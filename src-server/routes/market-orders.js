/**
 * U2-5 Phase 2 市场订单管理（2026-11-16）
 *
 * POST   /api/market/orders                — 创建订单（购买/订阅商品）
 * GET    /api/market/orders                — 我的订单列表
 * GET    /api/market/orders/:id            — 订单详情
 * POST   /api/market/orders/:id/pay        — 模拟支付成功（回调）
 * POST   /api/market/orders/:id/cancel     — 取消订单
 * GET    /api/market/orders/admin/all      — 管理员：所有订单列表
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const crypto = require('crypto');
const router = express.Router();
router.use(auth);

// 辅助：生成订单号
function genOrderNo() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AP${ts}${rand}`;
}

// ---------- 创建订单 ----------
router.post('/', async (req, res) => {
  const { product_id } = req.body || {};
  if (!product_id) return res.json({ code: 400, msg: '请指定商品 ID' });

  const product = db.prepare(`
    SELECT mp.*, a.name AS agent_name, a.owner AS agent_owner
    FROM market_products mp
    JOIN agents a ON a.id = mp.agent_id
    WHERE mp.id=? AND mp.status='active'
  `).get(product_id);
  if (!product) return res.json({ code: 404, msg: '商品不存在或已下架' });

  // 防止重复：同商品同买家处于 pending/paid/completed 状态的不允许再购买（除非已 cancelled/refunded）
  if (product.price_type === 'one_time') {
    const exist = db.prepare("SELECT id FROM market_orders WHERE product_id=? AND buyer=? AND status IN ('pending','paid','completed')").get(product_id, req.user.username);
    if (exist) return res.json({ code: 400, msg: '你已经购买过该商品，无需重复购买' });
  }

  const orderNo = genOrderNo();
  const info = db.prepare(`INSERT INTO market_orders (order_no,product_id,agent_id,buyer,price,price_type,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,?)`).run(orderNo, product_id, product.agent_id, req.user.username, product.price, product.price_type, now(), now());

  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '创建市场订单', `商品「${product.agent_name}」${orderNo}`, req.ip, now());

  res.json({ code: 0, data: { id: info.lastInsertRowid, order_no: orderNo, amount: product.price }, msg: '订单已创建' });
});

// ---------- 我的订单列表 ----------
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, mp.name AS product_name, a.name AS agent_name, a.icon
    FROM market_orders o
    JOIN market_products mp ON mp.id = o.product_id
    JOIN agents a ON a.id = o.agent_id
    WHERE o.buyer=?
    ORDER BY o.id DESC
  `).all(req.user.username);
  res.json({ code: 0, data: rows });
});

// ---------- 订单详情 ----------
router.get('/:id', (req, res) => {
  const o = db.prepare(`
    SELECT o.*, mp.name AS product_name, mp.price_type AS product_price_type, a.name AS agent_name, a.icon
    FROM market_orders o
    JOIN market_products mp ON mp.id = o.product_id
    JOIN agents a ON a.id = o.agent_id
    WHERE o.id=? AND (o.buyer=? OR ?='admin')
  `).get(req.params.id, req.user.username, req.user.role);
  if (!o) return res.json({ code: 404, msg: '订单不存在' });
  res.json({ code: 0, data: o });
});

// ---------- 模拟支付成功（回调） ----------
router.post('/:id/pay', async (req, res) => {
  const o = db.prepare("SELECT * FROM market_orders WHERE id=? AND buyer=? AND status='pending'").get(req.params.id, req.user.username);
  if (!o) return res.json({ code: 404, msg: '订单不存在或已处理' });

  // 模拟支付成功，更新订单状态
  const nowStr = now();
  const product = db.prepare('SELECT * FROM market_products WHERE id=?').get(o.product_id);

  let subscriptionEnd = null;
  if (o.price_type === 'subscription') {
    // 订阅类型：计算到期时间（默认当前时间 + 1 个月）
    const period = product?.subscription_period || 'month';
    const d = new Date();
    if (period === 'year') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    subscriptionEnd = d.toISOString().replace('T', ' ').slice(0, 19);
  }

  db.prepare('UPDATE market_orders SET status=?, paid_at=?, subscription_end=?, updated_at=? WHERE id=?')
    .run('paid', nowStr, subscriptionEnd, nowStr, o.id);

  // 记录到 usage_records（market 维度）
  try {
    db.prepare(`INSERT INTO usage_records (username, dimension, dimension_key, tokens, count, cost, meta, created_at)
      VALUES (?, 'market', ?, 0, 1, ?, ?, ?)`)
      .run(req.user.username, `order:${o.order_no}`, o.price, JSON.stringify({ order_id: o.id, product_id: o.product_id, price_type: o.price_type }), nowStr);
  } catch { /* 计费记录失败不影响订单完成 */ }

  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '支付订单', `${o.order_no}（¥${o.price}）`, req.ip, nowStr);

  res.json({ code: 0, msg: '支付成功', data: { order_no: o.order_no, status: 'paid', subscription_end: subscriptionEnd } });
});

// ---------- 取消订单 ----------
router.post('/:id/cancel', async (req, res) => {
  const o = db.prepare("SELECT * FROM market_orders WHERE id=? AND buyer=? AND status='pending'").get(req.params.id, req.user.username);
  if (!o) return res.json({ code: 404, msg: '订单不存在或已处理' });
  db.prepare("UPDATE market_orders SET status='cancelled', updated_at=? WHERE id=?").run(now(), o.id);
  res.json({ code: 0, msg: '已取消' });
});

// ---------- 管理员：所有订单 ----------
router.get('/admin/all', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, mp.name AS product_name, a.name AS agent_name
    FROM market_orders o
    JOIN market_products mp ON mp.id = o.product_id
    JOIN agents a ON a.id = o.agent_id
    ORDER BY o.id DESC LIMIT 200
  `).all();
  const stat = {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    paid: rows.filter(r => r.status === 'paid').length,
    completed: rows.filter(r => r.status === 'completed').length,
    cancelled: rows.filter(r => r.status === 'cancelled').length,
    totalRevenue: rows.filter(r => r.status === 'paid').reduce((s, r) => s + r.price, 0),
  };
  res.json({ code: 0, data: { list: rows, stat } });
});

module.exports = router;
