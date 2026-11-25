#!/usr/bin/env node
/**
 * SW-1④（2026-11-25）切换窗口验收工具——SW-2 停机直切（D-5）S7 验收的单一命令化。
 *
 * 为什么需要它：切换夜高压环境下，runbook S7 的验收锚点分散在 health/curl、psql 计数、
 * RLS 探针、序列四处，人肉逐条跑易漏易错；本工具收敛为一条命令 + 退出码，窗口内可反复重跑
 * （全部只读，幂等零副作用）。
 *
 * 检查项（全部只读）：
 *   1. health：GET {BASE_URL}/api/health 重试至 ok（S7 刚起服的短暂未就绪窗口容忍 10 次）；
 *   2. 计数锚点：PG 侧八表 COUNT；提供 SW_SQLITE（切换前 sqlite 归档/快照）时双侧对比——
 *      核心七表必须相等；op_logs 为漂移容忍表（服务起来后 ops 审计天然写入，只报告不判死，
 *      否则起服即红——验收工具必须能在「已起服」形态下跑）；
 *   3. RLS 三态探针：以业务连接串 SET app.tenant_id——基线 '0' 与不存在租户 '999999' 必须
 *      0 行（fail-closed 隔离仍在），探针租户必须 >0（数据可见）。FORCE RLS 对 owner 也生效
 *      （SW-1 演练实证），故业务角色连接即可探真，无需超户；
 *   4. 序列健康：锚点表 last_value ≥ MAX(id)（显式 id 搬运后 nextval 不回卷撞主键——
 *      migrate-to-pg 与 db.js 启动块双保险的独立复核）。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:3210 PG_CONN=postgres://user:pass@host:5432/db node scripts/sw-verify.js
 *   SW_SQLITE=data/backups/platform-2026-11-28.db   # 可选：提供则做双侧计数对比
 *   SW_TENANT_ID=1                                  # 可选：RLS 可见性探针租户号（默认 1）
 * 退出码：0=全部通过；1=存在失败项（逐项打印 ✗）。
 */
'use strict';
const fs = require('fs');

const BASE_URL = process.env.SW_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3210';
const PG_CONN = process.env.PG_CONN || process.env.DATABASE_URL || '';
const SQLITE_PATH = process.env.SW_SQLITE || '';
const PROBE_TENANT = process.env.SW_TENANT_ID || '1';

// 锚点表与 runbook S7 验收口径一致；op_logs 单列漂移容忍（见头注释 2）
const ANCHOR_TABLES = ['users', 'tenants', 'agents', 'sessions', 'messages', 'kb_chunks', 'workflow_runs', 'op_logs'];
const DRIFT_TOLERANT = new Set(['op_logs']);

function fail(msg) { console.error(`[sw-verify] ✗ ${msg}`); process.exit(1); }

/** health：重试至 ok 或超次（起服初期未就绪/瞬时拒连都视为「再等等」） */
async function checkHealth() {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json().catch(() => null);
      if (j && j.code === 0 && j.data && j.data.ok === true) return true;
    } catch { /* 未就绪/瞬时拒连——重试 */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

/** PG 侧锚点计数 + RLS 三态 + 序列健康（业务角色连接——与生产运行形态同权探真） */
async function pgChecks() {
  if (!PG_CONN) fail('缺少 PG_CONN（与 db.js 同口径，或设 DATABASE_URL）');
  const pg = require('pg');
  const client = new pg.Client({ connectionString: PG_CONN });
  await client.connect();
  // 计数与探针同租户上下文：租户内容表（agents/sessions/messages/kb_chunks/workflow_runs）
  // 在 RLS 基线下 fail-closed 全不可见——不带上下文直数必得 0（SW-1 E2E 实测抓回）。
  // 单租户部署（当前生产形态）探针租户即全量；多租户日需扩展为逐租户求和口径。
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [String(PROBE_TENANT)]);
  const counts = {};
  for (const t of ANCHOR_TABLES) {
    counts[t] = (await client.query(`SELECT COUNT(*)::int c FROM ${t}`)).rows[0].c;
  }
  // RLS 三态：基线与不存在租户 fail-closed 为 0，探针租户可见 >0
  const rls = {};
  for (const tid of ['0', '999999', String(PROBE_TENANT)]) {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tid]);
    rls[tid] = (await client.query('SELECT COUNT(*)::int c FROM agents')).rows[0].c;
  }
  // 序列健康：锚点表全部为 id SERIAL（<表>_id_seq 命名约定）；last_value ≥ MAX(id)
  const seq = [];
  for (const t of ANCHOR_TABLES) {
    const r = await client.query(
      `SELECT COALESCE((SELECT last_value FROM ${t}_id_seq), 0)::bigint lv,
              COALESCE((SELECT MAX(id) FROM ${t}), 0)::bigint mx`);
    seq.push({ t, lv: Number(r.rows[0].lv), mx: Number(r.rows[0].mx) });
  }
  await client.end();
  return { counts, rls, seq };
}

