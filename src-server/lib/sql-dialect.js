/**
 * U2-1 / N7-P4 信创 DAL —— SQL 方言适配层
 *
 * 目的：让上层 SQL（当前以 SQLite 语法为主）可在国产数据库上执行。提供把 SQLite 专有构造
 *       翻译为达梦（dm）/ 人大金仓（kingbase，PG 系）等价语法的能力；默认 sqlite 方言下
 *       为恒等转换（不改变任何 SQL，保证零回归）。
 *
 * 设计原则：
 *   - 默认 sqlite 方言恒等返回，回归行为不变；
 *   - 逐构造覆盖、可单测；未知/未映射的 SQLite 专有构造显式产出 warning（不静默）；
 *   - 仅做「可机械改写」的映射；语义复杂的改写（如 UPDATE ... LIMIT）不臆造，转 warning。
 */
'use strict';

/* ---------------- 通用规则（dm / kingbase 共有） ---------------- */

const COMMON_RULES = [
  // 当前时间：SQLite datetime('now','localtime') / datetime('now') → 标准 CURRENT_TIMESTAMP
  { re: /datetime\(\s*'now'\s*(?:,\s*'localtime'\s*)?\)/gi, to: 'CURRENT_TIMESTAMP' },
  { re: /\bdate\(\s*'now'\s*(?:,\s*'localtime'\s*)?\)/gi, to: 'CURRENT_DATE' },
  // IFNULL → COALESCE（三者等价）
  { re: /\bIFNULL\s*\(/gi, to: 'COALESCE(' },
  // 反引号标识符 → 双引号（SQLite 与 PG/dm 均支持双引号；反引号非标准）
  { re: /`([^`]+)`/g, to: '"$1"' },
];

/* ---------------- 方言定义 ---------------- */

const DIALECTS = {
  // 默认：恒等（不翻译任何内容）
  sqlite: { name: 'sqlite', label: 'SQLite（默认）', rules: [], unsupported: [] },

  // 达梦 DM8
  dm: {
    name: 'dm',
    label: '达梦 DM8',
    rules: [
      // INTEGER PRIMARY KEY AUTOINCREMENT → INT IDENTITY(1,1) PRIMARY KEY
      { re: /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, to: 'INT IDENTITY(1,1) PRIMARY KEY' },
      // 搜索型 LIKE 的大小写：DM 默认区分，保留原样
      ...COMMON_RULES,
    ],
    unsupported: [
      { name: 'strftime()', re: /\bstrftime\s*\(/i },
      { name: 'julianday()', re: /\bjulianday\s*\(/i },
      { name: 'printf()', re: /\bprintf\s*\(/i },
      { name: 'randomblob()', re: /\brandomblob\s*\(/i },
      { name: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/i },
      { name: 'PRAGMA', re: /\bPRAGMA\b/i },
    ],
  },

  // 人大金仓 KingbaseES（PostgreSQL 兼容）
  kingbase: {
    name: 'kingbase',
    label: '人大金仓 KingbaseES',
    rules: [
      // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
      { re: /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, to: 'SERIAL PRIMARY KEY' },
      // 单独的整型自增列（无 PRIMARY KEY 紧跟）
      { re: /\bINTEGER\s+AUTOINCREMENT\b/gi, to: 'SERIAL' },
      ...COMMON_RULES,
    ],
    unsupported: [
      { name: 'strftime()', re: /\bstrftime\s*\(/i },
      { name: 'julianday()', re: /\bjulianday\s*\(/i },
      { name: 'printf()', re: /\bprintf\s*\(/i },
      { name: 'randomblob()', re: /\brandomblob\s*\(/i },
      { name: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/i },
      { name: 'PRAGMA', re: /\bPRAGMA\b/i },
    ],
  },
};

/** 方言名列表 */
function dialects() { return Object.keys(DIALECTS); }

/** 是否为已知方言 */
function isKnown(name) { return Object.prototype.hasOwnProperty.call(DIALECTS, name); }

/** 取方言定义（未知时回退 sqlite，保持零回归） */
function getDialect(name) {
  const key = String(name || 'sqlite').toLowerCase();
  return DIALECTS[key] || DIALECTS.sqlite;
}

/**
 * 翻译 SQL 到目标方言。
 * @param {string} sql SQL 文本（SQLite 语法）
 * @param {string} [dialectName='sqlite']
 * @returns {{sql:string, warnings:string[], dialect:string}}
 */
function translate(sql, dialectName = 'sqlite') {
  const d = getDialect(dialectName);
  let out = String(sql == null ? '' : sql);
  const warnings = [];

  if (d.name === 'sqlite') return { sql: out, warnings, dialect: d.name };

  // --- 复合语句：INSERT OR IGNORE / INSERT OR REPLACE 的语义等价改写 ---
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
    if (d.name === 'kingbase') {
      out = appendClause(out, 'ON CONFLICT DO NOTHING');
    } else {
      warnings.push('INSERT OR IGNORE：达梦缺少等价语法，已降级为普通 INSERT，去重需依赖唯一约束 + 应用层判定');
    }
  }
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT');
    if (d.name === 'kingbase') {
      warnings.push('INSERT OR REPLACE：金仓需 ON CONFLICT (...) DO UPDATE SET ...，缺少冲突目标，未自动改写');
    } else {
      warnings.push('INSERT OR REPLACE：达梦需改写为 MERGE，未自动改写');
    }
  }

  // --- 正则规则逐条应用 ---
  for (const r of d.rules) out = out.replace(r.re, r.to);

  // --- 未映射构造告警 ---
  for (const p of d.unsupported) {
    if (p.re.test(out)) warnings.push(`未映射的 SQLite 专有构造：${p.name}（请人工确认 ${d.label} 等价写法）`);
  }

  return { sql: out, warnings, dialect: d.name };
}

/** 在语句末尾（分号之前）追加子句 */
function appendClause(sql, clause) {
  const trimmed = sql.replace(/\s*;\s*$/, '');
  const semi = /;\s*$/.test(sql) ? ';' : '';
  return `${trimmed} ${clause}${semi}`;
}

module.exports = { dialects, isKnown, getDialect, translate, DIALECTS };
