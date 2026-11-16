/**
 * U2-2 数据库抽象层（DAL）指令封装（2026-11-16）
 *
 * 设计目标：
 *   1. 提供统一的 INSERT/UPDATE/SELECT/DELETE/now/exec 操作，隐藏 SQL 方言差异。
 *   2. 当前仅实现 SQLite 方言（在原有 db.js 基础上包装）。
 *   3. 后续可切换为达梦/人大金仓方言：仅替换 dialect 模块，接口不变。
 *   4. 不强制替换现有 db.prepare 调用——DAL 层供新代码使用，旧代码逐步迁移。
 *
 * 使用方式（新代码）：
 *   const dal = require('../lib/dal');
 *   dal.insert('users', { username: 'alice', nickname: 'Alice' });
 *   dal.update('users', { nickname: 'Alice2' }, 'username=?', ['alice']);
 *   dal.query('SELECT * FROM users WHERE role=?', ['admin']);
 *   const u = dal.get('SELECT * FROM users WHERE username=?', ['admin']);
 *   dal.exec('ALTER TABLE users ADD COLUMN age INTEGER');
 *   dal.now();                     // 返回当前时间字符串（SQLite: "YYYY-MM-DD HH:mm"）
 *   dal.pragma('table_info(users)'); // PRAGMA 查询（返回列信息数组）
 *
 * 方言差异当前由内部 SQLite 函数实现；达梦方言落地时继承同一接口。
 */
const { db: sqlite3, now: sqliteNow } = require('../db');

const DIALECT = process.env.DB_DIALECT || 'sqlite';

/** 方言命名空间；当前仅 sqlite */
const dialect = {
  /** now() 返回当前时间字符串（SQLite 日期格式） */
  now: () => sqliteNow(),
  /** pragma 查询（返回行数组） */
  pragma: (cmd) => sqlite3.prepare(`PRAGMA ${cmd}`).all(),
  /** lastInsertRowid 获取（SQLite 通过 prep 的 lastInsertRowid） */
  lastInsertRowid: (result) => result?.lastInsertRowid,
};

/**
 * 单行 INSERT（自动将 data 对象映射为键值对）。
 * @param {string} table  表名
 * @param {object} data   字段键值映射（不包含 id）
 * @returns {number} 自增 ID（lastInsertRowid）
 */
function insert(table, data) {
  if (!table) throw new Error('insert: 表名为空');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('insert: data 须为键值对象');
  const keys = Object.keys(data);
  if (!keys.length) throw new Error('insert: data 不能为空');
  const cols = keys.map(k => `"${k.replace(/"/g, '""')}"`).join(',');
  const vals = keys.map(() => '?').join(',');
  const placeholders = keys.map(k => data[k]);
  const info = sqlite3.prepare(`INSERT INTO "${table.replace(/"/g, '""')}" (${cols}) VALUES (${vals})`).run(...placeholders);
  return dialect.lastInsertRowid(info);
}

/**
 * INSERT OR REPLACE（upsert 语义）。
 */
function upsert(table, data) {
  if (!table) throw new Error('upsert: 表名为空');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('upsert: data 须为键值对象');
  const keys = Object.keys(data);
  if (!keys.length) throw new Error('upsert: data 不能为空');
  const cols = keys.map(k => `"${k.replace(/"/g, '""')}"`).join(',');
  const vals = keys.map(() => '?').join(',');
  const placeholders = keys.map(k => data[k]);
  const info = sqlite3.prepare(`INSERT OR REPLACE INTO "${table.replace(/"/g, '""')}" (${cols}) VALUES (${vals})`).run(...placeholders);
  return dialect.lastInsertRowid(info);
}

/**
 * 按条件更新。
 * @param {string} table  表名
 * @param {object} data   要更新的字段
 * @param {string} [where]  条件（如 'id=?'）；缺省时更新全表
 * @param {Array}  [params] 条件参数
 * @returns {number} 受影响行数
 */
function update(table, data, where, params) {
  if (!table) throw new Error('update: 表名为空');
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) throw new Error('update: data 须为非空键值对象');
  const keys = Object.keys(data);
  const sets = keys.map(k => `"${k.replace(/"/g, '""')}"=?`).join(',');
  const setVals = keys.map(k => data[k]);
  const allParams = [...setVals, ...(Array.isArray(params) ? params : [])];
  const sql = `UPDATE "${table.replace(/"/g, '""')}" SET ${sets}${where ? ` WHERE ${where}` : ''}`;
  return sqlite3.prepare(sql).run(...allParams).changes;
}

/**
 * 删除（建议带 where 防全表删除）。
 * @returns {number} 受影响行数
 */
function remove(table, where, params) {
  if (!table) throw new Error('remove: 表名为空');
  const p = Array.isArray(params) ? params : [];
  return sqlite3.prepare(`DELETE FROM "${table.replace(/"/g, '""')}"${where ? ` WHERE ${where}` : ''}`).run(...p).changes;
}

/**
 * 查询多行。
 * @param {string} sql     SQL 语句
 * @param {Array}  [params] 参数
 * @returns {Array} 行数组
 */
function query(sql, params) {
  const p = Array.isArray(params) ? params : [];
  return sqlite3.prepare(sql).all(...p);
}

/**
 * 查询单行。
 * @param {string} sql
 * @param {Array}  [params]
 * @returns {object|null}
 */
function get(sql, params) {
  const p = Array.isArray(params) ? params : [];
  return sqlite3.prepare(sql).get(...p);
}

/**
 * 查询单列第一行（pluck）。
 * @param {string} sql
 * @param {Array}  [params]
 * @returns {*} 第一列的值，或 undefined
 */
function pluck(sql, params) {
  const p = Array.isArray(params) ? params : [];
  return sqlite3.prepare(sql).pluck().get(...p);
}

/**
 * 执行 DDL 或其他无参数的 SQL。
 */
function exec(sql) {
  return sqlite3.exec(sql);
}

/**
 * PRAGMA 查询。
 * @param {string} cmd 如 'table_info(agents)'
 * @returns {Array}
 */
function pragma(cmd) {
  return dialect.pragma(cmd);
}

/**
 * 返回当前时间字符串。
 */
function now() {
  return dialect.now();
}

/**
 * 运行事务。
 * @param {Function} fn 事务回调，接收一个 dal 实例（本模块的所有方法均可使用）。
 *   事务内异常自动回滚。
 */
function transaction(fn) {
  sqlite3.prepare('BEGIN').run();
  try {
    const result = fn({
      query, get, insert, update, remove, exec, pragma, now, pluck, upsert,
    });
    sqlite3.prepare('COMMIT').run();
    return result;
  } catch (e) {
    sqlite3.prepare('ROLLBACK').run();
    throw e;
  }
}

module.exports = { insert, upsert, update, remove, query, get, pluck, exec, pragma, now, transaction, DIALECT };
