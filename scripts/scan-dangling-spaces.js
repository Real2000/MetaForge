#!/usr/bin/env node
/**
 * SEC-04 配套：空间脏数据巡检脚本（2026-11-22）
 *
 * 目的：资源 space_id 指向不存在（或 0/NULL）的空间时，SEC-04 后按 fail-closed 判定为不可见；
 * 本脚本只读扫描各资源表中「有 space_id 但该空间不存在」的悬空引用，输出清单与计数，
 * 便于管理员核对是修复 space_id 还是回收资源。
 *
 * 用法：node scripts/scan-dangling-spaces.js
 *  - 默认扫描 <项目>/data/platform.db；可用 AGENT_DATA_DIR 指向其他数据目录。
 *  - 可选 --fix-null：将悬空 space_id 置为 0（=无空间归属，全员可见），谨慎使用（需显式传参）。
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'platform.db');

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error(`[dangling] 未找到数据库：${DB_PATH}`); process.exit(1); }
  const Database = require('better-sqlite3');
  const fixNull = process.argv.includes('--fix-null');
  const db = new Database(DB_PATH, { readonly: !fixNull });

  const hasSpaceId = t => {
    const ok = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!ok) return false;
    return db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'space_id');
  };
  // 主要资源表（含 space_id 归属）
  const tables = ['agents', 'kbs', 'tasks', 'app_tables', 'assets', 'projects'];
  let total = 0;
  for (const t of tables) {
    if (!hasSpaceId(t)) continue;
    const rows = db.prepare(`SELECT id, space_id, owner FROM ${t} WHERE space_id IS NOT NULL AND space_id != 0`).all();
    const dangling = rows.filter(r => !db.prepare('SELECT 1 FROM spaces WHERE id=?').get(r.space_id));
    total += dangling.length;
    console.log(`[dangling] ${t}：${dangling.length}/${rows.length} 行 space_id 悬空`);
    for (const r of dangling.slice(0, 30)) console.log(`        - id=${r.id} space_id=${r.space_id} owner=${r.owner}`);
    if (dangling.length > 30) console.log(`        … 其余 ${dangling.length - 30} 行略`);
    if (fixNull && dangling.length) {
      const info = db.prepare(`UPDATE ${t} SET space_id=0 WHERE id IN (${dangling.map(() => '?').join(',')})`).run(...dangling.map(r => r.id));
      console.log(`        ✅ 已置 0（无归属）${info.changes} 行`);
    }
  }
  db.close();
  console.log(`\n[dangling] 完成：悬空引用共 ${total} 行${fixNull ? '（已按 --fix-null 置 0）' : '（只读；如需置 0 请加 --fix-null）'}。`);
  process.exit(0);
}
try { main(); } catch (e) { console.error('[dangling] 执行异常：', e && e.message); process.exit(1); }
