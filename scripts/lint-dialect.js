#!/usr/bin/env node
/**
 * BE-C2（2026-11-23）方言闭环审计门禁：lint:dialect
 *
 * 背景：BE-C1 已把业务 SQL 收敛到 dal 统一出口（方言层可拦截全部 SQL）；BE-C2 在此之上把建表
 * DDL 也经方言层（db.js db.exec 包装点注入 translate）。本工具回答验收问题：
 *   「dm/kingbase 方言 translate 单测通过；warning 清单为 0 或有替代」
 *
 * 机制：
 *   1. 词法提取（字符串/注释感知状态机）全库 SQL 字面量——db.exec(...)（DDL）、
 *      dal.q/getq/runq/exec/pluck(...)（业务出口）、db.prepare(...)（框架层）三类调用点的第一实参；
 *      模板插值 ${...} 以 __EXPR__ 占位（片段级翻译足以覆盖文本级方言规则）；
 *   2. 每条 SQL 对 dm / kingbase 双方言 translate；
 *   3. warnings 按签名归类：`<方言>::<构造名>`（未映射构造名 / INSERT OR IGNORE|REPLACE 类别前缀），
 *      与 scripts/dialect-baseline.json 的 alternatives 登记表比对——
 *      **未登记的 warning 即失败**；已登记 = 验收认可的「有替代」；
 *   4. downgrades（FTS5/vec0 虚表跳过等已确认降级）单独报告，不构成阻塞。
 *
 * 用法：
 *   node scripts/lint-dialect.js            # 审计（CI 门禁）
 *   node scripts/lint-dialect.js --update   # 把当前 warnings 写入登记表（仅新增替代方案时用）
 *
 * 与既有 scripts/dialect-audit.js（2026-11-22）的关系：audit 为启发式构造分布统计 +
 * translate 冒烟（进度度量视角）；本工具为闭环验收门禁（逐条 SQL 字面量提取 → 双方言
 * 翻译 → 未登记 warning 必须为 0）。CI 门禁入口为 lint:dialect。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src-server'];
const BASELINE = path.join(__dirname, 'dialect-baseline.json');
const { translate } = require('../src-server/lib/sql-dialect');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ---------- 词法状态机（与 dal-codemod 同源思路：字符串/注释感知，括号配对） ---------- */

function skipString(src, i) {
  const q = src[i]; i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      i += 2; let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '`' || c === "'" || c === '"') { i = skipString(src, i); continue; }
        i++;
      }
      continue;
    }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

function matchParen(src, open) {
  let depth = 0, i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 提取三类调用点的第一实参 SQL 字面量（模板 ${} → __EXPR__）；返回 [{file, line, sql}] */
function extractSqlLiterals(src, rel) {
  const out = [];
  const re = /\b(db\.exec|db\.prepare|dal\.(?:q|getq|runq|exec|pluck))\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    // 第一实参起点：跳过空白/注释
    let i = open + 1;
    while (i < src.length && /[\s]/.test(src[i])) i++;
    const ch = src[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') continue; // 动态拼接/变量 → 跳过（片段级审计覆盖不到，构造类别登记兜底）
    const end = skipString(src, i);
    let sql = src.slice(i + 1, end - 1);
    // PG-1（2026-11-23）：源码切片保留 JS 转义（如 datetime(\'now\',\'localtime\')），与运行时真实
    // SQL 不一致——方言改写按运行时文本匹配，转义残留造成漏匹配假阴性（datetime 残留网首跑
    // 暴露：auth/payment/security 的转义形态 10 处被误报残留）。统一反转义为运行时文本。
    sql = sql.replace(/\\(['"\\$`])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    // 模板插值占位（避免把 JS 表达式当 SQL 翻译）
    sql = sql.replace(/\$\{[^}]*\}/g, '__EXPR__');
    if (!sql.trim()) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ file: rel, line, sql, kind: m[1] });
  }
  return out;
}

/** 把 translate 的 warning 文本解析为稳定签名：`<构造名>`（方言维度在外层拼接） */
function warningSignature(msg) {
  let m = /^未映射的 SQLite 专有构造：([^（]+)（/.exec(msg);
  if (m) return m[1].trim();
  m = /^(INSERT OR [A-Z]+)：/.exec(msg);
  if (m) return m[1];
  return String(msg).split('：')[0].slice(0, 40); // 未知形态 → 前缀兜底（新类别显式暴露）
}

/* ---------- 审计主流程 ---------- */

function main() {
  const doUpdate = process.argv.includes('--update');
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }

  const allSql = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    allSql.push(...extractSqlLiterals(fs.readFileSync(f, 'utf8'), rel));
  }

  // 双方言翻译 → 归类
  const warnBySig = new Map();   // 签名 → { dialects:Set, count, samples:[file:line] }
  const downgrades = [];
  for (const item of allSql) {
    for (const dialect of ['dm', 'kingbase']) {
      const t = translate(item.sql, dialect);
      for (const w of t.warnings) {
        const sig = `${dialect}::${warningSignature(w)}`;
        if (!warnBySig.has(sig)) warnBySig.set(sig, { dialects: new Set(), count: 0, samples: [] });
        const e = warnBySig.get(sig);
        e.dialects.add(dialect); e.count++;
        if (e.samples.length < 3) e.samples.push(`${item.file}:L${item.line}`);
      }
      for (const dg of t.downgrades) {
        const key = `${dialect}::${dg.kind}`;
        if (!downgrades.some(x => x.key === key)) downgrades.push({ key, note: dg.note, samples: [`${item.file}:L${item.line}`] });
      }
    }
  }

  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { alternatives: {} };
  base.alternatives = base.alternatives || {};

  const unregistered = [...warnBySig.entries()].filter(([sig]) => !base.alternatives[sig]);

  if (doUpdate) {
    for (const [sig] of unregistered) base.alternatives[sig] = '';
    fs.writeFileSync(BASELINE, JSON.stringify(base, null, 2) + '\n', 'utf8');
    console.log(`[lint:dialect] 登记表已更新：新增 ${unregistered.length} 项待补替代说明（scripts/dialect-baseline.json）`);
  }

  // 报告
  console.log('==== BE-C2 方言闭环审计 ====');
  console.log(`SQL 提取：${allSql.length} 条（db.exec DDL + dal 出口 + db.prepare 框架层）`);
  console.log(`downgrades（已确认降级，非阻塞）：${downgrades.length} 项`);
  for (const d of downgrades) console.log(`  ↘ ${d.key}：${d.note}（样本 ${d.samples[0]}）`);
  console.log(`warning 类别：${warnBySig.size} 项（${unregistered.length} 项未登记）`);
  for (const [sig, e] of warnBySig) {
    const ok = base.alternatives[sig];
    console.log(`  ${ok ? '✓ 已登记替代' : '✗ 未登记'} ${sig}（×${e.count}，样本 ${e.samples.join(' ')}）${ok ? `：${ok}` : ''}`);
  }

  if (unregistered.length) {
    console.error(`\n==== 方言审计门禁失败：${unregistered.length} 项 warning 未登记替代方案 ====`);
    console.error('请在 scripts/dialect-baseline.json 的 alternatives 补充替代说明（或修复该构造后重跑）。');
    process.exit(1);
  }
  console.log('\n==== 方言审计门禁通过：未登记 warning = 0（已登记项均有替代方案）====');
}

main();
