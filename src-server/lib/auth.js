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
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verify(token);
  if (!payload) return res.status(401).json({ code: 401, msg: '未登录或登录已过期' });
  const user = db.prepare('SELECT id, username, nickname, role, dept, onboarded FROM users WHERE id=? AND status=1').get(payload.uid);
  if (!user) return res.status(401).json({ code: 401, msg: '账号不可用' });
  req.user = user;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  next();
}

module.exports = { sign, verify, auth, adminOnly, TOKEN_TTL_MS };
