/**
 * 渠道适配层（2026-11-12 P1-7）：统一入站消息模型 + 出站发送统一封装
 *
 * ============ 入站：统一消息模型（五元组 + 元数据）============
 *  所有渠道（钉钉/企微/飞书/通用 Webhook）的入站报文归一化为：
 *  {
 *    channel:   'dingtalk' | 'wecom' | 'feishu' | 'webhook',
 *    sender:    { id, name, type: 'user' | 'bot' | 'system' },   // 发送方
 *    chat:      { id, type: 'single' | 'group', name },          // 会话/群
 *    text:      String,                                          // 文本（附件文本化并入）
 *    attachments: [{ name, type, url, size }],                  // 附件
 *    ts:        Number(ms) | null,                               // 消息时间戳
 *    raw:       Object,                                          // 原始报文（审计/排障）
 *    eventId:   String                                           // 渠道侧幂等键
 *  }
 *
 * ============ 出站：send(to, message) 统一封装 ============
 *  message: { title?, content, type: 'text' | 'markdown' }
 *  to:      { channel, receivers: [userId...] } | { channel: 'inbox', username }
 *  渠道未配置 → 自动降级站内信（notify.js 的 notifications 表）+ 审计留痕
 */
const express = require('express');
const { db, now } = require('../db');
const { loadSecrets } = require('./secrets');
const { auth } = require('./auth');

// ---------------- ① 入站解析器（各渠道 → 统一模型） ----------------

/** 钉钉企业内部消息（通讯录事件不含消息；机器人 stream 模式 future）→ 统一模型
 *  当前覆盖：任务 Webhook 场景中钉钉格式（text.content）与 h5 免登上下文消息 */
function parseDingtalk(body) {
  const senderId = String(body?.senderStaffId || body?.senderId || body?.userid || '');
  const content = String(body?.text?.content ?? body?.content ?? body?.msgtext?.content ?? '').trim();
  return {
    channel: 'dingtalk',
    sender: { id: senderId, name: String(body?.senderNick || body?.senderNickname || senderId || ''), type: 'user' },
    chat: {
      id: String(body?.conversationId || body?.chatId || body?.cid || senderId || ''),
      type: body?.chattype === 'group' || body?.conversationType === 'group' ? 'group' : 'single',
      name: String(body?.chatTitle || body?.conversationTitle || ''),
    },
    text: content,
    attachments: extractAttachments(body),
    ts: body?.createTime ? Number(body.createTime) : (body?.timestamp ? Number(body.timestamp) : null),
    raw: body,
    eventId: String(body?.msgId || body?.EventId || body?.eventId || ''),
  };
}

/** 企业微信回调（text.content / markdown）→ 统一模型 */
function parseWecom(body) {
  const content = String(body?.text?.content ?? body?.msgtext?.content ?? body?.content ?? '').trim();
  return {
    channel: 'wecom',
    sender: { id: String(body?.from?.user_id || body?.from?.userid || body?.From?.UserName || ''), name: String(body?.from?.name || body?.From?.alias || ''), type: 'user' },
    chat: {
      id: String(body?.chatid || body?.ChatId || body?.from?.user_id || ''),
      type: (body?.chattype || body?.ChatType) === 'group' ? 'group' : 'single',
      name: String(body?.chatname || ''),
    },
    text: content,
    attachments: extractAttachments(body),
    ts: body?.msgtime ? Number(body.msgtime) : null,
    raw: body,
    eventId: String(body?.msgid || body?.MsgId || ''),
  };
}

/** 飞书事件（message 事件 content JSON 字符串）→ 统一模型 */
function parseFeishu(body) {
  let text = '';
  try {
    const c = body?.event?.message?.content ? JSON.parse(body.event.message.content) : null;
    text = String(c?.text ?? c?.title ?? '').trim();
  } catch { text = String(body?.event?.message?.content ?? '').trim(); }
  const msg = body?.event?.message || {};
  return {
    channel: 'feishu',
    sender: { id: String(msg.sender?.id || body?.event?.sender?.sender_id?.open_id || ''), name: String(msg.sender?.name || ''), type: 'user' },
    chat: {
      id: String(msg.chat_id || ''),
      type: msg.chat_type === 'p2p' ? 'single' : 'group',
      name: '',
    },
    text,
    attachments: extractAttachments(body?.event || {}),
    ts: msg.create_time ? Number(msg.create_time) * 1000 : null,
    raw: body,
    eventId: String(body?.event?.message?.message_id || body?.event_id || ''),
  };
}

