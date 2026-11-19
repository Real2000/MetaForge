/** 渠道适配层路由（2026-11-12 P1-7）
 *  GET  /api/channel/inbound        标准入站投递（渠道自动识别 → 归一化模型 → 审计 → 派发测试会话）
 *  GET  /api/channel/messages       入站消息审计列表（adminOnly）
 *  POST /api/channel/send           出站统一发送（adminOnly；channel+receivers+message）
 *  GET  /api/channel/status         渠道配置状态（哪些渠道已配凭证，adminOnly）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { normalizeInbound, send, CHANNEL_TYPES, upsertChannel, listChannels, getChannelConfig, updateCallbackStatus, toggleChannel, deleteChannel, upsertUserBinding, listUserBindings, deleteUserBinding, resolveCardCallback, sendCardResult, auditInbound } = require('../lib/channel');
const { loadSecrets } = require('../lib/secrets');
const { upsertBind, deleteBind, listBinds, addWhitelist, removeWhitelist, listWhitelist, inbound } = require('../lib/group-context');
const { getAdapter, listAdapterStatus } = require('../lib/im-adapters');
const { verifyCardCallback } = require('../lib/card-callback-verify'); // U0-5 P3 回调验签
const { buildPassiveReply } = require('../lib/im-wechat-mp'); // U0-1③ 公众号被动回复（N4）

const router = express.Router();

// 渠道事件回调体解析：XML（企微/公众号，安全模式为 Encrypt 包裹的 XML 文本）
// 全局仅挂 express.json()，XML 请求体不被解析；此处按内容类型补 text 解析（挂在免 auth 回调端点前）
const xmlParser = express.text({ type: ['text/xml', 'application/xml'], limit: '2mb' });

// ---------------- P1-9 IM 事件回调（免 auth：飞书/企微服务器回调不带平台 token，
// 安全靠渠道侧 URL 验证握手 + 渗透面与钩钉 callback 同构；必须注册在 router.use(auth) 之前） ----------------
/** POST /api/channel/event/:id —— 飞书/企微/公众号 事件订阅共用的回调端点 */
router.get('/event/:id', async (req, res) => {
  // URL 验证握手（企微/公众号 GET + query params）
  const ch = db.prepare('SELECT id, type, enabled FROM channels WHERE id=?').get(Number(req.params.id));
  if (!ch) return res.status(404).json({ code: 404, msg: '渠道不存在' });
  const adapter = getAdapter(ch.type);
  if (!adapter || adapter.status === 'reserved') return res.status(200).send(req.query.echostr || '');
  try {
    const result = adapter.handleEvent(ch.id, { ...req.headers, ...req.query }, null, req.query);
    if (result?.echo) return res.send(result.echo);
    return res.status(400).send('verify failed');
  } catch { return res.status(500).json({ code: 500, msg: '事件处理异常' }); }
});

