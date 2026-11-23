/**
 * 知识库检索（混合检索 v3，2026-10-20 P2 升级）：
 * 1. 关键词通道：BM25-lite（词 + 中文 2-gram）
 * 2. 向量通道（双引擎）：
 *    a. bge-m3 真实语义嵌入（网关 OpenAI 兼容 /embeddings，1024 维）——语义检索，缓存于 kb_chunks.embedding 列（JSON 前缀 "B3:"）
 *    b. 本地 n-gram 哈希兜底（256 维）——网关不可用时自动降级，零外部依赖（缓存前缀 "H:"）
 * 3. 融合：加权 RRF（Reciprocal Rank Fusion），score = Σ w/(60+rank)；向量权重 vecWeight 可调（0=纯关键词，1=纯向量，默认 0.5）
 * 4. Rerank（2026-10-28 P2 重排升级）：RRF 粗召回 Top 30 → cross-encoder 重排取 Top 5，模型可选、可关闭
 * 5. 可视化（2026-10-29）：每条结果带 channels（bm25/vec/both 命中通道）与 hit_terms（命中查询词，前端高亮用）
 * 6. 元数据过滤（V1.2 #2 2026-10-30）：opts.metadataFilter（JSON 对象，AND 语义）——分块行通过当且仅当
 * 7. 重排阈值门控 + 库级配置（M4 AI-09 2026-11-23）：kbs 可配 rerank_enabled/rerank_model/rerank_top_n/
 *    rerank_threshold（库级覆盖传入 opts）；重排分数低于阈值的片段不进 context；降级/生效写 opts.trace
 * 8. GraphRAG 图谱通道（M4 AI-04 2026-11-23）：查询关联实体 → 支撑关系分块作为 RRF 第三通道
 *    （固定权重 GRAPH_W，在 wB+wV 之外叠加；opts.graph=false 可关）；命中标记 r.graph + channels='graph'
 *    过滤的每个键都满足 meta[key] === 过滤值，或 meta[key] 为数组且包含该值；无元数据/缺键的行被
 *    滤除（fail-closed，防误授权）；不传或空对象时行为与无过滤完全一致（黄金基线护栏红线）
 * 返回 [{content, file, kb, kb_id, score(融合), bm25, vec, engine, channels, hit_terms, rerank_score}]
 *
 * M3 · RAG 数据平面重建（2026-11-23）：
 *   AI-01：retrieve() 收 opts.history——携带对话历史时先经 lib/query-rewrite 改写查询（多轮指代消解），
 *          改写失败静默回落原 query（0 阻断）。
 *   AI-02：向量通路正确性——删除 LanceDB ANN 死分支（不可达 + 256/1024 维陷阱）；cosine 维度不符 fail-loud
 *          （原静默返回 0 会丢召回）；embedding 存储由 JSON 文本改为 float32 BLOB（解析 590ms→16ms@N=1万）。
 *   AI-02 收尾（2026-11-23，D-4 拍板 SQLite-vec）：sqlite-vec vec0 影子表 KNN 快路径（lib/vector-index.js）。
 *          仅当 扩展可用 + 库域限定 + 网关可出查询向量 + 覆盖度完整 时启用；KNN 命中行回查精确余弦，
 *          融合口径与全扫严格一致；否则全量回落既有全表扫描（行为不变，0 阻断）。ANN 路径的主 SELECT
 *          不携带 embedding BLOB（省 O(N) 传输——实测 10 万分块现状全扫 p95 ≈1.9s，KNN 路径 ~200ms）。
 */
const { db } = require('../db');
const { assertPublicHttpUrl } = require('./ssrf-guard'); // SEC-05：向量/重排网关出站前的 SSRF 校验

const DIM = 256;              // 本地哈希向量维度
const BGE_DIM = 1024;         // bge-m3 向量维度
const BGE_MODEL = 'bge-m3';
const BGE_TIMEOUT = 12000;    // 嵌入调用超时（超时/失败自动降级本地引擎，不阻塞检索）
const RERANK_MODEL = 'bge-reranker-v2-m3'; // 默认重排模型
const RERANK_TIMEOUT = 10000; // 重排调用超时
const RERANK_CANDIDATES = 30; // 粗召回送入 Rerank 的候选数
const RERANK_TOP_N = 5;      // Rerank 后精排输出数
const GRAPH_W = 0.25;        // 图谱通道 RRF 融合权重（AI-04；在 wB+wV 之外叠加，wB=wV=0.5 时约占 1/5，仅助推不主导）
const GRAPH_TOP_K = 8;       // 图谱关联实体取数上限（实体链接 topK）

const { injectWatermark } = require('./trusted-kb-gateway'); // U2-7 外部源引用水印

/* ---------------- bge-m3 网关嵌入（多供应商尝试，失败自动降级本地） ---------------- */

/** 找到拥有 bge/embedding 模型的已配置供应商（默认优先） */
function bgeProviders() {
  return db.prepare("SELECT * FROM providers WHERE configured=1 AND api_key != '' AND base_url != '' ORDER BY is_default DESC, id")
    .all()
    .filter(p => {
      try { return JSON.parse(p.models || '[]').some(m => /bge-m3|bge.*embed|embedding/i.test(m)); }
      catch { return false; }
    });
}

/** 调网关批量取嵌入。失败返回 null（调用方降级本地引擎）。带 30s 记忆：网关连续失败则短时间内不再尝试 */
let bgeDownUntil = 0;
async function bgeEmbed(texts) {
  if (Date.now() < bgeDownUntil) return null;
  const ps = bgeProviders();
  for (const p of ps) {
    try {
      const url = p.base_url.replace(/\/+$/, '') + '/embeddings';
      await assertPublicHttpUrl(url); // SEC-05：拒绝私网/环回目标（网关在内网时由 AGENT_FETCH_ALLOW_PRIVATE=1 放行）
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        body: JSON.stringify({ model: BGE_MODEL, input: texts.map(t => String(t || '').slice(0, 4000)) }),
        signal: AbortSignal.timeout(BGE_TIMEOUT),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = (j.data || []).map(d => d.embedding);
      if (list.length === texts.length && list.every(v => Array.isArray(v) && v.length === BGE_DIM)) return list;
      throw new Error('返回结构异常');
    } catch { /* 换下一个供应商 */ }
  }
  bgeDownUntil = Date.now() + 30000; // 全部失败：30 秒内直接走本地引擎，避免每次检索都等超时
  return null;
}

/* ---------------- Rerank 重排（2026-10-28：cross-encoder 精排） ---------------- */

