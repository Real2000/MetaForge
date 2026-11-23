/**
 * P1-18 仓储分层 — 通用 SQL 工具箱（2026-11-13）
 *
 * 目标：为所有 repo 模块提供统一的查询工具，消除路由/lib 中散落的直接 prepare 链式调用样板。
 *
 * 设计原则：
 *   1) 零心智负担 — 只封装查询构建，不引入 ORM 概念；
 *   2) 显式优于隐式 — 不隐藏底层 SQL，不搞自动映射；
 *   3) 渐进式迁移 — 新功能直接走 repo，存量代码逐步替换，不要求一次性全改。
 */
const { db, now } = require('../db');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

/** 单行查询（有则返回对象，无则 null） */
function get(sql, ...params) {
  return dal.getq(sql, [...params]);
}

/** 多行查询 */
function all(sql, ...params) {
  return dal.q(sql, [...params]);
}

/** 执行（返回 info 对象 { changes, lastInsertRowid }） */
function run(sql, ...params) {
  return dal.runq(sql, [...params]);
}

/** 单值查询（如 COUNT、MAX 等聚合结果） */
function scalar(sql, ...params) {
  const row = dal.getq(sql, [...params]);
  if (!row) return null;
  const vals = Object.values(row);
  return vals.length ? vals[0] : null;
}

/** 事务 */
function transaction(fn) {
  return db.transaction(fn);
}

/** 批量 INSERT 多行 */
function insertMany(table, rows) {
  if (!rows || !rows.length) return;
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  const tx = db.transaction((items) => {
    for (const item of items) stmt.run(...cols.map(c => item[c]));
  });
  tx(rows);
  return rows.length;
}

/** 写入操作日志 */
function opLog(username, action, detail, ip) {
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [username || '匿名', String(action).slice(0,200), String(detail || '').slice(0,500), ip || '', now()]);
}

module.exports = { db, now, get, all, run, scalar, transaction, insertMany, opLog };