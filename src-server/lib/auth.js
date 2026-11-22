/**
 * 认证：HMAC 无状态 token
 * 密钥管理（P0 安全加固，2026-11-11 移除硬编码兜底）：
 * - 优先读环境变量 AGENT_JWT_SECRET；
 * - 其次读 data/secrets.json（首次启动自动生成 64 字节随机密钥落盘，权限 600）；
 * - 两路均失败时服务器拒绝启动，不再使用旧版硬编码兜底密钥。
 */
const crypto = require('crypto');
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
      const u = db.prepare('SELECT token_version FROM users WHERE id=?').get(payload.uid);
      if (!u || (u.token_version || 0) !== payload.tv) return null;
    }
    // P0-4 token 吊销检查：查询 blacklist 表，命中则视为无效
    if (payload.jti) {
      const blacklisted = db.prepare('SELECT 1 FROM token_blacklist WHERE jti=?').get(payload.jti);
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
  const user = db.prepare('SELECT id, username, nickname, role, dept, dept_id, onboarded FROM users WHERE id=? AND status=1').get(payload.uid);
  if (!user) return res.status(401).json({ code: 401, msg: '账号不可用' });
  req.user = user;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
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
      db.prepare('INSERT OR IGNORE INTO token_blacklist (jti, username, created_at) VALUES (?,?,?)')
        .run(payload.jti, req.user?.username || String(payload.uid), new Date().toISOString());
    }
  } catch { }
}

/** SEC-07（2026-11-22）：用户级令牌吊销——将指定用户 token_version +1。
 *  改密/管理员重置密码/停用账号时调用，配合 verify() 的 tv 比对，使该用户全部旧令牌立即失效。
 *  返回新的 token_version（调用方可在吊销后签发携带新版本号的令牌，实现「本人换新、他人全踢」）。 */
function bumpTokenVersion(userId) {
  db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id=?').run(userId);
  const r = db.prepare('SELECT token_version FROM users WHERE id=?').get(userId);
  return r ? (r.token_version || 0) : 0;
}

// SEC-08（2026-11-22）：token_blacklist 定期清理防膨胀——超过 TTL 的条目其令牌已自然过期，
// 黑名单记录可安全删除。启动时执行一次 + 每小时一次（unref 不阻进程退出）。
function cleanBlacklist() {
  try {
    const cutoff = new Date(Date.now() - TOKEN_TTL_MS - 3600000).toISOString(); // TTL + 1h 冗余
    db.prepare('DELETE FROM token_blacklist WHERE created_at < ?').run(cutoff);
  } catch { /* 表不可用等异常忽略 */ }
}
cleanBlacklist();
setInterval(cleanBlacklist, 60 * 60 * 1000).unref();

module.exports = { sign, verify, auth, adminOnly, revokeToken, bumpTokenVersion, cleanBlacklist, TOKEN_TTL_MS, readToken, setAuthCookie, clearAuthCookie };