/** 找到拥有 rerank 模型的已配置供应商（默认优先） */
function rerankProviders() {
  return db.prepare("SELECT * FROM providers WHERE configured=1 AND api_key != '' AND base_url != '' ORDER BY is_default DESC, id")
    .all()
    .filter(p => {
      try { return JSON.parse(p.models || '[]').some(m => /rerank|bge-reranker|reranker/i.test(m)); }
      catch { return false; }
    });
}

/** 调网关 rerank 接口，返回按相关性降序排列的索引数组。失败返回 null（跳过重排，回落 RRF 结果）。model 可指定重排模型（默认 bge-reranker-v2-m3） */
let rerankDownUntil = 0;
async function bgeRerank(query, candidates, model, retTop) {
  if (Date.now() < rerankDownUntil) return null;
  if (!candidates || !candidates.length) return null;
  const ps = rerankProviders();
  if (!ps.length) return null;
  for (const p of ps) {
    try {
      const url = p.base_url.replace(/\/+$/, '') + '/rerank';
      await assertPublicHttpUrl(url); // SEC-05：拒绝私网/环回目标
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        body: JSON.stringify({
          model: model || RERANK_MODEL,
          query,
          documents: candidates.map(c => c.content),
          top_n: Math.min(candidates.length, retTop || RERANK_TOP_N),
        }),
        signal: AbortSignal.timeout(RERANK_TIMEOUT),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // 标准响应格式：{ results: [{ index, relevance_score, document: { text } }, ...] }
      if (j.results && Array.isArray(j.results) && j.results.length) {
        j.results.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
        // 返回按索引排列的精排结果（保留原索引以便后续 merge）
        return j.results.map(r => ({ index: r.index, score: r.relevance_score || 0 }));
      }
      // 非标准响应：尝试 data[]（类 OpenAI 格式）
      if (j.data && Array.isArray(j.data) && j.data.length) {
        j.data.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
        return j.data.map(r => ({ index: r.index, score: r.relevance_score || 0 }));
      }
      throw new Error('返回结构异常');
    } catch { /* 换下一个供应商 */ }
  }
  rerankDownUntil = Date.now() + 30000; // 全部失败：30 秒内跳过重排
  return null;
}

/** 列出全部已配置供应商提供的 rerank 模型名（去重，召回测试下拉用） */
function rerankModels() {
  const out = [];
  const rows = db.prepare("SELECT models FROM providers WHERE configured=1 AND api_key != '' AND base_url != ''").all();
  for (const r of rows) {
    try {
      for (const m of JSON.parse(r.models || '[]')) {
        if (/rerank|bge-reranker|reranker/i.test(m) && !out.includes(m)) out.push(String(m));
      }
    } catch { }
  }
  return out;
}

/**
 * AI-09：归一库级重排配置（纯函数，无数据库访问——配置随检索查询行的 kbs 列一同带回，避免新增裸查）。
 * 返回 { enabled|null, model, topN|null, threshold|null }；入参空返回 null（回落全局默认）。
 * 归一：rerank_top_n 限 [1,50] 整数；rerank_threshold 仅接受有限数（NULL/非法 → null=不过滤）。
 */
function normalizeKbRerankConfig(kb) {
  if (!kb) return null;
  const tn = Number(kb.rerank_top_n);
  const th = Number(kb.rerank_threshold);
  return {
    enabled: kb.rerank_enabled == null ? null : !!kb.rerank_enabled,
    model: kb.rerank_model || '',
    topN: (kb.rerank_top_n == null || !Number.isFinite(tn)) ? null : Math.max(1, Math.min(50, Math.floor(tn))),
    threshold: (kb.rerank_threshold == null || !Number.isFinite(th)) ? null : th,
  };
}

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}
// 中文额外生成 2-gram
function terms(s) {
  const set = new Set(tokenize(s));
  const joined = (s || '').replace(/\s+/g, '');
  for (let i = 0; i + 1 < joined.length; i++) set.add(joined.slice(i, i + 2));
  return [...set];
}

/** FNV-1a 哈希 → [0, DIM) */
function hashIdx(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIM;
}

/** 文本 → 256 维 L2 归一化向量（字符 n-gram 哈希袋） */
function embed(text) {
  const v = new Float32Array(DIM);
  const ts = terms(text);
  if (!ts.length) return v;
  const tf = new Map();
  ts.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
  for (const [t, f] of tf) {
    // 双哈希降低碰撞：主位 +1，副位 +0.5（带符号）
    v[hashIdx(t)] += 1 + Math.log(f);
    const h2 = hashIdx(t + '#');
    v[h2] += 0.5;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

// AI-02：cosine 维度不符 fail-loud（原实现静默 return 0 → 引擎混用被当成「无相似度」，静默丢召回、极难定位）。
// 正常通路内查询向量与全部分块向量同引擎（见 retrieve 的分支保证），此处为通路一致性断言。
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) {
    throw new Error(`向量维度不一致：查询 ${a && a.length} 维 vs 分块 ${b && b.length} 维（嵌入引擎混用，向量通路错误）`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* AI-02：向量存储格式 —— float32 BLOB（新）+ JSON 文本（旧，兼容读）
 * BLOB 布局：首字节 engine tag（1=B3 / 1024 维，2=H / 256 维）+ 小端 Float32 序列。
 * 动机：JSON 文本解析在 N=1万 时全表扫描 ~590ms；改 float32 BLOB 后 ~16ms（实测）。 */
const ENGINE_TAG = { B3: 1, H: 2 };
const TAG_ENGINE = { 1: 'B3', 2: 'H' };

/** 向量 → BLOB（engine: 'B3' | 'H'） */
function encodeVec(vec, engine) {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec || []);
  const buf = Buffer.allocUnsafe(1 + arr.length * 4);
  buf[0] = ENGINE_TAG[engine] || 0;
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], 1 + i * 4);
  return buf;
}

/** BLOB → {v, engine}；非法长度/未知 tag → null（fail-closed） */
function decodeVec(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null;
  if (buf.length < 5) return null;
  const engine = TAG_ENGINE[buf[0]];
  if (!engine) return null;
  const dim = engine === 'B3' ? BGE_DIM : DIM;
  if (buf.length !== 1 + dim * 4) return null;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = buf.readFloatLE(1 + i * 4);
  return { v, engine };
}

