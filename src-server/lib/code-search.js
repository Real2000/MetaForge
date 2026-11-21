/**
 * D2-1 代码混合检索内核（2026-11-21）
 *
 * 三通道融合检索（复用知识库 retriever 的本地哈希向量 embed 与 cross-encoder 重排）：
 *   1. 符号通道：查询词与 symbol_name 精确/前缀/包含/标识符拆分匹配（函数/类名命中最强）；
 *   2. 关键词通道：对块内容做 BM25-lite（代码感知分词 codeTerms）；
 *   3. 语义通道：本地哈希向量余弦（与建索引用同一 embed，离线一致）。
 *   融合：加权 RRF → 可选 cross-encoder 重排（复用 retriever.bgeRerank）。
 *
 * 返回 [{id, file_path, lang, chunk_kind, symbol_name, start_line, end_line, content,
 *        score, symbol, bm25, vec, channels, hit_terms, rerank_score}]
 */
const retriever = require('./retriever');
const { codeTerms, splitIdent } = require('./code-index');

const K = 60;
const DEFAULT_WEIGHTS = { sym: 1.0, bm25: 1.0, vec: 0.7 };

/* ---------------- 向量编解码（与 retriever 本地哈希引擎一致，256 维，前缀 H:） ---------------- */
function parseEmbedding(s) {
  if (!s) return null;
  try {
    const raw = s.startsWith('H:') ? s.slice(2) : s;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 256) return null;
    return Float32Array.from(arr);
  } catch { return null; }
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------- 符号通道打分 ---------------- */
/** 查询词 vs 符号名：精确=1、前缀=0.85、包含=0.7、词元交集=0.5；父名（类名）命中略降权 */
function symbolScore(queryLower, queryTerms, row) {
  const name = row.symbol_name ? String(row.symbol_name).toLowerCase() : '';
  const parent = row.symbol_parent ? String(row.symbol_parent).toLowerCase() : '';
  const q = queryLower.trim();
  if (!q) return 0;
  let best = 0;
  const check = (n) => {
    if (!n) return 0;
    if (n === q) return 1;
    if (q.length >= 2 && n.startsWith(q)) return 0.85;
    if (n.includes(q)) return 0.7;
    const nameTerms = new Set(splitIdent(n));
    const inter = queryTerms.filter(t => t.length > 2 && nameTerms.has(t)).length;
    if (inter > 0) return Math.min(0.5, 0.2 + inter * 0.15);
    return 0;
  };
  best = Math.max(best, check(name));
  best = Math.max(best, check(parent) * 0.8);
  // 文件名命中（按文件检索）
  const fileBase = String(row.file_path || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  best = Math.max(best, check(fileBase) * 0.6);
  return best;
}

/* ---------------- BM25 通道（代码感知分词） ---------------- */
function bm25Scores(rows, qTerms) {
  const N = rows.length || 1;
  const df = new Map();
  const docs = rows.map(r => {
    const t = new Set(codeTerms((r.symbol_name || '') + ' ' + (r.content || '')));
    t.forEach(x => df.set(x, (df.get(x) || 0) + 1));
    return t;
  });
  const k1 = 1.5, b = 0.75;
  const avgLen = docs.reduce((s, t) => s + t.size, 0) / N || 1;
  return rows.map((r, i) => {
    const t = docs[i];
    let score = 0;
    for (const qt of qTerms) {
      if (!t.has(qt)) continue;
      const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
      score += idf * ((k1 + 1)) / (k1 * (1 - b + b * (t.size / avgLen)) + 1);
    }
    return score;
  });
}

/**
 * 混合检索。
 * @param {Array} rows  code_index 行（含 id/file_path/lang/chunk_kind/symbol_name/symbol_parent/start_line/end_line/content/embedding）
 * @param {string} query
 * @param {number} topN
 * @param {{weights?:object, rerankEnabled?:boolean, rerankModel?:string, minScore?:number}} opts
 */
async function search(rows, query, topN = 5, opts = {}) {
  if (!rows || !rows.length) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const qTerms = codeTerms(q).filter(t => t.length > 0);
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };

  const sym = rows.map(r => symbolScore(qLower, qTerms, r));
  const bm25 = bm25Scores(rows, qTerms);
  const qVec = retriever.embed(q);
  const vecs = rows.map(r => parseEmbedding(r.embedding));
  const vec = vecs.map(v => cosine(qVec, v));

  // 加权 RRF：三通道各自排序后按权重累加
  const idx = [...rows.keys()];
  const rrf = new Array(rows.length).fill(0);
  const addRank = (scores, weight, gate) => {
    [...idx].sort((a, b) => scores[b] - scores[a]).forEach((i, rank) => {
      if (scores[i] > gate) rrf[i] += weight / (K + rank + 1);
    });
  };
  addRank(sym, w.sym, 0);
  addRank(bm25, w.bm25, 0);
  addRank(vec, w.vec, 0.08);

  const minScore = opts.minScore != null ? Number(opts.minScore) : 0;
  let out = rows.map((r, i) => ({
    id: r.id, repo_id: r.repo_id, file_path: r.file_path, lang: r.lang,
    chunk_kind: r.chunk_kind, symbol_name: r.symbol_name, symbol_parent: r.symbol_parent,
    start_line: r.start_line, end_line: r.end_line, content: r.content,
    score: Math.round(rrf[i] * 10000) / 10000,
    symbol: Math.round(sym[i] * 1000) / 1000,
    bm25: Math.round(bm25[i] * 1000) / 1000,
    vec: Math.round(vec[i] * 1000) / 1000,
    _i: i,
  })).filter(r => r.score > minScore);

  out.sort((a, b) => b.score - a.score);

  // 命中通道 + 命中词（前端高亮）
  const qSet = new Set(qTerms);
  for (const r of out) {
    const sh = r.symbol > 0, bh = r.bm25 > 0, vh = r.vec > 0.08;
    const n = [sh, bh, vh].filter(Boolean).length;
    r.channels = n >= 2 ? 'both' : sh ? 'symbol' : bh ? 'bm25' : vh ? 'vec' : 'none';
    try {
      const row = rows[r._i];
      r.hit_terms = [...new Set(codeTerms(row.content + ' ' + (row.symbol_name || '')).filter(t => qSet.has(t)))].slice(0, 20);
    } catch { }
    delete r._i;
  }

  // 重排（可选，复用 cross-encoder；失败自动回落 RRF 序）
  if (opts.rerankEnabled !== false && out.length) {
    const cands = out.slice(0, 30);
    try {
      const ranked = await retriever.bgeRerank(q, cands.map(c => ({ content: (c.symbol_name ? c.symbol_name + '\n' : '') + c.content })), opts.rerankModel);
      if (ranked && ranked.length) {
        const map = new Map(cands.map((c, i) => [i, c]));
        const re = ranked.map(r => { const c = map.get(r.index); if (c) c.rerank_score = r.score; return c; }).filter(Boolean);
        // 重排结果在前，其余保持 RRF 序
        const rest = out.filter(c => !cands.includes(c));
        out = re.concat(rest);
      }
    } catch { /* 回落 RRF */ }
  }
  return out.slice(0, topN);
}

module.exports = { search, parseEmbedding, cosine, symbolScore, bm25Scores, DEFAULT_WEIGHTS };
