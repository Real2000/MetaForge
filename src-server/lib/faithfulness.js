/**
 * 答案忠实度 / 引用校验（M4 AI-07，2026-11-23）
 *
 * 背景：RAG 回答的幻觉主要来自两类——① 引用编号越界/编造（[9] 但命中集只有 2 条）；
 * ② 答案句与所引片段语义脱节（编造命中集中不存在的事实）。原链路生成后无任何校验，
 * 用户无法区分「有据回答」与「幻觉回答」。
 *
 * 两级校验：
 *   L1 结构校验（恒开，纯本地字符串运算，0 成本 0 延迟）：
 *     - 引用合法域：答案中 [n] 须满足 1 ≤ n ≤ hits.length，越界/编造 → invalidCitations
 *   L2 支撑度校验（逐句判定「答案句是否被命中集支撑」）：
 *     - LLM 裁判：单次批量调用（chatOnce，temperature 0.1，硬超时 8s），返回逐句 supported 布尔；
 *       有供应商时默认开启（AGENT_FAITHFULNESS_LLM=0 可关，控成本）；mock/演示模式自动回落词面
 *     - 词面回退（无供应商/LLM 失败/被关闭）：句中实词与命中集（或所引片段）的覆盖率 ≥ 0.15 判支撑
 *
 * 判定：invalidCitations 非空，或 supportedRatio < SUPPORT_THRESHOLD（默认 0.5）→ lowConfidence = true。
 * 计划表验收口径：幻觉引用检出率 ≥80%、误报 ≤10%——阈值 0.5 取保守值压误报（LLM 裁判 + 引用域校验双通道）。
 *
 * 0 阻断：任何异常返回 null（调用方忽略），绝不影响回答下发；不做「重答一次」（流式内容已下发，
 * 二次生成体验差且成本翻倍，选择标注「低置信」方案——计划表两选一中的低风险项）。
 */
const { chatOnce, getConfiguredProviders } = require('./llm');

const SUPPORT_THRESHOLD = 0.5;   // 支撑度低于此比例 → 低置信标注（保守值压误报）
const LEXICAL_COVER_MIN = 0.15;  // 词面回退路径的支撑判定覆盖率阈值
const MAX_SENTENCES = 16;        // 送检句数上限（长答案截断，控 LLM 成本）
const MIN_SENTENCE_LEN = 6;      // 过短片段（问候/语气词/Markdown 符号）不送检（中文字 6 字已是实质信息句）
const LLM_TIMEOUT_MS = 8000;     // LLM 裁决硬超时（超时回落词面，不拖慢对话收尾）

