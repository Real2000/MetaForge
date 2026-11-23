/**
 * AI-14 查询感知的元数据过滤（M5 · P2，2026-11-23）
 *
 * 动机：当前元数据过滤为纯静态声明（agents.kb_metadata_filter / 调用方传入），用户问
 * 「人事部门的年假制度」时，若未静态配置部门过滤则可能命中其他部门的制度文档——查询语义
 * 里明确携带的过滤意图未被利用。
 *
 * 方案（fail-closed 优先，误过滤率 0 的三重保证）：
 *   1. 值域约束：LLM 推断的 {key: value} 必须来自该库**实际元数据值域**（retriever 从 rows
 *      提取 distinct 键值传入）——域外键/值一律丢弃，模型幻觉无法造成误过滤；
 *   2. 交集语义：推断结果与静态 metadataFilter 合并时**静态优先**（同键取静态）——AI 只能
 *      缩小结果集，不能推翻用户显式声明；
 *   3. 默认关 + 0 阻断：无模型/超时/解析失败 → 返回 null（行为与关闭完全一致）。
 *
 * 开关：库级 kbs.infer_metadata_filter（迁移 #138，默认 0）或 opts.inferFilter 显式覆盖
 * （节点级/测试）；依赖 chatOnce（网关 mock 视为无模型回落）。
 */
const crypto = require('crypto');

let _impl = null; // 可注入的推断实现（测试用；生产为 null 走 _defaultImpl）

const SYS_PROMPT = [
  '你是检索元数据过滤器。任务：根据用户查询，从给定元数据键值域中推断本次检索应使用的过滤条件。',
  '输入包含【元数据键值域】（每个键的合法取值清单）与【用户查询】。',
  '规则：',
  '1. 仅当查询**明确提及**某个键的取值（如部门名/文档类型/年份）时才输出对应条件；',
  '2. 只输出 JSON 对象 {"filter": {"键": "值"}}，不加围栏与解释；键与值必须严格来自值域清单（原文匹配）；',
  '3. 查询不含明确过滤意图时输出 {"filter": {}}（空对象——不过滤，宁缺勿错）。',
].join('\n');

/* ---------------- 短 TTL 缓存（同 multi-query 模式；键含值域指纹防跨库串味） ---------------- */
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;
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

/** 模型输出解析 + 值域校验：域外键/值丢弃（fail-closed 核心——幻觉无法造成误过滤） */
function parseAndValidate(raw, vocabulary) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch { return null; }
  const f = obj && typeof obj === 'object' ? (obj.filter || obj) : null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (typeof k !== 'string' || !k) continue;
    const legal = vocabulary[k];
    if (!Array.isArray(legal) || !legal.length) continue; // 键不在值域 → 丢
    const sv = String(v == null ? '' : v).trim();
    if (!sv) continue;
    if (!legal.map(String).includes(sv)) continue;       // 值不在值域 → 丢（幻觉防误过滤）
    out[k] = sv;
  }
  return out;
}

/** 值域文本化（供 prompt；键值数量截断防爆 prompt） */
function vocabText(vocabulary) {
  return Object.entries(vocabulary)
    .map(([k, vs]) => `- ${k}: ${vs.map(String).join(' | ')}`)
    .join('\n');
}

/** 默认实现：chatOnce 一次调用；无真实模型 → null（回落不过滤） */
async function _defaultImpl(query, vocabulary, opts = {}) {
  const { chatOnce } = require('./llm');
  const messages = [
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: `【元数据键值域】\n${vocabText(vocabulary)}\n\n【用户查询】${query}\n【过滤输出】` },
  ];
  const r = await chatOnce(messages, {
    model: opts.model,
    temperature: 0,
    max_reply: 200,
    hardTimeoutMs: Number(opts.timeoutMs) || 2500,
    username: opts.username,
    tenantId: opts.tenantId,
  });
  if (!r || r.mode === 'mock' || !r.full) return null;
  return r.full;
}

/**
 * 推断查询感知的元数据过滤条件。返回 {键: 值}（已过值域校验）或 null（不过滤）。
 * @param {string} query 查询
 * @param {Object<string, Array>} vocabulary 该库元数据键值域（retriever 提取）
 * @param {object} opts { model, username, tenantId, timeoutMs, impl }
 */
async function inferMetadataFilter(query, vocabulary, opts = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q || !vocabulary || typeof vocabulary !== 'object') return null;
  const keys = Object.keys(vocabulary).filter(k => Array.isArray(vocabulary[k]) && vocabulary[k].length);
  if (!keys.length) return null;
  const impl = typeof opts.impl === 'function' ? opts.impl : (_impl || _defaultImpl);
  const vfp = crypto.createHash('sha1').update(vocabText(vocabulary)).digest('hex').slice(0, 16);
  const key = crypto.createHash('sha1').update(q + '\u0000' + vfp).digest('hex').slice(0, 24);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const raw = await Promise.race([
      Promise.resolve(impl(q, vocabulary, opts)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('metadata-infer timeout')), Number(opts.timeoutMs) || 2500)),
    ]);
    const parsed = parseAndValidate(raw, vocabulary);
    // 空对象 = 无过滤意图（与 null 同义，但缓存住避免重复调用）
    out = parsed && Object.keys(parsed).length ? parsed : null;
  } catch { out = null; } // 超时/异常/无模型 → 不过滤（0 阻断）
  cacheSet(key, out);
  return out;
}

module.exports = {
  inferMetadataFilter,
  parseAndValidate,
  // 测试助手（下划线约定：生产代码不得调用）
  __setImpl: (fn) => { _impl = typeof fn === 'function' ? fn : null; },
  __clearCache: () => { _cache.clear(); },
  __cacheSize: () => _cache.size,
};
