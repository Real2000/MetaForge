/**
 * 审计日志写入层（SEC-11 防篡改哈希链 + UTC · SEC-12 强制脱敏，M2 批次4）
 *
 * 设计目标：把「日志写入」收敛为唯一可控出口——无论调用方是谁（哪怕直接
 * `db.prepare('INSERT INTO op_logs …')`），只要写入 op_logs / security_events，
 * 都强制经过本层的脱敏与哈希链，无法绕过：
 *
 *   installGuard(db)  在 db.js 装配期调用一次：包装 db.prepare，凡命中
 *                     `INSERT INTO op_logs|security_events (…cols…) VALUES (…)` 的语句，
 *                     返回受控 statement（.run() 落库前统一处理）。
 *
 *   受控落库（auditInsert）：
 *     ① SEC-12：所有字符串字段过 maskSecrets + maskPII（密钥/PII 落库前掩码）；
 *     ② SEC-11：created_at 统一写 UTC ISO8601（形如 2026-11-22T14:05:00Z）；
 *     ③ SEC-11：写 prev_hash（上一行 record_hash，首行 GENESIS）与 record_hash =
 *               sha256(prev_hash + '|' + 规范化JSON(实际存储行))，构成防篡改链。
 *        record_hash 以「回读实际存储值」计算，保证写入端与校验端逐字节一致。
 *
 *   verifyChain(db, table) 重算链，定位首个被篡改行（供脚本/回归使用）。
 *
 * 兼容：历史行（升级前）record_hash 为空——校验时跳过，仅对启用链后的行校验。
 */
const crypto = require('crypto');

const CHAIN_TABLES = ['op_logs', 'security_events'];
const GENESIS = '0'.repeat(64);

let _maskers = null;
/** 惰性取掩码函数（避免与 secrets.js/security.js 的加载期循环依赖） */
function maskers() {
  if (_maskers) return _maskers;
  let maskSecrets = (s) => s, maskPII = (s) => s;
  try { maskSecrets = require('./secrets').maskSecrets; } catch { /* 极端加载顺序下降级 */ }
  try { maskPII = require('./security').maskPII; } catch { }
  _maskers = { maskSecrets, maskPII };
  return _maskers;
}

/** SEC-12：单值脱敏（非字符串原样透传） */
function sanitizeValue(v) {
  if (typeof v !== 'string') return v;
  const { maskSecrets, maskPII } = maskers();
  try { return maskPII(maskSecrets(v)); } catch { return v; }
}

/** SEC-11：UTC ISO8601（秒精度，形如 2026-11-22T14:05:00Z） */
function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 规范化：仅取指定列、键名升序、undefined→null，保证两端 JSON 完全一致 */
function canonical(row, cols) {
  const o = {};
  for (const c of cols.slice().sort()) o[c] = row[c] === undefined ? null : row[c];
  return JSON.stringify(o);
}

