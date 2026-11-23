/**
 * 长对话上下文压缩（M4 AI-06 2026-11-23）
 *
 * 动机：多轮会话 history 随轮次线性增长，超长会话（>30 轮）会顶爆模型上下文窗口（供应商 400）或
 * 让早期关键信息被稀释。本模块做 token 预算管理：超限时对「早期轮次」滚动摘要（LLM），保留最近 N 轮原文。
 *
 * 设计要点（0 阻断，对齐 query-rewrite/AI-01 的降级哲学）：
 *  - 预算：opts.maxTokens（默认 env AGENT_CONTEXT_MAX_TOKENS 或 6000）；token 估算与全站口径一致
 *    （约 0.6 token/字符）。
 *  - 保留最近轮次：keepRecentTurns（默认 6），并受 agent.context_rounds 上限约束（context_rounds 作为上限）。
 *  - 摘要：优先 LLM（chatOnce，temperature 0.1）；无供应商 / 演示模式 / 失败 / 超时 → 抽取式兜底
 *    （保留早期各轮的截断首段）。两条路径都只「压缩早期轮次」，最近 N 轮永远原文透传。
 *  - 未超预算 / 轮次不足 → 原样返回（历史行为不变，黄金基线护栏）。
 */
const { chatOnce, getConfiguredProviders } = require('./llm');

const DEFAULT_MAX_TOKENS = 6000;   // 默认 token 预算（约等于 1 万字上下文；可由 env 覆盖）
const DEFAULT_KEEP_TURNS = 6;      // 默认保留最近 6 轮原文
const SUMMARY_MAX_CHARS = 1200;    // 摘要文本上限（防摘要本身过长）
const SUMMARY_TIMEOUT_MS = 12000;  // LLM 摘要超时（超时走抽取式兜底）

/** token 估算（与全站 Math.ceil(len*0.6) 口径一致；role/role 开销忽略，量级可接受） */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length * 0.6);
}

/** 一轮消息数组的总 token（role 名不计） */
function estimateHistoryTokens(history) {
  let n = 0;
  for (const m of history || []) n += estimateTokens(m && m.content);
  return n;
}

/** 读取 token 预算：opts.maxTokens > env AGENT_CONTEXT_MAX_TOKENS > 默认；非法回落默认 */
function resolveMaxTokens(opts) {
  const raw = (opts && opts.maxTokens != null) ? opts.maxTokens : process.env.AGENT_CONTEXT_MAX_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_TOKENS;
}

/** 读取保留轮次：opts.keepRecentTurns > context_rounds 上限 > 默认；非法回落默认 */
function resolveKeepTurns(opts) {
  const cr = Number(opts && opts.contextRounds);
  const upBound = (Number.isFinite(cr) && cr > 0) ? Math.floor(cr) : Infinity; // context_rounds 作为上限
  const raw = Number(opts && opts.keepRecentTurns);
  const base = (Number.isFinite(raw) && raw > 0) ? Math.floor(raw) : DEFAULT_KEEP_TURNS;
  return Math.max(1, Math.min(base, upBound));
}

/** 抽取式兜底摘要：保留早期各轮的首段截断（无 LLM 时仍能大幅降 token） */
function extractiveSummary(early) {
  const parts = [];
  for (const m of early) {
    const text = String((m && m.content) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(`${m.role === 'user' ? '用户' : '助手'}：${text.slice(0, 80)}`);
  }
  return parts.join('\n').slice(0, SUMMARY_MAX_CHARS);
}

// __summaryImpl 测试助手（下划线约定：生产代码不得调用）：注入确定性摘要实现，避免单测触网
let __summaryImpl = null;

/** LLM 摘要：把早期多轮压成一段要点；失败返回 null（调用方走兜底） */
async function llmSummary(early, opts) {
  if (__summaryImpl) { // 单测注入（返回字符串=用其作摘要；返回 null/抛错=走兜底）
    const r = await __summaryImpl(early, opts);
    return r ? String(r).trim().slice(0, SUMMARY_MAX_CHARS) : null;
  }
  if (getConfiguredProviders().length === 0) return null; // 无真实模型（含演示模式）→ 兜底
  const convo = early.map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 1500)}`).join('\n');
  const prompt = `请把以下较早的对话内容压缩为一段简明摘要（保留关键事实、结论、约束、用户偏好与未决事项；忽略寒暄）。只输出摘要正文，不要多余解释。\n\n${convo.slice(0, 12000)}`;
  try {
    const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 512, hardTimeoutMs: SUMMARY_TIMEOUT_MS, username: opts && opts.username, tenantId: opts && opts.tenantId });
    if (!r || r.mode === 'mock' || !String(r.full || '').trim()) return null;
    return String(r.full).trim().slice(0, SUMMARY_MAX_CHARS);
  } catch { return null; }
}

/**
 * 压缩对话历史（主入口）。
 * @param {Array<{role,content}>} history 原始历史（时间正序，末尾为最近）
 * @param {Object} opts { maxTokens, keepRecentTurns, contextRounds, username, tenantId, trace }
 * @returns {Promise<{messages, compressed, summarizedTurns, tokensBefore, tokensAfter}>}
 *  - messages：压缩后的历史（未超限时与原 history 全等）
 *  - compressed：是否发生压缩
 *  - summarizedTurns：被折叠进摘要的轮次（消息条）数
 *  - trace：传入对象时回写 { compressed, tokensBefore, tokensAfter, summarizedTurns, method }
 */
async function compressHistory(history, opts = {}) {
  const msgs = Array.isArray(history) ? history.filter(m => m && m.content != null) : [];
  const trace = (opts.trace && typeof opts.trace === 'object') ? opts.trace : null;
  const base = { messages: msgs, compressed: false, summarizedTurns: 0, tokensBefore: estimateHistoryTokens(msgs), tokensAfter: estimateHistoryTokens(msgs) };
  const maxTokens = resolveMaxTokens(opts);
  const keepTurns = resolveKeepTurns(opts);
  // 未超预算 → 原样返回（历史行为不变）
  if (base.tokensBefore <= maxTokens || msgs.length <= keepTurns * 2) {
    if (trace) trace.compress = { compressed: false, tokensBefore: base.tokensBefore, tokensAfter: base.tokensAfter, summarizedTurns: 0, method: 'none' };
    return base;
  }
  const keep = keepTurns * 2; // 每轮 = user+assistant 两条
  const early = msgs.slice(0, msgs.length - keep);
  const recent = msgs.slice(msgs.length - keep);
  let summary = await llmSummary(early, opts);
  const method = summary ? 'llm' : 'extractive';
  if (!summary) summary = extractiveSummary(early);
  const summaryMsg = { role: 'assistant', content: `【此前对话摘要】\n${summary}` };
  const messages = [summaryMsg, ...recent];
  const tokensAfter = estimateHistoryTokens(messages);
  if (trace) trace.compress = { compressed: true, tokensBefore: base.tokensBefore, tokensAfter, summarizedTurns: early.length, method };
  return { messages, compressed: true, summarizedTurns: early.length, tokensBefore: base.tokensBefore, tokensAfter };
}

module.exports = { compressHistory, estimateTokens, estimateHistoryTokens, extractiveSummary, DEFAULT_MAX_TOKENS, DEFAULT_KEEP_TURNS, __setSummaryImpl: (fn) => { __summaryImpl = fn; } };
