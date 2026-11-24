/**
 * 任务执行器 + Cron 调度器（30 秒扫描一次）
 * 2026-10-20：内置运维任务（每日备份/产物清理/日志归档），不依赖外部 cron
 */
const { db, now, withDbTenant } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { runAgent } = require('./workflow');
const { lastFire } = require('./cron');
const ops = require('./ops');
const { addUsage, checkQuota } = require('./quota'); // P5.31 记归属者配额；P5.33 审查修复（F3）执行前配额闸门
const { canView } = require('./agent-access'); // P5.34（审查 F8）：执行期复查智能体可见性
const { register, enqueue } = require('./task-queue'); // U2-1 任务队列
const clusterLock = require('./cluster-lock'); // U2-1 / N7-P2 集群选主租约锁

const fireMarks = new Map(); // task_id -> last fired ts

// U2-1 / N7-P2：集群下「调度 tick」与「运维定时任务」仅由 leader 进程执行，避免多进程重复触发。
// 非集群模式（默认）下 CLUSTER=false，所有门控短路为「放行」，行为与引入前完全一致。
const CLUSTER = clusterLock.isClusterMode();
const LEADER_LOCK = clusterLock.LOCK_NAME;
const LOCK_TTL = clusterLock.DEFAULT_TTL_MS;

// U2-1 / N7-P1：注册 cron 任务处理器到 task-queue（模块加载即注册，供 API 进程与独立 worker 进程共用）。
// 原先注册在 startScheduler() 内且用 global 守卫；抽到顶层后，worker.js 只需 require 本模块即可消费 'cron-task'，
// 无需启动 30s 扫描 tick。register 对同名重复注册会抛错，模块缓存保证只执行一次。
register('cron-task', async (payload) => {
  // PG-1 增量（2026-11-24）：队列 worker/调度回调无请求 ALS——platform 逃逸读任务（跨租户派发面），
  // 执行体按任务归属租户进入上下文（runTask 内 UPDATE tasks / INSERT task_runs / runAgent 写
  // sessions/messages/chat_traces 全走 RLS；无上下文时全部不可见/违约）
  const task = withDbTenant('platform', () => dal.getq('SELECT * FROM tasks WHERE id=?', [payload.taskId]));
  if (!task) throw new Error('任务不存在');
  return await withDbTenant(Number(task.tenant_id) || 1, () => runTask(task));
});

/** P5.34（审查 F8）：自动停用任务并通知归属者（配额耗尽/主体失效等场景共用）
 *  P5.34b（Y3）：outputMsg 只传原因短语（不再自带「任务已自动停用：」前缀），通知模板统一拼装 */
function disableTask(task, reason, title) {
  // task_runs 显式行归属租户（列默认 1 会让非 1 租户的执行记录错挂租户 1——应用层过滤与 RLS 双失明）
  dal.runq('UPDATE tasks SET enabled=0, last_run_at=?, last_result=? WHERE id=?', [now(), 'fail', task.id]);
  dal.runq('INSERT INTO task_runs (task_id,tenant_id,status,started_at,finished_at,output) VALUES (?,?,?,?,?,?)', [task.id, Number(task.tenant_id) || 1, 'fail', now(), now(), '任务已自动停用：' + reason]);
  try {
    dal.runq('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)', [task.username, title || '⏸️ 定时任务已自动停用', `任务「${task.name || task.id}」因 ${String(reason).replace(/\n[\s\S]*$/, '')} 已自动停用，可在「任务管理」页查看。`, 'task', '#/tasks', now()]);
  } catch { /* 通知失败不影响停用 */ }
}