/** 返回 s[openIdx]='(' 对应的 ')' 下标（支持嵌套括号，忽略字符串字面量）；无匹配返回 -1 */
function matchParen(s, openIdx) {
  let depth = 0, inStr = null;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 按顶层逗号切分（深度 0，忽略括号内与字符串内逗号） */
function splitTop(s) {
  const out = [];
  let depth = 0, inStr = null, cur = '';
  for (const ch of s) {
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 解析 INSERT 语句：
 *   仅接受单行插入 op_logs/security_events；占位符须为 `?`（created_at 列允许为函数/字面量，将被覆盖为 UTC）。
 *   返回 { table, cols, argIndex }（argIndex[k]：该列对应的参数下标，-1 表示无参占位）；
 *   不安全/不匹配返回 null（回落原语句，不接管）。
 */
function parseInsert(sql) {
  const s = String(sql);
  const head = /^\s*INSERT\s+INTO\s+(op_logs|security_events)\s*\(/i.exec(s);
  if (!head) return null;
  const table = head[1].toLowerCase();
  const colsEnd = matchParen(s, head[0].length - 1);
  if (colsEnd < 0) return null;
  const colsPart = s.slice(head[0].length, colsEnd);
  const rest = s.slice(colsEnd + 1);
  const vMatch = /\bVALUES\s*\(/i.exec(rest);
  if (!vMatch) return null;
  const openParen = vMatch.index + vMatch[0].length - 1;
  const valEnd = matchParen(rest, openParen);
  if (valEnd < 0) return null;
  if (rest.slice(valEnd + 1).trim().replace(/;$/, '').trim() !== '') return null; // 尾随内容 → 不接管
  const cols = splitTop(colsPart).map((c) => c.trim().replace(/["'`[\]]/g, '')).filter(Boolean);
  const vals = splitTop(rest.slice(openParen + 1, valEnd)).map((v) => v.trim());
  if (vals.length !== cols.length) return null;
  if (cols.includes('prev_hash') || cols.includes('record_hash')) return null; // 本层已写出，避免自接管
  const argIndex = [];
  let cursor = 0, safe = true;
  vals.forEach((p, i) => {
    if (p === '?') argIndex.push(cursor++);
    else if (cols[i] === 'created_at') argIndex.push(-1); // 覆盖为 UTC
    else safe = false;
  });
  if (!safe) return null;
  return { table, cols, argIndex };
}

/**
 * 受控落库：脱敏 → UTC → requestId 注入（BE-F1）→ 写入 → 回读实际行计算哈希链并回填。
 * @param {Function} prepareRaw db 的**原始** prepare（installGuard 闭包传入，避免自递归）
 */
const { currentRequestId } = require('./request-context');
// BE-F1：request_id 为日志链关联键而非审计内容，不参与哈希链（写入端/校验端同步排除，
// 避免迁移加列后旧行 canonical 变化导致 verifyChain 误报篡改）
const NON_HASH_COLS = ['id', 'prev_hash', 'record_hash', 'request_id'];
/** 目标表是否有 request_id 列（每次探测不做长缓存：BE-E1 down/up 窗口后仍新鲜；
 *  旧 schema 表（如独立内存库/未迁移库）返回 false → 降级不注入，审计写入永不因关联键缺失而失败） */
function hasRidColumn(prepareRaw, table) {
  try {
    const cols = prepareRaw(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === 'request_id');
  } catch { return false; }
}
function auditInsert(prepareRaw, table, cols, argIndex, args) {
  const row = {};
  cols.forEach((c, i) => { row[c] = argIndex[i] < 0 ? null : args[argIndex[i]]; });
  // ① 脱敏
  for (const k of Object.keys(row)) row[k] = sanitizeValue(row[k]);
  // ② UTC 时间（created_at 一律覆盖）
  if (cols.includes('created_at')) row.created_at = utcNow();
  // ②' BE-F1：请求上下文内自动补 request_id（列已就位才注入——旧 schema 表降级不注入，兼容独立测试库/未迁移库）
  const ridCol = (table === 'op_logs' || table === 'security_events') && hasRidColumn(prepareRaw, table);
  const rid = currentRequestId();
  if (ridCol && rid && !cols.includes('request_id')) row.request_id = rid;
  // prev_hash：链上一条（写入前查询，不含本行）
  const prevRow = prepareRaw(`SELECT record_hash FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  const prevHash = (prevRow && prevRow.record_hash) || GENESIS;
  // 插入（record_hash 依赖实际存储值，先留默认空串，回读后再回填）
  const insCols = ridCol ? [...cols, 'request_id', 'prev_hash'] : [...cols, 'prev_hash'];
  row.prev_hash = prevHash;
  const vals = insCols.map((c) => (row[c] === undefined ? null : row[c]));
  const info = prepareRaw(`INSERT INTO ${table} (${insCols.join(',')}) VALUES (${insCols.map(() => '?').join(',')})`).run(...vals);
  const id = info.lastInsertRowid;
  // ③ 回读实际存储行 → 计算 record_hash → 回填（request_id 不参与哈希）
  const stored = prepareRaw(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (stored) {
    const ccols = Object.keys(stored).filter((c) => !NON_HASH_COLS.includes(c));
    const rec = sha256(prevHash + '|' + canonical(stored, ccols));
    prepareRaw(`UPDATE ${table} SET record_hash=? WHERE id=?`).run(rec, id);
  }
  return info;
}

/** 装配守卫：包装 db.prepare 拦截 op_logs/security_events 插入（幂等） */
function installGuard(db) {
  if (!db || db.__auditGuarded) return false;
  const orig = db.prepare.bind(db);
  db.prepare = function (sql) {
    const ins = parseInsert(sql);
    if (!ins || !CHAIN_TABLES.includes(ins.table)) return orig(sql);
    return {
      run: (...args) => auditInsert(orig, ins.table, ins.cols, ins.argIndex, args),
      get: () => undefined,
      all: () => [],
      pluck() { return this; },
      iterate() { return []; },
      raw() { return this; },
      bind() { return this; },
    };
  };
  Object.defineProperty(db, '__auditGuarded', { value: true, enumerable: false });
  return true;
}

/**
 * 校验哈希链：返回 { ok, checked, brokenAt }。brokenAt=首个不匹配行的 id。
 * 仅校验 record_hash 非空的行（历史行跳过）。
 */
function verifyChain(db, table) {
  if (!CHAIN_TABLES.includes(table)) throw new Error('verifyChain 仅支持：' + CHAIN_TABLES.join(' / '));
  const rows = db.prepare(`SELECT * FROM ${table} WHERE record_hash IS NOT NULL AND record_hash != '' ORDER BY id ASC`).all();
  let prev = GENESIS, brokenAt = null;
  for (const r of rows) {
    // BE-F1：request_id 不参与哈希（与 auditInsert 写入端一致；否则迁移后旧行全部误报篡改）
    const cols = Object.keys(r).filter((c) => !NON_HASH_COLS.includes(c));
    const rec = sha256(prev + '|' + canonical(r, cols));
    if (r.prev_hash !== prev || r.record_hash !== rec) { brokenAt = r.id; break; }
    prev = r.record_hash;
  }
  return { ok: brokenAt === null, checked: rows.length, brokenAt };
}

module.exports = { installGuard, verifyChain, CHAIN_TABLES, GENESIS, utcNow, sanitizeValue, parseInsert };
