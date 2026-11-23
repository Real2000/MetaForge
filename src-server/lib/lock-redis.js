/**
 * MT-15 / U2-1 跨机分布式锁后端（Redis 实现）
 *
 * 用途：多**节点**（跨主机）部署时，`cluster_locks` 的 SQLite 租约仅在「共享同一 DB 文件」的同机
 *      多进程场景有效；跨机需要一份所有节点都能访问的共享权威——本模块以 Redis 提供该锁。
 *
 * 语义与 lib/cluster-lock.js 的 DB 租约**完全对齐**：
 *   - acquire：仅当「键不存在 / 已过期 / 本持有者已持有」时写入成功（Lua 原子脚本）；
 *   - renew  ：等价于以本持有者身份再次 acquire（刷新 PX 过期）；
 *   - release：仅删除本持有者持有的键（Lua 比较后删除，避免误删他人锁）；
 *   - isLeader：只读判断当前持有者是否为锁主。
 *
 * 依赖策略（可选依赖，惰性加载）：需 ioredis（随 bullmq 一并安装）。未安装时 defaultClient() 抛可读错误；
 *   本模块支持**注入任意 Redis 客户端**（createBackend(client)），便于单测用假客户端验证算法，无需真实 Redis。
 */
let _ioredisErr = null;
let _client = null; // 默认惰性客户端（ioredis）

/** 锁键名（统一前缀，避免与其他键冲突） */
function lockKey(name) { return `agentlock:${name}`; }

/**
 * 用给定上层客户端（ioredis 兼容：eval/get/del）构造锁后端。
 * @param {{eval:Function,get:Function,del:Function}} client
 */
function createBackend(client) {
  if (!client || typeof client.eval !== 'function') throw new Error('lock-redis: 需要提供 Redis 客户端（含 eval）');

  // 原子接管：不存在→写；已是本人→续期；否则让位
  const ACQUIRE_LUA = `
    local v = redis.call('GET', KEYS[1])
    if not v then
      redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
      return 1
    elseif v == ARGV[1] then
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 1
    else
      return 0
    end`;

  // 原子释放：仅删本人持有
  const RELEASE_LUA = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end`;

  async function acquire(name, ttlMs, owner) {
    const r = await client.eval(ACQUIRE_LUA, 1, lockKey(name), String(owner), String(ttlMs));
    return Number(r) === 1;
  }

  async function isLeader(name, owner) {
    const v = await client.get(lockKey(name));
    return v === String(owner);
  }

  function renew(name, ttlMs, owner) { return acquire(name, ttlMs, owner); }

  async function release(name, owner) {
    const r = await client.eval(RELEASE_LUA, 1, lockKey(name), String(owner));
    return Number(r) === 1;
  }

  async function info(name) {
    const v = await client.get(lockKey(name));
    return v ? { name, owner: v } : null;
  }

  return { name: 'redis', acquire, isLeader, renew, release, info };
}

/** ioredis 是否可用（不抛异常） */
function available() {
  try { require('ioredis'); return true; } catch (e) { _ioredisErr = e; return false; }
}

/** 依赖缺失时的可读错误 */
function missingDepsError() {
  return new Error('Redis 分布式锁需要依赖 ioredis，请先安装：npm i ioredis bullmq（或改用 LOCK_DRIVER=db）');
}

/** 默认客户端（惰性创建 ioredis；未安装则抛错） */
function defaultClient() {
  if (_client) return _client;
  if (!available()) throw missingDepsError();
  const Redis = require('ioredis');
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  _client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  return _client;
}

/** 注入客户端（测试用；传 null 复位） */
function _setClient(c) { _client = c; }

module.exports = { createBackend, available, missingDepsError, defaultClient, lockKey, _setClient };
