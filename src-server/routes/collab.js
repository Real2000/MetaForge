/**
 * P2-1～3 协作路由：协作房间 + 任务分解 + 人机协同（2026-11-13）
 *
 * 基础功能（P2-1）：
 *   GET    /api/collab/rooms                — 我的房间列表
 *   POST   /api/collab/rooms                — 创建房间
 *   GET    /api/collab/rooms/:id            — 房间详情
 *   PUT    /api/collab/rooms/:id            — 更新房间设置
 *   POST   /api/collab/rooms/:id/close      — 关闭房间
 *
 *   成员管理：
 *   GET    /api/collab/rooms/:id/members    — 成员列表
 *   POST   /api/collab/rooms/:id/members    — 添加成员
 *   PUT    /api/collab/rooms/:id/members/:mid — 修改成员角色
 *   DELETE /api/collab/rooms/:id/members/:mid — 移除成员
 *
 *   AI 参与者：
 *   GET    /api/collab/rooms/:id/ai         — AI参与者列表
 *   POST   /api/collab/rooms/:id/ai         — 添加AI参与者
 *   PUT    /api/collab/rooms/:id/ai/:aid    — 更新AI角色
 *   DELETE /api/collab/rooms/:id/ai/:aid    — 移除AI
 *
 *   消息：
 *   GET    /api/collab/rooms/:id/messages   — 消息列表
 *   POST   /api/collab/rooms/:id/messages   — 发送消息（含任务指令）
 *   PUT    /api/collab/rooms/:id/messages/:mid/recall  — 撤回消息
 *   PUT    /api/collab/rooms/:id/messages/:mid/hide   — 隐藏消息
 *   PUT    /api/collab/rooms/:id/messages/:mid/read   — 标记已读
 *
 *   邀请：
 *   GET    /api/collab/rooms/:id/invites    — 邀请列表
 *   POST   /api/collab/rooms/:id/invites    — 生成邀请
 *   PUT    /api/collab/rooms/:id/invites/:iid — 更新邀请
 *   DELETE /api/collab/rooms/:id/invites/:iid — 删除邀请
 *   POST   /api/collab/join/:code            — 通过邀请码加入
 *
 * 任务分解（P2-2）：
 *   GET    /api/collab/rooms/:id/tasks           — 任务拓扑
 *   POST   /api/collab/rooms/:id/tasks           — 创建任务
 *   PUT    /api/collab/rooms/:id/tasks/:tid      — 更新任务状态
 *   PUT    /api/collab/rooms/:id/tasks/:tid/deps — 设置依赖
 *
 * 人机协同（P2-3）：
 *   POST   /api/collab/rooms/:id/assign          — 指派给 AI 或人
 *   POST   /api/collab/rooms/:id/summarize       — 汇总多 Agent 执行结果
 */
const express = require('express');
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');

const router = express.Router();
router.use(auth);

/* ---------- 辅助函数 ---------- */

function genCode() {
  return crypto.randomBytes(4).toString('hex');
}

/** 检查用户是否为房间主持人或管理员 */
function canManage(room, user) {
  return user.role === 'admin' || room.host === user.username;
}

/** 检查用户是否为房间成员 */
function isMember(roomId, username) {
  const m = db.prepare('SELECT id FROM collab_room_members WHERE room_id=? AND username=? AND status=?').get(roomId, username, 'active');
  return !!m;
}

/* ==================== P2-1 房间 CRUD ==================== */

router.get('/rooms', (req, res) => {
  // 我创建或参与的（活跃）房间
  const rows = db.prepare(`
    SELECT DISTINCT r.*
    FROM collab_rooms r
    LEFT JOIN collab_room_members m ON m.room_id=r.id AND m.username=?
    WHERE r.status='active' AND (r.host=? OR m.id IS NOT NULL)
    ORDER BY r.updated_at DESC
  `).all(req.user.username, req.user.username);
  res.json({ code: 0, data: rows });
});

