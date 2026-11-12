/** 记忆管理（2026-11-12 P1-5）：跨智能体记忆的查看/搜索/合并/删除/导出
 *  全部接口 adminOnly（后台「记忆管理」页数据源）；按智能体或用户隔离 = 筛选维度（agent_id/username）+ 合并限定同一归属
 *  - GET    /api/memories?q=&agent_id=&username=&type=   列表+搜索+统计
 *  - DELETE /api/memories/:id                            单条删除
 *  - POST   /api/memories/merge { ids, text, type }      合并多条为一条（限定同一智能体+同一用户，防归属混乱）
 *  - GET    /api/memories/export?format=json|csv&...     导出当前筛选结果（json / Excel 兼容 CSV）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

const TYPE_SET = new Set(['fact', 'preference', 'summary']);

/** 组装筛选 WHERE（参数化）：q 关键词 / agent_id / username / type */
function buildWhere({ q, agent_id, username, type }) {
  const wh = [];
  const args = [];
  if (q) { wh.push('(m.fact LIKE ?)'); args.push(`%${q}%`); }
  if (agent_id) { wh.push('m.agent_id=?'); args.push(agent_id); }
  if (username) { wh.push('m.username=?'); args.push(username); }
  if (type && TYPE_SET.has(type)) { wh.push('m.type=?'); args.push(type); }
  return { sql: wh.length ? ' WHERE ' + wh.join(' AND ') : '', args };
}

const BASE_SELECT = `SELECT m.id, m.agent_id, m.username, m.fact, m.type, m.confidence, m.source, m.created_at, a.name AS agent_name
  FROM agent_memories m LEFT JOIN agents a ON a.id = m.agent_id`;

router.get('/', adminOnly, (req, res) => {
  const { q, agent_id, username, type } = req.query;
  const { sql, args } = buildWhere(req.query);
  const list = db.prepare(`${BASE_SELECT}${sql} ORDER BY m.id DESC LIMIT 500`).all(...args);
  // 全局统计（不含筛选）+ 筛选命中数，卡片与筛选条共用
  const stat = {
    total: db.prepare('SELECT COUNT(*) c FROM agent_memories').get().c,
    fact: db.prepare(`SELECT COUNT(*) c FROM agent_memories WHERE IFNULL(type,'fact')='fact'`).get().c,
    preference: db.prepare(`SELECT COUNT(*) c FROM agent_memories WHERE type='preference'`).get().c,
    summary: db.prepare(`SELECT COUNT(*) c FROM agent_memories WHERE type='summary'`).get().c,
    matched: db.prepare(`SELECT COUNT(*) c FROM agent_memories m${sql}`).get(...args).c,
  };
  res.json({ code: 0, data: { list, stat } });
});

router.delete('/:id', adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM agent_memories WHERE id=?').get(req.params.id);
  if (!row) return res.json({ code: 404, msg: '记忆不存在' });
  db.prepare('DELETE FROM agent_memories WHERE id=?').run(row.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '删除记忆', `#${row.id}（agent:${row.agent_id}，用户:${row.username}）`, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

router.post('/merge', adminOnly, (req, res) => {
  const { ids, text, type } = req.body || {};
  const idList = Array.isArray(ids) ? ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  const merged = String(text || '').trim();
  if (idList.length < 2) return res.json({ code: 400, msg: '请勾选至少 2 条记忆进行合并' });
  if (!merged) return res.json({ code: 400, msg: '请填写合并后的记忆内容' });
  if (merged.length > 500) return res.json({ code: 400, msg: '合并内容请控制在 500 字以内' });
  const rows = idList.map(id => db.prepare('SELECT * FROM agent_memories WHERE id=?').get(id)).filter(Boolean);
  if (rows.length !== idList.length) return res.json({ code: 404, msg: '部分记忆不存在或已被删除，请刷新后重试' });
  // 隔离约束：合并限定同一智能体 + 同一用户（跨归属合并会导致记忆注入错乱）
  const sameAgent = new Set(rows.map(r => r.agent_id)).size === 1;
  const sameUser = new Set(rows.map(r => r.username)).size === 1;
  if (!sameAgent || !sameUser) return res.json({ code: 400, msg: '只能合并同一智能体、同一用户名下的记忆' });
  // 保留最早一条（id 最小）作为合并结果；类型可指定，默认 fact；置信度取被合并记录中的最高值
  rows.sort((a, b) => a.id - b.id);
  const keep = rows[0];
  const dropIds = rows.slice(1).map(r => r.id);
  const newType = TYPE_SET.has(type) ? type : (TYPE_SET.has(keep.type) ? keep.type : 'fact');
  const maxConf = Math.max(...rows.map(r => (r.confidence == null ? 1.0 : r.confidence)));
  const tx = db.transaction(() => {
    db.prepare('UPDATE agent_memories SET fact=?, type=?, confidence=?, source=? WHERE id=?')
      .run(merged, newType, maxConf, keep.source || 'admin-merge', keep.id);
    for (const id of dropIds) db.prepare('DELETE FROM agent_memories WHERE id=?').run(id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '合并记忆', `#${keep.id} ← [${dropIds.join(',')}]（agent:${keep.agent_id}，用户:${keep.username}）`, req.ip, now());
  });
  tx();
  res.json({ code: 0, data: { kept: keep.id, dropped: dropIds }, msg: `已合并为 1 条（#${keep.id}）` });
});

router.get('/export', adminOnly, (req, res) => {
  const { format } = req.query;
  const { sql, args } = buildWhere(req.query);
  const list = db.prepare(`${BASE_SELECT}${sql} ORDER BY m.id DESC LIMIT 5000`).all(...args);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '导出记忆', `format:${format || 'json'}，${list.length} 条`, req.ip, now());
  if (format === 'csv') {
    // Excel 兼容：BOM 头防中文乱码；字段含逗号/引号/换行时按 CSV 规则转义
    const escCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const header = ['id', 'agent_id', 'agent_name', 'username', 'type', 'confidence', 'fact', 'source', 'created_at'];
    const lines = [header.map(escCell).join(',')];
    for (const r of list) lines.push(header.map(h => escCell(r[h])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="memories.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="memories.json"');
  res.json({ code: 0, exported_at: now(), count: list.length, data: list });
});

module.exports = router;
