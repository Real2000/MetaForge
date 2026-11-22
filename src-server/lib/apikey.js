/**
 * API Key 哈希工具（SEC-02a 2026-11-22 安全止血）
 *
 * 背景：agent_api_keys.key 与 mcp_tokens.token 此前明文存储、列表接口回传完整明文、
 * openapi 明文比对——库泄露或列表接口越权即丢全部对外密钥。
 * 方案（D-3 决策）：改为 HMAC-SHA256(pepper, key) 存储哈希，列表仅回前缀掩码，创建时一次性回显完整 Key。
 *   - 不用 bcrypt/argon2（Key 为高熵随机串，无需慢哈希抗离线爆破）；
 *   - 不用随机盐（需逐行查询才可校验，HMAC 固定 pepper 支持按哈希直达索引查询）。
 * pepper 取值（稳定即可，跨重启须一致，否则历史 Key 全部失效）：
 *   AGENT_APIKEY_PEPPER 环境变量 > 主加密密钥（SEC-10：env/文件/DB 同源，AES 层 primaryKey）
 *   > data/secrets.json 的 jwt_secret。
 */
const crypto = require('crypto');

let _pepper = null;

function pepper() {
  if (_pepper) return _pepper;
  if (process.env.AGENT_APIKEY_PEPPER) return (_pepper = Buffer.from(process.env.AGENT_APIKEY_PEPPER));
  // 主选：主加密密钥（SEC-10 与加密层同源：环境变量 > 文件 > DB；已由 db.js 启动期保证存在，跨重启稳定）
  try {
    const { primaryKey } = require('./crypto-util');
    const k = primaryKey();
    if (k) return (_pepper = Buffer.from(k));
  } catch { /* 忽略：crypto-util 未就绪时回退 */ }
  // 兜底：JWT 密钥文件
  try {
    const fs = require('fs');
    const path = require('path');
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'secrets.json'), 'utf8'));
    if (j && j.jwt_secret) return (_pepper = Buffer.from(String(j.jwt_secret)));
  } catch { /* 忽略 */ }
  throw new Error('API Key 哈希 pepper 不可用：请配置 AGENT_APIKEY_PEPPER，或确保 ENCRYPTION_KEY / data/secrets.json 存在');
}

/** 计算 Key 的 HMAC-SHA256 哈希（hex，64 字符） */
function hashKey(key) {
  return crypto.createHmac('sha256', pepper()).update('apkey:' + String(key)).digest('hex');
}

/** 生成前缀掩码（列表展示用，绝不包含可用于调用认证的完整值） */
function maskPrefix(key) {
  const s = String(key || '');
  if (s.length <= 8) return '****';
  return s.slice(0, 8) + '****' + s.slice(-4);
}

/** 判断某值是否为本模块产出的哈希形态（用于存量明文迁移判定） */
function looksHashed(v) {
  return /^[0-9a-f]{64}$/i.test(String(v || ''));
}

module.exports = { hashKey, maskPrefix, looksHashed, pepper };
