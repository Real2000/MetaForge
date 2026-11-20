/**
 * D1-4 技能密钥管理（2026-11-21）
 *
 * 按「用户 × 技能」隔离的技能凭据存储：
 *   - 值 AES-256-GCM 加密落盘（复用 crypto-util，与 user_tool_keys / user_providers 同一套）；
 *   - 任何接口只回掩码（头3尾2），绝不回明文；
 *   - 运行期由 skill-runner 调用 getSecretsForRun 解密注入沙箱（内存态，不落日志）；
 *   - 输出脱敏 scrub：把明文值替换为 ***（防被技能代码回显进 stdout 而泄露）。
 *
 * 与全局 secrets 表（管理员画布 {{env.XXX}} 占位符）语义分离——那套是平台级、仅管理员可写；
 * 本模块是用户级、每个用户为自己的技能各配各的。
 */
const { db, now } = require('../db');
const { encrypt, decrypt } = require('./crypto-util');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isValidName(name) { return NAME_RE.test(String(name || '')); }

/** 掩码：仅回示头 3 尾 2，中间固定 ****（与 tool-keys 同款隐私口径） */
function maskValue(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (s.length <= 5) return '****';
  return s.slice(0, 3) + '****' + s.slice(-2);
}

/** 写入/更新（owner×skill×name 唯一）；值非空 */
function setSecret(owner, skillId, name, value) {
  const n = String(name || '').trim();
  if (!isValidName(n)) return { ok: false, msg: '密钥名仅支持字母/数字/下划线，字母或下划线开头，≤64 字符' };
  if (value == null || String(value) === '') return { ok: false, msg: '密钥值不能为空' };
  const old = db.prepare('SELECT id FROM skill_secrets WHERE owner=? AND skill_id=? AND name=?').get(owner, skillId, n);
  const enc = encrypt(String(value));
  if (old) {
    db.prepare("UPDATE skill_secrets SET value=?, updated_at=datetime('now','localtime') WHERE id=?").run(enc, old.id);
    return { ok: true, action: 'updated', name: n };
  }
  db.prepare("INSERT INTO skill_secrets (owner, skill_id, name, value, created_at, updated_at) VALUES (?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))")
    .run(owner, skillId, n, enc);
  return { ok: true, action: 'created', name: n };
}

/** 删除 */
function deleteSecret(owner, skillId, name) {
  const r = db.prepare('DELETE FROM skill_secrets WHERE owner=? AND skill_id=? AND name=?').run(owner, skillId, String(name || ''));
  return r.changes > 0;
}

/** 列出密钥（掩码回显，绝不回明文）：[{ name, masked, updated_at }] */
function listSecrets(owner, skillId) {
  return db.prepare('SELECT name, value, updated_at FROM skill_secrets WHERE owner=? AND skill_id=? ORDER BY name')
    .all(owner, skillId)
    .map(r => ({ name: r.name, masked: maskValue(decrypt(r.value)), has_value: !!r.value, updated_at: r.updated_at }));
}

/** 运行期取用（明文；仅供 skill-runner 注入沙箱）：{ name: plaintext } */
function getSecretsForRun(owner, skillId) {
  const out = {};
  for (const r of db.prepare('SELECT name, value FROM skill_secrets WHERE owner=? AND skill_id=?').all(owner, skillId)) {
    const v = decrypt(r.value);
    if (v) out[r.name] = v;
  }
  return out;
}

/** 删除某技能的全部密钥（技能删除时级联） */
function purgeSkill(owner, skillId) {
  db.prepare('DELETE FROM skill_secrets WHERE owner=? AND skill_id=?').run(owner, skillId);
}

/**
 * 输出脱敏：把文本中出现的明文密钥值替换为 ***（防技能把凭据回显进 stdout/stderr）。
 * 长度 <4 的值不参与替换（避免误伤常见短词）。
 */
function scrub(text, values) {
  let out = String(text == null ? '' : text);
  for (const v of values || []) {
    const s = String(v || '');
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

module.exports = { isValidName, maskValue, setSecret, deleteSecret, listSecrets, getSecretsForRun, purgeSkill, scrub };
