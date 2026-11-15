/**
 * U1-1 内建数据库路由（2026-11-14）
 *
 * 覆盖已落地功能：
 *   - 工作流 database 节点（复用 sanitizeSelectSql 安全层，只读）
 *   - app_tables（用户可创建自定义表，写入/查询行数据）
 *
 * 新增能力：
 *  GET    /api/database/tables          — 我的表列表
 *  POST   /api/database/tables          — 建表（列定义 JSON）
 *  GET    /api/database/tables/:id      — 表详情
 *  PUT    /api/database/tables/:id      — 更新表定义/限制
 *  DELETE /api/database/tables/:id      — 删表（清空行数据）
 *  GET    /api/database/tables/:id/rows — 查询行数据
 *  POST   /api/database/tables/:id/rows — 插入行数据
 *  PUT    /api/database/tables/:id/rows/:rid — 更新行
 *  DELETE /api/database/tables/:id/rows/:rid — 删除行
 *
 * 配额：每用户上限 20 个表，每表上限 5000 行
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

const MAX_TABLES_PER_USER = 20;
const MAX_ROWS_PER_TABLE = 5000;

/* ==================== 表管理 ==================== */

router.get('/tables', (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const username = req.user.role === 'admin' ? req.query.owner || null : req.user.username;
  let sql = 'SELECT * FROM app_tables WHERE 1=1';
  const args = [];
  if (username) { sql += ' AND owner=?'; args.push(username); }
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) c')).get(...args).c;
  const rows = db.prepare(sql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, +pageSize, (+page - 1) * +pageSize);
  res.json({ code: 0, data: { list: rows, total, page: +page, pageSize: +pageSize } });
});

router.post('/tables', (req, res) => {
  const { name, display_name, description, columns, max_rows } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '表名不能为空' });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,19}$/.test(name)) return res.json({ code: 400, msg: '表名必须为20字符内的字母数字下划线' });
  // 配额检查
  const count = db.prepare('SELECT COUNT(*) c FROM app_tables WHERE owner=?').get(req.user.username).c;
  if (count >= MAX_TABLES_PER_USER) return res.json({ code: 400, msg: `表数量已达上限（${MAX_TABLES_PER_USER}个），无法创建更多` });
  let cols = [];
  try { cols = JSON.parse(columns || '[]'); } catch { return res.json({ code: 400, msg: 'columns 格式错误，请提供有效的 JSON' }); }
  if (!Array.isArray(cols) || !cols.length) return res.json({ code: 400, msg: '请至少定义一个列' });
  try {
    const info = db.prepare(`INSERT INTO app_tables (name, display_name, description, columns, max_rows, owner, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(name, display_name || '', description || '', JSON.stringify(cols), Math.min(max_rows || MAX_ROWS_PER_TABLE, MAX_ROWS_PER_TABLE), req.user.username, now(), now());
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '创建数据表', `table:${name} columns:${cols.length}`, req.ip, now());
    res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.json({ code: 400, msg: '表名已存在' });
    throw e;
  }
});

router.get('/tables/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!row) return res.json({ code: 404, msg: '表不存在' });
  if (row.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权访问' });
  res.json({ code: 0, data: row });
});

router.put('/tables/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '表不存在' });
  if (old.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权修改' });
  const { display_name, description, max_rows } = req.body || {};
  const fields = []; const vals = [];
  if (display_name !== undefined) { fields.push('display_name=?'); vals.push(display_name); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description); }
  if (max_rows !== undefined) { fields.push('max_rows=?'); vals.push(Math.min(max_rows, MAX_ROWS_PER_TABLE)); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(old.id);
  db.prepare(`UPDATE app_tables SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ code: 0 });
});

router.delete('/tables/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '表不存在' });
  if (old.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权删除' });
  // 清空行数据 + 删表
  db.prepare('DELETE FROM app_table_rows WHERE table_id=?').run(old.id);
  db.prepare('DELETE FROM app_tables WHERE id=?').run(old.id);
  res.json({ code: 0 });
});

/* ==================== 行数据管理 ==================== */

router.get('/tables/:id/rows', (req, res) => {
  const t = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!t) return res.json({ code: 404, msg: '表不存在' });
  if (t.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权访问' });
  const { page = 1, pageSize = 50, q } = req.query;
  let sql = 'SELECT * FROM app_table_rows WHERE table_id=?';
  const args = [t.id];
  if (q) { sql += ' AND data LIKE ?'; args.push(`%${q}%`); }
  const total = db.prepare('SELECT COUNT(*) c FROM app_table_rows WHERE table_id=?').get(t.id).c;
  const rows = db.prepare(sql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, +pageSize, (+page - 1) * +pageSize);
  res.json({ code: 0, data: { list: rows.map(r => ({ ...r, data: tryParse(r.data) })), total, page: +page, pageSize: +pageSize } });
});

router.post('/tables/:id/rows', (req, res) => {
  const t = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!t) return res.json({ code: 404, msg: '表不存在' });
  if (t.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权写入' });
  // 行数配额检查
  const cnt = db.prepare('SELECT COUNT(*) c FROM app_table_rows WHERE table_id=?').get(t.id).c;
  if (cnt >= t.max_rows) return res.json({ code: 400, msg: `行数已达上限（${t.max_rows} 行）` });
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.json({ code: 400, msg: 'data 必须为对象' });
  const info = db.prepare('INSERT INTO app_table_rows (table_id, data, created_at, updated_at) VALUES (?,?,?,?)').run(t.id, JSON.stringify(data), now(), now());
  // 更新表行数快照
  db.prepare('UPDATE app_tables SET row_count=?,updated_at=? WHERE id=?').run(cnt + 1, now(), t.id);
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
});

router.put('/tables/:id/rows/:rid', (req, res) => {
  const t = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!t) return res.json({ code: 404, msg: '表不存在' });
  if (t.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权修改' });
  const oldRow = db.prepare('SELECT * FROM app_table_rows WHERE id=? AND table_id=?').get(req.params.rid, t.id);
  if (!oldRow) return res.json({ code: 404, msg: '行不存在' });
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.json({ code: 400, msg: 'data 必须为对象' });
  db.prepare('UPDATE app_table_rows SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(data), now(), oldRow.id);
  res.json({ code: 0 });
});

router.delete('/tables/:id/rows/:rid', (req, res) => {
  const t = db.prepare('SELECT * FROM app_tables WHERE id=?').get(req.params.id);
  if (!t) return res.json({ code: 404, msg: '表不存在' });
  if (t.owner !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '无权删除' });
  db.prepare('DELETE FROM app_table_rows WHERE id=? AND table_id=?').run(req.params.rid, t.id);
  const cnt = db.prepare('SELECT COUNT(*) c FROM app_table_rows WHERE table_id=?').get(t.id).c;
  db.prepare('UPDATE app_tables SET row_count=?,updated_at=? WHERE id=?').run(cnt, now(), t.id);
  res.json({ code: 0 });
});

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = router;