/** 通用 Webhook（任务触发用；兼容任意 JSON/纯文本）→ 统一模型 */
function parseWebhook(body) {
  let text = '';
  if (body && typeof body === 'object') text = String(body.input ?? body.message ?? body.text ?? body.content ?? body.question ?? '').trim();
  else text = String(body ?? '').trim();
  return {
    channel: 'webhook',
    sender: { id: String(body?.from || body?.sender || 'webhook'), name: 'Webhook', type: 'system' },
    chat: { id: String(body?.session || body?.conversation || 'default'), type: 'single', name: '' },
    text,
    attachments: extractAttachments(body),
    ts: Date.now(),
    raw: body,
    eventId: '',
  };
}

/** 附件提取（多渠道字段兜底；返回 [{name,type,url,size}]） */
function extractAttachments(src) {
  const out = [];
  const arr = src?.attachments || src?.files || src?.event?.message?.attachments || src?.image || [];
  if (Array.isArray(arr)) {
    for (const a of arr) {
      if (a && typeof a === 'object') out.push({ name: String(a.name || a.title || '附件'), type: String(a.type || a.file_type || 'file'), url: String(a.url || a.download_url || a.fileUrl || ''), size: Number(a.size || a.fileSize || 0) });
    }
  } else if (arr && typeof arr === 'object') { // 单文件对象形态
    out.push({ name: String(arr.name || '附件'), type: String(arr.type || 'file'), url: String(arr.url || ''), size: Number(arr.size || 0) });
  }
  return out;
}

/** 渠道自动识别 + 解析（入站统一入口） */
function normalizeInbound(body, channelHint) {
  if (channelHint && channelHint !== 'auto') {
    const parser = { dingtalk: parseDingtalk, wecom: parseWecom, feishu: parseFeishu, webhook: parseWebhook }[channelHint];
    if (parser) return parser(body);
  }
  // 自动识别特征：钉钉 text.content / senderStaffId；企微 chatid / from.user_id；飞书 event.message
  const s = JSON.stringify(body || {});
  if ((body?.event?.message) || (body?.schema === '2.0' && body?.header?.event_type === 'im.message.receive_v1')) return parseFeishu(body);
  if (body?.senderStaffId || body?.conversationId || body?.chatId) return parseDingtalk(body);
  if (body?.chatid || body?.ChatId || body?.from?.user_id || body?.From) return parseWecom(body);
  return parseWebhook(body);
}

// ---------------- ② 出站统一封装 ----------------

/** 站内信降级/直达渠道（notifications 表，username='*' 为广播） */
function sendInbox(username, message) {
  db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(username === '*' ? '*' : String(username), String(message.title || '').slice(0, 60) || '通知',
      String(message.content || '').slice(0, 2000), 'system', '', now());
  return { ok: true, channel: 'inbox', receivers: [username] };
}

