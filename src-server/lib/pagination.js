/**
 * 分页参数容错解析（P1-3 2026-11-04，演进计划表 P1 安全闭环）
 *
 * 背景：notify.js 原实现 `Math.min(+(req.query.limit || 30), 100)`——
 *   `?limit=abc` → +("abc")=NaN → Math.min(NaN,100)=NaN → LIMIT ? 绑定 NaN
 *   → better-sqlite3 抛 "Invalid value" → 全局兜底 500（演进计划表所述问题实锤）；
 *   `?limit=-100` → LIMIT 负数 → SQLite 视为「无限制」全量返回（数据放大/DoS 面）。
 *   各路由原本五种手写解析（knowledge/logs/security/notify）语义不一，本模块统一收口。
 *
 * 语义（对齐演进计划表建议式）：
 *   - parsePagination：page = Math.max(1, parseInt(page) || 1)（非法/0/负 → 1）
 *                      size = Math.min(max, Math.max(1, parseInt(size) || def))（非法 → def，上下限钳制）
 *                      同时派生 offset = (page-1)*size，调用方免重复计算
 *   - parseLimit：limit 风格接口（无页码概念）——非法/0/负 → 默认值（比钳 1 更保守，
 *                 传负数通常意在「取全部」，拒绝回默认比放行 LIMIT 1 更安全）
 *
 * parseInt 语义注：parseInt('abc')=NaN（|| 短路取默认）；parseInt('-100')=-100（truthy，走钳制）；
 * parseInt('3.9')=3（截断）；parseInt('1e3')=1（'e' 处停止，保守可接受）。
 */

/** 页码风格分页解析：返回 { page, size, offset } */
function parsePagination(req, opts = {}) {
  const { pageKey = 'page', sizeKey = 'size', defaultSize = 20, maxSize = 100 } = opts;
  const page = Math.max(1, parseInt(req.query[pageKey], 10) || 1);
  const size = Math.min(maxSize, Math.max(1, parseInt(req.query[sizeKey], 10) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

/** limit 风格解析（单值条数上限）：非法/0/负 → def，上限 max 钳制 */
function parseLimit(req, opts = {}) {
  const { key = 'limit', def = 50, max = 200 } = opts;
  const n = parseInt(req.query[key], 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, n);
}

module.exports = { parsePagination, parseLimit };
