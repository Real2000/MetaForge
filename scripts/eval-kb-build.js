'use strict';
/**
 * AI-R2 评测库构建（M12，2026-11-26）：578 块干扰评测库幂等重建
 *
 * 运行（隔离库；不要指向生产数据目录——评测库会混入生产知识库列表）：
 *   AGENT_DATA_DIR=.temp/aiq1-rerun node scripts/eval-kb-build.js [--force]
 *
 * 幂等：同名库已存在且 ≥500 块 → 跳过（--force 清旧重建）。
 * 资产：scripts/eval-assets.js（唯一真相源；25 正检块 + 550+ 干扰块，禁词防御过滤）。
 * 出口：buildKb() 供 smoke/后续脚本复用；require.main 时执行 CLI。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const A = require('./eval-assets');

/**
 * 构建/复用评测库。
 * @param {object} opts { force?:boolean, log?:function }
 * @returns {Promise<{kbId:number, gold:number, noise:number, skipped:number, total:number, reused:boolean}>}
 */
async function buildKb(opts = {}) {
  const force = opts.force === true;
  const log = typeof opts.log === 'function' ? opts.log : console.log;
  const { db, now } = require(path.join(ROOT, 'src-server', 'db'));

  const exist = db.prepare('SELECT id FROM kbs WHERE name=?').get(A.KB_NAME);
  const existChunks = exist ? db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE kb_id=?').get(exist.id).c : 0;
  if (exist && existChunks >= 500 && !force) {
    log(`[eval-kb] 评测库已存在（kb#${exist.id}，${existChunks} 块），跳过（--force 重建）`);
    return { kbId: exist.id, gold: A.GOLD_CHUNKS.length, noise: existChunks - A.GOLD_CHUNKS.length, skipped: 0, total: existChunks, reused: true };
  }
  if (exist) { // force 重建：先清旧块（外键顺序：块 → 文件 → 库）
    db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(exist.id);
    db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(exist.id);
    db.prepare('DELETE FROM kbs WHERE id=?').run(exist.id);
  }
  db.prepare('INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES (?,?,1,?,?)')
    .run(A.KB_NAME, A.KB_DESC, 'aiq1-rerun', now());
  const kbId = db.prepare('SELECT id FROM kbs WHERE name=?').get(A.KB_NAME).id;
  db.prepare('INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,?)')
    .run(kbId, '评测语料合集.txt', 1024 * 600, 'success', A.GOLD_CHUNKS.length, now());
  const fid = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;

  const insChunk = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)');
  let gold = 0, noise = 0;
  for (const c of A.GOLD_CHUNKS) { insChunk.run(fid, kbId, c); gold++; }
  const { kept, skipped } = A.filterNoiseForbidden(A.makeNoiseChunks());
  for (const n of kept) { insChunk.run(fid, kbId, `[${n.idx}] ${n.content}`); noise++; }
  const total = db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE kb_id=?').get(kbId).c;
  log(`[eval-kb] kb#${kbId} 注入完成：正检块 ${gold} + 干扰块 ${noise}（禁词防御丢弃 ${skipped}）`);
  log(`[eval-kb] 库总块数：${total}（${total >= 500 ? '✅ 达到 ≥500 重跑门槛' : '❌ 不足 500'}）`);
  return { kbId, gold, noise, skipped, total, reused: false };
}

if (require.main === module) {
  buildKb({ force: process.argv.includes('--force') })
    .then(() => process.exit(0))
    .catch(e => { console.error('构造失败：', (e && e.stack) || e); process.exit(1); });
}

module.exports = { buildKb };