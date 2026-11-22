#!/usr/bin/env node
/**
 * BE-C2 SQL 方言闭环审计（2026-11-22）
 *
 * 静态扫描 src-server 下的 SQL 文本，统计 SQLite 专有构造的分布，用于度量
 * BE-C2「清零 PRAGMA / strftime / INSERT OR IGNORE / REPLACE；收敛 lastInsertRowid / AUTOINCREMENT」
 * 的推进进度，并对 dm / kingbase 方言执行一次 translate 冒烟，暴露未映射构造。
 *
 * 用法：
 *   node scripts/dialect-audit.js            # 打印分布与 translate 冒烟
 *   node scripts/dialect-audit.js --json     # 输出 JSON
 *   node scripts/dialect-audit.js --strict   # 存在未映射构造时退出码 1（门禁）
 *
 * 说明：启发式扫描，不解析 SQL 语法树；仅统计「可机械识别」的构造。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlDialect = require('../src-server/lib/sql-dialect');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src-server'];

/** 构造清单（正则 → 名称 → 是否已有方言替代） */
const CONSTRUCTS = [
  { name: "datetime('now'…)", re: /datetime\(\s*'now'/gi, mapped: true, note: '→ CURRENT_TIMESTAMP' },
  { name: 'strftime()', re: /\bstrftime\s*\(/gi, mapped: true, note: '→ to_char / epoch' },
  { name: 'julianday()', re: /\bjulianday\s*\(/gi, mapped: false, note: '未映射，告警' },
  { name: 'printf()', re: /\bprintf\s*\(/gi, mapped: false, note: '未映射，告警' },
  { name: 'randomblob()', re: /\brandomblob\s*\(/gi, mapped: false, note: '未映射，告警' },
  { name: 'INSERT OR IGNORE', re: /\bINSERT\s+OR\s+IGNORE\b/gi, mapped: true, note: '→ ON CONFLICT DO NOTHING(kingbase)' },
  { name: 'INSERT OR REPLACE', re: /\bINSERT\s+OR\s+REPLACE\b/gi, mapped: false, note: '需冲突目标，告警' },
  { name: 'PRAGMA', re: /\bPRAGMA\b/gi, mapped: false, note: '框架层，不参与业务 SQL' },
  { name: 'lastInsertRowid', re: /\blastInsertRowid\b/g, mapped: false, note: '收敛到 DAL 抽象' },
  { name: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/gi, mapped: true, note: '→ IDENTITY/SERIAL' },
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');

  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }

  const counts = {};
  const byFile = {};
  for (const c of CONSTRUCTS) { counts[c.name] = { hits: 0, files: new Set() }; }

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const c of CONSTRUCTS) {
      const m = src.match(c.re);
      if (m && m.length) {
        counts[c.name].hits += m.length;
        counts[c.name].files.add(path.relative(ROOT, file));
        byFile[path.relative(ROOT, file)] = (byFile[path.relative(ROOT, file)] || 0) + m.length;
      }
    }
  }

  // translate 冒烟：对每类构造的代表性语句执行 dm / kingbase 翻译，收集未映射警告
  const smokeSql = [
    "UPDATE t SET a=datetime('now','localtime') WHERE id=?",
    "SELECT strftime('%s','now','localtime') - strftime('%s', created_at) FROM t",
    "INSERT OR IGNORE INTO t (a) VALUES (?)",
    "INSERT OR REPLACE INTO t (a) VALUES (?)",
    'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, n TEXT)',
  ];
  const unmatched = [];
  for (const dlg of ['dm', 'kingbase']) {
    for (const sql of smokeSql) {
      const r = sqlDialect.translate(sql, dlg);
      for (const w of r.warnings) unmatched.push({ dialect: dlg, sql, warning: w });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    scanned_files: files.length,
    constructs: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, { hits: v.hits, files: v.files.size }])),
    translate_unmatched: unmatched,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return strict && unmatched.length ? process.exit(1) : undefined;
  }

  console.log('==== BE-C2 SQL 方言闭环审计 ====');
  console.log(`扫描文件: ${files.length}`);
  console.log('\n构造分布：');
  for (const c of CONSTRUCTS) {
    const v = counts[c.name];
    const flag = c.mapped ? '✔映射' : '⚠待收敛';
    console.log(`  ${flag}  ${c.name.padEnd(20)} ${String(v.hits).padStart(4)} 处 / ${v.files.size} 文件   ${c.note}`);
  }
  console.log(`\ntranslate 未映射告警: ${unmatched.length}`);
  if (unmatched.length) {
    unmatched.slice(0, 12).forEach(u => console.log(`  [${u.dialect}] ${u.warning}\n     ${u.sql.slice(0, 90)}`));
    if (unmatched.length > 12) console.log(`  ... 其余 ${unmatched.length - 12} 条见 --json`);
  }
  console.log('\n提示：BE-C2 目标是「映射类构造清零或已有替代、待收敛类逐步抽象」；PRAGMA/AUTOINCREMENT 多在框架与 DDL 层，属收敛而非清零。');

  if (strict && unmatched.length) process.exit(1);
}

main();
