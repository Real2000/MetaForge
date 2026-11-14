/**
 * 企业微信 IM 渠道适配器（2026-11-14 U0-1 渠道真接入）
 *
 * 同构 im-feishu.js 接口：accessToken / send / handleEvent
 *
 * 凭证来源：channels 表 type='wecom' 行的解密 config（P1-8 getChannelConfig）
 *   config: { corpId, secret, agentId, token, encodingAESKey }
 *
 * 三个能力：
 *   1. access_token 获取（缓存 < 官方 2h 有效期）
 *   2. 出站发消息（应用消息 API /cgi-bin/message/send）
 *   3. 入站事件验签与解包（xml → url verify + message 提取 + JSON 输出）
 */
const { db, now } = require('../db');
const { getChannelConfig, updateCallbackStatus, normalizeInbound } = require('./channel');

// ---------------- access_token（有缓存） ----------------
const tokenCache = new Map(); // channel_id → { value, expire }

async function wecomAccessToken(channelId) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'wecom') throw new Error('渠道不存在或类型不是 wecom');
  const cfg = ch.config || {};
  if (!cfg.corpId || !cfg.secret) return null; // 未配置 → mock 模式
  const hit = tokenCache.get(channelId);
  if (hit && Date.now() < hit.expire) return hit.value;
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`,
    { method: 'GET', signal: AbortSignal.timeout(8000) }
  );
  const j = await r.json();
  if (j.errcode !== 0 || !j.access_token) {
    throw new Error('企微 access_token 获取失败：' + (j.errmsg || JSON.stringify(j).slice(0, 120)));
  }
  tokenCache.set(channelId, { value: j.access_token, expire: Date.now() + (j.expires_in || 7200) * 1000 - 300000 });
  return j.access_token;
}

// ---------------- 出站：发应用消息 ----------------
/** wecomSend(channelId, to, message)：
 *  to.receiver — 成员 UserID | 群聊 chatid
 *  to.receiverType — 'user' | 'chat'
 *
 *  语义保证：本函数永不 reject（凭证缺失/网络失败一律返回 { ok:false } 或降级） */
async function wecomSend(channelId, to, message) {
  const content = String(message?.content || '').trim();
  if (!content) return { ok: false, error: '消息内容不能为空' };
  let token = null;
  try { token = await wecomAccessToken(channelId); } catch (e) { return { ok: false, error: '企微凭证获取失败：' + e.message }; }
  if (!token) {
    // mock 模式：降级站内信
    const { sendInbox } = require('./channel');
    sendInbox('*', { title: `企微渠道（${channelId}）未配置凭证`, content: `消息已降级：${content}` });
    return { ok: true, degraded: true, mock: true };
  }
  try {
    const payload = {
      touser: to.receiverType === 'chat' ? '' : (to.receiver || '@all'),
      msgtype: 'text',
      agentid: to.agentid || undefined,
      text: { content },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 0,
    };
    if (to.receiverType === 'chat') {
      payload.chatid = to.receiver;
    }
    const r = await fetch('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.errcode !== 0) return { ok: false, error: '企微发送失败：' + (j.errmsg || '未知错误') };
    return { ok: true, messageId: String(j.msgid || '') };
  } catch (e) { return { ok: false, error: '企微服务不可达：' + e.message }; }
}

// ---------------- XML 解析辅助（企微回调用 XML，最小化实现） ----------------
function parseXml(xml) {
  const obj = {};
  xml.replace(/<(\w+)>([^<]*)<\/\1>/g, (_, k, v) => { obj[k] = v; return ''; });
  // 处理嵌套标签
  xml.replace(/<(\w+)>([\s\S]*?)<\/\1>/g, (_, k, v) => {
    if (!v.includes('<')) return;
    const inner = {};
    v.replace(/<(\w+)>([^<]*)<\/\1>/g, (_, ik, iv) => { inner[ik] = iv; return ''; });
    if (Object.keys(inner).length) obj[k] = inner;
  });
  return obj;
}

// ---------------- 入站：回调事件处理 ----------------
/** handleWecomEvent(channelId, headers, body)：
 *  body 为原始 XML 字符串（企微回调是 xml）
 *  - URL 验证握手（echostr）→ 返回 { echo: echostr }
 *  - 文本消息事件 → 归一化模型
 *  - 其他事件 → { ignored: true, type } */
function handleWecomEvent(channelId, headers, body) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'wecom') return { error: '渠道不存在或类型不是 wecom' };
  const cfg = ch.config || {};

  // ① URL 验证握手：企微回调配置时推送 GET
  if (body && body.includes('<echostr>')) {
    const parsed = parseXml(body);
    // 验签（如有 token）：headers 中的 msg_signature 与 sha1(token+timestamp+nonce+echostr) 比对
    if (cfg.token && headers.msg_signature) {
      const sig = sha1([cfg.token, headers.timestamp || '', headers.nonce || '', parsed.echostr || ''].sort().join(''));
      if (sig !== headers.msg_signature) return { error: '签名验证失败' };
    }
    return { echo: parsed.echostr || '' };
  }

  // ② 消息事件：XML 转 JSON
  try {
    const parsed = parseXml(body || '');
    const msgType = parsed.MsgType || '';
    if (msgType === 'text' && parsed.Content) {
      const model = {
        channel: 'wecom',
        senderId: parsed.FromUserName || '',
        senderName: '', // 企微回调不直接携带昵称，需后续获取
        chatType: parsed.ToUserName ? 'single' : 'group',
        chatId: parsed.ToUserName || '',
        text: parsed.Content,
        rawEvent: parsed,
        timestamp: parsed.CreateTime || '',
        createdAt: now(),
      };
      try { updateCallbackStatus(channelId, 'ok', ''); } catch { }
      return { message: model };
    }
    try { updateCallbackStatus(channelId, 'ok', ''); } catch { }
    return { ignored: true, type: msgType || 'unknown' };
  } catch { return { error: '事件解析失败' }; }
}

// SHA1 工具（企微签名用）
function sha1(str) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(str).digest('hex');
}

module.exports = { wecomAccessToken, wecomSend, handleWecomEvent };