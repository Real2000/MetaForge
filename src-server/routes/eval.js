/**
 * D3-4 评测体系 V1 API（2026-11-21）
 *
 * 覆盖：
 *  - 指标口径：/config（目标线 + 三项指标定义 + 内置套件模板）
 *  - 套件清单：/suites（内置基准 + 既有 evaluations 智能体/知识库评测集）
 *  - SWE-bench-lite：/template/swe-bench-lite（结构/样例）、POST /import/swe-bench-lite（实例→内部用例）
 *  - 发布基线：POST /baselines（采集/登记一条基线）、GET /baselines、GET /baselines/:id、
 *              DELETE /baselines/:id
 *  - 指标总览：/metrics；发布历史关联基线：/releases/:agentId
 *  - 多版本趋势（V2）：/trend（套件按版本序列 + 逐点回退/显著性 + 趋势摘要）
 *  - runner 接入（V2）：GET /runner/probe、POST /runner/swe-bench-lite（外部 harness 适配器）
 *
 * 读接口要求 JWT 认证（router.use(auth)）；写/删基线为管理员操作（adminOnly）。
 * 基线是发布治理数据（系统级可比基线），不按用户隔离。
 */
const express = require('express');
const { db } = require('../db');
const dal = require('../lib/dal'); // BE-C1：新增强制统一出口（方言翻译 + 租户边界注入）
const { auth, adminOnly } = require('../lib/auth');
const evalSuite = require('../lib/eval-suite');
const swebenchRunner = require('../lib/swebench-runner');
const ragMetrics = require('../lib/rag-metrics'); // M4 AI-03：RAG 四指标 + 质量基线 runner

const router = express.Router();
router.use(auth);

/* ============================ 查询 ============================ */

/** 指标口径 + 目标线 + 套件模板 */
router.get('/config', (req, res) => {
  // M4 AI-03：附 RAG 四指标定义（context_precision / context_recall / answer_relevancy / faithfulness）
  res.json({ code: 0, data: { ...evalSuite.metricDefinitions(), ragMetrics: ragMetrics.RAG_METRIC_DEFS, templates: evalSuite.SUITE_TEMPLATES } });
});

/** 可用套件：内置模板 + 既有评测集（evaluations；type='rag' 为 M4 AI-03 RAG 质量基线） */
router.get('/suites', (req, res) => {
  const suites = evalSuite.SUITE_TEMPLATES.map(t => ({ ...t, builtin: true }));
  // AI-03（2026-11-23）：附带 score/created_at/metrics——RAG 基线历史可直接展示四指标聚合
  // BE-C1（2026-11-23）：走 dal 统一出口，evaluations/agents 为租户域表，统一注入租户边界（单租户零回归）
  const tw = dal.tenantWhere('e', dal.tenantScope(req));
  const evals = dal.q(`SELECT e.id, e.name, e.type, e.kb_id, e.agent_id, e.score, e.created_at, e.metrics, a.name AS agent_name
    FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id WHERE 1=1${tw.sqlStr} ORDER BY e.id DESC LIMIT 200`, tw.args);
  for (const ev of evals) {
    let metrics = null;
    try { metrics = JSON.parse(ev.metrics || 'null'); } catch { metrics = null; }
    suites.push({
      name: ev.name,
      suite_type: ev.type === 'kb' ? 'kb' : ev.type === 'rag' ? 'rag' : 'agent',
      evaluation_id: ev.id,
      ref_id: ev.type === 'kb' || ev.type === 'rag' ? ev.kb_id : ev.agent_id, builtin: false,
      desc: ev.type === 'kb' ? '知识库评测集（召回回归）' : ev.type === 'rag' ? 'RAG 质量基线（检索→生成→RAGAS 四指标）' : `智能体测评集（${ev.agent_name || '智能体'}）`,
      score: ev.score ?? null, created_at: ev.created_at, metrics,
    });
  }
  res.json({ code: 0, data: { suites } });
});

/** SWE-bench-lite 导入模板 */
router.get('/template/swe-bench-lite', (req, res) => {
  res.json({ code: 0, data: evalSuite.sweBenchLiteTemplate() });
});

/** 导入 SWE-bench-lite 实例 → 内部用例（预览，不落库） */
router.post('/import/swe-bench-lite', (req, res) => {
  const rows = (req.body || {}).instances;
  if (!Array.isArray(rows) || !rows.length) return res.json({ code: 400, msg: '请提供 instances 数组（SWE-bench-lite 实例）' });
  const cases = evalSuite.sweBenchLiteToCases(rows);
  res.json({ code: 0, data: { cases, metrics: evalSuite.computeMetrics(cases) } });
});

