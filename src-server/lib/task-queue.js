/**
 * U2-1 任务队列抽象层（2026-11-16 初版）
 * N7-P1 重构（2026-11-19）：实现已拆分到 lib/queue/*，本文件保留为兼容转发出口。
 *
 *   lib/queue/index.js         门面（注册表 + 驱动选择 + 统一 API）
 *   lib/queue/memory-driver.js 进程内驱动（默认）
 *   lib/queue/redis-driver.js  BullMQ/Redis 驱动（可选）
 *   lib/queue/worker.js        独立 worker 进程入口
 *
 * 既有调用方（lib/ops.js、lib/scheduler.js）仍可用 require('../lib/task-queue') 不变。
 */
module.exports = require('./queue/index');
