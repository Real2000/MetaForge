/**
 * U2-1 / N7-P1 内存队列驱动（默认，进程内）
 *
 * 由原 lib/task-queue.js 迁移而来，行为完全等价：
 *   - 任务状态持久化到 task_queue 表（幂等、重试、延迟、优先级）；
 *   - 入队后经 setImmediate 进程内串行执行；
 *   - 失败按指数退避重试，超过 max_retries 标 failed；
 *   - 完成历史默认保留 7 天。
 *
 * 与 Redis 驱动的关系：对外 API 等价，可在 lib/queue/index.js 中经 QUEUE_DRIVER 切换。
 * 集群注意：进程内队列不支持多进程共享，PM2 cluster 下需由 P2 选主锁保证仅单实例执行。
 */
const { db, now } = require('../../db');
const dal = require('../dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const clusterLock = require('../cluster-lock'); // U2-1 / N7-P2 集群选主（跨进程仅 leader 处理队列）
const crypto = require('crypto');

const TASK_HISTORY_KEEP_DAYS = 7;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 首次重试延迟 1 秒，后续指数退避

/**
 * 创建内存驱动。
 * @param {Map<string,{handler:Function,opts:Object}>} registry - 任务注册表（由门面统一持有）
 */
function create(registry) {
  /** 入队任务，返回 jobId（同步；与 Redis 驱动的异步实现经门面统一） */
  function enqueue(name, payload, opts = {}) {
    if (!registry.has(name)) throw new Error(`未注册的任务类型：${name}（可用类型：${[...registry.keys()].join(', ')}）`);
    const jobId = opts.jobId || `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const delay = opts.delay || 0;
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : MAX_RETRIES;
    const priority = opts.priority || 0;
    // PG-1（2026-11-23）：延迟任务的 scheduled_at 原用 toISOString()（UTC）写入，与 now() 及方言层
    // 基钟（Asia/Shanghai，见 sql-dialect TZ_BASE）不同钟——跨钟比较会让延迟任务提前数小时触发。
    // 统一为业务基准钟（与 db.js now() 同钟），双驱动行为一致。
    const schedAt = delay ? new Date(Date.now() + delay).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : now();
    dal.runq(`INSERT INTO task_queue (job_id, name, payload, status, priority, max_retries, retry_count, delay_ms, created_at, scheduled_at) VALUES (?,?,?,?,?,?,0,?,?,?)`, [jobId, name, JSON.stringify(payload), 'pending', priority, maxRetries, delay, now(), schedAt]);
    if (!delay) setImmediate(() => processQueue());
    else setTimeout(() => processQueue(), delay);
    return jobId;
  }

  /** 处理队首任务（进程内串行；集群下由调用方保证单实例） */
  async function processQueue() {
    // U2-1 / N7-P2：集群模式下内存 worker 仅 leader 执行，避免多进程重复处理同一条 pending 任务。
    // 非集群模式 isLeader 恒为 true，行为与引入前一致（不读写锁表）。
    if (!clusterLock.isLeader(clusterLock.LOCK_NAME)) return;
    const job = dal.getq(`SELECT * FROM task_queue WHERE status='pending' AND (scheduled_at IS NULL OR scheduled_at <= datetime('now','localtime')) ORDER BY priority DESC, id ASC LIMIT 1`);
    if (!job) return;
    const entry = registry.get(job.name);
    if (!entry) { dal.runq(`UPDATE task_queue SET status='failed' WHERE id=?`, [job.id]); return; }
    dal.runq(`UPDATE task_queue SET status='running', started_at=datetime('now','localtime'), worker_id=?, locked_at=datetime('now','localtime') WHERE id=?`, [clusterLock.ownerId(), job.id]);
    try {
      let payload = null;
      try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }
      const result = await entry.handler(payload);
      dal.runq(`UPDATE task_queue SET status='success', finished_at=datetime('now','localtime'), result=? WHERE id=?`, [JSON.stringify(result || {}), job.id]);
    } catch (e) {
      const retries = (job.retry_count || 0) + 1;
      if (retries < (job.max_retries || MAX_RETRIES)) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, retries - 1);
        // PG-1（2026-11-23）：datetime() 的参数化修饰符（?||' seconds'）不可静态方言改写——改为
        // JS 侧算好绝对时刻传参（基钟 Asia/Shanghai，与 now()/方言层 TZ_BASE 同钟；语义与
        // 原「now+delay 秒」等价）。sqlite 驱动不再依赖 datetime()，双驱动同一句 SQL。
        const nextAt = new Date(Date.now() + delay).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
        dal.runq(`UPDATE task_queue SET status='pending', retry_count=?, scheduled_at=?, error=? WHERE id=?`, [retries, nextAt, e.message, job.id]);
        setTimeout(() => processQueue(), delay);
      } else {
        dal.runq(`UPDATE task_queue SET status='failed', finished_at=datetime('now','localtime'), error=? WHERE id=?`, [e.message, job.id]);
      }
    }
    setImmediate(() => processQueue());
  }

  /** 清理过期历史任务 */
  function cleanupHistory() {
    const cutoff = new Date(Date.now() - TASK_HISTORY_KEEP_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const r = dal.runq(`DELETE FROM task_queue WHERE finished_at IS NOT NULL AND finished_at < ?`, [cutoff]);
    if (r.changes) console.log(`[task-queue] 清理 ${r.changes} 条过期历史任务（> ${TASK_HISTORY_KEEP_DAYS} 天）`);
    return r.changes || 0;
  }

  /** 获取任务状态 */
  function getJob(jobId) {
    return dal.getq('SELECT * FROM task_queue WHERE job_id=?', [jobId]);
  }

  /** 获取队列状态 */
  function queueStats() {
    const r = dal.q(`SELECT status, COUNT(*) c FROM task_queue GROUP BY status`);
    const stats = {};
    for (const row of r) stats[row.status] = row.c;
    return stats;
  }

  /** 内存驱动的 worker 在 enqueue 时随队启动，无需独立 startWorkers */
  function startWorkers() { /* no-op */ }
  function stopWorkers() { /* no-op */ }

  return { name: 'memory', enqueue, getJob, queueStats, cleanupHistory, processQueue, drain: processQueue, startWorkers, stopWorkers };
}

module.exports = { create, MAX_RETRIES, TASK_HISTORY_KEEP_DAYS };
