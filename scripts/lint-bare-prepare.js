#!/usr/bin/env node
/**
 * BE-C1 裸查门禁（ratchet）：禁止新增未收敛的裸 db.prepare / db.exec（2026-11-22）
 *
 * 背景：MT-05/BE-C1 目标是把租户过滤与方言收敛到统一出口（lib/dal.js），
 *       但存量裸查约 1500+ 处，无法一次改完。本门禁用「棘轮」策略：
 *       - 记录当前每个文件的裸查数量为基线（scripts/dal-baseline.json）；
 *       - 任意文件裸查数超过基线即失败（禁止新增）；
 *       - 存量可逐步下调（收敛一个改小一个）。
 *
 * 用法：
 *   node scripts/lint-bare-prepare.js           # 校验（CI/发布前）
 *   node scripts/lint-bare-prepare.js --update  # 重新生成基线（仅收敛后使用）
 *
 * 白名单：lib/dal.js / lib/migrate.js / lib/sql-dialect.js / db.js 等框架出口自身豁免。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src-server'];
const BASELINE = path.join(__dirname, 'dal-baseline.json');
// 允许「出口/框架」层直接持有裸查（db.js/dal.js 等为方言与租户出口自身；audit.js 为审计写入/校验底层，须对任意 db 实例工作）。
// RAG/向量引擎底层（2026-11-23 补录，M4 质量战役产物）：vec0 虚表 DDL/KNN、FTS5 MATCH、BLOB 向量读写、
// GraphRAG 实体图、记忆语义召回、RAGAS 指标采集、摄取管道——均为平台原生 SQLite 特性语法，
// 方言翻译（q/getq/runq）与业务 CRUD 租户收敛不适用（D-2：SQLite 为默认库，PG 方言仅 SaaS 档远期）。
// workflow.js（2026-11-23 AI-08 补录）：画布执行引擎层——运行落库/子智能体调度/检查点/节点防线查询
// 均为引擎内部机制 SQL，须对任意 db 实例工作（与 audit.js 同性质），不属业务路由 CRUD 收敛范围。
// access-log.js（2026-11-23 BE-F1 补录）：请求日志中间件——finish 回调对构造注入的 db 实例落
// access_logs 骨架行，同属框架层（不持有业务查询语义）。
const ALLOWLIST = new Set([
  'src-server/db.js', 'src-server/lib/dal.js', 'src-server/lib/migrate.js',
  'src-server/lib/sql-dialect.js', 'src-server/lib/db-driver.js', 'src-server/lib/audit.js',
  'src-server/lib/vector-index.js', 'src-server/lib/retriever.js', 'src-server/lib/graphrag.js',
  'src-server/lib/memory-recall.js', 'src-server/lib/rag-metrics.js', 'src-server/lib/ingestion-pipeline.js',
  'src-server/lib/workflow.js', 'src-server/lib/access-log.js',
  // MT-7（2026-11-23）补录：pg-rls 为 RLS 策略执行器（PG 原生 DDL 的框架层出口，
  // 与 migrate 同性质——策略应用发生在建表完成后，非业务 CRUD 收敛范围）
  'src-server/lib/pg-rls.js',
]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

function countBare(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/db\.(prepare|exec)\s*\(/g);
  return m ? m.length : 0;
}

function scan() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  const counts = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOWLIST.has(rel)) continue;
    const n = countBare(f);
    if (n) counts[rel] = n;
  }
  return counts;
}

function main() {
  const update = process.argv.includes('--update');
  const counts = scan();

  if (update || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n', 'utf8');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`[lint:sql] 基线已写入 ${path.relative(ROOT, BASELINE)}：${Object.keys(counts).length} 文件 / ${total} 处裸查`);
    return;
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const regressions = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = base[file] || 0;
    if (n > allowed) regressions.push({ file, base: allowed, now: n, delta: n - allowed });
  }

  const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
  const nowTotal = Object.values(counts).reduce((a, b) => a + b, 0);

  if (regressions.length) {
    console.error('==== BE-C1 裸查门禁：发现新增未收敛裸查 ====');
    regressions.sort((a, b) => b.delta - a.delta).forEach(r => {
      console.error(`  ✗ ${r.file}: ${r.base} → ${r.now}（+${r.delta}）`);
    });
    console.error('\n请改用统一出口：require(\'../lib/dal\') 的 q/getq/runq（已内置方言翻译 + 租户出口）。');
    console.error('如确需放宽，收敛后运行 `npm run lint:sql:update` 刷新基线。');
    process.exit(1);
  }

  console.log(`==== BE-C1 裸查门禁通过 =====`);
  console.log(`文件数 ${Object.keys(counts).length} / 裸查 ${nowTotal} 处（基线 ${baseTotal} 处，本文件均未超基线）`);
}

main();