function parseVec(s) {
  if (!s) return { v: null, engine: null };
  // AI-02：先按 BLOB（新格式）解码；字符串为旧 JSON 文本格式，保持兼容读（存量分块懒迁移，下次写入即转 BLOB）
  if (Buffer.isBuffer(s) || s instanceof Uint8Array) {
    return decodeVec(s) || { v: null, engine: null };
  }
  if (typeof s !== 'string') return { v: null, engine: null };
  try {
    // 旧缓存格式："B3:[...]"（bge-m3 1024 维）或 "H:[...]"（本地哈希 256 维）；裸 JSON 视为旧版本地哈希
    let engine = 'H', raw = s;
    if (s.startsWith('B3:')) { engine = 'B3'; raw = s.slice(3); }
    else if (s.startsWith('H:')) { engine = 'H'; raw = s.slice(2); }
    const arr = JSON.parse(raw);
    const dim = engine === 'B3' ? BGE_DIM : DIM;
    if (!Array.isArray(arr) || arr.length !== dim) return { v: null, engine: null };
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = arr[i];
    return { v, engine };
  } catch { return { v: null, engine: null }; }
}

/** BM25 通道打分（U0-3：FTS5 可选。useFts=true 时走 SQL MATCH，缺省运行时扫描维持既有测试行为） */
function bm25Scores(rows, qTerms, opts) {
  if (opts && opts.useFts) {
    try {
      const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'").get();
      if (hasFts) return bm25ScoresFts5(rows, qTerms);
    } catch { /* 退化 */ }
  }
  return bm25ScoresMemory(rows, qTerms);
}

/** FTS5 加速版 */
function bm25ScoresFts5(rows, qTerms) {
  if (!rows.length || !qTerms.length) return rows.map(() => 0);
  const ftsQuery = qTerms.filter(t => t.length > 0).join(' OR ');
  if (!ftsQuery.trim()) return rows.map(() => 0);
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const ftsRows = db.prepare(`SELECT rowid, bm25(kb_chunks_fts, 0) AS fts_score FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? AND rowid IN (${ph})`).all(ftsQuery, ...ids);
  const scoreMap = new Map();
  for (const r of ftsRows) scoreMap.set(r.rowid, -r.fts_score);
  return rows.map(r => scoreMap.get(r.id) || 0);
}

/** 内存 BM25 通道打分（原实现，匹配增强关键词/问法扩展 _idx） */
function bm25ScoresMemory(rows, qTerms) {
  const N = rows.length;
  const df = new Map();
  const docTerms = rows.map(r => {
    const t = new Set(terms(r._idx || r.content));
    t.forEach(x => df.set(x, (df.get(x) || 0) + 1));
    return t;
  });
  const k1 = 1.5, b = 0.75;
  const avgLen = docTerms.reduce((s, t) => s + t.size, 0) / N;
  return rows.map((r, i) => {
    const t = docTerms[i];
    let score = 0;
    for (const q of qTerms) {
      if (!t.has(q)) continue;
      const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += idf * ((k1 + 1) * 1) / (k1 * (1 - b + b * (t.size / avgLen)) + 1);
    }
    return score;
  });
}

/**
 * 混合检索（async，P2 双引擎）。返回 [{content, file, kb, kb_id, score, bm25, vec, engine, channels, hit_terms}]
 * 向量引擎：优先 bge-m3（缺缓存的分块批量取嵌入并落库），网关不可用自动降级本地哈希。
 * opts（2026-10-29 可视化升级，均可选）：
 *   - vecWeight：向量通道融合权重 0~1（0=纯 BM25，1=纯向量，默认 0.5 均衡，与旧行为一致）
 *   - rerankModel：重排模型名（默认 bge-reranker-v2-m3）
 *   - rerankEnabled：是否启用重排（默认 true；false 时直接返回 RRF 排名，便于对比效果）
 *   - metadataFilter（V1.2 #2 2026-10-30）：元数据过滤对象（AND 语义，键值须全满足；空对象=不过滤）
 * 调用方全部 await retrieve(...)（原同步调用点已同步改造）。
 */
/** 从分块行提取元数据键值域（AI-14 推断的合法性边界；键≤12、每键值≤10，防爆 prompt） */
function _metaVocabFromRows(rows) {
  const vocab = {};
  for (const r of rows) {
    let m = null;
    try { if (r.metadata && r.metadata !== '{}') m = JSON.parse(r.metadata); } catch { m = null; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if (!vocab[k]) vocab[k] = new Set();
      const set = vocab[k];
      (Array.isArray(v) ? v : [v]).forEach(x => { if (set.size < 10 && x != null && x !== '') set.add(String(x)); });
    }
    if (Object.keys(vocab).length >= 12) break;
  }
  return Object.fromEntries(Object.entries(vocab).map(([k, s]) => [k, [...s]]));
}

/** AI-14 开关判定：opts.inferFilter 显式优先，否则库级 kbs.infer_metadata_filter（默认关） */
function _kbInferFlag(kbId, opts) {
  if (opts.inferFilter != null) return opts.inferFilter === true;
  if (kbId == null) return false;
  try {
    const r = db.prepare('SELECT infer_metadata_filter FROM kbs WHERE id=?').get(kbId);
    return !!(r && Number(r.infer_metadata_filter) === 1);
  } catch { return false; }
}

/** AI-14：推断过滤条件并与静态声明交集合并（静态优先；返回 {merged, ai}——ai 供 trace） */
async function _resolveAiFilter(query, rows, kbId, opts, _trace) {
  if (!_kbInferFlag(kbId, opts)) return { merged: opts.metadataFilter, ai: null };
  const vocabObj = _metaVocabFromRows(rows);
  if (!Object.keys(vocabObj).length) return { merged: opts.metadataFilter, ai: null };
  let ai = null;
  try {
    const { inferMetadataFilter } = require('./metadata-infer');
    ai = await inferMetadataFilter(query, vocabObj, {
      model: opts.rewriteModel, username: opts.username, tenantId: opts.tenantId,
    });
  } catch { ai = null; }
  if (_trace) _trace.inferFilter = {
    applied: !!(ai && Object.keys(ai).length), filter: ai || null,
    vocabulary: Object.keys(vocabObj),
  };
  if (!ai || !Object.keys(ai).length) return { merged: opts.metadataFilter, ai: null };
  const stat = (opts.metadataFilter && typeof opts.metadataFilter === 'object' && !Array.isArray(opts.metadataFilter)) ? opts.metadataFilter : null;
  return { merged: { ...ai, ...(stat || {}) }, ai }; // 同键静态优先——AI 只能缩小，不能推翻
}

