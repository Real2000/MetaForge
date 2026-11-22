/**
 * MT-13 支付/订阅闭环路由（2026-11-22）
 *
 * - POST /api/payment/callback/:channel        支付网关回调（免登录；HMAC 验签 fail-closed；幂等按 event_id）
 * - POST /api/payment/orders                   创建订单（订阅 / 充值）
 * - GET  /api/payment/orders                   订单列表（租户管理员本租户 / 平台超管跨租户）
 * - GET  /api/payment/status                   本租户商业状态（订阅 + 钱包）
 * - GET  /api/payment/reconcile?month=         对账：已支付订单金额 = 生效金额（diff=0，平台超管）
 * - POST /api/payment/orders/:orderNo/mark-paid   人工标记已支付（平台超管，运维兜底）
 * - POST /api/payment/orders/:orderNo/refund      退款（平台超管；幂等可重放）
 * - POST /api/payment/orders/:orderNo/sign        生成沙箱回调签名（平台超管，联调用）
 */
const express = require('express');
const { auth, adminOnly, platformAdminOnly } = require('../lib/auth');
const payment = require('../lib/payment');
const { scopeTenant, isPlatformSuper } = require('../lib/tenant');

const router = express.Router();

// 支付网关回调（免登录）：验签在 lib/payment 内做，未配置密钥一律拒绝
router.post('/callback/:channel', (req, res) => {
  const raw = req.rawBody ? req.rawBody.toString('utf8')
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const sign = req.headers['x-pay-sign'] || req.headers['x-signature'] || (req.body && req.body.sign) || '';
  const payload = (req.body && typeof req.body === 'object') ? req.body : undefined;
  const r = payment.handleCallback({ channel: req.params.channel, rawBody: raw, sign, payload });
  if (!r.ok) return res.status(r.code || 400).json({ code: r.code || 400, msg: r.msg });
  res.json({ code: 0, data: { status: r.status, idempotent: !!r.idempotent } });
});

router.use(auth, adminOnly); // 以下端点需管理员

// 创建订单（订阅 / 充值）
router.post('/orders', (req, res) => {
  const b = req.body || {};
  // 租户归属：租户管理员强制本租户；平台超管可经 body.tenant_id 指定，默认自身所在租户
  const tid = isPlatformSuper(req.user)
    ? (Number(b.tenant_id) || req.tenant.id || req.user.tenant_id || 1)
    : (req.tenant.id || req.user.tenant_id);
  const r = payment.createOrder({
    tenantId: tid, type: b.type || 'subscribe', planKey: b.plan_key,
    amount: b.amount, channel: b.channel, subject: b.subject, operator: req.user.username,
  });
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  res.json({ code: 0, data: r.order });
});

// 订单列表
router.get('/orders', (req, res) => {
  const scope = scopeTenant(req); // null = 全部（平台超管未指定 / 单租户）
  res.json({ code: 0, data: payment.listOrders(scope, { status: req.query.status, limit: req.query.limit }) });
});

// 本租户商业状态（订阅 + 钱包）
router.get('/status', (req, res) => {
  const tid = scopeTenant(req);
  const useTid = tid != null ? tid : (req.tenant.id || req.user.tenant_id || 1);
  res.json({ code: 0, data: payment.tenantStatus(useTid) });
});

// 对账（平台超管）
router.get('/reconcile', platformAdminOnly, (req, res) => {
  res.json({ code: 0, data: payment.reconcile({ month: req.query.month }) });
});

// 人工标记已支付（平台超管，运维兜底；幂等）
router.post('/orders/:orderNo/mark-paid', platformAdminOnly, (req, res) => {
  const b = req.body || {};
  const r = payment.markPaid(req.params.orderNo, { amount: b.amount, channel: b.channel || 'manual', operator: req.user.username });
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  res.json({ code: 0, data: r.order });
});

// 退款（平台超管；幂等）
router.post('/orders/:orderNo/refund', platformAdminOnly, (req, res) => {
  const r = payment.refund({ orderNo: req.params.orderNo, operator: req.user.username, reason: (req.body || {}).reason });
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  res.json({ code: 0, data: r.order });
});

// 生成沙箱回调签名（平台超管，无真实网关时联调用）：返回 raw+sign，直接 POST 到 /api/payment/callback/sandbox
router.post('/orders/:orderNo/sign', platformAdminOnly, (req, res) => {
  const o = payment.getOrder(req.params.orderNo);
  if (!o) return res.json({ code: 404, msg: '订单不存在' });
  const secret = payment.callbackSecret();
  if (!secret) return res.json({ code: 400, msg: '未配置 PAYMENT_CALLBACK_SECRET' });
  const body = { order_no: o.order_no, event_id: (req.body || {}).event_id || ('evt_' + Date.now()), status: 'paid', amount: o.amount };
  const raw = JSON.stringify(body);
  res.json({ code: 0, data: { raw, sign: payment.signPayload(raw, secret), body } });
});

module.exports = router;
