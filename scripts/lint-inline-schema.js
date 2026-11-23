#!/usr/bin/env node
/**
 * BE-E1 内联 schema 门禁（冻结基线，2026-11-23）
 *
 * 背景：db.js 历史上以「内联 CREATE TABLE / ALTER ADD COLUMN」演进 schema，导致执行顺序
 *       依赖手工维护（M4 AI-09 的 chat_traces.retrieval_trace 内联块写在建表语句之前，
 *       全新库单次启动即丢失该列，首次对话落库即抛 no such column）。
 *       BE-E1 起 schema 演进只允许发生在 lib/migrate.js（迁移执行器在全部建表之后运行）。
 *
 * 棘轮策略（与 lint-bare-prepare.js 同思路）：
 *   - 基线 scripts/inline-schema-baseline.json 冻结 db.js 现有内联建表表名与加列对；
 *   - 出现基线外的新增内联建表/加列即失败（exit 1），提示改走迁移框架；
 *   - 基线内条目被迁出 db.js 后可用 --update-baseline 收缩基线（只允许变小）。
 *
 * 用法：
 *   node scripts/lint-inline-schema.js                # 校验（npm run lint:schema）
 *   node scripts/lint-inline-schema.js --update-baseline  # 重新生成基线（迁出内联块后使用）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_JS = path.join(ROOT, 'src-server', 'db.js');
const BASELINE = path.join(__dirname, 'inline-schema-baseline.json');

/**
 * 扫描源码中的内联 DDL：建表表名 + 加列对。
 * @param {string} src - 源码文本
 * @returns {{ tables: string[], alters: [string, number][] }}
 *   tables: 内联 CREATE TABLE 的表名（排序）；alters: ['表.列', 出现次数]（排序）
 */
function scanInlineSchema(src) {
  const tables = new Set();
  const alters = new Map();
  const reCreate = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)[`"\]]?\s*\(/gi;
  const reAlter = /ALTER\s+TABLE\s+[`"[]?([A-Za-z0-9_]+)[`"\]]?\s+ADD\s+COLUMN\s+[`"[]?([A-Za-z0-9_]+)/gi;
  let m;
  while ((m = reCreate.exec(src))) tables.add(m[1].toLowerCase());
  while ((m = reAlter.exec(src))) {
    const k = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
    alters.set(k, (alters.get(k) || 0) + 1);
  }
  return { tables: [...tables].sort(), alters: [...alters.entries()].sort() };
}

/**
 * 校验扫描结果是否符合基线（只拦「新增」，存量冻结）。
 * @returns {{ ok: boolean, violations: string[], baseline: object, scanned: object }}
 */
function checkInlineSchema(src, baseline) {
  const scanned = scanInlineSchema(src);
  const violations = [];
  const baseTables = new Set(baseline.tables || []);
  const baseAlters = new Map(Object.entries(baseline.alters || {}));
  for (const t of scanned.tables) {
    if (!baseTables.has(t)) {
      violations.push(`新增内联建表：CREATE TABLE ${t} —— 新表请加到 src-server/lib/migrate.js ALL_MIGRATIONS（createSql 迁移步）`);
    }
  }
  for (const [k, n] of scanned.alters) {
    const bn = baseAlters.get(k) || 0;
    if (n > bn) {
      violations.push(`新增内联加列：ALTER TABLE ${k.replace('.', ' ADD COLUMN ')}（现 ${n} 处 > 基线 ${bn} 处）—— 新列请加到 src-server/lib/migrate.js ALL_MIGRATIONS（列迁移步）`);
    }
  }
  return { ok: violations.length === 0, violations, baseline, scanned };
}

function main() {
  const update = process.argv.includes('--update-baseline');
  const src = fs.readFileSync(DB_JS, 'utf8');
  if (update) {
    const scanned = scanInlineSchema(src);
    const baseline = {
      note: 'BE-E1 内联 schema 冻结基线：db.js 存量内联建表/加列清单。新增 DDL 一律走 src-server/lib/migrate.js；本文件只能随迁出而收缩（--update-baseline）。',
      tables: scanned.tables,
      alters: Object.fromEntries(scanned.alters),
      generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`[lint:schema] 基线已更新：${scanned.tables.length} 张内联建表 / ${scanned.alters.length} 组内联加列 → ${path.relative(ROOT, BASELINE)}`);
    return;
  }
  if (!fs.existsSync(BASELINE)) {
    console.error('[lint:schema] 基线不存在，请先运行：node scripts/lint-inline-schema.js --update-baseline');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const r = checkInlineSchema(src, baseline);
  if (r.ok) {
    console.log(`[lint:schema] 通过：db.js 内联 DDL 未超出基线（${r.scanned.tables.length} 表 / ${r.scanned.alters.length} 加列对）`);
  } else {
    console.error(`[lint:schema] 失败：检测到 ${r.violations.length} 处基线外新增内联 DDL（BE-E1：停止 db.js 新增内联建表/加列）`);
    for (const v of r.violations) console.error('  ✗ ' + v);
    console.error('  → 请将上述新表/新列改写为 src-server/lib/migrate.js 中的迁移步（列迁移 table+column / 建表迁移 table+createSql / 复杂逻辑 up 函数）');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { scanInlineSchema, checkInlineSchema, DB_JS, BASELINE };
