/**
 * 群上下文（2026-11-12 P1-10）：群聊绑定、成员白名单、@机器人识别
 *
 * 数据表（db.js P1-10 迁移）：
 *   channel_bound_chats —— chat_key('{channel}:{chat_id}') UNIQUE ↔ agent_id 绑定，bind_mode
 *   chat_whitelist      —— bind_id + sender_id 白名单（bind_mode=whitelist 时生效）
 *
 * 入站消息处理管线：
 *   inbound(msg) → ① @机器人识别（群聊须 @，单聊直通）
 *                 → ② 绑定查找（未绑定群 → 提示绑定）
 *                 → ③ 白名单校验（all/whitelist/admin 三模式）
 *                 → ④ 返回 { ok, agentId, text(去@), bind }；拒绝时 { ok:false, reply }（出站提示语）
 */
const { db, now } = require('../db');

// ---------------- @机器人识别 ----------------
/** 各渠道 @ 机器人的特征剥离（返回 { hit, text }：hit=是否@了机器人，text=去除@后的输入）
 *  飞书：text 形如 "@_user_1 帮我查数据"（mention 数组关联）；母版匹配 @_user_N 前缀
 *  钉钉：@机器人 前缀 mentionUsers 判定
 *  企微：@机器人 文本前缀
 *  通用：文本以 @ 开头视作命中（宽松兜底，验证期够用） */
function stripAtMention(msg) {
  const text = String(msg.text || '').trim();
  // 飞书 v2：mentions 数组存在且 name 匹配首个 @_user_N 时视为@机器人
  const mentions = msg.raw?.event?.message?.mentions || msg.raw?.mentions || [];
  const m = text.match(/^@_user_\d+\s*/);
  if (m) return { hit: true, text: text.slice(m[0].length).trim() };
  const m2 = text.match(/^@(机器人|robot|bot)\s*/i);
  if (m2) return { hit: true, text: text.slice(m2[0].length).trim() };
  // mentions 非空但没匹配上文本前缀（部分客户端 @ 后无空格）：仍按命中算（防漏）
  if (mentions.length) return { hit: true, text: text.replace(/^@\S+\s*/, '').trim() };
  return { hit: false, text };
}

// ---------------- 绑定管理 ----------------
function chatKey(channel, chatId) { return `${channel}:${chatId}`; }

function findBind(channel, chatId) {
  return db.prepare('SELECT * FROM channel_bound_chats WHERE chat_key=?').get(chatKey(channel, chatId));
}

