/**
 * D2-2 计费用量感知闭环路由（2026-11-21）
 *
 * - GET  /api/billing/reconcile?month=YYYY-MM   对账报表：单价 × 用量 = 应收（adminOnly）
 * - GET  /api/billing/holds?limit=              预留台账明细（adminOnly）
 * - GET  /api/billing/stats?month=YYYY-MM       闸门统计：预检/拦截/并发（adminOnly）
 * - GET  /api/billing/my                        本人计费状态（并发上限/成本配额/本月成本）
 * - PUT  /api/billing/users/:username           设置用户成本配额与并发上限（adminOnly）
 * - GET  /api/billing/tenants?month=            MT-11 租户维度成本聚合（平台超管跨租户 / 租户管理员本租户）
 * - GET  /api/billing/tenant?month=             MT-11 租户账单明细（tenant_id → username 两级）
 * - GET  /api/billing/tenant/export?month=      MT-11 租户账单导出（CSV，Excel 直开）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const gate = require('../lib/billing-gate');
const billing = require('../lib/billing');
const { scopeTenant } = require('../lib/tenant');

const router = express.Router();
router.use(auth);

// 对账报表：单价 × 用量 = 应收（可核应收）
router.get('/reconcile', adminOnly, (req, res) => {
  res.json({ code: 0, data: gate.reconcile({ month: req.query.month }) });
});

// 预留台账明细
router.get('/holds', adminOnly, (req, res) => {
  const limit = Math.min(500, Math.max(1, Math.floor(+req.query.limit || 100)));
  const tid = scopeTenant(req);
  const rows = tid == null
    ? dal.q('SELECT * FROM billing_holds ORDER BY id DESC LIMIT ?', [limit])
    : dal.q('SELECT * FROM billing_holds WHERE tenant_id=? ORDER BY id DESC LIMIT ?', [tid, limit]);
  res.json({ code: 0, data: rows });
});

// MT-11：租户维度成本聚合（平台超管跨租户或经 ?tenant_id= 指定；租户管理员仅本租户）
router.get('/tenants', adminOnly, (req, res) => {
  const tid = scopeTenant(req);
  res.json({ code: 0, data: billing.tenantCostOfMonth(req.query.month, tid) });
});

// MT-11：租户账单明细（tenant_id → username 两级；两租户互不串账）
router.get('/tenant', adminOnly, (req, res) => {
  const tid = scopeTenant(req);
  res.json({ code: 0, data: billing.tenantReport({ month: req.query.month, tenantId: tid }) });
});

// MT-11：租户账单导出（CSV）
router.get('/tenant/export', adminOnly, (req, res) => {
  const tid = scopeTenant(req);
  const { csv, month, total, rowCount } = billing.tenantReportCsv({ month: req.query.month, tenantId: tid });
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '导出租户账单', `${month}（${rowCount} 行，合计 ¥${total}）`, req.ip, now()]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tenant-billing-${month}.csv"`);
  res.send(csv);
});

// 闸门统计
router.get('/stats', adminOnly, (req, res) => {
  res.json({ code: 0, data: gate.stats({ month: req.query.month }) });
});

// 本人计费状态（对话页/个人中心展示并发与成本配额）
router.get('/my', (req, res) => {
  const username = req.user.username;
  const u = dal.getq('SELECT quota_total, quota_used, cost_quota, max_concurrency FROM users WHERE username=?', [username]) || {};
  res.json({
    code: 0,
    data: {
      cost_quota: u.cost_quota || 0,
      max_concurrency: u.max_concurrency || 0,
      active: gate.activeConcurrency(username),
      month_cost: gate.monthCostOfUser(username),
      quota_total: u.quota_total || 0,
      quota_used: u.quota_used || 0,
    },
  });
});

// 设置用户计费参数（成本配额 / 并发上限，0=不限）
router.put('/users/:username', adminOnly, (req, res) => {
  const u = dal.getq('SELECT * FROM users WHERE username=?', [req.params.username]);
  if (!u) return res.json({ code: 404, msg: '用户不存在' });
  // MT-11：租户管理员仅能调整本租户用户计费参数（跨租户 fail-closed）
  const scopeTid = scopeTenant(req);
  if (scopeTid != null && Number(u.tenant_id) !== Number(scopeTid)) {
    return res.status(403).json({ code: 403, msg: '无权调整其他租户用户的计费参数' });
  }
  const body = req.body || {};
  const sets = [], detail = [];
  if (body.cost_quota !== undefined) {
    const v = Math.max(0, Number(body.cost_quota) || 0);
    dal.runq('UPDATE users SET cost_quota=? WHERE username=?', [v, u.username]);
    sets.push('cost_quota'); detail.push(`成本配额 → ${v === 0 ? '不限' : '¥' + v.toFixed(2) + '/月'}`);
  }
  if (body.max_concurrency !== undefined) {
    const v = Math.max(0, Math.floor(Number(body.max_concurrency) || 0));
    dal.runq('UPDATE users SET max_concurrency=? WHERE username=?', [v, u.username]);
    sets.push('max_concurrency'); detail.push(`并发上限 → ${v === 0 ? '不限' : v}`);
  }
  if (!sets.length) return res.json({ code: 400, msg: '无可更新字段（cost_quota / max_concurrency）' });
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '设置计费参数', `${u.username}：${detail.join('，')}`, req.ip, now()]);
  res.json({ code: 0, msg: '已保存：' + detail.join('，') });
});

module.exports = router;