router.post('/event/:id', xmlParser, async (req, res) => {
  const ch = db.prepare('SELECT id, type, enabled FROM channels WHERE id=?').get(Number(req.params.id));
  if (!ch) return res.status(404).json({ code: 404, msg: '渠道不存在' });
  const isXmlChannel = ch.type === 'wechat-mp' || ch.type === 'wecom';
  if (!ch.enabled) return isXmlChannel ? res.type('text/xml').send('success') : res.status(200).json({ code: 0, msg: '渠道已停用' });
  const adapter = getAdapter(ch.type);
  if (!adapter || adapter.status === 'reserved') {
    return isXmlChannel ? res.type('text/xml').send('success')
      : res.status(200).json({ code: 0, msg: `渠道类型 ${ch.type} 适配器为预留接口，事件已接收但未处理` });
  }
  try {
    // 飞书: body 是 JSON 对象；企微/公众号: body 是 XML 字符串（经 xmlParser）
    const rawBody = typeof req.body === 'string' ? req.body : (req.body || {});
    const result = adapter.handleEvent(ch.id, { ...req.headers, ...req.query }, rawBody, req.query);
    // 飞书 url 验证握手：必须回 { challenge }
    if (result?.challenge) return res.json({ challenge: result.challenge });
    if (result?.error) return isXmlChannel ? res.type('text/xml').send('success') : res.status(400).json({ code: 400, msg: result.error });
    if (result?.ignored) return isXmlChannel ? res.type('text/xml').send('success') : res.json({ code: 0, data: { ignored: true } });
    // message 事件 → 审计落库 + P1-10 群上下文管线
    const msg = result.message;
    const audit = auditInbound(msg);
    const verdict = inbound(msg);
    // 公众号：被动回复 XML（≤5s 硬超时，微信最多重试 3 次）
    // 双通道约定：路由命中 → 立即回占位（长耗时任务不阻塞 5s 窗口）；
    //            真正的结果由业务执行方经 pushAsyncResult()（客服接口，48h 窗口）异步回推。
    //            路由未命中 → 直接回提示语。
    if (result.reply) {
      let content = '';
      if (verdict.ok) content = '正在处理，请稍候…'; // 占位；长任务转异步由 pushAsyncResult 回推
      else if (verdict.reply) content = verdict.reply;
      const xml = buildPassiveReply(result.reply.toUser, result.reply.fromUser, content);
      return res.type('text/xml').send(xml);
    }
    if (verdict.ok) {
      res.json({ code: 0, data: { routed: true, agent_id: verdict.agentId, text: verdict.text, audit_id: audit.id } });
    } else if (verdict.silent) {
      res.json({ code: 0, data: { silent: true } }); // 群内未@：静默
    } else {
      res.json({ code: 0, data: { routed: false, reply: verdict.reply } }); // 提示语由渠道方回发
    }
  } catch (e) {
    try { updateCallbackStatus(ch.id, 'error', '事件处理异常：' + e.message); } catch { }
    if (isXmlChannel) return res.type('text/xml').send('success');
    res.status(500).json({ code: 500, msg: '事件处理异常：' + e.message });
  }
});

// ---------------- U0-5 卡片回调（免 auth：IM 卡片按钮回调不带平台 token，
// 安全靠渠道验签（R6）+ 决议人归属校验；必须注册在 router.use(auth) 之前） ----------------
/** POST/GET /api/channel/card-callback —— 用户点击审批卡按钮后的回调端点
 *  参数（query 或 body 皆可，兼容卡片的 action_url 打开与 POST 回调）：
 *    callbackData: 卡片发送时携带的 confirm_key
 *    action: 'approve' | 'reject'
 *    user_id: 渠道侧用户标识（用于归属校验与结果回发）
 *    channel / channel_id: 渠道类型或 id（用于定位验签配置）
 *    reason?: 决议说明（可选）
 *  流程：验签(R6) → 决议核心 resolveCardCallback(R4：写终态 + 唤醒等待) → 回发结果条(R5)
 */
async function handleCardCallback(req, res) {
  try {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const q = req.query || {};
    const pick = k => (b[k] != null && b[k] !== '') ? b[k] : (q[k] != null && q[k] !== '' ? q[k] : '');
    const channelType = String(pick('channel') || '');
    const channelIdRaw = pick('channel_id');
    const callbackData = String(pick('callbackData') || '');
    const action = String(pick('action') || '');
    const userId = String(pick('user_id') || '');
    const reason = String(pick('reason') || '');

    if (!callbackData || !action) return res.json({ code: 400, msg: '缺少 callbackData 或 action' });
    if (!['approve', 'reject'].includes(action)) return res.json({ code: 400, msg: 'action 应为 approve 或 reject' });

    // 定位渠道（取验签配置 + 归属校验所需的 channel_id）
    let chRow = null;
    if (channelIdRaw) chRow = getChannelConfig(Number(channelIdRaw));
    else if (channelType) {
      const r0 = db.prepare('SELECT id FROM channels WHERE type=? AND enabled=1 ORDER BY id LIMIT 1').get(channelType);
      if (r0) chRow = getChannelConfig(r0.id);
    }

    // R6 验签（未配置验签材料的渠道放行并标注 unverified——mock/未接入期不中断链路）
    const v = verifyCardCallback(
      { type: channelType || (chRow && chRow.type) || '', config: (chRow && chRow.config) || {} },
      req.headers, req.body, req.query,
    );
    if (!v.ok) {
      try { if (chRow) updateCallbackStatus(chRow.id, 'error', '卡片回调验签失败：' + v.reason); } catch { }
      return res.status(401).json({ code: 401, msg: '回调验签失败：' + v.reason });
    }

    // R4 决议核心
    const r = resolveCardCallback({ callbackData, action, userId, reason, channelId: chRow && chRow.id });
    if (!r.ok) {
      try { if (chRow) updateCallbackStatus(chRow.id, 'warning', r.msg); } catch { }
      return res.json({ code: r.code, msg: r.msg, data: r.status ? { status: r.status } : undefined });
    }

    try { if (chRow) updateCallbackStatus(chRow.id, 'ok', ''); } catch { }

    // R5 回发结果条（异步、静默；不影响回调响应）
    const effType = channelType || (chRow && chRow.type) || '';
    if (effType && effType !== 'inbox' && userId) {
      Promise.resolve()
        .then(() => sendCardResult(effType, userId, { status: r.status, toolName: r.toolName, confirmKey: callbackData, reason }))
        .catch(() => { });
    }

    res.json({ code: 0, data: { confirm_key: callbackData, status: r.status, resumed: r.resumed, unverified: !!v.unverified } });
  } catch (e) {
    res.status(500).json({ code: 500, msg: '卡片回调处理失败：' + e.message });
  }
}
router.post('/card-callback', handleCardCallback);
router.get('/card-callback', handleCardCallback);

