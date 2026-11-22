/**
 * D2-2 计费用量感知闭环（2026-11-21）
 *
 * 在既有「单价表 providers.model_price + billing.js 成本归因 + quota.js 配额」之上，
 * 补上「预检 → 预留 → 结算」三段式闸门、用户级并发上限、以及对账所需的预留台账。
 *
 * 设计要点：
 *  - 三段式：precheck（模型调用前，查配额/并发，写 held 预留）→ settle（记账点，按真实用量结算）
 *    → release（异常/中断时幂等回滚）。settle/release 均幂等：重复调用不改变金额、不重复计数。
 *  - 扣费误差为 0：结算金额 = computeCost(真实 prompt/completion tokens, 真实单价)，
 *    只按单价与用量精确计算，不做任何估算性加减；对账按「单价 × 用量 = 应收」可逐行核验（diff=0）。
 *  - 超限 100% 拦截：Token 配额 / 成本配额（users.cost_quota，元/月）/ 并发上限（users.max_concurrency）
 *    任一命中即拒绝并落 blocked 台账，不放行。
 *  - 并发上限：以 billing_holds 中 status='held' 的行数计活跃并发；held 超过 TTL 视为僵尸自动回收。
 *  - 本模块只做「实测与预检」，支付闭环可后续接入，账先算准。
 */
const { db } = require('../db');
const { computeCost, priceOf, userTenantId } = require('./billing');

const HOLD_TTL_MS = 10 * 60 * 1000; // 预留超时：10 分钟未结算视为僵尸（如进程崩溃遗留）

/** 生成预留请求号（含时间戳 + 随机段，唯一） */
function newRequestId() {
  return 'bh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/** 当前本地月（YYYY-MM，与 usage_records.created_at 写入口径一致） */
function currentMonth() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
}

/** 按内容估算输入 tokens（与既有口径一致：字符数 × 0.6，向上取整，至少 1） */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length * 0.6));
}

/** 读取用户计费元数据（配额 + 并发上限 + 租户） */
function userMeta(username) {
  return db.prepare('SELECT quota_total, quota_used, cost_quota, max_concurrency, tenant_id FROM users WHERE username=?').get(username) || null;
}

/** 回收超时的 held 预留（僵尸占用并发名额 / 台账悬挂） */
function reapStale() {
  try {
    db.prepare(`UPDATE billing_holds SET status='released', reason='stale', settled_at=datetime('now','localtime')
      WHERE status='held' AND (strftime('%s','now','localtime') - strftime('%s', created_at)) * 1000 > ?`).run(HOLD_TTL_MS);
  } catch { /* 回收失败不阻断主流程 */ }
}

/** 某用户当前活跃并发数（held 且未过期的预留数） */
function activeConcurrency(username) {
  reapStale();
  const r = db.prepare("SELECT COUNT(*) c FROM billing_holds WHERE username=? AND status='held'").get(username);
  return r ? r.c : 0;
}

/** 某用户某月成本口径已用（元）——以 usage_records 成本归因为准（含 D2-2 之前的存量成本） */
function monthCostOfUser(username, month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonth();
  const r = db.prepare("SELECT COALESCE(SUM(cost),0) c FROM usage_records WHERE username=? AND dimension='model' AND created_at LIKE ? || '%'").get(username, m);
  return r ? Number(r.c) : 0;
}

/**
 * MT-11：某租户某月成本口径已用（元）——usage_records 快照 tenant_id 聚合。
 * @param {number} tenantId 租户 ID
 * @param {string} [month] YYYY-MM（缺省当月）
 */
function tenantMonthCost(tenantId, month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonth();
  const r = db.prepare("SELECT COALESCE(SUM(cost),0) c FROM usage_records WHERE tenant_id=? AND dimension='model' AND created_at LIKE ? || '%'").get(Number(tenantId), m);
  return r ? Number(r.c) : 0;
}

/**
 * 预检（模型调用之前调用）。
 * 检查顺序：Token 配额 → 成本配额 → 并发上限；任一命中即拒绝（落 blocked 台账）。
 * @param {object} p { username, model, provider, promptText, promptTokens }
 * @returns {{ ok:true, request_id, est_tokens, est_cost, priced } | { ok:false, code, reason, request_id }}
 */
