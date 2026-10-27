/**
 * 限流中间件（2026-10-20 P0 安全加固）
 * 内存滑动窗口实现，零依赖。两个用途：
 *  1. shareRoutes —— 分享页免登录对话按 IP 限流（防脚本刷爆网关 Token 计费）
 *  2. apikeyLimits —— openapi 密钥自鉴权按 Key 限流（可配每日额度）
 * 超限返回 429 + 友好中文提示；窗口自动清理防内存膨胀。
 */
const buckets = new Map(); // key -> { count, resetAt }

function cleanup() {
  const t = Date.now();
  if (buckets.size < 4096) return; // 小规模不清理
  for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
}

/** 创建限流器。opts: { name, windowMs, max, keyFn(req)→string, msg } */
function createLimiter(opts) {
  const { name, windowMs = 60000, max = 30, keyFn, msg } = opts;
  return function limit(req, res, next) {
    cleanup();
    const k = name + ':' + keyFn(req);
    const t = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(k, b);
    }
    b.count++;
    // 响应头带剩余额度（便于前端/调用方感知）
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) {
      const waitSec = Math.ceil((b.resetAt - t) / 1000);
      res.setHeader('Retry-After', waitSec);
      const friendly = msg || `操作太频繁，请 ${waitSec} 秒后再试`;
      if (req.path.startsWith('/openapi') || req.headers.accept?.includes('application/json')) {
        return res.status(429).json({ code: 429, msg: friendly, retry_after: waitSec });
      }
      return res.status(429).json({ code: 429, msg: friendly, retry_after: waitSec });
    }
    next();
  };
}

/** 客户端 IP 提取（代理场景取 X-Forwarded-For 首个） */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { createLimiter, clientIp };
