/**
 * U1-6 成本归因与精细计费（2026-11-16）
 *
 * 设计要点：
 *  - 单价存 providers.model_price（JSON：{"模型名":{"input":x,"output":y}}，单位：元/千 Token）
 *  - cost 一律按「真实单价 × token 数」计算（U1-6 之前 usage_records.cost 是调用方传入的估算值）；
 *    未配置单价的模型 cost=0 并在 meta 标记 priced:false——没有单价就不瞎估，报表口径真实可审计
 *  - dept_id 取写时用户部门快照（部门月度成本报表按该列聚合；用户后来调部门不影响历史归因）
 *  - 写入失败只记日志不抛出（与 op_logs/chat_traces 同模式，绝不阻断对话主流程）
 *
 * 记账口径与 quota.js 的关系：quota（users.quota_used）仍按 messages.tokens 输出估算口径；
 * 本模块是「成本」口径：tokens = prompt + completion，二者用途不同互不干扰。
 */
const { db, now } = require('../db');

/** 解析单价 JSON（容错：坏数据按无单价处理）。返回 Map<模型名, {input, output}> */
function parsePriceTable(raw) {
  try {
    const obj = JSON.parse(raw || '{}');
    const out = new Map();
    for (const [k, v] of Object.entries(obj || {})) {
      const input = Number(v && v.input), output = Number(v && v.output);
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) continue;
      out.set(k, { input, output }); // 元/千 Token
    }
    return out;
  } catch { return new Map(); }
}

/** 查某模型单价。providerName 可空（按模型名在已配置供应商中找第一个含该模型且配了单价的）。
 *  返回 { input, output } | null（无单价） */
function priceOf(modelName, providerName) {
  if (!modelName) return null;
  const rows = providerName
    ? db.prepare('SELECT model_price, models FROM providers WHERE name=?').all(providerName)
    : db.prepare("SELECT model_price, models FROM providers WHERE configured=1").all();
  // 指定供应商：其单价表里有该模型 → 命中
  for (const r of rows) {
    const table = parsePriceTable(r.model_price);
    const hit = table.get(modelName);
    if (hit) return hit;
  }
  return null;
}

/** 按真实单价计算成本（元）。tokens 单位：个；单价单位：元/千 Token。保留 6 位小数防低价精度丢失 */
function computeCost(promptTokens, completionTokens, price) {
  if (!price) return 0;
  const pt = Math.max(0, Math.ceil(+promptTokens || 0));
  const ct = Math.max(0, Math.ceil(+completionTokens || 0));
  return Number(((pt / 1000) * price.input + (ct / 1000) * price.output).toFixed(6));
}

/**
 * 记一笔模型用量（成本归因入口——chat 主链路 / chat-sink / openapi / share 各记账点调用）。
 * @param {object} p { username, model, provider?, promptTokens, completionTokens, meta? }
 * @returns {{ priced:boolean, cost:number } | null}（写库失败返回 null）
 */
function recordModelUsage({ username, model, provider, promptTokens = 0, completionTokens = 0, meta } = {}) {
  if (!username || !model) return null;
  try {
    const price = priceOf(model, provider);
    const cost = computeCost(promptTokens, completionTokens, price);
    const dept = db.prepare('SELECT dept_id FROM users WHERE username=?').get(username);
    const tokens = Math.max(0, Math.ceil(+promptTokens || 0)) + Math.max(0, Math.ceil(+completionTokens || 0));
    const metaObj = Object.assign({ provider: provider || '', priced: !!price }, meta || {});
    if (price) { metaObj.price_input = price.input; metaObj.price_output = price.output; } // 单价快照（后续调价不影响历史成本可审计性）
    db.prepare(`INSERT INTO usage_records (username, dimension, dimension_key, tokens, count, cost, meta, prompt_tokens, completion_tokens, dept_id, created_at)
      VALUES (?, 'model', ?, ?, 1, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
      .run(username, String(model), tokens, cost, JSON.stringify(metaObj),
        Math.max(0, Math.ceil(+promptTokens || 0)), Math.max(0, Math.ceil(+completionTokens || 0)), dept ? dept.dept_id : null);
    return { priced: !!price, cost };
  } catch (e) {
    console.error('[billing] 用量记账失败（不阻断对话）：', e.message);
    return null;
  }
}

/** 当月（YYYY-MM）各部门成本聚合（U1-6 月度部门成本报表数据源；含未归属用户的「未归属」行）。
 *  返回 { month, departments, totalCost }（按 cost 降序，未归属固定在最后） */
function deptCostOfMonth(month) {
  // created_at 写入口径是 datetime('now','localtime')（服务器本地时区），月份过滤同口径取本地月（toISOString 是 UTC，月初 8 小时内会错位）
  const m = /^\d{4}-\d{2}$/.test(month || '')
    ? month
    : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const rows = db.prepare(`SELECT ur.dept_id, d.name AS dept_name, d.monthly_budget AS budget,
      COUNT(DISTINCT ur.username) AS members, SUM(ur.tokens) AS tokens, SUM(ur.cost) AS cost
    FROM usage_records ur
    LEFT JOIN departments d ON d.id = ur.dept_id
    WHERE ur.dimension='model' AND ur.created_at LIKE ? || '%'
    GROUP BY ur.dept_id`).all(m);
  // LEFT JOIN 未命中 name 的（dept_id 为 NULL 或部门已删）归入「未归属」
  const noDept = { dept_id: null, dept_name: '未归属', members: 0, tokens: 0, cost: 0, budget: 0 };
  const out = [];
  for (const r of rows) {
    if (r.dept_id == null) { noDept.members += r.members; noDept.tokens += r.tokens; noDept.cost += r.cost; continue; }
    out.push({ dept_id: r.dept_id, dept_name: r.dept_name || `#${r.dept_id}`, members: r.members, tokens: r.tokens, cost: r.cost, budget: r.budget || 0 });
  }
  out.sort((a, b) => b.cost - a.cost);
  if (noDept.cost > 0 || noDept.tokens > 0) out.push(noDept);
  return { month: m, departments: out, totalCost: Number(out.reduce((s, r) => s + r.cost, 0).toFixed(6)) };
}

module.exports = { parsePriceTable, priceOf, computeCost, recordModelUsage, deptCostOfMonth };
