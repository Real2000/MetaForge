/**
 * U1-7 画布多人实时协作（2026-11-16）
 *
 * 协议设计（WebSocket 端点 /api/canvas-ws，upgrade 握手经 HttpOnly Cookie 鉴权——
 * P2-3 改造后 token 不入 JS 可读存储，浏览器同源 WS 握手自动携带 Cookie，服务端 readToken 复用）：
 *
 * 客户端 → 服务端：
 *   {type:'join', roomId}                      加入房间（须为活跃成员/host/admin）
 *   {type:'wf', baseVersion, workflow}         提交本地画布全量（防抖；服务端计算增量）
 *   {type:'op', op:'node:move', moves:[{id,x,y}]}  节点位置批量移动（拖拽结束；diff 有意忽略位置故单独走轻指令）
 *   {type:'cursor', x, y}                     光标（画布世界坐标；客户端节流）
 *   {type:'sync'}                              主动请求全量重同步
 *
 * 服务端 → 客户端：
 *   {type:'hello', version, workflow, agentId, roomName, members:[{username,nickname}]}
 *   {type:'presence', members}                加入/离开广播
 *   {type:'ok', version}                      wf 提交被接受
 *   {type:'diff', version, diff, by}          语义增量广播（workflow-diff；added 含完整 node/edge）
 *   {type:'op', op:'node:move', moves, by}    位置移动广播
 *   {type:'cursor', by, x, y}                 光标转发
 *   {type:'conflict', currentVersion, msg}    baseVersion 落后 → 拒绝（服务端版本为准；客户端应 sync）
 *   {type:'sync', version, workflow, members} 全量重同步
 *   {type:'closed', msg}                      房间被关闭
 *   {type:'error', msg}
 *
 * 冲突规则（计划表：冲突以服务端版本为准，乐观锁保留兜底）：
 *   - WS 层：每房间 version 单调递增；wf 提交 baseVersion ≠ 当前 version 即拒绝（客户端全量重拉）；
 *     服务端串行处理消息，正常在同步态下不会触发——该锁为网络乱序/离线残留提交的兜底
 *   - HTTP 层：agents PUT 既有 base_updated_at 乐观锁（409）保持不变，覆盖非协作路径
 *
 * 状态承载：房间画布态为【会话内存态】（Map roomId → {version, workflow, clients}），
 * 初始从 agents.workflow 载入；持久化仍走既有保存链路（成员点击保存 → PUT /agents/:id，
 * 成功后 markDirty 触发的 wf 提交会把保存后状态同步给房间，服务端 diff=0 仅回 ack）。
 * 最后一名成员离开后保留 10 分钟再清理（短暂掉线重连不丢会话态）。
 */
const { WebSocketServer } = require('ws');
const { db, now } = require('../db');
const { verify, readToken } = require('./auth');
const { diffWorkflows } = require('./workflow-diff');

const WS_PATH = '/api/canvas-ws';
const ROOM_IDLE_MS = 10 * 60000; // 全员离开后状态保留 10 分钟
const HEARTBEAT_MS = 30000;

const rooms = new Map(); // roomId(number) -> session

/** WS upgrade 请求鉴权：复用 HTTP 同一套（Bearer 头 / ap_token Cookie——浏览器 WS 握手自动带 Cookie） */
function wsUser(req) {
  try {
    const payload = verify(readToken(req));
    if (!payload || !payload.uid) return null;
    return db.prepare('SELECT id, username, nickname, role FROM users WHERE id=? AND status=1').get(payload.uid) || null;
  } catch { return null; }
}

/** 载入（或复用）房间的协作会话态：绑定 agent 的画布为初始权威版本 */
function loadSession(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  const room = db.prepare("SELECT * FROM collab_rooms WHERE id=?").get(roomId);
  if (!room) return { err: 404, msg: '房间不存在' };
  if (room.status !== 'active') return { err: 403, msg: '房间已关闭或归档，无法协作' };
  if (!room.agent_id) return { err: 400, msg: '该房间未绑定画布（需先在智能体编排页创建画布协作房间）' };
  const agent = db.prepare('SELECT id, name, workflow FROM agents WHERE id=?').get(room.agent_id);
  if (!agent) return { err: 404, msg: '房间绑定的智能体已不存在' };
  let wf = null;
  try { wf = JSON.parse(agent.workflow || 'null'); } catch { wf = null; }
  if (!wf || !Array.isArray(wf.nodes)) wf = { nodes: [], edges: [], viewport: { x: 60, y: 40, zoom: 1 } };
  const s = { roomId, agentId: room.agent_id, roomName: room.name, version: 0, workflow: wf, clients: new Set(), cursors: new Map(), idleTimer: null };
  rooms.set(roomId, s);
  return s;
}

