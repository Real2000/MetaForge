/**
 * 评测体系 V1（D3-4，2026-11-21）
 *
 * 目标：把「智能体测评 + 知识库评测回归」升级为**可对比的发布基线**体系——补任务成功率、
 * 步数、人工干预率三项核心指标，每次发布采集一条基线，与同套件上一条基线对比（是否回退）。
 * 另提供 SWE-bench-lite 适配器（外部基准可接入）。
 *
 * 分层（与 experience.js / sandbox-pool.js 一致：纯逻辑 + 有状态分离）：
 *   - 纯逻辑（可单测）：normalizeCase / casePassed / stepsFromTools / computeMetrics /
 *     diffBaseline / compareVerdict / sweBenchLiteToCases / sweBenchLiteTemplate
 *   - 有状态（供 routes/eval.js 复用）：captureFromTelemetry / createBaseline / listBaselines /
 *     baselineDetail / overview / autoCaptureOnPublish / deleteBaseline
 *
 * 指标口径：
 *   - 任务成功率 = 通过用例数 / 总用例数 × 100（单用例得分 ≥ PASS_THRESHOLD 视为通过）
 *   - 平均步数   = 所有用例步数之和 / 总用例数（步数 = 一轮任务消耗的工具调用次数，缺省 0）
 *   - 人工干预率 = 需要人工介入的用例数 / 总用例数 × 100（安全阻断/被判低质/人工接管等）
 * 三条口径均可从「评测用例结果」直接给出，也可从平台真实遥测（messages + chat_traces）聚合。
 */

const { db, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

/* ============================ 常量 / 目标线 ============================ */

const PASS_THRESHOLD = 0.6;   // 单用例得分 ≥ 0.6 视为通过
const SUCCESS_TARGET = 70;    // 任务成功率验收线（≥ 70% 达标）
const INTERVENTION_MAX = 20;  // 人工干预率验收线（≤ 20% 达标，越低越好）
const MAX_CASES = 500;        // 单次基线保留的用例明细上限

/** 内置评测集模板（第三方基准可接入） */
const SUITE_TEMPLATES = [
  {
    name: 'swe-bench-lite', label: 'SWE-bench-lite（软件工程基准）', suite_type: 'builtin',
    desc: 'SWE-bench-lite 数据集子集：以仓库 issue 为任务、补丁通过测试为成功判据；本平台按其 instance 结构导入为内部用例集后评测。',
  },
  { name: 'agent-suite', label: '智能体测评集', suite_type: 'agent', desc: '对某智能体批量提问并按期望关键词命中判分（evaluations type=agent）。' },
  { name: 'kb-regression', label: '知识库召回回归', suite_type: 'kb', desc: '知识库 Top-1 召回命中重跑（evaluations type=kb，复用 kb-eval-regression）。' },
];

/* ============================ 纯逻辑（可单测） ============================ */

/** 从 tool_calls JSON 推导步数（一轮任务消耗的工具调用次数 = 数组长度） */
function stepsFromTools(toolCalls) {
  let arr = toolCalls;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr || '[]'); } catch { arr = []; }
  }
  return Array.isArray(arr) ? arr.length : 0;
}

/** 归一一评测用例：统一 {id, passed, score, steps, intervened, note} */
function normalizeCase(raw) {
  const it = raw || {};
  let score = Number(it.score);
  if (!Number.isFinite(score)) {
    // 只给了 passed 布尔时，换算成 1/0
    score = it.passed ? 1 : (it.success ? 1 : 0);
  }
  if (score > 1) score = score / 100; // 允许传入 0~100 的分值
  score = Math.max(0, Math.min(1, score));
  const passed = it.passed != null ? !!it.passed : score >= PASS_THRESHOLD;
  const steps = Number.isFinite(Number(it.steps)) ? Math.max(0, Math.round(Number(it.steps))) : 0;
  const intervened = !!(it.intervened || it.blocked || it.manual);
  return {
    id: String(it.id ?? it.name ?? '').slice(0, 120),
    passed,
    score: +score.toFixed(2),
    steps,
    intervened,
    note: String(it.note ?? '').slice(0, 200),
  };
}

