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
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '采集评测基线', `${row.suite}：成功率 ${row.metrics.successRate}% / 步数 ${row.metrics.avgSteps} / 干预率 ${row.metrics.interventionRate}%`, req.ip, require('../db').now()]);
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
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, 'SWE-bench-lite runner 执行', `${instances.length} 实例：成功率 ${out.metrics.successRate}% / 步数 ${out.metrics.avgSteps} / 干预率 ${out.metrics.interventionRate}%`, req.ip, require('../db').now()]);
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

// ==================== AI-12 提示词多版本效果对比（2026-11-23） ====================
// 复用 agent_prompt_versions（保存即快照）+ 既有 agent 评测跑分口径（chatOnce + 期望关键词命中比例）：
// 同一评测集（type='agent'）对 N 个提示词版本「离线跑分」——system prompt 临时替换为版本快照
//（不落 agents 表，零侵入），产出成功率/质量指标对比报告；先离线对比，不强制流量灰度（计划表口径）。
const { chatOnce } = require('../lib/llm');
const { canView } = require('../lib/agent-access');

/** 归属防线：智能体可见性 + 评测集归属（须为该智能体的 type='agent' 评测集） */
function evalAgentGuard(req, res, agentId, evalId) {
  const agent = dal.getq('SELECT * FROM agents WHERE id=?', [agentId]);
  if (!agent) { res.json({ code: 404, msg: '智能体不存在' }); return null; }
  if (!canView(agent, req.user)) { res.json({ code: 403, msg: '无权查看该智能体' }); return null; }
  const ev = dal.getq(`SELECT * FROM evaluations WHERE id=? AND agent_id=?`, [evalId, agentId]);
  if (!ev) { res.json({ code: 404, msg: '评测集不存在或不属于该智能体' }); return null; }
  return { agent, ev };
}

// 版本列表（对比入口数据源：含当前在线 prompt 作对照行 version=0）
router.get('/prompt-versions/:agentId', async (req, res) => {
  const agent = dal.getq('SELECT * FROM agents WHERE id=?', [req.params.agentId]);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(agent, req.user)) return res.json({ code: 403, msg: '无权查看该智能体' });
  const rows = dal.q(`SELECT id, version, prompt, user_prompt, edited_by, note, created_at
    FROM agent_prompt_versions WHERE agent_id=? ORDER BY version DESC LIMIT 50`, [req.params.agentId]);
  res.json({ code: 0, data: {
    current: { version: 0, prompt: agent.prompt || '', note: '当前在线版本（未保存为快照）', created_at: agent.updated_at || '' },
    versions: rows,
  } });
});

