/**
 * 微信公众号 IM 渠道适配器（2026-11-19 U0-1③ / N4 渠道补齐）
 *
 * 同构 im-wecom.js / im-feishu.js 接口：accessToken / send / handleEvent（+ sendCard 降级）
 *
 * 凭证来源：channels 表 type='wechat-mp' 行的解密 config（P1-8 getChannelConfig）
 *   config: { appId, appSecret, token, encodingAESKey? }
 *     - appId/appSecret  —— 拉 access_token（/cgi-bin/token，7200s）
 *     - token            —— 服务器配置校验（sha1 验签）
 *     - encodingAESKey?  —— 安全模式消息体 AES（P3；未配置则明文模式）
 *
 * 能力与微信协议差异（相较企微/飞书的三个关键点）：
 *   1. 回调为 XML（同企微），被动回复须 5s 内同步返回 XML，微信最多重试 3 次；
 *   2. 异步回推只能用「客服接口」（/message/custom/send），且有 48h 交互窗口；
 *   3. access_token 与素材接口为公众号独有路径。
 *
 * MOCK 模式：config 不全时出站走站内信降级（复用 channel.sendInbox），
 * 入站事件照常解析——测试号凭证未到位期间不阻塞全链路验证。
 */
const crypto = require('crypto');
const { db, now } = require('../db');
const { getChannelConfig, updateCallbackStatus, normalizeInbound } = require('./channel');

// ---------------- access_token（有缓存） ----------------
const tokenCache = new Map(); // channel_id → { value, expire }

