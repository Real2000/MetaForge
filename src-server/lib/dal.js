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
const sqlDialect = require('./sql-dialect');

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
      query, get, insert, update, remove, exec, pragma, now, pluck, upsert, q, getq, runq,
    });
    sqlite3.prepare('COMMIT').run();
    return result;
  } catch (e) {
    sqlite3.prepare('ROLLBACK').run();
    throw e;
  }
}

/* ==================== BE-C1 / MT-05：统一查询出口 ==================== */

/**
 * SQL 出口翻译：所有经 dal 出口的 SQL 先过方言层（sqlite 恒等，零回归）。
 * 供「方言层可拦截全部 SQL」目标使用。
 * @param {string} sql
 * @returns {string}
 */
function translateSql(sql) {
  return sqlDialect.translate(sql, DIALECT).sql;
}

/** 经方言出口查询多行 */
function q(sql, params) {
  return sqlite3.prepare(translateSql(sql)).all(...(Array.isArray(params) ? params : []));
}
/** 经方言出口查询单行 */
function getq(sql, params) {
  return sqlite3.prepare(translateSql(sql)).get(...(Array.isArray(params) ? params : []));
}
/** 经方言出口执行写入（INSERT/UPDATE/DELETE），返回 { changes, lastInsertRowid } */
function runq(sql, params) {
  return sqlite3.prepare(translateSql(sql)).run(...(Array.isArray(params) ? params : []));
}

/* ---------- MT-05 租户过滤出口（统一注入） ---------- */

/**
 * 从请求解析租户范围：单租户模式返回 null（不启用边界）；多租户返回整数 tenant_id。
 * @param {object} req Express 请求（须已过 tenantContext 中间件，挂 req.tenant）
 * @returns {number|null}
 */
function tenantScope(req) {
  if (!req || !req.tenant || req.tenant.single) return null;
  const id = req.tenant.id;
  return (id != null && Number.isFinite(Number(id))) ? Number(id) : null;
}

/**
 * 生成租户过滤 SQL 片段（供各资源查询统一拼接，禁止路由自拼 tenant 条件）。
 * 单租户（scope=null）→ 空片段（零回归）；多租户 → ` AND <alias>.tenant_id=?`。
 * @param {string} [alias] 表别名（如 'a'）；缺省为无别名
 * @param {number|null} scope tenantScope(req) 的返回值
 * @returns {{sqlStr:string, args:Array}}
 */
function tenantWhere(alias, scope) {
  if (scope == null) return { sqlStr: '', args: [] };
  const a = alias ? `${alias}.` : '';
  return { sqlStr: ` AND ${a}tenant_id=?`, args: [scope] };
}

module.exports = {
  insert, upsert, update, remove, query, get, pluck, exec, pragma, now, transaction,
  q, getq, runq, translateSql, tenantScope, tenantWhere, DIALECT,
};
