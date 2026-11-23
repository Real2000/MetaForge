/**
 * AI-10 多路查询（Multi-Query）+ HyDE（M5 · P2，2026-11-23）
 *
 * 动机：单一查询对混合检索的表达能力有限——用户问题与文档措辞不一致时（问法 vs 写法），
 * BM25 关键词与向量语义都可能漏召。多路查询把原查询扩写为 3~5 个「同信息需求、不同表述」的
 * 子查询，各路独立检索后跨路 RRF 融合，任何一路命中即可召回；HyDE（Hypothetical Document
 * Embeddings）另让 LLM 生成一段假设性答案，用「答案的语义」而非「问题的语义」做纯向量检索
 * ——答案与文档同为「陈述句」，嵌入空间更接近，对问答型知识库增益显著。
 *
 * 方案（与 query-rewrite 同哲学，0 阻断）：
 *   - expandQueries(rawQuery, opts)：LLM 一次调用产出 { queries:[3~5 子查询], hyde:假设答案? }；
 *     无真实模型 / 超时 / 解析失败 / 任何异常 → 返回 [原查询]（上层单路检索，行为与关闭一致）；
 *   - 缓存：按 (query + hyde 开关) 指纹短 TTL 内存缓存（同轮多入口共用一次扩写）；
 *   - 开关默认关（控成本）：kbs.multi_query 库级（0=关/1=多路/2=多路+HyDE，迁移 #137），
 *     retrieve() 的 opts.multiQuery/opts.hyde 显式覆盖（节点级/测试用）。
 *
 * 延迟预算（验收 ≤800ms）：扩写为一次 LLM 调用（hardTimeoutMs 默认 2500ms，超时回落单路）；
 * 子查询检索各路 Promise.all 并行；跨路 RRF 为纯内存计算（µs 级）。
 */
const crypto = require('crypto');

let _impl = null; // 可注入的扩写实现（测试用；生产为 null 走 _defaultImpl）

const SYS_PROMPT = [
  '你是检索查询扩写器。任务：把用户的查询改写为 3~5 个「信息需求相同、表述不同」的检索子查询，',
  '用于多路检索融合——从不同角度覆盖可能的相关文档措辞（同义改写 / 关键词聚焦 / 实体展开 / 问句↔陈述句转换）。',
  '规则：',
  '1. 只输出 JSON 对象 {"queries": ["子查询1", "子查询2", ...]}，不加围栏、不加解释；',
  '2. 子查询语言与原查询一致，每条不超过 60 字；不臆造原查询中不存在的信息；',
  '3. 原查询本身必须包含在 queries 中（作为其中一路，保证兜底召回）。',
].join('\n');

const HYPE_PROMPT = [
  '另外，请针对该查询生成一段 60~120 字的「假设性答案」：假设知识库中存在理想文档，它会如何直接回答这个查询。',
  '以陈述句撰写（与文档正文同风格），不虚构具体数字与专名。输出在 JSON 中加字段 "hyde": "假设答案文本"。',
].join('\n');

/* ---------------- 短 TTL 内存缓存（同 query-rewrite 模式） ---------------- */
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { _cache.delete(key); return undefined; }
  return e.v;
}
function cacheSet(key, v) {
  if (_cache.size >= CACHE_MAX) {
    const drop = Math.ceil(CACHE_MAX * 0.1);
    let i = 0;
    for (const k of _cache.keys()) { _cache.delete(k); if (++i >= drop) break; }
  }
  _cache.set(key, { v, exp: Date.now() + CACHE_TTL });
}

/** 解析模型输出：JSON 优先，退化按行切分；非法 → null（上层回落 [原查询]） */
function parseExpansion(raw, origQuery, wantHyde) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch {
    // 退化容错：非 JSON 时按行收集（每行视为一条子查询；含「hyde:」前缀行视为假设答案）。
    // 容错门：仅「多行」输出才视为逐行子查询格式——单行文本无法区分垃圾与合法子查询，宁缺勿错回落单路（0 阻断）。
    const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
    if (lines.length >= 2) {
      obj = { queries: lines.filter(x => !/^hyde\s*[：:]/i.test(x)) };
      const hy = lines.find(x => /^hyde\s*[：:]/i.test(x));
      if (hy) obj.hyde = hy.replace(/^hyde\s*[：:]\s*/i, '');
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  let queries = Array.isArray(obj.queries) ? obj.queries : [];
  queries = queries
    .map(q => String(q == null ? '' : q).replace(/^["'「「『]|["'」』]$/g, '').trim().slice(0, 120))
    .filter(q => q && q !== 'queries');
  if (!queries.length) return null;
  // 原查询必须是一路（兜底召回；模型漏带时补首）
  if (!queries.some(q => q === origQuery)) queries.unshift(origQuery);
  queries = queries.slice(0, 5);
  const out = { queries };
  if (wantHyde) {
    const hy = String(obj.hyde || '').trim().slice(0, 200);
    if (hy) out.hyde = hy;
  }
  return out;
}

/** 默认实现：chatOnce 一次调用产出子查询（+可选 HyDE）；无真实模型 → null（回落单路） */
async function _defaultImpl(rawQuery, wantHyde, opts = {}) {
  const { chatOnce } = require('./llm');
  const messages = [
    { role: 'system', content: SYS_PROMPT + (wantHyde ? '\n' + HYPE_PROMPT : '') },
    { role: 'user', content: `【查询】${rawQuery}\n【扩写输出】` },
  ];
  const r = await chatOnce(messages, {
    model: opts.model,
    temperature: 0,
    max_reply: 400,
    hardTimeoutMs: Number(opts.timeoutMs) || 2500,
    username: opts.username,
    tenantId: opts.tenantId,
  });
  if (!r || r.mode === 'mock' || !r.full) return null;
  return r.full;
}

/**
 * 扩写查询。返回 { queries: [原查询, ...子查询], hyde?: 假设答案 }；
 * 任何失败/无模型/关闭 → { queries: [原查询] }（上层据此走单路，0 阻断）。
 * @param {string} rawQuery 原查询
 * @param {object} opts { hyde, model, username, tenantId, timeoutMs, impl }
 */
async function expandQueries(rawQuery, opts = {}) {
  const q = String(rawQuery == null ? '' : rawQuery).trim();
  if (!q) return { queries: [] };
  const wantHyde = opts.hyde === true;
  const impl = typeof opts.impl === 'function' ? opts.impl : (_impl || _defaultImpl);
  const key = crypto.createHash('sha1').update(q + '\u0000' + (wantHyde ? 'H' : 'M')).digest('hex').slice(0, 16);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let out = { queries: [q] }; // 兜底：单路（原查询）
  try {
    const raw = await Promise.race([
      Promise.resolve(impl(q, wantHyde, opts)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('multi-query timeout')), Number(opts.timeoutMs) || 2500)),
    ]);
    const parsed = parseExpansion(raw, q, wantHyde);
    if (parsed) out = parsed;
  } catch { /* 超时/异常/无模型 → 保持单路兜底 */ }
  cacheSet(key, out);
  return out;
}

module.exports = {
  expandQueries,
  parseExpansion,
  // 测试助手（下划线约定：生产代码不得调用）
  __setImpl: (fn) => { _impl = typeof fn === 'function' ? fn : null; },
  __clearCache: () => { _cache.clear(); },
  __cacheSize: () => _cache.size,
};
