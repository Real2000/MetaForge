/**
 * BE-B5 内部 API 版本化（2026-11-23）
 *
 * 目标：内部 REST API 引入版本前缀 `/api/v1/*`（规范入口）；过渡期与旧 `/api/*` **双挂载**，
 * 旧前缀响应注入弃用告警头（Deprecation / Warning / Link）并记录告警，明确迁移期后下线。
 * OpenAPI 规范只列 v1（见 lib/api-doc.js 采集过滤）。
 *
 * 约定：
 *   - 规范前缀：`/api/v1/<sub>`
 *   - 旧前缀（弃用别名）：`/api/<sub>`
 *   - 非 `/api` 的对外开放契约（`/openapi/*`、`/mcp`）与静态资源不受影响。
 *
 * 兼容关键：双挂载下请求真实路径可能是 `/api/...` 或 `/api/v1/...`，凡既有「基于 /api 前缀」
 * 的判定逻辑（响应契约豁免 lib/response.js、租户公开路径 lib/auth.js、OpenAPI 标签/描述）
 * 一律先经 `stripVersion()` 折叠回 `/api/...`，保证两类前缀行为一致。
 */
const API_PREFIX = '/api/v1';
const LEGACY_PREFIX = '/api';

/** 旧前缀（弃用）路径判定：`/api/*` 但不含 `/api/v1/*` */
function isLegacyApiPath(p) {
  const s = String(p || '');
  if (s === API_PREFIX || s.startsWith(API_PREFIX + '/')) return false;
  return s === LEGACY_PREFIX || s.startsWith(LEGACY_PREFIX + '/');
}

/** 规范前缀路径判定 */
function isCanonicalApiPath(p) {
  const s = String(p || '');
  return s === API_PREFIX || s.startsWith(API_PREFIX + '/');
}

/** 归一化：把 `/api/v1/*` 折叠回 `/api/*`（供既有基于 /api 前缀的判定逻辑复用） */
function stripVersion(p) {
  const s = String(p || '');
  if (s === API_PREFIX) return LEGACY_PREFIX;
  if (s.startsWith(API_PREFIX + '/')) return LEGACY_PREFIX + s.slice(API_PREFIX.length);
  return s;
}

/** 双挂载：同一 router 同时挂到规范前缀与旧前缀（旧前缀=过渡期别名） */
function mountApi(app, sub, router) {
  const s = String(sub == null ? '' : sub).replace(/^\/+/, '');
  app.use(API_PREFIX + '/' + s, router);
  const legacy = LEGACY_PREFIX + '/' + s;
  if (legacy !== API_PREFIX + '/' + s) app.use(legacy, router);
  return app;
}

/**
 * 旧前缀弃用告警中间件：对 `/api/*`（非 v1）响应注入弃用头并记录告警（按「方法+路径」节流）。
 * 头语义参考 RFC 8594（Sunset/Link）+ RFC 7234 Warning。
 */
function deprecationNotice(log = console.warn) {
  const seen = new Set();
  return function apiDeprecation(req, res, next) {
    try {
      const full = String(req.originalUrl || req.url || '').split('?')[0];
      if (isLegacyApiPath(full)) {
        const successor = API_PREFIX + full.slice(LEGACY_PREFIX.length);
        res.setHeader('Deprecation', 'true');
        res.setHeader('Link', `<${successor}>; rel="successor-version"`);
        res.setHeader('Warning', '299 - "Deprecated API prefix /api; use /api/v1"');
        const key = String(req.method).toUpperCase() + ' ' + full;
        if (!seen.has(key) && seen.size < 500) {
          seen.add(key);
          try { log(`[api] 弃用前缀访问 ${key} → 请迁移至 ${successor}`); } catch { /* 告警失败不影响请求 */ }
        }
      }
    } catch { /* 告警不可影响请求 */ }
    next();
  };
}

module.exports = {
  API_PREFIX, LEGACY_PREFIX,
  isLegacyApiPath, isCanonicalApiPath, stripVersion,
  mountApi, deprecationNotice,
};
