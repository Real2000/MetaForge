/**
 * U2-1 / N7-P2 集群选主租约锁（DB 实现，跨进程）
 *
 * 用途：PM2 cluster / Node cluster 多进程场景下，保证「30s 调度 tick」「内存队列 worker」
 *      「运维定时任务」等**只应单实例运行**的工作仅由 leader 进程执行，避免重复触发。
 *
 * 原理：cluster_locks 表存一条租约记录（name 主键）。
 *   - acquire() 原子尝试接管：仅当「无记录 / 已过期 / 本进程已持有」时写入成功（SQLite upsert + WHERE）；
 *   - 持有者需周期性 renew()（续租）以维持领导权；过期后可被其他进程抢占（崩溃自愈）；
 *   - release() 在优雅退出时主动让位，使新进程可立即接管（避免等待 TTL）。
 *
 * 零回归：默认（单进程）模式下所有判断短路返回「是 leader」，不读写锁表，行为与引入前完全一致；
 *   仅当 isClusterMode() 为真（CLUSTER_MODE=1 / WEB_CONCURRENCY>1 / 配置 deploy_mode=cluster）时启用租约。
 *
 * 注意：本文件用 SQL 语句作为跨进程临界区，多进程各自持有独立 SQLite 连接（WAL），依赖单条 upsert 的原子性。
 */
const os = require('os');
const { db } = require('../db');
const lockRedis = require('./lock-redis'); // MT-15：跨机分布式锁后端（Redis）

const DEFAULT_TTL_MS = 90 * 1000; // 租约时长：调度 tick 每 30s 续租一次，90s 留 3 个周期容错
const LOCK_NAME = 'cluster-leader'; // 统一的集群领导权锁名

let _clusterMode = null; // 惰性缓存（env 运行期不变；配置项变更需重启，故缓存安全）

/** 当前进程的持有者标识 */
function ownerId() {
  return `${os.hostname()}:${process.pid}`;
}

/** 是否处于集群模式（决定是否启用选主租约） */
function isClusterMode() {
  if (_clusterMode !== null) return _clusterMode;
  if (process.env.CLUSTER_MODE === '1') return (_clusterMode = true);
  const wc = parseInt(process.env.WEB_CONCURRENCY || '', 10);
  if (wc > 1) return (_clusterMode = true);
  try {
    const cfg = require('../config');
    if (cfg.get && cfg.get('deploy_mode') === 'cluster') return (_clusterMode = true);
  } catch { /* config 不可用时按单进程处理 */ }
  return (_clusterMode = false);
}

/** 重置集群模式缓存（仅供测试） */
function _resetClusterModeCache() { _clusterMode = null; }

/**
 * 申请/接管/续租锁。原子操作：仅当空闲、已过期或本进程已持有时写入成功。
 * @param {string} name
 * @param {number} [ttlMs]
 * @param {string} [owner] - 持有者标识（默认 hostname:pid；测试可显式传入以模拟多进程）
 * @returns {boolean} 是否为当前持有者
 */
function acquire(name, ttlMs = DEFAULT_TTL_MS, owner = ownerId()) {
  const nowMs = Date.now();
  const exp = nowMs + ttlMs;
  db.prepare(`
    INSERT INTO cluster_locks (name, owner, acquired_at, expires_at)
    VALUES (@name, @owner, @now, @exp)
    ON CONFLICT(name) DO UPDATE SET
      owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    WHERE cluster_locks.owner = excluded.owner OR cluster_locks.expires_at < excluded.acquired_at
  `).run({ name, owner, now: nowMs, exp });
  const row = db.prepare('SELECT owner, expires_at FROM cluster_locks WHERE name=?').get(name);
  return !!(row && row.owner === owner && row.expires_at > nowMs);
}

/**
 * 只读判断当前进程是否为 leader。
 * 非集群模式恒为 true（不读写锁表）——保证单进程路径零开销、行为不变。
 */
function isLeader(name, owner = ownerId()) {
  if (!isClusterMode()) return true;
  const row = db.prepare('SELECT owner, expires_at FROM cluster_locks WHERE name=?').get(name);
  return !!(row && row.owner === owner && row.expires_at > Date.now());
}