/** 单用例是否通过（基于归一后的得分与阈值） */
function casePassed(c, threshold = PASS_THRESHOLD) {
  const n = normalizeCase(c);
  return n.passed && n.score >= threshold;
}

/** 计算指标（输入任意可归一用例数组） */
function computeMetrics(rawCases) {
  const cases = (Array.isArray(rawCases) ? rawCases : []).map(normalizeCase);
  const total = cases.length;
  const passed = cases.filter(c => c.passed).length;
  const intervened = cases.filter(c => c.intervened).length;
  const stepSum = cases.reduce((s, c) => s + c.steps, 0);
  const successRate = total ? Math.round(passed / total * 1000) / 10 : 0;   // 一位小数
  const interventionRate = total ? Math.round(intervened / total * 1000) / 10 : 0;
  const avgSteps = total ? Math.round(stepSum / total * 10) / 10 : 0;
  return {
    total, passed, intervened,
    successRate, avgSteps, interventionRate,
    meetsSuccess: total ? successRate >= SUCCESS_TARGET : false,
    meetsIntervention: total ? interventionRate <= INTERVENTION_MAX : false,
  };
}

/** 与上一基线对比（cur/prev 为指标对象；prev 为空 → 全部视为首次） */
function diffBaseline(cur, prev) {
  const c = cur || {};
  const p = prev || null;
  const mk = (key, lowerBetter) => {
    const cv = Number(c[key]) || 0;
    if (!p) return { cur: cv, prev: null, delta: null, trend: '首次', lowerBetter: !!lowerBetter };
    const pv = Number(p[key]) || 0;
    const delta = Math.round((cv - pv) * 10) / 10;
    let trend = '持平';
    if (Math.abs(delta) >= 0.1 / 2) trend = delta > 0 ? 'up' : 'down';
    return { cur: cv, prev: pv, delta, trend, lowerBetter: !!lowerBetter };
  };
  return {
    successRate: mk('successRate', false),
    avgSteps: mk('avgSteps', true),
    interventionRate: mk('interventionRate', true),
  };
}

/** 判定本次相对上一基线是否回退（成功率不下降 且 干预率不上升 视为无回退） */
function compareVerdict(diff) {
  const d = diff || {};
  const reasons = [];
  const sr = d.successRate || {};
  const ir = d.interventionRate || {};
  if (sr.prev == null) return { ok: true, first: true, reasons: ['首次基线（无可对比基准）'] };
  let ok = true;
  if (sr.delta != null && sr.delta < 0) { ok = false; reasons.push(`任务成功率下降 ${Math.abs(sr.delta)}pp`); }
  if (ir.delta != null && ir.delta > 0) { ok = false; reasons.push(`人工干预率上升 ${ir.delta}pp`); }
  if (ok) reasons.push('成功率未下降、干预率未上升——无回退');
  return { ok, first: false, reasons };
}

/* ==================== 统计显著性（V2 增强：零依赖两比例 z 检验） ==================== */

/** 误差函数 erf（Abramowitz & Stegun 7.1.26 近似，最大误差 ~1.5e-7） */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** 标准正态双尾 p 值：P(|Z| > |z|) = 2·(1 − Φ(|z|)) */
function normalTwoTailP(z) {
  const az = Math.abs(Number(z) || 0);
  const cdf = 0.5 * (1 + erf(az / Math.SQRT2));
  return Math.max(0, Math.min(1, 2 * (1 - cdf)));
}

const ALPHA = 0.05;      // 显著性水平（双尾）
const MIN_SAMPLE = 5;    // 每组最小样本量；低于此值改用 Fisher 精确检验（不做「样本不足」直接放行）
const EXPECTED_MIN = 5;  // z 检验适用前提：每个期望频数 ≥ 5，否则改用 Fisher

/** 标准正态分位数（Acklam 近似，双精度 |相对误差| < 1.15e-9） */
function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > phigh) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Wilson 得分置信区间（比例，默认 95%）。比正态近似在小样本/极端比例下更稳健。
 * @returns {{low:number, high:number, center:number, width:number}} 均为百分比（0~100，一位小数）
 */