router.use(auth);

/** 入站投递：任何系统把消息 POST 到此端点即可（渠道自动识别）。
 *  本期语义：归一化 + 落审计 + 返回统一模型（供任务/机器人后续消费；测试用 echo）。
 *  归属：调用方须带平台 token（与任务 webhook 的免鉴权模式区分开——本端点先行管理侧验证） */
router.post('/inbound', (req, res) => {
  const model = normalizeInbound(req.body || {}, 'auto');
  // 审计落库（event_id 幂等：同条渠道消息重复投递只记一次）
  const audit = auditInbound(model);
  // P1-8：投递时可选 X-Channel-Id 头 → 写回该渠道行回调状态（ok/err）
  const chId = Number(req.get('X-Channel-Id') || 0);
  if (chId) {
    try { updateCallbackStatus(chId, model.text ? 'ok' : 'warning', model.text ? '' : '入站消息文本为空'); } catch { }
  }
  res.json({ code: 0, data: { ...model, raw: undefined, audit_id: audit.id } });
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

// ---------------- P1-9 第二 IM 渠道（飞书）+ 适配器注册表 ----------------

/** 适配器注册表状态（P1-9 预留接口可发现） */
router.get('/adapters', adminOnly, (req, res) => {
  res.json({ code: 0, data: listAdapterStatus() });
});

/** 渠道出站发送（复用 P1-7 统一 send，飞书走 im-feishu 适配器） */
router.post('/:id/send-im', adminOnly, async (req, res) => {
  const ch = db.prepare('SELECT id, type, enabled FROM channels WHERE id=?').get(Number(req.params.id));
  if (!ch) return res.json({ code: 404, msg: '渠道不存在' });
  const b = req.body || {};
  if (!b.receiver || !b.content) return res.json({ code: 400, msg: 'receiver 与 content 必填' });
  const adapter = getAdapter(ch.type);
  if (!adapter || adapter.status === 'reserved') return res.json({ code: 400, msg: `渠道类型 ${ch.type} 适配器尚未实现` });
  // 兜底 try-catch：适配器实现异常不影响服务进程（正常适配器自身不 reject，此为双保险）
  let r;
  try {
    r = await adapter.send(ch.id, { receiver: b.receiver, receiverType: b.receiverType || 'open_id' }, { title: b.title, content: b.content });
  } catch (e) {
    return res.json({ code: 502, msg: '发送异常：' + e.message });
  }
  if (!r.ok) return res.json({ code: 502, msg: r.error });
  res.json({ code: 0, data: r, msg: r.mock ? '已发送（mock 降级站内信）' : '已发送' });
});

// ---------------- P1-10 群绑定与白名单 ----------------

/** 绑定列表（含智能体名/渠道名/白名单数） */
router.get('/binds', adminOnly, (req, res) => {
  res.json({ code: 0, data: listBinds(req.query.channel_id ? Number(req.query.channel_id) : undefined) });
});

/** 创建/更新绑定（chat_key 幂等） */
router.post('/binds/upsert', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.channel_id || !b.chat_id) return res.json({ code: 400, msg: 'channel_id 与 chat_id 必填' });
  try {
    const bind = upsertBind({
      channelId: Number(b.channel_id), chatId: String(b.chat_id), chatName: b.chat_name,
      agentId: b.agent_id ? Number(b.agent_id) : undefined,
      bindMode: b.bind_mode, createdBy: req.user.username,
    });
    res.json({ code: 0, data: bind, msg: '已保存' });
  } catch (e) { res.json({ code: 400, msg: e.message }); }
});

