/**
 * 通用密钥管理（P5.5：画布 {{env.XXX}} 占位符运行时注入）
 * - secrets 表存密钥（仅管理员可写）；内存缓存 60s
 * - 任何接口不回读明文；日志/inputs 落库前用 maskSecrets 脱敏
 * 
 * V2.4 #4 收尾：敏感密钥加密存储。存储时对值进行 AES-256-GCM 加密，
 * 读取时自动解密。ENCRYPTION_KEY 自身不加密（它是加密密钥自身）。
 */
const { db } = require('../db');
const { encrypt, decrypt } = require('./crypto-util'); // V2.4 #4 加密工具

const CACHE_TTL = 60 * 1000;
let cache = null, cacheAt = 0;

/** 全量密钥名→值（缓存，值已解密） */
function loadSecrets() {
  if (cache && Date.now() - cacheAt < CACHE_TTL) return cache;
  const rows = db.prepare('SELECT name, value FROM secrets').all();
  // V2.4 #4：对加密的值进行解密；ENCRYPTION_KEY 自身不解密（保持明文）
  cache = Object.fromEntries(rows.map(r => [
    r.name,
    r.name === 'ENCRYPTION_KEY' ? r.value : decrypt(r.value)
  ]));
  cacheAt = Date.now();
  return cache;
}

/** 清缓存（写入/删除后调用） */
function invalidate() { cache = null; cacheAt = 0; }

/** 渲染 {{env.NAME}}：查不到的保留原样（便于发现配置缺失） */
function renderEnv(tpl) {
  return String(tpl ?? '').replace(/\{\{\s*env\.([\w.-]+)\s*\}\}/g, (m, name) => {
    const v = loadSecrets()[name];
    return v === undefined ? m : String(v);
  });
}

/** 列出全部密钥名（管理页用；不含值） */
function listNames() {
  return db.prepare('SELECT id, name, remark, created_at, updated_at, length(value) AS len FROM secrets ORDER BY name').all();
}

/** 写入/更新（值非空才更新；空值=删除） */
function upsert(name, value, remark) {
  const old = db.prepare('SELECT id FROM secrets WHERE name=?').get(name);
  if (value == null || value === '') {
    if (old) db.prepare('DELETE FROM secrets WHERE id=?').run(old.id);
    invalidate();
    return old ? 'deleted' : 'noop';
  }
  // V2.4 #4：对值加密后存储；ENCRYPTION_KEY 自身不加密（保持明文）
  const storedValue = name === 'ENCRYPTION_KEY' ? value : encrypt(value);
  if (old) db.prepare("UPDATE secrets SET value=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?").run(storedValue, remark || old.remark || '', old.id);
  else db.prepare("INSERT INTO secrets (name, value, remark, created_at, updated_at) VALUES (?,?,?,datetime('now','localtime'),datetime('now','localtime'))").run(name, storedValue, remark || '');
  invalidate();
  return old ? 'updated' : 'created';
}

/**
 * 脱敏：把文本中出现的密钥值替换为 {{env.NAME}}（日志落库前调用，防泄露）
 * 长度 <4 的密钥不参与替换（避免误伤常见短词）
 */
function maskSecrets(text) {
  const secrets = loadSecrets();
  let out = String(text ?? '');
  for (const [name, value] of Object.entries(secrets)) {
    if (value && String(value).length >= 4 && out.includes(value)) {
      out = out.split(String(value)).join(`{{env.${name}}}`);
    }
  }
  return out;
}

module.exports = { loadSecrets, invalidate, renderEnv, listNames, upsert, maskSecrets };
