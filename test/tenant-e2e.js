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
  // PG 模式（MT-7/PG-1：FORCE RLS 已生效）：直连 db 的写入/读取须在对应租户上下文内
  //（与 auth 中间件同语义）；sqlite 无 withTenant → 直通执行，双驱动共用同一套用例。
  const hasPgCtx = typeof db.withTenant === 'function';
  const asTenant = (tid, fn) => (hasPgCtx ? db.withTenant(tid, fn) : fn());

  // ---------- 造双租户数据 ----------
  const now = new Date().toISOString();
  const sp2 = asTenant(2, () => {
    db.prepare("INSERT INTO users (username,password,nickname,role,status,created_at,tenant_id) VALUES ('bob','x','Bob','user',1,?,2)").run(now);
    db.prepare("INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('T2企业空间','enterprise','bob',1,?,2)").run(now);
    const sid = db.prepare("SELECT id FROM spaces WHERE name='T2企业空间'").get().id;
    db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('T2智能体','digital',?,'bob','published','public',2)").run(sid);
    db.prepare("INSERT INTO kbs (name,owner,space_id,created_at,tenant_id) VALUES ('T2知识库','bob',?,?,2)").run(sid, now);
    db.prepare("INSERT INTO tasks (name,target_type,target_id,username,created_at,tenant_id) VALUES ('T2任务','agent',1,'bob',?,2)").run(now);
    return sid;
  });
  asTenant(1, () => {
    db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('T1智能体','digital',NULL,'admin','published','public',1)").run();
    db.prepare("INSERT INTO kbs (name,owner,space_id,created_at,tenant_id) VALUES ('T1知识库','admin',0,?,1)").run(now);
  });

  // ---------- 0. PG-1：DB 层 FORCE RLS 实证（PG 轨道专属；sqlite 无 RLS 跳过） ----------
  // 背景（2026-11-24 复现踩坑）：三参 NULLIF 语法错使 applyRls 整体失败且被启动 catch 吞掉——
  // 策略数 0，此前 26 项全绿仅靠应用层过滤（DAL tenantWhere），DB 层隔离从未被验证过（假绿）。
  // 本用例绕开应用层直查 db，验证 RLS 会话变量隔离的真实生效。
  if (hasPgCtx) {
    await t('PG-1：DB 层 FORCE RLS 实证——策略已应用 + 跨租户行会话隔离不可见（非应用层）', () => {
      const pol = db.prepare("SELECT COUNT(*) c FROM pg_policy WHERE polname='tenant_isolation'").get().c;
      // 期望覆盖面动态计算（TENANT_TABLES − 平面排除；workflow_templates 入排除后为 68）
      const { TENANT_TABLES } = require('../src-server/lib/tenant-tables');
      const { PLATFORM_PLANE_EXCLUDE } = require('../src-server/lib/pg-rls');
      const expectPol = TENANT_TABLES.length - PLATFORM_PLANE_EXCLUDE.length;
      assert.ok(pol >= expectPol, `tenant_isolation 策略应 ≥${expectPol} 张（实际 ${pol}）——applyRls 失败防线（启动 fail-closed）`);
      const seen1 = asTenant(1, () => db.prepare('SELECT COUNT(*) c FROM agents WHERE tenant_id=2').get().c);
      assert.strictEqual(seen1, 0, 'tenant=1 上下文直查不得见 tenant=2 行（DB 层 RLS）');
      const seenNoCtx = db.prepare('SELECT COUNT(*) c FROM agents WHERE tenant_id=2').get().c;
      assert.strictEqual(seenNoCtx, 0, '无上下文（基线 0）直查不得见 tenant=2 行（fail-closed）');
      const seenPlat = db.withTenant('platform', () => db.prepare('SELECT COUNT(*) c FROM agents WHERE tenant_id=2').get().c);
      assert.ok(seenPlat >= 1, "'platform' 显式逃逸应可见（运维通道）");
      // 写向隔离：tenant=1 上下文写入 tenant_id=2 行应被 WITH CHECK 拒绝
      let denied = false;
      asTenant(1, () => {
        try { db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('RLS-WRITE-PROBE','digital',NULL,'admin','published','public',2)").run(); }
        catch { denied = true; }
      });
      assert.ok(denied, '跨租户写入应被 WITH CHECK 拒绝（DB 层 fail-closed）');
    });
  }

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
  await t('多租户：tenant=1 视角看不到他租户智能体', () => asTenant(1, () => {
    const { sqlStr, args } = spaceFilterSql('a', { username: 'admin', role: 'admin' }, { tenantId: 1 });
    const names = listAgents(base + sqlStr, args);
    assert.ok(!names.includes('T2智能体'), 'tenant=1 不应见 T2智能体：' + JSON.stringify(names));
    assert.ok(names.includes('T1智能体'), 'tenant=1 应见 T1智能体：' + JSON.stringify(names));
  }));

  await t('多租户：tenant=2 视角看不到本租户外（且 admin 亦受边界）', () => asTenant(2, () => {
    const { sqlStr, args } = spaceFilterSql('a', { username: 'admin', role: 'admin' }, { tenantId: 2 });
    const names = listAgents(base + sqlStr, args);
    assert.ok(!names.includes('T1智能体'), 'tenant=2 不应见 T1智能体：' + JSON.stringify(names));
    assert.ok(names.includes('T2智能体'), 'tenant=2 应见 T2智能体：' + JSON.stringify(names));
  }));

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
    assert.strictEqual(asTenant(1, () => spaceVisibleTo(db, sp2, 'bob', { tenantId: 1 })), false, 'tenant=1 看 tenant=2 空间应不可见');
    assert.strictEqual(asTenant(2, () => spaceVisibleTo(db, sp2, 'bob', { tenantId: 2 })), true, 'tenant=2 看本租户企业空间应可见');
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

  await t('DAL q()：经方言出口（sqlite 恒等 / PG 走 kingbase 翻译）且在隔离库可用', () => {
    const rows = dal.q('SELECT COUNT(*) AS c FROM users');
    assert.ok(rows[0].c >= 1, 'q() 应返回计数');
    if (hasPgCtx) {
      // PG 轨道：dal 绑定 kingbase 方言，datetime → CURRENT_TIMESTAMP（BE-C2 语义锚定）
      assert.strictEqual(dal.translateSql("SELECT datetime('now')"), "SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')", 'PG 轨道应经方言翻译（TEXT 契约 + 业务基准钟，PG-1 语义修复）');
    } else {
      assert.strictEqual(dal.translateSql("SELECT datetime('now')"), "SELECT datetime('now')", 'sqlite 方言恒等翻译');
    }
  });

  // ---------- 6. HTTP：多租户 fail-closed ----------
  const port = 3300 + Math.floor(Math.random() * 400);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, AGENT_MULTI_TENANT: '1', PAYMENT_CALLBACK_SECRET: 'e2e-pay-secret', AGENT_FETCH_ALLOW_PRIVATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], // PG 轨道排障：服务启动失败时需看到 stderr（不能 ignore）
  });
  let srvLog = '';
  child.stdout.on('data', c => { srvLog += c; });
  child.stderr.on('data', c => { srvLog += c; });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { up = (await fetch(origin + '/api/health')).ok; } catch { }
    }
    await t('HTTP 多租户：公开端点 /api/health 正常（200）', () => {
      if (!up) { // 服务未就绪：透出启动日志尾部，避免 PG 轨道排障盲区
        console.error('     [server 启动日志尾部]\n     ' + String(srvLog).trim().split('\n').slice(-20).join('\n     '));
      }
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

    // ---------- 7. MT-08/09/10 租户商用闭环 ----------
    const login = async (username, password) => {
      const r = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return r.json();
    };
    const jpost = async (url, token, body) => (await fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) })).json();
    let adminTok = '';
    let t2Tok = ''; // 租户 2 管理员令牌（跨用例复用——登录有限流，重复 login 会挤爆后续用例）

    await t('MT-08：平台超管登录返回 tenant_id 与 platform_admin 标记', async () => {
      const j = await login('admin', 'admin123');
      assert.strictEqual(j.code, 0, JSON.stringify(j));
      assert.strictEqual(j.data.user.platform_admin, 1, 'admin 应为平台超管');
      assert.strictEqual(j.data.user.tenant_id, 1);
      adminTok = j.data.token;
    });

    await t('MT-10：平台超管开通租户并派生首个管理员', async () => {
      const j = await jpost('/api/tenants', adminTok, { name: 'E2E客户X', plan: 'pro', adminUsername: 'e2eadm', adminPassword: 'E2e@2026' });
      assert.strictEqual(j.code, 0, JSON.stringify(j));
      const list = await (await fetch(origin + '/api/tenants', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
      assert.ok(list.data.some(x => x.name === 'E2E客户X'), '新租户应出现在列表');
    });

    await t('MT-10：重名开通被拒（用户名全局唯一）', async () => {
      const j = await jpost('/api/tenants', adminTok, { name: 'X2', adminUsername: 'e2eadm', adminPassword: 'E2e@2026' });
      assert.strictEqual(j.code, 400, JSON.stringify(j));
    });

    await t('MT-08：租户管理员仅见本租户用户、无权访问租户本体', async () => {
      const j = await login('e2eadm', 'E2e@2026');
      assert.strictEqual(j.code, 0, JSON.stringify(j));
      assert.strictEqual(j.data.user.tenant_id, 2, '派生管理员应属新租户');
      assert.strictEqual(j.data.user.platform_admin, 0, '派生管理员非平台超管');
      t2Tok = j.data.token;
      const uj = await (await fetch(origin + '/api/users', { headers: { Authorization: 'Bearer ' + t2Tok } })).json();
      assert.ok(uj.data.length >= 1 && uj.data.every(u => u.tenant_id === 2), '应仅见本租户用户：' + JSON.stringify(uj.data.map(u => u.username)));
      const tr = await fetch(origin + '/api/tenants', { headers: { Authorization: 'Bearer ' + t2Tok } });
      assert.strictEqual(tr.status, 403, '租户管理员访问租户列表应 403');
    });

    await t('MT-09：平台超管跨租户借用（impersonation）签发可用令牌；未确认被拒', async () => {
      const uj = await (await fetch(origin + '/api/users?tenant_id=2', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
      const target = uj.data.find(u => u.username === 'e2eadm');
      assert.ok(target, '应能跨租户检索到目标用户');
      const noConfirm = await jpost('/api/platform-admin/impersonate', adminTok, { user_id: target.id });
      assert.strictEqual(noConfirm.code, 400, '未 confirm 应被拒');
      const j = await jpost('/api/platform-admin/impersonate', adminTok, { user_id: target.id, confirm: true });
      assert.strictEqual(j.code, 0, JSON.stringify(j));
      const mj = await (await fetch(origin + '/api/auth/me', { headers: { Authorization: 'Bearer ' + j.data.token } })).json();
      assert.strictEqual(mj.data.username, 'e2eadm', '借用令牌应以目标用户身份生效');
    });

    // ---------- 7.5 PG-1 增量（2026-11-24）：写路径注入器 + 后台接线（PG 轨道专属）----------
    // 背景：业务 INSERT 普遍不写 tenant_id（列默认 1）——租户 2 请求下新行错挂租户 1，
    // PG 模式被 RLS WITH CHECK 直接拒绝（无法建会话）。桥层注入器统一兜底，本组用例端到端实证。
    if (hasPgCtx) {
      await t('PG-1 增量：租户 2 HTTP 建会话——桥层租户列注入器落正确归属 + 双向隔离', async () => {
        // 复用 MT-08 的 t2Tok——登录有限流（每分钟 N 次），重复 login 会挤爆后续停用租户用例
        const r = await (await fetch(origin + '/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t2Tok }, body: JSON.stringify({ title: 'T2注入器会话' }) })).json();
        assert.strictEqual(r.code, 0, JSON.stringify(r));
        const row = db.withTenant('platform', () => db.prepare('SELECT tenant_id FROM sessions WHERE id=?').get(r.data.id));
        assert.ok(row && Number(row.tenant_id) === 2, `会话行应归属租户 2（桥注入器生效），实际 ${row && row.tenant_id}`);
        const list = await (await fetch(origin + '/api/chat/sessions', { headers: { Authorization: 'Bearer ' + t2Tok } })).json();
        assert.ok(list.code === 0 && Array.isArray(list.data) && list.data.some(s => s.id === r.data.id), '租户 2 用户应能读到自己的新会话');
        const leak = asTenant(1, () => db.prepare('SELECT id FROM sessions WHERE id=?').get(r.data.id));
        assert.ok(!leak, '租户 1 不得见到租户 2 会话（DB 层 RLS）');
      });

      await t('PG-1 增量：后台摘要任务接线——platform 跨租户读 + 显式行归属租户落库', () => {
        const { withDbTenant } = require('../src-server/db');
        const ops = require('../src-server/lib/ops');
        const shanghaiNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const aid = asTenant(2, () => {
          const a = db.prepare("INSERT INTO agents (name,type,owner,status,visibility,tenant_id,long_memory) VALUES ('T2记忆助手','digital','e2eadm','published','public',2,1)").run();
          const sid = db.prepare("INSERT INTO sessions (agent_id,title,username,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(a.lastInsertRowid, '摘要用例', 'e2eadm', 2, shanghaiNow, shanghaiNow).lastInsertRowid;
          const insMsg = db.prepare("INSERT INTO messages (session_id,role,content,tokens,tenant_id,created_at) VALUES (?, 'user', ?, 0, 2, ?)");
          for (let i = 0; i < 5; i++) insMsg.run(sid, '话题 ' + i + '：会话内容样本', shanghaiNow);
          return a.lastInsertRowid;
        });
        // 镜像 startOps 的包裹方式（运维任务统一 platform 逃逸上下文——无上下文时 RLS 下只见基线 0 行）
        const r = withDbTenant('platform', () => ops.digestMemories());
        assert.ok(r && r.ok, '摘要任务应成功：' + JSON.stringify(r));
        const mem = db.withTenant('platform', () => db.prepare("SELECT tenant_id, source FROM agent_memories WHERE agent_id=? AND source='digest' LIMIT 1").get(aid));
        assert.ok(mem, '应产出摘要行（platform 跨租户读到租户 2 会话——后台接线生效）');
        assert.strictEqual(Number(mem.tenant_id), 2, '摘要行应显式归属租户 2（不随列默认错挂租户 1）');
        const leak = asTenant(1, () => db.prepare('SELECT id FROM agent_memories WHERE agent_id=? LIMIT 1').get(aid));
        assert.ok(!leak, '租户 1 不得见到租户 2 的记忆行（RLS）');
      });
    }

    // ---------- 8. MT-11/12/13 商用闭环（账单 / 隔离 / 支付） ----------
    await t('MT-11：租户账单隔离——平台超管跨租户、租户管理员仅本租户（伪造 tenant_id 被强制）', async () => {
      const ins = "INSERT INTO usage_records (username,dimension,dimension_key,tokens,count,cost,prompt_tokens,completion_tokens,tenant_id,created_at) VALUES (?,?,?,?,1,?,?,?,?,datetime('now','localtime'))";
      db.prepare(ins).run('admin', 'model', 'm1', 100, 1.5, 60, 40, 1);
      db.prepare(ins).run('e2eadm', 'model', 'm1', 200, 2.5, 120, 80, 2);
      const superAll = await (await fetch(origin + '/api/billing/tenants', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
      assert.strictEqual(superAll.code, 0, JSON.stringify(superAll));
      const tids = superAll.data.tenants.map(x => x.tenant_id);
      assert.ok(tids.includes(2), '平台超管应见新租户成本：' + JSON.stringify(tids));
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      const mine = await (await fetch(origin + '/api/billing/tenants', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.ok(mine.data.tenants.length > 0 && mine.data.tenants.every(x => x.tenant_id === 2), '租户管理员仅见本租户：' + JSON.stringify(mine.data.tenants));
      const force = await (await fetch(origin + '/api/billing/tenants?tenant_id=1', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.ok(force.data.tenants.every(x => x.tenant_id === 2), '伪造 tenant_id 应被强制本租户：' + JSON.stringify(force.data.tenants));
    });

    await t('MT-11：跨租户调整用户配额被拒（403）', async () => {
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      const r = await fetch(origin + '/api/quota/users/admin', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + btok }, body: JSON.stringify({ total: 123 }) });
      assert.strictEqual(r.status, 403, '跨租户改配额应 403，实际 ' + r.status);
    });

    await t('MT-12：密钥分层——租户层列表仅见本层；平台全局层不含租户密钥', async () => {
      await jpost('/api/secrets', adminTok, { name: 'E2E_GLOBAL', value: 'gvalue-12345' });
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      await jpost('/api/secrets', btok, { name: 'E2E_T2', value: 't2val-123456' });
      const tj = await (await fetch(origin + '/api/secrets', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.ok(tj.data.some(x => x.name === 'E2E_T2'), '租户层应见本租户密钥');
      assert.ok(!tj.data.some(x => x.name === 'E2E_GLOBAL'), '租户层列表不应含平台全局密钥');
      const gj = await (await fetch(origin + '/api/secrets', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
      assert.ok(gj.data.some(x => x.name === 'E2E_GLOBAL'), '全局层应见全局密钥');
      assert.ok(!gj.data.some(x => x.name === 'E2E_T2'), '全局层不应含租户密钥');
    });

    await t('MT-12：供应商可见性——租户层可见「全局基线 ∪ 本租户」，不可见他租户层', async () => {
      await jpost('/api/providers', adminTok, { name: 'E2E_全局供应商', base_url: 'https://api.example.com/v1', models: ['m-e2e'] });
      await jpost('/api/providers?tenant_id=1', adminTok, { name: 'E2E_T1供应商', base_url: 'https://api.t1.com/v1', models: ['m-t1'] });
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      await jpost('/api/providers', btok, { name: 'E2E_T2供应商', base_url: 'https://api.t2.com/v1', models: ['m-t2'] });
      const list = await (await fetch(origin + '/api/providers', { headers: { Authorization: 'Bearer ' + btok } })).json();
      const names = (list.data || []).map(p => p.name);
      assert.ok(names.includes('E2E_全局供应商'), '应见全局基线：' + JSON.stringify(names));
      assert.ok(names.includes('E2E_T2供应商'), '应见本租户供应商');
      assert.ok(!names.includes('E2E_T1供应商'), '不应见他租户供应商：' + JSON.stringify(names));
    });

    await t('MT-13：租户下单 → 平台超管标记已支付 → 订阅生效 + 成员配额下发', async () => {
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      const c = await jpost('/api/payment/orders', btok, { type: 'subscribe', plan_key: 'pro', channel: 'sandbox' });
      assert.strictEqual(c.code, 0, JSON.stringify(c));
      const no = c.data.order_no;
      const ol = await (await fetch(origin + '/api/payment/orders', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.ok(ol.data.length > 0 && ol.data.every(o => o.tenant_id === 2), '租户订单列表仅本租户：' + JSON.stringify(ol.data.map(o => o.tenant_id)));
      const mp = await jpost(`/api/payment/orders/${no}/mark-paid`, adminTok, {});
      assert.strictEqual(mp.code, 0, JSON.stringify(mp));
      const st = await (await fetch(origin + '/api/payment/status', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.strictEqual(st.data.subscription.status, 'active');
      assert.strictEqual(st.data.subscription.plan_key, 'pro');
      const uj = await (await fetch(origin + '/api/users', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.ok(uj.data.every(u => u.quota_total === 5000000), '成员配额应下发套餐额度：' + JSON.stringify(uj.data.map(u => u.quota_total)));
    });

    await t('MT-13：沙箱回调验签 + 幂等（同 event_id 只生效一次）；未签名被拒', async () => {
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      const c = await jpost('/api/payment/orders', btok, { type: 'recharge', amount: 66, channel: 'sandbox' });
      const no = c.data.order_no;
      const r0 = await fetch(origin + '/api/payment/callback/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_no: no, event_id: 'e2e-evt-x', status: 'paid', amount: 66 }) });
      assert.strictEqual(r0.status, 401, '无签名回调应 401，实际 ' + r0.status);
      const s = (await jpost(`/api/payment/orders/${no}/sign`, adminTok, { event_id: 'e2e-evt-1' })).data;
      const post = () => fetch(origin + '/api/payment/callback/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pay-Sign': s.sign }, body: s.raw });
      const r1 = await (await post()).json();
      assert.strictEqual(r1.code, 0, JSON.stringify(r1));
      const r2 = await (await post()).json();
      assert.strictEqual(r2.data.idempotent, true, '重复回调应幂等');
      const st = await (await fetch(origin + '/api/payment/status', { headers: { Authorization: 'Bearer ' + btok } })).json();
      assert.strictEqual(st.data.wallet.balance, 66, '充值应入钱包且不重复：' + JSON.stringify(st.data.wallet));
    });

    await t('MT-13：支付对账账实一致（平台超管）', async () => {
      const rec = await (await fetch(origin + '/api/payment/reconcile', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
      assert.strictEqual(rec.code, 0, JSON.stringify(rec));
      assert.strictEqual(rec.data.balanced, true, '对账应账实一致：' + JSON.stringify(rec.data));
    });

    await t('MT-10：停用租户后其账号登录被拒、旧令牌失效', async () => {
      const btok = t2Tok; // 复用 MT-08 登录令牌——登录有限流（1 分钟窗口），逐用例重复 login 会挤爆后续用例
      const r = await fetch(origin + '/api/tenants/2/status', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ status: 'disabled' }) });
      assert.strictEqual((await r.json()).code, 0);
      const blocked = await login('e2eadm', 'E2e@2026');
      assert.strictEqual(blocked.code, 403, '停用租户登录应 403：' + JSON.stringify(blocked));
      const me = await fetch(origin + '/api/auth/me', { headers: { Authorization: 'Bearer ' + btok } });
      assert.strictEqual(me.status, 401, '停用后旧令牌应失效');
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