/** 解绑（级联删白名单） */
router.delete('/binds/:id', adminOnly, (req, res) => {
  deleteBind(Number(req.params.id));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '解绑群聊', `#${req.params.id}`, req.ip, now());
  res.json({ code: 0, msg: '已解绑' });
});

/** 白名单管理 */
router.get('/binds/:id/whitelist', adminOnly, (req, res) => {
  res.json({ code: 0, data: listWhitelist(Number(req.params.id)) });
});
router.post('/binds/:id/whitelist', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.sender_id) return res.json({ code: 400, msg: 'sender_id 必填' });
  try {
    addWhitelist(Number(req.params.id), b.sender_id, b.sender_name);
    res.json({ code: 0, msg: '已添加' });
  } catch (e) { res.json({ code: 400, msg: e.message }); }
});
router.delete('/binds/:id/whitelist/:senderId', adminOnly, (req, res) => {
  removeWhitelist(Number(req.params.id), req.params.senderId);
  res.json({ code: 0, msg: '已移除' });
});

/** mock 入站全链路验证（P1-9/P1-10 验收用）：模拟一条渠道消息走完整管线
 *  POST /api/channel/mock-dispatch { channel_type, chat_id, chat_type, sender_id, text, with_at, feishu_style }
 *  说明：直接构造统一入站模型（绕过各渠道原始报文格式差异——格式解析已由
 *  P1-7 的 normalizeInbound 单独覆盖），此处专测 P1-10 群上下文管线本身 */
router.post('/mock-dispatch', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.channel_type || !b.chat_id || b.text === undefined) return res.json({ code: 400, msg: 'channel_type / chat_id / text 必填' });
  const model = {
    channel: String(b.channel_type),
    sender: { id: String(b.sender_id || 'mock-user'), name: String(b.sender_name || 'Mock用户'), type: 'user' },
    chat: { id: String(b.chat_id), type: b.chat_type === 'group' ? 'group' : 'single', name: String(b.chat_name || '') },
    text: String(b.text),
    attachments: [],
    ts: Date.now(),
    raw: b.with_at ? { mentions: [{ key: '@_user_1', name: 'robot' }] } : {},
    eventId: 'mock-' + Date.now(),
  };
  const verdict = inbound(model);
  res.json({ code: 0, data: { model: { ...model, raw: undefined }, verdict } });
});

// ==================== U0-5 R2 用户↔渠道身份绑定 ====================

/** GET /api/channel/user-bindings —— 绑定列表（?username= 过滤） */
router.get('/user-bindings', adminOnly, (req, res) => {
  res.json({ code: 0, data: listUserBindings(req.query.username ? String(req.query.username) : undefined) });
});

/** POST /api/channel/user-bindings/upsert —— 新增/更新绑定（username+channel_id 幂等） */
router.post('/user-bindings/upsert', adminOnly, (req, res) => {
  const b = req.body || {};
  try {
    const row = upsertUserBinding({
      username: b.username || req.user.username,
      channelId: b.channel_id,
      channelUserId: b.channel_user_id,
      channelUserName: b.channel_user_name,
    });
    res.json({ code: 0, data: row, msg: '已保存' });
  } catch (e) { res.json({ code: 400, msg: e.message }); }
});

/** DELETE /api/channel/user-bindings/:id —— 解绑 */
router.delete('/user-bindings/:id', adminOnly, (req, res) => {
  deleteUserBinding(Number(req.params.id));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '解绑用户渠道', `#${req.params.id}`, req.ip, now());
  res.json({ code: 0, msg: '已解绑' });
});

module.exports = router;
