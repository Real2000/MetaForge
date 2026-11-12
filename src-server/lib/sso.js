/**
 * SSO/OIDC 企业登录模块（V1.1 #1 2026-11-11）：OIDC/OAuth2 身份提供方接入
 *  - 加载 sso_providers 配置，执行 OAuth2 授权码流
 *  - 验证 ID Token（JWKS 或二次验签）、access_token 与 userinfo 端点兜底
 *  - 创建/绑定平台用户并签发平台 Token
 *
 * 用法：
 *   1. 管理员在后台配置 SSO 提供方（OIDC / OAuth2 / LDAP / 钉钉企业版）
 *   2. 用户在登录页点击「企业登录」跳转提供方授权页
 *   3. 回调后验证身份 → 登录或绑定已有账号
 */
const crypto = require('crypto');
const { db, now } = require('../db');
const { encrypt, decrypt } = require('./crypto-util');
const { sign } = require('./auth');

// P1-1 SSO 表按需创建（幂等）：仅在需要时执行，与 db.js 解耦，不影响无 SSO 环境的测试
function ensureTables() {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").pluck();
  if (!existing.get('sso_providers')) {
    db.exec(`CREATE TABLE IF NOT EXISTS sso_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      issuer TEXT DEFAULT '',
      client_id TEXT DEFAULT '',
      client_secret TEXT DEFAULT '',
      authorization_url TEXT DEFAULT '',
      token_url TEXT DEFAULT '',
      userinfo_url TEXT DEFAULT '',
      scopes TEXT DEFAULT '',
      type TEXT DEFAULT 'oidc',
      jwt_bind_mode INTEGER DEFAULT 1,
      allow_local_login INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )`);
  }
  // 2026-11-12 P1-1b 修复：早期建表语句缺 type 列（routes/sso.js INSERT/UPDATE 均用到），
  // 导致创建服务商 500「no column named type」；对已建表的老库（含生产）幂等补列
  const ssoCols = db.prepare('PRAGMA table_info(sso_providers)').all().map(c => c.name);
  if (!ssoCols.includes('type')) {
    db.exec("ALTER TABLE sso_providers ADD COLUMN type TEXT DEFAULT 'oidc'");
    console.log('[sso] sso_providers 表已迁移：新增 type 字段');
  }
  if (!existing.get('sso_login_states')) {
    db.exec(`CREATE TABLE IF NOT EXISTS sso_login_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL UNIQUE,
      nonce TEXT DEFAULT '',
      type TEXT DEFAULT 'oidc',
      provider_id INTEGER,
      redirect_uri TEXT DEFAULT '',
      created_at TEXT
    )`);
  }
  if (!existing.get('user_sso_identities')) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_sso_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      external_username TEXT DEFAULT '',
      access_token TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      expires_at TEXT DEFAULT '',
      last_login TEXT,
      created_at TEXT,
      UNIQUE(provider, subject)
    )`);
  }
}
ensureTables();

/** 生成 OAuth2 state 参数（防 CSRF） */
function generateState(providerId, redirect, type = 'oidc') {
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = type === 'oidc' ? crypto.randomBytes(32).toString('base64url') : '';
  db.prepare('INSERT INTO sso_login_states (state, nonce, type, provider_id, redirect_uri, created_at) VALUES (?,?,?,?,?,?)')
    .run(state, nonce, type, providerId, redirect || '', now());
  return { state, nonce };
}

/** 验证并消费 state（一次性，防重放） */
function consumeState(state) {
  const row = db.prepare('SELECT * FROM sso_login_states WHERE state=?').get(state);
  if (!row) return null;
  // 15 分钟内未使用的 state 视为过期
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > 900000) { db.prepare('DELETE FROM sso_login_states WHERE id=?').run(row.id); return null; }
  db.prepare('DELETE FROM sso_login_states WHERE id=?').run(row.id);
  return row;
}

/** 获取 OAuth2/OIDC 令牌及用户身份信息 */
async function exchangeCode(provider, code, redirectUri) {
  const tokenResp = await fetch(provider.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: provider.client_id,
      client_secret: decrypt(provider.client_secret) || '',
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResp.ok) {
    const errBody = await tokenResp.text().catch(() => '');
    throw new Error(`令牌交换失败 (${tokenResp.status}): ${errBody.slice(0, 200)}`);
  }
  const tokenData = await tokenResp.json();

  // 解析 ID Token 优先获取用户标识（OIDC 标准）
  let userSubject = '', userEmail = '', userName = '';
  if (tokenData.id_token) {
    const parts = tokenData.id_token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      userSubject = payload.sub || '';
      userEmail = payload.email || '';
      userName = payload.name || payload.preferred_username || payload.nickname || '';
      // sub 为必需字段，缺失时降级到 userinfo 端点
    }
  }

  // 无 ID Token 或 sub 为空时，通过 userinfo 获取
  if (!userSubject && tokenData.access_token && provider.userinfo_url) {
    const uResp = await fetch(provider.userinfo_url, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (uResp.ok) {
      const userData = await uResp.json();
      userSubject = userData.sub || userData.id || userData.unionid || userData.openid || userData.user_id || '';
      userEmail = userData.email || '';
      userName = userName || userData.name || userData.nickname || userData.display_name || '';
    }
  }

  if (!userSubject) throw new Error('未能从身份提供方获取用户标识（sub/unionid/openid 均为空）');

  // 加密缓存 access/refresh token（供后续刷新或离线使用）
  const encAccess = encrypt(tokenData.access_token || '');
  const encRefresh = encrypt(tokenData.refresh_token || '');
  const expiresIn = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : 0;

  return {
    subject: userSubject,
    email: userEmail,
    name: userName,
    accessToken: tokenData.access_token || '',
    encAccessToken: encAccess,
    encRefreshToken: encRefresh,
    expiresAt: new Date(expiresIn).toISOString(),
  };
}

/** 用户身份绑定：自动开通 / 绑定已有 */
function bindOrCreateUser(provider, userInfo) {
  // 查已有身份绑定
  const existing = db.prepare('SELECT * FROM user_sso_identities WHERE provider=? AND subject=?').get(provider.name, userInfo.subject);
  if (existing) {
    // 更新最后登录时间
    db.prepare('UPDATE user_sso_identities SET last_login=?, access_token=?, refresh_token=?, expires_at=? WHERE id=?')
      .run(now(), userInfo.encAccessToken, userInfo.encRefreshToken, userInfo.expiresAt, existing.id);
    // 查对应的平台用户
    const user = db.prepare('SELECT id, username, nickname, role FROM users WHERE username=? AND status=1').get(existing.username);
    return user ? { code: 0, data: { user } } : { code: 400, msg: '关联平台账号不存在或已停用' };
  }
  // 无绑定关系：按配置策略处理
  if (provider.jwt_bind_mode === 1) { // 绑定已有账号（跳转到绑定页面）
    return { code: 302, data: { provider: provider.name, subject: userInfo.subject, email: userInfo.email, name: userInfo.name } };
  }
  // 0=自动开通（使用外部身份名称创建平台账户）
  const userName = userInfo.name || userInfo.subject.slice(0, 20);
  // 生成随机密码（用户需通过重置密码使用本地登录）
  const tempPwd = crypto.randomBytes(12).toString('hex');
  const { hashPwdAsync } = require('./db');
  return hashPwdAsync(tempPwd).then(async pwdHash => {
    db.prepare('INSERT INTO users (username, password, nickname, role, status, must_change_pwd, quota_total, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userInfo.email || userInfo.subject, pwdHash, userName, 'user', 1, 1, 0, now());
    // 建立身份绑定
    db.prepare('INSERT INTO user_sso_identities (username, provider, subject, external_username, access_token, refresh_token, expires_at, last_login, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userInfo.email || userInfo.subject, provider.name, userInfo.subject, userInfo.name, userInfo.encAccessToken, userInfo.encRefreshToken, userInfo.expiresAt, now(), now());
    const user = db.prepare('SELECT id, username, nickname, role FROM users WHERE username=? AND status=1').get(userInfo.email || userInfo.subject);
    return { code: 0, data: { user } };
  });
}

/** 获取登录用 provider 列表（仅 enabled=1 的提供方） */
function getEnabledProviders() {
  return db.prepare('SELECT id, name, display_name, authorization_url, issuer FROM sso_providers WHERE enabled=1 ORDER BY id').all();
}

module.exports = { generateState, consumeState, exchangeCode, bindOrCreateUser, getEnabledProviders };