async function retrieve(query, kbId = null, topN = 5, threshold = 0.01, opts = {}) {
  // AI-09/AI-13：检索诊断载体（调用方传 opts.trace 对象时回填；用于 chat_traces.retrieval_trace 落库）
  const _trace = (opts.trace && typeof opts.trace === 'object') ? opts.trace : null;
  // AI-01：多轮查询改写 / 指代消解——携带对话历史时先改写查询再用其检索
  // （无历史 / 已关闭 / 模型不可用 / 超时 / 任何异常 → rewriteQuery 均回落原 query，绝不阻断检索）
  if (Array.isArray(opts.history) && opts.history.length && opts.rewrite !== false) {
    const _origQ = query;
    try {
      const { rewriteQuery } = require('./query-rewrite');
      const rq = await rewriteQuery(query, opts.history, {
        username: opts.username, tenantId: opts.tenantId, model: opts.rewriteModel,
      });
      if (rq) query = rq;
    } catch { /* 改写失败不影响检索 */ }
    if (_trace) _trace.rewrite = { original: _origQ, rewritten: query, applied: query !== _origQ };
  }
  // AI-10（2026-11-23）：多路查询 + HyDE 分发——opts.multiQuery 显式传值优先；未传时读库级 kbs.multi_query
  //（1=多路 / 2=多路+HyDE）；显式 false 时跳过库级读取（子路调用防递归的关键）。
  let _mq = opts.multiQuery;
  if (_mq == null && kbId != null) {
    try {
      const kbMq = db.prepare('SELECT multi_query FROM kbs WHERE id=?').get(kbId);
      const mv = Number(kbMq && kbMq.multi_query) || 0;
      if (mv === 1 || mv === 2) {
        _mq = true;
        if (mv === 2) opts = { ...opts, hyde: opts.hyde ?? true };
      }
    } catch { /* 库级读取失败 → 视为未开启（0 阻断） */ }
  }
  if (_mq === true) {
    return retrieveMultiQuery(query, kbId, topN, threshold, { ...opts, multiQuery: true });
  }
  // P2 里程碑补测修复（2026-11-05）：vector_weight 非法值鲁棒性——原实现 Number('abc')=NaN 后
  // Math.min/max 对 NaN 透传 → wV/wB 全 NaN → RRF 全 NaN → score>=threshold 恒 false → 静默 0 命中；
  // 修复后非有限数（'abc'/null 之外的 NaN 场景）回落默认 0.5，语义与缺省一致
  const _w = Number(opts.vecWeight ?? 0.5);
  const vecWeight = Number.isFinite(_w) ? Math.min(1, Math.max(0, _w)) : 0.5;
  // AI-02 收尾：ANN 候选判定（扩展可用 + 库域限定 + 未显式关闭）——成立时主 SELECT 不取 embedding BLOB
  //（KNN 在库内算距离，向量不出库；这是 10 万分块下性能收益的本体）；opts.ann=false 可强制全扫（调试/对照）
  const annCandidate = kbId != null && opts.ann !== false && require('./vector-index').available();
  const rows = db.prepare(`
    SELECT c.id, c.content, c.kb_id, c.file_id, c.parent_id, c.chapter_id, ${annCandidate ? '' : 'c.embedding,'} c.keywords, c.metadata, f.name AS file, k.name AS kb,
      k.rerank_enabled AS kb_rerank_enabled, k.rerank_model AS kb_rerank_model, k.rerank_top_n AS kb_rerank_top_n, k.rerank_threshold AS kb_rerank_threshold
    FROM kb_chunks c
    LEFT JOIN kb_files f ON f.id = c.file_id
    LEFT JOIN kbs k ON k.id = c.kb_id
    WHERE (? IS NULL OR c.kb_id = ?) AND (k.enabled IS NULL OR k.enabled = 1)
  `).all(kbId, kbId);
  if (!rows.length) return [];
  const kbChunkTotal = rows.length; // AI-02 收尾：本库分块总数（覆盖度闸分母；须在元数据过滤 splice 前捕获）
  // AI-09：库级重排配置（从本行携带的 kbs 列构建，免额外查询；kbId 为空时不应用库级配置）
  const kbc = kbId != null ? normalizeKbRerankConfig({
    rerank_enabled: rows[0].kb_rerank_enabled,
    rerank_model: rows[0].kb_rerank_model,
    rerank_top_n: rows[0].kb_rerank_top_n,
    rerank_threshold: rows[0].kb_rerank_threshold,
  }) : null;
  const rerankOpts = {
    ...opts,
    rerankEnabled: (kbc && kbc.enabled != null) ? kbc.enabled : opts.rerankEnabled,
    rerankModel: (kbc && kbc.model) ? kbc.model : opts.rerankModel,
    rerankTopN: (kbc && kbc.topN != null) ? kbc.topN : opts.rerankTopN,
    rerankThreshold: (kbc && kbc.threshold != null) ? kbc.threshold : opts.rerankThreshold,
    trace: _trace,
  };
  // V1.2 #2 2026-10-30：元数据过滤（AND 语义）——rows 取回后、任何打分/通道计算前逐行判定，覆盖全部分支
  // （annRows 从 rows 派生，先在此过滤即可）。fail-closed：无元数据/缺键/值不匹配的行直接滤除（防误授权）。
  // AI-14（2026-11-23）查询感知元数据过滤：LLM 从查询推断过滤条件（值域约束 fail-closed——域外键值丢弃），
  // 与静态 metadataFilter 交集合并（同键静态优先）。0 阻断（无模型/超时 → 不过滤）。
  const _ai = await _resolveAiFilter(query, rows, kbId, opts, _trace);
  // 无 metadataFilter 或空过滤对象时全部通过——与无过滤行为完全一致（黄金基线护栏红线，勿动语义）。
  const fObj = (_ai.merged && typeof _ai.merged === 'object' && !Array.isArray(_ai.merged)) ? _ai.merged : null;
  const fKeys = fObj ? Object.keys(fObj).filter(k => k && fObj[k] !== undefined && fObj[k] !== null && fObj[k] !== '') : [];
  if (fKeys.length) {
    const kept = rows.filter(r => {
      let meta = null;
      try { if (r.metadata && r.metadata !== '{}') meta = JSON.parse(r.metadata); } catch { meta = null; } // NULL/''/损坏 JSON 均视为无元数据
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false; // fail-closed：无元数据被滤除
      for (const k of fKeys) {
        const v = fObj[k];
        const mv = meta[k];
        if (Array.isArray(v)) {
          // V1.2 审查加固 2026-10-30：过滤值为数组 → OR 语义（元数据标量 ∈ 数组，或两数组有交集）
          if (v.includes(mv)) continue;
          if (Array.isArray(mv) && mv.some(x => v.includes(x))) continue;
          return false;
        }
        if (mv === v) continue; // 标量相等
        if (Array.isArray(mv) && mv.includes(v)) continue; // 数组包含（dept 多部门场景）
        return false; // 缺键/值不匹配 → 滤除（fail-closed）
      }
      return true;
    });
    if (!kept.length) return []; // 有过滤且全被滤除 → 无命中（fail-closed 设计语义，不兜底放开）
    rows.splice(0, rows.length, ...kept); // 原数组原地替换（rows 引用贯穿后续所有分支）
  }
  // 自动关键词/问法扩展（2026-10-29）：BM25 索引文本 = 原文 + keywords/questions；输出仍用原文（finish 取 r.content）
  for (const r of rows) {
    if (r.keywords) {
      try {
        const meta = JSON.parse(r.keywords);
        const extra = [...(meta.keywords || []), ...(meta.questions || [])].filter(Boolean).join('\n');
        if (extra) r._idx = r.content + '\n' + extra;
      } catch { /* keywords 损坏则忽略，仅用原文 */ }
    }
  }
  const qTerms = terms(query);
  if (!qTerms.length) return [];

  // 通道 0：GraphRAG 图谱（M4 AI-04）——查询词关联实体 → 一度关系 → 支撑分块作为第三通道并入 RRF 融合。
  // 实体表为空时一次 EXISTS 探测即短路（无图谱数据的库零开销）；任何异常静默跳过（0 阻断，主检索不受影响）。
  // 懒加载 graphrag（其依赖 llm.js）避免无图谱路径的依赖图扩大。
  let graphRank = null;
  if (opts.graph !== false) {
    try {
      const hasEntities = db.prepare('SELECT EXISTS(SELECT 1 FROM entities) AS has').get().has;
      if (hasEntities) {
        const { retrieveGraph } = require('./graphrag');
        const g = retrieveGraph(query, kbId, opts.graphTopK || GRAPH_TOP_K);
        if (g && Array.isArray(g.chunk_ids) && g.chunk_ids.length) {
          const idToIdx = new Map(rows.map((r, i) => [Number(r.id), i]));
          graphRank = g.chunk_ids.map(cid => idToIdx.get(Number(cid))).filter(i => i != null); // 行号基于元数据过滤后的 rows
          if (graphRank.length && _trace) {
            _trace.graph = { entities: g.entities.length, relations: g.relations.length, chunks: graphRank.length };
          }
        }
      }
    } catch { /* 图谱通道异常不影响主检索 */ }
  }

  // 通道 1：BM25（同步）
  const bm25 = bm25Scores(rows, qTerms);

  // 通道 2：向量（双引擎选择）
  const upd = db.prepare('UPDATE kb_chunks SET embedding=? WHERE id=?');

  // ===== AI-02 收尾（D-4：SQLite-vec）ANN 快路径 =====
  // 仅当 覆盖度完整（影子表行数=库分块数，缺失行先回填双写）时走 KNN；KNN 命中行回查 kb_chunks.embedding
  // 算精确余弦，使 RRF 向量通道口径与全扫严格一致（非近似 ANN，验收「命中率≥98%」天然 100%）。
  // 任何一步不成立（扩展/网关/索引/覆盖度）→ 落到下方既有全表扫描，行为不变（0 阻断）。
  if (annCandidate) {
    const qEmb = await bgeEmbed([query]);
    if (qEmb && Array.isArray(qEmb[0]) && qEmb[0].length === BGE_DIM) {
      try {
        const vi = require('./vector-index');
        const qv = new Float32Array(qEmb[0]);
        // 覆盖度闸：缺失行优先复用 B3 缓存、无缓存批量走网关，双写（kb_chunks.embedding + 影子表）；
        // 网关中途失败保留已写部分，下次检索续传（闸门兜底，不会 KNN 到空洞）
        let backfilled = 0;
        if (vi.count(kbId) < kbChunkTotal) backfilled = await backfillVecIndex(kbId);
        const indexed = vi.count(kbId);
        const knnHits = vi.knn(kbId, qv, vi.ANN_K);
        if (knnHits.length) {
          const embMap = fetchEmbeddings(knnHits.map(h => h.rowid));
          const idToIdx = new Map(rows.map((r, i) => [Number(r.id), i]));
          const vecScores = new Array(rows.length).fill(0);
          let scored = 0;
          for (const h of knnHits) {
            const idx = idToIdx.get(h.rowid);
            const v = embMap.get(h.rowid);
            if (idx == null || !v) continue; // 元数据过滤掉的行/向量不可读 → 不参与向量通道（fail-closed）
            vecScores[idx] = cosine(qv, v);
            scored++;
          }
          if (_trace) {
            _trace.engine = 'B3';
            _trace.ann = { engine: 'sqlite-vec', k: vi.ANN_K, hits: scored, coverage: `${indexed}/${kbChunkTotal}`, backfilled };
          }
          return rerankAndSlice(query, finish(rows, bm25, vecScores, 'B3', RERANK_CANDIDATES, threshold, vecWeight, qTerms, graphRank), topN, rerankOpts, kbId);
        }
        if (_trace) _trace.ann = { engine: 'sqlite-vec', hits: 0, coverage: `${indexed}/${kbChunkTotal}`, degraded: true, reason: 'empty_index' };
      } catch (e) {
        if (_trace) _trace.ann = { engine: 'sqlite-vec', degraded: true, reason: String(e && e.message).slice(0, 120) };
      }
    }
    // ANN 未走通（网关查询向量不可用/索引空/异常）→ 主 SELECT 未携带 BLOB，补齐后回落全扫（与旧行为一致）
    await loadEmbeddings(rows);
  }
  const parsed = rows.map(r => parseVec(r.embedding));

  // AI-02：删除 LanceDB ANN 死分支（原 vector-store.js）。
  // 取证：upsertVectors 全后端零调用 → annSearch 恒返回 null（表从未写入）；且该分支传入的 embed(query)
  // 是 256 维本地哈希向量，与 bge-m3 1024 维缓存维度天然不符——既不可达又埋维度陷阱。
  // 向量通路统一走下方全表扫描 + 引擎一致性重算（查询与全部分块同引擎，杜绝混维）。

  // 优先 bge-m3：任一分块缺 B3 缓存 → 批量补齐（查询向量同引擎）
  let engine = 'H'; // P2-1 mocks: 默认本地哈希引擎，避免bgeEmbed不可用时的路径断裂（bgeProviders 无embedding模型时自动降级）
  if (parsed.every(p => p.engine === 'B3')) {
    // 全部已有 bge 缓存，查询向量走网关（失败则整体降级本地重算）
    const q = await bgeEmbed([query]);
    if (q) {
      engine = 'B3'; // 全 B3 缓存 + 网关查询向量成功——真实引擎是 bge-m3（历史代码误标 H，随 AI-02 收尾修正）
      const qv0 = new Float32Array(q[0]);
      const vecScores = parsed.map(p => cosine(qv0, p.v));
      if (_trace) _trace.engine = engine;
      return rerankAndSlice(query, finish(rows, bm25, vecScores, engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms, graphRank), topN, rerankOpts, kbId);
    }
  }
  const missIdx = rows.map((_, i) => i).filter(i => parsed[i].engine !== 'B3');
  if (missIdx.length) {
    const got = await bgeEmbed([query, ...missIdx.map(i => rows[i].content)]);
    if (got && got.length === missIdx.length + 1) {
      // 批量落库 bge 向量缓存
      engine = 'B3'; // 网关补齐成功——本次检索全程 bge-m3（历史代码误标 H，随 AI-02 收尾修正）
      missIdx.forEach((idx, k) => {
        try { upd.run(encodeVec(got[k + 1], 'B3'), rows[idx].id); } catch { }
        parsed[idx] = { v: new Float32Array(got[k + 1]), engine: 'B3' };
      });
      if (_trace) _trace.engine = engine;
      const qv0 = new Float32Array(got[0]);
      const vecScores = parsed.map(p => p.v ? cosine(qv0, p.v) : 0);
      return rerankAndSlice(query, finish(rows, bm25, vecScores, engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms, graphRank), topN, rerankOpts, kbId);
    }
  }

  // 降级：本地哈希引擎（查询与所有分块同引擎重算，保证维度一致）
  engine = 'H';
  const qVec = embed(query);
  const vecs = rows.map((r, i) => {
    if (parsed[i].engine === 'H') return parsed[i].v;
    const v = embed(r.content);
    try { upd.run(encodeVec(v, 'H'), r.id); } catch { }
    return v;
  });
  if (_trace) _trace.engine = engine;
  const vecScores = vecs.map(v => cosine(qVec, v));
  return rerankAndSlice(query, finish(rows, bm25, vecScores, engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms, graphRank), topN, rerankOpts, kbId);
}