/** 续租（等价于以本进程身份再次 acquire） */
function renew(name, ttlMs = DEFAULT_TTL_MS, owner = ownerId()) { return acquire(name, ttlMs, owner); }

/** 主动让位（仅删除本进程持有的记录） */
function release(name, owner = ownerId()) {
  const r = db.prepare('DELETE FROM cluster_locks WHERE name=? AND owner=?').run(name, owner);
  return r.changes > 0;
}

/** 查询锁当前状态（监控/诊断用） */
function info(name) {
  return db.prepare('SELECT * FROM cluster_locks WHERE name=?').get(name) || null;
}

// ===================== MT-15：锁后端选择 + 异步统一 API（支持跨机） =====================
// 后端（LOCK_DRIVER）：db=库内租约（默认，仅同机多进程共享 SQLite 有效）；
//   redis=Redis 分布式锁（跨机多节点唯一权威）；auto=队列驱动为 redis 时用 redis，否则 db。
// 既有同步 API（acquire/isLeader/renew/release）保持「DB 后端」语义不变（零回归）；
// 需要跨机时改用异步 API（acquireAsync/isLeaderAsync/renewAsync/releaseAsync），由后端自动分派。

/** 解析锁后端：LOCK_DRIVER(env) > 配置项 lock_driver > auto */
function resolveLockDriver() {
  let v = String(process.env.LOCK_DRIVER || '').toLowerCase();
  if (!v) { try { const cfg = require('../config'); v = String((cfg.get && cfg.get('lock_driver')) || 'auto').toLowerCase(); } catch { v = 'auto'; } }
  if (v === 'db' || v === 'redis') return v;
  // auto：跟随队列驱动
  let q = String(process.env.QUEUE_DRIVER || '').toLowerCase();
  if (!q) { try { const cfg = require('../config'); q = String((cfg.get && cfg.get('queue_driver')) || 'memory').toLowerCase(); } catch { q = 'memory'; } }
  return q === 'redis' ? 'redis' : 'db';
}

let _redisBackend = null;
/** 取得（惰性创建）Redis 锁后端；依赖/连接不可用时抛可读错误（跨机档 fail-fast） */
function redisBackend() {
  if (_redisBackend) return _redisBackend;
  _redisBackend = lockRedis.createBackend(lockRedis.defaultClient());
  return _redisBackend;
}

/** 注入 Redis 客户端（测试用；传 null 复位）；会重建后端 */
function _setRedisClient(c) { lockRedis._setClient(c); _redisBackend = null; }

/** 当前锁后端名（db / redis；监控用） */
function backend() { return resolveLockDriver(); }

/** 异步申请/接管/续租（按后端分派；redis 后端支持跨机） */
async function acquireAsync(name, ttlMs = DEFAULT_TTL_MS, owner = ownerId()) {
  if (resolveLockDriver() === 'redis') return redisBackend().acquire(name, ttlMs, owner);
  return acquire(name, ttlMs, owner);
}
/** 异步判断是否 leader（按后端分派） */
async function isLeaderAsync(name, owner = ownerId()) {
  if (resolveLockDriver() === 'redis') return redisBackend().isLeader(name, owner);
  return isLeader(name, owner);
}
/** 异步续租 */
async function renewAsync(name, ttlMs = DEFAULT_TTL_MS, owner = ownerId()) {
  if (resolveLockDriver() === 'redis') return redisBackend().renew(name, ttlMs, owner);
  return renew(name, ttlMs, owner);
}
/** 异步释放 */
async function releaseAsync(name, owner = ownerId()) {
  if (resolveLockDriver() === 'redis') return redisBackend().release(name, owner);
  return release(name, owner);
}

module.exports = {
  acquire, isLeader, renew, release, info,
  isClusterMode, _resetClusterModeCache, ownerId,
  LOCK_NAME, DEFAULT_TTL_MS,
  // MT-15：跨机锁
  resolveLockDriver, backend, _setRedisClient,
  acquireAsync, isLeaderAsync, renewAsync, releaseAsync,
};
