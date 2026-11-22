#!/usr/bin/env node
/**
 * 审计日志哈希链校验工具（SEC-11，M2 批次4）
 *
 * 用法：
 *   node scripts/verify-audit-chain.js            # 校验 op_logs + security_events
 *   node scripts/verify-audit-chain.js op_logs    # 仅校验指定表
 *
 * 退出码：0=链完整；1=发现断裂；2=运行错误。
 * 仅校验启用链之后的行（record_hash 非空）；历史行自动跳过。
 */
process.env.AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || require('path').join(__dirname, '..', 'data');

const { db } = require('../src-server/db');
const { verifyChain, CHAIN_TABLES } = require('../src-server/lib/audit');

function main() {
  const arg = process.argv[2];
  const tables = arg ? [arg] : CHAIN_TABLES;
  for (const t of tables) {
    if (!CHAIN_TABLES.includes(t)) { console.error(`未知表：${t}（支持：${CHAIN_TABLES.join(', ')}）`); process.exit(2); }
  }
  let broken = 0;
  for (const t of tables) {
    let r;
    try { r = verifyChain(db, t); } catch (e) { console.error(`[${t}] 校验异常：${e.message}`); process.exit(2); }
    if (r.ok) console.log(`✅ [${t}] 哈希链完整（已校验 ${r.checked} 行）`);
    else { broken++; console.error(`❌ [${t}] 哈希链断裂：首次不匹配行 id=${r.brokenAt}（已校验 ${r.checked} 行）`); }
  }
  try { db.close(); } catch { }
  process.exit(broken ? 1 : 0);
}

main();
