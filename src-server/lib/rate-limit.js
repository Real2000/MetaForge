/**
 * 限流中间件（2026-10-20 P0 安全加固）
 * 内存滑动窗口实现，零依赖。两个用途：
 *  1. shareRoutes —— 分享页免登录对话按 IP 限流（防脚本刷爆网关 Token 计费）
 *  2. apikeyLimits —— openapi 密钥自鉴权按 Key 限流（可配每日额度）
 * 超限返回 429 + 友好中文提示；窗口自动清理防内存膨胀。
 *
 * BE-B3（M2 批次3，2026-11-22）：新增共享存储（SQLite）限流与每 Key 日/月配额守卫——
 *   - createLimiter({ shared:true })：计数落库（rate_limit_counters），多实例同库不放大额度；
 *   - createQuotaGuard()：按 Key 的日/月配额（agent_api_keys.quota_daily/quota_monthly），
 *     原子「自增后判超」——多实例下放行总次数恒等于配置额度；超限 429 + Retry-After。
 */
const buckets = new Map(); // key -> { count, resetAt }

function cleanup() {
  const t = Date.now();
  if (buckets.size < 4096) return; // 小规模不清理
  for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
}

/* ---------- BE-B3：共享存储（SQLite）计数原语 ---------- */

/** 延迟加载 DAL（避免模块加载期提前初始化 db；DAL 已内置方言出口） */
function dal() { return require('./dal'); }

/** 原子「自增并返回新计数」——单条 UPSERT..RETURNING，多实例写串行化后计数精确 */
function dbIncr(bucketKey, resetAt) {
  const d = dal();
  const ts = new Date().toISOString();
  const row = d.getq(
    `INSERT INTO rate_limit_counters (bucket_key, count, reset_at, updated_at) VALUES (?, 1, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
     RETURNING count, reset_at`,
    [bucketKey, resetAt, ts],
  );
  maybePurgeCounters();
  return row ? { count: row.count, resetAt: row.reset_at } : { count: 1, resetAt };
}

/** 只读当前计数（不递增） */
function dbPeek(bucketKey) {
  const row = dal().getq('SELECT count, reset_at FROM rate_limit_counters WHERE bucket_key=?', [bucketKey]);
  return row ? { count: row.count, resetAt: row.reset_at } : null;
}

let _lastPurge = 0;
/** 低概率清理过期计数行（防表无限增长） */
function maybePurgeCounters() {
  const now = Date.now();
  if (now - _lastPurge < 60000) return;
  _lastPurge = now;
  try { dal().runq('DELETE FROM rate_limit_counters WHERE reset_at < ?', [now]); } catch { /* 忽略清理失败 */ }
}

/** 创建限流器。opts: { name, windowMs, max, keyFn(req)→string, msg, shared } */
function createLimiter(opts) {
  const { name, windowMs = 60000, max = 30, keyFn, msg, shared = false } = opts;
  return function limit(req, res, next) {
    if (shared) {
      const t = Date.now();
      const windowStart = Math.floor(t / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      let count = 1, ra = resetAt;
      try {
        const r = dbIncr(`rl:${name}:${keyFn(req)}:${windowStart}`, resetAt);
        count = r.count; ra = r.resetAt;
      } catch { count = 1; ra = resetAt; } // 存储故障降级放行（不阻断业务）
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
      if (count > max) {
        const waitSec = Math.max(1, Math.ceil((ra - t) / 1000));
        res.setHeader('Retry-After', waitSec);
        const friendly = msg || `操作太频繁，请 ${waitSec} 秒后再试`;
        return res.status(429).json({ code: 429, msg: friendly, retry_after: waitSec });
      }
      return next();
    }
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

/* ---------- BE-B3：每 Key 日/月配额守卫 ---------- */

/** 计算日/月周期桶键与失效时刻（本地时区） */
function periodBuckets(name, key, now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const p2 = n => String(n).padStart(2, '0');
  const dayStr = `${y}-${p2(m)}-${p2(day)}`;
  const monStr = `${y}-${p2(m)}`;
  return {
    daily: { bucketKey: `rq:${name}:${key}:d:${dayStr}`, resetAt: new Date(y, m - 1, day + 1).getTime() },
    monthly: { bucketKey: `rq:${name}:${key}:m:${monStr}`, resetAt: new Date(y, m, 1).getTime() },
  };
}

/**
 * 创建配额守卫。opts: { name, keyFn(req)→string, limitsFn(req)→{daily,monthly}, msg }
 * limitsFn 返回 0/缺省 = 该周期不限。放行时对已配置周期自增；任一周期超限即 429 + Retry-After。
 */
function createQuotaGuard(opts) {
  const { name = 'quota', keyFn, limitsFn, msg } = opts;
  return function quotaGuard(req, res, next) {
    let limits = {};
    try { limits = (limitsFn && limitsFn(req)) || {}; } catch { limits = {}; }
    const daily = Number(limits.daily) > 0 ? Number(limits.daily) : 0;
    const monthly = Number(limits.monthly) > 0 ? Number(limits.monthly) : 0;
    if (!daily && !monthly) return next(); // 未配置 → 不限（向后兼容）
    const t = Date.now();
    const b = periodBuckets(name, keyFn(req), t);
    try {
      if (daily) {
        const r = dbIncr(b.daily.bucketKey, b.daily.resetAt);
        if (r.count > daily) {
          const waitSec = Math.max(1, Math.ceil((r.resetAt - t) / 1000));
          res.setHeader('Retry-After', waitSec);
          return res.status(429).json({ code: 429, msg: msg || `已达每日调用配额（${daily} 次/天），请明日再试`, retry_after: waitSec, quota: { period: 'daily', limit: daily } });
        }
      }
      if (monthly) {
        const r = dbIncr(b.monthly.bucketKey, b.monthly.resetAt);
        if (r.count > monthly) {
          const waitSec = Math.max(1, Math.ceil((r.resetAt - t) / 1000));
          res.setHeader('Retry-After', waitSec);
          return res.status(429).json({ code: 429, msg: msg || `已达每月调用配额（${monthly} 次/月），请下月再试`, retry_after: waitSec, quota: { period: 'monthly', limit: monthly } });
        }
      }
    } catch { /* 存储故障降级放行 */ }
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

module.exports = { createLimiter, createQuotaGuard, dbIncr, dbPeek, clientIp, trustHops, trustProxySetting };
