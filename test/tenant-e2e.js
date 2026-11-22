/**
 * MT-07 双租户交叉越权 E2E 验收套件（2026-11-22）
 *
 * 覆盖 M1 多租户底座的核心承诺：
 *   - 单租户模式零回归（不启用租户边界）；
 *   - 多租户模式「租户硬边界」fail-closed：跨租户资源不可见；
 *   - 空间过滤 / reqTenantOpt / DAL 出口（tenantScope / tenantWhere / q）语义正确；
 *   - HTTP 层：多租户模式下缺租户上下文 → 403（fail-closed），公开端点不受影响。
 *
 * 用法：node test/tenant-e2e.js（内部设独立临时库，不污染生产数据）
 */
process.env.AGENT_DATA_DIR = require('path').join(__dirname, '..', '.temp', 'tenant-e2e-' + Date.now());

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch(e => { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); });
}

(async () => {
  console.log('【MT-07】双租户交叉越权 E2E');
  const { db } = require('../src-server/db');
  const { spaceFilterSql, filterBySpace, spaceVisibleTo, reqTenantOpt } = require('../src-server/lib/space-utils');
  const dal = require('../src-server/lib/dal');

  // ---------- 造双租户数据 ----------
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (username,password,nickname,role,status,created_at,tenant_id) VALUES ('bob','x','Bob','user',1,?,2)").run(now);
  db.prepare("INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('T2企业空间','enterprise','bob',1,?,2)").run(now);
  const sp2 = db.prepare("SELECT id FROM spaces WHERE name='T2企业空间'").get().id;
  db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('T2智能体','digital',?,'bob','published','public',2)").run(sp2);
  db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('T1智能体','digital',NULL,'admin','published','public',1)").run();
  db.prepare("INSERT INTO kbs (name,owner,space_id,created_at,tenant_id) VALUES ('T2知识库','bob',?,?,2)").run(sp2, now);
  db.prepare("INSERT INTO kbs (name,owner,space_id,created_at,tenant_id) VALUES ('T1知识库','admin',0,?,1)").run(now);
  db.prepare("INSERT INTO tasks (name,target_type,target_id,username,created_at,tenant_id) VALUES ('T2任务','agent',1,'bob',?,2)").run(now);

  const listAgents = (sqlStr, args) => db.prepare(`SELECT a.name FROM agents a WHERE 1=1 ${sqlStr}`).all(...args).map(r => r.name);
  const base = ` AND a.status='published'`;

  // ---------- 1. 单租户零回归 ----------
  await t('单租户：admin 零条件放行（sqlStr 为空）', () => {
    assert.strictEqual(spaceFilterSql('a', { username: 'admin', role: 'admin' }).sqlStr, '');
  });

  await t('单租户：普通用户过滤片段不含 tenant_id（零行为变更）', () => {
    const { sqlStr } = spaceFilterSql('a', { username: 'bob', role: 'user' });
    assert.ok(!/tenant_id/.test(sqlStr), '单租户不应出现 tenant_id 条件');
  });

  // ---------- 2. 多租户交叉不可见（agents） ----------
  await t('多租户：tenant=1 视角看不到他租户智能体', () => {
    const { sqlStr, args } = spaceFilterSql('a', { username: 'admin', role: 'admin' }, { tenantId: 1 });
    const names = listAgents(base + sqlStr, args);
    assert.ok(!names.includes('T2智能体'), 'tenant=1 不应见 T2智能体：' + JSON.stringify(names));
    assert.ok(names.includes('T1智能体'), 'tenant=1 应见 T1智能体：' + JSON.stringify(names));
  });

  await t('多租户：tenant=2 视角看不到本租户外（且 admin 亦受边界）', () => {
    const { sqlStr, args } = spaceFilterSql('a', { username: 'admin', role: 'admin' }, { tenantId: 2 });
    const names = listAgents(base + sqlStr, args);
    assert.ok(!names.includes('T1智能体'), 'tenant=2 不应见 T1智能体：' + JSON.stringify(names));
    assert.ok(names.includes('T2智能体'), 'tenant=2 应见 T2智能体：' + JSON.stringify(names));
  });

  // ---------- 3. filterBySpace（kbs，JS 侧） ----------
  await t('多租户：filterBySpace 跨租户知识库被过滤', () => {
    const rows = db.prepare('SELECT id,name,owner,space_id,tenant_id FROM kbs').all();
    const t1 = filterBySpace(rows, { username: 'admin', role: 'admin' }, db, 'space_id', 'owner', { tenantId: 1 }).map(r => r.name);
    const t2 = filterBySpace(rows, { username: 'bob', role: 'user' }, db, 'space_id', 'owner', { tenantId: 2 }).map(r => r.name);
    assert.ok(!t1.includes('T2知识库'), 'tenant=1 不应见 T2知识库：' + JSON.stringify(t1));
    assert.ok(!t2.includes('T1知识库'), 'tenant=2 不应见 T1知识库：' + JSON.stringify(t2));
  });

  await t('单租户：filterBySpace 语义不变（admin 全见、普通用户按空间/owner）', () => {
    const rows = db.prepare('SELECT id,name,owner,space_id,tenant_id FROM kbs').all();
    const adminRows = filterBySpace(rows, { username: 'admin', role: 'admin' }, db);
    assert.strictEqual(adminRows.length, rows.length, '单租户 admin 应见全部');
  });

  // ---------- 4. spaceVisibleTo 跨租户 ----------
  await t('spaceVisibleTo：跨租户空间不可见、本租户企业空间可见', () => {
    assert.strictEqual(spaceVisibleTo(db, sp2, 'bob', { tenantId: 1 }), false, 'tenant=1 看 tenant=2 空间应不可见');
    assert.strictEqual(spaceVisibleTo(db, sp2, 'bob', { tenantId: 2 }), true, 'tenant=2 看本租户企业空间应可见');
  });

  // ---------- 5. reqTenantOpt / DAL 出口 ----------
  await t('reqTenantOpt：单租户→{}；多租户→{tenantId}', () => {
    assert.deepStrictEqual(reqTenantOpt({ tenant: { id: 1, single: true } }), {});
    assert.deepStrictEqual(reqTenantOpt({ tenant: { id: 2 } }), { tenantId: 2 });
    assert.deepStrictEqual(reqTenantOpt({}), {});
  });

  await t('DAL tenantScope/tenantWhere：单租户空片段、多租户强制注入', () => {
    assert.strictEqual(dal.tenantScope({ tenant: { id: 1, single: true } }), null);
    assert.strictEqual(dal.tenantScope({ tenant: { id: 3 } }), 3);
    assert.deepStrictEqual(dal.tenantWhere('a', null), { sqlStr: '', args: [] });
    assert.deepStrictEqual(dal.tenantWhere('a', 3), { sqlStr: ' AND a.tenant_id=?', args: [3] });
  });

  await t('DAL q()：经方言出口（sqlite 恒等）且在隔离库可用', () => {
    const rows = dal.q('SELECT COUNT(*) AS c FROM users');
    assert.ok(rows[0].c >= 1, 'q() 应返回计数');
    assert.strictEqual(dal.translateSql('SELECT datetime(\'now\')'), "SELECT datetime('now')", 'sqlite 方言恒等翻译');
  });

  // ---------- 6. HTTP：多租户 fail-closed ----------
  const port = 3300 + Math.floor(Math.random() * 400);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, AGENT_MULTI_TENANT: '1' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { up = (await fetch(origin + '/api/health')).ok; } catch { }
    }
    await t('HTTP 多租户：公开端点 /api/health 正常（200）', () => {
      assert.ok(up, 'server 应在 10s 内就绪');
    });
    await t('HTTP 多租户：缺租户上下文的受保护端点 → 403（fail-closed）', async () => {
      const r = await fetch(origin + '/api/agents');
      assert.strictEqual(r.status, 403, `缺租户应 403，实际 ${r.status}`);
    });
    await t('HTTP 多租户：带 X-Tenant-Id 头但未认证 → 401（租户已解析、认证拦截）', async () => {
      const r = await fetch(origin + '/api/agents', { headers: { 'X-Tenant-Id': '2' } });
      assert.strictEqual(r.status, 401, `带租户头未认证应 401，实际 ${r.status}`);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    try { child.kill('SIGKILL'); } catch { }
  }

  // 清理独立临时库
  try { require('fs').rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true }); } catch { }

  console.log('———————————————');
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
