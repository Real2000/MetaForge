/**
 * 任务执行器 + Cron 调度器（30 秒扫描一次）
 * 2026-10-20：内置运维任务（每日备份/产物清理/日志归档），不依赖外部 cron
 */
const { db, now } = require('../db');
const { runAgent } = require('./workflow');
const { lastFire } = require('./cron');
const ops = require('./ops');

const fireMarks = new Map(); // task_id -> last fired ts

async function runTask(task) {
  const started = now();
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(task.target_id);
  let output = '';
  let status = 'success';
  try {
    if (!agent) throw new Error('目标智能体不存在');
    const params = JSON.parse(task.params || '{}');
    // P5.8 #11：经统一入口 runAgent——画布模式按编排图执行，表单模式走提示词+知识库（定时任务也能跑画布工作流）
    const r = await runAgent(agent, params.input || '（无输入参数）请执行默认任务。', { triggerType: 'schedule' });
    output = r.text;
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
