/**
 * 卡片回调验签（U0-5 P3 / R6）
 *
 * 目标：防伪造卡片回调直接触发审批决议。按渠道配置「可配置验签」，不臆造厂商算法：
 *   ① 通用 HMAC：渠道 config.callbackSecret 存在 → HMAC-SHA256(callbackSecret, rawBody)，
 *      与请求头 x-callback-signature（或 query.signature / body.signature）比对。
 *   ② 钉钉 / 企微：渠道 config.token 存在且请求带 msg_signature → 复用钉钉/企微官方
 *      sha1 方案 sha1( [token,timestamp,nonce,encrypt].字典序排序().join('') )（见 dingtalk-crypto.sha1Sign）。
 *   ③ 飞书：渠道 config.verificationToken 存在 → 与 body.token / body.header.token 比对（飞书事件/卡片回调令牌）。
 *   ④ 未配置任何验签材料 → 放行但标记 unverified（mock / 未接入期不中断链路，审计标注；
 *      真实凭证到位后在渠道 config 补 callbackSecret/token/verificationToken 即自动强制校验）。
 *
 * 语义：返回 { ok:true } | { ok:true, unverified:true } | { ok:false, reason }。
 * 恒时比较复用 dingtalk-crypto.safeEqualHex，防时序侧信道。
 */
const crypto = require('crypto');
const { sha1Sign, safeEqualHex } = require('./dingtalk-crypto');

/** 从多渠道位置取首个子段（query / body / headers） */
function pick(names, query, body, headers) {
  for (const n of names) {
    const v = (query && query[n] != null && query[n] !== '') ? query[n]
      : (body && body[n] != null && body[n] !== '') ? body[n]
        : (headers && headers[n] != null && headers[n] !== '') ? headers[n] : null;
    if (v != null) return String(v);
  }
  return '';
}

/**
 * @param {{type:string, config:object}} ch 渠道（type + 解密配置）
 * @param {object} headers 请求头
 * @param {object|string} body 请求体（对象或原始字符串）
 * @param {object} query 查询参数
 */
function verifyCardCallback(ch, headers, body, query) {
  const type = String(ch?.type || '');
  const cfg = (ch && ch.config) || {};
  const h = headers || {};
  const q = query || {};
  const b = (body && typeof body === 'object') ? body : {};

  // ① 通用 HMAC（优先级最高，配置即强制）
  if (cfg.callbackSecret) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
    const sig = pick(['x-callback-signature', 'signature'], q, b, h);
    const exp = crypto.createHmac('sha256', String(cfg.callbackSecret)).update(raw).digest('hex');
    if (!sig || !safeEqualHex(sig, exp)) return { ok: false, reason: '回调签名校验失败' };
    return { ok: true };
  }

  // ② 钉钉 / 企微 sha1 方案
  if ((type === 'dingtalk' || type === 'wecom') && cfg.token) {
    const msgSig = pick(['msg_signature', 'msgSignature'], q, b, h);
    if (!msgSig) return { ok: false, reason: '缺少 msg_signature' };
    const ts = pick(['timestamp'], q, b, h);
    const nonce = pick(['nonce'], q, b, h);
    const encrypt = pick(['encrypt'], q, b, h);
    let exp;
    try { exp = sha1Sign(cfg.token, ts, nonce, encrypt); } catch (e) { return { ok: false, reason: e.message }; }
    if (!safeEqualHex(msgSig, exp)) return { ok: false, reason: '回调签名校验失败' };
    return { ok: true };
  }

  // ③ 飞书 verificationToken
  if (type === 'feishu' && cfg.verificationToken) {
    const tok = String(b.token || (b.header && b.header.token) || '');
    if (tok !== String(cfg.verificationToken)) return { ok: false, reason: '飞书验证令牌不匹配' };
    return { ok: true };
  }

  // ④ 未配置验签材料：放行并标注（不中断链路）
  return { ok: true, unverified: true };
}

module.exports = { verifyCardCallback };
