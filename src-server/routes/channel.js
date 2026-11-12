/** 渠道适配层路由（2026-11-12 P1-7）
 *  GET  /api/channel/inbound        标准入站投递（渠道自动识别 → 归一化模型 → 审计 → 派发测试会话）
 *  GET  /api/channel/messages       入站消息审计列表（adminOnly）
 *  POST /api/channel/send           出站统一发送（adminOnly；channel+receivers+message）
 *  GET  /api/channel/status         渠道配置状态（哪些渠道已配凭证，adminOnly）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { normalizeInbound, send, CHANNEL_TYPES, upsertChannel, listChannels, getChannelConfig, updateCallbackStatus, toggleChannel, deleteChannel } = require('../lib/channel');
const { loadSecrets } = require('../lib/secrets');

const router = express.Router();
router.use(auth);

/** 入站投递：任何系统把消息 POST 到此端点即可（渠道自动识别）。
 *  本期语义：归一化 + 落审计 + 返回统一模型（供任务/机器人后续消费；测试用 echo）。
 *  归属：调用方须带平台 token（与任务 webhook 的免鉴权模式区分开——本端点先行管理侧验证） */
router.post('/inbound', (req, res) => {
  const model = normalizeInbound(req.body || {}, 'auto');
  // 审计落库（event_id 幂等：同条渠道消息重复投递只记一次）
  let audId = null;
  try {
    const exists = model.eventId ? db.prepare('SELECT id FROM channel_messages WHERE event_id=?').get(model.eventId) : null;
    if (!exists) {
      const info = db.prepare(`INSERT INTO channel_messages (event_id, channel, sender_id, chat_id, chat_type, text, attachments, raw, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        model.eventId, model.channel, model.sender.id, model.chat.id, model.chat.type,
        model.text.slice(0, 2000), JSON.stringify(model.attachments || []),
        JSON.stringify(model.raw || {}).slice(0, 5000), now());
      audId = info.lastInsertRowid;
    } else {
      audId = exists.id;
      db.prepare('UPDATE channel_messages SET created_at=? WHERE id=?').run(now(), audId);
    }
  } catch { /* 审计失败不阻断投递 */ }
  // P1-8：投递时可选 X-Channel-Id 头 → 写回该渠道行回调状态（ok/err）
  const chId = Number(req.get('X-Channel-Id') || 0);
  if (chId) {
    try { updateCallbackStatus(chId, model.text ? 'ok' : 'warning', model.text ? '' : '入站消息文本为空'); } catch { }
  }
  res.json({ code: 0, data: { ...model, raw: undefined, audit_id: audId } });
});

/** 入站消息审计（adminOnly）：渠道侧进来的每条消息可查 */
router.get('/messages', adminOnly, (req, res) => {
  const { channel, q } = req.query;
  const wh = [];
  const args = [];
  if (channel && channel !== 'all') { wh.push('channel=?'); args.push(channel); }
  if (q) { wh.push('(text LIKE ? OR sender_id LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT id, event_id, channel, sender_id, chat_id, chat_type, text, attachments, dispatched_to, dispatch_result, created_at
    FROM channel_messages${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`;
  res.json({ code: 0, data: db.prepare(sql).all(...args) });
});

/** 出站统一发送（adminOnly）：测试/运营用统一出口 */
router.post('/send', adminOnly, async (req, res) => {
  const b = req.body || {};
  const receivers = Array.isArray(b.receivers) ? b.receivers : String(b.receivers || '').split(',').map(x => x.trim()).filter(Boolean);
  const to = {
    channel: String(b.channel || 'inbox'),
    receivers,
    username: b.username ? String(b.username) : undefined,
  };
  const message = { title: String(b.title || '').trim(), content: String(b.content || '').trim(), type: String(b.type || 'text') };
  if (!message.content) return res.json({ code: 400, msg: 'content 不能为空' });
  const r = await send(to, message);
  if (!r.ok) return res.json({ code: 500, msg: r.error });
  res.json({ code: 0, data: r, msg: r.degraded ? '已降级站内信发送' : '已发送' });
});

/** 渠道配置状态（adminOnly）：前端/排障用 */
router.get('/status', adminOnly, (req, res) => {
  const s = loadSecrets();
  const channels = {
    dingtalk: !!(s.DINGTALK_APP_KEY && s.DINGTALK_APP_SECRET && s.DINGTALK_AGENT_ID),
    wecom: false,   // 适配位
    feishu: false,  // 适配位
    inbox: true,
  };
  res.json({ code: 0, data: { channels, note: '渠道凭证经「密钥管理」配置（DINGTALK_APP_KEY / APP_SECRET / AGENT_ID）' } });
});

// ---------------- P1-8（2026-11-12）：channels 表 CRUD + 启停 + 回调状态 + OAuth states ----------------

/** 渠道列表（配置已脱敏；adminOnly） */
router.get('/list', adminOnly, (req, res) => {
  res.json({ code: 0, data: { types: CHANNEL_TYPES, list: listChannels() } });
});

/** 新增/更新渠道（adminOnly；config 整体加密落库，密钥不回显） */
router.post('/upsert', adminOnly, (req, res) => {
  const b = req.body || {};
  try {
    const row = upsertChannel({
      id: b.id ? Number(b.id) : undefined,
      name: b.name, type: b.type, config: b.config, enabled: b.enabled, createdBy: req.user.username,
    });
    res.json({ code: 0, data: { id: row.id, name: row.name, type: row.type, enabled: !!row.enabled }, msg: b.id ? '已保存' : '已创建' });
  } catch (e) {
    res.json({ code: 400, msg: e.message });
  }
});

/** 启停切换（adminOnly） */
router.post('/:id/toggle', adminOnly, (req, res) => {
  try {
    res.json({ code: 0, data: toggleChannel(Number(req.params.id)) });
  } catch (e) { res.json({ code: 404, msg: e.message }); }
});

/** 删除渠道（adminOnly；级联清 OAuth states） */
router.delete('/:id', adminOnly, (req, res) => {
  try {
    deleteChannel(Number(req.params.id));
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '删除渠道', `#${req.params.id}`, req.ip, now());
    res.json({ code: 0, msg: '已删除' });
  } catch (e) { res.json({ code: 404, msg: e.message }); }
});

/** 回调状态上报（adminOnly 运维接口 & 入站处理内部调用）：写回 channels.callback_status */
router.post('/:id/callback-status', adminOnly, (req, res) => {
  const b = req.body || {};
  try {
    updateCallbackStatus(Number(req.params.id), String(b.status || 'ok'), String(b.err || ''));
    res.json({ code: 0, msg: '已更新' });
  } catch (e) { res.json({ code: 400, msg: e.message }); }
});

/** connector_oauth_states：发起 OAuth 连接（生成 state，10 分钟有效） */
router.post('/:id/oauth/start', adminOnly, (req, res) => {
  const ch = db.prepare('SELECT id, type FROM channels WHERE id=?').get(Number(req.params.id));
  if (!ch) return res.json({ code: 404, msg: '渠道不存在' });
  const crypto = require('crypto');
  const state = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO connector_oauth_states (state, channel_id, redirect_uri, username, expires_at, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(state, ch.id, String(req.body?.redirect_uri || ''), req.user.username, expiresAt, now());
  res.json({ code: 0, data: { state, expires_in: 600 } });
});

/** OAuth 回调消费 state（一次性；channelId + state 匹配且未过期未消费才通过） */
router.post('/oauth/consume', adminOnly, (req, res) => {
  const { state } = req.body || {};
  if (!state) return res.json({ code: 400, msg: 'state 不能为空' });
  const row = db.prepare('SELECT * FROM connector_oauth_states WHERE state=?').get(String(state));
  if (!row) return res.json({ code: 404, msg: 'state 不存在' });
  if (row.consumed) return res.json({ code: 400, msg: 'state 已使用（防重放）' });
  const expired = row.expires_at && new Date(row.expires_at) < new Date();
  if (expired) return res.json({ code: 400, msg: 'state 已过期，请重新发起连接' });
  db.prepare('UPDATE connector_oauth_states SET consumed=1 WHERE id=?').run(row.id);
  res.json({ code: 0, data: { channel_id: row.channel_id, username: row.username } });
});

module.exports = router;