function wilsonInterval(successes, total, alpha = ALPHA) {
  const n = Number(total) || 0, x = Math.max(0, Math.min(Number(successes) || 0, n));
  const r1 = (v) => Math.round(v * 1000) / 10;
  if (n <= 0) return { low: 0, high: 0, center: 0, width: 0 };
  const z = normInv(1 - alpha / 2);
  const phat = x / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))) / denom;
  const lo = Math.max(0, center - half), hi = Math.min(1, center + half);
  return { low: r1(lo), high: r1(hi), center: r1(center), width: r1(hi - lo) };
}

/** 对数阶乘（带缓存）与组合数对数，供 Fisher 精确检验做数值稳定运算 */
const _lfact = [0];
function lfact(n) {
  n = Math.floor(Number(n) || 0);
  if (n < 0) return 0;
  for (let i = _lfact.length; i <= n; i++) _lfact[i] = _lfact[i - 1] + Math.log(i);
  return _lfact[n];
}
function logChoose(n, k) { if (k < 0 || k > n) return -Infinity; return lfact(n) - lfact(k) - lfact(n - k); }

/**
 * Fisher 精确检验（两尾，2×2 表）。表 [[a,b],[c,d]]：a=当前通过、b=当前未过、c=上一条通过、d=上一条未过。
 * 小样本 / 期望频数过低时替代 z 检验，避免正态近似失真。
 * @returns {{p:number|null, oddsRatio:number|null, significant:boolean, alpha:number, method:'fisher', smallSample:boolean, direction:'up'|'down'|'flat'|'unknown'}}
 */
function fisherExact(a, b, c, d, alpha = ALPHA) {
  a = Math.round(Number(a) || 0); b = Math.round(Number(b) || 0); c = Math.round(Number(c) || 0); d = Math.round(Number(d) || 0);
  const r1 = a + b, r2 = c + d, col1 = a + c, col2 = b + d, n = a + b + c + d;
  if (n === 0 || r1 === 0 || r2 === 0 || col1 === 0 || col2 === 0) {
    return { p: null, oddsRatio: null, significant: false, alpha, method: 'fisher', smallSample: true, direction: 'unknown' };
  }
  const logP = (x) => logChoose(r1, x) + logChoose(r2, col1 - x) - logChoose(n, col1);
  const pObs = Math.exp(logP(a));
  const lo = Math.max(0, col1 - r2), hi = Math.min(r1, col1);
  let ptwo = 0;
  for (let x = lo; x <= hi; x++) { const p = Math.exp(logP(x)); if (p <= pObs * (1 + 1e-7)) ptwo += p; }
  ptwo = Math.min(1, ptwo);
  const OR = (b * c === 0) ? ((a * d === 0) ? null : Infinity) : (a * d) / (b * c);
  const direction = (a / r1) > (c / r2) ? 'up' : (a / r1) < (c / r2) ? 'down' : 'flat';
  return { p: Math.round(ptwo * 10000) / 10000, oddsRatio: (OR == null || !isFinite(OR)) ? OR : Math.round(OR * 1000) / 1000, significant: ptwo < alpha, alpha, method: 'fisher', smallSample: false, direction };
}

/**
 * 两比例 z 检验（pooled，双尾）。比较两组「成功数/总数」比例差异是否统计显著。
 * @returns {{z:number|null, p:number|null, significant:boolean, alpha:number, smallSample:boolean, direction:'up'|'down'|'flat'|'unknown', se:number|null, method:'z'}}
 */
function proportionZTest(x1, n1, x2, n2, alpha = ALPHA) {
  const N1 = Number(n1) || 0, N2 = Number(n2) || 0, X1 = Number(x1) || 0, X2 = Number(x2) || 0;
  if (N1 < MIN_SAMPLE || N2 < MIN_SAMPLE) {
    return { z: null, p: null, significant: false, alpha, smallSample: true, direction: 'unknown', se: null, method: 'z' };
  }
  const pPool = (X1 + X2) / (N1 + N2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / N1 + 1 / N2));
  if (se <= 0) return { z: null, p: null, significant: false, alpha, smallSample: false, direction: 'unknown', se: 0, method: 'z' };
  const z = (X1 / N1 - X2 / N2) / se;      // 正 = 当前比例更高
  const p = normalTwoTailP(z);
  return {
    z: Math.round(z * 1000) / 1000, p: Math.round(p * 10000) / 10000,
    significant: p < alpha, alpha, smallSample: false,
    direction: z > 0 ? 'up' : z < 0 ? 'down' : 'flat', se: Math.round(se * 10000) / 10000, method: 'z',
  };
}

