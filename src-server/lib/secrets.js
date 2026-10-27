/**
 * 通用密钥管理（P5.5：画布 {{env.XXX}} 占位符运行时注入）
 * - secrets 表存密钥（仅管理员可写）；内存缓存 60s
 * - 任何接口不回读明文；日志/inputs 落库前用 maskSecrets 脱敏
 */
const { db } = require('../db');

const CACHE_TTL = 60 * 1000;
let cache = null, cacheAt = 0;

/** 全量密钥名→值（缓存） */
function loadSecrets() {
  if (cache && Date.now() - cacheAt < CACHE_TTL) return cache;
  const rows = db.prepare('SELECT name, value FROM secrets').all();
  cache = Object.fromEntries(rows.map(r => [r.name, r.value]));
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
  if (old) db.prepare("UPDATE secrets SET value=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?").run(value, remark || old.remark || '', old.id);
  else db.prepare("INSERT INTO secrets (name, value, remark, created_at, updated_at) VALUES (?,?,?,datetime('now','localtime'),datetime('now','localtime'))").run(name, value, remark || '');
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