/**
 * AI-10（2026-11-23）多路查询 + HyDE：扩写 → 各路并行检索（不重排）→ 跨路 RRF 融合 → 统一重排切片。
 * 触发：opts.multiQuery===true（显式）或库级 kbs.multi_query（1=多路 / 2=多路+HyDE，retrieve 内分发）。
 * 0 阻断：扩写失败/超时/无模型 → expandQueries 返回 [原查询] → 单路语义与关闭时完全一致。
 * HyDE：假设答案作为额外一路参与检索（答案与文档同为陈述句，嵌入空间更接近，向量通道受益最大）。
 * 性能：各路 Promise.all 并行；每路独立载库扫描（大库下为 N 倍读放大——默认关的考量之一）；
 *       融合后统一重排复用单路终点语义（阈值门控/降级/trace 全一致）。
 */
async function retrieveMultiQuery(query, kbId, topN, threshold, opts = {}) {
  const _trace = (opts.trace && typeof opts.trace === 'object') ? opts.trace : null;
  const { expandQueries } = require('./multi-query');
  const wantHyde = opts.hyde === true;
  let expand;
  try {
    expand = await expandQueries(query, {
      hyde: wantHyde,
      model: opts.rewriteModel || opts.multiQueryModel,
      username: opts.username, tenantId: opts.tenantId,
    });
  } catch { expand = { queries: [query] }; }
  const queries = Array.isArray(expand.queries) ? expand.queries.filter(Boolean) : [];
  if (wantHyde && expand.hyde) queries.push(expand.hyde);
  if (queries.length <= 1) {
    if (_trace) _trace.multiQuery = { applied: false, reason: 'expansion_fallback', queries: [query] };
    return retrieve(query, kbId, topN, threshold, { ...opts, multiQuery: false, hyde: false });
  }
  if (_trace) _trace.multiQuery = { applied: true, hyde: !!(wantHyde && expand.hyde), queries };
  // AI-14：多路模式下推断一次（原查询），合并进各路 metadataFilter——各路 inferFilter:false 防重复 LLM 调用
  let mqOpts = opts;
  if (_kbInferFlag(kbId, opts)) {
    let vocabRows = [];
    try { vocabRows = db.prepare("SELECT metadata FROM kb_chunks WHERE kb_id=? AND metadata IS NOT NULL AND metadata != '' LIMIT 500").all(kbId); } catch { }
    if (vocabRows.length) {
      const { merged } = await _resolveAiFilter(query, vocabRows, kbId, { ...opts, inferFilter: true }, _trace);
      if (merged && typeof merged === 'object' && Object.keys(merged).length) mqOpts = { ...opts, metadataFilter: merged };
    }
  }
  mqOpts = { ...mqOpts, inferFilter: false };
  // 各路并行：不重排（融合后统一重排）、各路 trace 不回填主 trace、每路取 RERANK_CANDIDATES 条候选
  const perRoute = await Promise.all(queries.map(q => retrieve(q, kbId, RERANK_CANDIDATES, threshold, {
    ...mqOpts, multiQuery: false, hyde: false, rerankEnabled: false, trace: null,
  })));
  // 跨路 RRF：chunk_id → Σ 1/(60+rank)（任一路命中即有分；多路命中叠加增强）
  const fused = new Map();
  perRoute.forEach(hits => {
    (hits || []).forEach((h, rank) => {
      const cur = fused.get(h.id);
      const add = 1 / (60 + rank + 1);
      if (cur) cur.rrf += add;
      else fused.set(h.id, { rrf: add, item: h });
    });
  });
  const merged = [...fused.values()].sort((a, b) => b.rrf - a.rrf)
    .map(x => ({ ...x.item, multi_rrf: +x.rrf.toFixed(6) }));
  // 统一重排：合并库级重排配置（与单路 retrieve 内部同款语义），trace 回填主 trace 的 rerank 段
  let rerankOpts = opts;
  if (kbId != null) {
    const kbRow = db.prepare('SELECT rerank_enabled, rerank_model, rerank_top_n, rerank_threshold FROM kbs WHERE id=?').get(kbId);
    const kbc = kbRow ? normalizeKbRerankConfig({
      rerank_enabled: kbRow.rerank_enabled, rerank_model: kbRow.rerank_model,
      rerank_top_n: kbRow.rerank_top_n, rerank_threshold: kbRow.rerank_threshold,
    }) : null;
    rerankOpts = {
      ...opts,
      rerankEnabled: (kbc && kbc.enabled != null) ? kbc.enabled : opts.rerankEnabled,
      rerankModel: (kbc && kbc.model) ? kbc.model : opts.rerankModel,
      rerankTopN: (kbc && kbc.topN != null) ? kbc.topN : opts.rerankTopN,
      rerankThreshold: (kbc && kbc.threshold != null) ? kbc.threshold : opts.rerankThreshold,
    };
  }
  return rerankAndSlice(query, merged.slice(0, RERANK_CANDIDATES), topN, { ...rerankOpts, trace: _trace }, kbId);
}