/** 钉钉工作通知（复用 dingtalk.js 的 token 缓存机制——lib 化后共享） */
let dingTokenCache = { value: '', expire: 0 };
async function dingAccessToken() {
  const s = loadSecrets();
  if (!s.DINGTALK_APP_KEY || !s.DINGTALK_APP_SECRET) return null; // 未配置
  if (Date.now() < dingTokenCache.expire) return dingTokenCache.value;
  const r = await fetch('https://oapi.dingtalk.com/gettoken?' + new URLSearchParams({ appkey: s.DINGTALK_APP_KEY, appsecret: s.DINGTALK_APP_SECRET }), { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j || j.errcode !== 0 || !j.access_token) throw new Error('获取钉钉 access_token 失败：' + JSON.stringify(j || {}).slice(0, 120));
  dingTokenCache = { value: j.access_token, expire: Date.now() + (j.expires_in || 7200) * 1000 - 200000 };
  return dingTokenCache.value;
}

/**
 * 出站统一发送：send(to, message)
 * @param to    { channel: 'dingtalk'|'wecom'|'feishu'|'inbox', receivers: [...], username? }
 *              receivers 为渠道侧用户标识数组（钉钉 userid；inbox 为平台用户名）
 * @param message { title?, content, type?: 'text'|'markdown'|'card', card?: { body, buttons, callbackData } }
 *              type='card' 时发送交互卡片（钉钉/飞书等渠道转原生卡片；inbox 降级文本）
 * @returns { ok, channel, receivers, degraded?, mock?, taskId?, error? }
 */
async function send(to, message) {
  const channel = String(to?.channel || 'inbox');
  const receivers = Array.isArray(to?.receivers) ? to.receivers.map(String).filter(Boolean) : [];
  const contentType = String(message?.type || 'text');
  const content = String(message?.content || '').trim();
  if (!content) return { ok: false, channel, error: '消息内容不能为空' };
  const title = String(message?.title || '').trim();

  // 卡片模式：构造渠道原生卡片消息
  if (contentType === 'card' && message?.card) {
    return sendCard(channel, receivers, title, message.card, message);
  }

  // ① 站内信：平台内闭环（通知中心）
  if (channel === 'inbox') {
    const targets = to?.username ? [to.username] : (receivers.length ? receivers : ['*']);
    let n = 0;
    for (const u of targets) { sendInbox(u, message); n++; }
    return { ok: true, channel: 'inbox', receivers: targets, delivered: n };
  }

  // ② 钉钉工作通知：已配置 → 真发；未配置 → 降级站内信 + 审计
  if (channel === 'dingtalk') {
    if (!receivers.length) return { ok: false, channel, error: '接收人为空' };
    const s = loadSecrets();
    if (!s.DINGTALK_APP_KEY || !s.DINGTALK_APP_SECRET || !s.DINGTALK_AGENT_ID) {
      sendInbox('*', { title: title || '钉钉未配置', content: `钉钉渠道未配置凭证，消息已降级站内信：${title ? '【' + title + '】' : ''}${content}` });
      return { ok: true, channel: 'inbox', degraded: true, receivers, mock: true };
    }
    try {
      const token = await dingAccessToken();
      const body = buildDingCardBody(message);
      const r = await fetch('https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?' + new URLSearchParams({ access_token: token }), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: s.DINGTALK_AGENT_ID,
          userid_list: receivers.slice(0, 20).join(','),
          msg: body,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (!j || j.errcode !== 0) return { ok: false, channel, error: '钉钉发送失败：' + (j?.errmsg || '未知错误') };
      return { ok: true, channel: 'dingtalk', receivers, taskId: j.task_id };
    } catch (e) { return { ok: false, channel, error: '钉钉服务不可达：' + e.message }; }
  }

  // ③ 企微/飞书：适配位（本期未配置凭证时统一降级站内信，留扩展点）
  if (channel === 'wecom' || channel === 'feishu') {
    sendInbox('*', { title: title || `${channel === 'wecom' ? '企业微信' : '飞书'}渠道未接入`, content: `该渠道暂未接入，消息已降级站内信：${title ? '【' + title + '】' : ''}${content}` });
    return { ok: true, channel: 'inbox', degraded: true, receivers, mock: true };
  }
  return { ok: false, channel, error: `未知渠道：${channel}` };
}

/** 构建钉钉卡片消息体 */
function buildDingCardBody(message) {
  const card = message.card || {};
  const title = String(message?.title || '').trim();
  const content = String(message?.content || '').trim();
  const buttons = Array.isArray(card.buttons) ? card.buttons : [];
  const callbackData = String(card.callbackData || '');
  const markdown = `## ${title}\n\n${content}\n` + (buttons.length ? buttons.map((b, i) => `---\n[${b.text}](${b.value || '#'})`).join('\n') : '');
  // 钉钉 action_card 卡片
  return {
    msgtype: 'action_card',
    action_card: {
      title: title || '审批通知',
      markdown,
      single_title: buttons.length === 1 ? buttons[0].text : undefined,
      single_url: buttons.length === 1 && buttons[0].value ? buttons[0].value : undefined,
      btn_json_list: buttons.length > 1 ? buttons.map(b => ({
        title: b.text,
        action_url: b.value || '',
      })) : undefined,
    },
  };
}

/** 卡片转渠道原生发送（当前仅降级站内信，待渠道适配就绪后启用） */
async function sendCard(channel, receivers, title, card, message) {
  // 当前降级站内信
  const buttons = Array.isArray(card.buttons) ? card.buttons : [];
  const btnText = buttons.map(b => `[${b.text}]`).join(' / ');
  sendInbox('*', { title: title || '卡片消息', content: `${message?.content || ''}\n${btnText ? '按钮：' + btnText : ''}` });
  return { ok: true, channel: 'inbox', degraded: true, receivers, card: true };
}

// ---------------- ③ P1-8 channels 表：渠道注册/配置加密/启停/回调状态 ----------------
const { encrypt, decrypt } = require('./crypto-util');

const CHANNEL_TYPES = ['dingtalk', 'wecom', 'feishu', 'telegram', 'discord', 'mqtt', 'webhook'];

/** 新增/更新渠道（config 整体 AES-256-GCM 加密落库；回显时解密+脱敏） */
function upsertChannel({ id, name, type, config, enabled, createdBy }) {  const n = String(name || '').trim();
  if (!n) throw new Error('渠道名称不能为空');
  // P1-8 修正：编辑场景未传字段保留旧值（type 同样适用——只改名不应把类型重置成默认 webhook）
  const effType = String(type || '').trim();
  let cfgPlain = {};
  if (config && typeof config === 'object') cfgPlain = config;
  else if (typeof config === 'string' && config.trim()) { try { cfgPlain = JSON.parse(config); } catch { cfgPlain = {}; } }
  const cfgJson = JSON.stringify(cfgPlain);
  const cfgEnc = cfgJson === '{}' ? '' : (encrypt(cfgJson) || cfgJson); // 加密失败兜底明文（crypto-util 约定）
  if (id) {
    const old = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    if (!old) throw new Error('渠道不存在');
    // 校验仅在显式传 type 时做；未传沿用旧类型
    if (effType && !CHANNEL_TYPES.includes(effType)) throw new Error(`不支持的字段类型：${effType}（可选：${CHANNEL_TYPES.join('/')}）`);
    const finalType = effType || old.type;
    const finalName = n || old.name;
    db.prepare('UPDATE channels SET name=?, type=?, config=?, enabled=?, updated_at=? WHERE id=?')
      .run(finalName, finalType, config === undefined ? old.config : cfgEnc, enabled === undefined ? old.enabled : (enabled ? 1 : 0), now(), id);
    return db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  }
  if (!effType) throw new Error('新增渠道必须指定 type');
  const t = effType;
  if (!CHANNEL_TYPES.includes(t)) throw new Error(`不支持的字段类型：${t}（可选：${CHANNEL_TYPES.join('/')}）`);
  const info = db.prepare(`INSERT INTO channels (name, type, config, enabled, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(n, t, cfgEnc, enabled === undefined ? 1 : (enabled ? 1 : 0), String(createdBy || ''), now(), now());
  return db.prepare('SELECT * FROM channels WHERE id=?').get(info.lastInsertRowid);
}

/** 渠道列表（配置解密后按敏感键脱敏：*Secret/secret/Key/appSecret 一律 ••••） */
function listChannels() {
  const rows = db.prepare('SELECT * FROM channels ORDER BY id').all();
  return rows.map(r => {
    let cfg = {};
    try { cfg = r.config ? JSON.parse(decrypt(r.config) || r.config) : {}; } catch { cfg = {}; }
    const masked = {};
    for (const [k, v] of Object.entries(cfg)) {
      masked[k] = /secret|key|token|password/i.test(k) ? (String(v || '') ? '••••••••' : '') : v;
    }
    return { ...r, config: masked, has_config: !!(r.config && r.config.length > 10) };
  });
}

/** 渠道详情（内部消费：解密明文配置，不脱敏——仅 lib 内部/发消息用） */
function getChannelConfig(id) {
  const r = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  if (!r) return null;
  try { return { ...r, config: r.config ? JSON.parse(decrypt(r.config) || r.config) : {} }; } catch { return { ...r, config: {} }; }
}

/** 回调状态上报（入站投递/回调处理结果写回渠道行——排障与看板消费） */
function updateCallbackStatus(channelId, status, err) {
  const s = ['ok', 'warning', 'error', 'pending'].includes(status) ? status : 'pending';
  db.prepare('UPDATE channels SET callback_status=?, callback_last_at=?, callback_err=?, updated_at=? WHERE id=?')
    .run(s, now(), String(err || '').slice(0, 300), now(), channelId);
}

/** 启停切换 */
function toggleChannel(id) {
  const old = db.prepare('SELECT id, enabled FROM channels WHERE id=?').get(id);
  if (!old) throw new Error('渠道不存在');
  const next = old.enabled ? 0 : 1;
  db.prepare('UPDATE channels SET enabled=?, updated_at=? WHERE id=?').run(next, now(), id);
  return { id, enabled: !!next };
}

/** 删除渠道（级联清 OAuth states） */
function deleteChannel(id) {
  db.prepare('DELETE FROM connector_oauth_states WHERE channel_id=?').run(id);
  db.prepare('DELETE FROM channels WHERE id=?').run(id);
}

module.exports = {
  // 入站
  normalizeInbound, parseDingtalk, parseWecom, parseFeishu, parseWebhook,
  // 出站
  send, sendInbox,
  // P1-8 渠道注册表管理
  CHANNEL_TYPES, upsertChannel, listChannels, getChannelConfig,
  updateCallbackStatus, toggleChannel, deleteChannel,
};
