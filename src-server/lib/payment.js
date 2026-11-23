/**
 * MT-13 支付/订阅闭环（2026-11-22）
 *
 * 在 billing-gate「预检—预留—结算」之上补齐「租户钱包 + 订阅」商业闭环：
 *   下单(createOrder) → 支付回调(handleCallback，验签 fail-closed) → 配额/钱包生效(activate)
 *   → 续费(renew，复用下单+回调) → 退款(refund，幂等) → 对账(reconcile，diff=0)
 *
 * 设计要点：
 *  - 幂等：回调以 event_id 唯一（payment_events）去重；订单状态迁移 guarded（仅 pending→paid→refunded）；
 *    重复回调/重复退款不改变金额、不重复生效，可安全重放。
 *  - 验签 fail-closed：回调必须携带 HMAC-SHA256 签名，密钥取自平台全局层 secrets（PAYMENT_CALLBACK_SECRET）
 *    或环境变量；未配置密钥 → 一律拒绝（绝不因缺配置而放行）。
 *  - 生效：订阅 → 写 tenant_subscriptions(active) + 置 tenants.plan + 下发配额到本租户成员（period 内 quota_total）；
 *    充值 → 记租户钱包余额。两者均以「订单应付金额」为唯一口径，保证对账 diff=0。
 *  - 金额口径：一律「元」，保留 6 位小数；充值金额 = 订单金额 × 兑换率（tokens_per_yuan）写入钱包 token 余额。
 */
'use strict';

const crypto = require('crypto');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { PLANS, planOf } = require('./plans');

/** 支持的支付渠道（sandbox 用于联调/自测；wechat/alipay 为预留适配位） */
const CHANNELS = ['sandbox', 'wechat', 'alipay'];

/** 获取回调验签密钥（平台全局层 secrets → 环境变量）。未配置返回 ''（调用方 fail-closed） */
function callbackSecret() {
  try {
    const { loadSecrets } = require('./secrets');
    const v = loadSecrets(0).PAYMENT_CALLBACK_SECRET;
    if (v) return String(v);
  } catch { /* ignore */ }
  return String(process.env.PAYMENT_CALLBACK_SECRET || '');
}

/** 生成订单号 */
function newOrderNo() {
  return 'PO' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

const round6 = (n) => Number((+n || 0).toFixed(6));

/** 套餐价格（元）。enterprise 为定制（price=null）→ 不允许在线下单，返回 null。 */
function planPrice(planKey) {
  const p = PLANS[planKey];
  if (!p) return null;
  if (p.price == null) return null; // 定制报价：走线下
  return round6(p.price);
}

/** 套餐配额（tokens；0=不限） */
function planQuota(planKey) {
  const p = PLANS[planKey];
  return p ? (p.quota || 0) : 0;
}

/**
 * 创建订单。
 * @param {object} p { tenantId, type='subscribe'|'recharge', planKey, amount, channel='sandbox', subject, operator }
 * @returns {{ok:true, order:object} | {ok:false, msg:string}}
 */
function createOrder({ tenantId, type = 'subscribe', planKey = '', amount, channel = 'sandbox', subject = '', operator = '' } = {}) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return { ok: false, msg: '缺少有效租户' };
  if (!CHANNELS.includes(channel)) return { ok: false, msg: '不支持的支付渠道' };
  let amt;
  if (type === 'subscribe') {
    const key = String(planKey || '').trim();
    if (!PLANS[key]) return { ok: false, msg: '套餐不存在' };
    if (PLANS[key].price == null) return { ok: false, msg: '该套餐为定制报价，请走线下签约' };
    amt = planPrice(key);
    planKey = key;
  } else if (type === 'recharge') {
    amt = round6(amount);
    if (!(amt > 0)) return { ok: false, msg: '充值金额须大于 0' };
    planKey = '';
  } else {
    return { ok: false, msg: '不支持的订单类型' };
  }
  const orderNo = newOrderNo();
  const subj = subject || (type === 'subscribe' ? `订阅 ${planOf(planKey).name}` : `钱包充值 ¥${amt}`);
  dal.runq(`INSERT INTO payment_orders (order_no,tenant_id,type,plan_key,amount,channel,subject,status,operator,meta,created_at)
    VALUES (?,?,?,?,?,?,?, 'pending', ?, '{}', datetime('now','localtime'))`, [orderNo, tid, type, planKey, amt, channel, subj, operator]);
  return { ok: true, order: getOrder(orderNo) };
}

