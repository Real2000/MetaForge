#!/usr/bin/env node
/**
 * SEC-03 配套：存量明文密钥巡检脚本（2026-11-22）
 *
 * 目的：ENCRYPTION_KEY 缺失期间，crypto-util.encrypt() 曾「静默返回明文」，
 * 导致 providers / user_providers / user_tool_keys / usermodels / secrets 等表的
 * 敏感值以明文落库。本脚本只读扫描，列出疑似明文（本应为 AES 密文三段 hex，或
 * 本应被加密却无 '.' 分隔符）的行，供人工核对与迁移。
 *
 * 用法：node scripts/scan-plaintext-secrets.js
 *  - 默认扫描 <项目>/data/platform.db（生产库），只读，不写任何数据。
 *  - 可用 AGENT_DATA_DIR 指向其他数据目录。
 *
 * 退出码：0 = 扫描完成（无论是否发现）；1 = 执行异常。
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'platform.db');

// 密文形态（SEC-10 起带 kid 前缀）：[kid(8hex).]iv(32hex).authTag(32hex).ciphertext(hex+)
// 兼容旧三段 iv.authTag.ciphertext 与新版四段 kid.iv.authTag.ciphertext
const CIPHER_RE = /^(?:[0-9a-f]{8}\.)?[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]+$/i;

function looksPlain(v) {
  const s = String(v ?? '');
  if (!s) return false;
  return !CIPHER_RE.test(s); // 非密文形态即疑似明文（含无 '.' 分隔符的旧明文）
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[scan] 未找到数据库：${DB_PATH}`);
    process.exit(1);
  }
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  // 待扫描表 → 敏感列（值为空则跳过）
  const targets = [
    { table: 'providers', col: 'api_key' },
    { table: 'user_providers', col: 'api_key' },
    { table: 'user_tool_keys', col: 'api_key' },
    { table: 'usermodels', col: 'api_key' },
  ];
  let total = 0;
  for (const { table, col } of targets) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    const hasCol = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    if (!hasCol) continue;
    const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all();
    const suspects = rows.filter(r => looksPlain(r.v));
    if (suspects.length) {
      total += suspects.length;
      console.log(`[scan] ${table}.${col}：${suspects.length}/${rows.length} 行疑似明文`);
      for (const r of suspects.slice(0, 50)) console.log(`        - id=${r.id} 值前缀=${String(r.v).slice(0, 8)}…（长度 ${String(r.v).length}）`);
      if (suspects.length > 50) console.log(`        … 其余 ${suspects.length - 50} 行略`);
    } else {
      console.log(`[scan] ${table}.${col}：${rows.length} 行，全部为密文形态 ✓`);
    }
  }
  // secrets 表：ENCRYPTION_KEY 自身按设计为明文，其余应为密文
  const hasSecrets = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secrets'").get();
  if (hasSecrets) {
    const rows = db.prepare("SELECT id, name, value FROM secrets WHERE value IS NOT NULL AND value != ''").all();
    const suspects = rows.filter(r => r.name !== 'ENCRYPTION_KEY' && looksPlain(r.value));
    total += suspects.length;
    console.log(`[scan] secrets：${suspects.length}/${rows.length} 行疑似明文（ENCRYPTION_KEY 自身明文属预期，已排除）`);
    for (const r of suspects.slice(0, 50)) console.log(`        - id=${r.id} name=${r.name}`);
  }
  db.close();
  console.log(`\n[scan] 完成：疑似明文共 ${total} 行。若 >0，请核对后用平台加密路径重写（重启服务会自动迁移无 '.' 的旧值）。`);
  process.exit(0);
}

try { main(); } catch (e) { console.error('[scan] 执行异常：', e && e.message); process.exit(1); }