/** 校验加入权限：活跃成员 / host / admin */
function canJoin(roomId, user) {
  const room = db.prepare('SELECT * FROM collab_rooms WHERE id=?').get(roomId);
  if (!room || room.status !== 'active') return { ok: false, msg: '房间不存在或已关闭' };
  if (user.role === 'admin' || room.host === user.username) return { ok: true };
  const m = db.prepare("SELECT id FROM collab_room_members WHERE room_id=? AND username=? AND status='active'").get(roomId, user.username);
  return m ? { ok: true } : { ok: false, msg: '你不是该协作房间的成员（需房主在房间管理中添加）' };
}

/** 在线成员清单（去重；同一账号多端只显示一条） */
function onlineMembers(s) {
  const map = new Map();
  for (const c of s.clients) map.set(c.__user.username, { username: c.__user.username, nickname: c.__user.nickname || c.__user.username });
  return [...map.values()];
}

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* 断开竞态静默 */ } } }
function broadcast(s, obj, exclude) { for (const c of s.clients) if (c !== exclude) send(c, obj); }

/** 画布 JSON 结构校验（防手拼客户端污染会话态） */
function validWorkflow(w) {
  return !!w && typeof w === 'object' && Array.isArray(w.nodes) && Array.isArray(w.edges)
    && w.nodes.every(n => n && typeof n === 'object' && n.id != null)
    && w.edges.every(e => e && typeof e === 'object');
}

function touchSession(s) {
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (s.clients.size === 0) {
    s.idleTimer = setTimeout(() => { if (rooms.get(s.roomId) === s && s.clients.size === 0) rooms.delete(s.roomId); }, ROOM_IDLE_MS);
    s.idleTimer.unref?.();
  }
}

