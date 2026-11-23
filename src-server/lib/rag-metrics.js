/**
 * RAG 质量评测四指标（RAGAS 类，M4 AI-03，2026-11-23）+ 端到端 RAG 质量基线 runner
 *
 * 背景：原召回评测只有「Top-1 命中」（已由 kb-eval-regression 升级为 Recall@K/MRR/NDCG），
 * 但「检索对了、生成错了」的生成侧质量问题（上下文选错/答案跑题/幻觉）完全不可见——
 * 对标 Dify 缺失 RAGAS 类生成质量口径。
 *
 * 四指标（均 0~1，越高越好；LLM 裁判优先、启发式回退）：
 *   - context_precision 上下文精确率：检索片段中与问题相关的占比（含排序质量，相关片段越靠前分越高）
 *   - context_recall    上下文召回率：回答/问题所需信息被检索片段覆盖的程度
 *   - answer_relevancy 答案相关性：回答与问题的对题程度（是否回答了所问）
 *   - faithfulness      答案忠实度：回答中的事实是否被检索片段支撑（复用 lib/faithfulness 判定）
 *
 * 评测模式（opts.mode /自动判定）：
 *   - 'llm'：有供应商时默认——单次批量调用 chatOnce 裁判全部四指标（JSON 输出，8s 硬超时）
 *   - 'heuristic'：无供应商/LLM 失败/显式要求——词面启发式（词覆盖率近似，口径见各函数注释；
 *     无生成模型时 runRagBaseline 以 answerFn 注入答案，检索型指标仍真实可信）
 *
 * runRagBaseline：逐用例走完整链路（retrieve → 生成 → 四指标）→ 聚合落 evaluations（type='rag'，
 * metrics 列存聚合）——同一评测集重跑即可得「同一 KB 变更前后」的量化对比（计划表验收口径）。
 * 0 阻断：单用例任何异常按该用例计 0 分并记录 error，不中断整批。
 */
const { db, now } = require('../db');
const { retrieve } = require('./retriever');
const { chatOnce, getConfiguredProviders } = require('./llm');
const { lexicalCover, splitSentences } = require('./faithfulness');
const { rankMetrics } = require('./kb-eval-regression');

const JUDGE_TIMEOUT_MS = 8000;
const ANSWER_TIMEOUT_MS = 30000;
const MAX_CONTEXTS = 5;    // 单用例送检片段数（与检索 TopN 缺省一致）

/** 指标定义（/api/eval/config 展示用；与 D3-4 metricDefinitions 同风格） */
const RAG_METRIC_DEFS = [
  { key: 'context_precision', label: '上下文精确率', unit: '', target: '越高越好', lowerBetter: false, desc: '检索片段中相关内容的占比与排序质量（相关片段越靠前分越高）' },
  { key: 'context_recall', label: '上下文召回率', unit: '', target: '越高越好', lowerBetter: false, desc: '回答所需信息被检索片段覆盖的程度（期望词覆盖率近似）' },
  { key: 'answer_relevancy', label: '答案相关性', unit: '', target: '越高越好', lowerBetter: false, desc: '回答与问题的对题程度（是否回答了所问）' },
  { key: 'faithfulness', label: '答案忠实度', unit: '', target: '越高越好', lowerBetter: false, desc: '回答中的事实被检索片段支撑的比例（引用/词面/LLM 裁判）' },
];

/* ============================ 启发式指标（可单测的纯函数） ============================ */

/** 实词集合（与 faithfulness.sentenceTerms 同口径；独立实现避免跨模块私有函数依赖漂移） */
function _terms(s) {
  const clean = String(s || '').toLowerCase().replace(/\[\d{1,3}\]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const set = new Set();
  for (const w of clean.split(/\s+/)) if (w.length >= 2) set.add(w);
  const joined = clean.replace(/\s+/g, '');
  for (let i = 0; i + 1 < joined.length; i++) {
    const p = joined.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(p)) set.add(p);
  }
  return set;
}

/** 启发式上下文精确率：片段按「与 query 的词面重合度」判相关，二值相关性按排名折损累计（NDCG 形态）——
 *  相关片段排得越靠前分越高；全不相关 → 0。 */
function heuristicContextPrecision(query, contexts) {
  const q = _terms(query);
  if (!q.size || !contexts.length) return 0;
  const rel = contexts.map(c => {
    const t = String(c || '');
    let hit = 0;
    for (const term of q) if (t.includes(term)) hit++;
    return hit / q.size >= 0.1; // 与 query 词面重合 ≥10% 视为相关（启发式阈值）
  });
  let dcg = 0;
  rel.forEach((r, i) => { if (r) dcg += 1 / Math.log2(i + 2); });
  const rc = rel.filter(Boolean).length;
  if (!rc) return 0;
  let idcg = 0;
  for (let i = 0; i < rc; i++) idcg += 1 / Math.log2(i + 2);
  return Math.round((dcg / idcg) * 100) / 100;
}

/** 启发式上下文召回率：期望词（answer/expect_terms）被片段集合覆盖的比例——
 *  无显式期望词时以 query 词为代理（检索应带回问句所述信息） */