async function wechatMpAccessToken(channelId) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'wechat-mp') throw new Error('渠道不存在或类型不是 wechat-mp');
  const cfg = ch.config || {};
  if (!cfg.appId || !cfg.appSecret) return null; // 未配置 → mock 模式
  const hit = tokenCache.get(channelId);
  if (hit && Date.now() < hit.expire) return hit.value;
  const r = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`,
    { method: 'GET', signal: AbortSignal.timeout(8000) }
  );
  const j = await r.json();
  if (!j.access_token) throw new Error('公众号 access_token 获取失败：' + (j.errmsg || JSON.stringify(j).slice(0, 120)));
  tokenCache.set(channelId, { value: j.access_token, expire: Date.now() + (j.expires_in || 7200) * 1000 - 300000 });
  return j.access_token;
}

// ---------------- 验签（GET 服务器配置校验 / POST 安全模式签名共用） ----------------
/** 公众号签名算法：sha1( [token, timestamp, nonce (+encrypt?)].sort().join('') ) */
function computeSignature(token, timestamp, nonce, encrypt) {
  const arr = [String(token || ''), String(timestamp || ''), String(nonce || '')];
  if (encrypt != null) arr.push(String(encrypt));
  return crypto.createHash('sha1').update(arr.sort().join('')).digest('hex');
}

/** 恒时比较（防时序侧信道） */
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

/** GET 服务器配置校验：signature/timestamp/nonce 三元组验签 */
function verifyUrlSignature(cfg, query) {
  const q = query || {};
  const sig = String(q.signature || '');
  const ts = String(q.timestamp || '');
  const nonce = String(q.nonce || '');
  if (!cfg.token) return { ok: true, unverified: true }; // 未配 token：放行并标注（mock/未接入期）
  const exp = computeSignature(cfg.token, ts, nonce);
  if (!safeEqualHex(sig, exp)) return { ok: false, reason: '服务器配置校验签名失败' };
  return { ok: true };
}

// ---------------- XML 解析（处理 CDATA + 扁平元素；公众号/企微回调同构） ----------------
/** 解析微信回调 XML 为扁平对象；带 CDATA 的元素取其文本内容 */
function parseXml(xml) {
  const obj = {};
  // 非 CDATA 的值用 [^<]* 排除嵌套标签，避免外层 <xml> 吞掉整段
  const re = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const key = m[1];
    // CDATA 分支允许含 <；非 CDATA 分支由 [^<]* 构造已排除嵌套标签，无需再过滤
    const val = m[2] != null ? m[2] : m[3];
    if (val != null) obj[key] = val;
  }
  return obj;
}

// ---------------- 安全模式：AES-256-CBC 解密（P3；未配 encodingAESKey 时不调用） ----------------
/** Node crypto 的 aes-256-cbc 默认 PKCS7 填充，与微信安全模式一致 */
function decryptMessage(encodingAESKey, encryptB64) {
  const key = Buffer.from(String(encodingAESKey) + '=', 'base64'); // 43 位 → 44 位 Base64
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([decipher.update(Buffer.from(String(encryptB64), 'base64')), decipher.final()]);
  // 去 PKCS7 填充
  let pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) pad = 0;
  buf = buf.slice(0, buf.length - pad);
  // 结构：random(16) + msgLen(4, BE) + msg + appid
  const msgLen = buf.readUInt32BE(16);
  const msg = buf.slice(20, 20 + msgLen).toString('utf8');
  const appid = buf.slice(20 + msgLen).toString('utf8');
  return { msg, appid };
}

// ---------------- 出站（P1 先建适配位；P2 接客服接口真发） ----------------
/** wechatMpSend(channelId, to, message)：客服接口 /cgi-bin/message/custom/send
 *  to: { receiver: openid }  （单聊用户 openid）
 *  语义保证：永不 reject（凭证缺失/网络失败/窗口超时一律降级或返回 { ok:false }） */
async function wechatMpSend(channelId, to, message) {
  const content = String(message?.content || '').trim();
  if (!content) return { ok: false, error: '消息内容不能为空' };
  const openid = String(to?.receiver || '').trim();
  let token = null;
  try { token = await wechatMpAccessToken(channelId); } catch (e) { return { ok: false, error: '公众号凭证获取失败：' + e.message }; }
  if (!token) {
    const { sendInbox } = require('./channel');
    sendInbox('*', { title: `公众号渠道（${channelId}）未配置凭证`, content: `消息已降级站内信：${message?.title ? '【' + message.title + '】' : ''}${content}` });
    return { ok: true, degraded: true, mock: true };
  }
  if (!openid) return { ok: false, error: '接收人 openid 为空' };
  try {
    const payload = {
      touser: openid,
      msgtype: 'text',
      text: { content: (message?.title ? `【${message.title}】` : '') + content },
    };
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.errcode !== 0) {
      // 45015：超出 48h 客服接口交互窗口 → 降级站内信并标注
      const windowClosed = j.errcode === 45015;
      if (windowClosed) {
        const { sendInbox } = require('./channel');
        sendInbox('*', { title: `公众号渠道（${channelId}）客服窗口已关闭`, content: `超出 48h 交互窗口，消息降级站内信：${content}` });
        return { ok: true, degraded: true, windowClosed: true };
      }
      return { ok: false, error: '公众号发送失败：' + (j.errmsg || 'errno=' + j.errcode) };
    }
    return { ok: true, messageId: '' };
  } catch (e) { return { ok: false, error: '公众号服务不可达：' + e.message }; }
}

/** wechatMpSendCard：公众号客服接口不支持交互卡片 → 文本化降级（审批链接仍可点） */
async function wechatMpSendCard(channelId, to, message) {
  const card = message?.card || {};
  const buttons = Array.isArray(card.buttons) ? card.buttons : [];
  const title = String(message?.title || '').trim();
  const content = String(message?.content || '').trim();
  if (!title && !content && !buttons.length) return { ok: false, error: '卡片内容不能为空' };
  const btnText = buttons.map(b => `[${b.text}]${b.url ? ' ' + b.url : ''}`).join(' / ');
  const text = `${title ? '【' + title + '】' : ''}${content}${btnText ? '\n按钮：' + btnText : ''}`;
  const r = await wechatMpSend(channelId, to, { content: text });
  return { ...r, card: true, textDegraded: true };
}

// ---------------- 被动回复（≤5s 同步返回 XML） ----------------
/** 构造被动回复 XML；content 为空时返回 'success'（微信视为不回复，用于长任务转异步） */
function buildPassiveReply(toUser, fromUser, content) {
  const c = String(content || '');
  if (!c) return 'success';
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName>` +
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${c}]]></Content></xml>`;
}

// ---------------- 入站：回调事件处理 ----------------
/** handleWechatMpEvent(channelId, headers, body)：
 *  - GET 服务器配置校验（query 带 signature/timestamp/nonce/echostr）→ 返回 { echo: echostr }
 *  - POST 消息事件（XML）→ 归一化模型 + 被动回复 XML
 *  - 其他事件（subscribe/unsubscribe/CLICK 等）→ { ignored: true, type }
 *  body：POST 时为原始 XML 字符串；GET 时传 null，验签参数在 headers(=query) 中 */
function handleWechatMpEvent(channelId, headers, body, query) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'wechat-mp') return { error: '渠道不存在或类型不是 wechat-mp' };
  const cfg = ch.config || {};
  // 合并 headers 与 query（微信验签参数在 query；安全模式 POST 亦然）
  const h = { ...(headers || {}), ...(query || {}) };

  // ① GET 服务器配置校验（echostr 握手）
  if (!body && (h.echostr != null || h.signature != null)) {
    const v = verifyUrlSignature(cfg, h);
    if (!v.ok) return { error: v.reason };
    return { echo: String(h.echostr || '') };
  }

  // ② POST 消息事件（XML）
  try {
    let parsed = parseXml(body || '');
    // 安全模式：报文含 <Encrypt> 且配置了 AESKey → 验签 + 解密后再解析
    if (parsed.Encrypt && cfg.encodingAESKey) {
      const v = cfg.token
        ? verifyMsgSignature(cfg.token, h, parsed.Encrypt)
        : { ok: true, unverified: true };
      if (!v.ok) return { error: v.reason };
      const { msg } = decryptMessage(cfg.encodingAESKey, parsed.Encrypt);
      parsed = parseXml(msg);
    }
    const msgType = parsed.MsgType || '';
    const fromUser = parsed.FromUserName || '';
    const toUser = parsed.ToUserName || '';

    if (msgType === 'text' && parsed.Content != null) {
      // 归一化模型（与 lib/channel.normalizeInbound 统一形状，供群上下文管线消费）
      const model = normalizeInbound(parsed, 'wechat-mp');
      model.createdAt = now();
      try { updateCallbackStatus(channelId, 'ok', ''); } catch { }
      // 返回被动回复上下文（reply.toUser/fromUser）；内容由调用方按路由结果构造
      return { message: model, reply: { toUser: fromUser, fromUser: toUser } };
    }
    // 非文本消息（image/voice/event 等）：记录事件类型，不回复
    try { updateCallbackStatus(channelId, 'ok', ''); } catch { }
    return { ignored: true, type: msgType || 'unknown', xml: true };
  } catch { return { error: '事件解析失败' }; }
}

/** POST 安全模式 msg_signature 校验：sha1([token,timestamp,nonce,encrypt].sort()) */
function verifyMsgSignature(token, headers, encrypt) {
  const sig = String(headers.msg_signature || headers.msgSignature || '');
  const ts = String(headers.timestamp || '');
  const nonce = String(headers.nonce || '');
  if (!sig) return { ok: false, reason: '缺少 msg_signature' };
  const exp = computeSignature(token, ts, nonce, encrypt);
  if (!safeEqualHex(sig, exp)) return { ok: false, reason: '安全模式签名校验失败' };
  return { ok: true };
}

/** 临时素材上传（P3）：/cgi-bin/media/upload?type=image —— 返回 { media_id, expires_in } */
async function uploadMedia(channelId, type, buffer, filename) {
  const t = String(type || 'image');
  let token = null;
  try { token = await wechatMpAccessToken(channelId); } catch (e) { return { ok: false, error: '公众号凭证获取失败：' + e.message }; }
  if (!token) return { ok: false, error: '公众号未配置凭证', mock: true };
  try {
    const fd = new FormData();
    fd.append('media', new Blob([buffer]), filename || 'file');
    const r = await fetch(`https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(t)}`, {
      method: 'POST', body: fd, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.errcode || !j.media_id) return { ok: false, error: '素材上传失败：' + (j.errmsg || JSON.stringify(j).slice(0, 120)) };
    return { ok: true, mediaId: j.media_id, expiresIn: j.expires_in };
  } catch (e) { return { ok: false, error: '素材接口不可达：' + e.message }; }
}

module.exports = {
  wechatMpAccessToken, wechatMpSend, wechatMpSendCard,
  handleWechatMpEvent, buildPassiveReply, uploadMedia,
  parseXml, computeSignature, safeEqualHex, decryptMessage, verifyUrlSignature,
};
