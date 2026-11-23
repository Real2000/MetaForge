/**
 * 认证：HMAC 无状态 token
 * 密钥管理（P0 安全加固，2026-11-11 移除硬编码兜底）：
 * - 优先读环境变量 AGENT_JWT_SECRET；
 * - 其次读 data/secrets.json（首次启动自动生成 64 字节随机密钥落盘，权限 600）；
 * - 两路均失败时服务器拒绝启动，不再使用旧版硬编码兜底密钥。
 */
const crypto = require('crypto');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const SECRET_FILE = path.join(__dirname, '..', '..', 'data', 'secrets.json');

function loadSecret() {
  // 1) 环境变量优先（生产部署推荐）
  if (process.env.AGENT_JWT_SECRET && process.env.AGENT_JWT_SECRET.length >= 16) {
    return process.env.AGENT_JWT_SECRET;
  }
  // 2) 密钥文件（自动生成）
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const j = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
      if (j.jwt_secret && j.jwt_secret.length >= 16) return j.jwt_secret;
    }
  } catch { /* 损坏则重新生成 */ }
  // 3) 生成新密钥落盘（目录可能不存在则创建）
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    const j = { jwt_secret: crypto.randomBytes(48).toString('hex'), generated_at: new Date().toISOString() };
    fs.writeFileSync(SECRET_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
    return j.jwt_secret;
  } catch { }
  // 4) 两路均失败：拒绝启动，禁止使用弱钥（2026-11-11 移除旧版 LEGACY_SECRET 兜底）
  console.error('[auth] 致命错误：无法读取/生成 JWT 密钥。请设置环境变量 AGENT_JWT_SECRET（≥16 位），或确保 data/ 目录可写。');
  process.exit(1);
}

const SECRET = loadSecret();

// Token 有效期：默认 7 天，可用环境变量调整（小时）
const TOKEN_TTL_MS = (+(process.env.AGENT_TOKEN_TTL_HOURS || 0) > 0 ? +process.env.AGENT_TOKEN_TTL_HOURS : 168) * 3600000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, jti: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

// ---------------- P2-3 彻底修复（2026-11-09）：HttpOnly Cookie 认证通道 ----------------
// 原状态：token 由前端存 localStorage/sessionStorage，XSS 一旦发生即可窃取（storage 对 JS 完全可读）。
// 方案：服务端签发 HttpOnly Cookie（JS 不可读，XSS 无法外带）；Bearer 头通道保留（API 调用方/
// openapi/embed 等非浏览器场景兼容）。零依赖手写 Cookie 解析（项目无 cookie-parser，遵循其零依赖哲学）。
const AUTH_COOKIE_NAME = 'ap_token';

/** 从请求中提取认证 token：优先 Authorization: Bearer 头，回落 HttpOnly Cookie
 *  注意：HTTP 层会裁剪头值的尾部空白——前端 getToken() 为空时会发出 "Bearer "（到达即 "Bearer"），
 *  剥离 scheme 后为空值时必须回落 Cookie，否则空 Bearer 头会短路掉 Cookie 通道（集成实测踩过） */
function readToken(req) {
  const h = String(req.headers.authorization || '').trim();
  if (h) {
    const bearerVal = h.replace(/^Bearer\s*/i, '').trim();
    if (bearerVal) return bearerVal; // 有效 Bearer 值（或无 scheme 的裸 token，与旧中间件语义一致）
    // 头存在但剥离后为空（"Bearer"/"Bearer "）→ 继续走 Cookie 回落
  }
  const cookie = req.headers.cookie;
  if (!cookie) return '';
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); }
    }
  }
  return '';
}

/** 登录/换码成功后写 HttpOnly Cookie（与 token TTL 同寿；SameSite=Lax 兼容 SSE/顶层导航且防跨站 POST）
 *  SEC-07（2026-11-22）：生产环境强制 Secure 属性——仅经 HTTPS 回传，防明文信道窃取。
 *  触发条件：NODE_ENV=production 或 AGENT_ENABLE_HSTS=1 或 AGENT_COOKIE_SECURE=1（本地 HTTP 开发默认不加，避免登录不可用）。 */
function setAuthCookie(res, token) {
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  const secure = (process.env.NODE_ENV === 'production' || process.env.AGENT_ENABLE_HSTS === '1' || process.env.AGENT_COOKIE_SECURE === '1') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

/** 登出时清除认证 Cookie（Max-Age=0 即删；SEC-07：生产同步带 Secure，确保能覆盖已 Secure 的旧 Cookie） */
function clearAuthCookie(res) {
  const secure = (process.env.NODE_ENV === 'production' || process.env.AGENT_ENABLE_HSTS === '1' || process.env.AGENT_COOKIE_SECURE === '1') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    // SEC-07（2026-11-22）：用户级令牌吊销——比对 token 内嵌版本号 tv 与用户当前 token_version。
    // 改密/重置密码/停用账号时将该用户 token_version +1，本检查使该用户全部已签发旧令牌立即失效
    // （无需逐条黑名单；旧令牌无 tv 字段时跳过，保持向后兼容）。
    if (payload.tv != null) {
      const u = dal.getq('SELECT token_version FROM users WHERE id=?', [payload.uid]);
      if (!u || (u.token_version || 0) !== payload.tv) return null;
    }
    // P0-4 token 吊销检查：查询 blacklist 表，命中则视为无效
    if (payload.jti) {
      const blacklisted = dal.getq('SELECT 1 FROM token_blacklist WHERE jti=?', [payload.jti]);
      if (blacklisted) return null;
    }
    return payload;
  } catch { return null; }
}