/**
 * 按样本规模自动选择检验方法：任一组样本 < MIN_SAMPLE 或任一期望频数 < EXPECTED_MIN → Fisher 精确检验；否则两比例 z 检验。
 */
function proportionTest(x1, n1, x2, n2, alpha = ALPHA) {
  const N1 = Number(n1) || 0, N2 = Number(n2) || 0, X1 = Number(x1) || 0, X2 = Number(x2) || 0;
  const pPool = (X1 + X2) / ((N1 + N2) || 1);
  const expMin = Math.min(N1 * pPool, N1 * (1 - pPool), N2 * pPool, N2 * (1 - pPool));
  if (N1 < MIN_SAMPLE || N2 < MIN_SAMPLE || !Number.isFinite(expMin) || expMin < EXPECTED_MIN) {
    return fisherExact(X1, N1 - X1, X2, N2 - X2, alpha);
  }
  return proportionZTest(X1, N1, X2, N2, alpha);
}

/**
 * 对两条基线做显著性检验：成功率（主指标）+ 干预率；按样本规模自动选 z / Fisher。
 * verdict ∈ improved（显著提升）/ regressed（显著回退）/ no_change（变化不显著）/ insufficient（样本不足）
 */
function significance(cur, prev, alpha = ALPHA) {
  const c = cur || {}, p = prev || {};
  if (!prev || p.total == null) return { first: true, alpha, verdict: 'first', successRate: null, interventionRate: null };
  const sr = proportionTest(c.passed, c.total, p.passed, p.total, alpha);
  const ir = proportionTest(c.intervened, c.total, p.intervened, p.total, alpha);
  let verdict;
  if (sr.smallSample) verdict = 'insufficient';
  else if (!sr.significant) verdict = 'no_change';
  else verdict = sr.direction === 'up' ? 'improved' : 'regressed';
  return { first: false, alpha, successRate: sr, interventionRate: ir, verdict };
}

/** SWE-bench-lite instance → 内部用例（成功判据：补丁通过 FAIL_TO_PASS 测试） */
function sweBenchLiteToCases(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((r) => {
    const it = r || {};
    const failed = Array.isArray(it.FAIL_TO_PASS) ? it.FAIL_TO_PASS.length : 0;
    const passed = Number.isFinite(Number(it.passed_tests)) ? Number(it.passed_tests) : null;
    // 命中数 / 需要通过的测试总数 → 得分；缺省无测试信息按未通过
    let score = 0;
    if (failed > 0 && passed != null) score = Math.max(0, Math.min(1, passed / failed));
    else if (it.resolved === true) score = 1;
    return normalizeCase({
      id: it.instance_id || it.id || '',
      score,
      passed: it.resolved === true || score >= PASS_THRESHOLD,
      steps: Number.isFinite(Number(it.steps)) ? Number(it.steps) : 0,
      intervened: !!it.intervened,
      note: it.repo ? `${it.repo}` : '',
    });
  });
}

/** SWE-bench-lite 导入模板（结构 + 样例，供前端展示/复制） */
function sweBenchLiteTemplate() {
  return {
    suite_type: 'builtin', name: 'swe-bench-lite',
    schema: { instance_id: 'string', repo: 'string', problem_statement: 'string', FAIL_TO_PASS: 'string[]', passed_tests: 'number', resolved: 'boolean (可选)', steps: 'number (可选)' },
    sample: [{ instance_id: 'astropy__astropy-12907', repo: 'astropy/astropy', problem_statement: '修复 ...', FAIL_TO_PASS: ['test_a', 'test_b'], passed_tests: 2, steps: 5 }],
  };
}

