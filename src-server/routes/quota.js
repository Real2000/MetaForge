/**
 * 用量报表（2026-10-20 P2）：用户 Token 配额管理与用量统计
 * - GET  /api/quota/my            本人配额状态（对话页常驻用量条 + 80%/90% 预警横幅数据源）
 * - GET  /api/quota/report        用量总览（每用户配额/已用/占比 + 全平台汇总 + 近 14 天趋势）
 * - GET  /api/quota/tenants        MT-11 租户维度配额聚合（平台超管跨租户 / 租户管理员本租户）
 * - PUT  /api/quota/users/:name   设置用户配额（body: { total }，0=不限；重置预警档位重新计）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { quotaOf, resetQuotaAlert, tenantQuotaSummary } = require('../lib/quota');
const { scopeTenant } = require('../lib/tenant');

const router = express.Router();
router.use(auth);

// 本人配额状态（auth 级，全员可用）
router.get('/my', (req, res) => {
  res.json({ code: 0, data: quotaOf(req.user.username) });
});

// MT-11：租户维度配额聚合（tenant_id → username）
router.get('/tenants', adminOnly, (req, res) => {
  res.json({ code: 0, data: tenantQuotaSummary(scopeTenant(req)) });
});

router.get('/report', adminOnly, (req, res) => {
  const tid = scopeTenant(req);
  const users = tid == null
    ? dal.q(`SELECT u.id, u.username, u.nickname, u.dept, u.quota_total, u.quota_used, u.cost_quota, u.max_concurrency, u.status FROM users u ORDER BY u.quota_used DESC`)
    : dal.q(`SELECT u.id, u.username, u.nickname, u.dept, u.quota_total, u.quota_used, u.cost_quota, u.max_concurrency, u.status FROM users u WHERE u.tenant_id=? ORDER BY u.quota_used DESC`, [tid]);
  const rows = users.map(u => {
    const q = quotaOf(u.username);
    return {
      username: u.username, nickname: u.nickname, dept: u.dept, status: u.status,
      quota_total: q.total, quota_used: q.used, remaining: q.remaining === Infinity ? -1 : q.remaining,
      percent: q.percent, unlimited: q.unlimited,
      cost_quota: u.cost_quota || 0, max_concurrency: u.max_concurrency || 0,
    };
  });
  // 全平台汇总
  const summary = {
    total_users: rows.length,
    limited_users: rows.filter(r => !r.unlimited).length,
    quota_total: rows.reduce((s, r) => s + r.quota_total, 0),
    quota_used: rows.reduce((s, r) => s + r.quota_used, 0),
  };
  // 近 14 天用量趋势（按 messages.tokens 聚合；多租户下按租户收敛）
  const tf = tid == null ? '' : ' AND m.tenant_id=?';
  const trend = dal.q(`
    SELECT substr(m.created_at, 1, 10) day, SUM(m.tokens) tokens
    FROM messages m
    WHERE m.created_at >= datetime('now', '-14 day', 'localtime')${tf}
    GROUP BY day ORDER BY day`, [...(tid == null ? [] : [tid])]);
  // 按智能体用量 TOP10（近 30 天）
  const af = tid == null ? '' : ' AND ct.tenant_id=?';
  const byAgent = dal.q(`
    SELECT a.name agent_name, SUM(ct.tokens) tokens, COUNT(*) calls
    FROM chat_traces ct LEFT JOIN agents a ON a.id = ct.agent_id
    WHERE ct.created_at >= datetime('now', '-30 day', 'localtime')${af}
    GROUP BY ct.agent_id ORDER BY tokens DESC LIMIT 10`, [...(tid == null ? [] : [tid])]);
  // 按模型/供应商用量 TOP10（近 30 天，chat_traces.model + 网关侧不可得供应商时降级为模型名）
  const byModel = dal.q(`
    SELECT model, SUM(tokens) tokens, COUNT(*) calls
    FROM chat_traces
    WHERE created_at >= datetime('now', '-30 day', 'localtime') AND model != ''${tid == null ? '' : ' AND tenant_id=?'}
    GROUP BY model ORDER BY tokens DESC LIMIT 10`, [...(tid == null ? [] : [tid])]);
  res.json({ code: 0, data: { rows, summary, trend, byAgent, byModel } });
});

router.put('/users/:username', adminOnly, (req, res) => {
  const u = dal.getq('SELECT * FROM users WHERE username=?', [req.params.username]);
  if (!u) return res.json({ code: 404, msg: '用户不存在' });
  // MT-11：租户管理员仅能调整本租户用户配额（跨租户 fail-closed）
  const tid = scopeTenant(req);
  if (tid != null && Number(u.tenant_id) !== Number(tid)) {
    return res.status(403).json({ code: 403, msg: '无权调整其他租户用户的配额' });
  }
  const total = Math.max(0, Math.floor(+(req.body || {}).total || 0)); // 0=不限
  dal.runq('UPDATE users SET quota_total=? WHERE username=?', [total, u.username]);
  resetQuotaAlert(u.username); // 新配额周期重新计预警（80%/90% 各重发一次）
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '设置配额', `${u.username} → ${total === 0 ? '不限' : total.toLocaleString('zh-CN') + ' tokens'}`, req.ip, now()]);
  res.json({ code: 0, msg: total === 0 ? '已设为不限量' : `配额已设为 ${total.toLocaleString('zh-CN')} tokens` });
});

module.exports = router;
