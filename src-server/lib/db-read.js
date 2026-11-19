/**
 * U2-1 / N7-P3 读写分离 DAL —— 只读连接（读副本）
 *
 * 目标：将「统计 / 列表 / 看板」等只读查询逐步切到只读副本连接，主库专注写入，
 * 在读写负载较高的规模化部署下降低主库锁竞争。
 *
 * 硬约束（零回归）：
 *   - 未配置 AGENT_DB_READONLY（或指向的副本文件不存在）时，getReadDb() 直接返回主库连接，
 *     行为与现状完全一致；
 *   - 副本连接以 readonly 模式打开，任何写入都会报错，避免误写副本造成主从分叉。
 *
 * 说明：副本由 litestream 持续同步（见 deploy/litestream.yml），或由
 * scripts/replica-bootstrap.sh 一次性初始化。仅「允许轻微延迟」的只读查询应走副本；
 * 写后立即读（强一致）必须走主库。
 */
const fs = require('fs');

let readDb = null;        // 惰性创建的只读连接
let readDbPath = null;    // 当前只读连接对应的路径（用于路径变更检测）

/** 配置的只读副本路径（未配置返回空串） */
function replicaPath() {
  return String(process.env.AGENT_DB_READONLY || '').trim();
}

/** 是否已配置且副本文件存在 */
function hasReplica() {
  const p = replicaPath();
  return !!p && fs.existsSync(p);
}

/**
 * 获取只读连接。
 * @param {object} mainDb 主库连接（未配置副本时作为回退返回）
 * @returns {object} better-sqlite3 Database（只读副本或主库）
 */
function getReadDb(mainDb) {
  if (!hasReplica()) return mainDb;               // 未配置 / 副本缺失 → 回退主库（等同现状）
  const p = replicaPath();
  if (readDb && readDbPath === p) return readDb;  // 复用已打开的只读连接
  closeReadDb();                                   // 路径变更时重开
  const Database = require('better-sqlite3');      // 惰性加载（默认路径不引入额外开销）
  readDb = new Database(p, { readonly: true, fileMustExist: true });
  readDbPath = p;
  return readDb;
}

/** 关闭只读连接（优雅停机时调用；未打开则无操作） */
function closeReadDb() {
  try { if (readDb) readDb.close(); } catch { }
  readDb = null;
  readDbPath = null;
}

/** 状态（供健康检查 / 启动横幅展示） */
function status() {
  return {
    enabled: hasReplica(),
    path: replicaPath() || null,
    mode: hasReplica() ? 'replica' : 'main-fallback',
  };
}

module.exports = { getReadDb, closeReadDb, hasReplica, replicaPath, status };