function heuristicContextRecall(query, contexts, expectTerms) {
  const terms = (expectTerms && expectTerms.length ? expectTerms : [..._terms(query)]);
  if (!terms.length) return 0;
  const joined = (contexts || []).join('\n');
  const covered = terms.filter(t => joined.includes(t)).length;
  return Math.round((covered / terms.length) * 100) / 100;
}

/** 启发式答案相关性：query 词被 answer 覆盖的比例（对题下限口径；完全跑题 → 趋近 0） */
function heuristicAnswerRelevancy(query, answer) {
  const q = _terms(query);
  if (!q.size) return 0;
  const a = String(answer || '');
  if (!a.trim()) return 0;
  const hit = [...q].filter(t => a.includes(t)).length;
  return Math.round((hit / q.size) * 100) / 100;
}

/** 启发式忠实度：答案句被片段集合词面支撑（覆盖率 ≥0.15）的比例（复用 AI-07 同口径） */
function heuristicFaithfulness(answer, contexts) {
  const sentences = splitSentences(answer);
  if (!sentences.length) return 0;
  const base = (contexts || []).join('\n');
  const supported = sentences.filter(s => lexicalCover(s, base) >= 0.15).length;
  return Math.round((supported / sentences.length) * 100) / 100;
}

/* ============================ LLM 裁判 ============================ */

/** 单次批量 LLM 裁决四指标。返回归一化对象或 null（无供应商/失败/mock/超时） */
async function llmJudgeFour({ query, contexts, answer, opts = {} }) {
  if (!getConfiguredProviders().length) return null;
  if (opts.mode === 'heuristic') return null;
  const ctx = contexts.map((c, i) => `【片段${i + 1}】${String(c || '').slice(0, 600)}`).join('\n');
  const prompt = `你是 RAG 质量评测员。基于以下「用户问题、检索片段、模型回答」，从四个维度打分（0~1 两位小数）：
- context_precision：检索片段与问题相关的程度（含排序质量，相关片段越靠前分越高）
- context_recall：回答问题所需信息被检索片段覆盖的程度
- answer_relevancy：回答与问题的对题程度
- faithfulness：回答中的事实被检索片段支撑的程度（片段未提及的断言 = 不支撑）
要求：仅输出 JSON 对象，不要其他文字。格式：{"context_precision":0.8,"context_recall":0.7,"answer_relevancy":0.9,"faithfulness":0.85}

用户问题：${String(query || '').slice(0, 300)}
${ctx}
模型回答：${String(answer || '').slice(0, 1200)}`;
  try {
    const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 400, hardTimeoutMs: JUDGE_TIMEOUT_MS });
    if (!r || r.mode === 'mock' || !r.full) return null;
    const m = String(r.full).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const clamp01 = v => (Number.isFinite(+v) ? Math.min(1, Math.max(0, Math.round(+v * 100) / 100)) : null);
    const out = {};
    for (const k of ['context_precision', 'context_recall', 'answer_relevancy', 'faithfulness']) out[k] = clamp01(o[k]);
    if (Object.values(out).some(v => v == null)) return null; // 关键指标缺失 → 回落启发式
    return out;
  } catch { return null; }
}

/* ============================ 四指标统一入口 ============================ */

/**
 * 计算单用例 RAG 四指标。
 * @param {object} p { query, contexts(检索片段数组), answer, expectTerms?, opts?{mode:'llm'|'heuristic', judge?} }
 * @returns {Promise<{mode, context_precision, context_recall, answer_relevancy, faithfulness}>}
 * opts.judge（DI）：测试注入裁判函数（返回四指标对象），生产缺省走 LLM→启发式两级。
 */
async function ragFourMetrics({ query, contexts, answer, expectTerms, opts = {} }) {
  const ctxs = (Array.isArray(contexts) ? contexts : []).filter(Boolean);
  const heuristic = {
    context_precision: heuristicContextPrecision(query, ctxs),
    context_recall: heuristicContextRecall(query, ctxs, expectTerms),
    answer_relevancy: heuristicAnswerRelevancy(query, answer),
    faithfulness: heuristicFaithfulness(answer, ctxs),
  };
  let llm = null;
  if (typeof opts.judge === 'function') {
    try { llm = await opts.judge({ query, contexts: ctxs, answer }); } catch { llm = null; }
  } else {
    llm = await llmJudgeFour({ query, contexts: ctxs, answer, opts });
  }
  if (llm) {
    return {
      mode: (typeof opts.judge === 'function') ? 'llm' : 'llm',
      context_precision: llm.context_precision,
      context_recall: llm.context_recall,
      answer_relevancy: llm.answer_relevancy,
      faithfulness: llm.faithfulness,
    };
  }
  return { mode: 'heuristic', ...heuristic };
}

/* ============================ 端到端 RAG 质量基线 ============================ */

/** 生成模型回答（KB 接地 + 引用规范，与 chat 主链路同提示词风格）。
 *  answerFn（DI）注入时优先；无供应商且无 answerFn → null（该用例答案侧指标计 0）。 */