/** 指标总览口径说明（供前端展示，避免口径歧义） */
function metricDefinitions() {
  return {
    passThreshold: PASS_THRESHOLD, successTarget: SUCCESS_TARGET, interventionMax: INTERVENTION_MAX,
    metrics: [
      { key: 'successRate', label: '任务成功率', unit: '%', target: `≥ ${SUCCESS_TARGET}`, lowerBetter: false, desc: '通过用例数 / 总用例数；单用例得分 ≥ ' + PASS_THRESHOLD + ' 视为通过' },
      { key: 'avgSteps', label: '平均步数', unit: '步', target: '参考', lowerBetter: true, desc: '一轮任务消耗的工具调用次数均值（chat_traces.tool_calls 长度）' },
      { key: 'interventionRate', label: '人工干预率', unit: '%', target: `≤ ${INTERVENTION_MAX}`, lowerBetter: true, desc: '需人工介入的用例占比（安全阻断 / 被判低质 / 人工接管）' },
    ],
    significance: {
      alpha: ALPHA, minSample: MIN_SAMPLE, expectedMin: EXPECTED_MIN,
      methods: ['z', 'fisher'],
      desc: `同一套件相邻两条基线对比：按样本规模自动选择检验方法——样本充足（每组 ≥ ${MIN_SAMPLE} 且期望频数 ≥ ${EXPECTED_MIN}）用两比例 z 检验，小样本/低期望频数用 Fisher 精确检验（两尾）；p < ${ALPHA} 视为差异显著。`,
      verdicts: [
        { key: 'improved', label: '显著提升' }, { key: 'regressed', label: '显著回退' },
        { key: 'no_change', label: '变化不显著' }, { key: 'insufficient', label: '样本不足/退化' },
      ],
    },
    confidence: {
      level: Math.round((1 - ALPHA) * 100), method: 'Wilson 得分区间',
      desc: `${Math.round((1 - ALPHA) * 100)}% Wilson 得分置信区间：对成功率/干预率给出区间估计，小样本与极端比例下比正态近似更稳健（趋势图置信带即由此绘制）。`,
    },
  };
}

/* ============================ 有状态（基线管理） ============================ */

/**
 * 从平台真实遥测聚合某智能体的评测用例（用于发布基线，零额外模型调用）。
 * 口径（V1 近似）：
 *   - 反馈类用例：messages.solved ∈ {1,2} 的助手消息——solved=1 通过、=2 未解决（真实任务成败信号）；
 *   - 执行类用例：chat_traces 每行一轮对话——passed=「未被安全阻断」（近似的完成判据）、
 *     steps=tool_calls 长度、intervened=blocked 非空（被安全阻断=需人工介入）。
 * 两类均为「可观测事件」，合并计成功率/步数/干预率；无评测集时作为发布基线的兜底来源。
 */
function captureFromTelemetry(agentId) {
  const aid = Number(agentId);
  if (!Number.isFinite(aid) || aid <= 0) return { cases: [], metrics: computeMetrics([]) };
  // 任务成功率：该智能体已反馈（solved 非 0）的助手消息；solved=1 通过、solved=2 未解决
  const solvedRows = dal.q(`SELECT m.solved AS solved
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.agent_id=? AND m.role='assistant' AND m.solved IN (1,2)`, [aid]);
  // 步数 / 人工干预：chat_traces 一次对话一行（tool_calls 长度=步数；blocked 非空=被安全阻断=需干预）
  const traces = dal.q('SELECT tool_calls, blocked FROM chat_traces WHERE agent_id=? LIMIT 1000', [aid]);
  const cases = [];
  for (const r of solvedRows) {
    cases.push(normalizeCase({ id: 'solved', passed: Number(r.solved) === 1, score: Number(r.solved) === 1 ? 1 : 0 }));
  }
  for (const tr of traces) {
    const intervened = !!(tr.blocked && String(tr.blocked).trim());
    cases.push(normalizeCase({ id: 'trace', passed: !intervened, steps: stepsFromTools(tr.tool_calls), intervened }));
  }
  return { cases, metrics: computeMetrics(cases) };
}