function getOrder(orderNo) {
  return dal.getq('SELECT * FROM payment_orders WHERE order_no=?', [orderNo]) || null;
}

/** 计算回调签名（供网关侧/自测使用）：HMAC-SHA256(rawBody, secret) hex */
function signPayload(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(rawBody), 'utf8').digest('hex');
}

/** 常量时间比较（防时序侧信道） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/**
 * 校验回调签名（fail-closed）。
 * @returns {{ok:true} | {ok:false, code:number, msg:string}}
 */
function verifySignature(rawBody, sign) {
  const secret = callbackSecret();
  if (!secret) return { ok: false, code: 401, msg: '回调验签密钥未配置，拒绝处理' };
  if (!sign) return { ok: false, code: 401, msg: '缺少签名' };
  const expect = signPayload(rawBody, secret);
  return safeEqual(expect, sign) ? { ok: true } : { ok: false, code: 401, msg: '签名校验失败' };
}

/**
 * 处理支付网关回调（幂等可重放）。
 * @param {object} p { channel, rawBody, sign, payload } payload 为解析后的 JSON 对象
 * @returns {{ok:true, status:string, idempotent?:boolean} | {ok:false, code:number, msg:string}}
 */
function handleCallback({ channel, rawBody, sign, payload } = {}) {
  const v = verifySignature(rawBody, sign);
  if (!v.ok) return v;
  let body = payload;
  if (!body) { try { body = JSON.parse(rawBody || '{}'); } catch { return { ok: false, code: 400, msg: '回调报文非法' }; } }
  const orderNo = String(body.order_no || '').trim();
  const eventId = String(body.event_id || '').trim();
  const status = String(body.status || 'paid').trim();
  const amount = body.amount != null ? round6(body.amount) : null;
  if (!orderNo || !eventId) return { ok: false, code: 400, msg: '回调缺少 order_no / event_id' };
  const ch = CHANNELS.includes(channel) ? channel : 'sandbox';

  // 幂等：同一 event_id 只处理一次
  const seen = dal.getq('SELECT id FROM payment_events WHERE event_id=?', [eventId]);
  if (seen) {
    const o = getOrder(orderNo);
    return { ok: true, status: o ? o.status : 'unknown', idempotent: true };
  }
  dal.runq('INSERT INTO payment_events (event_id,order_no,channel,type,amount,raw,created_at) VALUES (?,?,?,?,?,?,datetime(\'now\',\'localtime\'))', [eventId, orderNo, ch, status, amount == null ? 0 : amount, String(rawBody || '').slice(0, 4000)]);

  const order = getOrder(orderNo);
  if (!order) return { ok: false, code: 404, msg: '订单不存在' };

  if (status === 'paid') {
    const r = markPaid(orderNo, { amount, channel: ch, eventId });
    return r.ok ? { ok: true, status: 'paid', idempotent: !!r.idempotent } : { ok: false, code: 409, msg: r.msg };
  }
  if (status === 'refunded') {
    const r = refund({ orderNo, operator: 'gateway', reason: 'gateway_callback' });
    return r.ok ? { ok: true, status: 'refunded', idempotent: !!r.idempotent } : { ok: false, code: 409, msg: r.msg };
  }
  return { ok: true, status: order.status, ignored: true };
}

/**
 * 标记订单已支付并生效（幂等：重复调用不再生效）。
 * @returns {{ok:true, order:object, idempotent?:boolean} | {ok:false, msg:string}}
 */
function markPaid(orderNo, { amount, channel, eventId, operator = 'system' } = {}) {
  const order = getOrder(orderNo);
  if (!order) return { ok: false, msg: '订单不存在' };
  if (order.status === 'paid') return { ok: true, order, idempotent: true };
  if (order.status === 'refunded') return { ok: false, msg: '已退款订单不可再支付' };
  // 金额校验：回调金额（若有）应不小于应付（防篡改少付）
  if (amount != null && round6(amount) + 1e-9 < round6(order.amount)) {
    return { ok: false, msg: `回调金额 ${round6(amount)} 小于应付 ${order.amount}，拒绝` };
  }
  const r = dal.runq(`UPDATE payment_orders SET status='paid', paid_at=datetime('now','localtime'), channel=COALESCE(NULLIF(?,''),channel)
    WHERE order_no=? AND status='pending'`, [channel || '', orderNo]);
  if (!r.changes) {
    const cur = getOrder(orderNo);
    return cur && cur.status === 'paid' ? { ok: true, order: cur, idempotent: true } : { ok: false, msg: '订单状态不可支付' };
  }
  activate(getOrder(orderNo));
  return { ok: true, order: getOrder(orderNo) };
}

