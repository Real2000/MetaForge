/**
 * U2-1 / N7-P2 PM2 进程编排配置（可选，非必需）
 *
 * 用途：多进程/多节点生产部署时，用 PM2 统一管理「API 进程集群」与「独立队列 worker」。
 *   不使用 PM2 也可用 Node 内置 cluster 运行（WEB_CONCURRENCY=N node server.js）。
 *
 * 用法：
 *   npm i -g pm2
 *   pm2 start ecosystem.config.js              # 启动全部（web + 队列 worker）
 *   pm2 start ecosystem.config.js --only agent-web   # 仅 API 集群
 *   QUEUE_DRIVER=redis pm2 start ecosystem.config.js # Redis 队列模式（需先装 bullmq/ioredis 并配 REDIS_URL）
 *   pm2 logs / pm2 status / pm2 reload all
 *
 * 关键设计：
 *   - web 应用 cluster 模式多实例；队列 worker 用 fork（连接可横向扩）。
 *   - 通过 WEB_CONCURRENCY 让每个 web 进程识别集群模式，启用 DB 选主租约锁（见 lib/cluster-lock.js），
 *     保证「30s 调度 tick / 运维定时任务 / 内存队列」仅 leader 执行，不重复触发。
 *   - 队列 worker（agent-queue-worker）仅在 QUEUE_DRIVER=redis 时才有意义；内存模式下该进程会自行退出。
 *     Redis 模式下调度 tick 仍由 web leader 负责，worker 只消费队列。
 */

const path = require('node:path');

// web 实例数：优先取环境变量 WEB_CONCURRENCY，默认按 CPU 核数（至少 2）——但注意最大不超过 8，避免 SQLite 写竞争过大
const os = require('node:os');
const WEB_INSTANCES = parseInt(process.env.WEB_CONCURRENCY || '', 10) || Math.min(Math.max(os.cpus().length, 2), 8);

module.exports = {
  apps: [
    {
      name: 'agent-web',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'cluster',
      instances: WEB_INSTANCES,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3210,
        WEB_CONCURRENCY: String(WEB_INSTANCES), // 令各 worker 识别集群模式 → 启用选主锁
        DEPLOY_MODE: 'cluster',
        AGENT_DATA_DIR: process.env.AGENT_DATA_DIR || path.join(__dirname, 'data'),
        // MT-15：跨机部署时设 QUEUE_DRIVER=redis + REDIS_URL + LOCK_DRIVER=redis（redis 队列档为强依赖，缺依赖即启动失败）
        QUEUE_DRIVER: process.env.QUEUE_DRIVER || 'memory',
        LOCK_DRIVER: process.env.LOCK_DRIVER || 'auto',
        REDIS_URL: process.env.REDIS_URL || '',
      },
      // 优雅停机：等待存量请求收尾
      kill_timeout: 8000,
      wait_ready: false,
      max_restarts: 10,
      restart_delay: 3000,
      // 日志轮转（配合 pm2 install pm2-logrotate 更佳）
      out_file: 'logs/pm2-web-out.log',
      error_file: 'logs/pm2-web-err.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'agent-queue-worker',
      script: 'src-server/lib/queue/worker.js',
      cwd: __dirname,
      exec_mode: 'fork', // 队列 worker 用 fork（可 instances 横向扩；BullMQ Worker 并发由代码内 concurrency 控制）
      instances: parseInt(process.env.QUEUE_WORKERS || '1', 10) || 1,
      env: {
        NODE_ENV: 'production',
        QUEUE_DRIVER: process.env.QUEUE_DRIVER || 'redis', // 非 redis 时该进程自行退出（无可消费队列）
        REDIS_URL: process.env.REDIS_URL || '',
        AGENT_DATA_DIR: process.env.AGENT_DATA_DIR || path.join(__dirname, 'data'),
      },
      kill_timeout: 8000,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: 'logs/pm2-worker-out.log',
      error_file: 'logs/pm2-worker-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