/* ============================ 基线 ============================ */

/**
 * 采集/登记一条发布基线。
 * body: { suite, suite_type, ref_id?, label?, agent_version?, cases?[], evaluation_id? , agent_id? }
 *   - cases 提供 → 直接按用例计分；否则 evaluation_id → 读该评测集结果；
 *   - agent_id 提供且无 cases/evaluation_id → 从真实遥测（messages+chat_traces）聚合。
 */
router.post('/baselines', adminOnly, (req, res) => {
  const b = req.body || {};
  const suite = String(b.suite || '').trim();
  if (!suite) return res.json({ code: 400, msg: '请填写套件名 suite' });
  let cases = Array.isArray(b.cases) ? b.cases : null;
  if (!cases && b.agent_id != null) {
    cases = evalSuite.captureFromTelemetry(Number(b.agent_id)).cases;
  }
  if (!cases && b.evaluation_id != null) cases = []; // 交由 createBaseline 读评测记录
  if (!cases && b.evaluation_id == null) return res.json({ code: 400, msg: '请提供 cases[]、agent_id 或 evaluation_id 之一' });
  const row = evalSuite.createBaseline({
    suite, suite_type: b.suite_type || 'agent', ref_id: b.ref_id != null ? b.ref_id : (b.agent_id || b.evaluation_id),
    label: b.label || '', agent_version: b.agent_version != null ? b.agent_version : null,
    cases: cases || undefined, evaluation_id: b.evaluation_id != null ? b.evaluation_id : undefined,
    created_by: req.user.username,
  });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '采集评测基线', `${row.suite}：成功率 ${row.metrics.successRate}% / 步数 ${row.metrics.avgSteps} / 干预率 ${row.metrics.interventionRate}%`, req.ip, require('../db').now());
  res.json({ code: 0, data: row });
});

/** 基线列表（带与同套件上一条的对比） */
router.get('/baselines', (req, res) => {
  const data = evalSuite.listBaselines({
    suite: req.query.suite, suite_type: req.query.suite_type, limit: req.query.limit,
  });
  res.json({ code: 0, data });
});

/** 基线详情（用例明细 + 对比） */
router.get('/baselines/:id', (req, res) => {
  const row = evalSuite.baselineDetail(req.params.id);
  if (!row) return res.json({ code: 404, msg: '基线不存在' });
  res.json({ code: 0, data: row });
});

/** 删除基线（管理员） */
router.delete('/baselines/:id', adminOnly, (req, res) => {
  if (!evalSuite.deleteBaseline(req.params.id)) return res.json({ code: 404, msg: '基线不存在' });
  res.json({ code: 0, msg: '已删除' });
});

/* ============================ 指标 / 发布关联 ============================ */

/** 指标总览（各套件最新基线达标状态 + 回退数） */
router.get('/metrics', (req, res) => {
  res.json({ code: 0, data: evalSuite.overview() });
});

/** 多版本趋势（某套件按版本序列的三指标走势 + 逐点回退/显著性 + 趋势摘要） */
router.get('/trend', (req, res) => {
  const suite = String(req.query.suite || '').trim();
  if (!suite) return res.json({ code: 400, msg: '请提供 suite' });
  res.json({ code: 0, data: evalSuite.suiteTrend({ suite, suite_type: req.query.suite_type, limit: req.query.limit }) });
});

/* ==================== SWE-bench-lite 真实 runner 接入（适配器） ==================== */

/** 探测是否已接入外部 runner（零依赖：平台不捆绑 harness） */
router.get('/runner/probe', adminOnly, (req, res) => {
  res.json({ code: 0, data: swebenchRunner.runnerProbe() });
});

/**
 * 用外部 runner 执行 SWE-bench-lite（管理员）。
 * body: { instances:[...], command?, timeoutMs?, suite?, suite_type?, label?, agent_version?, baseline? }
 *   - 未提供 command 时用环境变量 SWEBENCH_RUNNER_CMD；
 *   - baseline=true（默认）时把执行结果落为一条发布基线，便于与历史对比。
 */
