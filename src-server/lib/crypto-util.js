/**
 * 加密工具：AES-256-GCM 加密/解密，用于存储敏感密钥（如 API Key）
 * 全局加密密钥从 SECRETS 表读取（如果未配置则返回空字符串，兜底行为不崩溃）
 *
 * P1-1 修复 2026-11-04：db 改为 loadEncryptionKey 内惰性 require——此前顶层
 * `const { db } = require('../db')` 与 db.js 的 api_key 迁移块构成加载期循环依赖
 * （db.js 执行中途 require 本模块 → 顶层解构拿到未赋值的 exports → db 恒 undefined，
 * secrets 用例 upsert→encrypt→db.prepare 崩溃导致整个测试套件中断）。惰性 require
 * 把取 db 的时机推迟到运行时调用，此时 db.js 必已完成加载。
 */
const crypto = require('crypto');

// 每次操作时重新读取，支持热更新
function loadEncryptionKey() {
  const { db } = require('../db'); // 惰性：运行时取（打破加载期循环依赖）
  const row = db.prepare("SELECT value FROM secrets WHERE name='ENCRYPTION_KEY'").pluck().get();
  // 密钥要求 32 字节，hex 编码就是 64 字符
  if (row && row.length === 64) return Buffer.from(row, 'hex');
  // 如果没有配置加密密钥，返回 null，不执行加密（兜底明文存储）
  return null;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // GCM 推荐 IV 长度

/**
 * AES-256-GCM 加密
 * @param {string} plaintext - 明文
 * @returns {string} base64 编码的密文（IV + authTag + ciphertext）
 */
function encrypt(plaintext) {
  const key = loadEncryptionKey();
  if (!key) return plaintext; // 未配置加密密钥时兜底明文（不推荐）
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  // 输出格式：IV (hex) + authTag (hex) + ciphertext (hex)
  return iv.toString('hex') + '.' + authTag.toString('hex') + '.' + encrypted;
}

/**
 * AES-256-GCM 解密
 * @param {string} encrypted - 密文（IV.authTag.ciphertext 三段 hex）或旧版明文
 * @returns {string} 明文；密文形态但解密失败（密钥轮换/数据损坏）返回空串
 *  P3-4 修复 2026-11-09：原实现 catch 后返回原字符串——密钥轮换后 "iv.authTag.ciphertext"
 *  密文串会被当作明文 API Key 使用发给上游（调用方无从分辨），现改为：
 *  ① 先做密文形态校验（恰好 3 段且前两段各 32 位 hex）——形态不像密文的一律按旧明文原样返回（兼容历史明文数据）；
 *  ② 形态是密文但解密失败 → 返回空串 + console.warn（宁缺勿错，上游会按 Key 无效失败而非拿到密文串）。
 */
function decrypt(encrypted) {
  const key = loadEncryptionKey();
  const str = String(encrypted ?? '');
  if (!key) return str; // 未配置加密密钥时兜底返回原文（未加密的旧数据，encrypt 同环境也只存明文）
  const parts = str.split('.');
  const looksEncrypted = parts.length === 3
    && /^[0-9a-f]{32}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[1])
    && /^[0-9a-f]+$/i.test(parts[2]) && parts[2].length > 0;
  if (!looksEncrypted) return str; // 旧明文（含不含点/形态不符的值）原样返回
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    // 解密失败（密钥变更或数据损坏）：返回空串并告警，避免密文被当明文外发上游
    console.warn('[crypto-util] decrypt 失败（密钥不匹配或数据损坏），按空串处理：' + (e && e.message));
    return '';
  }
}

module.exports = { encrypt, decrypt };