router.post('/rooms', (req, res) => {
  const { name, description, room_type, model, settings } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '房间名称不能为空' });
  const r = db.prepare(`INSERT INTO collab_rooms (name,description,room_type,host,model,status,settings,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,?)`).run(
    name.slice(0, 200), (description || '').slice(0, 1000), room_type || 'collab',
    req.user.username, model || '', JSON.stringify(settings || {}), now(), now()
  );
  const roomId = Number(r.lastInsertRowid);
  // 自动将创建者加入成员表
  db.prepare(`INSERT INTO collab_room_members (room_id,username,role,nickname,joined_at,status) VALUES (?,?,'host',?,?,?)`)
    .run(roomId, req.user.username, req.user.nickname || req.user.username, now(), 'active');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '创建协作房间', name.slice(0, 100), req.ip, now());
  res.json({ code: 0, data: { id: roomId } });
});

router.get('/rooms/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  const memberCount = db.prepare("SELECT COUNT(*) AS c FROM collab_room_members WHERE room_id=? AND status='active'").get(r.id).c;
  const aiCount = db.prepare("SELECT COUNT(*) AS c FROM collab_ai_participants WHERE room_id=? AND status='active'").get(r.id).c;
  res.json({ code: 0, data: { ...r, memberCount, aiCount } });
});

router.put('/rooms/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可修改房间设置' });
  const { name, description, model, settings } = req.body || {};
  const fields = [];
  const vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name.slice(0, 200)); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description.slice(0, 1000)); }
  if (model !== undefined) { fields.push('model=?'); vals.push(model); }
  if (settings !== undefined) { fields.push('settings=?'); vals.push(JSON.stringify(settings)); }
  fields.push('updated_at=?'); vals.push(now());
  vals.push(r.id);
  db.prepare(`UPDATE collab_rooms SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ code: 0 });
});

router.post('/rooms/:id/close', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可关闭房间' });
  db.prepare("UPDATE collab_rooms SET status='closed',closed_at=?,updated_at=? WHERE id=?").run(now(), now(), r.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '关闭协作房间', r.name.slice(0, 100), req.ip, now());
  res.json({ code: 0 });
});

/* ==================== 成员管理 ==================== */

router.get('/rooms/:id/members', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  // 所有成员都可查看成员列表
  const rows = db.prepare('SELECT * FROM collab_room_members WHERE room_id=? ORDER BY role DESC, joined_at').all(r.id);
  res.json({ code: 0, data: rows });
});

router.post('/rooms/:id/members', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可添加成员' });
  const { username, role } = req.body || {};
  if (!username) return res.json({ code: 400, msg: '请指定用户名' });
  // 检查是否已在成员中
  const exists = db.prepare('SELECT id FROM collab_room_members WHERE room_id=? AND username=?').get(r.id, username);
  if (exists) {
    // 如果是 left/kicked 状态，重新激活
    db.prepare("UPDATE collab_room_members SET status='active',joined_at=?,left_at=NULL WHERE id=?").run(now(), exists.id);
  } else {
    db.prepare('INSERT INTO collab_room_members (room_id,username,role,joined_at,status) VALUES (?,?,?,?,?)')
      .run(r.id, username, role || 'member', now(), 'active');
  }
  res.json({ code: 0 });
});

router.put('/rooms/:id/members/:mid', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可修改成员角色' });
  const { role } = req.body || {};
  if (role) db.prepare('UPDATE collab_room_members SET role=? WHERE id=? AND room_id=?').run(role, req.params.mid, r.id);
  res.json({ code: 0 });
});

router.delete('/rooms/:id/members/:mid', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可移除成员' });
  db.prepare("UPDATE collab_room_members SET status='kicked',left_at=? WHERE id=? AND room_id=?").run(now(), req.params.mid, r.id);
  res.json({ code: 0 });
});

/* ==================== AI 参与者 ==================== */

router.get('/rooms/:id/ai', (req, res) => {
  const rows = db.prepare('SELECT c.*, a.name AS agent_name, a.icon AS agent_icon FROM collab_ai_participants c LEFT JOIN agents a ON a.id=c.agent_id WHERE c.room_id=? AND c.status!=\'removed\' ORDER BY c.id').all(req.params.id);
  res.json({ code: 0, data: rows });
});

router.post('/rooms/:id/ai', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可添加 AI' });
  const { agent_id, role, instruction } = req.body || {};
  if (!agent_id) return res.json({ code: 400, msg: '请指定智能体 ID' });
  const a = db.prepare('SELECT id, name FROM agents WHERE id=?').get(agent_id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  db.prepare(`INSERT INTO collab_ai_participants (room_id,agent_id,role,instruction,added_by,status,added_at)
    VALUES (?,?,?,?,?,'active',?)`).run(r.id, agent_id, role || 'collaborator', instruction || '', req.user.username, now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '添加 AI 参与者', `${a.name} → ${r.name}`, req.ip, now());
  res.json({ code: 0 });
});

router.put('/rooms/:id/ai/:aid', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可修改 AI 设置' });
  const { role, instruction } = req.body || {};
  if (role) db.prepare('UPDATE collab_ai_participants SET role=? WHERE id=? AND room_id=?').run(role, req.params.aid, req.params.id);
  if (instruction !== undefined) db.prepare('UPDATE collab_ai_participants SET instruction=? WHERE id=? AND room_id=?').run(instruction, req.params.aid, req.params.id);
  res.json({ code: 0 });
});

router.delete('/rooms/:id/ai/:aid', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可移除 AI' });
  db.prepare("UPDATE collab_ai_participants SET status='removed' WHERE id=? AND room_id=?").run(req.params.aid, req.params.id);
  res.json({ code: 0 });
});

/* ==================== 消息 ==================== */

router.get('/rooms/:id/messages', (req, res) => {
  const { limit = 100, before } = req.query;
  let sql = `SELECT * FROM collab_room_messages WHERE room_id=?`;
  const args = [req.params.id];
  if (before) { sql += ' AND id < ?'; args.push(+before); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(Math.min(+limit || 100, 500));
  let rows = db.prepare(sql).all(...args);
  // 过滤 hidden_for 包含当前用户的消息
  rows = rows.filter(m => {
    try { const hidden = JSON.parse(m.hidden_for || '[]'); return !hidden.includes(req.user.username); } catch { return true; }
  }).reverse();
  res.json({ code: 0, data: rows });
});

router.post('/rooms/:id/messages', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (r.status !== 'active') return res.json({ code: 400, msg: '房间已关闭，无法发送消息' });
  const { content, parent_id, msg_type, attachments } = req.body || {};
  if (!content) return res.json({ code: 400, msg: '消息内容不能为空' });
  db.prepare(`INSERT INTO collab_room_messages (room_id,parent_id,sender,role,content,attachments,msg_type,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.id, parent_id || null, req.user.username, 'user', content.slice(0, 50000),
      JSON.stringify(attachments || []), msg_type || 'text', now());
  res.json({ code: 0 });
});