router.post('/runner/swe-bench-lite', adminOnly, async (req, res) => {
  const b = req.body || {};
  const instances = Array.isArray(b.instances) ? b.instances : [];
  if (!instances.length) return res.json({ code: 400, msg: '请提供 instances 数组（SWE-bench-lite 实例）' });
  const out = await swebenchRunner.runSweBenchLite({ instances, command: b.command, timeoutMs: b.timeoutMs });
  if (!out.ok) return res.json({ code: out.configured ? 500 : 400, msg: out.error, data: { configured: out.configured, command: out.command } });
  let baseline = null;
  if (b.baseline !== false) {
    baseline = evalSuite.createBaseline({
      suite: String(b.suite || 'swe-bench-lite').slice(0, 120), suite_type: b.suite_type || 'builtin',
      ref_id: b.ref_id != null ? b.ref_id : null, label: b.label || ('runner 执行 ' + new Date().toISOString().slice(0, 16)),
      agent_version: b.agent_version != null ? b.agent_version : null,
      cases: out.cases, created_by: req.user.username,
    });
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, 'SWE-bench-lite runner 执行', `${instances.length} 实例：成功率 ${out.metrics.successRate}% / 步数 ${out.metrics.avgSteps} / 干预率 ${out.metrics.interventionRate}%`, req.ip, require('../db').now());
  res.json({ code: 0, data: { predictions: out.predictions, cases: out.cases, metrics: out.metrics, baseline, command: out.command } });
});

/** 智能体发布历史 + 每次发布关联的基线（可对比基线视图） */
router.get('/releases/:agentId', (req, res) => {
  res.json({ code: 0, data: evalSuite.releaseBaselines(req.params.agentId) });
});

/**
 * M4 AI-03（2026-11-23）：RAG 质量基线——逐用例走完整链路（检索 → 生成 → RAGAS 四指标），
 * 聚合结果落 evaluations（type='rag'，metrics 列存聚合 JSON）——同一评测集重跑即得「同一 KB
 * 变更前后」的量化对比；检索侧附带 Top-1/hit@K/召回@K/MRR/NDCG（用例带 expect_terms 时）。
 * body: { kb_id, cases?[{query, expect_terms?}], evaluation_id?(复用 kb 评测集 dataset), name?, top_n?, model?, rerank_enabled? }
 * 仅管理员；无模型供应商时答案侧四指标计 null（可评用例数在 metrics.evaluated_answers 中体现）。
 */
router.post('/rag-baseline', adminOnly, async (req, res) => {
  const b = req.body || {};
  const kbId = Number(b.kb_id);
  if (!Number.isInteger(kbId) || kbId <= 0) return res.json({ code: 400, msg: '请提供 kb_id（知识库）' });
  let cases = Array.isArray(b.cases) && b.cases.length ? b.cases : null;
  let evRef = null;
  if (!cases && b.evaluation_id != null) {
    // BE-C1：走 dal 统一出口 + 租户边界——引用的评测集必须属于当前租户，防止跨租户借用 dataset
    const tw = dal.tenantWhere('', dal.tenantScope(req));
    evRef = dal.getq(`SELECT * FROM evaluations WHERE id=? AND type='kb' AND kb_id=?${tw.sqlStr}`, [Number(b.evaluation_id), kbId, ...tw.args]);
    if (!evRef) return res.json({ code: 404, msg: 'evaluation_id 对应的知识库评测集不存在（须为该库的 type=kb 评测集）' });
    try { cases = JSON.parse(evRef.dataset || '[]'); } catch { cases = null; }
    if (!Array.isArray(cases) || !cases.length) return res.json({ code: 400, msg: '该评测集 dataset 为空或损坏' });
  }
  if (!cases) return res.json({ code: 400, msg: '请提供 cases[] 或 evaluation_id（复用该库的知识库评测集）' });
  const topN = (Number.isFinite(+b.top_n) && +b.top_n > 0) ? Math.min(20, Math.floor(+b.top_n)) : 5;
  const out = await ragMetrics.runRagBaseline({
    kbId, cases, name: b.name, topN,
    opts: { model: b.model, rerankEnabled: b.rerank_enabled },
  });
  if (!out.ok) return res.json({ code: 400, msg: out.msg });
  const m = out.metrics;
  const fmt = v => (v == null ? '—' : (+v).toFixed(2));
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)',
    [req.user.username, 'RAG 质量基线采集', `${out.name}：${out.cases} 用例（可评答案 ${m.evaluated_answers}）——上下文精确率 ${fmt(m.context_precision)} / 召回率 ${fmt(m.context_recall)} / 答案相关性 ${fmt(m.answer_relevancy)} / 忠实度 ${fmt(m.faithfulness)}`, req.ip, require('../db').now()]);
  res.json({ code: 0, data: { id: out.id, name: out.name, cases: out.cases, metrics: out.metrics, score: out.score, detail: out.detail } });
});

module.exports = router;
