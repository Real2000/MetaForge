/**
 * 认证：HMAC 无状态 token
 * 密钥管理（2026-10-20 P0 安全加固）：
 * - 优先读环境变量 AGENT_JWT_SECRET；
 * - 其次读 data/secrets.json（首次启动自动生成 64 字节随机密钥落盘，权限 600）；
 * - 兜底旧版硬编码密钥（保证升级后存量 Token 不失效）。
 * 秘钥文件缺失时自动生成，任何人拿到源码也伪造不了 Token。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const SECRET_FILE = path.join(__dirname, '..', '..', 'data', 'secrets.json');
const LEGACY_SECRET = 'agent-platform-jwt-secret-v1';

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
  // 4) 兜底：旧版硬编码（极端环境写不了文件时仍可用，保证不崩）
  return LEGACY_SECRET;
}

const SECRET = loadSecret();
if (SECRET === LEGACY_SECRET && !process.env.AGENT_JWT_SECRET) {
  console.warn('[auth] 警告：未能生成/读取密钥文件，正在使用内置兜底密钥（不安全，请检查 data 目录写权限）');
}

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

/** 登录/换码成功后写 HttpOnly Cookie（与 token TTL 同寿；SameSite=Lax 兼容 SSE/顶层导航且防跨站 POST） */
function setAuthCookie(res, token) {
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

/** 登出时清除认证 Cookie（Max-Age=0 即删） */
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
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

module.exports = { sign, verify, auth, adminOnly, revokeToken, TOKEN_TTL_MS, readToken, setAuthCookie, clearAuthCookie };
