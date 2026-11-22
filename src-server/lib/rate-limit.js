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

/**
 * 受信代理跳数解析（SEC-01 2026-11-22 安全止血）。
 * 背景：原 clientIp 无条件信任 X-Forwarded-For 首个值——攻击者可伪造 XFF 头，
 * 使每次请求落在新 IP 桶，从而绕过登录/分享/开放 API 的按 IP 限流与失败锁定（爆破绕过）。
 * 规则（默认最保守）：
 *   - 未配置 AGENT_TRUST_PROXY（或 =0/false/off/no）→ 不信任任何代理，直接用 socket.remoteAddress，忽略 XFF；
 *   - 配置为正整数 N → 信任「最靠近服务的 N 跳」代理，取 XFF 中第 (len-N) 个（左起，即真实客户端）；
 *     链路长度不足 N 跳时不予采信，回落 socket.remoteAddress；
 *   - 其他非空真值（如 "true"）→ 视为信任 1 跳。
 */
function trustHops() {
  const v = process.env.AGENT_TRUST_PROXY;
  if (v == null || v === '' || v === '0' || /^(false|off|no)$/i.test(String(v).trim())) return 0;
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return 1;
}

/** Express 等价设置值：trust proxy 期望 number | boolean（false=直连） */
function trustProxySetting() {
  const h = trustHops();
  return h > 0 ? h : false;
}

/** 客户端 IP 提取（仅在配置受信代理后按跳数采信 XFF，否则以 TCP 源地址为准） */
function clientIp(req) {
  const hops = trustHops();
  if (hops > 0) {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      const idx = parts.length - hops;
      if (idx >= 0 && parts[idx]) return parts[idx];
    }
  }
  return (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

module.exports = { createLimiter, clientIp, trustHops, trustProxySetting };