// 离线对比跑分：同一评测集 × N 个提示词版本 → 对比报告（落库 prompt_compare_reports）
router.post('/prompt-compare', async (req, res) => {
  const { agent_id, evaluation_id, version_ids } = req.body || {};
  const g = evalAgentGuard(req, res, Number(agent_id), Number(evaluation_id));
  if (!g) return;
  const { agent, ev } = g;
  if ((ev.type || 'agent') !== 'agent') return res.json({ code: 400, msg: '仅支持智能体类型评测集（type=agent）' });
  let items = [];
  try { items = JSON.parse(ev.dataset || '[]'); } catch { items = []; }
  if (!Array.isArray(items) || !items.length) return res.json({ code: 400, msg: '该评测集 dataset 为空或损坏' });
  items = items.slice(0, 20); // 与既有评测 runner 同一截断口径（防超长跑分阻塞）
  // 参评版本：显式 version_ids（去重截 8 个）或默认「当前在线 + 最近 3 个快照」
  // 语义统一（2026-11-23 修正）：任何对比报告都含「当前在线版本」对照基线（version=0）——
  // 用户最核心的对比场景是「历史版本 vs 现在线上」，显式指定 version_ids 时同样并入基线
  // （首轮测试实锤：指定单版本曾因参评数 1 触发「至少两版本」400，与「+当前在线共 2 参评」验收意图相悖）
  let versions;
  const currentRow = () => ({ version: 0, prompt: agent.prompt || '', user_prompt: '', note: '当前在线版本', edited_by: '', created_at: '' });
  if (Array.isArray(version_ids) && version_ids.length) {
    const ids = [...new Set(version_ids.map(Number).filter(Number.isFinite))].slice(0, 8);
    const picked = dal.q(`SELECT version, prompt, user_prompt, note, edited_by, created_at FROM agent_prompt_versions WHERE agent_id=? AND version IN (${ids.map(() => '?').join(',')}) ORDER BY version DESC`, [agent.id, ...ids]);
    if (!picked.length) return res.json({ code: 404, msg: '指定的提示词版本不存在' });
    versions = [currentRow(), ...picked];
  } else {
    versions = [currentRow()]
      .concat(dal.q(`SELECT version, prompt, user_prompt, note, edited_by, created_at FROM agent_prompt_versions WHERE agent_id=? ORDER BY version DESC LIMIT 3`, [agent.id]));
  }
  if (versions.length < 2) return res.json({ code: 400, msg: '至少需要两个版本才能对比（当前在线 + 至少一个快照）' });
  // 逐版本离线跑分（system prompt = 版本快照；与 V1.3 评测 runner 同口径：关键词命中比例）
  const scored = [];
  for (const v of versions) {
    const cases = [];
    let total = 0;
    for (const it of items) {
      const r = await chatOnce([
        { role: 'system', content: String(v.prompt || '你是智能助手。') },
        { role: 'user', content: String(it.q || '') },
      ], { model: agent.model, temperature: 0.2, agentName: agent.name });
      const got = (r.full || '').slice(0, 500);
      const keys = String(it.expect || '').split(/[，,、\s]+/).filter(Boolean);
      const hit = keys.filter(k => got.includes(k)).length;
      const score = keys.length ? hit / keys.length : 1;
      total += score;
      cases.push({ q: it.q, expect: it.expect, got, score: +score.toFixed(2), hit: keys.length ? hit : 1, keys: keys.length });
    }
    const fullHit = cases.filter(c => c.score >= 1).length; // 成功率口径：期望关键词全命中的条数占比
    scored.push({
      version: v.version, note: v.note || '', edited_by: v.edited_by || '', created_at: v.created_at || '',
      prompt_head: String(v.prompt || '').slice(0, 120),
      score: Math.round((total / cases.length) * 100),          // 质量指标：综合得分（命中比例均值）
      success_rate: Math.round((fullHit / cases.length) * 100),  // 成功率：全命中条目占比
      cases,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const report = {
    agent_id: agent.id, agent_name: agent.name, evaluation_id: ev.id, evaluation_name: ev.name,
    case_count: items.length, winner: scored[0].version, generated_at: new Date().toISOString(),
    versions: scored,
  };
  const info = dal.runq(`INSERT INTO prompt_compare_reports (agent_id, evaluation_id, report, created_at) VALUES (?,?,?,datetime('now','localtime'))`,
    [agent.id, ev.id, JSON.stringify(report)]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)',
    [req.user.username, '提示词版本对比', `${agent.name} × ${ev.name}：${scored.length} 版本，最优 v${scored[0].version}（${scored[0].score} 分）`, req.ip, require('../db').now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid, report } });
});

// 对比报告导出（验收：报告可导出，含成功率/质量指标）——json 全量 / csv 逐版本汇总
router.get('/prompt-compare/:id/export', (req, res) => {
  const row = dal.getq('SELECT * FROM prompt_compare_reports WHERE id=?', [req.params.id]);
  if (!row) return res.json({ code: 404, msg: '对比报告不存在' });
  let report = {};
  try { report = JSON.parse(row.report || '{}'); } catch { report = {}; }
  if ((req.query.format || 'json') === 'csv') {
    // Excel 兼容 CSV：BOM 头 + 逐版本汇总行 + 逐条明细（成功率/综合得分并列，便于筛选排序）
    const escCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [[
      '版本', '备注', '操作者', '快照时间', '综合得分(质量指标)', '成功率(%)', '用例数',
    ].map(escCell).join(',')];
    for (const v of report.versions || []) {
      lines.push([`v${v.version}`, v.note, v.edited_by, v.created_at, v.score, v.success_rate, (v.cases || []).length].map(escCell).join(','));
    }
    lines.push('');
    lines.push(['用例序号', '查询', '期望关键词', '版本', '得分', '回答摘录'].map(escCell).join(','));
    (report.versions || []).forEach(v => (v.cases || []).forEach((c, i) => {
      lines.push([i + 1, c.q, c.expect, `v${v.version}`, c.score, c.got].map(escCell).join(','));
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prompt-compare-${req.params.id}.csv"`);
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.setHeader('Content-Disposition', `attachment; filename="prompt-compare-${req.params.id}.json"`);
  res.json({ code: 0, exported_at: require('../db').now(), report });
});

module.exports = router;
