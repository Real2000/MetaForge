/**
 * D2-2 计费用量感知闭环路由（2026-11-21）
 *
 * - GET  /api/billing/reconcile?month=YYYY-MM   对账报表：单价 × 用量 = 应收（adminOnly）
 * - GET  /api/billing/holds?limit=              预留台账明细（adminOnly）
 * - GET  /api/billing/stats?month=YYYY-MM       闸门统计：预检/拦截/并发（adminOnly）
 * - GET  /api/billing/my                        本人计费状态（并发上限/成本配额/本月成本）
 * - PUT  /api/billing/users/:username           设置用户成本配额与并发上限（adminOnly）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const gate = require('../lib/billing-gate');

const router = express.Router();
router.use(auth);

// 对账报表：单价 × 用量 = 应收（可核应收）
router.get('/reconcile', adminOnly, (req, res) => {
  res.json({ code: 0, data: gate.reconcile({ month: req.query.month }) });
});

// 预留台账明细
router.get('/holds', adminOnly, (req, res) => {
  const limit = Math.min(500, Math.max(1, Math.floor(+req.query.limit || 100)));
  const rows = db.prepare('SELECT * FROM billing_holds ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ code: 0, data: rows });
});

// 闸门统计
router.get('/stats', adminOnly, (req, res) => {
  res.json({ code: 0, data: gate.stats({ month: req.query.month }) });
});

// 本人计费状态（对话页/个人中心展示并发与成本配额）
router.get('/my', (req, res) => {
  const username = req.user.username;
  const u = db.prepare('SELECT quota_total, quota_used, cost_quota, max_concurrency FROM users WHERE username=?').get(username) || {};
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
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username);
  if (!u) return res.json({ code: 404, msg: '用户不存在' });
  const body = req.body || {};
  const sets = [], detail = [];
  if (body.cost_quota !== undefined) {
    const v = Math.max(0, Number(body.cost_quota) || 0);
    db.prepare('UPDATE users SET cost_quota=? WHERE username=?').run(v, u.username);
    sets.push('cost_quota'); detail.push(`成本配额 → ${v === 0 ? '不限' : '¥' + v.toFixed(2) + '/月'}`);
  }
  if (body.max_concurrency !== undefined) {
    const v = Math.max(0, Math.floor(Number(body.max_concurrency) || 0));
    db.prepare('UPDATE users SET max_concurrency=? WHERE username=?').run(v, u.username);
    sets.push('max_concurrency'); detail.push(`并发上限 → ${v === 0 ? '不限' : v}`);
  }
  if (!sets.length) return res.json({ code: 400, msg: '无可更新字段（cost_quota / max_concurrency）' });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '设置计费参数', `${u.username}：${detail.join('，')}`, req.ip, now());
  res.json({ code: 0, msg: '已保存：' + detail.join('，') });
});

module.exports = router;
