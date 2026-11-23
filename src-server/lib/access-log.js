/**
 * BE-F1（2026-11-23）：轻量请求日志中间件 + 结构化可观测
 *
 * 职责（挂在 tenantContext 之后、API 路由之前）：
 *   1. 每请求生成 requestId（12 位 hex），经 AsyncLocalStorage 传播全链路
 *      （audit.js 拦截器为 op_logs/security_events 自动补 request_id 列）；
 *   2. 响应头回传 X-Request-Id（用户报障可引用）；
 *   3. res finish 时异步落 access_logs 一行（method/path/status/耗时/用户/租户/IP）——
 *      验收「每次请求可检索到 requestId 贯穿的日志链」的骨架。
 *
 * 性能与噪音控制：
 *   - 静态资源在 expressStatic 已被服务、不会走到本中间件（天然豁免）；
 *   - 显式跳过 /api/health（监控探针高频）与 OPTIONS 预检（CORS）；
 *   - INSERT 单行 µs 级 + finish 后异步执行，不阻塞响应。
 */
const crypto = require('crypto');
const { runWithContext } = require('./request-context');

/** 12 位 hex requestId（每请求唯一，日志检索粒度足够且短） */
function newRequestId() { return crypto.randomBytes(6).toString('hex'); }

const SKIP_PATHS = /^\/api\/health|^\/api\/v1\/health/; // 探针减噪

function accessLogMiddleware(db, now) {
  return (req, res, next) => {
    const requestId = newRequestId();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const t0 = Date.now();
    const skip = SKIP_PATHS.test(req.path || '') || req.method === 'OPTIONS';
    res.on('finish', () => {
      if (skip) return;
      // finish 回调在请求上下文内执行（res.on 注册于 run() 作用域）——但 finish 时 req.user
      // /req.tenant 已由后续中间件填充，闭包引用可见
      try {
        const user = (req.user && req.user.username) || '';
        const tenant = (req.tenant && Number.isFinite(Number(req.tenant.id))) ? Number(req.tenant.id) : 1;
        db.prepare(`INSERT INTO access_logs (request_id, method, path, status, duration_ms, username, tenant_id, ip, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(requestId, req.method, String(req.originalUrl || req.url || '').slice(0, 500),
            res.statusCode, Date.now() - t0, user, tenant,
            String(req.ip || '').slice(0, 64), now());
      } catch { /* 落库失败不影响响应（日志骨架尽力而为） */ }
    });
    // 路由处理整体置于请求上下文内（同步 next() + 异步传播——fire-and-forget 后台任务同样可取 requestId）
    runWithContext({ requestId, req }, next);
  };
}

module.exports = { accessLogMiddleware, newRequestId };
