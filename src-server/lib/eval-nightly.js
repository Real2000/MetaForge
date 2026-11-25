/**
 * AI-Q2（M8，2026-11-25）：RAGAS 评测夜跑 + 指标趋势 + 前后对比自动报告
 *
 * 承接 AI-Q1：RAGAS 四指标基线（type='rag'）在真实模型环境已归档——本模块把它 CI 化：
 *   1. 夜跑（每日 03:00，避开 03:30 备份组时段）：重跑全部 type='rag' 评测集（数据集存
 *      evaluations.dataset，天然「评测集变更自动重跑」）；
 *   2. 趋势：夜跑结果追加落 evaluations（type='rag'，name 原名保留可比性），前端既有
 *      /api/eval/trend 按时间序天然成趋势线（零前端改动）；
 *   3. 前后对比自动报告：与上一次同库同集的跑分做逐指标 diff，变化超阈值（±5pp）时
 *      notifications 定向平台超管（劣化必报；改善也报——回归双向可见）；
 *   4. 成本护栏：单夜跑用例总数上限 50（D-8 分级预算口径——RAGAS 裁判走中档模型），
 *      超限截断并在报告标注；0 阻断（单集失败跳过不中断）。
 *
 * 挂载：startOps（03:00 daily 判定基于 dayKey 跨日触发窗口，与备份组同构的 30 分钟轮询）。
 */
'use strict';
const { db, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口
const { runRagBaseline } = require('./rag-metrics');

const MAX_CASES_PER_NIGHT = 50;   // 成本护栏（D-8：RAGAS 类中档模型夜跑上限）
const DIFF_ALERT_PP = 5;          // 逐指标变化告警阈值（百分点）
let _lastRunDay = null;           // dayKey 防重入（同日多次轮询只跑一次）

/** 取同库同评测名的上一次跑分（趋势对比基准） */
function prevBaseline(kbId, evalName, excludeId) {
  return dal.getq(
    "SELECT id, metrics, score, created_at FROM evaluations WHERE type='rag' AND kb_id=? AND name=? AND id < ? ORDER BY id DESC LIMIT 1",
    [kbId, evalName, excludeId]);
}

/** 逐指标对比：返回 { verdict, diffs:[{metric, prev, cur, diff}] }；null/空值指标不参与对比
 *  （无答案轮 mean4 落 null——Number(null)=0 经典坑须显式拦截，否则无答案轮必误报 ±90pp） */
function diffMetrics(prevMetrics, curMetrics) {
  const KEYS = ['context_precision', 'context_recall', 'answer_relevancy', 'faithfulness'];
  const num = (m, k) => (m && m[k] != null && m[k] !== '' ? Number(m[k]) : NaN);
  const diffs = [];
  let degraded = false;
  for (const k of KEYS) {
    const p = num(prevMetrics, k);
    const c = num(curMetrics, k);
    if (!Number.isFinite(p) || !Number.isFinite(c)) continue; // 任一侧不可评（如无答案轮）跳过
    const d = Math.round((c - p) * 100); // pp
    if (Math.abs(d) >= DIFF_ALERT_PP) diffs.push({ metric: k, prev: p, cur: c, diff_pp: d });
    if (d <= -DIFF_ALERT_PP) degraded = true;
  }
  return { verdict: degraded ? 'degraded' : (diffs.length ? 'improved' : 'stable'), diffs };
}

/** 通知平台超管（与 OPS-2 metrics 同一触达面） */
function notifyAdmins(title, content) {
  try {
    const admins = dal.q('SELECT username FROM users WHERE platform_admin=1');
    for (const u of admins) {
      dal.runq('INSERT INTO notifications (username, title, content, created_at) VALUES (?,?,?,?)',
        [u.username, title, String(content).slice(0, 500), now()]);
    }
  } catch { /* 通知失败不阻断（调度循环容错） */ }
}

/** 夜跑主体：全部 type='rag' 评测集重跑 + 对比报告（幂等：dayKey 防重入） */
async function runRagNightly() {
  const today = (() => { try { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); } catch { return ''; } })();
  if (_lastRunDay === today) return { ok: true, skipped: true, msg: '今日已跑' };
  _lastRunDay = today;
  // 集选取幂等口径：每 (kb_id, name) 只取最新一行——runRagBaseline 每次产物都带 dataset 快照，
  // 若不按名去重，夜跑产物行次晚也被当评测集复制重跑，集数每夜翻倍（指数雪崩，数周内击穿护栏）。
  // 取最新行同时保证「用户重跑评测（改 dataset）后夜跑自动跟最新集」。
  const evals = dal.q(
    "SELECT e.id, e.kb_id, e.name, e.dataset FROM evaluations e JOIN (SELECT MAX(id) mid FROM evaluations WHERE type='rag' GROUP BY kb_id, name) g ON e.id = g.mid ORDER BY e.id");
  if (!evals.length) return { ok: true, skipped: true, msg: '无 rag 评测集' };
  let casesBudget = MAX_CASES_PER_NIGHT;
  let runCount = 0, degradedCount = 0, truncated = false;
  for (const ev of evals) {
    if (casesBudget <= 0) { truncated = true; break; }
    let cases = [];
    try { cases = JSON.parse(ev.dataset || '[]'); } catch { continue; /* 数据集损坏跳过 */ }
    const slice = cases.slice(0, casesBudget);
    if (!slice.length) continue;
    if (slice.length < cases.length) truncated = true; // 集内截断也要标注——末集用尽预算时循环不再进入 budget<=0 分支，漏标会让报告低估护栏影响
    casesBudget -= slice.length;
    try {
      // name 保持原名（趋势可比）；runner 内部 INSERT 新行 → 趋势天然追加
      const r = await runRagBaseline({ kbId: ev.kb_id, cases: slice, name: ev.name, topN: 5 });
      if (!r || !r.ok) continue;
      runCount++;
      const prev = prevBaseline(ev.kb_id, ev.name, r.id);
      if (prev) {
        let prevMetrics = null;
        try { prevMetrics = JSON.parse(prev.metrics || '{}'); } catch { /* 旧行 metrics 损坏按无基准 */ }
        const { verdict, diffs } = diffMetrics(prevMetrics, r.metrics);
        if (verdict === 'degraded') {
          degradedCount++;
          notifyAdmins('RAG 质量回归告警',
            `评测「${ev.name}」指标较上次回归：${diffs.map(d => `${d.metric} ${d.prev}→${d.cur}（${d.diff_pp}pp）`).join('；')}（${today} 夜跑自动报告）`);
        } else if (verdict === 'improved') {
          notifyAdmins('RAG 质量改善',
            `评测「${ev.name}」指标改善：${diffs.map(d => `${d.metric} ${d.prev}→${d.cur}（+${d.diff_pp}pp）`).join('；')}（${today} 夜跑自动报告）`);
        }
      }
    } catch (e) {
      console.error(`[eval-nightly] 评测集#${ev.id}「${ev.name}」夜跑失败：`, e.message);
    }
  }
  const msg = `RAGAS 夜跑完成：${runCount}/${evals.length} 集${truncated ? '（成本护栏截断）' : ''}，指标回归 ${degradedCount} 集`;
  console.log(`[ops][eval-nightly] ${msg}`);
  try { dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '评价夜跑', msg, '', now()]); } catch { /* */ }
  return { ok: true, runCount, degradedCount, truncated };
}

module.exports = { runRagNightly, diffMetrics, prevBaseline, __constants: { MAX_CASES_PER_NIGHT, DIFF_ALERT_PP }, __resetDay: () => { _lastRunDay = null; } };
