/**
 * U2-5 市场商品管理路由（2026-11-16 Phase 1）
 *
 * GET    /api/market/products              — 商品列表（含筛选：?type=free|paid）
 * GET    /api/market/products/:id          — 商品详情
 * POST   /api/market/products              — 智能体发行为商品（admin）
 * PUT    /api/market/products/:id          — 更新商品信息（admin）
 * DELETE /api/market/products/:id          — 下架商品（admin）
 *
 * Phase 1 只完成商品上架架构，不包含购买/支付/分成流程。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

/* ---------- 商品列表 ---------- */
router.get('/', (req, res) => {
  const { type, q } = req.query;
  let sql = `
    SELECT mp.*, a.name AS agent_name, a.icon, a.description AS agent_desc
    FROM market_products mp
    JOIN agents a ON a.id = mp.agent_id
    WHERE 1=1`;
  const args = [];
  if (type === 'paid') sql += ` AND mp.price_type != 'free'`;
  else if (type === 'free') sql += ` AND mp.price_type = 'free'`;
  if (q) { sql += ` AND (mp.name LIKE ? OR mp.agent_name LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY mp.id DESC';
  const rows = db.prepare(sql).all(...args);
  res.json({ code: 0, data: rows.map(normalizeProduct) });
});

/* ---------- 商品详情 ---------- */
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM market_products WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '商品不存在' });
  res.json({ code: 0, data: normalizeProduct(p) });
});

/* ---------- 智能体发行为商品 ---------- */
router.post('/', adminOnly, (req, res) => {
  const { agent_id, price_type, price, subscription_period, author_profit_share, description } = req.body || {};
  if (!agent_id) return res.json({ code: 400, msg: '请指定智能体' });
  const agent = db.prepare('SELECT id, name, owner, status FROM agents WHERE id=?').get(agent_id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!req.user.role === 'admin' && agent.owner !== req.user.username) {
    return res.json({ code: 403, msg: '无权限：仅智能体所有者或管理员可发布商品' });
  }
  if (price_type && !['free', 'one_time', 'subscription'].includes(price_type)) {
    return res.json({ code: 400, msg: '价格类型非法（可用类型：free / one_time / subscription）' });
  }
  // 幂等：已有该智能体的商品则更新
  const exist = db.prepare('SELECT * FROM market_products WHERE agent_id=?').get(agent_id);
  if (exist) {
    db.prepare('UPDATE market_products SET name=?,price_type=?,price=?,subscription_period=?,author_profit_share=?,description=?,updated_at=? WHERE id=?')
      .run(agent.name, price_type || exist.price_type, price != null ? price : exist.price,
        subscription_period || exist.subscription_period, author_profit_share != null ? author_profit_share : exist.author_profit_share,
        description ?? exist.description, now(), exist.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '更新市场商品', `${agent.name}（${price_type || exist.price_type}）`, req.ip, now());
    return res.json({ code: 0, msg: '商品已更新' });
  }
  db.prepare('INSERT INTO market_products (agent_id,name,price_type,price,subscription_period,author_profit_share,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(agent_id, agent.name, price_type || 'free', price || 0, subscription_period || 'month', author_profit_share || 0.8, description || '', 'active', now(), now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '发布市场商品', `${agent.name}（${price_type || 'free'}）`, req.ip, now());
  res.json({ code: 0, msg: '商品已发布' });
});

/* ---------- 更新商品信息 ---------- */
router.put('/:id', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM market_products WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '商品不存在' });
  const { price_type, price, subscription_period, author_profit_share, description, status } = req.body || {};
  db.prepare('UPDATE market_products SET price_type=?,price=?,subscription_period=?,author_profit_share=?,description=?,status=?,updated_at=? WHERE id=?')
    .run(price_type || p.price_type, price != null ? price : p.price,
      subscription_period || p.subscription_period, author_profit_share != null ? author_profit_share : p.author_profit_share,
      description ?? p.description, status ?? p.status, now(), p.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '更新市场商品', `#${p.id}`, req.ip, now());
  res.json({ code: 0, msg: '已更新' });
});

/* ---------- 下架商品 ---------- */
router.delete('/:id', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM market_products WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '商品不存在' });
  db.prepare('DELETE FROM market_products WHERE id=?').run(p.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '下架市场商品', p.name, req.ip, now());
  res.json({ code: 0, msg: '已下架' });
});

/* ---------- 辅助 ---------- */
function normalizeProduct(p) {
  return {
    ...p,
    price: p.price || 0,
    subscription_period: p.subscription_period || 'month',
    author_profit_share: p.author_profit_share || 0.8,
  };
}

// ---------- U2-5 Phase 3 月度收入对账报表 ----------
router.get('/revenue', adminOnly, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.json({ code: 400, msg: '月份格式非法，应为 YYYY-MM' });
  const months = month;
  const nextMonth = month.slice(0, 5) + String(+month.slice(5, 7) + 1).padStart(2, '0');
  const rows = db.prepare(`
    SELECT mp.id AS product_id, mp.name AS product_name, mp.price_type, a.name AS agent_name,
      COUNT(o.id) AS orders, COALESCE(SUM(o.price),0) AS revenue,
      COALESCE(SUM(o.price * mp.author_profit_share),0) AS author_share,
      COALESCE(SUM(o.price * (1 - mp.author_profit_share)),0) AS platform_revenue
    FROM market_products mp
    JOIN agents a ON a.id = mp.agent_id
    LEFT JOIN market_orders o ON o.product_id = mp.id AND o.status IN ('paid','completed')
      AND o.paid_at >= ? AND o.paid_at < ?
    GROUP BY mp.id ORDER BY revenue DESC LIMIT 200
  `).all(`${months}-01 00:00:00`, `${nextMonth}-01 00:00:00`);
  const total = {
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    authorShare: rows.reduce((s, r) => s + r.author_share, 0),
    platformRevenue: rows.reduce((s, r) => s + r.platform_revenue, 0),
  };
  res.json({ code: 0, data: { month: months, details: rows, total } });
});

module.exports = router;
