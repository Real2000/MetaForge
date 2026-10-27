/**
 * 知识库检索（混合检索 v3，2026-10-20 P2 升级）：
 * 1. 关键词通道：BM25-lite（词 + 中文 2-gram）
 * 2. 向量通道（双引擎）：
 *    a. bge-m3 真实语义嵌入（网关 OpenAI 兼容 /embeddings，1024 维）——语义检索，缓存于 kb_chunks.embedding 列（JSON 前缀 "B3:"）
 *    b. 本地 n-gram 哈希兜底（256 维）——网关不可用时自动降级，零外部依赖（缓存前缀 "H:"）
 * 3. 融合：RRF（Reciprocal Rank Fusion），score = Σ 1/(60+rank)
 * 返回 [{content, file, kb, kb_id, score(融合), bm25, vec, engine}]
 */
const { db } = require('../db');

const DIM = 256;              // 本地哈希向量维度
const BGE_DIM = 1024;         // bge-m3 向量维度
const BGE_MODEL = 'bge-m3';
const BGE_TIMEOUT = 12000;    // 嵌入调用超时（超时/失败自动降级本地引擎，不阻塞检索）

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
 * 混合检索（async，P2 双引擎）。返回 [{content, file, kb, kb_id, score, bm25, vec, engine}]
 * 向量引擎：优先 bge-m3（缺缓存的分块批量取嵌入并落库），网关不可用自动降级本地哈希。
 * 调用方全部 await retrieve(...)（原同步调用点已同步改造）。
 */
async function retrieve(query, kbId = null, topN = 5, threshold = 0.01) {
  const rows = db.prepare(`
    SELECT c.id, c.content, c.kb_id, c.file_id, c.embedding, f.name AS file, k.name AS kb
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

  // 优先 bge-m3：任一分块缺 B3 缓存 → 批量补齐（查询向量同引擎）
  let engine = 'B3';
  if (parsed.every(p => p.engine === 'B3')) {
    // 全部已有 bge 缓存，查询向量走网关（失败则整体降级本地重算）
    const q = await bgeEmbed([query]);
    if (q) return finish(rows, bm25, parsed.map(p => p.v), new Float32Array(q[0]), engine, topN, threshold);
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
      return finish(rows, bm25, parsed.map(p => p.v), new Float32Array(got[0]), engine, topN, threshold);
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
  return finish(rows, bm25, vecs, qVec, engine, topN, threshold);
}

/** RRF 融合 + 排序输出（两种引擎共用） */
function finish(rows, bm25, vecs, qVec, engine, topN, threshold) {
  const vec = vecs.map(v => cosine(qVec, v));
  const K = 60;
  const bm25Rank = [...rows.keys()].sort((a, b) => bm25[b] - bm25[a]);
  const vecRank = [...rows.keys()].sort((a, b) => vec[b] - vec[a]);
  const rrf = new Array(rows.length).fill(0);
  bm25Rank.forEach((idx, rank) => { if (bm25[idx] > 0) rrf[idx] += 1 / (K + rank + 1); });
  vecRank.forEach((idx, rank) => { if (vec[idx] > 0.05) rrf[idx] += 1 / (K + rank + 1); });

  return rows.map((r, i) => ({
    content: r.content, file: r.file, kb: r.kb, kb_id: r.kb_id,
    score: Math.round(rrf[i] * 10000) / 10000,
    bm25: Math.round(bm25[i] * 1000) / 1000,
    vec: Math.round(vec[i] * 1000) / 1000,
    engine, // B3=bge-m3 语义检索 / H=本地哈希兜底
  }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

module.exports = { retrieve, embed, bgeEmbed };