/** 同套件上一条基线（不含本条） */
function prevBaseline(suite, suiteType, beforeId) {
  return dal.getq(`SELECT * FROM eval_baselines WHERE suite=? AND suite_type=? AND id < ? ORDER BY id DESC LIMIT 1`, [suite, suiteType || 'agent', Number(beforeId) || 1e15]) || null;
}

/** 规范化基线行（补指标对象 + 与上一条对比） */
function normalizeBaseline(row, withDiff = true) {
  const r = row || null;
  if (!r) return null;
  const metrics = {
    total: Number(r.total) || 0, passed: Number(r.passed) || 0,
    intervened: r.intervened != null ? (Number(r.intervened) || 0) : Math.round((Number(r.intervention_rate) || 0) / 100 * (Number(r.total) || 0)),
    successRate: Number(r.success_rate) || 0, avgSteps: Number(r.avg_steps) || 0,
    interventionRate: Number(r.intervention_rate) || 0,
    meetsSuccess: !!r.meets_success, meetsIntervention: !!r.meets_intervention,
  };
  let cases = [];
  try { cases = JSON.parse(r.cases || '[]'); } catch { cases = []; }
  const out = {
    id: Number(r.id) || 0,
    suite: r.suite || '', suite_type: r.suite_type || 'agent',
    ref_id: r.ref_id != null ? Number(r.ref_id) : null,
    label: r.label || '', agent_version: r.agent_version != null ? Number(r.agent_version) : null,
    metrics, created_by: r.created_by || '', created_at: r.created_at || '',
    case_count: cases.length,
  };
  if (withDiff) {
    const prev = prevBaseline(out.suite, out.suite_type, r.id);
    const prevMetrics = prev ? {
      total: Number(prev.total) || 0, passed: Number(prev.passed) || 0,
      intervened: prev.intervened != null ? (Number(prev.intervened) || 0) : Math.round((Number(prev.intervention_rate) || 0) / 100 * (Number(prev.total) || 0)),
      successRate: Number(prev.success_rate) || 0, avgSteps: Number(prev.avg_steps) || 0,
      interventionRate: Number(prev.intervention_rate) || 0,
    } : null;
    out.diff = diffBaseline(metrics, prevMetrics);
    out.verdict = compareVerdict(out.diff);
    out.significance = prevMetrics ? significance(metrics, prevMetrics) : significance(metrics, null);
    out.prev_id = prev ? Number(prev.id) : null;
  }
  return out;
}