/** 提取答案中的引用编号（去重保序）：[1]、[2][3] → [1,2,3] */
function parseCitations(answer) {
  const out = [];
  const seen = new Set();
  for (const m of String(answer || '').matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** 答案分句：按中英标点与换行切分；过滤 <MIN_SENTENCE_LEN 的碎片（问候/序号/Markdown 噪声不送检）。
 *  长度统计剔除中英标点与引用标记（否则标点计入长度会把长句误判为碎片）。 */
function splitSentences(answer) {
  return String(answer || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map(s => s.trim())
    .filter(s => s.replace(/[#*`>\-\s\[\]\d.、。，：！？；！？“”‘’（）·…]/g, '').length >= MIN_SENTENCE_LEN);
}

/** 实词集合（去 Markdown/引用标记/数字，降小写；中文逐字 + 2-gram，英文按词） */
function sentenceTerms(s) {
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

/** 词面支撑度：句中实词被 text 覆盖的比例（0~1）。空句/空文本返回 0 */
function lexicalCover(sentence, text) {
  const st = sentenceTerms(sentence);
  if (!st.size) return 0;
  const t = String(text || '');
  let hit = 0;
  for (const term of st) if (t.includes(term)) hit++;
  return hit / st.size;
}

/** LLM 批量裁决：逐句判断是否被 contexts 支撑。返回 Map<句idx, boolean>；失败/mock/超时返回 null */
async function llmJudgeSentences(sentences, contexts, opts = {}) {
  if (!getConfiguredProviders().length) return null;
  if (process.env.AGENT_FAITHFULNESS_LLM === '0') return null;
  const ctx = contexts.map((c, i) => `【片段${i + 1}】${String(c || '').slice(0, 600)}`).join('\n');
  const prompt = `你是答案忠实度审核员。下面给出知识库检索片段和答案分句列表，逐句判断：该句陈述的事实是否被检索片段支撑（片段未提及或与片段矛盾 = 不支撑；仅在片段中的表述有依据、无新事实即可支撑；礼貌性/总结性/引用标注句视为支撑）。
要求：仅输出 JSON 数组，不要其他文字。格式：[{"i":0,"supported":true},{"i":1,"supported":false}]（i 为句子序号，从 0 开始，必须覆盖全部句子）。

${ctx}

答案分句：
${sentences.map((s, i) => `${i}. ${s}`).join('\n')}`;
  try {
    const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 1024, hardTimeoutMs: LLM_TIMEOUT_MS });
    if (!r || r.mode === 'mock' || !r.full) return null;
    const m = String(r.full).match(/\[[\s\S]*\]/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return null;
    const map = new Map();
    for (const it of parsed) {
      if (it && Number.isInteger(it.i) && typeof it.supported === 'boolean') map.set(it.i, it.supported);
    }
    return map.size ? map : null;
  } catch { return null; }
}

/**
 * 忠实度/引用校验主入口（chat.js 生成完成后调用）。
 * @param {object} p  { answer, hits, query?, opts? }
 *   hits：检索命中集（retriever 输出，含 content 字段）
 * @returns {null | { mode, score, verdict, lowConfidence, invalidCitations, unsupported, summary }}
 *   无可检内容（无引用句且无实义句）→ null；异常 → null（0 阻断）
 */
async function checkFaithfulness({ answer, hits, query, opts = {} }) {
  try {
    const list = Array.isArray(hits) ? hits : [];
    const ans = String(answer || '');
    if (!ans || !list.length) return null;
    // L1：引用合法域
    const cited = parseCitations(ans);
    const invalidCitations = cited.filter(n => n < 1 || n > list.length);
    const citedValid = cited.filter(n => n >= 1 && n <= list.length);
    // L2：逐句支撑度（引用句优先按其引用片段判定；无引用句按全命中集）
    let sentences = splitSentences(ans).slice(0, MAX_SENTENCES);
    if (!sentences.length) return null;
    const contexts = list.map(h => String(h && (h.content || h) || ''));
    const llmMap = await llmJudgeSentences(sentences, contexts, opts);
    const unsupported = [];
    let judged = 0;
    let supported = 0;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const citeMs = [...s.matchAll(/\[(\d{1,3})\]/g)].map(m => Number(m[1])).filter(n => n >= 1 && n <= list.length);
      // 判定基准：该句的引用片段（多引用取并集）；无引用句以全命中集为基准（LLM 模式）/全命中集（词面）
      const base = citeMs.length ? citeMs.map(n => contexts[n - 1]).join('\n') : contexts.join('\n');
      judged++;
      if (llmMap) {
        if (llmMap.get(i) === true) supported++;
        else unsupported.push({ i, sentence: s.slice(0, 80) });
      } else {
        if (lexicalCover(s, base) >= LEXICAL_COVER_MIN) supported++;
        else unsupported.push({ i, sentence: s.slice(0, 80) });
      }
    }
    const score = judged ? Math.round((supported / judged) * 100) / 100 : null;
    const lowConfidence = invalidCitations.length > 0 || (score != null && score < (Number.isFinite(+opts.threshold) ? +opts.threshold : SUPPORT_THRESHOLD));
    const mode = llmMap ? 'llm' : 'lexical';
    const verdict = invalidCitations.length ? 'invalid_citation' : lowConfidence ? 'low_confidence' : 'pass';
    return {
      mode, score, verdict, lowConfidence,
      invalidCitations, unsupported,
      summary: {
        mode, score, verdict, low_confidence: lowConfidence,
        invalid_citations: invalidCitations.length, unsupported_sentences: unsupported.length,
        judged_sentences: judged, cited_sources: [...new Set(citedValid)].length,
      },
    };
  } catch { return null; } // 0 阻断：任何异常吞掉（调用方拿 null 直接跳过）
}

module.exports = { checkFaithfulness, parseCitations, splitSentences, lexicalCover, sentenceTerms, SUPPORT_THRESHOLD, LEXICAL_COVER_MIN };
