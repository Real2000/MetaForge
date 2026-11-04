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
 * @param {string} encrypted - base64 编码的密文（IV + authTag + ciphertext）
 * @returns {string} 明文，如果解密失败返回空字符串
 */
function decrypt(encrypted) {
  const key = loadEncryptionKey();
  if (!key) return encrypted; // 未配置加密密钥时兜底返回原文（未加密的旧数据）
  try {
    const parts = encrypted.split('.');
    if (parts.length < 3) {
      // 格式不对，可能是未加密的旧数据，原文返回
      return encrypted;
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    // 解密失败（密钥变更或数据损坏）返回原字符串，避免阻塞业务
    return encrypted;
  }
}

module.exports = { encrypt, decrypt };
