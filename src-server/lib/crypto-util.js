/**
 * 加密工具：AES-256-GCM 加密/解密，用于存储敏感密钥（如 API Key）
 *
 * SEC-10（M2 批次4，2026-11-22）密钥管理规范化：
 *   ① 密钥来源优先级：环境变量 AGENT_ENCRYPTION_KEY > 文件 <DATA_DIR>/encryption.key（0600）> secrets 表（旧版，兼容）
 *      —— 推荐环境变量/文件，使「加密密钥」与「密文」不同源（不再同存 secrets 表）。
 *   ② 密文加 kid 前缀支持多版本：密文格式 `kid.iv.authTag.ciphertext`（kid=sha256(key) 前 8 位 hex）；
 *      解密按 kid 命中对应密钥；旧 3 段密文（无 kid）按当前密钥回退解。
 *   ③ 轮换：轮换时把新密钥设为 AGENT_ENCRYPTION_KEY、旧密钥设为 AGENT_ENCRYPTION_KEY_PREV（仅解密用），
 *      旧密文仍可解，新写入用新密钥。keyInfo() 暴露来源与版本供启动日志/巡检。
 *
 * 历史沿革：P1-1 修复 db 惰性 require 打破加载期循环依赖；SEC-03 密钥缺失时 fail-closed 抛错（拒绝明文落盘）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_FILE = path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'encryption.key');

/** 校验 64 位 hex → Buffer(32)；非法返回 null */
function keyFromHex(hex) {
  const s = String(hex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

/** kid：密钥指纹前缀（8 位 hex），随密钥变化，解密据此定位版本 */
function kidOf(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('hex').slice(0, 8);
}

/** 从文件读取密钥（0600）；不存在/非法返回 null */
function keyFromFile() {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    return keyFromHex(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch { return null; }
}

/** 从 secrets 表读取（旧版来源，兼容）；惰性 require 打破加载期循环依赖 */
function keyFromDb() {
  try {
    const { db } = require('../db');
    const row = db.prepare("SELECT value FROM secrets WHERE name='ENCRYPTION_KEY'").pluck().get();
    return keyFromHex(row);
  } catch { return null; }
}

let _infoCache = null;
/** 解析当前密钥来源 + 版本密钥环（60s 缓存，支持热更新） */
function resolveKeys() {
  if (_infoCache && Date.now() - _infoCache.at < 60000) return _infoCache;
  const ring = new Map(); // kid -> Buffer
  let source = 'none', primary = null, primaryKid = null;
  // 主密钥：env > file > db
  const envKey = keyFromHex(process.env.AGENT_ENCRYPTION_KEY);
  const fileKey = keyFromFile();
  const dbKey = keyFromDb();
  if (envKey) { primary = envKey; source = 'env'; }
  else if (fileKey) { primary = fileKey; source = 'file'; }
  else if (dbKey) { primary = dbKey; source = 'db'; }
  if (primary) { primaryKid = kidOf(primary); ring.set(primaryKid, primary); }
  // 轮换用旧密钥（仅解密）：AGENT_ENCRYPTION_KEY_PREV（逗号分隔多个 hex）
  for (const hex of String(process.env.AGENT_ENCRYPTION_KEY_PREV || '').split(',')) {
    const k = keyFromHex(hex);
    if (k) ring.set(kidOf(k), k);
  }
  // DB 旧密钥也纳入密钥环（轮换后旧密文仍可解）
  if (dbKey) ring.set(kidOf(dbKey), dbKey);
  _infoCache = { at: Date.now(), source, primary, primaryKid, ring };
  return _infoCache;
}

/** 当前加密密钥（fail-closed：缺失即抛错，拒绝明文落盘，SEC-03） */
function loadEncryptionKey() {
  const k = resolveKeys().primary;
  if (!k) {
    throw new Error('加密密钥未配置：请设置 AGENT_ENCRYPTION_KEY 环境变量、或写入 ' + KEY_FILE +
      '（0600，64 位 hex），或确保 secrets 表存在 ENCRYPTION_KEY（拒绝明文落盘）');
  }
  return k;
}

/** 密钥来源与版本信息（启动日志/巡检/测试用） */
function keyInfo() {
  const r = resolveKeys();
  return { source: r.source, kid: r.primaryKid, versions: [...r.ring.keys()], hasPrimary: !!r.primary };
}

/** 清缓存（写入新密钥后热更新） */
function resetKeyCache() { _infoCache = null; }

/** 密钥文件路径（迁移脚本/文档用） */
function keyFilePath() { return KEY_FILE; }

/** 当前主加密密钥（Buffer）或 null（SEC-10：供 apikey pepper / 巡检复用同一来源，避免来源漂移） */
function primaryKey() {
  return resolveKeys().primary || null;
}

/**
 * AES-256-GCM 加密
 * @returns {string} `kid.ivHex.authTagHex.ciphertextHex`（SEC-10：带 kid 前缀的多版本格式）
 */
function encrypt(plaintext) {
  const key = loadEncryptionKey();
  const kid = kidOf(key);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${kid}.${iv.toString('hex')}.${authTag.toString('hex')}.${encrypted}`;
}

/** 用指定密钥尝试解密，成功返回明文，失败返回 null */
function tryDecrypt(key, ivHex, tagHex, ctHex) {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(ctHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch { return null; }
}

/**
 * AES-256-GCM 解密（兼容三种形态）
 *   - 新格式 4 段 `kid.iv.tag.ct`：按 kid 选密钥解密；
 *   - 旧格式 3 段 `iv.tag.ct`：按密钥环逐个尝试（兼容轮换）；
 *   - 非密文形态（历史明文）：原样返回。
 * 密文形态但无可用密钥/解密失败 → 返回空串 + 告警（避免密文被当明文外发上游）。
 */
function decrypt(encrypted) {
  const str = String(encrypted ?? '');
  const parts = str.split('.');
  const isHex = (s, n) => new RegExp(`^[0-9a-f]{${n}}$`, 'i').test(s);
  let kid = null, ivHex = null, tagHex = null, ctHex = null;
  if (parts.length === 4 && isHex(parts[0], 8) && isHex(parts[1], 32) && isHex(parts[2], 32) && isHex(parts[3], parts[3].length) && parts[3].length > 0) {
    kid = parts[0]; ivHex = parts[1]; tagHex = parts[2]; ctHex = parts[3];
  } else if (parts.length === 3 && isHex(parts[0], 32) && isHex(parts[1], 32) && isHex(parts[2], parts[2].length) && parts[2].length > 0) {
    ivHex = parts[0]; tagHex = parts[1]; ctHex = parts[2];
  } else {
    return str; // 旧明文原样返回
  }
  const { ring, primaryKid } = resolveKeys();
  const candidates = [];
  if (kid && ring.has(kid)) candidates.push(ring.get(kid));
  else if (!kid) {
    // 旧格式：优先当前密钥，再试其余（轮换兼容）
    if (ring.has(primaryKid)) candidates.push(ring.get(primaryKid));
    for (const [k, v] of ring) if (k !== primaryKid) candidates.push(v);
  }
  for (const key of candidates) {
    const out = tryDecrypt(key, ivHex, tagHex, ctHex);
    if (out !== null) return out;
  }
  console.warn('[crypto-util] decrypt 失败（无匹配密钥或数据损坏），按空串处理' + (kid ? '（kid=' + kid + '）' : ''));
  return '';
}

module.exports = { encrypt, decrypt, keyInfo, resetKeyCache, keyFilePath, kidOf, primaryKey };