async function generateAnswer({ query, contexts, opts = {} }) {
  if (typeof opts.answerFn === 'function') return opts.answerFn({ query, contexts });
  if (!getConfiguredProviders().length) return null;
  const ctx = contexts.map((c, i) => `[${i + 1}] ${String(c || '').slice(0, 800)}`).join('\n');
  const messages = [
    { role: 'system', content: `你是知识库问答助手。优先依据给出的检索内容回答；引用时在句末标注来源编号如 [1]；知识库没有的内容如实说明，不要编造。\n\n检索内容：\n${ctx}` },
    { role: 'user', content: String(query || '').slice(0, 500) },
  ];
  try {
    const r = await chatOnce(messages, { temperature: 0.3, max_reply: 1024, hardTimeoutMs: ANSWER_TIMEOUT_MS, model: opts.model });
    if (!r || r.mode === 'mock' || !r.full) return null;
    return r.full;
  } catch { return null; }
}

/**
 * 运行 RAG 质量基线：逐用例 retrieve → 生成 → 四指标 → 聚合落 evaluations（type='rag'）。
 * @param {object} p { kbId, cases:[{query, expect_terms?}], name?, topN?=5, opts?{model, answerFn, judge, rerankEnabled} }
 * @returns {Promise<{id, name, cases, metrics, retrieval, detail}>}
 *  - metrics：四指标均值 + mode；retrieval：Top-1/hit@K/召回@K/MRR/NDCG（rankMetrics 复用，需用例带 expect_terms）
 *  - score 列 = 四指标均值（0~1，可排序/可比）
 */
async function runRagBaseline({ kbId, cases, name, topN = MAX_CONTEXTS, opts = {} }) {
  const list = (Array.isArray(cases) ? cases : [])
    .map(c => ({ query: String(c?.query ?? '').trim(), expect_terms: Array.isArray(c?.expect_terms) ? c.expect_terms.map(t => String(t || '').trim()).filter(Boolean) : [] }))
    .filter(c => c.query);
  if (!list.length) return { ok: false, msg: '用例为空（需至少 1 条 {query, expect_terms?}）' };
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(kbId);
  if (!kb) return { ok: false, msg: '知识库不存在' };
  const detail = [];
  const fourSum = { context_precision: 0, context_recall: 0, answer_relevancy: 0, faithfulness: 0 };
  let fourCount = 0;
  const rankItems = [];
  for (const c of list) {
    const row = { query: c.query, expect_terms: c.expect_terms };
    try {
      const hits = await retrieve(c.query, kbId, topN, 0.01, { rerankEnabled: opts.rerankEnabled });
      const contexts = hits.map(h => String(h.content || ''));
      row.hits = hits.length;
      row.retrieval = c.expect_terms.length ? rankMetrics(contexts, c.expect_terms) : null;
      if (row.retrieval) rankItems.push(row.retrieval);
      const answer = await generateAnswer({ query: c.query, contexts, opts });
      row.answer = answer ? String(answer).slice(0, 500) : null;
      if (answer) {
        const m = await ragFourMetrics({ query: c.query, contexts, answer, expectTerms: c.expect_terms, opts });
        row.metrics = m;
        fourCount++;
        for (const k of Object.keys(fourSum)) fourSum[k] += (m[k] || 0);
        row.mode = m.mode;
      } else {
        // 无生成能力（无供应商且未注入 answerFn）：答案侧四指标不可评，显式置 null（聚合只统计可评用例）
        row.metrics = null;
        row.mode = 'no_answer';
      }
    } catch (e) {
      row.error = String(e && e.message).slice(0, 120);
    }
    detail.push(row);
  }
  const mean4 = k => fourCount ? Math.round((fourSum[k] / fourCount) * 100) / 100 : null;
  const metrics = {
    cases: list.length, evaluated_answers: fourCount,
    context_precision: mean4('context_precision'),
    context_recall: mean4('context_recall'),
    answer_relevancy: mean4('answer_relevancy'),
    faithfulness: mean4('faithfulness'),
    top_n: topN,
    evaluated_at: now(),
  };
  const score = fourCount ? +((metrics.context_precision + metrics.context_recall + metrics.answer_relevancy + metrics.faithfulness) / 4).toFixed(2) : 0;
  const evalName = (name || `RAG质量基线·${kb.name}`).slice(0, 100);
  const info = db.prepare(`INSERT INTO evaluations (name,kb_id,type,dataset,status,score,result,metrics,created_at)
    VALUES (?,?, 'rag', ?, 'done', ?, ?, ?, ?)`)
    .run(evalName, kbId, JSON.stringify(list), score, JSON.stringify(detail), JSON.stringify(metrics), now());
  return { ok: true, id: Number(info.lastInsertRowid), name: evalName, cases: list.length, metrics, score, detail };
}

module.exports = {
  ragFourMetrics, runRagBaseline, generateAnswer,
  heuristicContextPrecision, heuristicContextRecall, heuristicAnswerRelevancy, heuristicFaithfulness,
  RAG_METRIC_DEFS, MAX_CONTEXTS,
};
