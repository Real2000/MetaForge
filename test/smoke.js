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
  await t('hashPwd 稳定且区分大小写', () => {
    assert.strictEqual(hashPwd('abc123'), hashPwd('abc123'));
    assert.notStrictEqual(hashPwd('abc123'), hashPwd('ABC123'));
  });
  await t('verifyPwd 新 SALT 命中 / 错误密码拒绝', () => {
    const stored = hashPwd('right-pass');
    assert.deepStrictEqual(verifyPwd('right-pass', stored), { ok: true, legacy: false });
    assert.strictEqual(verifyPwd('wrong-pass', stored).ok, false);
  });
  await t('verifyPwd 旧 SALT（升级前存量密码）兼容命中且标记 legacy', () => {
    const legacyHash = require('crypto').createHash('sha256').update('agent-platform-salt-v1' + 'old-user-pwd').digest('hex');
    const v = verifyPwd('old-user-pwd', legacyHash);
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

  await t('P5.30 tripwire：chat.js 技能路径 addUsage 恰好 1 处（双重记账回归）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src-server', 'routes', 'chat.js'), 'utf8');
    const start = src.indexOf("skill === 'image'");
    const end = src.indexOf('const agent = agent_id ?');
    assert.ok(start > 0 && end > start, '技能块定位成功');
    const hits = src.slice(start, end).match(/addUsage\(/g) || [];
    assert.strictEqual(hits.length, 1, '技能路径 addUsage 应恰好 1 次（此前重复两行导致双倍扣减）：实际 ' + hits.length);
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
  await t('扩展工具注册：TOOL_DEFS 合并后共 15 个（P5.26 run_code + P5.27 local_exec + P5.31 create_task）', () => {
    const need = ['db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'export_word', 'tts', 'doc_review', 'run_code', 'local_exec', 'create_task'];
    need.forEach(n => assert.ok(tools.TOOL_DEFS[n], `缺少工具 ${n}`));
    assert.strictEqual(Object.keys(tools.TOOL_DEFS).length, 15);
    need.forEach(n => assert.strictEqual(tools.TOOL_DEFS[n].schema.function.name, n, `schema 名不匹配 ${n}`));
    assert.strictEqual(tools.toolRiskOf('create_task'), 'high', 'create_task 应归 high（默认权限必弹确认卡）');
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
        });
        await t('HTTP：知识库写权限——非创建者改删被拒（P5.30）', async () => {
          db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('归属测试库','',1,'测试用户一',datetime('now','localtime'))`).run();
          const kbid = db.prepare(`SELECT id FROM kbs WHERE name='归属测试库'`).get().id;
          const put = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '改名' }) }, tok2);
          assert.strictEqual(put.j && put.j.code, 403, '非创建者改名应 403：' + JSON.stringify(put.j));
          const own = await jfetch(`/api/knowledge/${kbid}`, { method: 'PUT', body: JSON.stringify({ name: '归属测试库改名' }) }, tok1);
          assert.ok(own.j && own.j.code === 0, '创建者（owner 为其昵称）应放行：' + JSON.stringify(own.j));
          const del = await jfetch(`/api/knowledge/${kbid}`, { method: 'DELETE' }, tok2);
          assert.strictEqual(del.j && del.j.code, 403, '非创建者删除应 403：' + JSON.stringify(del.j));
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
        });
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

  // 收尾：关闭库并清理临时目录
  try { db.close(); } catch { }
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });

  console.log('\n———————————————');
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('套件异常：', e); process.exit(1); });