function handleConn(wss, ws, user) {
  let s = null; // 当前加入的房间会话
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.__user = user;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return send(ws, { type: 'error', msg: '非法消息（非 JSON）' }); }
    if (!m || typeof m !== 'object' || !m.type) return send(ws, { type: 'error', msg: '消息缺少 type' });

    // 加入房间
    if (m.type === 'join') {
      if (s) return send(ws, { type: 'error', msg: '已在一个协作房间中（先离开再加入）' });
      const roomId = Number(m.roomId);
      if (!Number.isInteger(roomId) || roomId <= 0) return send(ws, { type: 'error', msg: 'roomId 非法' });
      const gate = canJoin(roomId, user);
      if (!gate.ok) return send(ws, { type: 'error', msg: gate.msg });
      const r = loadSession(roomId);
      if (r.err) return send(ws, { type: 'error', msg: r.msg });
      s = r;
      s.clients.add(ws);
      touchSession(s);
      send(ws, { type: 'hello', version: s.version, workflow: s.workflow, agentId: s.agentId, roomName: s.roomName, members: onlineMembers(s), you: { username: user.username, nickname: user.nickname || user.username } });
      broadcast(s, { type: 'presence', members: onlineMembers(s) }, ws);
      console.log(`[canvas-collab] ${user.username} 加入房间 #${roomId}（${s.clients.size} 人在线）`);
      return;
    }

    if (!s) return send(ws, { type: 'error', msg: '未加入房间（先发送 join）' });

    // 提交画布全量（防抖后的本地态）→ 服务端算增量 → 广播
    if (m.type === 'wf') {
      if (!validWorkflow(m.workflow)) return send(ws, { type: 'error', msg: 'workflow 结构非法（须含 nodes/edges 数组）' });
      if (Number(m.baseVersion) !== s.version) {
        // 乐观锁兜底：正常同步态不会触发；网络乱序/离线残留提交会命中 → 客户端 sync 重拉
        return send(ws, { type: 'conflict', currentVersion: s.version, msg: `版本落后（本地 ${m.baseVersion} / 服务端 ${s.version}），已按服务端为准，请 sync 重同步` });
      }
      const diff = diffWorkflows(s.workflow, m.workflow);
      if (diff.summary.total > 0) {
        s.workflow = m.workflow;
        s.version++;
        broadcast(s, { type: 'diff', version: s.version, diff, by: user.username }, ws);
        send(ws, { type: 'ok', version: s.version });
      } else {
        send(ws, { type: 'ok', version: s.version }); // 内容一致（如他人 remote 应用后触发回环提交）
      }
      return;
    }

    // 轻指令：节点位置移动（diff 有意忽略 position——拖拽是纯视觉语义，单独通道高频低费）
    if (m.type === 'op' && m.op === 'node:move') {
      if (!Array.isArray(m.moves) || !m.moves.every(v => v && v.id != null && Number.isFinite(+v.x) && Number.isFinite(+v.y))) {
        return send(ws, { type: 'error', msg: 'moves 结构非法' });
      }
      // 同步进服务端态（晚加入者 hello 拿到的即最新位置；但不动 version——位置无语义）
      for (const v of m.moves) {
        const n = (s.workflow.nodes || []).find(x => String(x.id) === String(v.id));
        if (n) n.position = { x: Math.round(+v.x), y: Math.round(+v.y) };
      }
      broadcast(s, { type: 'op', op: 'node:move', moves: m.moves, by: user.username }, ws);
      return;
    }

    // 光标转发（客户端已节流；服务端同坐标去重兜底）
    if (m.type === 'cursor') {
      if (!Number.isFinite(+m.x) || !Number.isFinite(+m.y)) return;
      const key = user.username, last = s.cursors.get(key);
      if (last && Math.abs(last.x - +m.x) < 1 && Math.abs(last.y - +m.y) < 1) return;
      s.cursors.set(key, { x: +m.x, y: +m.y });
      broadcast(s, { type: 'cursor', by: key, nickname: user.nickname || key, x: +m.x, y: +m.y }, ws);
      return;
    }

    // 主动全量重同步
    if (m.type === 'sync') {
      send(ws, { type: 'sync', version: s.version, workflow: s.workflow, members: onlineMembers(s) });
      return;
    }

    return send(ws, { type: 'error', msg: `未知消息类型：${m.type}` });
  });

  ws.on('close', () => {
    if (s) {
      s.clients.delete(ws);
      s.cursors.delete(user.username);
      broadcast(s, { type: 'cursor', by: user.username, nickname: user.nickname || user.username, x: null, y: null }); // 光标消失
      broadcast(s, { type: 'presence', members: onlineMembers(s) });
      touchSession(s);
      console.log(`[canvas-collab] ${user.username} 离开房间 #${s.roomId}（剩 ${s.clients.size} 人）`);
      s = null;
    }
  });
}

/** 房间被业务侧关闭（POST /collab/rooms/:id/close）→ 通知并清理会话态 */
function notifyRoomClosed(roomId) {
  const s = rooms.get(Number(roomId));
  if (!s) return;
  broadcast(s, { type: 'closed', msg: '协作房间已被主持人关闭' });
  for (const c of s.clients) { try { c.close(1000, 'room closed'); } catch { } }
  if (s.idleTimer) clearTimeout(s.idleTimer);
  rooms.delete(Number(roomId));
}

/** 挂载到 HTTP server（server.js 在 app.listen 后调用一次） */
function attachCanvasCollab(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 }); // 单消息上限 8MB（全量画布足够）
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== WS_PATH) return; // 非 canvas-collab 的 upgrade 不接管（留给其他协议；当前无）
    const user = wsUser(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => handleConn(wss, ws, user));
  });
  const hb = setInterval(() => {
    for (const c of wss.clients) {
      if (c.isAlive === false) { try { c.terminate(); } catch { } continue; }
      c.isAlive = false;
      try { c.ping(); } catch { }
    }
  }, HEARTBEAT_MS);
  hb.unref?.();
  console.log(`[canvas-collab] WebSocket 画布协作已挂载（${WS_PATH}）`);
  return { close: () => { clearInterval(hb); try { wss.close(); } catch { } } };
}

/** 测试/诊断用：当前会话房间数与在线人数 */
function collabStats() {
  return [...rooms.values()].map(s => ({ roomId: s.roomId, agentId: s.agentId, version: s.version, online: s.clients.size }));
}

module.exports = { attachCanvasCollab, notifyRoomClosed, collabStats };
