/**
 * OPS-2（2026-11-25）：系统健康监控与阈值告警
 *
 * 三层可观测（计划口径「系统/检索/业务」）：
 *   1. 系统层——事件循环延迟（node:perf_hooks monitorEventLoopDelay 滑动 60s 窗口 P50/P95）、
 *      RSS/heap/external 内存、进程句柄数；
 *   2. 业务层——access_logs（BE-F1 骨架行）按窗口聚合：请求量、5xx 错误率、403 权限/租户拒绝数
 *      （RLS/越权防线的应用层投影）、慢请求数与 top 路径、延迟 P50/P95；
 *   3. 检索层——知识检索端点（recall-test / chat 带 kb）请求量与延迟聚合（检索链路的健康投影）。
 *
 * 阈值告警走既有通知体系（notifications 表：定向 admin 用户铃铛可见）+ err_logs 留底。
 * 规则（本轮常量口径，调优后可 config 化）：
 *   ① 事件循环 P95 > 200ms（同步阻塞信号——同步桥/beetter-sqlite3 长查询的主风险）；
 *   ② RSS > 1.5GB（PG 桥大结果集/检索全量的内存风险线）；
 *   ③ 5xx 错误率 > 5% 且窗口请求量 ≥ 50（小样本不判，防误报）；
 *   ④ 慢请求（>3s）> 10 条/窗。
 * 节流：同规则 30 分钟内只发一次告警通知（持续异常不刷屏；恢复不打扰——阈值回落后只是不再触发）。
 *
 * 挂载：startOps（5 分钟独立间隔巡检）；查询端点：GET /api/stats/system-metrics（adminOnly）。
 */
'use strict';
const { monitorEventLoopDelay } = require('perf_hooks');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译）
const { now } = require('../db');

// ---- 阈值常量（OPS-2 首版口径）----
const EVL_P95_ALERT_MS = 200;     // 事件循环延迟告警线
const RSS_ALERT_MB = 1536;        // 1.5GB
const ERR_RATE_ALERT = 0.05;      // 5xx 比例
const ERR_MIN_SAMPLE = 50;        // 小样本豁免线
const SLOW_REQ_MS = 3000;         // 慢请求定义
const SLOW_ALERT_COUNT = 10;      // 慢请求告警线（每窗）
const WINDOW_MIN = 15;            // 业务聚合窗口（分钟）
const ALERT_THROTTLE_MS = 30 * 60000; // 同规则告警节流

const RETRIEVE_PATH_RE = /^\/api\/(knowledge\/recall-test|chat)/; // 检索链路端点投影

let loopH = null;                 // Histogram 句柄（startMetrics 后常驻）
const lastFire = new Map();       // 规则 → 上次告警时间（节流）

/** 启动事件循环延迟采样（幂等；进程生命周期常驻） */
function startMetrics() {
  if (loopH) return;
  loopH = monitorEventLoopDelay({ resolution: 20 });
  loopH.enable();
}

/** 事件循环延迟快照（P50/P95，ms；未启动/未采样时返回 null 占位——NaN 不外泄） */
function eventLoopStats() {
  if (!loopH) return { p50: null, p95: null };
  const p50 = loopH.mean; const p95 = loopH.percentile(95);
  loopH.reset();
  // 演练实证：enable 后首个窗口内无样本时 mean 为 NaN——归一为 null（快照 JSON 干净、告警判定天然短路）
  const f = (v) => (Number.isFinite(v) ? Math.round(v / 1e6 * 100) / 100 : null);
  return { p50: f(p50), p95: f(p95) };
}

/** 系统层快照：事件循环 + 内存 + 句柄（process.memoryUsage/getActiveResourcesInfo 内建，零依赖） */
function systemSnapshot() {
  const m = process.memoryUsage();
  return {
    eventLoop: eventLoopStats(),
    rssMB: Math.round(m.rss / 1048576),
    heapUsedMB: Math.round(m.heapUsed / 1048576),
    externalMB: Math.round(m.external / 1048576),
    handles: (process.getActiveResourcesInfo?.() || []).length,
    uptimeH: Math.round(process.uptime() / 360) / 10,
  };
}

/** 业务/检索层聚合（access_logs 按窗口；SQL 聚合下推防全表读）
 *  dal 出口的 substr/LIKE 均在两方言验证可用（created_at 为 TEXT ISO 契约）。 */
