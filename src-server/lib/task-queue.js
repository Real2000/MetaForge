/**
 * U2-1 任务队列抽象层（2026-11-16）
 *
 * 职责：
 *  1. 统一任务注册、入队、执行接口。
 *  2. 当前实现为【进程内队列】（setImmediate 调度），不依赖 Redis 等外部中间件。
 *  3. 提供与 BullMQ 等价的入队参数：{ payload, opts: { delay, retry, maxRetries, priority, jobId } }。
 *  4. 后续可替换为 Redis 后端：只需替换 enqueue 和 worker shell 的实现，注册表和任务处理函数不变。
 *
 * task_queue 表：用于持久化任务状态，支持幂等、重试、延迟执行。
 *   - 当前为启动时拉取，后续可扩展为调度器模式。
 *   - 完成的任务默认保留 7 天（TASK_HISTORY_KEEP_DAYS）。
 *
 * 与现有 cron 定时任务（scheduler.js）的关系：
 *   cron 依旧使用 30s 定时轮询 tasks 表，通过 enqueue 将任务递交给 task-queue 执行。
 *   异步摄取和 workflow_runs 同理，通过 enqueue 接入 task-queue。
 *   迁移的代码变更量很小（替换老的 fire-and-forget 或直接调用的模式）。
 */
const { db, now } = require('../db');
const crypto = require('crypto');

const TASK_HISTORY_KEEP_DAYS = 7;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 首次重试延迟 1 秒，后续指数退避

// 注册表：name -> { handler, opts }
const REGISTRY = new Map();

/** 注册任务类型 */
function register(name, handler, opts = {}) {
  if (REGISTRY.has(name)) throw new Error(`任务类型已注册：${name}`);
  REGISTRY.set(name, { handler, opts });
}

/** 入队任务。返回 jobId。*/
function enqueue(name, payload, opts = {}) {
  if (!REGISTRY.has(name)) throw new Error(`未注册的任务类型：${name}（可用类型：${[...REGISTRY.keys()].join(', ')}）`);
  const jobId = opts.jobId || `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const delay = opts.delay || 0;
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : MAX_RETRIES;
  const priority = opts.priority || 0;
  // 写 task_queue 表：插入一条 pending 任务
  db.prepare(`INSERT INTO task_queue (job_id, name, payload, status, priority, max_retries, retry_count, delay_ms, created_at, scheduled_at) VALUES (?,?,?,?,?,?,0,?,?,?)`)
    .run(jobId, name, JSON.stringify(payload), 'pending', priority, maxRetries, delay, now(), delay ? new Date(Date.now() + delay).toISOString().replace('T', ' ').slice(0, 19) : now());
  // 非延迟任务立即调度执行
  if (!delay) setImmediate(() => processQueue());
  else setTimeout(() => processQueue(), delay);
  return jobId;
}

/** 处理队首任务（进程内串行执行；后续可替换为 worker 模式） */
async function processQueue() {
  const job = db.prepare(`SELECT * FROM task_queue WHERE status='pending' AND (scheduled_at IS NULL OR scheduled_at <= datetime('now','localtime')) ORDER BY priority DESC, id ASC LIMIT 1`).get();
  if (!job) return;
  const entry = REGISTRY.get(job.name);
  if (!entry) { db.prepare(`UPDATE task_queue SET status='failed' WHERE id=?`).run(job.id); return; }
  db.prepare(`UPDATE task_queue SET status='running', started_at=datetime('now','localtime') WHERE id=?`).run(job.id);
  try {
    let payload = null;
    try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }
    const result = await entry.handler(payload);
    db.prepare(`UPDATE task_queue SET status='success', finished_at=datetime('now','localtime'), result=? WHERE id=?`).run(JSON.stringify(result || {}), job.id);
  } catch (e) {
    const retries = (job.retry_count || 0) + 1;
    if (retries < (job.max_retries || MAX_RETRIES)) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retries - 1);
      db.prepare(`UPDATE task_queue SET status='pending', retry_count=?, scheduled_at=datetime('now','localtime',?||' seconds'), error=? WHERE id=?`)
        .run(retries, String(delay / 1000), e.message, job.id);
      setTimeout(() => processQueue(), delay);
    } else {
      db.prepare(`UPDATE task_queue SET status='failed', finished_at=datetime('now','localtime'), error=? WHERE id=?`).run(e.message, job.id);
    }
  }
  // 处理队列中的下一个任务
  setImmediate(() => processQueue());
}

/** 清理过期历史任务 */
function cleanupHistory() {
  const cutoff = new Date(Date.now() - TASK_HISTORY_KEEP_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const r = db.prepare(`DELETE FROM task_queue WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff);
  if (r.changes) console.log(`[task-queue] 清理 ${r.changes} 条过期历史任务（> ${TASK_HISTORY_KEEP_DAYS} 天）`);
}

/** 获取任务状态 */
function getJob(jobId) {
  return db.prepare('SELECT * FROM task_queue WHERE job_id=?').get(jobId);
}

/** 获取队列状态 */
function queueStats() {
  const r = db.prepare(`
    SELECT status, COUNT(*) c FROM task_queue GROUP BY status
  `).all();
  const stats = {};
  for (const row of r) stats[row.status] = row.c;
  return stats;
}

module.exports = { register, enqueue, getJob, queueStats, cleanupHistory };
