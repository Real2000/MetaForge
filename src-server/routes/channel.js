/** 渠道适配层路由（2026-11-12 P1-7）
 *  GET  /api/channel/inbound        标准入站投递（渠道自动识别 → 归一化模型 → 审计 → 派发测试会话）
 *  GET  /api/channel/messages       入站消息审计列表（adminOnly）
 *  POST /api/channel/send           出站统一发送（adminOnly；channel+receivers+message）
 *  GET  /api/channel/status         渠道配置状态（哪些渠道已配凭证，adminOnly）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { normalizeInbound, send } = require('../lib/channel');
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

module.exports = router;
