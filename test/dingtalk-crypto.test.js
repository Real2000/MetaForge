/**
 * 钉钉加解密纯逻辑单测（V1.3 #4 2026-10-30，测试先行——先于 lib/dingtalk-crypto.js 编写）
 *
 * 用法：node test/dingtalk-crypto.test.js（独立可执行，不进 npm test——Tech Lead 统一收编冒烟套件）
 * 覆盖（≥8 条）：签名正确性（固定四参→已知 SHA1 值，向量独立于被测代码用 node:crypto 预计算）/
 *   签名参数顺序敏感性 / 加解密 roundtrip（对象+中文、非对象原文 echostr 场景）/
 *   解密后结构校验（长度字段精确切分）/ corpid 尾部提取 / 非法 AES Key 长度 / 损坏 Base64 /
 *   解密后长度字段越界 / buildEncryptedCallback 组装完整性。
 * 测试向量自造（encryptMsg 生成密文 + node:crypto 手工构造坏结构密文），不依赖钉钉真实报文。
 */
const assert = require('assert');
const crypto = require('crypto');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch(e => { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); });
}

(async () => {
  const C = require('../src-server/lib/dingtalk-crypto');
  const { sha1Sign, decryptMsg, encryptMsg, buildEncryptedCallback } = C;

  // 固定测试向量：43 位 Base64（解码 32 字节，与钉钉控制台 AESKey 形态一致）
  const AES_KEY = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
  const TOKEN = 'token123';
  const CORPID = 'ding-corpid-test-001';

  console.log('【1】签名算法（sha1Sign）');
  await t('签名正确性：固定四参字典序排序后 SHA1（独立预计算期望值）', () => {
    // 期望值由 node:crypto 独立预计算：sha1('1700000000encryptXyznonceAbctoken123')
    assert.strictEqual(sha1Sign('token123', '1700000000', 'nonceAbc', 'encryptXyz'),
      'a4874524fa87f4069ec52a5bd0b66e8fd608777d');
  });
  await t('签名参数顺序敏感性：乱序拼接必不等（两种乱序对照）', () => {
    const right = sha1Sign('token123', '1700000000', 'nonceAbc', 'encryptXyz');
    // 乱序 1：原参数顺序直接 join（不排序）
    const wrong1 = crypto.createHash('sha1').update(['token123', '1700000000', 'nonceAbc', 'encryptXyz'].join('')).digest('hex');
    // 乱序 2：encrypt 提到最前
    const wrong2 = crypto.createHash('sha1').update(['encryptXyz', 'token123', 'nonceAbc', '1700000000'].join('')).digest('hex');
    assert.notStrictEqual(wrong1, right, '乱序拼接的 SHA1 必须与正确签名不同');
    assert.notStrictEqual(wrong2, right, '乱序拼接的 SHA1 必须与正确签名不同');
    // 换任一参数（哪怕单字符）签名也必须变
    assert.notStrictEqual(sha1Sign('token124', '1700000000', 'nonceAbc', 'encryptXyz'), right);
  });
  await t('签名参数缺失报错（不静默）', () => {
    assert.throws(() => sha1Sign('t', null, 'n', 'e'), /签名参数缺失|不能为空/);
    assert.throws(() => sha1Sign('t', 'ts', 'n'), /签名参数缺失|不能为空/);
  });

  console.log('【2】加解密 roundtrip（encryptMsg / decryptMsg）');
  await t('roundtrip：对象消息体（含中文）加密→解密逐字段还原', () => {
    const msg = { EventType: 'user_add_org', UserId: 'user001', NickName: '张三丰', DeptIdList: [1, 5], Phone: '13800001234' };
    const enc = encryptMsg(AES_KEY, CORPID, msg);
    const r = decryptMsg(AES_KEY, enc);
    assert.deepStrictEqual(r.message, msg, '消息体对象应逐字段还原（含中文昵称）');
    assert.strictEqual(r.corpid, CORPID);
  });
  await t('roundtrip：非对象原文（echostr 场景）解出字符串原文', () => {
    const echostr = 'ding-url-verify-random-str-99887766';
    const enc = encryptMsg(AES_KEY, CORPID, echostr);
    const r = decryptMsg(AES_KEY, enc);
    assert.strictEqual(r.message, echostr, '非 JSON 原文应原样返回字符串（URL 验证 echostr）');
    assert.strictEqual(r.corpid, CORPID);
  });
  await t('解密后结构校验：长度字段精确切分（消息体不与 corpid 混串）', () => {
    // 消息体里故意带 corpid 前缀相似内容，验证按长度字段切分而非字符串猜测
    const msg = JSON.stringify({ a: CORPID.slice(0, 5), b: '尾' + CORPID });
    const enc = encryptMsg(AES_KEY, CORPID, msg);
    const r = decryptMsg(AES_KEY, enc);
    assert.strictEqual(r.message.a, CORPID.slice(0, 5));
    assert.strictEqual(r.message.b, '尾' + CORPID);
    assert.strictEqual(r.corpid, CORPID, '尾部 corpid 应完整独立提取');
  });
  await t('corpid 尾部提取：不同 corpid 值互不串扰（含中文 corpid）', () => {
    for (const cid of ['', 'corp-A', '企业标识-中文测试']) {
      const r = decryptMsg(AES_KEY, encryptMsg(AES_KEY, cid, { k: 'v' }));
      assert.strictEqual(r.corpid, cid, `corpid=${JSON.stringify(cid)} 应精确还原`);
    }
  });

  console.log('【3】非法输入报错（不静默，中文 message）');
  await t('非法 AES Key 长度报错（16 字节 / 空串）', () => {
    const bad16 = crypto.randomBytes(16).toString('base64').replace(/=+$/, '');
    assert.throws(() => encryptMsg(bad16, CORPID, { a: 1 }), /32 字节|长度非法/);
    assert.throws(() => decryptMsg(bad16, encryptMsg(AES_KEY, CORPID, { a: 1 })), /32 字节|长度非法/);
    assert.throws(() => decryptMsg('', 'whatever'), /不能为空|长度非法/);
  });
  await t('损坏 Base64 报错（非法字符 AESKey / 非分组密文）', () => {
    assert.throws(() => decryptMsg('!!!非法字符!!!', 'xxx'), /Base64|长度非法/); // AESKey 损坏
    const enc = encryptMsg(AES_KEY, CORPID, { a: 1 });
    assert.throws(() => decryptMsg(AES_KEY, '!!!' + enc.slice(0, 20)), /Base64|长度非法|解密失败/); // 密文损坏
    assert.throws(() => decryptMsg(AES_KEY, ''), /不能为空|长度非法/); // 密文为空
  });
  await t('解密后长度字段越界报错（手工构造坏结构密文）', () => {
    // 手工构造：16B 随机串 + 声明长度远超实际（0x7FFFFFFF）+ 短消息体 + corpid，再 AES 加密
    const key = Buffer.from(AES_KEY, 'base64');
    const iv = key.subarray(0, 16);
    const badPlain = Buffer.concat([
      crypto.randomBytes(16),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0x7FFFFFFF); return b; })(),
      Buffer.from(JSON.stringify({ a: 1 }), 'utf8'),
      Buffer.from(CORPID, 'utf8'),
    ]);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const badEnc = Buffer.concat([cipher.update(badPlain), cipher.final()]).toString('base64');
    assert.throws(() => decryptMsg(AES_KEY, badEnc), /越界|结构非法/);
    // 第二种坏结构：明文不足 20 字节（解不出 4 字节长度头）
    const shortPlain = crypto.randomBytes(10);
    const c2 = crypto.createCipheriv('aes-256-cbc', key, iv);
    const shortEnc = Buffer.concat([c2.update(shortPlain), c2.final()]).toString('base64');
    assert.throws(() => decryptMsg(AES_KEY, shortEnc), /越界|结构非法/);
  });
  await t('AES Key 不匹配的密文解密报错（不静默返回垃圾）', () => {
    const otherKey = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
    const enc = encryptMsg(otherKey, CORPID, { a: 1 });
    assert.throws(() => decryptMsg(AES_KEY, enc), /解密失败|结构非法|越界/);
  });

  console.log('【4】回调报文组装（buildEncryptedCallback）');
  await t('组装完整性：四字段齐全 + 签名可独立验证 + 密文可解出原消息', () => {
    const msg = { EventType: 'dept_create', DeptId: 12, ParentId: 1, DeptName: '研发二部' };
    const packet = buildEncryptedCallback(AES_KEY, TOKEN, CORPID, msg, { timestamp: '1700000000', nonce: 'nonceAbc' });
    // ① 四字段
    for (const f of ['msg_signature', 'timestamp', 'nonce', 'encrypt']) {
      assert.ok(packet[f] !== undefined && packet[f] !== '', `报文缺字段 ${f}`);
    }
    assert.strictEqual(packet.timestamp, '1700000000');
    assert.strictEqual(packet.nonce, 'nonceAbc');
    // ② 签名可独立验证（回调服务按同算法重算比对）
    assert.strictEqual(sha1Sign(TOKEN, packet.timestamp, packet.nonce, packet.encrypt), packet.msg_signature);
    // ③ 密文可解回原消息与 corpid
    const r = decryptMsg(AES_KEY, packet.encrypt);
    assert.deepStrictEqual(r.message, msg);
    assert.strictEqual(r.corpid, CORPID);
  });
  await t('组装默认参数：未显式传 timestamp/nonce 时自动生成（可解可验）', () => {
    const packet = buildEncryptedCallback(AES_KEY, TOKEN, CORPID, { t: 1 });
    assert.strictEqual(sha1Sign(TOKEN, String(packet.timestamp), String(packet.nonce), packet.encrypt), packet.msg_signature);
    assert.strictEqual(decryptMsg(AES_KEY, packet.encrypt).message.t, 1);
  });

  console.log(`\n${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });
