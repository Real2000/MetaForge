/**
 * U2-1 / N7-P1 任务队列门面（驱动选择 + 统一 API）
 *
 * 分层：
 *   lib/queue/index.js         ← 本文件：注册表 + 驱动选择 + 统一门面
 *   lib/queue/memory-driver.js ← 进程内驱动（默认）
 *   lib/queue/redis-driver.js  ← BullMQ/Redis 驱动（可选）
 *   lib/queue/worker.js        ← 独立 worker 进程入口（redis 驱动用）
 *
 * 驱动选择：QUEUE_DRIVER 环境变量 / 配置项 queue_driver，取值 memory（默认）| redis。
 *   指定 redis 但依赖缺失或连接失败时，回退内存驱动并记录错误（不使应用崩溃），
 *   错误信息经 driverInfo() 暴露，供系统监控/健康检查展示。
 *
 * 兼容：lib/task-queue.js 仍作为本门面的转发出口，既有调用方（ops.js/scheduler.js）无需改动。
 */
const REGISTRY = new Map();   // name -> { handler, opts }
let _driver = null;
let _driverErr = null;
let _driverName = '';

/** 解析驱动名：环境变量优先，其次配置中心，默认 memory */
function _resolveDriverName() {
  let name = process.env.QUEUE_DRIVER || '';
  if (!name) {
    try { const cfg = require('../config'); name = (cfg.get && cfg.get('queue_driver')) || 'memory'; }
    catch { name = 'memory'; }
  }
  return String(name || 'memory').toLowerCase();
}

/**
 * 是否「强依赖」模式（MT-15）：显式指定 redis 驱动且处于生产/集群档时，Redis 依赖缺失或连接失败
 * 一律 **fail-fast 抛错**（不再静默回退内存驱动，避免「以为用了外置队列其实退回了进程内」的隐形降级）。
 * 优先级：AGENT_QUEUE_ALLOW_FALLBACK=1（显式允许回退）> AGENT_QUEUE_STRICT=1 / 配置 queue_strict > 自动判定。
 */
function _strict() {
  if (process.env.AGENT_QUEUE_ALLOW_FALLBACK === '1') return false;
  if (process.env.AGENT_QUEUE_STRICT === '1') return true;
  try { const cfg = require('../config'); if (cfg.get && cfg.get('queue_strict') === '1') return true; } catch { /* ignore */ }
  if (_resolveDriverName() !== 'redis') return false;
  // 显式指定 redis → 生产/集群档视为强依赖
  if (process.env.NODE_ENV === 'production' || process.env.CLUSTER_MODE === '1') return true;
  if ((parseInt(process.env.WEB_CONCURRENCY || '', 10) || 0) > 1) return true;
  try { const cfg = require('../config'); if (cfg.get && cfg.get('deploy_mode') === 'cluster') return true; } catch { /* ignore */ }
  return false;
}

/** 取得（或惰性创建）当前驱动实例 */
function _getDriver() {
  if (_driver) return _driver;
  const want = _resolveDriverName();
  if (want === 'redis') {
    try {
      const rd = require('./redis-driver');
      if (!rd.available()) throw rd.missingDepsError();
      let url = '';
      try { const cfg = require('../config'); url = (cfg.get && cfg.get('redis_url')) || ''; } catch { /* ignore */ }
      _driver = rd.create(REGISTRY, { redisUrl: url || undefined });
      _driverName = 'redis';
    } catch (e) {
      if (_strict()) {
        // MT-15：强依赖模式下不回退，暴露致命错误（进程应据此启动失败，避免静默降级）
        _driverErr = e;
        _driverName = 'none';
        throw new Error('[queue] 已配置 Redis 强依赖但驱动不可用（拒绝回退内存驱动）：' + e.message +
          '。如确需回退，请设 AGENT_QUEUE_ALLOW_FALLBACK=1。');
      }
      _driverErr = e;
      _driver = require('./memory-driver').create(REGISTRY);
      _driverName = 'memory(fallback)';
      console.error('[queue] Redis 驱动不可用，已回退内存驱动：', e.message);
    }
  } else {
    _driver = require('./memory-driver').create(REGISTRY);
    _driverName = 'memory';
  }
  return _driver;
}

/** 注册任务类型（与驱动无关，注册表由门面统一持有） */
function register(name, handler, opts = {}) {
  if (REGISTRY.has(name)) throw new Error(`任务类型已注册：${name}`);
  REGISTRY.set(name, { handler, opts });
}

/** 入队（内存驱动同步返回 jobId；Redis 驱动返回 Promise<jobId>） */
function enqueue(name, payload, opts = {}) { return _getDriver().enqueue(name, payload, opts); }
/** 查询任务状态（Redis 驱动为异步） */
function getJob(jobId) { return _getDriver().getJob(jobId); }
/** 队列状态 */
function queueStats() { return _getDriver().queueStats(); }
/** 清理历史 */
function cleanupHistory(retention) { return _getDriver().cleanupHistory(retention); }
/** 启动 worker（内存为 no-op；Redis 需在独立进程调用） */
function startWorkers() { return _getDriver().startWorkers(); }
/** 停止 worker（优雅退出） */
async function stopWorkers() { return _getDriver().stopWorkers(); }
/** U2-1/N7-P2：触发一次队列排空（内存驱动为主动拉取 pending 任务；Redis 驱动无此概念，返回 undefined） */
function drain() { const d = _getDriver(); return d.drain ? d.drain() : undefined; }

/** 驱动运行信息（健康检查/监控用） */
function driverInfo() {
  let fatal = null;
  try { _getDriver(); } catch (e) { fatal = e.message; }
  return {
    driver: _driverName || 'none',
    requested: _resolveDriverName(),
    strict: _strict(),
    error: fatal || (_driverErr ? _driverErr.message : null),
    registered: [...REGISTRY.keys()],
  };
}

/** 复位驱动缓存（仅测试用；运行期驱动一经创建即固定） */
function _resetDriver() { _driver = null; _driverErr = null; _driverName = ''; }

module.exports = {
  register, enqueue, getJob, queueStats, cleanupHistory,
  startWorkers, stopWorkers, drain, driverInfo, REGISTRY,
  _strict, _resolveDriverName, _resetDriver, // MT-15：供测试/监控
};
