/**
 * AI-01 多轮查询改写 / 指代消解（M3 · RAG 数据平面重建，2026-11-23）
 *
 * 动机：检索入口此前直接消费用户原始 query（retriever.js:257 / chat.js:994），多轮对话里
 * 「它 / 这个 / 上述 / 该方案」等指代与省略主语在后一轮必然掉召回——query 脱离上下文后不可自洽。
 *
 * 方案：检索前用 LLM 将「最新问题 + 最近若干轮历史」压缩为一条自包含、可独立检索的查询语句。
 *   - 封装 rewriteQuery(rawQuery, history, opts)：无历史 / 无真实模型 / 超时 / 任何异常 → 一律回落原 query（0 阻断）。
 *   - 开关：环境变量 AGENT_QUERY_REWRITE=0 或配置项 query_rewrite=0 关闭（默认开启，但也仅在「有历史轮次」时才真正触发）。
 *   - 缓存：按 (query + 最近历史) 指纹做短 TTL 内存缓存，避免同一轮重复改写（多入口共用一次检索时省一次模型调用）。
 *   - 依赖 chatOnce 非流式入口（网关不可用时返回 mock → 检测 mode==='mock' 视为无模型，直接回落）。
 *
 * 接入：retriever.retrieve() 收 opts.history（统一出口）——凡携带对话历史的检索入口（chat 主链路等）
 *   传 history 即可，工具/工作流/开放 API 有历史时同样传入；无历史则为纯 no-op（单轮查询无需指代消解）。
 */
const crypto = require('crypto');

let _impl = null; // 可注入的改写实现（测试用；生产为 null 走 _defaultImpl）

const SYS_PROMPT = [
  '你是检索查询改写器。任务：把用户的最新问题改写成一个「自包含、可独立检索」的查询语句——',
  '消解代词与指代（它/这个/那个/上述/该方案/此功能…），补全被省略的主语或宾语，使其脱离对话历史也能被理解。',
  '规则：',
  '1. 只输出改写后的查询本身，不加引号、不加解释、不加任何前缀或标点装饰；',
  '2. 若最新问题本身已自包含（无指代、无省略），原样输出；',
  '3. 保留原问题的关键实体、指标、限定词，不得臆造历史中不存在的信息；',
  '4. 语言与用户问题一致，长度不超过 100 字。',
].join('\n');

/** 开关：环境变量优先，其次配置项 query_rewrite（默认开启）。任何读取异常一律视为开启（由后续「有历史才改写 + 失败回落」兜住） */
function isEnabled() {
  const env = process.env.AGENT_QUERY_REWRITE;
  if (env === '0' || env === 'false' || env === 'off') return false;
  try {
    const cfg = require('./config');
    if (cfg && typeof cfg.get === 'function') {
      const v = cfg.get('query_rewrite');
      if (v === 0 || v === '0' || v === false || v === 'false') return false;
    }
  } catch { /* 配置层不可用 → 保守视为开启 */ }
  return true;
}

/** 规范化历史：仅保留 role/content 合法的 user/assistant 轮次，取最近 maxTurns 轮（默认 4） */
function normalizeHistory(history, maxTurns = 4) {
  if (!Array.isArray(history)) return [];
  const clean = [];
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
    if (!role) continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    clean.push({ role, content });
  }
  return clean.slice(-Math.max(1, maxTurns) * 2);
}

function fingerprint(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}
function cacheKey(q, turns) {
  return fingerprint(q + '\u0000' + turns.map(t => t.role[0] + ':' + t.content).join('\u0001'));
}

/* ---------------- 短 TTL 内存缓存（防重复改写；进程内，多副本各自缓存无害） ---------------- */
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const _cache = new Map(); // key → { v, exp }
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { _cache.delete(key); return undefined; }
  return e.v;
}
function cacheSet(key, v) {
  if (_cache.size >= CACHE_MAX) {
    // 简单淘汰：删除最早插入的一批（Map 保序）
    const drop = Math.ceil(CACHE_MAX * 0.1);
    let i = 0;
    for (const k of _cache.keys()) { _cache.delete(k); if (++i >= drop) break; }
  }
  _cache.set(key, { v, exp: Date.now() + CACHE_TTL });
}

/** 清洗模型输出为单一查询语句：剥代码围栏/前缀/引号，取首行，截断 200 字 */
function sanitize(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  t = t.replace(/^(改写查询|改写后的问题|改写后|查询|query)\s*[：:]\s*/i, '').trim();
  t = t.replace(/^[“”"'「」‘’《》]+/, '').replace(/[“”"'「」‘’《》]+$/, '').trim();
  t = t.split('\n')[0].trim();
  const chars = [...t];
  if (chars.length > 200) t = chars.slice(0, 200).join('');
  return t;
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('query-rewrite timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 默认实现：调用非流式 LLM（chatOnce），无真实模型/空返回 → 返回 null（交由上层回落原 query） */
async function _defaultImpl(raw, turns, opts = {}) {
  const { chatOnce } = require('./llm');
  const histText = turns.map(t => `${t.role === 'assistant' ? '助手' : '用户'}：${String(t.content).slice(0, 300)}`).join('\n');
  const messages = [
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: `【对话历史】\n${histText}\n\n【最新问题】${raw}\n【改写查询】` },
  ];
  const r = await chatOnce(messages, {
    model: opts.model,
    temperature: 0,
    max_reply: 200,
    hardTimeoutMs: Number(opts.timeoutMs) || 8000,
    username: opts.username,
    tenantId: opts.tenantId,
  });
  if (!r || r.mode === 'mock' || !r.full) return null; // 无真实模型 → 不改写（回落原 query）
  return r.full;
}

/**
 * 改写查询。返回自包含查询语句；任何失败/无历史/被关闭 → 返回原 query（永不抛错、永不阻断）。
 * @param {string} rawQuery 最新问题
 * @param {Array<{role,content}>} history 对话历史（时间正序）
 * @param {object} opts { enabled, model, username, tenantId, maxTurns, timeoutMs, impl }
 */
async function rewriteQuery(rawQuery, history = [], opts = {}) {
  const q = String(rawQuery == null ? '' : rawQuery).trim();
  if (!q) return q;
  if (opts.enabled === false || !isEnabled()) return q;
  const turns = normalizeHistory(history, opts.maxTurns || 4);
  if (!turns.length) return q; // 无历史 → 单轮查询无需指代消解
  const impl = typeof opts.impl === 'function' ? opts.impl : (_impl || _defaultImpl);
  const key = cacheKey(q, turns);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let out = q;
  try {
    const r = await withTimeout(Promise.resolve(impl(q, turns, opts)), Number(opts.timeoutMs) || 8000);
    const cleaned = sanitize(r);
    if (cleaned) out = cleaned;
  } catch { out = q; } // 超时/模型异常 → 回落原 query（0 阻断）
  cacheSet(key, out);
  return out;
}

module.exports = {
  rewriteQuery,
  isEnabled,
  normalizeHistory,
  sanitize,
  // 测试助手（下划线约定：生产代码不得调用）
  __setImpl: (fn) => { _impl = typeof fn === 'function' ? fn : null; },
  __clearCache: () => { _cache.clear(); },
  __cacheSize: () => _cache.size,
};
