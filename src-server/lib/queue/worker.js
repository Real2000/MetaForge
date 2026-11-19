/**
 * U2-1 / N7-P1 独立队列 worker 进程入口（Redis 驱动专用）
 *
 * 用法：QUEUE_DRIVER=redis node src-server/lib/queue/worker.js
 * PM2：见 ecosystem.config.js 的 worker 应用（exec_mode=fork，可多实例横向扩）。
 *
 * 职责：加载任务处理函数注册（ops 命名任务 + cron-task），然后启动 BullMQ Worker 消费队列。
 * 说明：本进程不启动 API、不启动 30s 调度 tick（tick 由 API 进程按选主锁单实例运行）。
 *   驱动非 redis 时（如未配 Redis），worker 无可消费队列，直接退出并按状态码 0 结束。
 */
require('../../db');           // 确保 schema 就绪
require('../ops');             // 注册 ops 命名任务（daily-backup / uploads-cleanup / ...）
require('../scheduler');       // 注册 cron-task 处理器（仅注册，不启动 tick）

const q = require('./index');

const info = q.driverInfo();
if (info.driver !== 'redis') {
  console.error(`[queue:worker] 当前队列驱动为「${info.driver}」，非 redis，worker 进程无需启动（将退出）。`);
  if (info.error) console.error('[queue:worker] 驱动降级原因：', info.error);
  process.exit(0);
}

q.startWorkers();
console.log(`[queue:worker] 已启动，驱动=redis，已注册任务类型：${info.registered.join(', ')}`);

async function shutdown(sig) {
  console.log(`[queue:worker] 收到 ${sig}，正在优雅退出…`);
  try { await q.stopWorkers(); } catch (e) { console.error('[queue:worker] 停止 worker 失败：', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
