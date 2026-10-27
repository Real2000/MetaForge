/**
 * 模型成本计算（P5.13 成本可视化）
 *
 * 设计：
 * - MODEL_PRICES 内置常见模型单价（元/百万 tokens，input/output 分列；前缀匹配，长前缀优先）
 * - calcCost(model, promptTokens, completionTokens) → { inCost, outCost, total, priced }
 * - 未匹配模型用 DEFAULT_PRICE（标注 priced:false 前端可显示估价符号 ~）
 * - 价格为内置参考值（部署方可按实际网关价格改此表）；估算仅供成本感知，非计费依据（计费走 TokenGateway）
 */
const DEFAULT_PRICE = { in: 4, out: 12 }; // 元/百万 tokens（未匹配模型的兜底估价）

// 前缀匹配（长前缀优先）；单位：元 / 1M tokens
const MODEL_PRICES = [
  // DeepSeek 系（官方价约 ¥2 输入 / ¥8 输出，缓存外）
  ['deepseek-v4', { in: 2, out: 8 }],
  ['deepseek', { in: 2, out: 8 }],
  ['dsv4', { in: 2, out: 8 }],
  ['ds-', { in: 2, out: 8 }],
  // GLM 系
  ['glm5', { in: 2, out: 8 }],
  ['glm-4', { in: 2, out: 8 }],
  ['glm', { in: 3, out: 10 }],
  // Qwen 系
  ['qwen3-vl', { in: 3, out: 9 }],
  ['qwen-max', { in: 5, out: 15 }],
  ['qwen-plus', { in: 2, out: 6 }],
  ['qwen-turbo', { in: 1, out: 3 }],
  ['qwen', { in: 2, out: 6 }],
  // MiniMax
  ['minimax', { in: 3, out: 10 }],
  // 大厂旗舰档
  ['gpt-4o', { in: 15, out: 45 }],
  ['gpt-4', { in: 15, out: 45 }],
  ['claude', { in: 20, out: 60 }],
  ['gemini', { in: 8, out: 24 }],
];

/** 查模型单价：小写化后按前缀匹配（表序即优先级，长前缀排前） */
function priceOf(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return { ...DEFAULT_PRICE, priced: false };
  for (const [prefix, p] of MODEL_PRICES) {
    if (m.startsWith(prefix)) return { in: p.in, out: p.out, priced: true };
  }
  return { ...DEFAULT_PRICE, priced: false };
}

/** 计算一次调用成本：tokens 为 null/undefined 时按 0（费用 0） */
function calcCost(model, promptTokens, completionTokens) {
  const p = priceOf(model);
  const inT = Math.max(0, Number(promptTokens) || 0);
  const outT = Math.max(0, Number(completionTokens) || 0);
  const inCost = inT / 1e6 * p.in;
  const outCost = outT / 1e6 * p.out;
  return { inCost, outCost, total: inCost + outCost, priced: p.priced, model: String(model || ''), tokens: { in: inT, out: outT } };
}

/** 费用格式化：≥0.01 显示 ¥0.023；小于显示 ¥0.0023；0 显示 ¥0 */
function fmtCost(cny) {
  const v = Number(cny) || 0;
  if (v === 0) return '¥0';
  if (v >= 0.01) return '¥' + v.toFixed(3);
  return '¥' + v.toFixed(4);
}

module.exports = { MODEL_PRICES, DEFAULT_PRICE, priceOf, calcCost, fmtCost };