function bizSnapshot() {
  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const base = `FROM access_logs WHERE created_at >= ?`;
  const rows = dal.q(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) err5xx,
      SUM(CASE WHEN status = 403 THEN 1 ELSE 0 END) deny403,
      SUM(CASE WHEN duration_ms > ${SLOW_REQ_MS} THEN 1 ELSE 0 END) slow,
      COALESCE(AVG(duration_ms), 0) avgMs
    ${base}`, [since]);
  const r = rows[0] || { total: 0, err5xx: 0, deny403: 0, slow: 0, avgMs: 0 };
  const byPath = dal.q(`SELECT path, COUNT(*) c, COALESCE(AVG(duration_ms),0) a ${base} AND duration_ms > ${SLOW_REQ_MS}
    GROUP BY path ORDER BY c DESC LIMIT 5`, [since]);
  const retrieval = dal.q(`SELECT COUNT(*) total, COALESCE(AVG(duration_ms),0) avgMs
    ${base} AND (path LIKE '/api/knowledge/recall-test%' OR path LIKE '/api/chat%')`, [since]);
  const rt = retrieval[0] || { total: 0, avgMs: 0 };
  return {
    windowMin: WINDOW_MIN,
    requests: Number(r.total) || 0,
    err5xx: Number(r.err5xx) || 0,
    errRate: r.total ? Math.round((r.err5xx / r.total) * 10000) / 100 : 0, // 百分比
    deny403: Number(r.deny403) || 0,
    slow: Number(r.slow) || 0,
    slowTopPaths: byPath.map((p) => ({ path: p.path, count: p.c, avgMs: Math.round(p.a) })),
    avgMs: Math.round(Number(r.avgMs) || 0),
    retrieval: { requests: Number(rt.total) || 0, avgMs: Math.round(Number(rt.avgMs) || 0) },
  };
}

/** 三层快照合集（/api/stats/system-metrics 数据源） */
function collectSnapshot() {
  return { ts: new Date().toISOString(), system: systemSnapshot(), biz: bizSnapshot() };
}

/** 告警判定与触达（notifications 定向 admin + err_logs 留底；同规则 30min 节流）
 *  返回本次触发的告警数组（演练/端点断言用）。 */
function runAlertCheck(adminUsers) {
  const snap = collectSnapshot();
  const fires = [];
  if (snap.system.eventLoop.p95 != null && snap.system.eventLoop.p95 > EVL_P95_ALERT_MS) {
    fires.push(`事件循环延迟过高：P95 ${snap.system.eventLoop.p95}ms（阈 ${EVL_P95_ALERT_MS}ms，近 30s）`);
  }
  if (snap.system.rssMB > RSS_ALERT_MB) {
    fires.push(`内存超限：RSS ${snap.system.rssMB}MB（阈 ${RSS_ALERT_MB}MB）`);
  }
  if (snap.biz.requests >= ERR_MIN_SAMPLE && snap.biz.errRate > ERR_RATE_ALERT * 100) {
    fires.push(`5xx 错误率过高：${snap.biz.errRate}%（${snap.biz.err5xx}/${snap.biz.requests}，阈 5%）`);
  }
  if (snap.biz.slow > SLOW_ALERT_COUNT) {
    fires.push(`慢请求过多：${snap.biz.slow} 条 >3s（阈 ${SLOW_ALERT_COUNT} 条/${WINDOW_MIN}min）`);
  }
  const nowMs = Date.now();
  const dispatched = [];
  for (const msg of fires) {
    const rule = msg.split('：')[0];
    if (lastFire.has(rule) && nowMs - lastFire.get(rule) < ALERT_THROTTLE_MS) continue; // 节流
    lastFire.set(rule, nowMs);
    // 触达：notifications 定向平台管理员（'*' 全员广播不适合运维告警——量级与受众都不对）
    for (const u of adminUsers || []) {
      try { dal.runq('INSERT INTO notifications (username, title, content, created_at) VALUES (?,?,?,?)',
        [u, '系统健康告警', msg, now()]); } catch { /* 通知写失败不阻断巡检 */ }
    }
    try { dal.insert('err_logs', { source: 'ops-metrics', message: msg, created_at: now() }); } catch { /* 留底失败不阻断 */ }
    dispatched.push(msg);
  }
  return { snapshot: snap, dispatched };
}

module.exports = { startMetrics, collectSnapshot, runAlertCheck, systemSnapshot, bizSnapshot, __constants: { EVL_P95_ALERT_MS, RSS_ALERT_MB, ERR_RATE_ALERT, ERR_MIN_SAMPLE, SLOW_REQ_MS, SLOW_ALERT_COUNT, WINDOW_MIN } };