/** 创建一条基线（从用例或从既有评测记录）；返回规范化行（含对比） */
function createBaseline(opts) {
  const o = opts || {};
  let cases = Array.isArray(o.cases) ? o.cases.map(normalizeCase) : [];
  if (!cases.length && o.evaluation_id != null) {
    const ev = dal.getq('SELECT * FROM evaluations WHERE id=?', [Number(o.evaluation_id)]);
    if (ev) {
      let detail = [];
      try { detail = JSON.parse(ev.result || '[]'); } catch { detail = []; }
      cases = (Array.isArray(detail) ? detail : []).map(d => normalizeCase({ id: d.query || d.q || '', score: d.score, steps: d.steps, intervened: d.intervened }));
    }
  }
  const metrics = computeMetrics(cases);
  const trimmed = cases.slice(0, MAX_CASES);
  const info = dal.runq(`INSERT INTO eval_baselines
    (suite,suite_type,ref_id,label,agent_version,total,passed,intervened,success_rate,avg_steps,intervention_rate,meets_success,meets_intervention,cases,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    String(o.suite || 'unnamed').slice(0, 120), o.suite_type || 'agent',
    o.ref_id != null ? Number(o.ref_id) : null, String(o.label || '').slice(0, 120),
    o.agent_version != null ? Number(o.agent_version) : null,
    metrics.total, metrics.passed, metrics.intervened, metrics.successRate, metrics.avgSteps, metrics.interventionRate,
    metrics.meetsSuccess ? 1 : 0, metrics.meetsIntervention ? 1 : 0,
    JSON.stringify(trimmed), String(o.created_by || ''), o.created_at || now()]);
  const row = dal.getq('SELECT * FROM eval_baselines WHERE id=?', [info.lastInsertRowid]);
  return normalizeBaseline(row, true);
}

/**
 * 发布时自动采集基线（供 agents.js 发布分支 fire-and-forget 调用）：
 * 优先复用该智能体最近一次 agent 型评测集结果；无评测集则回退真实遥测（messages+chat_traces）。
 * 这样「每次发布都有一条可对比基线」，且不触发额外模型调用。
 */
function autoCaptureOnPublish(agent, version, actor) {
  try {
    const aid = Number(agent?.id);
    if (!Number.isFinite(aid) || aid <= 0) return null;
    const ev = dal.getq(`SELECT * FROM evaluations WHERE agent_id=? AND (type='agent' OR type IS NULL) AND status='done' ORDER BY id DESC LIMIT 1`, [aid]);
    let cases = [];
    if (ev) {
      let detail = [];
      try { detail = JSON.parse(ev.result || '[]'); } catch { detail = []; }
      cases = (Array.isArray(detail) ? detail : []).map(d => normalizeCase({ id: d.q || d.query || '', score: d.score }));
    }
    if (!cases.length) cases = captureFromTelemetry(aid).cases;
    return createBaseline({
      suite: agent.name || ('agent-' + aid), suite_type: 'agent', ref_id: aid,
      label: `${agent.name || ('agent-' + aid)} v${version} 发布`, agent_version: version,
      cases, created_by: actor?.username || '',
    });
  } catch (e) {
    return { error: e.message };
  }
}

/** 基线列表（按 suite 过滤；每条带与同套件上一条的对比） */
function listBaselines({ suite, suite_type, limit = 100 } = {}) {
  const cond = [], args = [];
  if (suite) { cond.push('suite=?'); args.push(String(suite)); }
  if (suite_type) { cond.push('suite_type=?'); args.push(String(suite_type)); }
  const rows = dal.q(`SELECT * FROM eval_baselines ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, [...args, Math.min(Math.max(Number(limit) || 100, 1), 500)]);
  return rows.map(r => normalizeBaseline(r, true));
}

/** 基线详情（含用例明细与对比） */
function baselineDetail(id) {
  const row = dal.getq('SELECT * FROM eval_baselines WHERE id=?', [Number(id)]);
  if (!row) return null;
  const base = normalizeBaseline(row, true);
  let cases = [];
  try { cases = JSON.parse(row.cases || '[]'); } catch { cases = []; }
  base.cases = cases;
  return base;
}

/** 指标总览：各套件最新基线 + 达标状态 */
function overview() {
  const rows = dal.q(`SELECT * FROM eval_baselines ORDER BY id DESC`);
  const latestBySuite = new Map();
  for (const r of rows) {
    const key = `${r.suite_type}::${r.suite}`;
    if (!latestBySuite.has(key)) latestBySuite.set(key, r);
  }
  const suites = [...latestBySuite.values()].map(r => normalizeBaseline(r, true));
  const total = rows.length;
  const meetsSuccess = suites.filter(s => s.metrics.meetsSuccess).length;
  const meetsIntervention = suites.filter(s => s.metrics.meetsIntervention).length;
  const regressions = suites.filter(s => s.verdict && !s.verdict.ok).length;
  return { total, suiteCount: suites.length, meetsSuccess, meetsIntervention, regressions, suites };
}

/** 删除基线（adminOnly 由路由保证） */
function deleteBaseline(id) {
  const row = dal.getq('SELECT id FROM eval_baselines WHERE id=?', [Number(id)]);
  if (!row) return false;
  dal.runq('DELETE FROM eval_baselines WHERE id=?', [Number(id)]);
  return true;
}

