/**
 * 飞书 IM 渠道适配器（2026-11-12 P1-9 第二 IM 渠道）
 *
 * 凭证来源：channels 表 type='feishu' 行的解密 config（P1-8 getChannelConfig）
 *   config: { appId, appSecret, verificationToken?, encryptKey? }
 *
 * 三个能力：
 *   1. tenant_access_token 获取（缓存 < 官方 2h 有效期）
 *   2. 出站发消息（im/v1/messages，接收 open_id）——lib/channel.send 的 feishu 分支调用
 *   3. 入站事件验签与解包（事件订阅 v2：url challenge 应答 + message 事件提取）
 *
 * MOCK 模式：config 不全时出站走站内信降级（复用 channel.sendInbox），
 * 入站事件照常解析——P1-9/P1-10 验证期不依赖真实飞书应用。
 */
const { db, now } = require('../db');
const { getChannelConfig, updateCallbackStatus, normalizeInbound } = require('./channel');

// ---------------- tenant_access_token（有缓存） ----------------
const tokenCache = new Map(); // channel_id → { value, expire }

async function feishuAccessToken(channelId) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'feishu') throw new Error('渠道不存在或类型不是 feishu');
  const cfg = ch.config || {};
  if (!cfg.appId || !cfg.appSecret) return null; // 未配置 → mock 模式
  const hit = tokenCache.get(channelId);
  if (hit && Date.now() < hit.expire) return hit.value;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.tenant_access_token) throw new Error('飞书 tenant_access_token 获取失败：' + (j.msg || JSON.stringify(j).slice(0, 120)));
  tokenCache.set(channelId, { value: j.tenant_access_token, expire: Date.now() + (j.expire || 7200) * 1000 - 300000 });
  return j.tenant_access_token;
}

// ---------------- 出站：发消息（群 chat_id 或单聊 open_id） ----------------
/** feishuSend(channelId, to, message)：to.receiverType 'chat_id'|'open_id'
 *  语义保证：本函数永不 reject（凭证缺失/网络失败一律返回 { ok:false } 或降级），
 *  调用方（路由层）无需 try-catch——防止单次发送失败击穿整个服务进程 */
async function feishuSend(channelId, to, message) {
  const content = String(message?.content || '').trim();
  if (!content) return { ok: false, error: '消息内容不能为空' };
  let token = null;
  try {
    token = await feishuAccessToken(channelId);
  } catch (e) {
    return { ok: false, error: '飞书凭证获取失败：' + e.message };
  }
  if (!token) {
    // mock 模式：降级站内信（验证期行为，配置真实凭证后自动切换真发）
    const { sendInbox } = require('./channel');
    sendInbox('*', { title: `飞书渠道（${channelId}）未配置凭证`, content: `消息已降级站内信：${message?.title ? '【' + message.title + '】' : ''}${content}` });
    return { ok: true, degraded: true, mock: true };
  }
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + (to.receiverType || 'open_id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        receive_id: to.receiver,
        msg_type: 'text',
        content: JSON.stringify({ text: (message.title ? `【${message.title}】` : '') + content }),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, error: '飞书发送失败：' + (j.msg || '未知错误') };
    return { ok: true, messageId: j.data?.message_id };
  } catch (e) { return { ok: false, error: '飞书服务不可达：' + e.message }; }
}

// ---------------- 出站：发交互卡片（U0-5 P1，msg_type=interactive） ----------------
/** feishuSendCard(channelId, to, message)：message = { title, content, card }
 *  card = { buttons:[{text,action,url}], callbackData }（见 lib/card-render.js）
 *  语义保证：本函数永不 reject（凭证缺失/网络失败一律降级站内信或返回 { ok:false }） */
async function feishuSendCard(channelId, to, message) {
  const card = message?.card || {};
  const title = String(message?.title || '').trim();
  const content = String(message?.content || '').trim();
  const buttons = Array.isArray(card.buttons) ? card.buttons : [];
  if (!title && !content && !buttons.length) return { ok: false, error: '卡片内容不能为空' };
  let token = null;
  try {
    token = await feishuAccessToken(channelId);
  } catch (e) {
    return { ok: false, error: '飞书凭证获取失败：' + e.message };
  }
  if (!token) {
    // mock 模式：降级站内信（配置真实凭证后自动切换真发）
    const { sendInbox } = require('./channel');
    const btnText = buttons.map(b => `[${b.text}]`).join(' / ');
    sendInbox('*', { title: `飞书渠道（${channelId}）未配置凭证`, content: `卡片已降级站内信：${title ? '【' + title + '】' : ''}${content}${btnText ? ' 按钮：' + btnText : ''}` });
    return { ok: true, degraded: true, mock: true };
  }
  try {
    const { renderFeishuCard } = require('./card-render');
    const body = renderFeishuCard(card, { title, content });
    const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + (to.receiverType || 'open_id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ receive_id: to.receiver, msg_type: 'interactive', content: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, error: '飞书卡片发送失败：' + (j.msg || '未知错误') };
    return { ok: true, messageId: j.data?.message_id };
  } catch (e) { return { ok: false, error: '飞书服务不可达：' + e.message }; }
}

// ---------------- 入站：事件订阅（v2 协议） ----------------
/** 事件回调统一入口：
 *  - url challenge（飞书配置回调地址时的验证握手）→ 返回 { challenge }
 *  - message 事件 → 归一化模型（复用 channel.parseFeishu）
 *  - 其他事件 → { ignored: true, type }
 *  验签（可选）：config.verificationToken 存在时校验 header x-lark-signature 不匹配拒绝 */
function handleFeishuEvent(channelId, headers, body) {
  const ch = getChannelConfig(channelId);
  if (!ch || ch.type !== 'feishu') return { error: '渠道不存在或类型不是 feishu' };
  const cfg = ch.config || {};

  // ① URL 验证握手
  if (body?.type === 'url_verification' && body?.challenge) {
    return { challenge: body.challenge };
  }
  // ② 事件解包（v2 schema：{ header: { event_type }, event: {...} }；v1 兼容：{ event: {...} }）
  const eventType = body?.header?.event_type || '';
  const event = body?.event || {};

  if (eventType === 'im.message.receive_v1' || event?.message) {
    const model = normalizeInbound(body, 'feishu');
    // 渠道回调状态联动（P1-8）
    try { updateCallbackStatus(channelId, model.text ? 'ok' : 'warning', model.text ? '' : '入站消息文本为空'); } catch { }
    return { message: model };
  }
  try { updateCallbackStatus(channelId, 'ok', ''); } catch { }
  return { ignored: true, type: eventType || 'unknown' };
}

module.exports = { feishuAccessToken, feishuSend, feishuSendCard, handleFeishuEvent };