/** sqlite 侧锚点计数（只读直连切换前归档/快照；SW_SQLITE 缺省则跳过双侧对比） */
function sqliteCounts() {
  if (!SQLITE_PATH) return null;
  if (!fs.existsSync(SQLITE_PATH)) fail(`SW_SQLITE 不存在：${SQLITE_PATH}`);
  const db = require('better-sqlite3')(SQLITE_PATH, { readonly: true });
  const counts = {};
  for (const t of ANCHOR_TABLES) counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  db.close();
  return counts;
}

/** 纯函数：双侧锚点对比（strict 表必须相等；漂移容忍表只标记不判死）——导出供 smoke 运行时守卫直测 */
function compareAnchors(pgCounts, sqliteCounts) {
  return ANCHOR_TABLES.map((t) => {
    const tolerant = DRIFT_TOLERANT.has(t);
    const ok = sqliteCounts == null ? true : (tolerant ? true : pgCounts[t] === sqliteCounts[t]);
    return { table: t, pg: pgCounts[t], sqlite: sqliteCounts ? sqliteCounts[t] : undefined, tolerant, ok };
  });
}

async function main() {
  const fails = [];
  const healthy = await checkHealth();
  console.log(`${healthy ? '✓' : '✗'} health ${BASE_URL}/api/health ${healthy ? 'OK' : '不可用（10 次重试后）'}`);
  if (!healthy) fails.push('health 不可用');
  const { counts, rls, seq } = await pgChecks();
  const sq = sqliteCounts();
  for (const c of compareAnchors(counts, sq)) {
    const line = `${c.table}: pg=${c.pg}` + (sq ? ` sqlite=${c.sqlite}` : '（未提供 SW_SQLITE，跳过双侧对比）');
    console.log(`${c.ok ? '✓' : '✗'} 锚点 ${line}${c.tolerant ? '（漂移容忍，仅报告）' : ''}`);
    if (!c.ok) fails.push(`锚点不等 ${c.table}`);
  }
  const rlsOk = rls['0'] === 0 && rls['999999'] === 0 && rls[String(PROBE_TENANT)] > 0;
  console.log(`${rlsOk ? '✓' : '✗'} RLS 基线0=${rls['0']} 不存在租户=${rls['999999']} 探针租户${PROBE_TENANT}=${rls[String(PROBE_TENANT)]}（前两者必须 0，探针租户必须 >0）`);
  if (!rlsOk) fails.push('RLS 三态探针失败');
  for (const s of seq) {
    const ok = s.lv >= s.mx;
    console.log(`${ok ? '✓' : '✗'} 序列 ${s.t}: last=${s.lv} max=${s.mx}（须 last ≥ max）`);
    if (!ok) fails.push(`序列回卷风险 ${s.t}`);
  }
  console.log('———————————————');
  if (fails.length) { console.log(`[sw-verify] ✗ 失败 ${fails.length} 项：${fails.join('；')}`); process.exit(1); }
  console.log(`[sw-verify] ✅ 全部通过（health + 锚点${sq ? '双侧' : '单侧'} + RLS 三态 + 序列 ${ANCHOR_TABLES.length} 表）`);
}

module.exports = { compareAnchors };
if (require.main === module) main().catch((e) => { console.error('[sw-verify] 致命错误：', e.message); process.exit(1); });