async function runTask(task) {
  const started = now();
  // P5.33 审查修复（F3）：执行前配额闸门——此前配额耗尽只拦对话，任务照常每 cron 周期烧 token（denial-of-wallet）。
  // 超限自动停用任务并发站内信告知归属者（username='' 的历史管理员任务不限额不检查）
  if (task.username) {
    const quotaMsg = checkQuota(task.username);
    if (quotaMsg) {
      disableTask(task, String(quotaMsg).split('\n')[0]);
      console.log(`[scheduler] 任务「${task.name}」归属者配额已耗尽，自动停用`);
      return { status: 'fail', output: '任务已自动停用：' + String(quotaMsg).split('\n')[0] };
    }
  }
  const agent = dal.getq('SELECT * FROM agents WHERE id=?', [task.target_id]);
  // P5.34（审查 F8）：执行期复查智能体状态与可见性——权限只在创建时点校验，事后下架/转受限的
  // 智能体不应继续在无人值守周期执行（历史任务 username='' 为管理员创建，仅查发布状态）
  if (!agent || agent.status !== 'published') {
    const reason = !agent ? '执行主体（智能体）已被删除' : '执行主体（智能体）已下架（非发布状态）';
    disableTask(task, reason);
    console.log(`[scheduler] 任务「${task.name}」执行主体已失效，自动停用`);
    return { status: 'fail', output: '任务已自动停用：' + reason };
  }
  if (task.username) {
    const owner = dal.getq('SELECT id, username, nickname, role, dept FROM users WHERE username=? AND status=1', [task.username]);
    if (!owner) {
      disableTask(task, '任务归属者账号已停用/删除');
      return { status: 'fail', output: '任务已自动停用：任务归属者账号已停用/删除' };
    }
    if (!canView(agent, owner)) {
      disableTask(task, '执行主体（智能体）已不对任务归属者开放');
      console.log(`[scheduler] 任务「${task.name}」主体可见性变更，自动停用`);
      return { status: 'fail', output: '任务已自动停用：执行主体（智能体）已不对任务归属者开放' };
    }
  }
  let output = '';
  let status = 'success';
  let usage = null;
  try {
    const params = JSON.parse(task.params || '{}');
    // P5.8 #11：经统一入口 runAgent——画布模式按编排图执行，表单模式走提示词+知识库（定时任务也能跑画布工作流）
    // P5.31：透传任务归属者 username（用户自有模型优先路由 + 产出 token 记归属者配额）
    const r = await runAgent(agent, params.input || '（无输入参数）请执行默认任务。', { triggerType: 'schedule', username: task.username || undefined });
    output = r.text;
    usage = r.usage || null;
    if (!output) throw new Error('智能体无返回');
  } catch (e) {
    status = 'fail';
    output = '执行失败：' + e.message;
    dal.runq('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)', ['task-scheduler', `任务「${task.name}」执行失败：${e.message}`, now()]);
  }
  const finished = now();
  // task_runs 显式行归属租户（同 disableTask——非 1 租户的执行记录不可错挂租户 1）
  dal.runq('INSERT INTO task_runs (task_id,tenant_id,status,started_at,finished_at,output) VALUES (?,?,?,?,?,?)', [task.id, Number(task.tenant_id) || 1, status, started, finished, output]);
  dal.runq('UPDATE tasks SET last_run_at=?, last_result=? WHERE id=?', [finished, status, task.id]);
  // P5.31 配额记账：定时任务的 token 消耗记到任务归属者（此前不记任何人；管理员建的历史任务 username='' 不记）
  try {
    const tokens = usage?.totalTokens || 0;
    if (task.username && tokens > 0) addUsage(task.username, tokens);
  } catch { /* 记账失败不影响任务执行 */ }
  return { status, output };
}

function startScheduler() {
  // U2-1：'cron-task' 已在模块顶层注册（见上），此处仅保留守卫以兼容旧调用
  if (!global.__cronTaskRegistered) global.__cronTaskRegistered = true;
  // MT-15：集群/跨机领导权（异步统一 API，后端按 LOCK_DRIVER 分派：同机=DB 租约，跨机=Redis 锁）。
  //   schedLeader 每次 tick 刷新，供 ops 守卫同步读取（ops 自身定时器不改为异步）。
  let schedLeader = !CLUSTER;
  const tick = async () => {
    // U2-1 / N7-P2 / MT-15：集群模式下，非 leader 进程让位（同时完成领导权续租）
    schedLeader = CLUSTER ? await clusterLock.acquireAsync(LEADER_LOCK, LOCK_TTL) : true;
    if (CLUSTER && !schedLeader) {
      if (!global.__schedStandbyLogged) { console.log('[scheduler] 非 leader 进程，调度让位（由 leader 执行 tick）'); global.__schedStandbyLogged = true; }
      return;
    }
    try {
      // PG-1 增量：跨租户调度扫描（platform 逃逸）——无上下文直查 tasks 在 RLS 下只见基线 0 行，
      // 调度器会静默空转；逐任务执行时由 cron-task handler 按归属租户进上下文
      const tasks = withDbTenant('platform', () => dal.q('SELECT * FROM tasks WHERE enabled=1 AND exec_type=?', ['cron']));
      for (const t of tasks) {
        if (!t.cron) continue;
        const prev = fireMarks.get(t.id) || Date.parse(t.last_run_at || '') || Date.now() - 60000;
        const ts = lastFire(t.cron, prev);
        if (ts && ts > prev) {
          fireMarks.set(t.id, ts);
          console.log(`[scheduler] 定时触发任务：${t.name}`);
          enqueue('cron-task', { taskId: t.id });
        }
      }
      // 集群模式下由 leader 兜底排空内存队列（非 leader 进程入队的任务在此被处理）
      if (CLUSTER) { try { const q = require('./task-queue'); if (q.drain) q.drain(); } catch { /* 排空失败不影响扫描 */ } }
    } catch (e) {
      console.error('[scheduler] 扫描异常：', e.message);
    }
  };
  tick();
  setInterval(tick, 30000);
  // P0 运维：每日备份 + 产物清理 + 日志归档（内置，无外部依赖）
  // U2-1 / N7-P2 / MT-15：集群下仅 leader 执行运维定时任务（读取 schedLeader，含跨机 Redis 锁结果）
  ops.startOps(() => schedLeader);
  console.log('[scheduler] 定时任务调度器已启动（30s 扫描）');
}

module.exports = { runTask, startScheduler };