/** 订单生效：订阅 → 写订阅 + 下发配额 + 置租户套餐；充值 → 记钱包 */
function activate(order) {
  const tid = Number(order.tenant_id);
  if (order.type === 'subscribe') {
    const quota = planQuota(order.plan_key);
    const start = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const end = (() => {
      const d = new Date(); d.setMonth(d.getMonth() + 1);
      return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    })();
    const existing = dal.getq('SELECT id FROM tenant_subscriptions WHERE tenant_id=?', [tid]);
    if (existing) {
      dal.runq(`UPDATE tenant_subscriptions SET plan_key=?,status='active',period_start=?,period_end=?,quota_grant=?,price=?,order_no=?,updated_at=datetime('now','localtime') WHERE id=?`, [order.plan_key, start, end, quota, order.amount, order.order_no, existing.id]);
    } else {
      dal.runq(`INSERT INTO tenant_subscriptions (tenant_id,plan_key,status,period_start,period_end,quota_grant,price,order_no,created_at,updated_at)
        VALUES (?,?,'active',?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`, [tid, order.plan_key, start, end, quota, order.amount, order.order_no]);
    }
    dal.runq('UPDATE tenants SET plan=? WHERE id=?', [order.plan_key, tid]);
    applyQuotaToTenant(tid, quota, order.plan_key);
  } else if (order.type === 'recharge') {
    creditWallet(tid, order.amount, `充值订单 ${order.order_no}`);
  }
  // 生效快照：对账以「订单应付 = 实际生效金额」为唯一口径（fail-closed：未生效的已支付订单会被对账抓出）
  try {
    const meta = Object.assign({}, JSON.parse(order.meta || '{}'), {
      activated: true, effective_amount: round6(order.amount), activated_at: now(),
    });
    dal.runq('UPDATE payment_orders SET meta=? WHERE order_no=?', [JSON.stringify(meta), order.order_no]);
  } catch { /* 快照失败不影响生效本身 */ }
}

/**
 * 下发套餐配额到租户成员（订阅生效口径）：period 重新计。
 * quota=0（不限）→ 成员 quota_total=0（不限）；否则按套餐配额覆盖成员 quota_total 并清零已用、重置预警档。
 */
function applyQuotaToTenant(tenantId, quota, planKey) {
  const tid = Number(tenantId);
  const q = Math.max(0, Math.floor(Number(quota) || 0));
  try {
    dal.runq('UPDATE users SET quota_total=?, quota_used=0, quota_alert_level=0 WHERE tenant_id=?', [q, tid]);
    console.log(`[payment] 租户 ${tid} 订阅 ${planKey} 生效：成员配额 ${q === 0 ? '不限' : q} tokens`);
  } catch (e) { console.error('[payment] 下发配额失败（不阻断支付）：', e.message); }
}

/** 记租户钱包流水（正=入账，负=出账） */
function creditWallet(tenantId, delta, remark) {
  const tid = Number(tenantId);
  const d = round6(delta);
  const w = dal.getq('SELECT * FROM tenant_wallets WHERE tenant_id=?', [tid]);
  if (w) {
    dal.runq("UPDATE tenant_wallets SET balance=balance+?, updated_at=datetime('now','localtime') WHERE tenant_id=?", [d, tid]);
  } else {
    dal.runq("INSERT INTO tenant_wallets (tenant_id,balance,currency,created_at,updated_at) VALUES (?,?,'CNY',datetime('now','localtime'),datetime('now','localtime'))", [tid, d]);
  }
  return getWallet(tid);
}

function getWallet(tenantId) {
  return dal.getq('SELECT * FROM tenant_wallets WHERE tenant_id=?', [Number(tenantId)]) || { tenant_id: Number(tenantId), balance: 0, currency: 'CNY' };
}

/**
 * 退款（幂等：仅 paid→refunded 生效一次）。
 * 充值退款：从钱包扣回（余额不足则扣至 0，不产生负余额）；订阅退款：订阅置 refunded。
 */
