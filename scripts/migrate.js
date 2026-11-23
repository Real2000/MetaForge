#!/usr/bin/env node
/**
 * BE-E1 迁移 CLI（2026-11-23）：status / up / down / snapshot / check
 *
 * 用法（目标库由 AGENT_DATA_DIR 决定，未设置时作用于 <项目>/data/platform.db 生产库）：
 *   node scripts/migrate.js status                       # 台账 + 锚点 + 漂移状态
 *   node scripts/migrate.js up                           # 执行未应用迁移并重新锚定
 *   node scripts/migrate.js down [--to <id>] [--yes]     # 逆序回滚（默认仅最新一步；--yes 跳过确认）
 *   node scripts/migrate.js snapshot [-o <file>]         # 导出全库结构快照（DDL 哈希 + 指纹）
 *   node scripts/migrate.js check                        # 漂移检测（实际结构 vs 上次锚点，不写锚点）
 *
 * down 依赖 AGENT_NO_AUTO_MIGRATE=1 抑制 boot 自动 up（否则 require db 即把刚回滚的步加回来）。
 * 回滚是破坏性操作：先列出目标库路径与将回滚的步骤，要求交互确认（--yes 跳过）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'platform.db');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

function usage() {
  console.log('用法：node scripts/migrate.js <status|up|down|snapshot|check> [options]');
  console.log('  status                 台账 + 锚点 + 漂移状态');
  console.log('  up                     执行未应用迁移并重新锚定');
  console.log('  down [--to <id>] [--yes]  逆序回滚（默认仅最新一步）');
  console.log('  snapshot [-o <file>]   导出全库结构快照 JSON');
  console.log('  check                  漂移检测（只读）');
  process.exit(cmd ? 1 : 0);
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

async function main() {
  if (!cmd || !['status', 'up', 'down', 'snapshot', 'check'].includes(cmd)) usage();
  // up 允许初始化新库（require db.js 即建库并迁移）；其余子命令对不存在的库拒绝，避免误建空库
  if (cmd !== 'up' && !fs.existsSync(DB_FILE)) {
    console.error(`[migrate-cli] 目标库不存在：${DB_FILE}（先运行 up / 启动一次服务，或确认 AGENT_DATA_DIR）`);
    process.exit(1);
  }
  console.log(`[migrate-cli] 目标库：${DB_FILE}${process.env.AGENT_DATA_DIR ? '（AGENT_DATA_DIR 指定）' : '（默认生产库）'}`);

  // down 模式：抑制 db.js boot 的自动迁移与锚定（防自动 up 抵消回滚）
  if (cmd === 'down') process.env.AGENT_NO_AUTO_MIGRATE = '1';

  const { db } = require(path.join(ROOT, 'src-server', 'db'));
  const mig = require(path.join(ROOT, 'src-server', 'lib', 'migrate'));
  const steps = mig.ALL_MIGRATIONS;
  const applied = mig.getAppliedIds();
  const latest = Math.max(0, ...steps.map(s => s.id));

  if (cmd === 'status') {
    const pending = steps.filter(s => !applied.has(s.id));
    console.log(`[migrate-cli] 台账：${applied.size}/${steps.length} 已应用（注册表最新 id=${latest}）`);
    if (pending.length) {
      console.log(`[migrate-cli] 待应用 ${pending.length} 步：`);
      for (const s of pending) console.log(`  #${s.id} ${s.name}`);
    }
    const drift = mig.checkSchemaDrift();
    if (drift.status === 'unanchored') {
      console.log('[migrate-cli] 锚点：未锚定（首次启动 / up 后将建立）');
    } else if (drift.status === 'ok') {
      console.log(`[migrate-cli] 锚点：一致（app ${drift.appVersion}，anchored ${drift.anchoredAt}）`);
    } else {
      console.log(`[migrate-cli] 锚点：漂移！实际指纹与上次锚点不一致，涉及对象：`);
      for (const k of drift.drifted) console.log(`  ✗ ${k}`);
    }
    return;
  }

  if (cmd === 'up') {
    const r = mig.runMigrations(steps);
    console.log(`[migrate-cli] up 完成：新应用 ${r.applied} 步${r.errors.length ? `，${r.errors.length} 步失败` : ''}`);
    if (r.errors.length) { for (const e of r.errors) console.error('  ✗ ' + e); process.exit(1); }
    mig.anchorSchema();
    console.log(`[migrate-cli] 已重新锚定（app ${mig.appVersion()}）`);
    return;
  }

  if (cmd === 'down') {
    const to = flag('--to') ? Number(flag('--to')) : undefined;
    if (Number.isFinite(to) && (!steps.some(s => s.id === to))) {
      console.error(`[migrate-cli] --to ${to} 不在注册表中（可选 id：${steps.map(s => s.id).join(', ')}）`);
      process.exit(1);
    }
    // 预演：列出将回滚的步骤（含不可回滚告警）
    const desc = [...steps].sort((a, b) => b.id - a.id).filter(s => applied.has(s.id));
    const target = Number.isFinite(to) ? to : (Math.max(...applied) - 1);
    const willRevert = desc.filter(s => s.id > target);
    if (!willRevert.length) { console.log('[migrate-cli] 无可回滚步骤'); return; }
    console.log('[migrate-cli] 将回滚以下步骤（逆序，遇错即停）：');
    for (const s of willRevert) {
      const reversible = typeof s.down === 'function' || (s.table && s.column) || (s.table && s.createSql);
      console.log(`  #${s.id} ${s.name}${reversible ? '' : '  ⚠ 自定义 up 且未定义 down，遇错将停在它身上'}`);
    }
    if (flag('--yes') !== true) {
      const ok = await confirm(`确认在 ${DB_FILE} 上执行回滚？(y/N) `);
      if (!ok) { console.log('[migrate-cli] 已取消'); process.exit(0); }
    }
    const results = mig.revertMigrations(steps, Number.isFinite(to) ? { to } : {});
    let failed = false;
    for (const r of results) {
      console.log(r.ok ? `  ✓ 已回滚 #${r.id} ${r.name}` : `  ✗ 回滚失败 #${r.id} ${r.name}：${r.error}`);
      if (!r.ok) failed = true;
    }
    mig.anchorSchema();
    console.log(`[migrate-cli] 回滚结束，已重新锚定。当前台账：${mig.getAppliedIds().size} 步`);
    if (failed) process.exit(1);
    return;
  }

  if (cmd === 'snapshot') {
    const fp = mig.computeSchemaFingerprint();
    const snap = {
      taken_at: new Date().toISOString(),
      app_version: mig.appVersion(),
      db_file: DB_FILE,
      applied_migrations: [...applied].sort((a, b) => a - b),
      schema_hash: fp.hash,
      per_object: fp.perObject,
      object_count: fp.objectCount,
    };
    const out = flag('-o');
    if (out) {
      fs.writeFileSync(out, JSON.stringify(snap, null, 2) + '\n');
      console.log(`[migrate-cli] 快照已写入 ${out}（${fp.objectCount} 对象，hash ${fp.hash.slice(0, 16)}…）`);
    } else {
      console.log(JSON.stringify(snap, null, 2));
    }
    return;
  }

  if (cmd === 'check') {
    const drift = mig.checkSchemaDrift();
    if (drift.status === 'ok') {
      console.log(`[migrate-cli] check：结构一致（app ${drift.appVersion}，anchored ${drift.anchoredAt}，hash ${drift.hash.slice(0, 16)}…）`);
    } else if (drift.status === 'unanchored') {
      console.log('[migrate-cli] check：未锚定（运行 up 或正常启动服务以建立锚点）');
      process.exit(1);
    } else {
      console.log(`[migrate-cli] check：漂移（实际 ${drift.hash.slice(0, 16)}… vs 锚点 ${drift.anchoredHash.slice(0, 16)}…）`);
      for (const k of drift.drifted) console.log('  ✗ ' + k);
      process.exit(1);
    }
    return;
  }
}

main().catch(e => { console.error('[migrate-cli] 失败：', e.message); process.exit(1); });