function auth(req, res, next) {
  const token = readToken(req); // P2-3：Bearer 头 / HttpOnly Cookie 双通道
  const payload = verify(token);
  if (!payload) return res.status(401).json({ code: 401, msg: '未登录或登录已过期' });
  // P0-3 收尾 2026-10-30：SELECT 补 dept_id——此前缺该字段导致 req.user.dept_id 恒 undefined，
  // visible_depts 纯数字 ID 模式在 HTTP 链路判定空转（部门树勾选保存正常但部门用户实际看不到智能体）
  const user = dal.getq('SELECT id, username, nickname, role, dept, dept_id, onboarded, tenant_id, COALESCE(platform_admin,0) AS platform_admin FROM users WHERE id=? AND status=1', [payload.uid]);
  if (!user) return res.status(401).json({ code: 401, msg: '账号不可用' });
  req.user = user;
  next();
}
// MT-08（2026-11-22）账号/角色分层：adminOnly 语义拆分。
//   - adminOnly / tenantAdminOnly：租户管理员（role='admin'），仅在本人租户域内管理（默认，绝大多数后台路由沿用）。
//   - platformAdminOnly：平台超管（platform_admin=1 或配置清单命中），可跨租户运维（平台级敏感操作）。
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  next();
}
function platformAdminOnly(req, res, next) {
  if (!isPlatformSuperadmin(req.user)) return res.status(403).json({ code: 403, msg: '需要平台超管权限' });
  next();
}
/** P0-4 token 吊销：将当前请求携带的 token 加入黑名单（P2-3：双通道取 token——
 *  前端改 Cookie 后不再发 Authorization 头，若仍只从头取 token，登出/改密的吊销会静默失效，
 *  旧 cookie 在 TTL 内继续可用——这是 Cookie 化改造的关键连带点） */
function revokeToken(req) {
  const token = readToken(req);
  if (!token) return;
  try {
    const [body] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.jti && payload.uid) {
      dal.runq('INSERT OR IGNORE INTO token_blacklist (jti, username, created_at) VALUES (?,?,?)', [payload.jti, req.user?.username || String(payload.uid), new Date().toISOString()]);
    }
  } catch { }
}

/** SEC-07（2026-11-22）：用户级令牌吊销——将指定用户 token_version +1。
 *  改密/管理员重置密码/停用账号时调用，配合 verify() 的 tv 比对，使该用户全部旧令牌立即失效。
 *  返回新的 token_version（调用方可在吊销后签发携带新版本号的令牌，实现「本人换新、他人全踢」）。 */
function bumpTokenVersion(userId) {
  dal.runq('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id=?', [userId]);
  const r = dal.getq('SELECT token_version FROM users WHERE id=?', [userId]);
  return r ? (r.token_version || 0) : 0;
}

// SEC-08（2026-11-22）：token_blacklist 定期清理防膨胀——超过 TTL 的条目其令牌已自然过期，
// 黑名单记录可安全删除。启动时执行一次 + 每小时一次（unref 不阻进程退出）。
function cleanBlacklist() {
  try {
    const cutoff = new Date(Date.now() - TOKEN_TTL_MS - 3600000).toISOString(); // TTL + 1h 冗余
    dal.runq('DELETE FROM token_blacklist WHERE created_at < ?', [cutoff]);
  } catch { /* 表不可用等异常忽略 */ }
}
cleanBlacklist();
setInterval(cleanBlacklist, 60 * 60 * 1000).unref();

// ==================== MT-03 租户上下文中间件（2026-11-22） ====================
// 设计（对应 docs/tenant-scope.md §4.2）：
//   - 单租户模式（默认）：不启用租户硬边界，全部请求挂 req.tenant={id:1}，业务行为与现状一致（零回归）。
//   - 多租户模式（AGENT_MULTI_TENANT=1）：解析优先级 —— 已认证用户的 users.tenant_id（服务端权威）
//     > JWT claim tenant_id > X-Tenant-Id 头 / 子域 > 拒绝（fail-closed 403）。
//   - 平台超管（AGENT_PLATFORM_ADMINS，默认 admin）：可旁路跨租户，但每次旁路强制写审计。
const MULTI_TENANT = ['1', 'true', 'yes', 'on'].includes(String(process.env.AGENT_MULTI_TENANT || '').toLowerCase());
const PLATFORM_ADMINS = String(process.env.AGENT_PLATFORM_ADMINS || 'admin').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_TENANT_ID = 1;