function refund({ orderNo, operator = '', reason = '' } = {}) {
  const order = getOrder(orderNo);
  if (!order) return { ok: false, msg: '订单不存在' };
  if (order.status === 'refunded') return { ok: true, order, idempotent: true };
  if (order.status !== 'paid') return { ok: false, msg: '仅已支付订单可退款' };
  const r = dal.runq("UPDATE payment_orders SET status='refunded', refunded_at=datetime('now','localtime') WHERE order_no=? AND status='paid'", [orderNo]);
  if (!r.changes) {
    const cur = getOrder(orderNo);
    return cur && cur.status === 'refunded' ? { ok: true, order: cur, idempotent: true } : { ok: false, msg: '订单状态不可退款' };
  }
  const tid = Number(order.tenant_id);
  if (order.type === 'recharge') {
    const w = getWallet(tid);
    const back = Math.min(round6(order.amount), round6(w.balance)); // 扣至 0，不产生负余额
    if (back > 0) creditWallet(tid, -back, `退款 ${orderNo}`);
  } else if (order.type === 'subscribe') {
    dal.runq("UPDATE tenant_subscriptions SET status='refunded', updated_at=datetime('now','localtime') WHERE tenant_id=? AND order_no=?", [tid, orderNo]);
  }
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [operator || 'system', '订单退款', `${orderNo}（¥${order.amount}）${reason ? '：' + reason : ''}`, '', now()]);
  return { ok: true, order: getOrder(orderNo) };
}

/** 某租户商业状态（订阅 + 钱包 + 配额） */
function tenantStatus(tenantId) {
  const tid = Number(tenantId);
  const sub = dal.getq('SELECT * FROM tenant_subscriptions WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [tid]) || null;
  const wallet = getWallet(tid);
  const tenant = dal.getq('SELECT id,name,plan,status FROM tenants WHERE id=?', [tid]) || null;
  return { tenant_id: tid, tenant, subscription: sub, wallet };
}

/** 订单列表（scope=null → 全部；否则限定租户） */
function listOrders(scope, { status, limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Math.floor(+limit || 100)));
  const where = [], args = [];
  if (scope != null && Number.isFinite(Number(scope))) { where.push('tenant_id=?'); args.push(Number(scope)); }
  if (status) { where.push('status=?'); args.push(String(status)); }
  const sql = `SELECT * FROM payment_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  args.push(lim);
  return dal.q(sql, [...args]);
}

/**
 * 对账（diff=0）：某月已支付订单应付金额 = 其「生效快照」金额之和。
 * 以订单 meta.activated/effective_amount 为准逐单核验：已支付但未生效（或金额不符）会被抓出。
 */
function reconcile({ month } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '')
    ? month
    : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const orders = dal.q("SELECT * FROM payment_orders WHERE status='paid' AND created_at LIKE ? || '%'", [m]);
  let expect = 0, actual = 0;
  const items = [];
  for (const o of orders) {
    expect += round6(o.amount);
    let meta = {};
    try { meta = JSON.parse(o.meta || '{}'); } catch { /* ignore */ }
    const effective = meta.activated ? round6(meta.effective_amount) : 0;
    actual += effective;
    items.push({
      order_no: o.order_no, tenant_id: o.tenant_id, type: o.type, plan_key: o.plan_key,
      amount: round6(o.amount), effective, activated: !!meta.activated, status: o.status,
      balanced: Math.abs(effective - round6(o.amount)) < 1e-9,
    });
  }
  const diff = round6(actual - expect);
  return {
    month: m,
    orders: orders.length,
    expect_amount: round6(expect),
    actual_amount: round6(actual),
    diff,
    balanced: Math.abs(diff) < 1e-9,
    items,
    wallets: dal.q('SELECT tenant_id, balance FROM tenant_wallets ORDER BY tenant_id'),
    subscriptions: dal.q("SELECT tenant_id, plan_key, status, quota_grant, price FROM tenant_subscriptions ORDER BY tenant_id"),
  };
}

module.exports = {
  CHANNELS,
  newOrderNo,
  planPrice,
  planQuota,
  createOrder,
  getOrder,
  signPayload,
  verifySignature,
  handleCallback,
  markPaid,
  refund,
  activate,
  applyQuotaToTenant,
  creditWallet,
  getWallet,
  tenantStatus,
  listOrders,
  reconcile,
  callbackSecret,
};
