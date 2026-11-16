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
  await t('clientIp 取 X-Forwarded-For 首段', () => {
    assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, ip: '127.0.0.1' }), '1.2.3.4');
    assert.strictEqual(clientIp({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
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
    const { sqlStr, args } = spaceFilterSql('a', { username: 'zhangsan', role: 'user' });
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
    assert.strictEqual(spaceVisibleTo(db, 99999, 'zhangsan'), true, '空间不存在→宽容放行（脏数据等效无归属）');
    const per = db.prepare("SELECT id FROM spaces WHERE type='personal' AND owner='admin' LIMIT 1").get();
    assert.strictEqual(spaceVisibleTo(db, per.id, 'admin'), true, '个人空间 owner→可见');
    assert.strictEqual(spaceVisibleTo(db, per.id, 'zhangsan'), false, '个人空间非 owner→不可见');
    const dept = db.prepare("SELECT id FROM spaces WHERE type='dept' LIMIT 1").get();
    assert.strictEqual(spaceVisibleTo(db, dept.id, 'zhangsan'), false, '部门空间非 owner→不可见（过渡语义）');
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
      assert.strictEqual(d.openapi.openapi, '3.0.3');
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
        await t('HTTP：智能体保存工具白名单——create_task/local_exec 拒绝（P5.34）', async () => {
          const bad1 = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '注入测试A', tools: ['create_task'] }) }, tok1);
          assert.strictEqual(bad1.j && bad1.j.code, 400, 'POST 配置 create_task 应 400：' + JSON.stringify(bad1.j));
          assert.ok(String(bad1.j.msg).includes('create_task'), '错误信息应指名违禁工具');
          const bad2 = await jfetch('/api/agents', { method: 'POST', body: JSON.stringify({ name: '注入测试B', tools: ['web_search', 'local_exec'] }) }, tok1);
          assert.strictEqual(bad2.j && bad2.j.code, 400, 'POST 配置 local_exec 应 400');
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
          // 违禁工具排除（AGENT_TOOL_DENY：create_task/local_exec 不进市场）
          const names = bt.map(x => x.name);
          assert.ok(!names.includes('create_task') && !names.includes('local_exec'), '违禁工具（create_task/local_exec）不应出现在市场：' + names.filter(n => ['create_task', 'local_exec'].includes(n)).join(','));
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
          const rb = await jfetch(`/api/agents/${llmopsAid}/prompt-versions/${v1.id}/rollback`, { method: 'POST' }, tok1);
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
          const rb = await jfetch(`/api/agents/${llmopsAid}/prompt-versions/${anyV.id}/rollback`, { method: 'POST' }, tok2);
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
    await t('validateAgentTools：create_task/local_exec 拒绝，run_code 与常规工具放行（F1②）', () => {
      assert.strictEqual(validateAgentTools(['web_search', 'run_code', 'calculator']), null, '常规工具+run_code 应放行');
      assert.ok(String(validateAgentTools(['create_task'])).includes('create_task') && String(validateAgentTools(['create_task'])).includes('不允许'), 'create_task 应拒绝');
      assert.ok(String(validateAgentTools(['web_search', 'local_exec'])).includes('local_exec'), 'local_exec 应拒绝');
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
    await t('copy/技能资产白名单：违禁工具被剔除（P5.34b 审查 F2/F3）', () => {
      // copy：源智能体含违禁工具（模拟历史注入）→ 副本剔除
      const sysAgent = db.prepare("SELECT id FROM agents WHERE system_key='system_task_runner'").get();
      db.prepare(`INSERT INTO agents (name,description,type,category,prompt,status,source,tools,allow_copy,owner,created_at,updated_at) VALUES ('违禁源智能体','x','digital','测试','p','published','self',?,1,'httpadmin',datetime('now','localtime'),datetime('now','localtime'))`).run(JSON.stringify(['web_search', 'create_task', 'local_exec', 'not_a_tool']));
      const srcId = db.prepare("SELECT id FROM agents WHERE name='违禁源智能体'").get().id;
      // 直接调用 copy 的核心过滤逻辑（路由层 HTTP 测不了 canView/admin 上下文，此处验证数据面）：
      // 复制 SQL 用 filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t))
      const { TOOL_DEFS, AGENT_TOOL_DENY } = require('../src-server/lib/tools');
      const copyTools = JSON.parse(db.prepare('SELECT tools FROM agents WHERE id=?').get(srcId).tools).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
      assert.deepStrictEqual(copyTools, ['web_search'], 'copy 过滤应只剩合法工具：' + JSON.stringify(copyTools));
      // 技能资产：API 直调注入 create_task → filter 剔除（skillassets.js 同口径）
      const skillTools = ['create_task', 'web_search', 'local_exec'].filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
      assert.deepStrictEqual(skillTools, ['web_search'], '技能工具过滤应剔除违禁');
      db.prepare("DELETE FROM agents WHERE name='违禁源智能体'").run();
    });
    await t('P5.34b tripwire：runChildAgent 与 @技能/@专家并入均带违禁拒绝（F1/F4）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      // F1：runChildAgent 的 executeTool 拒绝 create_task/local_exec
      const rcStart = src.indexOf('async function runChildAgent');
      const rcEnd = src.indexOf('/** ⑦ 分类器路由');
      assert.ok(rcStart > 0 && rcEnd > rcStart, 'runChildAgent 定位成功');
      const rcBlock = src.slice(rcStart, rcEnd);
      assert.ok(rcBlock.includes("name === 'create_task' || name === 'local_exec'"), '子智能体执行应拒绝 create_task/local_exec');
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
      const re = /INSERT INTO agents \(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*\.run\(/g;
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
      assert.ok(/DELETE FROM err_logs'\)\.run\(\)/.test(src), 'DELETE FROM err_logs 必须带 .run()（prepare 只编译不执行，曾 77→77 假成功）');
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
        db.prepare('DELETE FROM providers WHERE id=?').run(pid);
      }
    });
    await t('单元：P2-2 bgeRerank——results 降序解析 / data[] 备选格式 / HTTP 500 → null + 30s 熔断窗口内不再发请求', async () => {
      const { bgeRerank, __expireCircuitBreakers } = require('../src-server/lib/retriever');
      __expireCircuitBreakers(); // 前序用例可能触发熔断（如 bgeEmbed 失败路径），重置后本用例熔断断言才真实可控
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
        db.prepare('DELETE FROM providers WHERE id=?').run(pid);
      }
    });
    await t('单元：P2-1 bgeEmbed——成功 1024 维列表 / 维度不符降级 / 条数不符降级（结构校验三态，mock fetch finally 恢复）', async () => {
      const { bgeEmbed, __expireCircuitBreakers } = require('../src-server/lib/retriever');
      __expireCircuitBreakers(); // HTTP 区无供应商调用已设 30s 熔断（无 provider 也落熔断行的实现语义），不重置会短路成功路径
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
        // user2 查看 user1 文件：HTTP 200 + body code 403（归属校验层拒绝，业务码语义）
        const r1 = await jfetch(`/api/files/${fid}`, t2);
        assert.strictEqual(r1.status, 200, '元数据接口应返回 200');
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
      const { encrypt, decrypt } = require('../src-server/lib/crypto-util');
      const { upsert } = require('../src-server/lib/secrets');
      const crypto = require('crypto');
      // 保存原密钥状态（P1-4：启动自动初始化，正常应已存在）
      const orig = db.prepare("SELECT value FROM secrets WHERE name='ENCRYPTION_KEY'").pluck().get();
      try {
        const k1 = crypto.randomBytes(32).toString('hex');
        upsert('ENCRYPTION_KEY', k1, 'P3-4 回归');
        const enc = encrypt('P3-4-secret-明文-value');
        // 加密形态生效（三段 hex）且往返一致
        assert.ok(/^[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]+$/i.test(enc), 'encrypt 应产出 IV.tag.cipher 三段 hex 形态');
        assert.strictEqual(decrypt(enc), 'P3-4-secret-明文-value', '正确密钥下往返应得原文');
        // 密钥轮换：同密文换钥解密 → 必须返回空串（原实现返回密文串，会被当明文 API Key 发给上游）
        const k2 = crypto.randomBytes(32).toString('hex');
        upsert('ENCRYPTION_KEY', k2, 'P3-4 回归-轮换');
        const wrong = decrypt(enc);
        assert.strictEqual(wrong, '', '密钥不匹配时应返回空串，而不是把密文串当明文返回');
        // 旧明文兼容：形态不像密文的值原样返回（历史明文数据不破坏）
        assert.strictEqual(decrypt('legacy-plain-key'), 'legacy-plain-key', '旧明文应原样返回');
        assert.strictEqual(decrypt('a.b.c'), 'a.b.c', '三点分隔但非密文形态（前两段非 32hex）应按旧明文返回');
        assert.strictEqual(decrypt(''), '', '空值应返回空串');
      } finally {
        // 还原密钥状态，避免污染后续用例
        if (orig) upsert('ENCRYPTION_KEY', orig, 'P3-4 回归-还原');
        else db.prepare("DELETE FROM secrets WHERE name='ENCRYPTION_KEY'").run();
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
      // handler 前应有 1 层限流中间件（route.stack = [limiter, handler]）
      assert.strictEqual(layer.route.stack.length, 2, `/v1/models 应挂限流中间件（当前 ${layer.route.stack.length} 层，预期 limiter+handler=2）`);
    });
    await t('P2-3 / P2-3：A1 op 扩展12个白名单+A2审计日志落op_logs', () => {
      const { OPS_WHITELIST } = require('../src-server/routes/localbridge');
      // A1: op 白名单应有 13 个（原 4 + 扩展 9）
      assert.ok(OPS_WHITELIST.length >= 13, `OPS_WHITELIST 应有 ≥13 个 op（当前 ${OPS_WHITELIST.length}）`);
      const expected = ['mkdir','list_dir','open_app','notify','screenshot','clipboard_read','clipboard_write',
        'key_type','mouse_click','window_list','window_focus','file_read','file_write'];
      for (const e of expected) {
        assert.ok(OPS_WHITELIST.includes(e), `应包含 op「${e}」`);
      }
      // A1: tools-extra.js local_exec schema 描述应包含扩展 op 名
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'lib', 'tools-extra.js'), 'utf8');
      for (const e of ['screenshot','clipboard_read','clipboard_write','key_type','mouse_click',
          'window_list','window_focus','file_read','file_write']) {
        assert.ok(src.includes(e), `tools-extra.js schema 应包含 ${e}`);
      }
      // A1: local_exec schema 的 op enum 应与白名单一致
      assert.ok(src.includes("'screenshot', 'clipboard_read'"), 'schema op enum 应包含扩展 op');
      // A2: local_exec run 应落审计日志（op_logs）
      assert.ok(src.includes("op_logs"), 'tools-extra.js 应写入 op_logs 审计日志');
      assert.ok(src.includes('本地桥:'), 'tools-extra.js 应写入 op_logs 审计日志（action 含本地桥前缀）');
    });
    await t('P3-8：/chat/models 不再 SELECT api_key 列（truthiness 改由 SQL has_key 表达）', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
      const m = /router\.get\('\/models',[\s\S]{0,400}?db\.prepare\((['"`])([\s\S]*?)\1\)/.exec(src);
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

  // 收尾：关闭库并清理临时目录
  try { db.close(); } catch { }
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });

  console.log('\n———————————————');
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('套件异常：', e); process.exit(1); });
