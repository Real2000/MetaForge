/** 版本分级与 License 授权控制单测（V2.2 #8 2026-10-31，测试先行——先于路由接线编写）
 *  用法：node test/edition.test.js（独立可执行，不进 npm test——Tech Lead 统一收编冒烟套件）
 *  覆盖（10 条）：无文件降级 / 合法签发验签通过 / 篡改 customer 验签失败降级 / 过期降级（当天仍有效）/
 *    hasFeature 三版本矩阵 / requireFeature 403+放行两态 / 到期提醒写入 / 同日去重 /
 *    损坏 JSON 降级 / canonical 字母序独立向量 + 公钥覆盖口。
 *  测试密钥对本进程内现生成，经环境变量 LICENSE_PUBKEY_HEX 覆盖内置公钥（不走模块内置测试钥——
 *  与生产密钥轮换同口）；AGENT_DATA_DIR 指向独立临时目录（不污染生产库），结束自动清理。
 */
process.env.AGENT_DATA_DIR = require('path').join(__dirname, '..', '.temp', 'edition-test-' + Date.now());

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch(e => { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); });
}

(async () => {
  // 测试密钥对 + 覆盖公钥（LICENSE_PUBKEY_HEX 是测试与生产轮换共用的口）
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const PRIV = privateKey;
  const PUB_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  process.env.LICENSE_PUBKEY_HEX = PUB_HEX;

  const E = require('../src-server/lib/edition');
  const DATA_DIR = process.env.AGENT_DATA_DIR;
  const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

  function localDateStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function dateAfter(days) { const d = new Date(); d.setDate(d.getDate() + days); return localDateStr(d); }

  /** 签发测试 License：canonical 手工按字母序键构造（不调被测 canonicalOf，防两端同源缺陷互相掩盖） */
  function signLicense(fields) {
    const canonical = JSON.stringify({
      customer: fields.customer, edition: fields.edition, expires_at: fields.expires_at,
      issued_at: fields.issued_at, license_key: fields.license_key,
    });
    return { ...fields, signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), PRIV).toString('hex') };
  }
  /** 写入 license.json 并热加载（模拟运维放票后刷新） */
  function writeLicense(lic) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, lic === null ? 'not a json' : JSON.stringify(lic, null, 2));
    return E.refreshLicense();
  }

  console.log('【1】降级链路（不锁死不裸奔）');
  await t('① 无 License 文件 → community 降级不抛错 + hasFeature 矩阵', () => {
    const cur = E.refreshLicense();
    assert.strictEqual(cur.edition, 'community', '缺失 License 应降级 community');
    assert.strictEqual(cur.licensed, false);
    assert.strictEqual(cur.reason, 'missing');
    assert.strictEqual(cur.customer, null);
    assert.strictEqual(cur.license_key, null);
    assert.strictEqual(E.hasFeature('agents'), true, 'community 基础特性照常可用（不裸奔）');
    assert.strictEqual(E.hasFeature('dingtalk'), false, 'community 无高级特性');
    assert.strictEqual(E.hasFeature('tenant'), false, 'community 无企业特性');
  });
  await t('② 合法签发 License 验签通过：edition/customer/剩余天数/license_key 前缀均正确', () => {
    writeLicense(signLicense({ customer: '测试公司', edition: 'professional', expires_at: dateAfter(365), issued_at: localDateStr(), license_key: 'ab'.repeat(16) }));
    const cur = E.currentEdition();
    assert.strictEqual(cur.edition, 'professional');
    assert.strictEqual(cur.licensed, true);
    assert.strictEqual(cur.reason, 'ok');
    assert.strictEqual(cur.customer, '测试公司');
    assert.strictEqual(cur.days_left, 365, '签发 365 天当天起算应剩整 365 天');
    assert.strictEqual(cur.expires_at, dateAfter(365));
    assert.strictEqual(cur.license_key, 'abababab…', 'license_key 仅展示前 8 位前缀（防完整 key 泄露）');
    assert.strictEqual(E.hasFeature('dingtalk'), true, '专业版含钉钉特性');
    assert.strictEqual(E.hasFeature('tenant'), false, '专业版不含租户特性');
  });
  await t('③ 篡改 customer 字段验签失败 → community 降级（reason=badsig）', () => {
    const lic = signLicense({ customer: '测试公司', edition: 'enterprise', expires_at: dateAfter(30), issued_at: localDateStr(), license_key: 'cd'.repeat(16) });
    lic.customer = '别的公司（改票）'; // 签发后篡改客户名
    const cur = writeLicense(lic);
    assert.strictEqual(cur.edition, 'community');
    assert.strictEqual(cur.reason, 'badsig');
    assert.strictEqual(cur.licensed, false);
    assert.strictEqual(cur.customer, null, '篡改票的客户名不得外泄到版本快照');
  });
  await t('④ 过期 License（expires_at 在昨天）→ community；到期日当天仍有效（< 今天才算过期）', () => {
    const expired = writeLicense(signLicense({ customer: '过期客户', edition: 'professional', expires_at: dateAfter(-1), issued_at: localDateStr(), license_key: 'ee'.repeat(16) }));
    assert.strictEqual(expired.edition, 'community');
    assert.strictEqual(expired.reason, 'expired');
    const lastDay = writeLicense(signLicense({ customer: '末日电晕', edition: 'professional', expires_at: localDateStr(), issued_at: localDateStr(), license_key: 'ff'.repeat(16) }));
    assert.strictEqual(lastDay.licensed, true, '到期日当天应仍有效');
    assert.strictEqual(lastDay.days_left, 0);
  });
  await t('⑤ 损坏 JSON（非法文本）→ community 降级不抛错（reason=badjson）', () => {
    const cur = writeLicense(null); // 写入 'not a json'
    assert.strictEqual(cur.edition, 'community');
    assert.strictEqual(cur.reason, 'badjson');
    assert.strictEqual(E.hasFeature('agents'), true, '降级后基础功能不受影响');
  });

  console.log('【2】版本决策表与中间件');
  await t('⑥ hasFeature 矩阵：community 无 dingtalk / professional 有 dingtalk 无 tenant / enterprise 全有', () => {
    writeLicense(signLicense({ customer: '矩阵客户-社', edition: 'community', expires_at: dateAfter(10), issued_at: localDateStr(), license_key: '01'.repeat(16) }));
    assert.strictEqual(E.hasFeature('dingtalk'), false);
    assert.strictEqual(E.hasFeature('kb'), true);
    writeLicense(signLicense({ customer: '矩阵客户-专', edition: 'professional', expires_at: dateAfter(10), issued_at: localDateStr(), license_key: '02'.repeat(16) }));
    assert.strictEqual(E.hasFeature('dingtalk'), true, 'professional 应含 dingtalk');
    assert.strictEqual(E.hasFeature('ldap'), true, 'professional 应含 ldap');
    assert.strictEqual(E.hasFeature('tenant'), false, 'professional 不应含 tenant');
    writeLicense(signLicense({ customer: '矩阵客户-企', edition: 'enterprise', expires_at: dateAfter(10), issued_at: localDateStr(), license_key: '03'.repeat(16) }));
    for (const f of ['agents', 'kb', 'workflow', 'mcp', 'openapi', 'dingtalk', 'ldap', 'unlimited', 'tenant', 'audit_flow', 'priority_support']) {
      assert.strictEqual(E.hasFeature(f), true, `enterprise 应含全部特性：${f}`);
    }
  });
  await t('⑦ requireFeature 中间件：无权特性 403 + upgrade_hint / 有权特性 next() 放行', () => {
    // 当前为 enterprise（上一用例）——换回 professional 测中间档
    writeLicense(signLicense({ customer: '闸门客户', edition: 'professional', expires_at: dateAfter(20), issued_at: localDateStr(), license_key: '04'.repeat(16) }));
    let blocked = false;
    const res = { body: null, json(j) { this.body = j; return this; } };
    E.requireFeature('tenant')(null, res, () => { blocked = true; }); // professional 无 tenant
    assert.strictEqual(blocked, false, '无权特性不得进入业务 handler');
    assert.strictEqual(res.body.code, 403);
    assert.strictEqual(res.body.msg, '该功能需要企业版授权（当前：专业版）', '升级引导应指向该特性所属最低版本');
    assert.deepStrictEqual(res.body.data, { upgrade_hint: true, feature: 'tenant', edition: 'professional' });
    let passedGate = false;
    E.requireFeature('dingtalk')({}, { json() { throw new Error('有权特性不应走 json 分支'); } }, () => { passedGate = true; });
    assert.strictEqual(passedGate, true, '有权特性应放行 next()');
  });

  console.log('【3】到期提醒（notifications）');
  await t('⑧ 快到期（29 天后）→ checkExpiryNotice 向 admin 写 notifications', () => {
    writeLicense(signLicense({ customer: '快到期客户', edition: 'enterprise', expires_at: dateAfter(29), issued_at: localDateStr(), license_key: '05'.repeat(16) }));
    const wrote = E.checkExpiryNotice();
    assert.strictEqual(wrote, true, '30 天窗口内首次应写入');
    const { db } = require('../src-server/db');
    const rows = db.prepare(`SELECT title, content FROM notifications WHERE username='admin' AND title LIKE 'License 将于%' ORDER BY id DESC LIMIT 1`).all();
    assert.ok(rows.length >= 1, '应有到期提醒通知');
    assert.ok(rows[0].title.includes('29 天'), `标题应含剩余天数：${rows[0].title}`);
    assert.ok(rows[0].content.includes(dateAfter(29)), '内容应含到期日期');
  });
  await t('⑨ 同日重复调用不重复写（当日同标题去重）', () => {
    const wrote = E.checkExpiryNotice();
    assert.strictEqual(wrote, false, '同日第二次应跳过');
    const { db } = require('../src-server/db');
    const c = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE username='admin' AND title LIKE 'License 将于%'`).get().c;
    assert.strictEqual(c, 1, `当日去重后应仅 1 条（实际 ${c}）`);
  });

  console.log('【4】辅助口');
  await t('⑩ getPublicKeyHex 返回环境变量覆盖值；canonicalOf 按字母序（独立向量）', () => {
    assert.strictEqual(E.getPublicKeyHex(), PUB_HEX, 'LICENSE_PUBKEY_HEX 应覆盖内置公钥');
    const lic = { customer: 'c', edition: 'e', expires_at: 'x', issued_at: 'y', license_key: 'z', signature: 's', extra: 1 };
    // 独立预计算期望串：五字段恰好按 customer<edition<expires_at<issued_at<license_key 字母序，多余字段（signature/extra）不参与
    assert.strictEqual(E.canonicalOf(lic), JSON.stringify({ customer: 'c', edition: 'e', expires_at: 'x', issued_at: 'y', license_key: 'z' }));
    assert.ok(E.canonicalOf(lic).indexOf('"signature"') === -1, 'signature 本身不得参与签名内容');
  });

  // 清理临时库（与 smoke.js 同款临时目录约定）
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