/** 智能体发布历史 + 关联基线（展示「每次发布有可对比基线」） */
function releaseBaselines(agentId) {
  const aid = Number(agentId);
  if (!Number.isFinite(aid) || aid <= 0) return [];
  const history = dal.q(`SELECT version, note, published_by, created_at FROM agent_publish_history WHERE agent_id=? ORDER BY version DESC`, [aid]);
  return history.map(h => {
    const b = dal.getq(`SELECT * FROM eval_baselines WHERE suite_type='agent' AND ref_id=? AND agent_version=? ORDER BY id DESC LIMIT 1`, [aid, h.version]);
    return { version: h.version, note: h.note || '', published_by: h.published_by || '', created_at: h.created_at || '', baseline: b ? normalizeBaseline(b, true) : null };
  });
}

/**
 * 多版本趋势：某套件按时间正序的基线序列 + 逐点对比/显著性 + 整体趋势摘要（V2 增强）。
 * 每点含 metrics/diff/verdict/significance；summary 给出首末净变化、回退/显著回退/显著提升计数与方向。
 */
function suiteTrend({ suite, suite_type, limit = 30 } = {}) {
  const name = String(suite || '').trim();
  if (!name) return { suite: '', suite_type: suite_type || null, count: 0, points: [], summary: null };
  const st = suite_type || null;
  const rows = dal.q(`SELECT * FROM eval_baselines WHERE suite=? AND (? IS NULL OR suite_type=?) ORDER BY id ASC LIMIT ?`, [name, st, st, Math.min(Math.max(Number(limit) || 30, 1), 200)]);
  const points = [];
  let prevMetrics = null;
  for (const r of rows) {
    const b = normalizeBaseline(r, false);   // 不额外查 prev，由循环维护
    const diff = diffBaseline(b.metrics, prevMetrics);
    const verdict = compareVerdict(diff);
    const sig = significance(b.metrics, prevMetrics);
    points.push({
      id: b.id, label: b.label || '', agent_version: b.agent_version, created_at: b.created_at,
      metrics: b.metrics, diff, verdict, significance: sig,
      ci: {
        successRate: wilsonInterval(b.metrics.passed, b.metrics.total),
        interventionRate: wilsonInterval(b.metrics.intervened, b.metrics.total),
      },
    });
    prevMetrics = b.metrics;
  }
  const first = points[0] || null, last = points[points.length - 1] || null;
  const net = (key) => (first && last) ? Math.round((last.metrics[key] - first.metrics[key]) * 10) / 10 : 0;
  const netSuccess = net('successRate'), netSteps = net('avgSteps'), netIntervention = net('interventionRate');
  const regressions = points.filter(p => p.verdict && !p.verdict.first && !p.verdict.ok).length;
  const significantRegressions = points.filter(p => p.significance && p.significance.verdict === 'regressed').length;
  const significantImprovements = points.filter(p => p.significance && p.significance.verdict === 'improved').length;
  return {
    suite: name, suite_type: st, count: points.length, points,
    ciLevel: Math.round((1 - ALPHA) * 100),
    summary: {
      first: first ? { id: first.id, label: first.label, successRate: first.metrics.successRate, avgSteps: first.metrics.avgSteps, interventionRate: first.metrics.interventionRate } : null,
      last: last ? { id: last.id, label: last.label, successRate: last.metrics.successRate, avgSteps: last.metrics.avgSteps, interventionRate: last.metrics.interventionRate } : null,
      netSuccess, netSteps, netIntervention, regressions, significantRegressions, significantImprovements,
      direction: netSuccess > 0 ? 'up' : netSuccess < 0 ? 'down' : 'flat',
    },
  };
}

module.exports = {
  PASS_THRESHOLD, SUCCESS_TARGET, INTERVENTION_MAX, SUITE_TEMPLATES, ALPHA, MIN_SAMPLE, EXPECTED_MIN,
  stepsFromTools, normalizeCase, casePassed, computeMetrics, diffBaseline, compareVerdict,
  erf, normalTwoTailP, normInv, wilsonInterval, lfact, logChoose,
  proportionZTest, proportionTest, fisherExact, significance,
  sweBenchLiteToCases, sweBenchLiteTemplate, metricDefinitions,
  captureFromTelemetry, createBaseline, autoCaptureOnPublish, listBaselines, baselineDetail,
  overview, deleteBaseline, releaseBaselines, suiteTrend, normalizeBaseline,
};