router.put('/rooms/:id/messages/:mid/recall', (req, res) => {
  const m = db.prepare('SELECT * FROM collab_room_messages WHERE id=? AND room_id=?').get(req.params.mid, req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  if (m.sender !== req.user.username && req.user.role !== 'admin')
    return res.json({ code: 403, msg: '仅消息发送者或管理员可撤回' });
  db.prepare('UPDATE collab_room_messages SET recalled=1 WHERE id=?').run(m.id);
  res.json({ code: 0 });
});

router.put('/rooms/:id/messages/:mid/hide', (req, res) => {
  const m = db.prepare('SELECT * FROM collab_room_messages WHERE id=? AND room_id=?').get(req.params.mid, req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可隐藏消息' });
  try {
    const hidden = JSON.parse(m.hidden_for || '[]');
    if (!hidden.includes(req.user.username)) hidden.push(req.user.username);
    db.prepare('UPDATE collab_room_messages SET hidden_for=? WHERE id=?').run(JSON.stringify(hidden), m.id);
  } catch { return res.json({ code: 500, msg: '隐藏失败' }); }
  res.json({ code: 0 });
});

router.put('/rooms/:id/messages/:mid/read', (req, res) => {
  const m = db.prepare('SELECT * FROM collab_room_messages WHERE id=? AND room_id=?').get(req.params.mid, req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  try {
    const readBy = JSON.parse(m.read_by || '[]');
    if (!readBy.includes(req.user.username)) {
      readBy.push(req.user.username);
      db.prepare('UPDATE collab_room_messages SET read_by=? WHERE id=?').run(JSON.stringify(readBy), m.id);
    }
  } catch { }
  res.json({ code: 0 });
});

/* ==================== 邀请 ==================== */

router.get('/rooms/:id/invites', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可查看邀请' });
  const rows = db.prepare('SELECT * FROM collab_room_invites WHERE room_id=? ORDER BY id DESC').all(req.params.id);
  res.json({ code: 0, data: rows });
});

router.post('/rooms/:id/invites', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可生成邀请' });
  const { target_username, role, max_use, expires_in_hours } = req.body || {};
  const code = genCode();
  let expiresAt = null;
  if (expires_in_hours) {
    const d = new Date(Date.now() + expires_in_hours * 3600000);
    expiresAt = d.toISOString().replace('T', ' ').slice(0, 19);
  }
  db.prepare(`INSERT INTO collab_room_invites (room_id,invite_code,target_username,role,max_use,expires_at,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(r.id, code, target_username || '', role || 'member', max_use || 0, expiresAt, req.user.username, now());
  res.json({ code: 0, data: { invite_code: code } });
});

router.put('/rooms/:id/invites/:iid', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可修改邀请' });
  const { enabled, max_use } = req.body || {};
  if (enabled !== undefined) db.prepare('UPDATE collab_room_invites SET enabled=? WHERE id=? AND room_id=?').run(enabled ? 1 : 0, req.params.iid, req.params.id);
  if (max_use !== undefined) db.prepare('UPDATE collab_room_invites SET max_use=? WHERE id=? AND room_id=?').run(max_use, req.params.iid, req.params.id);
  res.json({ code: 0 });
});

router.delete('/rooms/:id/invites/:iid', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可删除邀请' });
  db.prepare('DELETE FROM collab_room_invites WHERE id=? AND room_id=?').run(req.params.iid, req.params.id);
  res.json({ code: 0 });
});

router.post('/join/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM collab_room_invites WHERE invite_code=? AND enabled=1').get(req.params.code);
  if (!inv) return res.json({ code: 404, msg: '邀请码不存在或已禁用' });
  if (inv.target_username && inv.target_username !== req.user.username)
    return res.json({ code: 403, msg: '此邀请码仅限指定用户' });
  if (inv.max_use > 0 && inv.use_count >= inv.max_use)
    return res.json({ code: 400, msg: '邀请码已用完' });
  if (inv.expires_at && new Date(inv.expires_at) < new Date())
    return res.json({ code: 400, msg: '邀请码已过期' });
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(inv.room_id);
  if (!r || r.status !== 'active') return res.json({ code: 404, msg: '房间不存在或已关闭' });
  // 加入成员
  const exists = db.prepare('SELECT id FROM collab_room_members WHERE room_id=? AND username=?').get(inv.room_id, req.user.username);
  if (exists) {
    db.prepare("UPDATE collab_room_members SET status='active',joined_at=?,left_at=NULL WHERE id=?").run(now(), exists.id);
  } else {
    db.prepare('INSERT INTO collab_room_members (room_id,username,role,joined_at,status) VALUES (?,?,?,?,?)')
      .run(inv.room_id, req.user.username, inv.role, now(), 'active');
  }
  db.prepare('UPDATE collab_room_invites SET use_count=use_count+1 WHERE id=?').run(inv.id);
  res.json({ code: 0, data: { room_id: inv.room_id, room_name: r.name } });
});

/* ---------- P2-2 任务分解 ---------- */

router.post('/rooms/:id/tasks', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可创建任务' });
  const { title, description, parent_id, assignee, assignee_type, deps } = req.body || {};
  if (!title) return res.json({ code: 400, msg: '任务标题不能为空' });
  const info = db.prepare(`INSERT INTO collab_room_tasks (room_id,parent_id,title,description,assignee,assignee_type,deps,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`).run(
    r.id, parent_id || null, title.slice(0, 200), (description || '').slice(0, 2000),
    assignee || '', assignee_type || 'human', JSON.stringify(deps || []),
    req.user.username, now(), now()
  );
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '创建协作任务', `${title}（${r.name}）`, req.ip, now());
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
});

router.get('/rooms/:id/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM collab_room_tasks WHERE room_id=? ORDER BY COALESCE(parent_id,0), id').all(req.params.id);
  res.json({ code: 0, data: rows });
});

router.put('/rooms/:id/tasks/:tid', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可更新任务' });
  const { status, assignee, assignee_type, title, description } = req.body || {};
  const fields = []; const vals = [];
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (title !== undefined) { fields.push('title=?'); vals.push(title.slice(0, 200)); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description.slice(0, 2000)); }
  if (assignee !== undefined) { fields.push('assignee=?'); vals.push(assignee); }
  if (assignee_type !== undefined) { fields.push('assignee_type=?'); vals.push(assignee_type); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(req.params.tid, req.params.id);
  db.prepare(`UPDATE collab_room_tasks SET ${fields.join(',')} WHERE id=? AND room_id=?`).run(...vals);
  res.json({ code: 0 });
});

router.put('/rooms/:id/tasks/:tid/deps', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可设置依赖' });
  const { deps } = req.body || [];
  db.prepare('UPDATE collab_room_tasks SET deps=?,updated_at=? WHERE id=? AND room_id=?')
    .run(JSON.stringify(deps), now(), req.params.tid, req.params.id);
  res.json({ code: 0 });
});

/* ---------- P2-3 人机协同 ---------- */

router.post('/rooms/:id/assign', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  if (!canManage(r, req.user)) return res.json({ code: 403, msg: '仅主持人或管理员可指派' });
  const { task_id, assignee, assignee_type } = req.body || {};
  if (!task_id || !assignee) return res.json({ code: 400, msg: '请指定任务和负责人' });
  const t = db.prepare('SELECT * FROM collab_room_tasks WHERE id=? AND room_id=?').get(task_id, r.id);
  if (!t) return res.json({ code: 404, msg: '任务不存在' });
  db.prepare('UPDATE collab_room_tasks SET assignee=?,assignee_type=?,status=?,updated_at=? WHERE id=?')
    .run(assignee, assignee_type || 'human', 'assigned', now(), task_id);
  // 写一条系统消息记录指派
  db.prepare(`INSERT INTO collab_room_messages (room_id,sender,role,content,msg_type,meta,created_at)
    VALUES (?,?,?,'system',?,?,'system',?,?)`)
    .run(r.id, req.user.username, `已指派任务「${t.title}」给 ${assignee}（${assignee_type === 'ai' ? 'AI' : '人'}）`,
      JSON.stringify({ task_id, assignee, assignee_type }), now());
  res.json({ code: 0 });
});

router.post('/rooms/:id/summarize', (req, res) => {
  const r = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ code: 404, msg: '房间不存在' });
  // 查询该房间所有已完成任务，生成一份简明汇总
  const done = db.prepare("SELECT * FROM collab_room_tasks WHERE room_id=? AND status IN ('done','success','completed') ORDER BY updated_at DESC").all(r.id);
  const pending = db.prepare("SELECT * FROM collab_room_tasks WHERE room_id=? AND status NOT IN ('done','success','completed','cancelled') ORDER BY id").all(r.id);
  const messages = db.prepare("SELECT * FROM collab_room_messages WHERE room_id=? AND msg_type!='system' ORDER BY id ASC LIMIT 50").all(r.id);
  const agents = db.prepare('SELECT c.*, a.name AS agent_name FROM collab_ai_participants c LEFT JOIN agents a ON a.id=c.agent_id WHERE c.room_id=? AND c.status=?').all(r.id, 'active');
  const summary = {
    room: r.name,
    totalTasks: done.length + pending.length,
    completed: done.length,
    pending: pending.length,
    aiParticipants: agents.map(a => ({ name: a.agent_name || `#${a.agent_id}`, role: a.role })),
    lastActivity: messages.length ? messages[messages.length - 1].created_at : null,
  };
  db.prepare(`INSERT INTO collab_room_messages (room_id,sender,role,content,msg_type,meta,created_at)
    VALUES (?,?,'system','自动汇总报告',?,'summary',?,?)`)
    .run(r.id, 'system', JSON.stringify(summary, null, 2), JSON.stringify({ type: 'summary' }), now());
  res.json({ code: 0, data: summary });
});

module.exports = router;