/**
 * 知识库检索（混合检索 v3，2026-10-20 P2 升级）：
 * 1. 关键词通道：BM25-lite（词 + 中文 2-gram）
 * 2. 向量通道（双引擎）：
 *    a. bge-m3 真实语义嵌入（网关 OpenAI 兼容 /embeddings，1024 维）——语义检索，缓存于 kb_chunks.embedding 列（JSON 前缀 "B3:"）
 *    b. 本地 n-gram 哈希兜底（256 维）——网关不可用时自动降级，零外部依赖（缓存前缀 "H:"）
 * 3. 融合：加权 RRF（Reciprocal Rank Fusion），score = Σ w/(60+rank)；向量权重 vecWeight 可调（0=纯关键词，1=纯向量，默认 0.5）
 * 4. Rerank（2026-10-28 P2 重排升级）：RRF 粗召回 Top 30 → cross-encoder 重排取 Top 5，模型可选、可关闭
 * 5. 可视化（2026-10-29）：每条结果带 channels（bm25/vec/both 命中通道）与 hit_terms（命中查询词，前端高亮用）
 * 返回 [{content, file, kb, kb_id, score(融合), bm25, vec, engine, channels, hit_terms, rerank_score}]
 */
const { db } = require('../db');

const DIM = 256;              // 本地哈希向量维度
const BGE_DIM = 1024;         // bge-m3 向量维度
const BGE_MODEL = 'bge-m3';
const BGE_TIMEOUT = 12000;    // 嵌入调用超时（超时/失败自动降级本地引擎，不阻塞检索）
const RERANK_MODEL = 'bge-reranker-v2-m3'; // 默认重排模型
const RERANK_TIMEOUT = 10000; // 重排调用超时
const RERANK_CANDIDATES = 30; // 粗召回送入 Rerank 的候选数
const RERANK_TOP_N = 5;      // Rerank 后精排输出数

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
      const r = await fetch(p.base_url.replace(/\/+$/, '') + '/embeddings', {
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
async function bgeRerank(query, candidates, model) {
  if (Date.now() < rerankDownUntil) return null;
  if (!candidates || !candidates.length) return null;
  const ps = rerankProviders();
  if (!ps.length) return null;
  for (const p of ps) {
    try {
      const url = p.base_url.replace(/\/+$/, '') + '/rerank';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        body: JSON.stringify({
          model: model || RERANK_MODEL,
          query,
          documents: candidates.map(c => c.content),
          top_n: Math.min(candidates.length, RERANK_TOP_N),
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

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (a.length !== b.length) return 0; // 维度不一致（引擎不同）视为无相似度
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function parseVec(s) {
  if (!s) return { v: null, engine: null };
  try {
    // 缓存格式："B3:[...]"（bge-m3 1024 维）或 "H:[...]"（本地哈希 256 维）；裸 JSON 视为旧版本地哈希
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

/** BM25 通道打分 */
function bm25Scores(rows, qTerms) {
  const N = rows.length;
  const df = new Map();
  const docTerms = rows.map(r => {
    const t = new Set(terms(r.content));
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
 * 调用方全部 await retrieve(...)（原同步调用点已同步改造）。
 */
async function retrieve(query, kbId = null, topN = 5, threshold = 0.01, opts = {}) {
  const vecWeight = Math.min(1, Math.max(0, Number(opts.vecWeight ?? 0.5)));
  const rows = db.prepare(`
    SELECT c.id, c.content, c.kb_id, c.file_id, c.parent_id, c.embedding, f.name AS file, k.name AS kb
    FROM kb_chunks c
    LEFT JOIN kb_files f ON f.id = c.file_id
    LEFT JOIN kbs k ON k.id = c.kb_id
    WHERE (? IS NULL OR c.kb_id = ?) AND (k.enabled IS NULL OR k.enabled = 1)
  `).all(kbId, kbId);
  if (!rows.length) return [];
  const qTerms = terms(query);
  if (!qTerms.length) return [];

  // 通道 1：BM25（同步）
  const bm25 = bm25Scores(rows, qTerms);

  // 通道 2：向量（双引擎选择）
  const upd = db.prepare('UPDATE kb_chunks SET embedding=? WHERE id=?');
  const parsed = rows.map(r => parseVec(r.embedding));

  // 优先 LanceDB ANN 搜索（2026-10-28 P3 向量库升级）
  let annResult = null;
  try {
    const { annSearch, initDB } = require('./vector-store');
    if (await initDB()) {
      annResult = await annSearch(embed(query), RERANK_CANDIDATES);
    }
  } catch { /* ANN 不可用 → 回退全表扫描 */ }

  if (annResult && annResult.length) {
    const annRows = [];
    const idxMap = new Map(annResult.map(r => [r.id, r]));
    for (let i = 0; i < rows.length; i++) {
      if (idxMap.has(rows[i].id)) annRows.push({ ...rows[i], score: idxMap.get(rows[i].id).score });
    }
    if (annRows.length) {
      const annBm25 = bm25Scores(annRows, qTerms);
      const annParsed = annRows.map(r => parseVec(r.embedding));
      if (annParsed.some(p => p.engine === 'B3')) {
        const q = await bgeEmbed([query]);
        if (q) return rerankAndSlice(query, finish(annRows, annBm25, annParsed.map(p => p.v), new Float32Array(q[0]), 'B3', RERANK_CANDIDATES, threshold, vecWeight, qTerms), topN, opts);
      }
      return rerankAndSlice(query, finish(annRows, annBm25, annParsed.map(p => p.v), embed(query), 'H', RERANK_CANDIDATES, threshold, vecWeight, qTerms), topN, opts);
    }
  }

  // 回退：全表扫描（LanceDB 不可用或无命中时）

  // 优先 bge-m3：任一分块缺 B3 缓存 → 批量补齐（查询向量同引擎）
  let engine = 'B3';
  if (parsed.every(p => p.engine === 'B3')) {
    // 全部已有 bge 缓存，查询向量走网关（失败则整体降级本地重算）
    const q = await bgeEmbed([query]);
    if (q) return rerankAndSlice(query, finish(rows, bm25, parsed.map(p => p.v), new Float32Array(q[0]), engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms), topN, opts);
  }
  const missIdx = rows.map((_, i) => i).filter(i => parsed[i].engine !== 'B3');
  if (missIdx.length) {
    const got = await bgeEmbed([query, ...missIdx.map(i => rows[i].content)]);
    if (got && got.length === missIdx.length + 1) {
      // 批量落库 bge 向量缓存
      missIdx.forEach((idx, k) => {
        try { upd.run('B3:' + JSON.stringify(got[k + 1]), rows[idx].id); } catch { }
        parsed[idx] = { v: new Float32Array(got[k + 1]), engine: 'B3' };
      });
      return rerankAndSlice(query, finish(rows, bm25, parsed.map(p => p.v), new Float32Array(got[0]), engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms), topN, opts);
    }
  }

  // 降级：本地哈希引擎（查询与所有分块同引擎重算，保证维度一致）
  engine = 'H';
  const qVec = embed(query);
  const vecs = rows.map((r, i) => {
    if (parsed[i].engine === 'H') return parsed[i].v;
    const v = embed(r.content);
    try { upd.run('H:' + JSON.stringify([...v]), r.id); } catch { }
    return v;
  });
  return rerankAndSlice(query, finish(rows, bm25, vecs, qVec, engine, RERANK_CANDIDATES, threshold, vecWeight, qTerms), topN, opts);
}

/** Rerank 重排（优先）→ 如果不可用/被关闭/失败，退回 RRF 排名前 topN 条。opts.rerankEnabled=false 跳过重排，opts.rerankModel 指定模型 */
async function rerankAndSlice(query, rrfResults, topN, opts = {}) {
  if (!rrfResults || !rrfResults.length) return [];
  if (opts.rerankEnabled === false) return attachParentContext(rrfResults.slice(0, topN));
  try {
    const ranked = await bgeRerank(query, rrfResults, opts.rerankModel);
    if (ranked && ranked.length) {
      // 按 rerank 索引重排
      const resultMap = new Map();
      rrfResults.forEach((r, i) => resultMap.set(i, r));
      return attachParentContext(ranked
        .map(r => ({ ...resultMap.get(r.index), rerank_score: r.score }))
        .filter(Boolean)
        .slice(0, topN));
    }
  } catch { /* fallthrough: 退回 RRF 排序 */ }
  return attachParentContext(rrfResults.slice(0, topN));
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

/** 加权 RRF 融合 + 排序输出（两种引擎共用）。vecWeight 为向量通道权重（0~1）；qTerms 用于计算每条结果的命中词 */
function finish(rows, bm25, vecs, qVec, engine, topN, threshold, vecWeight = 0.5, qTerms = []) {
  const vec = vecs.map(v => cosine(qVec, v));
  const K = 60;
  const wV = Math.min(1, Math.max(0, vecWeight)); // 向量通道权重（0=纯关键词，1=纯向量）
  const wB = 1 - wV;
  const bm25Rank = [...rows.keys()].sort((a, b) => bm25[b] - bm25[a]);
  const vecRank = [...rows.keys()].sort((a, b) => vec[b] - vec[a]);
  const rrf = new Array(rows.length).fill(0);
  bm25Rank.forEach((idx, rank) => { if (bm25[idx] > 0) rrf[idx] += wB / (K + rank + 1); });
  vecRank.forEach((idx, rank) => { if (vec[idx] > 0.05) rrf[idx] += wV / (K + rank + 1); });

  const out = rows.map((r, i) => ({
    content: r.content, file: r.file, kb: r.kb, kb_id: r.kb_id,
    score: Math.round(rrf[i] * 10000) / 10000,
    bm25: Math.round(bm25[i] * 1000) / 1000,
    vec: Math.round(vec[i] * 1000) / 1000,
    engine, // B3=bge-m3 语义检索 / H=本地哈希兜底
    _i: i,
  }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // 命中通道标识（bm25/vec/both）+ 命中查询词（前端高亮用）——仅对输出条目计算，开销可控
  const qSet = new Set(qTerms);
  for (const r of out) {
    const bm25Hit = r.bm25 > 0, vecHit = r.vec > 0.05;
    r.channels = bm25Hit && vecHit ? 'both' : bm25Hit ? 'bm25' : vecHit ? 'vec' : 'none';
    if (qSet.size) {
      try { r.hit_terms = [...new Set(terms(rows[r._i].content).filter(t => qSet.has(t)))].slice(0, 20); } catch { }
    }
    delete r._i;
  }
  return out;
}

module.exports = { retrieve, embed, bgeEmbed, bgeRerank, rerankProviders, rerankModels };