/** 创建/更新绑定（chat_key 幂等 upsert） */
function upsertBind({ channelId, chatId, chatName, agentId, bindMode, createdBy }) {
  const key = chatKey(
    db.prepare('SELECT type FROM channels WHERE id=?').get(channelId)?.type || 'webhook',
    chatId,
  );
  const old = db.prepare('SELECT * FROM channel_bound_chats WHERE chat_key=?').get(key);
  if (old) {
    db.prepare('UPDATE channel_bound_chats SET chat_name=?, agent_id=?, bind_mode=?, updated_at=? WHERE id=?')
      .run(String(chatName || old.chat_name), agentId ?? old.agent_id, bindMode || old.bind_mode, now(), old.id);
    return db.prepare('SELECT * FROM channel_bound_chats WHERE id=?').get(old.id);
  }
  const info = db.prepare(`INSERT INTO channel_bound_chats (channel_id, chat_key, chat_name, agent_id, bind_mode, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(channelId, key, String(chatName || ''), agentId ?? null, bindMode || 'all', String(createdBy || ''), now(), now());
  return db.prepare('SELECT * FROM channel_bound_chats WHERE id=?').get(info.lastInsertRowid);
}

function deleteBind(bindId) {
  db.prepare('DELETE FROM chat_whitelist WHERE bind_id=?').run(bindId); // 级联
  db.prepare('DELETE FROM channel_bound_chats WHERE id=?').run(bindId);
}

function listBinds(channelId) {
  const where = channelId ? 'WHERE b.channel_id=?' : '';
  const args = channelId ? [channelId] : [];
  return db.prepare(`
    SELECT b.*, a.name AS agent_name, c.name AS channel_name, c.type AS channel_type,
      (SELECT COUNT(*) FROM chat_whitelist w WHERE w.bind_id=b.id) AS whitelist_count
    FROM channel_bound_chats b
    LEFT JOIN agents a ON a.id=b.agent_id
    LEFT JOIN channels c ON c.id=b.channel_id
    ${where} ORDER BY b.id DESC`).all(...args);
}

// ---------------- 白名单 ----------------
function addWhitelist(bindId, senderId, senderName) {
  const bid = db.prepare('SELECT id FROM channel_bound_chats WHERE id=?').get(bindId);
  if (!bid) throw new Error('绑定不存在');
  db.prepare(`INSERT INTO chat_whitelist (bind_id, sender_id, sender_name, created_at) VALUES (?,?,?,?)
    ON CONFLICT(bind_id, sender_id) DO UPDATE SET sender_name=excluded.sender_name`)
    .run(bindId, String(senderId), String(senderName || ''), now());
}
function removeWhitelist(bindId, senderId) {
  db.prepare('DELETE FROM chat_whitelist WHERE bind_id=? AND sender_id=?').run(bindId, String(senderId));
}
function listWhitelist(bindId) {
  return db.prepare('SELECT * FROM chat_whitelist WHERE bind_id=? ORDER BY id').all(bindId);
}

// ---------------- 入站处理管线（P1-10 核心入口） ----------------
/** inbound(msg)：统一入站模型（channel/sender/chat/text/raw）→ 路由决策
 *  返回 { ok:true, agentId, text, bind } 或 { ok:false, reply }（reply 为给用户的提示语，出站发送） */
function inbound(msg) {
  const isGroup = msg.chat?.type === 'group';

  // ① 单聊：直通（无需@）；群聊：必须@机器人（免打扰语义）
  const at = stripAtMention(msg);
  if (isGroup && !at.hit) {
    return { ok: false, silent: true }; // 群里没@：静默忽略（不回消息，防机器人刷屏）
  }
  const text = at.text;
  if (!text) return { ok: false, reply: '收到空的指令，请说点什么～' };

  // ② 绑定查找
  const bind = findBind(msg.channel, msg.chat.id);
  if (!bind) {
    return {
      ok: false,
      reply: isGroup
        ? `本群尚未绑定智能体。管理员可在平台「接入管理 → 群绑定」中，将本群（${msg.chat.id}）绑定到指定智能体。`
        : `本会话尚未绑定智能体。管理员可在平台绑定会话 ${msg.chat.id} 到指定智能体。`,
    };
  }
  if (!bind.agent_id) return { ok: false, reply: '本群已登记但未指定智能体，请联系管理员完成绑定。' };

  // ③ 白名单校验（all=全员 / whitelist=名单内 / admin=频道创建者+平台管理员——无平台账号映射时按白名单空处理）
  if (bind.bind_mode === 'whitelist') {
    const hit = db.prepare('SELECT id FROM chat_whitelist WHERE bind_id=? AND sender_id=?').get(bind.id, msg.sender.id);
    if (!hit) {
      return { ok: false, reply: `抱歉，您（${msg.sender.id}）不在本群机器人的使用白名单内，请联系管理员添加。` };
    }
  }
  // admin 模式：白名单表作为管理员名单复用（语义：名单内即放行；空名单 = 仅创建者——创建者标识未落库时拒绝）
  if (bind.bind_mode === 'admin') {
    const list = listWhitelist(bind.id);
    if (!list.some(w => w.sender_id === msg.sender.id)) {
      return { ok: false, reply: '本群机器人仅对管理员开放，如需使用请联系管理员。' };
    }
  }

  return { ok: true, agentId: bind.agent_id, text, bind };
}

module.exports = {
  stripAtMention, chatKey, findBind, upsertBind, deleteBind, listBinds,
  addWhitelist, removeWhitelist, listWhitelist, inbound,
};
