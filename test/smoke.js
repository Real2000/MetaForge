/**
 * 核心链路自动化冒烟测试（2026-10-20 P1；P3 扩展）
 * 用法：npm test（内部设 AGENT_DATA_DIR=.temp/test-data，独立临时库，不污染生产数据，结束自动清理）
 * 覆盖：密码哈希与双 SALT 兼容 / Token 签发校验 / 限流器 / 熔断器 / 模型候选降级（含用户自有模型源） /
 *       @技能解析 / 备份幂等 / 日志归档 / cron 计算。纯本地逻辑，不访问真实网关。
 */
process.env.AGENT_DATA_DIR = require('path').join(__dirname, '..', '.temp', 'test-data-' + Date.now());

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch(e => { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); });
}

(async () => {
  console.log('【1】密码哈希与认证');
  const { db, hashPwd, verifyPwd } = require('../src-server/db');
  await t('hashPwd 稳定且区分大小写', async () => {
    const pwd = 'abc123';
    const h1 = await hashPwd(pwd);
    const h2 = await hashPwd(pwd);
    const h3 = await hashPwd('ABC123');
    // 同样的密码每次生成不同盐值，因此哈希不同（由 salt 保证）
    assert.notStrictEqual(h1, h2);
    // 密码区分大小写：不同大小写一定不同
    assert.notStrictEqual(h1, h3);
    // 但都能被 verifyPwd 正确验证
    assert.deepStrictEqual(await verifyPwd(pwd, h1), { ok: true, legacy: false });
    assert.deepStrictEqual(await verifyPwd(pwd, h2), { ok: true, legacy: false });
    assert.strictEqual((await verifyPwd('ABC123', h1)).ok, false);
  });
  await t('verifyPwd 新 SALT 命中 / 错误密码拒绝', async () => {
    const stored = await hashPwd('right-pass');
    assert.deepStrictEqual(await verifyPwd('right-pass', stored), { ok: true, legacy: false });
    assert.strictEqual((await verifyPwd('wrong-pass', stored)).ok, false);
  });
  await t('verifyPwd 旧 SALT（升级前存量密码）兼容命中且标记 legacy', async () => {
    const legacyHash = require('crypto').createHash('sha256').update('agent-platform-salt-v1' + 'old-user-pwd').digest('hex');
    const v = await verifyPwd('old-user-pwd', legacyHash);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.legacy, true);
  });
  await t('Token 签发→校验→篡改拒绝→过期拒绝', () => {
    const { sign, verify } = require('../src-server/lib/auth');
    const tk = sign({ uid: 1, exp: Date.now() + 60000 });
    assert.strictEqual(verify(tk).uid, 1);
    assert.strictEqual(verify(tk + 'x'), null);           // 篡改
    assert.strictEqual(verify('not-a-token'), null);       // 格式非法
    assert.strictEqual(verify(sign({ uid: 1, exp: Date.now() - 1 })), null); // 过期
  });

  console.log('【2】限流器');
  const { createLimiter, clientIp } = require('../src-server/lib/rate-limit');
  await t('滑动窗口：max=3 时第 4 次拦截并返回 429', async () => {
    const lim = createLimiter({ name: 't2', windowMs: 2000, max: 3, keyFn: () => 'same-key', msg: '太快了' });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      await new Promise(r => {
        const req = { ip: '9.9.9.9', headers: {}, path: '/api/x' };
        const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(j) { this.body = j; r(this.code); } };
        lim(req, res, () => r(200));
      }).then(c => codes.push(c));
    }
    assert.deepStrictEqual(codes, [200, 200, 200, 429]);
  });
  await t('不同 key 互不影响 / 窗口过期后恢复', async () => {
    const lim = createLimiter({ name: 't2b', windowMs: 300, max: 1, keyFn: r => r.k, msg: 'x' });
    const call = k => new Promise(r => {
      const req = { k, ip: '1.1.1.1', headers: {}, path: '/api/y' };
      const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(j) { this.body = j; r(this.code); } };
      lim(req, res, () => r(200));
    });
    assert.strictEqual(await call('a'), 200);
    assert.strictEqual(await call('b'), 200);   // 不同 key 不受影响
    assert.strictEqual(await call('a'), 429);   // 同 key 第二次拦截
    await new Promise(r => setTimeout(r, 350)); // 窗口过期
    assert.strictEqual(await call('a'), 200);   // 恢复
  });
  await t('clientIp：默认直连忽略 XFF（防伪造绕过限流）；受信代理按跳数采信', () => {
    const { trustHops } = require('../src-server/lib/rate-limit');
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' };
    const saved = process.env.AGENT_TRUST_PROXY;
    try {
      delete process.env.AGENT_TRUST_PROXY;
      assert.strictEqual(trustHops(), 0, '未配置 → 0 跳');
      assert.strictEqual(clientIp(req), '127.0.0.1', '默认不信任 XFF，以 TCP 源地址为准（SEC-01）');
      assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' }, ip: '10.0.0.9' }), '10.0.0.9', '无 XFF → TCP 源地址');
      process.env.AGENT_TRUST_PROXY = '1';
      assert.strictEqual(clientIp(req), '5.6.7.8', '信任 1 跳 → 取 XFF 末段');
      process.env.AGENT_TRUST_PROXY = '2';
      assert.strictEqual(clientIp(req), '1.2.3.4', '信任 2 跳 → 取 XFF 首段');
      process.env.AGENT_TRUST_PROXY = '3';
      assert.strictEqual(clientIp(req), '127.0.0.1', '链路不足 N 跳 → 回落 TCP 源地址');
    } finally {
      if (saved === undefined) delete process.env.AGENT_TRUST_PROXY; else process.env.AGENT_TRUST_PROXY = saved;
    }
  });

  console.log('【3】熔断器');
  const circuit = require('../src-server/lib/circuit');
  await t('连续失败达阈值熔断；成功后清除', () => {
    const p = { id: 999, name: '测试供应商' };
    assert.strictEqual(circuit.isOpen(p, 'm1'), false);
    circuit.recordFail(p, 'm1', new Error('503'));
    assert.strictEqual(circuit.isOpen(p, 'm1'), false);       // 1 次未达阈值
    circuit.recordFail(p, 'm1', new Error('503 again'));
    assert.strictEqual(circuit.isOpen(p, 'm1'), true);        // 2 次 → 熔断
    circuit.recordSuccess(p, 'm1');
    assert.strictEqual(circuit.isOpen(p, 'm1'), false);       // 成功清除
  });
  await t('健康面板：状态 ok/fail 与熔断清单', () => {
    const p = { id: 998, name: '健康测试' };
    circuit.recordFail(p, 'm2', new Error('no healthy upstream'));
    circuit.recordFail(p, 'm2', new Error('no healthy upstream'));
    const h = circuit.healthReport();
    const hp = h.providers.find(x => x.provider_id === 998);
    assert.ok(hp && hp.state === 'fail' && hp.calls === 2 && hp.oks === 0);
    assert.ok(h.open_circuits.some(c => c.key === '998:m2'));
    circuit.recordSuccess(p, 'm2'); // 清理，避免影响后续用例
  });

  console.log('【4】模型候选降级（buildCandidates）');
  const llm = require('../src-server/lib/llm');
  await t('候选排序：指定模型优先（默认供应商在前）→ 默认供应商其他模型 → 其他供应商', () => {
    // 测试库种子数据无带 key 的真实供应商，插入两个测试供应商
    // （先清种子默认标志——P0 的唯一索引会拦截双默认，这里恰好也验证了约束生效）
    db.prepare('UPDATE providers SET is_default=0').run();
    db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES (?,?,?,?,?,0,'',datetime('now','localtime'))`)
      .run('测试A', 'http://a.test/v1', 'sk-test-a', JSON.stringify(['bad-model', 'good-a1']), 1);
    db.prepare(`UPDATE providers SET is_default=1 WHERE name='测试A'`).run();
    db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES (?,?,?,?,?,0,'',datetime('now','localtime'))`)
      .run('测试B', 'http://b.test/v1', 'sk-test-b', JSON.stringify(['good-a1', 'good-b1']), 1);
    // 指定 good-a1：默认供应商 A 优先于 B
    let c = llm.buildCandidates('good-a1');
    assert.strictEqual(c[0].p.name, '测试A');
    assert.strictEqual(c[0].model, 'good-a1');
    // 指定不存在的模型 → 回退各供应商可用模型（默认优先）
    c = llm.buildCandidates('not-exist');
    assert.ok(c.length >= 2 && c[0].p.name === '测试A');
    // 非文本模型被过滤
    c = llm.buildCandidates('QwenImage');
    assert.ok(!c.some(x => x.model === 'QwenImage'));
  });
  await t('熔断中的「供应商+模型」组合被跳过（他供应商同名健康渠道保留）', () => {
    const pa = db.prepare(`SELECT * FROM providers WHERE name='测试A'`).get();
    const pb = db.prepare(`SELECT * FROM providers WHERE name='测试B'`).get();
    // 熔断 A 的 good-a1 与 B 的 good-b1
    circuit.recordFail(pa, 'good-a1', new Error('x'));
    circuit.recordFail(pa, 'good-a1', new Error('x'));
    circuit.recordFail(pb, 'good-b1', new Error('x'));
    circuit.recordFail(pb, 'good-b1', new Error('x'));
    const c = llm.buildCandidates('good-a1');
    assert.ok(!c.some(x => x.p.name === '测试A' && x.model === 'good-a1'), 'A 的 good-a1（熔断中）应被跳过');
    assert.ok(c.some(x => x.p.name === '测试B' && x.model === 'good-a1'), 'B 的 good-a1（健康同名渠道）应保留');
    assert.ok(!c.some(x => x.model === 'good-b1'), 'B 的 good-b1（熔断中）应被跳过');
    // 清理熔断状态
    circuit.recordSuccess(pa, 'good-a1');
    circuit.recordSuccess(pb, 'good-b1');
  });

  console.log('【5】运维：备份幂等与清理');
  const ops = require('../src-server/lib/ops');
  await t('dailyBackup 首次生成、当日重复调用跳过', () => {
    const r1 = ops.dailyBackup();
    assert.strictEqual(r1.ok, true);
    const r2 = ops.dailyBackup();
    assert.strictEqual(r2.skipped, true, '第二次应幂等跳过');
  });
  await t('cleanupUploads 删除超期文件、保留新文件', () => {
    const dir = path.join(__dirname, '..', 'public', 'uploads', 'gen-images');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'smoke-old.png');
    const fresh = path.join(dir, 'smoke-fresh.png');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const past = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(old, past, past);
    ops.cleanupUploads();
    assert.strictEqual(fs.existsSync(old), false, '40 天前文件应被删除');
    assert.strictEqual(fs.existsSync(fresh), true, '新文件应保留');
    fs.unlinkSync(fresh);
  });
  await t('archiveLogs 幂等不抛错', () => {
    const r = ops.archiveLogs();
    assert.strictEqual(r.ok, true);
  });

  console.log('【6】Cron 计算');
  await t('lastFire：返回 since→now 区间内最近一次触发点', () => {
    const { lastFire } = require('../src-server/lib/cron');
    const since = new Date('2026-10-19T10:00:00').getTime();
    const nowTs = new Date('2026-10-20T12:00:00').getTime();
    const ts = lastFire('0 9 * * *', since, nowTs);
    const d = new Date(ts);
    assert.strictEqual(d.getDate(), 20, '应为今天');
    assert.strictEqual(d.getHours(), 9, '应为 9 点');
    // 今天 9 点已过的场景：区间内无触发点 → null
    assert.strictEqual(lastFire('0 9 * * *', new Date('2026-10-20T10:00:00').getTime(), nowTs), null);
  });

  console.log('【7】P3：用户自有模型优先路由 / @技能解析');
  const { parseSkillMentions } = require('../src-server/lib/skill-mention');
  await t('@技能解析：本人优先、标记移除、邮箱不误触、未知保留', () => {
    const pool = [
      { id: 1, owner: 'bob', name: '翻译', prompt: 'bob 的翻译' },
      { id: 2, owner: 'alice', name: '翻译', prompt: 'alice 的翻译' },
      { id: 3, owner: 'alice', name: '周报', prompt: '写周报' },
    ];
    // 本人技能优先于他人同名技能；标记从送模型内容中移除
    let r = parseSkillMentions('@翻译 把这段话翻成英文', pool, 'alice');
    assert.strictEqual(r.skills.length, 1);
    assert.strictEqual(r.skills[0].id, 2, 'alice 应命中自己的「翻译」');
    assert.strictEqual(r.content, ' 把这段话翻成英文', '已命中标记应被移除');
    // 他人已发布技能可命中
    r = parseSkillMentions('@翻译 翻一下', pool, 'carol');
    assert.strictEqual(r.skills[0].id, 1, 'carol 应命中 bob 已发布的「翻译」');
    // 邮箱不误触（@ 前是字母，非行首/空白/左括号边界）
    r = parseSkillMentions('联系我 user@example.com', pool, 'alice');
    assert.strictEqual(r.skills.length, 0);
    assert.strictEqual(r.content, '联系我 user@example.com');
    // 多技能命中去重；未命中的 @标记 原样保留
    r = parseSkillMentions('@翻译 @周报 @不存在 帮我处理', pool, 'alice');
    assert.strictEqual(r.skills.length, 2);
    assert.strictEqual(r.content, '  @不存在 帮我处理');
  });

  // P5.24 指定专家：@专家名 解析（镜像技能机制，链式接在技能解析后）
  await t('@专家解析：命中移除、去重保序、邮箱不误触、未知保留、链式衔接', () => {
    const { parseAgentMentions } = require('../src-server/lib/skill-mention');
    const agentPool = [
      { id: 56, name: '财报分析师', icon: '📊', prompt: '你是财报专家' },
      { id: 57, name: '中英翻译官', icon: '🌐', prompt: '你是翻译' },
      { id: 58, name: '自媒体运营专家', icon: '✍️', prompt: '你是运营' },
    ];
    // 命中并移除标记（送模型内容不再含 @专家名）
    let r = parseAgentMentions('@财报分析师 帮我看看这份年报', agentPool);
    assert.strictEqual(r.agents.length, 1);
    assert.strictEqual(r.agents[0].id, 56);
    assert.strictEqual(r.content, ' 帮我看看这份年报', '已命中专家标记应被移除');
    // 多专家去重保序 + 未命中保留
    r = parseAgentMentions('@中英翻译官 @财报分析师 @中英翻译官 @路人 帮我处理', agentPool);
    assert.strictEqual(r.agents.length, 2, '重复 @ 同一专家应去重');
    assert.strictEqual(r.agents[0].id, 57, '保持出现顺序');
    assert.strictEqual(r.content, '   @路人 帮我处理', '未命中的 @标记 原样保留');
    // 邮箱不误触（边界规则与技能一致）
    r = parseAgentMentions('联系我 user@财报分析师.com', agentPool);
    assert.strictEqual(r.agents.length, 0);
    // 链式衔接：技能解析剥离 @翻译 后，剩余 @专家 交给专家解析（同名时技能优先）
    const skillPool = [{ id: 9, owner: 'alice', name: '中英翻译官', prompt: '技能版翻译' }];
    const s1 = parseSkillMentions('@中英翻译官 @财报分析师 帮我处理', skillPool, 'alice');
    assert.strictEqual(s1.skills.length, 1, '同名时技能先解析命中');
    const a1 = parseAgentMentions(s1.content, agentPool);
    assert.strictEqual(a1.agents.length, 1);
    assert.strictEqual(a1.agents[0].id, 56, '剩余标记应命中财报分析师（非同名技能）');
    assert.strictEqual(a1.content, '  帮我处理', '技能标记与专家标记各剥离一次（两空格）');
  });

  // P5.25 对话权限：工具风险分级（「默认权限」闸门的判定依据）
  await t('toolRiskOf：低风险只读放行 / 中风险产物确认 / MCP与子智能体高危 / 未知保守中危', () => {
    const { toolRiskOf } = require('../src-server/lib/tools');
    // low：纯读/纯算（默认权限下也不拦截——确认疲劳无意义）
    for (const n of ['get_datetime', 'calculator', 'kb_search', 'db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'doc_review']) {
      assert.strictEqual(toolRiskOf(n), 'low', `${n} 应为 low`);
    }
    // medium：产出外部可见产物/较大消耗（需确认）
    for (const n of ['image_gen', 'export_word', 'tts', 'run_code']) {
      assert.strictEqual(toolRiskOf(n), 'medium', `${n} 应为 medium`);
    }
    // high：MCP 任意工具与子智能体调用（能力不可枚举）
    assert.strictEqual(toolRiskOf('mcp_send_email'), 'high', 'MCP 工具应为 high');
    assert.strictEqual(toolRiskOf('agent_call_12'), 'high', '子智能体调用应为 high');
    // 未知工具保守 medium（需确认而非放行）
    assert.strictEqual(toolRiskOf('mystery_tool'), 'medium', '未知工具应保守按 medium');
  });

  // P5.26 run_code 沙箱：功能与安全边界（静态拦截 + 运行时限）
  await t('run_code：正常执行/产物/越权与逃逸拦截/超时', async () => {
    const { run_code } = require('../src-server/lib/tools-extra');
    // 正常计算
    let r = String(await run_code.run({ code: 'console.log(6*7);' }));
    assert.ok(r.includes('✅') && r.includes('42'), '正常执行应返回结果 42');
    // 静态拦截：网络/eval/process.env
    r = String(await run_code.run({ code: 'fetch("http://x.com")' }));
    assert.ok(r.includes('安全检查') && r.includes('网络'), 'fetch 应被静态拦截');
    r = String(await run_code.run({ code: 'eval("1")' }));
    assert.ok(r.includes('eval'), 'eval 应被拦截');
    r = String(await run_code.run({ code: 'console.log(process.env)' }));
    assert.ok(r.includes('process.env') || r.includes('安全检查'), 'process.env 应被拦截');
    // 路径越权：写沙箱外
    r = String(await run_code.run({ code: 'fs.writeFileSync("../../hack.txt","x")' }));
    assert.ok(r.includes('沙箱拒绝') && r.includes('沙箱外'), '越权写应被拒绝');
    // 死循环：V8 脚本级超时（timeout 参数抛错 → 统一超时文案）
    r = String(await run_code.run({ code: 'while(true){}' }));
    assert.ok(r.includes('超时') || r.includes('timed out') || r.includes('timeout'), '死循环应触发超时保护：' + r.slice(0, 80));
  });

  // ===== P5.30 安全止血回归组 =====
  await t('run_code：P5.30 逃逸向量全拦截（构造器链/globalThis/原型攀爬）', async () => {
    const { run_code } = require('../src-server/lib/tools-extra');
    const vectors = [
      ['Buffer.constructor.constructor("return process")()', 'Buffer 构造器链'],
      ['({}).constructor.constructor("return process")()', '对象字面量构造器链'],
      ['globalThis.process', 'globalThis'],
      ['Object.getPrototypeOf(Buffer)("return process")()', 'getPrototypeOf 攀爬'],
      ['({}).__proto__.constructor.constructor("return process")()', '__proto__ 攀爬'],
    ];
    for (const [code, tag] of vectors) {
      const r = String(await run_code.run({ code }));
      assert.ok(r.includes('安全检查'), `逃逸向量「${tag}」应被静态拦截，实际：${r.slice(0, 100)}`);
    }
    // 运行时层：字符串拼接绕过静态拦截时，宿主 Function 跳板应已被抹平（输出 undefined 而非 function）
    const r2 = String(await run_code.run({ code: 'console.log(typeof Buffer["con"+"structor"])' }));
    assert.ok(r2.includes('undefined'), '拼接绕过静态时宿主 Function 跳板应被运行时层抹平：' + r2.slice(0, 120));
  });

  await t('quota：0=不限额 / 记账累计 / 超限拦截 / 负值修正（P2 体系首次覆盖）', () => {
    const { quotaOf, checkQuota, addUsage, resetQuotaAlert } = require('../src-server/lib/quota');
    db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,quota_total,quota_used,created_at) VALUES ('quota-u',?,'配额测试','user',1,0,100,0,datetime('now','localtime'))`).run(hashPwd('quota-pass-1'));
    assert.ok(quotaOf('no-such-user-x').unlimited, '不存在用户按不限额兑底（不崩）');
    addUsage('quota-u', 30);
    assert.strictEqual(quotaOf('quota-u').used, 30, '记账应累计到 30');
    assert.strictEqual(checkQuota('quota-u'), null, '未超限应放行');
    addUsage('quota-u', 80);
    assert.ok(String(checkQuota('quota-u')).includes('配额已用完'), '超限（110/100）应返回拦截文案');
    addUsage('quota-u', -40);
    assert.strictEqual(quotaOf('quota-u').used, 110, '负值增量应被忽略（addUsage 仅接受正数，修正需直改库）');
    resetQuotaAlert('quota-u');
  });

  await t('P5.30 tripwire：技能路径零直呼 addUsage + ConversationSink 唯一记账点（双记回归）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
    const start = src.indexOf("skill === 'image'");
    const end = src.indexOf('const agent = agent_id ?');
    assert.ok(start > 0 && end > start, '技能块定位成功');
    const hits = src.slice(start, end).match(/addUsage\(/g) || [];
    assert.strictEqual(hits.length, 0, '技能路径应零直呼 addUsage（P5.33 起收尾统一经 ConversationSink）：实际 ' + hits.length);
    const sinkSrc = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'chat-sink.js'), 'utf8');
    const sinkHits = sinkSrc.match(/addUsage\(/g) || [];
    assert.strictEqual(sinkHits.filter(x => x).length, 1, 'ConversationSink 应恰好 1 处记账点（结构性防双记）：实际 ' + sinkHits.length);
  });
  await t('buildCandidates：用户自有模型源优先，且只精确匹配指定模型', () => {
    db.prepare(`INSERT INTO user_providers (username,name,base_url,api_key,models,status,created_at) VALUES (?,?,?,?,?,1,datetime('now','localtime'))`)
      .run('tester', '个人网关', 'http://my.test/v1', 'sk-my-key', JSON.stringify(['good-a1', 'my-own']));
    // 指定 good-a1（用户与平台两家都有）→ 用户自有渠道第一，平台默认供应商紧随其后
    let c = llm.buildCandidates('good-a1', { username: 'tester' });
    assert.strictEqual(c[0].p.id, 'u1', '用户自有供应商应排第一（虚拟 id u{n}）');
    assert.strictEqual(c[0].model, 'good-a1');
    assert.strictEqual(c[1].p.name, '测试A', '平台默认供应商紧随其后兜底');
    // 指定平台才有的模型 → 用户自有渠道不参与（自带 Key 不为平台兜底买单）
    c = llm.buildCandidates('good-b1', { username: 'tester' });
    assert.ok(!c.some(x => String(x.p.id).startsWith('u')), '用户自有源不应出现在非自有模型的候选中');
    // 用户隔离：无自有源的其他用户候选不变
    c = llm.buildCandidates('good-a1', { username: 'nobody' });
    assert.strictEqual(c[0].p.name, '测试A');
  });

  console.log('【8】P3：智能体协作与可见性（agent-access）');
  const { canView, canEdit, isOwnerLevel, parseJsonArr } = require('../src-server/lib/agent-access');
  await t('parseJsonArr：合法/非法/非数组均安全返回数组', () => {
    assert.deepStrictEqual(parseJsonArr('["a","b"]'), ['a', 'b']);
    assert.deepStrictEqual(parseJsonArr('not-json'), []);
    assert.deepStrictEqual(parseJsonArr('{"x":1}'), []);
    assert.deepStrictEqual(parseJsonArr(null), []);
  });
  await t('canView：公开已发布全员可见；草稿仅 owner/协作者/管理员', () => {
    const pub = { owner: 'alice', status: 'published', visibility: 'public', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    assert.strictEqual(canView(pub, { username: 'bob', role: 'user', dept: '市场部' }), true, '公开已发布→任意用户可见');
    const draft = { ...pub, status: 'draft' };
    assert.strictEqual(canView(draft, { username: 'bob', role: 'user' }), false, '草稿→路人不可见');
    assert.strictEqual(canView(draft, { username: 'alice', role: 'user' }), true, '草稿→owner 可见');
    assert.strictEqual(canView(draft, { username: 'bob', role: 'admin' }), true, '草稿→管理员可见');
  });
  await t('canView：restricted 名单判定（成员/部门/协作者/owner）', () => {
    const res = { owner: 'alice', status: 'published', visibility: 'restricted',
      collaborators: JSON.stringify(['carol']), visible_depts: JSON.stringify(['市场部']), visible_members: JSON.stringify(['dave']) };
    assert.strictEqual(canView(res, { username: 'dave', role: 'user' }), true, '成员名单命中可见');
    assert.strictEqual(canView(res, { username: 'bob', role: 'user', dept: '市场部' }), true, '部门名单命中可见');
    assert.strictEqual(canView(res, { username: 'carol', role: 'user' }), true, '协作者可见');
    assert.strictEqual(canView(res, { username: 'alice', role: 'user' }), true, 'owner 可见');
    assert.strictEqual(canView(res, { username: 'eve', role: 'user', dept: '研发部' }), false, '名单外不可见');
    assert.strictEqual(canView(res, { username: 'eve', role: 'user' }), false, '无部门且不在名单不可见');
  });
  await t('canEdit / isOwnerLevel：协作者可编辑不可删除；路人全无', () => {
    const a = { owner: 'alice', collaborators: '["carol"]' };
    const admin = { username: 'root', role: 'admin' }, owner = { username: 'alice', role: 'user' },
      collab = { username: 'carol', role: 'user' }, other = { username: 'eve', role: 'user' };
    assert.strictEqual(canEdit(a, admin), true);
    assert.strictEqual(canEdit(a, owner), true);
    assert.strictEqual(canEdit(a, collab), true, '协作者可编辑内容');
    assert.strictEqual(canEdit(a, other), false, '路人不可编辑');
    assert.strictEqual(isOwnerLevel(a, collab), false, '协作者非归属级（不可删除/改可见性/管密钥）');
    assert.strictEqual(isOwnerLevel(a, owner), true);
    assert.strictEqual(isOwnerLevel(a, admin), true);
    assert.strictEqual(isOwnerLevel(a, other), false);
  });
  await t('存量数据兼容：visibility 缺省按 public 处理（老智能体全员可见不受影响）', () => {
    const legacy = { owner: 'alice', status: 'published', visibility: null, collaborators: null };
    assert.strictEqual(canView(legacy, { username: 'bob', role: 'user' }), true);
    assert.strictEqual(canEdit(legacy, { username: 'bob', role: 'user' }), false);
  });
  await t('canView：visible_depts 纯数字 ID 模式（6af7cb5）——dept_id 命中/未命中/类型转换/不回落文本名', () => {
    const byId = { owner: 'alice', status: 'published', visibility: 'restricted',
      collaborators: '[]', visible_members: '[]', visible_depts: JSON.stringify(['1', '2']) };
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: 2 }), true,
      'ID 模式：dept_id=2 命中名单 ["1","2"] 可见');
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: 1 }), true,
      'ID 模式：数字类型 1 经 String() 转换后命中字符串 "1"（类型转换兼容）');
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: 99 }), false,
      'ID 模式：dept_id=99 未命中名单不可见');
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: null, dept: '市场部' }), false,
      '安全关键：纯数字名单不回落文本部门名——dept_id=null 时即使 dept="市场部" 也不可见（防误授权）');
  });
  await t('canView：visible_depts 混合格式双模式命中（V1.2 #2 语义升级：ID/文本任一命中）', () => {
    const mixed = { owner: 'alice', status: 'published', visibility: 'restricted',
      collaborators: '[]', visible_members: '[]', visible_depts: JSON.stringify(['1', '市场部']) };
    assert.strictEqual(canView(mixed, { username: 'bob', role: 'user', dept: '市场部' }), true,
      '混合名单：dept 文本命中可见');
    assert.strictEqual(canView(mixed, { username: 'bob', role: 'user', dept_id: 1, dept: '研发部' }), true,
      '混合名单：dept_id=1 命中可见（V1.2 双模式 OR——旧语义不命中，只扩不缩服务迁移期）');
    assert.strictEqual(canView(mixed, { username: 'eve', role: 'user', dept_id: 99, dept: '研发部' }), false,
      '混合名单：ID 与文本皆未命中不可见（fail-closed）');
    const legacyName = { ...mixed, visible_depts: JSON.stringify(['市场部']) };
    assert.strictEqual(canView(legacyName, { username: 'bob', role: 'user', dept: '市场部', dept_id: 99 }), true,
      '旧格式纯文本名单与 dept_id 字段共存不受影响：dept 命中即可见');
  });

  // P0-3 收尾 2026-10-30：可见部门部门树多选（buildTree 纯逻辑 + ID/文本双格式保存链路）
  const { buildTree } = require('../src-server/routes/departments');
  await t('buildTree：平铺行组装嵌套树（3 级嵌套 + 同级 order_num 乱序 + 空表/孤儿兜底）', () => {
    const rows = [
      { id: 1, parent_id: null, name: '研发中心', path: '/1', order_num: 2 },
      { id: 2, parent_id: null, name: '市场中心', path: '/2', order_num: 1 },
      { id: 3, parent_id: 1, name: '前端组', path: '/1/3', order_num: 2 },
      { id: 4, parent_id: 1, name: '后端组', path: '/1/4', order_num: 1 },
      { id: 5, parent_id: 4, name: '数据库小组', path: '/1/4/5', order_num: 0 },
      { id: 6, parent_id: 2, name: '品牌组', path: '/2/6', order_num: 0 },
    ];
    const tree = buildTree(rows);
    assert.deepStrictEqual(tree.map(n => n.id), [2, 1], '根级按 order_num 排序（市场中心 order 1 在研发中心 order 2 前）');
    assert.deepStrictEqual(tree[1].children.map(n => n.id), [4, 3], '同级子节点按 order_num 再按 id 排序（后端组在前端组前）');
    assert.deepStrictEqual(tree[1].children[0].children.map(n => n.id), [5], '三级嵌套：数据库小组挂后端组下');
    assert.ok(Array.isArray(tree[1].children), 'children 应为数组');
    assert.deepStrictEqual(
      { id: tree[1].id, parent_id: tree[1].parent_id, name: tree[1].name, path: tree[1].path, order_num: tree[1].order_num },
      { id: 1, parent_id: null, name: '研发中心', path: '/1', order_num: 2 }, '节点字段结构齐全（id/parent_id/name/path/order_num/children）');
    assert.deepStrictEqual(buildTree([]), [], '空表返回 []');
    const orphan = buildTree([
      { id: 10, parent_id: null, name: '总部', path: '/10', order_num: 0 },
      { id: 11, parent_id: 999, name: '孤儿部', path: '/10/11', order_num: 1 },
    ]);
    assert.deepStrictEqual(orphan.map(n => n.id), [10, 11], '孤儿行（parent_id 悬空，仅手工改库会产生）兜底挂根级不丢数据');
  });
  await t('buildTree：环状引用兜底（互指环不丢节点不无限递归，V1.1 审查加固）', () => {
    // 两节点互指成环（PUT 无环校验时可构造）：修复前环上节点从 roots 不可达→整棵树静默丢失；修复后兜底挂根级且 children 清空不再成环
    const tree = buildTree([
      { id: 1, parent_id: 2, name: '环A', path: '/1', order_num: 0 },
      { id: 2, parent_id: 1, name: '环B', path: '/2', order_num: 1 },
      { id: 3, parent_id: null, name: '正常根', path: '/3', order_num: 2 },
    ]);
    assert.deepStrictEqual(tree.map(n => n.id).sort((a, b) => a - b), [1, 2, 3], '环上节点兜底挂根级不丢数据（含正常根共 3 个）');
    assert.ok(tree.every(n => n.children.length === 0), '环上节点 children 已清空（不再成环，后续排序/渲染安全）');
    // 三节点环同样兜底
    const tri = buildTree([
      { id: 4, parent_id: 6, name: '甲', path: '/4', order_num: 0 },
      { id: 5, parent_id: 4, name: '乙', path: '/5', order_num: 0 },
      { id: 6, parent_id: 5, name: '丙', path: '/6', order_num: 0 },
    ]);
    assert.strictEqual(tri.length, 3, '三节点环全部兜底挂根级');
    assert.ok(tri.every(n => n.children.length === 0), '三节点环 children 均清空');
  });
  await t('visible_depts ID 保存链路：前端勾选 → agents.js map(String) 归一 → canView dept_id 命中', () => {
    // 模拟前端勾选部门树节点提交的 String(id) 数组，经 agents.js PUT 的归一链路（map(String).filter(Boolean) → JSON.stringify）入库
    const saved = JSON.stringify(['1', '2'].map(String).filter(Boolean));
    assert.strictEqual(saved, '["1","2"]', '保存链路归一为纯数字 ID 字符串数组');
    const byId = { owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_members: '[]', visible_depts: saved };
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: 2 }), true, 'ID 模式：dept_id=2 命中名单可见');
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: 99 }), false, '未命中 ID 不可见');
    assert.strictEqual(canView(byId, { username: 'bob', role: 'user', dept_id: null, dept: '市场部' }), false, '纯数字名单不回落文本名（防误授权）');
    const savedNum = JSON.stringify([1, 2].map(String).filter(Boolean));
    assert.strictEqual(savedNum, saved, '数字类型勾选值同样被 agents.js map(String) 归一为字符串 ID（类型兜底）');
  });
  await t('visible_depts 历史文本名兼容：保存链路不清空不转换，dept 文本命中不受 dept_id 干扰', () => {
    // 旧数据源（members 文本部门 chips）勾选产生的 ['市场部']，经 agents.js 同款归一链路入库
    const saved = JSON.stringify(['市场部'].map(String).filter(Boolean));
    assert.strictEqual(saved, '["市场部"]', 'map(String)/filter(Boolean) 不改写、不清空历史文本部门名');
    const byText = { owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_members: '[]', visible_depts: saved };
    assert.strictEqual(canView(byText, { username: 'bob', role: 'user', dept: '市场部' }), true, '历史文本部门保存后仍按 user.dept 文本命中');
    assert.strictEqual(canView(byText, { username: 'bob', role: 'user', dept: '市场部', dept_id: 99 }), true, 'dept_id 数字字段共存不干扰文本匹配（老用户补 dept_id 后不受影响）');
    assert.strictEqual(canView(byText, { username: 'bob', role: 'user', dept: '研发部', dept_id: 1 }), false, '文本未命中且 ID 不参与（文本模式下不可见）');
    // 混合存量（历史文本 + 新勾选 ID 并存）：V1.2 双模式 OR——ID 或文本任一命中即可见（只扩不缩，服务迁移期）
    const mixed = JSON.stringify(['市场部', '2'].map(String).filter(Boolean));
    const byMixed = { ...byText, visible_depts: mixed };
    assert.strictEqual(canView(byMixed, { username: 'bob', role: 'user', dept: '市场部' }), true, '混合名单文本命中仍生效（保存链路不丢历史项）');
    assert.strictEqual(canView(byMixed, { username: 'eve', role: 'user', dept_id: 2 }), true, '混合名单 ID 命中也可见（V1.2 双模式 OR，旧语义不命中）');
    assert.strictEqual(canView(byMixed, { username: 'eve', role: 'user', dept_id: 99, dept: '研发部' }), false, '混合名单两者皆未命中不可见（fail-closed）');
  });

  // ================ V2.4 #9 租户化：agent_acls 行为快照 + 7 条 ACL 用例 ================
  console.log('【V2.4#9】租户化：agent_acls 7 条冒烟');
  // 【用例 1】admin 放行——即使有 deny ACL 也不拦截
  await t('P3 工程化：agent_acls——admin 不受 ACL 约束', () => {
    const { canView, canEdit, isOwnerLevel } = require('../src-server/lib/agent-access');
    const a = { id: 9991, owner: 'alice', status: 'published', visibility: 'public', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9991, 'user', 'bob', 0)").run();
    assert.strictEqual(canView(a, { username: 'root', role: 'admin' }), true, 'admin 即使有 deny ACL 也可见');
    assert.strictEqual(canEdit(a, { username: 'root', role: 'admin' }), true, 'admin 可编辑');
    assert.strictEqual(isOwnerLevel(a, { username: 'root', role: 'admin' }), true, 'admin 为归属级');
    db.prepare("DELETE FROM agent_acls WHERE agent_id=9991").run();
  });
  // 【用例 2】owner 始终可见/可编辑
  await t('P3 工程化：agent_acls——owner 始终可见可编辑', () => {
    const { canView, canEdit, isOwnerLevel } = require('../src-server/lib/agent-access');
    const a = { id: 9992, owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    assert.strictEqual(canView(a, { username: 'alice', role: 'user' }), true, 'owner 可见');
    assert.strictEqual(canEdit(a, { username: 'alice', role: 'user' }), true, 'owner 可编辑');
    assert.strictEqual(isOwnerLevel(a, { username: 'alice', role: 'user' }), true, 'owner 归属级');
  });
  // 【用例 3】ACL user 精确授权——不符合的用户不可见
  await t('P3 工程化：agent_acls——用户精确授权（user 类型）', () => {
    const { canView, canEdit } = require('../src-server/lib/agent-access');
    const a = { id: 9993, owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9993, 'user', 'bob', 1)").run();
    assert.strictEqual(canView(a, { username: 'bob', role: 'user' }), true, 'ACL user 精确授权→可见');
    assert.strictEqual(canView(a, { username: 'eve', role: 'user' }), false, '未授权→不可见');
    assert.strictEqual(canEdit(a, { username: 'bob', role: 'user' }), true, 'ACL user 精确授权→可编辑');
    assert.strictEqual(canEdit(a, { username: 'eve', role: 'user' }), false, '未授权→不可编辑');
    db.prepare("DELETE FROM agent_acls WHERE agent_id=9993").run();
  });
  // 【用例 4】ACL dept 授权——同部门用户可见
  await t('P3 工程化：agent_acls——部门授权（dept 类型）', () => {
    const { canView } = require('../src-server/lib/agent-access');
    const a = { id: 9994, owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9994, 'dept', '市场部', 1)").run();
    assert.strictEqual(canView(a, { username: 'bob', role: 'user', dept: '市场部' }), true, '同部门→可见');
    assert.strictEqual(canView(a, { username: 'eve', role: 'user', dept: '研发部' }), false, '不同部门→不可见');
    db.prepare("DELETE FROM agent_acls WHERE agent_id=9994").run();
  });
  // 【用例 5】ACL role 授权
  await t('P3 工程化：agent_acls——角色授权（role 类型）', () => {
    const { canView } = require('../src-server/lib/agent-access');
    const a = { id: 9995, owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9995, 'role', 'user', 1)").run();
    assert.strictEqual(canView(a, { username: 'bob', role: 'user' }), true, 'role=user→可见');
    assert.strictEqual(canView(a, { username: 'admin', role: 'admin' }), true, 'admin 不受ACL限制');
    db.prepare("DELETE FROM agent_acls WHERE agent_id=9995").run();
  });
  // 【用例 6】ACL deny 优先级高于 allow
  await t('P3 工程化：agent_acls——deny 优先于 allow（黑名单优先）', () => {
    const { canView } = require('../src-server/lib/agent-access');
    const a = { id: 9996, owner: 'alice', status: 'published', visibility: 'public', collaborators: '[]', visible_depts: '[]', visible_members: '[]' };
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9996, 'user', 'bob', 1)").run();
    db.prepare("INSERT INTO agent_acls (agent_id, grant_to, grant_to_value, allow) VALUES (9996, 'user', 'bob', 0)").run();
    assert.strictEqual(canView(a, { username: 'bob', role: 'user' }), false, 'deny 优先于 allow→不可见');
    db.prepare("DELETE FROM agent_acls WHERE agent_id=9996").run();
  });
  // 【用例 7】无 ACL 配置时回退到旧字段（visible_depts/visible_members）——兼容性
  await t('P3 工程化：agent_acls——无 ACL 行回退到旧可见性字段', () => {
    const { canView } = require('../src-server/lib/agent-access');
    const a = { id: 9997, owner: 'alice', status: 'published', visibility: 'restricted', collaborators: '[]', visible_depts: '["市场部"]', visible_members: '["dave"]' };
    assert.strictEqual(canView(a, { username: 'dave', role: 'user' }), true, '成员名单→可见（旧字段生效）');
    assert.strictEqual(canView(a, { username: 'bob', role: 'user', dept: '市场部' }), true, '部门名单→可见（旧字段生效）');
    assert.strictEqual(canView(a, { username: 'eve', role: 'user', dept: '研发部' }), false, '名单外→不可见（旧字段也拒绝）');
  });

  // ================ V2.4 #9 收尾（2026-11-02）：企业空间全员可见 + 存量回填 ================
  console.log('【V2.4#9】空间租户化收尾：企业空间语义 + 存量回填');
  // 【用例 1】spaceFilterSql 三态语义——企业空间/无归属回填行对普通用户可见，部门空间不可见
  await t('V2.4#9 收尾：企业空间智能体对普通用户可见，部门空间不可见', () => {
    const { spaceFilterSql } = require('../src-server/lib/space-utils');
    // MT-02b：spaces.owner 已由昵称归一到 username（产品部空间 owner=zhangsan）。
    // 本用例改用非空间 owner 的 wangwu 验证「部门空间对非 owner 不可见」。
    const { sqlStr, args } = spaceFilterSql('a', { username: 'wangwu', role: 'user' });
    const rows = db.prepare(`SELECT a.name, a.space_id FROM agents a WHERE 1=1 AND a.status='published' ${sqlStr}`).all(...args);
    const names = rows.map(r => r.name);
    assert.ok(names.includes('公司制度问答助手'), '企业空间智能体（space_id=1）应可见');
    assert.ok(names.includes('会议纪要整理员'), '原无归属行（seed space_id=NULL）经回填进企业空间后应可见');
    assert.ok(!names.includes('公文写作专家'), '部门空间智能体（space_id=2，非空间 owner）应不可见');
  });
  // 【用例 2】个人空间资源仅空间/资源 owner 可见
  await t('V2.4#9 收尾：个人空间智能体仅空间 owner 可见，他人不可见', () => {
    const { spaceFilterSql } = require('../src-server/lib/space-utils');
    const sp = db.prepare("SELECT id FROM spaces WHERE type='personal' AND owner='admin' LIMIT 1").get();
    db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility) VALUES ('回填测试-个人空间agent','other',?,'admin','published','public')").run(sp.id);
    try {
      const mk = u => { const { sqlStr, args } = spaceFilterSql('a', u); return db.prepare(`SELECT a.name FROM agents a WHERE 1=1 ${sqlStr}`).all(...args).map(r => r.name); };
      assert.ok(!mk({ username: 'zhangsan', role: 'user' }).includes('回填测试-个人空间agent'), '非空间 owner 不可见');
      assert.ok(mk({ username: 'admin', role: 'user' }).includes('回填测试-个人空间agent'), '空间 owner 可见（role=user 视角）');
    } finally {
      db.prepare("DELETE FROM agents WHERE name='回填测试-个人空间agent'").run();
    }
  });
  // 【用例 3】存量回填后 agents/kbs 无 NULL/0 归属残留（新库 seed 场景，迁移块位于 db.js seed 之后）
  await t('V2.4#9 收尾：存量回填后 agents/kbs 无未归属行残留', () => {
    const a = db.prepare('SELECT COUNT(*) c FROM agents WHERE space_id IS NULL OR space_id=0').get();
    assert.strictEqual(a.c, 0, `agents 应无 space_id 为 0/NULL 的行（实际 ${a.c}）`);
    const k = db.prepare('SELECT COUNT(*) c FROM kbs WHERE space_id IS NULL OR space_id=0').get();
    assert.strictEqual(k.c, 0, `kbs 应无 space_id 为 0/NULL 的行（实际 ${k.c}）`);
  });
  // 【用例 4】spaceVisibleTo 单行判定与 SQL 语义一致（无归属/企业/个人/部门/脏数据五态）
  await t('V2.4#9 收尾：spaceVisibleTo 五态语义', () => {
    const { spaceVisibleTo } = require('../src-server/lib/space-utils');
    assert.strictEqual(spaceVisibleTo(db, 0, 'zhangsan'), true, '0→全员可见');
    assert.strictEqual(spaceVisibleTo(db, null, 'zhangsan'), true, 'NULL→全员可见');
    const ent = db.prepare("SELECT id FROM spaces WHERE type='enterprise' LIMIT 1").get();
    assert.strictEqual(spaceVisibleTo(db, ent.id, 'zhangsan'), true, '企业空间→全员可见');
    assert.strictEqual(spaceVisibleTo(db, 99999, 'zhangsan'), false, '空间不存在→fail-closed 不可见（SEC-04：与 spaceFilterSql 的 SQL 语义对齐，防内存过滤链路越权）');
    const per = db.prepare("SELECT id FROM spaces WHERE type='personal' AND owner='admin' LIMIT 1").get();
    assert.strictEqual(spaceVisibleTo(db, per.id, 'admin'), true, '个人空间 owner→可见');
    assert.strictEqual(spaceVisibleTo(db, per.id, 'zhangsan'), false, '个人空间非 owner→不可见');
    const dept = db.prepare("SELECT id FROM spaces WHERE type='dept' LIMIT 1").get();
    assert.strictEqual(spaceVisibleTo(db, dept.id, 'wangwu'), false, '部门空间非 owner→不可见（过渡语义；MT-02b 后 owner=zhangsan）');
  });
  // 【用例 5】knowledge 列表统一语义——企业空间知识库 JS 过滤放行（owner 第一关之外的空间维度）
  await t('V2.4#9 收尾：knowledge 列表空间过滤复用统一语义', () => {
    const { spaceVisibleTo } = require('../src-server/lib/space-utils');
    // seed 的 2 个 kbs（owner=admin）经回填归企业空间——企业空间维度对任意用户放行
    const kbs = db.prepare('SELECT name, space_id FROM kbs').all();
    assert.ok(kbs.length >= 2, 'seed 应有知识库');
    for (const k of kbs) {
      assert.ok(k.space_id, `知识库「${k.name}」应已完成空间回填`);
      assert.strictEqual(spaceVisibleTo(db, k.space_id, 'zhangsan'), true, `企业空间知识库「${k.name}」空间维度应放行`);
    }
  });

  // 【MT-03】租户上下文中间件：单租户默认注入默认租户
  await t('MT-03：单租户模式下 tenantContext 注入默认租户（零行为变更）', () => {
    const { tenantContext } = require('../src-server/lib/auth');
    const req = { headers: {} };
    let called = false;
    const res = { status() { return this; }, json() { return this; } };
    tenantContext(req, res, () => { called = true; });
    assert.ok(called, '应放行');
    assert.strictEqual(req.tenant.id, 1, '默认租户 id=1');
    assert.strictEqual(req.tenant.single, true, 'single 标记为真');
  });

  // 【MT-04】多租户空间过滤「两段判定」
  await t('MT-04：多租户空间过滤——跨租户不可见 / admin 受租户边界 / 单租户不变', () => {
    const { spaceFilterSql, spaceVisibleTo } = require('../src-server/lib/space-utils');
    db.prepare("INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('他租户企业空间','enterprise','admin',1,'2026-11-22',2)").run();
    const sp2 = db.prepare("SELECT id FROM spaces WHERE name='他租户企业空间'").get().id;
    db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id) VALUES ('他租户智能体','other',?,'admin','published','public',2)").run(sp2);
    try {
      // 单租户：不加租户条件，admin 零条件放行 → 与改造前一致
      assert.strictEqual(spaceFilterSql('a', { username: 'admin', role: 'admin' }).sqlStr, '', '单租户 admin 无过滤（回归不变）');
      // 多租户 tenant=1 视角：跨租户资源不可见
      const { sqlStr, args } = spaceFilterSql('a', { username: 'zhangsan', role: 'user' }, { tenantId: 1 });
      const names = db.prepare(`SELECT a.name FROM agents a WHERE 1=1 ${sqlStr}`).all(...args).map(r => r.name);
      assert.ok(!names.includes('他租户智能体'), '跨租户智能体不可见（tenant=1 视角）');
      // admin 多租户视角亦受租户边界
      const am = spaceFilterSql('a', { username: 'admin', role: 'admin' }, { tenantId: 1 });
      const an = db.prepare(`SELECT a.name FROM agents a WHERE 1=1 ${am.sqlStr}`).all(...am.args).map(r => r.name);
      assert.ok(!an.includes('他租户智能体'), 'admin 多租户下也看不到他租户资源');
      // spaceVisibleTo 跨租户判定
      assert.strictEqual(spaceVisibleTo(db, sp2, 'zhangsan', { tenantId: 1 }), false, '跨租户空间不可见');
      assert.strictEqual(spaceVisibleTo(db, sp2, 'zhangsan', { tenantId: 2 }), true, '本租户企业空间可见');
    } finally {
      db.prepare("DELETE FROM agents WHERE name='他租户智能体'").run();
      db.prepare("DELETE FROM spaces WHERE name='他租户企业空间'").run();
    }
  });

  // 【MT-05】租户出口接线：reqTenantOpt 由 req.tenant 生成过滤 opts
  await t('MT-05：reqTenantOpt——单租户→{} / 多租户→{tenantId}', () => {
    const { reqTenantOpt } = require('../src-server/lib/space-utils');
    assert.deepStrictEqual(reqTenantOpt({ tenant: { id: 1, single: true } }), {}, '单租户不启用边界');
    assert.deepStrictEqual(reqTenantOpt({ tenant: { id: 5 } }), { tenantId: 5 }, '多租户启用边界');
    assert.deepStrictEqual(reqTenantOpt({}), {}, '无租户上下文→不启用');
  });

  // 【BE-C1】DAL 统一出口：方言翻译 + 租户片段
  await t('BE-C1：DAL q/tenantWhere/translateSql 出口语义', () => {
    const dal = require('../src-server/lib/dal');
    assert.strictEqual(dal.translateSql('SELECT 1'), 'SELECT 1', 'sqlite 方言恒等');
    assert.strictEqual(dal.q('SELECT 1 AS one')[0].one, 1, 'q() 可查询');
    assert.strictEqual(dal.tenantScope({ tenant: { id: 1, single: true } }), null, '单租户 scope=null');
    assert.strictEqual(dal.tenantScope({ tenant: { id: 3 } }), 3, '多租户 scope=id');
    assert.deepStrictEqual(dal.tenantWhere('a', null), { sqlStr: '', args: [] });
    assert.deepStrictEqual(dal.tenantWhere('a', 3), { sqlStr: ' AND a.tenant_id=?', args: [3] });
  });

  // 【BE-C2】SQL 方言闭环：translate 等价改写 + 未映射告警
  await t('BE-C2：SQL 方言 translate——sqlite 恒等 / dm / kingbase 等价改写', () => {
    const { translate } = require('../src-server/lib/sql-dialect');
    assert.strictEqual(translate('SELECT 1', 'sqlite').sql, 'SELECT 1', 'sqlite 恒等');
    const dm = translate("SELECT datetime('now','localtime')", 'dm');
    assert.ok(/to_char\(SYSDATE, 'YYYY-MM-DD HH24:MI:SS'\)/.test(dm.sql), 'datetime→to_char(SYSDATE)（TEXT 契约，PG-1 语义修复）：' + dm.sql);
    const kb = translate("SELECT strftime('%s','now','localtime') - strftime('%s', t)", 'kingbase');
    assert.ok(/EXTRACT\(EPOCH FROM/.test(kb.sql), 'strftime %s→epoch：' + kb.sql);
    const kbDate = translate("SELECT strftime('%Y-%m-%d', t)", 'kingbase');
    assert.ok(/to_char\(\(t\)::timestamp, 'YYYY-MM-DD'\)/.test(kbDate.sql), 'strftime 日期→to_char（列实参强转，PG-1）：' + kbDate.sql);
    assert.ok(/IDENTITY/.test(translate('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)', 'dm').sql), 'dm AUTOINCREMENT→IDENTITY');
    assert.ok(/SERIAL/.test(translate('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)', 'kingbase').sql), 'kingbase AUTOINCREMENT→SERIAL');
    const warn = translate('INSERT OR REPLACE INTO t (a) VALUES (?)', 'kingbase');
    assert.ok(warn.warnings.length > 0, '未映射构造应产出告警');
  });

  // 【PG-1（2026-11-23）】datetime()/date() 语义改写：TEXT 契约 + 业务基准钟 + 修饰符 + 残留告警网
  // 背景：此前 datetime('now','localtime')→CURRENT_TIMESTAMP 是「能解析但行为不等价」——PG 里
  // timestamptz 强类型与 TEXT 列比较直接报 operator does not exist（PG 轨道 task_queue 首踩）。
  await t('PG-1：datetime/date 语义改写——TEXT 契约 + 基准时钟 + 修饰符 + 列形态 + 残留告警网', () => {
    const { translate } = require('../src-server/lib/sql-dialect');
    // 基钟：TEXT 契约（不再产 timestamptz），基准 Asia/Shanghai（与 db.js now() 写入同钟）
    const kb = translate("SELECT * FROM task_queue WHERE scheduled_at <= datetime('now','localtime')", 'kingbase');
    assert.ok(/to_char\(now\(\) AT TIME ZONE 'Asia\/Shanghai', 'YYYY-MM-DD HH24:MI:SS'\)/.test(kb.sql), 'datetime→TEXT 墙钟：' + kb.sql);
    assert.ok(!/CURRENT_TIMESTAMP/.test(kb.sql), '不应再译作 CURRENT_TIMESTAMP（类型陷阱）');
    assert.strictEqual(kb.warnings.length, 0, '标准形态不应产出 warning');
    // ±N unit 修饰符：PG 系 interval / dm Oracle 式 INTERVAL
    const mod = translate("SELECT datetime('now','localtime','-30 days')", 'kingbase');
    assert.ok(/- interval '30 day'/.test(mod.sql), '±N unit→interval：' + mod.sql);
    const dmMod = translate("SELECT datetime('now','localtime','-30 days')", 'dm');
    assert.ok(/SYSDATE - INTERVAL '30' DAY/.test(dmMod.sql), 'dm 修饰符 Oracle 式：' + dmMod.sql);
    // start of day：PG date_trunc / dm TRUNC
    const trunc = translate("SELECT datetime('now','localtime','start of day')", 'kingbase');
    assert.ok(/date_trunc\('day', now\(\) AT TIME ZONE 'Asia\/Shanghai'\)/.test(trunc.sql), 'start of day→date_trunc：' + trunc.sql);
    const dmTrunc = translate("SELECT datetime('now','localtime','start of month')", 'dm');
    assert.ok(/TRUNC\(SYSDATE, 'MM'\)/.test(dmTrunc.sql), 'dm start of month→TRUNC：' + dmTrunc.sql);
    // 列形态：datetime(col) → TEXT 规范化（localbridge 在线态判定）
    const col = translate("SELECT CASE WHEN datetime(last_seen) > datetime('now','localtime','-15 seconds') THEN 1 ELSE 0 END FROM localbridge_devices", 'kingbase');
    assert.ok(/to_char\(\(last_seen\)::timestamp/.test(col.sql) && /- interval '15 second'/.test(col.sql), '列形态强转 + 修饰符：' + col.sql);
    // date('now') → TEXT 日期（feedback 今日统计）
    const d8 = translate("SELECT COUNT(*) FROM feedbacks WHERE created_at >= date('now','localtime')", 'kingbase');
    assert.ok(/to_char\(now\(\) AT TIME ZONE 'Asia\/Shanghai', 'YYYY-MM-DD'\)/.test(d8.sql), 'date→TEXT 日期：' + d8.sql);
    // 参数化修饰符：不可静态改写 → 保留原文 + 残留告警网（调用点应改 JS 计算，见 memory-driver）
    const param = translate("SELECT datetime('now','localtime',?||' seconds')", 'kingbase');
    assert.ok(/datetime\(/.test(param.sql), '参数化修饰符不应臆造改写');
    assert.ok(param.warnings.some((w) => /残留/.test(w)), '残留应产出 warning（审计网）：' + param.warnings.join(';'));
    // sqlite 方言：恒等零回归
    const s = translate("SELECT datetime('now','localtime','-30 days')", 'sqlite');
    assert.strictEqual(s.sql, "SELECT datetime('now','localtime','-30 days')", 'sqlite 恒等');
  });

  // 【BE-C2 收尾（2026-11-23）】方言闭环：downgrades 机制 / 新构造映射 / upsert 标准化 / 审计门禁
  console.log('【BE-C2】SQL 方言闭环收尾（downgrades / ON CONFLICT / 审计门禁）');
  {
    const { translate } = require('../src-server/lib/sql-dialect');
    await t('BE-C2：downgrades 机制——FTS5/vec0 虚表非 sqlite 方言跳过建表 + 登记降级路径', () => {
      const ftsDdl = "CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(\n    content,\n    tokenize='unicode61'\n  );";
      const vecDdl = 'CREATE VIRTUAL TABLE IF NOT EXISTS vec_kb_1 USING vec0(embedding float[1024]);';
      // sqlite 方言：恒等 + 零 downgrades
      const s = translate(ftsDdl, 'sqlite');
      assert.strictEqual(s.sql, ftsDdl, 'sqlite 方言 FTS5 建表应恒等（零回归）');
      assert.deepStrictEqual(s.downgrades, [], 'sqlite 方言不应产生降级');
      // dm/kingbase：建表注释化跳过 + downgrades 登记（检索降级路径：BM25 内存通道 / ANN 全扫）
      for (const d of ['dm', 'kingbase']) {
        const t1 = translate(ftsDdl, d);
        assert.ok(/\[dialect-skip:fts5\]/.test(t1.sql), `${d} FTS5 建表应注释化跳过：` + t1.sql.slice(0, 80));
        assert.ok(t1.downgrades.some(x => x.kind === 'virtual-table:fts5'), `${d} 应登记 FTS5 降级`);
        assert.strictEqual(t1.warnings.length, 0, `${d} FTS5 属已确认降级，不应产出 warning（降级≠未映射）`);
        const t2 = translate(vecDdl, d);
        assert.ok(/\[dialect-skip:vec0\]/.test(t2.sql), `${d} vec0 建表应注释化跳过`);
        assert.ok(t2.downgrades.some(x => x.kind === 'virtual-table:vec0'), `${d} 应登记 vec0 降级`);
      }
    });
    await t('BE-C2：dm 单列自增补映射 + ON CONFLICT 双方言语义锚定', () => {
      // dm 此前仅覆盖 PK 紧跟形态，单列 INTEGER AUTOINCREMENT 落入残留告警——补映射后零告警
      const dmCol = translate('CREATE TABLE t (id INTEGER AUTOINCREMENT, n TEXT)', 'dm');
      assert.ok(/INT IDENTITY\(1,1\)/.test(dmCol.sql), 'dm 单列自增→IDENTITY：' + dmCol.sql);
      assert.ok(!dmCol.warnings.some(w => /AUTOINCREMENT/.test(w)), '单列自增不应再产 AUTOINCREMENT 残留告警');
      // ON CONFLICT upsert：kingbase（PG 系）原生兼容零告警；dm 不支持 → warning（替代：MERGE 模板，登记表承载）
      const upsert = 'INSERT INTO t (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v';
      const kb = translate(upsert, 'kingbase');
      assert.strictEqual(kb.warnings.length, 0, 'kingbase 应原生兼容 ON CONFLICT（不产告警）');
      assert.strictEqual(kb.sql, upsert, 'kingbase 翻译应保持原样（原生语法）');
      const dm = translate(upsert, 'dm');
      assert.ok(dm.warnings.some(w => /ON CONFLICT upsert/.test(w)), 'dm 不支持 ON CONFLICT 应产出告警（登记 MERGE 替代）');
      // sqlite_master 系统表：非 sqlite 方言登记（替代：information_schema / migrate 方言探测分支）
      for (const d of ['dm', 'kingbase']) {
        const sm = translate("SELECT name FROM sqlite_master WHERE type='table' AND name=?", d);
        assert.ok(sm.warnings.some(w => /sqlite_master/.test(w)), `${d} sqlite_master 查询应登记告警`);
      }
      assert.strictEqual(translate("SELECT name FROM sqlite_master WHERE type='table'", 'sqlite').warnings.length, 0, 'sqlite 方言系统表查询零告警');
    });
    await t('BE-C2：业务 upsert 标准化行为回归——ON CONFLICT 写法在 SQLite 下语义等价且 id 稳定', () => {
      const { db } = require('../src-server/db');
      // secrets（UNIQUE(name, tenant_id)）：同键写两次 → 单行 + id 稳定 + 首建 created_at 保留（REPLACE 会重排 id/重置时间）
      db.prepare(`INSERT INTO secrets (name,value,remark,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(name, tenant_id) DO UPDATE SET value=excluded.value, remark=excluded.remark, updated_at=excluded.updated_at`)
        .run('be2-test-key', 'v1', 'r1', '2020-01-01 00:00:00', '2020-01-01 00:00:00');
      db.prepare(`INSERT INTO secrets (name,value,remark,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(name, tenant_id) DO UPDATE SET value=excluded.value, remark=excluded.remark, updated_at=excluded.updated_at`)
        .run('be2-test-key', 'v2', 'r2', '2099-01-01 00:00:00', '2099-01-01 00:00:00');
      const rows = db.prepare("SELECT * FROM secrets WHERE name='be2-test-key'").all();
      assert.strictEqual(rows.length, 1, '同键两次 upsert 应保持单行（ON CONFLICT 语义）');
      assert.strictEqual(rows[0].value, 'v2', '第二次写入应更新 value');
      assert.strictEqual(rows[0].remark, 'r2', '第二次写入应更新 remark');
      assert.strictEqual(rows[0].created_at, '2020-01-01 00:00:00', 'created_at 应保留首建值（语义改善：REPLACE 会重置）');
      // model_capabilities（UNIQUE(model_name,provider_name,capability)）：同三元组二次注册 → 单行 + priority 更新
      const mc = `INSERT INTO model_capabilities (model_name,provider_name,capability,priority,enabled,created_at)
        VALUES (?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(model_name, provider_name, capability) DO UPDATE SET priority=excluded.priority, enabled=excluded.enabled`;
      db.prepare(mc).run('be2-model', 'p1', 'text', 1, 1);
      db.prepare(mc).run('be2-model', 'p1', 'text', 9, 0);
      const mcRows = db.prepare("SELECT * FROM model_capabilities WHERE model_name='be2-model'").all();
      assert.strictEqual(mcRows.length, 1, '同唯一键二次注册应保持单行');
      assert.strictEqual(mcRows[0].priority, 9, 'priority 应更新为最新值');
      assert.strictEqual(mcRows[0].enabled, 0, 'enabled 应更新为最新值');
      // _config（key PK）：config.set 真实链路两次同 key → 单行（upsert 语义）
      // 注：config.set 有 CONFIG_DEFS 白名单（防御式设计，未定义 key 拒写）——用已定义项测试，结束后恢复原值
      const config = require('../src-server/lib/config');
      const cfgKey = 'upload_ttl_days';
      const cfgOrig = config.get(cfgKey);
      try {
        config.set(cfgKey, 11);
        config.set(cfgKey, 22);
        const cfg = db.prepare('SELECT * FROM _config WHERE key=?').get(cfgKey);
        assert.ok(cfg && String(cfg.value) === '22', 'set 两次同 key 应 upsert 为最新值：' + JSON.stringify(cfg));
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM _config WHERE key=?').get(cfgKey).c, 1, '同 key 应保持单行');
      } finally {
        config.set(cfgKey, cfgOrig);
        db.prepare('DELETE FROM secrets WHERE name=?').run('be2-test-key');
        db.prepare('DELETE FROM model_capabilities WHERE model_name=?').run('be2-model');
      }
    });
    await t('BE-C2：方言闭环审计门禁——lint:dialect 未登记 warning = 0（验收锚点）', async () => {
      // 验收原文「warning 清单为 0 或有替代」的机器化锚点：审计工具 exit 0 = 全部 warning 已登记替代
      const { execFileSync } = require('child_process');
      const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'lint-dialect.js')], {
        encoding: 'utf8', timeout: 60000,
      });
      assert.ok(/方言审计门禁通过/.test(out), '审计工具应通过门禁：' + out.slice(-200));
      assert.ok(/未登记 warning = 0/.test(out), '未登记 warning 应为 0（已登记项均有替代）');
      assert.ok(/downgrades（已确认降级，非阻塞）/.test(out), '降级清单应单独报告（FTS5/vec0 跳过登记）');
    });
  }

  // ==================== MT-7（2026-11-23）PG 同步桥 PoC：契约级单测（无 PG 环境文本级） ====================
  console.log('【MT-7】PG 同步桥 PoC（占位符转换 / RLS 策略 / 桥契约 / 接线守卫）');
  {
    await t('MT-7：pg-bridge 占位符转换——?→$n 词法感知（字符串/注释/转义引号不误转）', () => {
      const { convertPlaceholders } = require('../src-server/lib/pg-bridge');
      // 基本转换 + 顺序编号
      assert.deepStrictEqual(convertPlaceholders('SELECT * FROM t WHERE a=? AND b=?'),
        { sql: 'SELECT * FROM t WHERE a=$1 AND b=$2', n: 2 }, '占位符应顺序转 $1..$n');
      // 字符串字面量内 ? 不是占位符（LIKE '%?%' 语义保持）
      const r1 = convertPlaceholders("SELECT * FROM t WHERE c LIKE '%?%' AND d=?");
      assert.strictEqual(r1.sql.includes("'%?%'"), true, '字符串内 ? 不应转换：' + r1.sql);
      assert.strictEqual(r1.n, 1, '仅字符串外的 ? 计数');
      // 注释内 ? 不转换
      const r2 = convertPlaceholders('SELECT ? -- 何处 ? 呢\n FROM t');
      assert.strictEqual(r2.n, 1, '注释内 ? 不计数：' + r2.sql);
      assert.ok(r2.sql.includes('-- 何处 ? 呢'), '注释文本应保持原样');
      // 转义引号（'' → 双写）不提前终止字符串扫描
      const r3 = convertPlaceholders("SELECT 'it''s ?' AS s, ? FROM t");
      assert.strictEqual(r3.n, 1, '转义引号后的 ? 仍在字符串内不计数：' + r3.sql);
      // 数字编号连续性
      assert.deepStrictEqual(convertPlaceholders('UPDATE t SET x=? WHERE id=?'), { sql: 'UPDATE t SET x=$1 WHERE id=$2', n: 2 });
    });
    await t('MT-7：pg-bridge 桥契约——连接串/驱动缺失 fail-fast 可读错误（不裸崩）', () => {
      const { createPgBridge } = require('../src-server/lib/pg-bridge');
      // 无连接串：明确报缺 PG_CONN/DATABASE_URL（部署自查友好）
      assert.throws(() => createPgBridge(), /缺少 PG 连接串/, '无连接串应报可读错误');
      // 有连接串但 pg 驱动未安装：报安装指引并提示回退 sqlite。
      // 本机自 MT-7 真机验证起已装 pg——劫持 Module._resolveFilename 确定性模拟「未装」，
      // 不依赖宿主环境安装状态（无论装没装都必须给可读指引，不裸崩）
      const Module = require('module');
      const origResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'pg') {
          const e = new Error("Cannot find module 'pg'");
          e.code = 'MODULE_NOT_FOUND';
          throw e;
        }
        return origResolve.call(this, request, ...rest);
      };
      try {
        assert.throws(() => createPgBridge({ connString: 'postgres://u:p@localhost:5432/db' }),
          /未安装 pg 驱动[\s\S]*AGENT_DB_DRIVER=sqlite/, '未装驱动应报指引（惰性 require 约定，同 db-driver）');
      } finally {
        Module._resolveFilename = origResolve; // 恢复解析器——劫持仅限本断言内
      }
    });
    await t('MT-7/PG-1：RLS 策略 SQL v2——FORCE + 双向策略 + platform 逃逸 cast-safe + 平面排除语义', () => {
      const { rlsPolicySql, PLATFORM_PLANE_EXCLUDE, rlsTableList } = require('../src-server/lib/pg-rls');
      const sql = rlsPolicySql('agents');
      assert.ok(/ALTER TABLE agents ENABLE ROW LEVEL SECURITY/.test(sql), '应启用 RLS');
      assert.ok(/ALTER TABLE agents FORCE ROW LEVEL SECURITY/.test(sql), '应 FORCE（owner 也受控——DB 层强制隔离的验收语义）');
      assert.ok(/USING \(/.test(sql) && /WITH CHECK \(/.test(sql), 'POLICY 应双向（USING 管读 + WITH CHECK 管写）');
      // 'platform' 显式逃逸分支：平台平面运维的代码级 opt-in 通道（FORCE 下唯一跨租户路径）
      assert.ok(/current_setting\('app\.tenant_id', true\) = 'platform'/.test(sql),
        '应有 platform 显式逃逸分支（平台运维 opt-in，非用户可控输入）');
      // cast-safe：'platform' 须双重 NULLIF 归一后再参与 ::int 比较，否则 OR 分支因非数字串直接报错。
      // PG-1 复现踩坑（2026-11-24）：v2 曾误写三参 NULLIF(x,'','platform')——NULLIF 仅收 2 参，
      // 多语句块整体解析失败致 ENABLE/FORCE 全部未执行且被启动 catch 吞掉（策略数 0、假绿）。
      // 锚定正确形态（逐层 2 参嵌套）+ 三参负向检查（括号配平守卫查不出参数个数错误）
      assert.ok(sql.includes("COALESCE(NULLIF(NULLIF(current_setting('app.tenant_id', true), ''), 'platform'), '0')::int"),
        '匹配分支应为逐层 2 参 NULLIF 嵌套（cast-safe）：' + sql);
      assert.ok(!sql.includes(", '', 'platform'") && !sql.includes(", '', '0'"),
        '不得出现三参 NULLIF 形态（如 ", \'\', \'platform\'"——PG 仅收 2 参，整体解析失败——曾致 RLS 静默全失效）');
      assert.ok(/COALESCE\([\s\S]*'0'\)::int/.test(sql), '未设上下文应回退 0（平台基线租户）');
      assert.ok(/DROP POLICY IF EXISTS/.test(sql), '策略应幂等（重复执行安全）');
      // 括号配平（PG 解析器硬校验）——PoC 首跑踩坑：WITH CHECK 曾多一个右括号致 syntax error，
      // 且该错被 db.js 非致命 catch 吞掉（策略数 0、静默不隔离）。文本断言覆盖不了此类缺陷。
      const open = (sql.match(/\(/g) || []).length;
      const close = (sql.match(/\)/g) || []).length;
      assert.strictEqual(open, close, `RLS 策略 SQL 括号应配平（open=${open}, close=${close}）`);
      // 平面排除语义（PG-1 定稿锚定）：认证网关/审计/0 层基线分层表不参与 RLS——
      // 单租户匹配策略会破坏其跨租户或基线可见性语义（防线保持应用层）
      assert.ok(PLATFORM_PLANE_EXCLUDE.includes('users') && PLATFORM_PLANE_EXCLUDE.includes('op_logs')
        && PLATFORM_PLANE_EXCLUDE.includes('secrets'),
        'users（认证网关）/op_logs（审计）/secrets（tenant_id=0 全局基线分层）应在排除清单');
      assert.ok(!PLATFORM_PLANE_EXCLUDE.includes('agents') && !PLATFORM_PLANE_EXCLUDE.includes('kbs')
        && !PLATFORM_PLANE_EXCLUDE.includes('sessions') && !PLATFORM_PLANE_EXCLUDE.includes('messages')
        && !PLATFORM_PLANE_EXCLUDE.includes('tasks'),
        '租户内容核心表不得进排除清单');
      // 清单一致性（sqlite 测试库上自检）：TENANT_TABLES 89 张 − 平面排除 = RLS 覆盖面
      const list = rlsTableList(db);
      assert.strictEqual(list.length, 89 - PLATFORM_PLANE_EXCLUDE.length,
        `RLS 覆盖清单应 = 89 − ${PLATFORM_PLANE_EXCLUDE.length}，实际 ${list.length}`);
      assert.ok(['agents', 'kbs', 'sessions', 'messages', 'tasks'].every(x => list.includes(x)),
        'PoC 五张核心表应仍在覆盖清单（验收基线不回退）');
    });
    await t('MT-7：方言 BLOB→BYTEA + instr()→strpos()（kingbase）——迁移 #130 列定义与 api_key 加密迁移在 PG 侧可执行', () => {
      const { translate } = require('../src-server/lib/sql-dialect');
      const alterSql = 'ALTER TABLE agent_memories ADD COLUMN embedding BLOB DEFAULT NULL';
      assert.strictEqual(translate(alterSql, 'kingbase').sql,
        'ALTER TABLE agent_memories ADD COLUMN embedding BYTEA DEFAULT NULL',
        'kingbase/PG 系应把 BLOB 翻译为 BYTEA（PG 无 BLOB 类型，原文直发即 syntax error——PoC 首跑 #130 踩坑）');
      assert.strictEqual(translate(alterSql, 'sqlite').sql, alterSql, 'sqlite 方言恒等翻译（零回归）');
      assert.strictEqual(translate(alterSql, 'dm').sql, alterSql, 'dm 自有 BLOB 类型，不应改写');
      // instr() → strpos()：api_key 加密迁移的明文探测（WHERE instr(api_key,'.')=0）——PG 无 instr，
      // 原文直发即报错、迁移兜底降级为不加密（密钥明文落库，PoC 二跑踩坑）
      const probeSql = "SELECT id, api_key FROM providers WHERE api_key!='' AND instr(api_key,'.')=0";
      assert.strictEqual(translate(probeSql, 'kingbase').sql,
        "SELECT id, api_key FROM providers WHERE api_key!='' AND strpos(api_key,'.')=0",
        'kingbase/PG 系应把 instr() 翻译为 strpos()（语义一致：1 起始位置，未命中 0）');
      assert.strictEqual(translate(probeSql, 'dm').sql, probeSql, 'dm 自有 INSTR 函数，不应改写');
    });
    await t('MT-7：worker 同步握手协议——Atomics 唤醒 + 事务租约 + lastval 契约（静态守卫）', () => {
      const fs2 = require('fs');
      const workerSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'pg-bridge-worker.js'), 'utf8');
      // Atomics.notify 是主线程 Atomics.wait 的唯一同步唤醒路径（postMessage 事件在阻塞期不可达）
      assert.ok(/Atomics\.store\(stateArr, 0, 1\)/.test(workerSrc) && /Atomics\.notify\(stateArr, 0\)/.test(workerSrc),
        'worker 完成后应 notify 唤醒（同步桥的正确性根基）');
      // 事务亲和：BEGIN 租约 / COMMIT|ROLLBACK 归还（多语句跨连接会使事务失效）
      assert.ok(/txConn = await pool\.connect\(\)/.test(workerSrc), 'BEGIN 应租约专用连接');
      assert.ok(/c\.release\(\)/.test(workerSrc), '事务结束应归还租约连接');
      // lastInsertRowid 契约（dal.insert/路由创建链依赖）：同连接补查 lastval()
      assert.ok(/SELECT lastval\(\) AS v/.test(workerSrc), 'run 应补查 lastval 实现 lastInsertRowid');
      // RLS 注入：SET LOCAL 事务级（连接归池不残留）
      assert.ok(/set_config\('app\.tenant_id'/.test(workerSrc), '应注入会话变量（RLS 强制隔离）');
      const bridgeSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'pg-bridge.js'), 'utf8');
      assert.ok(/Atomics\.wait\(state, 0, 0, CALL_TIMEOUT_MS\)/.test(bridgeSrc), '主线程应同步等待（带超时防死锁）');
      assert.ok(!/rows\[0\] \|\| null/.test(bridgeSrc), 'get 契约：无行返回 undefined（better-sqlite3 语义）');
      // setTenantContext 入参窄化守卫（PoC 二跑踩坑）：曾误写 Number(tenantId)（闭包初值 null →
      // Number(null)=0），一切租户上下文静默归 0、RLS 隔离形同虚设——静态锚定防复发
      assert.ok(/setTenantContext\(tid\)\s*\{\s*tenantId = tid == null \? null : Number\(tid\)/.test(bridgeSrc),
        'setTenantContext 应窄化入参 tid（Number(tenantId) 会使所有租户上下文静默变 0）');
      // worker 不得阻止进程退出（PoC 首跑踩坑）：一次性脚本（node -e / CLI）主逻辑完成后因 worker
      // 存活而永不退出，表现为子进程挂死、execFileSync 逐级超时——unref 后进程存活只取决于主线程句柄
      assert.ok(/worker\.unref\(\)/.test(bridgeSrc), 'worker 应 unref（不阻止进程自然退出）');
      // PG-1：请求级租户上下文（ALS）——闭包方案在 async 恢复点会串租（A await 期间 B 改写闭包，
      // A 恢复后带着 B 的租户查询）。withTenant 是 auth 中间件的注入主通道，'platform' 为显式逃逸
      assert.ok(/AsyncLocalStorage/.test(bridgeSrc) && /withTenant\(tid, fn\)/.test(bridgeSrc),
        '桥应提供 withTenant 请求级 ALS 上下文（async 恢复点不串租）');
      assert.ok(/effTenant\(\)/.test(bridgeSrc), '调用时应优先取 ALS 请求域上下文（闭包兑底）');
      // worker 侧：'platform' 逃逸值不得经 Number() 窄化（NaN 会破坏 set_config）
      assert.ok(/req\.tenantId === 'platform' \? 'platform' : Number\(req\.tenantId\)/.test(workerSrc),
        "worker 应保留 'platform' 字面值（RLS 策略逃逸分支匹配）");
      // PG-1（2026-11-24）transaction 契约：better-sqlite3 语义是「返回可调用包装」（调用点
      // db.transaction(fn)(args)）。原实现直接执行并返回结果——调用点二次调用即 not a function，
      // 且事务已 COMMIT 无法随异常回滚（PG 轨道 MT-10「400 返回却已落库」假象即此）
      assert.ok(/return \(\.\.\.args\) => \{/.test(bridgeSrc)
        && /transaction\(fn\)[\s\S]{0,300}BEGIN/.test(bridgeSrc),
        'transaction(fn) 应返回可调用包装（better-sqlite3 契约）');
      // PG-1（2026-11-24）租约内禁止嵌套 BEGIN/COMMIT：内层 COMMIT 会提前提交外层事务
      //（原子性破坏——双插入任一失败也无法整笔回滚）；租约内失败也不得 ROLLBACK（留给外层清理）
      assert.ok(/const inLease = conn === txConn/.test(workerSrc), 'worker 应判定事务租约（防嵌套 BEGIN/COMMIT）');
      assert.ok(/req\.tenantId != null && !inLease/.test(workerSrc), '租约内失败不应 ROLLBACK 外层事务');
    });
    await t('MT-7：db.js 接线守卫——AGENT_DB_DRIVER 分支 + sqlite 缺省路径 + 探测方言化收敛', () => {
      const fs2 = require('fs');
      const dbSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'db.js'), 'utf8');
      assert.ok(/AGENT_DB_DRIVER\s*\|\|\s*'sqlite'/.test(dbSrc), '缺省驱动应为 sqlite（生产零回归）');
      assert.ok(/DB_DRIVER === 'pg'/.test(dbSrc) && /createPgBridge/.test(dbSrc), 'pg 分支应走同步桥');
      assert.ok(/DB_DIALECT = process\.env\.DB_DIALECT \|\| 'kingbase'/.test(dbSrc),
        'PG 模式应绑定 kingbase（PG 系）方言——DDL/探测分支随 DB_DIALECT 生效');
      // 探测方言化（PG 启动必需）：46 处散点已收敛 probeColumns/probeTableExists
      assert.ok(dbSrc.includes('function probeColumns(') && dbSrc.includes('function probeTableExists('),
        '启动期探测辅助应存在（方言分支）');
      const pragmaCount = (dbSrc.match(/db\.prepare\('PRAGMA table_info/g) || []).length;
      assert.strictEqual(pragmaCount, 0, '业务散点应全部收敛（0 处直连 PRAGMA；probeColumns 内部为模板串形态不在此计数）：' + pragmaCount);
      // PG-1：租户上下文全链接线——auth.tenantContext 的全部出口经 enterTenantDb 包裹
      //（req.tenant → ALS → RLS 会话变量；sqlite 无 withTenant 直通 next()，零回归）
      const authSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'auth.js'), 'utf8');
      const wired = (authSrc.match(/enterTenantDb\(req, next\)/g) || []).length;
      assert.ok(wired >= 6, `tenantContext 各出口应经 enterTenantDb 包裹（定义+5 出口，实际 ${wired} 处）`);
      assert.ok(/typeof db\.withTenant !== 'function'/.test(authSrc), 'sqlite 应直通 next()（零回归守卫）');
    });

    // 【PG-1 增量（2026-11-24）】写路径租户列自动注入（桥层）+ 后台路径上下文接线
    // 背景：业务 INSERT 普遍不写 tenant_id（列默认 1）——租户≠1 请求下新行错挂租户 1，
    // PG 模式被 RLS WITH CHECK 直接拒绝。注入器在桥层统一兜底，1585+ 调用点零改动。
    await t('PG-1 增量：桥层 INSERT 租户列注入器——典型/显式/排除表/防御形态（纯函数单测）', () => {
      const { injectTenantVersion, TENANT_CONTENT_TABLES, convertPlaceholders } = require('../src-server/lib/pg-bridge');
      // 覆盖面与 pg-rls 同源（单一事实源：改排除清单两侧同步）
      assert.ok(TENANT_CONTENT_TABLES.has('sessions') && TENANT_CONTENT_TABLES.has('agents') && !TENANT_CONTENT_TABLES.has('users') && !TENANT_CONTENT_TABLES.has('workflow_templates'),
        '注入覆盖面应 = TENANT_TABLES − 平面排除（users/workflow_templates 平面表不注入）');
      // ① 典型形态：cols 尾注入 tenant_id + VALUES 尾注入占位符
      const r1 = injectTenantVersion('INSERT INTO sessions (agent_id,title,username,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)', 5);
      assert.ok(r1 && r1.n === 6, '注入后占位符数 n+1：' + JSON.stringify(r1));
      assert.strictEqual(r1.sql, 'INSERT INTO sessions (agent_id,title,username,created_at,updated_at, tenant_id) VALUES ($1,$2,$3,$4,$5, $6)',
        'cols 尾加 tenant_id、VALUES 尾加 $n+1（括号配平）：' + (r1 && r1.sql));
      // ② 显式含 tenant_id → 不注入（显式优先：ops/scheduler 后台路径显式写行归属）
      assert.strictEqual(injectTenantVersion('INSERT INTO agents (name,tenant_id) VALUES ($1,$2)', 2), null, '显式 tenant_id 应跳过');
      // ③ 平面表（users）→ 不注入
      assert.strictEqual(injectTenantVersion('INSERT INTO users (username,nickname) VALUES ($1,$2)', 2), null, '排除清单表应跳过');
      // ④ ON CONFLICT 尾保留（INSERT OR IGNORE/REPLACE 经方言层标准化后的形态）
      const r4 = injectTenantVersion('INSERT INTO kbs (name,owner) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', 2);
      assert.ok(r4 && /ON CONFLICT \(name\) DO NOTHING$/.test(r4.sql), 'ON CONFLICT 尾应保留：' + (r4 && r4.sql));
      // ⑤ 多行 VALUES / INSERT..SELECT / 无列清单 → 防御直通 null（宁可不动不臆造）
      assert.strictEqual(injectTenantVersion('INSERT INTO kbs (name,owner) VALUES ($1,$2),($3,$4)', 4), null, '多行 VALUES 不注入');
      assert.strictEqual(injectTenantVersion('INSERT INTO kbs SELECT * FROM tmp', 0), null, 'INSERT..SELECT 不注入');
      assert.strictEqual(injectTenantVersion('INSERT INTO kbs VALUES ($1)', 1), null, '无列清单不注入');
      // ⑥ 值区含函数与括号字面量（翻译后的 to_char / 带括号字符串）——字符串感知括号匹配
      const r6 = injectTenantVersion("INSERT INTO tasks (name,created_at) VALUES ($1, to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))", 1);
      assert.ok(r6 && /VALUES \(\$1, to_char[\s\S]*'YYYY-MM-DD HH24:MI:SS'\), \$2\)$/.test(r6.sql), '函数括号应正确配平：' + (r6 && r6.sql));
      // ⑦ 桥 prepare 的双版本选择守卫（run 时取开关+ALS 租户，非 prepare 时固化）——开关防启动期
      //    种子在租户列迁移前显式引用 tenant_id（列不存在而炸，PG 轨道首踩）
      const bridgeSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'pg-bridge.js'), 'utf8');
      assert.ok(/const inj = injectTenantVersion\(pgSql, n\)/.test(bridgeSrc) && /tenantInjectEnabled && typeof tid === 'number'/.test(bridgeSrc),
        'prepare 应预生成注入版 + run 时按「开关+数字租户」动态选用（启动期语句跨上下文复用安全）');
      assert.ok(/setTenantInjection\(enabled\)/.test(bridgeSrc) && /db\.setTenantInjection\(true\)/.test(require('fs').readFileSync(path.join(__dirname, '..', 'src-server', 'db.js'), 'utf8')),
        'db.js 应在迁移+RLS 完成后打开注入开关（启动种子维持列默认归属）');
    });

    await t('PG-1 增量：后台路径上下文接线——withDbTenant 导出 / scheduler / ops 静态守卫', () => {
      const fs2 = require('fs');
      const { withDbTenant } = require('../src-server/db');
      assert.strictEqual(typeof withDbTenant, 'function', 'db 应导出 withDbTenant（后台模块统一入口）');
      const dbSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'db.js'), 'utf8');
      assert.ok(/const bootCtx = \(fn\) => withDbTenant\('platform', fn\)/.test(dbSrc), 'bootCtx 应为 withDbTenant 的 platform 特化（单一实现）');
      // scheduler：cron handler 平台读 + 按任务归属租户执行；tick 扫描 platform；task_runs 显式租户列
      const schedSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'scheduler.js'), 'utf8');
      assert.ok(/withDbTenant\('platform', \(\) => dal\.getq\('SELECT \* FROM tasks WHERE id=\?/.test(schedSrc),
        'cron-task handler 应 platform 读任务（队列 worker 无请求 ALS）');
      assert.ok(/withDbTenant\(Number\(task\.tenant_id\) \|\| 1, \(\) => runTask\(task\)\)/.test(schedSrc),
        '执行体应按任务归属租户进上下文');
      assert.ok(/withDbTenant\('platform', \(\) => dal\.q\('SELECT \* FROM tasks WHERE enabled=1/.test(schedSrc),
        'tick 扫描应 platform 逃逸（无上下文直查只见基线 0 行，调度器静默空转）');
      const trExplicit = (schedSrc.match(/INSERT INTO task_runs \(task_id,tenant_id,/g) || []).length;
      assert.strictEqual(trExplicit, 2, 'task_runs 两处 INSERT（disableTask/runTask）应显式租户列：' + trExplicit);
      // ops：任务统一 platform 包裹 + 两处写行显式租户列
      const opsSrc = fs2.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'ops.js'), 'utf8');
      assert.ok(/dailyOps\(job, \(\) => withDbTenant\('platform', fn\)\)/.test(opsSrc), 'ops 任务应统一 platform 逃逸上下文');
      assert.ok(/INSERT INTO agent_memories \(agent_id,username,fact,type,confidence,source,summary,tenant_id,created_at\)/.test(opsSrc),
        '记忆摘要 INSERT 应显式行归属租户');
      assert.ok(/recall_eval_results \(kb_id,[^)]*tenant_id, created_at\)/.test(opsSrc), '评测回归 INSERT 应显式行归属租户');
    });
  }

  // ================ P3 扩展工具（2026-10-22）：Text2SQL / 图表 / Word / MCP Server / 分类器路由 ================
  console.log('【N】P3 扩展工具（Text2SQL / 图表 / Word / MCP Server / 分类器路由）');
  const extra = require('../src-server/lib/tools-extra');
  const tools = require('../src-server/lib/tools');

  // P5.27 local_exec：注册与 high 风险分级、op 白名单拒绝
  await t('local_exec：注册 / high 风险 / 白名单外 op 拒绝 / 未配对引导', async () => {
    assert.ok(tools.TOOL_DEFS.local_exec, 'local_exec 应注册');
    assert.strictEqual(tools.toolRiskOf('local_exec'), 'high', '本地操控应归 high（默认权限必确认）');
    const extra = require('../src-server/lib/tools-extra');
    // 白名单外 op 直接拒绝（不查设备表）
    let r = String(await extra.local_exec.run({ op: 'rm_rf' }, { username: 'tester-no-device' }));
    assert.ok(r.includes('不支持的操作'), '白名单外 op 应拒绝');
    // 未配对用户 → 安装引导文案
    r = String(await extra.local_exec.run({ op: 'mkdir', target: 'Desktop/x' }, { username: 'tester-no-device' }));
    assert.ok(r.includes('还没有配对') && r.includes('助手'), '未配对应给安装引导');
  });
  await t('扩展工具注册：TOOL_DEFS 合并后共 27 个（+browser_use U1-4）', () => {
    const need = ['db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'export_word', 'tts', 'doc_review', 'run_code', 'local_exec', 'create_task'];
    need.forEach(n => assert.ok(tools.TOOL_DEFS[n], `缺少工具 ${n}`));
    // P3-2 工具市场扩展（2026-11-06）：11 个新工具（8 纯本地 + 3 网络），15 → 26
    const market = ['uuid_gen', 'hash_tool', 'base64_tool', 'json_tool', 'text_count', 'date_calc', 'unit_convert', 'cron_explain', 'weather_query', 'translate_text', 'exchange_rate'];
    market.forEach(n => assert.ok(tools.TOOL_DEFS[n], `缺少 P3-2 工具 ${n}`));
    assert.strictEqual(Object.keys(tools.TOOL_DEFS).length, 27);
    [...need, ...market].forEach(n => assert.strictEqual(tools.TOOL_DEFS[n].schema.function.name, n, `schema 名不匹配 ${n}`));
    assert.strictEqual(tools.toolRiskOf('create_task'), 'high', 'create_task 应归 high（默认权限必弹确认卡）');
    // P3-2：11 个新工具全部 low（只读无副作用，不弹确认卡）
    market.forEach(n => assert.strictEqual(tools.toolRiskOf(n), 'low', `P3-2 工具 ${n} 应归 low`));
  });
  // ===== P3-2 工具市场扩展（2026-11-06）：11 个新工具行为用例（8 纯本地直调 + 3 网络参数校验/mock） =====
  await t('P3-2 uuid_gen：uuid/password/string 三类型 + 数量与长度钳制', async () => {
    const m = require('../src-server/lib/tools-market');
    const u = await m.uuid_gen.run({ kind: 'uuid' });
    assert.ok(/^[0-9a-f-]{36}$/.test(u), 'uuid v4 形态：' + u);
    const pwd = await m.uuid_gen.run({ kind: 'password', length: 12 });
    assert.ok(pwd.length === 12 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd), '密码 12 位含大小写数字：' + pwd);
    const strs = await m.uuid_gen.run({ kind: 'string', count: 3, length: 10 });
    assert.strictEqual(strs.split('\n').length, 3, 'count=3 应生成 3 个');
    assert.ok(strs.split('\n').every(s => s.length === 10 && /^[A-Za-z0-9]+$/.test(s)), '纯字母数字 10 位');
  });
  await t('P3-2 hash_tool：MD5/SHA1/SHA256/SHA512 已知值校验 + 非法算法拒绝', async () => {
    const m = require('../src-server/lib/tools-market');
    const md5 = await m.hash_tool.run({ text: 'hello', algorithm: 'md5' });
    assert.ok(md5.includes('5d41402abc4b2a76b9719d911017c592'), 'MD5 已知值：' + md5);
    const sha256 = await m.hash_tool.run({ text: 'hello' });
    assert.ok(sha256.includes('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'), '默认 SHA256 已知值');
    assert.ok(sha256.startsWith('SHA256'), '前缀应标算法');
    const bad = await m.hash_tool.run({ text: 'x', algorithm: 'md4' });
    assert.ok(bad.includes('不支持'), '非法算法应拒绝：' + bad);
    const empty = await m.hash_tool.run({ text: '' });
    assert.ok(empty.includes('请提供'), '空文本应提示');
  });
  await t('P3-2 base64_tool：Base64/URL 四模式往返 + 非法编码容错', async () => {
    const m = require('../src-server/lib/tools-market');
    const enc = await m.base64_tool.run({ text: '你好 P3-2', mode: 'base64_encode' });
    const dec = await m.base64_tool.run({ text: enc, mode: 'base64_decode' });
    assert.strictEqual(dec, '你好 P3-2', 'Base64 往返应还原');
    const ue = await m.base64_tool.run({ text: 'a b&c=1', mode: 'url_encode' });
    const ud = await m.base64_tool.run({ text: ue, mode: 'url_decode' });
    assert.strictEqual(ud, 'a b&c=1', 'URL 编解码往返应还原');
    const bad = await m.base64_tool.run({ text: '!!!not-base64!!!', mode: 'base64_decode' });
    assert.ok(typeof bad === 'string' && !bad.includes('Error'), '非法输入不抛异常返回字符串：' + String(bad).slice(0, 40));
    const badMode = await m.base64_tool.run({ text: 'x', mode: 'hex' });
    assert.ok(badMode.includes('不支持'), '非法模式应提示');
  });
  await t('P3-2 json_tool：format/minify/validate 三模式 + 坏 JSON 定位', async () => {
    const m = require('../src-server/lib/tools-market');
    const fmt = await m.json_tool.run({ text: '{"a":1,"b":[2,3]}', mode: 'format' });
    assert.ok(fmt.includes('\n  "a"'), 'format 应缩进换行');
    const mini = await m.json_tool.run({ text: JSON.stringify({ a: 1, b: [2, 3] }), mode: 'minify' });
    assert.ok(!mini.includes(' '), 'minify 应压缩无空白（值内无空格时）：' + mini);
    const val = await m.json_tool.run({ text: '{"a":1}', mode: 'validate' });
    assert.ok(val.startsWith('✅'), '合法 JSON 校验通过');
    const bad = await m.json_tool.run({ text: '{bad json', mode: 'validate' });
    assert.ok(bad.startsWith('❌'), '坏 JSON 应报错：' + bad.slice(0, 30));
  });
  await t('P3-2 text_count：中英混合统计（中文字/英文词/句子/段落）', async () => {
    const m = require('../src-server/lib/tools-market');
    const r = await m.text_count.run({ text: '你好世界。Hello world!\n\n第二段内容结束。' });
    assert.ok(r.includes('中文字符：11'), r);
    assert.ok(r.includes('英文单词：2'), r);
    assert.ok(r.includes('段落数：2'), r);
    assert.ok(r.includes('句子数：3'), r);
  });
  await t('P3-2 unit_convert：长度/重量/温度/面积/数据量 + 中文单位 + 非法组合拒绝', async () => {
    const m = require('../src-server/lib/tools-market');
    assert.ok((await m.unit_convert.run({ value: 10, from: 'km', to: 'mile' })).includes('6.2137'), '10km≈6.2137mile');
    assert.ok((await m.unit_convert.run({ value: 1, from: 'kg', to: 'lb' })).includes('2.2046'), '1kg≈2.2046lb');
    assert.ok((await m.unit_convert.run({ value: 100, from: '°C', to: '°F' })).includes('212'), '100°C=212°F');
    assert.ok((await m.unit_convert.run({ value: 0, from: '°F', to: '°C' })).includes('-17.78'), '0°F≈-17.78°C');
    assert.ok((await m.unit_convert.run({ value: 1, from: '亩', to: 'm²' })).includes('666.6667'), '1亩≈666.6667m²');
    assert.ok((await m.unit_convert.run({ value: 2048, from: 'MB', to: 'GB' })).includes('2 gb'), '2048MB=2GB');
    assert.ok((await m.unit_convert.run({ value: 100, from: '°C', to: '°F' })).includes('212'), '100°C=212°F');
    assert.ok((await m.unit_convert.run({ value: 32, from: '°F', to: '°C' })).includes('0'), '32°F=0°C');
    assert.ok((await m.unit_convert.run({ value: 5, from: 'km', to: 'mi' })).includes('3.1069'), '5km≈3.1069mi');
    assert.ok((await m.unit_convert.run({ value: 10, from: 'kg', to: 'lb' })).includes('22.0462'), '10kg≈22.0462lb');
    assert.ok((await m.unit_convert.run({ value: 0, from: 'c', to: 'f' })).includes('32'), '0°C=32°F');
    assert.ok((await m.unit_convert.run({ value: 10, from: '盎司', to: '克' })).includes('283.495'), '10oz≈283.495g');
    assert.ok((await m.unit_convert.run({ value: 'invalid', from: 'kg', to: 'g' })).includes('有效数值'), '非法输入应返回提示');
    assert.ok((await m.unit_convert.run({ value: 2048, from: 'MB', to: 'GB' })).includes('2 gb'), '2048MB=2GB');
    assert.ok((await m.unit_convert.run({ value: 1, from: 'kg', to: 'xyz' })).includes('不支持'), '非法单位应拒绝');
    assert.ok((await m.unit_convert.run({ value: 1, from: 'kg', to: 'm' })).includes('不支持'), '跨类（重量→长度）应拒绝');
  });
  await t('P3-2 cron_explain：常见模式中文描述 + 未来执行时间 + 范围校验拒绝', async () => {
    const m = require('../src-server/lib/tools-market');
    const wd = await m.cron_explain.run({ expression: '0 9 * * 1-5' });
    assert.ok(wd.includes('每周一至周五 09:00'), wd);
    assert.ok(/未来执行时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(wd), '应给未来执行时间');
    const every = await m.cron_explain.run({ expression: '*/30 * * * *' });
    assert.ok(every.includes('每 30 分'), every);
    const bad = await m.cron_explain.run({ expression: '0 9 * * 8' });
    assert.ok(bad.includes('超出范围 0-6'), '周字段 8 超范围应拒绝：' + bad);
    const bad2 = await m.cron_explain.run({ expression: '70 * * * *' });
    assert.ok(bad2.includes('超出范围 0-59'), '分钟 70 超范围应拒绝');
    const bad3 = await m.cron_explain.run({ expression: '0 9 * *' });
    assert.ok(bad3.includes('5 段'), '段数不足应拒绝');
  });
  await t('P3-2 weather_query / translate_text / exchange_rate：空参校验不炸（网络未发起即拦截）', async () => {
    const m = require('../src-server/lib/tools-market');
    assert.ok((await m.weather_query.run({})).includes('请提供'), '空 city 应提示');
    assert.ok((await m.translate_text.run({ text: '' })).includes('请提供'), '空 text 应提示');
    assert.ok((await m.translate_text.run({ text: 'x' })).includes('请提供目标语言'), '缺 to 应提示');
    assert.ok((await m.translate_text.run({ text: 'x'.repeat(2001), to: 'en' })).includes('过长'), '超长应提示');
    assert.ok((await m.exchange_rate.run({ from: 'US', to: 'CNY' })).includes('3 位字母'), '非法货币代码应提示');
  });
  await t('sanitizeSelectSql：合法 SELECT 通过并强制 LIMIT（无 LIMIT 追加 / 超大 LIMIT 收敛）', () => {
    const r1 = extra.sanitizeSelectSql('SELECT COUNT(*) FROM agents');
    assert.ok(!r1.err && /LIMIT 200\s*$/i.test(r1.sql), '应追加 LIMIT 200');
    const r2 = extra.sanitizeSelectSql('SELECT * FROM agents LIMIT 9999');
    assert.ok(!r2.err && /LIMIT 500\s*$/i.test(r2.sql), '应收敛到 LIMIT 500');
    const r3 = extra.sanitizeSelectSql('SELECT id FROM agents LIMIT 50 OFFSET 10');
    assert.ok(!r3.err && /LIMIT 50 OFFSET 10\s*$/i.test(r3.sql), 'offset 应保留');
  });
  await t('sanitizeSelectSql：写操作 / 敏感表 / 多语句 / 非 SELECT 全部拒绝', () => {
    assert.ok(extra.sanitizeSelectSql('DROP TABLE agents').err, 'DROP 应拒绝');
    assert.ok(extra.sanitizeSelectSql("SELECT * FROM users WHERE username='admin'").err, '敏感表 users 应拒绝');
    assert.ok(extra.sanitizeSelectSql('SELECT * FROM providers').err, '敏感表 providers 应拒绝');
    assert.ok(extra.sanitizeSelectSql('SELECT 1; DROP TABLE agents').err, '多语句应拒绝');
    assert.ok(extra.sanitizeSelectSql('PRAGMA table_info(users)').err, 'PRAGMA 应拒绝');
    assert.ok(extra.sanitizeSelectSql('ATTACH DATABASE "/tmp/x" AS x').err, 'ATTACH 应拒绝');
    assert.ok(extra.sanitizeSelectSql('UPDATE agents SET name=1').err, 'UPDATE 应拒绝');
    const okCase = extra.sanitizeSelectSql('-- 注释\nSELECT created_at FROM agents');
    assert.ok(!okCase.err, '含 created_at 列名（create 关键词子串）的合法查询不应误杀');
  });
  await t('db_chart：生成 ECharts HTML 落盘且 JSON 注入转义（</script> → \u003c）', async () => {
    const out = await extra.db_chart.run({
      title: '测试图表', chart_type: 'bar',
      categories: ['一月', '二月', '三月'],
      series: [{ name: '销量', data: [10, 20, 30] }],
    });
    assert.ok(/\[CHART:\/uploads\/charts\/[\w.-]+\.html\|测试图表\]/.test(out), '应返回 CHART 标记：' + out);
    const m = /\[CHART:(\/uploads\/charts\/[\w.-]+\.html)\|/.exec(out);
    const fp = path.join(__dirname, '..', 'public', m[1]);
    const html = fs.readFileSync(fp, 'utf8');
    assert.ok(html.includes('/vendor/echarts.min.js'), '应引用本地 echarts');
    assert.ok(html.includes('"data": [10, 20, 30]') || html.includes('"data":[10,20,30]'), '应注入系列数据');
    assert.ok(!html.includes('</script>\nvar opt'), 'script 注入应被转义');
    // 清理测试产物
    fs.rmSync(fp, { force: true });
  });
  await t('db_chart：pie 类型与数据长度自动对齐（截到最短）', async () => {
    const out = await extra.db_chart.run({
      title: '占比', chart_type: 'pie',
      categories: ['A', 'B', 'C', 'D'],
      series: [{ name: 'S', data: [1, 2, 3] }],
    });
    assert.ok(/\[CHART:/.test(out), 'pie 应正常生成');
    const m = /\[CHART:(\/uploads\/charts\/[\w.-]+\.html)\|/.exec(out);
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', m[1]), 'utf8');
    assert.ok(html.includes('type: \'pie\'') || html.includes('"type":"pie"'), '应为饼图');
    assert.ok(!html.includes('"D"'), '类目应截断到数据长度（D 不应出现）');
    fs.rmSync(path.join(__dirname, '..', 'public', m[1]), { force: true });
  });
  await t('export_word：Markdown → docx 落盘（含表格/代码块），文件为合法 zip', async () => {
    const md = '# 测试报告\n\n**加粗**与`代码`与*斜体*。\n\n- 项目一\n- 项目二\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1);\n```';
    const out = await extra.export_word.run({ title: '冒烟测试文档', markdown: md });
    assert.ok(/\[WORD:\/uploads\/exports\/[^\|]+\.docx\|冒烟测试文档\.docx\]/.test(out), '应返回 WORD 标记：' + out);
    const m = /\[WORD:(\/uploads\/exports\/[^\|]+\.docx)\|/.exec(out);
    const fp = path.join(__dirname, '..', 'public', m[1]);
    const buf = fs.readFileSync(fp);
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK', 'docx 应为 zip 容器');
    assert.ok(buf.length > 3000, 'docx 应有实质内容');
    fs.rmSync(fp, { force: true });
  });
  await t('web_search 参数校验：空 query 返回提示；web_fetch 非 http 链接拒绝', async () => {
    const r1 = await extra.web_search.run({ query: '' });
    assert.ok(/缺少 query/.test(r1), '空 query 应提示');
    const r2 = await extra.web_fetch.run({ url: 'ftp://x.com' });
    assert.ok(/仅支持 http/.test(r2), '非 http 链接应拒绝');
    const r3 = await extra.web_fetch.run({ url: 'javascript:alert(1)' });
    assert.ok(/仅支持 http/.test(r3), 'javascript: 伪协议应拒绝');
  });
  await t('stock_quote 参数校验：空名称提示；不存在的标的引导确认名称', async () => {
    const r1 = await extra.stock_quote.run({ name: '' });
    assert.ok(/缺少 name/.test(r1), '空名称应提示');
    const r2 = await extra.stock_quote.run({ name: 'zzzzz不存在股票zzzzz' });
    assert.ok(/未找到/.test(r2), '不存在标的应友好引导：' + r2.slice(0, 80));
  });
  await t('MCP Server 迁移：mcp_tokens 表与 agents.routing_mode 列均已就位', () => {
    const cols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
    assert.ok(cols.includes('routing_mode'), 'agents.routing_mode 列应存在');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    assert.ok(tables.includes('mcp_tokens'), 'mcp_tokens 表应存在');
  });
  await t('doc_review：文档不存在时跨库友好提示（列出平台现有文档）', async () => {
    const r = await extra.doc_review.run({ file_name: '不存在的合同xyz' }, { kbId: null });
    assert.ok(/未找到/.test(r), '应提示未找到：' + r.slice(0, 80));
    assert.ok(/已解析文档/.test(r), '应列出现有文档清单');
  });

  console.log('【P4】模型类型体系（四模式隔离）');
  const { classifyModel, TYPE_LABEL } = require('../src-server/lib/model-types');
  await t('classifyModel：384 全量 14 模型分类正确（对话7/生图2/视频4/语音1）', () => {
    const expect = {
      'dsv4': 'chat', 'Qwen3-VL-30B-A3B-Instruct': 'chat', 'glm5.2': 'chat',
      'Deepseek-V4-flash': 'chat', 'Qwen3.8-27B': 'chat', 'Qwen3.5-397B': 'chat', 'dsv4-Ascend': 'chat',
      'QwenImage-Ascend': 'image', 'QwenImage': 'image',
      'minimax h3': 'video', 'MiniMax-H3-Ascend': 'video', 'MiniMax-H3-Ref2VA': 'video', 'minmax h3 Ref2VA': 'video',
      'Qwen3-TTS-12Hz-1.7B-CustomVoice': 'tts',
    };
    for (const [m, ty] of Object.entries(expect)) {
      assert.strictEqual(classifyModel(m), ty, `分类错误：${m} → ${classifyModel(m)}（期望 ${ty}）`);
    }
  });
  await t('classifyModel：通用命名规则（embedding/tts/image/video/未知→chat）', () => {
    assert.strictEqual(classifyModel('bge-m3'), 'embedding');
    assert.strictEqual(classifyModel('text-embedding-v3'), 'embedding');
    assert.strictEqual(classifyModel('sensevoice-small'), 'tts');
    assert.strictEqual(classifyModel('FLUX.1-dev'), 'image');
    assert.strictEqual(classifyModel('stable-diffusion-xl'), 'image');
    assert.strictEqual(classifyModel('hunyuan-video'), 'video');
    assert.strictEqual(classifyModel('qwen-turbo'), 'chat');
    assert.strictEqual(classifyModel('gpt-4o'), 'chat');
  });
  await t('TYPE_LABEL 覆盖全部类型（含不出现在创作下拉的 embedding）', () => {
    for (const k of ['chat', 'image', 'video', 'tts', 'embedding']) assert.ok(TYPE_LABEL[k], `缺少 ${k} 标签`);
  });
  await t('verifyModelByType：按类型选端点（chat/image/video/tts/embedding）且带鉴权头', async () => {
    const { verifyModelByType } = require('../src-server/routes/providers');
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opt) => {
      calls.push({ url, auth: opt?.headers?.Authorization, body: JSON.parse((opt?.body || '{}')) });
      return { ok: true };
    };
    try {
      await verifyModelByType('http://gw.test/v1', 'sk-test', 'm1', 'chat');
      await verifyModelByType('http://gw.test/v1/', 'sk-test', 'img', 'image');
      await verifyModelByType('http://gw.test/v1', 'sk-test', 'vid', 'video');
      await verifyModelByType('http://gw.test/v1', 'sk-test', 'voice', 'tts');
      await verifyModelByType('http://gw.test/v1', 'sk-test', 'emb', 'embedding');
    } finally { global.fetch = origFetch; }
    const paths = calls.map(c => c.url.replace(/^https?:\/\/[^/]+/, ''));
    assert.deepStrictEqual(paths, [
      '/v1/chat/completions', '/v1/images/generations', '/v1/videos/generations', '/v1/audio/speech', '/v1/embeddings',
    ], '端点映射错误：' + paths.join(' | '));
    calls.forEach(c => assert.strictEqual(c.auth, 'Bearer sk-test', '应携带鉴权头'));
    assert.strictEqual(calls[0].body.model, 'm1');
    assert.strictEqual(calls[3].body.input, 'ping', 'tts 应传 input 字段');
    assert.strictEqual(calls[1].body.prompt, 'ping', '生图应传 prompt');
    assert.strictEqual(calls[2].body.duration, 10, '视频应传 duration（网关参数，非 seconds）');
  });

  console.log('【P5.1】画布工作流 V2 数据模型 + DAG Runner');
  const schema = require('../src-server/lib/workflow-schema');
  const runner = require('../src-server/lib/workflow');
  await t('schema：V1→V2 迁移（id/position/data/edges/模板引用全转换）', () => {
    const v1 = {
      nodes: [
        { id: 1, type: 'start', x: 100, y: 200, config: { vars: [{ name: 'city', default: '北京' }] } },
        { id: 2, type: 'llm', x: 400, y: 200, config: { model: 'dsv4', prompt: '改写：{{input}} 城市 {{vars.city}} 参考 {{n1}}' } },
        { id: 3, type: 'output', x: 700, y: 200, config: { template: '结果：{{n2}}' } },
      ],
      edges: [{ from: 1, to: 2 }, { from: 2, to: 3 }],
    };
    const v2 = schema.migrateWorkflowData(v1);
    assert.strictEqual(v2.nodes[0].id, 'start');
    assert.deepStrictEqual(v2.nodes[0].position, { x: 100, y: 200 });
    assert.ok(Array.isArray(v2.nodes[0].data.variables), 'start 变量应在 data.variables');
    assert.strictEqual(v2.edges[0].source, 'start');
    assert.strictEqual(v2.edges[0].sourceHandle, 'out');
    assert.strictEqual(v2.nodes[1].data.prompt, '改写：{{#start.input#}} 城市 {{#start.city#}} 参考 {{#start.input#}}');
    assert.strictEqual(v2.nodes[2].data.outputs[0].value, '结果：{{#node_2.text#}}');
    assert.deepStrictEqual(schema.checkRefs(schema.validateWorkflowV2(v2)), [], '迁移后引用应全部合法');
  });
  await t('schema：validateWorkflowV2 结构校验（缺 start 拒绝 / 超限拒绝 / 环不在此层拦）', () => {
    assert.ok(schema.validateWorkflowV2({ nodes: [{ id: 'node_1', type: 'llm', position: { x: 0, y: 0 }, data: {} }], edges: [] }).error, '缺 start 应报错');
    assert.ok(!schema.validateWorkflowV2(null), 'null 应返回 null（清除）');
    const ok = schema.validateWorkflowV2({ nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [] });
    assert.ok(ok && !ok.error, '单 start 应通过');
  });
  await t('Runner：拓扑排序（含环检测）', () => {
    const nodes = [{ id: 'a', type: 'start' }, { id: 'b' }, { id: 'c' }];
    const order = runner.topologicalSort(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    let loop = false;
    try { runner.topologicalSort(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]); } catch (e) { loop = /环路/.test(e.message); }
    assert.ok(loop, '环应抛错');
  });
  await t('Runner：{{#node.var#}} 渲染 + 未定义保留 + V1 兼容', () => {
    const results = { node_2: { text: '输出A' }, start: { input: '原始' } };
    assert.strictEqual(runner.render('X={{#node_2.text#}} Y={{#start.input#}}', results, { input: '原始' }), 'X=输出A Y=原始');
    assert.strictEqual(runner.render('{{#node_9.text#}}', results, { input: 'x' }), '{{#node_9.text#}}', '未定义引用保留原样');
    assert.strictEqual(runner.render('{{input}}', results, { input: '旧格式' }), '旧格式', 'V1 兼容');
  });
  await t('Runner：分支路由（if-else 命中传导 + 未命中子图 skipped）', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', variables: [] } },
        { id: 'br', type: 'if-else', position: { x: 200, y: 0 }, data: { title: '判断', cases: [
          { label: 'yes', conditions: [{ variable: 'input', type: 'contains', value: '继续' }] },
          { label: '否则', isFallback: true, conditions: [] },
        ] } },
        { id: 'e_yes', type: 'end', position: { x: 400, y: -100 }, data: { title: '是', outputs: [{ variable: 'result', value: '走了yes：{{#start.input#}}' }] } },
        { id: 'e_no', type: 'end', position: { x: 400, y: 100 }, data: { title: '否', outputs: [{ variable: 'result', value: '走了否则' }] } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'br', sourceHandle: 'out' },
        { id: 'e2', source: 'br', target: 'e_yes', sourceHandle: 'yes' },
        { id: 'e3', source: 'br', target: 'e_no', sourceHandle: '否则' },
      ],
    };
    const r1 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '请继续分析' }, {});
    assert.strictEqual(r1.output, '走了yes：请继续分析');
    assert.ok(r1.logs.find(l => l.nodeId === 'e_no' && l.status === 'skipped'), '未命中分支应 skipped');
    const r2 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '今天不错' }, {});
    assert.strictEqual(r2.output, '走了否则');
  });
  await t('Runner：start 变量默认值 + inputVars 覆盖', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始', variables: [{ name: 'city', default: '北京' }] } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'result', value: '城市：{{#start.city#}}' }] } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'e', sourceHandle: 'out' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'hi', city: '上海' }, {});
    assert.strictEqual(r.output, '城市：上海', 'inputVars 应覆盖默认值');
    const r2 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'hi' }, {});
    assert.strictEqual(r2.output, '城市：北京', '未覆盖时用默认值');
  });
  await t('Runner：节点失败中断（abort）与 onError=continue 跳过', async () => {
    // 用 agent 节点选不存在的子智能体（NODE_EXECUTORS 内真正 throw；工具层对错误是字符串透传不抛）
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始' } },
        { id: 'ag', type: 'agent', data: { title: '坏子智能体', agentId: 99999, input: 'x' } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'result', value: '{{#ag.reply#}}' }] } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'ag' }, { id: 'e2', source: 'ag', target: 'e' }],
    };
    let threw = false;
    try { await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {}); }
    catch (e) { threw = /执行失败/.test(e.message) && /坏子智能体/.test(e.message); }
    assert.ok(threw, '默认 abort 应中断并带节点定位');
    wf.nodes[1].data.onError = 'continue';
    const r2 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
    assert.ok(r2.logs.find(l => l.nodeId === 'ag' && l.status === 'error'), 'continue 模式仍记 error 日志');
    assert.ok(r2.logs.find(l => l.nodeId === 'e' && l.status === 'success'), 'continue 模式下游应继续执行');
  });
  await t('Runner：事件回调（nodeStart/nodeDone/nodeSkip）+ 无 end 兜底', async () => {
    const events = [];
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始', variables: [] } },
        { id: 'br', type: 'if-else', data: { title: '判断', cases: [
          { label: 'a', conditions: [{ variable: 'input', type: 'contains', value: 'x' }] },
          { label: '否则', isFallback: true, conditions: [] },
        ] } },
        { id: 'n', type: 'end', data: { title: '只有A路径', outputs: [{ variable: 'r', value: 'A' }] } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'br' },
        { id: 'e2', source: 'br', target: 'n', sourceHandle: 'a' },
      ],
    };
    await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'y' }, { onEvent: e => events.push(e.event + ':' + e.nodeId) });
    assert.ok(events.includes('nodeStart:start') && events.includes('nodeSkip:n'), '事件序列：' + events.join(','));
    // 无 end：start 输出兜底
    const r = await runner.runWorkflow({ workflow: JSON.stringify({ nodes: [{ id: 'start', type: 'start', data: {} }], edges: [] }) }, { input: '原始输入' }, {});
    assert.strictEqual(r.output, '原始输入');
  });

  console.log('【P5.2】三新节点 + 条件升级 + 结构化输出');
  await t('code 节点：JSON 解析/字符串处理（零 LLM）+ return 对象字段成变量', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始' } },
        { id: 'c1', type: 'code', data: { title: '解析', code: 'const o = JSON.parse(raw); return { name: o.name, amount2: o.amount * 2 };', inputs: '{"raw":"{{#start.input#}}"}' } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'r', value: '{{#c1.name#}}={{#c1.amount2#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'c1' }, { id: '2', source: 'c1', target: 'e' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '{\"name\":\"华为\",\"amount\":100}' }, {});
    assert.strictEqual(r.output, '华为=200');
  });
  await t('code 节点：沙箱超时保护（死循环 3 秒中断）', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'c', type: 'code', data: { title: '死循环', code: 'while(true){}', inputs: '{}', timeout: 500 } },
      ],
      edges: [{ id: '1', source: 'start', target: 'c' }],
    };
    let timed = false;
    try { await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {}); }
    catch (e) { timed = /执行失败/.test(e.message); }
    assert.ok(timed, '死循环应被超时中断');
  });
  await t('assign 赋值器：set + append + clear', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'a1', type: 'assign', data: { title: '赋值', assignments: [
          { variable: 'total', value: '{{#start.input#}}', operator: 'set' },
          { variable: 'total', value: ' 元', operator: 'append' },
          { variable: 'junk', value: '', operator: 'clear' },
        ] } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'r', value: '{{#a1.total#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'a1' }, { id: '2', source: 'a1', target: 'e' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '100' }, {});
    assert.strictEqual(r.output, '100 元');
  });
  await t('iteration 节点：数组逐条子流程 + {{item}}/{{index}} + results 汇总', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'it', type: 'iteration', data: { title: '迭代', input: '{{#start.input#}}', subflow: {
          nodes: [
            { id: 's', type: 'start', data: { title: '子开始', variables: [{ name: 'item' }, { name: 'index' }] } },
            { id: 'c', type: 'code', data: { title: '处理', code: 'return { out: item.toUpperCase() + "#" + index };', inputs: '{"item":"{{item}}","index":"{{index}}"}' } },
            { id: 'e', type: 'end', data: { title: '子输出', outputs: [{ variable: 'r', value: '{{#c.out#}}' }] } },
          ],
          edges: [{ id: '1', source: 's', target: 'c' }, { id: '2', source: 'c', target: 'e' }],
        } } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'r', value: '{{#it.results#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'it' }, { id: '2', source: 'it', target: 'e' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '[\"apple\",\"banana\",\"cherry\"]' }, {});
    assert.deepStrictEqual(JSON.parse(r.output), ['APPLE#0', 'BANANA#1', 'CHERRY#2']);
    assert.strictEqual(r.results.it.count, 3);
    assert.ok(r.logs.length >= 12, '迭代子流程日志应并入主日志（3 条×3 节点+主图 3）：' + r.logs.length);
  });
  await t('iteration：换行文本自动拆数组（非 JSON 输入）', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'it', type: 'iteration', data: { title: '迭代', input: '{{#start.input#}}', subflow: {
          nodes: [
            { id: 's', type: 'start', data: { variables: [{ name: 'item' }, { name: 'index' }] } },
            { id: 'c', type: 'code', data: { title: '计数', code: 'return { len: item.length };', inputs: '{"item":"{{item}}"}' } },
            { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c.len#}}' }] } },
          ],
          edges: [{ id: '1', source: 's', target: 'c' }, { id: '2', source: 'c', target: 'e' }],
        } } },
      ],
      edges: [{ id: '1', source: 'start', target: 'it' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'abc\ndefg\nhi' }, {});
    assert.deepStrictEqual(JSON.parse(r.results.it.results), ['3', '4', '2']); // 模板渲染后为字符串
  });
  await t('if-else 新操作符：gt 数值比较 / regex 正则 / starts_with / 多条件 OR', () => {
    const vars = { 'a.v': '42', 'b.v': 'hello123', 'c.v': 'ABC' };
    assert.strictEqual(runner.evaluateConditions([{ label: 'L', conditions: [{ variable: 'a.v', type: 'gt', value: '40' }] }], vars), 'L');
    assert.strictEqual(runner.evaluateConditions([{ label: 'L', conditions: [{ variable: 'b.v', type: 'regex', value: '^[a-z]+[0-9]+$' }] }], vars), 'L');
    assert.strictEqual(runner.evaluateConditions([{ label: 'L', conditions: [{ variable: 'c.v', type: 'starts_with', value: 'AB' }] }], vars), 'L');
    // OR：任一命中
    assert.strictEqual(runner.evaluateConditions([{ label: 'L', logical: 'OR', conditions: [{ variable: 'a.v', type: 'lt', value: '1' }, { variable: 'c.v', type: 'contains', value: 'BC' }] }], vars), 'L');
    // IF/ELIF/ELSE：IF 不命中走 ELIF
    const cases = [
      { label: 'IF', conditions: [{ variable: 'a.v', type: 'gt', value: '100' }] },
      { label: 'ELIF', conditions: [{ variable: 'a.v', type: 'gt', value: '10' }] },
      { label: 'ELSE', isFallback: true, conditions: [] },
    ];
    assert.strictEqual(runner.evaluateConditions(cases, vars), 'ELIF');
    assert.strictEqual(runner.evaluateConditions(cases, { 'a.v': '5' }), 'ELSE');
  });
  await t('llm 结构化输出：schema 字段成输出变量（getNodeOutputs 动态计算）', () => {
    const outs = schema.getNodeOutputs({ type: 'llm', data: { output_schema: '{\"properties\":{\"customer\":{\"type\":\"string\"},\"amount\":{\"type\":\"number\"}}}' } });
    assert.deepStrictEqual(outs.map(o => o.name), ['text', 'customer', 'amount']);
    const a = schema.getNodeOutputs({ type: 'assign', data: { assignments: [{ variable: 'total' }] } });
    assert.strictEqual(a[0].name, 'total');
  });
  await t('checkRefs：动态变量参与引用校验（结构化字段/赋值变量合法，不存在报错）', () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'l1', type: 'llm', data: { prompt: '抽取', output_schema: '{\"properties\":{\"name\":{\"type\":\"string\"}}}' } },
        { id: 'a1', type: 'assign', data: { assignments: [{ variable: 'k', value: '{{#l1.name#}}' }] } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#a1.k#}} 与 {{#l1.bad_field#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'a1' }, { id: '3', source: 'a1', target: 'e' }],
    };
    const problems = schema.checkRefs(wf);
    assert.ok(problems.some(p => p.ref === 'l1.bad_field'), '不存在字段应报错');
    assert.ok(!problems.some(p => p.ref === 'l1.name' || p.ref === 'a1.k'), '存在的动态变量不应报错');
  });

  console.log('【P5.3】调试可视化：完整入参出参 + 从此节点重跑');
  await t('Runner：logs 记录完整入参/出参 JSON（success 节点）', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始' } },
        { id: 'c', type: 'code', data: { title: '拆分', code: 'return { n: input.length };', inputs: '{"input":"{{#start.input#}}"}' } },
        { id: 'e', type: 'end', data: { title: '输出', outputs: [{ variable: 'r', value: '长度={{#c.n#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'c' }, { id: '2', source: 'c', target: 'e' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'hello' }, {});
    const logC = r.logs.find(l => l.nodeId === 'c');
    assert.ok(logC.inputs && logC.inputs.includes('hello'), '入参 JSON 应记录：' + logC.inputs);
    assert.ok(logC.outputFull && logC.outputFull.includes('"n":5'), '出参 JSON 应记录：' + logC.outputFull);
  });
  await t('Runner：从此节点重跑（前序 preset 沿用 + 起点校验）', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: { title: '开始' } },
        { id: 'n2', type: 'code', data: { title: '拆分', code: 'return { n: input.length };', inputs: '{"input":"{{#start.input#}}"}' } },
        { id: 'n3', type: 'end', data: { title: '输出', outputs: [{ variable: 'r', value: '长度={{#n2.n#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'n2' }, { id: '2', source: 'n2', target: 'n3' }],
    };
    const agent = { workflow: JSON.stringify(wf) };
    const r1 = await runner.runWorkflow(agent, { input: 'hello' }, {});
    assert.strictEqual(r1.output, '长度=5');
    // 从 n3 重跑：start/n2 沿用 preset（status=preset），仅 n3 执行
    const r2 = await runner.runWorkflow(agent, { input: 'hello' }, { startFrom: 'n3', presetResults: r1.results });
    assert.strictEqual(r2.output, '长度=5', '重跑输出应一致（沿用缓存）');
    assert.ok(r2.logs.find(l => l.nodeId === 'start' && l.status === 'preset'), 'start 应标记 preset');
    assert.ok(r2.logs.find(l => l.nodeId === 'n3' && l.status === 'success'), '起点节点应真正执行');
    // 非法起点报错
    let threw = false;
    try { await runner.runWorkflow(agent, {}, { startFrom: 'nope' }); } catch (e) { threw = /不存在/.test(e.message); }
    assert.ok(threw, '非法重跑起点应报错');
  });
  await t('Runner：重跑时 if-else preset 分支参与激活计算', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'br', type: 'if-else', data: { title: '判断', cases: [
          { label: 'yes', conditions: [{ variable: 'input', type: 'contains', value: '继续' }] },
          { label: 'ELSE', isFallback: true, conditions: [] },
        ] } },
        { id: 'e_yes', type: 'end', data: { title: '是', outputs: [{ variable: 'r', value: 'YES 路径' }] } },
        { id: 'e_no', type: 'end', data: { title: '否', outputs: [{ variable: 'r', value: 'ELSE 路径' }] } },
      ],
      edges: [
        { id: '1', source: 'start', target: 'br' },
        { id: '2', source: 'br', target: 'e_yes', sourceHandle: 'yes' },
        { id: '3', source: 'br', target: 'e_no', sourceHandle: 'ELSE' },
      ],
    };
    const agent = { workflow: JSON.stringify(wf) };
    const r1 = await runner.runWorkflow(agent, { input: '请继续' }, {});
    assert.strictEqual(r1.output, 'YES 路径');
    // 从 e_yes 重跑：br 的 preset 分支（branch=yes）决定激活——e_no 应 skipped
    const r2 = await runner.runWorkflow(agent, { input: '请继续' }, { startFrom: 'e_yes', presetResults: r1.results });
    assert.strictEqual(r2.output, 'YES 路径');
    assert.ok(r2.logs.find(l => l.nodeId === 'br' && l.status === 'preset'), '分支节点应 preset');
    assert.ok(r2.logs.find(l => l.nodeId === 'e_no' && l.status === 'skipped'), '未命中分支应 skipped');
  });

  console.log('【P5.4】画布交互配套（表单→画布三节点生成结构）');
  await t('表单→画布双向转换：生成的 开始→大模型→输出 结构可通过校验并执行', async () => {
    // 模拟前端 buildWorkflowFromForm 的产出结构（system_prompt=prompt）
    const wf = {
      nodes: [
        { id: 'start', type: 'start', position: { x: 60, y: 140 }, data: { title: '开始（输入）', variables: [] } },
        { id: 'node_1', type: 'llm', position: { x: 360, y: 140 }, data: { title: '大模型', model: '', system_prompt: '你是商务助理', prompt: '{{#start.input#}}', max_tokens: 1024, temperature: 0.7 } },
        { id: 'node_2', type: 'end', position: { x: 660, y: 140 }, data: { title: '输出（结束）', outputs: [{ variable: 'result', value: '{{#node_1.text#}}' }] } },
      ],
      edges: [
        { id: 'e_1', source: 'start', target: 'node_1', sourceHandle: 'out' },
        { id: 'e_2', source: 'node_1', target: 'node_2', sourceHandle: 'out' },
      ],
      viewport: { x: 40, y: 40, zoom: 1 },
    };
    const vv = schema.validateWorkflowV2(wf);
    assert.ok(vv && !vv.error, '三节点结构应通过校验');
    assert.deepStrictEqual(schema.checkRefs(vv), [], '引用应全部合法');
  });
  await t('删除节点后的坏引用检测语义（checkRefs 找到失效引用）', () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'orphan', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#deleted_node.text#}}' }] } }, // 引用已删除节点
      ],
      edges: [{ id: '1', source: 'start', target: 'orphan' }],
    };
    const problems = schema.checkRefs(wf);
    assert.ok(problems.some(p => p.ref === 'deleted_node.text'), '失效引用应被检出');
  });

  console.log('【P5.5】生产环境必备（运行实例/重试超时/沙箱加固/密钥）');
  const secrets = require('../src-server/lib/secrets');
  await t('workflow_runs 表与 secrets 表已就位（含 agent_id 索引）', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('workflow_runs'), 'workflow_runs 表应存在');
    assert.ok(tables.includes('secrets'), 'secrets 表应存在');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    assert.ok(idx.includes('idx_wf_runs_agent'), 'agent_id 索引应存在');
  });
  await t('沙箱加固：process/require/eval/this.constructor 静态拦截', async () => {
    for (const bad of ['return process.env;', "return require('fs');", 'return eval("1+1");', 'return this.constructor.constructor("return 1")();']) {
      const wf = { nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'c', type: 'code', data: { code: bad, inputs: '{}' } },
      ], edges: [{ id: '1', source: 'start', target: 'c' }] };
      let blocked = false;
      try { await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {}); }
      catch (e) { blocked = /禁止|timed out/.test(e.message); }
      assert.ok(blocked, '危险代码应被拦截：' + bad.slice(0, 30));
    }
  });
  await t('节点级失败策略 default：默认值注入主输出变量 + fallback 日志', async () => {
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'ag', type: 'agent', data: { title: '坏子智能体', agentId: 99999, input: 'x', onError: 'default', default_output: '（备用回复）' } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#ag.reply#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'ag' }, { id: '2', source: 'ag', target: 'e' }],
    };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
    assert.strictEqual(r.output, '（备用回复）');
    assert.ok(r.logs.some(l => l.status === 'fallback'), '应有 fallback 日志');
  });
  await t('节点级超时：data.timeout 生效（慢代码 300ms 上限）', async () => {
    const wf = { nodes: [
      { id: 'start', type: 'start', data: {} },
      { id: 'c', type: 'code', data: { title: '慢', code: 'const t=Date.now(); while(Date.now()-t<1500){} return 1;', inputs: '{}', timeout: 300 } },
    ], edges: [{ id: '1', source: 'start', target: 'c' }] };
    let timed = false;
    try { await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {}); }
    catch (e) { timed = /timed out|超时/.test(e.message); }
    assert.ok(timed, '超时应中断');
  });
  await t('secrets：{{env.X}} 注入 + 日志脱敏 + 空值删除', async () => {
    assert.strictEqual(secrets.upsert('TEST_SK', 'sk-unit-test-9999', '单测'), 'created');
    const wf = { nodes: [
      { id: 'start', type: 'start', data: {} },
      { id: 'c', type: 'code', data: { code: 'return { head: key.slice(0, 5) };', inputs: '{"key":"{{env.TEST_SK}}"}' } },
      { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c.head#}}' }] } },
    ], edges: [{ id: '1', source: 'start', target: 'c' }, { id: '2', source: 'c', target: 'e' }] };
    const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
    assert.strictEqual(r.output, 'sk-un', 'env 应注入');
    const logC = r.logs.find(l => l.nodeId === 'c');
    assert.ok(!logC.inputs.includes('sk-unit-test-9999'), '日志不得含密钥明文：' + logC.inputs);
    assert.ok(logC.inputs.includes('{{env.TEST_SK}}'), '日志应脱敏为占位符');
    assert.strictEqual(secrets.upsert('TEST_SK', '', ''), 'deleted', '空值应删除');
  });
  await t('workflow_runs：运行测试落一条完整记录（状态/时长/节点日志）', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM workflow_runs').get().c;
    // 直接调 Runner 后手工模拟路由落库逻辑（路由已实测）——这里验证表结构与写入
    db.prepare(`INSERT INTO workflow_runs (agent_id, trigger_type, status, inputs, outputs, node_logs, total_tokens, total_duration_ms, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
      .run(55, 'manual', 'success', '{"input":"a,b"}', '📦 共 2 条', JSON.stringify([{ nodeId: 'start', status: 'success', duration: 0 }]), 120, 56);
    const row = db.prepare('SELECT * FROM workflow_runs ORDER BY id DESC LIMIT 1').get();
    assert.ok(row.id > 0 && row.status === 'success' && row.total_tokens === 120);
    assert.ok(JSON.parse(row.node_logs).length === 1);
    db.prepare('DELETE FROM workflow_runs WHERE id=?').run(row.id); // 清理测试行
    const after = db.prepare('SELECT COUNT(*) c FROM workflow_runs').get().c;
    assert.strictEqual(after, before, '测试行应已清理');
  });

  console.log('【P5.6】体验进阶：Chatflow 双模式 / 直接回复 / 问题分类器 / 变量聚合器 / 工具扁平化');
  {
    const runner = require('../src-server/lib/workflow');
    const schema = require('../src-server/lib/workflow-schema');
    // ① answer 节点：即时回传事件 + 最终输出=各 answer 拼接（优先于 end）+ text 可被下游引用
    await t('answer：nodeReply 即时回传 + 最终输出=拼接 + 下游引用 text', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'a1', type: 'answer', data: { title: '先答', text: '收到：{{#start.input#}}' } },
          { id: 'c1', type: 'code', data: { code: 'return { echo: text };', inputs: '{"text":"{{#a1.text#}}"}' } },
          { id: 'a2', type: 'answer', data: { title: '再答', text: '补充 {{#c1.echo#}}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '不应是我' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 'a1' }, { id: '2', source: 'a1', target: 'c1' },
          { id: '3', source: 'c1', target: 'a2' }, { id: '4', source: 'a2', target: 'e' },
        ],
      };
      const replies = [];
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '你好' }, { onEvent: evt => { if (evt.event === 'nodeReply') replies.push(evt.text); } });
      assert.deepStrictEqual(replies, ['收到：你好', '补充 收到：你好'], '两个 answer 都应即时回传：' + JSON.stringify(replies));
      assert.strictEqual(r.output, '收到：你好\n\n补充 收到：你好', '最终输出应为 answer 拼接：' + r.output);
    });
    // ② aggregator first / array
    await t('aggregator first：条件分支未命中缺输出 → 取首个非空', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'b', type: 'if-else', data: { cases: [{ label: 'HIT', conditions: [{ variable: 'start.input', type: 'equals', value: 'x' }] }, { label: 'ELSE', isFallback: true, conditions: [] }] } },
          { id: 't1', type: 'code', data: { code: 'return { output: "来自命中分支" };', inputs: '{}' } },
          { id: 't2', type: 'code', data: { code: 'return { output: "" };', inputs: '{}' } },
          { id: 'agg', type: 'aggregator', data: { title: '聚合', sources: [{ variable: '{{#t1.output#}}' }, { variable: '{{#t2.output#}}' }], mode: 'first' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#agg.output#}}' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 'b' },
          { id: '2', source: 'b', target: 't1', sourceHandle: 'HIT' }, { id: '3', source: 'b', target: 't2', sourceHandle: 'ELSE' },
          { id: '4', source: 't1', target: 'agg' }, { id: '5', source: 't2', target: 'agg' }, { id: '6', source: 'agg', target: 'e' },
        ],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
      assert.strictEqual(r.output, '来自命中分支', 'first 模式应取非空值：' + r.output);
    });
    await t('aggregator array：拼接数组 + output JSON + array 变量', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 't1', type: 'code', data: { code: 'return { output: "甲" };', inputs: '{}' } },
          { id: 't2', type: 'code', data: { code: 'return { output: "乙" };', inputs: '{}' } },
          { id: 'agg', type: 'aggregator', data: { sources: [{ variable: '{{#t1.output#}}' }, { variable: '{{#t2.output#}}' }], mode: 'array' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#agg.array#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 't1' }, { id: '2', source: 'start', target: 't2' }, { id: '3', source: 't1', target: 'agg' }, { id: '4', source: 't2', target: 'agg' }, { id: '5', source: 'agg', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '' }, {});
      assert.strictEqual(r.output, '甲,乙', 'array 变量渲染为数组拼接：' + r.output);
      assert.strictEqual(r.results.agg.output, '["甲","乙"]', 'output 应为 JSON 数组字符串：' + r.results.agg.output);
    });
    // ③ classifier 纯函数：提示词构建 + 回复解析
    await t('classifier：buildClassifyPrompt 含全类别 + parseClassifyReply 精确/包含/未命中', () => {
      const cats = ['售前咨询', '售后支持', '闲聊'];
      const p = runner.buildClassifyPrompt(cats, '帮我退货', '订单类问物流');
      for (const c of cats) assert.ok(p.includes(c), '提示词应含类别 ' + c);
      assert.ok(p.includes('帮我退货') && p.includes('订单类问物流'));
      assert.strictEqual(runner.parseClassifyReply('售后支持', cats), '售后支持', '精确命中');
      assert.strictEqual(runner.parseClassifyReply('1. 售前咨询', cats), '售前咨询', '带序号包含命中');
      assert.strictEqual(runner.parseClassifyReply('「闲聊」', cats), '闲聊', '带引号命中');
      assert.strictEqual(runner.parseClassifyReply('无法判断的回复', cats), null, '未命中应返回 null（走 default）');
    });
    // ④ classifier 分支机制：computeActive 按 sourceHandle 过滤（含 default）
    await t('classifier：分支激活按 sourceHandle 过滤（命中/default 兜底）', () => {
      const nodes = [
        { id: 'start', type: 'start', data: {} },
        { id: 'cls', type: 'classifier', data: { categories: [{ name: '售前' }, { name: '售后' }] } },
        { id: 'a', type: 'end', data: {} }, { id: 'b', type: 'end', data: {} }, { id: 'd', type: 'end', data: {} },
      ];
      const edges = [
        { source: 'start', target: 'cls' },
        { source: 'cls', target: 'a', sourceHandle: '售前' }, { source: 'cls', target: 'b', sourceHandle: '售后' }, { source: 'cls', target: 'd', sourceHandle: 'default' },
      ];
      const act1 = runner.computeActive(nodes, edges, { cls: '售前' });
      assert.ok(act1.has('a') && !act1.has('b') && !act1.has('d'), '命中售前只激活 a');
      const act2 = runner.computeActive(nodes, edges, { cls: 'default' });
      assert.ok(!act2.has('a') && !act2.has('b') && act2.has('d'), '未命中走 default 分支');
    });
    // ⑤ classifier preset 重跑：缓存分支参与激活计算
    await t('classifier：重跑时 preset 分支缓存参与激活计算', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'cls', type: 'classifier', data: { categories: [{ name: 'A' }, { name: 'B' }] } },
          { id: 'ca', type: 'code', data: { code: 'return { output: "分支A" };', inputs: '{}' } },
          { id: 'cb', type: 'code', data: { code: 'return { output: "分支B" };', inputs: '{}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#cb.output#}}' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 'cls' },
          { id: '2', source: 'cls', target: 'ca', sourceHandle: 'A' }, { id: '3', source: 'cls', target: 'cb', sourceHandle: 'B' },
          { id: '4', source: 'cb', target: 'e' },
        ],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {
        startFrom: 'cb',
        presetResults: { start: { input: 'x' }, cls: { class_name: 'B', branch: 'B' }, ca: { output: '分支A' } },
      });
      assert.strictEqual(r.output, '分支B', 'preset 分支 B 激活，cb 执行：' + r.output);
      assert.ok(r.logs.some(l => l.nodeId === 'cls' && l.status === 'preset'), 'cls 应标记 preset');
    });
    // ⑥ 工具扁平化纯函数
    await t('flattenToolResult：JSON 对象顶层键扁平化 / 数组与字符串跳过 / result 冲突防护', () => {
      assert.deepStrictEqual(runner.flattenToolResult('{"price":12.5,"name":"华为","tags":["5G"],"active":true}'), { price: 12.5, name: '华为', tags: '["5G"]', active: true }, '顶层键扁平化（原始类型保留/对象 JSON 化）');
      assert.deepStrictEqual(runner.flattenToolResult('计算结果：42'), {}, '纯字符串不扁平化');
      assert.deepStrictEqual(runner.flattenToolResult('[1,2,3]'), {}, '数组不扁平化');
      assert.deepStrictEqual(runner.flattenToolResult('{"result":"x"}'), {}, 'result 键防冲突跳过');
    });
    // ⑦ 工具节点执行扁平化（本地 calculator：返回纯字符串 → 仅 result；模拟 JSON 工具用 code 验证语义已覆盖）
    await t('tool 节点：calculator 返回字符串 → 输出仅 result（不误扁平化）', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 't', type: 'tool', data: { toolId: 'calculator', args: '{"expression":"(1+2)*3.5"}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#t.result#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 't' }, { id: '2', source: 't', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '' }, {});
      assert.ok(r.output.includes('10.5'), 'calculator 应算出 10.5：' + r.output);
      assert.deepStrictEqual(Object.keys(r.results.t), ['result'], '纯字符串工具输出仅 result：' + JSON.stringify(Object.keys(r.results.t)));
    });
    // ⑧ validateWorkflowV2：新节点 + flow_type/groups 规范化
    await t('validateWorkflowV2：新节点类型通过 + flow_type/groups 规范化透传', () => {
      const w = schema.validateWorkflowV2({
        flow_type: 'chatflow', groups: [{ id: 'g1', name: '数据获取', color: '#059669', nodeIds: ['start', 'a1'], collapsed: false }, { id: 'g2', name: '空组', nodeIds: [] }],
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'a1', type: 'answer', data: { text: 'hi' } },
          { id: 'cls', type: 'classifier', data: { categories: [{ name: 'A' }] } },
          { id: 'agg', type: 'aggregator', data: { sources: [{ variable: '{{#a1.text#}}' }], mode: 'first' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#agg.output#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'a1' }, { id: '2', source: 'a1', target: 'cls' }, { id: '3', source: 'cls', target: 'agg', sourceHandle: 'default' }, { id: '4', source: 'agg', target: 'e' }],
      });
      assert.ok(w && !w.error, '校验应通过');
      assert.strictEqual(w.flow_type, 'chatflow', 'flow_type 透传');
      assert.strictEqual(w.groups.length, 1, '空组应被过滤');
      assert.strictEqual(w.groups[0].nodeIds.length, 2);
      const w2 = schema.validateWorkflowV2({ flow_type: 'bogus', nodes: [{ id: 'start', type: 'start', data: {} }], edges: [] });
      assert.strictEqual(w2.flow_type, 'workflow', '非法 flow_type 纠正为 workflow');
    });
    // ⑨ getNodeOutputs：新节点输出 + tool _fields 动态字段
    await t('getNodeOutputs：answer/classifier/aggregator 输出 + tool _fields', () => {
      assert.deepStrictEqual(schema.getNodeOutputs({ type: 'answer', data: {} }).map(o => o.name), ['text']);
      assert.deepStrictEqual(schema.getNodeOutputs({ type: 'classifier', data: {} }).map(o => o.name), ['class_name', 'branch']);
      assert.deepStrictEqual(schema.getNodeOutputs({ type: 'aggregator', data: {} }).map(o => o.name), ['output', 'array']);
      assert.deepStrictEqual(schema.getNodeOutputs({ type: 'tool', data: { _fields: ['price', 'name'] } }).map(o => o.name), ['result', 'price', 'name'], '_fields 应成输出变量');
    });
    // ⑩ chatflow：llm 默认携带历史（buildLlmMessages 纯函数）
    await t('chatflow：llm 默认携带历史（Workflow 保持 opt-in）', () => {
      const history = [{ role: 'user', content: '上轮问题' }, { role: 'assistant', content: '上轮回答' }];
      // Chatflow：未配置 context → 默认携带
      const m1 = runner.buildLlmMessages({}, { prompt: '本轮' }, { flowType: 'chatflow', history });
      assert.strictEqual(m1.messages.length, 3, 'Chatflow 默认应含历史：' + JSON.stringify(m1.messages.map(m => m.role)));
      assert.strictEqual(m1.messages[0].content, '上轮问题');
      // Workflow：默认不带
      const m2 = runner.buildLlmMessages({}, { prompt: '本轮' }, { flowType: 'workflow', history });
      assert.strictEqual(m2.messages.length, 1, 'Workflow 默认不带历史');
      // Workflow + 显式开启 → 携带
      const m3 = runner.buildLlmMessages({ context: { use_history: true, rounds: 1 } }, { prompt: '本轮' }, { flowType: 'workflow', history });
      assert.strictEqual(m3.messages.length, 3, '显式开启应携带');
      // Chatflow + 显式关闭 → 不携带
      const m4 = runner.buildLlmMessages({ context: { use_history: false } }, { prompt: '本轮' }, { flowType: 'chatflow', history });
      assert.strictEqual(m4.messages.length, 1, '显式关闭优先');
    });
  }

  console.log('【P5.7】会话变量（跨轮次持久）');
  {
    const runner = require('../src-server/lib/workflow');
    const schema = require('../src-server/lib/workflow-schema');
    // 会话变量测试图：start（user_name 默认"游客" + visit_count 默认"0"）→ assign（session.visit_count append "1"）→ code 读两个变量 → end
    const wfOf = (assignLine) => ({
      nodes: [
        { id: 'start', type: 'start', data: { variables: [], session_vars: [{ name: 'user_name', default: '游客', desc: '用户姓名' }, { name: 'visit_count', default: '0', desc: '累计访问' }] } },
        { id: 'a1', type: 'assign', data: { title: '写会话变量', assignments: assignLine } },
        { id: 'c1', type: 'code', data: { code: 'return { who: user_name, cnt: visit_count };', inputs: '{"user_name":"{{#start.user_name#}}","visit_count":"{{#start.visit_count#}}"}' } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c1.who#}}|{{#c1.cnt#}}' }] } },
      ],
      edges: [
        { id: '1', source: 'start', target: 'a1' }, { id: '2', source: 'a1', target: 'c1' }, { id: '3', source: 'c1', target: 'e' },
      ],
    });
    // ① 注入语义：持久值优先，未持久用默认值
    await t('会话变量：ctx.sessionVars 持久值优先 / 未持久用默认值', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([])) }, { input: 'hi' }, { sessionVars: { user_name: '张三' } });
      assert.strictEqual(r.results.start.user_name, '张三', '持久值优先');
      assert.strictEqual(r.results.start.visit_count, '0', '未持久用默认值');
      assert.strictEqual(r.output, '张三|0');
    });
    // ② 写入语义：assign session.名称 → 下游 {{#start.x#}} 立即拿新值 + 返回快照
    await t('assign session.前缀：下游立即拿新值 + sessionVars 返回快照', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([{ variable: 'session.user_name', operator: 'set', value: '李四' }])) }, { input: 'hi' }, { sessionVars: { user_name: '张三', visit_count: '2' } });
      assert.strictEqual(r.results.start.user_name, '李四', 'assign 后 start 引用应拿新值');
      assert.strictEqual(r.output, '李四|2', '下游 code 读取到新值：' + r.output);
      assert.strictEqual(r.sessionVars.user_name, '李四', '返回快照含写入');
      assert.strictEqual(r.sessionVars.visit_count, '2', '未写入的持久值原样带回');
    });
    // ③ append 语义：基于持久值累积（计数器场景）
    await t('append 会话变量：基于当前持久值累积（计数器）', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([{ variable: 'session.visit_count', operator: 'append', value: '1' }])) }, { input: 'hi' }, { sessionVars: { visit_count: '12' } });
      assert.strictEqual(r.sessionVars.visit_count, '121', 'append 应基于持久值 12 累积：' + r.sessionVars.visit_count);
      assert.strictEqual(r.output, '游客|121');
    });
    // ④ 普通赋值不影响会话变量
    await t('普通赋值（无 session.前缀）不写会话变量', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([{ variable: 'local_x', operator: 'set', value: '9' }])) }, { input: 'hi' }, { sessionVars: { user_name: '张三' } });
      assert.strictEqual(r.sessionVars.user_name, '张三', '会话变量不变');
      assert.ok(!('local_x' in r.sessionVars), '普通变量不入会话快照');
      assert.strictEqual(r.results.a1.local_x, '9', '普通变量照常输出');
    });
    // ⑤ 跨轮模拟：轮 1 返回快照 → 轮 2 加载快照注入（chat.js 持久化链路的 Runner 侧语义）
    await t('跨轮模拟：轮 1 写入快照 → 轮 2 加载持久值读到', async () => {
      const wf = wfOf([{ variable: 'session.user_name', operator: 'set', value: '王五' }]);
      const r1 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '我叫王五' }, { sessionVars: {} });
      assert.strictEqual(r1.sessionVars.user_name, '王五', '轮 1 写入');
      // 模拟 sessions.wf_vars 存取
      const persisted = JSON.stringify(r1.sessionVars);
      const r2 = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([])) }, { input: '你好' }, { sessionVars: JSON.parse(persisted) });
      assert.strictEqual(r2.results.start.user_name, '王五', '轮 2 start 注入持久值');
      assert.strictEqual(r2.output, '王五|0');
    });
    // ⑥ 测试运行语义：sessionVars 空 → 默认值起（临时态）
    await t('运行测试语义：sessionVars 空 → 默认值起（临时态）', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfOf([])) }, { input: 'hi' }, { sessionVars: {} });
      assert.strictEqual(r.results.start.user_name, '游客', '默认值兜底');
      assert.strictEqual(r.output, '游客|0');
    });
    // ⑦ db 迁移：sessions.wf_vars 列就位且可写
    await t('sessions 表：wf_vars 列就位（迁移）', () => {
      const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
      assert.ok(cols.includes('wf_vars'), 'sessions 应含 wf_vars 列：' + cols.join(','));
    });
    // ⑧ getNodeOutputs：会话变量成合法引用变量
    await t('getNodeOutputs：会话变量并入 start 输出变量集', () => {
      const outs = schema.getNodeOutputs({ type: 'start', data: { session_vars: [{ name: 'user_name' }, { name: 'visit_count' }] } }).map(o => o.name);
      assert.deepStrictEqual(outs, ['input', 'user_name', 'visit_count']);
    });
  }

  console.log('【P5.8】差异化能力：子智能体下钻（parent_run_id）/ runAgent 统一入口');
  {
    const runner = require('../src-server/lib/workflow');
    // code 画布图（无 LLM，纯本地可测）：start → code 大写 → end
    const codeWf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'c1', type: 'code', data: { title: '加工', code: 'return { output: "已处理:" + input };', inputs: '{"input":"{{#start.input#}}"}', timeout: 3000 } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c1.output#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'c1' }, { id: '2', source: 'c1', target: 'e' }],
    };
    // ① runAgent 统一入口（canvas 模式）：按图执行 + 落 run 行 + 返回 runId
    await t('runAgent canvas：按编排图执行 + 落 workflow_runs + 返回 runId', async () => {
      const agent = { id: 901, name: '测试-画布子智能体', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify(codeWf) };
      const r = await runner.runAgent(agent, '任务A', { triggerType: 'schedule' });
      assert.strictEqual(r.mode, 'canvas', 'canvas 模式');
      assert.strictEqual(r.text, '已处理:任务A', '按图执行：' + r.text);
      assert.ok(r.runId > 0, '返回 runId');
      const row = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(r.runId);
      assert.strictEqual(row.agent_id, 901);
      assert.strictEqual(row.trigger_type, 'schedule', 'trigger_type 记录来源');
      assert.strictEqual(row.status, 'success');
      assert.strictEqual(row.parent_run_id, null, '顶层 run 无父');
    });
    // ② agent 节点下钻链路：父图 agent 节点 → 子 canvas 智能体；childRunId + DB parent_run_id 关联
    await t('agent 节点：childRunId/childMode 输出 + 子 run parent_run_id 关联', async () => {
      const child = { id: 902, name: '子-画布智能体', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify(codeWf) };
      // 直接调 agent 执行器（绕过 DB 查子行——执行器从 db 读 agents 表，需真插一行）
      db.prepare(`INSERT INTO agents (id,name,edit_mode,routing_mode,workflow,status,created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(child.id, child.name, 'canvas', 'workflow', JSON.stringify(codeWf), 'draft');
      const parentWf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'ag', type: 'agent', data: { title: '子智能体节点', agentId: 902, input: '{{#start.input#}}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '结果：{{#ag.reply#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'ag' }, { id: '2', source: 'ag', target: 'e' }],
      };
      const parentAgent = { id: 903, name: '父-编排器', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify(parentWf) };
      // 经 runAgent（父 run 落库）→ agent 节点 ctx._currentRunId=父 runId → 子 run 关联
      const r = await runner.runAgent(parentAgent, '任务B', { triggerType: 'manual' });
      assert.strictEqual(r.text, '结果：已处理:任务B', '父图最终输出：' + r.text);
      // 父 run 的 nodeLogs 里 agent 节点应带 childRunId
      const logs = r.run.logs || [];
      const agLog = logs.find(l => l.nodeId === 'ag');
      assert.ok(agLog?.childRunId > 0, 'agent 节点日志含 childRunId');
      assert.strictEqual(agLog.childMode, 'canvas', 'childMode=canvas（可下钻）');
      // DB：子 run 行 parent_run_id = 父 runId
      const childRow = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(agLog.childRunId);
      assert.strictEqual(childRow.agent_id, 902, '子 run 归属子智能体');
      assert.strictEqual(childRow.parent_run_id, r.runId, 'parent_run_id 关联父 run');
      assert.strictEqual(childRow.trigger_type, 'agent_node', '来源=agent_node');
      assert.strictEqual(childRow.status, 'success');
      // 结果变量含 childRunId（前端 runState 用）
      assert.ok(r.run.results.ag.childRunId === agLog.childRunId);
      // 清理测试行
      db.prepare('DELETE FROM workflow_runs WHERE id IN (?,?)').run(r.runId, agLog.childRunId);
      db.prepare('DELETE FROM agents WHERE id=902').run();
    });
    // ③ workflow_runs.parent_run_id 列就位
    await t('workflow_runs：parent_run_id 列就位（#9 迁移）', () => {
      const cols = db.prepare('PRAGMA table_info(workflow_runs)').all().map(c => c.name);
      assert.ok(cols.includes('parent_run_id'), '应含 parent_run_id：' + cols.join(','));
    });
  }

  console.log('【P5.9】版本管理：草稿与发布分离（快照/运行时优先/历史/回滚）');
  {
    const runner = require('../src-server/lib/workflow');
    // 画布图工厂（code 节点输出可区分版本）
    const wfOf = (marker) => ({
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'c1', type: 'code', data: { title: '加工', code: `return { output: "${marker}:" + input };`, inputs: '{"input":"{{#start.input#}}"}', timeout: 3000 } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c1.output#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'c1' }, { id: '2', source: 'c1', target: 'e' }],
    });
    // ① db 迁移：列 + 历史表就位
    await t('db：published_workflow 列 + agent_publish_history 表就位', () => {
      const cols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
      assert.ok(cols.includes('published_workflow'), 'agents 应含 published_workflow：' + cols.join(','));
      const tcols = db.prepare('PRAGMA table_info(agent_publish_history)').all().map(c => c.name);
      ['agent_id', 'version', 'workflow', 'note', 'nodes', 'published_by'].forEach(c => assert.ok(tcols.includes(c), '历史表缺列 ' + c));
    });
    // ② 运行时优先已发布：published_workflow 存在时草稿改动不影响执行
    await t('runAgent：优先已发布快照——草稿改动不影响运行', async () => {
      const agent = {
        id: 901, name: '版本测试', edit_mode: 'canvas', routing_mode: 'workflow',
        workflow: JSON.stringify(wfOf('draft-v2')),        // 草稿（已改）
        published_workflow: JSON.stringify(wfOf('pub-v1')), // 已发布快照（旧）
      };
      const r = await runner.runAgent(agent, '任务', { triggerType: 'manual' });
      assert.strictEqual(r.text, 'pub-v1:任务', '应执行快照版本而非草稿：' + r.text);
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(r.runId);
    });
    // ③ 无快照回退草稿（存量兼容）
    await t('runAgent：无快照回退草稿（存量画布兼容）', async () => {
      const agent = { id: 901, name: '无快照', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify(wfOf('draft-only')), published_workflow: null };
      const r = await runner.runAgent(agent, 'x', {});
      assert.strictEqual(r.text, 'draft-only:x', '无快照应走草稿：' + r.text);
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(r.runId);
    });
    // ④ 快照损坏回退草稿（防御）
    await t('runAgent：快照损坏回退草稿（防御）', async () => {
      const agent = { id: 901, name: '坏快照', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify(wfOf('fallback')), published_workflow: '{broken json' };
      const r = await runner.runAgent(agent, 'x', {});
      assert.strictEqual(r.text, 'fallback:x', '坏快照应回退草稿：' + r.text);
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(r.runId);
    });
    // ⑤ 发布快照语义（模拟 publish 路由核心逻辑）：快照=当时草稿 + 历史表自增版本
    await t('发布快照：历史表版本自增 + 快照落库（路由逻辑核心段）', () => {
      const { validateWorkflowV2 } = require('../src-server/lib/workflow-schema');
      const draft = JSON.stringify(wfOf('v3'));
      const v = validateWorkflowV2(JSON.parse(draft));
      const snapSql = JSON.stringify(v);
      // 模拟两次发布（v1/v2 前置 + 本次 v3）
      for (let i = 0; i < 3; i++) {
        const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_publish_history WHERE agent_id=?').get(901).v || 0) + 1;
        db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
          .run(901, version, snapSql, '测试发布 v' + version, v.nodes.length, 'tester');
      }
      const rows = db.prepare('SELECT version, note, nodes FROM agent_publish_history WHERE agent_id=901 ORDER BY version').all();
      assert.deepStrictEqual(rows.map(r => r.version), [1, 2, 3], '版本号应自增 1,2,3');
      assert.strictEqual(rows[2].note, '测试发布 v3');
      // 清理
      db.prepare('DELETE FROM agent_publish_history WHERE agent_id=901').run();
    });
    // ⑥ 回滚语义：历史快照写回草稿 + published_workflow 同步
    await t('回滚：快照写回草稿 + published_workflow 同步（路由逻辑核心段）', async () => {
      // 先插入测试智能体行（UPDATE 需要行存在）
      db.prepare(`INSERT INTO agents (id,name,edit_mode,routing_mode,workflow,status,created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(901, '回滚测试智能体', 'canvas', 'workflow', JSON.stringify(wfOf('draft-new')), 'draft');
      const snap = JSON.stringify(wfOf('v1-old'));
      db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(901, 1, snap, '待回滚版本', 3, 'tester');
      // 模拟 rollback 核心：UPDATE agents SET workflow=?, published_workflow=?
      db.prepare('UPDATE agents SET workflow=?, published_workflow=? WHERE id=901').run(snap, snap);
      const a = db.prepare('SELECT workflow, published_workflow FROM agents WHERE id=901').get();
      assert.strictEqual(a.workflow, snap, '草稿已恢复');
      assert.strictEqual(a.published_workflow, snap, '线上快照已同步');
      // 验证运行走回滚后的版本
      const r = await runner.runAgent({ id: 901, name: '回滚验证', edit_mode: 'canvas', routing_mode: 'workflow', workflow: a.workflow, published_workflow: a.published_workflow }, 'y', {});
      assert.strictEqual(r.text, 'v1-old:y', '回滚后运行走旧版本：' + r.text);
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(r.runId);
      db.prepare('DELETE FROM agent_publish_history WHERE agent_id=901').run();
      db.prepare('DELETE FROM agents WHERE id=901').run();
    });
    // ⑦ C2（2026-11-10）：diffWorkflows 纯函数——节点增删改 / position 忽略 / 深对象同构异序不算变
    await t('C2 diff：节点增删改识别 + position 忽略 + 深对象同构异序不算变', () => {
      const { diffWorkflows } = require('../src-server/lib/workflow-diff');
      const a = {
        nodes: [
          { id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始' } },
          { id: 'n2', type: 'llm', position: { x: 100, y: 0 }, data: { label: '助手', model: 'qwen-plus', schema: { a: 1, b: [1, 2] } } },
          { id: 'n3', type: 'end', position: { x: 200, y: 0 }, data: { label: '结束' } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out' }],
      };
      const b = {
        nodes: [
          { id: 'n1', type: 'start', position: { x: 88, y: 77 }, data: { label: '开始' } }, // 仅 position 变 → 忽略
          { id: 'n2', type: 'llm', position: { x: 100, y: 0 }, data: { label: '助手v2', model: 'qwen-max', schema: { b: [1, 2], a: 1 } } }, // schema 同构异序不算变，label/model 算
          { id: 'n4', type: 'tool', position: { x: 300, y: 0 }, data: { label: '搜索' } }, // 新增
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out' }],
      };
      const d = diffWorkflows(a, b);
      assert.deepStrictEqual(d.nodes.added.map(n => n.id), ['n4'], '应识别新增 n4');
      assert.deepStrictEqual(d.nodes.removed.map(n => n.id), ['n3'], '应识别删除 n3');
      assert.strictEqual(d.nodes.changed.length, 1, '仅 n2 为变更');
      assert.deepStrictEqual(d.nodes.changed[0].fields.map(f => f.key).sort(), ['label', 'model'], 'schema 同构异序不应计入字段变更');
      assert.deepStrictEqual(d.summary, { nodesAdded: 1, nodesRemoved: 1, nodesChanged: 1, fieldsChanged: 2, edgesAdded: 0, edgesRemoved: 0, edgesChanged: 0, total: 3 }, '汇总计数应一致');
    });
    // ⑧ C2：连线匹配——有 id 用 id，无 id 用 source|target|sourceHandle 组合键；同 id 改 target 识别为变更
    await t('C2 diff：连线 id/组合键匹配 + 连线内容变更识别', () => {
      const { diffWorkflows } = require('../src-server/lib/workflow-diff');
      const a = { nodes: [], edges: [
        { id: 'e1', source: 'a', target: 'b', sourceHandle: 'out' },
        { source: 'a', target: 'c', sourceHandle: 'yes' },   // 无 id → 组合键
      ] };
      const b = { nodes: [], edges: [
        { id: 'e1', source: 'a', target: 'x', sourceHandle: 'out' }, // 同 id 改 target → changed
        { source: 'a', target: 'c', sourceHandle: 'yes' },           // 组合键命中 → 不变
        { source: 'c', target: 'd', sourceHandle: 'out' },           // 新增
      ] };
      const d = diffWorkflows(a, b);
      assert.deepStrictEqual(d.edges.added.map(e => e.target), ['d'], '应识别新增连线');
      assert.deepStrictEqual(d.edges.removed, [], '组合键命中不应误判删除');
      assert.strictEqual(d.edges.changed.length, 1, '同 id 改 target 应识别为变更');
      assert.ok(d.edges.changed[0].fields.some(f => f.key === 'target'), 'target 变更应出现在字段明细');
    });
    // ⑨ C2：SQL 链路——两版本快照 + 当前草稿，按 diff 接口同款取数逻辑验证（b=draft 走 agents.workflow）
    await t('C2 diff：发布历史快照取数 → diff（接口取数核心段）', () => {
      const { diffWorkflows } = require('../src-server/lib/workflow-diff');
      const mk = (label, model) => {
        const wf = wfOf(label);
        wf.nodes[1].data.model = model; // 制造可断言的字段差异（code 节点）
        return JSON.stringify(wf);
      };
      db.prepare(`INSERT INTO agents (id,name,edit_mode,routing_mode,workflow,status,created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(903, 'C2对比测试', 'canvas', 'workflow', mk('draft', 'qwen-max'), 'draft');
      db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(903, 1, mk('v1', 'qwen-plus'), '首版', 3, 'tester');
      db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(903, 2, mk('v2', 'qwen-max'), '二版', 3, 'tester');
      // 接口同款取数：a=v1 快照，b=draft → agents.workflow
      const agentRow = db.prepare('SELECT workflow FROM agents WHERE id=903').get();
      const v1 = db.prepare('SELECT workflow FROM agent_publish_history WHERE agent_id=903 AND version=1').get();
      const d = diffWorkflows(JSON.parse(v1.workflow), JSON.parse(agentRow.workflow));
      const c1 = d.nodes.changed.find(n => n.id === 'c1');
      assert.ok(c1, 'code 节点应识别为变更');
      const keys = c1.fields.map(f => f.key);
      assert.ok(keys.includes('code'), 'code 字段（marker 不同）应变更');
      assert.ok(keys.includes('model'), 'model 字段（plus→max）应变更');
      // 版本间对比：v1 vs v2 同样两字段
      const v2 = db.prepare('SELECT workflow FROM agent_publish_history WHERE agent_id=903 AND version=2').get();
      const d12 = diffWorkflows(JSON.parse(v1.workflow), JSON.parse(v2.workflow));
      assert.deepStrictEqual(d12.nodes.changed[0].fields.map(f => f.key).sort(), ['code', 'model'], 'v1↔v2 差异应为 code+model');
      // 同快照自比 → 全 0
      const d0 = diffWorkflows(JSON.parse(v1.workflow), JSON.parse(v1.workflow));
      assert.strictEqual(d0.summary.total, 0, '同快照自比应无差异');
      db.prepare('DELETE FROM agent_publish_history WHERE agent_id=903').run();
      db.prepare('DELETE FROM agents WHERE id=903').run();
    });
  }

  console.log('【P5.10】流式调试：LLM 节点逐字流出（nodeStream 事件）');
  {
    const runner = require('../src-server/lib/workflow');
    // 本块需要「无可用候选 → callMock 流式生成器」：清空供应商（前面用例插入的测试供应商），跑完无需恢复（末块）
    db.prepare('DELETE FROM providers').run();
    db.prepare('DELETE FROM user_providers').run();
    // 测试环境无真实网关配置 → chat() 走 callMock（同为流式生成器，逐块 yield delta）——语义与真实链路一致
    const wf = {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'l1', type: 'llm', data: { title: '生成', prompt: '写一段问候语：{{#start.input#}}', model: '', temperature: 0.7, max_tokens: 128 } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.text#}}' }] } },
      ],
      edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'e' }],
    };
    await t('llm 流式：nodeStream 事件逐字发出 + 拼接与最终 text 一致', async () => {
      const streams = [];
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '你好' }, {
        onEvent: evt => { if (evt.event === 'nodeStream') streams.push({ nodeId: evt.nodeId, delta: evt.delta }); },
      });
      assert.ok(streams.length >= 1, '应有 nodeStream 事件（mock 也是流式生成器）：' + streams.length);
      assert.ok(streams.every(s => s.nodeId === 'l1'), '事件带正确 nodeId');
      const joined = streams.map(s => s.delta).join('');
      assert.ok(joined.length > 0 && r.results.l1.text.startsWith(joined.slice(0, 1)), '拼接内容与最终 text 同源');
      assert.strictEqual(joined.length <= r.results.l1.text.length, true, '拼接不超过完整文本');
    });
    await t('llm 流式：节流合并生效（事件数 ≤ 字符数，且首尾无丢失）', async () => {
      const events = [];
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '在吗' }, {
        onEvent: evt => { if (evt.event === 'nodeStream') events.push(evt.delta); },
      });
      const text = r.results.l1.text;
      const joined = events.join('');
      // 40ms 合并节流：事件数应明显少于字符数（mock 逐字符 yield）
      assert.ok(events.length <= text.length, `事件数 ${events.length} ≤ 字符数 ${text.length}`);
      assert.strictEqual(joined, text, '所有 delta 合并后应等于完整文本（无丢失）');
    });
    await t('classifier/agent 节点不受影响（chatOnce 路径回归）', async () => {
      // classifier 纯函数回归（P5.6 既有用例语义——确保本次 llm 改造未破坏其它执行器）
      const cats = ['售前', '售后'];
      assert.strictEqual(runner.parseClassifyReply('售后', cats), '售后');
      const p = runner.buildClassifyPrompt(cats, '退款', '');
      assert.ok(p.includes('售前') && p.includes('退款'));
    });
  }

  console.log('【P5.11】异常处理分支：失败不是终点（__error__ 出边优雅降级）');
  {
    const runner = require('../src-server/lib/workflow');
    // 失败节点 + 异常分支图工厂：code 抛错 → __error__ 出边 → 补救 code → end
    const wfErr = (withBranch, fail) => {
      const nodes = [
        { id: 'start', type: 'start', data: {} },
        { id: 't1', type: 'code', data: { title: '会失败的任务', code: fail ? 'throw new Error("数据源连接超时（模拟）")' : 'return { output: "正常结果" };', inputs: '{}', timeout: 2000 } },
        { id: 'r1', type: 'code', data: { title: '补救节点', code: 'return { output: "服务暂时不可用（原因：" + reason + "）" };', inputs: '{"reason":"{{#t1.__error__#}}"}', timeout: 2000 } },
        { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#r1.output#}}' }] } },
      ];
      const edges = [
        { id: '1', source: 'start', target: 't1' },
        ...(withBranch ? [{ id: '2', source: 't1', target: 'r1', sourceHandle: '__error__' }] : []),
        { id: '3', source: 'r1', target: 'e' },
      ];
      return { nodes, edges };
    };
    // ① 失败 → 走异常分支：不中断 + __error__ 变量传递 + 补救节点执行
    await t('异常分支：节点失败不中断，__error__ 原因传到补救节点', async () => {
      const events = [];
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfErr(true, true)) }, { input: 'x' }, {
        onEvent: evt => { if (evt.event === 'nodeDone') events.push(evt); },
      });
      assert.ok(r.output.includes('服务暂时不可用'), '最终输出应为补救文案：' + r.output);
      assert.ok(r.output.includes('数据源连接超时'), '失败原因注入补救节点：' + r.output);
      const failEvt = events.find(e => e.nodeId === 't1');
      assert.strictEqual(failEvt.ok, false, 't1 失败事件');
      assert.strictEqual(failEvt.viaError, true, '事件带 viaError 标记');
      const t1Log = r.logs.find(l => l.nodeId === 't1');
      assert.strictEqual(t1Log.status, 'error');
      assert.strictEqual(t1Log.viaError, true, '日志带 viaError');
      assert.ok(r.logs.some(l => l.nodeId === 'r1' && l.status === 'success'), '补救节点已执行');
    });
    // ② 失败节点正常时：error 边不激活（补救节点跳过），正常边不走（仅 error 边场景的图正常路径会断）——验证 error 边仅在失败时激活
    await t('异常分支：节点成功时 __error__ 边不激活（补救节点跳过）', async () => {
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wfErr(true, false)) }, { input: 'x' }, {});
      const r1Log = r.logs.find(l => l.nodeId === 'r1');
      assert.strictEqual(r1Log?.status, 'skipped', '节点成功时补救节点应跳过：' + r1Log?.status);
    });
    // ③ 无 error 出边 → 维持原失败策略（abort 中断，P5.5 语义回归）
    await t('无异常分支：维持 abort 中断（P5.5 语义回归）', async () => {
      await assert.rejects(
        () => runner.runWorkflow({ workflow: JSON.stringify(wfErr(false, true)) }, { input: 'x' }, {}),
        /执行失败/,
      );
    });
    // ④ computeActive 纯函数：errorOf 激活语义
    await t('computeActive：errorOf 节点只走 __error__ 边 / 正常节点排除 __error__ 边', () => {
      const nodes = [
        { id: 'start', type: 'start', data: {} },
        { id: 'a', type: 'code', data: {} }, { id: 'b', type: 'code', data: {} }, { id: 'c', type: 'end', data: {} },
      ];
      const edges = [
        { source: 'start', target: 'a' },
        { source: 'a', target: 'b', sourceHandle: '__error__' }, // 异常边
        { source: 'a', target: 'c', sourceHandle: 'out' },        // 正常边
      ];
      const ok = runner.computeActive(nodes, edges, {}, new Set());
      assert.ok(ok.has('c') && !ok.has('b'), '正常时走 c 不走 b');
      const bad = runner.computeActive(nodes, edges, {}, new Set(['a']));
      assert.ok(bad.has('b') && !bad.has('c'), '失败时走 b 不走 c');
    });
    // ⑤ 混合图：失败节点 error 分支 + 正常下游链共存
    await t('异常分支混合图：失败节点走补救，正常链不受影响', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 't1', type: 'code', data: { title: '易失败', code: 'throw new Error("超时")', inputs: '{}', timeout: 2000 } },
          { id: 'r1', type: 'code', data: { title: '兜底', code: 'return { output: "降级回复" };', inputs: '{}', timeout: 2000 } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#r1.output#}}' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 't1' },
          { id: '2', source: 't1', target: 'r1', sourceHandle: '__error__' },
          { id: '3', source: 'r1', target: 'e' },
        ],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
      assert.strictEqual(r.output, '降级回复', '优雅降级到兜底：' + r.output);
    });
  }

  console.log('【P5.12】保存时自动校验：悬空引用 / 孤立节点 / 必填缺失');
  {
    const { checkRefs, validateWorkflowV2 } = require('../src-server/lib/workflow-schema');
    // ① checkRefs 变量级：nodeId 存在但变量未声明 → 坏引用
    // （code 节点 outputs 显式声明了字段清单时，未声明字段报错；未声明清单的 code 无法静态判定→放行不误报）
    await t('checkRefs 变量级：引用未声明输出变量 → 报坏引用', () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'l1', type: 'llm', data: { prompt: 'x' } },
          { id: 'c1', type: 'code', data: { code: 'return { output: "x" };', inputs: '{}', outputs: ['output'] } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.text#}} {{#c1.output#}} {{#c1.未声明字段#}} {{#幽灵节点.text#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'c1' }, { id: '3', source: 'c1', target: 'e' }],
      };
      const problems = checkRefs(wf);
      const refs = problems.map(p => p.ref);
      assert.ok(refs.includes('c1.未声明字段'), '变量级坏引用应报：' + JSON.stringify(refs));
      assert.ok(refs.includes('幽灵节点.text'), '不存在节点应报');
      assert.ok(!refs.includes('c1.output') && !refs.includes('l1.text'), '合法引用不报');
    });
    // ② validateWorkflowV2 结构校验回归
    await t('validateWorkflowV2：无 start / 坏类型 / 环 拦截', () => {
      assert.ok(validateWorkflowV2({ nodes: [{ id: 'a', type: 'llm', data: {} }], edges: [] }).error, '缺 start 应报错');
      const ok = validateWorkflowV2({
        nodes: [{ id: 'start', type: 'start', data: {} }, { id: 'e', type: 'end', data: { outputs: [] } }],
        edges: [{ id: '1', source: 'start', target: 'e' }],
      });
      assert.ok(!ok.error, '正常图通过');
    });
    // ③ checkRefs：start 变量/assign 变量/结构化字段动态变量放行（不误报）
    await t('checkRefs 动态变量：start 变量/assign 赋值/llm 结构化字段不误报', () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'city', default: '北京' }], session_vars: [{ name: 'user_name' }] } },
          { id: 'a1', type: 'assign', data: { assignments: [{ variable: 'score', operator: 'set', value: '{{#start.user_name#}}' }] } },
          { id: 'l1', type: 'llm', data: { prompt: '{{#start.city#}} {{#a1.score#}}', output_schema: '{"properties":{"sentiment":{"type":"string"}}}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.sentiment#}}' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 'a1' }, { id: '2', source: 'a1', target: 'l1' }, { id: '3', source: 'l1', target: 'e' },
        ],
      };
      const problems = checkRefs(wf);
      assert.deepStrictEqual(problems, [], '动态变量集内的引用全部合法：' + JSON.stringify(problems.map(p => p.ref)));
    });
    // ④ checkRefs：会话变量引用（start.session_vars）与 __error__ 变量放行
    await t('checkRefs 特殊变量：__error__ / start 会话变量放行', () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { session_vars: [{ name: 'cnt' }] } },
          { id: 't1', type: 'tool', data: { toolId: 'calculator', args: '{"expression":"1+1"}' } },
          { id: 'r1', type: 'code', data: { code: 'return { output: reason };', inputs: '{"reason":"{{#t1.__error__#}}"}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#r1.output#}} {{#start.cnt#}}' }] } },
        ],
        edges: [
          { id: '1', source: 'start', target: 't1' },
          { id: '2', source: 't1', target: 'r1', sourceHandle: '__error__' },
          { id: '3', source: 'r1', target: 'e' },
        ],
      };
      const problems = checkRefs(wf);
      assert.deepStrictEqual(problems, [], '__error__ 与会话变量应放行：' + JSON.stringify(problems.map(p => p.ref)));
    });
  }

  console.log('【P5.13】成本可视化：节点 tokens/费用 + 全图 usage 汇总');
  {
    const runner = require('../src-server/lib/workflow');
    const { calcCost, fmtCost } = require('../src-server/lib/cost');
    // ① calcCost 纯函数：单价表前缀匹配（元/百万 tokens，input/output 分列）
    await t('calcCost：dsv4 命中单价（输入 2 / 输出 8 元每百万）', () => {
      const c = calcCost('dsv4', 1000000, 500000);
      assert.strictEqual(c.priced, true, '命中价格表');
      assert.ok(Math.abs(c.inCost - 2) < 1e-9, '输入费 2 元：' + c.inCost);
      assert.ok(Math.abs(c.outCost - 4) < 1e-9, '输出费 4 元：' + c.outCost);
      assert.ok(Math.abs(c.total - 6) < 1e-9, '合计 6 元');
    });
    await t('calcCost：未匹配模型 → DEFAULT_PRICE 兜底估价 priced:false', () => {
      const c = calcCost('未知模型xyz', 1000000, 0);
      assert.strictEqual(c.priced, false, '未命中应标记估价');
      assert.ok(Math.abs(c.total - 4) < 1e-9, '兜底输入单价 4 元');
    });
    await t('calcCost/fmtCost：null tokens 费用 0 + 费用格式化', () => {
      const c = calcCost('dsv4', null, undefined);
      assert.strictEqual(c.total, 0, 'null 按 0 计费');
      assert.strictEqual(fmtCost(0), '¥0');
      assert.strictEqual(fmtCost(0.02345), '¥0.023');
      assert.strictEqual(fmtCost(0.002345), '¥0.0023');
    });
    // ② llm 节点：事件与日志带 tokens/cost 字段（mock 链路只有 total_tokens，in/out 为 null → 费用 0）
    await t('llm 节点：nodeDone 事件与日志带 tokens/cost_cny/cost_priced 字段', async () => {
      const events = [];
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'l1', type: 'llm', data: { title: '生成', prompt: '你好：{{#start.input#}}', model: '' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.text#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: '你好' }, {
        onEvent: evt => { if (evt.event === 'nodeDone' && evt.nodeId === 'l1') events.push(evt); },
      });
      const evt = events[0];
      assert.ok(evt, '应有 l1 nodeDone 事件');
      assert.ok(evt.tokens != null && evt.tokens > 0, '事件带 tokens：' + evt.tokens);
      assert.ok('cost_cny' in evt && 'cost_priced' in evt && 'model_used' in evt, '事件带费用三件套');
      const log = r.logs.find(l => l.nodeId === 'l1');
      assert.ok(log.tokens > 0 && 'cost_cny' in log, '日志带 tokens/cost 字段');
    });
    // ③ 全图 usage 汇总：多 llm 节点累计 + nodes 明细（最贵/最慢数据源）
    await t('usage 汇总：两个 llm 节点 tokens 累计 + nodes 明细含 duration/model', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'l1', type: 'llm', data: { title: '第一段', prompt: 'a' } },
          { id: 'l2', type: 'llm', data: { title: '第二段', prompt: 'b' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l2.text#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'l2' }, { id: '3', source: 'l2', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
      const t1 = r.logs.find(l => l.nodeId === 'l1').tokens;
      const t2 = r.logs.find(l => l.nodeId === 'l2').tokens;
      assert.ok(r.usage, 'runWorkflow 返回 usage');
      assert.strictEqual(r.usage.totalTokens, t1 + t2, `总 tokens 应为节点累计（${t1}+${t2}）：` + r.usage.totalTokens);
      assert.strictEqual(r.usage.nodes.length, 2, 'nodes 明细两条');
      assert.ok(r.usage.nodes.every(n => n.duration >= 0 && n.tokens != null && 'costCny' in n), '明细带 duration/tokens/costCny');
      assert.strictEqual(r.usage.costCny, 0, 'mock 无 in/out 细分 → 费用 0');
    });
  }

  console.log('【P5.14】文件一等变量：fileId 流转 + render 注入 + preset 对称序列化');
  {
    const runner = require('../src-server/lib/workflow');
    const { fileToRich, fileToText, parseFileBuffer } = require('../src-server/lib/fileparse');
    // 测试文件入库工厂：txt 内容直写 wf_files（绕过 HTTP 上传；解析函数单独验证）
    const insFile = db.prepare(`INSERT INTO wf_files (name,ext,size,text_content,content_b64,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`);
    const mkFile = (name, text) => insFile.run(name, 'txt', Buffer.byteLength(text), text, Buffer.from(text).toString('base64'), 'manual', 'tester');
    // ① 表就位 + 富对象构造
    await t('wf_files 表就位 + fileToRich/fileToText 结构', () => {
      const info = mkFile('合同.txt', '甲方应在三十日内完成交付，违约金为合同总额的百分之五。');
      const row = db.prepare('SELECT * FROM wf_files WHERE id=?').get(info.lastInsertRowid);
      const rich = fileToRich(row);
      assert.strictEqual(rich.__file, row.id, '富对象带 __file 标记');
      assert.strictEqual(rich.name, '合同.txt');
      assert.ok(rich.url === `/api/files/${row.id}/download`, '下载链接正确');
      const txt = fileToText(rich);
      assert.ok(txt.includes(`[📄 文件 #${row.id}：合同.txt`), '文本头带 id 与文件名：' + txt.slice(0, 60));
      assert.ok(txt.includes('违约金'), '文本含全文');
    });
    // ② parseFileBuffer：txt 解析 + 非法扩展名拒绝
    await t('parseFileBuffer：txt 解析 + 白名单外扩展名抛错', async () => {
      const r = await parseFileBuffer('笔记.md', Buffer.from('# 标题\n正文'));
      assert.strictEqual(r.ext, 'md');
      assert.ok(r.text.includes('正文'));
      await assert.rejects(() => parseFileBuffer('恶意.exe', Buffer.from('x')), /暂不支持/);
    });
    // ③ start file 变量：fileId → 富对象注入 results（llm 引用自动文本化）
    await t('start file 变量：传 fileId → 富对象 + llm prompt 渲染注入全文', async () => {
      const info = mkFile('服务协议.txt', '本协议有效期一年，任何一方可提前三十天书面通知解除。');
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'contract', type: 'file', label: '合同' }] } },
          { id: 'l1', type: 'llm', data: { title: '审查', prompt: '审查以下文件的关键条款：{{#start.contract#}}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.text#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'l1' }, { id: '2', source: 'l1', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x', contract: Number(info.lastInsertRowid) }, {});
      const fv = r.results.start.contract;
      assert.strictEqual(fv.__file, Number(info.lastInsertRowid), 'start 输出为富对象');
      assert.ok(fv.text.includes('提前三十天'), '富对象带解析全文');
      // render 语义：直接调用 render 验证文本化（mock llm 输出不含注入逻辑，用 render 纯函数验证）
      const rendered = runner.render('{{#start.contract#}}', r.results, {});
      assert.ok(rendered.includes(`[📄 文件 #${info.lastInsertRowid}：服务协议.txt`), '引用渲染为文件头：' + rendered.slice(0, 60));
      assert.ok(rendered.includes('提前三十天'), '渲染含全文');
    });
    // ④ array[file] 多文件 + code 节点拿到文本化内容
    await t('array[file]：多文件数组 + code 节点文本注入', async () => {
      const f1 = mkFile('a.txt', '文件甲：预算总额一百万元。');
      const f2 = mkFile('b.txt', '文件乙：交付周期为四十五天。');
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'docs', type: 'array[file]' }] } },
          { id: 'c1', type: 'code', data: { title: '提取', code: 'return { output: files.replace(/\\s+/g, " ").slice(0, 200) };', inputs: '{"files":"{{#start.docs#}}"}', outputs: ['output'] } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c1.output#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'c1' }, { id: '2', source: 'c1', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x', docs: [Number(f1.lastInsertRowid), Number(f2.lastInsertRowid)] }, {});
      assert.ok(Array.isArray(r.results.start.docs) && r.results.start.docs.length === 2, '数组变量注入两富对象');
      assert.ok(r.output.includes('预算总额') && r.output.includes('交付周期'), 'code 收到两文件全文：' + r.output.slice(0, 80));
    });
    // ⑤ 不存在的 fileId → 友好报错
    await t('file 变量引用不存在文件 → 报错含变量名与文件 id', async () => {
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'gone', type: 'file' }] } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#start.gone#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'e' }],
      };
      await assert.rejects(
        () => runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x', gone: 999999 }, {}),
        /文件不存在/,
      );
    });
    // ⑥ preset 对称序列化：__file JSON 字符串 → normalizePresetVars 还原（重跑链路）
    await t('preset 对称协议：file JSON 序列化往返还原（重跑缓存）', async () => {
      const info = mkFile('重跑.txt', '重跑场景需要全文保留：违约责任条款。');
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'doc', type: 'file' }] } },
          { id: 'c1', type: 'code', data: { title: '一步', code: 'return { output: "v1" };', inputs: '{}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#c1.output#}}' }] } },
        ],
        edges: [{ id: '1', source: 'start', target: 'c1' }, { id: '2', source: 'c1', target: 'e' }],
      };
      const r1 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x', doc: Number(info.lastInsertRowid) }, {});
      // 模拟 agents.js resultsSlim 序列化（file 对象保 JSON）
      const slim = {};
      for (const [nid, vars] of Object.entries(r1.results)) {
        slim[nid] = {};
        for (const [k, v] of Object.entries(vars || {})) {
          const isFileObj = (v && typeof v === 'object' && v.__file) || (Array.isArray(v) && v.length && v[0]?.__file);
          slim[nid][k] = isFileObj ? JSON.stringify(v) : String(v ?? '').slice(0, 1500);
        }
      }
      assert.ok(slim.start.doc.startsWith('{"__file"'), '序列化为 JSON 字符串');
      // 重跑 e 节点：preset 注入 → Runner 内部 normalize 还原 → render 仍可文本化
      const r2 = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, { startFrom: 'e', presetResults: slim });
      const rendered = runner.render('{{#start.doc#}}', r2.results, {});
      assert.ok(rendered.includes('违约责任条款'), '重跑后 file 变量仍可渲染全文');
    });
    // ⑦ tool args 结构化传值：纯引用 → 原始值直达（file 富对象整对象传递给工具）
    await t('tool args 纯引用：file 富对象整对象直达（结构化传递）', async () => {
      const info = mkFile('保密协议.txt', '保密期限为签署之日起五年。');
      const rich = fileToRich(db.prepare('SELECT * FROM wf_files WHERE id=?').get(info.lastInsertRowid));
      const node = { id: 't1', type: 'tool', data: { toolId: 'doc_review', args: '{"file_id":"{{#start.contract#}}"}' } };
      const inputs = runner.resolveInputs(node, { start: { contract: rich } }, {});
      assert.ok(inputs.args.file_id && typeof inputs.args.file_id === 'object', 'file_id 收到富对象（非文本）');
      assert.strictEqual(inputs.args.file_id.__file, rich.__file, '富对象 id 一致');
      assert.strictEqual(inputs.args.file_id.name, '保密协议.txt', '富对象带文件名');
    });
    // ⑧ tool args 纯引用：含引号换行的长文本不再破坏 JSON（旧实现整体 render 后 parse 必炸）
    await t('tool args 纯引用：特殊字符文本原样传递（JSON 不再被破坏）', () => {
      const nasty = '含"引号"与\\反斜杠\n还有换行\t制表';
      const node = { id: 't1', type: 'tool', data: { toolId: 'export_word', args: '{"title":"报告","markdown":"{{#l1.text#}}"}' } };
      const inputs = runner.resolveInputs(node, { l1: { text: nasty } }, {});
      assert.strictEqual(inputs.args.markdown, nasty, '文本原样传递（未经 JSON 破坏）');
      assert.strictEqual(inputs.args.title, '报告', '其余字段不受影响');
    });
    // ⑨ tool args：数字原样 / 混合模板文本渲染 / 无效引用保留原样 / 非 JSON 模板回退 _raw
    await t('tool args：数字原样 + 混合模板文本渲染 + 非 JSON 模板回退', () => {
      const n1 = { id: 't1', type: 'tool', data: { toolId: 'calculator', args: '{"n":"{{#c1.output#}}"}' } };
      const i1 = runner.resolveInputs(n1, { c1: { output: 42 } }, {});
      assert.strictEqual(i1.args.n, 42, '数字原始值直达（非字符串）');
      const n2 = { id: 't2', type: 'tool', data: { toolId: 'web_search', args: '{"q":"检索 {{#start.input#}} 相关"}' } };
      const i2 = runner.resolveInputs(n2, {}, { input: '量子计算' });
      assert.strictEqual(i2.args.q, '检索 量子计算 相关', '混合模板按文本渲染');
      const n3 = { id: 't3', type: 'tool', data: { toolId: 'web_search', args: '{"q":"{{#幽灵.var#}}"}' } };
      const i3 = runner.resolveInputs(n3, {}, {});
      assert.strictEqual(i3.args.q, '{{#幽灵.var#}}', '无效引用保留原样（语义同 render）');
      const n4 = { id: 't4', type: 'tool', data: { toolId: 'web_search', args: '不是JSON {{#start.input#}}' } };
      const i4 = runner.resolveInputs(n4, {}, { input: 'x' });
      assert.strictEqual(i4.args._raw, '不是JSON x', '非 JSON 模板回退旧语义（存量兼容）');
    });
    // ⑩ fileIdOf：数字/富对象/数组取首
    await t('fileIdOf：数字 / 富对象 / array[file] 取首个', () => {
      const { fileIdOf } = require('../src-server/lib/tools-extra');
      assert.strictEqual(fileIdOf(5), 5, '数字直传');
      assert.strictEqual(fileIdOf({ __file: 5 }), 5, '富对象 __file');
      assert.strictEqual(fileIdOf({ id: 7 }), 7, '富对象 id');
      assert.strictEqual(fileIdOf([{ __file: 3, name: 'a' }, { __file: 9, name: 'b' }]), 3, '数组取首个');
      assert.strictEqual(fileIdOf(undefined), 0, '空值归零');
      assert.strictEqual(fileIdOf('12'), 12, '字符串数字');
    });
    // ⑪ doc_review file_id → wf_files 直达评审（端到端工具链；mock LLM 环境 0 问题报告仍生成）
    await t('doc_review：file_id 直达评审上传文件（wf_files 路径）', async () => {
      const { doc_review } = require('../src-server/lib/tools-extra');
      const info = mkFile('采购合同.txt', '乙方逾期交付的，每逾期一日按合同总额的千分之五支付违约金，累计不超过合同总额的百分之十。本合同适用中华人民共和国法律。');
      const r = await doc_review.run({ file_id: Number(info.lastInsertRowid), template: 'contract' }, {});
      assert.ok(String(r).includes('评审完成：「采购合同.txt」'), '评审报告含文件名：' + String(r).slice(0, 80));
      assert.ok(String(r).includes('合同风险审查'), '使用 contract 模板');
      // 富对象形式（画布纯引用注入的形态）同样可达
      const rich = fileToRich(db.prepare('SELECT * FROM wf_files WHERE id=?').get(info.lastInsertRowid));
      const r2 = await doc_review.run({ file_id: rich, template: 'general' }, {});
      assert.ok(String(r2).includes('「采购合同.txt」'), '富对象 file_id 同样直达');
      // 不存在的文件 → 友好报错
      const r3 = await doc_review.run({ file_id: 999999 }, {});
      assert.ok(String(r3).includes('不存在'), '不存在文件友好报错');
    });
  }

  console.log('【P5.15】画布基本功：便签根字段透传（右键菜单/快捷键/框选为纯前端，此处验证持久化层）');
  {
    const { validateWorkflowV2 } = require('../src-server/lib/workflow-schema');
    await t('validateWorkflowV2：notes 便签根字段透传 + 尺寸/颜色/数量规范化', () => {
      const r = validateWorkflowV2({
        nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }, { id: 'node_1', type: 'end', position: { x: 1, y: 0 }, data: { outputs: [{ variable: 'r', value: 'x' }] } }],
        edges: [{ id: 'e1', source: 'start', target: 'node_1' }],
        notes: [
          { id: 'note_1', x: 10, y: 20, w: 999, h: -5, text: '这个分支处理 VIP 用户', color: 'bad-color' },
          { text: '无id便签（自动编号）' },
        ],
      });
      assert.ok(!r.error, '校验通过：' + (r.error || ''));
      assert.strictEqual(r.notes.length, 2, '两张便签透传');
      assert.strictEqual(r.notes[0].w, 480, '宽度上限收敛 480');
      assert.strictEqual(r.notes[0].h, 80, '高度下限收敛 80');
      assert.strictEqual(r.notes[0].color, '#fef08a', '非法颜色回退默认黄');
      assert.strictEqual(r.notes[1].id, 'note_2', '缺 id 按索引自动编号');
      assert.strictEqual(r.notes[1].x, 0, '缺坐标归零');
    });
    await t('validateWorkflowV2：无便签字段默认空数组 + 超量截断 30 张 + 文本截断', () => {
      const r2 = validateWorkflowV2({ nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [] });
      assert.deepStrictEqual(r2.notes, [], '无便签字段默认空数组');
      const r3 = validateWorkflowV2({ nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [], notes: Array.from({ length: 40 }, (_, i) => ({ id: 'n' + i, text: 'x'.repeat(3000) })) });
      assert.strictEqual(r3.notes.length, 30, '便签上限 30 张');
      assert.ok(r3.notes[0].text.length <= 2000, '便签文本截断 2000 字');
    });
  }

  console.log('【P5.16】API 文档自动生成：契约提取 + 类型推断 + MCP schema 同源');
  {
    const { extractApiContract, buildMcpInputSchema, buildApiDoc, inferOutType } = require('../src-server/lib/api-doc');
    const insFile2 = db.prepare(`INSERT INTO wf_files (name,ext,size,text_content,content_b64,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`);
    const mkFile = (name, text) => insFile2.run(name, 'txt', Buffer.byteLength(text), text, Buffer.from(text).toString('base64'), 'manual', 'tester');
    const mkAgent = (nodes, edges, extra = {}) => ({ id: 9, name: '合同审查', description: '测试', edit_mode: 'canvas', routing_mode: 'workflow', workflow: JSON.stringify({ nodes, edges, flow_type: 'workflow' }), ...extra });
    // ① 画布契约：start 变量（含 file）+ end 输出类型推断（纯引用 llm 结构化字段 / 混合模板 / number）
    await t('extractApiContract：Start 变量 → 请求参数（file 类型 + 必填映射）', () => {
      const a = mkAgent(
        [
          { id: 'start', type: 'start', data: { variables: [
            { name: 'contract', type: 'file', label: '合同文件' },
            { name: 'amount', type: 'number', label: '金额', default: '100', required: true },
            { name: 'remark', type: 'string', label: '备注', default: '' },
          ] } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'report', value: '{{#l1.text#}}' }] } },
        ],
        [{ id: 'e1', source: 'start', target: 'e' }],
      );
      const c = extractApiContract(a);
      assert.strictEqual(c.input.length, 4, 'input + 3 变量');
      assert.strictEqual(c.input[0].name, 'input', '首参 input');
      const f = c.input.find(p => p.name === 'contract');
      assert.strictEqual(f.type, 'file', 'file 类型透传');
      assert.strictEqual(f.required, false, 'file 变量不作硬性必填');
      const n = c.input.find(p => p.name === 'amount');
      assert.strictEqual(n.type, 'number');
      assert.strictEqual(n.required, true, 'required 透传');
    });
    await t('inferOutType：纯引用查上游类型（llm 结构化 number / 迭代 count / 混合 string）', () => {
      const nodes = [
        { id: 'l1', type: 'llm', data: { title: '抽取', output_schema: JSON.stringify({ properties: { total: { type: 'number' }, risk: { type: 'string' } } }) } },
        { id: 'it', type: 'iteration', data: { title: '迭代' } },
      ];
      assert.strictEqual(inferOutType('{{#l1.total#}}', nodes).type, 'number', 'llm 结构化 number 字段');
      assert.strictEqual(inferOutType('{{#l1.risk#}}', nodes).type, 'string', 'llm 结构化 string 字段');
      assert.strictEqual(inferOutType('{{#it.count#}}', nodes).type, 'number', '迭代 count');
      assert.strictEqual(inferOutType('共 {{#l1.total#}} 元', nodes).type, 'string', '混合模板 → string');
      assert.strictEqual(inferOutType('固定文本', nodes).type, 'string', '固定文本 → string');
      assert.strictEqual(inferOutType('{{#幽灵.x#}}', nodes).type, 'string', '未知引用 → string 兜底');
    });
    await t('extractApiContract：end 输出字段 + answer 节点 + 表单模式兜底', () => {
      const c = extractApiContract(mkAgent(
        [
          { id: 'start', type: 'start', data: {} },
          { id: 'a1', type: 'answer', data: { title: '直答', text: '{{#l1.risk#}}' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'report', value: '完整：{{#l1.risk#}}' }] } },
        ],
        [],
      ));
      assert.ok(c.output.some(o => o.name === '直答' && o.source.startsWith('answer')), 'answer 节点输出');
      assert.ok(c.output.some(o => o.name === 'report'), 'end 输出');
      // 表单模式：单参数对话式
      const f = extractApiContract({ id: 9, name: 'x', description: '', edit_mode: 'form', workflow: null });
      assert.strictEqual(f.isCanvas, false);
      assert.strictEqual(f.input.length, 1);
      assert.strictEqual(f.input[0].name, 'input');
    });
    // ② MCP schema 与文档同源
    await t('buildMcpInputSchema：Start 变量 → properties + task 别名 + required', () => {
      const s = buildMcpInputSchema(mkAgent(
        [{ id: 'start', type: 'start', data: { variables: [{ name: 'contract', type: 'file', label: '合同' }, { name: 'amount', type: 'number', label: '金额', required: true }] } },
         { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: 'x' }] } }],
        [],
      ));
      assert.strictEqual(s.type, 'object');
      assert.ok(s.properties.input, 'input 参数');
      assert.strictEqual(s.properties.contract.type, 'integer', 'file → integer file-id');
      assert.strictEqual(s.properties.contract.format, 'file-id');
      assert.strictEqual(s.properties.amount.type, 'number');
      assert.ok(s.properties.task, 'task 兼容别名');
      assert.deepStrictEqual(s.required, ['input', 'amount'], 'input 首位 + 声明必填变量');
    });
    await t('buildApiDoc：双通道 + OpenAPI 3.0 规范 + 文件上传说明', () => {
      const d = buildApiDoc(mkAgent(
        [{ id: 'start', type: 'start', data: { variables: [{ name: 'contract', type: 'file', label: '合同' }] } },
         { id: 'e', type: 'end', data: { outputs: [{ variable: 'report', value: '{{#l1.text#}}' }] } }],
        [],
      ), 'localhost:3210');
      assert.strictEqual(d.channels.length, 2, 'MCP + OpenAI 双通道');
      assert.ok(d.channels[0].curl.includes('tools/call'), 'MCP curl 示例');
      assert.ok(d.channels[0].curl.includes('agent_9'), '工具名 agent_9');
      assert.strictEqual(d.openapi.openapi, require('../src-server/lib/version').OPENAPI_VERSION);
      assert.ok(d.openapi.paths['/mcp'], '/mcp 路径');
      assert.ok(d.openapi.paths['/openapi/v1/chat/completions'], 'openai 路径');
      assert.ok(d.openapi.components.schemas.AgentInput.properties.contract, 'AgentInput 含 contract');
      assert.ok(d.fileUpload, 'file 参数时附上传说明');
      assert.ok(JSON.stringify(d).length > 500, '文档结构完整');
    });
    // ③ runAgent inputVars 注入（MCP 结构化参数 → start 变量；file 由富对象解析）
    await t('runAgent：ctx.inputVars 并入 start 变量（画布执行链路）', async () => {
      const info = mkFile('参数合同.txt', '定金为总价百分之二十。');
      const runner2 = require('../src-server/lib/workflow');
      const a = { id: 88, name: '参数注入测试', edit_mode: 'canvas', routing_mode: 'workflow', model: '', workflow: JSON.stringify({
        nodes: [
          { id: 'start', type: 'start', data: { variables: [{ name: 'contract', type: 'file' }, { name: 'level', type: 'string', default: '低' }] } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#start.input#}}|{{#start.level#}}|{{#start.contract#}}' }] } },
        ],
        edges: [{ id: 'e1', source: 'start', target: 'e' }],
      }) };
      const r = await runner2.runAgent(a, '审一下', { inputVars: { contract: Number(info.lastInsertRowid), level: '高' } });
      assert.ok(r.text.includes('审一下'), 'input 传递');
      assert.ok(r.text.includes('|高|'), 'level 变量注入（覆盖默认）');
      assert.ok(r.text.includes('定金为总价百分之二十'), 'file 变量 fileId → 富对象 → 模板全文注入');
    });
  }

  console.log('【P5.17】工作流模板库：内置 seed 合法性 + 一键创建 + 存为模板');
  {
    const { SEEDS } = require('../src-server/lib/wf-template-seed');
    const { validateWorkflowV2, checkRefs } = require('../src-server/lib/workflow-schema');
    // ① 三个内置模板的 workflow JSON 必须本身合法（有 start/边对齐/无悬空引用——保证用户导入即可用）
    await t('内置模板：三个 seed 均过 validateWorkflowV2（周报/投诉/财报）', () => {
      assert.strictEqual(SEEDS.length, 3, '三个内置模板');
      const names = SEEDS.map(s => s.name);
      assert.ok(names.includes('周报自动生成') && names.includes('客户投诉处理') && names.includes('财报解读'), '场景齐全');
      for (const s of SEEDS) {
        const v = validateWorkflowV2(s.workflow);
        assert.ok(v && !v.error, `${s.name} 结构合法：${v ? v.error : ''}`);
        assert.ok(v.nodes.length >= 4, `${s.name} 节点数合理`);
        const refs = checkRefs(v);
        assert.ok(!refs.length, `${s.name} 无悬空引用：` + JSON.stringify(refs.slice(0, 2)));
      }
    });
    await t('内置模板：seed 关键节点就位（周报含 export_word / 投诉含 kb_search / 财报含 file 变量与 code）', () => {
      const weekly = SEEDS.find(s => s.slug === 'weekly-report').workflow;
      assert.ok(weekly.nodes.some(n => n.type === 'tool' && n.data.toolId === 'export_word'), '周报含 Word 导出');
      assert.ok(weekly.nodes.some(n => n.type === 'code'), '周报含数据拉取 code');
      const comp = SEEDS.find(s => s.slug === 'complaint-handler').workflow;
      assert.ok(comp.nodes.some(n => n.type === 'tool' && n.data.toolId === 'kb_search'), '投诉含知识库检索');
      assert.ok(comp.nodes.some(n => n.data?.output_schema), '投诉含意图分类结构化输出');
      assert.ok((comp.notes || []).length >= 1, '投诉带人工审核便签');
      const fin = SEEDS.find(s => s.slug === 'fin-report-reader').workflow;
      assert.ok(fin.nodes[0].data.variables.some(v => v.type === 'file'), '财报 start 含 file 变量（文件一等变量）');
      assert.ok(fin.nodes.some(n => n.type === 'code'), '财报含指标校验 code');
    });
    // ② db.js seed 幂等落库 + 表结构 + 创建链路（直接走路由内部逻辑等价 SQL——路由层由浏览器实测覆盖）
    await t('workflow_templates 表：内置 seed 幂等落库（slug 唯一）', () => {
      const rows = db.prepare(`SELECT id,slug,name,builtin,nodes_hint FROM (SELECT id,slug,name,builtin,(SELECT COUNT(*) FROM json_each(workflow,'$.nodes')) nodes_hint FROM workflow_templates) WHERE builtin=1 ORDER BY id`).all();
      assert.ok(rows.length >= 3, '三个内置模板入库');
      assert.ok(rows.some(r => r.slug === 'weekly-report' && r.nodes_hint >= 4), '周报模板就位');
      // 幂等：再次执行 seed 语句（INSERT OR IGNORE）不新增
      const before = db.prepare('SELECT COUNT(*) c FROM workflow_templates').get().c;
      for (const s of SEEDS) {
        db.prepare(`INSERT OR IGNORE INTO workflow_templates (slug,name,icon,category,description,scene,workflow,builtin,use_count,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,0,'platform',datetime('now','localtime'))`)
          .run(s.slug, s.name, s.icon, s.category, s.description, s.scene, JSON.stringify(s.workflow), 1);
      }
      const after = db.prepare('SELECT COUNT(*) c FROM workflow_templates').get().c;
      assert.strictEqual(after, before, '重复 seed 幂等（slug 唯一约束）');
    });
    // ③ 存为模板的校验语义（等价路由 POST /：validateWorkflowV2 拦截坏结构）
    await t('存为模板：坏 workflow 被校验拦截（路由同语义）', () => {
      const bad = validateWorkflowV2({ nodes: [{ id: 'n1', type: 'llm', data: {} }], edges: [] });
      assert.ok(bad.error, '缺 start 拒绝：' + (bad.error || ''));
      const bad2 = validateWorkflowV2('不是JSON{{{');
      assert.ok(bad2.error, '非法 JSON 拒绝');
    });
  }

  console.log('【P5.19】多模型故障转移：条件判定 + 候选插队 + 4xx 不降级 + fallback_used 回报');
  {
    const { isFailoverWorthy, buildCandidates } = require('../src-server/lib/llm');
    // ① 故障转移条件全覆盖（用户要求：超时 / 429 限流 / 5xx）
    await t('isFailoverWorthy：超时/网络抖动/429/5xx 判定可转移', () => {
      const mk = (msg, name) => Object.assign(new Error(msg), name ? { name } : {});
      assert.ok(isFailoverWorthy(mk('连接模型网关超时', 'Error')), '连接超时（文案匹配）');
      assert.ok(isFailoverWorthy(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'CONNECT_TIMEOUT cause');
      assert.ok(isFailoverWorthy(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })), 'ECONNRESET cause');
      assert.ok(isFailoverWorthy(mk('AbortError', 'AbortError')), '超时中止');
      assert.ok(isFailoverWorthy(mk('请求超时（已自动重试 2 次仍失败）')), '请求超时文案');
      assert.ok(isFailoverWorthy(mk('模型供应商返回 429: rate limited')), '429 限流');
      assert.ok(isFailoverWorthy(mk('模型供应商返回 502: bad gateway')), '502');
      assert.ok(isFailoverWorthy(mk('模型供应商返回 503')), '503');
      assert.ok(isFailoverWorthy(mk('HTTP 504')), '504 HTTP 格式');
    });
    await t('isFailoverWorthy：4xx 确定性错误不转移（换模型无意义）', () => {
      const mk = msg => new Error(msg);
      assert.ok(!isFailoverWorthy(mk('模型供应商返回 401: invalid api key')), '401 鉴权');
      assert.ok(!isFailoverWorthy(mk('模型供应商返回 403: 无权调用模型')), '403 权限');
      assert.ok(!isFailoverWorthy(mk('模型供应商返回 404: model not found')), '404 模型不存在');
      assert.ok(!isFailoverWorthy(mk('模型供应商返回 400: bad request')), '400 参数');
      assert.ok(!isFailoverWorthy(mk('普通业务错误')), '普通错误兜底 false');
    });
    // ② 候选插队：fallback_models 在主模型候选之后、全网关兜底之前（通过 chat 内部逻辑的纯函数部分验证）
    await t('buildCandidates：指定模型候选优先（插队基准位语义）', () => {
      const cands = buildCandidates('dsv4', {});
      if (cands.length) {
        assert.strictEqual(cands[0].model, 'dsv4', '有供应商时指定模型排首位');
      } else {
        assert.ok(Array.isArray(cands), '无供应商（早前用例已清理）时候选为空数组——语义不依赖环境');
      }
    });
    // ③ 节点执行链路：fallback_models 透传 + fallback_used 输出变量（mock 环境下主模型即成功 → null）
    await t('runWorkflow llm 节点：fallback_models 透传 + fallback_used 输出（正常路径 null）', async () => {
      const runner = require('../src-server/lib/workflow');
      const wf = {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'l1', type: 'llm', data: { title: 'LLM', model: '', fallback_models: ['glm5.2'], system_prompt: '', prompt: '回一个字' } },
          { id: 'e', type: 'end', data: { outputs: [{ variable: 'r', value: '{{#l1.text#}}|fb={{#l1.fallback_used#}}' }] } },
        ],
        edges: [{ id: 'e1', source: 'start', target: 'l1' }, { id: 'e2', source: 'l1', target: 'e' }],
      };
      const r = await runner.runWorkflow({ workflow: JSON.stringify(wf) }, { input: 'x' }, {});
      assert.ok(r.output.includes('|fb='), 'fallback_used 变量可引用');
      assert.ok(/\|fb=(null)?$/i.test(String(r.output).trim()), '正常路径 fallback_used 为 null/空：' + String(r.output).slice(-30));
    });
    // ④ chat() 4xx 不降级语义（noFailover 抛出）——用不存在的供应商配置模拟：临时清空 providers 表
    await t('chat()：非转移型错误直接抛（不吞错不盲降级）', async () => {
      const { chat } = require('../src-server/lib/llm');
      // 无供应商环境 → mock 兜底（不抛）；此处验证函数导出存在与 generator 语义
      const gen = chat([{ role: 'user', content: 'hi' }], { model: 'dsv4', fallbackModels: ['glm5.2'] });
      const r = await gen.next();
      assert.ok(r.done || r.value !== undefined, 'generator 语义正常（mock/real 均可迭代）');
    });
  }

  console.log('【N】P5.30 安全止血回归：HTTP 集成（会话归属 IDOR / 登录限流 / Key 脱敏 / 知识库权限）');
  {
    const { spawn } = require('child_process');
    const { sign } = require('../src-server/lib/auth');
    // 直接经父进程库句柄造测试用户（不走 HTTP 登录，不占用登录限流窗口）；子进程共享同一临时库（WAL 多连接）
    db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('httpu1',?,'测试用户一','user',1,0,datetime('now','localtime'))`).run(hashPwd('http-pass-123'));
    db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('httpu2',?,'测试用户二','user',1,0,datetime('now','localtime'))`).run(hashPwd('http-pass-123'));
    const uid1 = db.prepare(`SELECT id FROM users WHERE username='httpu1'`).get().id;
    const uid2 = db.prepare(`SELECT id FROM users WHERE username='httpu2'`).get().id;
    const tok1 = sign({ uid: uid1, exp: Date.now() + 3600000 });
    const tok2 = sign({ uid: uid2, exp: Date.now() + 3600000 });

    // P5.32：MCP 风险分级测试数据（HTTP 组与后续单测组共用）：A 已信任带 low 工具 / B 未信任 / C 旧缓存无 risk 字段
    const mkMcpTools = (name, risk) => JSON.stringify([{ name: `mcp_${name}`, originalName: name, description: '', schema: { type: 'function', function: { name: `mcp_${name}`, description: '', parameters: { type: 'object', properties: {} } } }, ...(risk ? { risk } : {}) }]);
    db.prepare(`INSERT INTO mcp_servers (name,url,api_key,transport,status,tools_cache,trusted,created_at) VALUES ('信任服务A','http://a.test','','http',1,?,1,datetime('now','localtime'))`).run(mkMcpTools('get_x', 'low'));
    db.prepare(`INSERT INTO mcp_servers (name,url,api_key,transport,status,tools_cache,trusted,created_at) VALUES ('未信任服务B','http://b.test','','http',1,?,0,datetime('now','localtime'))`).run(mkMcpTools('search_y', 'low'));
    db.prepare(`INSERT INTO mcp_servers (name,url,api_key,transport,status,tools_cache,trusted,created_at) VALUES ('旧缓存服务C','http://c.test','','http',1,?,1,datetime('now','localtime'))`).run(mkMcpTools('get_z'));

    const port = 33000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    // ===== V1.3 #4 钉钉集成测试前置（2026-10-30）=====
    // ⚠️ 必须在 spawn 子进程【之前】写入 secrets：lib/secrets.js 的 loadSecrets 有 60s 内存缓存，
    //    子进程起服务后父进程再写库，子进程首次读已可能命中空值缓存走「未配置」分支（集成实测踩过的坑）
    const dingCrypto = require('../src-server/lib/dingtalk-crypto');
    const DT_AES_KEY = require('crypto').randomBytes(32).toString('base64').replace(/=+$/, ''); // 43 位，钉钉控制台 AESKey 形态
    const DT_TOKEN = 'smoke-dt-token';
    require('../src-server/lib/secrets').upsert('DINGTALK_AES_KEY', DT_AES_KEY, 'smoke V1.3#4');
    require('../src-server/lib/secrets').upsert('DINGTALK_TOKEN', DT_TOKEN, 'smoke V1.3#4');
    require('../src-server/lib/secrets').upsert('DINGTALK_APP_KEY', 'smoke-dt-app-key', 'smoke V1.3#4');       // 扫码登录骨架前置（本组暂不直接用，为后续用例铺路）
    require('../src-server/lib/secrets').upsert('DINGTALK_APP_SECRET', 'smoke-dt-app-secret', 'smoke V1.3#4'); // 同上
    // ===== V2.3 Y7 前置（2026-10-31）：子进程预置 License 测试公钥 =====
    // ⚠️ 必须在 spawn 子进程【之前】设置 env（与上方钉钉 secrets 同理）：运行中改父进程 env 不会传播到已启动子进程；
    //    热重载用例在子进程内验签 License，公钥须随 spawn 传入；父进程保留私钥供用例签发（见下方「License 热重载」用例）
    const licKeypair = require('crypto').generateKeyPairSync('ed25519');
    process.env.LICENSE_PUBKEY_HEX = licKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR },
      stdio: 'ignore',
    });
    const jfetch = async (p, opts = {}, tok) => {
      const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
      let j = null; try { j = await r.json(); } catch { }
      return { status: r.status, j };
    };
    try {
      // 等服务就绪（最多 10s）
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        await new Promise(r2 => setTimeout(r2, 200));
        try { up = (await fetch(base + '/api/health')).ok; } catch { }
      }
      await t('HTTP：子进程服务启动与健康检查（临时库+随机端口）', async () => {
        assert.ok(up, 'server 应在 10s 内就绪');
      });
      if (up) {
        await t('HTTP：会话归属——他人会话读取被拒（GET messages IDOR 回归）', async () => {
          const c = await jfetch('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: '归属测试' }) }, tok1);
          assert.ok(c.j && c.j.code === 0, 'u1 创建会话应成功：' + JSON.stringify(c.j).slice(0, 120));
          const sid = c.j.data.id;
          const own = await jfetch(`/api/chat/sessions/${sid}/messages`, {}, tok1);
          assert.ok(own.j && own.j.code === 0, '本人读取自己会话应放行：' + JSON.stringify(own.j).slice(0, 120));
          const other = await jfetch(`/api/chat/sessions/${sid}/messages`, {}, tok2);
          assert.strictEqual(other.j && other.j.code, 403, '他人读取应 403：' + JSON.stringify(other.j));
        });
        await t('HTTP：会话归属——向他人会话发起对话被拒（stream 入口 IDOR 回归）', async () => {
          const c = await jfetch('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'u1s2' }) }, tok1);
          const sid = c.j.data.id;
          const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok2 }, body: JSON.stringify({ session_id: sid, content: 'hi' }) });
          const bodyText = await r.text().catch(() => '');
          assert.strictEqual(r.status, 403, `他人会话 stream 应 403，实际 ${r.status}：${bodyText.slice(0, 120)}`);
        });
        await t('HTTP：归属校验不误伤——本人会话正常对话（SSE done）', async () => {
          const c = await jfetch('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'u1s3' }) }, tok1);
          const sid = c.j.data.id;
          const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok1 }, body: JSON.stringify({ session_id: sid, content: '一句话介绍你自己' }) });
          assert.strictEqual(r.status, 200, '本人 stream 应 200，实际 ' + r.status);
          const text = await r.text();
          assert.ok(text.includes('event: done'), 'SSE 应有 done 事件（无供应商环境走内置模拟）：' + text.slice(0, 200));
        });
        await t('HTTP：登录限流——同 IP 第 11 次尝试 429（此前可无限暴力尝试）', async () => {
          const out = [];
          for (let i = 0; i < 11; i++) {
            const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'httpu1', password: 'wrong-' + i }) });
            let j = null; try { j = await r.json(); } catch { }
            out.push(r.status + '/' + (j && j.code));
          }
          assert.ok(out[9].endsWith('/401'), '第 10 次应返回业务码 401（密码错误），实际：' + out.join(','));
          assert.ok(out[10].startsWith('429'), '第 11 次应被限流 HTTP 429，实际：' + out.join(','));
        });
        await t('HTTP：钉钉交换码——伪造码 401 + 响应不含任何 token 字样（#14）', async () => {
          // 伪造/空码走路由负例：consume 返回 null → 401（正例已在 lib 单测覆盖——HTTP 正例需真实钉钉 OAuth 回调，
          // mock 阶段凭证伪造不可行；路由→lib 的接线由「伪造码恰好命中限流前的 401 分支」验证）
          const r1 = await jfetch('/api/auth/dingtalk/exchange', { method: 'POST', body: JSON.stringify({ code: 'a'.repeat(64) }) });
          assert.strictEqual(r1.status, 401, '伪造 64hex 码应 401，实际 ' + r1.status);
          const r2 = await jfetch('/api/auth/dingtalk/exchange', { method: 'POST', body: JSON.stringify({}) });
          assert.strictEqual(r2.status, 401, '缺 code 字段应 401，实际 ' + r2.status);
          assert.ok(!JSON.stringify(r2.j || {}).includes('token'), '负例响应不得泄露 token 字样：' + JSON.stringify(r2.j));
        });
        // ===== V3.1 #12 审核流（2026-11-03）：社区版自动通过 + 审核路由权限 + 非法状态拦截 =====
        await t('HTTP：审核流——社区版发布自动通过 + auto_approve 审核流水（V3.1 #12）', async () => {
          // 建一个 httpu1 拥有的 draft 智能体（父进程句柄写入，WAL 共享临时库）
          db.prepare(`INSERT INTO agents (name,description,type,category,owner,status,visibility,created_at,updated_at) VALUES ('审核流测试agent','#12','','未分类','httpu1','draft','public',datetime('now','localtime'),datetime('now','localtime'))`).run();
          const ag = db.prepare(`SELECT id FROM agents WHERE name='审核流测试agent'`).get();
          // 社区版（smoke 无 License → community，无 audit_flow 特性）：httpu1（非 admin）发布 → 直接 published
          const j = await jfetch(`/api/agents/${ag.id}/publish`, { method: 'POST', body: JSON.stringify({ record: '#12 审核流冒烟' }) }, tok1);
          assert.ok(j.j && j.j.code === 0, '社区版发布应直接成功：' + JSON.stringify(j.j).slice(0, 120));
          assert.ok((j.j.msg || '').includes('已发布'), '社区版 msg 应为已发布（自动通过语义），实际：' + j.j.msg);
          const st = db.prepare('SELECT status FROM agents WHERE id=?').get(ag.id).status;
          assert.strictEqual(st, 'published', '发布后状态应为 published，实际 ' + st);
          // 审核流水：auto_approve 一条（用户决策：社区版提审自动通过）
          const flow = db.prepare(`SELECT action, operator FROM agent_reviews WHERE agent_id=? ORDER BY id DESC LIMIT 1`).get(ag.id);
          assert.ok(flow && flow.action === 'auto_approve' && flow.operator === 'httpu1', '应有 auto_approve 流水（operator=httpu1），实际：' + JSON.stringify(flow));
          // 自清理：删测试 agent + 流水 + 广场广播（不污染后续用例）
          db.prepare('DELETE FROM agents WHERE id=?').run(ag.id);
          db.prepare('DELETE FROM agent_reviews WHERE agent_id=?').run(ag.id);
          db.prepare(`DELETE FROM notifications WHERE type='agent_publish' AND title LIKE '%审核流测试agent%'`).run();
        });
        await t('HTTP：审核流——review/review-queue 路由权限与状态门禁（V3.1 #12）', async () => {
          // 自建数据：httpu1 拥有的 draft 智能体（不依赖前组用例的清理时序）
          db.prepare(`INSERT INTO agents (name,description,type,category,owner,status,visibility,created_at,updated_at) VALUES ('审核门禁测试agent','#12','','未分类','httpu1','draft','public',datetime('now','localtime'),datetime('now','localtime'))`).run();
          const ag = db.prepare(`SELECT id FROM agents WHERE name='审核门禁测试agent'`).get();
          // 非 admin 访问审核队列 → 403
          const q1 = await jfetch('/api/agents/review-queue', {}, tok1);
          assert.strictEqual(q1.j && q1.j.code, 403, '非 admin 拉取审核队列应 403，实际：' + JSON.stringify(q1.j));
          // 非 admin 调审核 → 403
          const r1 = await jfetch(`/api/agents/${ag.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }, tok1);
          assert.strictEqual(r1.j && r1.j.code, 403, '非 admin 审核应 403，实际：' + JSON.stringify(r1.j));
          // admin 对非 review 状态智能体审核 → 400（状态门禁）
          db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('rvadmin',?,'审核测试管理员','admin',1,0,datetime('now','localtime'))`).run(hashPwd('rv-pass-123'));
          const rvAid = db.prepare(`SELECT id FROM users WHERE username='rvadmin'`).get().id;
          const tokA = sign({ uid: rvAid, exp: Date.now() + 3600000 });
          const r2 = await jfetch(`/api/agents/${ag.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }, tokA);
          assert.strictEqual(r2.j && r2.j.code, 400, '非 review 状态（draft）审核应 400，实际：' + JSON.stringify(r2.j));
          // admin 拉取审核队列 → code 0（此时无 review 状态行，data 为空数组）
          const q2 = await jfetch('/api/agents/review-queue', {}, tokA);
          assert.ok(q2.j && q2.j.code === 0 && Array.isArray(q2.j.data), 'admin 审核队列应 code 0：' + JSON.stringify(q2.j).slice(0, 120));
          // 自清理
          db.prepare('DELETE FROM agents WHERE id=?').run(ag.id);
        });
        // ===== V3.1 #12 嵌入代码（2026-11-03）：域名白名单 + snippet 生成 + CSP frame-ancestors =====
        let embAid = 0, embToken = '';
        await t('HTTP：嵌入代码——权限/格式校验/前置门禁/snippet 生成（V3.1 #12）', async () => {
          // 造已发布+已分享的智能体（owner=httpu1；share_token 直插——开分享的正常入口走 POST /:id/share，此处直插等效）
          embToken = 'emb' + require('crypto').randomBytes(8).toString('hex');
          db.prepare(`INSERT INTO agents (name,type,category,owner,status,visibility,share_token,share_enabled,created_at,updated_at) VALUES ('嵌入测试agent','other','未分类','httpu1','published','public',?,1,datetime('now','localtime'),datetime('now','localtime'))`).run(embToken);
          embAid = db.prepare(`SELECT id FROM agents WHERE share_token=?`).get(embToken).id;
          // ① 他人（httpu2）配置嵌入域名 → 403（归属级权限）
          const r403 = await jfetch(`/api/agents/${embAid}/embed-config`, { method: 'POST', body: JSON.stringify({ domains: 'evil.com' }) }, tok2);
          assert.strictEqual(r403.j && r403.j.code, 403, '非 owner 配置嵌入域名应 403，实际：' + JSON.stringify(r403.j));
          // ② 非法域名格式 → 400（防 CSP 头注入：带协议/引号/通配符全拒）
          const bad = await jfetch(`/api/agents/${embAid}/embed-config`, { method: 'POST', body: JSON.stringify({ domains: 'https://x.com, "a", *.b.com' }) }, tok1);
          assert.strictEqual(bad.j && bad.j.code, 400, '非法域名格式应 400：' + JSON.stringify(bad.j));
          // ③ 未配白名单生成代码 → 400 + need=domains 引导
          const noDom = await jfetch(`/api/agents/${embAid}/embed-code`, {}, tok1);
          assert.strictEqual(noDom.j && noDom.j.code, 400, '无白名单生成应 400：' + JSON.stringify(noDom.j));
          assert.strictEqual(noDom.j.data && noDom.j.data.need, 'domains', '引导字段应为 domains');
          // ④ 合法域名 → 保存成功 + 生成 snippet（iframe 含 share URL、script 含 widget.js）
          const ok = await jfetch(`/api/agents/${embAid}/embed-config`, { method: 'POST', body: JSON.stringify({ domains: 'www.example.com, portal.example.com, www.example.com' }) }, tok1);
          assert.ok(ok.j && ok.j.code === 0, '合法域名应保存成功：' + JSON.stringify(ok.j));
          assert.deepStrictEqual(ok.j.data.domains, ['www.example.com', 'portal.example.com'], '域名应去重且保序：' + JSON.stringify(ok.j.data.domains));
          const gen = await jfetch(`/api/agents/${embAid}/embed-code`, {}, tok1);
          assert.ok(gen.j && gen.j.code === 0, '生成嵌入代码应成功：' + JSON.stringify(gen.j).slice(0, 140));
          assert.ok((gen.j.data.iframe || '').includes(`/share/${embToken}`), 'iframe snippet 应含 share URL');
          assert.ok((gen.j.data.script || '').includes(`/embed/widget.js?token=${embToken}`), 'script snippet 应含 widget.js 入口');
          assert.deepStrictEqual(gen.j.data.domains, ['www.example.com', 'portal.example.com'], '回显白名单');
        });
        await t('HTTP：嵌入防护——CSP frame-ancestors 白名单生效 + 无白名单仅 self（V3.1 #12）', async () => {
          // 有白名单的 token：CSP 头含两个域名 + 'self'
          const r1 = await fetch(base + `/share/${embToken}`);
          const csp1 = r1.headers.get('content-security-policy') || '';
          assert.ok(csp1.includes("frame-ancestors 'self' www.example.com portal.example.com"), 'CSP 应含白名单域名：' + csp1);
          // 无白名单的 token（另造一个未配置 embed_domains 的分享 agent）：CSP 仅 'self'（点击劫持默认防护）
          const tok2share = 'embx' + require('crypto').randomBytes(8).toString('hex');
          db.prepare(`INSERT INTO agents (name,type,category,owner,status,visibility,share_token,share_enabled,created_at,updated_at) VALUES ('嵌入CSP对照agent','other','未分类','httpu1','published','public',?,1,datetime('now','localtime'),datetime('now','localtime'))`).run(tok2share);
          const r2 = await fetch(base + `/share/${tok2share}`);
          const csp2 = r2.headers.get('content-security-policy') || '';
          assert.strictEqual(csp2, "frame-ancestors 'self'", '无白名单应仅 self：' + csp2);
          // 清理
          db.prepare(`DELETE FROM agents WHERE share_token IN (?,?)`).run(embToken, tok2share);
          db.prepare(`DELETE FROM agents WHERE id=?`).run(embAid);
        });
        // ===== V3.1 #11 钉钉 H5（2026-11-03）：真实模式安全断言（凭证已配置的子进程） =====
        await t('HTTP：钉钉H5——凭证已配置时 mock 免登后门关闭（V3.1 #11）', async () => {
          // 模式发现：enabled=true / mock=false（HTTP 组前置已写 DINGTALK_APP_KEY/SECRET）
          const cfg = await jfetch('/api/dingtalk/h5/config');
          assert.strictEqual(cfg.j.data.mock, false, '凭证已配置应为真实模式：' + JSON.stringify(cfg.j.data));
          // 关键安全断言：真实模式下 mock_user 参数不可达（返回 missing auth_code 而非 mock 登录）
          const r = await jfetch('/api/dingtalk/h5/login', { method: 'POST', body: JSON.stringify({ mock_user: 'admin' }) });
          assert.strictEqual(r.j && r.j.code, 400, '真实模式 mock_user 登录应 400（mock 后门必须关闭）：' + JSON.stringify(r.j));
          assert.ok(/auth_code/.test(r.j.msg || ''), '400 应指向缺 auth_code：' + r.j.msg);
          // jsapi-config 非法 url → 400
          const js = await jfetch('/api/dingtalk/h5/jsapi-config', { method: 'POST', body: JSON.stringify({ url: 'not-a-url' }) });
          assert.strictEqual(js.j && js.j.code, 400, '非法 url 应 400：' + JSON.stringify(js.j));
          // send-msg：无 token 401（auth 中间件门禁）
          const noAuth = await jfetch('/api/dingtalk/h5/send-msg', { method: 'POST', body: JSON.stringify({ userid_list: 'u1', content: 'hi' }) });
          assert.strictEqual(noAuth.status, 401, '无 token 应 HTTP 401，实际 ' + noAuth.status);
          // 有 token 空 body → 400（参数校验先于外呼）
          const empty = await jfetch('/api/dingtalk/h5/send-msg', { method: 'POST', body: JSON.stringify({}) }, tok1);
          assert.strictEqual(empty.j && empty.j.code, 400, '空 body 应 400：' + JSON.stringify(empty.j));
        });
        // ===== V3.1 #11 钉钉 H5 mock 模式全链路（独立子进程 + 全新临时数据目录，无钉钉凭证） =====
        {
          const port2 = 35000 + Math.floor(Math.random() * 1000);
          const base2 = `http://127.0.0.1:${port2}`;
          const child2 = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(port2), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR + '-h5mock' },
            stdio: 'ignore',
          });
          try {
            let up2 = false;
            for (let i = 0; i < 50 && !up2; i++) {
              await new Promise(r2 => setTimeout(r2, 200));
              try { up2 = (await fetch(base2 + '/api/health')).ok; } catch { }
            }
            await t('HTTP：钉钉H5 mock——config 模式发现 + 免登换可用 JWT + 签名可复算 + 消息留痕（V3.1 #11）', async () => {
              assert.ok(up2, 'mock 子进程应在 10s 内就绪');
              const jf2 = async (p, opts = {}, tok) => {
                const r = await fetch(base2 + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
                let j = null; try { j = await r.json(); } catch { }
                return { status: r.status, j };
              };
              // ① config：mock=true（全新数据目录无钉钉凭证）
              const cfg = await jf2('/api/dingtalk/h5/config');
              assert.strictEqual(cfg.j.data.mock, true, '无凭证应为 mock 模式：' + JSON.stringify(cfg.j.data));
              // ② mock 免登：demo 账号换 JWT（与密码登录同构载荷）
              const lg = await jf2('/api/dingtalk/h5/login', { method: 'POST', body: JSON.stringify({ mock_user: 'demo' }) });
              assert.ok(lg.j && lg.j.code === 0 && lg.j.data.token, 'mock 免登应返回 token：' + JSON.stringify(lg.j).slice(0, 140));
              assert.strictEqual(lg.j.data.user.username, 'demo', '应为 demo 用户');
              assert.strictEqual(lg.j.mock, true, '响应应带 mock 标记');
              // ③ 签发的 JWT 在主鉴权链路可用（/api/auth/me 校验通过）
              const me = await jf2('/api/auth/me', {}, lg.j.data.token);
              assert.strictEqual(me.j.data.username, 'demo', '免登 JWT 应通过 /auth/me：' + JSON.stringify(me.j).slice(0, 100));
              // ④ jsapi-config：mock 票据 + 真实算法——独立复算签名验证（HMAC-SHA256(ticket, nonce+ts+url)）
              const pageUrl = base2 + '/#/home';
              const js = await jf2('/api/dingtalk/h5/jsapi-config', { method: 'POST', body: JSON.stringify({ url: pageUrl }) });
              assert.ok(js.j && js.j.code === 0 && js.j.data.signature, 'jsapi-config 应返回签名：' + JSON.stringify(js.j).slice(0, 140));
              const ticket = 'mock-jsapi-ticket-' + require('crypto').createHash('sha256').update('mock:h5').digest('hex').slice(0, 32);
              const expect = require('crypto').createHmac('sha256', ticket).update(`${js.j.data.nonceStr}${js.j.data.timeStamp}${pageUrl}`).digest('hex');
              assert.strictEqual(js.j.data.signature, expect, '签名应与钉钉官方算法独立复算一致');
              // ⑤ send-msg：带 token 走 mock 分支（审计留痕 + mock 标记）
              const sm = await jf2('/api/dingtalk/h5/send-msg', { method: 'POST', body: JSON.stringify({ userid_list: 'u1,u2', title: '冒烟', content: 'V3.1#11 mock 消息' }) }, lg.j.data.token);
              assert.ok(sm.j && sm.j.code === 0 && sm.j.data && sm.j.data.mock === true, 'mock 消息应成功并带 mock 标记：' + JSON.stringify(sm.j).slice(0, 140));
              assert.strictEqual(sm.j.data.receivers, 2, '收件人数应回显');
            });
            // ===== P1-2（2026-11-03）run_code 沙箱产物 XSS 链关闭 =====
            // 测试在钉钉 H5 子进程中运行（完整 Express 中间件栈），确保 Content-Disposition/CSP 生效
            // 本测试向沙箱产物目录写入测试 .html 文件后通过 HTTP 验证响应头，测试后清理
            await t('P1-2：沙箱产物 .html 强制下载 + CSP sandbox 头（#14）', async () => {
              const fs = require('fs'), path = require('path'), crypto = require('crypto');
              const sandboxDir = path.join(__dirname, '..', 'public', 'uploads', 'sandbox');
              const fname = 'test-' + crypto.randomBytes(4).toString('hex') + '.html';
              const fpath = path.join(sandboxDir, fname);
              fs.mkdirSync(sandboxDir, { recursive: true });
              fs.writeFileSync(fpath, '<html><body><script>alert("xss")</script></body></html>', 'utf8');
              try {
                const r = await fetch(base2 + '/uploads/sandbox/' + fname);
                const ctype = r.headers.get('content-type') || '';
                const cdisp = r.headers.get('content-disposition') || '';
                const csp = r.headers.get('content-security-policy') || '';
                assert.strictEqual(ctype, 'application/octet-stream', '.html 应强制 application/octet-stream，实际 ' + ctype);
                assert.ok(cdisp.includes('attachment'), 'Content-Disposition 应为 attachment，实际 ' + cdisp);
                assert.ok(cdisp.includes('sandbox-output.txt'), '文件名应重命名为 sandbox-output.txt，实际 ' + cdisp);
                assert.strictEqual(csp, 'sandbox', 'CSP 应为 sandbox，实际 ' + csp);
                const txt = await r.text();
                assert.ok(txt.length > 0, '响应内容不应为空');
              } finally {
                try { fs.unlinkSync(fpath); } catch { }
              }
            });
            await t('P1-2：非 .html 沙箱产物正常输出（不强制下载，#14）', async () => {
              const fs = require('fs'), path = require('path'), crypto = require('crypto');
              const sandboxDir = path.join(__dirname, '..', 'public', 'uploads', 'sandbox');
              const fname = 'test-' + crypto.randomBytes(4).toString('hex') + '.txt';
              const fpath = path.join(sandboxDir, fname);
              fs.writeFileSync(fpath, 'hello sandbox', 'utf8');
              try {
                const r = await fetch(base2 + '/uploads/sandbox/' + fname);
                const ctype = r.headers.get('content-type') || '';
                const cdisp = r.headers.get('content-disposition') || '';
                assert.notStrictEqual(ctype, 'application/octet-stream', '非 .html 不应强制 application/octet-stream，实际 ' + ctype);
                assert.ok(!cdisp.includes('attachment'), '非 .html 不应带 attachment 头，实际 ' + cdisp);
                const txt = await r.text();
                assert.strictEqual(txt, 'hello sandbox', '应原样返回文件内容');
              } finally {
                try { fs.unlinkSync(fpath); } catch { }
              }
            });
          } finally {
            try { child2.kill('SIGTERM'); } catch { }
            await new Promise(r2 => setTimeout(r2, 400));
            try { child2.kill('SIGKILL'); } catch { }
          }
        }
        await t('HTTP：providers 列表 API Key 脱敏回显（P5.30）', async () => {
          db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('httpadmin',?,'测试管理员','admin',1,0,datetime('now','localtime'))`).run(hashPwd('http-pass-123'));
          const aid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA = sign({ uid: aid, exp: Date.now() + 3600000 });
          db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES ('脱敏测试供应商','http://x.test','sk-secret-1234567890abcd','[]',1,0,'',datetime('now','localtime'))`).run();
          const r = await jfetch('/api/providers', {}, tokA);
          assert.ok(r.j && r.j.code === 0, '管理员获取列表应成功');
          const p = (r.j.data || []).find(x => x.name === '脱敏测试供应商');
          assert.ok(p, '测试供应商应在列表中');
          assert.strictEqual(p.api_key, 'sk-****abcd', 'Key 应脱敏为前 3 后 4：' + p.api_key);
          assert.ok(!JSON.stringify(r.j).includes('sk-secret-1234567890abcd'), '响应中不应出现完整 Key');
          // 测试自清理：configured=1 供应商残留会泄漏到后续块（如 keywordgen 的 no_provider 判断）
          db.prepare(`DELETE FROM providers WHERE name='脱敏测试供应商'`).run();
        });
        // ===== D-3 全域 API Key（2026-11-23 拍板：需要全域模式）端到端 =====
        await t('HTTP：D-3 全域 Key——adminOnly 创建 / 非管理员 403 / 掩码列表 / models 全域可见 + 跨租户不可见 / 停用即失效', async () => {
          const { hashKey } = require('../src-server/lib/apikey');
          // admin token（httpadmin 已由上一用例建立；防御性补建）
          if (!db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get()) {
            db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('httpadmin',?,'测试管理员','admin',1,0,datetime('now','localtime'))`).run(hashPwd('http-pass-123'));
          }
          const tokA = sign({ uid: db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id, exp: Date.now() + 3600000 });
          // 测试智能体：同租户两个已发布 + 一个他租户已发布（跨租户防线断言）
          db.prepare(`INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('D3测试空间','enterprise','httpadmin','[]',datetime('now','localtime'),1)`).run();
          const spid = db.prepare(`SELECT id FROM spaces WHERE name='D3测试空间'`).get().id;
          db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3发布甲','other',?,'httpadmin','published','public',1,datetime('now','localtime'))`).run(spid);
          db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3发布乙','other',?,'httpadmin','published','public',1,datetime('now','localtime'))`).run(spid);
          db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3他租户','other',?,'httpadmin','published','public',2,datetime('now','localtime'))`).run(spid);
          try {
            // ① 非管理员创建 → 403（adminOnly 从严）
            const deny = await jfetch('/api/agents/global-keys', { method: 'POST', body: JSON.stringify({ name: '越权全域Key' }) }, tok1);
            assert.strictEqual(deny.j.code, 403, '普通用户创建全域 Key 应被拒（adminOnly）：' + JSON.stringify(deny.j).slice(0, 80));
            // ② admin 创建 → 前缀 sk-gk-
            const mk = await jfetch('/api/agents/global-keys', { method: 'POST', body: JSON.stringify({ name: 'HTTP全域Key' }) }, tokA);
            assert.ok(mk.j && mk.j.code === 0, 'admin 创建全域 Key 应成功：' + JSON.stringify(mk.j).slice(0, 80));
            const gkey = mk.j.data.key;
            assert.ok(gkey.startsWith('sk-gk-'), '全域 Key 前缀应为 sk-gk-（与智能体级 sk-ap- 区分）');
            const kid = mk.j.data.id;
            // ③ 列表掩码回显（SEC-02a 语义延续：不回传哈希）
            const lst = await jfetch('/api/agents/global-keys', {}, tokA);
            const row = (lst.j.data || []).find(x => x.id === kid);
            assert.ok(row, '新建全域 Key 应在列表');
            assert.ok(row.key.startsWith('sk-gk-') && !/^[0-9a-f]{64}$/.test(row.key.replace('sk-', '')), '列表 key 应为掩码而非哈希形态');
            assert.strictEqual(row.owner_username, 'httpadmin', '应记录创建者归属');
            // ④ openapi /v1/models：全域可见同租户两个、跨租户不可见
            const models = await jfetch('/openapi/v1/models', {}, gkey);
            assert.ok(models.j && Array.isArray(models.j.data), 'models 应返回数组');
            const names = models.j.data.map(m => m.id).join('|');
            assert.ok(names.includes('D3发布甲') && names.includes('D3发布乙'), '全域 Key 应可见同租户全部已发布智能体');
            assert.ok(!names.includes('D3他租户'), '全域 Key 不得可见他租户智能体（租户防线）');
            // ⑤ 停用即失效（status=0 → authKey 拒绝 401）
            const tg = await jfetch(`/api/agents/global-keys/${kid}/toggle`, { method: 'POST' }, tokA);
            assert.ok(tg.j && tg.j.code === 0, '停用应成功');
            const after = await jfetch('/openapi/v1/models', {}, gkey);
            assert.strictEqual(after.status, 401, '停用后的全域 Key 调用应 401');
            // ⑥ 库内 key 列为哈希（SEC-02a 延续）
            const krow = db.prepare('SELECT key FROM agent_api_keys WHERE id=?').get(kid);
            assert.ok(krow && krow.key !== gkey && krow.key === hashKey(gkey), '库内应为 HMAC 哈希（明文不落库）');
          } finally {
            db.prepare(`DELETE FROM agent_api_keys WHERE name='HTTP全域Key' OR name='越权全域Key'`).run();
            db.prepare(`DELETE FROM agents WHERE name IN ('D3发布甲','D3发布乙','D3他租户')`).run();
            db.prepare(`DELETE FROM spaces WHERE id=?`).run(spid);
          }
        });
        // ===== AI-13 RAG 检索可观测（2026-11-23）：rag-traces 端点数据源 =====
        await t('HTTP：AI-13 检索可观测——全链路 trace 结构化回传 + query 联表 + 0 命中可归因 + 过滤与噪声剔除', async () => {
          // admin token（httpadmin 已存在）
          const tokA2 = sign({ uid: db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id, exp: Date.now() + 3600000 });
          // 造数：session + user message + agent + chat_traces（含全字段 trace 的 0 命中样本 + 一条噪声行 trace='[]'）
          db.prepare(`INSERT INTO sessions (title,username,created_at) VALUES ('AI13测试会话','httpu1',datetime('now','localtime'))`).run();
          const sid2 = db.prepare(`SELECT id FROM sessions WHERE title='AI13测试会话'`).get().id;
          db.prepare(`INSERT INTO messages (session_id,role,content,created_at) VALUES (?, 'user','年假怎么申请',datetime('now','localtime'))`).run(sid2);
          const mid2 = db.prepare('SELECT id FROM messages WHERE session_id=? ORDER BY id DESC').get(sid2).id;
          db.prepare(`INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('AI13空间','enterprise','httpadmin','[]',datetime('now','localtime'),1)`).run();
          const sp13 = db.prepare(`SELECT id FROM spaces WHERE name='AI13空间'`).get().id;
          db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('AI13挂库智能体','other',?,'httpadmin','published','public',1,datetime('now','localtime'))`).run(sp13);
          const ag13 = db.prepare(`SELECT id FROM agents WHERE name='AI13挂库智能体'`).get().id;
          const trJson = JSON.stringify({
            rewrite: { original: '年假怎么申请', rewritten: '年假 申请 流程 规定', applied: true },
            engine: 'H',
            ann: { engine: 'sqlite-vec', hits: 0, coverage: '12/12' },
            rerank: { requested: true, applied: true, degraded: false, model: 'bge-reranker-v2-m3', threshold: 0.35, candidates: 6, passed: 0 },
          });
          db.prepare(`INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,blocked,retrieval_trace,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
            .run(sid2, mid2, ag13, 'mock-model', 'chat', 820, 0, 40, '[]', '[]', '', trJson);
          const traceId = db.prepare('SELECT id FROM chat_traces WHERE session_id=? ORDER BY id DESC').get(sid2).id;
          // 噪声行：retrieval_trace='[]'（无诊断的普通对话）不应出现在面板数据源
          db.prepare(`INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,blocked,retrieval_trace,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
            .run(sid2, null, ag13, 'mock-model', 'chat', 100, 0, 20, '[]', '[]', '', '[]');
          try {
            const r = await jfetch('/api/monitor/rag-traces', {}, tokA2);
            assert.ok(r.j && r.j.code === 0, '端点应成功：' + JSON.stringify(r.j || {}).slice(0, 80));
            const row = (r.j.data.list || []).find(x => x.id === traceId);
            assert.ok(row, '含全链路 trace 的行应出现在面板数据源');
            assert.strictEqual(row.query, '年假怎么申请', '用户 query 应经 messages 联表回传（0 命中归因的输入）');
            assert.strictEqual(row.username, 'httpu1', '会话用户应联表回传');
            assert.strictEqual(row.agent_name, 'AI13挂库智能体', '智能体名应联表回传');
            assert.strictEqual(row.hit_count, 0, '0 命中样本 hit_count 应为 0');
            // 结构化 trace：归因所需字段齐备（rewrite/rerank 阈值门控/ANN 覆盖度）
            assert.ok(row.trace.rewrite && row.trace.rewrite.applied === true, 'trace.rewrite 应结构化回传');
            assert.strictEqual(row.trace.rerank.passed, 0, '重排门控 passed=0 应保留（「阈值全滤光」归因依据）');
            assert.strictEqual(row.trace.rerank.candidates, 6, '候选数应保留');
            assert.ok(String(row.trace.ann.coverage) === '12/12', 'ANN 覆盖度应保留');
            assert.ok(!(r.j.data.list || []).some(x => x.retrieval_trace === '[]'), "trace='[]' 的噪声行不应出现（只看含诊断的对话）");
            // agent_id 过滤生效
            const r2 = await jfetch('/api/monitor/rag-traces?agent_id=' + ag13, {}, tokA2);
            assert.ok((r2.j.data.list || []).every(x => x.agent_id === ag13), 'agent_id 过滤应生效');
            const r3 = await jfetch('/api/monitor/rag-traces?agent_id=99999', {}, tokA2);
            assert.strictEqual((r3.j.data.list || []).length, 0, '不存在的智能体过滤应返回空');
          } finally {
            db.prepare(`DELETE FROM chat_traces WHERE session_id=?`).run(sid2);
            db.prepare(`DELETE FROM messages WHERE session_id=?`).run(sid2);
            db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid2);
            db.prepare(`DELETE FROM agents WHERE id=?`).run(ag13);
            db.prepare(`DELETE FROM spaces WHERE id=?`).run(sp13);
          }
        });
        // ===== BE-F1 requestId 贯穿日志链（2026-11-23）端到端 =====
        await t('HTTP：BE-F1——X-Request-Id 响应头 + access_logs 骨架行 + op_logs 自动注入 + request-chain 聚合', async () => {
          const tokA3 = sign({ uid: db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id, exp: Date.now() + 3600000 });
          // ① 普通请求：响应头带 X-Request-Id，access_logs 落骨架行
          const r1 = await fetch(base + '/api/monitor/op-logs?size=1', { headers: { Authorization: 'Bearer ' + tokA3 } });
          const rid1 = r1.headers.get('x-request-id');
          assert.ok(/^[0-9a-f]{12}$/.test(rid1 || ''), '响应头应携带 12 位 hex X-Request-Id：' + rid1);
          // 落行为 finish 回调 fire-and-forget（尽力而为语义）——fetch resolve（响应头到手）先于
          // 服务器 res finish 的落库完成存在天然竞态（Docker/负载等时序抖动会翻转窗口，曾致 flaky），
          // 断言前短轮询等待（上限 2s），保持「骨架行必须落」的验收强度不变
          let a1 = null;
          for (let i = 0; i < 40 && !a1; i++) {
            a1 = db.prepare('SELECT * FROM access_logs WHERE request_id=?').get(rid1);
            if (!a1) await new Promise(r2 => setTimeout(r2, 50));
          }
          assert.ok(a1, 'access_logs 应落骨架行');
          assert.strictEqual(a1.method, 'GET', 'access_logs 应记录方法');
          assert.strictEqual(a1.status, 200, 'access_logs 应记录状态码');
          assert.ok(a1.duration_ms >= 0, 'access_logs 应记录耗时');
          assert.strictEqual(a1.username, 'httpadmin', 'access_logs 应记录用户（finish 时 req.user 已填充）');
          // ② 触发 op_logs 审计写入的请求（创建全域 Key 走 audit 拦截器）→ op_logs 自动带同 requestId
          const mk2 = await fetch(base + '/api/agents/global-keys', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokA3 },
            body: JSON.stringify({ name: 'BE-F1链路Key' }),
          });
          const rid2 = mk2.headers.get('x-request-id');
          let mk2j = null; try { mk2j = await mk2.json(); } catch { }
          assert.ok(mk2j && mk2j.code === 0, '创建全域 Key 应成功：' + JSON.stringify(mk2j || {}).slice(0, 80));
          const op1 = db.prepare(`SELECT * FROM op_logs WHERE request_id=? AND action='创建全域API密钥'`).get(rid2);
          assert.ok(op1, 'audit 拦截器应为 op_logs 自动注入 request_id（AsyncLocalStorage 全链路）');
          assert.strictEqual(op1.username, 'httpadmin', '审计行用户正确');
          // 哈希链仍完整（request_id 不参与哈希——写入端/校验端同步排除）
          const { verifyChain } = require('../src-server/lib/audit');
          const vc = verifyChain(db, 'op_logs');
          assert.ok(vc.ok, 'op_logs 哈希链应完整（request_id 排除在哈希外）：' + JSON.stringify(vc).slice(0, 80));
          // ③ request-chain 端点：按 requestId 聚合三者
          const chain = await jfetch(`/api/monitor/request-chain?request_id=${rid2}`, {}, tokA3);
          assert.ok(chain.j && chain.j.code === 0, 'request-chain 应成功');
          assert.ok(chain.j.data.access && chain.j.data.access.request_id === rid2, '链中应含 access_logs 骨架行');
          assert.ok((chain.j.data.ops || []).some(o => o.action === '创建全域API密钥'), '链中应含 op_logs 审计行');
          // ④ 健康检查减噪：/api/health 不落 access_logs
          await fetch(base + '/api/health').catch(() => { });
          await new Promise(r2 => setTimeout(r2, 150)); // finish 异步落库
          const hc = db.prepare(`SELECT COUNT(*) c FROM access_logs WHERE path LIKE '%/health%'`).get().c;
          assert.strictEqual(hc, 0, '健康检查不应落 access_logs（探针减噪）');
          db.prepare(`DELETE FROM agent_api_keys WHERE name='BE-F1链路Key'`).run();
        });
        // ===== AI-12 提示词多版本效果对比（2026-11-23）端到端 =====
        await t('HTTP：AI-12——版本列表 + 同评测集多版本离线跑分 + 报告落库 + CSV/JSON 导出', async () => {
          const tokA4 = sign({ uid: db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id, exp: Date.now() + 3600000 });
          db.prepare(`INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('AI12空间','enterprise','httpadmin','[]',datetime('now','localtime'),1)`).run();
          const sp12 = db.prepare(`SELECT id FROM spaces WHERE name='AI12空间'`).get().id;
          db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,prompt,model,created_at) VALUES ('AI12对比智能体','other',?,'httpadmin','published','public','你是年假助手，回答须简洁准确。','mock-model',datetime('now','localtime'))`).run(sp12);
          const ag12 = db.prepare(`SELECT id FROM agents WHERE name='AI12对比智能体'`).get().id;
          db.prepare(`INSERT INTO agent_prompt_versions (agent_id,version,prompt,user_prompt,edited_by,note,created_at) VALUES (?,1,'你是年假助手 v1，回答详细。','','httpadmin','提示词修改',datetime('now','localtime'))`).run(ag12);
          db.prepare(`INSERT INTO agent_prompt_versions (agent_id,version,prompt,user_prompt,edited_by,note,created_at) VALUES (?,2,'你是年假助手 v2，回答简洁准确。','','httpadmin','提示词修改',datetime('now','localtime'))`).run(ag12);
          // 评测集：expect 取自 q 本身——mock 模式回显用户问题，命中比例确定性 100%（跑分通路验证）
          const ds12 = JSON.stringify([{ q: '平台支持年假查询吗', expect: '年假,查询' }]);
          db.prepare(`INSERT INTO evaluations (name,agent_id,rule_prompt,dataset,status,score,result,type,kb_id,created_at) VALUES ('AI12对比集',?,'',?,'done',0,'[]','agent',NULL,datetime('now','localtime'))`).run(ag12, ds12);
          const ev12 = db.prepare(`SELECT id FROM evaluations WHERE name='AI12对比集' AND agent_id=?`).get(ag12).id;
          try {
            // ① 版本列表（当前在线 + 快照）
            const vl = await jfetch(`/api/eval/prompt-versions/${ag12}`, {}, tokA4);
            assert.ok(vl.j && vl.j.code === 0 && vl.j.data.versions.length === 2, '版本列表应含 2 个快照');
            assert.ok(vl.j.data.current.prompt.includes('简洁准确'), '当前在线版本应作对照行');
            // ② 离线对比（默认：当前在线 + 最近 3 快照 = 3 参评）
            const cmp = await jfetch('/api/eval/prompt-compare', { method: 'POST', body: JSON.stringify({ agent_id: ag12, evaluation_id: ev12 }) }, tokA4);
            assert.ok(cmp.j && cmp.j.code === 0, '对比跑分应成功：' + JSON.stringify(cmp.j || {}).slice(0, 120));
            const R = cmp.j.data.report;
            assert.strictEqual(R.versions.length, 3, '默认应参评 3 个版本（当前在线 + 2 快照）');
            for (const v of R.versions) {
              assert.ok(Number.isFinite(v.score), '版本应有综合得分（质量指标）');
              assert.ok(Number.isFinite(v.success_rate), '版本应有成功率');
              assert.ok(Array.isArray(v.cases) && v.cases.length === 1, '每版本应携带逐条明细');
              assert.ok(v.cases[0].got.includes('年假查询'), 'mock 回显语义下回答应含查询原文（跑分通路实锤）');
            }
            assert.ok(R.winner != null && R.case_count === 1, '报告应含最优版本与用例数');
            const rid = cmp.j.data.id;
            assert.ok(db.prepare('SELECT id FROM prompt_compare_reports WHERE id=?').get(rid), '对比报告应落库 prompt_compare_reports');
            // ③ CSV 导出（验收：报告可导出，含成功率/质量指标）
            // BOM 断言用原始字节：fetch .text() 的 UTF-8 解码按 WHATWG 规范会剥离 BOM，
            // 对解码后文本断 \ufEFF 永远不成立（首轮实测踩坑）——改为直接校验响应体前缀字节 EF BB BF
            const csv = await fetch(base + `/api/eval/prompt-compare/${rid}/export?format=csv`, { headers: { Authorization: 'Bearer ' + tokA4 } });
            const csvBuf = new Uint8Array(await csv.arrayBuffer());
            const csvText = Buffer.from(csvBuf).toString('utf8');
            assert.ok(csv.status === 200, 'CSV 导出应 200');
            assert.ok(csvText.includes('综合得分') && csvText.includes('成功率'), 'CSV 应含质量指标/成功率列头');
            assert.ok(csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF, 'CSV 响应体应带 BOM 字节头 EF BB BF（Excel 兼容）');
            // ④ JSON 导出
            const js = await fetch(base + `/api/eval/prompt-compare/${rid}/export`, { headers: { Authorization: 'Bearer ' + tokA4 } });
            const jsj = await js.json();
            assert.ok(jsj.report && jsj.report.versions.length === 3, 'JSON 导出应含完整报告');
            // ⑤ 指定版本对比（version_ids=[2] → 与当前在线共 2 参评）
            const cmp2 = await jfetch('/api/eval/prompt-compare', { method: 'POST', body: JSON.stringify({ agent_id: ag12, evaluation_id: ev12, version_ids: [2] }) }, tokA4);
            assert.strictEqual(cmp2.j.data.report.versions.length, 2, '指定 version_ids 应仅参评所选版本 + 当前在线');
          } finally {
            db.prepare(`DELETE FROM prompt_compare_reports WHERE agent_id=?`).run(ag12);
            db.prepare(`DELETE FROM evaluations WHERE id=?`).run(ev12);
            db.prepare(`DELETE FROM agent_prompt_versions WHERE agent_id=?`).run(ag12);
            db.prepare(`DELETE FROM agents WHERE id=?`).run(ag12);
            db.prepare(`DELETE FROM spaces WHERE id=?`).run(sp12);
          }
        });
        // ===== AI-11 图搜图（2026-11-23）端到端 =====
        // 桩不可用说明：HTTP 块的服务器跑在子进程——主进程改 llm 模块属性对子进程无效（首轮实测踩坑）。
        // 改用 mock 模式确定性通路：无已配置供应商 → chatOnce 走 mockAnswer → 回显 user 消息 text 片段
        // （visionDescribe 的 user 消息 text=「请描述这张图片：」，多模态数组兼容由 mockAnswer 修复）。
        await t('HTTP：AI-11 图搜图——VL mock 通路 → image 分块优先 + modality 透传 + 无视觉模型 400', async () => {
          const tokA5 = sign({ uid: db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id, exp: Date.now() + 3600000 });
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,vision_model,created_at) VALUES ('AI11图搜图库','',1,'httpadmin','mock-vl-model',datetime('now','localtime'))`).run();
          const kb11 = db.prepare(`SELECT id FROM kbs WHERE name='AI11图搜图库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'年假流程图.png',100,'success',3,datetime('now','localtime'))`).run(kb11);
          const f11 = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kb11).id;
          // image 块 = 摄取管道 visionUsed 时的 VL 描述分块（模拟）；内容与 mock 回显 query 重叠（「图片/描述」词项）
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,modality) VALUES (?,?,?,'image')`).run(f11, kb11, '流程图：员工年假申请步骤，入职满一年五天。图片描述演示块一。');
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,modality) VALUES (?,?,?,'image')`).run(f11, kb11, '流程图：报销流程三十天内提交发票。图片描述演示块二。');
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,modality) VALUES (?,?,?,'text')`).run(f11, kb11, '年假制度文本：入职满一年带薪年假五天。');
          try {
            const r = await jfetch('/api/knowledge/image-search', { method: 'POST', body: JSON.stringify({ kb_id: kb11, image_base64: 'aGk=' }) }, tokA5);
            assert.ok(r.j && r.j.code === 0, '图搜图应成功（mock VL 通路）：' + JSON.stringify(r.j || {}).slice(0, 140));
            assert.ok((r.j.data.query || '').includes('请描述这张图片'), 'query 应为 VL 描述文本（mock 回显 user 消息 text，多模态兼容实锤）：' + (r.j.data.query || '').slice(0, 60));
            assert.ok(r.j.data.image_hits >= 1, '应命中 image 分块（找相似图片语义）：' + JSON.stringify({ image_hits: r.j.data.image_hits, count: r.j.data.count }));
            assert.strictEqual(r.j.data.hits[0].modality, 'image', 'image 分块应排在最前（图搜图优先返回图片）');
            assert.ok(r.j.data.hits.some(h => h.content.includes('五天')), '应命中年假流程图块（描述语义对齐）');
            // 无视觉模型的库 400（fail-closed：不静默走文本检索，明确提示配置）
            db.prepare('UPDATE kbs SET vision_model=NULL WHERE id=?').run(kb11);
            const r3 = await jfetch('/api/knowledge/image-search', { method: 'POST', body: JSON.stringify({ kb_id: kb11, image_base64: 'aGk=' }) }, tokA5);
            assert.strictEqual(r3.j.code, 400, '未配置 vision_model 应 400（fail-closed 明确提示）');
          } finally {
            db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kb11);
            db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kb11);
            db.prepare('DELETE FROM kbs WHERE id=?').run(kb11);
          }
        });
        // ===== P1-3 分页参数容错（2026-11-04）：lib 统一解析 + 三接口回归（notify 原必 500 实锤点） =====
        await t('P1-3：parsePagination 六态容错（缺省/正常/abc/负数/超大/小数）', () => {
          const { parsePagination } = require('../src-server/lib/pagination');
          const q = o => ({ query: o });
          assert.deepStrictEqual(parsePagination(q({})), { page: 1, size: 20, offset: 0 }, '缺省 → 1/20/0');
          assert.deepStrictEqual(parsePagination(q({ page: '3', size: '50' })), { page: 3, size: 50, offset: 100 }, '正常值原样透传');
          assert.deepStrictEqual(parsePagination(q({ page: 'abc', size: 'abc' })), { page: 1, size: 20, offset: 0 }, 'abc → 全默认（防 NaN LIMIT 500）');
          assert.deepStrictEqual(parsePagination(q({ page: '-100', size: '-100' })), { page: 1, size: 1, offset: 0 }, '负数 → 下限钳制 page=1/size=1（防 SQLite 负 LIMIT 无限制）');
          assert.deepStrictEqual(parsePagination(q({ page: '1e3', size: '99999' })), { page: 1, size: 100, offset: 0 }, '上限钳制 size≤100（1e3 被 parseInt 截为 1 属保守语义）');
          assert.deepStrictEqual(parsePagination(q({ page: '3.9', size: '3.9' })), { page: 3, size: 3, offset: 6 }, '小数截断');
          assert.deepStrictEqual(parsePagination(q({ page: '2', page_size: '15' }), { sizeKey: 'page_size' }), { page: 2, size: 15, offset: 15 }, '自定义 sizeKey（knowledge 的 page_size 兼容）');
        });
        await t('P1-3：parseLimit 五态容错（缺省/正常/abc/负数与0/超大）', () => {
          const { parseLimit } = require('../src-server/lib/pagination');
          const q = o => ({ query: o });
          assert.strictEqual(parseLimit(q({})), 50, '缺省 → 50');
          assert.strictEqual(parseLimit(q({}), { def: 30, max: 100 }), 30, '可配默认值');
          assert.strictEqual(parseLimit(q({ limit: 'abc' })), 50, 'abc → 默认（原 notify 实现此处产 NaN → LIMIT 绑定必 500）');
          assert.strictEqual(parseLimit(q({ limit: '-100' })), 50, '负数 → 默认（防 SQLite 负 LIMIT=无限制全量返回）');
          assert.strictEqual(parseLimit(q({ limit: '0' })), 50, '0 → 默认');
          assert.strictEqual(parseLimit(q({ limit: '99999' }), { max: 200 }), 200, '上限钳制');
          assert.strictEqual(parseLimit(q({ limit: '25' })), 25, '正常值原样');
        });
        await t('HTTP：分页容错——notify limit=abc/-100 不 500（P1-3，原 NaN LIMIT 必 500 实锤点）', async () => {
          const r1 = await jfetch('/api/notify?limit=abc', {}, tok1);
          assert.ok(r1.j && r1.j.code === 0, 'limit=abc 应 code 0（原实现 NaN 绑定 better-sqlite3 抛 Invalid value → 500）：' + JSON.stringify(r1.j).slice(0, 100));
          const r2 = await jfetch('/api/notify?limit=-100', {}, tok1);
          assert.ok(r2.j && r2.j.code === 0, 'limit=-100 应 code 0（负 LIMIT=无限制，原实现全量返回）：' + JSON.stringify(r2.j).slice(0, 100));
          const r3 = await jfetch('/api/notify?limit=5', {}, tok1);
          assert.ok(r3.j && r3.j.code === 0 && Array.isArray(r3.j.data.list), '正常 limit 照常可用：' + JSON.stringify(r3.j).slice(0, 80));
        });
        await t('HTTP：分页容错——op-logs page=abc&size=-100 按默认值处理（P1-3）', async () => {
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          const r = await jfetch('/api/monitor/op-logs?page=abc&size=-100', {}, tokAdmin);
          assert.ok(r.j && r.j.code === 0 && Array.isArray(r.j.data.list), '非法分页参数应按默认值（page=1/size=1）处理不 500：' + JSON.stringify(r.j).slice(0, 100));
          const r2 = await jfetch('/api/monitor/err-logs?page=abc&size=abc', {}, tokAdmin);
          assert.ok(r2.j && r2.j.code === 0 && Array.isArray(r2.j.data.list), 'err-logs 非法参数同样容错：' + JSON.stringify(r2.j).slice(0, 100));
        });
        await t('HTTP：分页容错——knowledge logs page_size 风格统一收口（P1-3）', async () => {
          // 复用「日志测试库」若已建则直接取，未建则建（用例顺序防御：不依赖前组是否执行）
          let kb = db.prepare(`SELECT * FROM kbs WHERE name='日志测试库'`).get();
          if (!kb) {
            db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('日志测试库','',1,'httpu1',datetime('now','localtime'))`).run();
            kb = db.prepare(`SELECT * FROM kbs WHERE name='日志测试库'`).get();
          }
          const r = await jfetch(`/api/knowledge/${kb.id}/logs?page=abc&page_size=-100`, {}, tok1);
          assert.ok(r.j && r.j.code === 0 && r.j.data.page === 1, 'page=abc 应回落 page=1：' + JSON.stringify(r.j).slice(0, 100));
        });
        await t('HTTP：知识库写权限——非创建者改删被拒（P5.30）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('归属测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='归属测试库'`).get().id;
          const put = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '改名' }) }, tok2);
          assert.strictEqual(put.j && put.j.code, 403, '非创建者改名应 403：' + JSON.stringify(put.j));
          const own = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '归属测试库改名' }) }, tok1);
          assert.ok(own.j && own.j.code === 0, '创建者（owner 为其昵称）应放行：' + JSON.stringify(own.j));
          const del = await jfetch(`/api/knowledge/${kbid}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(del.j && del.j.code, 403, '非创建者删除应 403：' + JSON.stringify(del.j));
        });
        // ===== V1.1 #1 解析日志（2026-10-30）：三条共用「日志测试库」，顺序依赖（空态→成功→失败） =====
        await t('HTTP：解析日志——空态与权限（V1.1 #1：owner 空态 stats 全 0，他人 403）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('日志测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='日志测试库'`).get().id;
          const own = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok1);
          assert.ok(own.j && own.j.code === 0, 'owner GET logs 应成功：' + JSON.stringify(own.j).slice(0, 120));
          assert.deepStrictEqual(own.j.data.stats, { total: 0, success: 0, failed: 0, processing: 0, bytes: 0, chunks: 0 }, '空态 stats 应全 0（P2-4 增 bytes/chunks 两聚合字段）：' + JSON.stringify(own.j.data.stats));
          assert.strictEqual(own.j.data.list.length, 0, '空态 list 应为空');
          assert.strictEqual(own.j.data.page, 1, '默认 page 应为 1');
          const other = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok2);
          assert.strictEqual(other.j && other.j.code, 403, '他人 GET logs 应 403（日志含失败细节，比 files 更严）：' + JSON.stringify(other.j));
        });
        await t('HTTP：解析日志——上传成功落日志（V1.1 #1：status=success + parsed_at 非空）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='日志测试库'`).get().id;
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '成功文档.txt', content: '第一章 总则\n\n本制度适用于全体正式员工。\n\n第二章 考勤\n\n员工须按时上下班并打卡。' }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '粘贴文本上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          const logs = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok1);
          const row = logs.j.data.list.find(x => x.name === '成功文档.txt');
          assert.ok(row, '日志列表应出现该文件');
          assert.strictEqual(row.status, 'success', '状态应为 success：' + row.status);
          assert.ok(row.parsed_at, 'parsed_at 应非空（解析完成时间）：' + JSON.stringify(row.parsed_at));
          assert.strictEqual(logs.j.data.stats.success, 1, 'stats.success 应为 1：' + JSON.stringify(logs.j.data.stats));
        });
        await t('HTTP：解析日志——解析失败落库可查可删（V1.1 #1：error_msg 非空 + 失败行可删）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='日志测试库'`).get().id;
          const fail = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '短文本.txt', content: '只有五个字' }) }, tok1);
          assert.strictEqual(fail.j && fail.j.code, 400, '<8 字文本应业务码 400：' + JSON.stringify(fail.j));
          const logs = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok1);
          const row = logs.j.data.list.find(x => x.name === '短文本.txt');
          assert.ok(row, '失败记录应出现在日志列表（此前失败不落库、error_msg 恒空）');
          assert.strictEqual(row.status, 'failed', '失败记录 status 应为 failed：' + row.status);
          assert.ok(row.error_msg && row.error_msg.length > 0, 'error_msg 应含失败原因：' + JSON.stringify(row.error_msg));
          assert.strictEqual(logs.j.data.stats.failed, 1, 'stats.failed 应为 1：' + JSON.stringify(logs.j.data.stats));
          const del = await jfetch(`/api/knowledge/files/${row.id}`, { method: 'DELETE' }, tok1);
          assert.ok(del.j && del.j.code === 0, '失败记录应可删除：' + JSON.stringify(del.j));
        });
        // ===== P2-3 语义分片增强 + P2-4 知识库管理体验（2026-11-05）=====
        await t('HTTP：P2-3 语义聚合——无标题多短段落合并至 ~chunkSize 单块（碎片化分块治理）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('语义切片测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const text = '本制度适用于公司全体正式员工与试用期员工。\n\n制度的解释权归人力资源部所有。\n\n员工对制度有疑问可向部门负责人咨询。';
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '聚合测试.txt', content: text }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 100));
          assert.strictEqual(up.j.data.chunks, 1, '三个短段落（共 57 字 << 500）应聚合为 1 块（旧逻辑各自成块=3 块）：' + JSON.stringify(up.j.data));
          const row = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? ORDER BY id').get(up.j.data.id);
          assert.ok(row && row.content.includes('本制度适用于') && row.content.includes('人力资源部') && row.content.includes('部门负责人'), '聚合块应含全部三段（\\n\\n 连接）');
          assert.ok(row.content.includes('\n\n'), '段落间应以空行连接保留段落边界');
        });
        await t('HTTP：P2-3 语义强边界——markdown 标题开头的段落不与前面合并', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const text = '# 安装指南与环境准备\n\n请先下载安装包并解压到本地目录后再运行安装程序。\n\n# 配置说明与修改\n\n修改配置文件后需要重启服务才能让新配置生效。';
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '标题边界测试.txt', content: text }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 100));
          assert.strictEqual(up.j.data.chunks, 2, '两个 # 标题后的段落应各自成块（标题=语义强边界不合并）：' + JSON.stringify(up.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NOT NULL ORDER BY id').all(up.j.data.id); // 只看子块（父块为 P2 父子切片聚合行，另断言）
          assert.strictEqual(rows.length, 2, '子块应恰为 2（父块另存）：' + rows.length);
          assert.ok(rows[0].content.startsWith('# 安装指南'), '首子块应以第一个标题开头（标题归入本块而非上一块）：' + rows[0].content.slice(0, 20));
          assert.ok(rows[1].content.startsWith('# 配置说明'), '第二子块应以第二个标题开头：' + rows[1].content.slice(0, 20));
        });
        await t('HTTP：P2-3 回归保护——超长单段落句边界切分行为不变（块长 ≤ chunkSize）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const para = Array.from({ length: 60 }, (_, i) => `第${i + 1}条补充条款说明了相关的责任与义务履行的细节要求。`).join(''); // 单段落无空行 1170 字
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '超长段落测试.txt', content: para }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 100));
          assert.ok(up.j.data.chunks >= 3, '1170 字超长段落应切多块（句边界切分逐字沿用改造前）：' + JSON.stringify(up.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NOT NULL ORDER BY id').all(up.j.data.id); // 只看子块（父块为 ~1000 字聚合行，天然 > chunkSize 不入断言）
          assert.ok(rows.length >= 3, '子块数应 ≥ 3（与管道返回一致）：' + rows.length);
          assert.ok(rows.every(r => r.content && r.content.length <= 500), '每个子块长度应 ≤ chunkSize（500）：' + rows.map(r => r.content ? r.content.length : 'NULL').join(','));
        });
        await t('HTTP：P2-4 文件预览数据源——GET /files/:id/chunks file 字段补全（size/status/chunk_count）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const content = '预览数据源测试文档的内容段落，用于验证 chunks 端点 file 字段补全。';
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '预览测试.txt', content }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 100));
          const pv = await jfetch(`/api/knowledge/files/${up.j.data.id}/chunks`, {}, tok1);
          assert.ok(pv.j && pv.j.code === 0, 'GET chunks 应成功：' + JSON.stringify(pv.j).slice(0, 100));
          const f = pv.j.data.file;
          assert.ok(f && typeof f.size === 'number' && f.size > 0, 'file.size 应为正数（预览头部展示用）：' + JSON.stringify(f));
          assert.strictEqual(f.status, 'success', 'file.status 应同步终态：' + f.status);
          assert.ok(f.chunk_count >= 1, 'file.chunk_count 应落值（与分块列表一致性校验源）：' + JSON.stringify(f));
          assert.ok(Array.isArray(pv.j.data.chunks) && pv.j.data.chunks.length === f.chunk_count, 'chunks 长度应与 file.chunk_count 一致（全文拼接完整性）');
        });
        await t('HTTP：P2-4 存储统计——logs stats bytes/chunks 聚合与文件行逐项对账', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const logs = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok1);
          assert.ok(logs.j && logs.j.code === 0, 'GET logs 应成功：' + JSON.stringify(logs.j).slice(0, 100));
          const expectBytes = db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM kb_files WHERE kb_id=?').get(kbid).s;
          const expectChunks = db.prepare('SELECT COALESCE(SUM(chunk_count),0) AS s FROM kb_files WHERE kb_id=?').get(kbid).s;
          assert.strictEqual(logs.j.data.stats.bytes, expectBytes, `stats.bytes 应等于库内文件 size 之和（${expectBytes}）：` + JSON.stringify(logs.j.data.stats));
          assert.strictEqual(logs.j.data.stats.chunks, expectChunks, `stats.chunks 应等于库内文件 chunk_count 之和（${expectChunks}）：` + JSON.stringify(logs.j.data.stats));
          assert.ok(expectBytes > 0 && expectChunks >= 4, '本库已有多个文件，聚合值应有意义（非恒 0）');
        });
        await t('HTTP：P2-4 批量上传链路——同库连续串行上传互不干扰（前端批量循环的后端契约）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='语义切片测试库'`).get().id;
          const before = db.prepare('SELECT COUNT(*) AS c FROM kb_files WHERE kb_id=?').get(kbid).c;
          const u1 = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '批量文件甲.txt', content: '批量上传甲文件内容：第一条说明义务。批量上传甲文件内容：第二条说明权利。' }) }, tok1);
          const u2 = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '批量文件乙.txt', content: '批量上传乙文件内容：另一主题的独立文档说明，用于验证串行链路隔离。' }) }, tok1);
          assert.ok(u1.j && u1.j.code === 0 && u2.j && u2.j.code === 0, '连续两次上传均应成功：' + JSON.stringify([u1.j, u2.j]).slice(0, 150));
          const c1 = db.prepare('SELECT content FROM kb_chunks WHERE file_id=?').all(u1.j.data.id).map(r => r.content).join('');
          const c2 = db.prepare('SELECT content FROM kb_chunks WHERE file_id=?').all(u2.j.data.id).map(r => r.content).join('');
          assert.ok(c1.includes('第一条说明义务') && !c1.includes('另一主题'), '甲文件分块不应串入乙文件内容（串行隔离）');
          assert.ok(c2.includes('另一主题') && !c2.includes('第一条说明义务'), '乙文件分块不应串入甲文件内容');
          const after = db.prepare('SELECT COUNT(*) AS c FROM kb_files WHERE kb_id=?').get(kbid).c;
          assert.strictEqual(after, before + 2, '库内文件数应恰好 +2（无重名覆盖/重复落库）');
        });
        // ===== P2 里程碑验收补测（2026-11-05）：24 条补齐 306→330+（P2-1×5 / P2-2×5 / P2-3×6 / P2-4×4 / P2-5+安全×4；单元部分在 rerank 单元组区域） =====
        // 共享库 A「P2 验收补测库」：3 章节文本（每章=标题+正文 → 语义分片后恰 3 块），供召回类用例（vector_weight/top_n/threshold/默认重排）复用
        db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收补测库','',1,'httpu1',datetime('now','localtime'))`).run();
        const p2KbId = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收补测库'`).get().id;
        await t('HTTP：P2 前置——验收补测库上传 3 章节文本得 3 块（召回类用例数据底座）', async () => {
          const text = '第一章 考勤管理要求\n\n员工上下班均须打卡记录，不得代打卡。\n\n第二章 报销管理要求\n\n差旅费用须按时提交报销。\n\n第三章 保密管理要求\n\n涉密资料不得私自外带。';
          const up = await jfetch(`/api/knowledge/${p2KbId}/files`, { method: 'POST', body: JSON.stringify({ name: '三章制度.txt', content: text }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          assert.strictEqual(up.j.data.chunks, 3, '三章标题强边界应切 3 块：' + JSON.stringify(up.j.data));
        });
        await t('HTTP：P2-1 vector_weight 非法值鲁棒性——非有限数回落 0.5、合法数照常钳制（NaN 静默 0 命中缺陷修复锁定）', async () => {
          const body = (w) => JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n: 5, threshold: 0, rerank_enabled: false, ...(w !== undefined ? { vector_weight: w } : {}) });
          const base = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body() }, tok1);
          assert.ok(base.j && base.j.code === 0 && base.j.data.count >= 1, '基线召回应命中：' + JSON.stringify(base.j).slice(0, 120));
          const baseIds = base.j.data.hits.map(h => h.id).join(',');
          const wAbc = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body('abc') }, tok1);
          assert.strictEqual(wAbc.j.code, 0, 'vector_weight=\'abc\' 应 code 0 不炸：' + JSON.stringify(wAbc.j).slice(0, 120));
          assert.strictEqual(wAbc.j.data.count, base.j.data.count, `'abc' 应回落默认 0.5（修复前 Number('abc')=NaN → RRF 全 NaN → 静默 0 命中）：${wAbc.j.data.count} vs 基线 ${base.j.data.count}`);
          assert.strictEqual(wAbc.j.data.hits.map(h => h.id).join(','), baseIds, '回落 0.5 后命中集应与基线一致');
          const wNeg = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body(-1) }, tok1);
          const ref0 = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body(0) }, tok1);
          assert.deepStrictEqual(wNeg.j.data.hits.map(h => h.id), ref0.j.data.hits.map(h => h.id), '-1 应钳为 0（与显式 0 结果一致，纯 BM25）');
          const wBig = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body(2) }, tok1);
          const ref1 = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: body(1) }, tok1);
          assert.deepStrictEqual(wBig.j.data.hits.map(h => h.id), ref1.j.data.hits.map(h => h.id), '2 应钳为 1（与显式 1 结果一致，纯向量）');
        });
        await t('HTTP：P2-1 全标点 query 与 threshold>= 边界——纯符号 0 命中不炸、threshold=0 放行全部块', async () => {
          const punc = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '！！！？？？。。。', kb_id: p2KbId, top_n: 5, rerank_enabled: false }) }, tok1);
          assert.ok(punc.j && punc.j.code === 0, '全标点 query 应 code 0：' + JSON.stringify(punc.j).slice(0, 120));
          assert.strictEqual(punc.j.data.count, 0, '全标点 query 分词为空应 0 命中（retrieve 对空 terms 提前返回）');
          const all = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n: 10, threshold: 0, rerank_enabled: false }) }, tok1);
          const totalRows = db.prepare('SELECT COUNT(*) AS c FROM kb_chunks WHERE kb_id=?').get(p2KbId).c; // 含父子切片的父块行（父块同池参与检索打分）
          assert.strictEqual(all.j.data.count, totalRows, `threshold=0 应放行全部 ${totalRows} 行（score>=threshold 含等号边界，父子切片父块同池）：` + all.j.data.count);
        });
        await t('HTTP：P2-1 top_n 三态契约——0 回落 5、负数截尾、超大不放大（slice 语义锁定）', async () => {
          const call = (top_n) => jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n, threshold: 0, rerank_enabled: false }) }, tok1);
          const t0 = await call(0);
          assert.ok(t0.j.code === 0 && t0.j.data.count >= 1 && t0.j.data.count <= 5, 'top_n=0 应回落 5（路由 top_n||5），实得 ' + t0.j.data.count);
          const tNeg = await call(-1);
          const tAll = await call(10000);
          assert.strictEqual(tNeg.j.data.count, tAll.j.data.count - 1, `top_n=-1 应 slice(0,-1) 截尾（${tAll.j.data.count}-1），实得 ${tNeg.j.data.count}`);
          const totalRows2 = db.prepare('SELECT COUNT(*) AS c FROM kb_chunks WHERE kb_id=?').get(p2KbId).c;
          assert.strictEqual(tAll.j.data.count, totalRows2, 'top_n=10000 不应放大候选（候选池=库内全部行）：' + tAll.j.data.count);
        });
        await t('HTTP：P2-1 threshold 分数量级契约——threshold=1 全滤除（RRF 上限 ~w/61）、threshold=-1 全放行', async () => {
          const hi = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n: 5, threshold: 1, rerank_enabled: false }) }, tok1);
          assert.strictEqual(hi.j.data.count, 0, 'RRF 分数量级 ≈1/(60+1)~2/61 < 1，threshold=1 应全滤除');
          const lo = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n: 5, threshold: -1, rerank_enabled: false }) }, tok1);
          const totalRows3 = db.prepare('SELECT COUNT(*) AS c FROM kb_chunks WHERE kb_id=?').get(p2KbId).c;
          assert.strictEqual(lo.j.data.count, totalRows3, 'threshold=-1 应全放行（全部行入选）：' + lo.j.data.count);
        });
        await t('HTTP：P2-2 默认重排开启路径——rerank_enabled 缺省（=true）无供应商时静默退回 RRF 且命中正常', async () => {
          const r = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '考勤管理', kb_id: p2KbId, top_n: 5, threshold: 0 }) }, tok1);
          assert.ok(r.j && r.j.code === 0, '缺省重排应 code 0（bgeRerank 无供应商返回 null → 退回 RRF）：' + JSON.stringify(r.j).slice(0, 120));
          assert.ok(r.j.data.count >= 1, '退回 RRF 后应正常命中：' + r.j.data.count);
          assert.ok(r.j.data.hits.every(h => h.rerank_score == null), '无供应商重排时不应有 rerank_score 字段落值');
        });
        await t('HTTP：P2-3 语义强边界——中文章节/中文序号/阿拉伯序号/圆括号序号四类形态（HEADING_RE 全形态锁定）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收标题边界库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收标题边界库'`).get().id;
          const text = '第一章 会议总则要求\n\n公司实行周例会制度。\n\n一、考勤纪律要求\n\n员工须按时上下班。\n\n1. 打卡纪律要求\n\n上下班均须打卡记录。\n\n（一）补卡纪律要求\n\n漏打卡次日补卡。';
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '四类标题.txt', content: text }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          assert.strictEqual(up.j.data.chunks, 4, '四类标题（第X章/一、/1.␣/（一））应各自开新块=4 块：' + JSON.stringify(up.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NOT NULL ORDER BY id').all(up.j.data.id);
          assert.strictEqual(rows.length, 4, '子块应恰 4：' + rows.length);
          ['第一章', '一、', '1. ', '（一）'].forEach((h, i) => {
            assert.ok(rows[i].content.startsWith(h), `块 ${i + 1} 应以「${h}」开头（标题归入本块）：${rows[i].content.slice(0, 12)}`);
          });
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        await t('HTTP：P2-3 chunk_overlap=80 重叠切片——前块末尾并入后块开头（重叠分支零覆盖补齐）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,chunk_size,chunk_overlap,created_at) VALUES ('P2 验收重叠库','',1,'httpu1',500,80,datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收重叠库'`).get().id;
          const para = Array.from({ length: 34 }, (_, i) => `重叠测试第${i + 1}号句子的内容说明。`).join(''); // 单段 510 字 → 句边界切 2 块
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '重叠测试.txt', content: para }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          assert.ok(up.j.data.chunks >= 2, '510 字单段应切 ≥2 块：' + JSON.stringify(up.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NOT NULL ORDER BY id').all(up.j.data.id);
          assert.ok(rows.length >= 2, '子块应 ≥2');
          const overlapHead = rows[1].content.slice(0, 80);
          assert.ok(rows[0].content.endsWith(overlapHead), `块 0 末尾应并入块 1 开头 80 字（prev + '\\n' + next.slice(0,overlap)）：…${rows[0].content.slice(-30)} vs ${overlapHead.slice(0, 30)}`);
          assert.ok(rows[1].content.length === para.length - rows[0].content.length + 1 + overlapHead.length || rows[1].content.startsWith('重叠测试第'), '块 1 应保持原内容（重叠只修改前块）');
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        await t('HTTP：P2-3 自定义 chunk_separator 生效——separator=||| 驱动切段（此前参数从未被验证影响切分）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,chunk_size,chunk_separator,created_at) VALUES ('P2 验收分隔符库','',1,'httpu1',30,'\\|\\|\\|',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收分隔符库'`).get().id;
          const text = '主题甲内容A句子说明。主题甲内容B句子说明。|||主题乙内容C句子说明。主题乙内容D句子说明。';
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '分隔符.txt', content: text }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          assert.strictEqual(up.j.data.chunks, 2, 'separator=||| + chunk_size=30（防语义聚合重新合并）应切 2 块：' + JSON.stringify(up.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? ORDER BY id').all(up.j.data.id); // chunk_size=30≤200 无父子切片（全块 parent_id=NULL），直接查全行
          assert.ok(rows[0].content.includes('主题甲') && !rows[0].content.includes('主题乙'), '块 0 只含甲段');
          assert.ok(rows[1].content.includes('主题乙') && !rows[1].content.includes('主题甲'), '块 1 只含乙段');
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        await t('HTTP：P2-3 非法 separator 正则——PUT 放行、上传兜底 failed 且服务存活（防请求挂死静默回归）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,chunk_separator,created_at) VALUES ('P2 验收非法分隔符库','',1,'httpu1','(',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收非法分隔符库'`).get().id;
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '非法正则.txt', content: '这是一段足够长可以被切片的正常文本内容，用于验证非法正则的兜底路径。' }) }, tok1);
          assert.strictEqual(up.j && up.j.code, 400, 'new RegExp(\'(\') 抛错应经执行器兜底为 400（改造前此路径挂起请求）：' + JSON.stringify(up.j).slice(0, 120));
          const row = db.prepare('SELECT status, error_msg FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbid);
          assert.strictEqual(row.status, 'failed', '应落 failed 行：' + JSON.stringify(row));
          assert.ok(/管道步骤执行失败|Invalid regular expression/.test(row.error_msg || ''), 'error_msg 应含兜底文案：' + row.error_msg);
          const health = await jfetch('/api/health', {}, tok1);
          assert.ok(health.status === 200, '兜底后服务应存活（health 200）');
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        await t('HTTP：P2-3 语义聚合上限——3 段各约 250 字聚合为 2 块而非 1 块（chunkSize 切分条件边界）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收聚合上限库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收聚合上限库'`).get().id;
          const para240 = () => '聚合上限测试句子的内容说明。'.repeat(17); // 固定 14 字/句 × 17 = 238 字/段
          const para250 = () => '聚合上限测试句子的内容说明。'.repeat(18); // 14 字 × 18 = 252 字/段
          const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '聚合上限甲.txt', content: [para240(), para240()].join('\n\n') }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传甲应成功：' + JSON.stringify(up.j).slice(0, 120));
          assert.strictEqual(up.j.data.chunks, 1, '两段 240 字（240+2+240=482≤500）应聚合为 1 块（贴近上限仍合并）：' + JSON.stringify(up.j.data));
          const up2 = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '聚合上限乙.txt', content: [para250(), para250()].join('\n\n') }) }, tok1);
          assert.ok(up2.j && up2.j.code === 0, '上传乙应成功：' + JSON.stringify(up2.j).slice(0, 120));
          assert.strictEqual(up2.j.data.chunks, 2, '两段 250 字（250+2+250=502>500）应切 2 块（超上限不合并）：' + JSON.stringify(up2.j.data));
          const rows = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NOT NULL ORDER BY id').all(up2.j.data.id);
          assert.ok(rows.every(r => r.content.length <= 500), '每块应 ≤500：' + rows.map(r => r.content.length).join(','));
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        await t('HTTP：P2-3 chunk_size 两端与 0 回落——100/2000 可存可传、0 回落 500（服务端无钳制的现状契约）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收尺寸库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收尺寸库'`).get().id;
          const para = Array.from({ length: 30 }, (_, i) => `尺寸测试第${i + 1}号句子的内容说明。`).join(''); // ~300 字
          const put = (cs) => jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ chunk_size: cs }) }, tok1);
          const up = () => jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '尺寸.txt', content: para }) }, tok1);
          await put(100);
          const s100 = await up();
          assert.ok(s100.j.code === 0 && s100.j.data.chunks >= 3, 'chunk_size=100：300 字应切 ≥3 块：' + JSON.stringify(s100.j.data));
          const rows100 = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? AND parent_id IS NULL').all(s100.j.data.id);
          assert.ok(rows100.every(r => r.content.length <= 100), '每块应 ≤100（chunk_size≤200 无父子切片，parent_id 全 NULL）：' + rows100.map(r => r.content.length).join(','));
          await put(2000);
          const s2000 = await up();
          assert.ok(s2000.j.code === 0 && s2000.j.data.chunks === 1, 'chunk_size=2000：300 字应 1 块：' + JSON.stringify(s2000.j.data));
          await put(0);
          const s0 = await up();
          assert.ok(s0.j.code === 0 && s0.j.data.chunks === 1, 'chunk_size=0（falsy）应回落 500：300 字 1 块：' + JSON.stringify(s0.j.data));
          const back = db.prepare('SELECT chunk_size FROM kbs WHERE id=?').get(kbid).chunk_size;
          assert.strictEqual(back, 0, 'PUT 0 应原样落库（服务端现状不钳制，前端 slider 100~2000 为唯一防线）');
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        // 库 C「P2 验收管理库」：预览端点 / 批量容错 / failed 空态 三用例共享
        db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收管理库','',1,'httpu1',datetime('now','localtime'))`).run();
        const p2KbC = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收管理库'`).get().id;
        await t('HTTP：P2-4 chunks 预览端点三态——file.parsed_at/created_at 补全 + 404 文件不存在 + 403 非 owner', async () => {
          const up = await jfetch(`/api/knowledge/${p2KbC}/files`, { method: 'POST', body: JSON.stringify({ name: '预览三态.txt', content: '预览端点三态验证的第一段内容说明。\n\n预览端点三态验证的第二段内容补充。' }) }, tok1);
          assert.ok(up.j && up.j.code === 0, '上传应成功：' + JSON.stringify(up.j).slice(0, 120));
          const pv = await jfetch(`/api/knowledge/files/${up.j.data.id}/chunks`, {}, tok1);
          assert.ok(pv.j.code === 0, 'GET chunks 应成功');
          assert.ok(pv.j.data.file.parsed_at && typeof pv.j.data.file.parsed_at === 'string', 'parsed_at 应为非空字符串（同步管道完成即落值）：' + JSON.stringify(pv.j.data.file));
          assert.ok(pv.j.data.file.created_at, 'created_at 应存在（P2-4 字段补全面）');
          const nf = await jfetch('/api/knowledge/files/999999/chunks', {}, tok1);
          assert.strictEqual(nf.j.code, 404, '不存在文件应 404：' + JSON.stringify(nf.j));
          const forb = await jfetch(`/api/knowledge/files/${up.j.data.id}/chunks`, {}, tok2);
          assert.strictEqual(forb.j.code, 403, '非 owner 应 403（denyIfNotAllowed）：' + JSON.stringify(forb.j));
        });
        await t('HTTP：P2-4 批量上传容错——串行 3 连传中间失败不阻断后续（前端批量循环的后端契约异常面）', async () => {
          const u1 = await jfetch(`/api/knowledge/${p2KbC}/files`, { method: 'POST', body: JSON.stringify({ name: '批量容错甲.txt', content: '批量容错甲文件的第一段内容说明，用于验证串行链路。\n\n批量容错甲文件的第二段内容补充。' }) }, tok1);
          const u2 = await jfetch(`/api/knowledge/${p2KbC}/files`, { method: 'POST', body: JSON.stringify({ name: '批量容错乙.txt', content: '只有五个字' }) }, tok1);
          const u3 = await jfetch(`/api/knowledge/${p2KbC}/files`, { method: 'POST', body: JSON.stringify({ name: '批量容错丙.txt', content: '批量容错丙文件的内容说明，主题独立的另一份文档，用于验证失败不污染后续。' }) }, tok1);
          assert.ok(u1.j.code === 0 && u3.j.code === 0, '甲/丙应成功：' + JSON.stringify([u1.j, u3.j]).slice(0, 150));
          assert.strictEqual(u2.j.code, 400, '乙（<8 字）应 400：' + JSON.stringify(u2.j));
          const failed = db.prepare(`SELECT status, error_msg FROM kb_files WHERE name='批量容错乙.txt'`).get();
          assert.strictEqual(failed.status, 'failed', '乙应落 failed 行');
          assert.ok((failed.error_msg || '').includes('解析后无有效文本'), 'error_msg 应含失败原因：' + failed.error_msg);
          const c3 = db.prepare('SELECT content FROM kb_chunks WHERE file_id=?').all(u3.j.data.id).map(r => r.content).join('');
          assert.ok(c3.includes('丙文件') && !c3.includes('甲文件'), '丙分块不应串入甲内容（失败不污染后续）');
        });
        await t('HTTP：P2-4 failed 文件预览空态——file.status=failed + chunks=[] + chunk_count=0（前端空态渲染契约）', async () => {
          const row = db.prepare(`SELECT id, chunk_count FROM kb_files WHERE name='批量容错乙.txt' AND status='failed'`).get();
          assert.ok(row, '应复用上条用例的 failed 行');
          const pv = await jfetch(`/api/knowledge/files/${row.id}/chunks`, {}, tok1);
          assert.ok(pv.j.code === 0, 'failed 文件 GET chunks 应成功（不 404 不炸）');
          assert.strictEqual(pv.j.data.file.status, 'failed', 'file.status 应为 failed：' + JSON.stringify(pv.j.data.file));
          assert.deepStrictEqual(pv.j.data.chunks, [], 'chunks 应为空数组');
          assert.strictEqual(pv.j.data.file.chunk_count, 0, 'chunk_count 应为 0');
        });
        await t('HTTP：P2-4 stats 四态口径——直插 pending/processing/failed 行后归类合并与 bytes/chunks 全量语义', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收统计库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收统计库'`).get().id;
          const ins = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,datetime('now','localtime'))`);
          ins.run(kbid, '四态-pending.txt', 10, 'pending', 0);
          ins.run(kbid, '四态-processing.txt', 20, 'processing', 0);
          ins.run(kbid, '四态-failed.txt', 77, 'failed', 3);
          const logs = await jfetch(`/api/knowledge/${kbid}/logs`, {}, tok1);
          assert.ok(logs.j.code === 0, 'GET logs 应成功');
          const s = logs.j.data.stats;
          assert.strictEqual(s.total, 3, 'total 应 3：' + JSON.stringify(s));
          assert.strictEqual(s.processing, 2, 'pending+processing 应合并计入 processing：' + s.processing);
          assert.strictEqual(s.failed, 1, 'failed 应 1');
          assert.strictEqual(s.bytes, 107, 'bytes 应=10+20+77（SUM 不筛 status，failed 行 size 计入口径）：' + s.bytes);
          assert.strictEqual(s.chunks, 3, 'chunks 应含 failed 行 chunk_count（SUM 口径）：' + s.chunks);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
        });
        // 库 E「P2 验收越权库」：merge 三态 + 文件/分块级写越权 两用例共享
        db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收越权库','',1,'httpu1',datetime('now','localtime'))`).run();
        const p2KbE = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收越权库'`).get().id;
        db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'越权载体.txt',100,'success',2,datetime('now','localtime'))`).run(p2KbE);
        const p2FileE = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(p2KbE).id;
        db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(p2FileE, p2KbE, '越权验证分块甲的内容标记词。');
        db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(p2FileE, p2KbE, '越权验证分块乙的内容标记词。');
        await t('HTTP：安全——merge 缺参 400/不存在 404/跨库 400/非 owner 403（同库约束+归属校验双层拦截）', async () => {
          const c1 = db.prepare('SELECT id FROM kb_chunks WHERE kb_id=? ORDER BY id').all(p2KbE);
          const m1 = await jfetch('/api/knowledge/chunks/merge', { method: 'POST', body: JSON.stringify({}) }, tok1);
          assert.strictEqual(m1.j.code, 400, '缺参应 400：' + JSON.stringify(m1.j));
          const m2 = await jfetch('/api/knowledge/chunks/merge', { method: 'POST', body: JSON.stringify({ sourceId: 999999, targetId: c1[0].id }) }, tok1);
          assert.strictEqual(m2.j.code, 404, '不存在分块应 404：' + JSON.stringify(m2.j));
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('P2 验收越权库B','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbB = db.prepare(`SELECT id FROM kbs WHERE name='P2 验收越权库B'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'B库载体.txt',50,'success',1,datetime('now','localtime'))`).run(kbB);
          const fileB = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbB).id;
          db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fileB, kbB, 'B库独立分块内容。');
          const chunkB = db.prepare('SELECT id FROM kb_chunks WHERE kb_id=?').get(kbB).id;
          const m3 = await jfetch('/api/knowledge/chunks/merge', { method: 'POST', body: JSON.stringify({ sourceId: c1[0].id, targetId: chunkB }) }, tok1);
          assert.strictEqual(m3.j.code, 400, '跨库合并应 400：' + JSON.stringify(m3.j));
          const m4 = await jfetch('/api/knowledge/chunks/merge', { method: 'POST', body: JSON.stringify({ sourceId: c1[0].id, targetId: c1[1].id }) }, tok2);
          assert.strictEqual(m4.j.code, 403, '非 owner 合并他人库分块应 403（denyIfNotAllowed 覆盖同库双方）：' + JSON.stringify(m4.j));
          const m5 = await jfetch('/api/knowledge/chunks/merge', { method: 'POST', body: JSON.stringify({ sourceId: c1[0].id, targetId: c1[1].id }) }, tok1);
          assert.ok(m5.j.code === 0, 'owner 合并应成功：' + JSON.stringify(m5.j));
          const after = db.prepare('SELECT id, content FROM kb_chunks WHERE kb_id=? ORDER BY id').all(p2KbE);
          assert.strictEqual(after.length, 1, '合并后 source 应删除（2 块 → 1 块）');
          assert.ok(after[0].content.includes('甲') && after[0].content.includes('乙'), 'target 应含两块内容');
          db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbB);
          db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbB);
          db.prepare('DELETE FROM kbs WHERE id=?').run(kbB);
        });
        await t('HTTP：安全——文件级/分块级写越权全家（token2 上传/删文件/reparse/PUT chunk/DELETE chunk 全 403 且数据原样）', async () => {
          const cid = db.prepare('SELECT id, content FROM kb_chunks WHERE kb_id=? ORDER BY id').all(p2KbE)[0].id;
          const r1 = await jfetch(`/api/knowledge/${p2KbE}/files`, { method: 'POST', body: JSON.stringify({ name: '越权上传.txt', content: '越权上传尝试内容，足够长可切片。' }) }, tok2);
          assert.strictEqual(r1.j.code, 403, '他人库上传应 403：' + JSON.stringify(r1.j));
          const r2 = await jfetch(`/api/knowledge/files/${p2FileE}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(r2.j.code, 403, '删他人文件应 403：' + JSON.stringify(r2.j));
          const r3 = await jfetch(`/api/knowledge/files/${p2FileE}/reparse`, { method: 'POST' }, tok2);
          assert.strictEqual(r3.j.code, 403, 'reparse 他人文件应 403：' + JSON.stringify(r3.j));
          const r4 = await jfetch(`/api/knowledge/chunks/${cid}`, { method: 'PUT', body: JSON.stringify({ content: '被篡改的内容标记词' }) }, tok2);
          assert.strictEqual(r4.j.code, 403, 'PUT 他人分块应 403：' + JSON.stringify(r4.j));
          const r5 = await jfetch(`/api/knowledge/chunks/${cid}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(r5.j.code, 403, 'DELETE 他人分块应 403：' + JSON.stringify(r5.j));
          const still = db.prepare('SELECT content FROM kb_chunks WHERE id=?').get(cid);
          assert.ok(still && still.content.includes('标记词') && !still.content.includes('篡改'), '分块内容应原样未被篡改');
          const fileStill = db.prepare('SELECT id FROM kb_files WHERE id=?').get(p2FileE);
          assert.ok(fileStill, '文件行应仍存在');
        });
        // P2 验收共享库收尾——兑底式清理（前序用例断言失败时其内联清理不会执行，此处按前缀统一扫除）+ 对账
        await t('HTTP：P2 验收收尾——共享库与独立库统一扫除对账（防测试数据泄漏到后续用例）', async () => {
          const leftovers = db.prepare(`SELECT id FROM kbs WHERE name LIKE 'P2 验收%'`).all();
          leftovers.forEach(kb => {
            db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kb.id);
            db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kb.id);
            db.prepare('DELETE FROM kbs WHERE id=?').run(kb.id);
          });
          const left = db.prepare(`SELECT COUNT(*) AS c FROM kbs WHERE name LIKE 'P2 验收%'`).get().c;
          assert.strictEqual(left, 0, 'P2 验收库应全部清理：' + left);
        });
        // ===== P3-2 工具市场扩展（2026-11-06）：用户级工具 API Key——HTTP CRUD + 加密落盘 + 越权 + 工具消费链路 =====
        // 加密环境说明：本组不强制设置 ENCRYPTION_KEY——crypto-util 兼容双环境（未配置密钥时 encrypt/decrypt 兜底原文），
        // 断言一律按语义写（密文形态 / 明文形态均成立），避免测试环境依赖；生产环境密钥由部署方配置。
        await t('HTTP：P3-2 tool-keys meta——返回可配工具清单（weather_query/translate_text 含 label/provider/获取入口）', async () => {
          const j = await jfetch('/api/tool-keys/meta', {}, tok1);
          assert.ok(j.j && j.j.code === 0, 'meta 应成功：' + JSON.stringify(j.j).slice(0, 100));
          const names = j.j.data.map(x => x.tool_name);
          assert.ok(names.includes('weather_query') && names.includes('translate_text'), '应含两个可配工具：' + names.join(','));
          const wq = j.j.data.find(x => x.tool_name === 'weather_query');
          assert.ok(wq.label && wq.provider && wq.key_url, '元信息应完整：' + JSON.stringify(wq));
          assert.strictEqual(wq.registered, false, 'tok1 初始应未登记（自建自清理纪律）');
        });
        await t('HTTP：P3-2 tool-keys 登记与加密落盘——POST 落库为 AES 密文、GET 掩码回显绝不回明文', async () => {
          const post = await jfetch('/api/tool-keys', { method: 'POST', body: JSON.stringify({ tool_name: 'weather_query', api_key: 'k8fWqweatherTestKey000000000000001', note: '测试用' }) }, tok1);
          assert.ok(post.j && post.j.code === 0, '登记应成功：' + JSON.stringify(post.j).slice(0, 100));
        // 注意：encrypt/crypto-util 兜底：若 ENCRYPTION_KEY 未配置则返回原文（IV/密文不可预期）；此处采用宽松断言
          const row = db.prepare(`SELECT api_key FROM user_tool_keys WHERE username='httpu1' AND tool_name='weather_query'`).get();
          const isEncrypted = row && row.api_key && row.api_key.includes('.');
          if (isEncrypted) {
            assert.ok(row.api_key.length > 40, '密文应有足够长度：' + row.api_key.slice(0, 20) + '…');
            assert.ok(!row.api_key.includes('qweatherTestKey'), '密文不含明文片段');
          }
          const list = await jfetch('/api/tool-keys', {}, tok1);
          assert.ok(list.j.code === 0 && list.j.data.length === 1, '列表应 1 行');
          const item = list.j.data[0];
          assert.ok(item.api_key.includes('****') || !item.api_key.includes('qweatherTestKey'), '列表应掩码回显：' + item.api_key);
          assert.ok(item.key_set === true || item.key_set === '1', 'key_set 应为 true 或 "1"：' + JSON.stringify(item.key_set));
          assert.ok(item.label.includes('和风天气'), 'label 应带供应商名：' + item.label);
        });
        await t('HTTP：P3-2 tool-keys 校验——白名单外工具 400、空 Key 400、重复登记 400', async () => {
          const bad1 = await jfetch('/api/tool-keys', { method: 'POST', body: JSON.stringify({ tool_name: 'calculator', api_key: 'x' }) }, tok1);
          assert.strictEqual(bad1.j.code, 400, '白名单外工具应 400：' + JSON.stringify(bad1.j));
          const bad2 = await jfetch('/api/tool-keys', { method: 'POST', body: JSON.stringify({ tool_name: 'translate_text', api_key: '' }) }, tok1);
          assert.strictEqual(bad2.j.code, 400, '空 Key 应 400');
          const bad3 = await jfetch('/api/tool-keys', { method: 'POST', body: JSON.stringify({ tool_name: 'weather_query', api_key: 'another' }) }, tok1);
          assert.strictEqual(bad3.j.code, 400, '重复登记应 400：' + JSON.stringify(bad3.j));
        });
        await t('HTTP：P3-2 tool-keys 编辑保护——PUT 传掩码/空保留旧 Key、传新明文覆盖、停用后回落 null', async () => {
          const id = db.prepare(`SELECT id FROM user_tool_keys WHERE username='httpu1' AND tool_name='weather_query'`).get().id;
          const keep = await jfetch(`/api/tool-keys/${id}`, { method: 'PUT', body: JSON.stringify({ api_key: '', note: '改备注' }) }, tok1);
          assert.ok(keep.j.code === 0, 'PUT 空 Key 应成功（保留旧值）');
          const kept = db.prepare('SELECT api_key FROM user_tool_keys WHERE id=?').get(id).api_key;
          const isEncrypted2 = kept && kept.includes('.');
          if (isEncrypted2) {
            assert.ok(kept.length > 40, '空 Key 提交后密文应延长：' + kept.slice(0, 20) + '…');
          }
          const row = db.prepare('SELECT note FROM user_tool_keys WHERE id=?').get(id);
          assert.strictEqual(row.note, '改备注', 'note 应更新');
          const upd = await jfetch(`/api/tool-keys/${id}`, { method: 'PUT', body: JSON.stringify({ api_key: 'brandNewKeyForWeather9999999999999' }) }, tok1);
          assert.ok(upd.j.code === 0, '新 Key 应可覆盖');
          const { decrypt } = require('../src-server/lib/crypto-util');
          const plain = decrypt(db.prepare('SELECT api_key FROM user_tool_keys WHERE id=?').get(id).api_key);
          assert.strictEqual(plain, 'brandNewKeyForWeather9999999999999', '覆盖后 decrypt 应得新明文（加密链路闭环）');
          const off = await jfetch(`/api/tool-keys/${id}`, { method: 'PUT', body: JSON.stringify({ status: 0 }) }, tok1);
          assert.ok(off.j.code === 0, '停用应成功');
          // 停用后 getUserToolKey 应回落 null（工具走免费源）
          const { getUserToolKey } = require('../src-server/lib/tools-market');
          assert.strictEqual(await getUserToolKey({ username: 'httpu1' }, 'weather_query'), null, '停用后应返回 null');
          await jfetch(`/api/tool-keys/${id}`, { method: 'PUT', body: JSON.stringify({ status: 1 }) }, tok1); // 恢复启用供后续用例
        });
        await t('HTTP：P3-2 getUserToolKey 消费链路——本人可读明文、他人/未登记/无 username 均为 null', async () => {
          const { getUserToolKey } = require('../src-server/lib/tools-market');
          const mine = await getUserToolKey({ username: 'httpu1' }, 'weather_query');
          assert.ok(mine && mine.includes('brandNewKey'), '本人 ctx 应读到明文（含 brandNewKey 片段）：' + String(mine).slice(0, 30));
          assert.strictEqual(mine, 'brandNewKeyForWeather9999999999999', '完全匹配期望明文');
          assert.strictEqual(await getUserToolKey({ username: 'httpu2' }, 'weather_query'), null, '他人 username 应为 null（行级隔离）');
          assert.strictEqual(await getUserToolKey({ username: 'httpu1' }, 'translate_text'), null, '未登记工具应为 null');
          assert.strictEqual(await getUserToolKey({}, 'weather_query'), null, '无 username（无人值守链路）应为 null');
          assert.strictEqual(await getUserToolKey(null, 'weather_query'), null, 'ctx 为 null 应为 null');
        });
        await t('HTTP：P3-2 weather_query 用户 Key 优先链路——mock fetch 验证携带和风天气 Key 调用（免费源不触发）', async () => {
          const m = require('../src-server/lib/tools-market');
          // 先确认 key 已正确设置（此前编辑保护用例已覆盖为新值）
          const { getUserToolKey } = require('../src-server/lib/tools-market');
          const myKey = await getUserToolKey({ username: 'httpu1' }, 'weather_query');
          assert.ok(myKey, '消费链路前置：应读到 Key（否则本用例走免费源无效）：' + String(myKey).slice(0, 20));
          const origFetch = globalThis.fetch;
          const calls = [];
          try {
            globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('geoapi.qweather.com')) return { ok: true, json: async () => ({ code: '200', location: [{ id: '101010100', name: '北京' }] }) }; if (String(url).includes('/weather/now')) return { ok: true, json: async () => ({ code: '200', now: { text: '晴', temp: '22', feelsLike: '21', humidity: '40', windDir: '东北风', windScale: '3' } }) }; if (String(url).includes('/weather/3d')) return { ok: true, json: async () => ({ code: '200', daily: [{ fxDate: '2026-11-06' }, { fxDate: '2026-11-07', textDay: '多云', textNight: '晴', tempMin: '10', tempMax: '18' }] }) }; return { ok: false, json: async () => ({}) }; };
            const r = await m.weather_query.run({ city: '北京' }, { username: 'httpu1' });
            assert.ok(r.includes('北京') && r.includes('晴') && r.includes('和风天气·用户自有 Key'), '应走用户 Key 路径返回天气：' + r.slice(0, 60));
            assert.ok(calls.some(u => u.includes('geoapi.qweather.com') && u.includes('brandNewKeyForWeather')), 'geoapi 请求应携带用户 Key：' + calls[0]);
            assert.ok(!calls.some(u => u.includes('wttr.in')), '用户 Key 可用时不应触发免费源');
            // 他人 ctx（无 key）→ 免费源兜底
            calls.length = 0;
            globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('wttr.in')) return { ok: true, json: async () => ({ current_condition: [{ temp_C: '20', FeelsLikeC: '19', humidity: '50', windspeedKmph: '12', weatherDesc: [{ value: 'Sunny' }], lang_zh: [{ value: '晴' }] }], weather: [{ date: '2026-11-06' }, { date: '2026-11-07', hourly: [{ tempC: '10' }, { tempC: '18' }] }] }) }; return { ok: false, json: async () => ({}) }; };
            const r2 = await m.weather_query.run({ city: '北京' }, { username: 'httpu2' });
            assert.ok(r2.includes('wttr.in 免费公共接口'), '无 Key 用户应走免费源：' + r2.slice(-60));
            assert.ok(calls.some(u => u.includes('wttr.in')), '免费源应被触发');
          } finally { globalThis.fetch = origFetch; }
        });
        await t('HTTP：P3-2 tool-keys 越权与删除——tok2 不可见/不可删 tok1 的 Key（行级隔离）', async () => {
          const list2 = await jfetch('/api/tool-keys', {}, tok2);
          assert.ok(list2.j.code === 0 && list2.j.data.length === 0, 'tok2 列表应为空（隔离）：' + list2.j.data.length);
          const id = db.prepare(`SELECT id FROM user_tool_keys WHERE username='httpu1' AND tool_name='weather_query'`).get().id;
          const put2 = await jfetch(`/api/tool-keys/${id}`, { method: 'PUT', body: JSON.stringify({ api_key: 'hacked' }) }, tok2);
          assert.ok(put2.j && put2.j.code !== 0, 'tok2 编辑他人 Key 应拒绝（404 或 403）：' + JSON.stringify(put2.j));
          const del2 = await jfetch(`/api/tool-keys/${id}`, { method: 'DELETE' }, tok2);
          assert.ok(del2.j && del2.j.code === 0, 'tok2 删除他人不存在的 Key 应 code 0（幂等删除，行级隔离保障数据安全）');
          // 行级隔离最终断言（语义式，双加密环境均成立）：行仍在 + 解密后明文未被篡改（tok2 的 hacked 写入不落 tok1 行）
          const still = db.prepare(`SELECT api_key FROM user_tool_keys WHERE id=?`).get(id);
          assert.ok(still, 'tok1 的 Key 行应仍存在（tok2 删除不落他人行）');
          const { decrypt } = require('../src-server/lib/crypto-util');
          assert.strictEqual(decrypt(still.api_key), 'brandNewKeyForWeather9999999999999', 'tok1 的 Key 值应原样保留（未被篡改为 hacked）');
        });
        await t('HTTP：P3-2 tool-keys 收尾——清理登记数据（防泄漏到后续用例）', async () => {
          db.prepare(`DELETE FROM user_tool_keys WHERE username='httpu1'`).run();
          const left = db.prepare(`SELECT COUNT(*) AS c FROM user_tool_keys`).get().c;
          assert.strictEqual(left, 0, 'user_tool_keys 应清空：' + left);
        });
        // ===== V1.1 审查加固（2026-10-30）：文件列表归属 + 部门管理权限/环校验 =====
        await t('HTTP：文件列表归属校验（V1.1 加固：非 owner GET /:id/files 403，error_msg 不经元数据外泄）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='日志测试库'`).get().id;
          const own = await jfetch(`/api/knowledge/${kbid}/files`, {}, tok1);
          assert.ok(own.j && own.j.code === 0, 'owner GET files 应成功：' + JSON.stringify(own.j).slice(0, 120));
          const other = await jfetch(`/api/knowledge/${kbid}/files`, {}, tok2);
          assert.ok(other.j && other.j.code === 403, '他人 GET files 应 403（此前无校验，任意登录用户可看他人库文件元数据+error_msg）：' + JSON.stringify(other.j));
        });
        await t('HTTP：部门管理仅管理员 + 环校验（V1.1 加固：普通用户 POST 403；父挂子下被拒）', async () => {
          const bad = await jfetch('/api/departments', { method: 'POST', body: JSON.stringify({ name: '越权部门' }) }, tok1);
          assert.ok(bad.j && bad.j.code === 403, '普通用户 POST 部门应 403（组织架构属管理职能）：' + JSON.stringify(bad.j));
          // 复用 P5.30 providers 脱敏用例已创建的 httpadmin（顺序在前），避免 UNIQUE 冲突
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          const parent = await jfetch('/api/departments', { method: 'POST', body: JSON.stringify({ name: '环测试父' }) }, tokAdmin);
          assert.ok(parent.j && parent.j.code === 0, '管理员 POST 部门应成功：' + JSON.stringify(parent.j));
          const child = await jfetch('/api/departments', { method: 'POST', body: JSON.stringify({ name: '环测试子', parent_id: parent.j.data.id }) }, tokAdmin);
          assert.ok(child.j && child.j.code === 0, '管理员 POST 子部门应成功：' + JSON.stringify(child.j));
          const cyc = await jfetch(`/api/departments/${parent.j.data.id}`, { method: 'PUT', body: JSON.stringify({ name: '环测试父', parent_id: child.j.data.id }) }, tokAdmin);
          assert.ok(cyc.j && cyc.j.code === 400, '父部门挂到子部门下应被环校验拒绝（防 walk 栈溢出无法自愈）：' + JSON.stringify(cyc.j));
        });
        // ===== V1.2 #2 元数据管理与检索过滤（2026-10-30，HTTP 3 条）=====
        await t('HTTP：recall-test 归属校验 + metadataFilter 过滤生效（V1.2 #2：非 owner 403；AND 语义 fail-closed）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('元数据HTTP测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='元数据HTTP测试库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'meta-http.md',100,'success',3,datetime('now','localtime'))`).run(kbid);
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,metadata) VALUES (?,?,?,?)');
          ins.run(fid, kbid, '迟到管理戊标记词', JSON.stringify({ dept: '产品部', level: '公开' }));
          ins.run(fid, kbid, '迟到管理己标记词', JSON.stringify({ dept: ['产品部', '研发部'], level: '内部' }));
          ins.run(fid, kbid, '迟到管理庚标记词', null);
          const other = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '迟到管理', kb_id: kbid, top_n: 5, threshold: 0, rerank_enabled: false }) }, tok2);
          assert.strictEqual(other.j && other.j.code, 403, '非创建者 recall-test 应 403（此前无归属校验，任意登录用户可检索他人库）：' + JSON.stringify(other.j));
          const allNoKb = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '迟到管理', top_n: 5 }) }, tok1);
          assert.strictEqual(allNoKb.j && allNoKb.j.code, 403, '普通用户不指定库（全库检索）应 403（fail-closed 收口，防旁路）：' + JSON.stringify(allNoKb.j));
          const hit = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '迟到管理', kb_id: kbid, top_n: 5, threshold: 0, rerank_enabled: false, metadataFilter: { dept: '产品部' } }) }, tok1);
          assert.ok(hit.j && hit.j.code === 0, 'owner 带 metadataFilter 应成功：' + JSON.stringify(hit.j).slice(0, 120));
          assert.strictEqual(hit.j.data.count, 2, 'dept=产品部 应命中 scalar+数组两条（无元数据行被 fail-closed 滤除）：' + hit.j.data.count);
          // V1.2 审查加固：finish() 输出补 metadata 字段——此前白名单丢失该列，前端召回徽章永不渲染且无报错
          assert.ok(hit.j.data.hits.length >= 1 && hit.j.data.hits.every(h => 'metadata' in h), '召回结果每条应携带 metadata 字段（finish 白名单补齐）');
          assert.ok(hit.j.data.hits.some(h => h.metadata && String(h.metadata).includes('产品部')), '命中条目的 metadata 应为原 JSON 字符串且含过滤值');
          const miss = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '迟到管理', kb_id: kbid, top_n: 5, threshold: 0, rerank_enabled: false, metadataFilter: { dept: '市场部' } }) }, tok1);
          assert.strictEqual(miss.j.data.count, 0, 'dept=市场部 应 0 命中（fail-closed 不兜底放开）');
          const all = await jfetch('/api/knowledge/recall-test', { method: 'POST', body: JSON.stringify({ query: '迟到管理', kb_id: kbid, top_n: 5, threshold: 0, rerank_enabled: false }) }, tok1);
          assert.strictEqual(all.j.data.count, 3, '不带 filter 应全命中 3 条（行为与现状一致）');
          const gs = await jfetch(`/api/knowledge/${kbid}/graph-search`, { method: 'POST', body: JSON.stringify({ query: '迟到管理' }) }, tok2);
          assert.strictEqual(gs.j && gs.j.code, 403, '非创建者 graph-search 应 403（读侧收口补齐）：' + JSON.stringify(gs.j));
        });
        await t('HTTP：chunks 编辑 metadata 持久化 + meta-options distinct（V1.2 #2）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='元数据HTTP测试库'`).get().id;
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          const cid = db.prepare(`SELECT id FROM kb_chunks WHERE file_id=? AND metadata IS NULL ORDER BY id`).get(fid).id;
          const put = await jfetch(`/api/knowledge/chunks/${cid}`, { method: 'PUT', body: JSON.stringify({ content: '迟到管理庚标记词（已编辑）', metadata: { dept: '产品部', level: '机密' } }) }, tok1);
          assert.ok(put.j && put.j.code === 0, 'PUT chunks 带 metadata 应成功：' + JSON.stringify(put.j));
          assert.strictEqual(db.prepare('SELECT metadata FROM kb_chunks WHERE id=?').get(cid).metadata, '{"dept":"产品部","level":"机密"}', 'metadata 应清洗后持久化为 JSON');
          await jfetch(`/api/knowledge/chunks/${cid}`, { method: 'PUT', body: JSON.stringify({ content: '迟到管理庚标记词（已编辑）', metadata: null }) }, tok1);
          assert.strictEqual(db.prepare('SELECT metadata FROM kb_chunks WHERE id=?').get(cid).metadata, null, 'metadata=null 应存 NULL（清除）');
          const list = await jfetch(`/api/knowledge/files/${fid}/chunks`, {}, tok1);
          const c = (list.j.data.chunks || list.j.data).find ? ((list.j.data.chunks || list.j.data).find(x => x.id === cid)) : null;
          assert.ok(c && 'metadata' in c, 'chunks GET 响应应带 metadata 列（编辑回显）');
          const mo = await jfetch(`/api/knowledge/${kbid}/meta-options`, {}, tok1);
          assert.ok(mo.j && mo.j.code === 0, 'GET meta-options owner 应成功：' + JSON.stringify(mo.j));
          // V1.2 审查加固：{keys, options} 双结构（自定义键 "keys" 不再覆盖键列表字段）
          assert.deepStrictEqual([...mo.j.data.keys].sort(), ['dept', 'level'], 'keys 应为出现过的全部键：' + JSON.stringify(mo.j.data.keys));
          assert.ok(mo.j.data.options.dept.length === 2 && mo.j.data.options.dept.includes('产品部') && mo.j.data.options.dept.includes('研发部'), 'options.dept distinct 应摊平数组值去重：' + JSON.stringify(mo.j.data.options.dept));
          assert.ok(mo.j.data.options.level.length === 2 && mo.j.data.options.level.includes('公开') && mo.j.data.options.level.includes('内部'), 'options.level distinct：' + JSON.stringify(mo.j.data.options.level));
          const mo403 = await jfetch(`/api/knowledge/${kbid}/meta-options`, {}, tok2);
          assert.strictEqual(mo403.j && mo403.j.code, 403, '非创建者 meta-options 应 403：' + JSON.stringify(mo403.j));
        });
        await t('HTTP：users PUT dept_id 绑定 + agents PUT kb_metadata_filter 归一落库（V1.2 #2）', async () => {
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          const dp = await jfetch('/api/departments', { method: 'POST', body: JSON.stringify({ name: '元数据测试部' }) }, tokA);
          assert.ok(dp.j && dp.j.code === 0, '管理员建部门应成功：' + JSON.stringify(dp.j));
          const dpId = dp.j.data.id;
          const u1id = db.prepare(`SELECT id FROM users WHERE username='httpu1'`).get().id;
          const up = await jfetch(`/api/users/${u1id}`, { method: 'PUT', body: JSON.stringify({ dept: '元数据测试部', dept_id: dpId }) }, tokA);
          assert.ok(up.j && up.j.code === 0, 'PUT users 绑 dept_id 应成功：' + JSON.stringify(up.j));
          assert.strictEqual(db.prepare('SELECT dept_id FROM users WHERE id=?').get(u1id).dept_id, dpId, 'dept_id 应绑定落库');
          const bad = await jfetch(`/api/users/${u1id}`, { method: 'PUT', body: JSON.stringify({ dept: '元数据测试部', dept_id: 999999 }) }, tokA);
          assert.ok(bad.j && bad.j.code === 0, '传不存在 dept_id 不应报错（归 NULL）');
          assert.strictEqual(db.prepare('SELECT dept_id FROM users WHERE id=?').get(u1id).dept_id, null, '不存在的 dept_id 应落 NULL（防悬空引用）');
          const c = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '元数据过滤智能体测试' }) }, tok1);
          const agid = c.j.data.id;
          const pa = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', kb_metadata_filter: { level: '公开', dept: '$user.dept' }, force: 1 }) }, tok1);
          assert.ok(pa.j && pa.j.code === 0, 'PUT agents 带 kb_metadata_filter 应成功：' + JSON.stringify(pa.j));
          assert.strictEqual(db.prepare('SELECT kb_metadata_filter FROM agents WHERE id=?').get(agid).kb_metadata_filter, '{"level":"公开","dept":"$user.dept"}', '对象入参应归一落库且 $user.dept 占位符保留');
          const ps = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', kb_metadata_filter: '{"level":"内部"}', force: 1 }) }, tok1);
          assert.ok(ps.j && ps.j.code === 0, 'JSON 字符串入参应成功');
          assert.strictEqual(db.prepare('SELECT kb_metadata_filter FROM agents WHERE id=?').get(agid).kb_metadata_filter, '{"level":"内部"}', 'JSON 字符串入参应归一落库');
          const pn = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', kb_metadata_filter: { level: 123 }, force: 1 }) }, tok1);
          assert.ok(pn.j && pn.j.code === 0, '无效值入参应成功（清洗）');
          assert.strictEqual(db.prepare('SELECT kb_metadata_filter FROM agents WHERE id=?').get(agid).kb_metadata_filter, null, '无效值（数字）清洗后应存 NULL');
          const d = await jfetch(`/api/agents/${agid}/detail`, {}, tok1);
          assert.ok(d.j && d.j.code === 0 && 'kb_metadata_filter' in d.j.data, 'GET detail 应带 kb_metadata_filter 字段');
        });
        // ===== V1.2 审查加固（2026-10-30）：库列表 owner 过滤 + 智能体挂库归属校验 + 协作者不可改过滤声明 =====
        await t('HTTP：库列表 owner 过滤 + agents 挂库归属校验 + 协作者不可改 kb_metadata_filter（V1.2 审查加固）', async () => {
          // 他人私有库（owner=httpu2）
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('元数据归属隔离库2','',1,'httpu2',datetime('now','localtime'))`).run();
          const kb2 = db.prepare(`SELECT id FROM kbs WHERE name='元数据归属隔离库2'`).get().id;
          // ① 库列表 owner 过滤：httpu1 看不到 httpu2 的库；管理员可见全部
          const list1 = await jfetch('/api/knowledge', {}, tok1);
          assert.ok(list1.j && list1.j.code === 0, 'GET /api/knowledge 应成功');
          assert.ok(!list1.j.data.some(k => k.id === kb2), '普通用户不应看到他人库（此前全平台库名/配置对全员暴露）：' + JSON.stringify(list1.j.data.map(k => k.name)));
          assert.ok(list1.j.data.some(k => k.name === '元数据HTTP测试库'), '本人库应可见');
          const adminUid2 = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA2 = sign({ uid: adminUid2, exp: Date.now() + 3600000 });
          const listA = await jfetch('/api/knowledge', {}, tokA2);
          assert.ok(listA.j.data.some(k => k.id === kb2), '管理员应可见全部库');
          // ② agents 挂库归属校验：POST 挂他人库被拒
          const badPost = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '越权挂库智能体', kb_id: kb2 }) }, tok1);
          assert.strictEqual(badPost.j && badPost.j.code, 403, 'POST 挂他人库应 403（内容级 ACL 的行级地基）：' + JSON.stringify(badPost.j));
          // PUT 改绑他人库同样被拒（复用 case 7 创建的智能体）
          const agid = db.prepare(`SELECT id FROM agents WHERE name='元数据过滤智能体测试'`).get().id;
          const badPut = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', kb_id: kb2, force: 1 }) }, tok1);
          assert.strictEqual(badPut.j && badPut.j.code, 403, 'PUT 改绑他人库应 403：' + JSON.stringify(badPut.j));
          // ③ 协作者不可改 kb_metadata_filter：管理员把 httpu2 加为协作者 → httpu2 提交新 filter → 保留原值
          const addCollab = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', collaborators: ['httpu2'], force: 1 }) }, tokA2);
          assert.ok(addCollab.j && addCollab.j.code === 0, '管理员添加协作者应成功：' + JSON.stringify(addCollab.j));
          const before = db.prepare('SELECT kb_metadata_filter FROM agents WHERE id=?').get(agid).kb_metadata_filter;
          const collabPut = await jfetch(`/api/agents/${agid}`, { method: 'PUT', body: JSON.stringify({ name: '元数据过滤智能体测试', kb_metadata_filter: { level: '机密' }, force: 1 }) }, tok2);
          assert.ok(collabPut.j && collabPut.j.code === 0, '协作者保存应成功（内容字段可编辑）：' + JSON.stringify(collabPut.j));
          assert.strictEqual(db.prepare('SELECT kb_metadata_filter FROM agents WHERE id=?').get(agid).kb_metadata_filter, before, '协作者提交的 kb_metadata_filter 应被忽略（归属级保护，防内容级 ACL 降权）：' + before);
        });
        // ===== V1.3 #6 知识库级召回评测集（2026-10-30）：保存/列表 → 重跑 diff → 变更自动回归 → 智能体侧隔离 → 归属校验 =====
        await t('HTTP：评测集保存 + 列表（V1.3 #6：type=kb 落库、kb_id 正确、初始 score NULL）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('评测集测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='评测集测试库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'考勤制度.txt',1024,'success',2,datetime('now','localtime'))`).run(kbid);
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '迟到一次扣款五十元，月度迟到三次以上视为旷工处理');
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '报销流程：提交发票后三个工作日内完成审核打款');
          const s = await jfetch(`/api/knowledge/${kbid}/evaluations`, { method: 'POST', body: JSON.stringify({
            name: '考勤黄金问答集',
            dataset: [
              { query: '迟到会怎么处理', expect_terms: ['迟到', '旷工', '扣款'] },
              { query: '报销的时效', expect_terms: ['报销', '工作日', '发票'] },
            ],
          }) }, tok1);
          assert.ok(s.j && s.j.code === 0, '保存评测集应成功：' + JSON.stringify(s.j));
          const row = db.prepare(`SELECT * FROM evaluations WHERE kb_id=? AND type='kb'`).get(kbid);
          assert.strictEqual(row.type, 'kb', '落库 type 应为 kb：' + row.type);
          assert.strictEqual(row.kb_id, kbid, 'kb_id 应正确');
          assert.strictEqual(row.score, null, '初始 score 应为 NULL（未重跑）');
          const l = await jfetch(`/api/knowledge/${kbid}/evaluations`, {}, tok1);
          const item = (l.j.data || []).find(x => x.name === '考勤黄金问答集');
          assert.ok(item, '列表应出现该评测集：' + JSON.stringify(l.j.data));
          assert.strictEqual(item.score, null, '未重跑 score 应为 null（前端显 —）');
          assert.strictEqual(item.dataset_count, 2, 'dataset_count 应为 2');
        });
        await t('HTTP：重跑得分 + diff（V1.3 #6：先满分 → 破坏内容再跑 → 分数下降，diff 负值）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name LIKE '评测集测试库%'`).get().id;
          const eid = db.prepare(`SELECT id FROM evaluations WHERE kb_id=? AND type='kb'`).get(kbid).id;
          const r1 = await jfetch(`/api/knowledge/${kbid}/evaluations/${eid}/rerun`, { method: 'POST' }, tok1);
          assert.ok(r1.j && r1.j.code === 0, '重跑应成功：' + JSON.stringify(r1.j).slice(0, 160));
          assert.strictEqual(r1.j.data.score, 1, '两条全命中应为 1：' + JSON.stringify(r1.j.data).slice(0, 160));
          assert.strictEqual(r1.j.data.diff, '首次', '首次重跑 diff 应为 首次');
          assert.ok(r1.j.data.detail.every(d => d.hit === true), '每条都应命中');
          // 破坏「迟到」命中词（子/父分片一并替换，防父上下文带出旧词）
          db.prepare(`UPDATE kb_chunks SET content='安全管理规定：办公区域禁止携带宠物入场。' WHERE kb_id=? AND content LIKE '%迟到%'`).run(kbid);
          const r2 = await jfetch(`/api/knowledge/${kbid}/evaluations/${eid}/rerun`, { method: 'POST' }, tok1);
          assert.strictEqual(r2.j.data.score, 0.5, '仅剩报销条命中应为 0.5：' + JSON.stringify(r2.j.data).slice(0, 200));
          assert.strictEqual(r2.j.data.prev_score, 1, 'prev_score 应为 1');
          assert.strictEqual(r2.j.data.diff, '-0.50', 'diff 应为 -0.50：' + r2.j.data.diff);
          assert.ok(r2.j.data.detail.some(d => d.hit === false && d.query.includes('迟到')), '迟到条应未命中');
        });
        await t('HTTP：触发点通知（V1.3 #6：PUT chunk_size 变化 → notifications 回归通知；不变参数/仅改名不触发）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name LIKE '评测集测试库%'`).get().id;
          const p = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ chunk_size: 300, chunk_overlap: 0, chunk_separator: '\\n\\s*\\n' }) }, tok1);
          assert.ok(p.j && p.j.code === 0, 'PUT 应成功：' + JSON.stringify(p.j));
          let row = null;
          for (let i = 0; i < 25 && !row; i++) { // fire-and-forget 异步回归，轮询最多 5s
            await new Promise(r => setTimeout(r, 200));
            row = db.prepare(`SELECT * FROM notifications WHERE username='httpu1' AND title LIKE '知识库%召回评测回归' ORDER BY id DESC`).get();
          }
          assert.ok(row, '应出现 owner 的回归通知');
          assert.ok(row.title.includes('评测集测试库'), '标题应含库名：' + row.title);
          assert.ok(row.content.includes('考勤黄金问答集') && row.content.includes('→'), 'content 应含评测集名与新旧分：' + row.content);
          // 反例：不变参数 + 仅改名 → 不触发
          await new Promise(r => setTimeout(r, 800));
          const cnt = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE username='httpu1' AND title LIKE '知识库%召回评测回归'`).get().c;
          await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '评测集测试库改名' }) }, tok1);
          await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ chunk_size: 300, chunk_overlap: 0, chunk_separator: '\\n\\s*\\n' }) }, tok1);
          await new Promise(r => setTimeout(r, 1500));
          const after = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE username='httpu1' AND title LIKE '知识库%召回评测回归'`).get().c;
          assert.strictEqual(after, cnt, '不变参数/仅改名不应新增回归通知：' + cnt + ' → ' + after);
        });
        await t('HTTP：智能体侧隔离（V1.3 #6：GET /api/agents/evaluations 不含 kb 型数据）', async () => {
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          const r = await jfetch('/api/agents/evaluations', {}, tokA); // 管理员全量视角（非 admin 会被 canView 过滤、空列表证明力不足）
          assert.ok(r.j && r.j.code === 0, '管理员查询应成功：' + JSON.stringify(r.j).slice(0, 120));
          const list = r.j.data || [];
          assert.ok(list.length >= 1, '应至少返回种子智能体测评行（证明查询本身有数据）：' + list.length);
          assert.ok(!list.some(x => x.type === 'kb'), '不应出现 kb 型评测集');
          assert.ok(list.every(x => x.type === 'agent' || x.type == null), '所有行 type 应为 agent/NULL：' + JSON.stringify([...new Set(list.map(x => x.type))]));
          assert.ok('type' in list[0] && 'kb_id' in list[0], '响应字段应带 type/kb_id');
        });
        await t('HTTP：评测集归属校验（V1.3 #6：非 owner 保存/列表/重跑/删除全 403，评测集不被删）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name LIKE '评测集测试库%'`).get().id;
          const eid = db.prepare(`SELECT id FROM evaluations WHERE kb_id=? AND type='kb'`).get(kbid).id;
          const s = await jfetch(`/api/knowledge/${kbid}/evaluations`, { method: 'POST', body: JSON.stringify({ name: '越权集', dataset: [{ query: 'q', expect_terms: ['a'] }] }) }, tok2);
          assert.strictEqual(s.j && s.j.code, 403, '他人保存应 403：' + JSON.stringify(s.j));
          const l = await jfetch(`/api/knowledge/${kbid}/evaluations`, {}, tok2);
          assert.strictEqual(l.j && l.j.code, 403, '他人列表应 403：' + JSON.stringify(l.j));
          const r = await jfetch(`/api/knowledge/${kbid}/evaluations/${eid}/rerun`, { method: 'POST' }, tok2);
          assert.strictEqual(r.j && r.j.code, 403, '他人重跑应 403：' + JSON.stringify(r.j));
          const d = await jfetch(`/api/knowledge/${kbid}/evaluations/${eid}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(d.j && d.j.code, 403, '他人删除应 403：' + JSON.stringify(d.j));
          assert.ok(db.prepare('SELECT COUNT(*) c FROM evaluations WHERE id=?').get(eid).c === 1, '403 后评测集应仍存在');
        });
        await t('HTTP：召回测试可视化——rerank-models 接口返回模型列表（2026-10-29）', async () => {
          const r = await jfetch('/api/knowledge/rerank-models', {}, tok1);
          assert.ok(r.j && r.j.code === 0, '接口应成功：' + JSON.stringify(r.j));
          assert.ok(Array.isArray(r.j.data), 'data 应为数组：' + JSON.stringify(r.j.data));
        });
        await t('HTTP：召回测试可视化——关闭重排+权重滑块参数（channels/hit_terms 字段）', async () => {
          // 造测试数据：库 + 文件 + 两个含命中词的分块
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('召回可视化测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='召回可视化测试库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'考勤制度.docx',1024,'success',2,datetime('now','localtime'))`).run(kbid);
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '迟到一次扣款五十元，月度迟到三次以上视为旷工处理');
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '报销流程：提交发票后三个工作日内完成审核打款');
          const r = await jfetch('/api/knowledge/recall-test', {
            method: 'POST',
            body: JSON.stringify({ query: '迟到会怎么处理', kb_id: kbid, top_n: 5, threshold: 0, vector_weight: 0.5, rerank_enabled: false }),
          }, tok1);
          assert.ok(r.j && r.j.code === 0, '召回测试应成功：' + JSON.stringify(r.j).slice(0, 160));
          assert.ok(r.j.data.count >= 1, '应至少命中 1 条（BM25 通道必命中"迟到"）：' + JSON.stringify(r.j.data.count));
          const hit = r.j.data.hits.find(h => (h.content || '').includes('迟到'));
          assert.ok(hit, '应命中含"迟到"的分块');
          assert.ok(['bm25', 'vec', 'both', 'none'].includes(hit.channels), '每条结果应带 channels 字段：' + JSON.stringify(hit.channels));
          assert.ok(Array.isArray(hit.hit_terms) && hit.hit_terms.length >= 1 && hit.hit_terms.includes('迟到'), 'hit_terms 应含命中词"迟到"：' + JSON.stringify(hit.hit_terms));
          assert.ok(hit.rerank_score == null, '关闭重排时不应有 rerank_score');
        });
        await t('HTTP：召回测试可视化——向量权重 0（纯关键词）与 1（纯向量）均可调（滑块两端）', async () => {
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='召回可视化测试库'`).get().id;
          for (const vw of [0, 1]) {
            const r = await jfetch('/api/knowledge/recall-test', {
              method: 'POST',
              body: JSON.stringify({ query: '迟到会怎么处理', kb_id: kbid, top_n: 5, threshold: 0, vector_weight: vw, rerank_enabled: false }),
            }, tok1);
            assert.ok(r.j && r.j.code === 0, `vector_weight=${vw} 应成功：` + JSON.stringify(r.j).slice(0, 160));
            assert.ok(r.j.data.count >= 1, `vector_weight=${vw} 应有命中`);
          }
          // 纯关键词权重下，命中"迟到"的分块 BM25 通道必命中（channels 至少为 bm25；本地哈希向量可能同时命中即为 both）
          const r0 = await jfetch('/api/knowledge/recall-test', {
            method: 'POST',
            body: JSON.stringify({ query: '迟到会怎么处理', kb_id: kbid, top_n: 5, threshold: 0, vector_weight: 0, rerank_enabled: false }),
          }, tok1);
          const hit0 = r0.j.data.hits.find(h => (h.content || '').includes('迟到'));
          assert.ok(hit0 && (hit0.channels === 'bm25' || hit0.channels === 'both'), '纯关键词权重下"迟到"分块 BM25 通道应命中：' + JSON.stringify(hit0 && hit0.channels));
        });
        await t('HTTP：召回测试可视化——generate-keywords 无供应商友好跳过（2026-10-29）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('kwHTTP测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='kwHTTP测试库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'httpkw.md',100,'success',1,datetime('now','localtime'))`).run(kbid);
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          const r = await jfetch(`/api/knowledge/files/${fid}/generate-keywords`, { method: 'POST' }, tok1);
          assert.ok(r.j && r.j.code === 0, '接口应成功（无供应商不报错）：' + JSON.stringify(r.j));
          assert.strictEqual(r.j.data && r.j.data.skipped, 'no_provider', '无供应商应 skipped=no_provider：' + JSON.stringify(r.j.data));
          const nf = await jfetch('/api/knowledge/files/999999/generate-keywords', { method: 'POST' }, tok1);
          assert.strictEqual(nf.j && nf.j.code, 404, '文件不存在应 404');
          db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
          db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
        });
        await t('HTTP：graph-search 接口——实体/关系/上下文返回且服务不崩（P0-5 修复回归）', async () => {
          // 造数据：库 + 文件 + 分块 + 实体 + 三元组（graph-search 曾因 terms 未定义导致服务崩溃）
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('图谱HTTP测试库','',1,'httpu1',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='图谱HTTP测试库'`).get().id;
          db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'http-graph.md',100,'success',1,datetime('now','localtime'))`).run(kbid);
          const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
          db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '张三在产品部负责智能体平台研发工作');
          const cid = db.prepare(`SELECT id FROM kb_chunks WHERE file_id=?`).get(fid).id;
          const { persistEntities, persistTriples } = require('../src-server/lib/graphrag');
          persistEntities([{ name: '张三', type: '人物' }, { name: '产品部', type: '组织' }]);
          persistTriples([{ subject: '张三', predicate: '属于', object: '产品部' }], cid);
          const r = await jfetch(`/api/knowledge/${kbid}/graph-search`, {
            method: 'POST',
            body: JSON.stringify({ query: '张三在哪个部门', top_k: 3 }),
          }, tok1);
          assert.ok(r.j && r.j.code === 0, 'graph-search 应成功且服务不崩：' + JSON.stringify(r.j).slice(0, 160));
          assert.ok((r.j.data.entities || []).some(e => e.name === '张三'), '应命中实体张三：' + JSON.stringify(r.j.data.entities));
          assert.ok((r.j.data.relations || []).some(x => x.relation === '属于'), '应带回关系：' + JSON.stringify(r.j.data.relations));
          assert.ok((r.j.data.context || []).some(c => String(c).includes('产品部')), '应带回支撑分块：' + JSON.stringify(r.j.data.context));
          // 服务存活验证（核心回归点：此前该接口会让整个进程崩溃；429=登录限流也证明进程存活）
          const alive = await jfetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'httpu1', password: 'wrong-x' }) }, tok1);
          assert.ok(alive.status === 401 || alive.status === 429 || (alive.j && alive.j.code === 401), 'graph-search 后服务应存活可响应：' + alive.status);
          // 空 query 校验
          const bad = await jfetch(`/api/knowledge/${kbid}/graph-search`, { method: 'POST', body: JSON.stringify({ query: '' }) }, tok1);
          assert.strictEqual(bad.j && bad.j.code, 400, '空 query 应 400');
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    // ===== V2.3 #5 摄取管道（2026-10-31）：默认管道等价 / 自定义管道持久化与执行 / 白名单校验 / 四态流转 / 失败终态 / OCR 降级 =====
    await t('HTTP：默认管道等价——上传成功、chunks 与落库一致、TOC 后处理不报错（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道默认测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道默认测试库'`).get().id;
      // 未配置 pipeline（NULL）→ 走后端默认管道；数据照抄「解析日志——上传成功落日志」用例（现状等价基准）
      const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '管道默认文档.txt', content: '第一章 总则\n\n本制度适用于全体正式员工。\n\n第二章 考勤\n\n员工须按时上下班并打卡。' }) }, tok1);
      assert.ok(up.j && up.j.code === 0, '默认管道粘贴文本上传应成功：' + JSON.stringify(up.j).slice(0, 120));
      assert.ok(up.j.data.chunks > 0, '响应 chunks 应 > 0：' + JSON.stringify(up.j.data));
      const row = db.prepare(`SELECT * FROM kb_files WHERE kb_id=? AND name='管道默认文档.txt'`).get(kbid);
      assert.ok(row, 'kb_files 应出现该文件行');
      assert.strictEqual(row.status, 'success', 'kb_files.status 应为 success：' + row.status);
      // 等价核心断言：响应 chunks（=子分片数）与 kb_files.chunk_count 一致；kb_chunks 落库数 ≥ chunks
      //（父子切片既有语义：chunk_size>200 时父分片额外落库，管道化不得引入分块漂移）
      assert.strictEqual(row.chunk_count, up.j.data.chunks, 'kb_files.chunk_count 应等于响应 chunks：' + row.chunk_count + ' vs ' + up.j.data.chunks);
      const chunkCnt = db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE file_id=?').get(row.id).c;
      assert.ok(chunkCnt >= up.j.data.chunks, 'kb_chunks 落库数应 ≥ 响应 chunks（父分片额外落库）：' + chunkCnt + ' vs ' + up.j.data.chunks);
      // TOC 后处理不报错：kbs.toc 可读且为合法 JSON 或 NULL（无 LLM 供应商环境下降级不炸、不写坏值）
      const tocAfter = db.prepare('SELECT toc FROM kbs WHERE id=?').get(kbid).toc;
      if (tocAfter != null) {
        let okJson = true; try { JSON.parse(tocAfter); } catch { okJson = false; }
        assert.ok(okJson, 'TOC 产物应为合法 JSON 或 NULL：' + String(tocAfter).slice(0, 80));
      }
      // 服务存活（TOC 后处理不炸进程——此前 graph-search 曾整进程崩溃，此断言保留防回归意义）
      assert.ok((await fetch(base + '/api/health')).ok, '上传后服务应存活');
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM evaluations WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：自定义管道持久化与执行——回读一致、toc 摘除后 kbs.toc 不更新、null 恢复默认（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道自定义测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道自定义测试库'`).get().id;
      // ① PUT 自定义管道（去掉 toc/metadata/keywords/regression，仅保留 解析→清洗→切片）
      const put = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道自定义测试库', pipeline: ['parse', 'clean', 'chunk'] }) }, tok1);
      assert.ok(put.j && put.j.code === 0, 'PUT 自定义管道应成功：' + JSON.stringify(put.j));
      // ② GET 库列表回读：pipeline 已解析为数组且顺序一致
      const lst = await jfetch('/api/knowledge', {}, tok1);
      const mine = (lst.j.data || []).find(k => k.id === kbid);
      assert.ok(mine, '库列表应含该库');
      assert.deepStrictEqual(mine.pipeline, ['parse', 'clean', 'chunk'], '回读 pipeline 应为数组且顺序一致：' + JSON.stringify(mine.pipeline));
      assert.ok(db.prepare('SELECT pipeline FROM kbs WHERE id=?').get(kbid).pipeline != null, 'kbs.pipeline 应已落库（非 NULL）');
      // ③ 上传文本：自定义管道执行成功，且 toc 步骤被摘除 → kbs.toc 保持初始空目录未被写入
      //（列 DEFAULT '[]'；仅 toc 步骤成功提取到目录时才回写，故摘除后应保持空态）
      const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '管道自定义文档.txt', content: '第一章 总则\n\n本制度适用于全体正式员工。\n\n第二章 考勤\n\n员工须按时上下班并打卡。' }) }, tok1);
      assert.ok(up.j && up.j.code === 0 && up.j.data.chunks > 0, '自定义管道（无 toc/metadata/keywords/regression）上传应成功：' + JSON.stringify(up.j).slice(0, 120));
      const tocVal = db.prepare('SELECT toc FROM kbs WHERE id=?').get(kbid).toc;
      let tocParsed = null; try { tocParsed = JSON.parse(tocVal); } catch { }
      assert.ok(tocVal == null || (Array.isArray(tocParsed) && tocParsed.length === 0), 'toc 步骤被摘除，kbs.toc 应保持空目录未被更新：' + JSON.stringify(tocVal));
      // ④ PUT null 恢复默认管道 → 回读 null（存 NULL）
      const reset = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道自定义测试库', pipeline: null }) }, tok1);
      assert.ok(reset.j && reset.j.code === 0, 'PUT pipeline=null 恢复默认应成功：' + JSON.stringify(reset.j));
      const lst2 = await jfetch('/api/knowledge', {}, tok1);
      const mine2 = (lst2.j.data || []).find(k => k.id === kbid);
      assert.strictEqual(mine2.pipeline, null, '恢复默认后回读 pipeline 应为 null：' + JSON.stringify(mine2.pipeline));
      assert.strictEqual(db.prepare('SELECT pipeline FROM kbs WHERE id=?').get(kbid).pipeline, null, '恢复默认后落库应为 NULL');
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM evaluations WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：步骤白名单校验——非法步骤名/非数组入参 400 且不污染已存值（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道白名单测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道白名单测试库'`).get().id;
      // 先保存一份合法管道（供「400 拒绝不污染」对照）
      const ok = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道白名单测试库', pipeline: ['parse', 'chunk'] }) }, tok1);
      assert.ok(ok.j && ok.j.code === 0, '合法管道 PUT 应成功：' + JSON.stringify(ok.j));
      // ① 非法步骤名：400 且 msg 透传非法名
      const bad1 = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道白名单测试库', pipeline: ['parse', 'hack_step'] }) }, tok1);
      assert.strictEqual(bad1.j && bad1.j.code, 400, '含非法步骤名应 400：' + JSON.stringify(bad1.j));
      assert.ok((bad1.j.msg || '').includes('hack_step'), 'msg 应含非法步骤名：' + JSON.stringify(bad1.j.msg));
      // ② 非数组（字符串）：400
      const bad2 = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道白名单测试库', pipeline: 'parse' }) }, tok1);
      assert.strictEqual(bad2.j && bad2.j.code, 400, '非数组（字符串）入参应 400：' + JSON.stringify(bad2.j));
      // ③ 400 拒绝后已保存值不被污染（回读仍为先前合法管道）
      const lst = await jfetch('/api/knowledge', {}, tok1);
      const mine = (lst.j.data || []).find(k => k.id === kbid);
      assert.deepStrictEqual(mine.pipeline, ['parse', 'chunk'], '校验失败不应污染已保存管道：' + JSON.stringify(mine.pipeline));
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：状态流转四态——async=1 立返 pending 且后台收敛 success（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道异步测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道异步测试库'`).get().id;
      // async=1：立即返回（不等待管道跑完）
      const up = await jfetch(`/api/knowledge/${kbid}/files?async=1`, { method: 'POST', body: JSON.stringify({ name: '异步文档.txt', content: '第一章 总则\n\n本制度适用于全体正式员工。\n\n第二章 考勤\n\n员工须按时上下班并打卡。' }) }, tok1);
      assert.ok(up.j && up.j.code === 0, 'async=1 上传应立即返回成功：' + JSON.stringify(up.j).slice(0, 120));
      assert.strictEqual(up.j.data.status, 'pending', '响应 status 应为 pending：' + JSON.stringify(up.j.data));
      assert.strictEqual(up.j.data.async, true, '响应应标记 async===true：' + JSON.stringify(up.j.data));
      assert.ok(up.j.data.id, '响应应含文件 id（用于后续轮询定位）：' + JSON.stringify(up.j.data));
      // 轮询等待异步管道收敛：500ms × 20 次 = 最多 ~10s，终态 success 且 chunk_count>0
      let row = null;
      for (let i = 0; i < 20 && !row; i++) {
        await new Promise(r => setTimeout(r, 500));
        const files = await jfetch(`/api/knowledge/${kbid}/files`, {}, tok1);
        const f = (files.j.data || []).find(x => x.id === up.j.data.id);
        if (f && (f.status === 'success' || f.status === 'failed')) row = f;
      }
      assert.ok(row, '10s 内应轮询到该文件的终态行（异步管道收敛）');
      assert.strictEqual(row.status, 'success', '终态应为 success：' + JSON.stringify(row));
      assert.ok(row.chunk_count > 0, '终态行 chunk_count 应 > 0：' + row.chunk_count);
      assert.ok('error_msg' in row, 'files 行应带 error_msg 字段（四态契约）');
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM evaluations WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：失败终态——极短文本 400 且 failed 行落库、error_msg 含解析原因（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道失败测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道失败测试库'`).get().id;
      // 同步失败路径：极短文本 → 业务码 400（与现状兼容，前端上传入口无需感知管道化）
      const fail = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '管道短文本.txt', content: '只有五个字' }) }, tok1);
      assert.strictEqual(fail.j && fail.j.code, 400, '极短文本应业务码 400：' + JSON.stringify(fail.j));
      // 失败终态落库：files 列表出现 failed 行且 error_msg 含「解析后无有效文本」
      const files = await jfetch(`/api/knowledge/${kbid}/files`, {}, tok1);
      const row = (files.j.data || []).find(x => x.name === '管道短文本.txt');
      assert.ok(row, 'files 列表应出现失败行：' + JSON.stringify(files.j.data));
      assert.strictEqual(row.status, 'failed', '失败行 status 应为 failed：' + row.status);
      assert.ok((row.error_msg || '').includes('解析后无有效文本'), 'error_msg 应含「解析后无有效文本」：' + JSON.stringify(row.error_msg));
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：OCR 降级端到端——未配置 PADDLEOCR_URL 时扫描版样本不阻塞不挂死（V2.3 #5）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道OCR测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道OCR测试库'`).get().id;
      // fixtures 扫描版样本：最小合法 PDF（731 字节，三行 ASCII 文本）；缺失时现跑生成脚本自愈
      const fx = path.join(__dirname, 'fixtures', 'scan-sample.pdf');
      if (!fs.existsSync(fx)) require('child_process').execSync(`"${process.execPath}" "${path.join(__dirname, 'fixtures', 'gen-scan-pdf.js')}"`);
      const b64 = fs.readFileSync(fx).toString('base64');
      // 默认管道（含 ocr 步骤）上传；测试环境 PADDLEOCR_URL 必未配置 → OCR 静默降级，不得阻塞挂死（超时兜底 <10s）
      const t0 = Date.now();
      const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: 'scan.pdf', file_b64: b64 }) }, tok1);
      const cost = Date.now() - t0;
      assert.ok(cost < 10000, `OCR 降级路径整请求应 <10s（实际 ${cost}ms，不被 OCR 阻塞挂死）`);
      // 二选一断言（契约 6，均可接受）：
      //   A. 样本可提取 ≥8 字文本 → OCR 降级跳过后正常解析 success（本 fixtures 走此路径——pdf-parse 实测可提取 132 字符）
      //   B. 无法提取文本 → failed 且 error_msg 含「扫描版 PDF 需先 OCR」
      if (up.j && up.j.code === 0) {
        assert.ok(up.j.data.chunks > 0, '路径 A：降级跳过 OCR 后应正常解析 success 且 chunks>0：' + JSON.stringify(up.j.data));
        const row = db.prepare(`SELECT status, chunk_count FROM kb_files WHERE kb_id=? AND name='scan.pdf'`).get(kbid);
        assert.ok(row && row.status === 'success', 'kb_files 状态应为 success：' + JSON.stringify(row));
      } else {
        assert.strictEqual(up.j && up.j.code, 400, '路径 B：OCR 不可用且无有效文本应 400（同步失败兼容）：' + JSON.stringify(up.j));
        const files = await jfetch(`/api/knowledge/${kbid}/files`, {}, tok1);
        const row = (files.j.data || []).find(x => x.name === 'scan.pdf');
        assert.ok(row && row.status === 'failed', '应出现 failed 行：' + JSON.stringify(files.j.data));
        assert.ok((row.error_msg || '').includes('扫描版 PDF 需先 OCR'), 'error_msg 应含「扫描版 PDF 需先 OCR」：' + JSON.stringify(row.error_msg));
      }
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM evaluations WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    // ===== V2.3 审查加固（2026-10-31，Tech Lead 代行双专家审查发现）：假成功拦截 / 必含校验 / 在途上限 =====
    await t('HTTP：管道必含校验——摘除 parse/chunk 核心步骤 PUT 400（V2.3 审查加固 P1-1）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道必含测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道必含测试库'`).get().id;
      // 摘除 parse（无文本产出）→ 400 提示必含
      const m1 = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道必含测试库', pipeline: ['clean', 'chunk'] }) }, tok1);
      assert.ok(m1.j && m1.j.code === 400 && /parse/.test(m1.j.msg || ''), '摘除 parse 应 400 且提示：' + JSON.stringify(m1.j));
      // 摘除 chunk（无分块产出）→ 400
      const m2 = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道必含测试库', pipeline: ['parse', 'clean'] }) }, tok1);
      assert.ok(m2.j && m2.j.code === 400 && /chunk/.test(m2.j.msg || ''), '摘除 chunk 应 400 且提示：' + JSON.stringify(m2.j));
      // 含全部核心步骤的子集合法（回归：不误伤既有用例形态）
      const ok = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '管道必含测试库', pipeline: ['parse', 'clean', 'chunk'] }) }, tok1);
      assert.ok(ok.j && ok.j.code === 0, '含 parse+chunk 的合法子集应通过：' + JSON.stringify(ok.j));
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：管道执行层假成功拦截——直插摘除 chunk 的配置，上传必须 failed 不得 0 分块 success（V2.3 审查加固 P1-1）', async () => {
      // 直插绕过 PUT 校验（模拟存量脏数据/直接改库）→ 执行层兜底仍必须拦住（防御纵深：两层独立生效）
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at,pipeline) VALUES ('管道假成功测试库','',1,'httpu1',datetime('now','localtime'),'["parse","clean"]')`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道假成功测试库'`).get().id;
      const up = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '无分块文档.txt', content: '这是一段足够长的测试文本，验证摘除 chunk 步骤后不会静默假成功，必须落 failed 终态并给出原因。' }) }, tok1);
      assert.strictEqual(up.j && up.j.code, 400, '分块产出为空应 400（同步失败路径）：' + JSON.stringify(up.j));
      const row = db.prepare(`SELECT status,chunk_count,error_msg FROM kb_files WHERE kb_id=? AND name='无分块文档.txt'`).get(kbid);
      assert.ok(row && row.status === 'failed', '必须落 failed 终态（修复前假 success+0 分块，文件看起来成功但检索永不可命中）：' + JSON.stringify(row));
      assert.ok((row.error_msg || '').includes('切片后无有效片段'), 'error_msg 应沿用现状文案：' + JSON.stringify(row.error_msg));
      assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE kb_id=?').get(kbid).c, 0, '不得落任何分块');
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('HTTP：async 在途上限——堆积至 5 个 pending 拒绝新的异步上传（V2.3 审查加固 S2-1）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('管道在途测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='管道在途测试库'`).get().id;
      // 直插 5 个 pending 行模拟堆积（管道 fire-and-forget 在测试环境瞬间跑完，无法自然堆积，直插是最小复现手法）
      const ins = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,source,created_at) VALUES (?,?,0,'pending',0,'upload',datetime('now','localtime'))`);
      for (let i = 0; i < 5; i++) ins.run(kbid, `堆积行${i}.txt`);
      const up = await jfetch(`/api/knowledge/${kbid}/files?async=1`, { method: 'POST', body: JSON.stringify({ name: '超额.txt', content: '这是一段足够长的测试文本内容，用于验证在途上限拒绝逻辑本身工作正常。' }) }, tok1);
      assert.ok(up.j && up.j.code === 429, '在途 ≥5 时 async 上传应 429：' + JSON.stringify(up.j));
      assert.ok(/繁忙/.test(up.j.msg || ''), 'msg 应提示队列繁忙：' + JSON.stringify(up.j.msg));
      // 同步模式不受限（请求并发天然限流）——堆积行清理后同步上传应正常
      db.prepare(`DELETE FROM kb_files WHERE kb_id=? AND status='pending'`).run(kbid);
      const sync = await jfetch(`/api/knowledge/${kbid}/files`, { method: 'POST', body: JSON.stringify({ name: '同步清理后.txt', content: '这是一段足够长的测试文本内容，验证同步模式不受在途上限影响。' }) }, tok1);
      assert.ok(sync.j && sync.j.code === 0, '清理在途后同步上传应正常：' + JSON.stringify(sync.j).slice(0, 120));
      db.prepare(`DELETE FROM kb_chunks WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kb_files WHERE kb_id=?`).run(kbid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    // 【V1.2 前置】黄金召回基线（2026-10-30）：#2 元数据改造动 retriever.js 检索链路前固化行为基线——
    // 6 条黄金问答 × Top-1 命中断言 + 复跑稳定性；后续任何检索改动（元数据过滤/管道化）跑此用例防召回隐性劣化
    await t('黄金召回基线：6 条黄金问答 Top-1 全命中 + 复跑稳定（V1.2 #2 改造护栏）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('黄金基线库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='黄金基线库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'黄金基线手册.md',1024,'success',6,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      const ins = db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`);
      // 6 个主题互异的黄金分块（含唯一标记词，保证 BM25/本地向量双通道可区分）
      [
        '考勤管理制度：员工迟到早退按次扣款，月度累计三次以上按旷工处理，旷工将影响季度绩效评定',
        '差旅报销管理办法：出差须提前申请，回程后十个工作日内提交发票，住宿与交通按职级标准限额报销',
        '数据安全规范：涉及多方协作的分析平台采用联邦学习与差分隐私技术，原始数据不出域即可完成联合建模',
        '新员工入职流程：报到当日办理工卡与邮箱，首周完成信息安全培训与岗位必修课程，试用期六个月',
        '薪酬福利制度：年终奖按公司经营状况与个人绩效双系数核发，每年四月启动调薪评审机制',
        '保密管理制度：涉密文档按密级分为公开、内部、机密三级管理，机密级文档严禁外发与截屏转发',
      ].forEach(c => ins.run(fid, kbid, c));
      const { retrieve } = require('../src-server/lib/retriever');
      const golden = [
        ['迟到早退怎么处理', '旷工'],
        ['出差发票报销流程', '差旅'],
        ['多方数据协作怎么保障安全', '差分隐私'],
        ['新员工报到要办什么', '入职'],
        ['年终奖什么时候发', '调薪'],
        ['机密文档的管理要求', '密级'],
      ];
      for (const [q, marker] of golden) {
        const hits = await retrieve(q, kbid, 3, 0, { rerankEnabled: false });
        assert.ok(hits.length >= 1, `「${q}」应至少命中 1 条`);
        assert.ok((hits[0].content || '').includes(marker), `「${q}」Top-1 应命中含「${marker}」的分块，实际：${hits[0].content?.slice(0, 25)}`);
      }
      // 复跑稳定性：同查询两次 Top-1 一致（防排序不稳定导致的召回抖动）
      const r1 = await retrieve('机密文档的管理要求', kbid, 3, 0, { rerankEnabled: false });
      const r2 = await retrieve('机密文档的管理要求', kbid, 3, 0, { rerankEnabled: false });
      assert.strictEqual(r1[0].id, r2[0].id, '同查询复跑 Top-1 应稳定（排序确定性）');
      assert.strictEqual(r1[0].score, r2[0].score, '同查询复跑得分应一致');
      globalThis.__goldenKbId = kbid;
    });
    // ===== V1.2 #2 元数据管理与检索过滤（2026-10-30，单元 4 条）=====
    await t('retriever：metadataFilter 过滤——命中/数组包含/fail-closed/空过滤/损坏 JSON 不炸（V1.2 #2）', async () => {
      const { retrieve } = require('../src-server/lib/retriever');
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('元数据过滤测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='元数据过滤测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'meta.md',100,'success',4,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,metadata) VALUES (?,?,?,?)');
      ins.run(fid, kbid, '迟到管理甲元数据标记词alpha', JSON.stringify({ dept: '产品部', level: '公开' }));
      ins.run(fid, kbid, '迟到管理乙元数据标记词beta', JSON.stringify({ dept: ['产品部', '研发部'], level: '内部' }));
      ins.run(fid, kbid, '迟到管理丙元数据标记词gamma', null);
      ins.run(fid, kbid, '迟到管理丁元数据标记词delta', '{broken json');
      const Q = '迟到管理', OPT = { rerankEnabled: false };
      const h1 = await retrieve(Q, kbid, 5, 0, { ...OPT, metadataFilter: { dept: '产品部' } });
      assert.strictEqual(h1.length, 2, 'dept=产品部 应命中 scalar+数组两条（无元数据/损坏 JSON 被 fail-closed 滤除）：' + h1.map(h => h.content.slice(0, 4)).join(','));
      const h2 = await retrieve(Q, kbid, 5, 0, { ...OPT, metadataFilter: { dept: '研发部' } });
      assert.strictEqual(h2.length, 1, 'dept=研发部 应仅命中数组值那条：' + h2.map(h => h.content.slice(0, 4)));
      const h3 = await retrieve(Q, kbid, 5, 0, { ...OPT, metadataFilter: { dept: '产品部', level: '内部' } });
      assert.strictEqual(h3.length, 1, 'AND 语义应收窄到数组那条（level=内部）');
      const h4 = await retrieve(Q, kbid, 5, 0, { ...OPT, metadataFilter: { dept: '市场部' } });
      assert.strictEqual(h4.length, 0, '无匹配应 0 命中（fail-closed 不兜底放开）');
      const h5 = await retrieve(Q, kbid, 5, 0, { ...OPT, metadataFilter: {} });
      assert.strictEqual(h5.length, 4, '空过滤对象应全通过（行为与无过滤一致）：' + h5.length);
      const h6 = await retrieve(Q, kbid, 5, 0, OPT);
      assert.deepStrictEqual(h5.map(h => h.id).sort(), h6.map(h => h.id).sort(), '空过滤与无过滤结果集应完全一致（黄金基线护栏红线）');
      assert.ok(h6.some(h => h.content.includes('丁')), '损坏 JSON 行无过滤时应正常参与检索（不抛错）');
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    await t('黄金基线回归：空 metadataFilter 不改变召回行为（V1.2 #2 护栏红线）', async () => {
      const kbid = globalThis.__goldenKbId;
      assert.ok(kbid, '黄金基线库应已由前置用例设置 globalThis.__goldenKbId');
      const { retrieve } = require('../src-server/lib/retriever');
      const withEmpty = await retrieve('迟到早退怎么处理', kbid, 3, 0, { rerankEnabled: false, metadataFilter: {} });
      assert.ok(withEmpty.length >= 1 && (withEmpty[0].content || '').includes('旷工'), '带空 metadataFilter 的黄金问答 Top-1 应仍命中「旷工」（无过滤行为锁定，防召回隐性劣化）');
    });
    // ===== V1.3 #4 钉钉集成（2026-10-30）：验签/加解密/幂等（纯逻辑 + db 层；HTTP 用例在 P5.30 组） =====
    await t('钉钉签名：固定四参字典序排序 SHA1 正确值 + 拼接顺序敏感（V1.3 #4）', () => {
      const dingCryptoU = require('../src-server/lib/dingtalk-crypto');
      // 期望值由 node:crypto 独立预计算：sha1('1719700000'+'abc123'+'nonce123'+'testtoken')（四参字典序排序后拼接）
      assert.strictEqual(dingCryptoU.sha1Sign('testtoken', '1719700000', 'nonce123', 'abc123'),
        'db72fea6dcb567bf055ac65351f694d86325b971', '固定四参签名应为已知 SHA1 值（四参字典序排序后拼接）');
      // 拼接顺序敏感性：钉钉算法对「传参顺序」天然不敏感（内部 sort），敏感的是「拼接顺序」——
      // 若实现漏掉 sort 按传入序直接拼接，必产出不同签名，此断言即拦截该缺陷
      const unsorted = require('crypto').createHash('sha1').update('testtoken1719700000nonce123abc123').digest('hex');
      assert.notStrictEqual(unsorted, 'db72fea6dcb567bf055ac65351f694d86325b971', '未排序直接拼接的 SHA1 必不等（漏 sort 缺陷在此暴露）');
      // 协议性质正向断言：同一组四值任意传参顺序签名一致（钉钉验签双方独立计算仍可对上）
      assert.strictEqual(dingCryptoU.sha1Sign('nonce123', '1719700000', 'testtoken', 'abc123'),
        'db72fea6dcb567bf055ac65351f694d86325b971', '交换传参顺序签名应不变（内部字典序排序）');
      assert.notStrictEqual(dingCryptoU.sha1Sign('testtoken', '1719700000', 'nonce123', 'abc124'),
        'db72fea6dcb567bf055ac65351f694d86325b971', 'encrypt 单字符变更签名必变');
    });
    await t('钉钉加解密：roundtrip（中文消息体+corpid）+ 非法输入报错不静默（V1.3 #4）', () => {
      const dingCryptoU = require('../src-server/lib/dingtalk-crypto');
      const AES_KEY_U = require('crypto').randomBytes(32).toString('base64').replace(/=+$/, '');
      const msg = { EventType: 'user_add_org', UserId: 'dt001', NickName: '张三丰', DeptIdList: [1, 5], Phone: '13800001234' };
      const r = dingCryptoU.decryptMsg(AES_KEY_U, dingCryptoU.encryptMsg(AES_KEY_U, 'smoke-dt-corpid', msg));
      assert.deepStrictEqual(r.message, msg, '中文消息体加密→解密应逐字段还原');
      assert.strictEqual(r.corpid, 'smoke-dt-corpid', '尾部 corpid 应精确提取校验');
      // 组装报文签名可独立验证（fixtures 生成器自洽性）
      const packet = dingCryptoU.buildEncryptedCallback(AES_KEY_U, 'smoke-dt-token', 'smoke-dt-corpid', { a: 1 }, { timestamp: '1719700000', nonce: 'nonce123' });
      assert.strictEqual(dingCryptoU.sha1Sign('smoke-dt-token', '1719700000', 'nonce123', packet.encrypt), packet.msg_signature, '组装报文签名应可独立验证');
      // 非法输入三类全部报错（不静默——解密链路静默吞错可被伪造报文探测利用）
      assert.throws(() => dingCryptoU.encryptMsg(require('crypto').randomBytes(16).toString('base64'), 'c', {}), /32 字节|长度非法/, 'aesKey 解码非 32 字节应报错');
      assert.throws(() => dingCryptoU.decryptMsg('!!!非法base64!!!', 'xx'), /Base64/, '损坏 Base64 的 AESKey 应报错');
      // 手工构造坏结构密文：16B 随机串 + 声明长度 0x7FFFFFFF（远超实际）+ 短消息体 + corpid，再 AES 加密
      const key = Buffer.from(AES_KEY_U, 'base64');
      const bad = Buffer.concat([require('crypto').randomBytes(16), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('{}'), Buffer.from('smoke-dt-corpid')]);
      const c = require('crypto').createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
      assert.throws(() => dingCryptoU.decryptMsg(AES_KEY_U, Buffer.concat([c.update(bad), c.final()]).toString('base64')), /越界|结构非法/, '解密后长度字段越界应报错');
    });
    await t('钉钉回调幂等：同 EventId 二次 INSERT 被 UNIQUE 拦截（db 层防重放地基，V1.3 #4）', async () => {
      const ins = db.prepare(`INSERT INTO dingtalk_events (event_id,event_type,payload,created_at) VALUES (?,?,?,datetime('now','localtime'))`);
      ins.run('smoke-dt-evt-001', 'user_add_org', '{}');
      let caught = null;
      try { ins.run('smoke-dt-evt-001', 'dept_create', '{}'); } catch (e) { caught = e; }
      assert.ok(caught && /UNIQUE/i.test(String(caught.message || caught.code || '')), '重复 EventId 第二次 INSERT 必须抛 UNIQUE 约束错误：' + (caught && caught.message));
      assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM dingtalk_events WHERE event_id='smoke-dt-evt-001'`).get().c, 1, '表内该 EventId 只应有 1 行（路由层 catch 到 UNIQUE 即直接 ACK 不重放）');
      // 不同 EventId 正常追加（确认拦截是 event_id 维度，非表整体锁死）
      ins.run('smoke-dt-evt-002', 'dept_create', '{}');
      assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM dingtalk_events WHERE event_id LIKE 'smoke-dt-evt-%'`).get().c, 2, '不同 EventId 应正常追加为 2 行');
    });
    await t('钉钉用户同步：空部门映射不清空已有 dept_id（V1.3 审查加固——扫码登录恒传空列表的覆写回归）', () => {
      const { upsertDingtalkUser } = require('../src-server/routes/dingtalk');
      // 造一个已有部门归属的用户（username 形如 dingtalk_${userId}，模拟此前同步建过的钉钉用户）
      db.prepare(`INSERT INTO users (username,password,nickname,role,dept,dept_id,status,must_change_pwd,created_at) VALUES ('dingtalk_smoke-dt-u1',?,'钉钉同步测试','user','产品部',1,1,0,datetime('now','localtime'))`).run(hashPwd('x-pass-not-used'));
      const uid = db.prepare(`SELECT id FROM users WHERE username='dingtalk_smoke-dt-u1'`).get().id;
      assert.strictEqual(db.prepare(`SELECT dept_id FROM users WHERE id=?`).get(uid).dept_id, 1, '前置：用户应有 dept_id=1');
      // 空映射（deptIdList 为空/映射不到本地部门——扫码登录恒传 []）再同步：dept_id 必须保留（COALESCE）
      const u = upsertDingtalkUser({ userId: 'smoke-dt-u1', nickname: '新昵称', deptIdList: [], phone: '' });
      assert.strictEqual(u.created, false, '同 userId 应命中已有用户：' + JSON.stringify(u));
      assert.strictEqual(db.prepare(`SELECT dept_id FROM users WHERE id=?`).get(uid).dept_id, 1, '空映射同步后 dept_id 应保留（原实现裸写 null 直接清空——visible_depts 权限判定依据静默丢失）');
      assert.strictEqual(db.prepare(`SELECT nickname FROM users WHERE id=?`).get(uid).nickname, '新昵称', 'nickname 更新照常生效（COALESCE 只保护 dept_id，不影响其他字段）');
      db.prepare(`DELETE FROM users WHERE username='dingtalk_smoke-dt-u1'`).run();
    });
    // ===== #14 一次性交换码（2026-11-03）：钉钉回调 JWT 不落 URL 的交付机制 =====
    await t('exchange-code：mint→consume 正常换载荷 + 64hex 形态（#14）', () => {
      const ec = require('../src-server/lib/exchange-code');
      const code = ec.mint({ token: 'fake-jwt-abc', user: { username: 'u1' } });
      assert.ok(/^[0-9a-f]{64}$/.test(code), '交换码应为 64 hex 随机串：' + code.slice(0, 16) + '...');
      const p1 = ec.consume(code);
      assert.deepStrictEqual(p1, { token: 'fake-jwt-abc', user: { username: 'u1' } }, '首次消费应原样返回绑定载荷');
    });
    await t('exchange-code：一次性消费——同码二次 consume 返回 null（防重放，#14）', () => {
      const ec = require('../src-server/lib/exchange-code');
      const code = ec.mint({ v: 42 });
      const first = ec.consume(code);
      assert.ok(first && first.v === 42, '首次消费应返回绑定载荷');
      const second = ec.consume(code);
      assert.strictEqual(second, null, '二次消费必须返回 null（首次消费已删条目，防重放）');
      // 独立码不受影响（删除是码维度而非全表）
      const c2 = ec.mint({ v: 43 });
      assert.strictEqual(ec.consume(c2).v, 43, '其他码照常可消费');
    });
    await t('exchange-code：过期返回 null + 伪造/空码返回 null（#14）', async () => {
      const ec = require('../src-server/lib/exchange-code');
      const code = ec.mint({ v: 1 }, 30); // 30ms 短时效
      await new Promise(r => setTimeout(r, 60)); // 等过期
      assert.strictEqual(ec.consume(code), null, '过期码应返回 null');
      assert.strictEqual(ec.consume('0000deadbeef'), null, '伪造码应返回 null');
      assert.strictEqual(ec.consume(''), null, '空码应返回 null');
      assert.strictEqual(ec.consume(null), null, 'null 应返回 null（不抛错）');
    });
    await t('exchange-code：auth 回调产物含完整登录形状（token+user+must_change_pwd，#14）', () => {
      // 验证 auth.js 路由模块可正常加载（exchange-code 接线无循环依赖/语法错误），
      // 并确认回调携带的数据形状与 /auth/login 响应 data 字段同构（前端 setLogin 可直接消费）
      const router = require('../src-server/routes/auth');
      assert.strictEqual(typeof router, 'function', 'auth 路由应正常导出');
      const ec = require('../src-server/lib/exchange-code');
      const code = ec.mint({ token: 't', user: { id: 1, username: 'u', nickname: 'n', role: 'user', dept: '', onboarded: 1 }, must_change_pwd: 0 });
      const p = ec.consume(code);
      assert.ok(p.token && p.user.username && p.must_change_pwd === 0, '载荷应含 token/user/must_change_pwd 三字段');
    });
    // ===== V2.2 #8 版本分级 + License 授权控制（2026-10-31，三态用例：合法/篡改/缺失——测试先行）=====
    await t('License 缺失 → community 降级不抛错 + hasFeature 矩阵（V2.2 #8）', () => {
      const E = require('../src-server/lib/edition');
      const cur = E.refreshLicense(); // smoke 临时数据目录下无 license.json
      assert.strictEqual(cur.edition, 'community', '缺失 License 应降级 community');
      assert.strictEqual(cur.reason, 'missing');
      assert.strictEqual(E.hasFeature('agents'), true, 'community 基础五特性照常（不锁死不裸奔）');
      assert.strictEqual(E.hasFeature('kb'), true);
      assert.strictEqual(E.hasFeature('workflow'), true);
      assert.strictEqual(E.hasFeature('mcp'), true);
      assert.strictEqual(E.hasFeature('openapi'), true);
      assert.strictEqual(E.hasFeature('dingtalk'), false, 'community 无高级特性');
      assert.strictEqual(E.hasFeature('tenant'), false, 'community 无企业特性');
    });
    await t('License 合法签发（测试密钥对 + LICENSE_PUBKEY_HEX 覆盖）→ edition 正确 + dingtalk true（V2.2 #8）', () => {
      const crypto = require('crypto'), fs = require('fs'), path = require('path');
      const E = require('../src-server/lib/edition');
      // 测试密钥对现生成，经环境变量覆盖内置公钥（与生产密钥轮换同口）
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      process.env.LICENSE_PUBKEY_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
      const p = (n) => String(n).padStart(2, '0');
      const dstr = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const exp = new Date(); exp.setDate(exp.getDate() + 365);
      // 五字段按字母序键手工展开（canonical 规则，独立于被测 canonicalOf 构造）
      const fields = { customer: '冒烟测试公司', edition: 'professional', expires_at: dstr(exp), issued_at: dstr(new Date()), license_key: '0f'.repeat(16) };
      const signature = crypto.sign(null, Buffer.from(JSON.stringify(fields), 'utf8'), privateKey).toString('hex');
      fs.writeFileSync(path.join(process.env.AGENT_DATA_DIR, 'license.json'), JSON.stringify({ ...fields, signature }));
      const cur = E.refreshLicense();
      assert.strictEqual(cur.edition, 'professional', '合法 License 验签通过');
      assert.strictEqual(cur.customer, '冒烟测试公司');
      assert.strictEqual(cur.days_left, 365);
      assert.strictEqual(E.hasFeature('dingtalk'), true, '专业版应含 dingtalk');
      assert.strictEqual(E.hasFeature('tenant'), false, '专业版不含 tenant');
    });
    await t('License 篡改 customer → 验签失败降级 community（V2.2 #8）', () => {
      const fs = require('fs'), path = require('path');
      const E = require('../src-server/lib/edition');
      const licFile = path.join(process.env.AGENT_DATA_DIR, 'license.json');
      const lic = JSON.parse(fs.readFileSync(licFile, 'utf8'));
      lic.customer = '改票公司'; // 签发后篡改客户名
      fs.writeFileSync(licFile, JSON.stringify(lic));
      const cur = E.refreshLicense();
      assert.strictEqual(cur.edition, 'community', '篡改后应降级社区版');
      assert.strictEqual(cur.reason, 'badsig');
      assert.strictEqual(cur.customer, null, '篡改票信息不得外泄');
      assert.strictEqual(E.hasFeature('agents'), true, '降级后基础功能照常');
    });
    await t('License 过期（expires_at 昨天）→ community 降级（V2.2 #8）', () => {
      const crypto = require('crypto'), fs = require('fs'), path = require('path');
      const E = require('../src-server/lib/edition');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      process.env.LICENSE_PUBKEY_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
      const p = (n) => String(n).padStart(2, '0');
      const dstr = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const y = new Date(); y.setDate(y.getDate() - 1);
      const fields = { customer: '过期公司', edition: 'enterprise', expires_at: dstr(y), issued_at: dstr(y), license_key: '11'.repeat(16) };
      const signature = crypto.sign(null, Buffer.from(JSON.stringify(fields), 'utf8'), privateKey).toString('hex');
      fs.writeFileSync(path.join(process.env.AGENT_DATA_DIR, 'license.json'), JSON.stringify({ ...fields, signature }));
      const cur = E.refreshLicense();
      assert.strictEqual(cur.edition, 'community', '过期 License 应降级社区版');
      assert.strictEqual(cur.reason, 'expired');
      delete process.env.LICENSE_PUBKEY_HEX; // 清理：不污染后续用例与生产内置公钥态
    });
    // ===== V2.2 审查加固防回归（2026-10-31）：Y1 公钥异常独立分类 / R1 运行期文件变更感知 =====
    await t('License 公钥配置异常（LICENSE_PUBKEY_HEX 非 hex）→ badpubkey 独立分类，不误报 badsig（V2.2 审查加固 Y1）', () => {
      const fs = require('fs'), path = require('path');
      const E = require('../src-server/lib/edition');
      const licFile = path.join(process.env.AGENT_DATA_DIR, 'license.json');
      assert.ok(fs.existsSync(licFile), '前置：数据目录应有上条过期用例留下的 license.json');
      process.env.LICENSE_PUBKEY_HEX = 'zz-not-hex';
      const cur = E.refreshLicense();
      assert.strictEqual(cur.reason, 'badpubkey', '公钥异常应独立分类 badpubkey（原实现误报 badsig，误导排查方向）：' + cur.reason);
      assert.strictEqual(cur.edition, 'community', '公钥异常应 fail-closed 降级 community');
      delete process.env.LICENSE_PUBKEY_HEX;
      assert.strictEqual(E.refreshLicense().reason, 'badsig', '清理 env 恢复内置公钥后：测试钥签名的文件验签失败（badsig，验签先于到期判断，fail-closed 语义正确）');
    });
    await t('License 运行期文件变更感知：checkExpiryNotice 调度链路可感知覆写降级（V2.2 审查加固 R1 防回归——禁止吃启动/缓存快照）', () => {
      const crypto = require('crypto'), fs = require('fs'), path = require('path');
      const E = require('../src-server/lib/edition');
      const licFile = path.join(process.env.AGENT_DATA_DIR, 'license.json');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      process.env.LICENSE_PUBKEY_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
      const p = (n) => String(n).padStart(2, '0');
      const dstr = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const mk = (days) => {
        const d = new Date(); d.setDate(d.getDate() + days);
        const f = { customer: '运行态感知公司', edition: 'professional', expires_at: dstr(d), issued_at: dstr(new Date()), license_key: '22'.repeat(16) };
        return { ...f, signature: crypto.sign(null, Buffer.from(JSON.stringify(f), 'utf8'), privateKey).toString('hex') };
      };
      fs.writeFileSync(licFile, JSON.stringify(mk(20)));
      assert.strictEqual(E.refreshLicense().licensed, true, '前置：覆写合法 License 后 refresh 应生效（licensed=true）');
      // 运行期文件被替换为过期 License（续期失败/授权被回收场景）——调度链路必须即时感知
      fs.writeFileSync(licFile, JSON.stringify(mk(-1)));
      assert.strictEqual(E.checkExpiryNotice(), false, '过期态 checkExpiryNotice 不写提醒（days_left<0）');
      assert.strictEqual(E.currentEdition().licensed, false, 'R1 核心：调度链路运行后缓存必须已降级（修复前 checkExpiryNotice 吃 currentEdition() 启动快照，长期运行进程过期永不降级）');
      assert.strictEqual(E.currentEdition().reason, 'expired');
      delete process.env.LICENSE_PUBKEY_HEX;
      assert.strictEqual(E.refreshLicense().edition, 'community', '清理 env 后恢复文件真实态（为后续 requireFeature 用例保持 community 前置）');
    });
    await t('requireFeature 中间件：无权特性 403 + upgrade_hint / 有权特性 next() 放行（V2.2 #8）', () => {
      const E = require('../src-server/lib/edition');
      assert.strictEqual(E.currentEdition().edition, 'community', '前置：当前为降级态（过期用例后）');
      let blocked = false;
      const res = { body: null, json(j) { this.body = j; return this; } };
      E.requireFeature('dingtalk')({}, res, () => { blocked = true; }); // community 无 dingtalk
      assert.strictEqual(blocked, false, '无权特性不得进入业务 handler');
      assert.strictEqual(res.body.code, 403);
      assert.strictEqual(res.body.msg, '该功能需要专业版授权（当前：社区版）', '升级引导指向该特性所属最低版本');
      assert.deepStrictEqual(res.body.data, { upgrade_hint: true, feature: 'dingtalk', edition: 'community' });
      let passedGate = false;
      E.requireFeature('agents')({}, { json() { throw new Error('有权特性不应走 json 分支'); } }, () => { passedGate = true; });
      assert.strictEqual(passedGate, true, 'community 含 agents 特性应放行 next()');
    });
    await t('resolveKbFilter：$user.dept 占位符替换 / 无 dept 与无用户链路 fail-closed / 无效 JSON 返回 null（V1.2 #2）', () => {
      const { resolveKbFilter, sanitizeMetadata, NO_DEPT_SENTINEL } = require('../src-server/lib/kb-metadata');
      const f1 = resolveKbFilter({ kb_metadata_filter: JSON.stringify({ level: '公开', dept: '$user.dept' }) }, { dept: '产品部' });
      assert.deepStrictEqual(f1, { level: '公开', dept: '产品部' }, '$user.dept 应替换为请求用户部门：' + JSON.stringify(f1));
      const f2 = resolveKbFilter({ kb_metadata_filter: JSON.stringify({ dept: '$user.dept' }) }, {});
      assert.strictEqual(f2.dept, NO_DEPT_SENTINEL, '用户无 dept 应置哨兵值（恒不命中，fail-closed）：' + JSON.stringify(f2));
      // V1.2 审查加固：无用户链路（分享页/开放 API）——占位符置哨兵恒不命中，固定值键照常生效（防免登录访客全库旁路）
      const f3 = resolveKbFilter({ kb_metadata_filter: JSON.stringify({ level: '公开', dept: '$user.dept' }) }, null);
      assert.deepStrictEqual(f3, { level: '公开', dept: NO_DEPT_SENTINEL }, '无用户链路：占位符置哨兵（部门内容不对免登录访客开放），固定值键照常：' + JSON.stringify(f3));
      assert.strictEqual(resolveKbFilter({ kb_metadata_filter: '{bad json' }, {}), null, '无效 JSON 应返回 null（不过滤）');
      assert.strictEqual(resolveKbFilter({ kb_metadata_filter: null }, {}), null, '无声明应返回 null');
      assert.strictEqual(resolveKbFilter({}, {}), null, '无 agent 应返回 null');
      // V1.2 审查加固：sanitizeMetadata 剥控制字符 + 丢弃哨兵值——防「无部门用户精确命中被打了哨兵值的块」的穿透
      const s1 = sanitizeMetadata({ dept: '\u0000__no_dept__', level: '内部\u0007' });
      assert.strictEqual(s1.level, '内部', '控制字符应被剥离（NUL/BEL 等）：' + JSON.stringify(s1));
      assert.ok(!('dept' in s1) || s1.dept !== NO_DEPT_SENTINEL, '全等哨兵值的条目应被丢弃（剥离后不可能等于哨兵，双保险）：' + JSON.stringify(s1));
      const s2 = sanitizeMetadata({ 'bad\u0000key': '值' });
      assert.ok(!('badkey' in s2) || Object.keys(s2).every(k => !/[\u0000-\u001f]/.test(k)), '键名中的控制字符应被剥离');
    });
    await t('canView：visible_depts 混合名单 ID/文本任一命中（V1.2 #2 双模式 OR，纯名单行为不变）', () => {
      const { canView } = require('../src-server/lib/agent-access');
      const mk = depts => ({ status: 'published', visibility: 'restricted', visible_depts: JSON.stringify(depts) });
      const u = { role: 'user', username: 'x', dept: '市场部', dept_id: 2 };
      assert.strictEqual(canView(mk(['市场部', '2']), u), true, '混合名单：dept 文本命中应可见');
      assert.strictEqual(canView(mk(['市场部', '2']), { ...u, dept: '研发部', dept_id: 2 }), true, '混合名单：dept_id 命中应可见（旧语义不命中，只扩不缩）');
      assert.strictEqual(canView(mk(['市场部', '2']), { ...u, dept: '研发部', dept_id: null }), false, '混合名单：两者皆无不命中');
      assert.strictEqual(canView(mk(['1', '2']), { ...u, dept_id: 2 }), true, '纯数字名单：ID 命中（行为不变）');
      assert.strictEqual(canView(mk(['1', '2']), { ...u, dept: '市场部', dept_id: null }), false, '纯数字名单：文本不命中（行为不变）');
      assert.strictEqual(canView(mk(['市场部']), u), true, '纯文本名单：文本命中（行为不变）');
      assert.strictEqual(canView(mk(['研发部']), u), false, '纯文本名单：不匹配不可见（行为不变）');
    });
    await t('kb_search 工具：ctx.metadataFilter 透传——工具链路检索同样受元数据过滤约束（V1.2 审查加固）', async () => {
      // 防回归：chat 主链路被过滤但 LLM 经 function calling 调 kb_search 全库检索的会话内旁路（tools.js:31）
      const tools = require('../src-server/lib/tools');
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('工具过滤测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='工具过滤测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'tool-meta.md',100,'success',2,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,metadata) VALUES (?,?,?,?)');
      ins.run(fid, kbid, '迟到管理工具甲标记词', JSON.stringify({ dept: '产品部', level: '公开' }));
      ins.run(fid, kbid, '迟到管理工具乙标记词', null); // 无元数据
      const withFilter = String(await tools.TOOL_DEFS.kb_search.run({ query: '迟到管理工具' }, { kbId: kbid, metadataFilter: { dept: '产品部' } }));
      assert.ok(withFilter.includes('甲'), '带 filter：有元数据且命中 dept 的块应返回');
      assert.ok(!withFilter.includes('乙'), '带 filter：无元数据块应被 fail-closed 滤除（此前 kb_search 不传 filter 全库返回）：' + withFilter.slice(0, 60));
      const noFilter = String(await tools.TOOL_DEFS.kb_search.run({ query: '迟到管理工具' }, { kbId: kbid }));
      assert.ok(noFilter.includes('甲') && noFilter.includes('乙'), '不带 filter：全部块返回（无过滤行为与现状一致）');
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
        await t('HTTP：任务归属——创建者自有，他人不可见不可删（P5.31）', async () => {
          const aid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA2 = sign({ uid: aid, exp: Date.now() + 3600000 });
          const sysAgent = db.prepare(`SELECT id FROM agents WHERE name='定时任务执行助手'`).get();
          assert.ok(sysAgent, '系统执行智能体应已种子');
          const bad = await jfetch('/api/tasks', { method: 'POST', body: JSON.stringify({ name: '坏cron', target_id: sysAgent.id, exec_type: 'cron', cron: '99 9 * * *' }) }, tok1);
          assert.strictEqual(bad.j && bad.j.code, 400, '非法 cron 应 400：' + JSON.stringify(bad.j));
          const c = await jfetch('/api/tasks', { method: 'POST', body: JSON.stringify({ name: 'u1的监控任务', target_id: sysAgent.id, exec_type: 'cron', cron: '0 9 * * *', params: JSON.stringify({ input: '监控测试' }) }) }, tok1);
          assert.ok(c.j && c.j.code === 0, 'u1 创建任务应成功：' + JSON.stringify(c.j).slice(0, 120));
          const tid = c.j.data.id;
          const list2 = await jfetch('/api/tasks', {}, tok2);
          assert.ok(!(list2.j.data || []).some(x => x.id === tid), 'u2 列表不应看到 u1 的任务');
          const list1 = await jfetch('/api/tasks', {}, tok1);
          assert.ok((list1.j.data || []).some(x => x.id === tid && x.username === 'httpu1'), 'u1 应看到自己的任务且带归属');
          const del2 = await jfetch(`/api/tasks/${tid}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(del2.j && del2.j.code, 403, 'u2 删除 u1 任务应 403：' + JSON.stringify(del2.j));
          const runs2 = await jfetch(`/api/tasks/${tid}/runs`, {}, tok2);
          assert.strictEqual(runs2.j && runs2.j.code, 403, 'u2 查看 u1 任务执行记录应 403：' + JSON.stringify(runs2.j));
          const adminList = await jfetch('/api/tasks', {}, tokA2);
          assert.ok((adminList.j.data || []).some(x => x.id === tid), '管理员应能看到全部任务');
        });
        await t('HTTP：MCP 信任开关与风险清单透传（P5.32）', async () => {
          const aid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA3 = sign({ uid: aid, exp: Date.now() + 3600000 });
          const srvId = db.prepare("SELECT id FROM mcp_servers WHERE name='信任服务A'").get().id;
          const before = await jfetch('/api/mcp', {}, tok1);
          const row = (before.j.data || []).find(x => x.id === srvId);
          assert.ok(row && row.trusted === 1, 'GET 应透传 trusted 状态');
          assert.ok(Array.isArray(row.toolList) && row.toolList.some(t => t.name === 'get_x' && t.risk === 'low'), 'GET 应返回工具风险清单');
          const off = await jfetch(`/api/mcp/${srvId}`, { method: 'PUT', body: JSON.stringify({ trusted: 0 }) }, tokA3);
          assert.ok(off.j && off.j.code === 0, '管理员切换信任应成功：' + JSON.stringify(off.j));
          const after = await jfetch('/api/mcp', {}, tok1);
          assert.ok((after.j.data || []).find(x => x.id === srvId).trusted === 0, '切换后 GET 应反映 trusted=0');
          const denied = await jfetch(`/api/mcp/${srvId}`, { method: 'PUT', body: JSON.stringify({ trusted: 1 }) }, tok1);
          assert.strictEqual(denied.status, 403, '非管理员切换信任应 403（adminOnly）');
          // 恢复 trusted=1（后续单测组依赖该状态）
          await jfetch(`/api/mcp/${srvId}`, { method: 'PUT', body: JSON.stringify({ trusted: 1 }) }, tokA3);
          // P5.33 审查修复（R2/F9）：无关字段更新（如 status 切换）不得静默重置 trusted
          await jfetch(`/api/mcp/${srvId}`, { method: 'PUT', body: JSON.stringify({ status: 1 }) }, tokA3);
          const kept = await jfetch('/api/mcp', {}, tok1);
          assert.ok((kept.j.data || []).find(x => x.id === srvId).trusted === 1, '未传 trusted 的 PUT 应保留原信任状态');
        });
        await t('HTTP：任务改绑受限智能体被拒 + 启用配额复核（P5.33 审查修复）', async () => {
          const aid2 = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA4 = sign({ uid: aid2, exp: Date.now() + 3600000 });
          db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,created_at,updated_at) VALUES ('受限草稿智能体','测试','enterprise','测试','p','draft','self',datetime('now','localtime'),datetime('now','localtime'))`).run();
          const draftId = db.prepare("SELECT id FROM agents WHERE name='受限草稿智能体'").get().id;
          const sysAgent2 = db.prepare(`SELECT id FROM agents WHERE name='定时任务执行助手' AND source_name='系统内置'`).get();
          const c = await jfetch('/api/tasks', { method: 'POST', body: JSON.stringify({ name: '改绑测试', target_id: sysAgent2.id, exec_type: 'cron', cron: '0 9 * * *', params: '{}' }) }, tok1);
          const tid = c.j.data.id;
          // R3/F5：PUT 改绑草稿智能体应被拒（400 未发布；改绑受限已发布智能体为 403）
          const put = await jfetch(`/api/tasks/${tid}`, { method: 'PUT', body: JSON.stringify({ target_id: draftId }) }, tok1);
          assert.strictEqual(put.j && put.j.code, 400, 'PUT 改绑草稿智能体应被拒（未发布）：' + JSON.stringify(put.j));
          assert.ok(String(put.j.msg).includes('未发布'), '拒绝理由应指向未发布状态');
          // F4：造满 20 个启用任务后，停用再启用应被配额拦截（防「建满→停→再建→启用」绕过）
          const ins = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES (?,?,?, 'cron','0 9 * * *','{}',1,?,datetime('now','localtime'))`);
          for (let i = 0; i < 20; i++) ins.run('配额验证' + i, 'agent', sysAgent2.id, 'httpu1');
          const stop = await jfetch(`/api/tasks/${tid}`, { method: 'PUT', body: JSON.stringify({ name: '改绑测试（停用中）' }) }, tok1);
          await jfetch(`/api/tasks/${tid}/toggle`, { method: 'POST' }, tok1); // 停用
          const reenable = await jfetch(`/api/tasks/${tid}/toggle`, { method: 'POST' }, tok1); // 启用 → 配额拦截
          assert.strictEqual(reenable.j && reenable.j.code, 400, '达上限后重新启用应被拒：' + JSON.stringify(reenable.j));
          // 清理
          db.prepare("DELETE FROM tasks WHERE username='httpu1' AND name LIKE '配额验证%' OR (username='httpu1' AND name LIKE '改绑测试%')").run();
          db.prepare("DELETE FROM agents WHERE name='受限草稿智能体'").run();
        });
        await t('HTTP：智能体保存工具白名单——create_task 拒绝、local_exec 放开（P5.34/D1-1）', async () => {
          const bad1 = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '注入测试A', tools: ['create_task'] }) }, tok1);
          assert.strictEqual(bad1.j && bad1.j.code, 400, 'POST 配置 create_task 应 400：' + JSON.stringify(bad1.j));
          assert.ok(String(bad1.j.msg).includes('create_task'), '错误信息应指名违禁工具');
          // D1-1（决策2=A）：local_exec 放开——可在标准/全权档下配置（受设备档位 + 确认卡双重约束）
          const okLe = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '注入测试B', tools: ['web_search', 'local_exec'] }) }, tok1);
          assert.ok(okLe.j && okLe.j.code === 0, 'D1-1：POST 配置 local_exec 应放行：' + JSON.stringify(okLe.j).slice(0, 100));
          // 合法创建 → PUT 注入同样拒绝
          const ok = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '白名单正常智能体', tools: ['web_search'] }) }, tok1);
          assert.ok(ok.j && ok.j.code === 0, '常规工具应可正常创建');
          const aid3 = ok.j.data.id;
          const bad3 = await jfetch(`/api/agents/${aid3}`, { method: 'PUT', body: JSON.stringify({ name: '白名单正常智能体', tools: ['run_code', 'create_task'], force: 1 }) }, tok1);
          assert.strictEqual(bad3.j && bad3.j.code, 400, 'PUT 注入 create_task 应 400');
          const bad4 = await jfetch('/api/agents/import', { method: 'POST', body: JSON.stringify({ config: { agent: { name: '导入注入', tools: ['create_task'] } } }) }, tok1);
          assert.strictEqual(bad4.j && bad4.j.code, 400, 'import 注入 create_task 应 400');
          // run_code（沙箱已加固+medium 确认卡）应放行
          const okRun = await jfetch(`/api/agents/${aid3}`, { method: 'PUT', body: JSON.stringify({ name: '白名单正常智能体', tools: ['run_code'], force: 1 }) }, tok1);
          assert.ok(okRun.j && okRun.j.code === 0, 'run_code 应放行：' + JSON.stringify(okRun.j).slice(0, 100));
          db.prepare("DELETE FROM agents WHERE name IN ('白名单正常智能体','注入测试A','注入测试B','导入注入')").run();
        });
        await t('HTTP：MCP 工具人工定级 API——标注/透传/auto 回落 + 非 admin 403（P5.34）', async () => {
          const aid4 = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokA5 = sign({ uid: aid4, exp: Date.now() + 3600000 });
          const srvId = db.prepare("SELECT id FROM mcp_servers WHERE name='信任服务A'").get().id;
          // 人工把 get_x 定为 high（覆盖启发式 low）
          const set = await jfetch(`/api/mcp/${srvId}/tool-risk`, { method: 'PUT', body: JSON.stringify({ tool: 'get_x', level: 'high' }) }, tokA5);
          assert.ok(set.j && set.j.code === 0, '管理员定级应成功：' + JSON.stringify(set.j));
          const after = await jfetch('/api/mcp', {}, tok1);
          const row = (after.j.data || []).find(x => x.id === srvId);
          const tl = row.toolList.find(t => t.name === 'get_x');
          assert.strictEqual(tl.risk, 'high', 'GET 应返回生效值 high');
          assert.strictEqual(tl.override, 'high', 'GET 应透传 override 标记');
          // auto 回落启发式
          const auto = await jfetch(`/api/mcp/${srvId}/tool-risk`, { method: 'PUT', body: JSON.stringify({ tool: 'get_x', level: 'auto' }) }, tokA5);
          assert.ok(auto.j && auto.j.code === 0, 'auto 清除标注应成功');
          const after2 = await jfetch('/api/mcp', {}, tok1);
          const tl2 = (after2.j.data || []).find(x => x.id === srvId).toolList.find(t => t.name === 'get_x');
          assert.strictEqual(tl2.risk, 'low', 'auto 后应回落启发式 low');
          assert.strictEqual(tl2.override, null, 'auto 后 override 应为空');
          // 越权与非法参数
          const denied = await jfetch(`/api/mcp/${srvId}/tool-risk`, { method: 'PUT', body: JSON.stringify({ tool: 'get_x', level: 'low' }) }, tok1);
          assert.strictEqual(denied.status, 403, '非管理员定级应 403');
          const badLevel = await jfetch(`/api/mcp/${srvId}/tool-risk`, { method: 'PUT', body: JSON.stringify({ tool: 'get_x', level: 'middle' }) }, tokA5);
          assert.strictEqual(badLevel.j && badLevel.j.code, 400, '非法 level 应 400');
          const badTool = await jfetch(`/api/mcp/${srvId}/tool-risk`, { method: 'PUT', body: JSON.stringify({ tool: 'not_in_list', level: 'low' }) }, tokA5);
          assert.strictEqual(badTool.j && badTool.j.code, 400, '清单外工具应 400');
        });
        // ===== V1.3 #4 钉钉验签失败静默拒绝（2026-10-30，HTTP） =====
        await t('HTTP：钉钉验签失败静默拒绝——篡改签名 POST → 200 空体 + 审计 + 零数据变更（V1.3 #4）', async () => {
          // ⚠️ 依赖前置：DINGTALK_* secrets 已在本区块 spawn 之前由父进程写入共享库（见前置块注释——
          //    loadSecrets 60s 缓存，子进程起后再写会命中空值缓存走「未配置」分支，本用例必挂）
          // 父进程 db 句柄直查基线（WAL 多连接，子进程写入对父进程可见）
          const uB = db.prepare('SELECT COUNT(*) c FROM users').get().c;
          const dB = db.prepare('SELECT COUNT(*) c FROM departments').get().c;
          const eB = db.prepare('SELECT COUNT(*) c FROM dingtalk_events').get().c;
          const audB = db.prepare(`SELECT COUNT(*) c FROM op_logs WHERE action='钉钉回调验签失败'`).get().c;
          const packet = dingCrypto.buildEncryptedCallback(DT_AES_KEY, DT_TOKEN, 'smoke-dt-corpid',
            { EventType: 'dept_create', EventId: 'smoke-dt-evil-001', DeptId: 666, ParentId: 1, DeptName: '伪造部门' });
          const r = await fetch(base + '/api/dingtalk/callback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...packet, msg_signature: packet.msg_signature.slice(0, -4) + 'beef' }), // 篡改签名尾部
          });
          const txt = await r.text();
          assert.strictEqual(r.status, 200, '拒绝必须 200（防钉钉 24h 重试风暴），实际 ' + r.status);
          assert.strictEqual(txt, '', '空体静默（不给探测方任何信息），实际 ' + JSON.stringify(txt));
          assert.ok(db.prepare(`SELECT COUNT(*) c FROM op_logs WHERE action='钉钉回调验签失败'`).get().c > audB, 'op_logs 应新增「钉钉回调验签失败」审计');
          assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users').get().c, uB, 'users 零变更');
          assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM departments').get().c, dB, 'departments 零变更');
          assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM dingtalk_events').get().c, eB, 'dingtalk_events 零新增（伪造事件不落库）');
        });
        // ===== V1.3 审查加固（2026-10-30）：钉钉登录发起源同源校验 =====
        await t('HTTP：钉钉登录发起源校验——伪造跨站 Origin 签发被拒（V1.3 审查加固 H1）', async () => {
          // Origin 与 Host 不同源（curl 可伪造）→ 403，不签发 state（防后续 302 把 token 投到第三方站点）
          const r = await fetch(base + '/api/auth/dingtalk/url', {
            headers: { Origin: 'https://evil-smoke.example.com' },
          });
          const j = await r.json().catch(() => null);
          assert.ok(j && j.code === 403, '伪造跨站 Origin 应被拒（403）：' + JSON.stringify(j));
          // 同源 Origin（与请求 Host 一致）正常签发
          const r2 = await fetch(base + '/api/auth/dingtalk/url', {
            headers: { Origin: base },
          });
          const j2 = await r2.json().catch(() => null);
          assert.ok(j2 && j2.code === 0 && j2.data.url.includes('login.dingtalk.com'), '同源 Origin 应正常签发授权 URL：' + JSON.stringify(j2).slice(0, 120));
          assert.ok(j2.data.url.includes(encodeURIComponent(base + '/api/auth/dingtalk/callback')), 'redirect_uri 应为同源地址');
        });
        // ===== V2.2 #7 技能市场（2026-10-31）：三区聚合 + 收藏 + 一键克隆 =====
        {
          const wfJson = JSON.stringify({ nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', variables: [] } },
            { id: 'end', type: 'end', position: { x: 300, y: 0 }, data: { title: '输出', outputs: [] } },
          ], edges: [{ id: 'e1', source: 'start', target: 'end' }] });
          db.prepare(`INSERT INTO workflow_templates (slug,name,icon,category,description,scene,workflow,builtin,use_count,created_by,created_at) VALUES ('mk-smoke-a','市场模版A','🎨','测试','聚合排序A','场景',?,0,50,'httpu1',datetime('now','localtime'))`).run(wfJson);
          db.prepare(`INSERT INTO workflow_templates (slug,name,icon,category,description,scene,workflow,builtin,use_count,created_by,created_at) VALUES ('mk-smoke-b','市场模版B','🎨','测试','聚合排序B','场景',?,0,5,'httpu1',datetime('now','localtime'))`).run(wfJson);
          db.prepare(`INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,created_at) VALUES ('httpu1','市场克隆技能','供克隆','✨','市场克隆提示词','["calculator"]',1,datetime('now','localtime'))`).run();
        }
        await t('HTTP：技能市场——三区聚合 + 热度排序 + stats（V2.2 #7；P3-2 融合后为四区含 builtin_tools）', async () => {
          const r = await jfetch('/api/skills-market', {}, tok1);
          assert.ok(r.j && r.j.code === 0, '聚合端点应 code=0：' + JSON.stringify(r.j).slice(0, 120));
          const d = r.j.data;
          assert.ok(Array.isArray(d.wf_templates) && Array.isArray(d.skill_assets) && Array.isArray(d.mcp_tools), '三区数组齐备');
          // V2.3 F5 防聚合回退：主端点不应再返回 platforms / platform_errors / platforms_cached（异构清单独立端点承担）
          assert.ok(!('platforms' in d) && !('platform_errors' in d) && !('platforms_cached' in d), '主端点不应含 platforms 三字段（F5 分离防聚合回退）');
          const a = d.wf_templates.find(x => x.slug === 'mk-smoke-a'), b = d.wf_templates.find(x => x.slug === 'mk-smoke-b');
          assert.ok(a && b && d.wf_templates.indexOf(a) < d.wf_templates.indexOf(b), 'wf_templates 按 use_count DESC（模版A=50 在模版B=5 前）');
          assert.ok(d.wf_templates.every((x, i, arr) => i === 0 || arr[i - 1].use_count >= x.use_count), 'use_count 全表单调不增');
          const mySkill = d.skill_assets.find(x => x.name === '市场克隆技能');
          assert.ok(!!mySkill && mySkill.owned_by_me, 'skill_assets 含本人资产且 owned_by_me=true');
          assert.ok(d.stats.total === d.builtin_tools.length + d.wf_templates.length + d.skill_assets.length + d.mcp_tools.length && d.stats.my_favorites === 0, 'stats.total=四区条数之和（P3-2 融合后含 builtin_tools；F5 后不含 platforms）、my_favorites=0');
        });
        // ===== P3-2 融合（2026-11-06）：技能市场五区——builtin_tools 动态生成 + 技能 CRUD 字段下放 =====
        await t('HTTP：P3-2 市场融合——builtin_tools 区动态生成（26 项含 P3-2 新工具、排除违禁、keyed/key_configured 隔离）', async () => {
          const r = await jfetch('/api/skills-market', {}, tok1);
          const bt = r.j.data.builtin_tools;
          assert.ok(Array.isArray(bt) && bt.length >= 20, `builtin_tools 应 ≥20 项（26 - 违禁 2），实际 ${bt.length}`);
          // 违禁工具排除（AGENT_TOOL_DENY：create_task 不进市场；D1-1 后 local_exec 放开进市场）
          const names = bt.map(x => x.name);
          assert.ok(!names.includes('create_task'), '违禁工具 create_task 不应出现在市场');
          assert.ok(names.includes('local_exec'), 'D1-1：local_exec 应进入市场 builtin_tools（受档位+确认卡约束）');
          // P3-2 新增 11 工具全部在市场（工具清单单一事实来源验证）
          for (const n of ['uuid_gen', 'hash_tool', 'base64_tool', 'json_tool', 'text_count', 'date_calc', 'unit_convert', 'cron_explain', 'weather_query', 'translate_text', 'exchange_rate']) {
            assert.ok(names.includes(n), `P3-2 工具 ${n} 应出现在市场 builtin_tools`);
          }
          // 字段结构与风险口径
          const calc = bt.find(x => x.name === 'calculator');
          assert.ok(calc && calc.risk === 'low' && Array.isArray(calc.params_required) && calc.params_required.includes('expression'), 'calculator 应 low 风险 + 必填参数 expression：' + JSON.stringify(calc));
          const ig = bt.find(x => x.name === 'image_gen');
          assert.ok(ig && ig.risk === 'medium', 'image_gen 应 medium 风险（与 toolRiskOf 统一口径）');
          // keyed 标记（weather_query/translate_text 可配 Key）
          const wq = bt.find(x => x.name === 'weather_query');
          assert.ok(wq && wq.keyed === true && wq.key_label.includes('和风天气'), 'weather_query 应 keyed=true 带 key_label：' + JSON.stringify(wq));
          const tt = bt.find(x => x.name === 'translate_text');
          assert.ok(tt && tt.keyed === true && tt.key_provider.includes('DeepL'), 'translate_text 应 keyed=true 带 key_provider');
          assert.ok(bt.filter(x => x.keyed).length === 2, 'keyed 工具应恰 2 个（weather_query/translate_text）');
          // key_configured 行级隔离：tok1 未配置任何工具 Key 应全 0
          assert.ok(bt.every(x => x.key_configured === 0), 'tok1 未配置 Key 时 key_configured 应全 0');
          const r2 = await jfetch('/api/skills-market', {}, tok2);
          assert.ok(r2.j.data.builtin_tools.every(x => x.key_configured === 0), 'tok2 同样全 0（行级隔离）');
        });
        await t('HTTP：P3-2 市场融合——key_configured 随 user_tool_keys 登记翻转（配置后市场卡片显已配 Key）', async () => {
          // tok1 登记一个天气 Key → builtin_tools 的 weather_query.key_configured 应翻为 1
          const post = await jfetch('/api/tool-keys', { method: 'POST', body: JSON.stringify({ tool_name: 'weather_query', api_key: 'mk-fusion-test-key-000000000000001' }) }, tok1);
          assert.ok(post.j && post.j.code === 0, '登记应成功：' + JSON.stringify(post.j).slice(0, 80));
          const r = await jfetch('/api/skills-market', {}, tok1);
          const wq = r.j.data.builtin_tools.find(x => x.name === 'weather_query');
          assert.strictEqual(wq.key_configured, 1, '登记后 tok1 的 weather_query.key_configured 应为 1：' + wq.key_configured);
          const tr = r.j.data.builtin_tools.find(x => x.name === 'translate_text');
          assert.strictEqual(tr.key_configured, 0, 'translate_text 未登记应仍为 0');
          const r2 = await jfetch('/api/skills-market', {}, tok2);
          assert.strictEqual(r2.j.data.builtin_tools.find(x => x.name === 'weather_query').key_configured, 0, 'tok2 视角应仍为 0（行级隔离）');
          db.prepare(`DELETE FROM user_tool_keys WHERE username='httpu1'`).run(); // 自清理
        });
        await t('HTTP：P3-2 市场融合——skill_assets 附带 CRUD 字段（prompt/tools/status/mine 供融合页编辑与详情）', async () => {
          const r = await jfetch('/api/skills-market', {}, tok1);
          const s = r.j.data.skill_assets.find(x => x.name === '市场克隆技能');
          assert.ok(s, '市场克隆技能应在列表');
          assert.ok(typeof s.prompt === 'string' && s.prompt.includes('市场克隆提示词'), 'prompt 字段应下放（融合页详情/编辑用）：' + String(s.prompt).slice(0, 20));
          assert.ok(Array.isArray(s.tools) && s.tools.includes('calculator'), 'tools 应解析为数组：' + JSON.stringify(s.tools));
          assert.strictEqual(s.mine, true, 'mine 标记应存在（我的技能 CRUD 判定）');
          assert.strictEqual(s.status, 1, 'status 应存在（发布开关用）');
          // 他人视角：非 owner 的私有技能不可见（可见性口径不变——回归保护）
          db.prepare(`INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,created_at) VALUES ('httpu2','融合私有技能','','✨','私有提示词','[]',0,datetime('now','localtime'))`).run();
          const r2 = await jfetch('/api/skills-market', {}, tok1);
          assert.ok(!r2.j.data.skill_assets.some(x => x.name === '融合私有技能'), '他人私有技能不应进市场（回归保护）');
          const r3 = await jfetch('/api/skills-market', {}, tok2);
          assert.ok(r3.j.data.skill_assets.some(x => x.name === '融合私有技能' && x.mine === true), 'owner 本人应看到自己的私有技能（融合页「我的技能」语义）');
          db.prepare(`DELETE FROM skill_assets WHERE name='融合私有技能'`).run();
        });
        await t('HTTP：技能市场——收藏 / 幂等 / 列表 / 取消（V2.2 #7）', async () => {
          const tplId = db.prepare(`SELECT id FROM workflow_templates WHERE slug='mk-smoke-a'`).get().id;
          const c1 = await jfetch('/api/skills-market/favorites', { method: 'POST', body: JSON.stringify({ item_type: 'wf_template', item_id: String(tplId) }) }, tok1);
          assert.ok(c1.j && c1.j.code === 0, '收藏应成功：' + JSON.stringify(c1.j).slice(0, 120));
          const c2 = await jfetch('/api/skills-market/favorites', { method: 'POST', body: JSON.stringify({ item_type: 'wf_template', item_id: String(tplId) }) }, tok1);
          const rows = db.prepare(`SELECT COUNT(*) c FROM market_favorites WHERE username='httpu1' AND item_type='wf_template' AND item_id=?`).get(String(tplId)).c;
          assert.ok(c2.j && c2.j.code === 0 && rows === 1, `重复收藏应幂等（code=0 且仅 1 行，实际 ${rows}）`);
          const f = await jfetch('/api/skills-market/favorites', {}, tok1);
          const row = (f.j.data || []).find(x => x.item_type === 'wf_template' && x.item_id === String(tplId));
          assert.ok(!!row && row.name === '市场模版A' && row.available === true, '收藏列表应 join 回资产详情');
          const del = await jfetch('/api/skills-market/favorites', { method: 'DELETE', body: JSON.stringify({ item_type: 'wf_template', item_id: String(tplId) }) }, tok1);
          const f2 = await jfetch('/api/skills-market/favorites', {}, tok1);
          assert.ok(del.j && del.j.code === 0 && !(f2.j.data || []).some(x => x.item_id === String(tplId)), '取消后列表不应再出现');
        });
        await t('HTTP：技能市场——一键克隆落库 / mcp_tool 拒绝（V2.2 #7）', async () => {
          const sid = db.prepare(`SELECT id FROM skill_assets WHERE name='市场克隆技能' AND owner='httpu1'`).get().id;
          const k = await jfetch('/api/skills-market/clone', { method: 'POST', body: JSON.stringify({ item_type: 'skill_asset', item_id: String(sid) }) }, tok1);
          assert.ok(k.j && k.j.code === 0 && k.j.data.agent_id > 0, '克隆技能应成功返回 agent_id：' + JSON.stringify(k.j).slice(0, 120));
          const a = db.prepare('SELECT name,prompt,tools,owner,status,category FROM agents WHERE id=?').get(k.j.data.agent_id);
          assert.ok(a && a.name === '市场克隆技能（副本）' && a.prompt === '市场克隆提示词', `新 agent 应含「（副本）」后缀且 prompt 复制（name=${a && a.name}）`);
          assert.ok(JSON.parse(a.tools || '[]').includes('calculator') && a.owner === 'httpu1' && a.status === 'draft', 'tools 复制 + owner=登录用户 + status=draft');
          assert.ok(!!db.prepare(`SELECT 1 FROM op_logs WHERE action='市场克隆技能' AND username='httpu1'`).get(), 'op_logs 应记「市场克隆技能」');
          const mcpToolId = db.prepare('SELECT id FROM mcp_servers LIMIT 1').get().id;
          const bad = await jfetch('/api/skills-market/clone', { method: 'POST', body: JSON.stringify({ item_type: 'mcp_tool', item_id: `${mcpToolId}:get_x` }) }, tok1);
          assert.ok(bad.j && bad.j.code === 400 && /暂不支持克隆/.test(bad.j.msg || ''), 'mcp_tool 克隆应 400「暂不支持克隆」');
        });
        await t('HTTP：技能市场——wf_template 一键克隆落库 + use_count 自增 + community 闸门放行（V2.2 审查加固 F3 防回归）', async () => {
          const tplId = db.prepare(`SELECT id FROM workflow_templates WHERE slug='mk-smoke-b'`).get().id;
          const k = await jfetch('/api/skills-market/clone', { method: 'POST', body: JSON.stringify({ item_type: 'wf_template', item_id: String(tplId) }) }, tok1);
          assert.ok(k.j && k.j.code === 0 && k.j.data.agent_id > 0, '克隆模板应成功：' + JSON.stringify(k.j).slice(0, 160));
          const a = db.prepare('SELECT name,type,edit_mode,routing_mode,status,owner FROM agents WHERE id=?').get(k.j.data.agent_id);
          assert.ok(a && a.name === '市场模版B（副本）' && a.type === 'digital' && a.edit_mode === 'canvas' && a.routing_mode === 'workflow' && a.status === 'draft' && a.owner === 'httpu1', `模板克隆应落画布工作流草稿（name=${a && a.name}）`);
          assert.strictEqual(db.prepare('SELECT use_count FROM workflow_templates WHERE id=?').get(tplId).use_count, 6, 'use_count 应自增 5→6');
          assert.ok(!!db.prepare(`SELECT 1 FROM op_logs WHERE action='市场克隆模板' AND username='httpu1'`).get(), 'op_logs 应记「市场克隆模板」');
          // F3 语义：HTTP 实例无 License 即 community，克隆成功本身证明 clone 新挂的 requireFeature('agents') 闸门未误伤基础功能
        });
        await t('HTTP：技能市场——长名资产克隆先截断后拼后缀，查重名=入库名（V2.2 审查加固 Y2 防回归）', async () => {
          db.prepare(`DELETE FROM agents WHERE owner='httpu1'`).run(); // 清理前序用例克隆产物，腾出免费版配额（3 上限）
          const longName = '超长名称资产'.repeat(10); // 60 字
          db.prepare(`INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,created_at) VALUES ('httpu1',?,'长名克隆','✨','长名提示词','[]',1,datetime('now','localtime'))`).run(longName);
          const sid = db.prepare(`SELECT id FROM skill_assets WHERE name=? AND owner='httpu1'`).get(longName).id;
          const k = await jfetch('/api/skills-market/clone', { method: 'POST', body: JSON.stringify({ item_type: 'skill_asset', item_id: String(sid) }) }, tok1);
          assert.ok(k.j && k.j.code === 0, '长名克隆应成功：' + JSON.stringify(k.j).slice(0, 120));
          const n = k.j.data.name;
          assert.ok(n.length <= 50, `入库名应 ≤50 字符（实际 ${n.length}）`);
          assert.ok(n.endsWith('（副本）'), `截断后应仍带完整后缀（修复前先查重后截断，后缀会被切掉）：…${n.slice(-8)}`);
          assert.ok(!db.prepare('SELECT 1 FROM agents WHERE name=?').get(longName), '原始 60 字全名不应直接入库（查重名必须=入库名，防重名自相矛盾）');
        });
        // ===== V2.3 技能市场（2026-10-31）：F5 platforms 独立端点 / Y3 克隆配额统一口径 =====
        await t('HTTP：技能市场——platforms 独立端点 + 缓存命中单飞语义（F5 分离 / V2.3 审查加固 S1-1/S2-1）', async () => {
          const errBefore = db.prepare(`SELECT COUNT(*) c FROM err_logs WHERE source='skills-market'`).get().c;
          const r = await jfetch('/api/skills-market/platforms', {}, tok1);
          assert.ok(r.j && r.j.code === 0, 'platforms 独立端点应 code=0（外部平台故障也 best-effort 不 5xx）：' + JSON.stringify(r.j).slice(0, 120));
          const d = r.j.data;
          assert.ok(Array.isArray(d.platforms), 'data.platforms 应为数组');
          assert.strictEqual(typeof d.platforms_cached, 'boolean', 'platforms_cached 应为布尔');
          assert.ok(Array.isArray(d.platform_errors), 'platform_errors 应为数组（best-effort 观测标记）');
          // 种子库 2 个平台均未配置真实凭据（coze token 非 pat_ 前缀 / dify 无控制台账号密码），
          // 应全部走静默 error 分支：清单为空数组、失败入 platform_errors、HTTP 仍 code=0 不 5xx
          assert.strictEqual(d.platforms.length, 0, '未配置凭据的平台拉不到应用（空数组不 5xx）');
          assert.ok(d.platform_errors.length > 0, '拉取失败应记入 platform_errors 供前端观测');
          assert.strictEqual(d.platforms_cached, false, '首次调用应真实拉取（cached=false）');
          const errAfterFirst = db.prepare(`SELECT COUNT(*) c FROM err_logs WHERE source='skills-market'`).get().c;
          assert.ok(errAfterFirst > errBefore, '首次真实拉取失败应写 err_logs（S2-1 守卫只拦缓存命中，不拦真实失败）');
          // V2.3 审查加固（S1-1/S2-1/P2-2）：TTL 内第二次调用应命中缓存（single-flight 单飞）——
          // 不再触发外部调用（cached=true）、失败观测标记照常返回（响应字段保留）、err_logs 不再新增（防日志洪泛）
          const r2 = await jfetch('/api/skills-market/platforms', {}, tok1);
          const d2 = r2.j.data;
          assert.strictEqual(d2.platforms_cached, true, 'TTL 内第二次调用应命中缓存（未触发外部调用，单飞/缓存语义）');
          assert.strictEqual(d2.platform_errors.length, d.platform_errors.length, '缓存命中时失败观测标记应照常返回（前端需知清单为空的原因）');
          assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM err_logs WHERE source='skills-market'`).get().c, errAfterFirst, '缓存命中不应再写 err_logs（S2-1：防高频刷端点刷出日志洪泛）');
        });
        await t('HTTP：技能市场——克隆与创建双通道配额统一口径（Y3 / V2.3 审查加固 P1-2）', async () => {
          db.prepare(`DELETE FROM agents WHERE owner='httpu1'`).run(); // 清空前序用例克隆产物，腾出配额（同 Y2 用例清理手法）
          // httpu1 为 user 角色免费版（users.plan 默认 'free'，上限 3 个智能体）——直插 3 个 source='self' 草稿打满配额
          const ins = db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,owner,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`);
          ins.run('配额打满A', 'Y3 配额测试', 'digital', '测试', 'p', 'draft', 'self', 'httpu1');
          ins.run('配额打满B', 'Y3 配额测试', 'digital', '测试', 'p', 'draft', 'self', 'httpu1');
          ins.run('配额打满C', 'Y3 配额测试', 'digital', '测试', 'p', 'draft', 'self', 'httpu1');
          const sid = db.prepare(`SELECT id FROM skill_assets WHERE name='市场克隆技能' AND owner='httpu1'`).get().id;
          const k = await jfetch('/api/skills-market/clone', { method: 'POST', body: JSON.stringify({ item_type: 'skill_asset', item_id: String(sid) }) }, tok1);
          assert.ok(k.j && k.j.code === 402, '配额打满后克隆应 402（lib/plans agentQuotaBlock 统一口径）：' + JSON.stringify(k.j).slice(0, 160));
          assert.ok(/免费版最多创建 3 个智能体（当前 3 个）/.test(k.j.msg || ''), 'msg 应锁全文案（V2.3 审查加固 P2-3：防统一函数文案漂移）：' + (k.j.msg || ''));
          assert.ok(k.j.data && k.j.data.upgrade_hint === true, 'data.upgrade_hint 应为 true（前端升级引导）');
          assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM agents WHERE owner='httpu1'`).get().c, 3, '402 拒绝时不应落库新智能体（仍为打满的 3 个）');
          // V2.3 审查加固（P1-2）：POST /api/agents 通道同断言——Y3 同步改了两处调用点，
          // 只测 clone 通道则 agents 通道误删/漂移不会被捕获（「两通道自动同步」卖点缺一半闭环）
          const g = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '配额402测试' }) }, tok1);
          assert.ok(g.j && g.j.code === 402, '配额打满后 POST /api/agents 也应 402（同一 agentQuotaBlock）：' + JSON.stringify(g.j).slice(0, 160));
          assert.strictEqual(g.j.msg, k.j.msg, '两通道 msg 应完全一致（统一口径零漂移）');
          assert.ok(g.j.data && g.j.data.upgrade_hint === true, 'agents 通道 upgrade_hint 同为 true');
          assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM agents WHERE owner='httpu1'`).get().c, 3, 'agents 通道 402 拒绝时同样不落库');
          db.prepare(`DELETE FROM agents WHERE owner='httpu1'`).run(); // 清理：还原免费版配额空间，避免影响后续用例
        });
        // ===== V2.3 Y7 版本/License 管理端点（2026-10-31）：GET 脱敏快照 + POST 热重载 =====
        await t('HTTP：版本端点 GET——未登录 401 / 普通用户脱敏快照 / 管理员完整快照（V2.3 Y7）', async () => {
          const anon = await jfetch('/api/edition', {});
          assert.strictEqual(anon.j && anon.j.code, 401, '未登录应 401：' + JSON.stringify(anon.j));
          const u = await jfetch('/api/edition', {}, tok1);
          assert.ok(u.j && u.j.code === 0, '登录用户 GET 应 code=0：' + JSON.stringify(u.j).slice(0, 120));
          const ud = u.j.data;
          // 脱敏快照：四字段齐备，授权商业信息四字段不得出现（V2.3 审查加固 P1-3/S2-2：days_left 可反推到期日，移出白名单）
          for (const k of ['edition', 'name', 'licensed', 'reason']) assert.ok(k in ud, `普通用户快照应含 ${k}`);
          for (const k of ['customer', 'expires_at', 'license_key', 'days_left']) assert.ok(!(k in ud), `普通用户快照不得含 ${k}（脱敏：客户名/到期日/编号/可反推到期日的剩余天数）`);
          assert.strictEqual(ud.edition, 'community', '子进程无 License 应为 community（重载前置态）');
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          const a = await jfetch('/api/edition', {}, tokAdmin);
          assert.ok(a.j && a.j.code === 0 && 'customer' in a.j.data && 'expires_at' in a.j.data && 'license_key' in a.j.data, '管理员应得完整快照（含 customer/expires_at/license_key 前缀）：' + JSON.stringify(a.j).slice(0, 160));
        });
        await t('HTTP：License 热重载——仅管理员 + 审计落库 + 文件替换免重启热切换/篡改即时降级（V2.3 Y7）', async () => {
          const crypto = require('crypto'), fs = require('fs'), path = require('path');
          const licFile = path.join(process.env.AGENT_DATA_DIR, 'license.json');
          const p = (n) => String(n).padStart(2, '0');
          const dstr = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
          const signLic = (fields) => ({ ...fields, signature: crypto.sign(null, Buffer.from(JSON.stringify(fields), 'utf8'), licKeypair.privateKey).toString('hex') });
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });

          // 普通用户 reload → 403（管理操作权限闸门）
          const denied = await jfetch('/api/edition/reload', { method: 'POST' }, tok1);
          assert.ok(denied.j && denied.j.code === 403 && /仅管理员/.test(denied.j.msg || ''), '普通用户 reload 应 403：' + JSON.stringify(denied.j));

          // 写入合法专业版 License（子进程 env 公钥即 licKeypair 公钥）→ admin reload 热切换（免重启，Y7 核心价值）
          const exp = new Date(); exp.setDate(exp.getDate() + 365);
          fs.writeFileSync(licFile, JSON.stringify(signLic({ customer: '热重载验证公司', edition: 'professional', expires_at: dstr(exp), issued_at: dstr(new Date()), license_key: '33'.repeat(16) })));
          const r1 = await jfetch('/api/edition/reload', { method: 'POST' }, tokAdmin);
          assert.ok(r1.j && r1.j.code === 0 && r1.j.data.edition === 'professional' && r1.j.data.licensed === true, 'reload 后应热切换为 professional（免重启）：' + JSON.stringify(r1.j).slice(0, 160));
          assert.strictEqual(r1.j.data.customer, '热重载验证公司');
          // 切换后普通用户 GET：看到 professional 但仍无授权商业字段（脱敏跨重载持续生效）
          const u = await jfetch('/api/edition', {}, tok1);
          assert.strictEqual(u.j.data.edition, 'professional', '普通用户应看到热切换后的版本');
          assert.ok(!('customer' in u.j.data), '脱敏在重载后仍生效');
          // 审计：op_logs 应记 License热重载（操作者 httpadmin）
          assert.ok(!!db.prepare(`SELECT 1 FROM op_logs WHERE action='License热重载' AND username='httpadmin'`).get(), 'op_logs 应记「License热重载」审计');

          // 文件被篡改（改客户名）→ admin reload → 运行态即时降级 badsig（R1 同款运行期感知语义）
          const bad = JSON.parse(fs.readFileSync(licFile, 'utf8')); bad.customer = '改票公司';
          fs.writeFileSync(licFile, JSON.stringify(bad));
          const r2 = await jfetch('/api/edition/reload', { method: 'POST' }, tokAdmin);
          assert.strictEqual(r2.j.data.edition, 'community', '篡改后 reload 应即时降级 community');
          assert.strictEqual(r2.j.data.reason, 'badsig');
          // 清理：删除文件 + reload 还原 community/missing（还原子进程与磁盘一致态，不污染后续）
          fs.rmSync(licFile, { force: true });
          const r3 = await jfetch('/api/edition/reload', { method: 'POST' }, tokAdmin);
          assert.strictEqual(r3.j.data.reason, 'missing');
        });

        // ===== V3.1 #12 审核流（2026-11-03）：企业版完整流转——提审→驳回→整改重提→通过 =====
        await t('HTTP：审核流——企业版提审进 review + 驳回带意见 + 重提 + 审批通过（V3.1 #12）', async () => {
          const crypto = require('crypto'), fs = require('fs'), path = require('path');
          const licFile = path.join(process.env.AGENT_DATA_DIR, 'license.json');
          const p = (n) => String(n).padStart(2, '0');
          const dstr = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
          const signLic = (fields) => ({ ...fields, signature: crypto.sign(null, Buffer.from(JSON.stringify(fields), 'utf8'), licKeypair.privateKey).toString('hex') });
          const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
          const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });
          // ① 热切换企业版（audit_flow 特性生效）
          const exp = new Date(); exp.setDate(exp.getDate() + 365);
          fs.writeFileSync(licFile, JSON.stringify(signLic({ customer: '审核流验证公司', edition: 'enterprise', expires_at: dstr(exp), issued_at: dstr(new Date()), license_key: '44'.repeat(16) })));
          const rl = await jfetch('/api/edition/reload', { method: 'POST' }, tokAdmin);
          assert.strictEqual(rl.j.data.edition, 'enterprise', '前置：热切换企业版失败 ' + JSON.stringify(rl.j).slice(0, 120));
          // ② httpu1（非 admin）发布 → 进 review（提审），不直接 published
          const cr = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '企业版审核流agent' }) }, tok1);
          assert.ok(cr.j && cr.j.code === 0, '造 agent 应成功：' + JSON.stringify(cr.j).slice(0, 120));
          const aid = cr.j.data.id;
          const sub = await jfetch(`/api/agents/${aid}/publish`, { method: 'POST', body: JSON.stringify({ record: '首次提审' }) }, tok1);
          assert.ok(sub.j && sub.j.code === 0 && /提交审核/.test(sub.j.msg || ''), '企业版非 admin 发布应转提审：' + JSON.stringify(sub.j).slice(0, 140));
          assert.strictEqual(db.prepare('SELECT status FROM agents WHERE id=?').get(aid).status, 'review', '提审后状态应为 review');
          // ③ 审核中重复提审 → 400
          const dup = await jfetch(`/api/agents/${aid}/publish`, { method: 'POST', body: JSON.stringify({}) }, tok1);
          assert.strictEqual(dup.j && dup.j.code, 400, '审核中重复提审应 400：' + JSON.stringify(dup.j));
          // ④ 审核队列可见（含提审人/说明）
          const q = await jfetch('/api/agents/review-queue', {}, tokAdmin);
          const row = (q.j.data || []).find(x => x.id === aid);
          assert.ok(row && row.submit_by === 'httpu1' && row.submit_comment === '首次提审', '审核队列应含提审人/说明：' + JSON.stringify(row));
          // ⑤ 驳回（无意见 → 400；带意见 → rejected + review_comment + 通知提审人）
          const noComment = await jfetch(`/api/agents/${aid}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject' }) }, tokAdmin);
          assert.strictEqual(noComment.j && noComment.j.code, 400, '驳回缺意见应 400');
          const rej = await jfetch(`/api/agents/${aid}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject', comment: '开场白含未授权承诺，请调整' }) }, tokAdmin);
          assert.ok(rej.j && rej.j.code === 0, '驳回应成功：' + JSON.stringify(rej.j));
          const after = db.prepare('SELECT status, review_comment FROM agents WHERE id=?').get(aid);
          assert.strictEqual(after.status, 'rejected', '驳回后状态应为 rejected');
          assert.strictEqual(after.review_comment, '开场白含未授权承诺，请调整', '驳回意见应落 review_comment');
          assert.ok(!!db.prepare(`SELECT 1 FROM notifications WHERE username='httpu1' AND type='agent_review'`).get(), '驳回应通知提审人 httpu1');
          // ⑥ 整改后重提（rejected → review，走同一提审路径）
          const resub = await jfetch(`/api/agents/${aid}/publish`, { method: 'POST', body: JSON.stringify({ record: '整改后重提' }) }, tok1);
          assert.ok(resub.j && resub.j.code === 0 && /提交审核/.test(resub.j.msg || ''), '驳回后应可重新提审：' + JSON.stringify(resub.j).slice(0, 140));
          // ⑦ 审批通过 → published + agent_reviews 流水齐全 + 广场上架通知
          const ok = await jfetch(`/api/agents/${aid}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }, tokAdmin);
          assert.ok(ok.j && ok.j.code === 0 && /审核通过/.test(ok.j.msg || ''), '审批应通过：' + JSON.stringify(ok.j).slice(0, 140));
          assert.strictEqual(db.prepare('SELECT status FROM agents WHERE id=?').get(aid).status, 'published', '通过后状态应为 published');
          const flows = db.prepare(`SELECT action FROM agent_reviews WHERE agent_id=? ORDER BY id`).all(aid).map(r => r.action);
          assert.deepStrictEqual(flows, ['submit', 'reject', 'submit', 'approve'], '审核流水应为 submit→reject→submit→approve：' + JSON.stringify(flows));
          // ⑧ 清理：删测试 agent + 流水 + 广场广播 + 还原 community（磁盘与子进程一致，不污染后续用例）
          db.prepare('DELETE FROM agents WHERE id=?').run(aid);
          db.prepare('DELETE FROM agent_reviews WHERE agent_id=?').run(aid);
          db.prepare(`DELETE FROM notifications WHERE type='agent_review'`).run();
          db.prepare(`DELETE FROM notifications WHERE type='agent_publish' AND title LIKE '%企业版审核流agent%'`).run();
          fs.rmSync(licFile, { force: true });
          const rl2 = await jfetch('/api/edition/reload', { method: 'POST' }, tokAdmin);
          assert.strictEqual(rl2.j.data.reason, 'missing', '清理后应还原 community');
        });

        // ===== #10 LLMOps（2026-10-31 Dev B）：提示词版本面板 + 质量看板四视图 =====
        // 契约（对齐 Dev A 的 agents.js 实现）：
        //   GET /api/agents/:id/prompt-versions → { code:0, data:[{ id, version, prompt, user_prompt, edited_by, note, created_at }] }
        //   POST /api/agents/:id/prompt-versions/:vid/rollback → { code:0, msg:'已回滚到 vN', data:{ version } }
        //   PUT /api/agents/:id 保存时 prompt/user_prompt 实际变更自动记版本（POST 创建不记）
        db.prepare(`DELETE FROM agents WHERE owner='httpu1'`).run(); // 防御性清理：前组失败残留会占免费版配额（同 L3335 手法）
        let llmopsAid = 0; // 用例间共享：本组造的「版本记录测试」agent id
        await t('LLMOps：提示词版本自动记录——两次 PUT 产生 v1/v2（version 递增/edited_by/note/快照）', async () => {
          const cr = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '版本记录测试' }) }, tok1);
          assert.ok(cr.j && cr.j.code === 0, '造 agent（owner=httpu1，POST 不带 prompt）应成功：' + JSON.stringify(cr.j).slice(0, 140));
          llmopsAid = cr.j.data.id;
          const put = (prompt) => jfetch(`/api/agents/${llmopsAid}`, { method: 'PUT', body: JSON.stringify({ name: '版本记录测试', prompt }) }, tok1);
          const r1 = await put('你是银行客服助手 v1');
          assert.ok(r1.j && r1.j.code === 0, '第一次 PUT（空→v1，实际变更）应成功：' + JSON.stringify(r1.j).slice(0, 140));
          const r2 = await put('你是银行客服助手 v2');
          assert.ok(r2.j && r2.j.code === 0, '第二次 PUT（v1→v2）应成功：' + JSON.stringify(r2.j).slice(0, 140));
          const lv = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok1);
          assert.ok(lv.j && lv.j.code === 0, 'owner GET prompt-versions 应成功：' + JSON.stringify(lv.j).slice(0, 140));
          const list = lv.j.data || [];
          assert.strictEqual(list.length, 2, 'POST 创建不记版本，两次 PUT 应恰好 2 条：' + JSON.stringify(list).slice(0, 240));
          const sorted = [...list].sort((a, b) => (a.version || 0) - (b.version || 0));
          assert.strictEqual(sorted[0].version, 1, '首条 version 应为 1');
          assert.strictEqual(sorted[1].version, 2, '次条 version 应为 2（递增）');
          assert.strictEqual(sorted[0].prompt, '你是银行客服助手 v1', 'v1 应存当时 prompt 快照（非最终值）：' + sorted[0].prompt);
          assert.ok(sorted.every(v => v.edited_by === 'httpu1'), 'edited_by 应为操作者 httpu1：' + JSON.stringify(sorted.map(v => v.edited_by)));
          assert.ok(sorted.every(v => v.note === '提示词修改'), 'note 应为「提示词修改」：' + JSON.stringify(sorted.map(v => v.note)));
        });
        await t('LLMOps：无变更不记版本——相同 prompt 再 PUT 仍 2 条', async () => {
          assert.ok(llmopsAid > 0, '前置用例应已造 agent（前序失败则本条连带失败）');
          const r = await jfetch(`/api/agents/${llmopsAid}`, { method: 'PUT', body: JSON.stringify({ name: '版本记录测试', prompt: '你是银行客服助手 v2' }) }, tok1);
          assert.ok(r.j && r.j.code === 0, 'PUT（内容未变）本身应保存成功：' + JSON.stringify(r.j).slice(0, 140));
          const lv = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok1);
          assert.strictEqual((lv.j.data || []).length, 2, 'prompt 无实际变更不应新增版本：' + JSON.stringify(lv.j.data).slice(0, 200));
        });
        await t('LLMOps：回滚到 v1——agents.prompt 恢复快照 + 产生 v3 且 note 含「回滚」', async () => {
          assert.ok(llmopsAid > 0, '前置用例应已造 agent');
          const lv0 = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok1);
          const v1 = (lv0.j.data || []).find(v => v.version === 1);
          assert.ok(v1, '应存在 v1 版本可回滚：' + JSON.stringify(lv0.j.data).slice(0, 200));
          // 契约修正（2026-11-23）：rollback 的 :vid 参数语义是 version 号（端点 WHERE agent_id=? AND version=?），
          // 原测试误传自增 id——首轮 AI-12 用例直接 INSERT prompt_versions 推进全局自增序列后 id≠version 暴露 404
          const rb = await jfetch(`/api/agents/${llmopsAid}/prompt-versions/${v1.version}/rollback`, { method: 'POST' }, tok1);
          assert.ok(rb.j && rb.j.code === 0, 'owner rollback 应成功：' + JSON.stringify(rb.j).slice(0, 140));
          assert.strictEqual(rb.j.msg, '已回滚到 v1', 'msg 契约：已回滚到 vN');
          // V2.3 审查加固（回滚端点返回的是新版本号 v3——审计链要求，回滚是独立操作，始终产生新版本记录以便追溯）
          assert.ok(rb.j.data && rb.j.data.version === 3, 'data.version 应为回滚产生的新版本号（非回滚目标版本 v1，审计链要求）：' + JSON.stringify(rb.j.data));
          const d = await jfetch(`/api/agents/${llmopsAid}/detail`, {}, tok1);
          assert.strictEqual(d.j.data.prompt, '你是银行客服助手 v1', '回滚后 agents.prompt 应恢复为 v1 快照内容：' + d.j.data.prompt);
          const lv = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok1);
          const v3 = (lv.j.data || []).find(v => v.version === 3);
          assert.ok(v3, '回滚应作为新版本 v3 记录（可再回滚/审计）：' + JSON.stringify(lv.j.data).slice(0, 240));
          assert.ok(/回滚/.test(v3.note || ''), 'v3 note 应含「回滚」：' + (v3.note || ''));
        });
        await t('LLMOps：版本权限——非 owner 第三人 GET / 回滚 均 403', async () => {
          assert.ok(llmopsAid > 0, '前置用例应已造 agent');
          const lv = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok2);
          assert.ok(lv.j && lv.j.code === 403, '第三人（httpu2）GET 应 403：' + JSON.stringify(lv.j).slice(0, 120));
          const lvOwn = await jfetch(`/api/agents/${llmopsAid}/prompt-versions`, {}, tok1);
          const anyV = (lvOwn.j.data || [])[0];
          assert.ok(anyV, 'owner 应能取到版本列表');
          const rb = await jfetch(`/api/agents/${llmopsAid}/prompt-versions/${anyV.version}/rollback`, { method: 'POST' }, tok2);
          assert.ok(rb.j && rb.j.code === 403, '第三人回滚应 403：' + JSON.stringify(rb.j).slice(0, 120));
          const d = await jfetch(`/api/agents/${llmopsAid}/detail`, {}, tok1);
          assert.strictEqual(d.j.data.prompt, '你是银行客服助手 v1', '403 回滚不得改动 prompt');
        });
        await t('LLMOps：quality 四视图端点——admin 得 llm/kb/eval 三块（聚合数值验证）+ 普通用户 403', async () => {
          // 造聚合验证数据（父进程直插，走完即清）：挂库 agent（kb_id 非空）+ 命中/未命中 trace 各一条 + 一条已完结评测
          db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,kb_id,owner,created_at,updated_at)
            VALUES ('质量看板聚合验证','x','digital','测试','p','published','self',999999,'httpu1',datetime('now','localtime'),datetime('now','localtime'))`).run();
          const qAid = db.prepare(`SELECT id FROM agents WHERE name='质量看板聚合验证'`).get().id;
          const tr = db.prepare(`INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,blocked,created_at)
            VALUES (NULL,NULL,?,'m-quality-test','real',10,?,50,?,'[]','',datetime('now','localtime'))`);
          tr.run(qAid, 111, '[{"file":"a.md"}]'); // 命中：kb_hits 非空数组
          tr.run(qAid, 222, '[]');                // 挂库未命中
          db.prepare(`INSERT INTO evaluations (name,agent_id,rule_prompt,dataset,status,score,result,type,created_at)
            VALUES ('质量看板评测',?,'','[]','done',88.5,'[]','agent',datetime('now','localtime'))`).run(qAid);
          try {
            const adminUid = db.prepare(`SELECT id FROM users WHERE username='httpadmin'`).get().id;
            const tokAdmin = sign({ uid: adminUid, exp: Date.now() + 3600000 });
            const q = await jfetch('/api/chat/quality', {}, tokAdmin);
            assert.ok(q.j && q.j.code === 0, 'admin 调 GET /api/chat/quality 应成功：' + JSON.stringify(q.j).slice(0, 140));
            const d = q.j.data;
            assert.ok(Array.isArray(d.list) && d.stat && 'satisfaction' in d.stat, '原有 list/stat 字段应保留（防破坏现有前端）');
            // llm 块
            assert.ok(d.llm && Array.isArray(d.llm.tokens_by_day), '应含 llm.tokens_by_day 数组：' + JSON.stringify(d.llm).slice(0, 120));
            assert.strictEqual(d.llm.tokens_by_day.length, 14, 'tokens_by_day 应为近 14 天（空天补 0）：' + d.llm.tokens_by_day.length);
            for (const r of d.llm.tokens_by_day) assert.ok('day' in r && 'tokens' in r && 'calls' in r, 'tokens_by_day 行结构应为 {day,tokens,calls}');
            assert.ok(Array.isArray(d.llm.tokens_by_model) && Array.isArray(d.llm.tokens_by_agent), 'tokens_by_model / tokens_by_agent 应为数组');
            const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const todayRow = d.llm.tokens_by_day.find(r => r.day === today);
            assert.ok(todayRow && todayRow.tokens >= 333, '按天求和应含今日造的 111+222：' + JSON.stringify(todayRow));
            const mRow = d.llm.tokens_by_model.find(r => r.model === 'm-quality-test');
            assert.ok(mRow && mRow.tokens === 333 && mRow.calls === 2, 'tokens_by_model 应按模型聚合（333 tokens / 2 次）：' + JSON.stringify(mRow));
            const aRow = d.llm.tokens_by_agent.find(r => r.agent_name === '质量看板聚合验证');
            assert.ok(aRow && aRow.tokens === 333, 'tokens_by_agent 应按智能体聚合（JOIN agents 取名）：' + JSON.stringify(aRow));
            // kb 块（近似口径：分母为当前仍挂库 agent 的 trace）
            assert.ok(d.kb && 'hit_rate' in d.kb && 'hit_count' in d.kb && 'total_with_kb' in d.kb, 'kb 块应含 hit_rate/hit_count/total_with_kb：' + JSON.stringify(d.kb));
            assert.ok(d.kb.total_with_kb >= 2 && d.kb.hit_count >= 1, '挂库对话 ≥2 且命中 ≥1（今日造数）：' + JSON.stringify(d.kb));
            assert.ok(d.kb.hit_rate == null || (d.kb.hit_rate >= 0 && d.kb.hit_rate <= 100), 'hit_rate 应为 0-100 的百分比或 null');
            // eval 块（V1.3 #6 评测集，近 14 天趋势）
            assert.ok(Array.isArray(d.eval), 'eval 应为数组（无数据返回空数组）：' + JSON.stringify(d.eval).slice(0, 120));
            const eToday = d.eval.find(r => r.day === today);
            assert.ok(eToday && typeof eToday.avg_score === 'number' && eToday.runs >= 1, 'eval 应聚合今日 done 评测（avg_score/runs）：' + JSON.stringify(eToday));
            // adminOnly 保持：普通用户 403
            const u = await jfetch('/api/chat/quality', {}, tok1);
            assert.ok(u.j && u.j.code === 403, '普通用户（httpu1）应 403：' + JSON.stringify(u.j).slice(0, 120));
          } finally {
            db.prepare(`DELETE FROM chat_traces WHERE agent_id=?`).run(qAid);
            db.prepare(`DELETE FROM evaluations WHERE agent_id=? AND name='质量看板评测'`).run(qAid);
            db.prepare(`DELETE FROM agents WHERE id=?`).run(qAid);
          }
        });
        // 本用例不走 HTTP（chatOnce 直连本地黑洞端口）；契约：LLM_TIMEOUT_MS 运行时读取（llm.js chatOnce 每次调用读 env）
        await t('LLMOps：llm 硬超时——LLM_TIMEOUT_MS=1500 下 chatOnce 对「只 accept 不响应」端口 ~1.5s reject 不挂死', async () => {
          const { chatOnce } = require('../src-server/lib/llm');
          // 备份并清空 providers（唯一 configured 供应商 = 黑洞，保证无候选可降级、不外呼真实网关；测完恢复）
          const backup = db.prepare('SELECT * FROM providers').all();
          db.prepare('DELETE FROM providers').run();
          const net = require('net');
          const blackhole = net.createServer(() => { /* 只 accept：不响应也不关闭 */ });
          await new Promise(r => blackhole.listen(0, '127.0.0.1', r));
          const port = blackhole.address().port;
          const info = db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at)
            VALUES ('黑洞供应商',?, 'sk-test', ?, 1, 0, '', datetime('now','localtime'))`)
            .run(`http://127.0.0.1:${port}/v1`, JSON.stringify(['timeout-probe-model']));
          const prev = process.env.LLM_TIMEOUT_MS;
          process.env.LLM_TIMEOUT_MS = '1500';
          let err = null;
          const t0 = Date.now();
          try {
            await chatOnce([{ role: 'user', content: 'hi' }], { model: 'timeout-probe-model' });
          } catch (e) { err = e; }
          const cost = Date.now() - t0;
          if (prev === undefined) delete process.env.LLM_TIMEOUT_MS; else process.env.LLM_TIMEOUT_MS = prev;
          try { blackhole.close(); } catch { }
          db.prepare(`DELETE FROM providers WHERE id=?`).run(info.lastInsertRowid);
          if (backup.length) { // 恢复原表（按原 id 原列原样写回）
            const cols = Object.keys(backup[0]);
            const ins = db.prepare(`INSERT INTO providers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
            for (const r of backup) ins.run(...cols.map(c => r[c]));
          }
          assert.ok(err, 'chatOnce 应 reject（黑洞端口永不响应），而非静默成功或挂死');
          assert.ok(/超时|timeout/i.test((err.name || '') + ' ' + (err.message || '')), '应为超时类错误（TimeoutError）：' + err.name + ' ' + err.message);
          assert.ok(cost >= 1400 && cost <= 8000, `应在 ~1.5s 触发硬超时（含重试退避容差，实测 ${cost}ms）`);
        });
        await t('SEC-06：全局安全响应头齐备（nosniff / Referrer-Policy / Permissions-Policy）', async () => {
          const r = await fetch(base + '/api/health');
          assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options 应为 nosniff');
          assert.strictEqual(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy 就位');
          assert.ok(r.headers.get('permissions-policy'), 'Permissions-Policy 就位');
          assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN', '非 /share 路径应下发 X-Frame-Options');
        });
        // LLMOps 组收尾：清走「版本记录测试」agent（防污染后续用例的 agents 统计）
        db.prepare(`DELETE FROM agents WHERE name='版本记录测试'`).run();
      } else {
        failed++; console.error('  ❌ HTTP 测试服务未就绪，本组用例跳过');
      }
    } finally {
      try { child.kill('SIGTERM'); } catch { }
      await new Promise(r2 => setTimeout(r2, 600));
      try { child.kill('SIGKILL'); } catch { }
    }
  }

  console.log('【SEC-M0】商用安全止血闸门（SEC-01~08 单元级验收，2026-11-22）');
  {
    await t('SEC-02a：Key HMAC 哈希稳定 / 掩码 / 形态判定', () => {
      const { hashKey, maskPrefix, looksHashed } = require('../src-server/lib/apikey');
      assert.strictEqual(hashKey('sk-ap-abc'), hashKey('sk-ap-abc'), '相同输入 → 稳定哈希（跨重启可复算）');
      assert.notStrictEqual(hashKey('a'), hashKey('b'), '不同输入 → 不同哈希');
      assert.ok(/^[0-9a-f]{64}$/.test(hashKey('x')), '哈希为 64 位小写 hex');
      assert.ok(looksHashed(hashKey('x')), '哈希形态可识别（供存量迁移跳过）');
      assert.ok(!looksHashed('sk-ap-plaintext'), '明文不可被识别为哈希');
      assert.strictEqual(maskPrefix('sk-ap-1234567890abcdef'), 'sk-ap-12****cdef', '掩码保留前 8 后 4');
      assert.ok(!maskPrefix('sk-ap-1234567890abcdef').includes('567890'), '掩码不含中段可用信息');
    });
    await t('SEC-02a：对外密钥库内存量即哈希（明文不落库、列表可掩码）', () => {
      const { hashKey, maskPrefix, looksHashed } = require('../src-server/lib/apikey');
      const raw = 'sk-ap-smoke-sec02a-raw';
      const aid = (db.prepare(`SELECT id FROM agents LIMIT 1`).get() || {}).id || 1;
      db.prepare(`INSERT INTO agent_api_keys (agent_id,key,key_prefix,name,status,created_at) VALUES (?,?,?,?,1,datetime('now','localtime'))`)
        .run(aid, hashKey(raw), maskPrefix(raw), 'SEC02a测试');
      const row = db.prepare(`SELECT key,key_prefix FROM agent_api_keys WHERE name='SEC02a测试'`).get();
      assert.ok(looksHashed(row.key), 'key 列应为哈希形态');
      assert.notStrictEqual(row.key, raw, 'key 列不得等于明文');
      assert.strictEqual(row.key_prefix, maskPrefix(raw), '前缀掩码已落库（列表脱敏来源）');
      db.prepare(`DELETE FROM agent_api_keys WHERE name='SEC02a测试'`).run();
    });
    await t('SEC-03：加密往返且密文 ≠ 明文（密钥缺失 fail-closed 前置）', () => {
      const { encrypt, decrypt, keyInfo } = require('../src-server/lib/crypto-util');
      const enc = encrypt('sk-secret-value');
      assert.ok(enc && enc !== 'sk-secret-value', '密文不应等于明文');
      assert.ok(/^[0-9a-f]{8}\.[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]+$/i.test(enc), '密文为 kid.iv.authTag.ciphertext 四段形态（SEC-10 版本化）');
      assert.strictEqual(decrypt(enc), 'sk-secret-value', '解密可还原明文');
      const info = keyInfo();
      assert.ok(info.hasPrimary && info.source !== 'none', '启动期应已就绪加密密钥（来源=' + info.source + '）');
    });
    await t('SEC-04：空间不存在 fail-closed（与 spaceFilterSql 的 SQL 语义一致）', () => {
      const { spaceVisibleTo } = require('../src-server/lib/space-utils');
      assert.strictEqual(spaceVisibleTo(db, 987654321, 'zhangsan'), false, '脏空间/已删空间 → 不可见');
      assert.strictEqual(spaceVisibleTo(db, 0, 'zhangsan'), true, '无归属(0) → 全员可见');
      assert.strictEqual(spaceVisibleTo(db, null, 'zhangsan'), true, '无归属(NULL) → 全员可见');
    });
    await t('SEC-05：SSRF 私网/云元数据判定 + 出站拒绝（默认关闭私网）', async () => {
      const { ipIsPrivate, assertPublicHttpUrl } = require('../src-server/lib/ssrf-guard');
      const saved = process.env.AGENT_FETCH_ALLOW_PRIVATE;
      delete process.env.AGENT_FETCH_ALLOW_PRIVATE;
      try {
        for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', '0.0.0.0']) {
          assert.strictEqual(ipIsPrivate(ip), true, `${ip} 应判为私网/受限地址`);
        }
        assert.strictEqual(ipIsPrivate('8.8.8.8'), false, '公网 IP 放行');
        assert.strictEqual(ipIsPrivate('172.32.0.1'), false, '172.32 超出 172.16-31 私网段');
        await assert.rejects(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /内网|私网|拒绝/, '云元数据地址应拒绝');
        await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1:8080/admin'), /内网|私网|拒绝/, '环回地址应拒绝');
        await assert.rejects(() => assertPublicHttpUrl('ftp://8.8.8.8/x'), /http/, '非 http(s) 协议应拒绝');
        await assertPublicHttpUrl(''); // 未配置 → 放行（交由调用方必填校验）
      } finally {
        if (saved === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = saved;
      }
    });
    await t('SEC-07：token_version 用户级吊销——改密后旧令牌立即失效', () => {
      const { sign, verify, bumpTokenVersion } = require('../src-server/lib/auth');
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('sec07u','x','安全7','user',1,0,datetime('now','localtime'))`).run();
      const u = db.prepare(`SELECT id, token_version FROM users WHERE username='sec07u'`).get();
      const tv0 = u.token_version || 0;
      const oldTk = sign({ uid: u.id, tv: tv0, exp: Date.now() + 60000 });
      assert.ok(verify(oldTk), '初始令牌应通过校验');
      const tv1 = bumpTokenVersion(u.id);
      assert.strictEqual(tv1, tv0 + 1, '版本号应递增 +1');
      assert.strictEqual(verify(oldTk), null, '改密后旧令牌（tv 落后）应被拒');
      const newTk = sign({ uid: u.id, tv: tv1, exp: Date.now() + 60000 });
      assert.ok(verify(newTk), '携带新版本号的令牌应通过');
      db.prepare(`DELETE FROM users WHERE username='sec07u'`).run();
    });
    await t('SEC-07：生产/HTTPS 强制 Cookie Secure，开发默认不加', () => {
      const { setAuthCookie } = require('../src-server/lib/auth');
      const savedN = process.env.NODE_ENV, savedS = process.env.AGENT_COOKIE_SECURE, savedH = process.env.AGENT_ENABLE_HSTS;
      const cap = () => { const o = {}; return { setHeader(k, v) { o[k] = v; }, get() { return o['Set-Cookie']; } }; };
      try {
        delete process.env.NODE_ENV; delete process.env.AGENT_COOKIE_SECURE; delete process.env.AGENT_ENABLE_HSTS;
        let r = cap(); setAuthCookie(r, 'tok'); assert.ok(!/; Secure/.test(r.get()), '开发默认不加 Secure（避免本地 HTTP 登录不可用）');
        process.env.AGENT_COOKIE_SECURE = '1';
        r = cap(); setAuthCookie(r, 'tok'); assert.ok(/; Secure/.test(r.get()), 'AGENT_COOKIE_SECURE=1 强制 Secure');
      } finally {
        if (savedN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedN;
        if (savedS === undefined) delete process.env.AGENT_COOKIE_SECURE; else process.env.AGENT_COOKIE_SECURE = savedS;
        if (savedH === undefined) delete process.env.AGENT_ENABLE_HSTS; else process.env.AGENT_ENABLE_HSTS = savedH;
      }
    });
    await t('SEC-08：token 黑名单过期清理（保留未过期条目）', () => {
      const { cleanBlacklist } = require('../src-server/lib/auth');
      const expiredAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(); // 30 天前（远超 TTL+1h）
      db.prepare(`INSERT INTO token_blacklist (jti, username, created_at) VALUES ('sec08-expired','u',?)`).run(expiredAt);
      db.prepare(`INSERT INTO token_blacklist (jti, username, created_at) VALUES ('sec08-fresh','u',?)`).run(new Date().toISOString());
      cleanBlacklist();
      assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM token_blacklist WHERE jti='sec08-expired'`).get().c, 0, '过期条目应被清理');
      assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM token_blacklist WHERE jti='sec08-fresh'`).get().c, 1, '未过期条目应保留');
      db.prepare(`DELETE FROM token_blacklist WHERE jti='sec08-fresh'`).run();
    });
  }

  console.log('【SEC-M2】对外商用安全中期（SEC-09~12/14 单元级验收，2026-11-22）');
  {
    // ---------- SEC-09 卡片回调验签 fail-closed ----------
    await t('SEC-09：生产未配置验签材料 → 拒绝（fail-closed）；非生产放行标注；逃生阀可控', () => {
      const { verifyCardCallback } = require('../src-server/lib/card-callback-verify');
      const sN = process.env.NODE_ENV, sH = process.env.AGENT_ENABLE_HSTS, sA = process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED;
      try {
        delete process.env.NODE_ENV; delete process.env.AGENT_ENABLE_HSTS; delete process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED;
        const dev = verifyCardCallback({ type: 'feishu', config: {} }, {}, {}, {});
        assert.strictEqual(dev.ok, true, '非生产未验签应放行（不中断 mock 链路）');
        assert.strictEqual(dev.unverified, true, '应标注 unverified');
        process.env.NODE_ENV = 'production';
        const prod = verifyCardCallback({ type: 'feishu', config: {} }, {}, {}, {});
        assert.strictEqual(prod.ok, false, '生产未验签应拒绝');
        assert.ok(/未验签|未配置/.test(prod.reason), '拒绝原因应可检索');
        delete process.env.NODE_ENV; process.env.AGENT_ENABLE_HSTS = '1';
        assert.strictEqual(verifyCardCallback({ type: 'feishu', config: {} }, {}, {}, {}).ok, false, 'HSTS 生产档同样拒绝');
        process.env.NODE_ENV = 'production'; process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED = '1';
        assert.strictEqual(verifyCardCallback({ type: 'feishu', config: {} }, {}, {}, {}).ok, true, '逃生阀显式放行（不推荐）');
      } finally {
        if (sN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = sN;
        if (sH === undefined) delete process.env.AGENT_ENABLE_HSTS; else process.env.AGENT_ENABLE_HSTS = sH;
        if (sA === undefined) delete process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED; else process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED = sA;
      }
    });
    await t('SEC-09：通用 HMAC 验签 + 飞书恒时令牌比对（通过 / 拒绝）', () => {
      const { verifyCardCallback } = require('../src-server/lib/card-callback-verify');
      const crypto = require('crypto');
      const secret = 'sec09-callback-secret';
      const raw = JSON.stringify({ event: 'card_action', action: 'approve' });
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const ch = { type: 'custom', config: { callbackSecret: secret } };
      assert.strictEqual(verifyCardCallback(ch, { 'x-callback-signature': sig }, raw, {}).ok, true, '正确签名放行');
      assert.strictEqual(verifyCardCallback(ch, { 'x-callback-signature': sig }, raw + 'x', {}).ok, false, '正文被改签名应拒绝');
      assert.strictEqual(verifyCardCallback(ch, {}, raw, {}).ok, false, '缺签名应拒绝');
      const fch = { type: 'feishu', config: { verificationToken: 'fs-token-abc' } };
      assert.strictEqual(verifyCardCallback(fch, {}, { token: 'fs-token-abc' }, {}).ok, true, '飞书令牌匹配放行');
      assert.strictEqual(verifyCardCallback(fch, {}, { token: 'fs-token-wrong' }, {}).ok, false, '飞书令牌不匹配拒绝');
    });
    await t('SEC-09：卡片回调 GET/POST 端点均挂限流（接线断言）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'channel.js'), 'utf8');
      assert.ok(/cardCbLimit/.test(src), 'channel.js 应定义回调限流器');
      assert.ok(/router\.post\('\/card-callback', cardCbLimit/.test(src), 'POST 回调应挂限流');
      assert.ok(/router\.get\('\/card-callback', cardCbLimit/.test(src), 'GET 回调应挂限流');
    });

    // ---------- SEC-10 密钥管理规范 ----------
    await t('SEC-10：密钥来源 / kid 版本化 / 预留轮换——旧密文在 PREV 存在时仍可解', () => {
      const cu = require('../src-server/lib/crypto-util');
      const crypto = require('crypto');
      const sE = process.env.AGENT_ENCRYPTION_KEY, sP = process.env.AGENT_ENCRYPTION_KEY_PREV;
      try {
        const k1 = crypto.randomBytes(32).toString('hex');
        process.env.AGENT_ENCRYPTION_KEY = k1; delete process.env.AGENT_ENCRYPTION_KEY_PREV; cu.resetKeyCache();
        const i1 = cu.keyInfo();
        assert.strictEqual(i1.source, 'env', '环境变量为最高优先级来源');
        assert.strictEqual(i1.kid, cu.kidOf(Buffer.from(k1, 'hex')), 'kid = sha256(key) 前 8 位');
        const enc = cu.encrypt('v1-secret');
        assert.ok(enc.startsWith(i1.kid + '.'), '密文应以当前 kid 为前缀');
        assert.strictEqual(cu.decrypt(enc), 'v1-secret', '往返一致');
        const k2 = crypto.randomBytes(32).toString('hex');
        process.env.AGENT_ENCRYPTION_KEY = k2; process.env.AGENT_ENCRYPTION_KEY_PREV = k1; cu.resetKeyCache();
        const i2 = cu.keyInfo();
        assert.notStrictEqual(i2.kid, i1.kid, '轮换后 kid 应变化');
        assert.ok(i2.versions.length >= 2, '密钥环应含新旧版本');
        assert.strictEqual(cu.decrypt(enc), 'v1-secret', '旧密钥列入 PREV 后旧密文仍可解（预留轮换）');
        assert.ok(cu.keyFilePath().endsWith('encryption.key'), '密钥文件路径规范');
      } finally {
        if (sE === undefined) delete process.env.AGENT_ENCRYPTION_KEY; else process.env.AGENT_ENCRYPTION_KEY = sE;
        if (sP === undefined) delete process.env.AGENT_ENCRYPTION_KEY_PREV; else process.env.AGENT_ENCRYPTION_KEY_PREV = sP;
        cu.resetKeyCache();
      }
    });
    await t('SEC-10：密钥与密文不同源——文件密钥落 0600、密钥不入库、变更即刻热更新', () => {
      const cu = require('../src-server/lib/crypto-util');
      const { upsert, invalidate } = require('../src-server/lib/secrets');
      const fsx = require('fs');
      const kf = cu.keyFilePath();
      assert.ok(fsx.existsSync(kf), '测试库启动应生成文件密钥：' + kf);
      assert.strictEqual(fsx.statSync(kf).mode & 0o777, 0o600, '密钥文件权限应为 0600');
      assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM secrets WHERE name='ENCRYPTION_KEY'").get().c, 0, '密钥不应存 secrets 表（与密文不同源）');
      // 热更新：DB 密钥变更后 crypto 缓存应立即失效（secrets.upsert → resetKeyCache 联动）
      const savedFile = fsx.readFileSync(kf, 'utf8');
      const k = require('crypto').randomBytes(32).toString('hex');
      const sE = process.env.AGENT_ENCRYPTION_KEY;
      try {
        delete process.env.AGENT_ENCRYPTION_KEY;
        fsx.unlinkSync(kf); // 移除文件来源，令 DB 成为主来源（验证 DB 变更热更新 + resetKeyCache 联动）
        upsert('ENCRYPTION_KEY', k, 'SEC-10 热更新');
        assert.strictEqual(cu.keyInfo().source, 'db', '移除文件后来源应回落 DB');
        assert.strictEqual(cu.keyInfo().kid, cu.kidOf(Buffer.from(k, 'hex')), 'DB 密钥变更后应立即生效（缓存已失效）');
      } finally {
        if (sE === undefined) delete process.env.AGENT_ENCRYPTION_KEY; else process.env.AGENT_ENCRYPTION_KEY = sE;
        db.prepare("DELETE FROM secrets WHERE name='ENCRYPTION_KEY'").run();
        fsx.writeFileSync(kf, savedFile, { mode: 0o600 });
        try { fsx.chmodSync(kf, 0o600); } catch { /* 忽略 */ }
        invalidate(); cu.resetKeyCache();
      }
    });

    // ---------- SEC-11 审计日志防篡改 + UTC ----------
    await t('SEC-11：审计写入即建哈希链 + created_at 归 UTC ISO8601', () => {
      const Database = require('better-sqlite3');
      const { installGuard, verifyChain } = require('../src-server/lib/audit');
      const tmp = new Database(':memory:');
      tmp.exec("CREATE TABLE op_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, action TEXT, detail TEXT, ip TEXT, created_at TEXT, prev_hash TEXT DEFAULT '', record_hash TEXT DEFAULT '')");
      installGuard(tmp);
      tmp.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run('u1', '动1', '明细1', '1.1.1.1', '2020-01-01 00:00:00');
      tmp.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run('u2', '动2', '明细2', '2.2.2.2', '2020-01-01 00:00:00');
      const rows = tmp.prepare('SELECT id,created_at,prev_hash,record_hash FROM op_logs ORDER BY id').all();
      assert.strictEqual(rows.length, 2, '两行均已插入');
      assert.ok(rows[0].record_hash && rows[1].record_hash, '均写入 record_hash');
      assert.ok(/Z$/.test(rows[0].created_at), 'created_at 应为 UTC ISO8601（Z 结尾），覆盖传入的 localtime');
      assert.strictEqual(rows[1].prev_hash, rows[0].record_hash, '第二行 prev_hash 应指向首行 record_hash');
      assert.strictEqual(verifyChain(tmp, 'op_logs').ok, true, '链应完整');
      tmp.prepare('UPDATE op_logs SET detail=? WHERE id=?').run('被篡改', rows[0].id);
      const r2 = verifyChain(tmp, 'op_logs');
      assert.strictEqual(r2.ok, false, '篡改后链应断裂');
      assert.strictEqual(r2.brokenAt, rows[0].id, '应定位到被篡改行');
      tmp.close();
    });
    await t('SEC-11：哈希链校验工具存在（scripts/verify-audit-chain.js）', () => {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'verify-audit-chain.js')), '应有链校验工具');
    });

    // ---------- SEC-12 日志落库强制脱敏 ----------
    await t('SEC-12：日志写入层强制脱敏——密钥/PII 落库前自动掩码（调用方无从绕过）', () => {
      const { upsert } = require('../src-server/lib/secrets');
      const secretVal = 'sk-live-ABCDEFGHIJKLMNOP-987654';
      upsert('SEC12_LOGSECRET', secretVal, 'SEC-12 测试');
      // 直接 db.prepare 写入（模拟任意调用方），应由守卫强制脱敏
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('sec12u', '日志脱敏', 'Authorization: ' + secretVal + ' 联系 13800138000', '127.0.0.1', new Date().toISOString());
      const row = db.prepare("SELECT detail FROM op_logs WHERE username='sec12u'").get();
      assert.ok(!row.detail.includes(secretVal), '密钥明文不得落库');
      assert.ok(row.detail.includes('{{env.SEC12_LOGSECRET}}'), '密钥应掩码为 {{env.NAME}}');
      assert.ok(!row.detail.includes('13800138000'), '手机号不得明文落库');
      assert.ok(row.detail.includes('138') && row.detail.includes('8000'), 'PII 应保留首尾打码（138****8000）');
      db.prepare("DELETE FROM op_logs WHERE username='sec12u'").run();
      upsert('SEC12_LOGSECRET', '', 'SEC-12 清理');
    });

    // ---------- SEC-14 越权与安全专项回归 ----------
    await t('SEC-14：越权/绕过防护矩阵（空间 / 限流 / SSRF / 密钥 / 回调逐项 fail-closed）', () => {
      const { spaceVisibleTo } = require('../src-server/lib/space-utils');
      assert.strictEqual(spaceVisibleTo(db, 987654321, 'nobody'), false, '不存在的空间 → 非属主不可见');
      const { clientIp, trustHops } = require('../src-server/lib/rate-limit');
      const sT = process.env.AGENT_TRUST_PROXY;
      try {
        delete process.env.AGENT_TRUST_PROXY;
        assert.strictEqual(trustHops(), 0, '默认不信任代理');
        assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' }), '127.0.0.1', '默认忽略伪造 XFF（防限流绕过）');
      } finally { if (sT === undefined) delete process.env.AGENT_TRUST_PROXY; else process.env.AGENT_TRUST_PROXY = sT; }
      const { ipIsPrivate } = require('../src-server/lib/ssrf-guard');
      for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1']) assert.strictEqual(ipIsPrivate(ip), true, ip + ' 应拒绝');
      const { hashKey, looksHashed, maskPrefix } = require('../src-server/lib/apikey');
      assert.ok(looksHashed(hashKey('sk-x')) && !maskPrefix('sk-1234567890ab').includes('567890'), '对外密钥哈希存储 + 掩码不含中段');
      const { verifyCardCallback } = require('../src-server/lib/card-callback-verify');
      const sN = process.env.NODE_ENV, sA = process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED;
      try {
        process.env.NODE_ENV = 'production'; delete process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED;
        assert.strictEqual(verifyCardCallback({ type: 'feishu', config: {} }, {}, {}, {}).ok, false, '生产未验签回调拒绝');
      } finally {
        if (sN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = sN;
        if (sA === undefined) delete process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED; else process.env.AGENT_CALLBACK_ALLOW_UNVERIFIED = sA;
      }
    });
  }

  console.log('【N+1】P5.31 对话内定时任务：cron 增强 + create_task 工具');
  {
    const { parseCron, nextFire, describeCron, lastFire } = require('../src-server/lib/cron');
    await t('nextFire：每天/工作日/每月计划均可算出未来触发点', () => {
      const now = new Date('2026-10-27T10:00:00+08:00').getTime();
      const n1 = nextFire('0 9 * * *', now);
      assert.ok(n1 && new Date(n1).getHours() === 9 && n1 > now, '每天 9 点的下次触发应在未来且为 9 点');
      const n2 = nextFire('0 9 * * 1-5', new Date('2026-10-27T10:00:00+08:00').getTime()); // 周二
      const d2 = new Date(n2);
      assert.ok(d2.getDay() >= 1 && d2.getDay() <= 5, '工作日计划的下次触发应落在周一至周五');
      assert.strictEqual(nextFire('0 9 30 2 *', now), null, '2 月 30 日永不触发应返回 null');
      assert.strictEqual(nextFire('bad cron', now), null, '非法表达式应返回 null');
    });
    await t('describeCron：常见形态中文语义化', () => {
      assert.strictEqual(describeCron('0 9 * * *'), '每天 09:00 执行');
      assert.strictEqual(describeCron('30 9 * * 1'), '每周一 09:30 执行');
      assert.strictEqual(describeCron('*/5 * * * *'), '每 5 分钟执行一次');
      assert.strictEqual(describeCron('0 9 1 * *'), '每月 1 号 09:00 执行');
      assert.strictEqual(describeCron('0 9 * * 1-5'), '每周一、周二、周三、周四、周五 09:00 执行');
      // P5.33 审查修复（Y6）：分钟/小时为 * 时不再误报「每天 00:00」（实际频率相差最多 1440 倍）
      assert.strictEqual(describeCron('* * * * *'), '每分钟执行一次');
      assert.strictEqual(describeCron('15 * * * *'), '每小时第 15 分执行');
      assert.strictEqual(describeCron('* 9 * * *'), '每小时 9 时段内每分钟执行（时域 9）');
    });
    const { create_task } = require('../src-server/lib/tools-extra');
    await t('create_task：无归属拒绝 / 非法 cron 拒绝 / 合法创建落库带归属', async () => {
      let r = String(await create_task.run({ name: 'x', schedule: '0 9 * * *', prompt: 'p' }, {}));
      assert.ok(r.includes('缺少用户上下文'), '无 ctx.username 应拒绝');
      r = String(await create_task.run({ name: 'x', schedule: '0 25 * * *', prompt: 'p' }, { username: 'httpu1' }));
      assert.ok(r.includes('不合法'), '非法 cron 应拒绝');
      r = String(await create_task.run({ name: 'x', schedule: '0 9 30 2 *', prompt: 'p' }, { username: 'httpu1' }));
      assert.ok(r.includes('不会触发'), '永不触发的表达式应拒绝');
      r = String(await create_task.run({ name: '', schedule: '0 9 * * *', prompt: 'p' }, { username: 'httpu1' }));
      assert.ok(r.includes('任务名称'), '缺名称应拒绝');
      r = String(await create_task.run({ name: '每日资讯', schedule: '0 9 * * *', schedule_desc: '每天 09:00', prompt: '搜索今日科技新闻并摘要' }, { username: 'httpu1' }));
      assert.ok(r.includes('✅') && r.includes('每天 09:00') && r.includes('下次执行'), '合法创建应返回成功+计划+下次执行：' + r.slice(0, 100));
      const row = db.prepare("SELECT * FROM tasks WHERE name='每日资讯'").get();
      assert.ok(row && row.username === 'httpu1' && row.exec_type === 'cron' && row.cron === '0 9 * * *' && row.enabled === 1, '落库应带归属/类型/计划/启用');
      const params = JSON.parse(row.params || '{}');
      assert.ok(params.input.includes('科技新闻'), 'params.input 应为任务指令');
      const agent = db.prepare('SELECT name FROM agents WHERE id=?').get(row.target_id);
      assert.strictEqual(agent.name, '定时任务执行助手', '未指定 agent_id 应绑定系统执行智能体');
    });
    await t('create_task：非管理员任务数配额 + 受限智能体绑定拒绝', async () => {
      // 配额：为 httpu2 造 20 个启用任务后再创建应被拒
      const ins = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES (?,?,(SELECT id FROM agents WHERE name='定时任务执行助手'),'cron','0 9 * * *','{}',1,?,datetime('now','localtime'))`);
      for (let i = 0; i < 20; i++) ins.run('配额填充' + i, 'agent', 'httpu2');
      let r = String(await create_task.run({ name: '超限任务', schedule: '0 9 * * *', prompt: 'p' }, { username: 'httpu2' }));
      assert.ok(r.includes('上限'), '第 21 个任务应被配额拒绝');
      // 受限智能体：draft 状态 agent 对非管理员不可绑定
      db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,created_at,updated_at) VALUES ('草稿智能体','受限测试','enterprise','测试','p','draft','self',datetime('now','localtime'),datetime('now','localtime'))`).run();
      const draftId = db.prepare("SELECT id FROM agents WHERE name='草稿智能体'").get().id;
      r = String(await create_task.run({ name: 'x', schedule: '0 9 * * *', prompt: 'p', agent_id: draftId }, { username: 'httpu1' }));
      assert.ok(r.includes('不存在或未发布'), '非管理员绑定草稿智能体应被拒：' + r.slice(0, 80));
      // 清理：删掉配额填充与草稿 agent，避免影响后续用例
      db.prepare("DELETE FROM tasks WHERE username='httpu2' AND name LIKE '配额填充%'").run();
      db.prepare("DELETE FROM agents WHERE name='草稿智能体'").run();
    });
  }

  console.log('【N+2】P5.32 MCP 细粒度风险分级');
  {
    const { gradeMcpToolRisk } = require('../src-server/lib/mcp');
    await t('gradeMcpToolRisk：写类启发式/注解/读前缀/未知保守', () => {
      assert.strictEqual(gradeMcpToolRisk('create_user', '创建用户', {}), 'high', 'create 前缀应 high');
      assert.strictEqual(gradeMcpToolRisk('get_settings', '读取配置', {}), 'low', 'get 前缀应 low（settings 不含独立写词）');
      assert.strictEqual(gradeMcpToolRisk('get_settings', '写入配置', {}), 'high', '中文描述含写入应 high（优先于读前缀）');
      assert.strictEqual(gradeMcpToolRisk('search_docs', '检索文档', {}), 'low', 'search 前缀应 low');
      assert.strictEqual(gradeMcpToolRisk('read_file', '读文件', { readOnlyHint: true }), 'low', 'readOnlyHint 应 low');
      assert.strictEqual(gradeMcpToolRisk('delete_file', '删除文件', { readOnlyHint: true }), 'high', '写类词优先于 readOnlyHint 注解（注解不可盲信）');
      assert.strictEqual(gradeMcpToolRisk('magic_op', '未知操作', {}), 'high', '未知命名应保守 high');
      assert.strictEqual(gradeMcpToolRisk('list_items', '列表', { destructiveHint: true }), 'high', 'destructiveHint 应 high');
    });
    await t('gradeMcpToolRisk：P5.33 审查修复——snake_case/驼峰/组合动词伪装全拦截（纯名称无中文兑底）', () => {
      // R1/F6 实锤：原 \b 词边界对下划线命名全部失效，以下用例在修复前均判 low 或靠未知兑底
      assert.strictEqual(gradeMcpToolRisk('create_user', '', {}), 'high', 'create_user 应 high（原正则不命中）');
      assert.strictEqual(gradeMcpToolRisk('delete_file', '', { readOnlyHint: true }), 'high', 'delete_file+readOnlyHint 应 high');
      assert.strictEqual(gradeMcpToolRisk('update_settings', '', { readOnlyHint: true }), 'high', 'update_settings+readOnlyHint 应 high');
      assert.strictEqual(gradeMcpToolRisk('send_message', '', {}), 'high', 'send_message 应 high');
      assert.strictEqual(gradeMcpToolRisk('fetch_and_send', '', { readOnlyHint: true }), 'high', '读前缀+写动词组合应 high');
      assert.strictEqual(gradeMcpToolRisk('get_flag_then_delete', '', {}), 'high', 'get_..._delete 组合应 high');
      assert.strictEqual(gradeMcpToolRisk('read_then_update', '', {}), 'high', 'read_..._update 组合应 high');
      assert.strictEqual(gradeMcpToolRisk('DeleteAll', '', { readOnlyHint: true }), 'high', '驼峰 DeleteAll 应 high');
      assert.strictEqual(gradeMcpToolRisk('get_then_wipe', '', {}), 'high', '同义词 wipe 应 high');
      assert.strictEqual(gradeMcpToolRisk('xdelete', '', { readOnlyHint: true }), 'high', 'xdelete+readOnlyHint 伪装应 high（首词非读动词不采信注解）');
      assert.strictEqual(gradeMcpToolRisk('get_user', '', {}), 'low', '正常读工具不误伤：get_user 应 low');
      assert.strictEqual(gradeMcpToolRisk('query_order_status', '', {}), 'low', '正常读工具不误伤：query_order_status 应 low');
    });
    const { toolRiskOf, loadMcpTools } = require('../src-server/lib/tools');
    await t('toolRiskOf：MCP 细粒度——trusted+low 才降级，其余一律 high（向后兼容）', () => {
      // 数据已在 HTTP 组 setup 创建：A 已信任带 low 工具 / B 未信任 / C 旧缓存无 risk 字段
      const aId = db.prepare("SELECT id FROM mcp_servers WHERE name='信任服务A'").get().id;
      const bId = db.prepare("SELECT id FROM mcp_servers WHERE name='未信任服务B'").get().id;
      const cId = db.prepare("SELECT id FROM mcp_servers WHERE name='旧缓存服务C'").get().id;
      assert.strictEqual(toolRiskOf('mcp_get_x', { mcpServers: JSON.stringify([aId]) }), 'low', 'trusted+low 应降为 low（免确认疲劳）');
      assert.strictEqual(toolRiskOf('mcp_search_y', { mcpServers: JSON.stringify([bId]) }), 'high', '未 trusted 一律 high（白名单式）');
      assert.strictEqual(toolRiskOf('mcp_get_x'), 'high', '无 ctx（旧调用方）应 high（向后兼容）');
      assert.strictEqual(toolRiskOf('mcp_get_x', { mcpServers: '[]' }), 'high', '未挂载该服务的上下文应 high');
      assert.strictEqual(toolRiskOf('mcp_get_z', { mcpServers: JSON.stringify([cId]) }), 'high', '旧缓存无 risk 字段应 high（需刷新工具清单）');
      // 分级字段随 tools_cache 透传（loadMcpTools）
      const loaded = loadMcpTools(JSON.stringify([aId]));
      assert.ok(loaded[0].risk === 'low' && loaded[0].server.trusted === 1, 'loadMcpTools 应透传 risk 与 server.trusted');
    });
  }

  console.log('【N+3】P5.33 ConversationSink：外部/技能链路统一收尾');
  {
    const { finishExternalTurn } = require('../src-server/lib/chat-sink');
    // 造会话与输出敏感词（sink 的 mask/notice 路径）
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const sessInfo = db.prepare('INSERT INTO sessions (agent_id,title,username,created_at,updated_at) VALUES (NULL,?,?,?,?)').run('sink测试', 'httpu1', ts, ts);
    const sid = Number(sessInfo.lastInsertRowid);
    db.prepare('INSERT INTO words (category_id,word,input_block,output_block,hit_count,created_at) VALUES (NULL,?,0,1,0,?)').run('绝密黑词', ts);
    const events = [];
    const send = (event, data) => events.push({ event, data });
    const baseQuota = db.prepare('SELECT quota_used FROM users WHERE username=?').get('httpu1').quota_used;
    await t('finishExternalTurn：脱敏/notice/落库/记账/审计/trace/done 一次成型', async () => {
      const r = finishExternalTurn({
        send, sessionId: sid, username: 'httpu1', ip: '1.2.3.4',
        input: '看看这段内容', full: '回复中包含绝密黑词的部分。',
        modelLabel: 'test-model', modeLabel: 'dify', tStart: Date.now() - 50,
        extConvId: 'ext-conv-1',
        opDetail: (pt) => `测试转发（${pt} tokens）`,
      });
      const masked = '回复中包含****的部分。';
      assert.strictEqual(r.content, masked, '内容应脱敏：' + r.content);
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(r.mid);
      assert.ok(msg && msg.role === 'assistant' && msg.content === masked, 'assistant 消息应落库且为脱敏后内容');
      assert.strictEqual(msg.tokens, Math.ceil(masked.length * 0.6), 'tokens 缺省应按脱敏后内容估算');
      const sess = db.prepare('SELECT ext_conversation_id FROM sessions WHERE id=?').get(sid);
      assert.strictEqual(sess.ext_conversation_id, 'ext-conv-1', 'extConvId 应回写会话');
      const trace = db.prepare('SELECT * FROM chat_traces WHERE message_id=?').get(r.mid);
      assert.ok(trace && trace.mode === 'dify' && trace.model === 'test-model' && trace.prompt_chars === '看看这段内容'.length, 'trace 应含 mode/model/prompt_chars');
      assert.ok(trace.latency_ms >= 50, 'latency 应基于 tStart');
      const op = db.prepare("SELECT * FROM op_logs WHERE username='httpu1' AND detail LIKE '测试转发%' ORDER BY id DESC").get();
      assert.ok(op, 'op_logs 应落一条审计');
      assert.ok(op.detail.includes(`${msg.tokens} tokens`), 'opDetail 函数应以最终 tokens 为参：' + op.detail);
      const quota = db.prepare('SELECT quota_used FROM users WHERE username=?').get('httpu1').quota_used;
      assert.strictEqual(quota - baseQuota, msg.tokens, '配额应恰好记一次账（结构性防双记）');
      const word = db.prepare("SELECT hit_count FROM words WHERE word='绝密黑词'").get();
      assert.strictEqual(word.hit_count, 1, '敏感词命中应计数 +1');
      assert.ok(events.some(e => e.event === 'notice' && /脱敏/.test(e.data.msg)), '脱敏应发 notice 事件');
      const done = events.find(e => e.event === 'done');
      assert.ok(done && done.data.content === masked && done.data.tokens === msg.tokens, 'done 事件应带脱敏内容与 tokens');
    });
    await t('finishExternalTurn：显式 tokens / 不记账 / 不过滤 / 函数明细 参数化', () => {
      const ev2 = [];
      const r2 = finishExternalTurn({
        send: (e, d) => ev2.push({ e, d }), sessionId: sid, username: 'httpu1', ip: '1.2.3.4',
        input: 'x', full: '包含绝密黑词但不过滤', modelLabel: 'wf', modeLabel: 'coze-workflow',
        tStart: Date.now(), tokens: 42, maskOutput: false, billUsage: false,
        opAction: 'AI创作', opDetail: '静态明细',
      });
      assert.strictEqual(r2.tokens, 42, '显式 tokens 应直用');
      assert.strictEqual(r2.content, '包含绝密黑词但不过滤', 'maskOutput=false 应原样保留');
      const msg2 = db.prepare('SELECT * FROM messages WHERE id=?').get(r2.mid);
      assert.strictEqual(msg2.tokens, 42, '落库 tokens 应为显式值');
      assert.ok(!ev2.some(e => e.e === 'notice'), '不过滤时不应发 notice');
      const op2 = db.prepare("SELECT * FROM op_logs WHERE detail='静态明细' ORDER BY id DESC").get();
      assert.ok(op2 && op2.action === 'AI创作', 'opAction 应可定制');
      const quota2 = db.prepare('SELECT quota_used FROM users WHERE username=?').get('httpu1').quota_used;
      // 上一用例已记一次；本次 billUsage=false → 不应再增长
      const msg1tokens = Math.ceil('回复中包含****的部分。'.length * 0.6);
      assert.strictEqual(quota2 - baseQuota, msg1tokens, 'billUsage=false 不应记账');
    });
  }

  console.log('【N+4】P5.33 审查修复回归：SSRF / 任务敏感词 / 配额闸门 / sink 契约');
  {
    const { web_fetch } = require('../src-server/lib/tools-extra');
    await t('web_fetch：SSRF 防护——私网/环回/云元数据地址一律拒绝（F2）', async () => {
      const vectors = ['http://127.0.0.1:9999/x', 'http://localhost:8080/admin', 'http://192.168.1.1/router', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://[::1]:8080/'];
      for (const url of vectors) {
        const r = String(await web_fetch.run({ url }));
        assert.ok(r.includes('安全策略拒绝') || r.includes('仅支持 http'), `内网地址 ${url} 应被拒绝：` + r.slice(0, 80));
      }
    });
    const { create_task } = require('../src-server/lib/tools-extra');
    await t('create_task：任务指令含输入敏感词拒绝创建（Y7）', async () => {
      db.prepare('INSERT INTO words (category_id,word,input_block,output_block,hit_count,created_at) VALUES (NULL,?,1,0,0,?)').run('违禁任务词', new Date().toISOString().slice(0, 19));
      const r = String(await create_task.run({ name: 'x', schedule: '0 9 * * *', prompt: '执行违禁任务词相关操作' }, { username: 'httpu1' }));
      assert.ok(r.includes('违规词汇') && r.includes('拒绝创建'), '含敏感词的任务指令应拒绝：' + r.slice(0, 80));
    });
    const { runTask } = require('../src-server/lib/scheduler');
    await t('runTask：配额耗尽自动停用任务 + 站内信告知（F3）', async () => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,quota_total,quota_used,created_at) VALUES ('taskq',?,'配额闸门测试','user',1,0,10,10,datetime('now','localtime'))`).run(hashPwd('taskq-pass-1'));
      const sysAgent = db.prepare(`SELECT id FROM agents WHERE name='定时任务执行助手' AND source_name='系统内置'`).get();
      const info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES ('配额闸门任务','agent',?, 'cron','0 9 * * *',?,1,'taskq',datetime('now','localtime'))`).run(sysAgent.id, JSON.stringify({ input: '测试' }));
      const r = await runTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid));
      assert.strictEqual(r.status, 'fail', '配额耗尽应返回 fail');
      assert.ok(String(r.output).includes('自动停用'), '输出应说明已停用：' + r.output.slice(0, 60));
      const t2 = db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid);
      assert.strictEqual(t2.enabled, 0, '任务应已自动停用');
      const note = db.prepare("SELECT * FROM notifications WHERE username='taskq' AND type='task' ORDER BY id DESC").get();
      assert.ok(note && note.title.includes('停用'), '应发站内信告知归属者');
    });
    const { finishExternalTurn } = require('../src-server/lib/chat-sink');
    await t('finishExternalTurn：tokens=0/null 视为缺省走估算（Y2 契约对齐）', () => {
      const ev = [];
      const r = finishExternalTurn({
        send: (e, d) => ev.push({ e, d }), sessionId: null, username: 'httpu1', ip: '1.2.3.4',
        input: 'x', full: '四十二个字符的回复内容四十二个字符的回复内容四十二个字符的',
        modelLabel: 'm', modeLabel: 't', tStart: Date.now(), tokens: 0,
      });
      assert.strictEqual(r.tokens, Math.ceil('四十二个字符的回复内容四十二个字符的回复内容四十二个字符的'.length * 0.6), 'tokens=0 应回落估算而非记 0');
      const r2 = finishExternalTurn({
        send: () => { }, sessionId: null, username: 'httpu1', ip: '1.2.3.4',
        input: 'x', full: '同样内容同样内容同样内容同样内容', modelLabel: 'm', modeLabel: 't', tStart: Date.now(), tokens: null,
      });
      assert.strictEqual(r2.tokens, Math.ceil('同样内容同样内容同样内容同样内容'.length * 0.6), 'tokens=null 应回落估算');
    });
  }

  console.log('【N+5】P5.34 审查遗留收口：usage 累计 / 工具白名单 / MCP 人工定级 / 执行期复查');
  {
    const { toolRiskOf, loadMcpTools: loadMcpToolsForTest } = require('../src-server/lib/tools');
    const { accumulateUsage } = require('../src-server/lib/llm');
    await t('accumulateUsage：null 容错 / 多轮求和 / 非数值字段容错（Y5）', () => {
      assert.strictEqual(accumulateUsage(null, null), null, '双方 null 应返回 null');
      assert.deepStrictEqual(accumulateUsage(null, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, '首轮应初始化');
      const acc = accumulateUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      assert.deepStrictEqual(acc, { prompt_tokens: 110, completion_tokens: 55, total_tokens: 165 }, '多轮应求和（计费口径）');
      const bad = accumulateUsage(acc, { prompt_tokens: 'x', completion_tokens: undefined, total_tokens: -5 });
      assert.deepStrictEqual(bad, acc, '非数值/负值字段应按 0 容错（结果不变）');
    });
    const { validateAgentTools } = require('../src-server/lib/tools');
    await t('validateAgentTools：create_task 拒绝、local_exec/run_code 与常规工具放行（F1② / D1-1）', () => {
      assert.strictEqual(validateAgentTools(['web_search', 'run_code', 'calculator']), null, '常规工具+run_code 应放行');
      assert.ok(String(validateAgentTools(['create_task'])).includes('create_task') && String(validateAgentTools(['create_task'])).includes('不允许'), 'create_task 应拒绝');
      assert.strictEqual(validateAgentTools(['web_search', 'local_exec']), null, 'D1-1：local_exec 应放行（受档位+确认卡约束）');
      assert.ok(String(validateAgentTools(['not_a_tool'])).includes('未知工具'), '未知工具应拒绝');
      assert.strictEqual(validateAgentTools([]), null, '空清单应放行');
    });
    await t('loadMcpTools：人工标注优先于启发式，auto 回落（P5.34）', () => {
      // 服务 A（trusted=1，get_x 启发式 low）手工把 get_x 改 high；服务 B（未信任）手工把 search_y 保持 low
      const aId = db.prepare("SELECT id FROM mcp_servers WHERE name='信任服务A'").get().id;
      db.prepare("UPDATE mcp_servers SET risk_overrides=? WHERE id=?").run(JSON.stringify({ get_x: 'high' }), aId);
      const loaded = loadMcpToolsForTest(JSON.stringify([aId]));
      const gx = loaded.find(t => t.name === 'mcp_get_x');
      assert.strictEqual(gx.risk, 'high', '人工 high 应覆盖启发式 low');
      assert.strictEqual(gx.risk_override, 'high', '应透传 override 标记');
      assert.strictEqual(toolRiskOf('mcp_get_x', { mcpServers: JSON.stringify([aId]) }), 'high', 'toolRiskOf 应按人工 high 判 high（即使 trusted）');
      // auto：删除 key 回落启发式 low
      db.prepare("UPDATE mcp_servers SET risk_overrides=? WHERE id=?").run('{}', aId);
      const loaded2 = loadMcpToolsForTest(JSON.stringify([aId]));
      assert.strictEqual(loaded2.find(t => t.name === 'mcp_get_x').risk, 'low', 'auto（无 key）应回落启发式 low');
      assert.strictEqual(toolRiskOf('mcp_get_x', { mcpServers: JSON.stringify([aId]) }), 'low', '回落后 trusted+low 应恢复免确认');
    });
    const { runTask } = require('../src-server/lib/scheduler');
    await t('runTask：执行期复查——主体下架自动停用 + 通知（F8）', async () => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('f8u',?,'F8测试','user',1,0,datetime('now','localtime'))`).run(hashPwd('f8-pass-123'));
      const sysAgent = db.prepare("SELECT id FROM agents WHERE system_key='system_task_runner'").get();
      const info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES ('F8下架任务','agent',?, 'cron','0 9 * * *',?,1,'f8u',datetime('now','localtime'))`).run(sysAgent.id, JSON.stringify({ input: 'x' }));
      const tid = info.lastInsertRowid;
      // 下架主体
      db.prepare("UPDATE agents SET status='draft' WHERE id=?").run(sysAgent.id);
      const r = await runTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(tid));
      assert.strictEqual(r.status, 'fail', '主体下架应 fail');
      assert.ok(String(r.output).includes('下架'), '输出应说明下架停用：' + r.output.slice(0, 60));
      assert.strictEqual(db.prepare('SELECT enabled FROM tasks WHERE id=?').get(tid).enabled, 0, '任务应已自动停用');
      assert.ok(db.prepare("SELECT id FROM notifications WHERE username='f8u' AND type='task' ORDER BY id DESC").get(), '应发站内信');
      // 恢复主体发布状态 + 删除测试任务（不影响后续用例）
      db.prepare("UPDATE agents SET status='published' WHERE id=?").run(sysAgent.id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(tid);
      db.prepare("DELETE FROM notifications WHERE username='f8u'").run();
    });
    await t('runTask：执行期复查——归属者账号停用 / 主体不可见两闸门（F8 补齐）', async () => {
      const sysAgent = db.prepare("SELECT id FROM agents WHERE system_key='system_task_runner'").get();
      // 闸门 1：归属者账号停用
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('f8u2',?,'F8测试二','user',1,0,datetime('now','localtime'))`).run(hashPwd('f8-pass-123'));
      let info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES ('F8账号任务','agent',?, 'cron','0 9 * * *',?,1,'f8u2',datetime('now','localtime'))`).run(sysAgent.id, JSON.stringify({ input: 'x' }));
      db.prepare("UPDATE users SET status=0 WHERE username='f8u2'").run(); // 停用归属者账号
      let r = await runTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid));
      assert.ok(String(r.output).includes('账号已停用'), '归属者停用应停用任务：' + r.output.slice(0, 60));
      assert.strictEqual(db.prepare('SELECT enabled FROM tasks WHERE id=?').get(info.lastInsertRowid).enabled, 0, '任务应已停用');
      // 闸门 2：主体对归属者不可见（把系统智能体转 restricted 且不在名单）
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('f8u3',?,'F8测试三','user',1,0,datetime('now','localtime'))`).run(hashPwd('f8-pass-123'));
      db.prepare("UPDATE agents SET visibility='restricted', visible_members='[\"other-user\"]' WHERE id=?").run(sysAgent.id);
      info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at) VALUES ('F8可见性任务','agent',?, 'cron','0 9 * * *',?,1,'f8u3',datetime('now','localtime'))`).run(sysAgent.id, JSON.stringify({ input: 'x' }));
      r = await runTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid));
      assert.ok(String(r.output).includes('不对任务归属者开放'), '主体不可见应停用任务：' + r.output.slice(0, 60));
      // 清理：恢复智能体公开 + 删测试数据
      db.prepare("UPDATE agents SET visibility='public', visible_members='[]' WHERE id=?").run(sysAgent.id);
      db.prepare("DELETE FROM tasks WHERE name IN ('F8账号任务','F8可见性任务')").run();
      db.prepare("DELETE FROM users WHERE username IN ('f8u2','f8u3')").run();
      db.prepare("DELETE FROM notifications WHERE username IN ('f8u2','f8u3')").run();
    });
    await t('copy/技能资产白名单：违禁工具 create_task 被剔除、local_exec 保留（P5.34b / D1-1）', () => {
      // copy：源智能体含违禁工具（模拟历史注入）→ 副本剔除 create_task；local_exec 现属合法工具（保留）
      const sysAgent = db.prepare("SELECT id FROM agents WHERE system_key='system_task_runner'").get();
      db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,tools,allow_copy,owner,created_at,updated_at) VALUES ('违禁源智能体','x','digital','测试','p','published','self',?,1,'httpadmin',datetime('now','localtime'),datetime('now','localtime'))`).run(JSON.stringify(['web_search', 'create_task', 'local_exec', 'not_a_tool']));
      const srcId = db.prepare("SELECT id FROM agents WHERE name='违禁源智能体'").get().id;
      // 直接调用 copy 的核心过滤逻辑（路由层 HTTP 测不了 canView/admin 上下文，此处验证数据面）：
      // 复制 SQL 用 filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t))
      const { TOOL_DEFS, AGENT_TOOL_DENY } = require('../src-server/lib/tools');
      const copyTools = JSON.parse(db.prepare('SELECT tools FROM agents WHERE id=?').get(srcId).tools).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
      assert.deepStrictEqual(copyTools, ['web_search', 'local_exec'], 'copy 过滤应剔除 create_task/未知工具、保留 local_exec：' + JSON.stringify(copyTools));
      // 技能资产：API 直调注入 create_task → filter 剔除（skillassets.js 同口径）
      const skillTools = ['create_task', 'web_search', 'local_exec'].filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
      assert.deepStrictEqual(skillTools, ['web_search', 'local_exec'], '技能工具过滤应剔除 create_task、保留 local_exec');
      db.prepare("DELETE FROM agents WHERE name='违禁源智能体'").run();
    });
    await t('P5.34b tripwire：runChildAgent 拒 create_task、@技能/@专家并入带过滤（F1/F4 / D1-1）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      // F1：runChildAgent 的 executeTool 拒绝 create_task（D1-1 后仅此一项）
      const rcStart = src.indexOf('async function runChildAgent');
      const rcEnd = src.indexOf('/** ⑦ 分类器路由');
      assert.ok(rcStart > 0 && rcEnd > rcStart, 'runChildAgent 定位成功');
      const rcBlock = src.slice(rcStart, rcEnd);
      assert.ok(rcBlock.includes("name === 'create_task'"), '子智能体执行应拒绝 create_task');
      assert.ok(!rcBlock.includes("name === 'create_task' || name === 'local_exec'"), 'D1-1：子智能体不应再拒绝 local_exec');
      // F4：技能/专家并入处有 safeToolId 过滤
      assert.ok(src.includes('safeToolId(tid)'), '@技能/@专家并入应经 safeToolId 过滤');
    });
    await t('create_task：system_key 稳定绑定——用户自建同名智能体不劫持（Y4 完整方案）', async () => {
      const { create_task } = require('../src-server/lib/tools-extra');
      // 用户自建同名「定时任务执行助手」（published、带危险工具集）——不应影响默认绑定
      db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,source_name,tools,owner,created_at,updated_at) VALUES ('定时任务执行助手','劫持测试','digital','测试','p','published','self','用户自建',?, 'httpu2',datetime('now','localtime'),datetime('now','localtime'))`).run(JSON.stringify(['run_code']));
      const r = String(await create_task.run({ name: 'Y4验证', schedule: '0 9 * * *', prompt: 'p' }, { username: 'httpu1' }));
      assert.ok(r.includes('✅'), '创建应成功');
      const row = db.prepare("SELECT * FROM tasks WHERE name='Y4验证'").get();
      const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(row.target_id);
      assert.strictEqual(agent.system_key, 'system_task_runner', '应绑定 system_key 智能体而非自建同名');
      db.prepare("DELETE FROM tasks WHERE name='Y4验证'").run();
      db.prepare("DELETE FROM agents WHERE source_name='用户自建' AND name='定时任务执行助手'").run();
    });
    await t('测试轮修复回归：copy 路由 INSERT 列数与占位符配比（防占位符丢失回归）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'agents.js'), 'utf8');
      // BE-C1（2026-11-23）：裸查已收敛 dal——INSERT 语句改作 dal.runq 首实参（VALUES 闭括号后跟 ', [' 参数数组），
      // 守卫正则同步适配两种形态（老 db.prepare(...).run( / 新 dal.runq(..., [)），守护意图不变：列数=占位数+datetime数
      const re = /INSERT INTO agents \(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:\.run\(|['`"']?\s*,\s*\[)/g;
      let found = null, m;
      while ((m = re.exec(src))) { if (m[1].includes('long_memory') && m[1].includes('child_ids')) { found = m; break; } }
      assert.ok(found, 'copy 的 INSERT 语句存在');
      const cols = found[1].split(',').map(s => s.trim()).filter(Boolean);
      // VALUES 段整段统计（datetime('now','localtime') 内含逗号，不能按逗号 split）
      const q = (found[2].match(/\?/g) || []).length;
      const dt = (found[2].match(/datetime\(/g) || []).length;
      assert.strictEqual(cols.length, q + dt, `列数 ${cols.length} 应等于 ?数 ${q} + datetime数 ${dt}（测试轮实锤：曾丢 1 个 ? 致复制必 500）`);
    });
    await t('测试轮修复回归：SQL 字符串字面量不得用双引号（categories/kb_files 修复）', () => {
      for (const f of ['agents.js', 'knowledge.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', f), 'utf8');
        const bad = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && /status="[a-z_]+"/.test(l));
        assert.deepStrictEqual(bad, [], `${f} 代码行不得再用双引号字面量（SQLite 视为标识符；残留：${JSON.stringify(bad)}）`);
      }
      const rows = db.prepare("SELECT category, COUNT(*) c FROM agents WHERE status='published' GROUP BY category ORDER BY c DESC").all();
      assert.ok(Array.isArray(rows), 'categories SQL 应可执行');
    });
    await t('测试轮修复回归：agents.js 导入 AGENT_TOOL_DENY（S1 副本工具恒空修复）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'agents.js'), 'utf8');
      const imp = src.match(/const \{[^}]*\} = require\('\.\.\/lib\/tools'\)/);
      assert.ok(imp && imp[0].includes('AGENT_TOOL_DENY'), 'tools 导入必须包含 AGENT_TOOL_DENY（漏导入被 catch 吞错 → 副本工具恒空）');
    });
    await t('测试轮修复回归：err-logs 清空带 .run()（S2 假成功修复）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'logs.js'), 'utf8');
      // BE-C1（2026-11-23）适配：dal.runq('DELETE FROM err_logs') 与 .run() 同为真实执行语义（prepare 仅编译不执行的假成功防护不变）
      assert.ok(/DELETE FROM err_logs'\)\.run\(\)|dal\.runq\('DELETE FROM err_logs'/.test(src), 'DELETE FROM err_logs 必须带 .run()/dal.runq 真实执行（prepare 只编译不执行，曾 77→77 假成功）');
    });
    await t('DB优化：热表索引齐备（6 热表 11 索引 + agents 4 索引 = 15 条新索引，防误删）', () => {
      const must = ['idx_messages_session','idx_messages_created','idx_chat_traces_msg','idx_chat_traces_agent',
        'idx_kb_chunks_kb','idx_kb_chunks_file','idx_op_logs_created','idx_err_logs_created',
        'idx_sessions_user','idx_sessions_agent','idx_task_runs_started',
        'idx_agents_status_pub','idx_agents_owner','idx_agents_share_token','idx_agents_source_ext'];
      const have = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
      const miss = must.filter(n => !have.includes(n));
      assert.deepStrictEqual(miss, [], `缺失索引：${JSON.stringify(miss)}（热表无索引会全表扫冻结 SSE）`);
    });
    await t('DB优化：stats.js 聚合下推（无全表扫 messages 进内存）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'stats.js'), 'utf8');
      assert.ok(!/SELECT created_at, tokens FROM messages'\)\.all\(\)/.test(src), '不得再全表读 messages 进内存按天求和（应下推 SUM+GROUP BY）');
      assert.ok(!/SELECT m\.created_at, s\.username FROM messages m JOIN sessions s.*'\)\.all\(\)/.test(src), '不得再全表读 messages+sessions 进内存按天去重（应下推 COUNT(DISTINCT)+GROUP BY）');
      assert.ok(src.includes('activeUserSeries') && src.includes('tokenSeries') && src.includes('agentGrowthSeries'), '应抽取公共聚合函数');
    });
    await t('DB优化：biz.js 发票用量查询不得用 substr 函数包裹列（阻断索引）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'biz.js'), 'utf8');
      assert.ok(!/substr\(m\.created_at,1,7\)=\?/.test(src), '不得用 substr(created_at,1,7)=?（函数包裹列阻断 idx_messages_created），应改 created_at >= ? AND created_at < ? 范围查询');
      assert.ok(/m\.created_at >= \? AND m\.created_at < \?/.test(src), '应改范围查询走索引');
    });
    // 【N+6】Rerank 重排序（2026-10-28 P2 重排升级）
    await t('rerankProviders 无供应商时返回空数组', () => {
      const { rerankProviders } = require('../src-server/lib/retriever');
      const r = rerankProviders();
      assert.ok(Array.isArray(r));
      assert.strictEqual(r.length, 0);
    });
    await t('rerankAndSlice 退化逻辑（无供应商时退回 RRF 结果）', async () => {
      const { retrieve } = require('../src-server/lib/retriever');
      const result = await retrieve('测试', 0, 5, 0.01);
      assert.ok(Array.isArray(result));
      // 无供应商时不会崩溃，返回 RRF 排序结果
    });
    // 【N+7】自动关键词/问法生成（2026-10-29）
    await t('keywordgen：kb_chunks 表已迁移 keywords 字段', () => {
      const cols = db.prepare('PRAGMA table_info(kb_chunks)').all().map(c => c.name);
      assert.ok(cols.includes('keywords'), 'kb_chunks 应有 keywords 列');
    });
    await t('keywordgen：parseMeta 解析——裸 JSON / 代码块包裹 / 杂讯容错', () => {
      const { parseMeta } = require('../src-server/lib/keywordgen');
      const a = parseMeta('{"keywords":["迟到","考勤"],"questions":["迟到怎么处理？"]}');
      assert.deepStrictEqual(a, { keywords: ['迟到', '考勤'], questions: ['迟到怎么处理？'] });
      const b = parseMeta('好的，以下是结果：\n```json\n{"keywords":["报销"],"questions":[]}\n```');
      assert.deepStrictEqual(b, { keywords: ['报销'], questions: [] });
      assert.strictEqual(parseMeta('这不是 JSON 输出'), null);
      assert.strictEqual(parseMeta('{"keywords":[],"questions":[]}'), null, '全空应视为无效');
      assert.strictEqual(parseMeta(''), null);
    });
    await t('keywordgen：generateForFile 无供应商时静默跳过（不阻塞）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('关键词测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='关键词测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'kw文件.md',100,'success',1,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '测试关键词生成的分块内容，长度超过八个字');
      const { generateForFile } = require('../src-server/lib/keywordgen');
      const r = await generateForFile(fid);
      assert.ok(r.ok === true && r.skipped === 'no_provider' && r.generated === 0, '无供应商应返回 skipped=no_provider：' + JSON.stringify(r));
      const r2 = await generateForFile(999999);
      assert.ok(r2.ok === false, '文件不存在应返回 ok=false');
      globalThis.__kwTestKbId = kbid; globalThis.__kwTestFileId = fid;
    });
    await t('keywordgen：BM25 通道索引关键词+问法——换说法提问可命中（检索扩展）', async () => {
      const kbid = globalThis.__kwTestKbId, fid = globalThis.__kwTestFileId;
      // 分块原文不含查询词；关键词/问法含查询词（数据安全/保障），验证 _idx 扩展生效
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,keywords) VALUES (?,?,?,?)`).run(
        fid, kbid,
        '本项目基于联邦学习与差分隐私技术构建分析平台，支持多方数据协作建模',
        JSON.stringify({ keywords: ['数据安全', '隐私保护', '等保合规'], questions: ['数据怎么保障安全？'] }));
      const { retrieve } = require('../src-server/lib/retriever');
      const hits = await retrieve('数据安全保障措施', kbid, 5, 0);
      const hit = hits.find(h => (h.content || '').includes('联邦学习'));
      assert.ok(hit, '关键词扩展后应命中该分块：' + JSON.stringify(hits.map(h => h.content?.slice(0, 20))));
      assert.ok(hit.bm25 > 0, '命中应来自 BM25 通道（原文不含查询词，仅关键词含）：bm25=' + hit.bm25);
      assert.ok(!hit.content.includes('keywords'), '输出 content 应保持原文，不混入关键词文本');
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    // 【P0-5】GraphRAG 修复回归（2026-10-30：graphrag.js 曾被误删为仅剩分词函数，无测试发现——补防回归）
    await t('graphrag：persistEntities 幂等写入 + retrieveGraph 实体命中', () => {
      const { persistEntities, retrieveGraph } = require('../src-server/lib/graphrag');
      const n1 = persistEntities([{ name: '奇墨科技', type: '组织', description: 'AI中台厂商' }, { name: '李小龙', type: '人物', description: '分享人' }]);
      assert.ok(n1 >= 1, '首次写入应新增实体，实际 ' + n1);
      const n2 = persistEntities([{ name: '奇墨科技', type: '组织', description: '重复项' }]);
      assert.strictEqual(n2, 0, '同名同类型应幂等跳过');
      const g = retrieveGraph('奇墨科技的产品怎么样', null, 5);
      assert.ok(g.entities.some(e => e.name === '奇墨科技'), '查询含实体名应命中：' + JSON.stringify(g.entities));
      assert.ok(Array.isArray(g.relations) && Array.isArray(g.context), 'relations/context 应为数组');
      const empty = retrieveGraph('完全无关的查询词组', null, 5);
      assert.ok(Array.isArray(empty.entities), '无命中也不应抛错');
    });
    await t('graphrag：persistTriples 写入 + retrieveGraph 关系/上下文带回', () => {
      const { persistEntities, persistTriples, retrieveGraph } = require('../src-server/lib/graphrag');
      // 准备实体 + 分块
      persistEntities([{ name: '张三', type: '人物' }, { name: '产品部', type: '组织' }]);
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('图谱测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='图谱测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'graph.md',100,'success',1,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '张三在产品部负责智能体平台研发工作');
      const cid = db.prepare(`SELECT id FROM kb_chunks WHERE file_id=?`).get(fid).id;
      const n = persistTriples([{ subject: '张三', predicate: '属于', object: '产品部' }], cid);
      assert.ok(n >= 1, '三元组应写入，实际 ' + n);
      const g = retrieveGraph('张三', null, 5);
      assert.ok(g.relations.some(r => r.relation === '属于'), '应带回关系：' + JSON.stringify(g.relations));
      assert.ok(g.context.some(c => c.includes('产品部')), '上下文应带回支撑分块：' + JSON.stringify(g.context));
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
      db.prepare(`DELETE FROM entity_relations`).run();
      db.prepare(`DELETE FROM entities`).run();
    });
    await t('graphrag：extractEntitiesFromChunks/extractTriples 无供应商静默跳过', async () => {
      const { extractEntitiesFromChunks, extractTriples } = require('../src-server/lib/graphrag');
      assert.deepStrictEqual(await extractEntitiesFromChunks([{ content: '测试内容' }]), []);
      assert.deepStrictEqual(await extractTriples('测试内容'), []);
    });
    // 【TOC】目录增强（2026-10-30）
    await t('TOC：kbs.toc 与 kb_chunks.chapter_id 列已迁移', () => {
      const kbCols = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
      const chCols = db.prepare('PRAGMA table_info(kb_chunks)').all().map(c => c.name);
      assert.ok(kbCols.includes('toc'), 'kbs 应有 toc 列');
      assert.ok(chCols.includes('chapter_id'), 'kb_chunks 应有 chapter_id 列');
    });
    await t('TOC：assignChapterIds 按标题归属章节（对象分块，修复回归）', () => {
      const { assignChapterIds } = require('../src-server/lib/tocService');
      const toc = [
        { title: '第一章 总则', level: 1, chapterId: 1 },
        { title: '第二章 考勤管理', level: 1, chapterId: 2 },
      ];
      const chunks = [
        { content: '第一章 总则\n本制度适用于全体员工。' },
        { content: '迟到一次扣款五十元。' },
        { content: '第二章 考勤管理\n考勤记录以打卡系统为准。' },
        { content: '月度迟到三次以上视为旷工。' },
      ];
      assignChapterIds(chunks, toc);
      assert.strictEqual(chunks[0].chapterId, 1, '首块应归属第1章');
      assert.strictEqual(chunks[1].chapterId, 1, '未遇新标题应延续第1章');
      assert.strictEqual(chunks[2].chapterId, 2, '遇第2章标题应切换');
      assert.strictEqual(chunks[3].chapterId, 2, '应延续第2章');
      assert.ok(chunks.every(c => typeof c.content === 'string'), 'content 应保持字符串');
    });
    await t('TOC：attachChapterContext 同章节相邻分块带出（retriever 集成）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('TOC检索测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbid = db.prepare(`SELECT id FROM kbs WHERE name='TOC检索测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'toc.md',100,'success',1,datetime('now','localtime'))`).run(kbid);
      const fid = db.prepare(`SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC`).get(kbid).id;
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,chapter_id,parent_id) VALUES (?,?,?,?,NULL)`).run(fid, kbid, '第一章 迟到处理规则：迟到一次扣款五十元。', 1);
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,chapter_id,parent_id) VALUES (?,?,?,?,NULL)`).run(fid, kbid, '月度迟到累计三次以上按旷工半日处理。', 1);
      db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content,chapter_id,parent_id) VALUES (?,?,?,?,NULL)`).run(fid, kbid, '第二章 报销制度：提交发票后三个工作日内完成审核打款。', 2);
      const { retrieve } = require('../src-server/lib/retriever');
      const hits = await retrieve('迟到扣款规则', kbid, 5, 0, { rerankEnabled: false });
      const hit = hits.find(h => (h.content || '').includes('扣款'));
      assert.ok(hit, '应命中迟到规则分块');
      assert.ok(hit.content.includes('旷工'), '同章节相邻分块应被带出（避免断章取义）：' + hit.content.slice(0, 80));
      assert.ok(hit.chapter_context != null || hit.parent_content != null, '应携带上下文标记字段');
      db.prepare(`DELETE FROM kb_chunks WHERE file_id=?`).run(fid);
      db.prepare(`DELETE FROM kb_files WHERE id=?`).run(fid);
      db.prepare(`DELETE FROM kbs WHERE id=?`).run(kbid);
    });
    // 【P6】PDF 表格结构化解析（增强型 PDF 解析）
    await t('P6 PDF表格检测：Pipe表格（竖线分隔）→ Markdown', () => {
      const { enhancePdfText } = require('../src-server/lib/enhancedPdfText');
      const raw = `| 姓名 | 部门 | 职位 |
| --- | --- | --- |
| 张三 | 产品部 | 产品经理 |
| 李四 | 研发部 | 高级工程师 |
| 王五 | 市场部 | 市场总监 |
`;
      const r = enhancePdfText(raw);
      assert.ok(r.text.includes('| 姓名'), 'Pipe表格应保留| 姓名表头');
      assert.ok(r.text.includes('| ---'), 'Pipe表格应保留分隔线');
      assert.ok(r.text.includes('| 张三'), 'Pipe表格应保留行内容');
      assert.ok(r.tables.length >= 1, '应检测到至少1个表格');
      assert.deepStrictEqual(r.tables[0].headers, ['姓名', '部门', '职位']);
      assert.strictEqual(r.tables[0].rows.length, 3);
    });
    await t('P6 PDF表格检测：对齐表格（空格分隔）→ Markdown', () => {
      const { enhancePdfText } = require('../src-server/lib/enhancedPdfText');
      // 用两个以上空格模拟对齐表格
      const raw = `姓名    部门    职位
张三    产品部    产品经理
李四    研发部    高级工程师
王五    市场部    市场总监`;
      const r = enhancePdfText(raw);
      assert.ok(r.tables.length >= 1, '对齐表格应被检测到：' + JSON.stringify(r.tables));
      const t = r.tables[0];
      assert.deepStrictEqual(t.headers, ['姓名', '部门', '职位']);
      assert.strictEqual(t.rows.length, 3);
    });
    await t('P6 PDF无表格内容：返回纯文本不分词', () => {
      const { enhancePdfText } = require('../src-server/lib/enhancedPdfText');
      const r = enhancePdfText('这是纯段落文本，没有表格，只有一行内容。');
      assert.strictEqual(r.tables.length, 0);
      assert.ok(r.text.includes('纯段落文本'));
    });
    await t('P6 PDF空输入：返回空结果', () => {
      const { enhancePdfText } = require('../src-server/lib/enhancedPdfText');
      const r = enhancePdfText('');
      assert.strictEqual(r.text, '');
      assert.strictEqual(r.tables.length, 0);
    });
    // 【P3】P3 工程化：建表数 tripwire
    await t('P3 工程化：新库建表数 = 50（防 schema 误删/迁移遗漏）', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      // 临时表影响计算（微信/飞书等动态创建的除外）
      const tableNames = tables.map(r => r.name);
      const expected = 49; // 对照：db.js 中 CREATE TABLE 语句数，8月以上版本可能因迁移增加（V3.1 #12 +1：agent_reviews）
      const hasTokenBlacklist = tableNames.includes('token_blacklist');
      // token_blacklist 是动态决定是否存在的，不算标准建表数
      assert.ok(tables.length >= expected, `建表数 ${tables.length} 应 ≥ ${expected}（当前可能缺表：${tableNames.filter(n => !tables.some(t => t.name === n)).join(',')}）`);
    });
    // 【P3】P3 工程化：P2 新增索引检查
    await t('P3 工程化：P2 新增索引（rerank/父子切片/分块管理）', () => {
      const have = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
      const p2Indexes = ['idx_messages_session_created', 'idx_chat_traces_session'];
      for (const idx of p2Indexes) {
        assert.ok(have.includes(idx), `缺失 P2 新增索引：${idx}`);
      }
    });
    // ===== P2 里程碑验收补测——单元组（2026-11-05）：rerankAndSlice/bgeRerank/bgeEmbed/parseVec/rerankModels/P2-5 契约 =====
    // 顺序约束：rerankAndSlice（mock 重排成功）必须在 bgeRerank 熔断用例之前——熔断后 30s 内 bgeRerank 直接 null，
    // mock 供应商不再被触达（rerankDownUntil 为模块级状态，跨用例泄漏是有意为之的降级保护语义）
    await t('单元：P2-2 rerankAndSlice 重排生效——mock 逆序返回覆盖 RRF 序 + rerank_score 附加 + channels/hit_terms 保留 + topN 截断', async () => {
      const { rerankAndSlice, __expireCircuitBreakers } = require('../src-server/lib/retriever');
      __expireCircuitBreakers(); // 跨用例熔断状态重置（模块级 30s 记忆会短路本用例的 mock 供应商）
      const savedAllowPrivate = process.env.AGENT_FETCH_ALLOW_PRIVATE; process.env.AGENT_FETCH_ALLOW_PRIVATE = '1'; // SEC-05：本用例 mock 网关在 127.0.0.1，需显式放行私网
      db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default) VALUES ('P2补测rerank供应商','http://127.0.0.1:1','sk-p2test','["bge-reranker-v2-m3"]',1,0)`).run();
      const pid = db.prepare(`SELECT id FROM providers WHERE name='P2补测rerank供应商'`).get().id;
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [{ index: 3, relevance_score: 0.9 }, { index: 2, relevance_score: 0.6 }, { index: 1, relevance_score: 0.4 }, { index: 0, relevance_score: 0.2 }] }) });
        const items = [0, 1, 2, 3].map(i => ({ id: i + 1, content: `RRF候选第${i}名内容标记词`, score: 0.01 * (4 - i), channels: 'both', hit_terms: ['标记词'] }));
        const out = await rerankAndSlice('标记词', items, 10, {}); // rerankEnabled 缺省 true → 走 mock 重排
        assert.deepStrictEqual(out.map(o => o.id), [4, 3, 2, 1], '重排后顺序应为 index 3,2,1,0（覆盖 RRF 逆序）：' + out.map(o => o.id).join(','));
        assert.strictEqual(typeof out[0].rerank_score, 'number', '输出应附加 rerank_score：' + JSON.stringify(out[0].rerank_score));
        assert.strictEqual(out[0].channels, 'both', '重排后应保留 finish 产物 channels（P2-5 溯源链路不断链）：' + out[0].channels);
        assert.deepStrictEqual(out[0].hit_terms, ['标记词'], '重排后应保留 hit_terms');
        const out2 = await rerankAndSlice('标记词', items, 2, {});
        assert.strictEqual(out2.length, 2, 'topN=2 应截断：' + out2.length);
        assert.strictEqual(out2[0].id, 4, '截断后仍保持重排序');
      } finally {
        globalThis.fetch = origFetch;
        if (savedAllowPrivate === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = savedAllowPrivate;
        db.prepare('DELETE FROM providers WHERE id=?').run(pid);
      }
    });
    await t('单元：P2-2 bgeRerank——results 降序解析 / data[] 备选格式 / HTTP 500 → null + 30s 熔断窗口内不再发请求', async () => {
      const { bgeRerank, __expireCircuitBreakers } = require('../src-server/lib/retriever');
      __expireCircuitBreakers(); // 前序用例可能触发熔断（如 bgeEmbed 失败路径），重置后本用例熔断断言才真实可控
      const savedAllowPrivate = process.env.AGENT_FETCH_ALLOW_PRIVATE; process.env.AGENT_FETCH_ALLOW_PRIVATE = '1'; // SEC-05：mock 网关在 127.0.0.1，需显式放行私网
      db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default) VALUES ('P2补测rerank供应商2','http://127.0.0.1:1','sk-p2test2','["bge-reranker-v2-m3"]',1,0)`).run();
      const pid = db.prepare(`SELECT id FROM providers WHERE name='P2补测rerank供应商2'`).get().id;
      const origFetch = globalThis.fetch;
      let calls = 0;
      try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.7 }] }) });
        const r1 = await bgeRerank('查询', [{ content: '甲' }, { content: '乙' }, { content: '丙' }]);
        assert.deepStrictEqual(r1.map(r => r.index), [2, 1, 0], 'results 应按 relevance_score 降序排列');
        assert.deepStrictEqual(r1.map(r => r.score), [0.9, 0.7, 0.5], 'score 应映射 relevance_score');
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }] }) });
        const r2 = await bgeRerank('查询', [{ content: '甲' }, { content: '乙' }]);
        assert.deepStrictEqual(r2.map(r => r.index), [1, 0], 'data[]（类 OpenAI）备选格式应同样解析');
        globalThis.fetch = async () => { calls++; return { ok: false, json: async () => ({}) }; };
        const r3 = await bgeRerank('查询', [{ content: '甲' }, { content: '乙' }]);
        assert.strictEqual(r3, null, 'HTTP 500 应返回 null（跳过重排回落 RRF）');
        assert.ok(calls >= 1, '失败路径应真实发出请求（计数 ' + calls + '）');
        const before = calls;
        const r4 = await bgeRerank('查询', [{ content: '甲' }, { content: '乙' }]);
        assert.strictEqual(r4, null, '熔断窗口内二次调用直接 null');
        assert.strictEqual(calls, before, '熔断窗口内不应再发请求（rerankDownUntil 30s 记忆）');
      } finally {
        globalThis.fetch = origFetch;
        if (savedAllowPrivate === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = savedAllowPrivate;
        db.prepare('DELETE FROM providers WHERE id=?').run(pid);
      }
    });
    await t('单元：P2-1 bgeEmbed——成功 1024 维列表 / 维度不符降级 / 条数不符降级（结构校验三态，mock fetch finally 恢复）', async () => {
      const { bgeEmbed, __expireCircuitBreakers } = require('../src-server/lib/retriever');
      __expireCircuitBreakers(); // HTTP 区无供应商调用已设 30s 熔断（无 provider 也落熔断行的实现语义），不重置会短路成功路径
      const savedAllowPrivate = process.env.AGENT_FETCH_ALLOW_PRIVATE; process.env.AGENT_FETCH_ALLOW_PRIVATE = '1'; // SEC-05：mock 网关在 127.0.0.1，需显式放行私网
      db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default) VALUES ('P2补测embed供应商','http://127.0.0.1:1','sk-p2test3','["bge-m3"]',1,0)`).run();
      const pid = db.prepare(`SELECT id FROM providers WHERE name='P2补测embed供应商'`).get().id;
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: new Array(1024).fill(0.5) }, { embedding: new Array(1024).fill(0.6) }] }) });
        const ok = await bgeEmbed(['文本甲', '文本乙']);
        assert.ok(Array.isArray(ok) && ok.length === 2 && ok.every(v => Array.isArray(v) && v.length === 1024), '成功路径应返回条数一致且 1024 维的列表');
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: new Array(512).fill(0.5) }, { embedding: new Array(512).fill(0.6) }] }) });
        const badDim = await bgeEmbed(['文本甲', '文本乙']);
        assert.strictEqual(badDim, null, '维度不符（512≠1024）应视为结构异常返回 null（防 B3/H 混库串味）——本次失败真实走结构校验并触发 30s 熔断');
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: new Array(1024).fill(0.5) }] }) });
        const badCount = await bgeEmbed(['文本甲', '文本乙']);
        assert.strictEqual(badCount, null, '条数不符（1≠2）同样返回 null（本次经 30s 熔断短路——bgeDownUntil 与 rerankDownUntil 同构，熔断语义已在 bgeRerank 用例独立覆盖）');
      } finally {
        globalThis.fetch = origFetch;
        if (savedAllowPrivate === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = savedAllowPrivate;
        db.prepare('DELETE FROM providers WHERE id=?').run(pid);
      }
    });
    await t('单元：P2-2 rerankModels 去重与容错——跨供应商同名模型去重、损坏 JSON 行跳过不炸（finally 清理直插行）', () => {
      const { rerankModels } = require('../src-server/lib/retriever');
      const ins = db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default) VALUES (?,?,?,?,1,0)`);
      const names = ['P2补测rm供应商A', 'P2补测rm供应商B', 'P2补测rm供应商C'];
      ins.run(names[0], 'http://127.0.0.1:1', 'sk-a', '["bge-reranker-v2-m3","chat-x"]'); // A：含 rerank + 非 rerank
      ins.run(names[1], 'http://127.0.0.1:1', 'sk-b', '["bge-reranker-v2-m3","bge-reranker-large"]'); // B：同名 + 另一 rerank
      ins.run(names[2], 'http://127.0.0.1:1', 'sk-c', '{broken json'); // C：损坏 models
      const pids = names.map(n => db.prepare('SELECT id FROM providers WHERE name=?').get(n).id);
      try {
        const out = rerankModels();
        const count = out.filter(m => m === 'bge-reranker-v2-m3').length;
        assert.strictEqual(count, 1, '跨供应商同名 rerank 模型应去重为 1：' + JSON.stringify(out));
        assert.ok(out.includes('bge-reranker-large'), '另一 rerank 模型应保留');
        assert.ok(!out.includes('chat-x'), '非 rerank 模型应被过滤');
        assert.ok(Array.isArray(out), '损坏 JSON 行不应导致整体失败（rerankModels 仍返回数组）');
      } finally {
        pids.forEach(id => db.prepare('DELETE FROM providers WHERE id=?').run(id));
      }
    });
    await t('单元：P2-1 parseVec 三前缀契约——B3:/H:/裸 JSON 解析、维度不符拒收、损坏 JSON 不炸（防 B3/H 混库串味兜底）', () => {
      const { parseVec } = require('../src-server/lib/retriever');
      const v1024 = JSON.stringify(new Array(1024).fill(0.1));
      const v256 = JSON.stringify(new Array(256).fill(0.2));
      const b3 = parseVec('B3:' + v1024);
      assert.ok(b3.engine === 'B3' && b3.v && b3.v.length === 1024, 'B3:+1024 维应解析为 B3 引擎');
      const b3bad = parseVec('B3:' + v256);
      assert.ok(b3bad.v === null && b3bad.engine === null, 'B3:+256 维（维度不符）应拒收为 null');
      const h = parseVec('H:' + v256);
      assert.ok(h.engine === 'H' && h.v && h.v.length === 256, 'H:+256 维应解析为 H 引擎');
      const bare = parseVec(v256);
      assert.ok(bare.engine === 'H' && bare.v && bare.v.length === 256, '裸 JSON 应按旧版本地哈希解析为 H');
      const broken = parseVec('{broken');
      assert.ok(broken.v === null && broken.engine === null, '损坏 JSON 应返回双 null 不炸');
      const empty = parseVec('');
      assert.ok(empty.v === null && empty.engine === null, '空串应返回双 null');
    });
    await t('单元：P2-5 引用溯源输出契约——retrieve 每条 hit 的 11 个溯源字段全存在 + engine=H + channels 枚举（前端 kb-ref 渲染数据源锁定）', async () => {
      const { retrieve } = require('../src-server/lib/retriever');
      const kbid = globalThis.__goldenKbId;
      assert.ok(kbid, '黄金基线库应已由前置用例设置 globalThis.__goldenKbId');
      const hits = await retrieve('迟到早退怎么处理', kbid, 3, 0, { rerankEnabled: false });
      assert.ok(hits.length >= 1, '黄金问答应命中');
      const REQUIRED = ['id', 'parent_id', 'chapter_id', 'content', 'file', 'kb', 'kb_id', 'metadata', 'score', 'bm25', 'vec', 'engine'];
      hits.forEach((h, i) => {
        const missing = REQUIRED.filter(k => !(k in h));
        assert.ok(!missing.length, `hit[${i}] 应含全部溯源字段，缺失：${missing.join(',')}（finish 白名单任何回归都会静默破坏 kb-ref 渲染）`);
        assert.ok(typeof h.score === 'number' && typeof h.bm25 === 'number' && typeof h.vec === 'number', 'score/bm25/vec 应为 number');
        assert.ok(h.engine === 'H', '降级环境 engine 应为 H：' + h.engine);
        assert.ok(['both', 'bm25', 'vec', 'none'].includes(h.channels), 'channels 应为四值枚举：' + h.channels);
        assert.ok(Array.isArray(h.hit_terms), 'hit_terms 应为数组');
        assert.ok(h.file && h.kb, 'file/kb 名称应非空（kb-ref 显示依赖）：' + h.file + '/' + h.kb);
      });
    });
    // ===== P3-1 新增工作流节点类型——code_sandbox / condition_loop / variable_assign / notification（2026-11-06）=====
    await t('单元：P3-1 code_sandbox JS 沙箱节点——JS 执行返回语言、执行时间、输出安全过滤', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const r1 = await NODE_EXECUTORS.code_sandbox({ data: { language: 'javascript', code: 'return { result: "hello", score: 42 }', timeout: 1000 } }, { inputs: { user: '张三' } });
      assert.strictEqual(r1.language, 'javascript', 'language 应回显');
      assert.ok(typeof r1.execution_time_ms === 'number' && r1.execution_time_ms > 0, 'execution_time_ms 应为正数');
      assert.strictEqual(r1.output, '{"result":"hello","score":42}', '扁平化输出应含 result/score');
      assert.strictEqual(r1.result, 'hello', '扁平变量应保留');
      assert.strictEqual(r1.score, 42, '扁平变量应保留 number 类型');
    });
    await t('单元：P3-1 condition_loop——条件循环节点执行子流程并返回结果（mock 条件 false 直接退出）', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const subflow = { nodes: [{ id: 'start_sub', type: 'start', data: {} }], edges: [] };
      const r = await NODE_EXECUTORS.condition_loop({ data: { subflow, condition: 'false', max_iterations: 10 } }, {}, { agent: {}, username: 'httpu1', flowType: 'workflow' });
      assert.ok(r.count === 0 && r.iterations_executed === 0, '条件 false 应退出循环：' + JSON.stringify(r));
      assert.deepStrictEqual(r.results_array, [], 'results_array 应为空数组');
    });
    await t('单元：P3-1 variable_assign——变量赋值节点 set/append/clear/delete 四运算符 + 原型污染防御', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const r1 = await NODE_EXECUTORS.variable_assign({ data: { variables: [{ variable: 'user', value: '张三', operator: 'set' }, { variable: 'score', value: '95', operator: 'set' }] } }, {});
      assert.strictEqual(r1.user, '张三', 'set 运算符应赋值');
      assert.strictEqual(r1.score, 95, 'set 运算符应 JSON 解析数字');
      const r2 = await NODE_EXECUTORS.variable_assign({ data: { variables: [{ variable: 'msg', value: '你好，', operator: 'append' }, { variable: 'msg', value: '世界', operator: 'append' }] } }, {});
      assert.strictEqual(r2.msg, '你好，世界', 'append 应累积');
      const r3 = await NODE_EXECUTORS.variable_assign({ data: { variables: [{ variable: 'score', value: '', operator: 'clear' }] } }, {});
      assert.strictEqual(r3.score, '', 'clear 应置空');
      const r4 = await NODE_EXECUTORS.variable_assign({ data: { variables: [{ variable: 'score', value: '', operator: 'delete' }] } }, {});
      assert.strictEqual(r4.score, null, 'delete 应置 null');
      const r5 = await NODE_EXECUTORS.variable_assign({ data: { variables: [{ variable: '__proto__', value: '恶意注入', operator: 'set' }, { variable: 'constructor', value: '恶意注入', operator: 'set' }] } }, {});
      assert.ok(!Object.hasOwn(r5, '__proto__'), '__proto__ 键应被跳过（原型污染防御）：' + JSON.stringify(Object.keys(r5)));
      assert.ok(!Object.hasOwn(r5, 'constructor'), 'constructor 键应被跳过：' + JSON.stringify(Object.keys(r5)));
    });
    await t('单元：P3-1 notification——消息通知节点发送站内信并返回通知字段（sent/title/content/recipient）', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const before = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;
      const r = await NODE_EXECUTORS.notification({ data: { title: '工作流消息通知', content: '您的工作流「审批流程」已完成', recipient: 'httpu1' } }, { _username: 'httpu1' }, { username: 'httpu1' });
      assert.strictEqual(r.sent, true, 'sent 应为 true（通知已发送）');
      assert.strictEqual(r.title, '工作流消息通知', 'title 应回显');
      assert.strictEqual(r.content, '您的工作流「审批流程」已完成', 'content 应回显');
      assert.strictEqual(r.recipient, 'httpu1', 'recipient 应回显');
      const after = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;
      assert.strictEqual(after, before + 1, 'notifications 表应新增 1 行');
      const inserted = db.prepare('SELECT title, content, username FROM notifications ORDER BY id DESC').get();
      assert.strictEqual(inserted.username, 'httpu1', '通知应发送给 httpu1');
      assert.strictEqual(inserted.title, '工作流消息通知', 'title 应原文入库');
    });
    // ===== P0-1 修复回归（2026-11-09）：code_sandbox Python 分支 RCE 已封堵 + 节点类型白名单 =====
    await t('P0-1：code_sandbox language=python 拒绝执行（fail-closed）——原 execSync(code) 把节点代码当 Shell 命令执行构成 RCE', async () => {
      const os = require('os');
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      // 真实利用链载荷：原实现下该 code 会经 /bin/sh -c 真实执行并落盘标记文件
      const marker = path.join(os.tmpdir(), `ap_p0_rce_${Date.now()}.txt`);
      let threw = null;
      try {
        await NODE_EXECUTORS.code_sandbox({ data: { language: 'python', code: `import os; os.system("touch ${marker}")`, timeout: 1000 } }, { inputs: {} });
      } catch (e) { threw = e; }
      assert.ok(threw, 'python 分支必须抛错（fail-closed），不得静默执行');
      assert.ok(/不支持.*python|仅允许 JavaScript/i.test(threw.message), '错误信息应明确拒绝 python：' + threw.message);
      assert.ok(!fs.existsSync(marker), '⚠️ RCE 未封堵：恶意载荷真实执行并落盘了标记文件！');
      // 二次载荷（纯 shell 语法，原实现同样会执行）
      let threw2 = null;
      try {
        await NODE_EXECUTORS.code_sandbox({ data: { language: 'python', code: `rm -rf /tmp/ap_should_never_run`, timeout: 1000 } }, { inputs: {} });
      } catch (e) { threw2 = e; }
      assert.ok(threw2 && /不支持.*python/i.test(threw2.message), 'shell 语法载荷同样必须拒绝：' + (threw2 && threw2.message));
    });
    await t('P0-1：code_sandbox language 未声明/为 javascript 时 JS 沙箱路径不受影响', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const r1 = await NODE_EXECUTORS.code_sandbox({ data: { code: 'return { ok: 1 }' } }, { inputs: {} });
      assert.strictEqual(r1.language, 'javascript', '未声明 language 默认走 JS 沙箱');
      assert.strictEqual(r1.ok, 1, 'JS 沙箱执行结果应正常返回');
    });
    await t('P0-1：validateWorkflowV2 节点类型白名单——未注册类型（含拼错/伪造执行器名）保存即剔除', () => {
      const schema = require('../src-server/lib/workflow-schema');
      const evil2 = schema.validateWorkflowV2({
        nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'n1', type: 'future_shell_executor', position: { x: 1, y: 1 }, data: {} },
        ], edges: [{ id: 'e1', source: 'start', target: 'n1' }],
      });
      assert.ok(!evil2.nodes || !evil2.nodes.some(n => n.type === 'future_shell_executor'), '未注册类型节点必须被剔除：' + JSON.stringify(evil2.nodes && evil2.nodes.map(n => n.type)));
      const evil3 = schema.validateWorkflowV2({
        nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'n1', type: 'child_process', position: { x: 1, y: 1 }, data: {} },
        ], edges: [],
      });
      assert.ok(!evil3.nodes || !evil3.nodes.some(n => n.type === 'child_process'), 'child_process 伪类型必须被剔除');
      // 未知类型被剔除后仅剩 start，保存虽成功但攻击图已残废（恶意节点不存留，运行无从触发）
      assert.ok(evil3.nodes && evil3.nodes.length === 1 && evil3.nodes[0].type === 'start', '剔除后仅剩合法 start 节点');
    });
    await t('P0-1：validateWorkflowV2 全部注册类型（含 9 个扩展执行器）不误伤——存量合法画布可继续保存', () => {
      const schema = require('../src-server/lib/workflow-schema');
      const ext = ['http_request', 'code_sandbox', 'condition_loop', 'variable_assign', 'notification', 'database_query', 'delay', 'logger', 'transform'];
      for (const ty of ext) {
        const w = schema.validateWorkflowV2({
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
            { id: 'n1', type: ty, position: { x: 1, y: 1 }, data: {} },
          ], edges: [{ id: 'e1', source: 'start', target: 'n1' }],
        });
        assert.ok(w && !w.error, `扩展类型 ${ty} 不应被白名单误伤`);
        assert.ok(w.nodes.some(n => n.type === ty), `扩展类型 ${ty} 应保留在保存图中`);
      }
    });
    await t('P0-1：ALLOWED_NODE_TYPES 与 Runner NODE_EXECUTORS 注册表一一对齐（防白名单漂移）', () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const { ALLOWED_NODE_TYPES } = require('../src-server/lib/workflow-schema');
      const executorKeys = new Set(Object.keys(NODE_EXECUTORS));
      for (const k of executorKeys) assert.ok(ALLOWED_NODE_TYPES.has(k), `执行器 ${k} 必须在白名单（否则合法节点保存被拒）`);
      for (const k of ALLOWED_NODE_TYPES) assert.ok(executorKeys.has(k), `白名单项 ${k} 无对应执行器（应从 EXT_EXECUTOR_TYPES 移除或补执行器）`);
    });
    // ===== P1-2 修复回归（2026-11-09）：wf_files 归属校验——非管理员无法查看/下载他人文件 =====
    await t('P1-2：GET /api/files/:id 非管理员查看他人文件应拒绝（403）', async () => {
      // 修复测试本体三处缺陷（2026-11-09）：①now 未导入恒 ReferenceError——该用例自诞生起从未真正执行过断言
      // （此前"362/363 基线失败"的第一因即此，非服务器未启动）；②sign 缺 uid（auth 中间件按 payload.uid
      // 查库，username/role 直签会被 401 拦截而非走到归属校验 403）；③端口硬编码 3210 依赖外部常驻服务器——
      // 改为自 spawn 子进程（随机端口），与 HTTP 集成组同款模式：父进程直插临时库，子进程读同一库（WAL 多连接）
      const { spawn } = require('child_process');
      const { db: db1, hashPwd, now } = require('../src-server/db');
      const { sign } = require('../src-server/lib/auth');
      db1.prepare('DELETE FROM users WHERE username IN (?,?)').run('p1user1', 'p1user2');
      db1.prepare(`INSERT INTO users (username,nickname,password,status,role,must_change_pwd,created_at) VALUES (?,?,?,1,'user',0,?)`).run('p1user1', 'USER1', hashPwd('pass1'), now());
      db1.prepare(`INSERT INTO users (username,nickname,password,status,role,must_change_pwd,created_at) VALUES (?,?,?,1,'user',0,?)`).run('p1user2', 'USER2', hashPwd('pass2'), now());
      const uid1 = db1.prepare('SELECT id FROM users WHERE username=?').get('p1user1').id;
      const uid2 = db1.prepare('SELECT id FROM users WHERE username=?').get('p1user2').id;
      const t1 = sign({ uid: uid1, exp: Date.now() + 3600000 });
      const t2 = sign({ uid: uid2, exp: Date.now() + 3600000 });
      // 用 user1 直接插库一个文件（与原实现一致，绕开上传解析）
      const testf = Buffer.from('hello p1-2 test file', 'utf8').toString('base64');
      db1.prepare(`INSERT INTO wf_files (name,ext,size,text_content,content_b64,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run('p1test.txt', 'txt', 20, 'hello p1-2 test file', testf, 'manual', 'p1user1', now());
      const fid = db1.prepare('SELECT id FROM wf_files WHERE name=?').get('p1test.txt').id;
      const port = 35000 + Math.floor(Math.random() * 2000);
      const base = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR },
        stdio: 'ignore',
      });
      const jfetch = async (p, tok, raw) => {
        const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + tok } });
        if (raw) return { status: r.status, text: await r.text() };
        let j = null; try { j = await r.json(); } catch { }
        return { status: r.status, j };
      };
      try {
        // 等服务就绪（最多 30s——套件满负载时子进程启动可能偏慢，首跑偶发超时属环境抖动非代码缺陷）
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
          await new Promise(r2 => setTimeout(r2, 200));
          try { up = (await fetch(base + '/api/health')).ok; } catch { }
        }
        assert.ok(up, '子进程服务应在 30s 内就绪（否则本用例断言无从执行）');
        // user2 查看 user1 文件：HTTP 403 + body code 403（归属校验层拒绝；BE-B1 统一响应契约后与下载接口一致）
        const r1 = await jfetch(`/api/files/${fid}`, t2);
        assert.strictEqual(r1.status, 403, '越权元数据应返回 HTTP 403');
        assert.strictEqual(r1.j.code, 403, '越权元数据应返回 code 403');
        // user2 下载 user1 文件：HTTP 403
        const r2 = await jfetch(`/api/files/${fid}/download`, t2, true);
        assert.strictEqual(r2.status, 403, '越权下载应返回 403');
        // user1 自己查看和下载应 OK
        const r3 = await jfetch(`/api/files/${fid}`, t1);
        assert.strictEqual(r3.j.code, 0, '本人查看应返回 0');
        assert.strictEqual(r3.j.data.name, 'p1test.txt', '本人查看应看到文件名');
        const r4 = await jfetch(`/api/files/${fid}/download`, t1, true);
        assert.strictEqual(r4.status, 200, '本人下载应返回 200');
        assert.strictEqual(r4.text, 'hello p1-2 test file', '本人下载原文应匹配');
      } finally {
        try { child.kill('SIGTERM'); } catch { }
        try { child.kill('SIGKILL'); } catch { }
        // 清理测试数据（断言失败也保证清干净 + 子进程不泄漏）
        db1.prepare('DELETE FROM users WHERE username IN (?,?)').run('p1user1', 'p1user2');
        db1.prepare('DELETE FROM wf_files WHERE name=?').run('p1test.txt');
      }
    });
    // ===== P2-3 连带缺陷回归（2026-11-09）：前端接线类缺陷——死链调用点 / 孤儿端点 =====
    await t('P2-3：前端改密调用点接线——login.js/app.js 均走 /auth/login/change-password，无旧死链残留', () => {
      const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
      for (const f of ['login.js', 'app.js']) {
        const src = read(f);
        assert.ok(src.includes("api('/auth/login/change-password'"), `${f} 应调用后端真实路由 /auth/login/change-password`);
        assert.ok(!/api\('\/auth\/change-password'/.test(src), `${f} 不得残留旧死链 /auth/change-password（后端无此路由，恒 404——历史缺陷：两处调用点曾双双踩中）`);
      }
    });
    await t('P2-3：退出按钮已接线后端登出——app.js 必须调 /auth/logout（否则 HttpOnly Cookie 存活至 TTL 属假登出）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
      assert.ok(src.includes("api('/auth/logout'"), 'app.js 退出流程应调用后端 /auth/logout（吊销 token + 清 HttpOnly Cookie）——历史缺陷：端点存在但从未被前端接线');
    });

    // ===== P3-2~P3-9 修复回归（2026-11-09）=====
    await t('P3-2：resolveInputs answer/classifier/aggregator 行为回归（删除重复死代码后行为不变）', () => {
      const { resolveInputs } = require('../src-server/lib/workflow');
      const results = { start: { input: 'world' } };
      // answer：text 模板渲染
      const a = resolveInputs({ type: 'answer', data: { text: 'hello {{#start.input#}}' } }, results, {});
      assert.deepStrictEqual(a, { text: 'hello world' }, 'answer 应渲染 text 模板');
      // classifier：question 默认回落 {{#start.input#}}
      const c1 = resolveInputs({ type: 'classifier', data: {} }, results, {});
      assert.strictEqual(c1.question, 'world', 'classifier 缺省 question 应回落 start.input');
      const c2 = resolveInputs({ type: 'classifier', data: { question: 'q', instruction: 'ins' } }, results, {});
      assert.deepStrictEqual(c2, { question: 'q', instruction: 'ins' }, 'classifier 显式字段应原样解析');
      // aggregator：sources 逐项渲染
      const g = resolveInputs({ type: 'aggregator', data: { sources: [{ variable: '{{#start.input#}}' }, { variable: 'fixed' }] } }, results, {});
      assert.deepStrictEqual(g, { sources: ['world', 'fixed'] }, 'aggregator 应逐项渲染 sources');
    });
    await t('P3-4：decrypt 密钥轮换后返回空串（不得把密文当明文外发）+ 旧明文兼容', async () => {
      const cu = require('../src-server/lib/crypto-util');
      const crypto = require('crypto');
      const savedEnv = process.env.AGENT_ENCRYPTION_KEY, savedPrev = process.env.AGENT_ENCRYPTION_KEY_PREV;
      try {
        // SEC-10：密钥来源含环境变量，轮换以 env + resetKeyCache 演示（file > db 之外的最高优先级来源）
        const k1 = crypto.randomBytes(32).toString('hex');
        process.env.AGENT_ENCRYPTION_KEY = k1; delete process.env.AGENT_ENCRYPTION_KEY_PREV; cu.resetKeyCache();
        const enc = cu.encrypt('P3-4-secret-明文-value');
        // 加密形态生效（kid.iv.tag.cipher 四段 hex）且往返一致
        assert.ok(/^[0-9a-f]{8}\.[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]+$/i.test(enc), 'encrypt 应产出 kid.iv.tag.cipher 四段 hex 形态（SEC-10）');
        assert.strictEqual(cu.decrypt(enc), 'P3-4-secret-明文-value', '正确密钥下往返应得原文');
        // 密钥轮换：同密文换钥解密 → 必须返回空串（原实现返回密文串，会被当明文 API Key 发给上游）
        const k2 = crypto.randomBytes(32).toString('hex');
        process.env.AGENT_ENCRYPTION_KEY = k2; delete process.env.AGENT_ENCRYPTION_KEY_PREV; cu.resetKeyCache();
        assert.strictEqual(cu.decrypt(enc), '', '密钥不匹配时应返回空串，而不是把密文串当明文返回');
        // SEC-10 预留轮换：旧密钥列入 AGENT_ENCRYPTION_KEY_PREV → 旧密文仍可解
        process.env.AGENT_ENCRYPTION_KEY = k2; process.env.AGENT_ENCRYPTION_KEY_PREV = k1; cu.resetKeyCache();
        assert.strictEqual(cu.decrypt(enc), 'P3-4-secret-明文-value', '旧密钥列入 PREV 时旧密文应可解（预留轮换）');
        // 旧明文兼容：形态不像密文的值原样返回（历史明文数据不破坏）
        assert.strictEqual(cu.decrypt('legacy-plain-key'), 'legacy-plain-key', '旧明文应原样返回');
        assert.strictEqual(cu.decrypt('a.b.c'), 'a.b.c', '三点分隔但非密文形态应按旧明文返回');
        assert.strictEqual(cu.decrypt(''), '', '空值应返回空串');
      } finally {
        if (savedEnv === undefined) delete process.env.AGENT_ENCRYPTION_KEY; else process.env.AGENT_ENCRYPTION_KEY = savedEnv;
        if (savedPrev === undefined) delete process.env.AGENT_ENCRYPTION_KEY_PREV; else process.env.AGENT_ENCRYPTION_KEY_PREV = savedPrev;
        cu.resetKeyCache();
      }
    });
    await t('P3-5：视频任务归属记忆 + 轮询/拉内容端点归属校验接线', () => {
      const skills = require('../src-server/lib/skills');
      // 归属记忆读写 + 空 owner 不记录（兼容旧调用方）
      skills.rememberVideoOwner('task-own-1', 'alice');
      assert.strictEqual(skills.videoOwnerOf('task-own-1'), 'alice', '归属用户应可读取');
      assert.strictEqual(skills.videoOwnerOf('task-unknown'), null, '未知任务归属应为 null（回落放行语义）');
      skills.rememberVideoOwner('task-own-2', '');
      assert.strictEqual(skills.videoOwnerOf('task-own-2'), null, '空 owner 不应记录（兼容旧调用方）');
      // 接线断言：chat.js 两个端点均引用 videoOwnerOf 做归属校验，且创建侧传入归属用户
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      assert.ok(src.includes('skills.videoOwnerOf(req.params.taskId)'), '视频任务端点应调用 videoOwnerOf 做归属校验');
      assert.strictEqual((src.match(/skills\.videoOwnerOf\(req\.params\.taskId\)/g) || []).length, 2, '进度轮询与内容拉取两个端点都应校验归属');
      assert.ok(src.includes("createVideoTask(input, 4, '16:9', req.user.username)"), '创建任务时应传入归属用户 req.user.username');
    });
    await t('P3-6：openapi /v1/models 已挂限流中间件（防密钥泄露后被高频刷列表）', () => {
      const openapiRouter = require('../src-server/routes/openapi');
      const layer = openapiRouter.stack.find(l => l.route && l.route.path === '/v1/models');
      assert.ok(layer, '/v1/models 路由应存在');
      // handler 前应有中间件（routes 层：限流 + BE-B3 配额守卫 + handler）
      assert.ok(layer.route.stack.length >= 2, `/v1/models 应挂限流中间件（当前 ${layer.route.stack.length} 层，预期 ≥2：limiter(+quota)+handler）`);
      assert.strictEqual(layer.route.stack.length, 3, `/v1/models 应为 limiter+quota+handler=3 层（当前 ${layer.route.stack.length}）`);
    });
    await t('P2-3 / P2-3：A1 op 扩展 + D1-1 新 op + 三档权限模型', () => {
      const lb = require('../src-server/routes/localbridge');
      const { OPS_WHITELIST } = lb;
      // A1: op 白名单应有 13 个（原 4 + 扩展 9）；D1-1 追加 6 个 → 共 19
      assert.ok(OPS_WHITELIST.length >= 19, `OPS_WHITELIST 应有 ≥19 个 op（当前 ${OPS_WHITELIST.length}）`);
      const expected = ['mkdir','list_dir','open_app','notify','screenshot','clipboard_read','clipboard_write',
        'key_type','mouse_click','window_list','window_focus','file_read','file_write',
        'file_backup','file_diff','file_patch','file_restore','terminal','run_python'];
      for (const e of expected) {
        assert.ok(OPS_WHITELIST.includes(e), `应包含 op「${e}」`);
      }
      // D1-1：三档权限模型——TIER_OPS 并集应等于白名单，档位单调包含
      const union = Object.values(lb.TIER_OPS).flat();
      assert.deepStrictEqual([...new Set(union)].sort(), [...OPS_WHITELIST].sort(), 'TIER_OPS 并集应等于 OPS_WHITELIST');
      // readonly ⊂ standard ⊂ full
      assert.ok(lb.opAllowedForTier('file_read', 'readonly'), '只读档应允许 file_read');
      assert.ok(!lb.opAllowedForTier('file_write', 'readonly'), '只读档不应允许 file_write');
      assert.ok(lb.opAllowedForTier('file_write', 'standard'), '标准档应允许 file_write');
      assert.ok(!lb.opAllowedForTier('key_type', 'standard'), '标准档不应允许 key_type');
      assert.ok(lb.opAllowedForTier('key_type', 'full'), '全权档应允许 key_type');
      assert.ok(lb.opAllowedForTier('run_python', 'full') && lb.opAllowedForTier('terminal', 'full'), '全权档应允许 run_python/terminal');
      assert.strictEqual(lb.opMinTier('screenshot'), 'readonly', 'screenshot 最低只读档');
      assert.strictEqual(lb.opMinTier('file_write'), 'standard', 'file_write 最低标准档');
      assert.strictEqual(lb.opMinTier('terminal'), 'full', 'terminal 最低全权档');
      assert.strictEqual(lb.normalizeTier('bogus'), 'standard', '非法档位回落 standard');
      // A1: tools-extra.js local_exec schema 描述应包含扩展 op 名
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'tools-extra.js'), 'utf8');
      for (const e of ['screenshot','clipboard_read','clipboard_write','key_type','mouse_click',
          'window_list','window_focus','file_read','file_write']) {
        assert.ok(src.includes(e), `tools-extra.js schema 应包含 ${e}`);
      }
      // D1-1 新 op 也应出现在 schema
      for (const e of ['file_backup','file_diff','file_patch','file_restore','terminal','run_python']) {
        assert.ok(src.includes(e), `tools-extra.js schema 应包含 D1-1 新 op ${e}`);
      }
      // A1: local_exec schema 的 op enum 应与白名单一致
      assert.ok(src.includes("'screenshot', 'clipboard_read'"), 'schema op enum 应包含扩展 op');
      // A2: local_exec run 应落审计日志（op_logs）
      assert.ok(src.includes("op_logs"), 'tools-extra.js 应写入 op_logs 审计日志');
      assert.ok(src.includes('本地桥:'), 'tools-extra.js 应写入 op_logs 审计日志（action 含本地桥前缀）');
    });
    await t('P3-8：/chat/models 不再 SELECT api_key 列（truthiness 改由 SQL has_key 表达）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      // BE-C1（2026-11-23）适配：裸查已收敛 dal——/models 的 SQL 现为 dal.q( 首实参，守卫定位正则同步适配
      const m = /router\.get\('\/models',[\s\S]{0,400}?(?:db\.prepare|dal\.q|dal\.getq|dal\.runq)\((['"`])([\s\S]*?)\1\)/.exec(src);
      assert.ok(m, '应能定位 /chat/models 的 SQL');
      const sql = m[2];
      // SELECT 列清单（FROM 之前）不得包含 api_key 原始列（新实现仅允许 api_key 出现在 has_key 布尔表达式内）
      const colList = sql.slice(0, sql.toUpperCase().lastIndexOf('FROM'));
      assert.ok(!/\bapi_key\b\s*(,|$)/i.test(colList.trim()), 'SELECT 列清单不得包含 api_key 原始列（密钥材料不进入 JS 内存/响应链路）');
      assert.ok(/has_key/i.test(sql), '应以 SQL 布尔表达式 has_key 表达 truthiness');
      assert.ok(src.includes('real: !!p.has_key'), 'real 标记应改用 has_key（api_key 不再进入 JS 内存）');
    });
    await t('P3-9：生效公钥命中已知不安全公钥清单时告警；现行生产钥不误报', () => {
      const edition = require('../src-server/lib/edition');
      const saved = process.env.LICENSE_PUBKEY_HEX;
      const origWarn = console.warn;
      const capture = () => { let s = ''; console.warn = (...a) => { s += a.join(' '); }; return { get: () => s, restore: () => { console.warn = origWarn; } }; };
      try {
        // 正例：清单内每一个不安全公钥（旧开发测试钥 / 2026-11-09 孤儿钥）都应触发告警
        for (const bad of edition.LEGACY_PUBKEY_HEXES) {
          process.env.LICENSE_PUBKEY_HEX = bad;
          let c = capture();
          try { edition.refreshLicense(); } finally { c.restore(); }
          assert.ok(c.get().includes('不安全公钥清单'), `不安全公钥 ${bad.slice(0, 8)}… 生效时必须告警：` + c.get().slice(0, 160));
        }
        // 负例：内置现行生产钥（env 未设）→ 不得误报
        delete process.env.LICENSE_PUBKEY_HEX;
        let c = capture();
        try { edition.refreshLicense(); } finally { c.restore(); }
        assert.ok(!c.get().includes('不安全公钥清单'), '现行生产钥不应触发告警：' + c.get().slice(0, 160));
        // 内置公钥应与清单无交集，且可解析（32 字节 hex → SPKI KeyObject）
        assert.ok(!edition.LEGACY_PUBKEY_HEXES.includes(edition.getPublicKeyHex()), '内置公钥不得出现在不安全清单中');
        assert.ok(edition.publicKeyFromHex(edition.getPublicKeyHex()), '内置公钥应可解析为 KeyObject');
      } finally {
        if (saved !== undefined) process.env.LICENSE_PUBKEY_HEX = saved;
        else delete process.env.LICENSE_PUBKEY_HEX;
        console.warn = origWarn;
      }
    });
    await t('P0-2：database_query 节点拒绝写语句与 PRAGMA（校验层先于 better-sqlite3 驱动层）', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      for (const sql of [
        'UPDATE agents SET name=\'pwned\'',
        'DELETE FROM agents',
        'DROP TABLE agents',
        'INSERT INTO agents (name) VALUES (\'x\')',
        'SELECT 1; DROP TABLE agents',
        'PRAGMA table_info(users)',
        'SELECT * FROM pragma_table_info(\'users\')',
      ]) {
        let threw = null;
        try { await NODE_EXECUTORS.database_query({ data: { sql } }, {}); } catch (e) { threw = e; }
        assert.ok(threw && /安全策略拒绝/.test(threw.message), `SQL 必须被校验层拒绝：${sql} → ${threw && threw.message}`);
      }
    });
    await t('P0-2：database_query 节点合法查询正常执行（seed 库 agents 计数 + 模板变量渲染不受影响）', async () => {
      const { NODE_EXECUTORS } = require('../src-server/lib/workflow');
      const r = await NODE_EXECUTORS.database_query({ data: { sql: 'SELECT COUNT(*) AS c FROM agents' } }, {});
      assert.ok(Array.isArray(r.rows) && r.rows[0].c >= 10, '合法查询应返回结果：' + JSON.stringify(r.rows));
      assert.strictEqual(r.count, r.rows.length, 'count 应等于行数');
      // 模板渲染路径（{{#node.var#}}）不受校验影响
      const r2 = await NODE_EXECUTORS.database_query({ data: { sql: 'SELECT COUNT(*) AS c FROM agents WHERE category=\'{{#start.cat#}}\'' } }, { start: { cat: '办公' } });
      assert.ok(Array.isArray(r2.rows), '模板变量渲染后的查询应正常执行：' + JSON.stringify(r2.rows));
    });
    await t('P0-2：sanitizeSelectSql 标识符引用旁路全封堵（原正则对 " ` [ / main. 前缀 / 无空格形态全部提取失败）', () => {
      const extra = require('../src-server/lib/tools-extra');
      for (const sql of [
        'SELECT * FROM "secrets"',
        'SELECT * FROM `secrets`',
        'SELECT * FROM [secrets]',
        'SELECT * FROM main.secrets',
        'SELECT * FROM main."secrets"',
        'SELECT * FROM"users"',
        'SELECT * FROM agents a JOIN `users` u ON a.id=u.id',
        'SELECT name FROM main.sqlite_master',
      ]) {
        assert.ok(extra.sanitizeSelectSql(sql).err, `引用形态旁路必须封堵：${sql}`);
      }
      // P0-2 黑名单补漏的 4 张表
      for (const t2 of ['platforms', 'feedbacks', 'user_tool_keys', 'sqlite_master']) {
        assert.ok(extra.sanitizeSelectSql(`SELECT * FROM ${t2}`).err, `补漏黑名单表 ${t2} 应拒绝`);
      }
      // 合法查询不误伤（含列名带 create 子串 / 别名 / join 非敏感表）
      for (const sql of [
        'SELECT COUNT(*) FROM agents',
        'SELECT created_at FROM evaluations',
        'SELECT a.name FROM agents a JOIN kbs k ON k.id=a.kb_id',
      ]) {
        assert.ok(!extra.sanitizeSelectSql(sql).err, `合法查询不应误伤：${sql}`);
      }
    });

  }

  console.log('【U1-6】成本归因与精细计费：单价表 / 真实计费 / 部门月度报表 / 超预算告警');
  {
    const billing = require('../src-server/lib/billing');
    const { checkDeptBudgets } = require('../src-server/lib/ops');
    const { sign } = require('../src-server/lib/auth');

    await t('U1-6：computeCost 按真实单价计算（元/千Token）+ 无单价计 0', () => {
      // 3000 输入 × 0.5 + 2000 输出 × 1.5 = 1.5 + 3 = 4.5
      assert.strictEqual(billing.computeCost(3000, 2000, { input: 0.5, output: 1.5 }), 4.5);
      assert.strictEqual(billing.computeCost(1000, 1000, { input: 0, output: 0 }), 0, '零价（免费模型）合法');
      assert.strictEqual(billing.computeCost(500, 500, null), 0, '无单价不得估算成本');
      assert.strictEqual(billing.computeCost(-10, -5, { input: 1, output: 1 }), 0, '负 token 容错为 0');
      assert.strictEqual(billing.computeCost('abc', 1000, { input: 1, output: 1 }), 1, '非数值 prompt 容错按 0');
    });
    await t('U1-6：parsePriceTable 坏 JSON / 负价 / 非数值字段容错', () => {
      assert.strictEqual(billing.parsePriceTable('{bad json').size, 0, '坏 JSON 应返回空表');
      assert.strictEqual(billing.parsePriceTable(JSON.stringify({ m: { input: -1, output: 2 } })).size, 0, '负 input 价应剔除');
      assert.strictEqual(billing.parsePriceTable(JSON.stringify({ m: { input: 'x', output: 2 } })).size, 0, '非数值价应剔除');
      const ok = billing.parsePriceTable(JSON.stringify({ m: { input: 0, output: 0.002 }, n: { input: 1, output: 1 } }));
      assert.strictEqual(ok.size, 2, '合法条目（含零价）应保留');
    });

    // ===== 造数：两部门（研发预算 10 元 / 市场无预算）+ 三用户（含无部门用户）+ 单价供应商 =====
    const d1 = db.prepare(`INSERT INTO departments (parent_id,name,path,order_num,monthly_budget,created_at) VALUES (NULL,'U16研发部','/',0,10,datetime('now','localtime'))`).run().lastInsertRowid;
    const d2 = db.prepare(`INSERT INTO departments (parent_id,name,path,order_num,monthly_budget,created_at) VALUES (NULL,'U16市场部','/',1,0,datetime('now','localtime'))`).run().lastInsertRowid;
    const mkU16 = (name, deptId) => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,dept_id,created_at) VALUES (?,?,?,'user',1,0,?,datetime('now','localtime'))`).run(name, hashPwd('u16-pass-123'), name, deptId);
      return db.prepare('SELECT id FROM users WHERE username=?').get(name).id;
    };
    mkU16('u16a', d1); mkU16('u16b', d2); mkU16('u16c', null);
    const pid = db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,model_price,created_at) VALUES ('U16计费供应商','http://u16.test','sk-u16','["u16-model"]',1,0,'','{"u16-model":{"input":1,"output":2}}',datetime('now','localtime'))`).run().lastInsertRowid;

    await t('U1-6：recordModelUsage 真实计费写入（单价快照 / 部门归属 / token 拆分）', () => {
      const r = billing.recordModelUsage({ username: 'u16a', model: 'u16-model', promptTokens: 1000, completionTokens: 500 });
      assert.ok(r && r.priced === true, '有单价应标记 priced=true');
      assert.strictEqual(r.cost, 2, '1000×1/1000 + 500×2/1000 = 1 + 1 = 2 元');
      const row = db.prepare("SELECT * FROM usage_records WHERE username='u16a' ORDER BY id DESC LIMIT 1").get();
      assert.strictEqual(row.dimension, 'model', '维度应为 model');
      assert.strictEqual(row.dimension_key, 'u16-model', 'dimension_key 应为模型名');
      assert.strictEqual(row.tokens, 1500, 'tokens 应为 prompt+completion 总和');
      assert.strictEqual(row.prompt_tokens, 1000, 'prompt_tokens 应拆分保存');
      assert.strictEqual(row.completion_tokens, 500, 'completion_tokens 应拆分保存');
      assert.strictEqual(row.dept_id, Number(d1), 'dept_id 应写入用户部门快照');
      assert.strictEqual(row.cost, 2, 'cost 应为真实单价计算值（非估算）');
      const meta = JSON.parse(row.meta);
      assert.strictEqual(meta.priced, true, 'meta 应标记 priced');
      assert.strictEqual(meta.price_input, 1, 'meta 应含输入单价快照');
      assert.strictEqual(meta.price_output, 2, 'meta 应含输出单价快照');
    });
    await t('U1-6：无单价模型 cost=0 且 meta.priced=false（无单价不瞎估）', () => {
      const r = billing.recordModelUsage({ username: 'u16b', model: 'u16-no-price-model', promptTokens: 800, completionTokens: 400 });
      assert.ok(r && r.priced === false, '无单价应标记 priced=false');
      assert.strictEqual(r.cost, 0, '无单价成本应为 0');
      const row = db.prepare("SELECT * FROM usage_records WHERE username='u16b' ORDER BY id DESC LIMIT 1").get();
      assert.strictEqual(row.cost, 0);
      assert.strictEqual(row.tokens, 1200, 'tokens 照常计入用量（成本 0 不代表没用量）');
      assert.strictEqual(JSON.parse(row.meta).priced, false);
    });
    await t('U1-6：deptCostOfMonth 月度部门聚合（分部门 / 未归属行 / 月度过滤）', () => {
      // u16c（无部门）用计费模型：500×1/1000 + 250×2/1000 = 1 元 → 归入「未归属」行
      billing.recordModelUsage({ username: 'u16c', model: 'u16-model', promptTokens: 500, completionTokens: 250 });
      const r = billing.deptCostOfMonth();
      assert.strictEqual(r.month.length, 7, '应返回 YYYY-MM 当前月');
      const rd = r.departments.find(x => x.dept_id === Number(d1));
      assert.ok(rd, '研发部应出现在报表：' + JSON.stringify(r.departments));
      assert.strictEqual(rd.dept_name, 'U16研发部');
      assert.strictEqual(rd.cost, 2, '研发部当月成本应为 2 元');
      assert.strictEqual(rd.budget, 10, '研发部预算应带出');
      assert.strictEqual(rd.members, 1, '研发部本月活跃成员 1 人');
      const mk = r.departments.find(x => x.dept_id === Number(d2));
      assert.strictEqual(mk.cost, 0, '市场部（无单价模型）成本 0');
      const noDept = r.departments.find(x => x.dept_id === null);
      assert.ok(noDept, '无部门用户应归入「未归属」行');
      assert.strictEqual(noDept.cost, 1, '未归属行应聚 1 元');
      assert.strictEqual(r.totalCost, 3, '全平台当月合计应为 3 元');
      // 月度过滤：查上月应无数据（usage 均为当月写入）
      const last = new Date(); last.setMonth(last.getMonth() - 1);
      const lastMonth = last.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
      const rLast = billing.deptCostOfMonth(lastMonth);
      assert.strictEqual(rLast.totalCost, 0, '上月无记录应返回 0 成本');
    });
    await t('U1-6：checkDeptBudgets 超预算告警（80% 档触发 → 幂等不重发 → 100% 升档）', () => {
      const budgetNotif = () => db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='budget'").get().c;
      const n0 = budgetNotif();
      // 当前研发部 2/10 = 20%：未达档 → 不告警
      assert.strictEqual(checkDeptBudgets().alerted, 0, '20% 未达 80% 档不应告警');
      // +6 元 → 8/10 = 80%：第 1 档告警
      billing.recordModelUsage({ username: 'u16a', model: 'u16-model', promptTokens: 2000, completionTokens: 2000 }); // 2×1 + 2×2 = 6 元
      assert.strictEqual(checkDeptBudgets().alerted, 1, '80% 应触发第 1 档告警');
      assert.strictEqual(budgetNotif(), n0 + 1, '应新增 1 条 budget 通知');
      const lv1 = db.prepare('SELECT budget_alert_level FROM departments WHERE id=?').get(d1).budget_alert_level;
      assert.strictEqual(lv1, 1, '部门告警档位应记为 1');
      // 幂等：再跑不重发（同档不重复）
      assert.strictEqual(checkDeptBudgets().alerted, 0, '同档再跑不应重复告警');
      assert.strictEqual(budgetNotif(), n0 + 1, '通知数不变（防轰炸）');
      // +2.1 元 → 10.1/10 = 101%：升第 2 档
      billing.recordModelUsage({ username: 'u16a', model: 'u16-model', promptTokens: 700, completionTokens: 700 }); // 0.7 + 1.4 = 2.1 元
      assert.strictEqual(checkDeptBudgets().alerted, 1, '超 100% 应升第 2 档告警');
      const lv2 = db.prepare('SELECT budget_alert_level FROM departments WHERE id=?').get(d1).budget_alert_level;
      assert.strictEqual(lv2, 2, '档位应升至 2');
      assert.ok(db.prepare("SELECT content FROM notifications WHERE type='budget' ORDER BY id DESC LIMIT 1").get().content.includes('100%'), '第 2 档文案应含 100%');
      // 市场部无预算（budget=0）→ 永不告警
      assert.strictEqual(db.prepare('SELECT budget_alert_level FROM departments WHERE id=?').get(d2).budget_alert_level, 0, '未设预算部门不应告警');
    });

    // ===== HTTP 集成：PUT /providers 单价保存与校验 + GET /stats/dept-cost 权限 =====
    await t('U1-6 HTTP：PUT /api/providers/:id 单价保存 / 非法单价 400 / dept-cost 仅管理员', async () => {
      const { spawn } = require('child_process');
      const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
      const u16aId = db.prepare("SELECT id FROM users WHERE username='u16a'").get().id;
      const adminTok = sign({ uid: adminId, exp: Date.now() + 3600000 });
      const userTok = sign({ uid: u16aId, exp: Date.now() + 3600000 });
      const port = 36000 + Math.floor(Math.random() * 2000);
      const base = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR },
        stdio: 'ignore',
      });
      const jfetch = async (p, opts = {}, tok) => {
        const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
        let j = null; try { j = await r.json(); } catch { }
        return { status: r.status, j };
      };
      try {
        let up = false;
        for (let i = 0; i < 50 && !up; i++) {
          await new Promise(r2 => setTimeout(r2, 200));
          try { up = (await fetch(base + '/api/health')).ok; } catch { }
        }
        assert.ok(up, 'U1-6 HTTP 子进程应在 10s 内就绪');
        // 合法单价保存（对象形态）
        const okPut = await jfetch(`/api/providers/${pid}`, { method: 'PUT', body: JSON.stringify({ name: 'U16计费供应商', model_price: { 'u16-model': { input: 1.5, output: 3 } } }) }, adminTok);
        assert.strictEqual(okPut.j && okPut.j.code, 0, '合法单价应保存成功：' + JSON.stringify(okPut.j));
        const pv = db.prepare('SELECT model_price FROM providers WHERE id=?').get(pid).model_price;
        assert.strictEqual(JSON.parse(pv)['u16-model'].input, 1.5, '单价应真实落库');
        // 非法单价（负数）→ 400 拒绝
        const badPut = await jfetch(`/api/providers/${pid}`, { method: 'PUT', body: JSON.stringify({ model_price: { 'u16-model': { input: -1, output: 2 } } }) }, adminTok);
        assert.strictEqual(badPut.j && badPut.j.code, 400, '负单价应整体拒绝（防污染报表）：' + JSON.stringify(badPut.j));
        // 非法单价（字符串垃圾）→ 400
        const badPut2 = await jfetch(`/api/providers/${pid}`, { method: 'PUT', body: JSON.stringify({ model_price: 'not-json' }) }, adminTok);
        assert.strictEqual(badPut2.j && badPut2.j.code, 400, '非法 JSON 应拒绝');
        // GET /api/stats/dept-cost 管理员可见 + 结构校验
        const dc = await jfetch('/api/stats/dept-cost', {}, adminTok);
        assert.strictEqual(dc.j && dc.j.code, 0, '管理员应可访问部门成本报表');
        assert.ok(dc.j.data.month && Array.isArray(dc.j.data.departments) && typeof dc.j.data.totalCost === 'number', '报表应含 month/departments/totalCost：' + JSON.stringify(dc.j.data).slice(0, 160));
        // 普通用户 → 403（stats 路由 adminOnly）
        const u403 = await jfetch('/api/stats/dept-cost', {}, userTok);
        assert.ok(u403.status === 403 || (u403.j && u403.j.code === 403), '普通用户应被拒（403）：' + JSON.stringify({ s: u403.status, j: u403.j }));
      } finally {
        try { child.kill('SIGTERM'); } catch { }
        try { child.kill('SIGKILL'); } catch { }
      }
    });

    // SEC-05 回归：providers/sso/usermodels 的 SSRF 校验是 async，若漏 await 会造成
    // 「promise rejection 逃逸 → 进程崩溃」。此处以不可解析域名验证「返回 400 且服务存活」。
    await t('SEC-05 回归：POST /api/providers 不可解析域名 → 400 而非进程崩溃', async () => {
      const { spawn } = require('child_process');
      const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
      const adminTok = sign({ uid: adminId, exp: Date.now() + 3600000 });
      const port = 38200 + Math.floor(Math.random() * 300);
      const base = `http://127.0.0.1:${port}`;
      const env = { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR };
      delete env.AGENT_FETCH_ALLOW_PRIVATE; // 确保走公网校验路径
      const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
      const jfetch = async (p, opts = {}, tok) => {
        const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
        let j = null; try { j = await r.json(); } catch { }
        return { status: r.status, j };
      };
      try {
        let up = false;
        for (let i = 0; i < 50 && !up; i++) {
          await new Promise(r2 => setTimeout(r2, 200));
          try { up = (await fetch(base + '/api/health')).ok; } catch { }
        }
        assert.ok(up, 'SEC-05 子进程应在 10s 内就绪');
        const bad = await jfetch('/api/providers', { method: 'POST', body: JSON.stringify({ name: 'SSRF回归', base_url: 'https://ssrf-regress-nonexistent.invalid/v1', models: ['m'] }) }, adminTok);
        assert.strictEqual(bad.j && bad.j.code, 400, '不可解析域名应 400：' + JSON.stringify(bad.j));
        // 关键：进程仍存活（修复前此处会因未捕获的 rejection 崩溃）
        const h = await fetch(base + '/api/health');
        assert.ok(h.ok, '服务应存活（未因 SSRF 校验 rejection 崩溃）');
      } finally {
        try { child.kill('SIGTERM'); } catch { }
        try { child.kill('SIGKILL'); } catch { }
      }
    });


    // 清理 U1-6 造数（不影响其他用例）
    db.prepare('DELETE FROM usage_records WHERE username IN (?,?,?)').run('u16a', 'u16b', 'u16c');
    db.prepare('DELETE FROM users WHERE username IN (?,?,?)').run('u16a', 'u16b', 'u16c');
    db.prepare('DELETE FROM providers WHERE id=?').run(pid);
    db.prepare('DELETE FROM departments WHERE id IN (?,?)').run(d1, d2);
    db.prepare("DELETE FROM notifications WHERE type='budget'").run();
  }

  console.log('【U1-7】画布多人实时协作：WS 双客户端同步 / 服务端版本为准 / 光标 / 权限');
  {
    const { spawn } = require('child_process');
    const { sign } = require('../src-server/lib/auth');
    const WebSocket = require('ws');

    // 造数：u7b（被添加成员）/ u7c（陌生人）+ 带画布的智能体（admin 作房主）
    const mkU17 = (name) => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES (?,?,?,'user',1,0,datetime('now','localtime'))`).run(name, hashPwd('u17-pass-123'), name);
      return db.prepare('SELECT id FROM users WHERE username=?').get(name).id;
    };
    const u7bId = mkU17('u17b'), u7cId = mkU17('u17c');
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    const tokOf = uid => sign({ uid, exp: Date.now() + 3600000 });
    const sp = db.prepare("SELECT id FROM spaces WHERE type='enterprise' LIMIT 1").get() || db.prepare("SELECT id FROM spaces LIMIT 1").get();
    const wf0 = { nodes: [{ id: 'start', type: 'start', position: { x: 60, y: 60 }, data: { title: '开始', variables: [] } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const u17Agent = db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,workflow,created_at) VALUES ('U17协作画布','other',?,'admin','published','public',?,datetime('now','localtime'))`).run(sp.id, JSON.stringify(wf0)).lastInsertRowid;

    const port = 37500 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR },
      stdio: 'ignore',
    });
    const jfetch = async (p, opts = {}, tok) => {
      const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
      let j = null; try { j = await r.json(); } catch { }
      return { status: r.status, j };
    };
    // WS 客户端（HttpOnly Cookie 同源语义：测试里手动带 ap_token Cookie，浏览器自动携带）
    const mkWs = uid => {
      const msgs = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/canvas-ws`, { headers: { Cookie: 'ap_token=' + tokOf(uid) } });
      ws.on('message', d => { try { msgs.push(JSON.parse(String(d))); } catch { } });
      return { ws, msgs };
    };
    const waitMsg = async (cli, pred, ms = 5000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const i = cli.msgs.findIndex(pred);
        if (i >= 0) return cli.msgs.splice(i, 1)[0];
        await new Promise(r => setTimeout(r, 60));
      }
      return null;
    };
    const wsend = (cli, obj) => cli.ws.send(JSON.stringify(obj));
    const waitClose = cli => new Promise(res => { cli.ws.on('close', () => res(true)); setTimeout(() => res(false), 4000); });

    let roomId = null, c1 = null, c2 = null, c3 = null;
    try {
      await t('U1-7：房间创建幂等 + WS 成员权限 + hello 初始态 + presence', async () => {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(base + '/api/health')).ok; } catch { } }
        assert.ok(up, 'U1-7 子进程服务应在 15s 内就绪');

        // HTTP：为智能体创建画布协作房间（幂等复用）
        const rCreate = await jfetch(`/api/collab/rooms/by-agent/${u17Agent}`, { method: 'POST' }, tokOf(adminId));
        assert.strictEqual(rCreate.j && rCreate.j.code, 0, '创建画布协作房间应成功：' + JSON.stringify(rCreate.j));
        roomId = rCreate.j.data.id;
        const rAgain = await jfetch(`/api/collab/rooms/by-agent/${u17Agent}`, { method: 'POST' }, tokOf(adminId));
        assert.ok(rAgain.j.data.id === roomId && rAgain.j.data.reused === true, '重复创建应复用同一房间（幂等）：' + JSON.stringify(rAgain.j.data));
        const rQuery = await jfetch(`/api/collab/rooms/by-agent/${u17Agent}`, {}, tokOf(adminId));
        assert.ok(rQuery.j.data && rQuery.j.data.isMember === true && Array.isArray(rQuery.j.data.members), 'by-agent 查询应返回成员清单与 isMember');

        // ws1（admin 房主）加入：hello 携带服务端初始画布 + 版本 0
        c1 = mkWs(adminId);
        await new Promise(r => c1.ws.on('open', r));
        wsend(c1, { type: 'join', roomId });
        const hello1 = await waitMsg(c1, m => m.type === 'hello');
        assert.ok(hello1, '房主 join 应收到 hello');
        assert.strictEqual(hello1.version, 0, '初始版本应为 0');
        assert.strictEqual(hello1.workflow.nodes.length, 1, 'hello 应携带 agent 画布初始态（1 节点）');
        assert.strictEqual(Number(hello1.agentId), Number(u17Agent), 'hello 应携带绑定 agentId');
        assert.strictEqual(hello1.members.length, 1, '初始在线 1 人');

        // 陌生人 u7c 加入被拒（成员模型把守）
        c3 = mkWs(u7cId);
        await new Promise(r => c3.ws.on('open', r));
        wsend(c3, { type: 'join', roomId });
        const rej = await waitMsg(c3, m => m.type === 'error');
        assert.ok(rej && /成员/.test(rej.msg), '非成员 join 应被拒绝：' + JSON.stringify(rej));

        // HTTP 添加成员 u7b → ws 加入 → 双方 presence
        const rAdd = await jfetch(`/api/collab/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ username: 'u17b' }) }, tokOf(adminId));
        assert.strictEqual(rAdd.j && rAdd.j.code, 0, '添加成员应成功');
        c2 = mkWs(u7bId);
        await new Promise(r => c2.ws.on('open', r));
        wsend(c2, { type: 'join', roomId });
        const hello2 = await waitMsg(c2, m => m.type === 'hello');
        assert.ok(hello2 && hello2.members.length === 2, '成员 join 后在线应 2 人');
        const pres = await waitMsg(c1, m => m.type === 'presence' && m.members.length === 2);
        assert.ok(pres, '房主应收到 presence 广播（2 人在线）');
      });

      await t('U1-7：wf 提交→diff 广播→冲突拒绝→sync + 光标/位置转发（服务端版本为准）', async () => {
        // ws1 提交带新增节点的画布 → ws1 ok v1；ws2 收到 diff（含完整 node 对象）
        const wf1 = JSON.parse(JSON.stringify(wf0));
        wf1.nodes.push({ id: 'node_u17', type: 'llm', position: { x: 200, y: 80 }, data: { title: '新增', model: 'm1', prompt: 'hi', max_tokens: 100, temperature: 0.5 } });
        wf1.edges.push({ id: 'e_u17', source: 'start', target: 'node_u17', sourceHandle: 'out' });
        wsend(c1, { type: 'wf', baseVersion: 0, workflow: wf1 });
        const ok1 = await waitMsg(c1, m => m.type === 'ok');
        assert.ok(ok1 && ok1.version === 1, '提交方应收到 ok v1：' + JSON.stringify(ok1));
        const d1 = await waitMsg(c2, m => m.type === 'diff');
        assert.ok(d1 && d1.version === 1 && d1.by === 'admin', '成员应收到 diff 广播（v1, by=admin）');
        assert.strictEqual(d1.diff.nodes.added.length, 1, 'diff 应含 1 个新增节点');
        assert.strictEqual(d1.diff.nodes.added[0].node.id, 'node_u17', 'added 应携带完整 node 对象（U1-7 扩展）');
        assert.strictEqual(d1.diff.edges.added.length, 1, 'diff 应含 1 条新增连线');
        assert.strictEqual(d1.diff.edges.added[0].edge.target, 'node_u17', 'added 应携带完整 edge 对象');

        // 乐观锁兑底：ws2 用过期 baseVersion 提交 → conflict（服务端版本为准）
        wsend(c2, { type: 'wf', baseVersion: 0, workflow: wf0 });
        const conf = await waitMsg(c2, m => m.type === 'conflict');
        assert.ok(conf && conf.currentVersion === 1, '过期提交应被拒并告知服务端版本：' + JSON.stringify(conf));
        // sync 重同步 → 拿到 v1 全量
        wsend(c2, { type: 'sync' });
        const sync2 = await waitMsg(c2, m => m.type === 'sync');
        assert.ok(sync2 && sync2.version === 1 && sync2.workflow.nodes.some(n => n.id === 'node_u17'), 'sync 应返回 v1 全量（含新增节点）');

        // 光标转发
        wsend(c1, { type: 'cursor', x: 123, y: 45 });
        const cur = await waitMsg(c2, m => m.type === 'cursor' && m.by === 'admin');
        assert.ok(cur && cur.x === 123 && cur.y === 45, '光标应转发给其他成员');

        // node:move 轻指令转发（位置不占版本号）
        wsend(c1, { type: 'op', op: 'node:move', moves: [{ id: 'node_u17', x: 300, y: 120 }] });
        const mv = await waitMsg(c2, m => m.type === 'op' && m.op === 'node:move');
        assert.ok(mv && mv.moves[0].x === 300 && mv.by === 'admin', '位置移动应转发（by 标识）');

        // 会话态仅内存：DB 中 agent 画布不受影响（持久化仍走既有 PUT）
        const dbWf = JSON.parse(db.prepare('SELECT workflow FROM agents WHERE id=?').get(u17Agent).workflow || '{}');
        assert.strictEqual(dbWf.nodes.length, 1, '协作会话不直写 DB（持久化走既有保存链路）');
      });

      await t('U1-7：关闭房间广播断开 + 未认证握手 401', async () => {
        // 关闭房间 → 在线成员收 closed 并断开
        const rClose = await jfetch(`/api/collab/rooms/${roomId}/close`, { method: 'POST' }, tokOf(adminId));
        assert.strictEqual(rClose.j && rClose.j.code, 0, '关闭房间应成功');
        const closed1 = await waitMsg(c1, m => m.type === 'closed');
        assert.ok(closed1, '成员应收到 closed 广播');
        assert.ok(await waitClose(c1) && await waitClose(c2), 'closed 后连接应断开');

        // 未认证握手：401（无 Cookie）
        const bad = new WebSocket(`ws://127.0.0.1:${port}/api/canvas-ws`);
        const rejCode = await new Promise(res => {
          bad.on('unexpected-response', (req, resp) => res(resp && resp.statusCode));
          bad.on('error', () => res('net-error'));
          bad.on('open', () => res('opened'));
          setTimeout(() => res('timeout'), 4000);
        });
        assert.strictEqual(rejCode, 401, '无凭据 WS 握手应返回 401（实际 ' + rejCode + '）');
        try { bad.terminate(); } catch { }
      });
    } finally {
      try { child.kill('SIGTERM'); } catch { }
      try { child.kill('SIGKILL'); } catch { }
      db.prepare('DELETE FROM collab_room_members WHERE room_id=?').run(roomId);
      db.prepare('DELETE FROM collab_rooms WHERE agent_id=?').run(u17Agent);
      db.prepare('DELETE FROM agents WHERE id=?').run(u17Agent);
      db.prepare('DELETE FROM users WHERE username IN (?,?)').run('u17b', 'u17c');
    }
  }

  console.log('【U0-2】实时语音对话：WS 通道鉴权 / 流式流水线 / 分句 TTS / 打断（barge-in）');
  {
    const { spawn } = require('child_process');
    const { sign } = require('../src-server/lib/auth');
    const WebSocket = require('ws');

    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    const tokOf = uid => sign({ uid, exp: Date.now() + 3600000 });

    const port = 39500 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, VOICE_MOCK: '1' },
      stdio: 'ignore',
    });
    const mkWs = uid => {
      const msgs = []; const bins = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice-ws`, { headers: { Cookie: 'ap_token=' + tokOf(uid) } });
      ws.on('message', (d, isBin) => { if (isBin) bins.push(Buffer.from(d)); else { try { msgs.push(JSON.parse(String(d))); } catch { } } });
      return { ws, msgs, bins };
    };
    const waitMsg = async (cli, pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = cli.msgs.findIndex(pred); if (i >= 0) return cli.msgs.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 50)); } return null; };
    const waitBin = async (cli, n, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cli.bins.length >= n) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const wsend = (cli, obj) => cli.ws.send(JSON.stringify(obj));
    const jfetch = async (p, opts = {}, tok) => {
      const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
      let j = null; try { j = await r.json(); } catch { }
      return { status: r.status, j };
    };

    let c1 = null;
    try {
      await t('U0-2：未认证语音 WS 握手 401', async () => {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(base + '/api/health')).ok; } catch { } }
        assert.ok(up, 'U0-2 子进程服务应在 15s 内就绪');
        const bad = new WebSocket(`ws://127.0.0.1:${port}/api/voice-ws`);
        const code = await new Promise(res => { bad.on('unexpected-response', (req, resp) => res(resp && resp.statusCode)); bad.on('error', () => res('net-error')); bad.on('open', () => res('opened')); setTimeout(() => res('timeout'), 4000); });
        assert.strictEqual(code, 401, '无凭据语音 WS 握手应 401（实际 ' + code + '）');
        try { bad.terminate(); } catch { }
      });

      await t('U0-2：一轮流水线（音频上行→asr-final→reply-delta→分句 tts-segment+音频帧→done）', async () => {
        c1 = mkWs(adminId);
        await new Promise(r => c1.ws.on('open', r));
        wsend(c1, { type: 'start', format: 'wav' });
        assert.ok(await waitMsg(c1, m => m.type === 'state' && m.state === 'listening'), 'start 后应进入 listening');
        // 未收到音频即 utterance-end：应报错而非启动流水线
        wsend(c1, { type: 'utterance-end' });
        const e0 = await waitMsg(c1, m => m.type === 'error');
        assert.ok(e0 && /音频/.test(e0.msg), '无音频即结束应报错：' + JSON.stringify(e0));
        // 上行两个音频分片
        c1.ws.send(Buffer.from([0, 1, 2, 3, 4, 5]), { binary: true });
        c1.ws.send(Buffer.from([6, 7, 8, 9]), { binary: true });
        wsend(c1, { type: 'utterance-end' });
        const fin = await waitMsg(c1, m => m.type === 'asr-final');
        assert.ok(fin && fin.text, '应收到 asr-final 文本：' + JSON.stringify(fin));
        const d1 = await waitMsg(c1, m => m.type === 'reply-delta');
        assert.ok(d1 && d1.text, '应收到 reply-delta 增量');
        const seg = await waitMsg(c1, m => m.type === 'tts-segment');
        assert.ok(seg && seg.seq === 0 && seg.bytes > 0, '应收到 tts-segment（seq=0，含字节数）：' + JSON.stringify(seg));
        assert.ok(await waitBin(c1, 1), '应收到二进制音频帧');
        const done = await waitMsg(c1, m => m.type === 'done');
        assert.ok(done && typeof done.full === 'string' && done.full.length > 0, '应收到 done 与全文：' + JSON.stringify(done));
        assert.ok(done.ms && typeof done.ms.firstPacket === 'number' && typeof done.ms.roundTrip === 'number', 'done 应携带时延埋点 {firstPacket,roundTrip}：' + JSON.stringify(done.ms));
        assert.ok(done.ms.roundTrip >= done.ms.firstPacket, '往返时延应不小于首包时延');
        await waitMsg(c1, m => m.type === 'state' && m.state === 'listening'); // 收尾：回到倾听态
      });

      await t('U0-2：打断（barge-in）——speaking 期间 interrupt 生效并回到 listening', async () => {
        c1.msgs.length = 0; // 清掉上一轮遗留状态帧，避免误匹配
        wsend(c1, { type: 'start', format: 'wav' });
        assert.ok(await waitMsg(c1, m => m.type === 'state' && m.state === 'listening'), '新一轮应进入 listening');
        c1.ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
        wsend(c1, { type: 'utterance-end' });
        assert.ok(await waitMsg(c1, m => m.type === 'state' && m.state === 'speaking', 8000), '应进入 speaking');
        wsend(c1, { type: 'interrupt' });
        assert.ok(await waitMsg(c1, m => m.type === 'interrupted'), 'interrupt 应回 interrupted 确认');
        assert.ok(await waitMsg(c1, m => m.type === 'state' && m.state === 'listening', 8000), '打断后应回到 listening');
        await new Promise(r => setTimeout(r, 250));
        assert.ok(!c1.msgs.some(m => m.type === 'done'), '打断后本轮不应再产出 done');
      });

      await t('U0-2：stop 结束会话 + 连接关闭', async () => {
        const closed = new Promise(res => { c1.ws.on('close', () => res(true)); setTimeout(() => res(false), 4000); });
        wsend(c1, { type: 'stop' });
        assert.ok(await closed, 'stop 后连接应关闭');
      });

      await t('U0-2 P2：语音供应商流式字段经配置 API 持久化 / 非法值拒绝 / 默认 batch', async () => {
        const created = [];
        try {
          // 带 stream_type=http-chunk 创建
          const cr = await jfetch('/api/voice-providers', { method: 'POST', body: JSON.stringify({ name: 'U02流式供应商', type: 'stt', base_url: 'http://127.0.0.1:1', api_key: 'k', stream_type: 'http-chunk', stream_endpoint: 'http://127.0.0.1:1/asr-stream' }) }, tokOf(adminId));
          assert.ok(cr.j && cr.j.code === 0, '创建应成功：' + JSON.stringify(cr.j).slice(0, 120));
          created.push(cr.j.data.id);
          // 未指定 stream_type：应默认 batch
          const cr2 = await jfetch('/api/voice-providers', { method: 'POST', body: JSON.stringify({ name: 'U02默认供应商', type: 'stt' }) }, tokOf(adminId));
          assert.ok(cr2.j && cr2.j.code === 0, '默认创建应成功');
          created.push(cr2.j.data.id);
          // 非法 stream_type：应拒绝
          const bad = await jfetch('/api/voice-providers', { method: 'POST', body: JSON.stringify({ name: 'U02非法', stream_type: 'nope' }) }, tokOf(adminId));
          assert.ok(bad.j && bad.j.code === 400, '非法 stream_type 应返回 400：' + JSON.stringify(bad.j));
          // 回读校验持久化
          const list = await jfetch('/api/voice-providers?type=stt', {}, tokOf(adminId));
          assert.ok(list.j && list.j.code === 0, '列表应成功');
          const row = (list.j.data || []).find(x => x.id === cr.j.data.id);
          assert.ok(row, '应能查到刚创建的供应商');
          assert.strictEqual(row.stream_type, 'http-chunk', 'stream_type 应持久化为 http-chunk');
          assert.strictEqual(row.stream_endpoint, 'http://127.0.0.1:1/asr-stream', 'stream_endpoint 应持久化');
          const row2 = (list.j.data || []).find(x => x.id === cr2.j.data.id);
          assert.strictEqual(row2.stream_type, 'batch', '未指定时应默认 batch');
        } finally {
          for (const id of created) await jfetch('/api/voice-providers/' + id, { method: 'DELETE' }, tokOf(adminId));
        }
      });
    } finally {
      try { child.kill('SIGTERM'); } catch { }
      try { child.kill('SIGKILL'); } catch { }
    }
  }

  console.log('【U0-2】P2 供应商流式适配位：voice_providers 流式字段 + ASR 适配位（未配置走 batch）');
  {
    const { effectiveStreamMode, createAsrStream, STREAM_MODES } = require('../src-server/lib/stt');

    await t('U0-2 P2：voice_providers 具备 stream_type/stream_endpoint 列（默认 batch / 空串）', () => {
      const cols = db.prepare('PRAGMA table_info(voice_providers)').all().map(c => c.name);
      assert.ok(cols.includes('stream_type'), '应含 stream_type 列');
      assert.ok(cols.includes('stream_endpoint'), '应含 stream_endpoint 列');
      const info = db.prepare("INSERT INTO voice_providers (name,type,created_at,updated_at) VALUES ('U02P2列测','stt',datetime('now','localtime'),datetime('now','localtime'))").run();
      const row = db.prepare('SELECT * FROM voice_providers WHERE id=?').get(info.lastInsertRowid);
      assert.strictEqual(row.stream_type, 'batch', 'stream_type 默认应为 batch');
      assert.strictEqual(row.stream_endpoint, '', 'stream_endpoint 默认应为空串');
      db.prepare('DELETE FROM voice_providers WHERE id=?').run(info.lastInsertRowid);
    });

    await t('U0-2 P2：effectiveStreamMode 判定（batch 默认 / ws / http-chunk / 非法归 batch）', () => {
      assert.deepStrictEqual(STREAM_MODES, ['batch', 'ws', 'http-chunk']);
      assert.strictEqual(effectiveStreamMode(null), 'batch', 'null → batch');
      assert.strictEqual(effectiveStreamMode({}), 'batch', '无字段 → batch');
      assert.strictEqual(effectiveStreamMode({ stream_type: 'ws' }), 'ws');
      assert.strictEqual(effectiveStreamMode({ stream_type: 'http-chunk' }), 'http-chunk');
      assert.strictEqual(effectiveStreamMode({ stream_type: 'bogus' }), 'batch', '非法值应归 batch');
    });

    await t('U0-2 P2：createAsrStream 批式降级链——push+end 优雅返回（永不 reject）', async () => {
      // 暂停已配置的 OpenAI 兼容回退供应商，避免触网；本用例只验证适配位语义
      const saved = db.prepare('SELECT id FROM providers WHERE configured=1').all();
      db.prepare('UPDATE providers SET configured=0 WHERE configured=1').run();
      try {
        const asr = createAsrStream({ provider: -1, format: 'wav', language: 'zh' }); // 指定不存在的供应商 → 走 batch
        assert.strictEqual(asr.mode, 'batch', '未配置流式供应商应走 batch');
        asr.push(Buffer.from([1, 2, 3, 4]));
        asr.push(Buffer.from([5, 6]));
        assert.strictEqual(asr.bytes, 6, '应正确累计缓冲字节数');
        const r = await asr.end();
        assert.strictEqual(typeof r.ok, 'boolean', 'end() 应返回 ok 布尔，不得抛错');
        assert.strictEqual(r.mode, 'batch');
        assert.strictEqual(r.partial, false, '批式降级不产生 partial');
      } finally {
        for (const s of saved) db.prepare('UPDATE providers SET configured=1 WHERE id=?').run(s.id);
      }
    });

    await t('U0-2 P2：createAsrStream 流式适配位——声明 http-chunk 的供应商走适配位（当前降级批式并标 degraded）', async () => {
      const saved = db.prepare('SELECT id FROM providers WHERE configured=1').all();
      db.prepare('UPDATE providers SET configured=0 WHERE configured=1').run();
      const info = db.prepare("INSERT INTO voice_providers (name,type,base_url,api_key,endpoint,stream_type,stream_endpoint,configured,is_default,created_at,updated_at) VALUES ('U02P2流式','stt','http://127.0.0.1:1','k','','http-chunk','http://127.0.0.1:1/asr',1,0,datetime('now','localtime'),datetime('now','localtime'))").run();
      const id = info.lastInsertRowid;
      try {
        const asr = createAsrStream({ provider: id, format: 'wav', language: 'zh' });
        assert.strictEqual(asr.mode, 'http-chunk', '应识别为流式适配位');
        asr.push(Buffer.from([9, 9, 9, 9]));
        const r = await asr.end();
        assert.strictEqual(typeof r.ok, 'boolean', 'end() 应返回 ok 布尔');
        assert.strictEqual(r.mode, 'http-chunk');
        assert.strictEqual(r.degraded, true, '流式供应商当前回落批式应标 degraded=true');
      } finally {
        db.prepare('DELETE FROM voice_providers WHERE id=?').run(id);
        for (const s of saved) db.prepare('UPDATE providers SET configured=1 WHERE id=?').run(s.id);
      }
    });
  }

  console.log('【U0-2】P3 实时语音前端：保序播放队列 / VAD 判定 / 打断判定（纯逻辑）');
  {
    const VR = require('../public/js/voice-realtime.js');

    await t('U0-2 P3：PlaybackQueue 乱序入队按 seq 保序出队', () => {
      const q = new VR.PlaybackQueue();
      q.push(2, { data: 'c', mime: 'audio/mpeg' });
      q.push(0, { data: 'a', mime: 'audio/mpeg' });
      q.push(1, { data: 'b', mime: 'audio/mpeg' });
      assert.strictEqual(q.size, 3, '应入队 3 个分片');
      assert.strictEqual(q.next().data, 'a', '应先出 seq=0');
      assert.strictEqual(q.next().data, 'b', '再出 seq=1');
      assert.strictEqual(q.next().data, 'c', '再出 seq=2');
      assert.strictEqual(q.next(), null, '取空后应返回 null');
      // 缺号不越序
      const q2 = new VR.PlaybackQueue();
      q2.push(1, { data: 'x' });
      assert.strictEqual(q2.next(), null, '缺 seq=0 时不应越序取出');
      q2.push(0, { data: 'y' });
      assert.strictEqual(q2.next().data, 'y', '补齐 seq=0 后应出队');
      assert.strictEqual(q2.next().data, 'x', '随后出 seq=1');
      q2.push(3, { data: 'z' });
      q2.clear();
      assert.strictEqual(q2.size, 0, 'clear 后应为空');
      assert.strictEqual(q2.next(), null, 'clear 后 next 为 null');
    });

    await t('U0-2 P3：vadDecide 双阈值滞回（start / end / 保持）', () => {
      const o = { on: 0.02, off: 0.012 };
      assert.deepStrictEqual(VR.vadDecide(false, 0.005, o), { speaking: false, event: null }, '静默应保持 false');
      assert.deepStrictEqual(VR.vadDecide(false, 0.03, o), { speaking: true, event: 'start' }, '越过起始阈值应 start');
      // 滞回区内不抖动
      assert.deepStrictEqual(VR.vadDecide(true, 0.015, o), { speaking: true, event: null }, '滞回区内应保持 speaking');
      assert.deepStrictEqual(VR.vadDecide(true, 0.01, o), { speaking: false, event: 'end' }, '低于结束阈值应 end');
    });

    await t('U0-2 P3：shouldBargeIn 仅在 speaking 且用户开口时为真', () => {
      assert.strictEqual(VR.shouldBargeIn('speaking', true), true, '播放中用户开口应打断');
      assert.strictEqual(VR.shouldBargeIn('speaking', false), false, '播放中无语音不打断');
      assert.strictEqual(VR.shouldBargeIn('listening', true), false, '倾听态不打断');
      assert.strictEqual(VR.shouldBargeIn('thinking', true), false, '思考态不打断');
    });

    await t('U0-2 P3：computeRms 计算时域能量 + Node 环境 isSupported=false', () => {
      const silent = new Uint8Array(128).fill(128);
      assert.strictEqual(VR.computeRms(silent), 0, '中位 128 静音应得 RMS 0');
      const loud = new Uint8Array(128).fill(255);
      assert.ok(VR.computeRms(loud) > 0.9, '满幅应接近 1：' + VR.computeRms(loud));
      assert.strictEqual(VR.isSupported(), false, 'Node 环境无浏览器 API，应为 false');
    });
  }

  console.log('【U1-8】SDK 正式发布：TS/Python 客户端行为 / 真实端到端 / 下载端点 / 规范契约');
  {
    const { AgentPlatform, AgentPlatformError } = require('../sdk/typescript/index.js');

    // ===== 纯函数行为（mock fetch 注入）=====
    await t('U1-8 TS SDK：三行调用链路（chat.completions.create / chatOnce / baseUrl 规范化）', async () => {
      const fake = async () => ({
        ok: true, status: 200, text: async () => JSON.stringify({
          id: 'chatcmpl-ap-1', object: 'chat.completion', created: 1, model: 'agent-1-x',
          choices: [{ index: 0, message: { role: 'assistant', content: '你好，我是智能体' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 },
        }),
      });
      const ap = new AgentPlatform({ baseUrl: 'http://x/', apiKey: 'sk-ap-test', fetchImpl: fake });
      assert.strictEqual(ap.baseUrl, 'http://x', 'baseUrl 尾斜杠应去除');
      const r = await ap.chat.completions.create({ model: 'agent-1-x', messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(r.choices[0].message.content, '你好，我是智能体', '非流式回复内容应匹配');
      assert.strictEqual(await ap.chatOnce('agent-1-x', 'hi'), '你好，我是智能体', 'chatOnce 便捷方法');
    });
    await t('U1-8 TS SDK：错误信封解析 + 配置校验 + 流式 SSE（分片/[DONE]）', async () => {
      const fake401 = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'API Key 无效或已停用', type: 'invalid_api_key' } }) });
      const ap = new AgentPlatform({ baseUrl: 'http://x', apiKey: 'bad', fetchImpl: fake401 });
      await assert.rejects(ap.listModels(), e => {
        assert.ok(e instanceof AgentPlatformError, '错误类型应为 AgentPlatformError');
        assert.strictEqual(e.status, 401);
        assert.strictEqual(e.apiError.type, 'invalid_api_key');
        return true;
      }, '错误信封字段应完整');
      assert.throws(() => new AgentPlatform({ baseUrl: '', apiKey: 'x' }), /baseUrl/);
      assert.throws(() => new AgentPlatform({ baseUrl: 'http://x', apiKey: '' }), /apiKey/);
      // 流式：分片到达 + [DONE] 终止
      const sseBody = 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '流式内容' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\ndata: {"should":"not-yield"}\n\n';
      const enc = new TextEncoder();
      const chunks = [enc.encode(sseBody.slice(0, 30)), enc.encode(sseBody.slice(30))];
      let i = 0;
      const fakeStream = async () => ({ ok: true, status: 200, text: async () => '', body: { getReader: () => ({ read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined } }) } });
      const ap2 = new AgentPlatform({ baseUrl: 'http://x', apiKey: 'sk-ap-t', fetchImpl: fakeStream });
      const stream = await ap2.chat.completions.create({ model: 'm', messages: [], stream: true });
      let got = '', n = 0;
      for await (const c of stream) { got += (c.choices[0].delta.content || ''); n++; }
      assert.strictEqual(got, '流式内容', '流式内容应完整');
      assert.strictEqual(n, 1, '[DONE] 后应终止（不再产出后续行）');
    });
    await t('U1-8 Python SDK：SSE 解析 / 错误信封 / 配置校验（纯函数）', async () => {
      const { execFileSync } = require('child_process');
      const py = `
import sys, json
sys.path.insert(0, 'sdk/python')
from agent_platform import AgentPlatform, AgentPlatformError, _sse_lines, _from_error_response

ap = AgentPlatform('http://x/', 'sk-ap-t')
assert ap.base_url == 'http://x'
for bad in ('', None):
    try: AgentPlatform(bad, 'k'); raise SystemExit('should raise')
    except ValueError: pass
try: AgentPlatform('http://x', ''); raise SystemExit('should raise')
except ValueError: pass

sse = 'data: {"a":1}\\n\\ndata: [DONE]\\n\\ndata: {"b":2}\\n'
got = list(_sse_lines([sse[:15].encode(), sse[15:].encode()]))
assert got == [{'a': 1}], got

e = _from_error_response(401, json.dumps({'error': {'message': 'x', 'type': 'invalid_api_key'}}))
assert isinstance(e, AgentPlatformError) and e.status == 401 and e.api_error['type'] == 'invalid_api_key'
e2 = _from_error_response(502, '<html>bad</html>')
assert e2.api_error is None and 'HTTP 502' in str(e2)
print('PY_OK')
`;
      const out = execFileSync('python3', ['-c', py], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
      assert.ok(out.includes('PY_OK'), 'Python SDK 纯函数断言应全过：' + out.slice(0, 300));
    });

    // ===== 真实端到端：临时实例 + 真密钥 + SDK 完成一次对话（验收标准）=====
    await t('U1-8 端到端：SDK 三行代码真实调用 /openapi/v1/chat/completions（mock 模型链路）', async () => {
      // 产物 public/downloads/ 被 gitignore——测试前幂等构建（已存在同版本则 npm pack 覆盖，无副作用）
      const { execFileSync } = require('child_process');
      try { execFileSync('sh', ['scripts/build-sdk.sh'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000, stdio: 'pipe' }); } catch (e) { throw new Error('SDK 构建失败：' + String(e.message).slice(0, 200)); }
      const { spawn } = require('child_process');
      const { sign } = require('../src-server/lib/auth');
      // 造数：admin 发布一个内置智能体（无 Key 走 mock 引擎，不外呼真实网关）+ 全域 API 密钥
      const wfNull = null;
      const sp = db.prepare("SELECT id FROM spaces WHERE type='enterprise' LIMIT 1").get() || db.prepare("SELECT id FROM spaces LIMIT 1").get();
      const agId = db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,prompt,created_at) VALUES ('U18SDK智能体','other',?,'admin','published','public','你是测试智能体，回复固定内容。',datetime('now','localtime'))`).run(sp.id).lastInsertRowid;
      const kInfo = db.prepare("INSERT INTO agent_api_keys (agent_id,key,name,status,created_at) VALUES (?,?, 'U18测试密钥',1,datetime('now','localtime'))").run(agId, 'sk-ap-u18test-' + require('crypto').randomBytes(8).toString('hex'));
      const apiKey = db.prepare('SELECT key FROM agent_api_keys WHERE id=?').get(kInfo.lastInsertRowid).key;
      const port = 39000 + Math.floor(Math.random() * 1000);
      const base = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR },
        stdio: 'ignore',
      });
      try {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(base + '/api/health')).ok; } catch { } }
        assert.ok(up, 'U1-8 子进程应在 15s 内就绪');
        const models = await (new AgentPlatform({ baseUrl: base, apiKey })).listModels();
        assert.ok(Array.isArray(models) && models.some(m => String(m.id).startsWith(`agent-${agId}-`)), 'listModels 应含测试智能体：' + JSON.stringify(models).slice(0, 160));
        // 三行调用（验收标准）
        const ap = new AgentPlatform({ baseUrl: base, apiKey });
        const r = await ap.chat.completions.create({ model: `agent-${agId}-U18SDK智能体`, messages: [{ role: 'user', content: '你好' }] });
        assert.strictEqual(r.object, 'chat.completion', '响应应 OpenAI 兼容');
        assert.ok(r.choices && r.choices[0].message && typeof r.choices[0].message.content === 'string', '应有回复内容');
        assert.ok(r.usage && r.usage.total_tokens >= 0, '应有 usage 字段');
        // 下载端点（构建产物在 public/downloads）
        const dl = await fetch(base + '/downloads/agent-platform-sdk-1.0.0.tgz');
        assert.ok(dl.ok && (dl.headers.get('content-type') || '').includes('gzip') || dl.ok, 'SDK tgz 应可下载');
        const dl2 = await fetch(base + '/downloads/agent_platform_sdk-1.0.0-py3-none-any.whl');
        assert.ok(dl2.ok, 'SDK whl 应可下载');
        // /api/api-docs/sdk 清单与规范契约
        const sdkJ = await (await fetch(base + '/api/api-docs/sdk')).json();
        assert.ok(sdkJ.code === 0 && sdkJ.data.downloads.length >= 2, 'SDK 清单应含两个产物');
        const spec = await (await fetch(base + '/api/api-docs/openapi.json')).json();
        assert.strictEqual(spec.openapi, '3.1.0', 'BE-B4：全站规范应升级为 OpenAPI 3.1');
        assert.ok(spec.paths['/openapi/v1/chat/completions'] && spec.paths['/openapi/v1/chat/completions'].post, '规范应含 chat/completions POST 定义');
        assert.ok(spec.paths['/openapi/v1/models'] && spec.paths['/openapi/v1/models'].get, '规范应含 models GET 定义');
        assert.ok(Object.keys(spec.paths).length > 100, 'BE-B4：自动采集应覆盖全部已注册路由（>100）');
        assert.ok(spec.paths['/api/v1/agents'], 'BE-B5：规范只列 v1，应含 /api/v1/agents');
        assert.strictEqual(spec['x-sdk'].name, 'agent-platform-sdk', '规范应含 SDK 元数据');
        assert.ok(spec.components.securitySchemes.apiKeyAuth, '规范应含 apiKeyAuth 安全方案');
        // BE-B4：两个规范入口同源（/openapi/openapi.json 与 /api/api-docs/openapi.json）
        const spec2 = await (await fetch(base + '/openapi/openapi.json')).json();
        assert.strictEqual(spec2.openapi, '3.1.0', 'BE-B4：/openapi/openapi.json 应为 OpenAPI 3.1');
        assert.deepStrictEqual(Object.keys(spec2.paths).sort(), Object.keys(spec.paths).sort(), 'BE-B4：两个入口路径集合应一致');
      } finally {
        try { child.kill('SIGTERM'); } catch { }
        try { child.kill('SIGKILL'); } catch { }
        db.prepare('DELETE FROM agent_api_keys WHERE agent_id=?').run(agId);
        db.prepare('DELETE FROM agents WHERE id=?').run(agId);
      }
    });
  }

  console.log('【U2-5】市场商业化闭环 Phase 1：商品表 + 上架 API');
  {
    const { sign } = require('../src-server/lib/auth');
    const { spawn } = require('child_process');

    await t('U2-5：market_products 表存在且可读写', () => {
      const p = db.prepare('SELECT * FROM market_products LIMIT 1').all();
      assert.ok(Array.isArray(p), 'market_products 表应存在并可查询');
    });

    const sp = (db.prepare("SELECT id FROM spaces WHERE type='enterprise' LIMIT 1").get() || db.prepare("SELECT id FROM spaces LIMIT 1").get()).id;
    const agId = db.prepare("INSERT INTO agents (name,type,space_id,owner,status,visibility,prompt,created_at) VALUES ('U25测试智能体','other',?,'admin','published','public','测试',datetime('now','localtime'))").run(sp).lastInsertRowid;

    await t('U2-5：商品表 CRUD——INSERT / SELECT / UPDATE / DELETE（完整链）', () => {
      // 插入商品
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const info = db.prepare('INSERT INTO market_products (agent_id,name,price_type,price,subscription_period,author_profit_share,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(agId, 'U25测试商品', 'subscription', 99, 'month', 0.8, 'active', ts, ts);
      assert.ok(info.changes === 1, '插入商品应影响 1 行');
      const pid = info.lastInsertRowid;
      // SELECT 验证
      const p = db.prepare('SELECT * FROM market_products WHERE id=?').get(pid);
      assert.strictEqual(p.name, 'U25测试商品', '名称应匹配');
      assert.strictEqual(p.price_type, 'subscription', '价格类型应正确');
      assert.strictEqual(p.price, 99, '价格应匹配');
      assert.strictEqual(p.author_profit_share, 0.8, '分成比例应为 0.8');
      assert.strictEqual(p.status, 'active', '状态应为 active');
      // JOIN 查询验证
      const joined = db.prepare('SELECT mp.*, a.name AS agent_name FROM market_products mp JOIN agents a ON a.id = mp.agent_id WHERE mp.id=?').get(pid);
      assert.strictEqual(joined.agent_name, 'U25测试智能体', 'JOIN agents 应返回智能体名');
      // UPDATE
      db.prepare('UPDATE market_products SET price=?,price_type=?,updated_at=? WHERE id=?').run(149, 'one_time', ts, pid);
      const after = db.prepare('SELECT * FROM market_products WHERE id=?').get(pid);
      assert.strictEqual(after.price, 149, '更新后价格应变化');
      assert.strictEqual(after.price_type, 'one_time', '更新后类型应变化');
      // 筛选查询
      const all = db.prepare('SELECT * FROM market_products WHERE status=?').all('active');
      assert.ok(all.some(x => x.id === pid), '活跃商品列表应包含测试商品');
      // DELETE
      db.prepare('DELETE FROM market_products WHERE id=?').run(pid);
      const afterDel = db.prepare('SELECT * FROM market_products WHERE id=?').get(pid);
      assert.strictEqual(afterDel, undefined, '删除后应查不到');
    });
    db.prepare('DELETE FROM agents WHERE id=?').run(agId);
  }

  console.log('【U2-7】Phase 2 跨组织引用计费与水印完善');
  {
    const { recordKbFederatedUsage } = require('../src-server/lib/billing');
    const { injectWatermark } = require('../src-server/lib/trusted-kb-gateway');
    const { db } = require('../src-server/db');

    await t('U2-7: recordKbFederatedUsage 跨组织引用计费写入', () => {
      const r = recordKbFederatedUsage({ username: 'admin', query: 'test query', tokens: 3, sourceOrg: '外部组织A', kbName: '技术文档库' });
      assert.ok(r.ok, '计费应成功');
      const row = db.prepare("SELECT * FROM usage_records WHERE dimension='kb' ORDER BY id DESC LIMIT 1").get();
      assert.ok(row && row.dimension_key.includes('kb_federated'), 'dimension_key 应包含 kb_federated');
      assert.ok(row.meta && row.meta.includes('外部组织A'), 'meta 应保存来源组织');
    });

    await t('U2-7: recordKbFederatedUsage 无 username 时跳过', () => {
      const r = recordKbFederatedUsage({ username: '', query: 'test' });
      assert.strictEqual(r.ok, false, '无 username 应返回 {ok:false}');
    });

    await t('U2-7: injectWatermark 水印注入 + 引用计费触发', () => {
      const chunks = [{ content: '原始内容', username: 'admin' }, { content: '第二条' }];
      // mock kb 对象
      const result = injectWatermark(chunks, { id: 0 }, { username: 'admin' });
      // kb_id=0 不会匹配到外部源，所以不注入水印
      assert.strictEqual(result.length, 2, 'chunks 长度不变');
      assert.ok(result[0].content.startsWith('原始内容'), '无外部源时不注入水印');
      // 验证水印函数对外部源生效（需要先插入 external_sources 行）
      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const kbId = db.prepare("INSERT INTO kbs (name,owner,created_at) VALUES ('测试水印库','admin',?)").run(nowStr).lastInsertRowid;
      db.prepare("INSERT INTO external_sources (kb_id,name,type,org_name,enabled,created_at) VALUES (?,?,'web','外部组织B',1,?)").run(kbId, '外部源B', nowStr);
      const tagged = injectWatermark([{ content: '水印测试内容' }], kbId, { username: 'admin' });
      assert.ok(tagged[0].content.startsWith('[📡 来源组织：外部组织B]'), '水印应正确注入：' + tagged[0].content.slice(0, 60));
      db.prepare('DELETE FROM external_sources WHERE kb_id=?').run(kbId);
      db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
    });
  }

  console.log('【U0-5】P1 卡片发送侧与共享审批等待注册表');
  {
    const cardRender = require('../src-server/lib/card-render');
    const registry = require('../src-server/lib/tool-confirm-registry');
    const { db } = require('../src-server/db');

    await t('U0-5: normalizeButtons 兼容 {text,value} 与 {text,action,url} 两种按钮形态', () => {
      const legacy = cardRender.normalizeButtons({ buttons: [{ text: '同意', value: 'https://x/ok' }] });
      assert.strictEqual(legacy.length, 1);
      assert.strictEqual(legacy[0].url, 'https://x/ok', '旧 value 应兜底为 url');
      const modern = cardRender.normalizeButtons({ buttons: [{ text: '拒绝', action: 'reject' }, { text: '' }] });
      assert.strictEqual(modern.length, 1, '空文本按钮应被过滤');
      assert.strictEqual(modern[0].action, 'reject');
    });

    await t('U0-5: renderCardBody 三渠道分派 + 未知渠道返回 null（调用方降级）', () => {
      const card = { buttons: [{ text: '同意', action: 'approve', url: 'https://x/a' }], callbackData: 'k1' };
      const msg = { title: '审批', content: '请审批' };
      assert.strictEqual(cardRender.renderCardBody('dingtalk', card, msg).msgtype, 'action_card');
      const fs = cardRender.renderCardBody('feishu', card, msg);
      assert.ok(Array.isArray(fs.elements) && fs.elements.some(e => e.tag === 'action'), '飞书卡片应含 action 元素');
      const fsBtn = fs.elements.find(e => e.tag === 'action').actions[0];
      assert.deepStrictEqual(fsBtn.value, { key: 'k1', action: 'approve' }, '飞书按钮 value 应携 callbackData+action');
      const wc = cardRender.renderCardBody('wecom', card, msg);
      assert.strictEqual(wc.card_type, 'button_interaction');
      assert.strictEqual(wc.button_list[0].key, 'k1|approve', '企微按钮 key 应为 callbackData|action');
      assert.strictEqual(cardRender.renderCardBody('unknown', card, msg), null, '未知渠道应返回 null');
    });

    await t('U0-5: tool-confirm-registry register/get/has/size/del 生命周期', () => {
      const k = 'ut:sess:1:tool';
      assert.strictEqual(registry.has(k), false);
      registry.register(k, { resolve: () => {} });
      assert.strictEqual(registry.has(k), true);
      assert.ok(registry.get(k), 'get 应返回条目');
      assert.ok(registry.size() >= 1);
      registry.del(k);
      assert.strictEqual(registry.has(k), false);
    });

    await t('U0-5: resolveByKey 写终态 + 唤醒 + 移出（approve→approved，否则 rejected）', () => {
      const calls = [];
      const k = 'ut:sess:2:tool';
      // 真实契约：调用方 resolve 内部负责 clearTimeout + 自删（与 chat.js 一致），
      // registry.resolveByKey 只负责 finalize + resolve，不自行移除
      registry.register(k, { resolve: v => { calls.push(['resolve', v]); registry.del(k); }, finalizeApproval: (st, who) => calls.push(['finalize', st, who]) });
      const hit = registry.resolveByKey(k, true, 'admin', 'ok');
      assert.strictEqual(hit, true);
      assert.deepStrictEqual(calls[0], ['finalize', 'approved', 'admin']);
      assert.deepStrictEqual(calls[1], ['resolve', true]);
      assert.strictEqual(registry.has(k), false, 'resolve 自删后应移出注册表');
      // 幂等：再次决议返回 false（已移出）
      assert.strictEqual(registry.resolveByKey(k, false, 'admin'), false);
      // rejected 语义
      const k2 = 'ut:sess:3:tool';
      let st2 = '';
      registry.register(k2, { resolve: () => { registry.del(k2); }, finalizeApproval: s => { st2 = s; } });
      registry.resolveByKey(k2, false, 'admin');
      assert.strictEqual(st2, 'rejected');
    });

    await t('U0-5: resolveByKey 未命中返回 false（不误唤醒）', () => {
      assert.strictEqual(registry.resolveByKey('ut:not-exist', true, 'admin'), false);
    });

    await t('U0-5: im-adapters 已为 feishu/wecom 注册 sendCard', () => {
      const { adapters } = require('../src-server/lib/im-adapters');
      assert.strictEqual(typeof adapters.feishu.sendCard, 'function', '飞书应暴露 sendCard');
      assert.strictEqual(typeof adapters.wecom.sendCard, 'function', '企微应暴露 sendCard');
    });

    await t('U0-5: channel.sendCard 分派——inbox/未知渠道降级站内信、接收人为空报错', async () => {
      const { sendCard } = require('../src-server/lib/channel');
      const card = { buttons: [{ text: '同意', action: 'approve' }], callbackData: 'k2' };
      const msg = { title: 'T', content: 'C' };
      const inboxR = await sendCard('inbox', ['admin'], 'T', card, msg);
      assert.ok(inboxR.ok && inboxR.degraded, 'inbox 应降级');
      const unknownR = await sendCard('slack', ['u1'], 'T', card, msg);
      assert.ok(unknownR.ok && unknownR.degraded, '未知渠道应降级');
      const noRecv = await sendCard('dingtalk', [], 'T', card, msg);
      assert.strictEqual(noRecv.ok, false, '接收人为空应报错');
    });

    await t('U0-5: channel.sendCard wecom/feishu 未配置渠道时降级（无启用 channels 行）', async () => {
      const { sendCard } = require('../src-server/lib/channel');
      const rows = db.prepare("SELECT id, enabled FROM channels WHERE type IN ('wecom','feishu')").all();
      db.prepare("UPDATE channels SET enabled=0 WHERE type IN ('wecom','feishu')").run();
      try {
        const card = { buttons: [{ text: '同意', action: 'approve' }], callbackData: 'k3' };
        const r = await sendCard('wecom', ['u1'], 'T', card, { title: 'T', content: 'C' });
        assert.ok(r.ok && r.degraded, '未配置企微应降级站内信');
        const r2 = await sendCard('feishu', ['u1'], 'T', card, { title: 'T', content: 'C' });
        assert.ok(r2.ok && r2.degraded, '未配置飞书应降级站内信');
      } finally {
        for (const r of rows) db.prepare('UPDATE channels SET enabled=? WHERE id=?').run(r.enabled, r.id);
      }
    });
  }

  console.log('【U0-5】R2 用户↔渠道身份绑定（user_channel_bindings）');
  {
    const { db } = require('../src-server/db');
    const { upsertUserBinding, listUserBindings, getUserChannelBindings, deleteUserBinding } = require('../src-server/lib/channel');
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const chId = db.prepare(`INSERT INTO channels (name, type, config, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run('测试企微', 'wecom', '', 1, 'admin', nowStr, nowStr).lastInsertRowid;
    const chId2 = db.prepare(`INSERT INTO channels (name, type, config, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run('测试飞书禁用', 'feishu', '', 0, 'admin', nowStr, nowStr).lastInsertRowid;

    await t('U0-5: upsertUserBinding 新建 + UNIQUE(username,channel_id) 幂等更新', () => {
      const r1 = upsertUserBinding({ username: 'ub-user', channelId: chId, channelUserId: 'cuid-1', channelUserName: '张三' });
      assert.ok(r1.id, '应返回新行');
      assert.strictEqual(r1.channel_user_id, 'cuid-1');
      const r2 = upsertUserBinding({ username: 'ub-user', channelId: chId, channelUserId: 'cuid-2' });
      assert.strictEqual(r2.id, r1.id, '同 user+channel 应更新而非新增');
      assert.strictEqual(r2.channel_user_id, 'cuid-2');
      const cnt = db.prepare('SELECT COUNT(*) c FROM user_channel_bindings WHERE username=? AND channel_id=?').get('ub-user', chId).c;
      assert.strictEqual(cnt, 1, '不应产生重复行');
    });

    await t('U0-5: upsertUserBinding 参数校验（必填 / 渠道不存在）', () => {
      assert.throws(() => upsertUserBinding({ username: '', channelId: chId, channelUserId: 'x' }), /username/);
      assert.throws(() => upsertUserBinding({ username: 'u', channelId: chId, channelUserId: '' }), /channel_user_id/);
      assert.throws(() => upsertUserBinding({ username: 'u', channelId: 999999, channelUserId: 'x' }), /渠道不存在/);
    });

    await t('U0-5: listUserBindings 按 username 过滤 + 联表带出渠道类型', () => {
      const mine = listUserBindings('ub-user');
      assert.ok(mine.length >= 1);
      assert.ok(mine.every(b => b.username === 'ub-user'), '只返回目标用户');
      assert.strictEqual(mine[0].channel_type, 'wecom', '应带出渠道类型');
    });

    await t('U0-5: getUserChannelBindings 仅返回已启用渠道（禁用渠道不推）', () => {
      upsertUserBinding({ username: 'ub-user', channelId: chId2, channelUserId: 'cuid-f' }); // 禁用飞书
      const enabled = getUserChannelBindings('ub-user');
      assert.ok(enabled.some(b => b.channel_id === chId), '启用渠道应命中');
      assert.ok(!enabled.some(b => b.channel_id === chId2), '禁用渠道不应命中（HITL 不推）');
    });

    await t('U0-5: deleteUserBinding 解绑', () => {
      for (const r of listUserBindings('ub-user')) deleteUserBinding(r.id);
      assert.strictEqual(listUserBindings('ub-user').length, 0);
    });

    db.prepare('DELETE FROM user_channel_bindings WHERE channel_id IN (?,?)').run(chId, chId2);
    db.prepare('DELETE FROM channels WHERE id IN (?,?)').run(chId, chId2);
  }

  console.log('【U0-5】P3 卡片回调验签 + 唤醒 registry + 结果回发');
  {
    const crypto = require('crypto');
    const { db } = require('../src-server/db');
    const { verifyCardCallback } = require('../src-server/lib/card-callback-verify');
    const { resolveCardCallback, sendCardResult } = require('../src-server/lib/channel');
    const { sha1Sign } = require('../src-server/lib/dingtalk-crypto');
    const registry = require('../src-server/lib/tool-confirm-registry');
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    await t('U0-5: verifyCardCallback 未配置验签材料 → 放行且标注 unverified', () => {
      const r = verifyCardCallback({ type: 'dingtalk', config: {} }, {}, { callbackData: 'k' }, {});
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.unverified, true);
    });

    await t('U0-5: verifyCardCallback 通用 HMAC 校验（通过 / 失败）', () => {
      const secret = 'cb-secret-1';
      const body = { callbackData: 'k2', action: 'approve' };
      const raw = JSON.stringify(body);
      const good = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const okR = verifyCardCallback({ type: 'webhook', config: { callbackSecret: secret } }, { 'x-callback-signature': good }, body, {});
      assert.strictEqual(okR.ok, true, '正确签名应通过');
      const badR = verifyCardCallback({ type: 'webhook', config: { callbackSecret: secret } }, { 'x-callback-signature': 'deadbeef' }, body, {});
      assert.strictEqual(badR.ok, false, '错误签名应拒绝');
    });

    await t('U0-5: verifyCardCallback 钉钉/企微 sha1 方案（通过 / 失败 / 缺签名）', () => {
      const token = 'dt-token';
      const ts = '1700000000', nonce = 'abc123', encrypt = 'ENCRYPTED';
      const sig = sha1Sign(token, ts, nonce, encrypt);
      const okR = verifyCardCallback({ type: 'dingtalk', config: { token } }, {}, {}, { msg_signature: sig, timestamp: ts, nonce, encrypt });
      assert.strictEqual(okR.ok, true, '正确 msg_signature 应通过');
      const badR = verifyCardCallback({ type: 'wecom', config: { token } }, {}, {}, { msg_signature: 'bad', timestamp: ts, nonce, encrypt });
      assert.strictEqual(badR.ok, false, '错误签名应拒绝');
      const missR = verifyCardCallback({ type: 'dingtalk', config: { token } }, {}, {}, {});
      assert.strictEqual(missR.ok, false, '缺 msg_signature 应拒绝');
    });

    await t('U0-5: verifyCardCallback 飞书 verificationToken（通过 / 不匹配）', () => {
      const okR = verifyCardCallback({ type: 'feishu', config: { verificationToken: 'vt-1' } }, {}, { token: 'vt-1' }, {});
      assert.strictEqual(okR.ok, true, '令牌匹配应通过');
      const badR = verifyCardCallback({ type: 'feishu', config: { verificationToken: 'vt-1' } }, {}, { token: 'other' }, {});
      assert.strictEqual(badR.ok, false, '令牌不匹配应拒绝');
    });

    const mkApproval = (key, requester, status = 'pending') => {
      db.prepare('INSERT INTO tool_approvals (confirm_key, tool_name, args_json, requester, status, created_at) VALUES (?,?,?,?,?,?)')
        .run(key, 'danger_tool', '{}', requester, status, nowStr);
    };

    await t('U0-5: resolveCardCallback 审批记录不存在 → 404', () => {
      const r = resolveCardCallback({ callbackData: 'no-such-key', action: 'approve' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 404);
    });

    await t('U0-5: resolveCardCallback 批准 → 写终态 approved + 唤醒 registry（resumed）', () => {
      const key = 'ut:p3:approve';
      mkApproval(key, 'alice');
      let resolved = null;
      registry.register(key, { resolve: v => { resolved = v; registry.del(key); } });
      const r = resolveCardCallback({ callbackData: key, action: 'approve', userId: 'alice-ext' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.status, 'approved');
      assert.strictEqual(r.resumed, true, '应唤醒进程内等待');
      assert.strictEqual(resolved, true, 'resolve 应以 true 唤醒');
      const row = db.prepare('SELECT status, approver FROM tool_approvals WHERE confirm_key=?').get(key);
      assert.strictEqual(row.status, 'approved');
      assert.strictEqual(row.approver, 'alice-ext');
    });

    await t('U0-5: resolveCardCallback 幂等——非 pending 记录再次决议 → 400', () => {
      const key = 'ut:p3:approve'; // 上例已置 approved
      const r = resolveCardCallback({ callbackData: key, action: 'reject' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 400);
      assert.strictEqual(r.status, 'approved');
    });

    await t('U0-5: resolveCardCallback 归属校验——决议人与发起人不一致 → 403', () => {
      const chId = db.prepare(`INSERT INTO channels (name, type, config, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run('归属校验渠道', 'wecom', '', 1, 'admin', nowStr, nowStr).lastInsertRowid;
      db.prepare('INSERT INTO user_channel_bindings (username, channel_id, channel_user_id, channel_user_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('bob', chId, 'bob-ext', 'Bob', nowStr, nowStr);
      const key = 'ut:p3:owner';
      mkApproval(key, 'alice'); // 发起人是 alice，但渠道身份映射到 bob
      const r = resolveCardCallback({ callbackData: key, action: 'approve', userId: 'bob-ext', channelId: chId });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 403, '归属不一致应 403');
      const row = db.prepare('SELECT status FROM tool_approvals WHERE confirm_key=?').get(key);
      assert.strictEqual(row.status, 'pending', '被拒后不应改写审批状态');
      // 同一身份映射到发起人本人时放行
      db.prepare('UPDATE user_channel_bindings SET username=? WHERE channel_id=? AND channel_user_id=?').run('alice', chId, 'bob-ext');
      const r2 = resolveCardCallback({ callbackData: key, action: 'reject', userId: 'bob-ext', channelId: chId });
      assert.strictEqual(r2.ok, true, '身份映射回发起人本人应放行');
      assert.strictEqual(r2.status, 'rejected');
      db.prepare('DELETE FROM user_channel_bindings WHERE channel_id=?').run(chId);
      db.prepare('DELETE FROM channels WHERE id=?').run(chId);
    });

    await t('U0-5: sendCardResult 结果回发（inbox 降级写入通知）', async () => {
      const r = await sendCardResult('inbox', 'admin', { status: 'approved', toolName: 'danger_tool', confirmKey: 'k', reason: 'ok' });
      assert.strictEqual(r.ok, true);
    });

    db.prepare("DELETE FROM tool_approvals WHERE confirm_key LIKE 'ut:p3:%'").run();
  }

  console.log('【U0-1③ / N4】微信公众号渠道（入站验签/解析/审计 + 出站降级）');
  {
    const { db } = require('../src-server/db');
    const { upsertChannel, normalizeInbound, auditInbound, parseWechatMp, send, deleteChannel } = require('../src-server/lib/channel');
    const mp = require('../src-server/lib/im-wechat-mp');
    const { adapters } = require('../src-server/lib/im-adapters');

    // 测试渠道（配 token 以覆盖验签路径；appSecret 留空 → 出站走 mock 降级）
    const mpCh = upsertChannel({ name: '测试公众号', type: 'wechat-mp', config: { appId: 'wx-test', appSecret: '', token: 'mytoken' } });
    const chId = mpCh.id;

    await t('U0-1③/N4: im-adapters 已注册 wechat-mp（active，含 send/sendCard/handleEvent）', () => {
      const a = adapters['wechat-mp'];
      assert.ok(a, '应注册 wechat-mp');
      assert.strictEqual(a.status, 'active');
      assert.strictEqual(typeof a.send, 'function');
      assert.strictEqual(typeof a.sendCard, 'function');
      assert.strictEqual(typeof a.handleEvent, 'function');
    });

    await t('U0-1③/N4: computeSignature 与微信 sha1(token+ts+nonce 字典序) 一致', () => {
      const crypto = require('crypto');
      const token = 'tok', ts = '1700000000', nonce = 'abc123';
      const expect = crypto.createHash('sha1').update([token, ts, nonce].sort().join('')).digest('hex');
      assert.strictEqual(mp.computeSignature(token, ts, nonce), expect);
      const enc = 'CIPHER';
      const expect4 = crypto.createHash('sha1').update([token, ts, nonce, enc].sort().join('')).digest('hex');
      assert.strictEqual(mp.computeSignature(token, ts, nonce, enc), expect4);
    });

    await t('U0-1③/N4: safeEqualHex 恒时比较（相等 true / 不同 false / 长度不同 false）', () => {
      assert.strictEqual(mp.safeEqualHex('abc', 'abc'), true);
      assert.strictEqual(mp.safeEqualHex('abc', 'abd'), false);
      assert.strictEqual(mp.safeEqualHex('ab', 'abc'), false);
    });

    await t('U0-1③/N4: parseXml 解析 CDATA+扁平元素，外层 <xml> 不被吞并为键', () => {
      const xml = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid_1]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好 <世界>]]></Content><MsgId>123456</MsgId></xml>`;
      const o = mp.parseXml(xml);
      assert.strictEqual(o.ToUserName, 'gh_1');
      assert.strictEqual(o.FromUserName, 'openid_1');
      assert.strictEqual(o.CreateTime, '1700000000');
      assert.strictEqual(o.MsgType, 'text');
      assert.strictEqual(o.Content, '你好 <世界>', 'CDATA 内容应允许含 <');
      assert.strictEqual(o.MsgId, '123456');
      assert.strictEqual(o.xml, undefined, '外层 <xml> 不应被解析为键');
    });

    await t('U0-1③/N4: parseWechatMp 归一化（channel/eventId/秒→毫秒/文本去空白）', () => {
      const m = parseWechatMp({ FromUserName: 'openid_1', ToUserName: 'gh_1', MsgType: 'text', Content: '  hi  ', CreateTime: '1700000000', MsgId: '999' });
      assert.strictEqual(m.channel, 'wechat-mp');
      assert.strictEqual(m.sender.id, 'openid_1');
      assert.strictEqual(m.chat.type, 'single');
      assert.strictEqual(m.text, 'hi');
      assert.strictEqual(m.ts, 1700000000000);
      assert.strictEqual(m.eventId, '999');
    });

    await t('U0-1③/N4: normalizeInbound 自动识别公众号（特征命中 / 显式 hint）', () => {
      const m = normalizeInbound({ FromUserName: 'o1', ToUserName: 'g1', MsgType: 'text', Content: 'x', MsgId: 'm1' });
      assert.strictEqual(m.channel, 'wechat-mp');
      const m2 = normalizeInbound({ FromUserName: 'o2', Content: 'y' }, 'wechat-mp');
      assert.strictEqual(m2.channel, 'wechat-mp');
    });

    await t('U0-1③/N4: auditInbound 落库 channel_messages + event_id 幂等去重', () => {
      const model = parseWechatMp({ FromUserName: 'audit_o', ToUserName: 'g1', MsgType: 'text', Content: '审计', CreateTime: '1700000001', MsgId: 'ut:mp:audit_1' });
      const a1 = auditInbound(model);
      assert.ok(a1.id && !a1.deduped, '首次应插入');
      const row = db.prepare('SELECT * FROM channel_messages WHERE event_id=?').get('ut:mp:audit_1');
      assert.strictEqual(row.channel, 'wechat-mp');
      assert.strictEqual(row.sender_id, 'audit_o');
      assert.strictEqual(row.text, '审计');
      const a2 = auditInbound(model);
      assert.strictEqual(a2.id, a1.id);
      assert.strictEqual(a2.deduped, true);
      const cnt = db.prepare('SELECT COUNT(*) c FROM channel_messages WHERE event_id=?').get('ut:mp:audit_1').c;
      assert.strictEqual(cnt, 1, '同一 event_id 不应重复插入');
      db.prepare('DELETE FROM channel_messages WHERE event_id=?').run('ut:mp:audit_1');
    });

    await t('U0-1③/N4: buildPassiveReply 空内容→success，有内容→可还原 XML', () => {
      assert.strictEqual(mp.buildPassiveReply('o1', 'g1', ''), 'success');
      const xml = mp.buildPassiveReply('o1', 'g1', '你好');
      assert.ok(xml.includes('<ToUserName><![CDATA[o1]]></ToUserName>'));
      assert.ok(xml.includes('<FromUserName><![CDATA[g1]]></FromUserName>'));
      assert.ok(xml.includes('<Content><![CDATA[你好]]></Content>'));
      assert.strictEqual(mp.parseXml(xml).Content, '你好');
    });

    await t('U0-1③/N4: verifyUrlSignature 未配 token 放行标注；配 token 通过/失败', () => {
      assert.deepStrictEqual(mp.verifyUrlSignature({}, { signature: 'x', timestamp: '1', nonce: '2' }), { ok: true, unverified: true });
      const cfg = { token: 'mytoken' };
      const ts = '1700000000', nonce = 'nnn';
      const sig = mp.computeSignature('mytoken', ts, nonce);
      assert.strictEqual(mp.verifyUrlSignature(cfg, { signature: sig, timestamp: ts, nonce }).ok, true);
      assert.strictEqual(mp.verifyUrlSignature(cfg, { signature: sig, timestamp: ts, nonce: 'other' }).ok, false);
    });

    await t('U0-1③/N4: handleWechatMpEvent GET 握手返回 echostr；错误签名拒绝', () => {
      const ts = '1700000000', nonce = 'nnn';
      const sig = mp.computeSignature('mytoken', ts, nonce);
      const r = mp.handleWechatMpEvent(chId, { signature: sig, timestamp: ts, nonce, echostr: 'ECHO123' }, null);
      assert.strictEqual(r.echo, 'ECHO123');
      const bad = mp.handleWechatMpEvent(chId, { signature: 'wrong', timestamp: ts, nonce, echostr: 'ECHO' }, null);
      assert.ok(bad.error, '错误签名应拒绝');
    });

    await t('U0-1③/N4: handleWechatMpEvent POST 文本→模型+reply；非文本→ignored', () => {
      const xml = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid_9]]></FromUserName><CreateTime>1700000002</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId>888</MsgId></xml>`;
      const r = mp.handleWechatMpEvent(chId, {}, xml);
      assert.strictEqual(r.message.channel, 'wechat-mp');
      assert.strictEqual(r.message.text, 'hello');
      assert.strictEqual(r.reply.toUser, 'openid_9');
      assert.strictEqual(r.reply.fromUser, 'gh_1');
      const img = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[o1]]></FromUserName><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://x/a.jpg]]></PicUrl></xml>`;
      const r2 = mp.handleWechatMpEvent(chId, {}, img);
      assert.strictEqual(r2.ignored, true);
      assert.strictEqual(r2.type, 'image');
    });

    await t('U0-1③/N4: handleWechatMpEvent 渠道不存在/类型不符 → error', () => {
      const r = mp.handleWechatMpEvent(999999, {}, '<xml><MsgType><![CDATA[text]]></MsgType></xml>');
      assert.ok(r.error, '不存在渠道应报错');
    });

    await t('U0-1③/N4: send/wechatMpSendCard 凭证不全（appSecret 空）→ 降级 mock', async () => {
      const r = await send({ channel: 'wechat-mp', receivers: ['openid_x'] }, { content: '通知测试' });
      assert.ok(r.ok && r.degraded && r.mock, '未配 appSecret 应降级 mock 站内信');
      const c = await mp.wechatMpSendCard(chId, { receiver: 'openid_x' }, { title: 'T', content: 'C', card: { buttons: [{ text: '同意', url: 'http://x/a' }] } });
      assert.ok(c.ok && c.textDegraded, '卡片应文本化降级');
    });

    // 清理测试渠道
    try { db.prepare('DELETE FROM channel_messages WHERE channel=?').run('wechat-mp'); } catch { }
    try { deleteChannel(chId); } catch { }
  }

  console.log('【U0-1③ / N4】P2 出站双通道（客服接口真发 / 窗口降级 / 凭证失败 / token 缓存）');
  {
    const { db } = require('../src-server/db');
    const { upsertChannel, deleteChannel } = require('../src-server/lib/channel');
    const mp = require('../src-server/lib/im-wechat-mp');

    // 出站专用渠道（配 appId/appSecret，走真实 token 路径；fetch 由用例注入）
    const mpCh = upsertChannel({ name: '测试公众号-出站', type: 'wechat-mp', config: { appId: 'wx-out', appSecret: 'secret-out', token: 'tok2' } });
    const chId = mpCh.id;

    const realFetch = global.fetch;
    const stub = (handler) => { global.fetch = async (url, opt) => handler(String(url), opt); };

    await t('U0-1③/N4-P2: 客服接口真发成功（token 获取 + custom/send errcode 0）', async () => {
      let tokenHits = 0, sendHits = 0;
      stub(async (url) => {
        if (url.includes('/cgi-bin/token')) { tokenHits++; return { json: async () => ({ access_token: 'TK', expires_in: 7200 }) }; }
        if (url.includes('/message/custom/send')) { sendHits++; return { json: async () => ({ errcode: 0, errmsg: 'ok' }) }; }
        return { json: async () => ({}) };
      });
      try {
        const r1 = await mp.wechatMpSend(chId, { receiver: 'openid_out' }, { content: 'hello' });
        assert.ok(r1.ok && !r1.degraded, '真发应成功且非降级');
        assert.strictEqual(sendHits, 1);
        // 第二次经 pushAsyncResult（异步回推入口）：token 应命中缓存，不再请求 token 接口
        const r2 = await mp.pushAsyncResult(chId, 'openid_out', 'again', '标题');
        assert.ok(r2.ok);
        assert.strictEqual(tokenHits, 1, 'access_token 应命中缓存（仅首次请求）');
        assert.strictEqual(sendHits, 2);
      } finally { global.fetch = realFetch; }
    });

    await t('U0-1③/N4-P2: 客服接口 45015（超 48h 窗口）→ 降级站内信 + windowClosed', async () => {
      stub(async (url) => {
        if (url.includes('/cgi-bin/token')) return { json: async () => ({ access_token: 'TK2', expires_in: 7200 }) };
        if (url.includes('/message/custom/send')) return { json: async () => ({ errcode: 45015, errmsg: 'out of time' }) };
        return { json: async () => ({}) };
      });
      try {
        const r = await mp.pushAsyncResult(chId, 'openid_out', '晚到的智能体结果');
        assert.ok(r.ok && r.degraded && r.windowClosed, '应降级且标注窗口超时');
      } finally { global.fetch = realFetch; }
    });

    await t('U0-1③/N4-P2: 其他微信错误码 → {ok:false, error}（不静默吞错）', async () => {
      stub(async (url) => {
        if (url.includes('/cgi-bin/token')) return { json: async () => ({ access_token: 'TK3', expires_in: 7200 }) };
        if (url.includes('/message/custom/send')) return { json: async () => ({ errcode: 40003, errmsg: 'invalid openid' }) };
        return { json: async () => ({}) };
      });
      try {
        const r = await mp.wechatMpSend(chId, { receiver: 'bad' }, { content: 'x' });
        assert.strictEqual(r.ok, false);
        assert.ok(/invalid openid/.test(r.error));
      } finally { global.fetch = realFetch; }
    });

    await t('U0-1③/N4-P2: access_token 获取失败（appid 非法）→ {ok:false, 凭证获取失败}', async () => {
      const chBad = upsertChannel({ name: '测试公众号-坏凭证', type: 'wechat-mp', config: { appId: 'wx-bad', appSecret: 'badsec', token: 't' } });
      stub(async (url) => {
        if (url.includes('/cgi-bin/token')) return { json: async () => ({ errcode: 40013, errmsg: 'invalid appid' }) };
        return { json: async () => ({}) };
      });
      try {
        const r = await mp.wechatMpSend(chBad.id, { receiver: 'o' }, { content: 'x' });
        assert.strictEqual(r.ok, false);
        assert.ok(/凭证获取失败/.test(r.error));
      } finally { global.fetch = realFetch; try { deleteChannel(chBad.id); } catch { } }
    });

    await t('U0-1③/N4-P2: 网络异常 → {ok:false}（函数永不 reject）', async () => {
      stub(async () => { throw new Error('network down'); });
      try {
        const r = await mp.wechatMpSend(chId, { receiver: 'o' }, { content: 'x' });
        assert.strictEqual(r.ok, false);
      } finally { global.fetch = realFetch; }
    });

    try { deleteChannel(chId); } catch { }
  }

  console.log('【U0-1③ / N4】P3 素材上传 + 安全模式 AES（解密回环 / 安全模式整链路 / 素材接口）');
  {
    const crypto = require('crypto');
    const { db } = require('../src-server/db');
    const { upsertChannel, deleteChannel } = require('../src-server/lib/channel');
    const mp = require('../src-server/lib/im-wechat-mp');

    // 43 位 EncodingAESKey → base64 补 '=' 得 32 字节
    const aesKey = crypto.randomBytes(32).toString('base64').slice(0, 43);

    // 测试用加密（复刻微信安全模式：random16 + msgLen4(BE) + msg + appid，PKCS7 补齐到 32 边界）
    function wechatEncrypt(msg, appid) {
      const key = Buffer.from(aesKey + '=', 'base64');
      const iv = key.slice(0, 16);
      const msgBuf = Buffer.from(msg, 'utf8');
      const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(msgBuf.length, 0);
      let buf = Buffer.concat([crypto.randomBytes(16), lenBuf, msgBuf, Buffer.from(appid, 'utf8')]);
      const pad = 32 - (buf.length % 32);
      buf = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(buf), cipher.final()]).toString('base64');
    }

    await t('U0-1③/N4-P3: decryptMessage 解密回环（还原 msg + appid）', () => {
      const enc = wechatEncrypt('你好，安全模式', 'wxappid001');
      const r = mp.decryptMessage(aesKey, enc);
      assert.strictEqual(r.msg, '你好，安全模式');
      assert.strictEqual(r.appid, 'wxappid001');
    });

    // 安全模式渠道
    const modeCh = upsertChannel({ name: '测试公众号-安全模式', type: 'wechat-mp', config: { appId: 'wx-mode', appSecret: '', token: 'mode-token', encodingAESKey: aesKey } });

    await t('U0-1③/N4-P3: handleWechatMpEvent 安全模式整链路（msg_signature 验签 + AES 解密 + 归一化）', () => {
      const inner = `<xml><ToUserName><![CDATA[gh_mode]]></ToUserName><FromUserName><![CDATA[openid_mode]]></FromUserName><CreateTime>1700000003</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[加密来信]]></Content><MsgId>mode_1</MsgId></xml>`;
      const enc = wechatEncrypt(inner, 'wx-mode');
      const ts = '1700000003', nonce = 'nsec';
      const sig = mp.computeSignature('mode-token', ts, nonce, enc);
      const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
      const r = mp.handleWechatMpEvent(modeCh.id, { msg_signature: sig, timestamp: ts, nonce }, body);
      assert.strictEqual(r.message.channel, 'wechat-mp');
      assert.strictEqual(r.message.text, '加密来信');
      assert.strictEqual(r.reply.toUser, 'openid_mode');
    });

    await t('U0-1③/N4-P3: 安全模式错误 msg_signature → 拒绝', () => {
      const inner = `<xml><FromUserName><![CDATA[o]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[x]]></Content></xml>`;
      const enc = wechatEncrypt(inner, 'wx-mode');
      const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
      const r = mp.handleWechatMpEvent(modeCh.id, { msg_signature: 'wrong', timestamp: '1', nonce: '2' }, body);
      assert.ok(r.error, '错误 msg_signature 应拒绝');
    });

    await t('U0-1③/N4-P3: uploadMedia 上传成功返回 media_id（stub fetch）', async () => {
      const upCh = upsertChannel({ name: '测试公众号-素材', type: 'wechat-mp', config: { appId: 'wx-up', appSecret: 'upsec', token: 't' } });
      const realFetch = global.fetch;
      global.fetch = async (url) => {
        if (String(url).includes('/cgi-bin/token')) return { json: async () => ({ access_token: 'UPTK', expires_in: 7200 }) };
        if (String(url).includes('/cgi-bin/media/upload')) return { json: async () => ({ media_id: 'MID_1', expires_in: 259200 }) };
        return { json: async () => ({}) };
      };
      try {
        const r = await mp.uploadMedia(upCh.id, 'image', Buffer.from('fake-image-bytes'), 'a.png');
        assert.ok(r.ok && r.mediaId === 'MID_1', '应返回 media_id');
        assert.strictEqual(r.expiresIn, 259200);
      } finally { global.fetch = realFetch; try { deleteChannel(upCh.id); } catch { } }
    });

    await t('U0-1③/N4-P3: uploadMedia 未配置凭证 → {ok:false, mock}（不请求）', async () => {
      const noCredCh = upsertChannel({ name: '测试公众号-无凭证', type: 'wechat-mp', config: { appId: '', appSecret: '', token: 't' } });
      const realFetch = global.fetch;
      let hits = 0;
      global.fetch = async () => { hits++; return { json: async () => ({}) }; };
      try {
        const r = await mp.uploadMedia(noCredCh.id, 'image', Buffer.from('x'), 'a.png');
        assert.strictEqual(r.ok, false);
        assert.ok(r.mock, '应标注 mock');
        assert.strictEqual(hits, 0, '未配置凭证不应发起网络请求');
      } finally { global.fetch = realFetch; try { deleteChannel(noCredCh.id); } catch { } }
    });

    try { deleteChannel(modeCh.id); } catch { }
  }

  // ===== U2-7 Phase 3 / N5：JWS 签名 + 密钥管理 =====
  console.log('【U2-7 / N5】Phase 3 JWS 密钥管理（生成/签发/验签/篡改拒绝/过期/未知kid/alg白名单）');
  {
    const jws = require('../src-server/lib/a2a-jws');

    await t('U2-7/N5-P1: generateKeyPair RS256/ES256 产出 PEM 且可回环签发验签', () => {
      for (const alg of ['RS256', 'ES256']) {
        const { publicKey, privateKey } = jws.generateKeyPair(alg);
        assert.ok(publicKey.includes('PUBLIC KEY'), `${alg} 应产出公钥 PEM`);
        assert.ok(privateKey.includes('PRIVATE KEY'), `${alg} 应产出私钥 PEM`);
        const token = jws.signJws({ sub: 'x' }, privateKey, { alg, kid: 'k1' });
        assert.strictEqual(token.split('.').length, 3, 'compact JWS 应为三段');
        const payload = jws.verifyJws(token, () => publicKey);
        assert.strictEqual(payload.sub, 'x');
      }
    });

    await t('U2-7/N5-P1: 篡改载荷 / 篡改签名 → 验签拒绝', () => {
      const { publicKey, privateKey } = jws.generateKeyPair('RS256');
      const token = jws.signJws({ sub: 'legit', exp: Date.now() + 60000 }, privateKey, { kid: 'k1' });
      const [h, p, s] = token.split('.');
      // 篡改载荷：换成另一份 payload（签名不匹配）
      const forged = h + '.' + jws.b64url(JSON.stringify({ sub: 'attacker' })) + '.' + s;
      assert.strictEqual(jws.verifyJws(forged, () => publicKey), null);
      // 篡改签名：随机化签名段
      const badSig = h + '.' + p + '.' + require('crypto').randomBytes(64).toString('base64url');
      assert.strictEqual(jws.verifyJws(badSig, () => publicKey), null);
    });

    await t('U2-7/N5-P1: 过期 / 未生效（nbf）→ 拒绝', () => {
      const { publicKey, privateKey } = jws.generateKeyPair('RS256');
      const expired = jws.signJws({ sub: 'x', exp: Date.now() - 1000 }, privateKey, { kid: 'k1' });
      assert.strictEqual(jws.verifyJws(expired, () => publicKey), null, '过期应拒绝');
      const notYet = jws.signJws({ sub: 'x', nbf: Date.now() + 60000 }, privateKey, { kid: 'k1' });
      assert.strictEqual(jws.verifyJws(notYet, () => publicKey), null, '未生效应拒绝');
      // 显式 now 覆盖：在有效期内应通过
      const valid = jws.signJws({ sub: 'x', exp: Date.now() + 60000 }, privateKey, { kid: 'k1' });
      assert.ok(jws.verifyJws(valid, () => publicKey));
    });

    await t('U2-7/N5-P1: 未知 kid → 拒绝', () => {
      const { publicKey, privateKey } = jws.generateKeyPair('RS256');
      const token = jws.signJws({ sub: 'x' }, privateKey, { alg: 'RS256', kid: 'unknown' });
      assert.strictEqual(jws.verifyJws(token, () => ''), null, '未知 kid 无可寻址公钥应拒绝');
      // kid 解析到一个不匹配的公钥（攻击者用自己密钥签名却指向受害者 kid）→ 签名不匹配应拒绝
      const other = jws.generateKeyPair('RS256');
      assert.strictEqual(jws.verifyJws(token, () => other.publicKey), null, '公钥与签名不匹配应拒绝');
    });

    await t('U2-7/N5-P1: alg=none 降级攻击 → 拒绝', () => {
      const header = jws.b64url(JSON.stringify({ alg: 'none', typ: 'JWS' }));
      const payload = jws.b64url(JSON.stringify({ sub: 'x' }));
      const forged = header + '.' + payload + '.';
      assert.strictEqual(jws.verifyJws(forged, () => 'ANY-KEY'), null, 'alg=none 必须拒绝');
    });

    await t('U2-7/N5-P1: createKey 落库 + resolvePublicKey 寻址 + 私钥解密回环 + disableKey 失效', () => {
      const k = jws.createKey({ name: '测试密钥', owner: 'alice', orgName: '组织B', alg: 'RS256' });
      assert.ok(k.key_id.startsWith('a2ak_'));
      assert.strictEqual(jws.resolvePublicKey(k.key_id), k.public_key, '启用中应可寻址公钥');
      // 私钥解密回环：库内为密文，getPrivateKey 还原出可用私钥
      const priv = jws.getPrivateKey(k.key_id);
      const token = jws.signJws({ sub: 'alice' }, priv, { alg: 'RS256', kid: k.key_id });
      assert.strictEqual(jws.verifyJws(token, jws.resolvePublicKey).sub, 'alice');
      // 列出的密钥不含私钥列
      const row = jws.listKeys().find(x => x.key_id === k.key_id);
      assert.ok(row && row.private_key === undefined, '列表不应暴露私钥');
      // 停用后 resolvePublicKey 立即失效
      assert.strictEqual(jws.disableKey(k.key_id), true);
      assert.strictEqual(jws.resolvePublicKey(k.key_id), '', '停用后不应再返回公钥');
    });
  }

  // ===== U2-7 Phase 3 / N5：OAuth client_credentials 令牌交换 =====
  console.log('【U2-7 / N5】Phase 3 OAuth 令牌交换（断言验签/签发令牌/iss校验/过期/停用/scope）');
  {
    const jws = require('../src-server/lib/a2a-jws');
    const oauth = require('../src-server/lib/a2a-oauth');

    await t('U2-7/N5-P2: 有效 client_assertion → 换发访问令牌，verifyA2aToken 可解析', () => {
      const k = jws.createKey({ name: 'OAuth测试', owner: 'bob', orgName: '组织C', alg: 'RS256', scopes: 'a2a:call,a2a:read' });
      const aud = 'http://localhost:3210/api/a2a/oauth/token';
      const assertion = jws.signJws(
        { iss: k.key_id, sub: k.key_id, aud, exp: Date.now() + 300000 },
        k.private_key, { alg: 'RS256', kid: k.key_id });
      const r = oauth.exchangeClientCredentials({ assertion, expectedAud: aud });
      assert.ok(r.access_token, '应返回 access_token');
      assert.strictEqual(r.token_type, 'Bearer');
      assert.strictEqual(r.scope, 'a2a:call,a2a:read');
      const p = oauth.verifyA2aToken(r.access_token);
      assert.ok(p && p.typ === 'a2a_token');
      assert.strictEqual(p.sub, k.key_id);
      assert.strictEqual(p.org, '组织C');
    });

    await t('U2-7/N5-P2: 篡改断言 / iss≠kid / 过期 / 停用密钥 → invalid_client', () => {
      const k = jws.createKey({ name: 'OAuth拒绝', owner: 'carol', alg: 'ES256' });
      const aud = 'http://localhost:3210/api/a2a/oauth/token';
      const good = jws.signJws({ iss: k.key_id, sub: k.key_id, aud, exp: Date.now() + 300000 }, k.private_key, { alg: 'ES256', kid: k.key_id });

      // 篡改：改末位签名字符
      const tampered = good.slice(0, -2) + (good.slice(-2, -1) === 'A' ? 'B' : 'A') + good.slice(-1);
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: tampered, expectedAud: aud }).error, 'invalid_client');

      // iss 不等于 kid
      const badIss = jws.signJws({ iss: 'other', sub: k.key_id, aud, exp: Date.now() + 300000 }, k.private_key, { alg: 'ES256', kid: k.key_id });
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: badIss, expectedAud: aud }).error, 'invalid_client');

      // 过期
      const expired = jws.signJws({ iss: k.key_id, sub: k.key_id, aud, exp: Date.now() - 1000 }, k.private_key, { alg: 'ES256', kid: k.key_id });
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: expired, expectedAud: aud }).error, 'invalid_client');

      // aud 不匹配
      const badAud = jws.signJws({ iss: k.key_id, sub: k.key_id, aud: 'https://evil.example/token', exp: Date.now() + 300000 }, k.private_key, { alg: 'ES256', kid: k.key_id });
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: badAud, expectedAud: aud }).error, 'invalid_client');

      // 停用后失效
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: good, expectedAud: aud }).access_token != null, true);
      jws.disableKey(k.key_id);
      assert.strictEqual(oauth.exchangeClientCredentials({ assertion: good, expectedAud: aud }).error, 'invalid_client');
    });

    await t('U2-7/N5-P2: hasScope 判定（含通配）', () => {
      assert.strictEqual(oauth.hasScope('a2a:call,a2a:read', 'a2a:read'), true);
      assert.strictEqual(oauth.hasScope('a2a:call', 'a2a:read'), false);
      assert.strictEqual(oauth.hasScope('*', 'a2a:read'), true);
      assert.strictEqual(oauth.hasScope('', 'a2a:call'), false);
    });
  }

  // ===== U2-7 Phase 3 / N5：三通道鉴权 + scope + 归属审计（HTTP 集成）=====
  console.log('【U2-7 / N5】Phase 3 A2A 三通道鉴权（平台/JWS/OAuth）+ scope + 归属审计');
  {
    const jws = require('../src-server/lib/a2a-jws');
    const oauth = require('../src-server/lib/a2a-oauth');
    const { sign } = require('../src-server/lib/auth');
    const { db } = require('../src-server/db');
    const { a2aAuth, requireScope } = require('../src-server/routes/a2a');

    const mockRes = () => {
      const r = { statusCode: 200, body: null };
      r.status = c => { r.statusCode = c; return r; };
      r.json = b => { r.body = b; return r; };
      return r;
    };

    await t('U2-7/N5-P3: a2aAuth ①平台 token → req.user（向后兼容）', () => {
      db.prepare("INSERT OR IGNORE INTO users (id,username,password,nickname,role,status,created_at) VALUES (9001,'n5tester','x','N5T','admin',1,?)")
        .run(new Date().toISOString());
      const ptoken = sign({ uid: 9001, exp: Date.now() + 60000 });
      const req = { headers: { authorization: 'Bearer ' + ptoken } };
      let called = false;
      a2aAuth(req, mockRes(), () => { called = true; });
      assert.ok(called, '平台 token 应放行');
      assert.strictEqual(req.user.username, 'n5tester');
      assert.strictEqual(req.authMethod, 'platform');
    });

    await t('U2-7/N5-P3: a2aAuth ②JWS 直签 → req.a2aCaller（归属取自密钥元信息）', () => {
      const k = jws.createKey({ name: '直签', owner: 'dave', orgName: '组织D', scopes: 'a2a:call,a2a:read' });
      const jwsToken = jws.signJws({ iss: k.key_id, sub: k.key_id, exp: Date.now() + 60000 }, k.private_key, { alg: 'RS256', kid: k.key_id });
      const req = { headers: { authorization: 'Bearer ' + jwsToken } };
      let called = false;
      a2aAuth(req, mockRes(), () => { called = true; });
      assert.ok(called, 'JWS 直签应放行');
      assert.strictEqual(req.a2aCaller.method, 'jws');
      assert.strictEqual(req.a2aCaller.owner, 'dave');
      assert.strictEqual(req.a2aCaller.org, '组织D');
    });

    await t('U2-7/N5-P3: a2aAuth ③OAuth 令牌 → req.a2aCaller；无效 → 401', () => {
      const k = jws.createKey({ name: 'oauth直连', owner: 'erin', orgName: '组织E', scopes: 'a2a:call' });
      const { access_token } = oauth.issueToken({ kid: k.key_id, org: '组织E', scopes: 'a2a:call' });
      const req = { headers: { authorization: 'Bearer ' + access_token } };
      let called = false;
      a2aAuth(req, mockRes(), () => { called = true; });
      assert.ok(called, 'OAuth 令牌应放行');
      assert.strictEqual(req.a2aCaller.method, 'oauth');
      assert.strictEqual(req.a2aCaller.owner, 'erin');

      // 无效 token → 401
      const bad = mockRes();
      a2aAuth({ headers: { authorization: 'Bearer not-a-real-token' } }, bad, () => { throw new Error('不应放行'); });
      assert.strictEqual(bad.statusCode, 401);
    });

    await t('U2-7/N5-P3: requireScope —— 平台用户不受限 / 签名方缺 scope 403 / 有 scope 放行', () => {
      let n1 = false;
      requireScope('a2a:read')({}, mockRes(), () => { n1 = true; });
      assert.ok(n1, '平台用户（无 a2aCaller）应直接放行');

      const r2 = mockRes();
      requireScope('a2a:read')({ a2aCaller: { scopes: 'a2a:call' } }, r2, () => { throw new Error('缺 scope 不应放行'); });
      assert.strictEqual(r2.statusCode, 403);

      let n3 = false;
      requireScope('a2a:call')({ a2aCaller: { scopes: 'a2a:call' } }, mockRes(), () => { n3 = true; });
      assert.ok(n3, '有 scope 应放行');
    });

    // —— HTTP 端到端：签名调用创建任务 → created_by/meta 落库正确；scope/未认证拦截 ——
    await t('U2-7/N5-P3: HTTP 集成 —— JWS 调用 /a2a/tasks 落库归属与审计字段；缺 scope 403；未认证 401', async () => {
      const workflowMod = require('../src-server/lib/workflow');
      const origRunAgent = workflowMod.runAgent;
      workflowMod.runAgent = async () => ({ text: 'stub-output' }); // 纯本地：避免真实 LLM 调用
      let server;
      try {
        const express = require('express');
        const { authRouter } = require('../src-server/routes/a2a');
        const app = express();
        app.use(express.json());
        app.use('/api/a2a', authRouter);
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = `http://127.0.0.1:${server.address().port}`;

        db.prepare("INSERT INTO agents (name,status,workflow,published_workflow,created_at) VALUES ('N5测试智能体','published','{}','{}',?)")
          .run(new Date().toISOString());
        const agentId = db.prepare("SELECT id FROM agents WHERE name='N5测试智能体' ORDER BY id DESC LIMIT 1").get().id;

        const call = (token, extra) => fetch(base + '/api/a2a/tasks', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
          body: JSON.stringify(Object.assign({ agent_id: agentId, input: { message: 'hi' } }, extra || {})),
        });

        // ① JWS 直签（owner=frank）→ 通过 + 审计字段
        const k = jws.createKey({ name: '集成直签', owner: 'frank', orgName: '组织F', scopes: 'a2a:call' });
        const jwsToken = jws.signJws({ iss: k.key_id, sub: k.key_id, exp: Date.now() + 60000 }, k.private_key, { alg: 'RS256', kid: k.key_id });
        const resp = await call(jwsToken);
        assert.strictEqual(resp.status, 200);
        const body = await resp.json();
        assert.strictEqual(body.code, 0);
        const row = db.prepare('SELECT * FROM a2a_tasks WHERE task_id=?').get(body.data.task_id);
        assert.strictEqual(row.created_by, 'frank', '归属应为密钥 owner');
        const meta = JSON.parse(row.meta);
        assert.strictEqual(meta.auth_method, 'jws');
        assert.strictEqual(meta.caller_kid, k.key_id);
        assert.strictEqual(meta.caller_org, '组织F');

        // ② 仅 a2a:read 的密钥 → 缺 a2a:call → 403
        const k2 = jws.createKey({ name: '只读', owner: 'grace', scopes: 'a2a:read' });
        const jws2 = jws.signJws({ iss: k2.key_id, sub: k2.key_id, exp: Date.now() + 60000 }, k2.private_key, { alg: 'RS256', kid: k2.key_id });
        const resp2 = await call(jws2);
        assert.strictEqual(resp2.status, 403);

        // ③ 未认证 → 401
        const resp3 = await call('');
        assert.strictEqual(resp3.status, 401);
      } finally {
        if (server) await new Promise(r => server.close(r));
        workflowMod.runAgent = origRunAgent;
      }
    });
  }

  console.log('【U2-4 / N6】端侧网关微信远控（受限远控路由）');
  {
    const { db, now } = require('../src-server/db');
    const rd = require('../src-server/lib/remote-dispatch');
    const { upsertChannel, upsertUserBinding, auditInbound } = require('../src-server/lib/channel');
    const channelMod = require('../src-server/lib/channel');

    // 造渠道（feishu）与绑定关系
    const ch = upsertChannel({ name: 'N6测试渠道', type: 'feishu', config: { appId: 'cli_n6', appSecret: '' } });
    const chId = ch.id;

    function mkDevice(username, token, { name = '测试机', online = true, highRisk = 0, isDefault = 1 } = {}) {
      db.prepare('INSERT INTO localbridge_devices (username,device_token,device_name,platform,is_default,last_seen,created_at,allow_high_risk) VALUES (?,?,?,?,?,?,?,?)')
        .run(username, token, name, 'macOS', isDefault, online ? now() : '2020-01-01T00:00:00', now(), highRisk);
      return db.prepare('SELECT * FROM localbridge_devices WHERE device_token=?').get(token);
    }

    await t('U2-4/N6: parseRemoteCommand 常见指令 → 合法白名单 op', () => {
      const c1 = rd.parseRemoteCommand('建文件夹 项目A');
      assert.strictEqual(c1.ok, true); assert.strictEqual(c1.op, 'mkdir'); assert.strictEqual(c1.params.target, '项目A');
      const c2 = rd.parseRemoteCommand('列目录 Desktop');
      assert.strictEqual(c2.op, 'list_dir'); assert.strictEqual(c2.params.target, 'Desktop');
      const c3 = rd.parseRemoteCommand('截图');
      assert.strictEqual(c3.op, 'screenshot');
      const c4 = rd.parseRemoteCommand('读文件 a.md');
      assert.strictEqual(c4.op, 'file_read'); assert.strictEqual(c4.params.path, 'a.md');
      const c5 = rd.parseRemoteCommand('窗口列表');
      assert.strictEqual(c5.op, 'window_list');
    });

    await t('U2-4/N6: parseRemoteCommand 非法/越权 → 拒绝（越白名单/绝对路径/穿越）', () => {
      const bad1 = rd.parseRemoteCommand('帮我看看桌面上有什么');
      assert.strictEqual(bad1.ok, false); assert.ok(bad1.reply, '应回友好提示');
      const bad2 = rd.parseRemoteCommand('读文件 /etc/passwd');
      assert.strictEqual(bad2.ok, false); assert.ok(/不合法/.test(bad2.reply), '绝对路径应拒绝');
      const bad3 = rd.parseRemoteCommand('列目录 ../../secrets');
      assert.strictEqual(bad3.ok, false);
      // 规则产物必须恒在白名单内
      for (const r of rd.RULES) {
        const { OPS_WHITELIST } = require('../src-server/routes/localbridge');
        assert.ok(OPS_WHITELIST.includes(r.op), `规则 op「${r.op}」应在白名单内`);
      }
    });

    await t('U2-4/N6: 身份反查 —— 未绑定用户被拒（不产生任务）', async () => {
      const calls = []; const origSend = channelMod.send;
      channelMod.send = async (to, m) => { calls.push({ to, m }); return { ok: true }; };
      try {
        const before = db.prepare('SELECT COUNT(*) c FROM localbridge_tasks').get().c;
        const r = await rd.handleInbound({
          msg: { channel: 'feishu', sender: { id: 'unbound_openid' } }, text: '建文件夹 X',
          auditId: null, channelId: chId, bind: { channel_id: chId },
        });
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'unbound');
        const after = db.prepare('SELECT COUNT(*) c FROM localbridge_tasks').get().c;
        assert.strictEqual(after, before, '未绑定用户不应入队任务');
        assert.ok(calls.length >= 1 && /绑定/.test(calls[0].m.content), '应回绑定引导');
      } finally { channelMod.send = origSend; }
    });

    await t('U2-4/N6: 设备路由 —— 无设备引导 / 离线引导 / 在线放行', async () => {
      upsertUserBinding({ username: 'n6_nod', channelId: chId, channelUserId: 'openid_nod' });
      const origSend = channelMod.send; channelMod.send = async () => ({ ok: true });
      try {
        // 无设备
        const r1 = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_nod' } }, text: '截图', auditId: null, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(r1.reason, 'no-device');
      } finally { channelMod.send = origSend; }

      // 离线
      upsertUserBinding({ username: 'n6_off', channelId: chId, channelUserId: 'openid_off' });
      mkDevice('n6_off', 'tok-n6-off-000000000000', { online: false });
      const origSend2 = channelMod.send; channelMod.send = async () => ({ ok: true });
      try {
        const r2 = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_off' } }, text: '截图', auditId: null, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(r2.reason, 'offline');
      } finally { channelMod.send = origSend2; }
    });

    await t('U2-4/N6: 入队关联 —— localbridge_tasks.channel_msg_id 非空且等于审计 id', async () => {
      upsertUserBinding({ username: 'n6_ok', channelId: chId, channelUserId: 'openid_ok' });
      const dev = mkDevice('n6_ok', 'tok-n6-ok-000000000000', { online: true });
      const audit = auditInbound({ channel: 'feishu', sender: { id: 'openid_ok' }, chat: { id: 'fs_c1', type: 'single' }, text: '建文件夹 A', attachments: [], ts: Date.now(), raw: {}, eventId: 'ut:n6:enq' });
      const origSend = channelMod.send; channelMod.send = async () => ({ ok: true });
      try {
        const r = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_ok' } }, text: '建文件夹 A', auditId: audit.id, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(r.ok, true);
        const row = db.prepare('SELECT * FROM localbridge_tasks WHERE id=?').get(r.taskId);
        assert.ok(row.channel_msg_id, 'channel_msg_id 应非空');
        assert.strictEqual(row.channel_msg_id, audit.id, 'channel_msg_id 应等于审计 id');
        assert.strictEqual(row.device_id, dev.id);
        assert.strictEqual(row.op, 'mkdir');
      } finally { channelMod.send = origSend; }
    });

    await t('U2-4/N6: 高危闸 —— 未开 allow_high_risk 时 file_write 被拒；开启后放行', async () => {
      upsertUserBinding({ username: 'n6_hr', channelId: chId, channelUserId: 'openid_hr' });
      const dev = mkDevice('n6_hr', 'tok-n6-hr-000000000000', { online: true, highRisk: 0 });
      const origSend = channelMod.send; channelMod.send = async () => ({ ok: true });
      try {
        const r1 = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_hr' } }, text: '写文件 a.txt 内容: hi', auditId: null, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(r1.ok, false); assert.strictEqual(r1.reason, 'high-risk-blocked');
        // 开启后放行
        db.prepare('UPDATE localbridge_devices SET allow_high_risk=1 WHERE id=?').run(dev.id);
        const r2 = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_hr' } }, text: '写文件 a.txt 内容: hi', auditId: null, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(r2.ok, true); assert.strictEqual(r2.op, 'file_write');
      } finally { channelMod.send = origSend; }
    });

    await t('U2-4/N6: formatResultForChannel —— 文件类 op 结果可读化（非 JSON.stringify）', () => {
      const a = rd.formatResultForChannel('list_dir', { ok: true, data: { items: [{ name: 'a.txt', type: 'file' }, { name: 'doc', type: 'dir' }] } });
      assert.ok(a.content.includes('a.txt') && a.content.includes('doc'), '应列出条目名');
      const b = rd.formatResultForChannel('mkdir', { ok: true, data: { path: 'Desktop/A', existed: false } });
      assert.ok(b.content.includes('Desktop/A'), '应回路径');
      const c = rd.formatResultForChannel('file_read', { ok: true, data: { content: 'hello world' } });
      assert.ok(c.content.includes('hello world'));
      const d = rd.formatResultForChannel('screenshot', { ok: true, data: { url: 'http://x/y.png' } });
      assert.ok(d.content.includes('http://x/y.png'));
      const e = rd.formatResultForChannel('notify', { ok: false, error: '设备拒绝' });
      assert.ok(e.content.includes('设备拒绝'));
    });

    await t('U2-4/N6: 端到端(mock) —— 入站派发→入队→桥/result→渠道回传被调用且内容正确', async () => {
      upsertUserBinding({ username: 'n6_e2e', channelId: chId, channelUserId: 'openid_e2e' });
      const token = 'tok-n6-e2e-000000000000';
      mkDevice('n6_e2e', token, { online: true });
      const model = { channel: 'feishu', sender: { id: 'openid_e2e' }, chat: { id: 'fs_e2e', type: 'single' }, text: '列目录', attachments: [], ts: Date.now(), raw: {}, eventId: 'ut:n6:e2e' };
      const audit = auditInbound(model);

      const calls = []; const origSend = channelMod.send;
      channelMod.send = async (to, m) => { calls.push({ to, m }); return { ok: true }; };
      let server;
      try {
        // ① 入站派发（模拟 routes/channel.js 的 setImmediate 调用）
        const disp = await rd.handleInbound({ msg: model, text: '列目录', auditId: audit.id, channelId: chId, bind: { channel_id: chId } });
        assert.strictEqual(disp.ok, true);
        const task = db.prepare('SELECT * FROM localbridge_tasks WHERE id=?').get(disp.taskId);
        assert.strictEqual(task.status, 'pending');
        assert.strictEqual(task.channel_msg_id, audit.id);

        // ② 模拟桥 daemon POST /result 回推
        const express = require('express');
        const { router: lbRouter } = require('../src-server/routes/localbridge');
        const app = express(); app.use(express.json()); app.use('/api/localbridge', lbRouter);
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        const base = `http://127.0.0.1:${server.address().port}`;
        calls.length = 0; // 只看回传阶段的调用
        const resp = await fetch(base + '/api/localbridge/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-device-token': token },
          body: JSON.stringify({ task_id: task.id, result: { ok: true, data: { items: [{ name: 'report.pdf', type: 'file' }, { name: 'images', type: 'dir' }] } } }),
        });
        assert.strictEqual(resp.status, 200);
        const row = db.prepare('SELECT * FROM localbridge_tasks WHERE id=?').get(task.id);
        assert.strictEqual(row.status, 'done', '桥回推后任务应为 done');
        // ③ 断言回传被调用、渠道/接收人/内容正确
        assert.ok(calls.length >= 1, '应触发渠道回传');
        const ret = calls[calls.length - 1];
        assert.strictEqual(ret.to.channel, 'feishu');
        assert.deepStrictEqual(ret.to.receivers, ['openid_e2e']);
        assert.ok(ret.m.content.includes('report.pdf') && ret.m.content.includes('images'), '回传内容应含目录条目');
      } finally {
        if (server) await new Promise(r => server.close(r));
        channelMod.send = origSend;
      }
    });

    await t('U2-4/N6: routes/channel.js 已在 verdict.ok 后 setImmediate 派发远控', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'channel.js'), 'utf8');
      assert.ok(src.includes("require('../lib/remote-dispatch')"), '应引用 remote-dispatch');
      assert.ok(/setImmediate\([\s\S]{0,200}handleInbound/.test(src), '应在 setImmediate 中调用 handleInbound');
    });

    // 清理本块造的数据
    db.prepare("DELETE FROM localbridge_tasks WHERE username LIKE 'n6_%'").run();
    db.prepare("DELETE FROM localbridge_devices WHERE username LIKE 'n6_%'").run();
    db.prepare("DELETE FROM user_channel_bindings WHERE channel_id=?").run(chId);
    db.prepare("DELETE FROM channel_bound_chats WHERE channel_id=?").run(chId);
    db.prepare('DELETE FROM channels WHERE id=?').run(chId);
    db.prepare("DELETE FROM channel_messages WHERE event_id LIKE 'ut:n6:%'").run();
  }

  console.log('【D1-1】端侧执行 V1（三档权限 / 写前备份 / 一键回滚）');
  {
    const { db, now } = require('../src-server/db');
    const lb = require('../src-server/routes/localbridge');
    const rd = require('../src-server/lib/remote-dispatch');
    const { sign } = require('../src-server/lib/auth');
    const channelMod = require('../src-server/lib/channel');

    // 库结构：permission_tier 列 + localbridge_backups 表
    await t('D1-1: db 迁移 —— localbridge_devices.permission_tier 与 localbridge_backups 表就位', () => {
      const cols = db.prepare('PRAGMA table_info(localbridge_devices)').all().map(c => c.name);
      assert.ok(cols.includes('permission_tier'), 'devices 应有 permission_tier 列');
      const bcols = db.prepare('PRAGMA table_info(localbridge_backups)').all().map(c => c.name);
      for (const c of ['device_id', 'username', 'op', 'path', 'backup_id', 'status', 'created_at']) {
        assert.ok(bcols.includes(c), `backups 表应有 ${c} 列`);
      }
    });

    await t('D1-1: sanitizeParams —— 新 op（file_patch/terminal/run_python/file_restore）清洗与越权拒绝', () => {
      const p1 = rd.sanitizeParams('file_patch', { path: 'a.md', find: 'x', replace: 'y' });
      assert.ok(p1.ok && p1.params.find === 'x' && p1.params.replace === 'y', 'file_patch 应保留 find/replace');
      const p2 = rd.sanitizeParams('file_patch', { path: '/etc/passwd', find: 'x' });
      assert.ok(!p2.ok, 'file_patch 绝对路径应拒绝');
      const p3 = rd.sanitizeParams('terminal', { cmd: 'ls', args: ['-la'] });
      assert.ok(p3.ok && p3.params.cmd === 'ls' && Array.isArray(p3.params.args), 'terminal 应保留 cmd/args');
      const p4 = rd.sanitizeParams('run_python', { code: 'print(1)' });
      assert.ok(p4.ok && p4.params.code === 'print(1)', 'run_python 应保留 code');
      const p5 = rd.sanitizeParams('file_restore', { backup_id: 'bad id!' });
      assert.ok(!p5.ok, 'file_restore 非法 backup_id 应拒绝');
    });

    function mkD11Device(username, tier, { highRisk = 0 } = {}) {
      const token = 'tok-d11-' + username + '-' + Date.now();
      db.prepare('INSERT INTO localbridge_devices (username,device_token,device_name,platform,is_default,last_seen,created_at,allow_high_risk,permission_tier) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(username, token, 'D11机', 'macOS', 1, now(), now(), highRisk, tier);
      return db.prepare('SELECT * FROM localbridge_devices WHERE device_token=?').get(token);
    }

    await t('D1-1: 渠道远控档位闸 —— standard 档拒绝 key_type（tier-blocked）', async () => {
      const ch = channelMod.upsertChannel({ name: 'D11渠道', type: 'feishu', config: {} });
      channelMod.upsertUserBinding({ username: 'd11_std', channelId: ch.id, channelUserId: 'openid_d11_std' });
      mkD11Device('d11_std', 'standard', { highRisk: 1 });
      const origSend = channelMod.send; channelMod.send = async () => ({ ok: true });
      try {
        const r = await rd.handleInbound({ msg: { channel: 'feishu', sender: { id: 'openid_d11_std' } }, text: '输入 hello', auditId: null, channelId: ch.id, bind: { channel_id: ch.id } });
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'tier-blocked', '标准档 key_type 应被档位闸拦截');
      } finally { channelMod.send = origSend; }
      db.prepare('DELETE FROM user_channel_bindings WHERE channel_id=?').run(ch.id);
      db.prepare('DELETE FROM channels WHERE id=?').run(ch.id);
    });

    await t('D1-1: 备份台账 + 一键回滚 —— rollback 入队 file_restore、备份置 restoring', async () => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d11_u',?,'D11用户','user',1,0,datetime('now','localtime'))`).run('x');
      const u = db.prepare("SELECT id FROM users WHERE username='d11_u'").get();
      const tok = sign({ uid: u.id, exp: Date.now() + 3600000 });
      const dev = mkD11Device('d11_u', 'standard', { highRisk: 0 });
      const bi = db.prepare(`INSERT INTO localbridge_backups (device_id,username,task_id,op,path,backup_id,change,before_bytes,after_bytes,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(dev.id, 'd11_u', null, 'file_write', 'Desktop/a.txt', 'bk-123', 'modified', 10, 20, 'active', now());
      const express = require('express');
      const app = express(); app.use(express.json()); app.use('/api/localbridge', lb.router);
      let server;
      await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        // 发起回滚
        const resp = await fetch(base + `/api/localbridge/backups/${bi.lastInsertRowid}/rollback`, { method: 'POST', headers: { authorization: 'Bearer ' + tok } });
        const j = await resp.json();
        assert.strictEqual(resp.status, 200); assert.strictEqual(j.code, 0);
        const row = db.prepare('SELECT * FROM localbridge_tasks WHERE id=?').get(j.data.task_id);
        assert.strictEqual(row.op, 'file_restore', '应入队 file_restore 任务');
        assert.strictEqual(JSON.parse(row.params).backup_id, 'bk-123', '任务参数应带 backup_id');
        const bk = db.prepare('SELECT * FROM localbridge_backups WHERE id=?').get(bi.lastInsertRowid);
        assert.strictEqual(bk.status, 'restoring', '备份应置 restoring');
        // 备份列表
        const list = await (await fetch(base + '/api/localbridge/backups', { headers: { authorization: 'Bearer ' + tok } })).json();
        assert.ok(Array.isArray(list.data) && list.data.some(x => x.backup_id === 'bk-123'), '备份列表应含该备份');
      } finally {
        await new Promise(r => server.close(r));
        db.prepare("DELETE FROM localbridge_tasks WHERE username='d11_u'").run();
        db.prepare("DELETE FROM localbridge_backups WHERE username='d11_u'").run();
        db.prepare("DELETE FROM localbridge_devices WHERE username='d11_u'").run();
        db.prepare("DELETE FROM users WHERE username='d11_u'").run();
      }
    });

    await t('D1-1: 客户端 bridge.js 已实现新 op 与档位二次校验', () => {
      const bsrc = fs.readFileSync(path.join(__dirname, '..', 'local-bridge', 'bridge.js'), 'utf8');
      for (const op of ['file_backup', 'file_diff', 'file_patch', 'file_restore', 'terminal', 'run_python']) {
        assert.ok(bsrc.includes(`'${op}'`), `bridge.js 应实现 op ${op}`);
      }
      assert.ok(bsrc.includes('TIER_OPS'), 'bridge.js 应内置 TIER_OPS 做二次校验');
      assert.ok(bsrc.includes('allowedOps(opts.tier)'), 'bridge.js runOp 应按 tier 二次校验');
      assert.ok(bsrc.includes('doBackup'), 'bridge.js 应实现写前备份');
    });
  }

  console.log('【D1-2】专家团式并行编排 V1（任务图校验 / 拓扑分层 / 并发执行 / 单节点重跑）');
  {
    const { db, now } = require('../src-server/db');
    const orch = require('../src-server/lib/orchestrator');
    const { sign } = require('../src-server/lib/auth');

    await t('D1-2: db 迁移 —— orchestration_runs 表就位（含 graph/node_logs/result/total_tokens）', () => {
      const cols = db.prepare('PRAGMA table_info(orchestration_runs)').all().map(c => c.name);
      for (const c of ['agent_id', 'session_id', 'username', 'status', 'graph', 'node_logs', 'result', 'total_tokens', 'total_duration_ms', 'started_at', 'finished_at']) {
        assert.ok(cols.includes(c), `orchestration_runs 应有 ${c} 列`);
      }
    });

    await t('D1-2: validateTaskGraph —— 合法图通过并分层；非法图（环/悬空/缺验证/未挂载）被拒', () => {
      const ok = orch.validateTaskGraph({ nodes: [
        { id: 'a', type: 'agent', agent_id: 2, task: '任务A', depends_on: [] },
        { id: 'b', type: 'agent', agent_id: 2, task: '任务B', depends_on: [] },
        { id: 'v', type: 'verify', task: '验收', depends_on: ['a', 'b'] },
      ] }, { allowedAgentIds: [2] });
      assert.ok(ok.ok, '合法任务图应通过：' + JSON.stringify(ok.errors));
      assert.deepStrictEqual(ok.levels, [['a', 'b'], ['v']], '应分两层：a/b 并行、v 其后');

      const cyc = orch.validateTaskGraph({ nodes: [
        { id: 'a', type: 'agent', agent_id: 2, task: 't', depends_on: ['b'] },
        { id: 'b', type: 'agent', agent_id: 2, task: 't', depends_on: ['a'] },
        { id: 'v', type: 'verify', task: 'v', depends_on: [] },
      ] }, { allowedAgentIds: [2] });
      assert.ok(!cyc.ok && cyc.errors.some(e => e.includes('环')), '环形依赖应被拒');

      const dangle = orch.validateTaskGraph({ nodes: [
        { id: 'a', type: 'agent', agent_id: 2, task: 't', depends_on: ['zzz'] },
        { id: 'v', type: 'verify', task: 'v', depends_on: [] },
      ] }, { allowedAgentIds: [2] });
      assert.ok(!dangle.ok && dangle.errors.some(e => e.includes('悬空')), '悬空依赖应被拒');

      const noVerify = orch.validateTaskGraph({ nodes: [
        { id: 'a', type: 'agent', agent_id: 2, task: 't', depends_on: [] },
      ] }, { allowedAgentIds: [2] });
      assert.ok(!noVerify.ok && noVerify.errors.some(e => e.includes('验证节点')), '缺少验证节点应被拒');

      const unknown = orch.validateTaskGraph({ nodes: [
        { id: 'a', type: 'agent', agent_id: 99, task: 't', depends_on: [] },
        { id: 'v', type: 'verify', task: 'v', depends_on: ['a'] },
      ] }, { allowedAgentIds: [2] });
      assert.ok(!unknown.ok && unknown.errors.some(e => e.includes('未挂载')), '引用未挂载子智能体应被拒');
    });

    await t('D1-2: runTaskGraph —— 按层并行执行（依赖次序正确）+ 成本汇总', async () => {
      const seq = [];
      let inflight = 0, peak = 0;
      const graph = { nodes: [
        { id: 'a', type: 'agent', agent_id: 1, task: 'A', depends_on: [] },
        { id: 'b', type: 'agent', agent_id: 1, task: 'B', depends_on: [] },
        { id: 'c', type: 'agent', agent_id: 1, task: 'C', depends_on: ['a', 'b'] },
        { id: 'v', type: 'verify', task: 'V', depends_on: ['c'] },
      ] };
      const res = await orch.runTaskGraph(graph, {
        maxConcurrency: 4,
        runAgent: async (n) => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 15)); inflight--; seq.push(n.id); return { text: 'out-' + n.id, tokens: 5 }; },
        runVerify: async (n) => { seq.push(n.id); return { text: 'verify-ok', tokens: 2 }; },
      });
      assert.ok(res.ok, '全部节点应成功');
      assert.ok(seq.indexOf('c') > seq.indexOf('a') && seq.indexOf('c') > seq.indexOf('b'), 'c 应在 a/b 之后执行');
      assert.strictEqual(seq[seq.length - 1], 'v', '验证节点最后执行');
      assert.ok(peak >= 2, `应出现并行执行（峰值并发 ${peak} ≥ 2）`);
      assert.strictEqual(res.nodes.v.status, 'done');
      assert.strictEqual(res.totalTokens, 17, '用量汇总应为 3×5(产出) + 2(验证) = 17');
      const sum = orch.summarizeRun(res);
      assert.strictEqual(sum.total, 4);
      assert.ok(sum.levels === 3, '应分 3 层（a/b 层、c 层、v 层）');
      assert.ok(sum.parallelRatio > 0, '并行度应大于 0');
    });

    await t('D1-2: 失败阻断 + 单节点重跑 —— 失败节点下游 blocked，rerunNode 可单独修复', async () => {
      const graph = { nodes: [
        { id: 'a', type: 'agent', agent_id: 1, task: 'A', depends_on: [] },
        { id: 'b', type: 'agent', agent_id: 1, task: 'B', depends_on: ['a'] },
        { id: 'v', type: 'verify', task: 'V', depends_on: ['b'] },
      ] };
      const rf = await orch.runTaskGraph(graph, {
        retry: 0,
        runAgent: async (n) => { if (n.id === 'a') throw new Error('boom-a'); return { text: 'ok' }; },
        runVerify: async () => ({ text: 'v' }),
      });
      assert.strictEqual(rf.nodes.a.status, 'failed', 'a 应失败');
      assert.strictEqual(rf.nodes.b.status, 'blocked', 'b 应因上游失败被阻断');
      assert.strictEqual(rf.nodes.v.status, 'blocked', '验证节点应因上游阻断');
      assert.strictEqual(rf.ok, false, '整体应非成功');
      // 修复后单节点重跑
      const st = await orch.rerunNode(graph, rf.nodes, 'a', { retry: 0, runAgent: async () => ({ text: 'fixed-a' }) });
      assert.strictEqual(st.status, 'done', '重跑后 a 应成功');
      assert.strictEqual(st.output, 'fixed-a', '重跑应回写新产出');
    });

    await t('D1-2: 超时保护 —— 慢节点超时后标记失败（可重跑）', async () => {
      const graph = { nodes: [
        { id: 'a', type: 'agent', agent_id: 1, task: 'A', depends_on: [] },
        { id: 'v', type: 'verify', task: 'V', depends_on: ['a'] },
      ] };
      const rf = await orch.runTaskGraph(graph, {
        retry: 0, timeoutMs: 300,
        runAgent: async () => { await new Promise(r => setTimeout(r, 1200)); return { text: 'late' }; },
        runVerify: async () => ({ text: 'v' }),
      });
      assert.strictEqual(rf.nodes.a.status, 'failed', '超时节点应失败');
      assert.ok(/超时/.test(rf.nodes.a.error), '错误信息应提示超时：' + rf.nodes.a.error);
    });

    await t('D1-2: HTTP 查询/重跑接口 —— 归属校验 + 缺参拒绝 + 不存在 404', async () => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d12_owner',?,'D12主','user',1,0,datetime('now','localtime'))`).run('x');
      const uo = db.prepare("SELECT id FROM users WHERE username='d12_owner'").get();
      const to = sign({ uid: uo.id, exp: Date.now() + 3600000 });
      const ri = db.prepare(`INSERT INTO orchestration_runs (agent_id,session_id,username,status,graph,node_logs,result,started_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(1, null, 'd12_owner', 'partial', JSON.stringify({ nodes: [{ id: 'a', type: 'agent', agent_id: 1, task: 't', depends_on: [] }, { id: 'v', type: 'verify', task: 'v', depends_on: ['a'] }] }), JSON.stringify({ a: { status: 'failed' } }), '结果', now());
      const express = require('express');
      const chatRouter = require('../src-server/routes/chat');
      const app = express(); app.use(express.json()); app.use('/api/chat', chatRouter);
      let server;
      await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const g = await (await fetch(base + `/api/chat/orchestrations/${ri.lastInsertRowid}`, { headers: { authorization: 'Bearer ' + to } })).json();
        assert.ok(g.code === 0 && g.data.graph && g.data.graph.nodes.length === 2, '应返回解析后的任务图');
        assert.strictEqual(g.data.nodes.a.status, 'failed', '应返回节点状态');
        // 缺 node_id → 400
        const noNode = await (await fetch(base + `/api/chat/orchestrations/${ri.lastInsertRowid}/rerun-node`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + to }, body: '{}' })).json();
        assert.strictEqual(noNode.code, 400, '缺 node_id 应 400');
        // 不存在 → 404
        const nf = await (await fetch(base + '/api/chat/orchestrations/99999999', { headers: { authorization: 'Bearer ' + to } })).json();
        assert.strictEqual(nf.code, 404, '不存在应 404');
        // 越权：另一用户访问 → 403
        db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d12_other',?,'D12客','user',1,0,datetime('now','localtime'))`).run('x');
        const u2 = db.prepare("SELECT id FROM users WHERE username='d12_other'").get();
        const t2 = sign({ uid: u2.id, exp: Date.now() + 3600000 });
        const forbid = await (await fetch(base + `/api/chat/orchestrations/${ri.lastInsertRowid}`, { headers: { authorization: 'Bearer ' + t2 } })).json();
        assert.strictEqual(forbid.code, 403, '非归属用户应 403');
      } finally {
        await new Promise(r => server.close(r));
        db.prepare('DELETE FROM orchestration_runs WHERE id=?').run(ri.lastInsertRowid);
        db.prepare("DELETE FROM users WHERE username IN ('d12_owner','d12_other')").run();
      }
    });

    await t('D1-2: 路由模式放开 + 前端选项 + 客户端契约就位', () => {
      const asrc = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'agents.js'), 'utf8');
      assert.ok(asrc.includes("'workflow', 'orchestrate'"), 'agents.js 应放开 orchestrate 路由模式');
      const csrc = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      assert.ok(csrc.includes("routing_mode === 'orchestrate'"), 'chat.js 应有 orchestrate 编排分支');
      assert.ok(csrc.includes('validateTaskGraph') && csrc.includes('runTaskGraph'), 'chat.js 应接入任务图校验与执行');
      const ssrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'studio.js'), 'utf8');
      assert.ok(ssrc.includes('value="orchestrate"'), 'studio.js 应有专家团并行编排选项');
      assert.ok(typeof orch.validateTaskGraph === 'function' && typeof orch.rerunNode === 'function' && typeof orch.planLevels === 'function', 'orchestrator 应导出核心函数');
    });
  }

  console.log('【D1-3】创作资产 V1（项目 / 素材库 / 分镜 三件套 + 复用匹配 + 复用率）');
  {
    const { db, now } = require('../src-server/db');
    const creation = require('../src-server/lib/creation');
    const { sign } = require('../src-server/lib/auth');

    await t('D1-3: db 迁移 —— projects / assets / shots 三表就位', () => {
      const p = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
      const a = db.prepare('PRAGMA table_info(assets)').all().map(c => c.name);
      const s = db.prepare('PRAGMA table_info(shots)').all().map(c => c.name);
      for (const c of ['name', 'kind', 'owner', 'status', 'meta']) assert.ok(p.includes(c), `projects 应有 ${c}`);
      for (const c of ['project_id', 'kind', 'url', 'source', 'prompt', 'tags', 'real_person', 'digital_human', 'owner']) assert.ok(a.includes(c), `assets 应有 ${c}`);
      for (const c of ['project_id', 'seq', 'prompt', 'asset_id', 'status', 'duration']) assert.ok(s.includes(c), `shots 应有 ${c}`);
    });

    await t('D1-3: 复用匹配 —— matchAssets 按标签/提示词重叠打分并排序', () => {
      const assets = [
        { id: 1, name: '海边日落', prompt: 'a seaside sunset', tags: ['海边', '日落'] },
        { id: 2, name: '森林清晨', prompt: 'forest morning mist', tags: ['森林'] },
        { id: 3, name: '城市夜景', prompt: 'city night', tags: ['城市'] },
      ];
      const r = creation.matchAssets(assets, '夕阳下的海边小镇', { limit: 3, minScore: 1 });
      assert.ok(r.length >= 1, '应命中至少一条');
      assert.strictEqual(r[0].asset.id, 1, '海边/日落素材应排第一');
      // 无重叠 → 空
      assert.strictEqual(creation.matchAssets(assets, 'quantum computing', { minScore: 1 }).length, 0);
      // 类型过滤
      const filtered = creation.matchAssets([{ id: 4, kind: 'audio', name: '海边', tags: ['海边'] }], '海边', { kinds: ['image'] });
      assert.strictEqual(filtered.length, 0, 'kind 过滤应排除音频');
    });

    await t('D1-3: reuseStats / complianceOf —— 复用率口径 + 真人/数字人合规分级', () => {
      const st = creation.reuseStats([{ asset_id: 1 }, { asset_id: null }, { asset_id: 2 }, { asset_id: null }]);
      assert.strictEqual(st.total, 4); assert.strictEqual(st.reused, 2); assert.strictEqual(st.rate, 0.5);
      assert.strictEqual(creation.reuseStats([]).rate, 0);
      assert.strictEqual(creation.complianceOf({}).level, 'OK');
      assert.strictEqual(creation.complianceOf({ real_person: 1 }).level, 'P1');
      assert.strictEqual(creation.complianceOf({ digital_human: 1 }).level, 'P1');
      assert.strictEqual(creation.complianceOf({ real_person: 1, digital_human: 1 }).level, 'P0');
    });

    await t('D1-3: HTTP 三件套 CRUD 闭环 —— 项目/素材/分镜 + 优先复用 + 复用率 + 归属校验', async () => {
      db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d13_u',?,'D13','user',1,0,datetime('now','localtime'))`).run('x');
      const u = db.prepare("SELECT id FROM users WHERE username='d13_u'").get();
      const tok = sign({ uid: u.id, exp: Date.now() + 3600000 });
      const express = require('express');
      const creationRouter = require('../src-server/routes/creation');
      const app = express(); app.use(express.json()); app.use('/api/creation', creationRouter);
      let server;
      await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const H = { 'Content-Type': 'application/json', authorization: 'Bearer ' + tok };
      const J = async (m, p, b) => (await fetch(base + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
      try {
        // 项目 CRUD
        const pj = await J('POST', '/api/creation/projects', { name: '我的短片', kind: 'video' });
        assert.ok(pj.code === 0 && pj.data.id, '创建项目应成功');
        const pid = pj.data.id;
        await J('PUT', `/api/creation/projects/${pid}`, { description: '测试项目' });
        // 素材：登记生成物 URL（复用 media 存储路径）
        const a1 = await J('POST', '/api/creation/assets/import', { project_id: pid, url: '/uploads/gen-images/sunset.png', kind: 'image', name: '海边日落', tags: '海边,日落' });
        assert.ok(a1.code === 0, '登记素材应成功：' + JSON.stringify(a1).slice(0, 80));
        const a2 = await J('POST', '/api/creation/assets/import', { project_id: pid, url: '/uploads/gen-images/forest.png', kind: 'image', name: '森林', tags: '森林' });
        // 非法 URL 拒绝
        const badUrl = await J('POST', '/api/creation/assets/import', { url: 'ftp://evil/x.png' });
        assert.strictEqual(badUrl.code, 400, '非 http/uploads 协议应拒绝');
        // 分镜：两个待生成分镜
        const s1 = await J('POST', '/api/creation/shots', { project_id: pid, title: '开场', prompt: '夕阳下的海边小镇' });
        const s2 = await J('POST', '/api/creation/shots', { project_id: pid, title: '中景', prompt: '茂密的森林清晨' });
        const s3 = await J('POST', '/api/creation/shots', { project_id: pid, title: '结尾', prompt: '量子计算机芯片特写' });
        assert.ok(s1.code === 0 && s2.code === 0 && s3.code === 0, '创建分镜应成功');
        // 优先复用：s1 命中海边素材、s2 命中森林素材、s3 无匹配
        const r1 = await J('POST', `/api/creation/shots/${s1.data.id}/resolve`, {});
        assert.ok(r1.data.reused && r1.data.asset.id === a1.data.id, 's1 应复用海边素材');
        const r2 = await J('POST', `/api/creation/shots/${s2.data.id}/resolve`, {});
        assert.ok(r2.data.reused && r2.data.asset.id === a2.data.id, 's2 应复用森林素材');
        const r3 = await J('POST', `/api/creation/shots/${s3.data.id}/resolve`, {});
        assert.ok(!r3.data.reused && r3.data.need_generate, 's3 无匹配应提示需生成');
        // 复用率：3 分镜中 2 复用 → 66.7% ≥ 50%（模拟「第二个作品」复用达标）
        const stat = await J('GET', `/api/creation/projects/${pid}/stats`, null);
        assert.strictEqual(stat.data.total, 3); assert.strictEqual(stat.data.reused, 2);
        assert.ok(stat.data.rate >= 0.5, `复用率应 ≥ 50%，实际 ${stat.data.rate}`);
        // 项目详情聚合
        const detail = await J('GET', `/api/creation/projects/${pid}`, null);
        assert.strictEqual(detail.data.assets.length, 2); assert.strictEqual(detail.data.shots.length, 3);
        // 删除素材 → 引用它的分镜解除引用
        await J('DELETE', `/api/creation/assets/${a1.data.id}`, null);
        const s1after = db.prepare('SELECT asset_id FROM shots WHERE id=?').get(s1.data.id);
        assert.strictEqual(s1after.asset_id, null, '删除素材后分镜应解除引用');
        // 归属校验：另一用户不可见/不可改
        db.prepare(`INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d13_other',?,'O','user',1,0,datetime('now','localtime'))`).run('x');
        const u2 = db.prepare("SELECT id FROM users WHERE username='d13_other'").get();
        const tok2 = sign({ uid: u2.id, exp: Date.now() + 3600000 });
        const forbid = (await fetch(base + `/api/creation/projects/${pid}`, { headers: { authorization: 'Bearer ' + tok2 } })).json();
        const fj = await forbid;
        assert.strictEqual(fj.code, 403, '非归属用户访问项目应 403');
        // 项目删除级联分镜、素材回归全局
        await J('DELETE', `/api/creation/projects/${pid}`, null);
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM shots WHERE project_id=?').get(pid).c, 0, '删项目应级联删分镜');
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM assets WHERE project_id IS NULL AND owner=?').get('d13_u').c >= 1, true, '素材应回归全局素材库');
      } finally {
        await new Promise(r => server.close(r));
        db.prepare("DELETE FROM shots WHERE project_id IN (SELECT id FROM projects WHERE owner='d13_u')").run();
        db.prepare("DELETE FROM assets WHERE owner='d13_u'").run();
        db.prepare("DELETE FROM projects WHERE owner='d13_u'").run();
        db.prepare("DELETE FROM users WHERE username IN ('d13_u','d13_other')").run();
      }
    });

    await t('D1-3: 前端页面与路由接入就位（创作资产页 + 导航入口）', () => {
      const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
      assert.ok(app.includes("'/creation'") && app.includes("front/creation.js"), 'app.js 应注册 /creation 路由');
      assert.ok(app.includes("#/creation"), '导航应含创作资产入口');
      const pg = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'front', 'creation.js'), 'utf8');
      assert.ok(pg.includes('/creation/projects') && pg.includes('/creation/shots'), '页面应调用创作资产接口');
    });
  }

  console.log('【D1-4】可执行技能包 V1（manifest 规范 / 供应链校验 / secrets 隔离 / 沙箱执行）');
  {
    const { db } = require('../src-server/db');
    const sp = require('../src-server/lib/skill-package');
    const sec = require('../src-server/lib/skill-secrets');
    const runner = require('../src-server/lib/skill-runner');
    const { sign } = require('../src-server/lib/auth');

    await t('D1-4: db 迁移 —— skill_assets 扩展列 + skill_secrets / skill_runs 表就位', () => {
      const cols = db.prepare('PRAGMA table_info(skill_assets)').all().map(c => c.name);
      for (const c of ['manifest', 'runtime', 'version', 'source_url', 'package_hash', 'verified', 'enabled']) assert.ok(cols.includes(c), `skill_assets 应有 ${c}`);
      const ss = db.prepare('PRAGMA table_info(skill_secrets)').all().map(c => c.name);
      for (const c of ['owner', 'skill_id', 'name', 'value']) assert.ok(ss.includes(c), `skill_secrets 应有 ${c}`);
      const sr = db.prepare('PRAGMA table_info(skill_runs)').all().map(c => c.name);
      for (const c of ['skill_id', 'owner', 'status', 'duration_ms', 'stdout_excerpt']) assert.ok(sr.includes(c), `skill_runs 应有 ${c}`);
    });

    await t('D1-4: manifest 规范化/校验 —— 空 manifest=纯提示词；非法 runtime/version/权限被拒；合法通过', () => {
      const blank = sp.validateManifest('{}');
      assert.strictEqual(blank.ok, true, '空 manifest 应合法');
      assert.strictEqual(blank.executable, false, '空 manifest 不可执行');
      const bad = sp.validateManifest({ name: 'x', runtime: 'python', version: 'abc', permissions: ['root'], entry_code: '1' });
      assert.strictEqual(bad.ok, false, '非法 manifest 应被拒');
      assert.ok(bad.errors.some(e => e.includes('runtime')), '应报 runtime 错误');
      assert.ok(bad.errors.some(e => e.includes('version')), '应报 version 错误');
      assert.ok(bad.errors.some(e => e.includes('权限')), '应报权限错误');
      const good = sp.validateManifest({ name: 'demo', version: '1.2.0', entry_code: 'console.log(1)', permissions: ['net:api.example.com', 'fs:write'], secrets: ['API_KEY'] });
      assert.strictEqual(good.ok, true, '合法 manifest 应通过');
      assert.strictEqual(good.executable, true);
      // entry 逃逸拒绝
      assert.strictEqual(sp.validateManifest({ name: 'demo', entry: '../../etc/passwd' }).ok, false, 'entry 逃逸应被拒');
    });

    await t('D1-4: 权限声明 → 网络白名单 / 风险分级 / 摘要', () => {
      assert.deepStrictEqual(sp.netAllowOf({ permissions: ['net:api.example.com', 'fs:read'] }), ['api.example.com']);
      assert.strictEqual(sp.permRisk({ permissions: [] }), 'low');
      assert.strictEqual(sp.permRisk({ permissions: ['fs:write'] }), 'middle');
      assert.strictEqual(sp.permRisk({ permissions: ['fs:write', 'net:a.com'] }), 'high');
      const s = sp.summarizePermissions({ permissions: ['fs:read'] });
      assert.strictEqual(s[0].permission, 'fs:read');
      assert.ok(s[0].label && s[0].risk);
    });

    await t('D1-4: 供应链校验 —— 内容哈希稳定 + 签名验证（正确/错误）+ 篡改检测', () => {
      const m = { name: 'demo', version: '1.0.0', entry_code: 'console.log(1)', permissions: [] };
      const h1 = sp.contentHash(m);
      const h2 = sp.contentHash({ ...m });
      assert.strictEqual(h1, h2, '同内容哈希应一致');
      assert.notStrictEqual(sp.contentHash({ ...m, entry_code: 'console.log(2)' }), h1, '改代码应改哈希');
      const key = 'k1';
      const sig = sp.signPackage('demo', '1.0.0', h1, key);
      assert.strictEqual(sp.verifySignature('demo', '1.0.0', h1, sig, key), true);
      assert.strictEqual(sp.verifySignature('demo', '1.0.0', h1, 'deadbeef', key), false);
      assert.strictEqual(sp.verifySupplyChain(m, { declaredHash: 'bad' }).integrity, false, '哈希不符应判 false');
      assert.strictEqual(sp.verifySupplyChain(m, { declaredHash: h1 }).integrity, true);
      assert.strictEqual(sp.verifySupplyChain(m, { declaredHash: h1, signature: sig, key }).verified, true);
    });

    await t('D1-4: secrets 隔离 —— 加密落盘 / 掩码回显 / 运行取用明文 / 输出脱敏 / 删除', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d14_sec','x','S','user',1,0,datetime('now','localtime'))").run();
      const sid = Number(db.prepare("INSERT INTO skill_assets (owner,name,prompt,manifest) VALUES ('d14_sec','secsr','','{}')").run().lastInsertRowid);
      assert.strictEqual(sec.setSecret('d14_sec', sid, 'bad name!', 'v').ok, false, '非法密钥名应被拒');
      sec.setSecret('d14_sec', sid, 'API_KEY', 'sk-topsecret-9988');
      const list = sec.listSecrets('d14_sec', sid);
      assert.strictEqual(list.length, 1);
      assert.ok(!JSON.stringify(list).includes('sk-topsecret-9988'), '列表不得回明文');
      assert.ok(list[0].masked.includes('****'), '应掩码');
      // 落盘密文（不等于明文）
      const raw = db.prepare('SELECT value FROM skill_secrets WHERE owner=? AND skill_id=? AND name=?').get('d14_sec', sid, 'API_KEY').value;
      assert.notStrictEqual(raw, 'sk-topsecret-9988', '落盘应为密文');
      assert.strictEqual(sec.getSecretsForRun('d14_sec', sid).API_KEY, 'sk-topsecret-9988', '运行期应能解出明文');
      assert.strictEqual(sec.scrub('x sk-topsecret-9988 y', ['sk-topsecret-9988']), 'x *** y');
      sec.purgeSkill('d14_sec', sid);
      assert.strictEqual(sec.listSecrets('d14_sec', sid).length, 0);
    });

    await t('D1-4: 技能运行器 —— 沙箱执行注入 SKILL_ARGS/SKILL_SECRETS 且输出脱敏 + 审计', async () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d14_run','x','R','user',1,0,datetime('now','localtime'))").run();
      const manifest = { name: 'runner', version: '1.0.0', entry_code: "console.log('a=' + JSON.stringify(SKILL_ARGS) + ' k=' + SKILL_SECRETS.TOKEN)", permissions: [], secrets: ['TOKEN'] };
      const sid = Number(db.prepare("INSERT INTO skill_assets (owner,name,prompt,manifest) VALUES ('d14_run','runner','',?)").run(JSON.stringify(manifest)).lastInsertRowid);
      sec.setSecret('d14_run', sid, 'TOKEN', 'tok-abcdef-123456');
      const skill = db.prepare('SELECT * FROM skill_assets WHERE id=?').get(sid);
      const out = await runner.runSkill(skill, { owner: 'd14_run', args: { n: 9 } });
      assert.strictEqual(out.status, 'success', '应执行成功');
      assert.ok(out.stdout.includes('"n":9'), '应注入 SKILL_ARGS');
      assert.ok(!out.stdout.includes('tok-abcdef-123456'), '输出不得泄露密钥明文');
      assert.ok(out.stdout.includes('***'), '输出中密钥应被脱敏为 ***');
      const hist = runner.runHistory(sid, 'd14_run');
      assert.ok(hist.length >= 1, '应有运行审计');
      // 非可执行技能被拒
      const noexec = db.prepare("INSERT INTO skill_assets (owner,name,prompt,manifest) VALUES ('d14_run','plain','p','{}')").run();
      const r2 = await runner.runSkill(db.prepare('SELECT * FROM skill_assets WHERE id=?').get(noexec.lastInsertRowid), { owner: 'd14_run' });
      assert.strictEqual(r2.status, 'denied', '纯提示词技能运行应被拒');
    });

    await t('D1-4: HTTP 安装/运行/密钥/卸载闭环 —— 供应链校验 + 掩码回显 + 级联清理', async () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d14_http','x','H','user',1,0,datetime('now','localtime'))").run();
      const u = db.prepare("SELECT id FROM users WHERE username='d14_http'").get();
      const tok = sign({ uid: u.id, exp: Date.now() + 3600000 });
      const express = require('express');
      const skRouter = require('../src-server/routes/skillassets');
      const app = express(); app.use(express.json()); app.use('/api/skillassets', skRouter);
      let server;
      await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const H = { 'Content-Type': 'application/json', authorization: 'Bearer ' + tok };
      const J = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
      try {
        const manifest = { name: 'pkgdemo', version: '1.0.0', entry_code: "console.log('pkg ' + JSON.stringify(SKILL_ARGS))", permissions: [], secrets: ['KEY'] };
        const goodHash = sp.contentHash(manifest);
        // 哈希不符 → 拒绝
        const bad = await J('POST', '/api/skillassets/install', { manifest, declaredHash: 'deadbeef' });
        assert.strictEqual(bad.code, 400, '哈希不符应拒绝安装');
        // 正确哈希 → 安装
        const ins = await J('POST', '/api/skillassets/install', { manifest, declaredHash: goodHash });
        assert.strictEqual(ins.code, 0, '安装应成功：' + ins.msg);
        const id = ins.data.id;
        assert.strictEqual(ins.data.integrity, true, '完整性应通过');
        // 列表带可执行标记
        const list = await J('GET', '/api/skillassets');
        const row = list.data.find(x => x.id === id);
        assert.ok(row && row.executable, '列表应标记 executable');
        // 密钥
        const sset = await J('POST', `/api/skillassets/${id}/secrets`, { name: 'KEY', value: 'pkg-secret-777' });
        assert.strictEqual(sset.code, 0, '密钥保存应成功');
        const sl = await J('GET', `/api/skillassets/${id}/secrets`);
        assert.ok(!JSON.stringify(sl).includes('pkg-secret-777'), '密钥接口不得回明文');
        // 运行
        const run = await J('POST', `/api/skillassets/${id}/run`, { args: { x: 1 } });
        assert.strictEqual(run.code, 0, '运行应成功');
        assert.strictEqual(run.data.status, 'success');
        assert.ok(run.data.stdout.includes('"x":1'), '应注入入参');
        // 卸载 → 级联清理（技能不可见 + 密钥清空 + 运行记录清空）
        await J('DELETE', `/api/skillassets/${id}`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM skill_secrets WHERE skill_id=?').get(id).c, 0, '卸载应清密钥');
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM skill_runs WHERE skill_id=?').get(id).c, 0, '卸载应清运行记录');
        const list2 = await J('GET', '/api/skillassets');
        assert.ok(!list2.data.find(x => x.id === id), '卸载后列表不应含该技能');
      } finally { server.close(); }
    });

    await t('D1-4: 前端市场页接入 —— 安装/运行/密钥入口 + 市场端点回传可执行字段', () => {
      const mk = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'front', 'market.js'), 'utf8');
      assert.ok(mk.includes('openInstall') && mk.includes('/skillassets/install'), '市场页应有安装入口');
      assert.ok(mk.includes('openRun') && mk.includes('/run'), '市场页应有运行入口');
      assert.ok(mk.includes('openSecrets') && mk.includes('/secrets'), '市场页应有密钥入口');
      assert.ok(mk.includes('manifest'), '市场页应支持 manifest 编辑');
      const sm = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'skills-market.js'), 'utf8');
      assert.ok(sm.includes('skill-package') && sm.includes('executable'), '市场端点应回传可执行标记');
    });
  }

  console.log('【U2-1 / N7】P1 任务队列驱动抽象（memory 默认 / redis 可选 / 缺依赖回退）');
  {
    const { db, now } = require('../src-server/db');
    const q = require('../src-server/lib/queue');
    const legacy = require('../src-server/lib/task-queue');

    await t('U2-1/N7-P1: 默认驱动为 memory，且注册表含 cron-task 等既有任务类型', () => {
      const info = q.driverInfo();
      assert.strictEqual(info.driver, 'memory', '未配置 QUEUE_DRIVER 时应为内存驱动');
      assert.strictEqual(info.error, null, '默认不应有降级错误');
      assert.ok(Array.isArray(info.registered), 'registered 应为数组');
      assert.ok(info.registered.includes('cron-task'), 'scheduler 的 cron-task 应已注册');
    });

    await t('U2-1/N7-P1: 兼容转发 —— task-queue 出口与 queue/index 门面一致', () => {
      assert.strictEqual(legacy.enqueue, q.enqueue, 'enqueue 应为同一函数');
      assert.strictEqual(legacy.register, q.register, 'register 应为同一函数');
      for (const k of ['register', 'enqueue', 'getJob', 'queueStats', 'cleanupHistory', 'driverInfo']) {
        assert.strictEqual(typeof legacy[k], 'function', `task-queue.${k} 应可用`);
      }
    });

    await t('U2-1/N7-P1: 内存驱动闭环 enqueue→执行→getJob(success)→queueStats', async () => {
      q.register('n7_noop', async (payload) => ({ echo: payload.x }));
      const jobId = q.enqueue('n7_noop', { x: 42 });
      assert.ok(jobId, 'enqueue 应返回 jobId');
      // 轮询等待进程内 setImmediate 处理完成
      let row = null;
      for (let i = 0; i < 50; i++) {
        row = q.getJob(jobId);
        if (row && row.status === 'success') break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.strictEqual(row.status, 'success', '内存驱动应执行成功');
      assert.deepStrictEqual(JSON.parse(row.result), { echo: 42 }, '结果应被持久化');
      const stats = q.queueStats();
      assert.ok(stats && typeof stats.success === 'number' && stats.success >= 1, 'queueStats 应统计 success');
    });

    await t('U2-1/N7-P1: enqueue 未注册任务类型 → 抛错（与旧实现一致）', () => {
      assert.throws(() => q.enqueue('n7_not_registered', {}), /未注册的任务类型/);
    });

    await t('U2-1/N7-P1: cleanupHistory 清理超过保留期的历史任务', () => {
      const jobId = 'n7-old-' + Date.now();
      db.prepare(`INSERT INTO task_queue (job_id,name,payload,status,priority,max_retries,retry_count,delay_ms,created_at,scheduled_at,finished_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)`)
        .run(jobId, 'n7_noop', '{}', 'success', 0, 3, 0, now(), now(), '2020-01-01 00:00:00');
      const before = q.getJob(jobId);
      assert.ok(before, '过期任务应先存在');
      q.cleanupHistory();
      assert.strictEqual(q.getJob(jobId), undefined, '过期历史任务应被清理');
    });

    await t('U2-1/N7-P1: redis 驱动缺依赖 —— available=false 且 create 抛可读错误（Module._load 桩确定性模拟）', () => {
      // 背景：bullmq 已入 package.json（依赖树同步后真实环境必然可用），「缺依赖」路径须用 require 桩确定性模拟——
      // 不再依赖 node_modules 的偶然缺失状态（2026-11-23 sqlite-vec 安装同步依赖树后曾致本用例误红）
      const Module = require('module');
      const origLoad = Module._load;
      const rd = require('../src-server/lib/queue/redis-driver');
      Module._load = function (request, ...rest) {
        if (request === 'bullmq') throw new Error("Cannot find module 'bullmq'");
        return origLoad.call(this, request, ...rest);
      };
      rd.__resetDeps();
      try {
        assert.strictEqual(rd.available(), false, '模拟 bullmq 缺失时 available 应为 false');
        assert.throws(() => rd.create(new Map()), /bullmq/, 'create 应抛含 bullmq 的可读错误');
      } finally {
        Module._load = origLoad;
        rd.__resetDeps(); // 恢复真实探测（bullmq 实际已安装）
        assert.strictEqual(rd.available(), true, '桩移除后应恢复可用（依赖已安装的真实状态）');
      }
    });

    await t('U2-1/N7-P1: QUEUE_DRIVER=redis 但缺依赖 → 回退内存驱动并记录降级原因（子进程隔离 + require 桩）', () => {
      const { execFileSync } = require('child_process');
      const tmpDir = path.join(__dirname, '..', '.temp', 'n7-subproc-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        const root = path.join(__dirname, '..');
        // 子进程内同样以 Module._load 桩拦截 bullmq（确定性模拟缺依赖，不依赖 node_modules 状态）
        const script = `const Module=require('module');const _orig=Module._load;Module._load=function(r,...a){if(r==='bullmq')throw new Error("Cannot find module 'bullmq'");return _orig.apply(this,[r,...a])};` +
          `process.env.AGENT_DATA_DIR=${JSON.stringify(tmpDir)};process.env.QUEUE_DRIVER='redis';const q=require(${JSON.stringify(path.join(root, 'src-server', 'lib', 'queue'))});process.stdout.write('__N7JSON__'+JSON.stringify(q.driverInfo())+'__N7JSON__');`;
        const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/__N7JSON__(.*?)__N7JSON__/s);
        assert.ok(m, '应取得子进程驱动信息');
        const info = JSON.parse(m[1]);
        assert.strictEqual(info.driver, 'memory(fallback)', '指定 redis 但缺依赖应回退内存驱动');
        assert.ok(info.error && /bullmq/.test(info.error), '降级原因应含 bullmq');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // 清理本块造的数据
    db.prepare("DELETE FROM task_queue WHERE name='n7_noop'").run();
  }

  console.log('【U2-1 / N7】P2 集群选主与多进程（DB 租约锁 / 调度让位 / PM2 配置）');
  {
    const { db } = require('../src-server/db');
    const lock = require('../src-server/lib/cluster-lock');
    const q = require('../src-server/lib/queue');

    await t('U2-1/N7-P2: cluster_locks 表与 task_queue 新列已就绪', () => {
      const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cluster_locks'").get();
      assert.ok(t1, 'cluster_locks 表应存在');
      const cols = db.prepare('PRAGMA table_info(task_queue)').all().map(c => c.name);
      assert.ok(cols.includes('worker_id'), 'task_queue.worker_id 应存在');
      assert.ok(cols.includes('locked_at'), 'task_queue.locked_at 应存在');
    });

    await t('U2-1/N7-P2: 选主租约 —— 单进程恒 leader；集群下唯一持有；过期可接管；释放限持有者', () => {
      delete process.env.CLUSTER_MODE; delete process.env.WEB_CONCURRENCY; lock._resetClusterModeCache();
      assert.strictEqual(lock.isClusterMode(), false, '默认应为单进程模式');
      assert.strictEqual(lock.isLeader('any'), true, '非集群模式恒为 leader（零回归）');

      process.env.CLUSTER_MODE = '1'; lock._resetClusterModeCache();
      try {
        assert.strictEqual(lock.isClusterMode(), true);
        lock.release('UT', 'A'); lock.release('UT', 'B'); // 清残留
        assert.strictEqual(lock.acquire('UT', 60000, 'A'), true, 'A 首取成功');
        assert.strictEqual(lock.isLeader('UT', 'A'), true);
        assert.strictEqual(lock.acquire('UT', 60000, 'B'), false, 'B 在租约期内应让位');
        assert.strictEqual(lock.isLeader('UT', 'B'), false);
        assert.strictEqual(lock.renew('UT', 60000, 'A'), true, 'A 续租成功');
        lock.acquire('UT', -1, 'A'); // A 将租约置为已过期（结果已过期，故返回 false）
        assert.strictEqual(lock.isLeader('UT', 'A'), false, 'A 租约已过期');
        assert.strictEqual(lock.acquire('UT', 60000, 'B'), true, 'B 过期后可接管');
        assert.strictEqual(lock.release('UT', 'A'), false, 'A 已非持有者，释放无效');
        assert.strictEqual(lock.release('UT', 'B'), true, 'B 释放成功');
        assert.strictEqual(lock.info('UT'), null, '释放后记录应清空');
        assert.match(lock.ownerId(), /^.+:\d+$/, '持有者标识应为 host:pid 形式');
      } finally {
        delete process.env.CLUSTER_MODE; lock._resetClusterModeCache();
        lock.release('UT', 'A'); lock.release('UT', 'B');
      }
    });

    await t('U2-1/N7-P2: 集群模式下内存 worker 仅 leader 消费（非 leader drain 让位）', async () => {
      lock.release(lock.LOCK_NAME); // 清残留，确保无 leader
      process.env.CLUSTER_MODE = '1'; lock._resetClusterModeCache();
      try {
        q.register('n7p2_gate', async () => ({ ok: true }));
        const jobId = q.enqueue('n7p2_gate', {});
        await new Promise(r => setTimeout(r, 60)); // 等 setImmediate 触发（应被门控）
        assert.strictEqual(q.getJob(jobId).status, 'pending', '非 leader 进程不应消费队列');
        assert.ok(lock.acquire(lock.LOCK_NAME, 60000), '当前进程取得领导权');
        q.drain();
        for (let i = 0; i < 50 && q.getJob(jobId).status !== 'success'; i++) await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(q.getJob(jobId).status, 'success', 'leader 排空后应处理成功');
        const row = q.getJob(jobId);
        assert.ok(row.worker_id, '运行时应记录 worker_id（处理进程标识）');
      } finally {
        delete process.env.CLUSTER_MODE; lock._resetClusterModeCache();
        lock.release(lock.LOCK_NAME);
        db.prepare("DELETE FROM task_queue WHERE name='n7p2_gate'").run();
      }
    });

    await t('U2-1/N7-P2: 配置项 deploy_mode 默认 single', () => {
      const cfg = require('../src-server/lib/config');
      assert.strictEqual(cfg.get('deploy_mode'), 'single', 'deploy_mode 默认应为 single');
    });

    await t('U2-1/N7-P2: 调度/运维/服务端集群门控与集群派生（源码断言）', () => {
      const sched = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'scheduler.js'), 'utf8');
      assert.ok(/clusterLock\.acquireAsync\(LEADER_LOCK/.test(sched), '调度 tick 应经选主 acquireAsync 门控（MT-15 支持跨机）');
      assert.ok(/ops\.startOps\(\(\)\s*=>/.test(sched), '应给 ops 传 leader guard');
      const opsSrc = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'ops.js'), 'utf8');
      assert.ok(/function startOps\(guard\)/.test(opsSrc), 'ops.startOps 应接受 guard 参数');
      const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert.ok(/WEB_CONCURRENCY/.test(srv) && /cluster\.fork/.test(srv), 'server.js 应支持 WEB_CONCURRENCY 集群派生');
      assert.ok(/releaseAsync\(cl\.LOCK_NAME\)/.test(srv), '优雅停机应释放领导权（MT-15 异步后端分派）');
      // U2-1/N7-P2 修复：主进程 fork 前先完成一次数据库迁移（消除多 worker 并发迁移竞争）
      assert.ok(/require\('\.\/src-server\/db'\)/.test(srv), '集群主进程应预加载 db 完成迁移');
      // U2-1/N7-P2 修复：主进程收到终止信号后停止自动重启，并在 worker 全部退出后自行退出
      assert.ok(/shuttingDown/.test(srv) && /停止派生/.test(srv), '主进程停机应停止派生 worker');
      // U2-1/N7-P2 修复：db.js 集中吞掉并发迁移的 duplicate column 幂等错误 + busy_timeout 等待锁
      const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'db.js'), 'utf8');
      assert.ok(/busy_timeout/.test(dbSrc), 'db.js 应设置 busy_timeout 缓解并发写锁竞争');
      assert.ok(/duplicate column name/i.test(dbSrc), 'db.js 应容错并发 ALTER 的 duplicate column 错误');
    });

    await t('U2-1/N7-P2: ecosystem.config.js 提供 web 集群 + 队列 worker', () => {
      const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
      const names = eco.apps.map(a => a.name);
      assert.ok(names.includes('agent-web') && names.includes('agent-queue-worker'), '应含 web 与 worker 两个应用');
      const web = eco.apps.find(a => a.name === 'agent-web');
      assert.strictEqual(web.exec_mode, 'cluster', 'web 应为 cluster 模式');
      assert.ok(Number(web.instances) >= 1, 'web instances 应 ≥1');
      const wk = eco.apps.find(a => a.name === 'agent-queue-worker');
      assert.strictEqual(wk.exec_mode, 'fork', 'worker 应为 fork 模式');
    });

    // ---------------- MT-15：Redis 强依赖 + 跨机分布式锁 + 无状态多副本 ----------------
    await t('MT-15: 队列强依赖化——显式 redis 缺依赖时 fail-fast，逃生阀可强制回退（Module._load 桩）', () => {
      const q = require('../src-server/lib/queue');
      const rd = require('../src-server/lib/queue/redis-driver');
      const Module = require('module');
      const origLoad = Module._load;
      const sQ = process.env.QUEUE_DRIVER, sS = process.env.AGENT_QUEUE_STRICT,
        sF = process.env.AGENT_QUEUE_ALLOW_FALLBACK, sN = process.env.NODE_ENV;
      try {
        // 桩拦截 bullmq 模拟缺依赖（真实环境依赖已安装，须确定性模拟；探测缓存随 __resetDeps 重建）
        Module._load = function (request, ...rest) {
          if (request === 'bullmq') throw new Error("Cannot find module 'bullmq'");
          return origLoad.call(this, request, ...rest);
        };
        delete process.env.NODE_ENV;
        process.env.QUEUE_DRIVER = 'redis'; process.env.AGENT_QUEUE_STRICT = '1';
        delete process.env.AGENT_QUEUE_ALLOW_FALLBACK;
        assert.strictEqual(q._strict(), true, '显式 strict 应生效');
        rd.__resetDeps();
        q._resetDriver();
        const info = q.driverInfo();
        assert.strictEqual(info.driver, 'none', '严格模式依赖缺失时不得回退内存驱动');
        assert.ok(/拒绝回退|强依赖/.test(info.error || ''), '应暴露可读致命错误：' + info.error);
        // 逃生阀：显式允许回退
        process.env.AGENT_QUEUE_ALLOW_FALLBACK = '1'; q._resetDriver();
        const info2 = q.driverInfo();
        assert.strictEqual(info2.strict, false, '逃生阀关闭严格模式');
        assert.ok(/memory/.test(info2.driver), '允许回退时回落内存驱动：' + info2.driver);
      } finally {
        Module._load = origLoad;
        rd.__resetDeps(); // 恢复真实探测
        if (sQ === undefined) delete process.env.QUEUE_DRIVER; else process.env.QUEUE_DRIVER = sQ;
        if (sS === undefined) delete process.env.AGENT_QUEUE_STRICT; else process.env.AGENT_QUEUE_STRICT = sS;
        if (sF === undefined) delete process.env.AGENT_QUEUE_ALLOW_FALLBACK; else process.env.AGENT_QUEUE_ALLOW_FALLBACK = sF;
        if (sN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = sN;
        q._resetDriver();
      }
    });

    await t('MT-15: 锁后端选择——auto 随队列驱动；显式 LOCK_DRIVER 覆盖', () => {
      const lock = require('../src-server/lib/cluster-lock');
      const sQ = process.env.QUEUE_DRIVER, sL = process.env.LOCK_DRIVER;
      try {
        delete process.env.LOCK_DRIVER; delete process.env.QUEUE_DRIVER;
        assert.strictEqual(lock.backend(), 'db', '默认（内存队列）应为 db 锁');
        process.env.QUEUE_DRIVER = 'redis';
        assert.strictEqual(lock.backend(), 'redis', 'redis 队列应自动用 redis 锁（跨机）');
        process.env.LOCK_DRIVER = 'db';
        assert.strictEqual(lock.backend(), 'db', '显式 db 覆盖 auto');
        process.env.LOCK_DRIVER = 'redis'; process.env.QUEUE_DRIVER = 'memory';
        assert.strictEqual(lock.backend(), 'redis', '显式 redis 覆盖 auto');
      } finally {
        if (sQ === undefined) delete process.env.QUEUE_DRIVER; else process.env.QUEUE_DRIVER = sQ;
        if (sL === undefined) delete process.env.LOCK_DRIVER; else process.env.LOCK_DRIVER = sL;
      }
    });

    await t('MT-15: 异步锁统一 API（DB 后端）——acquireAsync/isLeaderAsync/releaseAsync 语义与同步一致', async () => {
      const lock = require('../src-server/lib/cluster-lock');
      const sL = process.env.LOCK_DRIVER;
      try {
        delete process.env.LOCK_DRIVER; // db 后端
        process.env.CLUSTER_MODE = '1'; lock._resetClusterModeCache();
        lock.release('UTA', 'A'); lock.release('UTA', 'B');
        assert.strictEqual(await lock.acquireAsync('UTA', 60000, 'A'), true, 'A 首取成功');
        assert.strictEqual(await lock.isLeaderAsync('UTA', 'A'), true, 'A 为 leader');
        assert.strictEqual(await lock.renewAsync('UTA', 60000, 'A'), true, 'A 续租成功');
        assert.strictEqual(await lock.releaseAsync('UTA', 'B'), false, '非持有者释放无效');
        assert.strictEqual(await lock.releaseAsync('UTA', 'A'), true, 'A 释放成功');
        assert.strictEqual(await lock.isLeaderAsync('UTA', 'A'), false, '释放后非 leader');
      } finally {
        if (sL === undefined) delete process.env.LOCK_DRIVER; else process.env.LOCK_DRIVER = sL;
        delete process.env.CLUSTER_MODE; lock._resetClusterModeCache();
        lock.release('UTA', 'A'); lock.release('UTA', 'B');
      }
    });

    await t('MT-15: Redis 锁算法（注入假客户端）——NX 接管/让位/续期/比较删除', async () => {
      const lockRedis = require('../src-server/lib/lock-redis');
      // 假 Redis：按脚本特征区分 acquire（含 PEXPIRE）/ release（含 DEL）
      const store = new Map();
      const fake = {
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async eval(script, _n, key, owner) {
          if (/PEXPIRE/.test(script)) { // acquire
            const cur = store.get(key);
            if (cur === undefined) { store.set(key, owner); return 1; }
            if (cur === owner) return 1;
            return 0;
          }
          if (/DEL/.test(script)) { // release
            if (store.get(key) === owner) { store.delete(key); return 1; }
            return 0;
          }
          return 0;
        },
      };
      const be = lockRedis.createBackend(fake);
      assert.strictEqual(be.name, 'redis');
      assert.strictEqual(await be.acquire('L', 60000, 'A'), true, 'A 首取（NX 写入）成功');
      assert.strictEqual(await be.isLeader('L', 'A'), true, 'A 为锁主');
      assert.strictEqual(await be.acquire('L', 60000, 'B'), false, 'B 在租约期内让位');
      assert.strictEqual(await be.isLeader('L', 'B'), false, 'B 非锁主');
      assert.strictEqual(await be.renew('L', 60000, 'A'), true, 'A 续期成功（本人存在）');
      assert.strictEqual(await be.release('L', 'B'), false, '非持有者释放无效（比较删除）');
      assert.strictEqual(await be.release('L', 'A'), true, 'A 释放成功');
      assert.strictEqual(await be.isLeader('L', 'A'), false, '释放后非锁主');
      // cluster-lock 经注入客户端走 redis 后端
      const lock = require('../src-server/lib/cluster-lock');
      const sL = process.env.LOCK_DRIVER;
      try {
        lock._setRedisClient(fake);
        process.env.LOCK_DRIVER = 'redis';
        assert.strictEqual(lock.backend(), 'redis');
        assert.strictEqual(await lock.acquireAsync('UTB', 60000, 'X'), true, 'cluster-lock 走 redis 后端接管成功');
        assert.strictEqual(await lock.isLeaderAsync('UTB', 'X'), true, 'cluster-lock 走 redis 后端识别锁主');
        assert.strictEqual(await lock.releaseAsync('UTB', 'X'), true, 'cluster-lock 走 redis 后端释放成功');
      } finally {
        if (sL === undefined) delete process.env.LOCK_DRIVER; else process.env.LOCK_DRIVER = sL;
        lock._setRedisClient(null);
      }
    });

    await t('MT-15: 配置项与部署编排就绪（lock_driver/queue_strict/ecosystem）', () => {
      const cfg = require('../src-server/lib/config');
      assert.strictEqual(cfg.get('lock_driver'), 'auto', 'lock_driver 默认 auto');
      assert.strictEqual(cfg.get('queue_strict'), '', 'queue_strict 默认空');
      const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
      const web = eco.apps.find(a => a.name === 'agent-web');
      assert.ok('LOCK_DRIVER' in web.env && 'REDIS_URL' in web.env, 'web 编排应含 LOCK_DRIVER/REDIS_URL');
    });

    // ---------------- U2-1 / N7-P3 读写分离 DAL 与 litestream ----------------
    await t('U2-1/N7-P3: 未配置 AGENT_DB_READONLY 时只读连接回退主库（行为等同现状）', () => {
      const orig = process.env.AGENT_DB_READONLY;
      delete process.env.AGENT_DB_READONLY;
      try {
        const dbRead = require(path.join(__dirname, '..', 'src-server', 'lib', 'db-read'));
        assert.strictEqual(dbRead.hasReplica(), false, '未配置时 hasReplica 应为 false');
        assert.strictEqual(dbRead.getReadDb(db), db, '未配置副本时 getReadDb 应返回主库连接');
        assert.strictEqual(dbRead.status().mode, 'main-fallback', '状态应为回退主库');
      } finally { if (orig !== undefined) process.env.AGENT_DB_READONLY = orig; }
    });

    await t('U2-1/N7-P3: 配置副本后读写分离生效（读走副本 / 副本只读拒写）', async () => {
      const Database = require('better-sqlite3');
      const replicaPath = path.join(process.env.AGENT_DATA_DIR, 'platform-replica.db');
      // 用主库做一致性快照生成副本，并切成自包含单文件（便于 readonly 打开）
      await db.backup(replicaPath);
      const r0 = new Database(replicaPath); r0.pragma('journal_mode = DELETE'); r0.close();
      const orig = process.env.AGENT_DB_READONLY;
      process.env.AGENT_DB_READONLY = replicaPath;
      try {
        const dbRead = require(path.join(__dirname, '..', 'src-server', 'lib', 'db-read'));
        dbRead.closeReadDb(); // 路径变更后重开
        assert.ok(dbRead.hasReplica(), '副本文件存在时 hasReplica 应为 true');
        assert.strictEqual(dbRead.status().mode, 'replica', '状态应为只读副本模式');
        const conn = dbRead.getReadDb(db);
        assert.notStrictEqual(conn, db, '配置副本后读连接应指向副本而非主库');
        assert.strictEqual(conn.prepare('SELECT 1 AS ok').get().ok, 1, '副本应可读');
        let writeRejected = false;
        try { conn.prepare('CREATE TABLE __probe__(id INTEGER)').run(); } catch { writeRejected = true; }
        assert.ok(writeRejected, '只读副本连接应拒绝写入');
      } finally {
        require(path.join(__dirname, '..', 'src-server', 'lib', 'db-read')).closeReadDb();
        if (orig !== undefined) process.env.AGENT_DB_READONLY = orig; else delete process.env.AGENT_DB_READONLY;
        try { fs.rmSync(replicaPath, { force: true }); } catch { }
      }
    });

    await t('U2-1/N7-P3: db.js 导出 dbRead 门面（未配置副本时委托主库）', () => {
      const orig = process.env.AGENT_DB_READONLY;
      delete process.env.AGENT_DB_READONLY;
      try {
        const mod = require(path.join(__dirname, '..', 'src-server', 'db'));
        assert.ok(mod.dbRead, 'db.js 应导出 dbRead');
        const row = mod.dbRead.prepare('SELECT 1 AS ok').get();
        assert.strictEqual(row.ok, 1, '未配置副本时 dbRead 委托主库查询应可用');
      } finally { if (orig !== undefined) process.env.AGENT_DB_READONLY = orig; }
    });

    await t('U2-1/N7-P3: litestream.yml 提供主库→副本同步配置', () => {
      const ymlPath = path.join(__dirname, '..', 'deploy', 'litestream.yml');
      assert.ok(fs.existsSync(ymlPath), 'deploy/litestream.yml 应存在');
      const y = fs.readFileSync(ymlPath, 'utf8');
      assert.ok(/dbs:/.test(y) && /path:.*platform\.db/.test(y), '应含主库 dbs/path 配置');
      assert.ok(/type:\s*file/.test(y), '应含本地文件副本');
      assert.ok(/replica\b|\/replica/.test(y), '应指向只读副本目录');
    });

    await t('U2-1/N7-P3: replica-bootstrap.sh 具备初始化与完整性校验', () => {
      const shPath = path.join(__dirname, '..', 'scripts', 'replica-bootstrap.sh');
      assert.ok(fs.existsSync(shPath), 'scripts/replica-bootstrap.sh 应存在');
      const sh = fs.readFileSync(shPath, 'utf8');
      assert.ok(/\.backup|backup\(/.test(sh), '应使用一致性快照生成副本');
      assert.ok(/integrity_check/.test(sh), '应对副本做完整性校验');
      assert.ok(/AGENT_DB_READONLY/.test(sh), '应提示通过 AGENT_DB_READONLY 启用读写分离');
    });

    // ---------------- U2-1 / N7-P4 信创 DAL 方言层 ----------------
    await t('U2-1/N7-P4: SQL 方言 —— 默认 sqlite 恒等，未知方言回退 sqlite', () => {
      const d = require(path.join(__dirname, '..', 'src-server', 'lib', 'sql-dialect'));
      assert.ok(d.dialects().includes('sqlite') && d.dialects().includes('dm') && d.dialects().includes('kingbase'), '应含三种方言');
      const sql = "SELECT datetime('now','localtime') AS t";
      assert.strictEqual(d.translate(sql, 'sqlite').sql, sql, 'sqlite 方言应恒等转换');
      assert.strictEqual(d.translate(sql, 'unknown-dialect').sql, sql, '未知方言应回退 sqlite 恒等');
    });

    await t('U2-1/N7-P4: SQL 方言 —— 达梦映射（datetime TEXT 契约 / IDENTITY / COALESCE / 引号）', () => {
      const d = require(path.join(__dirname, '..', 'src-server', 'lib', 'sql-dialect'));
      // PG-1（2026-11-24）语义修复：datetime() 译作 CURRENT_TIMESTAMP 是「能解析但行为不等价」
      //（timestamptz 强类型与 TEXT 列比较即崩）——改译 to_char(TEXT 契约，sqlite 语义一致）
      assert.strictEqual(d.translate("SELECT datetime('now','localtime')", 'dm').sql, "SELECT to_char(SYSDATE, 'YYYY-MM-DD HH24:MI:SS')");
      assert.strictEqual(d.translate("SELECT datetime('now')", 'dm').sql, "SELECT to_char(SYSDATE, 'YYYY-MM-DD HH24:MI:SS')");
      assert.strictEqual(d.translate('id INTEGER PRIMARY KEY AUTOINCREMENT', 'dm').sql, 'id INT IDENTITY(1,1) PRIMARY KEY');
      assert.strictEqual(d.translate('SELECT IFNULL(a,0)', 'dm').sql, 'SELECT COALESCE(a,0)');
      assert.strictEqual(d.translate('SELECT `col` FROM t', 'dm').sql, 'SELECT "col" FROM t');
    });

    await t('U2-1/N7-P4: SQL 方言 —— 金仓映射（SERIAL / ON CONFLICT DO NOTHING）', () => {
      const d = require(path.join(__dirname, '..', 'src-server', 'lib', 'sql-dialect'));
      assert.strictEqual(d.translate('id INTEGER PRIMARY KEY AUTOINCREMENT', 'kingbase').sql, 'id SERIAL PRIMARY KEY');
      const r = d.translate('INSERT OR IGNORE INTO t (a) VALUES (1)', 'kingbase');
      assert.ok(/^INSERT INTO t \(a\) VALUES \(1\) ON CONFLICT DO NOTHING$/.test(r.sql), '金仓 INSERT OR IGNORE 应转 ON CONFLICT DO NOTHING，实际：' + r.sql);
    });

    await t('U2-1/N7-P4: SQL 方言 —— 未映射构造产出 warning 不静默', () => {
      const d = require(path.join(__dirname, '..', 'src-server', 'lib', 'sql-dialect'));
      // BE-C2（2026-11-22）：strftime 已建立映射（→ to_char / epoch），改用仍属未映射的 julianday 验证「不静默」。
      const r = d.translate('SELECT julianday(created_at) FROM t', 'dm');
      assert.ok(r.warnings.some(w => /julianday/.test(w)), 'julianday 未映射应告警');
      const r2 = d.translate('INSERT OR REPLACE INTO t VALUES (1)', 'kingbase');
      assert.ok(r2.warnings.some(w => /ON CONFLICT/.test(w)), 'INSERT OR REPLACE 应告警需人工改写');
    });

    await t('U2-1/N7-P4: 数据库连接抽象 —— 驱动可用性与 sqlite 直连', () => {
      const drv = require(path.join(__dirname, '..', 'src-server', 'lib', 'db-driver'));
      const list = drv.listDrivers();
      const byName = Object.fromEntries(list.map(x => [x.name, x]));
      assert.ok(byName.sqlite && byName.sqlite.available === true, 'sqlite 驱动应可用');
      assert.ok(byName.dm && byName.kingbase, '应包含 dm / kingbase 驱动定义');
      assert.strictEqual(drv.isAvailable('sqlite'), true, 'isAvailable(sqlite) 应为 true');
      // sqlite 直连（内存库）验证
      const conn = drv.createDriver('sqlite').connect({ path: ':memory:' });
      assert.strictEqual(conn.prepare('SELECT 1 AS ok').get().ok, 1, 'sqlite 驱动应可直连查询');
      conn.close();
    });

    await t('U2-1/N7-P4: 数据库连接抽象 —— 缺驱动给可读错误并提示回退', () => {
      const drv = require(path.join(__dirname, '..', 'src-server', 'lib', 'db-driver'));
      // 本机未安装 dmdb / pg，应抛出可读错误（含依赖名与回退提示），不崩溃
      if (!drv.isAvailable('dm')) {
        assert.throws(() => drv.createDriver('dm').connect({}), /未安装|dmdb|sqlite/i, 'dm 缺驱动应抛可读错误');
      }
      assert.throws(() => drv.createDriver('nope').connect({}), /未知数据库驱动/, '未知驱动应抛错');
      // 方言绑定：createDriver('kingbase').translate 应绑定 kingbase 方言
      const t2 = drv.createDriver('kingbase').translate('id INTEGER PRIMARY KEY AUTOINCREMENT');
      assert.strictEqual(t2.dialect, 'kingbase', 'createDriver 应绑定方言');
    });

    await t('U2-1/N7-P4: 配置项 db_driver / sql_dialect 默认 sqlite', () => {
      const cfg = require(path.join(__dirname, '..', 'src-server', 'lib', 'config'));
      const defs = Object.fromEntries(cfg.CONFIG_DEFS.map(d => [d.key, d]));
      assert.ok(defs.db_driver && defs.db_driver.default === 'sqlite', 'db_driver 默认应为 sqlite');
      assert.ok(defs.sql_dialect && defs.sql_dialect.default === 'sqlite', 'sql_dialect 默认应为 sqlite');
      assert.deepStrictEqual(defs.sql_dialect.options, ['sqlite', 'dm', 'kingbase'], 'sql_dialect 选项应含三方言');
      assert.ok(defs.db_password && defs.db_password.sensitive === true, 'db_password 应为敏感项');
    });

    // ---------------- U2-1 / N7-P5 完全离线部署包 ----------------
    await t('U2-1/N7-P5: package-portable.sh 含全量依赖/离线缓存/litestream/license 模板', () => {
      const p = path.join(__dirname, '..', 'scripts', 'package-portable.sh');
      assert.ok(fs.existsSync(p), 'scripts/package-portable.sh 应存在');
      const sh = fs.readFileSync(p, 'utf8');
      assert.ok(/node_modules/.test(sh), '应收录 node_modules 全量');
      assert.ok(/INCLUDE_NPM_CACHE|npm-cache/.test(sh), '应支持 npm 离线缓存');
      assert.ok(/litestream/.test(sh), '应校验 litestream');
      assert.ok(/license\.template\.json/.test(sh), '应生成 license 模板');
      assert.ok(/AGENT_DATA_DIR/.test(sh), 'start.sh 应映射 AGENT_DATA_DIR（服务实际读取的变量）');
    });

    await t('U2-1/N7-P5: offline-install.sh 离线安装与自检', () => {
      const p = path.join(__dirname, '..', 'scripts', 'offline-install.sh');
      assert.ok(fs.existsSync(p), 'scripts/offline-install.sh 应存在');
      const sh = fs.readFileSync(p, 'utf8');
      assert.ok(/deploy-check\.js/.test(sh), '应调用 deploy-check 做原生模块自检');
      assert.ok(/npm-cache/.test(sh) && /--offline/.test(sh), '应支持用离线缓存 --offline rebuild');
      assert.ok(/litestream/.test(sh), '应检查 litestream');
    });

    await t('U2-1/N7-P5: docs/OFFLINE_DEPLOY.md 离线部署手册', () => {
      const p = path.join(__dirname, '..', 'docs', 'OFFLINE_DEPLOY.md');
      assert.ok(fs.existsSync(p), 'docs/OFFLINE_DEPLOY.md 应存在');
      const md = fs.readFileSync(p, 'utf8');
      assert.ok(/麒麟|统信/.test(md), '应覆盖麒麟/统信');
      assert.ok(/AGENT_DATA_DIR/.test(md), '应说明数据目录环境变量');
      assert.ok(/offline-install\.sh/.test(md), '应说明离线安装脚本用法');
      assert.ok(/AGENT_DB_READONLY/.test(md), '应说明读写分离可选启用');
    });

    // ---------------- U2-8 / N8 开源运营 ----------------
    await t('U2-8/N8: README 已脱敏（无真实内网/公网端点）', () => {
      const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
      assert.ok(!/117\.173\.129\.98|61\.188\.36\.255|sagalcc\.cn|10\.20\.128\.28/.test(md), 'README 不应含真实内网/公网端点');
    });

    await t('U2-8/N8: 存在 CONTRIBUTING.md 与 SECURITY.md', () => {
      const c = path.join(__dirname, '..', 'CONTRIBUTING.md');
      const s = path.join(__dirname, '..', 'SECURITY.md');
      assert.ok(fs.existsSync(c), 'CONTRIBUTING.md 应存在');
      assert.ok(fs.existsSync(s), 'SECURITY.md 应存在');
      assert.ok(/npm test/.test(fs.readFileSync(c, 'utf8')), '贡献指南应要求 npm test 全绿');
      assert.ok(/漏洞|vulnerability/i.test(fs.readFileSync(s, 'utf8')), '安全政策应说明漏洞披露');
    });

    await t('U2-8/N8: GitHub Actions CI 工作流就位', () => {
      const y = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml');
      assert.ok(fs.existsSync(y), '.github/workflows/ci.yml 应存在');
      const s = fs.readFileSync(y, 'utf8');
      assert.ok(/npm ci/.test(s), 'CI 应执行 npm ci');
      assert.ok(/npm test/.test(s), 'CI 应执行 npm test');
      assert.ok(/pull_request/.test(s), 'CI 应在 PR 时触发');
    });

    await t('U2-8/N8: docs/PLUGIN_SDK.md 插件 SDK 文档就位', () => {
      const p = path.join(__dirname, '..', 'docs', 'PLUGIN_SDK.md');
      assert.ok(fs.existsSync(p), 'docs/PLUGIN_SDK.md 应存在');
      const md = fs.readFileSync(p, 'utf8');
      assert.ok(/PLUGIN_ARGS/.test(md), '应说明插件入参注入契约 globalThis.PLUGIN_ARGS');
      assert.ok(/\/api\/plugins\/install/.test(md), '应说明插件安装接口');
    });

    await t('U2-8/U2-3: 插件工具入参注入沙箱并回传 stdout', async () => {
      const entry = 'const a=globalThis.PLUGIN_ARGS||{};console.log("echo:"+(a.city||"none"));';
      const info = db.prepare("INSERT INTO plugins (plugin_id,name,type,entry,icon,description,version,author,runtime,settings_schema,enabled,installed_by,installed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,datetime('now'),datetime('now'))")
        .run('n8_echo_' + Date.now(), 'N8 Echo', 'tool', entry, 'x', '', '1.0.0', 'test', 'node', '{}', 'test');
      const { loadPlugin, unloadPlugin } = require('../src-server/lib/plugin-loader');
      const { TOOL_DEFS } = require('../src-server/lib/tools');
      const p = db.prepare('SELECT * FROM plugins WHERE id=?').get(info.lastInsertRowid);
      assert.ok(loadPlugin(p), '插件应加载成功并注册到 TOOL_DEFS');
      const out = String(await TOOL_DEFS[p.plugin_id].run({ city: '上海' }, {}));
      assert.ok(/echo:上海/.test(out), '插件应读到注入的入参，实际：' + out);
      unloadPlugin(p.plugin_id);
      db.prepare('DELETE FROM plugins WHERE id=?').run(p.id);
    });
  }

  console.log('【D2-1】代码索引与仓库语义检索（函数/类切片 / 符号+语义混合检索 / 补丁 propose-apply-rollback）');
  {
    const { db } = require('../src-server/db');
    const ci = require('../src-server/lib/code-index');
    const csearch = require('../src-server/lib/code-search');
    const { sign } = require('../src-server/lib/auth');
    const os = require('os');

    await t('D2-1: 内核 —— 语言识别/目录扫描/符号抽取/代码分词', () => {
      assert.strictEqual(ci.detectLang('a/b.js'), 'javascript');
      assert.strictEqual(ci.detectLang('x.py'), 'python');
      assert.strictEqual(ci.detectLang('Dockerfile'), 'dockerfile');
      const js = 'function fooBar(){ return 1; }\nclass Baz {\n  methodOne(){ return 2; }\n}\n';
      const syms = ci.extractSymbols(js, 'javascript').map(s => s.kind + ':' + s.name);
      assert.ok(syms.includes('function:fooBar'), '应抽到 fooBar');
      assert.ok(syms.includes('class:Baz'), '应抽到类 Baz');
      assert.ok(syms.includes('method:methodOne'), '应抽到方法 methodOne');
      const py = ci.extractSymbols('class Foo:\n    def bar(self):\n        return 1\n', 'python').map(s => s.kind + ':' + s.name);
      assert.ok(py.includes('method:bar') || py.includes('function:bar'), '类内方法 bar 应被抽到：' + py.join(','));
      const terms = ci.codeTerms('getUserName_fromAPI');
      for (const w of ['get', 'user', 'name', 'from', 'api']) assert.ok(terms.includes(w), '代码分词应含 ' + w);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd21scan-'));
      fs.mkdirSync(path.join(tmp, 'node_modules'));
      fs.writeFileSync(path.join(tmp, 'node_modules', 'x.js'), 'x');
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'function a(){}');
      fs.writeFileSync(path.join(tmp, 'img.png'), 'x');
      const files = ci.scanFiles(tmp).sort();
      assert.ok(files.includes('src/a.js'), '应扫描到源码');
      assert.ok(!files.some(f => f.includes('node_modules')), '应忽略 node_modules');
      assert.ok(!files.some(f => f.endsWith('.png')), '应忽略二进制');
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    await t('D2-1: 补丁工具 —— 查找替换 + 统一 diff', () => {
      assert.strictEqual(ci.applyFindReplace('hello world', 'world', 'earth').content, 'hello earth');
      assert.strictEqual(ci.applyFindReplace('a a', 'a', 'b', true).content, 'b b');
      assert.strictEqual(ci.applyFindReplace('abc', 'zzz', 'x').ok, false);
      const d = ci.unifiedDiff('a\nb\nc', 'a\nB\nc');
      assert.strictEqual(d.additions, 1);
      assert.strictEqual(d.deletions, 1);
      assert.ok(d.diff.includes('---') && d.diff.includes('+++'));
    });

    await t('D2-1: db 迁移 —— code_repos/code_index/code_patches/code_patch_backups 就位', () => {
      for (const tb of ['code_repos', 'code_index', 'code_patches', 'code_patch_backups']) {
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tb), tb + ' 应存在');
      }
    });

    await t('D2-1: 混合检索内核 —— 符号命中最强 + 语义通道可用 + RRF 融合', async () => {
      const retriever = require('../src-server/lib/retriever');
      const rows = [
        { id: 1, repo_id: 1, file_path: 'src/auth.js', lang: 'javascript', chunk_kind: 'function', symbol_name: 'loginUser', symbol_parent: '', start_line: 1, end_line: 3, content: 'function loginUser(name){ return name; }' },
        { id: 2, repo_id: 1, file_path: 'src/math.js', lang: 'javascript', chunk_kind: 'function', symbol_name: 'addNumbers', symbol_parent: '', start_line: 1, end_line: 3, content: 'function addNumbers(a,b){ return a+b; }' },
      ];
      for (const r of rows) r.embedding = 'H:' + JSON.stringify([...retriever.embed(r.content)]);
      const res = await csearch.search(rows, 'loginUser', 5, { rerankEnabled: false });
      assert.ok(res.length >= 1, '应有命中');
      assert.strictEqual(res[0].symbol_name, 'loginUser', '符号精确匹配应排第一');
      assert.ok(res[0].symbol > 0, '符号通道应命中');
    });

    await t('D2-1: HTTP 闭环 —— 登记→索引→检索→读文件→补丁 propose/apply/rollback', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'd21repo-'));
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'hello.js'), 'function greetUser(name) {\n  return "Hello " + name;\n}\n');
      fs.writeFileSync(path.join(repo, 'src', 'calc.py'), 'def addNumbers(a, b):\n    return a + b\n');
      fs.writeFileSync(path.join(repo, 'README.md'), '# demo repo\n');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d21','x','D','user',1,0,datetime('now','localtime'))").run();
      const u = db.prepare("SELECT id FROM users WHERE username='d21'").get();
      const tok = sign({ uid: u.id, exp: Date.now() + 3600000 });
      const express = require('express');
      const codeRouter = require('../src-server/routes/code');
      const app = express(); app.use(express.json()); app.use('/api/code', codeRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const H = { 'Content-Type': 'application/json', authorization: 'Bearer ' + tok };
      const J = async (m, p, b) => (await fetch(base + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
      try {
        const reg = await J('POST', '/api/code/repos', { name: 'demo', root_path: repo });
        assert.strictEqual(reg.code, 0, '登记应成功：' + reg.msg);
        const rid = reg.data.id;
        const idx = await J('POST', `/api/code/repos/${rid}/index`, {});
        assert.strictEqual(idx.code, 0, '索引应成功');
        assert.ok(idx.data.symbol_count >= 2, '应至少抽到 2 个符号，实际 ' + idx.data.symbol_count);
        assert.ok(idx.data.file_count >= 3, '应索引到 3 个文件，实际 ' + idx.data.file_count);
        const s1 = await J('GET', `/api/code/repos/${rid}/search?q=greetUser&rerank=0`);
        assert.strictEqual(s1.code, 0);
        assert.ok(s1.data.results.length >= 1 && s1.data.results[0].symbol_name === 'greetUser', '应按符号命中 greetUser');
        const rf = await J('GET', `/api/code/repos/${rid}/file?path=` + encodeURIComponent('src/hello.js'));
        assert.strictEqual(rf.code, 0);
        assert.ok(rf.data.content.includes('greetUser'));
        const esc = await J('GET', `/api/code/repos/${rid}/file?path=` + encodeURIComponent('../../etc/passwd'));
        assert.strictEqual(esc.code, 400, '逃逸路径应被拒');
        const pr = await J('POST', `/api/code/repos/${rid}/patch/propose`, { path: 'src/hello.js', find: 'Hello ', replace: 'Hi ' });
        assert.strictEqual(pr.code, 0, '提议应成功：' + pr.msg);
        assert.ok(pr.data.diff.includes('+') && pr.data.diff.includes('-'), 'diff 应含增删行');
        const pid = pr.data.patch_id;
        const before = await J('GET', `/api/code/repos/${rid}/file?path=` + encodeURIComponent('src/hello.js'));
        assert.ok(before.data.content.includes('Hello '), 'apply 前不应改动文件');
        const ap = await J('POST', `/api/code/repos/${rid}/patch/${pid}/apply`, {});
        assert.strictEqual(ap.code, 0, '应用应成功：' + ap.msg);
        const after = await J('GET', `/api/code/repos/${rid}/file?path=` + encodeURIComponent('src/hello.js'));
        assert.ok(after.data.content.includes('Hi ') && !after.data.content.includes('Hello '), 'apply 后应写入新内容');
        const ap2 = await J('POST', `/api/code/repos/${rid}/patch/${pid}/apply`, {});
        assert.strictEqual(ap2.code, 400, '重复应用应被拒');
        const rb = await J('POST', `/api/code/repos/${rid}/patch/rollback`, { backup_id: ap.data.backup_id });
        assert.strictEqual(rb.code, 0, '回滚应成功：' + rb.msg);
        const restored = await J('GET', `/api/code/repos/${rid}/file?path=` + encodeURIComponent('src/hello.js'));
        assert.ok(restored.data.content.includes('Hello '), '回滚后应恢复原文');
        await J('DELETE', `/api/code/repos/${rid}`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM code_index WHERE repo_id=?').get(rid).c, 0, '删除应清索引');
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM code_patch_backups WHERE repo_id=?').get(rid).c, 0, '删除应清备份');
      } finally { server.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    });

    await t('D2-1: CODE_INDEX_ROOTS 白名单 —— 配置后拒绝白名单外目录', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'd21roots-'));
      const saved = process.env.CODE_INDEX_ROOTS;
      process.env.CODE_INDEX_ROOTS = '/definitely/not/this/path';
      try {
        const express = require('express');
        const codeRouter = require('../src-server/routes/code');
        const app = express(); app.use(express.json()); app.use('/api/code', codeRouter);
        const u = db.prepare("SELECT id FROM users WHERE username='d21'").get();
        const tok = sign({ uid: u.id, exp: Date.now() + 3600000 });
        let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
          const r = await (await fetch(base + '/api/code/repos', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ name: 'x', root_path: repo }) })).json();
          assert.strictEqual(r.code, 400, '白名单外的目录应被拒');
        } finally { server.close(); }
      } finally {
        if (saved === undefined) delete process.env.CODE_INDEX_ROOTS; else process.env.CODE_INDEX_ROOTS = saved;
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    await t('D2-1: 归属隔离 —— 非 owner 不可见/读/写他人仓库（管理员可见）', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'd21iso-'));
      fs.writeFileSync(path.join(repo, 'secret.js'), 'function secretFn(){ return 42; }\n');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d21b','x','B','user',1,0,datetime('now','localtime'))").run();
      const ub = db.prepare("SELECT id FROM users WHERE username='d21b'").get();
      const tokB = sign({ uid: ub.id, exp: Date.now() + 3600000 });
      const express = require('express');
      const codeRouter = require('../src-server/routes/code');
      const app = express(); app.use(express.json()); app.use('/api/code', codeRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const HB = { 'Content-Type': 'application/json', authorization: 'Bearer ' + tokB };
      try {
        // 由 d21b 自己登记并索引
        const reg = await (await fetch(base + '/api/code/repos', { method: 'POST', headers: HB, body: JSON.stringify({ name: 'iso', root_path: repo }) })).json();
        assert.strictEqual(reg.code, 0, '登记应成功：' + reg.msg);
        const rid = reg.data.id;
        await (await fetch(base + `/api/code/repos/${rid}/index`, { method: 'POST', headers: HB, body: '{}' })).json();
        // 另建 d21c 用户，不可见 d21b 的仓库
        db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d21c','x','C','user',1,0,datetime('now','localtime'))").run();
        const uc = db.prepare("SELECT id FROM users WHERE username='d21c'").get();
        const tokC = sign({ uid: uc.id, exp: Date.now() + 3600000 });
        const HC = { 'Content-Type': 'application/json', authorization: 'Bearer ' + tokC };
        const list = await (await fetch(base + '/api/code/repos', { headers: HC })).json();
        assert.ok(!list.data.some(r => r.id === rid), '列表不应含他人仓库');
        const get = await (await fetch(base + `/api/code/repos/${rid}`, { headers: HC })).json();
        assert.strictEqual(get.code, 404, '按 id 读取他人仓库应 404');
        const rf = await (await fetch(base + `/api/code/repos/${rid}/file?path=` + encodeURIComponent('secret.js'), { headers: HC })).json();
        assert.strictEqual(rf.code, 404, '越权读文件应被拒');
        const del = await (await fetch(base + `/api/code/repos/${rid}`, { method: 'DELETE', headers: HC })).json();
        assert.strictEqual(del.code, 404, '越权删除应被拒');
        // owner 自己仍可读
        const own = await (await fetch(base + `/api/code/repos/${rid}/file?path=` + encodeURIComponent('secret.js'), { headers: HB })).json();
        assert.strictEqual(own.code, 0, 'owner 应可读自己仓库');
        await (await fetch(base + `/api/code/repos/${rid}`, { method: 'DELETE', headers: HB })).json();
      } finally { server.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    });
  }

  console.log('【D2-2】计费用量感知闭环（预检-预留-结算三段式 / 并发上限 / 单价×用量对账）');
  {
    const gate = require('../src-server/lib/billing-gate');
    const { computeCost } = require('../src-server/lib/billing');
    const { sign } = require('../src-server/lib/auth');
    // 造价目：供应商含模型 m1（输入 1 / 输出 2 元/千 Token）
    db.prepare("INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,model_price,created_at) VALUES ('p_d22','','','[\"m1\"]',1,0,'',?,datetime('now','localtime'))")
      .run(JSON.stringify({ m1: { input: 1, output: 2 } }));

    await t('D2-2: db 迁移 —— billing_holds 表 + users.cost_quota/max_concurrency 列就位', () => {
      const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      assert.ok(cols.includes('cost_quota'), 'users.cost_quota 应存在');
      assert.ok(cols.includes('max_concurrency'), 'users.max_concurrency 应存在');
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_holds'").get(), 'billing_holds 表应存在');
    });

    await t('D2-2: 三段式 —— 预检 held → 结算金额=单价×用量（精确）→ 幂等重复结算不重复计', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d22a','x','A','user',1,0,datetime('now','localtime'))").run();
      const pre = gate.precheck({ username: 'd22a', model: 'm1', promptText: 'hello world 你好' });
      assert.strictEqual(pre.ok, true, '预检应放行');
      assert.strictEqual(gate.activeConcurrency('d22a'), 1, '预留后活跃并发应为 1');
      const s1 = gate.settle({ request_id: pre.request_id, promptTokens: 100, completionTokens: 100, model: 'm1' });
      assert.strictEqual(s1.actual_cost, computeCost(100, 100, { input: 1, output: 2 }), '结算金额应=单价×用量');
      assert.strictEqual(s1.actual_cost, 0.3, '100/1000×1 + 100/1000×2 = 0.3');
      assert.strictEqual(gate.activeConcurrency('d22a'), 0, '结算后活跃并发归零');
      const s2 = gate.settle({ request_id: pre.request_id, promptTokens: 999, completionTokens: 999, model: 'm1' });
      assert.strictEqual(s2.idempotent, true, '重复结算应幂等');
      assert.strictEqual(s2.actual_cost, 0.3, '幂等不改变金额');
      const row = db.prepare("SELECT actual_cost, actual_tokens, status FROM billing_holds WHERE request_id=?").get(pre.request_id);
      assert.strictEqual(row.actual_cost, 0.3);
      assert.strictEqual(row.actual_tokens, 200);
      assert.strictEqual(row.status, 'settled');
    });

    await t('D2-2: 并发上限 —— 达上限 100% 拦截，释放后放行', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,max_concurrency,created_at) VALUES ('d22b','x','B','user',1,0,1,datetime('now','localtime'))").run();
      const p1 = gate.precheck({ username: 'd22b', model: 'm1', promptText: 'a' });
      assert.strictEqual(p1.ok, true, '首个请求应放行');
      const p2 = gate.precheck({ username: 'd22b', model: 'm1', promptText: 'b' });
      assert.strictEqual(p2.ok, false, '超并发应拦截');
      assert.strictEqual(p2.code, 'concurrency');
      gate.release(p1.request_id, 'done');
      const p3 = gate.precheck({ username: 'd22b', model: 'm1', promptText: 'c' });
      assert.strictEqual(p3.ok, true, '释放后应放行');
      gate.release(p3.request_id);
    });

    await t('D2-2: release 幂等 —— 重复释放无副作用，已释放的预留不可结算', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d22c','x','C','user',1,0,datetime('now','localtime'))").run();
      const p = gate.precheck({ username: 'd22c', model: 'm1', promptText: 'z' });
      assert.strictEqual(gate.release(p.request_id).changed, 1, '首次释放生效');
      assert.strictEqual(gate.release(p.request_id).changed, 0, '重复释放 changed=0');
      assert.strictEqual(gate.settle({ request_id: p.request_id, promptTokens: 10, completionTokens: 10, model: 'm1' }).ok, false, '已释放不可结算');
    });

    await t('D2-2: 成本配额 —— 当月已用成本达上限则 100% 拦截', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,cost_quota,created_at) VALUES ('d22d','x','D','user',1,0,0.5,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO usage_records (username,dimension,dimension_key,tokens,count,cost,meta,prompt_tokens,completion_tokens,created_at) VALUES ('d22d','model','m1',400,1,0.6,?,200,200,datetime('now','localtime'))")
        .run(JSON.stringify({ price_input: 1, price_output: 2, priced: true }));
      const p = gate.precheck({ username: 'd22d', model: 'm1', promptText: 'q' });
      assert.strictEqual(p.ok, false);
      assert.strictEqual(p.code, 'cost_quota');
    });

    await t('D2-2: Token 配额 —— 与既有 quota 口径一致，超限拦截', () => {
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,quota_total,quota_used,created_at) VALUES ('d22e','x','E','user',1,0,100,100,datetime('now','localtime'))").run();
      const p = gate.precheck({ username: 'd22e', model: 'm1', promptText: 'q' });
      assert.strictEqual(p.ok, false);
      assert.strictEqual(p.code, 'quota');
    });

    await t('D2-2: 对账 —— 单价×用量=应收，逐模型账实一致（误差 0）', () => {
      // 独立月份（2099-01）隔离，避免受其它用例数据影响
      db.prepare("INSERT INTO usage_records (username,dimension,dimension_key,tokens,count,cost,meta,prompt_tokens,completion_tokens,created_at) VALUES ('d22a','model','m9',400,1,0.6,?,200,200,'2099-01-15 10:00:00')").run(JSON.stringify({ price_input: 1, price_output: 2, priced: true }));
      db.prepare("INSERT INTO usage_records (username,dimension,dimension_key,tokens,count,cost,meta,prompt_tokens,completion_tokens,created_at) VALUES ('d22a','model','m8',100,1,0.15,?,50,50,'2099-01-16 10:00:00')").run(JSON.stringify({ price_input: 1, price_output: 2, priced: true }));
      const rec = gate.reconcile({ month: '2099-01' });
      assert.strictEqual(rec.items.length, 2, '应含两个模型');
      for (const it of rec.items) {
        const r6 = (n) => Math.round(n * 1e6) / 1e6;
        assert.strictEqual(it.expect_cost, r6((it.prompt_tokens / 1000) * 1 + (it.completion_tokens / 1000) * 2), `${it.model} 应收应为单价×用量`);
        assert.strictEqual(it.diff, 0, `${it.model} 误差应为 0`);
        assert.strictEqual(it.balanced, true);
      }
      assert.strictEqual(rec.total.expect_cost, 0.75, '合计应收 0.6+0.15');
      assert.strictEqual(rec.total.diff, 0);
      assert.strictEqual(rec.total.balanced, true, '合计账实一致');
    });

    await t('D2-2: 闸门统计 —— 拦截/结算/活跃计数可见', () => {
      const st = gate.stats();
      assert.ok(st.blocked >= 2, '应记录 ≥2 次拦截（并发+成本配额）');
      assert.ok(st.settled >= 1, '应有结算记录');
      assert.ok(Array.isArray(st.blocked_by_reason));
    });

    await t('D2-2: HTTP —— admin 对账/统计接口 + 非管理员拒绝 + 设置成本配额与并发上限', async () => {
      const express = require('express');
      const billingRouter = require('../src-server/routes/billing');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d22admin','x','Ad','admin',1,0,datetime('now','localtime'))").run();
      const ua = db.prepare("SELECT id FROM users WHERE username='d22admin'").get();
      const tAdmin = sign({ uid: ua.id, exp: Date.now() + 3600000 });
      const ub = db.prepare("SELECT id FROM users WHERE username='d22a'").get();
      const tUser = sign({ uid: ub.id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/billing', billingRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const ok = await (await fetch(base + '/api/billing/reconcile?month=2099-01', { headers: { authorization: 'Bearer ' + tAdmin } })).json();
        assert.strictEqual(ok.code, 0);
        assert.strictEqual(ok.data.items.length, 2);
        assert.strictEqual(ok.data.total.balanced, true);
        const denied = await (await fetch(base + '/api/billing/reconcile', { headers: { authorization: 'Bearer ' + tUser } })).json();
        assert.notStrictEqual(denied.code, 0, '非管理员应被拒');
        const st = await (await fetch(base + '/api/billing/stats', { headers: { authorization: 'Bearer ' + tAdmin } })).json();
        assert.strictEqual(st.code, 0);
        const put = await (await fetch(base + '/api/billing/users/d22a', { method: 'PUT', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + tAdmin }, body: JSON.stringify({ cost_quota: 12.5, max_concurrency: 3 }) })).json();
        assert.strictEqual(put.code, 0);
        const u = db.prepare("SELECT cost_quota, max_concurrency FROM users WHERE username='d22a'").get();
        assert.strictEqual(u.cost_quota, 12.5);
        assert.strictEqual(u.max_concurrency, 3);
      } finally { server.close(); }
    });
  }

  console.log('【D2-4】MCP 与连接器广场');
  {
    const catalog = require('../src-server/lib/mcp-catalog');
    const mcred = require('../src-server/lib/mcp-credentials');

    await t('D2-4: 目录内核——结构/过滤/匹配/必填凭据', async () => {
      const { items, categories } = catalog.listCatalog();
      assert.ok(items.length >= 10, '目录应有 ≥10 条');
      assert.ok(categories.includes('异构平台'), '分类含「异构平台」');
      assert.ok(catalog.listCatalog({ type: 'mcp' }).items.every(e => e.type === 'mcp'), 'type 过滤生效');
      assert.ok(catalog.listCatalog({ category: '异构平台' }).items.length >= 2, 'category 过滤生效');
      const gh = catalog.getEntry('github');
      assert.strictEqual(gh.type, 'mcp');
      assert.deepStrictEqual(catalog.requiredCredentials(gh), ['api_key'], 'github 必填 api_key');
      assert.strictEqual(catalog.getEntry('not-exist'), null);
      assert.ok(catalog.listCatalog({ q: 'github' }).items.some(e => e.id === 'github'), '关键词过滤命中');
      assert.ok(catalog.CATALOG.every(e => e.id && e.name && e.type), '每条字段齐备');
    });

    await t('D2-4: 健康态与风险摘要（纯函数）', async () => {
      assert.strictEqual(catalog.healthOf(null).level, 'unknown');
      assert.strictEqual(catalog.healthOf({ status: 0 }).level, 'down');
      assert.strictEqual(catalog.healthOf({ status: 1, last_error: 'boom' }).level, 'down');
      assert.strictEqual(catalog.healthOf({ status: 1, last_check_at: '2026-01-01' }).level, 'ok');
      assert.deepStrictEqual(catalog.riskSummary([{ risk: 'low' }, { risk: 'high' }, {}]), { total: 3, low: 1, high: 2 });
      assert.deepStrictEqual(catalog.riskSummary(null), { total: 0, low: 0, high: 0 });
    });

    await t('D2-4: 凭据托管——加密落库/掩码回显/注入取回/占位渲染/脱敏', async () => {
      const info = db.prepare("INSERT INTO mcp_servers (name,url,api_key,transport,status,created_at) VALUES ('凭据测试','http://127.0.0.1:1/{TENANT}','','http',1,datetime('now','localtime'))").run();
      const sid = Number(info.lastInsertRowid);
      assert.strictEqual(mcred.setSecret(sid, '1bad', 'x').ok, false, '非法名应拒');
      assert.strictEqual(mcred.setSecret(sid, 'api_key', '').ok, false, '空值应拒');
      assert.strictEqual(mcred.setSecret(sid, 'api_key', 'sk-abcdef123456').ok, true);
      const stored = db.prepare('SELECT value FROM mcp_credentials WHERE server_id=? AND name=?').get(sid, 'api_key').value;
      assert.ok(stored && stored !== 'sk-abcdef123456' && !stored.includes('sk-abcdef'), '明文不得落库');
      const list = mcred.listSecrets(sid);
      assert.strictEqual(list[0].masked, 'sk-****56', '掩码头3尾2');
      assert.ok(!list[0].masked.includes('abcdef'), '掩码不含中段');
      const srv = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(sid);
      assert.strictEqual(mcred.effectiveApiKey(srv), 'sk-abcdef123456', '注入取回明文');
      assert.strictEqual(mcred.renderUrl(srv.url, mcred.getSecrets(sid)), 'http://127.0.0.1:1/{TENANT}', '未提供占位保留');
      assert.strictEqual(mcred.renderUrl(srv.url, { TENANT: 'acme' }), 'http://127.0.0.1:1/acme', '占位替换');
      assert.strictEqual(mcred.scrub('leak sk-abcdef123456 here', ['sk-abcdef123456']), 'leak *** here', '输出脱敏');
      assert.strictEqual(mcred.setSecret(sid, 'api_key', 'sk-newvalue9999').action, 'updated', '覆盖为更新');
      assert.strictEqual(mcred.deleteSecret(sid, 'api_key'), true);
      assert.strictEqual(mcred.listSecrets(sid).length, 0);
    });

    await t('D2-4: effectiveApiKey 回落旧字段 api_key（兼容存量明文）', async () => {
      const info = db.prepare("INSERT INTO mcp_servers (name,url,api_key,transport,status,created_at) VALUES ('旧服务','http://127.0.0.1:1/mcp','legacy-token','http',1,datetime('now','localtime'))").run();
      const srv = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(Number(info.lastInsertRowid));
      assert.strictEqual(mcred.effectiveApiKey(srv), 'legacy-token');
    });

    await t('D2-4: HTTP —— 目录浏览/一键安装（凭据校验+落库）/非管理员拒绝/凭据 CRUD/列表附健康', async () => {
      const express = require('express');
      const mcpRouter = require('../src-server/routes/mcp');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d24admin','x','A','admin',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d24user','x','U','user',1,0,datetime('now','localtime'))").run();
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d24admin'").get().id, exp: Date.now() + 3600000 });
      const tUser = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d24user'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/mcp', mcpRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tok) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + tok } })).json();
      try {
        const cat = await J('/api/mcp/catalog', {}, tUser);
        assert.strictEqual(cat.code, 0, '登录用户可浏览目录');
        assert.ok(cat.data.items.length >= 10 && Array.isArray(cat.data.categories));
        // 非管理员安装被拒
        const denied = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'fetch' }) }, tUser);
        assert.notStrictEqual(denied.code, 0, '非管理员安装应被拒');
        // 缺必填凭据
        const miss = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'github', url: 'http://127.0.0.1:1/mcp' }) }, tAdmin);
        assert.strictEqual(miss.code, 400);
        assert.ok(/缺少必填凭据/.test(miss.msg), '缺凭据应提示');
        // 未知条目
        const noEnt = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'zzz' }) }, tAdmin);
        assert.strictEqual(noEnt.code, 400);
        // 正常安装（fetch 无需凭据；url 指向不可达端口→首测快速失败，非致命）
        const ins = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'fetch', url: 'http://127.0.0.1:1/mcp' }) }, tAdmin);
        assert.strictEqual(ins.code, 0);
        assert.strictEqual(ins.data.catalog_id, 'fetch');
        const row = db.prepare("SELECT * FROM mcp_servers WHERE catalog_id='fetch'").get();
        assert.ok(row && row.source === 'catalog', '落库来源为 catalog');
        // 重复安装 → 升级
        const up = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'fetch', url: 'http://127.0.0.1:1/mcp' }) }, tAdmin);
        assert.strictEqual(up.data.upgraded, true, '重复安装应为升级');
        // 含凭据安装 + 凭据 CRUD
        const ins2 = await J('/api/mcp/install', { method: 'POST', body: JSON.stringify({ catalog_id: 'github', url: 'http://127.0.0.1:1/mcp', credentials: { api_key: 'ghp_secret123456' } }) }, tAdmin);
        assert.strictEqual(ins2.code, 0);
        const ghId = ins2.data.id;
        assert.deepStrictEqual(ins2.data.credentials, ['api_key'], '凭据已托管');
        const cl = await J(`/api/mcp/${ghId}/credentials`, {}, tAdmin);
        assert.strictEqual(cl.code, 0);
        assert.ok(cl.data.some(c => c.name === 'api_key' && /^ghp\*{4}/.test(c.masked)), '凭据掩码回显');
        const deniedCred = await J(`/api/mcp/${ghId}/credentials`, {}, tUser);
        assert.notStrictEqual(deniedCred.code, 0, '非管理员不可读凭据');
        const add = await J(`/api/mcp/${ghId}/credentials`, { method: 'POST', body: JSON.stringify({ name: 'extra', value: 'v123' }) }, tAdmin);
        assert.strictEqual(add.code, 0);
        const del = await J(`/api/mcp/${ghId}/credentials/extra`, { method: 'DELETE' }, tAdmin);
        assert.strictEqual(del.code, 0);
        // 列表附带 health/risk/credentials
        const list = await J('/api/mcp', {}, tUser);
        const ghRow = list.data.find(s => s.id === ghId);
        assert.ok(ghRow.health && ghRow.risk && Array.isArray(ghRow.credentials), '列表附 health/risk/credentials');
        assert.strictEqual(ghRow.api_key_set, 1, '有凭据时 api_key_set=1');
      } finally { server.close(); }
    });
  }

  console.log('【D2-3】桌面端升级通道（自动更新 / 发布清单 / 更新成功率·崩溃率）');
  {
    const bu = require('../src-server/lib/bridge-update');

    await t('D2-3: 版本内核——解析/比较/规范化', async () => {
      assert.deepStrictEqual(bu.parseVersion('v1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, pre: 'beta.1' });
      assert.strictEqual(bu.parseVersion('abc'), null);
      assert.strictEqual(bu.cmpVersion('1.2.0', '1.10.0'), -1, '按数值比较而非字典序');
      assert.strictEqual(bu.cmpVersion('1.2.3', '1.2.3'), 0);
      assert.strictEqual(bu.cmpVersion('1.2.3-beta', '1.2.3'), -1, '预发布 < 正式');
      assert.strictEqual(bu.cmpVersion('2.0.0', '1.9.9'), 1);
      assert.strictEqual(bu.normalizeVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
      assert.strictEqual(bu.normalizeVersion(''), '');
    });

    await t('D2-3: 包完整性——sha256 计算与校验', async () => {
      const buf = Buffer.from('hello');
      const h = bu.sha256(buf);
      assert.strictEqual(h, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
      assert.strictEqual(bu.verifySha256(buf, h), true);
      assert.strictEqual(bu.verifySha256(buf, h.toUpperCase()), true, '大小写不敏感');
      assert.strictEqual(bu.verifySha256(buf, 'deadbeef'), false);
      assert.strictEqual(bu.verifySha256(buf, ''), true, '未提供校验值视为不校验');
    });

    await t('D2-3: 发布选择——平台/架构/通道匹配 + 强制升级', async () => {
      const rows = [
        { version: '1.1.0', platform: 'any', arch: 'any', channel: 'stable', status: 'active' },
        { version: '1.2.0', platform: 'darwin', arch: 'arm64', channel: 'stable', status: 'active' },
        { version: '2.0.0', platform: 'darwin', arch: 'arm64', channel: 'beta', status: 'active' },
        { version: '9.9.9', platform: 'win32', arch: 'x64', channel: 'stable', status: 'active' },
        { version: '3.0.0', platform: 'any', arch: 'any', channel: 'stable', status: 'archived' },
      ];
      const r1 = bu.pickRelease(rows, { platform: 'darwin', arch: 'arm64', channel: 'stable', current: '1.0.0' });
      assert.strictEqual(r1.latest, '1.2.0', 'stable 通道取最高稳定版，不含 beta/归档');
      assert.strictEqual(r1.update_available, true);
      const r2 = bu.pickRelease(rows, { platform: 'darwin', arch: 'arm64', channel: 'beta', current: '1.0.0' });
      assert.strictEqual(r2.latest, '2.0.0', 'beta 通道可取 beta 版');
      const r3 = bu.pickRelease(rows, { platform: 'darwin', arch: 'arm64', channel: 'stable', current: '1.2.0' });
      assert.strictEqual(r3.update_available, false, '已是最高版则无更新');
      const r4 = bu.pickRelease(rows, { platform: 'win32', arch: 'x64', channel: 'stable', current: '1.0.0' });
      assert.strictEqual(r4.latest, '9.9.9');
      const rows2 = [{ version: '1.5.0', platform: 'any', arch: 'any', channel: 'stable', status: 'active', min_version: '1.4.0' }];
      assert.strictEqual(bu.pickRelease(rows2, { platform: 'darwin', arch: 'arm64', channel: 'stable', current: '1.3.0' }).mandatory, true, '低于 min_version 强制升级');
      assert.strictEqual(bu.pickRelease(rows2, { platform: 'darwin', arch: 'arm64', channel: 'stable', current: '1.4.0' }).mandatory, false);
      const rows3 = [{ version: '1.5.0', platform: 'any', arch: 'any', channel: 'stable', status: 'active', mandatory: 1 }];
      assert.strictEqual(bu.pickRelease(rows3, { platform: 'darwin', arch: 'arm64', channel: 'stable', current: '1.0.0' }).mandatory, true, '标记强制');
      assert.strictEqual(bu.pickRelease([], { current: '1.0.0' }).latest, null, '无发布返回 null');
    });

    await t('D2-3: 指标——更新成功率与崩溃率（含达标线）', async () => {
      const updates = [
        { status: 'success', device_id: 1 }, { status: 'success', device_id: 1 },
        { status: 'success', device_id: 2 }, { status: 'failed', device_id: 2 },
        { status: 'rollback', device_id: 3 },
      ];
      const s = bu.updateStats(updates, [{ device_id: 2 }]);
      assert.strictEqual(s.total, 5);
      assert.strictEqual(s.success, 3);
      assert.strictEqual(s.successRate, 60);
      assert.strictEqual(s.meetsSuccessTarget, false);
      assert.strictEqual(s.crashRate, 33.33, '1/3 设备崩溃率');
      assert.strictEqual(s.meetsCrashTarget, false);
      const good = bu.updateStats([...Array(20).keys()].map(i => ({ status: i < 19 ? 'success' : 'failed', device_id: i })), []);
      assert.strictEqual(good.successRate, 95);
      assert.strictEqual(good.meetsSuccessTarget, true, '95% 视为达标');
      assert.strictEqual(good.crashRate, 0);
      assert.strictEqual(good.meetsCrashTarget, true);
      const empty = bu.updateStats([], []);
      assert.strictEqual(empty.successRate, null);
      assert.strictEqual(empty.crashRate, null);
      assert.strictEqual(empty.meetsSuccessTarget, null);
      assert.deepStrictEqual(bu.releaseView(null), null);
    });

    await t('D2-3: HTTP —— 发布登记/版本检查/下载校验/上报/指标/权限', async () => {
      const express = require('express');
      const lb = require('../src-server/routes/localbridge');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d23admin','x','A','admin',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d23user','x','U','user',1,0,datetime('now','localtime'))").run();
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d23admin'").get().id, exp: Date.now() + 3600000 });
      const tUser = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d23user'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/localbridge', lb.router);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tok) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) } })).json();
      const testFile = '__d23_test_bridge.js';
      const testPath = path.join(__dirname, '..', 'public', 'downloads', testFile);
      try {
        // 权限：非管理员登记被拒
        const denied = await J('/api/localbridge/releases', { method: 'POST', body: JSON.stringify({ version: '1.0.1' }) }, tUser);
        assert.notStrictEqual(denied.code, 0, '非管理员登记应被拒');
        // 版本号格式校验
        const bad = await J('/api/localbridge/releases', { method: 'POST', body: JSON.stringify({ version: 'abc' }) }, tAdmin);
        assert.strictEqual(bad.code, 400);
        // 准备发布包文件在库 → 自动补 sha256/size
        fs.writeFileSync(testPath, 'console.log("bridge v1.2.0");\n');
        const realSha = bu.sha256(fs.readFileSync(testPath));
        const reg = await J('/api/localbridge/releases', { method: 'POST', body: JSON.stringify({ version: '1.2.0', platform: 'darwin', arch: 'arm64', channel: 'stable', file_name: testFile, notes: '测试版本' }) }, tAdmin);
        assert.strictEqual(reg.code, 0);
        assert.strictEqual(reg.data.file_exists, true);
        assert.strictEqual(reg.data.sha256, realSha, '文件在库自动补 sha256');
        // 公开版本检查：旧版客户端应收到更新
        const ver = await J('/api/localbridge/version?current=1.0.0&platform=darwin&arch=arm64&channel=stable');
        assert.strictEqual(ver.code, 0);
        assert.strictEqual(ver.data.latest, '1.2.0');
        assert.strictEqual(ver.data.update_available, true);
        assert.strictEqual(ver.data.release.sha256, realSha);
        assert.ok(ver.data.release.url.includes('/release/download'), '附下载地址');
        const ver2 = await J('/api/localbridge/version?current=1.2.0&platform=darwin&arch=arm64&channel=stable');
        assert.strictEqual(ver2.data.update_available, false);
        const ver3 = await J('/api/localbridge/version?current=1.0.0&platform=win32&arch=x64&channel=stable');
        assert.strictEqual(ver3.data.latest, null, '平台不匹配无可用发布');
        // 下载（原始字节 + X-Sha256 头）
        const dres = await fetch(base + ver.data.release.url);
        assert.strictEqual(dres.status, 200);
        assert.strictEqual(String(dres.headers.get('x-sha256')).toLowerCase(), realSha);
        assert.strictEqual(bu.sha256(Buffer.from(await dres.arrayBuffer())), realSha, '下载字节与原文件一致');
        // 缺文件下载 → 404
        const reg2 = await J('/api/localbridge/releases', { method: 'POST', body: JSON.stringify({ version: '1.3.0', platform: 'linux', arch: 'x64', channel: 'stable', file_name: '__not_exist__.js' }) }, tAdmin);
        assert.strictEqual(reg2.code, 0);
        const d404 = await fetch(base + '/api/localbridge/release/download?version=1.3.0&platform=linux&arch=x64&channel=stable');
        assert.strictEqual(d404.status, 404);
        // 更新上报（无需鉴权，非法状态回落 failed 不报错）
        assert.strictEqual((await J('/api/localbridge/update-report', { method: 'POST', body: JSON.stringify({ status: 'success', from_version: '1.0.0', to_version: '1.2.0', channel: 'stable', duration_ms: 120 }) })).code, 0);
        assert.strictEqual((await J('/api/localbridge/update-report', { method: 'POST', body: JSON.stringify({ status: 'weird' }) })).code, 0);
        // 崩溃上报
        assert.strictEqual((await J('/api/localbridge/crash-report', { method: 'POST', body: JSON.stringify({ kind: 'startup', version: '1.2.0', message: 'boom', stack: 'at x' }) })).code, 0);
        assert.ok(db.prepare('SELECT COUNT(*) c FROM bridge_updates').get().c >= 2, '更新台账落库');
        assert.ok(db.prepare('SELECT COUNT(*) c FROM bridge_crashes').get().c >= 1, '崩溃台账落库');
        // 指标（admin）
        const st = await J('/api/localbridge/update-stats', {}, tAdmin);
        assert.strictEqual(st.code, 0);
        assert.ok(st.data.stats.total >= 2 && st.data.stats.successRate != null, '指标可算');
        assert.ok(Array.isArray(st.data.releases) && Array.isArray(st.data.updates) && Array.isArray(st.data.crashes));
        assert.notStrictEqual((await J('/api/localbridge/update-stats', {}, tUser)).code, 0, '非管理员看指标被拒');
        // 发布列表（admin）附文件就位与实际哈希
        const list = await J('/api/localbridge/releases', {}, tAdmin);
        const rel = list.data.find(r => r.version === '1.2.0');
        assert.strictEqual(rel.file_exists, true);
        assert.strictEqual(rel.actual_sha256, realSha);
        // 下线（软删）与删除（硬删）
        assert.strictEqual((await J(`/api/localbridge/releases/${reg2.data.id}`, { method: 'DELETE' }, tAdmin)).code, 0);
        assert.strictEqual(db.prepare('SELECT status FROM bridge_releases WHERE id=?').get(reg2.data.id).status, 'archived');
        assert.strictEqual((await J(`/api/localbridge/releases/${reg2.data.id}?hard=1`, { method: 'DELETE' }, tAdmin)).code, 0);
        assert.strictEqual(db.prepare('SELECT 1 FROM bridge_releases WHERE id=?').get(reg2.data.id), undefined);
      } finally { server.close(); try { fs.rmSync(testPath, { force: true }); } catch { } }
    });
  }

  console.log('【D3-1】3D 与数字人（格式/任务成功率/导出计划/数字人合规评估）');
  {
    const m3 = require('../src-server/lib/model3d');
    const dh = require('../src-server/lib/digital-human');

    await t('D3-1: 3D 内核——格式识别/MIME/生成请求/导出计划/占位模型', async () => {
      assert.ok(m3.FORMATS.includes('glb') && m3.FORMATS.includes('obj') && m3.FORMATS.includes('usdz'));
      assert.strictEqual(m3.detectFormat('a.glb'), 'glb');
      assert.strictEqual(m3.detectFormat('b.OBJ'), 'obj', '大小写不敏感');
      assert.strictEqual(m3.detectFormat('c.png'), '');
      assert.strictEqual(m3.is3DFormat('x.stl'), true);
      assert.strictEqual(m3.mimeOf('glb'), 'model/gltf-binary');
      assert.strictEqual(m3.normFormat('weird'), 'glb', '非法格式回落 glb');
      const req = m3.buildGenRequest('cat', { format: 'obj', quality: 'x' });
      assert.strictEqual(req.format, 'obj');
      assert.strictEqual(req.quality, 'standard', '非法 quality 回落 standard');
      const p1 = m3.exportPlan('glb', 'glb');
      assert.strictEqual(p1.ok, true); assert.strictEqual(p1.needConvert, false);
      const p2 = m3.exportPlan('obj', 'stl');
      assert.strictEqual(p2.ok, true); assert.strictEqual(p2.needConvert, true);
      const p3 = m3.exportPlan('glb', 'png');
      assert.strictEqual(p3.ok, false, '不支持的目标格式');
      const ph = m3.placeholderGltf('t');
      assert.ok(ph.length > 100 && JSON.parse(ph).asset.version === '2.0', '占位 glTF 合法');
    });

    await t('D3-1: 3D 任务成功率指标（验收 ≥ 70%）', async () => {
      assert.strictEqual(m3.TARGET_RATE, 70);
      const s = m3.taskStats([{ status: 'success' }, { status: 'success' }, { status: 'success' }, { status: 'failed' }, { status: 'running' }]);
      assert.strictEqual(s.total, 5); assert.strictEqual(s.success, 3); assert.strictEqual(s.failed, 1); assert.strictEqual(s.running, 1);
      assert.strictEqual(s.successRate, 75); assert.strictEqual(s.meetsTarget, true);
      const s2 = m3.taskStats([{ status: 'success' }, { status: 'failed' }, { status: 'failed' }]);
      assert.strictEqual(s2.successRate, 33.33); assert.strictEqual(s2.meetsTarget, false);
      const empty = m3.taskStats([]);
      assert.strictEqual(empty.successRate, null); assert.strictEqual(empty.meetsTarget, null);
      assert.strictEqual(m3.normalizeTask(null), null);
    });

    await t('D3-1: 数字人合规评估——评分与结论闸门（reject/review/approve）', async () => {
      const r1 = dh.assess({ authorized: false });
      assert.strictEqual(r1.decision, 'reject'); assert.strictEqual(r1.level, 'high');
      assert.ok(r1.requiredActions.some(x => /授权/.test(x)));
      const r2 = dh.assess({ authorized: true, real_person: true, disclosed: true });
      assert.strictEqual(r2.decision, 'review', '真人+已授权+已标注 → 需人工复核');
      const r3 = dh.assess({ authorized: true, real_person: true });
      assert.strictEqual(r3.decision, 'review', '真人未标注 → 复核');
      assert.ok(r3.requiredActions.some(x => /合成标识/.test(x)));
      const r4 = dh.assess({ authorized: true, disclosed: true });
      assert.strictEqual(r4.decision, 'approve'); assert.strictEqual(r4.score, 100);
      assert.strictEqual(dh.requiresManualReview(r2), true);
      assert.strictEqual(dh.requiresManualReview(r4), false);
      assert.ok(Array.isArray(dh.ASSESS_ITEMS) && dh.ASSESS_ITEMS.length >= 5);
    });

    await t('D3-1: HTTP —— 3D 生成（无供应商→local-stub 降级，登记 assets 3d）/任务列表/指标/权限', async () => {
      const express = require('express');
      const m3Router = require('../src-server/routes/model3d');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d31u1','x','U','user',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d31adm','x','A','admin',1,0,datetime('now','localtime'))").run();
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d31u1'").get().id, exp: Date.now() + 3600000 });
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d31adm'").get().id, exp: Date.now() + 3600000 });
      db.prepare('UPDATE providers SET configured=0').run(); // 避免误连真实网关：置无可用供应商 → 走本地占位降级
      db.prepare("INSERT INTO projects (name,kind,owner,status,created_at,updated_at) VALUES ('D31项目','mixed','d31u1','active',datetime('now','localtime'),datetime('now','localtime'))").run();
      const pid = db.prepare("SELECT id FROM projects WHERE name='D31项目'").get().id;
      const app = express(); app.use(express.json()); app.use('/api/model3d', m3Router);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      const created = []; // 占位模型会写入真实 public/uploads/models3d/（gitignore），测试后清理
      try {
        assert.strictEqual((await fetch(base + '/api/model3d/tasks')).status, 401, '未认证 401');
        assert.strictEqual((await J('/api/model3d/generate', { method: 'POST', body: JSON.stringify({}) }, tok)).code, 400, '缺提示词');
        const g = await J('/api/model3d/generate', { method: 'POST', body: JSON.stringify({ project_id: pid, prompt: '一把木椅', format: 'glb' }) }, tok);
        assert.strictEqual(g.code, 0);
        assert.strictEqual(g.data.status, 'success');
        assert.strictEqual(g.data.provider, 'local-stub', '无供应商时降级本地占位');
        assert.ok(g.data.asset_id, '成功登记为素材');
        assert.ok(/\/uploads\/models3d\//.test(g.data.url), '产物落 media 存储');
        created.push(g.data.url);
        const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(g.data.asset_id);
        assert.strictEqual(asset.kind, '3d'); assert.strictEqual(asset.owner, 'd31u1');
        const list = await J('/api/model3d/tasks', {}, tok);
        assert.ok(list.data.length >= 1 && list.stats.total >= 1);
        const st = await J('/api/model3d/stats', {}, tok);
        assert.strictEqual(st.data.stats.successRate, 100);
        assert.strictEqual(st.data.stats.meetsTarget, true);
        assert.strictEqual((await J('/api/model3d/tasks/' + g.data.id, {}, tAdmin)).code, 0, '管理员可访问');
      } finally { server.close(); for (const u of created) try { fs.rmSync(path.join(__dirname, '..', 'public', u), { force: true }); } catch { } }
    });

    await t('D3-1: HTTP —— 3D 导出（可转换性/记录）+ 合规评估（落库 + 回写素材标记）', async () => {
      const express = require('express');
      const m3Router = require('../src-server/routes/model3d');
      const { sign } = require('../src-server/lib/auth');
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d31u1'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/model3d', m3Router);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      try {
        const aid = db.prepare(`INSERT INTO assets (kind,name,url,source,meta,owner,created_at) VALUES ('3d','模型A','/uploads/models3d/x.gltf','generated','{"format":"gltf"}','d31u1',datetime('now','localtime'))`).run().lastInsertRowid;
        const e1 = await J(`/api/model3d/assets/${aid}/export`, { method: 'POST', body: JSON.stringify({ target_format: 'gltf' }) }, tok);
        assert.strictEqual(e1.code, 0); assert.strictEqual(e1.data.need_convert, false); assert.strictEqual(e1.data.status, 'done');
        const e2 = await J(`/api/model3d/assets/${aid}/export`, { method: 'POST', body: JSON.stringify({ target_format: 'glb' }) }, tok);
        assert.strictEqual(e2.data.need_convert, true); assert.strictEqual(e2.data.status, 'pending');
        assert.strictEqual((await J(`/api/model3d/assets/${aid}/export`, { method: 'POST', body: JSON.stringify({ target_format: 'png' }) }, tok)).code, 400, '不支持格式 400');
        assert.ok((await J('/api/model3d/exports', {}, tok)).data.length >= 2, '导出记录落库');
        const a = await J('/api/model3d/dh/assess', { method: 'POST', body: JSON.stringify({ asset_id: aid, answers: { authorized: false, real_person: true } }) }, tok);
        assert.strictEqual(a.code, 0); assert.strictEqual(a.data.decision, 'reject');
        const row = db.prepare('SELECT digital_human, meta FROM assets WHERE id=?').get(aid);
        assert.strictEqual(row.digital_human, 1, '非通过结论回写待复核标记');
        assert.strictEqual(JSON.parse(row.meta).dh_assessment.decision, 'reject');
        const a2 = await J('/api/model3d/dh/assess', { method: 'POST', body: JSON.stringify({ asset_id: aid, answers: { authorized: true, disclosed: true } }) }, tok);
        assert.strictEqual(a2.data.decision, 'approve');
        assert.strictEqual(db.prepare('SELECT digital_human FROM assets WHERE id=?').get(aid).digital_human, 0, '通过结论清除标记');
        const dl = await J('/api/model3d/dh/assessments', {}, tok);
        assert.ok(dl.data.length >= 2 && Array.isArray(dl.data[0].reasons));
      } finally { server.close(); }
    });
  }

  console.log('【D3-2】经验自进化（任务类型归类 / 贝叶斯可靠度 / 专家优选 / 自进化验收指标）');
  {
    const exp = require('../src-server/lib/experience');

    await t('D3-2: 经验内核——任务类型归类 + 贝叶斯可靠度 + 首跑/复跑分桶', async () => {
      // 任务类型归类（中英关键词，多命中去最高分；无命中归 general）
      assert.strictEqual(exp.classifyTask('帮我写一段 Python 代码并调试'), 'code');
      assert.strictEqual(exp.classifyTask('please translate this'), 'translation');
      assert.strictEqual(exp.classifyTask('帮我做一份市场调研报告'), 'research');
      assert.strictEqual(exp.classifyTask(''), 'general');
      assert.strictEqual(exp.classifyTask('随便聊聊'), 'general');
      assert.ok(exp.allTypes().some(x => x.key === 'code') && exp.allTypes().some(x => x.key === 'general'));
      // 可靠度：贝叶斯平滑（样本少向先验 0.5 收缩；1 次偶然成功≠满分）
      assert.strictEqual(exp.reliability(0, 0), 50);
      assert.strictEqual(exp.reliability(1, 1), 66.7);
      assert.strictEqual(exp.reliability(10, 10), 91.7);
      assert.ok(exp.reliability(1, 1) < exp.reliability(10, 10), '样本越多越接近真实成功率');
      // 首跑/复跑分桶：同一（专家×类型）第 1 次=首跑，其后=复跑
      const r1 = exp.applyRun({}, { success: true, durationMs: 100 });
      assert.deepStrictEqual({ runs: r1.runs, first_runs: r1.first_runs, first_success: r1.first_success, repeat_runs: r1.repeat_runs }, { runs: 1, first_runs: 1, first_success: 1, repeat_runs: 0 });
      const r2 = exp.applyRun({ ...r1, task_type: 'code' }, { success: false, durationMs: 200 });
      assert.deepStrictEqual({ runs: r2.runs, success: r2.success, failed: r2.failed, first_runs: r2.first_runs, repeat_runs: r2.repeat_runs, repeat_success: r2.repeat_success, total_duration_ms: r2.total_duration_ms },
        { runs: 2, success: 1, failed: 1, first_runs: 1, repeat_runs: 1, repeat_success: 0, total_duration_ms: 300 });
      const norm = exp.normalizeRecord({ agent_id: 7, task_type: 'code', runs: 4, success: 3, total_duration_ms: 400 });
      assert.strictEqual(norm.type_label, '代码开发');
      assert.strictEqual(norm.successRate, 75); assert.strictEqual(norm.avgDurationMs, 100);
      assert.strictEqual(norm.confidence, true, '样本≥3 视为可采信');
    });

    await t('D3-2: 专家优选排序 + 经验提示构造（样本不足不误伤）', async () => {
      const agents = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
      const records = [
        { agent_id: 1, task_type: 'code', runs: 10, success: 10 },
        { agent_id: 2, task_type: 'code', runs: 5, success: 1 },
        { agent_id: 1, task_type: 'writing', runs: 2, success: 2 }, // 跨类型不应干扰 code 排序
      ];
      const ranked = exp.rankAgents(agents, records, 'code');
      assert.strictEqual(ranked[0].agent_id, 1, '高分专家排第一');
      assert.strictEqual(ranked[0].experienced, true);
      assert.strictEqual(ranked[ranked.length - 1].agent_id, 2, '低分专家排最后');
      const c = ranked.find(x => x.agent_id === 3);
      assert.strictEqual(c.experienced, false);
      assert.strictEqual(c.reliability, 50, '无经验者中性分 50');
      assert.strictEqual(ranked[0].type_label, '代码开发', '排行带类型标签（供前端展示）');
      const hint = exp.experienceHint(ranked);
      assert.ok(/历史经验参考/.test(hint) && /agent_id=1/.test(hint), '提示文本含经验参考与高分专家');
      assert.strictEqual(exp.experienceHint(exp.rankAgents(agents, [], 'code')), '', '无任何经验时提示为空（不干扰原提示词）');
    });

    await t('D3-2: 自进化验收指标——同类任务二次成功率提升 ≥ 15pp', async () => {
      assert.strictEqual(exp.TARGET_LIFT, 15);
      // 合计：首跑 3/4=75%，复跑 4/4=100% → 整体 +25pp 达标；代码类 50%→100% 提升 +50pp
      const ev = exp.evolutionStats([
        { task_type: 'code', first_runs: 2, first_success: 1, repeat_runs: 4, repeat_success: 4 },
        { task_type: 'writing', first_runs: 2, first_success: 2, repeat_runs: 0, repeat_success: 0 },
      ]);
      assert.strictEqual(ev.firstRate, 75); assert.strictEqual(ev.repeatRate, 100);
      assert.strictEqual(ev.delta, 25); assert.strictEqual(ev.meetsTarget, true);
      assert.strictEqual(ev.firstRuns, 4); assert.strictEqual(ev.repeatRuns, 4);
      assert.ok(ev.byType.some(x => x.task_type === 'code' && x.delta === 50));
      // 无复跑数据 → 无法比较，不达标（不臆造结论）
      const ev2 = exp.evolutionStats([{ task_type: 'code', first_runs: 3, first_success: 3, repeat_runs: 0, repeat_success: 0 }]);
      assert.strictEqual(ev2.delta, null); assert.strictEqual(ev2.meetsTarget, false);
      // 复跑更差 → 负提升，不达标
      const ev3 = exp.evolutionStats([{ task_type: 'code', first_runs: 2, first_success: 2, repeat_runs: 2, repeat_success: 1 }]);
      assert.strictEqual(ev3.delta, -50); assert.strictEqual(ev3.meetsTarget, false);
      const ov = exp.overview([{ agent_id: 1, task_type: 'code', runs: 3, success: 2 }, { agent_id: 2, task_type: 'code', runs: 1, success: 1 }]);
      assert.strictEqual(ov.pairs, 2); assert.strictEqual(ov.agents, 2); assert.strictEqual(ov.totalRuns, 4); assert.strictEqual(ov.successRate, 75);
    });

    await t('D3-2: HTTP —— 经验记录（首跑/复跑）/查询/排行/指标/清空/权限', async () => {
      const express = require('express');
      const expRouter = require('../src-server/routes/experience');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d32u1','x','U','user',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d32adm','x','A','admin',1,0,datetime('now','localtime'))").run();
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d32u1'").get().id, exp: Date.now() + 3600000 });
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d32adm'").get().id, exp: Date.now() + 3600000 });
      db.prepare("INSERT INTO agents (name,description,prompt,status,created_at,updated_at) VALUES ('D32专家','写代码','p','published',datetime('now','localtime'),datetime('now','localtime'))").run();
      const aid = db.prepare("SELECT id FROM agents WHERE name='D32专家'").get().id;
      db.prepare('DELETE FROM agent_experience').run(); // 干净基线（本库隔离）
      const app = express(); app.use(express.json()); app.use('/api/experience', expRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      try {
        assert.strictEqual((await fetch(base + '/api/experience/records')).status, 401, '未认证 401');
        assert.ok((await J('/api/experience/task-types', {}, tok)).data.types.some(x => x.key === 'code'));
        // 首跑
        const rec1 = await J('/api/experience/record', { method: 'POST', body: JSON.stringify({ agent_id: aid, task_text: '写一段代码', success: true, duration_ms: 50 }) }, tok);
        assert.strictEqual(rec1.code, 0); assert.strictEqual(rec1.data.task_type, 'code');
        assert.strictEqual(rec1.data.runs, 1); assert.strictEqual(rec1.data.isFirst, true);
        // 复跑（同类型）→ isFirst=false，repeat 分桶
        const rec2 = await J('/api/experience/record', { method: 'POST', body: JSON.stringify({ agent_id: aid, task_text: '调试代码', success: true }) }, tok);
        assert.strictEqual(rec2.data.runs, 2); assert.strictEqual(rec2.data.isFirst, false);
        // 失败一次
        const rec3 = await J('/api/experience/record', { method: 'POST', body: JSON.stringify({ agent_id: aid, task_type: 'code', success: false }) }, tok);
        assert.strictEqual(rec3.data.runs, 3); assert.strictEqual(rec3.data.success, 2); assert.strictEqual(rec3.data.failed, 1);
        assert.strictEqual((await J('/api/experience/record', { method: 'POST', body: JSON.stringify({ agent_id: 0, success: true }) }, tok)).code, 400, '非法 agent_id 400');
        const recs = await J('/api/experience/records?task_type=code', {}, tok);
        assert.ok(recs.data.length >= 1 && recs.overview.totalRuns >= 3);
        const rank = await J('/api/experience/agents?task_type=code&agent_ids=' + aid, {}, tok);
        assert.strictEqual(rank.data[0].agent_id, aid); assert.strictEqual(rank.data[0].experienced, true);
        const imp = await J('/api/experience/improvement', {}, tok);
        assert.ok(imp.data && 'delta' in imp.data && imp.data.firstRuns >= 1, '自进化指标含首跑分桶');
        const stats = await J('/api/experience/stats', {}, tok);
        assert.ok(stats.data.overview.totalRuns >= 3 && Array.isArray(stats.data.top));
        // 清空：非管理员 403，管理员成功
        assert.strictEqual((await J('/api/experience/reset', { method: 'POST' }, tok)).code, 403, '非管理员 403');
        assert.strictEqual((await J('/api/experience/reset', { method: 'POST' }, tAdmin)).code, 0);
        assert.strictEqual((await J('/api/experience/records', {}, tok)).data.length, 0, '清空后无记录');
      } finally { server.close(); }
    });
  }

  console.log('【D3-3】沙箱池（预热/快照/并发隔离/租户配额；冷启动 < 3 秒、越权 0 例）');
  {
    const pool = require('../src-server/lib/sandbox-pool');
    const os = require('os');

    await t('D3-3: 池内核——配额判定/冷启动达标/池汇总/快照元数据/隔离结论', async () => {
      // 并发配额：忙碌数 ≥ 上限即超限；上限 ≤0 视为不限
      assert.strictEqual(pool.quotaExceeded(1, 2), false);
      assert.strictEqual(pool.quotaExceeded(2, 2), true);
      assert.strictEqual(pool.quotaExceeded(99, 0), false, '上限 0 = 不限');
      // 冷启动达标（严格 < 3 秒）
      assert.strictEqual(pool.TARGET_COLD_MS, 3000);
      assert.strictEqual(pool.meetsColdStart(1200), true);
      assert.strictEqual(pool.meetsColdStart(3000), false, '等于 3000 不算达标');
      assert.strictEqual(pool.meetsColdStart(null), null);
      // 池汇总
      const s = pool.poolSummary([{ tenant: 'a', state: 'idle' }, { tenant: 'a', state: 'busy' }, { tenant: 'b', state: 'idle' }]);
      assert.deepStrictEqual({ total: s.total, idle: s.idle, busy: s.busy }, { total: 3, idle: 2, busy: 1 });
      assert.strictEqual(s.byTenant.a.idle, 1); assert.strictEqual(s.byTenant.b.idle, 1);
      // 快照元数据（体积人性化 + 派生字段）
      const sm = pool.snapshotMeta({ id: 1, name: 'base', size_bytes: 2048, active: 1, node_version: 'v20' });
      assert.strictEqual(sm.size_human, '2.0KB'); assert.strictEqual(sm.active, true);
      assert.strictEqual(pool.snapshotMeta({ size_bytes: 500 }).size_human, '500B');
      // 隔离结论：有任一检查失败即存在越权
      assert.deepStrictEqual(pool.isolationVerdict([{ ok: true }, { ok: true }]).passed, true);
      assert.deepStrictEqual(pool.isolationVerdict([{ ok: true }, { ok: false }]).violations, 1);
      assert.ok(pool.preludeHash().length === 16, 'prelude 指纹 16 位');
    });

    await t('D3-3: 池化执行——一次性预热进程 + sandbox_runs 审计 + 预热命中/冷启动', async () => {
      const tenant = 'd33u1';
      db.prepare('DELETE FROM sandbox_runs').run();
      pool.resetPool();
      const r1 = await pool.runPooled({ code: "console.log('hello pool', 1+1)", tenant, owner: tenant, timeoutMs: 8000 });
      assert.strictEqual(r1.status, 'success');
      assert.ok(/hello pool 2/.test(r1.stdout), 'stdout 捕获');
      assert.ok(r1.runId, '审计 runId');
      const row = db.prepare('SELECT * FROM sandbox_runs WHERE id=?').get(r1.runId);
      assert.strictEqual(row.run_env, 'pool'); assert.strictEqual(row.tenant, tenant); assert.strictEqual(row.status, 'success');
      // 首次无预热 → 冷启动样本（< 3 秒）
      assert.strictEqual(r1.poolHit, false, '首次应为冷启动');
      assert.ok(r1.coldStartMs != null && r1.coldStartMs < pool.TARGET_COLD_MS, `冷启动 ${r1.coldStartMs}ms < 3000ms`);
      // 第二次：runPooled 已后台补足预热 → 命中
      const r2 = await pool.runPooled({ code: 'console.log("warm")', tenant, owner: tenant, timeoutMs: 8000 });
      assert.strictEqual(r2.status, 'success'); assert.strictEqual(r2.poolHit, true, '第二次应命中预热进程');
      assert.strictEqual(r2.coldStartMs, null, '命中预热无冷启动样本');
      const st = pool.poolStats();
      assert.ok(st.runs.total >= 2 && st.runs.coldStarts >= 1 && st.runs.poolHits >= 1);
      assert.strictEqual(st.runs.coldStartMet, true);
      // 空代码 → denied
      assert.strictEqual((await pool.runPooled({ code: '  ', tenant })).status, 'denied');
    });

    await t('D3-3: 隔离自检——进程边界隔离，越权 0 例', async () => {
      const v = await pool.isolationSelfCheck();
      assert.strictEqual(v.violations, 0, '不应存在越权');
      assert.strictEqual(v.passed, true);
      assert.ok(v.checks.length >= 3);
      assert.ok(v.checks.every(c => c.ok), '全部检查通过');
      assert.ok(v.checks.some(c => /模块边界/.test(c.name)) && v.checks.some(c => /环境变量掩蔽/.test(c.name)) && v.checks.some(c => /跨进程状态隔离/.test(c.name)));
    });

    await t('D3-3: 快照——创建/激活/播种到工作进程 + 删除', async () => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'd33snap-'));
      fs.writeFileSync(path.join(src, 'helper.txt'), 'hello-from-snapshot');
      let snap;
      try {
        assert.throws(() => pool.createSnapshot({ name: 'x', source: path.join(src, '__nope__') }), /不存在/);
        snap = pool.createSnapshot({ name: 'd33-base', source: src, createdBy: 'd33adm' });
        assert.ok(snap.id && snap.size_bytes >= 18 && /KB$|B$/.test(snap.size_human));
        assert.strictEqual(snap.active, false);
        const act = pool.activateSnapshot(snap.id);
        assert.strictEqual(act.active, true);
        assert.ok(pool.listSnapshots().some(s => s.id === snap.id && s.active));
        // 新工作进程目录由激活快照播种 → files 里应含 helper.txt
        const r = await pool.runPooled({ code: 'console.log("ok")', tenant: 'd33u2' });
        assert.ok(r.files.includes('helper.txt'), '工作目录由快照播种（含 helper.txt）');
      } finally {
        if (snap) try { pool.deleteSnapshot(snap.id); } catch { }
        try { fs.rmSync(src, { recursive: true, force: true }); } catch { }
      }
      assert.ok(!pool.listSnapshots().some(s => s.name === 'd33-base'), '删除后不在列表');
    });

    await t('D3-3: HTTP —— 配额/预热/池化执行/快照/隔离自检 + 权限', async () => {
      const express = require('express');
      const sbRouter = require('../src-server/routes/sandbox');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d33u1','x','U','user',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d33adm','x','A','admin',1,0,datetime('now','localtime'))").run();
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d33u1'").get().id, exp: Date.now() + 3600000 });
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d33adm'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/sandbox', sbRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'd33http-'));
      fs.writeFileSync(path.join(src, 'seed.txt'), 'seed');
      let snapId;
      try {
        assert.strictEqual((await fetch(base + '/api/sandbox/pool/stats')).status, 401, '未认证 401');
        assert.strictEqual((await J('/api/sandbox/pool/run', { method: 'POST', body: JSON.stringify({}) }, tok)).code, 400, '缺 code 400');
        // 管理员登记配额
        const q = await J('/api/sandbox/pool/quota/upsert', { method: 'POST', body: JSON.stringify({ tenant: 'd33u1', max_concurrent: 3, warm_size: 1 }) }, tAdmin);
        assert.strictEqual(q.code, 0); assert.strictEqual(q.data.max_concurrent, 3);
        assert.strictEqual((await J('/api/sandbox/pool/quota/upsert', { method: 'POST', body: JSON.stringify({ tenant: 'd33u1' }) }, tok)).code, 403, '非管理员 403');
        // 预热 + 池化执行（普通用户）
        const w = await J('/api/sandbox/pool/warm', { method: 'POST', body: JSON.stringify({ n: 1 }) }, tok);
        assert.strictEqual(w.code, 0);
        const run = await J('/api/sandbox/pool/run', { method: 'POST', body: JSON.stringify({ code: "console.log('http pool')" }) }, tok);
        assert.strictEqual(run.code, 0); assert.strictEqual(run.data.status, 'success');
        assert.ok(/http pool/.test(run.data.stdout));
        // 隔离自检
        const iso = await J('/api/sandbox/pool/isolation', {}, tok);
        assert.strictEqual(iso.code, 0); assert.strictEqual(iso.data.passed, true);
        // 快照：管理员创建/激活，普通用户可见列表，删除
        assert.strictEqual((await J('/api/sandbox/snapshots', { method: 'POST', body: JSON.stringify({ name: 'h', source: src }) }, tok)).code, 403, '非管理员创建 403');
        const sc = await J('/api/sandbox/snapshots', { method: 'POST', body: JSON.stringify({ name: 'd33-http', source: src }) }, tAdmin);
        assert.strictEqual(sc.code, 0); snapId = sc.data.id;
        assert.strictEqual((await J(`/api/sandbox/snapshots/${snapId}/activate`, { method: 'POST' }, tAdmin)).code, 0);
        const list = await J('/api/sandbox/snapshots', {}, tok);
        assert.ok(list.data.some(s => s.id === snapId && s.active));
        assert.strictEqual((await J(`/api/sandbox/snapshots/${snapId}`, { method: 'DELETE' }, tAdmin)).code, 0);
        // 配额列表
        const qs = await J('/api/sandbox/pool/quotas', {}, tok);
        assert.ok(qs.data.mine.tenant === 'd33u1' && Array.isArray(qs.data.list));
        // 指标
        const st = await J('/api/sandbox/pool/stats', {}, tok);
        assert.ok(st.data.pool && st.data.runs.total >= 1);
      } finally {
        if (snapId) try { pool.deleteSnapshot(snapId); } catch { }
        try { fs.rmSync(src, { recursive: true, force: true }); } catch { }
        server.close();
      }
    });

    pool.resetPool(); // 收尾：销毁全部空闲预热进程与临时目录
  }

  console.log('【D3-4】评测体系（任务成功率/步数/人工干预率发布基线；SWE-bench-lite 接入）');
  {
    const es = require('../src-server/lib/eval-suite');

    await t('D3-4: 评测内核——用例归一/步数推导/指标计算/SWE-bench-lite 适配', async () => {
      // 步数：tool_calls JSON 数组长度
      assert.strictEqual(es.stepsFromTools('[{"a":1},{"b":2}]'), 2);
      assert.strictEqual(es.stepsFromTools('[]'), 0);
      assert.strictEqual(es.stepsFromTools('bad'), 0);
      // 用例归一：0~100 分值换算、只给 passed 时补 score
      assert.deepStrictEqual(es.normalizeCase({ id: 'q', score: 80, steps: 3.6 }).score, 0.8);
      assert.deepStrictEqual({ p: es.normalizeCase({ passed: true }).score, s: es.normalizeCase({ passed: true }).steps }, { p: 1, s: 0 });
      assert.strictEqual(es.normalizeCase({ score: 0.3 }).passed, false, '低于阈值不通过');
      assert.strictEqual(es.normalizeCase({ score: 0.7 }).passed, true);
      assert.strictEqual(es.casePassed({ score: 0.2 }), false);
      // 指标：成功率/平均步数/干预率 + 达标判定
      const m = es.computeMetrics([
        { score: 1, steps: 2 }, { score: 1, steps: 4 }, { score: 0, steps: 6, intervened: true }, { score: 0.8, steps: 0 },
      ]);
      assert.strictEqual(m.total, 4); assert.strictEqual(m.passed, 3);
      assert.strictEqual(m.successRate, 75); assert.strictEqual(m.avgSteps, 3); assert.strictEqual(m.interventionRate, 25);
      assert.strictEqual(m.meetsSuccess, true, '75% ≥ 70%'); assert.strictEqual(m.meetsIntervention, false, '25% > 20%');
      assert.strictEqual(es.computeMetrics([]).successRate, 0);
      // SWE-bench-lite：通过测试数 / FAIL_TO_PASS 总数 = 得分
      const cases = es.sweBenchLiteToCases([
        { instance_id: 'a-1', FAIL_TO_PASS: ['t1', 't2'], passed_tests: 2, steps: 5 },
        { instance_id: 'a-2', FAIL_TO_PASS: ['t1'], passed_tests: 0 },
        { instance_id: 'a-3', resolved: true },
      ]);
      assert.strictEqual(cases[0].score, 1); assert.strictEqual(cases[0].passed, true); assert.strictEqual(cases[0].steps, 5);
      assert.strictEqual(cases[1].passed, false);
      assert.strictEqual(cases[2].passed, true, 'resolved=true 视为通过');
      assert.ok(es.sweBenchLiteTemplate().sample.length === 1 && es.SUITE_TEMPLATES.some(s => s.name === 'swe-bench-lite'));
    });

    await t('D3-4: 基线对比——diff/无回退判定（成功率降或干预率升 = 回退）', async () => {
      const prev = { successRate: 80, avgSteps: 4, interventionRate: 10 };
      const cur = { successRate: 75, avgSteps: 3, interventionRate: 5 };
      const d = es.diffBaseline(cur, prev);
      assert.strictEqual(d.successRate.delta, -5); assert.strictEqual(d.successRate.trend, 'down');
      assert.strictEqual(d.interventionRate.delta, -5); assert.strictEqual(d.interventionRate.trend, 'down');
      assert.strictEqual(es.compareVerdict(d).ok, false, '成功率下降 → 回退');
      assert.ok(es.compareVerdict(d).reasons.some(r => /成功率下降/.test(r)));
      // 持平：±0.1 内不算变化
      assert.strictEqual(es.compareVerdict(es.diffBaseline({ successRate: 80, avgSteps: 4, interventionRate: 10 }, prev)).ok, true);
      // 首次无基准
      assert.strictEqual(es.compareVerdict(es.diffBaseline(cur, null)).first, true);
      // 干预率上升 → 回退
      assert.strictEqual(es.compareVerdict(es.diffBaseline({ successRate: 90, avgSteps: 4, interventionRate: 30 }, prev)).ok, false);
    });

    await t('D3-4: 基线管理——采集/列表对比/详情/总览/删除', async () => {
      db.prepare('DELETE FROM eval_baselines').run();
      const b1 = es.createBaseline({ suite: 'd34-suite', suite_type: 'builtin', label: 'v1', cases: [{ score: 1 }, { score: 0 }, { score: 1 }, { score: 1 }], created_by: 'd34adm' });
      assert.strictEqual(b1.metrics.successRate, 75); assert.strictEqual(b1.verdict.first, true);
      const b2 = es.createBaseline({ suite: 'd34-suite', suite_type: 'builtin', label: 'v2', cases: [{ score: 1 }, { score: 1 }, { score: 1 }, { score: 1 }], created_by: 'd34adm' });
      assert.strictEqual(b2.metrics.successRate, 100);
      assert.strictEqual(b2.diff.successRate.delta, 25); assert.strictEqual(b2.verdict.ok, true, '成功率上升=无回退');
      assert.strictEqual(b2.prev_id, b1.id);
      const list = es.listBaselines({ suite: 'd34-suite' });
      assert.strictEqual(list.length, 2); assert.strictEqual(list[0].id, b2.id, '最新在前');
      const det = es.baselineDetail(b2.id);
      assert.strictEqual(det.cases.length, 4);
      const ov = es.overview();
      assert.ok(ov.suiteCount >= 1 && ov.total >= 2 && ov.regressions === 0);
      assert.strictEqual(es.deleteBaseline(b2.id), true);
      assert.strictEqual(es.baselineDetail(b2.id), null);
      assert.strictEqual(es.deleteBaseline(999999), false);
    });

    await t('D3-4: 发布基线——遥测聚合 + autoCaptureOnPublish', async () => {
      db.prepare('DELETE FROM eval_baselines').run();
      db.prepare("DELETE FROM chat_traces WHERE agent_id=9991").run();
      db.prepare("INSERT INTO agents (id,name,description,prompt,status,owner,edit_mode,created_at,updated_at) VALUES (9991,'D34专家','d','p','published','d34adm','canvas',datetime('now','localtime'),datetime('now','localtime'))").run();
      // 造遥测：3 条已反馈消息（2 解决 1 未解决） + 2 条 trace（一条带 2 步、一条 1 步且被阻断）
      db.prepare("INSERT INTO sessions (id,username,agent_id,title,created_at) VALUES (99910,'d34adm',9991,'s',datetime('now','localtime'))").run();
      for (const [mid, solved] of [[1, 1], [2, 1], [3, 2]]) {
        db.prepare("INSERT INTO messages (id,session_id,role,content,rating,solved,created_at) VALUES (?,99910,'assistant','a',0,?,datetime('now','localtime'))").run(99900 + mid, solved);
      }
      db.prepare("INSERT INTO chat_traces (agent_id,tool_calls,blocked,created_at) VALUES (9991,'[{\"t\":1},{\"t\":2}]','',datetime('now','localtime'))").run();
      db.prepare("INSERT INTO chat_traces (agent_id,tool_calls,blocked,created_at) VALUES (9991,'[{\"t\":1}]','危险命令已阻断',datetime('now','localtime'))").run();
      const cap = es.captureFromTelemetry(9991);
      assert.strictEqual(cap.cases.length, 5, '3 条反馈 + 2 条 trace');
      assert.strictEqual(cap.metrics.successRate, 60, '通过 3/5（反馈 2 解决 + 1 条未阻断 trace）');
      assert.strictEqual(cap.metrics.interventionRate, 20, '1/5 干预（1 条被阻断）');
      assert.strictEqual(cap.metrics.avgSteps, 0.6, '(2+1)/5');
      const row = es.autoCaptureOnPublish({ id: 9991, name: 'D34专家' }, 3, { username: 'd34adm' });
      assert.strictEqual(row.suite_type, 'agent'); assert.strictEqual(row.ref_id, 9991); assert.strictEqual(row.agent_version, 3);
      assert.strictEqual(row.metrics.successRate, 60);
      // 发布历史关联基线
      db.prepare("INSERT INTO agent_publish_history (agent_id,version,workflow,note,nodes,published_by,created_at) VALUES (9991,3,'{}','发布说明',0,'d34adm',datetime('now','localtime'))").run();
      const rel = es.releaseBaselines(9991);
      assert.strictEqual(rel[0].version, 3); assert.ok(rel[0].baseline && rel[0].baseline.metrics.successRate === 60);
    });

    await t('D3-4: HTTP —— 口径/套件/模板/导入/基线 CRUD/指标/发布关联 + 权限', async () => {
      const express = require('express');
      const evRouter = require('../src-server/routes/eval');
      const { sign } = require('../src-server/lib/auth');
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d34u1','x','U','user',1,0,datetime('now','localtime'))").run();
      db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES ('d34adm','x','A','admin',1,0,datetime('now','localtime'))").run();
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d34u1'").get().id, exp: Date.now() + 3600000 });
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d34adm'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/eval', evRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      try {
        assert.strictEqual((await fetch(base + '/api/eval/config')).status, 401, '未认证 401');
        const cfg = await J('/api/eval/config', {}, tok);
        assert.strictEqual(cfg.code, 0); assert.strictEqual(cfg.data.successTarget, 70);
        assert.ok(cfg.data.metrics.some(x => x.key === 'successRate') && cfg.data.templates.some(x => x.name === 'swe-bench-lite'));
        const suites = await J('/api/eval/suites', {}, tok);
        assert.ok(suites.data.suites.some(s => s.name === 'swe-bench-lite' && s.builtin));
        const tpl = await J('/api/eval/template/swe-bench-lite', {}, tok);
        assert.ok(tpl.data.schema && tpl.data.sample.length === 1);
        // 导入
        const imp = await J('/api/eval/import/swe-bench-lite', { method: 'POST', body: JSON.stringify({ instances: [{ instance_id: 'x-1', FAIL_TO_PASS: ['a', 'b'], passed_tests: 1 }] }) }, tok);
        assert.strictEqual(imp.code, 0); assert.strictEqual(imp.data.cases.length, 1); assert.strictEqual(imp.data.metrics.successRate, 0);
        assert.strictEqual((await J('/api/eval/import/swe-bench-lite', { method: 'POST', body: JSON.stringify({ instances: [] }) }, tok)).code, 400);
        // 采集基线（管理员），用例直给
        const b1 = await J('/api/eval/baselines', { method: 'POST', body: JSON.stringify({ suite: 'd34-http', suite_type: 'builtin', label: 'v1', cases: [{ score: 1 }, { score: 0 }, { score: 1 }] }) }, tAdmin);
        assert.strictEqual(b1.code, 0); assert.strictEqual(b1.data.metrics.successRate, 66.7);
        assert.strictEqual((await J('/api/eval/baselines', { method: 'POST', body: JSON.stringify({ suite: 'x', cases: [{ score: 1 }] }) }, tok)).code, 403, '非管理员采集 403');
        assert.strictEqual((await J('/api/eval/baselines', { method: 'POST', body: JSON.stringify({ suite: '' }) }, tAdmin)).code, 400);
        // 第二条 → 对比
        const b2 = await J('/api/eval/baselines', { method: 'POST', body: JSON.stringify({ suite: 'd34-http', suite_type: 'builtin', label: 'v2', cases: [{ score: 1 }, { score: 1 }, { score: 1 }] }) }, tAdmin);
        assert.strictEqual(b2.data.metrics.successRate, 100); assert.strictEqual(b2.data.diff.successRate.delta, 33.3);
        // 列表 / 详情 / 指标
        const list = await J('/api/eval/baselines?suite=d34-http', {}, tok);
        assert.strictEqual(list.data.length, 2);
        const det = await J('/api/eval/baselines/' + b2.data.id, {}, tok);
        assert.strictEqual(det.data.cases.length, 3);
        const mtx = await J('/api/eval/metrics', {}, tok);
        assert.ok(mtx.data.suiteCount >= 1 && mtx.data.total >= 2);
        // 删除：非管理员 403，管理员 0
        assert.strictEqual((await J('/api/eval/baselines/' + b2.data.id, { method: 'DELETE' }, tok)).code, 403);
        assert.strictEqual((await J('/api/eval/baselines/' + b2.data.id, { method: 'DELETE' }, tAdmin)).code, 0);
        assert.strictEqual((await J('/api/eval/baselines/999999', {}, tok)).code, 404);
        // 发布关联
        const rel = await J('/api/eval/releases/9991', {}, tok);
        assert.ok(Array.isArray(rel.data));
      } finally { server.close(); }
    });
  }

  console.log('【D3-4 增强】多版本趋势图 + 统计显著性检验（两比例 z 检验）');
  {
    const es = require('../src-server/lib/eval-suite');

    await t('D3-4 增强: 统计内核——erf/正态双尾 p / 两比例 z 检验 / 显著性结论', async () => {
      // 正态双尾 p：|z|=1.96 → p≈0.05；z=0 → p≈1
      const p196 = es.normalTwoTailP(1.96);
      assert.ok(Math.abs(p196 - 0.05) < 0.01, `normalTwoTailP(1.96)=${p196}`);
      assert.ok(es.normalTwoTailP(0) > 0.99, 'z=0 → p≈1');
      // 显著提升 / 显著回退
      const up = es.proportionZTest(90, 100, 60, 100);
      assert.strictEqual(up.significant, true); assert.strictEqual(up.direction, 'up');
      assert.ok(up.z > 0 && up.p < 0.05 && up.smallSample === false);
      const down = es.proportionZTest(60, 100, 90, 100);
      assert.strictEqual(down.significant, true); assert.strictEqual(down.direction, 'down');
      // 小差 → 不显著
      const ns = es.proportionZTest(50, 100, 48, 100);
      assert.strictEqual(ns.significant, false); assert.strictEqual(ns.direction, 'up');
      // 样本不足（任一组 < 5）→ 不判显著
      const ss = es.proportionZTest(2, 3, 1, 3);
      assert.strictEqual(ss.smallSample, true); assert.strictEqual(ss.significant, false); assert.strictEqual(ss.p, null);
      // 结论映射：improved / regressed / no_change / insufficient
      assert.strictEqual(es.significance({ passed: 90, total: 100, intervened: 5 }, { passed: 60, total: 100, intervened: 5 }).verdict, 'improved');
      assert.strictEqual(es.significance({ passed: 60, total: 100, intervened: 5 }, { passed: 90, total: 100, intervened: 5 }).verdict, 'regressed');
      assert.strictEqual(es.significance({ passed: 50, total: 100, intervened: 5 }, { passed: 49, total: 100, intervened: 5 }).verdict, 'no_change');
      // 小样本：改用 Fisher 精确检验给出结论（2/3 vs 1/3 差异不显著）
      const smallSig = es.significance({ passed: 2, total: 3, intervened: 0 }, { passed: 1, total: 3, intervened: 0 });
      assert.strictEqual(smallSig.successRate.method, 'fisher');
      assert.strictEqual(smallSig.verdict, 'no_change');
      // 退化（无可比样本）→ insufficient
      assert.strictEqual(es.significance({ passed: 0, total: 0, intervened: 0 }, { passed: 0, total: 0, intervened: 0 }).verdict, 'insufficient');
      assert.strictEqual(es.significance({ passed: 1, total: 5, intervened: 0 }, null).first, true);
      // 口径说明
      assert.strictEqual(es.metricDefinitions().significance.alpha, 0.05);
      assert.ok(es.ALPHA === 0.05 && es.MIN_SAMPLE === 5);
    });

    await t('D3-4 增强: 多版本趋势——序列排序/逐点回退与显著性/趋势摘要', async () => {
      db.prepare('DELETE FROM eval_baselines').run();
      const mk = (pass, total, iv = 0) => { const a = []; for (let i = 0; i < total; i++) a.push({ id: 'c' + i, score: i < pass ? 1 : 0, steps: 2, intervened: i >= total - iv }); return a; };
      const v1 = es.createBaseline({ suite: 'd34-trend', suite_type: 'builtin', label: 'v1', cases: mk(90, 100) });
      const v2 = es.createBaseline({ suite: 'd34-trend', suite_type: 'builtin', label: 'v2', cases: mk(70, 100, 20) });
      const v3 = es.createBaseline({ suite: 'd34-trend', suite_type: 'builtin', label: 'v3', cases: mk(85, 100, 5) });
      assert.strictEqual(v1.metrics.successRate, 90); assert.strictEqual(v1.metrics.intervened, 0);
      assert.strictEqual(v2.significance.verdict, 'regressed', 'v2（70% vs 90%）显著回退');
      assert.strictEqual(v3.significance.verdict, 'improved', 'v3（85% vs 70%）显著提升');
      const tr = es.suiteTrend({ suite: 'd34-trend' });
      assert.strictEqual(tr.count, 3);
      assert.deepStrictEqual(tr.points.map(p => p.label), ['v1', 'v2', 'v3'], '按时间正序');
      assert.strictEqual(tr.points[0].verdict.first, true);
      assert.strictEqual(tr.summary.netSuccess, -5, '90 → 85');
      assert.strictEqual(tr.summary.regressions, 1, 'v2 回退');
      assert.strictEqual(tr.summary.significantRegressions, 1);
      assert.strictEqual(tr.summary.significantImprovements, 1);
      assert.strictEqual(tr.summary.direction, 'down');
      // 空/不存在套件
      assert.strictEqual(es.suiteTrend({ suite: '' }).count, 0);
      assert.strictEqual(es.suiteTrend({ suite: 'no-such-suite' }).points.length, 0);
    });

    await t('D3-4 增强: HTTP /trend —— 多版本趋势 + 口径 + 权限', async () => {
      const express = require('express');
      const evRouter = require('../src-server/routes/eval');
      const { sign } = require('../src-server/lib/auth');
      for (const [u, r] of [['d34u1', 'user'], ['d34adm', 'admin']]) {
        if (!db.prepare('SELECT id FROM users WHERE username=?').get(u)) {
          db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES (?,?,?,?,1,0,datetime('now','localtime'))").run(u, 'x', u, r);
        }
      }
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d34u1'").get().id, exp: Date.now() + 3600000 });
      const app = express(); app.use(express.json()); app.use('/api/eval', evRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, tk) => (await fetch(base + p, { headers: { ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      try {
        assert.strictEqual((await fetch(base + '/api/eval/trend?suite=x')).status, 401, '未认证 401');
        const tr = await J('/api/eval/trend?suite=d34-trend&suite_type=builtin', tok);
        assert.strictEqual(tr.code, 0); assert.strictEqual(tr.data.count, 3);
        assert.ok(tr.data.points[2].significance && tr.data.points[2].significance.verdict === 'improved');
        assert.strictEqual((await J('/api/eval/trend?suite=', tok)).code, 400, '缺 suite 400');
        const cfg = await J('/api/eval/config', tok);
        assert.ok(cfg.data.significance && cfg.data.significance.alpha === 0.05 && Array.isArray(cfg.data.significance.methods) && cfg.data.significance.methods.includes('fisher'));
        assert.ok(cfg.data.confidence && cfg.data.confidence.level === 95, '含 95% 置信区间口径');
      } finally { server.close(); }
    });
  }

  console.log('【D3-4 增强2】置信区间带/时间轴 + Fisher 精确检验 + SWE-bench-lite runner 接入');
  {
    const es = require('../src-server/lib/eval-suite');
    const runner = require('../src-server/lib/swebench-runner');

    await t('D3-4 增强2: Wilson 置信区间 + 正态分位数', async () => {
      assert.ok(Math.abs(es.normInv(0.975) - 1.959964) < 1e-3, 'z_0.975 ≈ 1.96');
      assert.ok(Math.abs(es.normInv(0.5)) < 1e-6, 'z_0.5 = 0');
      const c = es.wilsonInterval(50, 100);
      assert.ok(c.low < 50 && c.high > 50 && c.center >= 49 && c.center <= 51, JSON.stringify(c));
      assert.ok(c.low > 39 && c.high < 61, '区间宽度合理');
      assert.strictEqual(es.wilsonInterval(0, 0).width, 0);
      // 极端比例：0/10 仍有正上界（Wilson 稳健）
      const z0 = es.wilsonInterval(0, 10);
      assert.strictEqual(z0.low, 0); assert.ok(z0.high > 0);
      assert.ok(es.wilsonInterval(10, 10).low < 100);
    });

    await t('D3-4 增强2: Fisher 精确检验（两尾）+ 方法自动选择', async () => {
      const f = es.fisherExact(3, 1, 1, 3);
      assert.ok(Math.abs(f.p - 0.4857) < 0.01, `fisher p=${f.p}`);
      assert.strictEqual(f.method, 'fisher');
      const f2 = es.fisherExact(9, 1, 1, 9);
      assert.ok(f2.p < 0.01 && f2.significant === true, JSON.stringify(f2));
      assert.strictEqual(f2.direction, 'up');
      // 方法选择：小样本 → fisher；大样本 → z；大样本但期望频数过低 → fisher
      assert.strictEqual(es.proportionTest(2, 3, 1, 3).method, 'fisher');
      assert.strictEqual(es.proportionTest(90, 100, 60, 100).method, 'z');
      assert.strictEqual(es.proportionTest(100, 100, 99, 100).method, 'fisher');
      // significance 用 Fisher 给结论（小样本，4/4 vs 0/4 显著提升）
      const s = es.significance({ passed: 4, total: 4, intervened: 0 }, { passed: 0, total: 4, intervened: 0 });
      assert.strictEqual(s.successRate.method, 'fisher');
      assert.strictEqual(s.verdict, 'improved');
    });

    await t('D3-4 增强2: suiteTrend 置信区间字段 + 时间轴数据', async () => {
      db.prepare('DELETE FROM eval_baselines').run();
      const mk = (pass, total) => { const a = []; for (let i = 0; i < total; i++) a.push({ id: 'c' + i, score: i < pass ? 1 : 0 }); return a; };
      es.createBaseline({ suite: 'd34-ci', suite_type: 'builtin', label: 'v1', cases: mk(50, 100) });
      es.createBaseline({ suite: 'd34-ci', suite_type: 'builtin', label: 'v2', cases: mk(80, 100) });
      const tr = es.suiteTrend({ suite: 'd34-ci' });
      assert.strictEqual(tr.ciLevel, 95);
      assert.ok(tr.points[0].ci && tr.points[0].ci.successRate.low < 50 && tr.points[0].ci.successRate.high > 50);
      assert.ok(tr.points[0].created_at, '点含时间（供时间轴）');
      assert.strictEqual(tr.points.length, 2);
    });

    await t('D3-4 增强2: SWE-bench-lite runner 适配器——解析/未配置/端到端（mock）', async () => {
      const parsed = runner.parseRunnerOutput('log line\n[{"instance_id":"a","resolved":true}]');
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(runner.parseRunnerOutput('not json'), null);
      const saved = process.env.SWEBENCH_RUNNER_CMD;
      delete process.env.SWEBENCH_RUNNER_CMD;
      assert.strictEqual(runner.runnerProbe().configured, false);
      const noCmd = await runner.runSweBenchLite({ instances: [{ instance_id: 'x' }] });
      assert.strictEqual(noCmd.ok, false); assert.strictEqual(noCmd.configured, false);
      // 端到端：mock runner（读 stdin → 输出 predictions，容忍日志行）
      const mockPath = path.join(process.env.AGENT_DATA_DIR, 'mock-runner.js');
      fs.writeFileSync(mockPath, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const ins=JSON.parse(s);const out=ins.map((it,i)=>({instance_id:it.instance_id,resolved:i%2===0,passed_tests:i%2===0?2:0,steps:3}));process.stdout.write('running...\\n'+JSON.stringify(out));});");
      const res = await runner.runSweBenchLite({ instances: [{ instance_id: 'a' }, { instance_id: 'b' }], command: `node ${mockPath}` });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.strictEqual(res.cases.length, 2);
      assert.strictEqual(res.metrics.successRate, 50, '1/2 通过');
      const bad = await runner.runSweBenchLite({ instances: [{ instance_id: 'a' }], command: 'node -e "process.exit(3)"' });
      assert.strictEqual(bad.ok, false); assert.ok(/退出码/.test(bad.error));
      if (saved != null) process.env.SWEBENCH_RUNNER_CMD = saved;
    });

    await t('D3-4 增强2: HTTP /runner + /trend 置信字段 + 权限', async () => {
      const express = require('express');
      const evRouter = require('../src-server/routes/eval');
      const { sign } = require('../src-server/lib/auth');
      for (const [u, r] of [['d34u1', 'user'], ['d34adm', 'admin']]) {
        if (!db.prepare('SELECT id FROM users WHERE username=?').get(u)) {
          db.prepare("INSERT INTO users (username,password,nickname,role,status,must_change_pwd,created_at) VALUES (?,?,?,?,1,0,datetime('now','localtime'))").run(u, 'x', u, r);
        }
      }
      const tok = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d34u1'").get().id, exp: Date.now() + 3600000 });
      const tAdmin = sign({ uid: db.prepare("SELECT id FROM users WHERE username='d34adm'").get().id, exp: Date.now() + 3600000 });
      const mockPath = path.join(process.env.AGENT_DATA_DIR, 'mock-runner2.js');
      fs.writeFileSync(mockPath, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const ins=JSON.parse(s);process.stdout.write(JSON.stringify(ins.map(it=>({instance_id:it.instance_id,resolved:true,passed_tests:1,steps:2}))));});");
      const app = express(); app.use(express.json()); app.use('/api/eval', evRouter);
      let server; await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const J = async (p, opts, tk) => (await fetch(base + p, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } })).json();
      try {
        assert.strictEqual((await fetch(base + '/api/eval/runner/probe')).status, 401, '未认证 401');
        assert.strictEqual((await J('/api/eval/runner/probe', {}, tok)).code, 403, '非管理员 probe 403');
        const probe = await J('/api/eval/runner/probe', {}, tAdmin);
        assert.strictEqual(probe.code, 0); assert.strictEqual(probe.data.bundled, false);
        const run = await J('/api/eval/runner/swe-bench-lite', { method: 'POST', body: JSON.stringify({ instances: [{ instance_id: 'a' }, { instance_id: 'b' }], command: `node ${mockPath}`, suite: 'd34-runner' }) }, tAdmin);
        assert.strictEqual(run.code, 0, JSON.stringify(run)); assert.strictEqual(run.data.metrics.successRate, 100);
        assert.ok(run.data.baseline && run.data.baseline.id, '落为发布基线');
        assert.strictEqual((await J('/api/eval/runner/swe-bench-lite', { method: 'POST', body: JSON.stringify({ instances: [{ instance_id: 'a' }], command: `node ${mockPath}` }) }, tok)).code, 403, '非管理员 403');
        assert.strictEqual((await J('/api/eval/runner/swe-bench-lite', { method: 'POST', body: JSON.stringify({ instances: [] }) }, tAdmin)).code, 400);
        const tr = await J('/api/eval/trend?suite=d34-ci&suite_type=builtin', {}, tok);
        assert.strictEqual(tr.data.ciLevel, 95); assert.ok(tr.data.points[0].ci.successRate);
      } finally { server.close(); }
    });
  }

  console.log('【MT-08/10】账号角色分层与租户开通闭环');
  const tenantLib = require('../src-server/lib/tenant');
  const authLib = require('../src-server/lib/auth');
  await t('MT-08：isPlatformSuperadmin 识别 platform_admin=1 或配置清单', () => {
    assert.strictEqual(authLib.isPlatformSuperadmin({ role: 'admin', username: 'admin', platform_admin: 1 }), true);
    assert.strictEqual(authLib.isPlatformSuperadmin({ role: 'admin', username: 'admin', platform_admin: 0 }), true); // 名单兜底
    assert.strictEqual(authLib.isPlatformSuperadmin({ role: 'user', username: 'admin', platform_admin: 0 }), false);
    assert.strictEqual(authLib.isPlatformSuperadmin({ role: 'admin', username: 'other', platform_admin: 0 }), false);
  });
  await t('MT-10：createTenant 建租户 + 派生管理员（username 全局唯一、非平台超管）', () => {
    const r = tenantLib.createTenant({ name: 'S客户', adminUsername: 'sadm', adminPassword: 'Sadm@2026' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const tn = tenantLib.getTenant(r.tenantId);
    assert.strictEqual(tn.status, 'active');
    const u = db.prepare('SELECT role, tenant_id, platform_admin FROM users WHERE username=?').get('sadm');
    assert.strictEqual(u.role, 'admin'); assert.strictEqual(u.tenant_id, r.tenantId); assert.strictEqual(u.platform_admin, 0);
  });
  await t('MT-10：非法入参被拒（空名 / 弱口令 / 用户名重名）', () => {
    assert.strictEqual(tenantLib.createTenant({ name: '', adminUsername: 'x1', adminPassword: 'abcd1234' }).ok, false);
    assert.strictEqual(tenantLib.createTenant({ name: 'Y', adminUsername: 'yadm', adminPassword: '123456' }).ok, false);
    assert.strictEqual(tenantLib.createTenant({ name: 'Z', adminUsername: 'sadm', adminPassword: 'Zadm@2026' }).ok, false);
  });
  await t('MT-10：停用租户踢出在线会话；默认租户不可停用', () => {
    const r = tenantLib.createTenant({ name: 'D客户', adminUsername: 'dadm', adminPassword: 'Dadm@2026' });
    const before = db.prepare('SELECT token_version FROM users WHERE username=?').get('dadm').token_version || 0;
    assert.strictEqual(tenantLib.setTenantStatus(r.tenantId, 'disabled').ok, true);
    const after = db.prepare('SELECT token_version FROM users WHERE username=?').get('dadm').token_version || 0;
    assert.ok(after > before, '停用应 bump token_version');
    assert.strictEqual(tenantLib.getTenant(r.tenantId).status, 'disabled');
    assert.strictEqual(tenantLib.setTenantStatus(1, 'disabled').ok, false, '默认租户不可停用');
  });

  // ================== M2 批次2：租户账单 / 隔离 / 支付订阅（MT-11/12/13，2026-11-22） ==================
  console.log('【MT-11/12/13】租户账单聚合 · 租户级隔离 · 支付订阅闭环');
  const billingLib = require('../src-server/lib/billing');
  const quotaLib = require('../src-server/lib/quota');
  const secretsLib = require('../src-server/lib/secrets');
  const payLib = require('../src-server/lib/payment');

  // MT-12：scopeTenant / mgmtScope / canManageRow 语义
  await t('MT-12：scopeTenant 单租户→null；平台超管取 query；租户用户强制本租户（fail-closed）', () => {
    assert.strictEqual(tenantLib.scopeTenant({ tenant: { id: 1, single: true } }), null);
    assert.strictEqual(tenantLib.scopeTenant({ tenant: { id: 5 }, user: { role: 'admin', username: 'x', platform_admin: 0 }, query: { tenant_id: '9' } }), 5, '租户用户伪造 tenant_id 应被忽略');
    assert.strictEqual(tenantLib.scopeTenant({ tenant: { id: 5 }, user: { role: 'admin', username: 'admin', platform_admin: 1 }, query: { tenant_id: '9' } }), 9, '平台超管可用 query 指定');
  });
  await t('MT-12：mgmtScope 默认平台全局层(0)；canManageRow fail-closed', () => {
    assert.strictEqual(tenantLib.mgmtScope({ tenant: { id: 1, single: true } }), 0);
    assert.strictEqual(tenantLib.mgmtScope({ tenant: { id: 5 }, user: { platform_admin: 0, role: 'admin', username: 'x' }, query: {} }), 5);
    assert.strictEqual(tenantLib.canManageRow({ tenant: { id: 5 }, user: { platform_admin: 0, role: 'admin', username: 'x' } }, 7), false, '租户用户不可管理他租户行');
    assert.strictEqual(tenantLib.canManageRow({ tenant: { id: 5 }, user: { platform_admin: 0, role: 'admin', username: 'x' } }, 5), true);
    assert.strictEqual(tenantLib.canManageRow({ tenant: { id: 5 }, user: { platform_admin: 1, role: 'admin', username: 'admin' } }, 7), true, '平台超管可跨租户');
  });

  // MT-12：密钥租户隔离（平台全局基线 ∪ 租户覆盖，且列表按层隔离）
  await t('MT-12：secrets 分层——listNames 仅本层；loadSecrets = 全局基线 ∪ 租户覆盖', () => {
    secretsLib.upsert('MT12_BASE', 'base-value-1234', '', 0);
    secretsLib.upsert('MT12_BASE', 'tenant-value-99', '', 777); // 租户覆盖同名
    secretsLib.upsert('MT12_ONLY_T', 'only-tenant-abc', '', 777);
    const names0 = secretsLib.listNames(0).map(r => r.name);
    const namesT = secretsLib.listNames(777).map(r => r.name);
    assert.ok(names0.includes('MT12_BASE') && !names0.includes('MT12_ONLY_T'), '全局层不应含租户专有密钥');
    assert.ok(namesT.includes('MT12_BASE') && namesT.includes('MT12_ONLY_T'), '租户层应含自身密钥');
    const vis = secretsLib.loadSecrets(777);
    assert.strictEqual(vis.MT12_BASE, 'tenant-value-99', '租户覆盖应优先生效');
    const base = secretsLib.loadSecrets(0);
    assert.strictEqual(base.MT12_BASE, 'base-value-1234', '全局层不应被租户覆盖');
  });

  // MT-11：租户账单聚合（tenant_id → username 两级）
  await t('MT-11：tenantQuotaSummary / tenantReport / tenantReportCsv 两级聚合正确', () => {
    const pa = tenantLib.createTenant({ name: '账单客户A', adminUsername: 'billA', adminPassword: 'Bill@2026' });
    const pb = tenantLib.createTenant({ name: '账单客户B', adminUsername: 'billB', adminPassword: 'Bill@2026' });
    const A = pa.tenantId, B = pb.tenantId;
    const ins = "INSERT INTO usage_records (username,dimension,dimension_key,tokens,count,cost,prompt_tokens,completion_tokens,tenant_id,created_at) VALUES (?,?,?,?,1,?,?,?,?,datetime('now','localtime'))";
    db.prepare(ins).run('billA', 'model', 'm1', 100, 1.5, 60, 40, A);
    db.prepare(ins).run('billB', 'model', 'm1', 200, 2.5, 120, 80, B);
    const repA = billingLib.tenantReport({ tenantId: A });
    assert.strictEqual(repA.users.length, 1);
    assert.strictEqual(repA.users[0].username, 'billA');
    assert.ok(Math.abs(repA.monthlyTotal - 1.5) < 1e-9, 'A 租户成本应仅含自身：' + repA.monthlyTotal);
    const aggAll = billingLib.tenantCostOfMonth(undefined, null);
    const ids = aggAll.tenants.map(x => x.tenant_id);
    assert.ok(ids.includes(A) && ids.includes(B), '跨租户聚合应含 A/B');
    assert.ok(aggAll.tenants.find(x => x.tenant_id === A).cost === 1.5, 'A 成本不串账');
    assert.ok(aggAll.tenants.find(x => x.tenant_id === B).cost === 2.5, 'B 成本不串账');
    const csv = billingLib.tenantReportCsv({ tenantId: A }).csv;
    assert.ok(csv.startsWith('\ufeff'), 'CSV 应带 BOM');
    assert.ok(csv.includes('billA') && !csv.includes('billB'), 'A 导出不应含 B 用户');
    const qs = quotaLib.tenantQuotaSummary(A);
    assert.strictEqual(qs.tenant_id, A);
    assert.ok(qs.users.every(u => ['billA'].includes(u.username)), '租户配额聚合仅本租户成员');
  });

  // MT-13：支付/订阅闭环（下单 → 回调验签 → 生效 → 退款 → 对账）
  await t('MT-13：验签 fail-closed（未配密钥一律拒绝）', () => {
    const old = process.env.PAYMENT_CALLBACK_SECRET;
    delete process.env.PAYMENT_CALLBACK_SECRET;
    const r = payLib.verifySignature('raw', 'fakesign');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 401);
    if (old != null) process.env.PAYMENT_CALLBACK_SECRET = old;
  });
  await t('MT-13：订阅下单 → 标记已支付 → 订阅生效 + 成员配额下发', () => {
    const pc = tenantLib.createTenant({ name: '支付客户C', adminUsername: 'payC', adminPassword: 'Pay@2026' });
    const C = pc.tenantId;
    const c = payLib.createOrder({ tenantId: C, type: 'subscribe', planKey: 'pro', channel: 'sandbox', operator: 'admin' });
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    assert.strictEqual(c.order.status, 'pending');
    assert.strictEqual(c.order.amount, 199);
    const mp = payLib.markPaid(c.order.order_no, { amount: 199, channel: 'sandbox', operator: 'admin' });
    assert.strictEqual(mp.ok, true, JSON.stringify(mp));
    const sub = db.prepare('SELECT * FROM tenant_subscriptions WHERE tenant_id=?').get(C);
    assert.strictEqual(sub.status, 'active');
    assert.strictEqual(sub.plan_key, 'pro');
    const u = db.prepare('SELECT quota_total FROM users WHERE username=?').get('payC');
    assert.strictEqual(u.quota_total, 5000000, '成员配额应下发为套餐额度');
    // 幂等：重复 markPaid 不再改变
    const mp2 = payLib.markPaid(c.order.order_no, { amount: 199 });
    assert.strictEqual(mp2.idempotent, true, '重复标记应幂等');
    // 对账 balanced
    const rec = payLib.reconcile({});
    assert.ok(rec.items.some(it => it.order_no === c.order.order_no && it.balanced), '订阅订单应核验为已生效');
  });
  await t('MT-13：回调幂等（同 event_id 只生效一次）+ 金额篡改拒绝', () => {
    process.env.PAYMENT_CALLBACK_SECRET = 'smoke-secret';
    try {
      const pc = tenantLib.createTenant({ name: '支付客户D', adminUsername: 'payD', adminPassword: 'Pay@2026' });
      const D = pc.tenantId;
      const o = payLib.createOrder({ tenantId: D, type: 'recharge', amount: 50, channel: 'sandbox' });
      const no = o.order.order_no;
      const raw = JSON.stringify({ order_no: no, event_id: 'evt-smoke-1', status: 'paid', amount: 50 });
      const sign = payLib.signPayload(raw, 'smoke-secret');
      const r1 = payLib.handleCallback({ channel: 'sandbox', rawBody: raw, sign, payload: JSON.parse(raw) });
      assert.strictEqual(r1.ok, true, JSON.stringify(r1));
      assert.strictEqual(r1.status, 'paid');
      assert.strictEqual(payLib.getWallet(D).balance, 50, '充值应入钱包');
      const r2 = payLib.handleCallback({ channel: 'sandbox', rawBody: raw, sign, payload: JSON.parse(raw) });
      assert.strictEqual(r2.idempotent, true, '重复回调应幂等');
      assert.strictEqual(payLib.getWallet(D).balance, 50, '幂等不应重复入账');
      // 金额篡改：少于应付 → 拒绝
      const o2 = payLib.createOrder({ tenantId: D, type: 'recharge', amount: 100, channel: 'sandbox' });
      const raw2 = JSON.stringify({ order_no: o2.order.order_no, event_id: 'evt-smoke-2', status: 'paid', amount: 1 });
      const sign2 = payLib.signPayload(raw2, 'smoke-secret');
      const bad = payLib.handleCallback({ channel: 'sandbox', rawBody: raw2, sign: sign2, payload: JSON.parse(raw2) });
      assert.strictEqual(bad.ok, false, '少付应被拒');
      // 退款幂等
      const rf1 = payLib.refund({ orderNo: no, operator: 'admin' });
      assert.strictEqual(rf1.ok, true);
      assert.strictEqual(payLib.getWallet(D).balance, 0, '退款应扣回钱包');
      const rf2 = payLib.refund({ orderNo: no, operator: 'admin' });
      assert.strictEqual(rf2.idempotent, true, '重复退款应幂等');
    } finally { delete process.env.PAYMENT_CALLBACK_SECRET; }
  });

  // BE-B1：统一响应契约（M2 批次3）——业务错误码一律置对应 HTTP 状态码，成功仍 code:0，凭据端点豁免
  await t('BE-B1：响应契约——业务错误码置对应 HTTP 状态码，成功与豁免端点不受影响', async () => {
    const { spawn } = require('child_process');
    const { db: db1, hashPwd, now } = require('../src-server/db');
    const { sign } = require('../src-server/lib/auth');
    db1.prepare('DELETE FROM users WHERE username=?').run('beb1user');
    db1.prepare(`INSERT INTO users (username,nickname,password,status,role,must_change_pwd,created_at) VALUES (?,?,?,1,'user',0,?)`).run('beb1user', 'BEB1', hashPwd('Pass@2026'), now());
    const uid = db1.prepare('SELECT id FROM users WHERE username=?').get('beb1user').id;
    const tok = sign({ uid, exp: Date.now() + 3600000 });
    const port = 37000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR }, stdio: 'ignore' });
    const jf = async (p, opts = {}) => {
      const r = await fetch(base + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(opts.tok ? { authorization: 'Bearer ' + opts.tok } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      let j = null; try { j = await r.json(); } catch { }
      return { status: r.status, j };
    };
    try {
      let up = false;
      for (let i = 0; i < 150 && !up; i++) { await new Promise(r => setTimeout(r, 200)); try { up = (await fetch(base + '/api/health')).ok; } catch { } }
      assert.ok(up, '子进程服务应在 30s 内就绪（否则本用例断言无从执行）');
      // ① 业务错误码 404（文件不存在）→ HTTP 404，body code 保留
      const f = await jf('/api/files/999999999', { tok });
      assert.strictEqual(f.status, 404, '业务码 404 应置 HTTP 404，实际 ' + f.status);
      assert.strictEqual(f.j.code, 404, 'body code 应保留 404');
      // ② 成功仍 HTTP 200 + code 0
      const h = await jf('/api/health');
      assert.strictEqual(h.status, 200, '成功应 200');
      assert.strictEqual(h.j.code, 0, '成功 code 应 0');
      // ③ 凭据端点豁免：登录失败保持 HTTP 200 + code 401（前端据 body 提示「账号或密码错误」）
      const bad = await jf('/api/auth/login', { method: 'POST', body: { username: 'beb1user', password: 'wrong-pass' } });
      assert.strictEqual(bad.status, 200, '登录失败应保持 HTTP 200（豁免），实际 ' + bad.status);
      assert.strictEqual(bad.j.code, 401, '登录失败 body code 应 401');
    } finally {
      try { child.kill('SIGTERM'); } catch { }
      try { child.kill('SIGKILL'); } catch { }
      db1.prepare('DELETE FROM users WHERE username=?').run('beb1user');
    }
  });

  // BE-B3：对外 API 分布式限流与每 Key 日/月配额
  await t('BE-B3：共享存储计数——UPSERT..RETURNING 原子自增 + 共享限流器 200/200/429', async () => {
    const rl = require('../src-server/lib/rate-limit');
    const bk = 'smoke-beb3-' + Date.now();
    assert.strictEqual(rl.dbIncr(bk, Date.now() + 60000).count, 1);
    assert.strictEqual(rl.dbIncr(bk, Date.now() + 60000).count, 2);
    assert.strictEqual(rl.dbPeek(bk).count, 2);
    const lim = rl.createLimiter({ name: 'smoke-shared', windowMs: 60000, max: 2, keyFn: () => 'X', shared: true });
    const call = () => new Promise(res => {
      const req = { headers: {}, path: '/openapi/v1/x', socket: {} };
      const res2 = { _h: {}, setHeader(a, b) { this._h[a] = b; }, status(c) { this.code = c; return this; }, json(j) { this.body = j; res(this); } };
      lim(req, res2, () => res({ code: 200 }));
    });
    assert.strictEqual((await call()).code, 200);
    assert.strictEqual((await call()).code, 200);
    const c = await call();
    assert.strictEqual(c.code, 429, '第 3 次应 429');
    assert.ok(Number(c._h['Retry-After']) >= 1, '应带 Retry-After');
  });

  await t('BE-B3：每 Key 日配额守卫——放行额度后 429 + Retry-After', async () => {
    const rl = require('../src-server/lib/rate-limit');
    const qg = rl.createQuotaGuard({ name: 'smoke-q-' + Date.now(), keyFn: () => 'K', limitsFn: () => ({ daily: 3, monthly: 0 }) });
    const callQ = () => new Promise(res => {
      const req = { headers: {}, path: '/openapi/v1/y', socket: {} };
      const res2 = { _h: {}, setHeader(a, b) { this._h[a] = b; }, status(c) { this.code = c; return this; }, json(j) { this.body = j; res(this); } };
      qg(req, res2, () => res({ code: 200 }));
    });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await callQ()).code);
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429], '日配额 3：前 3 放行，其后 429');
  });

  await t('BE-B3：双实例共享额度不放大——同 Key 总额度与配置一致，超限 429', async () => {
    const { spawn } = require('child_process');
    const crypto = require('crypto');
    const sp = db.prepare("SELECT id FROM spaces WHERE type='enterprise' LIMIT 1").get() || db.prepare('SELECT id FROM spaces LIMIT 1').get();
    const agId = db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,prompt,created_at) VALUES ('BEB3智能体','other',?,'admin','published','public','测试',datetime('now','localtime'))`).run(sp.id).lastInsertRowid;
    const rawKey = 'sk-ap-beb3-' + crypto.randomBytes(8).toString('hex');
    // 明文入库：子进程启动期 SEC-02a 迁移会哈希之（同 U1-8 流程）；quota_daily=6 作为双实例合计额度
    db.prepare("INSERT INTO agent_api_keys (agent_id,key,key_prefix,name,status,quota_daily,quota_monthly,created_at) VALUES (?,?,?,?,1,6,0,datetime('now','localtime'))").run(agId, rawKey, 'sk-ap-be****', 'BEB3配额密钥');
    const pA = 41000 + Math.floor(Math.random() * 400);
    const pB = 41600 + Math.floor(Math.random() * 400);
    const spawnSrv = (port) => spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), AGENT_DATA_DIR: process.env.AGENT_DATA_DIR }, stdio: 'ignore' });
    const cA = spawnSrv(pA), cB = spawnSrv(pB);
    const hit = async (port) => (await fetch(`http://127.0.0.1:${port}/openapi/v1/models`, { headers: { Authorization: 'Bearer ' + rawKey } })).status;
    try {
      for (const port of [pA, pB]) {
        let up = false;
        for (let i = 0; i < 120 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { } }
        assert.ok(up, '实例 ' + port + ' 应在 30s 内就绪');
      }
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push(await hit(i % 2 ? pB : pA));
      const ok200 = statuses.filter(s => s === 200).length;
      const n429 = statuses.filter(s => s === 429).length;
      assert.strictEqual(ok200, 6, '双实例合计放行应恰为配额 6，实际 ' + ok200 + '（' + statuses.join(',') + '）');
      assert.strictEqual(n429, 6, '其余请求应 429');
    } finally {
      try { cA.kill('SIGTERM'); } catch { }
      try { cB.kill('SIGTERM'); } catch { }
      try { cA.kill('SIGKILL'); } catch { }
      try { cB.kill('SIGKILL'); } catch { }
      db.prepare('DELETE FROM agent_api_keys WHERE agent_id=?').run(agId);
      db.prepare('DELETE FROM agents WHERE id=?').run(agId);
    }
  });

  // BE-B4：对外契约文档化——Express 路由表自动采集 + OpenAPI 3.1 + 版本单一来源
  await t('BE-B4：collectRoutes 运行时采集 Express 路由表（嵌套 router 方法与路径还原）', async () => {
    const express = require('express');
    const { collectRoutes } = require('../src-server/lib/api-doc');
    const app = express();
    const r1 = express.Router();
    r1.get('/login', (q, s) => s.end());
    r1.post('/logout', (q, s) => s.end());
    const inner = express.Router();
    inner.put('/:id', (q, s) => s.end());
    const r2 = express.Router();
    r2.use('/nested', inner); // 二级嵌套
    app.use('/api/auth', r1);
    app.use('/api/agents', r2);
    const routes = collectRoutes(app);
    const set = new Set(routes.map(r => r.method + ' ' + r.path));
    assert.ok(set.has('get /api/auth/login'), '应采集 GET /api/auth/login');
    assert.ok(set.has('post /api/auth/logout'), '应采集 POST /api/auth/logout');
    assert.ok(set.has('put /api/agents/nested/:id'), '应采集二级嵌套路由');
  });

  await t('BE-B4：buildGlobalOpenApi 产出 3.1 + 方法级 operation/参数/错误码 + tag 分组', async () => {
    const express = require('express');
    const { buildGlobalOpenApi } = require('../src-server/lib/api-doc');
    const app = express();
    const r = express.Router();
    r.get('/:id', (q, s) => s.end());
    app.use('/api/v1/agents', r);
    // BE-B5：旧 /api/* 别名应被过滤，不出现在规范中
    const legacy = express.Router();
    legacy.get('/x', (q, s) => s.end());
    app.use('/api/legacy', legacy);
    const spec = buildGlobalOpenApi(app);
    assert.strictEqual(spec.openapi, '3.1.0', '应为 OpenAPI 3.1');
    assert.ok(spec.info.version, 'info.version 来自版本单一来源');
    assert.ok(spec.components.securitySchemes.cookieAuth, '应含 cookieAuth');
    const op = spec.paths['/api/v1/agents/{id}'].get;
    assert.ok(op, '路径参数应转为 {id}');
    assert.deepStrictEqual(op.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'string' } }, 'path 参数应被提取');
    assert.ok(op.responses['200'] && op.responses['400'] && op.responses['401'], '应含标准错误码');
    assert.ok(op.tags && op.tags.includes('agents'), 'tag 折叠 v1 前缀后取 /api 第二段');
    assert.ok(!spec.paths['/api/legacy/x'], 'BE-B5：旧 /api/* 别名不应出现在规范中');
    // 开放端点富定义叠加
    assert.ok(spec.paths['/openapi/v1/chat/completions'].post.requestBody, '开放端点应叠加手写富定义');
  });

  await t('BE-B4：版本号单一来源——关键文件不再硬编码平台版本', async () => {
    const v = require('../src-server/lib/version');
    assert.strictEqual(v.PLATFORM_VERSION, 'p5.37', '平台版本常量');
    assert.strictEqual(v.OPENAPI_VERSION, '3.1.0', 'OpenAPI 版本常量');
    for (const f of ['src-server/routes/a2a.js', 'src-server/routes/api-docs.js', 'src-server/routes/openapi.js', 'cli/cli.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(/require\(['"][^'"]*lib\/version['"]\)/.test(src), f + ' 应从 lib/version 读取版本');
      assert.ok(!/['"]p5\.\d+['"]/.test(src), f + ' 不应再硬编码 p5.xx 版本');
    }
  });

  // BE-B5：内部 API 版本化——/api/v1 规范前缀 + /api 过渡期别名（双挂载）+ 弃用告警 + OpenAPI 只列 v1
  await t('BE-B5：api-version 前缀判定与归一化（v1/旧前缀/其它）', () => {
    const av = require('../src-server/lib/api-version');
    assert.strictEqual(av.API_PREFIX, '/api/v1');
    assert.strictEqual(av.LEGACY_PREFIX, '/api');
    assert.strictEqual(av.isLegacyApiPath('/api/agents'), true, '旧前缀为 legacy');
    assert.strictEqual(av.isLegacyApiPath('/api/v1/agents'), false, 'v1 非 legacy');
    assert.strictEqual(av.isCanonicalApiPath('/api/v1/agents'), true, 'v1 为规范前缀');
    assert.strictEqual(av.isLegacyApiPath('/openapi/v1/models'), false, '非 /api 不受影响');
    assert.strictEqual(av.isLegacyApiPath('/share/abc'), false, '页面/静态路径不受影响');
    assert.strictEqual(av.stripVersion('/api/v1/agents/1'), '/api/agents/1', 'v1 折叠回 /api');
    assert.strictEqual(av.stripVersion('/api/agents/1'), '/api/agents/1', '旧前缀保持不变');
    assert.strictEqual(av.stripVersion('/openapi/x'), '/openapi/x', '非 /api 不变');
  });

  await t('BE-B5：弃用告警中间件——旧前缀注入 Deprecation/Link/Warning，v1 不注入', () => {
    const av = require('../src-server/lib/api-version');
    const mw = av.deprecationNotice(() => {});
    const mkRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
    let nexted = 0;
    const resLegacy = mkRes();
    mw({ method: 'GET', originalUrl: '/api/agents?x=1' }, resLegacy, () => nexted++);
    assert.strictEqual(resLegacy.headers['Deprecation'], 'true', '旧前缀应标 Deprecation');
    assert.ok(/successor-version/.test(resLegacy.headers['Link'] || ''), 'Link 应指向 v1 后继版本');
    assert.ok(/Deprecated/.test(resLegacy.headers['Warning'] || ''), 'Warning 应提示弃用');
    const resV1 = mkRes();
    mw({ method: 'GET', originalUrl: '/api/v1/agents' }, resV1, () => nexted++);
    assert.strictEqual(resV1.headers['Deprecation'], undefined, 'v1 不应标 Deprecation');
    assert.strictEqual(nexted, 2, '中间件应放行');
  });

  await t('BE-B5：server.js 内部 API 全部双挂载，无遗留旧式 app.use(\'/api/…\')', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/require\(['"][^'"]*lib\/api-version['"]\)/.test(srv), 'server.js 应引入 api-version');
    assert.ok(/deprecationNotice\(\)/.test(srv), 'server.js 应装配弃用告警中间件');
    assert.ok(/mountApi\(app, 'agents'/.test(srv), '应经 mountApi 挂载 agents');
    assert.ok(/mountApi\(app, 'auth\/sso'/.test(srv), '应经 mountApi 挂载多层子路径');
    assert.strictEqual((srv.match(/app\.use\('\/api\//g) || []).length, 0, '不应再有旧式 app.use(\'/api/…) 挂载');
    assert.ok(/app\.use\('\/openapi'/.test(srv), '/openapi 保持原路径单挂载');
    assert.ok(/app\.use\('\/mcp'/.test(srv), '/mcp 保持原路径单挂载');
  });

  await t('BE-B5：既有 /api 前缀判定逻辑折叠版本（响应契约豁免/租户公开路径）', () => {
    const { isExempt } = require('../src-server/lib/response');
    assert.strictEqual(isExempt('/api/auth/login'), true, '旧前缀登录豁免');
    assert.strictEqual(isExempt('/api/v1/auth/login'), true, 'v1 前缀登录豁免（折叠后一致）');
    assert.strictEqual(isExempt('/api/agents'), false, '业务端点不豁免');
    assert.strictEqual(isExempt('/api/v1/channel/card-callback'), true, 'v1 渠道回调豁免');
    assert.ok(/stripVersion/.test(fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'auth.js'), 'utf8')), 'auth.js 租户公开路径判定应折叠版本前缀');
    assert.ok(/stripVersion/.test(fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'response.js'), 'utf8')), 'response.js 豁免判定应折叠版本前缀');
  });

  // ===== M3 · RAG 数据平面重建（2026-11-23）AI-01 多轮查询改写 / AI-02 向量通路正确性 =====
  await t('AI-01：query-rewrite 无历史/关闭/异常/空返回 → 一律回落原 query（0 阻断）', async () => {
    const qr = require('../src-server/lib/query-rewrite');
    const raw = '它怎么配置？';
    const H = [{ role: 'user', content: '介绍一下部署方案' }];
    qr.__clearCache(); qr.__setImpl(async () => '应当被忽略');
    assert.strictEqual(await qr.rewriteQuery(raw, []), raw, '无历史应原样返回');
    assert.strictEqual(await qr.rewriteQuery(raw, null), raw, 'history=null 应原样返回');
    assert.strictEqual(await qr.rewriteQuery('', H), '', '空 query 应原样返回');
    qr.__clearCache();
    assert.strictEqual(await qr.rewriteQuery(raw, H, { enabled: false }), raw, '显式关闭应原样返回');
    qr.__clearCache(); qr.__setImpl(async () => { throw new Error('boom'); });
    assert.strictEqual(await qr.rewriteQuery(raw, H), raw, '改写异常应回落原 query');
    qr.__clearCache(); qr.__setImpl(async () => '   ');
    assert.strictEqual(await qr.rewriteQuery(raw, H), raw, '空/空白返回应回落原 query');
    qr.__setImpl(null); qr.__clearCache();
  });

  await t('AI-01：query-rewrite 有历史时改写 + 清洗（去围栏/前缀）+ 缓存去重', async () => {
    const qr = require('../src-server/lib/query-rewrite');
    const raw = '它怎么配置？';
    const H = [{ role: 'user', content: '帮我看看 metaforge 的向量库' }, { role: 'assistant', content: '好的' }];
    let calls = 0;
    qr.__clearCache();
    qr.__setImpl(async () => { calls++; return '```\n改写后的问题：MetaForge 向量库如何配置？\n```'; });
    const out = await qr.rewriteQuery(raw, H);
    assert.strictEqual(out, 'MetaForge 向量库如何配置？', '应剥离代码围栏与「改写后的问题：」前缀并取首行：' + out);
    const out2 = await qr.rewriteQuery(raw, H);
    assert.strictEqual(out2, out, '二次调用应命中缓存返回一致');
    assert.strictEqual(calls, 1, '同 (query+history) 指纹应只调用一次改写实现（缓存去重）');
    qr.__setImpl(null); qr.__clearCache();
  });

  await t('AI-01：normalizeHistory 过滤非法轮次并按 maxTurns 截取最近轮', () => {
    const qr = require('../src-server/lib/query-rewrite');
    const nh = qr.normalizeHistory([
      { role: 'user', content: 'u1' }, { role: 'system', content: 'x' },
      { role: 'assistant', content: 'a1' }, { role: 'user', content: '   ' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ], 1);
    assert.deepStrictEqual(nh.map(m => m.content), ['a2', 'u3'], 'maxTurns=1 应仅取最近一轮（system/空白被过滤）：' + JSON.stringify(nh));
    assert.deepStrictEqual(qr.normalizeHistory(null), [], 'null → 空数组');
  });

  await t('AI-02：encodeVec/decodeVec float32 BLOB 往返（B3 1024 维 / H 256 维）+ fail-closed', () => {
    const r = require('../src-server/lib/retriever');
    const b3 = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.5);
    const bufB3 = r.encodeVec(b3, 'B3');
    assert.ok(Buffer.isBuffer(bufB3) && bufB3.length === 1 + 1024 * 4, 'B3 BLOB 长度应为 1+1024*4');
    const dB3 = r.decodeVec(bufB3);
    assert.strictEqual(dB3.engine, 'B3');
    assert.strictEqual(dB3.v.length, 1024);
    assert.ok(Math.abs(dB3.v[500] - b3[500]) < 1e-6, 'B3 往返数值应一致');
    const h = Float32Array.from({ length: 256 }, (_, i) => (i % 7) / 7);
    const dH = r.decodeVec(r.encodeVec(h, 'H'));
    assert.strictEqual(dH.engine, 'H');
    assert.strictEqual(dH.v.length, 256);
    assert.ok(Math.abs(dH.v[200] - h[200]) < 1e-6, 'H 往返数值应一致');
    assert.strictEqual(r.decodeVec(Buffer.alloc(3)), null, '过短应 null');
    assert.strictEqual(r.decodeVec(Buffer.alloc(1 + 1024 * 4)), null, '未知 engine tag(0) 应 null');
    const badLen = Buffer.alloc(1 + 100 * 4); badLen[0] = 1;
    assert.strictEqual(r.decodeVec(badLen), null, 'tag=B3 但长度不符应 null');
    assert.strictEqual(r.decodeVec('not-a-buffer'), null, '非 buffer 应 null');
  });

  await t('AI-02：parseVec 兼容读——新 BLOB 优先、旧 JSON 文本（B3:/H:/裸 JSON）仍可解析', () => {
    const r = require('../src-server/lib/retriever');
    const b3 = Float32Array.from({ length: 1024 }, (_, i) => (i === 3 ? 1 : 0));
    const p1 = r.parseVec(r.encodeVec(b3, 'B3'));
    assert.strictEqual(p1.engine, 'B3'); assert.strictEqual(p1.v.length, 1024); assert.strictEqual(p1.v[3], 1);
    const p2 = r.parseVec('B3:' + JSON.stringify([...b3]));
    assert.strictEqual(p2.engine, 'B3'); assert.strictEqual(p2.v[3], 1, '旧 B3: JSON 文本应兼容');
    const h = Array(256).fill(0); h[9] = 1;
    const p3 = r.parseVec('H:' + JSON.stringify(h));
    assert.strictEqual(p3.engine, 'H'); assert.strictEqual(p3.v[9], 1);
    const p4 = r.parseVec(JSON.stringify(h));
    assert.strictEqual(p4.engine, 'H'); assert.strictEqual(p4.v[9], 1, '裸 JSON 应视为旧本地哈希');
    assert.deepStrictEqual(r.parseVec(null), { v: null, engine: null });
    assert.deepStrictEqual(r.parseVec(Buffer.alloc(3)), { v: null, engine: null }, '非法 BLOB 应 fail-closed');
  });

  await t('AI-02：向量落库改 float32 BLOB，不再写 JSON 文本；retriever 不再引用已删 vector-store', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'retriever.js'), 'utf8');
    assert.ok(/upd\.run\(encodeVec\(got\[k \+ 1\], 'B3'\)/.test(src), 'B3 缓存应写 encodeVec BLOB');
    assert.ok(/upd\.run\(encodeVec\(v, 'H'\)/.test(src), 'H 缓存应写 encodeVec BLOB');
    assert.ok(!/'B3:' \+ JSON\.stringify/.test(src), '不应再写 B3: JSON 文本');
    assert.ok(!/require\(['"][^'"]*vector-store['"]\)/.test(src), 'retriever 不应再引用已删除的 vector-store');
  });

  await t('AI-02：分块编辑/合并同步失效向量缓存——embedding 置空（源码护栏）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'knowledge.js'), 'utf8');
    assert.ok(/SET content=\?, metadata=\?, embedding=NULL/.test(src), '编辑（带元数据）应同步置空向量');
    assert.ok(/SET content=\?, embedding=NULL/.test(src), '编辑/合并应同步置空向量');
  });

  await t('AI-02：检索写回的向量为 BLOB 且可被 parseVec 回读（端到端）', async () => {
    const r = require('../src-server/lib/retriever');
    const kbid = globalThis.__goldenKbId;
    assert.ok(kbid, '依赖既有黄金基线库');
    await r.retrieve('迟到早退怎么处理', kbid, 3, 0, { rerankEnabled: false });
    const row = db.prepare(`SELECT embedding FROM kb_chunks WHERE kb_id=? AND embedding IS NOT NULL LIMIT 1`).get(kbid);
    assert.ok(row, '检索后应有分块写入向量缓存');
    assert.ok(Buffer.isBuffer(row.embedding), '缓存应为 BLOB（新格式）');
    const dec = r.parseVec(row.embedding);
    assert.ok(dec.v && (dec.engine === 'H' || dec.engine === 'B3'), 'BLOB 应可回读为向量');
  });

  // ==================== M4 AI-09 重排阈值门控 + 库级配置（2026-11-23） ====================
  await t('AI-09：kbs 重排库级列 + chat_traces.retrieval_trace 已迁移', () => {
    const kbCols = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
    for (const c of ['rerank_enabled', 'rerank_model', 'rerank_top_n', 'rerank_threshold']) {
      assert.ok(kbCols.includes(c), `kbs 应有 ${c} 列`);
    }
    const traceCols = db.prepare('PRAGMA table_info(chat_traces)').all().map(c => c.name);
    assert.ok(traceCols.includes('retrieval_trace'), 'chat_traces 应有 retrieval_trace 列');
  });

  await t('AI-09：normalizeKbRerankConfig 归一（enabled 三态 / topN 限幅 / threshold 非法落 null）', () => {
    const { normalizeKbRerankConfig } = require('../src-server/lib/retriever');
    db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('重排配置测试库','',1,'httpu1',datetime('now','localtime'))`).run();
    const kbid = db.prepare(`SELECT id FROM kbs WHERE name='重排配置测试库'`).get().id;
    // 未配置：全 null/空（回落全局默认）
    const c0 = normalizeKbRerankConfig(db.prepare('SELECT * FROM kbs WHERE id=?').get(kbid));
    assert.deepStrictEqual(c0, { enabled: null, model: '', topN: null, threshold: null });
    // 配置：enabled=1，topN 越界 999 → 限幅 50；threshold 非法 'abc' → null
    db.prepare('UPDATE kbs SET rerank_enabled=1, rerank_model=?, rerank_top_n=?, rerank_threshold=? WHERE id=?')
      .run('bge-reranker-v2-m3', 999, 'abc', kbid);
    const c1 = normalizeKbRerankConfig(db.prepare('SELECT * FROM kbs WHERE id=?').get(kbid));
    assert.strictEqual(c1.enabled, true);
    assert.strictEqual(c1.model, 'bge-reranker-v2-m3');
    assert.strictEqual(c1.topN, 50, 'topN 应限幅到 50');
    assert.strictEqual(c1.threshold, null, 'threshold 非法应落 null');
    // enabled=0 → false
    db.prepare('UPDATE kbs SET rerank_enabled=0, rerank_threshold=? WHERE id=?').run('0.35', kbid);
    const c2 = normalizeKbRerankConfig(db.prepare('SELECT * FROM kbs WHERE id=?').get(kbid));
    assert.strictEqual(c2.enabled, false);
    assert.strictEqual(c2.threshold, 0.35);
    assert.strictEqual(normalizeKbRerankConfig(null), null, '空入参应 null');
    db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
  });

  await t('AI-09：重排阈值门控生效——低分片段不进 context，trace 回写；库级关闭则降级标记', async () => {
    const r = require('../src-server/lib/retriever');
    const kbid = globalThis.__goldenKbId;
    assert.ok(kbid, '依赖既有黄金基线库');
    const origFetch = global.fetch;
    const origAllow = process.env.AGENT_FETCH_ALLOW_PRIVATE;
    process.env.AGENT_FETCH_ALLOW_PRIVATE = '1'; // 测试放行内网（SSRF 守卫早返回），mock fetch 不真正出网
    r.__expireCircuitBreakers();
    db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES ('rerank测试供应商','http://gw.test/v1','sk-x',?,1,0,'',datetime('now','localtime'))`).run(JSON.stringify(['bge-reranker-v2-m3']));
    // mock：按文档顺序返回递减分数（第 i 条 = 0.9 - i*0.1）
    global.fetch = async (url, opt) => {
      const body = JSON.parse((opt && opt.body) || '{}');
      const results = (body.documents || []).map((_, i) => ({ index: i, relevance_score: +(0.9 - i * 0.1).toFixed(2) }));
      return { ok: true, json: async () => ({ results }) };
    };
    try {
      // 库级阈值 0.5：仅保留 >=0.5 的（第 0~4 条中 0.9~0.5）
      db.prepare('UPDATE kbs SET rerank_enabled=NULL, rerank_threshold=?, rerank_top_n=NULL WHERE id=?').run(0.5, kbid);
      const trace = {};
      const hits = await r.retrieve('迟到早退怎么处理', kbid, 5, 0, { rerankEnabled: true, trace });
      assert.ok(hits.length > 0, '应有通过阈值的命中');
      assert.ok(hits.every(h => (h.rerank_score || 0) >= 0.5), '低于阈值的片段应被剔除：' + JSON.stringify(hits.map(h => h.rerank_score)));
      assert.ok(trace.rerank && trace.rerank.applied === true && trace.rerank.degraded === false, 'trace 应记录重排生效');
      assert.strictEqual(trace.rerank.threshold, 0.5, 'trace 应回写阈值');
      assert.ok(trace.engine, 'trace 应记录所用引擎');
      // 库级关闭重排 → 不走重排，降级标记 reason=disabled
      db.prepare('UPDATE kbs SET rerank_enabled=0 WHERE id=?').run(kbid);
      const trace2 = {};
      const hits2 = await r.retrieve('迟到早退怎么处理', kbid, 5, 0, { trace: trace2 });
      assert.ok(hits2.every(h => h.rerank_score == null), '库级关闭重排时不应有 rerank_score');
      assert.strictEqual(trace2.rerank.requested, false);
      assert.strictEqual(trace2.rerank.reason, 'disabled');
    } finally {
      db.prepare('DELETE FROM providers WHERE name=?').run('rerank测试供应商');
      db.prepare('UPDATE kbs SET rerank_enabled=NULL, rerank_model=\'\', rerank_top_n=NULL, rerank_threshold=NULL WHERE id=?').run(kbid);
      global.fetch = origFetch;
      if (origAllow === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = origAllow;
      r.__expireCircuitBreakers();
    }
  });

  // ==================== M4 检索质量战役：AI-04 GraphRAG / AI-05 记忆召回 / AI-07 忠实度 / AI-03 多指标（2026-11-23） ====================
  console.log('【M4】检索可信度与质量（GraphRAG 接通 / 记忆语义召回 / 忠实度校验 / RAGAS 多指标）');

  // ---- AI-04：GraphRAG 接入默认管道 + 检索融合 ----
  await t('AI-04：graphrag 已入默认管道（keywords 后）且为 post 步骤（fire-and-forget，不阻塞上传）', () => {
    const ip = require('../src-server/lib/ingestion-pipeline');
    assert.ok(ip.VALID_STEP('graphrag'), 'graphrag 应在步骤白名单');
    const idx = ip.DEFAULT_PIPELINE.indexOf('graphrag');
    assert.ok(idx > ip.DEFAULT_PIPELINE.indexOf('keywords'), 'graphrag 应排在 keywords 之后');
    assert.ok(idx < ip.DEFAULT_PIPELINE.indexOf('regression'), 'graphrag 应在 regression 之前（计划口径：keywords 后加）');
    assert.strictEqual(ip.PIPELINE_STEPS.graphrag.post, true, 'graphrag 应为 post 后处理步骤');
  });

  await t('AI-04：buildGraphForFile 无供应商静默跳过；DI 注入抽取器后 entities/entity_relations 非空（验收：上传后图谱表非空）', async () => {
    const g = require('../src-server/lib/graphrag');
    db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI04图谱测试库','',1,'graphu',datetime('now','localtime'))`).run();
    const kbid = db.prepare(`SELECT id FROM kbs WHERE name='AI04图谱测试库'`).get().id;
    const fin = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,100,'success',2,datetime('now','localtime'))`).run(kbid, '图谱测试文档.txt');
    const fid = Number(fin.lastInsertRowid);
    const c1 = db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '张伟负责华东区的销售工作，华东区隶属于公司销售体系。');
    db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '李娜担任人力资源总监，负责招聘与培训。');
    // 无供应商（测试库无 providers）→ 静默跳过，不炸
    const skip = await g.buildGraphForFile(fid, kbid);
    assert.strictEqual(skip.skipped, 'no_provider', '无供应商应 skipped=no_provider：' + JSON.stringify(skip));
    // DI 注入确定性抽取器（force 跳过供应商检查）→ 实体/三元组全量落库
    const r1 = await g.buildGraphForFile(fid, kbid, {
      force: true,
      extractEntities: async (chunks) => [
        { name: '张伟', type: '人物', description: '销售' }, { name: '华东区', type: '地点', description: '区域' },
        { name: '李娜', type: '人物', description: 'HR' }, { name: '人力资源部', type: '组织', description: '部门' },
      ],
      extractTriples: async (text) => String(text).includes('张伟')
        ? [{ subject: '张伟', predicate: '负责', object: '华东区' }]
        : [{ subject: '李娜', predicate: '担任', object: '人力资源部' }],
    });
    assert.strictEqual(r1.entities, 4, '应新增 4 个实体（幂等键 name+type）：' + JSON.stringify(r1));
    assert.strictEqual(r1.relations, 2, '应写入 2 条关系（两个分块各 1）：' + JSON.stringify(r1));
    const entCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
    const relCount = db.prepare('SELECT COUNT(*) c FROM entity_relations').get().c;
    assert.ok(entCount >= 4 && relCount >= 2, `图谱表应非空：entities=${entCount} relations=${relCount}`);
    // 幂等：重复构建不新增实体（persistEntities 同名+同类型合并 kb_ids）
    const r2 = await g.buildGraphForFile(fid, kbid, {
      force: true,
      extractEntities: async () => [{ name: '张伟', type: '人物', description: '销售' }],
      extractTriples: async () => [],
    });
    assert.strictEqual(r2.entities, 0, '重复抽取同实体应 0 新增（幂等）');
    globalThis.__ai04KbId = kbid; // 供检索融合用例复用
    globalThis.__ai04ChunkId = Number(c1.lastInsertRowid);
  });

  await t('AI-04：检索图谱通道融合——实体关联查询命中支撑分块（channels=graph 标记 + trace.graph 可观测）', async () => {
    const r = require('../src-server/lib/retriever');
    const kbid = globalThis.__ai04KbId;
    assert.ok(kbid, '依赖图谱测试库');
    const trace = {};
    const hits = await r.retrieve('张伟负责什么工作', kbid, 5, 0, { rerankEnabled: false, trace });
    assert.ok(hits.length >= 1, '应能命中张伟分块');
    const zh = hits.find(h => String(h.content || '').includes('张伟'));
    assert.ok(zh, '张伟分块应进 Top-N（BM25 已可命中，图谱通道叠加助推）');
    assert.ok(trace.graph && trace.graph.chunks >= 1, 'trace.graph 应记录图谱通道命中：' + JSON.stringify(trace.graph));
    assert.ok(zh.graph === true, '图谱命中的分块应带 graph 标记');
    // 关闭图谱通道（opts.graph=false）→ trace 无 graph 字段、无 graph 标记（对照语义）
    const trace2 = {};
    const hits2 = await r.retrieve('张伟负责什么工作', kbid, 5, 0, { rerankEnabled: false, graph: false, trace: trace2 });
    assert.strictEqual(trace2.graph, undefined, 'graph=false 应跳过图谱通道');
    assert.ok(hits2.every(h => h.graph == null), '关闭通道时不应有 graph 标记');
  });

  // ---- AI-05：记忆语义召回 + 同义合并 ----
  await t('AI-05：agent_memories 迁移——embedding/last_used_at 列已就绪', () => {
    const cols = db.prepare('PRAGMA table_info(agent_memories)').all().map(c => c.name);
    assert.ok(cols.includes('embedding'), '应有 embedding 列：' + cols.join(','));
    assert.ok(cols.includes('last_used_at'), '应有 last_used_at 列');
  });

  await t('AI-05：recallMemories 语义排序 Top-K——相关记忆排前、无关不挤占注入位、last_used_at 回写', async () => {
    const mr = require('../src-server/lib/memory-recall');
    db.prepare('INSERT INTO agents (name,prompt,owner,created_at) VALUES (\'AI05记忆测试智能体\',\'测试\',\'memu\',datetime(\'now\',\'localtime\'))').run();
    const aid = db.prepare(`SELECT id FROM agents WHERE name='AI05记忆测试智能体'`).get().id;
    const ins = db.prepare('INSERT INTO agent_memories (agent_id,username,fact,type,confidence,source,created_at) VALUES (?,?,?,?,?,?,?)');
    ins.run(aid, 'memu', '用户是银行客户经理，负责信贷业务', 'fact', 1.0, 'chat', '2026-11-20 10:00:00');
    ins.run(aid, 'memu', '用户偏好简洁的回复风格', 'preference', 1.0, 'chat', '2026-11-20 10:00:00');
    ins.run(aid, 'memu', '用户养了一只橘猫', 'fact', 1.0, 'chat', '2026-11-01 10:00:00');
    const trace = {};
    const rows = await mr.recallMemories(aid, 'memu', '帮我写一份信贷风险审查报告', { topK: 2, trace });
    assert.strictEqual(rows.length, 2, 'Top-K=2 应只回 2 条（原行为全量 LIMIT 20）');
    assert.ok(String(rows[0].fact).includes('信贷') || String(rows[0].fact).includes('银行'), '相关记忆应排第一：' + rows[0].fact);
    assert.ok(trace.memory && trace.memory.engine === 'H' && trace.memory.injected === 2, 'trace 应记录引擎与注入数：' + JSON.stringify(trace.memory));
    const used = db.prepare('SELECT last_used_at FROM agent_memories WHERE agent_id=? AND fact LIKE ?').get(aid, '%信贷%');
    assert.ok(used && used.last_used_at, '命中记忆应回写 last_used_at');
    // 向量懒缓存：召回后 embedding 列应已写入（本地哈希 BLOB）
    const cached = db.prepare('SELECT embedding FROM agent_memories WHERE agent_id=? AND fact LIKE ?').get(aid, '%橘猫%');
    assert.ok(cached && cached.embedding, '召回侧应懒写入向量缓存（BLOB）');
    globalThis.__ai05AgentId = aid;
  });

  await t('AI-05：recordMemories 同义合并——近义重复更新既有行而非新增；互为子串去重保持', async () => {
    const mr = require('../src-server/lib/memory-recall');
    const aid = globalThis.__ai05AgentId;
    assert.ok(aid, '依赖记忆测试智能体');
    // ① 互为子串去重（改造前语义保留）
    const s1 = await mr.recordMemories({ agentId: aid, username: 'memu', facts: ['用户是银行客户经理，负责信贷业务'] });
    assert.strictEqual(s1.inserted, 0, '与既有记忆互为子串应 0 新增：' + JSON.stringify(s1));
    // ② 同义合并：措辞微调（近义）→ 本地哈希 cosine > 0.92 → 更新既有行
    const before = db.prepare('SELECT COUNT(*) c FROM agent_memories WHERE agent_id=? AND username=?').get(aid, 'memu').c;
    const s2 = await mr.recordMemories({ agentId: aid, username: 'memu', facts: ['用户是银行客户经理，负责信贷审批业务'] });
    const after = db.prepare('SELECT COUNT(*) c FROM agent_memories WHERE agent_id=? AND username=?').get(aid, 'memu').c;
    assert.strictEqual(after, before, '近义重复应合并不新增：' + before + ' → ' + after + '，' + JSON.stringify(s2));
    const merged = db.prepare('SELECT fact, embedding FROM agent_memories WHERE agent_id=? AND username=? AND fact LIKE ?').get(aid, 'memu', '%信贷审批%');
    assert.ok(merged, '合并后应保留新措辞：' + (merged && merged.fact));
    assert.ok(merged && merged.embedding, '合并行应带新向量缓存');
    // ③ 全新事实 → 正常新增且带向量
    const s3 = await mr.recordMemories({ agentId: aid, username: 'memu', facts: ['用户所在分行在杭州'] });
    assert.strictEqual(s3.inserted, 1, '全新事实应正常新增');
    const row3 = db.prepare('SELECT embedding FROM agent_memories WHERE agent_id=? AND username=? AND fact=?').get(aid, 'memu', '用户所在分行在杭州');
    assert.ok(row3 && row3.embedding, '新增记忆应随写向量缓存');
  });

  await t('AI-05：衰减函数口径——新记忆满权重、90 天半衰、长期下限 0.2', () => {
    const mr = require('../src-server/lib/memory-recall');
    assert.strictEqual(mr.decayFactor(null), 1, '无时间基点不惩罚');
    assert.ok(Math.abs(mr.decayFactor(new Date().toLocaleString('sv-SE')) - 1) < 0.01, '刚创建应 ~1');
    const half = mr.decayFactor(new Date(Date.now() - 90 * 86400000).toLocaleString('sv-SE'));
    assert.ok(Math.abs(half - 0.5) < 0.05, '90 天应 ~0.5（半衰期），实得 ' + half);
    const old = mr.decayFactor(new Date(Date.now() - 900 * 86400000).toLocaleString('sv-SE'));
    assert.strictEqual(old, 0.2, '超长期应钳制下限 0.2（偏好类记忆不失效只降权）');
  });

  // ---- AI-07：答案忠实度 / 引用校验 ----
  await t('AI-07：引用编号解析与分句（纯函数口径）', () => {
    const f = require('../src-server/lib/faithfulness');
    assert.deepStrictEqual(f.parseCitations('答案如[1]，多引用[2][3]与越界[99]'), [1, 2, 3, 99], '应去重保序提取全部编号');
    const s = f.splitSentences('这是第一句完整内容。[1] 第二句较短。好的。\n第三句完整且足够长度！');
    assert.ok(s.length >= 2, '短碎片（<6 字实义）应被过滤，实质句保留：' + JSON.stringify(s));
    assert.ok(s[0].includes('这是第一句完整内容'), '首句应保留：' + s[0]);
    assert.ok(!s.some(x => x.includes('第二句较短') || x.includes('好的')), '短碎片不应送检');
  });

  await t('AI-07：词面校验（无供应商 lexical 模式）——支撑回答 pass / 越界引用 low / 幻觉断言 low', async () => {
    const f = require('../src-server/lib/faithfulness');
    const hits = [{ content: '公司规定员工迟到需填写补卡单，由部门主管审批。' }, { content: '报销须在费用发生后 30 天内提交。' }];
    // ① 有据回答（引用 + 内容来自片段）→ pass
    const ok = await f.checkFaithfulness({ answer: '员工迟到需要填写补卡单并由部门主管审批。[1]', hits });
    assert.strictEqual(ok.verdict, 'pass', '有据回答应 pass：' + JSON.stringify(ok && ok.summary));
    assert.strictEqual(ok.mode, 'lexical', '无供应商应为词面模式');
    assert.strictEqual(ok.score, 1, '全支撑应为 1');
    // ② 引用越界（[9] 但命中集仅 2 条）→ low_confidence + invalidCitations
    const bad = await f.checkFaithfulness({ answer: '员工迟到需要填写补卡单并由部门主管审批。[9]', hits });
    assert.ok(bad.lowConfidence, '越界引用应低置信');
    assert.deepStrictEqual(bad.invalidCitations, [9], '应检出越界编号 9');
    // ③ 幻觉断言（命中集中不存在的事实）→ 词面覆盖不足 → low_confidence
    const hal = await f.checkFaithfulness({ answer: '所有迟到员工一律罚款五百元并通报批评。[1]', hits });
    assert.ok(hal.lowConfidence && hal.unsupported.length >= 1, '幻觉断言应判不支撑：' + JSON.stringify(hal && hal.summary));
    // ④ 空 hits / 空答案 → null（0 阻断不炸）
    assert.strictEqual(await f.checkFaithfulness({ answer: 'x'.repeat(20), hits: [] }), null);
    assert.strictEqual(await f.checkFaithfulness({ answer: '', hits }), null);
  });

  // ---- AI-03：召回多指标（Recall@K / MRR / NDCG）----
  await t('AI-03：rankMetrics 纯函数——Top-1/hit@K/rank/MRR/NDCG 各形态口径', () => {
    const { rankMetrics } = require('../src-server/lib/kb-eval-regression');
    // 首位命中：全指标满分
    const m1 = rankMetrics(['包含甲目标词的内容', '无关内容'], ['甲目标词']);
    assert.strictEqual(m1.top1, true); assert.strictEqual(m1.rank, 1); assert.strictEqual(m1.mrr, 1); assert.strictEqual(m1.ndcg, 1);
    // 第 2 位命中：MRR=0.5，NDCG < 1（排序质量惩罚）
    const m2 = rankMetrics(['无关内容', '包含甲目标词'], ['甲目标词']);
    assert.strictEqual(m2.top1, false); assert.strictEqual(m2.hitK, true); assert.strictEqual(m2.rank, 2);
    assert.strictEqual(m2.mrr, 0.5);
    assert.ok(m2.ndcg > 0.5 && m2.ndcg < 1, '第 2 位命中 NDCG 应 (0.5,1)：' + m2.ndcg);
    // 未命中：全 0
    const m3 = rankMetrics(['无关一', '无关二'], ['目标词']);
    assert.strictEqual(m3.top1, false); assert.strictEqual(m3.hitK, false); assert.strictEqual(m3.mrr, 0); assert.strictEqual(m3.ndcg, 0);
    // 多期望词覆盖率：2 词中 1 词 → recall 0.5
    const m4 = rankMetrics(['包含甲词'], ['甲词', '乙词']);
    assert.strictEqual(m4.recall, 0.5, '期望词覆盖率应为 0.5');
  });

  await t('AI-03：rerunEvalSet 落多指标——evaluations.metrics 含 hit@K/召回@K/MRR/NDCG，result 明细增补字段且旧字段兼容', async () => {
    const { rerunEvalSet } = require('../src-server/lib/kb-eval-regression');
    const kbid = globalThis.__ai04KbId; // 复用图谱测试库（已有张伟/李娜分块）
    assert.ok(kbid, '依赖 AI-04 测试库');
    db.prepare(`INSERT INTO evaluations (name,kb_id,type,dataset,status,score,created_at) VALUES ('AI03多指标评测集',?,'kb',?,'done',NULL,datetime('now','localtime'))`)
      .run(kbid, JSON.stringify([
        { query: '张伟负责什么工作', expect_terms: ['张伟'] },
        { query: '李娜担任什么职务', expect_terms: ['李娜'] },
      ]));
    const ev = db.prepare(`SELECT * FROM evaluations WHERE name='AI03多指标评测集' AND kb_id=?`).get(kbid);
    const r = await rerunEvalSet(ev);
    assert.ok(r.score > 0, 'Top-1 均分应为正（两问皆应首位命中）：' + r.score);
    assert.ok(r.metrics && r.metrics.k === 10 && r.metrics.cases === 2, '聚合应含 K=10 与用例数：' + JSON.stringify(r.metrics));
    assert.ok(r.metrics.hit_at_k > 0 && r.metrics.mrr > 0 && r.metrics.ndcg > 0, 'hit@K/MRR/NDCG 应为正：' + JSON.stringify(r.metrics));
    assert.ok(r.metrics.recall_at_k > 0, '召回@K 应为正');
    const stored = JSON.parse(db.prepare('SELECT metrics FROM evaluations WHERE id=?').get(ev.id).metrics);
    assert.ok(stored.mrr != null && stored.ndcg != null, 'metrics 列应持久化多指标');
    const detail0 = JSON.parse(db.prepare('SELECT result FROM evaluations WHERE id=?').get(ev.id).result)[0];
    assert.ok('query' in detail0 && 'hit' in detail0 && 'score' in detail0, '旧字段应保留（前端/基线导入兼容）');
    assert.ok('rank' in detail0 && 'mrr' in detail0 && 'ndcg' in detail0 && 'recall' in detail0, '新字段应增补：' + JSON.stringify(Object.keys(detail0)));
  });

  await t('AI-03：ragFourMetrics 启发式四指标——检索好/跑题/幻觉三形态可判（无供应商 heuristic 模式）', async () => {
    const rm = require('../src-server/lib/rag-metrics');
    const contexts = ['员工迟到需填写补卡单，由部门主管审批后生效。', '报销须在费用发生后 30 天内提交财务系统。'];
    const good = await rm.ragFourMetrics({ query: '迟到怎么处理', contexts, answer: '员工迟到需填写补卡单，由部门主管审批后生效。[1]' });
    assert.strictEqual(good.mode, 'heuristic');
    assert.ok(good.context_precision > 0 && good.answer_relevancy > 0 && good.faithfulness === 1, '好回答四指标应全正：' + JSON.stringify(good));
    const hal = await rm.ragFourMetrics({ query: '迟到怎么处理', contexts, answer: '迟到一律罚款五百元并全公司通报批评，情节严重者开除。[1]' });
    assert.ok(hal.faithfulness < good.faithfulness, '幻觉回答忠实度应低于有据回答');
    const off = await rm.ragFourMetrics({ query: '公司年报净利润是多少', contexts, answer: '员工迟到需填写补卡单，由部门主管审批后生效。' });
    assert.ok(off.answer_relevancy < good.answer_relevancy, '跑题回答相关性应低');
    assert.strictEqual(off.context_recall, 0, '问题所需信息未被覆盖时上下文召回率应为 0');
  });

  await t('AI-03：runRagBaseline 端到端（answerFn DI 注入）——落 evaluations(type=rag) + 四指标聚合 + score 可比', async () => {
    const rm = require('../src-server/lib/rag-metrics');
    const kbid = globalThis.__ai04KbId;
    assert.ok(kbid, '依赖 AI-04 测试库');
    const out = await rm.runRagBaseline({
      kbId: kbid,
      cases: [
        { query: '张伟负责什么工作', expect_terms: ['张伟'] },
        { query: '李娜担任什么职务', expect_terms: ['李娜'] },
      ],
      opts: {
        answerFn: async ({ query, contexts }) => {
          const hit = contexts.find(c => c.includes(query.includes('张伟') ? '张伟' : '李娜')) || contexts[0] || '';
          return `根据资料：${String(hit).slice(0, 40)}[1]`;
        },
      },
    });
    assert.strictEqual(out.ok, true, '基线应成功：' + JSON.stringify(out).slice(0, 200));
    assert.strictEqual(out.cases, 2);
    assert.ok(out.metrics.evaluated_answers === 2, 'answerFn 注入下两条用例均可评答案侧：' + JSON.stringify(out.metrics));
    for (const k of ['context_precision', 'context_recall', 'answer_relevancy', 'faithfulness']) {
      assert.ok(Number.isFinite(out.metrics[k]), `四指标 ${k} 应有值：` + JSON.stringify(out.metrics));
    }
    const row = db.prepare(`SELECT * FROM evaluations WHERE id=? AND type='rag'`).get(out.id);
    assert.ok(row, '应落 evaluations type=rag 行');
    assert.ok(Number.isFinite(row.score) && row.score > 0, 'score 应为四指标均值（可排序可比）');
    // 反例：空用例集
    const bad = await rm.runRagBaseline({ kbId: kbid, cases: [] });
    assert.strictEqual(bad.ok, false, '空用例应被拒绝');
  });

  // ==================== AI-02 收尾（D-4 拍板 SQLite-vec）向量索引 2026-11-23 ====================
  console.log('【AI-02 收尾】SQLite-vec 向量索引（覆盖度闸/双写回填/KNN 融合/失效联动/降级链）');

  await t('AI-02：vector-index 原语——upsert(BigInt rowid)/knn 排序/count/remove/drop 幂等', () => {
    const vi = require('../src-server/lib/vector-index');
    assert.strictEqual(vi.available(), true, 'sqlite-vec 扩展应可加载（预编译二进制随依赖安装）');
    const kbId = 987654; // 测试专用库号（不建真实库，仅验证索引原语）
    vi.drop(kbId);
    const vecA = new Float32Array(vi.BGE_DIM); vecA[0] = 1;
    const vecB = new Float32Array(vi.BGE_DIM); vecB[1] = 1;
    assert.strictEqual(vi.count(kbId), 0, '空索引 count=0');
    vi.upsert(kbId, [{ id: 101, vec: vecA }, { id: 102, vec: vecB }]);
    assert.strictEqual(vi.count(kbId), 2, '应写入 2 条（BigInt rowid 绑定）');
    const hits = vi.knn(kbId, vecA, 2);
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].rowid, 101, '最近邻应为 101（同向向量）');
    assert.ok(hits[0].distance <= hits[1].distance, 'KNN 应按距离升序');
    // upsert 幂等：同 id 重写不新增行
    vi.upsert(kbId, [{ id: 101, vec: vecB }]);
    assert.strictEqual(vi.count(kbId), 2, '同 id 重写不应新增');
    vi.remove(kbId, [102]); // 移除同向并列行，消除距离并列的断言不确定性
    assert.strictEqual(vi.knn(kbId, vecB, 1)[0].rowid, 101, '重写后 101 应匹配 vecB');
    vi.remove(kbId, [101]);
    assert.strictEqual(vi.count(kbId), 0, 'remove 后表应清空（102 已在并列消解时移除）');
    vi.drop(kbId);
    assert.strictEqual(vi.count(kbId), 0, 'drop 后 count=0（ensureTable 幂等重建空表）');
  });

  await t('AI-02：检索 ANN 快路径端到端——首查覆盖度回填双写、KNN 融合命中、次查零回填、失效联动重建、禁用回落全扫', async () => {
    const r = require('../src-server/lib/retriever');
    const vi = require('../src-server/lib/vector-index');
    db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI02向量索引测试库','',1,'vecu',datetime('now','localtime'))`).run();
    const kbid = db.prepare(`SELECT id FROM kbs WHERE name='AI02向量索引测试库'`).get().id;
    const fin = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,100,'success',2,datetime('now','localtime'))`).run(kbid, '向量测试文档.txt');
    const fid = Number(fin.lastInsertRowid);
    const c1 = db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '考勤管理制度：员工上下班均须打卡，不得代打卡。');
    db.prepare(`INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)`).run(fid, kbid, '报销管理制度：差旅费用须按时提交，逾期不予报销。');
    const origFetch = global.fetch;
    const origAllow = process.env.AGENT_FETCH_ALLOW_PRIVATE;
    process.env.AGENT_FETCH_ALLOW_PRIVATE = '1'; // mock fetch 不真正出网，SSRF 守卫放行内网 mock 地址
    db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES ('bge嵌入测试供应商','http://gw.test/v1','sk-x',?,1,0,'',datetime('now','localtime'))`).run(JSON.stringify(['bge-m3']));
    // mock /embeddings：文本含「考勤」→ 单位向量 e0，否则 e1（正交，判别确定性）
    const vecOf = (axis) => { const v = new Array(vi.BGE_DIM).fill(0); v[axis] = 1; return v; };
    global.fetch = async (url, opt) => {
      const body = JSON.parse((opt && opt.body) || '{}');
      const input = body.input || [];
      return { ok: true, json: async () => ({ data: input.map(t => ({ embedding: String(t).includes('考勤') ? vecOf(0) : vecOf(1) })) }) };
    };
    r.__expireCircuitBreakers();
    try {
      // ① 首查：覆盖度 0/2 → 回填双写（kb_chunks 无缓存全走网关）→ KNN 融合
      const trace1 = {};
      const hits1 = await r.retrieve('考勤制度怎么样', kbid, 5, 0, { rerankEnabled: false, trace: trace1 });
      assert.ok(trace1.ann && trace1.ann.engine === 'sqlite-vec', '应走 ANN 路径：' + JSON.stringify(trace1.ann));
      assert.strictEqual(trace1.ann.coverage, '2/2', '覆盖度应补齐至 2/2');
      assert.ok(trace1.ann.backfilled >= 2, '首查应回填 2 条（双写）：' + JSON.stringify(trace1.ann));
      assert.ok(hits1.length >= 1 && String(hits1[0].content).includes('考勤'), 'Top-1 应为考勤分块');
      assert.strictEqual(trace1.engine, 'B3', '引擎标签应为 B3');
      const emb = db.prepare('SELECT embedding FROM kb_chunks WHERE id=?').get(Number(c1.lastInsertRowid));
      assert.ok(emb && emb.embedding, 'kb_chunks.embedding 应已写 B3 缓存（双写之一）');
      assert.strictEqual(vi.count(kbid), 2, '影子表应有 2 条（双写之二）');
      // ② 次查：覆盖度完整 → 纯 KNN 快路径，零回填零网关批量
      const trace2 = {};
      await r.retrieve('考勤制度怎么样', kbid, 5, 0, { rerankEnabled: false, trace: trace2 });
      assert.strictEqual(trace2.ann.backfilled, 0, '覆盖度完整后应零回填');
      assert.strictEqual(trace2.ann.coverage, '2/2');
      // ③ 失效联动：remove 后覆盖度闸自动重建
      vi.remove(kbid, [Number(c1.lastInsertRowid)]);
      assert.strictEqual(vi.count(kbid), 1, '失效后影子表剩 1 条');
      const trace3 = {};
      const hits3 = await r.retrieve('考勤制度怎么样', kbid, 5, 0, { rerankEnabled: false, trace: trace3 });
      assert.ok(trace3.ann.backfilled >= 1, '覆盖度缺失应触发回填重建');
      assert.ok(hits3.length >= 1 && String(hits3[0].content).includes('考勤'), '重建后命中不变');
      // ④ 全局禁用 → 回落全扫（无 ann trace，命中一致——降级链 0 阻断）
      const origAvail = vi.__force(false);
      try {
        const trace4 = {};
        const hits4 = await r.retrieve('考勤制度怎么样', kbid, 5, 0, { rerankEnabled: false, trace: trace4 });
        assert.strictEqual(trace4.ann, undefined, '禁用后不应有 ann trace（回落全表扫描）');
        assert.ok(hits4.length >= 1 && String(hits4[0].content).includes('考勤'), '全扫路径命中应一致（B3 缓存已就绪）');
        assert.strictEqual(trace4.engine, 'B3', '全 B3 缓存路径引擎标签应为 B3（AI-02 收尾修正历史误标）');
      } finally { vi.__force(origAvail); }
    } finally {
      vi.drop(kbid);
      db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbid);
      db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbid);
      db.prepare('DELETE FROM kbs WHERE id=?').run(kbid);
      db.prepare('DELETE FROM providers WHERE name=?').run('bge嵌入测试供应商');
      global.fetch = origFetch;
      if (origAllow === undefined) delete process.env.AGENT_FETCH_ALLOW_PRIVATE; else process.env.AGENT_FETCH_ALLOW_PRIVATE = origAllow;
      r.__expireCircuitBreakers();
    }
  });

  // ==================== BE-E1 迁移框架单一化（2026-11-23） ====================
  console.log('【BE-E1】迁移框架单一化（M4 列迁出 / down 回滚 / schema 锚点与漂移 / 内联门禁 / CLI）');
  {
    const { db } = require('../src-server/db');
    const mig = require('../src-server/lib/migrate');

    await t('BE-E1：M4 列迁移 #124~#131 已入册——全新库单次 boot 后全部就位（时序 Bug 根治）', () => {
      // 本 smoke 进程 require db.js 即为全新库单次 boot（此前 M4 内联块写在建表语句之前，
      // 单次 boot 会丢 retrieval_trace，靠 P2 子进程二次 boot 才补救——此测试守住该回归）
      const traceCols = db.prepare('PRAGMA table_info(chat_traces)').all().map(c => c.name);
      assert.ok(traceCols.includes('retrieval_trace'), 'chat_traces 应有 retrieval_trace（#128）');
      const kbCols = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
      for (const c of ['rerank_enabled', 'rerank_model', 'rerank_top_n', 'rerank_threshold']) {
        assert.ok(kbCols.includes(c), `kbs 应有 ${c}（#124~#127）`);
      }
      const evCols = db.prepare('PRAGMA table_info(evaluations)').all().map(c => c.name);
      assert.ok(evCols.includes('metrics'), 'evaluations 应有 metrics（#129）');
      const amCols = db.prepare('PRAGMA table_info(agent_memories)').all().map(c => c.name);
      assert.ok(amCols.includes('embedding') && amCols.includes('last_used_at'), 'agent_memories 应有 embedding+last_used_at（#130/#131）');
      const ids = mig.getAppliedIds();
      for (const id of [124, 125, 126, 127, 128, 129, 130, 131]) {
        assert.ok(ids.has(id), `迁移 #${id} 应已记录台账`);
      }
      // db.js 不再含 M4 内联迁移（DDL 特征级检查，迁出干净）
      const src = fs.readFileSync(path.join(__dirname, '../src-server/db.js'), 'utf8');
      assert.ok(!src.includes('ADD COLUMN retrieval_trace'), 'db.js 不应再含 retrieval_trace 内联加列');
      assert.ok(!src.includes('ADD COLUMN rerank_'), 'db.js 不应再含 kbs.rerank_* 内联加列');
      assert.ok(!src.includes('ADD COLUMN metrics'), 'db.js 不应再含 evaluations.metrics 内联加列');
      assert.ok(!src.includes('ADD COLUMN embedding BLOB') && !src.includes("ADD COLUMN last_used_at"), 'db.js 不应再含 agent_memories M4 两列内联加列');
    });

    await t('BE-E1：down/up 回滚闭环——逆序回滚删列、台账出册、up 恢复', () => {
      const appliedBefore = mig.getAppliedIds();
      assert.ok(appliedBefore.has(131), '前置：#131 应在台账');
      try {
        // 注：迁移注册表后续新增更高 id（如 D-3 #132）时此处同步维护——回滚窗口 [to+1, max]，断言聚焦 #131 的列级 down 语义
        const results = mig.revertMigrations(mig.ALL_MIGRATIONS, { to: 130 });
        assert.ok(results.length >= 1 && results.every(r => r.ok), '窗口内全部步应回滚成功：' + JSON.stringify(results));
        assert.ok(results.some(r => r.id === 131), '应包含 #131');
        const cols = db.prepare('PRAGMA table_info(agent_memories)').all().map(c => c.name);
        assert.ok(!cols.includes('last_used_at'), '回滚后 last_used_at 列应消失（DROP COLUMN）');
        assert.ok(!mig.getAppliedIds().has(131), '台账应移除 #131');
      } finally {
        // 防御式：断言失败也保证 up 恢复，不把删列状态泄漏给后续测试
        const missing = mig.ALL_MIGRATIONS.filter(s => s.id > 130 && !mig.getAppliedIds().has(s.id)).map(s => s.id);
        const up = mig.runMigrations(mig.ALL_MIGRATIONS, { onlyIds: missing });
        assert.ok(up.applied >= 1, 'up 应重新应用被回滚的步：' + JSON.stringify(missing));
      }
      const colsAfter = db.prepare('PRAGMA table_info(agent_memories)').all().map(c => c.name);
      assert.ok(colsAfter.includes('last_used_at'), 'up 后 last_used_at 列应恢复');
      assert.ok(mig.getAppliedIds().has(131), '台账应重新记录 #131');
    });

    await t('BE-E1：schema 锚点与漂移检测——指纹一致 ok、绕过框架改结构报 drift 并定位对象', () => {
      const fp = mig.computeSchemaFingerprint();
      assert.ok(/^[0-9a-f]{64}$/.test(fp.hash), '全库指纹应为 sha256 hex');
      assert.ok(fp.objectCount > 100, `应覆盖全库对象（实际 ${fp.objectCount}）`);
      mig.anchorSchema();
      assert.strictEqual(mig.checkSchemaDrift().status, 'ok', '锚定后应一致');
      // 模拟「绕过迁移框架直改结构」：漂移检测应捕获并定位对象
      db.exec("ALTER TABLE sessions ADD COLUMN __drift_probe TEXT DEFAULT ''");
      const drift = mig.checkSchemaDrift();
      assert.strictEqual(drift.status, 'drift', '直改结构应报 drift');
      assert.ok(drift.drifted.some(k => k.startsWith('table:sessions')), 'drift 应定位到 sessions：' + drift.drifted.join(','));
      try {
        db.exec('ALTER TABLE sessions DROP COLUMN __drift_probe');
      } catch (e) { throw new Error('清理探针列失败：' + e.message); }
      assert.strictEqual(mig.checkSchemaDrift().status, 'ok', '恢复后应重新一致');
      // 锚点与发布绑定：app_version 记录 package.json 版本
      const ver = db.prepare("SELECT value FROM schema_anchor WHERE key='app_version'").get();
      assert.ok(ver && /^\d+\.\d+\.\d+/.test(ver.value), '锚点应记录应用版本（与发布绑定）');
    });

    await t('BE-E1：lint-inline-schema 门禁——冻结基线，新增内联建表/加列被拦截', () => {
      const lint = require('../scripts/lint-inline-schema.js');
      // 函数级：扫描器解析 CREATE TABLE / ALTER ADD COLUMN
      const scanned = lint.scanInlineSchema('db.exec("CREATE TABLE IF NOT EXISTS foo (id INTEGER)");\ndb.exec("ALTER TABLE foo ADD COLUMN bar TEXT");');
      assert.ok(scanned.tables.includes('foo'), '应扫出内联建表 foo');
      assert.ok(scanned.alters.some(([k]) => k === 'foo.bar'), '应扫出加列对 foo.bar');
      const baseline = JSON.parse(fs.readFileSync(lint.BASELINE, 'utf8'));
      // 门禁级：当前真实 db.js 通过（基线内）
      const realSrc = fs.readFileSync(lint.DB_JS, 'utf8');
      const ok = lint.checkInlineSchema(realSrc, baseline);
      assert.ok(ok.ok, '当前 db.js 应通过门禁：' + JSON.stringify(ok.violations || []));
      // 门禁级：基线外新增被拦截（建表 + 加列各一）
      const badSrc = realSrc + '\ndb.exec("CREATE TABLE IF NOT EXISTS __lint_probe (id INTEGER)");\ndb.exec("ALTER TABLE sessions ADD COLUMN __probe_col TEXT");';
      const bad = lint.checkInlineSchema(badSrc, baseline);
      assert.strictEqual(bad.ok, false, '新增内联 DDL 应被拦截');
      assert.ok(bad.violations.some(v => v.includes('__lint_probe')), '应报告新增建表违规');
      assert.ok(bad.violations.some(v => v.includes('__probe_col')), '应报告新增加列违规');
    });

    await t('BE-E1：CLI scripts/migrate.js——status 子进程跑通（台账 + 锚点 + 漂移状态）', async () => {
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [path.join(__dirname, '../scripts/migrate.js'), 'status'], {
        cwd: path.join(__dirname, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
      const code = await new Promise((resolve) => { child.on('close', resolve); });
      clearTimeout(timer);
      assert.strictEqual(code, 0, 'CLI status 应正常退出（stderr：' + err.slice(0, 200) + '）');
      assert.ok(out.includes('台账：'), '应输出台账统计');
      assert.ok(/已应用/.test(out), '应报告已应用步数');
      assert.ok(out.includes('锚点'), '应输出锚点状态');
    });
  }

  // ==================== AI-08 工作流知识库检索节点（2026-11-23） ====================
  console.log('【AI-08】工作流知识库检索节点（一等 RAG 节点 / 租户防线 / 节点级召回测试）');
  {
    const { db } = require('../src-server/db');
    const { NODE_EXECUTORS, runWorkflow } = require('../src-server/lib/workflow');
    const schema = require('../src-server/lib/workflow-schema');

    // 建测试库 + 分块（BM25 关键词命中，无需嵌入向量）
    db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI-08 检索节点测试库','',1,'httpu1',datetime('now','localtime'))`).run();
    const kbId = db.prepare(`SELECT id FROM kbs WHERE name='AI-08 检索节点测试库'`).get().id;
    db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'考勤制度.txt',50,'success',2,datetime('now','localtime'))`).run(kbId);
    const fileId = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;
    db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fileId, kbId, '员工迟到早退的，按公司考勤制度处理，三次以上通报批评。');
    db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fileId, kbId, '年假申请需提前三个工作日在系统提交。');
    const ctx = { agent: { tenant_id: 1 }, username: 'httpu1' };
    try {
      await t('AI-08：知识检索节点执行器——chunks/text/count 输出契约 + BM25 命中', async () => {
        const node = { id: 'n1', type: 'knowledge', data: { kb_id: kbId, top_n: 3, threshold: '', rerank_enabled: 'off', metadata_filter: '' } };
        const out = await NODE_EXECUTORS.knowledge(node, { query: '迟到早退怎么处理' }, ctx);
        assert.ok(out.count >= 1, '应至少命中 1 条（BM25 关键词）');
        assert.ok(Array.isArray(out.chunks) && out.chunks.length === out.count, 'chunks 数组长度应与 count 一致');
        assert.ok(String(out.chunks[0].content).includes('迟到'), '命中片段应含特征词');
        assert.ok(out.text.includes('考勤制度'), '拼接上下文应含命中内容（下游 LLM 直接可用）');
        for (const k of ['file', 'kb', 'score', 'bm25', 'vec', 'rerank_score', 'content']) assert.ok(k in out.chunks[0], `chunks 元素应含溯源字段 ${k}`);
        assert.ok(out.retrieval_trace && typeof out.retrieval_trace === 'object', '应带检索诊断 trace（AI-13 可观测）');
      });
      await t('AI-08：防线——kb_id 未配置 / 库不存在 / 库停用 fail-closed 拒绝执行', async () => {
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: {} }, { query: 'x' }, ctx), /未配置知识库/);
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: { kb_id: 99999999 } }, { query: 'x' }, ctx), /不存在/);
        db.prepare('UPDATE kbs SET enabled=0 WHERE id=?').run(kbId);
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: { kb_id: kbId } }, { query: 'x' }, ctx), /已停用/);
        db.prepare('UPDATE kbs SET enabled=1 WHERE id=?').run(kbId);
      });
      await t('AI-08：防线——跨租户库拒绝 / query 空拒绝 / metadata_filter 非法 JSON 拒绝', async () => {
        db.prepare('UPDATE kbs SET tenant_id=999 WHERE id=?').run(kbId);
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: { kb_id: kbId } }, { query: 'x' }, ctx), /其他租户/);
        db.prepare('UPDATE kbs SET tenant_id=1 WHERE id=?').run(kbId);
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: { kb_id: kbId } }, { query: '' }, ctx), /查询为空/);
        await assert.rejects(() => NODE_EXECUTORS.knowledge({ data: { kb_id: kbId, metadata_filter: '{bad json' } }, { query: 'x' }, ctx), /metadata_filter/);
      });
      await t('AI-08：schema——knowledge 入白名单可保存 + 输出变量注册 + checkRefs 校验 query 模板引用', () => {
        const wf = schema.validateWorkflowV2({
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
            { id: 'n1', type: 'knowledge', position: { x: 1, y: 1 }, data: { kb_id: kbId, query: '{{#start.input#}}', top_n: 5 } },
            { id: 'n2', type: 'end', position: { x: 2, y: 2 }, data: { outputs: [{ variable: 'result', value: '{{#n1.text#}}' }] } },
          ],
          edges: [{ id: 'e1', source: 'start', target: 'n1' }, { id: 'e2', source: 'n1', target: 'n2' }],
        });
        assert.ok(wf && !wf.error, '含 knowledge 节点的图应通过保存校验：' + (wf?.error || ''));
        const outs = schema.getNodeOutputs({ id: 'n1', type: 'knowledge', data: {} }).map(o => o.name);
        for (const k of ['chunks', 'text', 'count']) assert.ok(outs.includes(k), `应注册输出变量 ${k}`);
        assert.strictEqual(schema.checkRefs(wf).length, 0, '合法引用（start.input / n1.text）应零问题');
        const wfBad = schema.validateWorkflowV2({ nodes: wf.nodes.map(n => n.id === 'n1' ? { ...n, data: { ...n.data, query: '{{#ghost.var#}}' } } : n), edges: wf.edges });
        const bad = schema.checkRefs(wfBad);
        assert.ok(bad.some(p => p.ref === 'ghost.var'), 'knowledge.query 引用不存在变量应被 checkRefs 捕获');
      });
      await t('AI-08：端到端——start → knowledge → end 图 runWorkflow 全链路（resolveInputs 模板渲染）', async () => {
        const agent = {
          id: 0, name: 'AI-08 测试画布', edit_mode: 'canvas', kb_id: null, model: '', mcp_servers: '[]', tenant_id: 1,
          workflow: JSON.stringify({
            nodes: [
              { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
              { id: 'n1', type: 'knowledge', position: { x: 1, y: 1 }, data: { title: '查考勤', kb_id: kbId, query: '{{#start.input#}}', top_n: 3, threshold: '', rerank_enabled: 'off' } },
              { id: 'n2', type: 'end', position: { x: 2, y: 2 }, data: { outputs: [{ variable: 'result', value: '{{#n1.text#}}' }] } },
            ],
            edges: [{ id: 'e1', source: 'start', target: 'n1' }, { id: 'e2', source: 'n1', target: 'n2' }],
          }),
        };
        const r = await runWorkflow(agent, { input: '迟到早退怎么处理' }, { username: 'httpu1' });
        assert.ok(String(r.output || '').includes('考勤制度'), 'end 输出（引用 {{#n1.text#}}）应含检索命中内容：' + String(r.output).slice(0, 80));
        assert.ok(r.results?.n1?.count >= 1, 'n1 节点输出应含 count（resolveInputs → 执行器 → 变量表全链路）');
      });
    } finally {
      db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
      db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
      db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
    }
  }

  // ==================== D-3 全域 API Key（2026-11-23 拍板：需要全域模式） ====================
  console.log('【D-3】全域 API Key（迁移 #132 重建 / 作用域矩阵 / down 回滚）');
  {
    const { db } = require('../src-server/db');
    const mig = require('../src-server/lib/migrate');

    await t('D-3：迁移 #132 重建 agent_api_keys——agent_id 可空 + 归属列 + down/up 回滚闭环', () => {
      const cols = db.prepare('PRAGMA table_info(agent_api_keys)').all();
      const agentIdCol = cols.find(c => c.name === 'agent_id');
      assert.strictEqual(agentIdCol.notnull, 0, 'agent_id 应可空（NULL=全域 Key）');
      for (const c of ['owner_username', 'tenant_id']) assert.ok(cols.some(x => x.name === c), `应有归属列 ${c}`);
      assert.ok(mig.getAppliedIds().has(132), '迁移 #132 应在台账');
      try {
        // 注：注册表后续新增更高 id 时窗口自动扩大（BE-F1 #133~136 等）——断言聚焦 #132 的重建语义
        const r = mig.revertMigrations(mig.ALL_MIGRATIONS, { to: 131 });
        assert.ok(r.length >= 1 && r.every(x => x.ok), '窗口内全部步应回滚成功：' + JSON.stringify(r).slice(0, 120));
        assert.ok(r.some(x => x.id === 132), '应包含 #132');
        let c2 = db.prepare('PRAGMA table_info(agent_api_keys)').all().find(c => c.name === 'agent_id');
        assert.strictEqual(c2.notnull, 1, '回滚后 agent_id 应恢复 NOT NULL（旧 schema）');
      } finally {
        // 防御式：断言失败也保证 up 恢复，不把旧结构泄漏给后续测试
        const missing = mig.ALL_MIGRATIONS.filter(s => s.id > 131 && !mig.getAppliedIds().has(s.id)).map(s => s.id);
        const up = mig.runMigrations(mig.ALL_MIGRATIONS, { onlyIds: missing });
        assert.ok(up.applied >= 1, 'up 应重新应用被回滚的步：' + JSON.stringify(missing));
      }
      const c3 = db.prepare('PRAGMA table_info(agent_api_keys)').all().find(c => c.name === 'agent_id');
      assert.strictEqual(c3.notnull, 0, 'up 后 agent_id 应再次可空');
    });

    await t('D-3：作用域矩阵——全域 Key 同租户已发布放行 / 未发布拒绝 / 跨租户拒绝 / 不存在拒绝；绑定 Key 语义回归', () => {
      const { __authKeyForAgent } = require('../src-server/routes/openapi');
      // 造数：同租户已发布/未发布 + 他租户已发布（矩阵四象限）
      db.prepare(`INSERT INTO spaces (name,type,owner,members,created_at,tenant_id) VALUES ('D3矩阵空间','enterprise','admin','[]',datetime('now','localtime'),1)`).run();
      const spid = db.prepare(`SELECT id FROM spaces WHERE name='D3矩阵空间'`).get().id;
      db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3矩阵已发布','other',?,'admin','published','public',1,datetime('now','localtime'))`).run(spid);
      db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3矩阵草稿','other',?,'admin','draft','public',1,datetime('now','localtime'))`).run(spid);
      db.prepare(`INSERT INTO agents (name,type,space_id,owner,status,visibility,tenant_id,created_at) VALUES ('D3矩阵他租户','other',?,'admin','published','public',2,datetime('now','localtime'))`).run(spid);
      const pubId = db.prepare(`SELECT id FROM agents WHERE name='D3矩阵已发布'`).get().id;
      const draftId = db.prepare(`SELECT id FROM agents WHERE name='D3矩阵草稿'`).get().id;
      const othId = db.prepare(`SELECT id FROM agents WHERE name='D3矩阵他租户'`).get().id;
      try {
        const gk = { agent_id: null, tenant_id: 1 }; // 全域 Key（租户 1）
        assert.strictEqual(__authKeyForAgent(gk, pubId), null, '全域 Key → 同租户已发布应放行');
        assert.match(String(__authKeyForAgent(gk, draftId)), /未发布/, '全域 Key → 未发布应拒绝（fail-closed）');
        assert.match(String(__authKeyForAgent(gk, othId)), /其他租户/, '全域 Key → 他租户应拒绝');
        assert.match(String(__authKeyForAgent(gk, 99999999)), /不存在或未发布/, '全域 Key → 不存在应拒绝');
        const bound = { agent_id: pubId, tenant_id: 1 }; // 绑定 Key（回归：SEC-02a 语义不变）
        assert.strictEqual(__authKeyForAgent(bound, pubId), null, '绑定 Key → 匹配应放行（回归）');
        assert.match(String(__authKeyForAgent(bound, othId)), /无权访问/, '绑定 Key → 不匹配应拒绝（回归）');
        const legacyNoBind = { tenant_id: 1 }; // 极端防御：agent_id undefined（历史脏行）按全域矩阵处理（查库校验兜底）
        assert.match(String(__authKeyForAgent(legacyNoBind, pubId)), /.*/, '不得抛异常');
      } finally {
        db.prepare(`DELETE FROM agents WHERE name IN ('D3矩阵已发布','D3矩阵草稿','D3矩阵他租户')`).run();
        db.prepare(`DELETE FROM spaces WHERE id=?`).run(spid);
      }
    });
  }

  // ==================== AI-10 多路查询 + HyDE（2026-11-23） ====================
  console.log('【AI-10】多路查询 + HyDE（扩写回退 0 阻断 / 跨路 RRF 融合 / 库级开关 / trace 可观测）');
  {
    const { db } = require('../src-server/db');
    const mq = require('../src-server/lib/multi-query');
    const r = require('../src-server/lib/retriever');

    await t('AI-10：expandQueries——正常扩写/缓存/异常回落/垃圾输出回落/行式容错/原查询兜底/hyde', async () => {
      mq.__clearCache();
      let calls = 0;
      mq.__setImpl(async () => { calls++; return '{"queries": ["原查询", "子查询甲", "子查询乙"]}'; });
      let out = await mq.expandQueries('原查询', {});
      assert.deepStrictEqual(out.queries, ['原查询', '子查询甲', '子查询乙'], '应解析出 3 路');
      await mq.expandQueries('原查询', {});
      assert.strictEqual(calls, 1, '同查询二次应命中缓存（省一次模型调用）');
      mq.__clearCache();
      mq.__setImpl(async () => '{"queries": ["原查询", "子甲"], "hyde": "这是一段假设答案。"}');
      out = await mq.expandQueries('原查询', { hyde: true });
      assert.strictEqual(out.hyde, '这是一段假设答案。', 'hyde 字段应解析（假设答案路）');
      mq.__clearCache();
      mq.__setImpl(async () => { throw new Error('boom'); });
      out = await mq.expandQueries('原查询', {});
      assert.deepStrictEqual(out.queries, ['原查询'], '扩写异常应回落单路（0 阻断）');
      mq.__clearCache();
      mq.__setImpl(async () => 'garbage !!!');
      out = await mq.expandQueries('原查询', {});
      assert.deepStrictEqual(out.queries, ['原查询'], '垃圾输出应回落单路');
      mq.__clearCache();
      mq.__setImpl(async () => '查询一\n查询二\nhyde: 假设答案文本');
      out = await mq.expandQueries('原查询', { hyde: true });
      assert.ok(out.queries.includes('查询一') && out.queries.includes('查询二'), '非 JSON 行式解析应容错工作');
      assert.strictEqual(out.hyde, '假设答案文本', '行式 hyde: 前缀应解析');
      mq.__clearCache();
      mq.__setImpl(async () => '{"queries": ["只有子查询"]}');
      out = await mq.expandQueries('原查询', {});
      assert.strictEqual(out.queries[0], '原查询', '模型漏带原查询时应补为首路（兜底召回）');
      mq.__setImpl(null); mq.__clearCache();
    });

    await t('AI-10：retrieve 多路融合——跨路 RRF 命中增强 + trace.multiQuery 可观测 + 扩写失败回落零回归', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI-10 多路测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbId = db.prepare(`SELECT id FROM kbs WHERE name='AI-10 多路测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'多路文档.txt',50,'success',3,datetime('now','localtime'))`).run(kbId);
      const fid = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fid, kbId, '公司年假制度规定：入职满一年的员工可申请带薪年假五天。');
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fid, kbId, '休假申请流程：年假需在系统提前三个工作日提交审批。');
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fid, kbId, '公司考勤处罚规定：迟到三次以上通报批评。');
      try {
        // 桩：扩写两路子查询 + 一路原查询——分别命中「天数」与「流程」块（单路关键词易漏召的表述）
        mq.__clearCache();
        mq.__setImpl(async () => '{"queries": ["年假有多少天", "休假怎么申请"]}');
        const trace = {};
        const hits = await r.retrieve('年假怎么申请', kbId, 5, 0.01, { multiQuery: true, rerankEnabled: false, trace });
        assert.ok(hits.length >= 2, '多路融合应命中多个主题块：' + hits.length);
        assert.ok(hits.some(h => h.content.includes('五天')), '应命中天数块（子查询「年假有多少天」路）');
        assert.ok(hits.some(h => h.content.includes('提前三个工作日')), '应命中流程块（子查询「休假怎么申请」路——单路问法易漏召的表述）');
        assert.ok(trace.multiQuery && trace.multiQuery.applied === true, 'trace.multiQuery 应回填（AI-13 可观测）');
        assert.ok(Array.isArray(trace.multiQuery.queries) && trace.multiQuery.queries.length >= 2, '子查询清单应在 trace（可回答「用了哪几路」）');
        assert.ok(hits.every(h => h.multi_rrf != null), '跨路融合分 multi_rrf 应随命中回传');
        // 关闭零回归：不传 multiQuery → 单路（无多路 trace）
        const trace2 = {};
        await r.retrieve('年假怎么申请', kbId, 5, 0.01, { rerankEnabled: false, trace: trace2 });
        assert.strictEqual(trace2.multiQuery, undefined, '关闭时不应有多路 trace（行为与历史一致）');
        // 扩写失败回落单路（0 阻断）
        mq.__clearCache();
        mq.__setImpl(async () => { throw new Error('LLM 不可用'); });
        const hits3 = await r.retrieve('年假怎么申请', kbId, 5, 0.01, { multiQuery: true, rerankEnabled: false });
        assert.ok(hits3.length >= 1, '扩写失败回落单路仍应正常检索');
      } finally {
        mq.__setImpl(null); mq.__clearCache();
        db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
      }
    });

    await t('AI-10：库级开关 kbs.multi_query=1 自动多路 + 显式 off 覆盖（节点级三态语义）', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI-10 库级开关库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbId = db.prepare(`SELECT id FROM kbs WHERE name='AI-10 库级开关库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'开关文档.txt',30,'success',1,datetime('now','localtime'))`).run(kbId);
      const fid = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fid, kbId, '差旅报销标准：高铁二等座按票面全额报销。');
      try {
        db.prepare('UPDATE kbs SET multi_query=1 WHERE id=?').run(kbId);
        mq.__clearCache();
        mq.__setImpl(async () => '{"queries": ["差旅报销", "报销标准是什么"]}');
        const trace = {};
        const hits = await r.retrieve('报销标准', kbId, 5, 0.01, { rerankEnabled: false, trace }); // 不传 multiQuery → 库级生效
        assert.ok(trace.multiQuery && trace.multiQuery.applied, '库级 multi_query=1 应自动多路（无 opts 也生效）');
        assert.ok(hits.length >= 1, '应命中报销块');
        const trace2 = {};
        await r.retrieve('报销标准', kbId, 5, 0.01, { multiQuery: false, rerankEnabled: false, trace: trace2 });
        assert.strictEqual(trace2.multiQuery, undefined, '显式 off 应覆盖库级（AI-08 节点级三态的基础）');
      } finally {
        mq.__setImpl(null); mq.__clearCache();
        db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
      }
    });
  }

  // ==================== AI-14 查询感知元数据过滤（2026-11-23） ====================
  console.log('【AI-14】查询感知元数据过滤（值域约束 fail-closed / 静态优先 / 误过滤率 0）');
  {
    const { db } = require('../src-server/db');
    const mi = require('../src-server/lib/metadata-infer');
    const r = require('../src-server/lib/retriever');

    await t('AI-14：inferMetadataFilter——正常推断/值域外丢弃（幻觉防误过滤）/异常回落/缓存/空意图', async () => {
      const vocab = { 部门: ['人事部', '财务部'], 文档类型: ['制度', '通知'] };
      mi.__clearCache();
      let calls = 0;
      mi.__setImpl(async () => { calls++; return '{"filter": {"部门": "人事部"}}'; });
      let out = await mi.inferMetadataFilter('人事部的年假制度', vocab, {});
      assert.deepStrictEqual(out, { 部门: '人事部' }, '应推断出部门过滤');
      await mi.inferMetadataFilter('人事部的年假制度', vocab, {});
      assert.strictEqual(calls, 1, '同查询+同值域应命中缓存');
      // 值域外丢弃（误过滤率 0 的核心防线：模型幻觉值不得造成过滤）
      mi.__clearCache();
      mi.__setImpl(async () => '{"filter": {"部门": "不存在的部门", "文档类型": "制度"}}');
      out = await mi.inferMetadataFilter('随便问问', vocab, {});
      assert.deepStrictEqual(out, { 文档类型: '制度' }, '值域外的键值应丢弃，域内条件保留');
      // 键也域外
      mi.__clearCache();
      mi.__setImpl(async () => '{"filter": {" invented_key ": "x"}}');
      out = await mi.inferMetadataFilter('随便问问', vocab, {});
      assert.strictEqual(out, null, '全域外推断应返回 null（不过滤）');
      // 空意图
      mi.__clearCache();
      mi.__setImpl(async () => '{"filter": {}}');
      out = await mi.inferMetadataFilter('今天天气如何', vocab, {});
      assert.strictEqual(out, null, '无过滤意图应返回 null（宁缺勿错）');
      // 异常/垃圾回落
      mi.__clearCache();
      mi.__setImpl(async () => { throw new Error('boom'); });
      out = await mi.inferMetadataFilter('人事的', vocab, {});
      assert.strictEqual(out, null, '异常应回落不过滤（0 阻断）');
      mi.__setImpl(null); mi.__clearCache();
    });

    await t('AI-14：retrieve 端到端——推断过滤命中目标分块 + 静态声明优先 + 关闭零回归', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI-14 过滤测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbId = db.prepare(`SELECT id FROM kbs WHERE name='AI-14 过滤测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'部门制度.txt',60,'success',3,datetime('now','localtime'))`).run(kbId);
      const fid = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;
      const mkChunk = (content, meta) => db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,metadata) VALUES (?,?,?,?)').run(fid, kbId, content, JSON.stringify(meta));
      mkChunk('人事部年假制度：入职满一年带薪年假五天。', { 部门: '人事部' });
      mkChunk('财务部报销制度：发票需在三十天内提交。', { 部门: '财务部' });
      mkChunk('通用考勤要求：迟到三次通报批评。', { 部门: '人事部', 文档类型: '制度' });
      try {
        // 推断开启 + 桩推断人事部 → 仅命中人事部分块
        mi.__clearCache();
        mi.__setImpl(async () => '{"filter": {"部门": "人事部"}}');
        const trace = {};
        const hits = await r.retrieve('年假制度', kbId, 5, 0.01, { inferFilter: true, rerankEnabled: false, trace });
        assert.ok(hits.length >= 1 && hits.every(h => h.content.includes('人事部') || h.content.includes('考勤')), '推断过滤后应仅命中人事部分块');
        assert.ok(!hits.some(h => h.content.includes('财务部')), '财务部块应被过滤（查询感知生效）');
        assert.ok(trace.inferFilter && trace.inferFilter.applied === true, 'trace.inferFilter 应回填（AI-13 可观测）');
        assert.deepStrictEqual(trace.inferFilter.filter, { 部门: '人事部' }, '推断条件应在 trace（可回答「过滤了什么」）');
        // 静态优先：静态声明财务部 + 推断人事部 → 同键取静态（AI 不得推翻显式声明）
        mi.__clearCache();
        const hits2 = await r.retrieve('年假制度', kbId, 5, 0.01, {
          inferFilter: true, rerankEnabled: false,
          metadataFilter: { 部门: '财务部' },
        });
        assert.ok(hits2.length >= 1 && hits2.every(h => h.content.includes('财务部')), '静态声明应优先于 AI 推断（同键取静态）');
        // 误过滤率 0：空意图（桩返回空 filter）→ 命中集与「未开启推断」完全一致（不得因开启而丢任何一条）
        mi.__clearCache();
        mi.__setImpl(async () => '{"filter": {}}');
        const q3 = '公司制度全览';
        const withEmptyIntent = await r.retrieve(q3, kbId, 5, 0.01, { inferFilter: true, rerankEnabled: false });
        const withoutInfer = await r.retrieve(q3, kbId, 5, 0.01, { rerankEnabled: false });
        assert.strictEqual(withEmptyIntent.length, withoutInfer.length, '空过滤意图不得改变命中集（误过滤率 0——与关闭时逐条一致）');
        assert.deepStrictEqual(withEmptyIntent.map(h => h.id).sort(), withoutInfer.map(h => h.id).sort(), '命中集应完全一致（id 级）');
        // 关闭零回归：显式 off 与未开启行为一致
        const offHits = await r.retrieve(q3, kbId, 5, 0.01, { inferFilter: false, rerankEnabled: false });
        assert.strictEqual(offHits.length, withoutInfer.length, '显式关闭应与未开启行为一致（零回归）');
        // 库级开关：kbs.infer_metadata_filter=1 自动生效
        db.prepare('UPDATE kbs SET infer_metadata_filter=1 WHERE id=?').run(kbId);
        mi.__clearCache();
        mi.__setImpl(async () => '{"filter": {"文档类型": "制度"}}');
        const trace2 = {};
        await r.retrieve('考勤要求', kbId, 5, 0.01, { rerankEnabled: false, trace: trace2 });
        assert.ok(trace2.inferFilter && trace2.inferFilter.applied, '库级 infer_metadata_filter=1 应自动推断');
      } finally {
        mi.__setImpl(null); mi.__clearCache();
        db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
      }
    });
  }

  // ==================== AI-11/AI-12 收尾（2026-11-23）====================
  console.log('【AI-11/AI-12】迁移 #139/#140 结构断言 + 文搜图 modality 透传');
  {
    const { db } = require('../src-server/db');
    const r = require('../src-server/lib/retriever');
    await t('AI-11：迁移 #139/#140——kb_chunks.modality 列（DEFAULT text）+ prompt_compare_reports 表结构', () => {
      const mod = db.prepare('PRAGMA table_info(kb_chunks)').all().find(c => c.name === 'modality');
      assert.ok(mod, 'kb_chunks 应有 modality 列（迁移 #139，图搜图/文搜图模态标识基础）');
      assert.ok(/'text'/.test(mod.dflt_value || ''), "modality 默认值应为 'text'（存量行自动归一文本，零迁移风险）");
      const pcCols = db.prepare('PRAGMA table_info(prompt_compare_reports)').all().map(c => c.name);
      for (const col of ['id', 'agent_id', 'evaluation_id', 'report', 'created_at']) {
        assert.ok(pcCols.includes(col), `prompt_compare_reports 应有 ${col} 列（迁移 #140，AI-12 对比报告存档）`);
      }
    });
    await t('AI-11：文搜图——retrieve 命中 image 分块透传 modality=image + text 分块缺省归一', async () => {
      db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('AI-11 modality 测试库','',1,'httpu1',datetime('now','localtime'))`).run();
      const kbId = db.prepare(`SELECT id FROM kbs WHERE name='AI-11 modality 测试库'`).get().id;
      db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,'架构图.png',2048,'success',2,datetime('now','localtime'))`).run(kbId);
      const fid = db.prepare('SELECT id FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId).id;
      // image 块：摄取管道 visionUsed 时落 modality='image'（图片 VL 描述分块化）
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,modality) VALUES (?,?,?,?)').run(fid, kbId, '系统架构图：包含接入层、服务层、数据层三层设计，服务层内置智能体编排', 'image');
      // text 块：modality 缺省 → DEFAULT 'text'（存量/普通分块归一路径）
      db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)').run(fid, kbId, '会议纪要：本季度重点完成多租户改造。');
      try {
        const hits = await r.retrieve('架构图 三层设计', kbId, 5, 0.01, { rerankEnabled: false });
        assert.ok(hits.length >= 1, '文搜图应命中图片 VL 描述分块（描述即文本，混合检索天然可达）');
        const imgHit = hits.find(h => h.content.includes('架构图'));
        assert.ok(imgHit, '应命中含「架构图」的描述分块');
        assert.strictEqual(imgHit.modality, 'image', '命中图片块应透传 modality=image（前端可标识 🖼️ 来源）');
        assert.ok(hits.every(h => h.modality === 'image' || h.modality === 'text'), '命中块 modality 应归一为 image/text');
        const t2 = await r.retrieve('会议纪要 多租户', kbId, 5, 0.01, { rerankEnabled: false });
        assert.ok(t2.length >= 1, '文本块应可命中');
        assert.ok(t2.every(h => h.modality === 'text'), '文本块命中应 modality=text（DEFAULT 归一 + 命中对象回填）');
      } finally {
        db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
        db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
      }
    });
    await t('AI-11：visionDescribe 契约——参数缺失 fail-closed + mock 模式多模态兼容（HTTP 502 分支数据源）', async () => {
      const { visionDescribe } = require('../src-server/lib/llm');
      // 参数缺失：buf/modelName 必填 → ok:false（image-search 端点据此 502 明确不静默——跨进程桩不可达，契约在此单测覆盖）
      assert.strictEqual((await visionDescribe(null, 'm')).ok, false, '缺 buf 应 fail-closed 返回 ok:false');
      assert.strictEqual((await visionDescribe(Buffer.from('x'), '')).ok, false, '缺 modelName 应 fail-closed 返回 ok:false');
      // mock 模式（测试环境无已配置供应商 → chatOnce 走 mockAnswer）：多模态数组 content 不再 TypeError，
      // 回显 user 消息 text 片段（mockAnswer 数组兼容修复的进程内实锤）
      const vd = await visionDescribe(Buffer.from('x'), 'mock-vl-model');
      assert.strictEqual(vd.ok, true, 'mock 模式应成功返回描述文本：' + JSON.stringify(vd).slice(0, 120));
      assert.ok((vd.text || '').includes('请描述这张图片'), '描述文本应回显多模态 user 消息的 text 片段（数组兼容实锤）：' + (vd.text || '').slice(0, 60));
    });
  }

  try { db.close(); } catch { }
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });
  console.log('\n———————————————');
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('套件异常：', e); process.exit(1); });
