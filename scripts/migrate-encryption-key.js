#!/usr/bin/env node
/**
 * 加密密钥迁出脚本（SEC-10，M2 批次4）
 *
 * 把 secrets 表的 ENCRYPTION_KEY 导出到 <DATA_DIR>/encryption.key（0600），
 * 使「加密密钥」与「密文」不同源（密钥与它加密的敏感值不再同存一个库）。
 *
 * 关键：迁移只改密钥的存放位置，不改密钥值 —— 历史密文（kid 相同）与 API Key pepper
 *       （pepper = 该密钥值的 HMAC）均不受影响，可平滑迁移。
 *
 * 用法：
 *   node scripts/migrate-encryption-key.js           仅导出到文件（DB 副本保留，兼容）
 *   node scripts/migrate-encryption-key.js --purge    导出后从 DB 删除（完成迁出）
 *   node scripts/migrate-encryption-key.js --force    文件已存在且与 DB 不同值时用 DB 值覆盖
 *
 * 退出码：0=成功；2=无 DB 密钥；3=文件冲突未覆盖；1=运行错误。
 */
process.env.AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || require('path').join(__dirname, '..', 'data');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const purge = args.includes('--purge');
const force = args.includes('--force');

function main() {
  const { db } = require('../src-server/db');
  const { keyFilePath, kidOf } = require('../src-server/lib/crypto-util');

  const row = db.prepare("SELECT value FROM secrets WHERE name='ENCRYPTION_KEY' AND tenant_id=0").pluck().get();
  if (!row || String(row).length !== 64) {
    console.error('❌ secrets 表未找到有效的 ENCRYPTION_KEY（64 位 hex）。');
    console.error('   若已改用环境变量/文件来源，则无需迁移。');
    try { db.close(); } catch { }
    process.exit(2);
  }
  const hex = String(row).trim();
  const kid = kidOf(Buffer.from(hex, 'hex'));
  const kf = keyFilePath();
  fs.mkdirSync(path.dirname(kf), { recursive: true });

  if (fs.existsSync(kf)) {
    const cur = fs.readFileSync(kf, 'utf8').trim();
    if (cur === hex) {
      console.log('✅ 密钥文件已存在且与 DB 一致：' + kf + '（kid=' + kid + '）');
    } else if (!force) {
      console.error('⚠️ 密钥文件已存在且与 DB 不同值，未覆盖（加 --force 才用 DB 值覆盖）。');
      try { db.close(); } catch { }
      process.exit(3);
    } else {
      fs.writeFileSync(kf, hex, { mode: 0o600 });
      try { fs.chmodSync(kf, 0o600); } catch { /* 平台差异忽略 */ }
      console.log('✅ 已用 DB 密钥覆盖文件：' + kf + '（kid=' + kid + '）');
    }
  } else {
    fs.writeFileSync(kf, hex, { mode: 0o600 });
    try { fs.chmodSync(kf, 0o600); } catch { /* 平台差异忽略 */ }
    console.log('✅ 已导出密钥到文件：' + kf + '（0600，kid=' + kid + '）');
  }

  if (purge) {
    db.prepare("DELETE FROM secrets WHERE name='ENCRYPTION_KEY' AND tenant_id=0").run();
    console.log('✅ 已从 secrets 表删除 ENCRYPTION_KEY（完成迁出，密钥与密文不同源）');
  } else {
    console.log('ℹ️ DB 副本仍保留（兼容）。确认无误后可加 --purge 完成迁出。');
  }
  console.log('   提示：迁移不改密钥值，历史密文与 API Key pepper 均不受影响。');
  try { db.close(); } catch { }
}

try { main(); } catch (e) { console.error('❌ 迁移失败：' + e.message); process.exit(1); }
