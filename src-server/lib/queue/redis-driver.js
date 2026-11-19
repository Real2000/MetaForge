/**
 * U2-1 / N7-P1 Redis 队列驱动（BullMQ 后端，可选）
 *
 * 用途：把长任务队列从进程内搬到 Redis，使 PM2 多进程 / 多节点可横向扩展 worker。
 *
 * 依赖策略（可选依赖，惰性加载）：
 *   - 需要 bullmq（含 ioredis）。未安装时本模块 create() 抛出可读错误，驱动不激活；
 *   - 不配置 QUEUE_DRIVER=redis 时，本模块不会被实例化，默认仍走内存驱动。
 *   安装：npm i bullmq ioredis（可选依赖，已列入 package.json optionalDependencies）
 *
 * 语义与内存驱动对齐：register 记录处理函数；enqueue 落队；worker 消费并更新任务状态。
 *   - 任务状态真值以 Redis 为准；task_queue 表仅由内存驱动使用，Redis 模式下不写该表。
 *   - 幂等：以 jobId 作为 BullMQ jobId，重复入队不会重复创建。
 *   - 重试：attempts = maxRetries，指数退避与内存驱动一致。
 */
let _bullmq = null;
let _bullmqErr = null;

/** 探测 bullmq 依赖是否可用（不抛异常，供门面/健康检查使用） */
function available() {
  if (_bullmq || _bullmqErr) return !!_bullmq;
  try { _bullmq = require('bullmq'); }
  catch (e) { _bullmqErr = e; }
  return !!_bullmq;
}

/** 依赖缺失时的可读错误信息 */
function missingDepsError() {
  return new Error('Redis 队列驱动需要依赖 bullmq 与 ioredis，请先安装：npm i bullmq ioredis（或改用 QUEUE_DRIVER=memory）');
}

/**
 * 创建 Redis 驱动。
 * @param {Map<string,{handler:Function,opts:Object}>} registry - 任务注册表（门面持有）
 * @param {{redisUrl?:string, prefix?:string}} [opts]
 */
function create(registry, opts = {}) {
  if (!available()) throw missingDepsError();
  const { Queue, Worker } = _bullmq;
  const redisUrl = opts.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const prefix = opts.prefix || 'agentq';
  const connection = { url: redisUrl };
  const queues = new Map();  // name -> Queue
  const workers = new Map(); // name -> Worker

  function q(name) {
    if (!queues.has(name)) queues.set(name, new Queue(name, { connection, prefix }));
    return queues.get(name);
  }

  /** 入队（异步）。返回 jobId。与内存驱动的同步实现经门面统一为「可忽略返回值」 */
  async function enqueue(name, payload, opts = {}) {
    if (!registry.has(name)) throw new Error(`未注册的任务类型：${name}（可用类型：${[...registry.keys()].join(', ')}）`);
    const job = await q(name).add(name, payload || {}, {
      jobId: opts.jobId,
      delay: opts.delay || 0,
      attempts: opts.maxRetries != null ? opts.maxRetries : 3,
      priority: opts.priority || 0,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000, // 保留最近 1000 条完成记录
      removeOnFail: 5000,
    });
    return job.id;
  }

  /** 启动 worker 消费已注册任务类型（应在独立 worker 进程中调用） */
  function startWorkers() {
    for (const [name, entry] of registry) {
      if (workers.has(name)) continue;
      const w = new Worker(name, async (job) => entry.handler(job.data || {}), {
        connection, prefix,
        concurrency: entry.opts && entry.opts.concurrency ? entry.opts.concurrency : 5,
      });
      w.on('failed', (job, err) => console.error(`[queue:redis] 任务 ${name}#${job && job.id} 失败：`, err && err.message));
      workers.set(name, w);
    }
  }

  /** 停止所有 worker（优雅退出） */
  async function stopWorkers() {
    for (const [, w] of workers) { try { await w.close(); } catch { /* ignore */ } }
    workers.clear();
  }

  /** 获取任务状态（跨队列查找） */
  async function getJob(jobId) {
    for (const [, queue] of queues) {
      const job = await queue.getJob(jobId);
      if (job) return { job_id: job.id, name: job.name, payload: job.data, status: await job.getState(), result: job.returnvalue, error: job.failedReason };
    }
    return null;
  }

  /** 队列状态汇总 */
  async function queueStats() {
    const stats = {};
    for (const [name, queue] of queues) {
      const c = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      stats[name] = c;
    }
    return stats;
  }

  /** 清理完成/失败历史（保留最近 retention 条） */
  async function cleanupHistory(retention) {
    const grace = 0, limit = retention || 1000;
    let n = 0;
    for (const [, queue] of queues) {
      try {
        await queue.clean(grace, limit, 'completed');
        await queue.clean(grace, limit, 'failed');
        n++;
      } catch { /* 忽略单个队列清理失败 */ }
    }
    return n;
  }

  return { name: 'redis', redisUrl, enqueue, getJob, queueStats, cleanupHistory, startWorkers, stopWorkers };
}

module.exports = { create, available, missingDepsError };
