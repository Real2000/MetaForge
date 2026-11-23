/**
 * 通用密钥管理（P5.5：画布 {{env.XXX}} 占位符运行时注入）
 * - secrets 表存密钥（仅管理员可写）；内存缓存 60s
 * - 任何接口不回读明文；日志/inputs 落库前用 maskSecrets 脱敏
 *
 * V2.4 #4 收尾：敏感密钥加密存储。存储时对值进行 AES-256-GCM 加密，
 * 读取时自动解密。ENCRYPTION_KEY 自身不加密（它是加密密钥自身）。
 *
 * MT-12（2026-11-22）租户级密钥隔离：
 *   - tenant_id=0 → 平台全局基线（全租户可见，平台超管维护；ENCRYPTION_KEY 等基础设施密钥归此层）
 *   - tenant_id>0 → 租户专有覆盖层（仅该租户可见，覆盖同名平台基线）
 *   - 运行时 loadSecrets(tenantId) = 平台基线 ∪ 租户专有（后者覆盖同名）；默认 tenantId=0（=仅平台基线，零回归）
 *   - 管理视角 listNames(tenantId) 仅返回该租户层自身密钥（租户 A 的密钥租户 B 不可见）
 *   - 唯一键为 (name, tenant_id)，同一密钥名可在不同租户各自定义
 */
const { db } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { encrypt, decrypt, resetKeyCache } = require('./crypto-util'); // V2.4 #4 加密工具（resetKeyCache：SEC-10 密钥热更新）

const CACHE_TTL = 60 * 1000;
const _cache = new Map();      // tenantId -> { data, at }
let _unionCache = null, _unionAt = 0; // 全量并集（脱敏用）

/** 规范化租户号：非负整数，缺省 0（平台全局） */
function normTenant(tenantId) {
  const n = Number(tenantId);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 读取某租户层原始行（含解密） */
function _loadTier(tenantId) {
  const rows = dal.q('SELECT name, value FROM secrets WHERE tenant_id=?', [tenantId]);
  const obj = {};
  for (const r of rows) {
    obj[r.name] = r.name === 'ENCRYPTION_KEY' ? r.value : decrypt(r.value);
  }
  return obj;
}

/**
 * 某租户可见的密钥 map（运行时注入用）。
 * 平台全局(0) 为基，租户专有(tenantId) 覆盖同名。默认 tenantId=0 → 返回平台基线。
 * @param {number} [tenantId]
 * @returns {Object<string,string>}
 */
function loadSecrets(tenantId) {
  const tid = normTenant(tenantId);
  const hit = _cache.get(tid);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  let data;
  if (tid === 0) {
    data = _loadTier(0);
  } else {
    data = Object.assign({}, _loadTier(0), _loadTier(tid)); // 平台基线 + 租户覆盖
  }
  _cache.set(tid, { data, at: Date.now() });
  return data;
}

/** 清缓存（写入/删除后调用） */
function invalidate() { _cache.clear(); _cacheAtReset(); }
function _cacheAtReset() { _unionCache = null; _unionAt = 0; }

/** 渲染 {{env.NAME}}：查不到的保留原样（便于发现配置缺失）。tenantId 缺省 0（平台基线）。 */
function renderEnv(tpl, tenantId) {
  return String(tpl ?? '').replace(/\{\{\s*env\.([\w.-]+)\s*\}\}/g, (m, name) => {
    const v = loadSecrets(tenantId)[name];
    return v === undefined ? m : String(v);
  });
}

/** 列出某租户层自身的密钥名（管理页用；不含值）。默认 0=平台全局层。 */
function listNames(tenantId) {
  const tid = normTenant(tenantId);
  return dal.q('SELECT id, name, remark, created_at, updated_at, tenant_id, length(value) AS len FROM secrets WHERE tenant_id=? ORDER BY name', [tid]);
}

/**
 * 写入/更新（值非空才更新；空值=删除）。按 (name, tenant_id) 定位。
 * @param {string} name
 * @param {string} value 空=删除
 * @param {string} [remark]
 * @param {number} [tenantId] 默认 0（平台全局）
 */
function upsert(name, value, remark, tenantId) {
  const tid = normTenant(tenantId);
  const old = dal.getq('SELECT id FROM secrets WHERE name=? AND tenant_id=?', [name, tid]);
  if (value == null || value === '') {
    if (old) dal.runq('DELETE FROM secrets WHERE id=?', [old.id]);
    invalidate();
    if (name === 'ENCRYPTION_KEY') { try { resetKeyCache(); } catch { /* 忽略 */ } }
    return old ? 'deleted' : 'noop';
  }
  // V2.4 #4：对值加密后存储；ENCRYPTION_KEY 自身不加密（保持明文）
  const storedValue = name === 'ENCRYPTION_KEY' ? value : encrypt(value);
  if (old) dal.runq("UPDATE secrets SET value=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?", [storedValue, remark || old.remark || '', old.id]);
  else dal.runq("INSERT INTO secrets (name, value, remark, tenant_id, created_at, updated_at) VALUES (?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))", [name, storedValue, remark || '', tid]);
  invalidate();
  // SEC-10：ENCRYPTION_KEY 变更后立即失效 crypto-util 密钥缓存，保证热更新（否则 60s 内仍用旧钥）
  if (name === 'ENCRYPTION_KEY') { try { resetKeyCache(); } catch { /* 忽略 */ } }
  return old ? 'updated' : 'created';
}

/**
 * 脱敏：把文本中出现的密钥值替换为 {{env.NAME}}（日志落库前调用，防泄露）
 * 采用跨全部租户的并集（宁可多掩码也不漏），长度 <4 的密钥不参与替换（避免误伤常见短词）
 */
function maskSecrets(text) {
  let union;
  if (_unionCache && Date.now() - _unionAt < CACHE_TTL) union = _unionCache;
  else {
    union = _loadTier(0);
    const tenants = dal.q('SELECT DISTINCT tenant_id FROM secrets WHERE tenant_id != 0');
    for (const t of tenants) Object.assign(union, _loadTier(t.tenant_id));
    _unionCache = union; _unionAt = Date.now();
  }
  let out = String(text ?? '');
  for (const [name, value] of Object.entries(union)) {
    if (value && String(value).length >= 4 && out.includes(value)) {
      out = out.split(String(value)).join(`{{env.${name}}}`);
    }
  }
  return out;
}

module.exports = { loadSecrets, invalidate, renderEnv, listNames, upsert, maskSecrets };
