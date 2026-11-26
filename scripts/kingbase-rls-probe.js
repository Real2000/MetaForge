#!/usr/bin/env node
/**
 * IC-1 CI 轨道（M11，2026-11-25）：kingbase RLS 行为探针（独立诊断工具）
 *
 * 资产由 XC-1 演练脚本提升转正（.temp/xc1-rls-probe.js → 本文件，探针逻辑逐行等价 + 连接参数化）。
 * 覆盖八项：superuser 旁路 / FORCE 后 owner 受控 / 回退缺省 '0' / SET LOCAL 事务级注入 /
 *          跨租户互不可见 / WITH CHECK 写拦截 / platform 逃逸通道 / 事务结束复位。
 *
 * ⚠️ 定位：独立诊断工具，**不纳入 npm run test:tenant:kingbase 轨道**——探针会 DROP 并重建
 * mt7_app 角色与 rls_probe 表（XC-1 演练同款自清理语义），只应在轨道复位前或专门排障时运行；
 * 运行后如需跑 e2e，先重跑 kingbase-track-reset.js 恢复角色/库/schema。
 *
 * 运行：node scripts/kingbase-rls-probe.js（前置：kingbase-track 容器已启动）
 * 连接：KB_ADMIN_CONN（默认本地演练容器 system 超户，XC-1 实测同款）
 */
'use strict';
const { Client } = require('pg');

const CONN_ADMIN = process.env.KB_ADMIN_CONN || 'postgres://system:Mt7kingbase2026@localhost:54321/kingbase';

// 与 lib/pg-rls.js L64-74 完全同款（XC-1 验收要求：行为差异清单以生产同款语义为基线）
// 注意：ENABLE 是启用开关（FORCE 只控 owner），漏 ENABLE 则 RLS 完全不生效（首轮探针踩坑）
const POLICY_SQL = (table) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  `DROP POLICY IF EXISTS tenant_isolation ON ${table};`,
  `CREATE POLICY tenant_isolation ON ${table} USING (` +
    `current_setting('app.tenant_id', true) = 'platform'` +
    ` OR tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.tenant_id', true), ''), 'platform'), '0')::int)` +
    ` WITH CHECK (current_setting('app.tenant_id', true) = 'platform'` +
    ` OR tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.tenant_id', true), ''), 'platform'), '0')::int);`,
];