/** 是否平台超管：platform_admin=1（DB 权威），或（向后兼容）role=admin 且用户名命中 AGENT_PLATFORM_ADMINS 清单 */
function isPlatformSuperadmin(user) {
  if (!user) return false;
  if (Number(user.platform_admin) === 1) return true;
  return !!(user.role === 'admin' && PLATFORM_ADMINS.includes(user.username));
}

/** 从请求解析租户 ID（不读 DB 用户，仅取 JWT/头/子域） */
function resolveTenantId(req) {
  // 1) JWT claim tenant_id（服务端签发，可信）
  const payload = verify(readToken(req));
  if (payload && payload.tenant_id != null && Number.isFinite(Number(payload.tenant_id))) {
    return { id: Number(payload.tenant_id), source: 'jwt' };
  }
  // 2) X-Tenant-Id 头
  const h = String(req.headers['x-tenant-id'] || '').trim();
  if (h) {
    const n = Number(h);
    return { id: Number.isFinite(n) ? n : NaN, source: 'header' };
  }
  // 3) 子域（Host 首段，按 tenants.name 反查）
  const host = String(req.headers.host || '').split(':')[0];
  const seg = host.split('.')[0];
  if (seg && !/^\d+$/.test(seg) && seg !== 'localhost' && seg !== '127') {
    try {
      const t = dal.getq('SELECT id FROM tenants WHERE name=? AND status=\'active\' LIMIT 1', [seg]);
      if (t) return { id: t.id, source: 'subdomain' };
    } catch { /* ignore */ }
  }
  return null;
}

/** 平台超管旁路强制审计 */
function auditTenantBypass(req, user, tenantId) {
  try {
    dal.runq('INSERT INTO security_events (type, detail, action, source, created_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))', ['tenant_bypass', `平台超管 ${user.username} 跨租户访问 tenant_id=${tenantId}`, String(req.method) + ' ' + String(req.originalUrl || req.url), 'tenant-context']);
  } catch { /* 审计失败不阻断 */ }
}

/** 租户上下文中间件：必须置于全部业务路由之前 */
const TENANT_PUBLIC_PREFIXES = ['/api/auth', '/api/health', '/api/edition', '/api/a2a', '/.well-known', '/api/config/public', '/api/payment/callback'];
// BE-B5：双挂载下 /api/v1/* 折叠回 /api/* 后再判定，两类前缀行为一致。
const { stripVersion } = require('./api-version');
function isTenantPublicPath(reqPath) {
  const p = stripVersion(String(reqPath || ''));
  return TENANT_PUBLIC_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'));
}
function tenantContext(req, res, next) {
  if (!MULTI_TENANT) {
    req.tenant = { id: DEFAULT_TENANT_ID, name: '默认租户', single: true };
    return next();
  }
  // 公开端点（登录/健康/发现/版本）无需租户上下文
  if (isTenantPublicPath(req.path)) {
    req.tenant = { id: DEFAULT_TENANT_ID, source: 'public' };
    return next();
  }
  // 多租户：先尝试认证，用于平台超管旁路与用户权威租户
  const payload = verify(readToken(req));
  let user = null;
  if (payload) {
    try { user = dal.getq('SELECT id, username, role, tenant_id FROM users WHERE id=? AND status=1', [payload.uid]); } catch { user = null; }
  }
  if (user && isPlatformSuperadmin(user)) {
    const r = resolveTenantId(req);
    const tid = (r && Number.isFinite(r.id) && r.id > 0) ? r.id : (user.tenant_id || DEFAULT_TENANT_ID);
    req.tenant = { id: tid, source: r ? r.source : 'superadmin-default', bypass: true };
    auditTenantBypass(req, user, tid);
    return next();
  }
  // 已认证普通用户：以其 users.tenant_id 为权威（防头伪造跨租户）
  if (user) {
    const tid = user.tenant_id || DEFAULT_TENANT_ID;
    req.tenant = { id: tid, source: 'user' };
    return next();
  }
  // 未认证（API Key/Agent 调用等）：JWT/头/子域，缺则拒绝
  const r = resolveTenantId(req);
  if (!r || !Number.isFinite(r.id) || r.id <= 0) {
    return res.status(403).json({ code: 403, msg: '缺少租户上下文（tenant_id）' });
  }
  req.tenant = { id: r.id, source: r.source };
  return next();
}

module.exports = { sign, verify, auth, adminOnly, platformAdminOnly, tenantAdminOnly: adminOnly, revokeToken, bumpTokenVersion, cleanBlacklist, tenantContext, isPlatformSuperadmin, MULTI_TENANT, TOKEN_TTL_MS, readToken, setAuthCookie, clearAuthCookie, PLATFORM_ADMINS, DEFAULT_TENANT_ID };
