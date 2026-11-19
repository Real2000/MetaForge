/**
 * U2-7 Phase 3 A2A JWS 签名与密钥管理（2026-11-19）
 *
 * 零依赖：完全使用 Node 内置 crypto 实现 JWS compact 签发/验签。
 *   - RS256：RSA-2048 + SHA-256（PKCS#1 v1.5 原始签名，与 JOSE 一致）
 *   - ES256：ECDSA P-256 + SHA-256（ieee-p1363 原始 r||s，与 JOSE 一致）
 *
 * 密钥对落地 a2a_api_keys 表；私钥经 crypto-util.encrypt（AES-256-GCM）加密后存储，
 * 明文私钥永不落盘；管理端仅在签发时一次性返回私钥。
 *
 * 时间声明单位：exp / nbf 采用【毫秒时间戳】，与 lib/auth.js 的平台 token 口径保持一致
 * （本项目内部链路自洽；对外接入方使用本仓库的签名示例即可）。
 */
const crypto = require('crypto');
const { db, now } = require('../db');
const { encrypt, decrypt } = require('./crypto-util');

const ALLOWED_ALGS = ['RS256', 'ES256'];

/* ---------------- 编码工具 ---------------- */

/** Buffer/字符串 → base64url（Node 内置 base64url 编码，无 = 补齐） */
function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString('base64url');
}

/** base64url → Buffer（容错：非法输入返回 null） */
function b64urlDecode(str) {
  try { return Buffer.from(String(str), 'base64url'); } catch { return null; }
}

/** 签名/验签选项：ES256 需显式指定 ieee-p1363 编码（Node 默认 DER，与 JOSE 不符） */
function keyOpts(alg, key) {
  return alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : { key };
}

/* ---------------- 密钥对生成 ---------------- */

/**
 * 生成签名密钥对（PEM）。
 * @param {'RS256'|'ES256'} alg
 * @returns {{ publicKey:string, privateKey:string }}
 */
function generateKeyPair(alg = 'RS256') {
  if (!ALLOWED_ALGS.includes(alg)) throw new Error('不支持的签名算法：' + alg);
  const isEc = alg === 'ES256';
  const { publicKey, privateKey } = crypto.generateKeyPairSync(isEc ? 'ec' : 'rsa', {
    ...(isEc ? { namedCurve: 'prime256v1' } : { modulusLength: 2048 }),
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/* ---------------- JWS compact ---------------- */

/**
 * 签发 compact JWS。
 * @param {object} payload          — 载荷（含 exp/nbf 等声明，单位毫秒）
 * @param {string} privateKeyPem    — 私钥 PEM
 * @param {{alg?:string, kid?:string}} [opts]
 * @returns {string}  header.payload.signature
 */
function signJws(payload, privateKeyPem, opts = {}) {
  const alg = opts.alg || 'RS256';
  if (!ALLOWED_ALGS.includes(alg)) throw new Error('不支持的签名算法：' + alg);
  const header = { alg, typ: 'JWS', kid: opts.kid || '' };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(signingInput), keyOpts(alg, privateKeyPem));
  return signingInput + '.' + sig.toString('base64url');
}

/**
 * 验签 compact JWS。
 * @param {string} token                    — compact JWS
 * @param {(kid:string)=>string} resolveKey — kid → 公钥 PEM（返回空串视为未知 kid）
 * @param {{now?:number}} [opts]            — now 覆盖当前时间（测试用）
 * @returns {object|null} 通过返回 payload，任一校验失败返回 null
 */
function verifyJws(token, resolveKey, opts = {}) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null; // ① 必须三段
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString());
    payload = JSON.parse(b64urlDecode(parts[1]).toString());
  } catch { return null; }
  if (!header || !ALLOWED_ALGS.includes(header.alg)) return null; // ② alg 白名单（拒 none 等）
  const publicKey = typeof resolveKey === 'function' ? resolveKey(header.kid) : '';
  if (!publicKey) return null; // ③ 未知 kid / 已停用
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), keyOpts(header.alg, publicKey), b64urlDecode(parts[2]));
  } catch { return null; }
  if (!ok) return null; // ④ 签名/载荷篡改
  const nowMs = opts.now || Date.now();
  if (payload.exp != null && nowMs > payload.exp) return null; // ⑤ 过期
  if (payload.nbf != null && nowMs < payload.nbf) return null; // ⑥ 未生效
  return payload;
}

/* ---------------- 密钥管理（a2a_api_keys 表） ---------------- */

/**
 * 新建 A2A 密钥。私钥加密落库，明文仅在此处返回一次。
 * @returns {{key_id, alg, public_key, private_key, scopes}} private_key 为明文 PEM（仅此一次）
 */
function createKey({ name = '', owner = '', orgName = '', alg = 'RS256', scopes = 'a2a:call', expiresAt = '' } = {}) {
  const { publicKey, privateKey } = generateKeyPair(alg);
  const kid = 'a2ak_' + crypto.randomBytes(12).toString('hex');
  db.prepare(`INSERT INTO a2a_api_keys (key_id,name,owner,org_name,alg,public_key,private_key,scopes,status,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?)`)
    .run(kid, name, owner, orgName, alg, publicKey, encrypt(privateKey), scopes, expiresAt, now());
  return { key_id: kid, alg, public_key: publicKey, private_key: privateKey, scopes };
}

/** 按 kid 取启用中（未停用、未过期）的公钥 PEM；不可用返回空串 */
function resolvePublicKey(kid) {
  if (!kid) return '';
  let row;
  try { row = db.prepare('SELECT public_key,status,expires_at FROM a2a_api_keys WHERE key_id=?').get(kid); } catch { return ''; }
  if (!row || !row.status) return '';
  if (row.expires_at && Date.now() > new Date(row.expires_at).getTime()) return '';
  return row.public_key || '';
}

/** 按 kid 取解密后的私钥 PEM（供令牌端点对持有方做断言校验之外的本地使用）；不可用返回空串 */
function getPrivateKey(kid) {
  const row = db.prepare('SELECT private_key,status FROM a2a_api_keys WHERE key_id=? AND status=1').get(kid);
  if (!row) return '';
  return decrypt(row.private_key);
}

/** 列出全部密钥（不含私钥列） */
function listKeys() {
  return db.prepare('SELECT id,key_id,name,owner,org_name,alg,scopes,status,expires_at,created_at,last_used_at FROM a2a_api_keys ORDER BY id DESC').all();
}

/** 停用密钥（status=0）；返回是否命中 */
function disableKey(kid) {
  const r = db.prepare('UPDATE a2a_api_keys SET status=0 WHERE key_id=?').run(kid);
  return r.changes > 0;
}

/** 记录最近使用时间（不阻断） */
function touchKey(kid) {
  try { db.prepare('UPDATE a2a_api_keys SET last_used_at=? WHERE key_id=?').run(now(), kid); } catch { /* ignore */ }
}

module.exports = {
  ALLOWED_ALGS,
  b64url, b64urlDecode,
  generateKeyPair, signJws, verifyJws,
  createKey, resolvePublicKey, getPrivateKey, listKeys, disableKey, touchKey,
};