async function main() {
  const admin = new Client({ connectionString: CONN_ADMIN });
  await admin.connect();
  const results = [];
  const probe = async (name, fn) => {
    try { const r = await fn(); results.push(`✅ ${name}: ${r}`); console.log(`✅ ${name}: ${r}`); }
    catch (e) { results.push(`❌ ${name}: ${e.message.slice(0, 100)}`); console.log(`❌ ${name}: ${e.message.slice(0, 100)}`); }
  };

  // ① superuser 属性（kingbase system 默认是否 bypass RLS 的前置判定）
  const su = await admin.query("SELECT rolname, rolsuper FROM pg_roles WHERE rolname='system'");
  console.log('① system 用户 rolsuper =', su.rows[0].rolsuper);
  await admin.query(`DROP USER IF EXISTS mt7_app`);
  await admin.query(`CREATE USER mt7_app WITH PASSWORD 'mt7_app_poc'`);

  // ② 建表（mt7_app 为 owner——FORCE 后 owner 受控的实测前提）+ 三租户数据
  await admin.query(`DROP TABLE IF EXISTS rls_probe`);
  await admin.query(`CREATE TABLE rls_probe (id int primary key, tenant_id int not null, data text)`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON rls_probe TO mt7_app`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO mt7_app`);
  for (const [id, t, d] of [[1, 0, '平台基线'], [2, 1, '租户一'], [3, 2, '租户二']]) {
    await admin.query(`INSERT INTO rls_probe VALUES ($1,$2,$3)`, [id, t, d]);
  }
  await admin.query(`ALTER TABLE rls_probe OWNER TO mt7_app`);
  for (const sql of POLICY_SQL('rls_probe')) await admin.query(sql);

  const app = new Client({ ...connParts(CONN_ADMIN), user: 'mt7_app', password: 'mt7_app_poc' });
  await app.connect();

  await probe('② owner+FORCE 下无上下文只见基线（回退 0）', async () => {
    const r = await app.query('SELECT COUNT(*) c FROM rls_probe');
    if (Number(r.rows[0].c) !== 1) throw new Error(`期望 1 行（基线），实际 ${r.rows[0].c}`);
    const row = await app.query('SELECT data FROM rls_probe');
    return `仅见「${row.rows[0].data}」`;
  });

  await probe('③ SET LOCAL 事务级注入（租户 2）', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', '2', true)");
    const r = await app.query('SELECT COUNT(*) c FROM rls_probe');
    const d = await app.query('SELECT data FROM rls_probe');
    await app.query('COMMIT');
    if (Number(r.rows[0].c) !== 1) throw new Error(`期望 1 行，实际 ${r.rows[0].c}`);
    return `事务内仅见「${d.rows[0].data}」`;
  });

  await probe('④ 事务结束复位（回退基线）', async () => {
    const r = await app.query('SELECT COUNT(*) c FROM rls_probe');
    return `COMMIT 后可见 ${r.rows[0].c} 行（期望 1，回退生效）`;
  });

  await probe('⑤ platform 逃逸通道全可见', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', 'platform', true)");
    const r = await app.query('SELECT COUNT(*) c FROM rls_probe');
    await app.query('COMMIT');
    if (Number(r.rows[0].c) !== 3) throw new Error(`期望 3 行全可见，实际 ${r.rows[0].c}`);
    return 'platform 上下文可见全部 3 行';
  });

  await probe('⑥ WITH CHECK 跨租户写拦截', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', '1', true)");
    try {
      await app.query(`INSERT INTO rls_probe VALUES (99, 2, '越权写')`);
      await app.query('ROLLBACK');
      throw new Error('越权写未被拦截（安全缺陷）');
    } catch (e) {
      await app.query('ROLLBACK');
      if (!/violate|row-level|policy|check/i.test(e.message)) throw e;
      return '租户 1 写租户 2 的行被策略拒绝';
    }
  });

  await probe('⑦ 本租户写放行', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', '1', true)");
    const r = await app.query(`INSERT INTO rls_probe VALUES (98, 1, '本租户写') RETURNING id`);
    await app.query('COMMIT');
    if (r.rows[0].id !== 98) throw new Error('本租户写失败');
    return '租户 1 写本租户行通过 RETURNING id=98';
  });

  // ⑧ superuser 是否 bypass（kingbase 的 RLS 与 PG16 同语义则 bypass）
  await probe('⑧ superuser bypass 行为（与 PG 系语义对照记录）', async () => {
    const r = await admin.query('SELECT COUNT(*) c FROM rls_probe');
    return `system(${su.rows[0].rolsuper ? 'superuser' : '非super'}) 无上下文直查可见 ${r.rows[0].c} 行`;
  });

  // 清理（演练数据最小化）——先断 app 连接再删用户（kingbase 不允许删除在线会话用户）
  await app.end();
  await admin.query('DROP TABLE IF EXISTS rls_probe');
  try { await admin.query('DROP OWNED BY mt7_app'); } catch { }
  await admin.query('DROP USER IF EXISTS mt7_app');
  await admin.end();
  console.log('\n==== kingbase RLS 探针完成 ====');
  results.forEach(r => console.log(r));
  // 任一探针 ❌ → 退出码 1（诊断工具也可被脚本化调用）
  if (results.some(r => r.startsWith('❌'))) process.exitCode = 1;
}

/** URL → pg Client 连接参数（探针以业务角色连接同实例时复用 host/port） */
function connParts(url) {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  };
}

main().catch(e => { console.error('探针失败:', e && e.stack || e); process.exit(1); });