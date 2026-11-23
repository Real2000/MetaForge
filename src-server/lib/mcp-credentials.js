/**
 * D2-4 连接器凭证托管（2026-11-21）
 *
 * MCP 服务 / 异构平台的凭据统一托管，按「服务 id」隔离：
 *   - 值 AES-256-GCM 加密落盘（复用 crypto-util，与 user_tool_keys / skill_secrets 同一套）；
 *   - 任何接口只回掩码（头3尾2），绝不回明文；
 *   - 连接期由 routes/lib 解密注入（内存态，不落日志）；
 *   - 输出脱敏 scrub：把明文值替换为 ***（防被工具回显泄露）。
 *
 * 与 lib/secrets.js（平台级 {{env.XXX}}）、skill-secrets.js（owner×skill）语义分离：
 * 本模块是「连接器级」、全局服务一份，仅管理员可写。
 */
const { db, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { encrypt, decrypt } = require('./crypto-util');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isValidName(name) { return NAME_RE.test(String(name || '')); }

/** 掩码：仅回示头 3 尾 2，中间固定 ****（与 tool-keys / skill-secrets 同款隐私口径） */
function maskValue(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (s.length <= 5) return '****';
  return s.slice(0, 3) + '****' + s.slice(-2);
}

/** 写入/更新（server_id × name 唯一）；值非空 */
function setSecret(serverId, name, value) {
  const n = String(name || '').trim();
  if (!isValidName(n)) return { ok: false, msg: '凭据名仅支持字母/数字/下划线，字母或下划线开头，≤64 字符' };
  if (value == null || String(value) === '') return { ok: false, msg: '凭据值不能为空' };
  const old = dal.getq('SELECT id FROM mcp_credentials WHERE server_id=? AND name=?', [serverId, n]);
  const enc = encrypt(String(value));
  if (old) {
    dal.runq("UPDATE mcp_credentials SET value=?, updated_at=datetime('now','localtime') WHERE id=?", [enc, old.id]);
    return { ok: true, action: 'updated', name: n };
  }
  dal.runq("INSERT INTO mcp_credentials (server_id, name, value, created_at, updated_at) VALUES (?,?,?,datetime('now','localtime'),datetime('now','localtime'))", [serverId, n, enc]);
  return { ok: true, action: 'created', name: n };
}

/** 删除 */
function deleteSecret(serverId, name) {
  const r = dal.runq('DELETE FROM mcp_credentials WHERE server_id=? AND name=?', [serverId, String(name || '')]);
  return r.changes > 0;
}

/** 列出凭据（掩码回显，绝不回明文）：[{ name, masked, has_value, updated_at }] */
function listSecrets(serverId) {
  return dal.q('SELECT name, value, updated_at FROM mcp_credentials WHERE server_id=? ORDER BY name', [serverId])
    .map(r => ({ name: r.name, masked: maskValue(decrypt(r.value)), has_value: !!r.value, updated_at: r.updated_at }));
}

/** 连接期取用（明文；仅供服务端注入）：{ name: plaintext } */
function getSecrets(serverId) {
  const out = {};
  for (const r of dal.q('SELECT name, value FROM mcp_credentials WHERE server_id=?', [serverId])) {
    const v = decrypt(r.value);
    if (v) out[r.name] = v;
  }
  return out;
}

/** 删除某服务的全部凭据（服务删除时级联） */
function purgeServer(serverId) {
  dal.runq('DELETE FROM mcp_credentials WHERE server_id=?', [serverId]);
}

// 作为 Bearer 令牌使用的凭据名（按优先级）
const API_KEY_NAMES = ['api_key', 'bearer_token', 'token', 'access_token'];

/**
 * 解析服务「有效 Bearer 令牌」：优先取托管凭据（api_key/bearer_token/... 解密），
 * 回落旧字段 mcp_servers.api_key（历史明文，兼容存量）。
 */
function effectiveApiKey(server) {
  if (server && server.id) {
    try {
      const creds = getSecrets(server.id);
      for (const n of API_KEY_NAMES) if (creds[n]) return creds[n];
    } catch { /* 表未就绪时静默回落 */ }
  }
  return (server && server.api_key) || '';
}

/** URL 占位符渲染：把 {name} 替换为凭据值（未提供的原样保留） */
function renderUrl(url, creds) {
  return String(url || '').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) =>
    (creds && creds[name] != null ? String(creds[name]) : m));
}

/**
 * 输出脱敏：把文本中出现的明文凭据值替换为 ***（防回显泄露）。长度 <4 的值不参与替换。
 */
function scrub(text, values) {
  let out = String(text == null ? '' : text);
  for (const v of values || []) {
    const s = String(v || '');
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

module.exports = {
  isValidName, maskValue, setSecret, deleteSecret, listSecrets, getSecrets,
  purgeServer, effectiveApiKey, renderUrl, scrub, API_KEY_NAMES,
};
