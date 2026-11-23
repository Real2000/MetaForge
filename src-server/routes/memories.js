/** 记忆管理（2026-11-12 P1-5）：跨智能体记忆的查看/搜索/合并/删除/导出
 *  全部接口 adminOnly（后台「记忆管理」页数据源）；按智能体或用户隔离 = 筛选维度（agent_id/username）+ 合并限定同一归属
 *  - GET    /api/memories?q=&agent_id=&username=&type=   列表+搜索+统计
 *  - DELETE /api/memories/:id                            单条删除
 *  - POST   /api/memories/merge { ids, text, type }      合并多条为一条（限定同一智能体+同一用户，防归属混乱）
 *  - GET    /api/memories/export?format=json|csv&...     导出当前筛选结果（json / Excel 兼容 CSV）
 *
 * BE-C1（2026-11-23）增量收敛：本文件全部查询改走 lib/dal 统一出口（q/getq/runq 方言翻译）；
 * 并修复多租户越权缺口——原实现无租户边界，多租户下租户管理员（adminOnly 放行）可见全平台记忆，
 * 现注入 tenant_id 过滤（单租户/平台超管 bypass 无过滤，零回归；agent_memories 为租户域表）。
 */
const express = require('express');
const dal = require('../lib/dal');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

const TYPE_SET = new Set(['fact', 'preference', 'summary']);

/** 组装筛选 WHERE（参数化）：q 关键词 / agent_id / username / type + 租户边界（BE-C1） */
function buildWhere({ q, agent_id, username, type }, scope) {
  const wh = [];
  const args = [];
  if (q) { wh.push('(m.fact LIKE ?)'); args.push(`%${q}%`); }
  if (agent_id) { wh.push('m.agent_id=?'); args.push(agent_id); }
  if (username) { wh.push('m.username=?'); args.push(username); }
  if (type && TYPE_SET.has(type)) { wh.push('m.type=?'); args.push(type); }
  if (scope != null) { wh.push('m.tenant_id=?'); args.push(scope); }
  return { sql: wh.length ? ' WHERE ' + wh.join(' AND ') : '', args };
}

/** 单行租户防护片段（DELETE/UPDATE by id 用）：单租户/超管返回空，多租户追加 AND tenant_id=? */
function tenantGuard(scope) {
  return scope == null ? { sqlStr: '', args: [] } : { sqlStr: ' AND tenant_id=?', args: [scope] };
}

const BASE_SELECT = `SELECT m.id, m.agent_id, m.username, m.fact, m.type, m.confidence, m.source, m.created_at, a.name AS agent_name
  FROM agent_memories m LEFT JOIN agents a ON a.id = m.agent_id`;

router.get('/', adminOnly, (req, res) => {
  const scope = dal.tenantScope(req);
  const { sql, args } = buildWhere(req.query, scope);
  const list = dal.q(`${BASE_SELECT}${sql} ORDER BY m.id DESC LIMIT 500`, args);
  // 全局统计（不含筛选，含租户边界）+ 筛选命中数，卡片与筛选条共用
  const tg = tenantGuard(scope);
  const stat = {
    total: dal.getq(`SELECT COUNT(*) c FROM agent_memories WHERE 1=1${tg.sqlStr}`, tg.args).c,
    fact: dal.getq(`SELECT COUNT(*) c FROM agent_memories WHERE IFNULL(type,'fact')='fact'${tg.sqlStr}`, tg.args).c,
    preference: dal.getq(`SELECT COUNT(*) c FROM agent_memories WHERE type='preference'${tg.sqlStr}`, tg.args).c,
    summary: dal.getq(`SELECT COUNT(*) c FROM agent_memories WHERE type='summary'${tg.sqlStr}`, tg.args).c,
    matched: dal.getq(`SELECT COUNT(*) c FROM agent_memories m${sql}`, args).c,
  };
  res.json({ code: 0, data: { list, stat } });
});

router.delete('/:id', adminOnly, (req, res) => {
  const tg = tenantGuard(dal.tenantScope(req));
  const row = dal.getq(`SELECT * FROM agent_memories WHERE id=?${tg.sqlStr}`, [req.params.id, ...tg.args]);
  if (!row) return res.json({ code: 404, msg: '记忆不存在' });
  dal.runq(`DELETE FROM agent_memories WHERE id=?${tg.sqlStr}`, [row.id, ...tg.args]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)',
    [req.user.username, '删除记忆', `#${row.id}（agent:${row.agent_id}，用户:${row.username}）`, req.ip, dal.now()]);
  res.json({ code: 0, msg: '已删除' });
});

router.post('/merge', adminOnly, (req, res) => {
  const { ids, text, type } = req.body || {};
  const idList = Array.isArray(ids) ? ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  const merged = String(text || '').trim();
  if (idList.length < 2) return res.json({ code: 400, msg: '请勾选至少 2 条记忆进行合并' });
  if (!merged) return res.json({ code: 400, msg: '请填写合并后的记忆内容' });
  if (merged.length > 500) return res.json({ code: 400, msg: '合并内容请控制在 500 字以内' });
  const tg = tenantGuard(dal.tenantScope(req));
  const rows = idList.map(id => dal.getq(`SELECT * FROM agent_memories WHERE id=?${tg.sqlStr}`, [id, ...tg.args])).filter(Boolean);
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
  // BE-C1：dal.transaction 统一出口（异常自动回滚）
  const tx = dal.transaction((d) => {
    // AI-05（2026-11-23）：合并后 fact 已变——向量缓存一并置空（召回侧懒重算），last_used_at 同步清零防陈旧衰减基点
    d.runq('UPDATE agent_memories SET fact=?, type=?, confidence=?, source=?, embedding=NULL, last_used_at=NULL WHERE id=?',
      [merged, newType, maxConf, keep.source || 'admin-merge', keep.id]);
    for (const id of dropIds) d.runq('DELETE FROM agent_memories WHERE id=?', [id]);
    d.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)',
      [req.user.username, '合并记忆', `#${keep.id} ← [${dropIds.join(',')}]（agent:${keep.agent_id}，用户:${keep.username}）`, req.ip, dal.now()]);
  });
  tx();
  res.json({ code: 0, data: { kept: keep.id, dropped: dropIds }, msg: `已合并为 1 条（#${keep.id}）` });
});

router.get('/export', adminOnly, (req, res) => {
  const { format } = req.query;
  const { sql, args } = buildWhere(req.query, dal.tenantScope(req));
  const list = dal.q(`${BASE_SELECT}${sql} ORDER BY m.id DESC LIMIT 5000`, args);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)',
    [req.user.username, '导出记忆', `format:${format || 'json'}，${list.length} 条`, req.ip, dal.now()]);
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
  res.json({ code: 0, exported_at: dal.now(), count: list.length, data: list });
});

module.exports = router;