/* ---------------- AI-02 收尾（D-4：SQLite-vec）辅助：BLOB 按需加载 / 回填 ---------------- */

/** 批量回填 rows[].embedding（ANN 路径的主 SELECT 不携带 BLOB；仅 ANN 未走通回落全扫时发生）。
 *  IN 分片 ≤500（SQLite 变量上限保守值）；未命中行的 embedding 保持 undefined（parseVec 归一为无缓存）。 */
function loadEmbeddings(rows) {
  const byId = new Map();
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, embedding FROM kb_chunks WHERE id IN (${ph})`).all(...part.map(x => x.id))) {
      byId.set(Number(r.id), r.embedding);
    }
  }
  for (const r of rows) {
    const e = byId.get(Number(r.id));
    if (e !== undefined) r.embedding = e;
  }
}

/** 取回指定分块 id 的 B3 向量（KNN 命中行算精确余弦用）；仅收 B3 且维度相符的（防脏数据入融合） */
function fetchEmbeddings(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, embedding FROM kb_chunks WHERE id IN (${ph})`).all(...part)) {
      const p = parseVec(r.embedding);
      if (p.engine === 'B3' && p.v && p.v.length === BGE_DIM) out.set(Number(r.id), p.v);
    }
  }
  return out;
}

/** 影子表覆盖度回填：缺失行优先复用 kb_chunks.embedding 已有 B3 缓存（向量值一致，避免重复网关调用
 *  与模型版本漂移），无缓存的批量走网关（batch 64，双写缓存+索引）。网关中途失败保留已写部分——
 *  覆盖度闸保证下次检索续传，KNN 永不命中空洞。返回累计写入条数。 */
