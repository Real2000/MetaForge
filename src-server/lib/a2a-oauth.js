/**
 * U2-7 Phase 3 A2A OAuth 令牌交换（2026-11-19）
 *
 * 实现 RFC 7523 private_key_jwt 的 client_credentials 流程：
 *   调用方用其 A2A 私钥签名 client_assertion（JWS），换取平台短期访问令牌。
 *   平台侧按 assertion 的 kid 寻址公钥验签，校验 iss/sub/aud/exp 后签发令牌。
 *
 * 访问令牌复用 lib/auth.js 的无状态 HMAC 签名（typ='a2a_token'，默认 1 小时，可吊销）。
 */
const { db } = require('../db');
const { sign, verify } = require('./auth');
const jws = require('./a2a-jws');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TOKEN_TYP = 'a2a_token';
const TOKEN_TTL_MS = (+(process.env.A2A_TOKEN_TTL_HOURS || 0) > 0 ? +process.env.A2A_TOKEN_TTL_HOURS : 1) * 3600000; // 默认 1 小时

/** 解析 JWS header（容错：非法返回 null） */
function decodeHeader(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
}

/** 判断 scope（逗号分隔）是否包含所需项；'*' 为通配 */
function hasScope(scopesCsv, needed) {
  const list = String(scopesCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(needed) || list.includes('*');
}

/** 签发 A2A 访问令牌 */
function issueToken({ kid, org = '', scopes = 'a2a:call' }) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const token = sign({ sub: kid, org, scope: scopes, typ: TOKEN_TYP, exp });
  return { access_token: token, token_type: 'Bearer', expires_in: Math.floor(TOKEN_TTL_MS / 1000), scope: scopes };
}

/**
 * 校验 A2A 访问令牌（供 A2A 鉴权中间件使用）。
 * @returns {object|null} 有效返回 payload，无效返回 null
 */
function verifyA2aToken(token) {
  const payload = verify(token); // 复用 auth.verify：签名 + 过期 + jti 吊销
  if (!payload || payload.typ !== TOKEN_TYP) return null;
  return payload;
}

/**
 * 交换 client_credentials：验 client_assertion → 签发访问令牌。
 * @param {{assertion:string, expectedAud?:string, now?:number}} p
 * @returns {{access_token,token_type,expires_in,scope} | {error:string,error_description?:string}}
 */
function exchangeClientCredentials({ assertion, expectedAud = '', now } = {}) {
  if (!assertion) return { error: 'invalid_request', error_description: '缺少 client_assertion' };
  const header = decodeHeader(assertion);
  if (!header || !header.kid) return { error: 'invalid_client' };

  // 验签（含 alg 白名单 / 未知 kid / 篡改 / 过期 / nbf）
  const payload = jws.verifyJws(assertion, jws.resolvePublicKey, now ? { now } : {});
  if (!payload) return { error: 'invalid_client' };

  // RFC 7523：iss 与 sub 均须等于客户端标识（kid）
  if (payload.iss !== header.kid || payload.sub !== header.kid) return { error: 'invalid_client' };

  // aud 校验：accept 精确匹配 expectedAud，或以令牌端点路径结尾（兼容自定义域名/端口）
  if (payload.aud) {
    const ok = !expectedAud
      || payload.aud === expectedAud
      || String(payload.aud).endsWith('/api/a2a/oauth/token');
    if (!ok) return { error: 'invalid_client' };
  }

  const row = db.prepare('SELECT org_name, scopes, status FROM a2a_api_keys WHERE key_id=?').get(header.kid);
  if (!row || !row.status) return { error: 'invalid_client' };

  jws.touchKey(header.kid);
  return issueToken({ kid: header.kid, org: row.org_name || '', scopes: row.scopes || 'a2a:call' });
}

module.exports = { ASSERTION_TYPE, TOKEN_TYP, TOKEN_TTL_MS, decodeHeader, hasScope, issueToken, verifyA2aToken, exchangeClientCredentials };
