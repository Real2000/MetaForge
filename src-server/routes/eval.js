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
 *
 * 读接口要求 JWT 认证（router.use(auth)）；写/删基线为管理员操作（adminOnly）。
 * 基线是发布治理数据（系统级可比基线），不按用户隔离。
 */
const express = require('express');
const { db } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const evalSuite = require('../lib/eval-suite');

const router = express.Router();
router.use(auth);

/* ============================ 查询 ============================ */

/** 指标口径 + 目标线 + 套件模板 */
router.get('/config', (req, res) => {
  res.json({ code: 0, data: { ...evalSuite.metricDefinitions(), templates: evalSuite.SUITE_TEMPLATES } });
});

/** 可用套件：内置模板 + 既有评测集（evaluations） */
router.get('/suites', (req, res) => {
  const suites = evalSuite.SUITE_TEMPLATES.map(t => ({ ...t, builtin: true }));
  const evals = db.prepare(`SELECT e.id, e.name, e.type, e.kb_id, e.agent_id, a.name AS agent_name
    FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id ORDER BY e.id DESC LIMIT 200`).all();
  for (const ev of evals) {
    suites.push({
      name: ev.name, suite_type: ev.type === 'kb' ? 'kb' : 'agent', evaluation_id: ev.id,
      ref_id: ev.type === 'kb' ? ev.kb_id : ev.agent_id, builtin: false,
      desc: ev.type === 'kb' ? '知识库评测集（召回回归）' : `智能体测评集（${ev.agent_name || '智能体'}）`,
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

/** 智能体发布历史 + 每次发布关联的基线（可对比基线视图） */
router.get('/releases/:agentId', (req, res) => {
  res.json({ code: 0, data: evalSuite.releaseBaselines(req.params.agentId) });
});

module.exports = router;