async function backfillVecIndex(kbId) {
  const vi = require('./vector-index');
  const missing = db.prepare(`SELECT id, content, embedding FROM kb_chunks WHERE kb_id=? AND id NOT IN (SELECT rowid FROM ${vi.tableFor(kbId)}) ORDER BY id`).all(kbId);
  if (!missing.length) return 0;
  const cached = [];
  const need = [];
  for (const r of missing) {
    const p = parseVec(r.embedding);
    if (p.engine === 'B3' && p.v && p.v.length === BGE_DIM) cached.push({ id: r.id, vec: p.v });
    else need.push(r);
  }
  let n = vi.upsert(kbId, cached);
  const upd = db.prepare('UPDATE kb_chunks SET embedding=? WHERE id=?');
  for (let i = 0; i < need.length; i += 64) {
    const batch = need.slice(i, i + 64);
    const got = await bgeEmbed(batch.map(r => r.content));
    if (!got || got.length !== batch.length) break; // 网关失败：保留已写部分（覆盖度闸下次续传）
    const items = [];
    batch.forEach((r, k) => {
      const v = new Float32Array(got[k]);
      if (v.length !== BGE_DIM) return; // 维度异常不入索引（防脏数据）
      try { upd.run(encodeVec(v, 'B3'), r.id); } catch { }
      items.push({ id: r.id, vec: v });
    });
    n += vi.upsert(kbId, items);
  }
  return n;
}

/** Rerank 重排（优先）→ 如果不可用/被关闭/失败，退回 RRF 排名前 topN 条。opts.rerankEnabled=false 跳过重排，opts.rerankModel 指定模型
 *  AI-09（2026-11-23）：opts.rerankTopN 覆盖输出条数；opts.rerankThreshold 数值时按重排分数门控（低于阈值的片段不进 context）；
 *  opts.trace（对象）时回写诊断 { requested, applied, degraded, reason, model, threshold, candidates, passed }——降级可观测。
 */
async function rerankAndSlice(query, rrfResults, topN, opts = {}, kbId = null) {
  if (!rrfResults || !rrfResults.length) return [];
  const trace = (opts.trace && typeof opts.trace === 'object') ? opts.trace : null;
  const setTrace = (obj) => { if (trace) trace.rerank = obj; };
  const wantTopN = (Number.isFinite(+opts.rerankTopN) && +opts.rerankTopN > 0) ? Math.floor(+opts.rerankTopN) : topN;
  const threshold = Number.isFinite(+opts.rerankThreshold) ? +opts.rerankThreshold : null;
  const modelName = opts.rerankModel || RERANK_MODEL;
  // 重排关闭：直接 RRF 排序（trace 标注 disabled，便于排查「为何无重排效果」）
  if (opts.rerankEnabled === false) {
    setTrace({ requested: false, applied: false, degraded: false, reason: 'disabled', model: modelName });
    return attachChapterContext(attachParentContext(rrfResults.slice(0, wantTopN)));
  }
  try {
    // 设阈值时多取候选（RERANK_CANDIDATES）以便门控后仍能凑满 wantTopN；否则只取 wantTopN（与历史行为一致）
    const retTop = threshold != null ? Math.max(wantTopN, RERANK_CANDIDATES) : wantTopN;
    const ranked = await bgeRerank(query, rrfResults, opts.rerankModel, retTop);
    if (ranked && ranked.length) {
      // 按 rerank 索引重排
      const resultMap = new Map();
      rrfResults.forEach((r, i) => resultMap.set(i, r));
      let mapped = ranked
        .map(r => ({ ...resultMap.get(r.index), rerank_score: r.score }))
        .filter(Boolean);
      const candidates = mapped.length;
      if (threshold != null) mapped = mapped.filter(r => (r.rerank_score || 0) >= threshold); // 门控：低相关片段剔除
      const passed = mapped.length;
      setTrace({ requested: true, applied: true, degraded: false, model: modelName, threshold, candidates, passed });
      return injectWatermark(attachChapterContext(attachParentContext(mapped.slice(0, wantTopN))), kbId);
    }
    // ranked 为 null（无重排供应商/熔断/返回异常）→ 降级回落 RRF
    setTrace({ requested: true, applied: false, degraded: true, reason: 'unavailable', model: modelName, threshold });
  } catch {
    setTrace({ requested: true, applied: false, degraded: true, reason: 'error', model: modelName, threshold });
  }
  // 降级路径回落 RRF（阈值仅作用于重排生效路径——重排不可用时不误清空结果集）
  return injectWatermark(attachChapterContext(attachParentContext(rrfResults.slice(0, wantTopN))), kbId);
}

