/**
 * 钉钉回调加解密与验签（V1.3 #4 2026-10-30，mock 阶段纯逻辑，本地零外网）
 *
 * 钉钉开放平台标准算法（服务端事件回调 + URL 验证）：
 *   签名   msg_signature = sha1( [token, timestamp, nonce, encrypt].字典序排序().join('') )
 *   加密   encrypt = base64( AES-256-CBC( key, iv=key[0..16) )( 16B 随机串 + 4B 消息长度(大端 uint32) + 消息体 + corpid ) )
 *   AESKey 控制台为 43 位 Base64 串（无 padding，解码恰 32 字节 = AES-256 key）
 *
 * 凭证来源：secrets 表（lib/secrets.js 约定键名 DINGTALK_AES_KEY / DINGTALK_TOKEN），
 *          由调用方（routes/dingtalk.js）读取后传入本模块；尾部 corpid 与配置的比对也由调用方做。
 * 纯函数零第三方依赖（仅 Node 内置 crypto）；所有非法输入抛带中文 message 的 Error，绝不静默——
 * 解密/验签链路上任何静默吞错都可能被伪造报文探测利用。
 */
const crypto = require('crypto');

/** 解析钉钉 AESKey：43 位 Base64（可带/不带 padding）→ 32 字节 key；非法即抛错 */
function decodeAesKey(aesKeyB64) {
  if (typeof aesKeyB64 !== 'string' || !aesKeyB64.trim()) {
    throw new Error('钉钉 AES Key 不能为空（secrets 表 DINGTALK_AES_KEY 未配置或为空）');
  }
  const raw = aesKeyB64.trim();
  // 显式字符集校验：Node 的 base64 解码是宽松的（非法字符直接被忽略、'!!!' 解出 0 字节），
  // 仅靠长度校验报错信息会误导排查方向，这里先拦住明显损坏的输入
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('钉钉 AES Key 不是合法的 Base64 字符串（请从钉钉开放平台控制台原样复制 43 位 AESKey）');
  }
  // 钉钉控制台 AESKey 为 43 位无 padding，按 Base64 规范补 '='（43 % 4 == 3 → 补 1 个）
  let s = raw;
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  const key = Buffer.from(s, 'base64');
  if (key.length !== 32) {
    throw new Error(`钉钉 AES Key 长度非法：Base64 解码后须 32 字节（AES-256），实际 ${key.length} 字节`);
  }
  return key;
}

/**
 * 回调验签：四参数字典序排序后拼接取 SHA1 hex
 * 与钉钉回调 query/body 携带的 msg_signature 比对（恒时比较由调用方用 crypto.timingSafeEqual 或直接比对）
 */
function sha1Sign(token, timestamp, nonce, encrypt) {
  if ([token, timestamp, nonce, encrypt].some(v => v == null || v === '')) {
    throw new Error('钉钉签名参数缺失：token/timestamp/nonce/encrypt 均不能为空');
  }
  const raw = [String(token), String(timestamp), String(nonce), String(encrypt)].sort().join('');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * 解密钉钉加密报文（回调 encrypt / URL 验证 echostr）
 * 明文结构：16B 随机串 + 4B 消息长度（大端 uint32）+ 消息体 + corpid
 * 返回 { message: JSON 对象或原文（echostr 非 JSON 场景）, corpid: 尾部企业标识 }
 */
function decryptMsg(aesKeyB64, encryptB64) {
  const key = decodeAesKey(aesKeyB64);
  if (typeof encryptB64 !== 'string' || !encryptB64.trim()) {
    throw new Error('钉钉密文不能为空（encrypt/echostr 缺失）');
  }
  const data = Buffer.from(encryptB64.trim(), 'base64');
  // AES-CBC + PKCS7 分组：密文长度须为 16 的整数倍（损坏 Base64 / 篡改密文通常在此暴露）
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error(`钉钉密文长度非法：须为 16 字节分组整数倍，实际 ${data.length} 字节（Base64 可能已损坏）`);
  }
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (e) {
    throw new Error('钉钉密文解密失败（AES Key 不匹配或密文损坏）：' + e.message);
  }
  if (plain.length < 20) {
    throw new Error(`解密后明文结构非法：须至少 20 字节（16B 随机串+4B 长度头），实际 ${plain.length} 字节`);
  }
  const msgLen = plain.readUInt32BE(16);
  if (16 + 4 + msgLen > plain.length) {
    throw new Error(`解密后消息长度字段越界：声明 ${msgLen} 字节，实际剩余仅 ${plain.length - 20} 字节`);
  }
  const message = plain.subarray(20, 20 + msgLen).toString('utf8');
  const corpid = plain.subarray(20 + msgLen).toString('utf8');
  let parsed = message;
  try { parsed = JSON.parse(message); } catch { /* 非 JSON 原文（URL 验证 echostr 场景），原样返回 */ }
  return { message: parsed, corpid };
}

/**
 * encryptMsg 的反向函数（测试向量构造用：加密→解密 roundtrip）
 * message 支持对象（JSON 序列化）或字符串（echostr 场景）原样加密
 */
function encryptMsg(aesKeyB64, corpid, message) {
  const key = decodeAesKey(aesKeyB64);
  const msgStr = typeof message === 'string' ? message : JSON.stringify(message ?? null);
  if (msgStr == null) throw new Error('钉钉加密消息体不能为空');
  const msgBuf = Buffer.from(msgStr, 'utf8');
  if (msgBuf.length > 0xFFFFFFFF) throw new Error('钉钉加密消息体超过 4 字节长度头上限（理论不可达）');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length);
  const plain = Buffer.concat([
    crypto.randomBytes(16),                       // 16B 随机串（防确定性密文）
    lenBuf,                                       // 4B 消息长度（大端）
    msgBuf,                                       // 消息体
    Buffer.from(String(corpid ?? ''), 'utf8'),    // 尾部 corpid
  ]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/**
 * 组装完整加密回调报文（测试 fixtures 生成器：签名+加密一步到位）
 * 返回 { msg_signature, timestamp, nonce, encrypt }——与钉钉 POST 回调 body 同构；
 * opts 可显式传 timestamp/nonce（固定向量测试用），默认当前秒级时间戳 + 随机 hex
 */
function buildEncryptedCallback(aesKeyB64, token, corpid, message, opts = {}) {
  const timestamp = opts.timestamp != null ? String(opts.timestamp) : String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce != null ? String(opts.nonce) : crypto.randomBytes(8).toString('hex');
  const encrypt = encryptMsg(aesKeyB64, corpid, message);
  return { msg_signature: sha1Sign(token, timestamp, nonce, encrypt), timestamp, nonce, encrypt };
}

/** 常量比较签名（防时序侧信道；长度不等直接 false） */
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { sha1Sign, decryptMsg, encryptMsg, buildEncryptedCallback, decodeAesKey, safeEqualHex };