function precheck({ username, model, provider, promptText, promptTokens } = {}) {
  if (!username) return { ok: false, code: 'no_user', reason: '缺少用户信息' };
  const u = userMeta(username);
  if (!u) return { ok: false, code: 'no_user', reason: '用户不存在' };
  const tid = u.tenant_id != null ? Number(u.tenant_id) : null; // MT-11：预留台账回填租户

  const est_tokens = (Number.isFinite(+promptTokens) && +promptTokens > 0)
    ? Math.ceil(+promptTokens) : estimateTokens(promptText);
  const price = priceOf(model, provider, tid);
  // 预留成本：输入按 est_tokens、输出按同量保守估计（结算时以真实用量为准重算）
  const est_cost = price ? computeCost(est_tokens, est_tokens, price) : 0;

  let block = null;
  if (u.quota_total > 0 && u.quota_used >= u.quota_total) {
    block = { code: 'quota', reason: `本月 Token 配额已用完（已用 ${Number(u.quota_used).toLocaleString('zh-CN')} / ${Number(u.quota_total).toLocaleString('zh-CN')}）。如需继续使用，请联系管理员调整配额。` };
  } else if (u.cost_quota > 0 && monthCostOfUser(username) >= u.cost_quota) {
    const used = monthCostOfUser(username);
    block = { code: 'cost_quota', reason: `本月成本配额已用完（已用 ¥${used.toFixed(4)} / ¥${Number(u.cost_quota).toFixed(2)}）。如需继续使用，请联系管理员调整配额。` };
  } else if (u.max_concurrency > 0 && activeConcurrency(username) >= u.max_concurrency) {
    block = { code: 'concurrency', reason: `并发请求已达上限（${u.max_concurrency}），请待当前请求完成后再试。` };
  }

  const request_id = newRequestId();
  if (block) {
    db.prepare(`INSERT INTO billing_holds (request_id,username,model,provider,est_tokens,est_cost,status,reason,tenant_id,created_at)
      VALUES (?,?,?,?,?,?, 'blocked', ?, ?, datetime('now','localtime'))`)
      .run(request_id, username, model || '', provider || '', est_tokens, est_cost, block.reason, tid);
    return { ok: false, code: block.code, reason: block.reason, request_id };
  }

  db.prepare(`INSERT INTO billing_holds (request_id,username,model,provider,est_tokens,est_cost,status,reason,tenant_id,created_at)
    VALUES (?,?,?,?,?,?, 'held', '', ?, datetime('now','localtime'))`)
    .run(request_id, username, model || '', provider || '', est_tokens, est_cost, tid);
  return { ok: true, request_id, est_tokens, est_cost, priced: !!price };
}

/**
 * 结算（记账点调用）。按真实用量与真实单价精确计算成本；幂等——重复结算返回首次结果，不重复计数。
 * @returns {{ ok:true, actual_tokens, actual_cost, priced, idempotent? } | { ok:false, reason }}
 */
function settle({ request_id, promptTokens = 0, completionTokens = 0, model, provider } = {}) {
  if (!request_id) return { ok: false, reason: '缺少 request_id' };
  const h = db.prepare('SELECT * FROM billing_holds WHERE request_id=?').get(request_id);
  if (!h) return { ok: false, reason: '预留不存在' };
  if (h.status === 'settled') {
    // 幂等：已结算直接返回首次结果（不重复累计）
    return { ok: true, idempotent: true, actual_tokens: h.actual_tokens, actual_cost: h.actual_cost, priced: true };
  }
  if (h.status !== 'held') return { ok: false, reason: `预留状态为 ${h.status}，不可结算` };

  const useModel = model || h.model || '';
  const useProvider = provider || h.provider || '';
  const tid = h.tenant_id != null ? Number(h.tenant_id) : userTenantId(h.username); // MT-11：优先台账快照，回兑用户
  const price = priceOf(useModel, useProvider, tid);
  const pt = Math.max(0, Math.ceil(+promptTokens || 0));
  const ct = Math.max(0, Math.ceil(+completionTokens || 0));
  const actual_tokens = pt + ct;
  const actual_cost = computeCost(pt, ct, price); // 精确：单价 × 用量，无估算项

  const r = db.prepare(`UPDATE billing_holds SET model=?, provider=?, actual_tokens=?, actual_cost=?, status='settled', settled_at=datetime('now','localtime')
    WHERE request_id=? AND status='held'`).run(useModel, useProvider, actual_tokens, actual_cost, request_id);
  if (!r.changes) {
    // 竞态：另一路径已结算/释放，回读当前值
    const cur = db.prepare('SELECT status, actual_tokens, actual_cost FROM billing_holds WHERE request_id=?').get(request_id);
    if (cur && cur.status === 'settled') return { ok: true, idempotent: true, actual_tokens: cur.actual_tokens, actual_cost: cur.actual_cost, priced: true };
    return { ok: false, reason: `预留状态为 ${cur ? cur.status : 'unknown'}，不可结算` };
  }
  return { ok: true, actual_tokens, actual_cost, priced: !!price };
}

/** 释放预留（异常/中断/未结算收尾时调用）。幂等：仅对 held 生效，重复调用无副作用。 */
function release(request_id, reason = 'released') {
  if (!request_id) return { ok: false, reason: '缺少 request_id' };
  const r = db.prepare(`UPDATE billing_holds SET status='released', reason=?, settled_at=datetime('now','localtime')
    WHERE request_id=? AND status='held'`).run(String(reason || 'released').slice(0, 200), request_id);
  return { ok: true, changed: r.changes };
}

/**
 * 对账：某月「单价 × 用量 = 应收」逐模型核验（数据源 usage_records 成本归因，带单价快照）。
 * 对每行按 meta.price_input/price_output 重算应收，diff = 实记成本 − 应收（应为 0）。
 * @returns {{ month, items:[...], total:{...}, gate:{...} }}
 */
function reconcile({ month } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonth();
  const rows = db.prepare(`SELECT dimension_key AS model, meta, tokens, cost, prompt_tokens, completion_tokens
    FROM usage_records WHERE dimension='model' AND created_at LIKE ? || '%'`).all(m);

  const map = new Map(); // model -> 聚合
  let unPricedCalls = 0;
  for (const r of rows) {
    const key = r.model || '(未知模型)';
    let it = map.get(key);
    if (!it) { it = { model: key, calls: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, actual_cost: 0, expect_cost: 0, priced: false, price_input: null, price_output: null }; map.set(key, it); }
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}'); } catch { /* 坏 meta 按未定价处理 */ }
    const pi = Number(meta.price_input), po = Number(meta.price_output);
    const priced = Number.isFinite(pi) && Number.isFinite(po);
    const pt = Math.max(0, +r.prompt_tokens || 0);
    const ct = Math.max(0, +r.completion_tokens || 0);
    it.calls += 1;
    it.prompt_tokens += pt;
    it.completion_tokens += ct;
    it.tokens += Math.max(0, +r.tokens || 0);
    it.actual_cost += Number(r.cost) || 0;
    if (priced) {
      it.priced = true;
      it.price_input = pi; it.price_output = po;
      it.expect_cost += (pt / 1000) * pi + (ct / 1000) * po; // 应收 = 单价 × 用量
    } else { unPricedCalls += 1; }
  }

  const round6 = (n) => Number((+n || 0).toFixed(6));
  const items = [...map.values()].map(it => {
    const actual = round6(it.actual_cost), expect = round6(it.expect_cost);
    return {
      model: it.model,
      calls: it.calls,
      prompt_tokens: it.prompt_tokens,
      completion_tokens: it.completion_tokens,
      tokens: it.tokens,
      priced: it.priced,
      price_input: it.price_input,
      price_output: it.price_output,
      expect_cost: expect,     // 应收（单价 × 用量）
      actual_cost: actual,     // 账面（usage_records.cost）
      diff: round6(actual - expect), // 误差（应为 0）
      balanced: Math.abs(actual - expect) < 1e-9,
    };
  }).sort((a, b) => b.actual_cost - a.actual_cost);

  const total = {
    models: items.length,
    calls: items.reduce((s, x) => s + x.calls, 0),
    tokens: items.reduce((s, x) => s + x.tokens, 0),
    expect_cost: round6(items.reduce((s, x) => s + x.expect_cost, 0)),
    actual_cost: round6(items.reduce((s, x) => s + x.actual_cost, 0)),
    unPricedCalls,
  };
  total.diff = round6(total.actual_cost - total.expect_cost);
  total.balanced = Math.abs(total.diff) < 1e-9;

  // 闸门台账汇总（held/settled/released/blocked）
  const g = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(actual_cost),0) cost
    FROM billing_holds WHERE created_at LIKE ? || '%' GROUP BY status`).all(m);
  const gate = { held: 0, settled: 0, released: 0, blocked: 0, settled_cost: 0 };
  for (const row of g) { gate[row.status] = row.c; if (row.status === 'settled') gate.settled_cost = round6(row.cost); }
  reapStale();
  gate.active = db.prepare("SELECT COUNT(*) c FROM billing_holds WHERE status='held'").get().c;

  return { month: m, items, total, gate };
}

/** 闸门统计：某月预检/拦截/并发概览 */
function stats({ month } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonth();
  reapStale();
  const byCode = db.prepare(`SELECT reason, COUNT(*) c FROM billing_holds WHERE status='blocked' AND created_at LIKE ? || '%' GROUP BY reason ORDER BY c DESC LIMIT 20`).all(m);
  const counts = db.prepare(`SELECT status, COUNT(*) c FROM billing_holds WHERE created_at LIKE ? || '%' GROUP BY status`).all(m);
  const c = { held: 0, settled: 0, released: 0, blocked: 0 };
  for (const row of counts) c[row.status] = row.c;
  const active = db.prepare("SELECT COUNT(*) c FROM billing_holds WHERE status='held'").get().c;
  // 当前并发 TOP（按用户）
  const conc = db.prepare("SELECT username, COUNT(*) c FROM billing_holds WHERE status='held' GROUP BY username ORDER BY c DESC LIMIT 20").all();
  return { month: m, ...c, active, blocked_by_reason: byCode, active_by_user: conc };
}

module.exports = {
  HOLD_TTL_MS,
  estimateTokens,
  currentMonth,
  monthCostOfUser,
  tenantMonthCost,
  activeConcurrency,
  reapStale,
  precheck,
  settle,
  release,
  reconcile,
  stats,
};