/** 父分片上下文增强：对命中子分片的结果，查找其父分片（parent_id）并将其内容合并到 content 前 */
function attachParentContext(results) {
  if (!results || !results.length) return results;
  // 收集所有需要查找的 parent_id
  const parentIds = results.filter(r => r.parent_id != null).map(r => Number(r.parent_id));
  if (!parentIds.length) return results;
  // 批量查询父分片
  const placeholders = parentIds.map(() => '?').join(',');
  const parents = db.prepare(`SELECT id, content FROM kb_chunks WHERE id IN (${placeholders})`).all(...parentIds);
  const parentMap = new Map(parents.map(p => [p.id, p.content]));
  for (const r of results) {
    if (r.parent_id != null && parentMap.has(r.parent_id)) {
      r.parent_content = parentMap.get(r.parent_id);
      // 把父分片内容放在子分片内容前面，用换行分隔
      r.content = parentMap.get(r.parent_id) + '\n' + r.content;
    }
  }
  return results;
}

/** TOC 章节上下文增强（2026-10-30）：命中分块带上同章节相邻分块，避免断章取义。
 *  已有父分片上下文的条目跳过（父子切片已提供 ~1000 字上下文，防内容重复膨胀）。
 */
function attachChapterContext(results) {
  if (!results || !results.length) return results;
  const need = results.filter(r => r.chapter_id != null && r.parent_id == null);
  if (!need.length) return results;
  const chIds = [...new Set(need.map(r => Number(r.chapter_id)))];
  const ph = chIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, chapter_id, content FROM kb_chunks WHERE chapter_id IN (${ph}) ORDER BY id`).all(...chIds);
  const byCh = new Map();
  for (const row of rows) {
    if (!byCh.has(row.chapter_id)) byCh.set(row.chapter_id, []);
    byCh.get(row.chapter_id).push(row);
  }
  for (const r of need) {
    const items = byCh.get(Number(r.chapter_id));
    if (!items || items.length <= 1) continue;
    const idx = items.findIndex(it => it.id === r.id);
    if (idx < 0) continue;
    const parts = [];
    if (idx > 0) parts.push(items[idx - 1].content);
    parts.push(items[idx].content);
    if (idx < items.length - 1) parts.push(items[idx + 1].content);
    if (parts.length > 1) {
      r.chapter_context = parts.filter((_, i2) => i2 !== idx).join('\n'); // 相邻上下文（不含自身）
      r.content = parts.join('\n');
    }
  }
  return results;
}

/** 加权 RRF 融合 + 排序输出（两种引擎共用）。
 *  vecScores（AI-02 收尾改造）：调用方预计算的余弦分数数组——全扫路径为逐行 cosine(qVec, v)；
 *  ANN 路径仅 KNN 命中行有值（其余 0，不参与向量通道，与「vec>0.05 门槛」语义自洽）。
 *  vecWeight 为向量通道权重（0~1）；qTerms 用于计算每条结果的命中词。
 *  graphRank（AI-04）：图谱通道命中的行索引数组（按图谱关联度排序）——固定权重 GRAPH_W 参与融合，命中标记 r.graph。 */
function finish(rows, bm25, vecScores, engine, topN, threshold, vecWeight = 0.5, qTerms = [], graphRank = null) {
  const vec = vecScores;
  const K = 60;
  const wV = Math.min(1, Math.max(0, vecWeight)); // 向量通道权重（0=纯关键词，1=纯向量）
  const wB = 1 - wV;
  const bm25Rank = [...rows.keys()].sort((a, b) => bm25[b] - bm25[a]);
  const vecRank = [...rows.keys()].sort((a, b) => vec[b] - vec[a]);
  const rrf = new Array(rows.length).fill(0);
  bm25Rank.forEach((idx, rank) => { if (bm25[idx] > 0) rrf[idx] += wB / (K + rank + 1); });
  vecRank.forEach((idx, rank) => { if (vec[idx] > 0.05) rrf[idx] += wV / (K + rank + 1); });
  const graphSet = new Set();
  if (graphRank && graphRank.length) {
    graphRank.forEach((idx, rank) => {
      if (idx >= 0 && idx < rows.length) { rrf[idx] += GRAPH_W / (K + rank + 1); graphSet.add(idx); }
    });
  }

  const out = rows.map((r, i) => ({
    id: r.id, parent_id: r.parent_id ?? null, chapter_id: r.chapter_id ?? null, // P1/P0-TOC 修复：携带分块ID与归属，供上下文挂载
    content: r.content, file: r.file, kb: r.kb, kb_id: r.kb_id,
    metadata: r.metadata ?? null, // V1.2 审查加固 2026-10-30：携带分块元数据（召回结果前端徽章/调用方判定用；原 JSON 字符串）
    score: Math.round(rrf[i] * 10000) / 10000,
    bm25: Math.round(bm25[i] * 1000) / 1000,
    vec: Math.round(vec[i] * 1000) / 1000,
    engine, // B3=bge-m3 语义检索 / H=本地哈希兑底
    _i: i,
  }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // 命中通道标识（bm25/vec/both/graph）+ 命中查询词（前端高亮用）——仅对输出条目计算，开销可控
  const qSet = new Set(qTerms);
  for (const r of out) {
    const bm25Hit = r.bm25 > 0, vecHit = r.vec > 0.05, graphHit = graphSet.has(r._i);
    if (graphHit) r.graph = true; // AI-04：图谱通道命中标记（可观测；与 channels 字段解耦不破坏前端既有语义）
    r.channels = bm25Hit && vecHit ? 'both' : bm25Hit ? 'bm25' : vecHit ? 'vec' : graphHit ? 'graph' : 'none';
    if (qSet.size) {
      try { r.hit_terms = [...new Set(terms(rows[r._i].content).filter(t => qSet.has(t)))].slice(0, 20); } catch { }
    }
    delete r._i;
  }
  return out;
}

// parseVec 导出（P2 里程碑补测 2026-11-05）：B3/H/裸 JSON 三前缀解析 + 维度不符拒收的单测需要；
// 本地嵌入缓存写入侧经 embed()，读取侧格式契约由此函数单点维护
// rerankAndSlice 导出：重排生效行为（rerank_score 附加/顺序覆盖/topN 截断）单测需要
// __expireCircuitBreakers 测试助手（下划线约定：生产代码不得调用）：bgeDownUntil/rerankDownUntil 为模块级
// 熔断状态，且 bgeEmbed 在无供应商环境下每次调用也会设置 30s 熔断（for 循环空转后落熔断行）——
// 跨用例泄漏会导致后续 mock 供应商用例被短路，单测前需主动过期重置
module.exports = { retrieve, embed, bgeEmbed, bgeRerank, rerankProviders, rerankModels, normalizeKbRerankConfig, parseVec, encodeVec, decodeVec, rerankAndSlice, __expireCircuitBreakers: () => { bgeDownUntil = 0; rerankDownUntil = 0; } };
