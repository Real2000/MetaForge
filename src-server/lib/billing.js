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
 *
 * MT-11（2026-11-22）租户级账单：记账时按写入时用户 tenant_id 快照回填 usage_records.tenant_id，
 * 新增 tenantCostOfMonth / tenantReport 聚合，实现「tenant_id → username」两级账单口径（两租户互不串账）。
 */
const { db, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

/** 有效租户号判定：null/undefined/'' → false（"全部租户"语义，零过滤）。
 *  注意：Number.isFinite(Number(null)) 为 true，故必须先排除空值，否则会把"全部"误当 tenant_id=0。 */
function hasTenant(tenantId) {
  return tenantId != null && tenantId !== '' && Number.isFinite(Number(tenantId));
}

/** 用户所属租户（写入时快照；容错返回 null）。*/ 
function userTenantId(username) {
  try {
    const r = dal.getq('SELECT tenant_id FROM users WHERE username=?', [username]);
    return r && r.tenant_id != null ? Number(r.tenant_id) : null;
  } catch { return null; }
}

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
function priceOf(modelName, providerName, tenantId) {
  if (!modelName) return null;
  // MT-12 起 providers 带 tenant_id（0=平台全局基线，>0=租户覆盖层）。
  // 传入 tenantId 时按「全局基线 ∪ 本租户」过滤，并让租户专有单价优先命中（覆盖层语义）。
  const useTenant = hasTenant(tenantId);
  let rows;
  if (providerName) {
    rows = useTenant
      ? dal.q('SELECT model_price, models, tenant_id FROM providers WHERE name=? AND (tenant_id=0 OR tenant_id=?) ORDER BY tenant_id DESC', [providerName, Number(tenantId)])
      : dal.q('SELECT model_price, models, tenant_id FROM providers WHERE name=?', [providerName]);
  } else if (useTenant) {
    rows = dal.q('SELECT model_price, models, tenant_id FROM providers WHERE configured=1 AND (tenant_id=0 OR tenant_id=?) ORDER BY tenant_id DESC', [Number(tenantId)]);
  } else {
    rows = dal.q('SELECT model_price, models, tenant_id FROM providers WHERE configured=1');
  }
  // 指定供应商：其单价表里有该模型 → 命中（按 tenant_id 降序，租户专有覆盖全局）
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
    const u = dal.getq('SELECT dept_id, tenant_id FROM users WHERE username=?', [username]);
    const tid = u && u.tenant_id != null ? Number(u.tenant_id) : null;
    const price = priceOf(model, provider, tid);
    const cost = computeCost(promptTokens, completionTokens, price);
    const tokens = Math.max(0, Math.ceil(+promptTokens || 0)) + Math.max(0, Math.ceil(+completionTokens || 0));
    const metaObj = Object.assign({ provider: provider || '', priced: !!price }, meta || {});
    if (price) { metaObj.price_input = price.input; metaObj.price_output = price.output; } // 单价快照（后续调价不影响历史成本可审计性）
    dal.runq(`INSERT INTO usage_records (username, dimension, dimension_key, tokens, count, cost, meta, prompt_tokens, completion_tokens, dept_id, tenant_id, created_at)
      VALUES (?, 'model', ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`, [username, String(model), tokens, cost, JSON.stringify(metaObj),
        Math.max(0, Math.ceil(+promptTokens || 0)), Math.max(0, Math.ceil(+completionTokens || 0)), u ? u.dept_id : null, tid]);
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
  const rows = dal.q(`SELECT ur.dept_id, d.name AS dept_name, d.monthly_budget AS budget,
      COUNT(DISTINCT ur.username) AS members, SUM(ur.tokens) AS tokens, SUM(ur.cost) AS cost
    FROM usage_records ur
    LEFT JOIN departments d ON d.id = ur.dept_id
    WHERE ur.dimension='model' AND ur.created_at LIKE ? || '%'
    GROUP BY ur.dept_id`, [m]);
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

/** U2-7 Phase 2：跨组织知识库引用计费。外部源检索命中时调用。 */
function recordKbFederatedUsage({ username, query, tokens = 1, sourceOrg = '', kbName = '', cost } = {}) {
  if (!username) return { ok: false, reason: 'username 为空' };
  try {
    const dimKey = `kb_federated:${(sourceOrg || '').slice(0, 30)}:${(kbName || '').slice(0, 30)}`;
    const finalCost = cost != null ? cost : Number((tokens * 0.001).toFixed(6));
    dal.runq("INSERT INTO usage_records (username, dimension, dimension_key, tokens, count, cost, meta, tenant_id, created_at) VALUES (?, 'kb', ?, ?, 1, ?, ?, ?, datetime('now','localtime'))", [username, dimKey, tokens, finalCost, JSON.stringify({ sourceOrg, kbName, query, type: 'kb_federated' }), userTenantId(username)]);
    return { ok: true, cost: finalCost };
  } catch (e) {
    console.error('[billing] kb_federated 计费失败（不阻断）：', e.message);
    return { ok: false, reason: e.message };
  }
}

/**
 * MT-11：某月租户维度成本聚合（按 usage_records 快照 tenant_id 归组）。
 * @param {string} month YYYY-MM（缺省当月）
 * @param {number|null} tenantId 指定租户；null = 全部租户
 * @returns {{ month, tenants:[{tenant_id,tenant_name,members,tokens,cost}], totalCost }}
 */
function tenantCostOfMonth(month, tenantId = null) {
  const m = /^\d{4}-\d{2}$/.test(month || '')
    ? month
    : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const limit = hasTenant(tenantId) ? ' AND ur.tenant_id = ?' : '';
  const args = limit ? [m, Number(tenantId)] : [m];
  const rows = dal.q(`SELECT ur.tenant_id, t.name AS tenant_name,
      COUNT(DISTINCT ur.username) AS members, SUM(ur.tokens) AS tokens, SUM(ur.cost) AS cost
    FROM usage_records ur
    LEFT JOIN tenants t ON t.id = ur.tenant_id
    WHERE ur.dimension='model' AND ur.created_at LIKE ? || '%'${limit}
    GROUP BY ur.tenant_id`, [...args]);
  const tenants = rows.map(r => ({
    tenant_id: r.tenant_id,
    tenant_name: r.tenant_name || (r.tenant_id == null ? '未归属' : `租户#${r.tenant_id}`),
    members: r.members || 0,
    tokens: r.tokens || 0,
    cost: Number((r.cost || 0).toFixed(6)),
  })).sort((a, b) => b.cost - a.cost);
  return { month: m, tenants, totalCost: Number(tenants.reduce((s, r) => s + r.cost, 0).toFixed(6)) };
}

/**
 * MT-11：租户账单报表（tenant_id → username 两级）。
 * @param {object} p { month, tenantId|null }
 * @returns {{ month, tenantId, users:[...], monthlyTotal, lifetimeTotal }}
 */
function tenantReport({ month, tenantId = null } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '')
    ? month
    : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const limit = hasTenant(tenantId) ? ' AND ur.tenant_id = ?' : '';
  const mArgs = limit ? [m, Number(tenantId)] : [m];
  const users = dal.q(`SELECT ur.username, SUM(ur.tokens) AS tokens, SUM(ur.cost) AS cost,
      SUM(ur.prompt_tokens) AS prompt_tokens, SUM(ur.completion_tokens) AS completion_tokens, COUNT(*) AS calls
    FROM usage_records ur
    WHERE ur.dimension='model' AND ur.created_at LIKE ? || '%'${limit}
    GROUP BY ur.username ORDER BY cost DESC`, [...mArgs])
    .map(r => ({
      username: r.username,
      calls: r.calls || 0,
      tokens: r.tokens || 0,
      prompt_tokens: r.prompt_tokens || 0,
      completion_tokens: r.completion_tokens || 0,
      cost: Number((r.cost || 0).toFixed(6)),
    }));
  const monthlyTotal = Number(users.reduce((s, r) => s + r.cost, 0).toFixed(6));
  const lArgs = limit ? [Number(tenantId)] : [];
  const life = dal.getq(`SELECT SUM(cost) AS cost FROM usage_records ur WHERE ur.dimension='model'${limit}`, [...lArgs]);
  return {
    month: m,
    tenantId: hasTenant(tenantId) ? Number(tenantId) : null,
    users,
    monthlyTotal,
    lifetimeTotal: Number(((life && life.cost) || 0).toFixed(6)),
  };
}

/**
 * MT-11：租户账单导出（CSV 文本；UTF-8 BOM 便于 Excel 打开不乱码）。
 * 字段：租户ID,租户名,用户名,调用次数,输入tokens,输出tokens,tokens合计,成本(元)
 */
function tenantReportCsv({ month, tenantId = null } = {}) {
  const rep = tenantReport({ month, tenantId });
  const rows = dal.q(`SELECT ur.tenant_id, t.name AS tenant_name, ur.username,
      SUM(ur.tokens) AS tokens, SUM(ur.prompt_tokens) AS pt, SUM(ur.completion_tokens) AS ct, SUM(ur.cost) AS cost, COUNT(*) AS calls
    FROM usage_records ur LEFT JOIN tenants t ON t.id = ur.tenant_id
    WHERE ur.dimension='model' AND ur.created_at LIKE ? || '%'${hasTenant(tenantId) ? ' AND ur.tenant_id = ?' : ''}
    GROUP BY ur.tenant_id, ur.username ORDER BY ur.tenant_id, cost DESC`, [...(hasTenant(tenantId) ? [rep.month, Number(tenantId)] : [rep.month])]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['租户ID', '租户名', '用户名', '调用次数', '输入tokens', '输出tokens', 'tokens合计', '成本(元)'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.tenant_id, esc(r.tenant_name || ''), esc(r.username || ''), r.calls || 0, r.pt || 0, r.ct || 0, r.tokens || 0, Number((r.cost || 0).toFixed(6))].join(','));
  }
  lines.push(['合计', '', '', '', '', '', '', rep.monthlyTotal].join(','));
  return { month: rep.month, csv: '\ufeff' + lines.join('\n'), total: rep.monthlyTotal, rowCount: rows.length };
}

module.exports = { parsePriceTable, priceOf, computeCost, recordModelUsage, deptCostOfMonth, recordKbFederatedUsage, tenantCostOfMonth, tenantReport, tenantReportCsv, userTenantId };
