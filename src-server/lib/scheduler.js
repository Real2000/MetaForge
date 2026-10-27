/**
 * 任务执行器 + Cron 调度器（30 秒扫描一次）
 * 2026-10-20：内置运维任务（每日备份/产物清理/日志归档），不依赖外部 cron
 */
const { db, now } = require('../db');
const { runAgent } = require('./workflow');
const { lastFire } = require('./cron');
const ops = require('./ops');
const { addUsage, checkQuota } = require('./quota'); // P5.31 记归属者配额；P5.33 审查修复（F3）执行前配额闸门

const fireMarks = new Map(); // task_id -> last fired ts

async function runTask(task) {
  const started = now();
  // P5.33 审查修复（F3）：执行前配额闸门——此前配额耗尽只拦对话，任务照常每 cron 周期烧 token（denial-of-wallet）。
  // 超限自动停用任务并发站内信告知归属者（username='' 的历史管理员任务不限额不检查）
  if (task.username) {
    const quotaMsg = checkQuota(task.username);
    if (quotaMsg) {
      db.prepare('UPDATE tasks SET enabled=0, last_run_at=?, last_result=? WHERE id=?').run(started, 'fail', task.id);
      db.prepare('INSERT INTO task_runs (task_id,status,started_at,finished_at,output) VALUES (?,?,?,?,?)')
        .run(task.id, 'fail', started, now(), '任务已自动停用：' + quotaMsg);
      try {
        db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
          .run(task.username, '⏸️ 定时任务已自动停用', `任务「${task.name}」因 ${quotaMsg.replace(/\n[\s\S]*$/, '')} 已自动停用，可在「任务管理」页查看。`, 'task', '#/tasks', now());
      } catch { /* 通知失败不影响停用 */ }
      console.log(`[scheduler] 任务「${task.name}」归属者配额已耗尽，自动停用`);
      return { status: 'fail', output: '任务已自动停用：' + quotaMsg };
    }
  }
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(task.target_id);
  let output = '';
  let status = 'success';
  let usage = null;
  try {
    if (!agent) throw new Error('目标智能体不存在');
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
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('task-scheduler', `任务「${task.name}」执行失败：${e.message}`, now());
  }
  const finished = now();
  db.prepare('INSERT INTO task_runs (task_id,status,started_at,finished_at,output) VALUES (?,?,?,?,?)')
    .run(task.id, status, started, finished, output);
  db.prepare('UPDATE tasks SET last_run_at=?, last_result=? WHERE id=?').run(finished, status, task.id);
  // P5.31 配额记账：定时任务的 token 消耗记到任务归属者（此前不记任何人；管理员建的历史任务 username='' 不记）
  try {
    const tokens = usage?.totalTokens || 0;
    if (task.username && tokens > 0) addUsage(task.username, tokens);
  } catch { /* 记账失败不影响任务执行 */ }
  return { status, output };
}

function startScheduler() {
  const tick = async () => {
    try {
      const tasks = db.prepare('SELECT * FROM tasks WHERE enabled=1 AND exec_type=?').all('cron');
      for (const t of tasks) {
        if (!t.cron) continue;
        const prev = fireMarks.get(t.id) || Date.parse(t.last_run_at || '') || Date.now() - 60000;
        const ts = lastFire(t.cron, prev);
        if (ts && ts > prev) {
          fireMarks.set(t.id, ts);
          console.log(`[scheduler] 定时触发任务：${t.name}`);
          await runTask(t);
        }
      }
    } catch (e) {
      console.error('[scheduler] 扫描异常：', e.message);
    }
  };
  tick();
  setInterval(tick, 30000);
  ops.startOps(); // P0 运维：每日备份 + 产物清理 + 日志归档（内置，无外部依赖）
  console.log('[scheduler] 定时任务调度器已启动（30s 扫描）');
}

module.exports = { runTask, startScheduler };
