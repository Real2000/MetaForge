#!/usr/bin/env node
/**
 * MT-06 租户隔离越权探针（2026-11-22）
 *
 * 静态扫描 src-server/routes 与 src-server/lib 中的所有 db.prepare/exec SQL，
 * 对**命中租户域表**（docs/tenant-scope.md §3.1 TENANT 清单）的 SELECT/UPDATE/DELETE
 * 检查其 WHERE/条件是否包含 `tenant_id`；未包含者列为风险项。
 *
 * 用法：
 *   node scripts/tenant-audit.js            # 打印风险清单与汇总
 *   node scripts/tenant-audit.js --json     # 输出 JSON（供 CI 消费）
 *   node scripts/tenant-audit.js --strict   # 存在风险项时退出码 1（用于门禁）
 *
 * 说明：启发式扫描，不解析 SQL 语法树；目的是在 MT-05（出口化）推进过程中量化裸查残留。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { TENANT_TABLES } = require('../src-server/lib/tenant-tables');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src-server/routes', 'src-server/lib'];
const TENANT_SET = new Set(TENANT_TABLES);

/** 递归收集 .js 文件 */
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 从源码文本抽取 db.prepare(`...`)/db.prepare('...') 的 SQL 片段（含位置） */
function extractSql(src) {
  const results = [];
  const re = /db\.prepare\(\s*(`|'|")([\s\S]*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[2];
    if (!raw) continue;
    // 仅关注含 CRUD 关键字的语句
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(raw)) continue;
    results.push({ sql: raw, index: m.index });
  }
  return results;
}

/** 该 SQL 命中的租户域表 */
function tenantTablesIn(sql) {
  const found = new Set();
  for (const t of TENANT_SET) {
    const re = new RegExp(`\\b${t}\\b`, 'i');
    if (re.test(sql)) found.add(t);
  }
  return found;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');

  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) files.push(...walk(abs));
  }

  const findings = [];
  let totalCrud = 0;
  let totalTenantCrud = 0;
  let covered = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { sql, index } of extractSql(src)) {
      totalCrud++;
      const ts = tenantTablesIn(sql);
      if (!ts.size) continue;
      totalTenantCrud++;
      const hasTenant = /\btenant_id\b/i.test(sql);
      if (hasTenant) { covered++; continue; }
      findings.push({
        file: path.relative(ROOT, file),
        line: lineOf(src, index),
        tables: [...ts],
        snippet: sql.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    scanned_files: files.length,
    crud_statements: totalCrud,
    tenant_crud_statements: totalTenantCrud,
    tenant_filtered: covered,
    risk_count: findings.length,
    findings,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return strict && findings.length ? process.exit(1) : undefined;
  }

  console.log('==== MT-06 租户隔离越权探针 ====');
  console.log(`扫描文件: ${files.length}`);
  console.log(`CRUD 语句: ${totalCrud}（其中命中租户域表: ${totalTenantCrud}）`);
  console.log(`已含 tenant_id 过滤: ${covered}`);
  console.log(`风险项（命中租户域表但未含 tenant_id）: ${findings.length}`);
  if (findings.length) {
    console.log('\n---- 风险清单（前 60 条）----');
    findings.slice(0, 60).forEach((f, i) => {
      console.log(`${String(i + 1).padStart(3)}. ${f.file}:${f.line}  [${f.tables.join(',')}]`);
      console.log(`     ${f.snippet}`);
    });
    if (findings.length > 60) console.log(`... 其余 ${findings.length - 60} 条见 --json`);
  }
  // 按文件聚合 Top
  const byFile = {};
  findings.forEach(f => { byFile[f.file] = (byFile[f.file] || 0) + 1; });
  const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log('\n---- 热点文件（前 12）----');
    top.forEach(([f, n]) => console.log(`${String(n).padStart(4)}  ${f}`));
  }
  console.log('\n提示：MT-05（出口化）目标是将上述风险项收敛为「经统一出口注入 tenant_id」，最终该清单清零。');

  if (strict && findings.length) process.exit(1);
}

main();
