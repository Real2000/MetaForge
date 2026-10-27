/** 数据看板 + 运营监控统计 + 用户列表 */
const express = require('express');
const os = require('os');
const { db } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth, adminOnly);

function dayKey(s) { return String(s).slice(0, 10); }
function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    out.push(d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  }
  return out;
}

/** 数据看板 */
router.get('/dashboard', (req, res) => {
  const days = lastNDays(7);
  const agentTotal = db.prepare('SELECT COUNT(*) c FROM agents').get().c;
  const agentPublished = db.prepare("SELECT COUNT(*) c FROM agents WHERE status='published'").get().c;
  const userTotal = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const kbTotal = db.prepare('SELECT COUNT(*) c FROM kbs').get().c;
  const kbFiles = db.prepare('SELECT COUNT(*) c FROM kb_files').get().c;
  const tokenTotal = db.prepare('SELECT COALESCE(SUM(tokens),0) c FROM messages').get().c;
  const taskTotal = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;

  // 活跃用户（按天去重）
  const activeRows = db.prepare('SELECT m.created_at, s.username FROM messages m JOIN sessions s ON s.id = m.session_id').all();
  const activeMap = new Map(days.map(d => [d, new Set()]));
  activeRows.forEach(r => { const k = dayKey(r.created_at); if (activeMap.has(k)) activeMap.get(k).add(r.username); });
  const activeUsers = days.map(d => activeMap.get(d).size);

  // token 消耗（按天）
  const tokenMap = new Map(days.map(d => [d, 0]));
  db.prepare('SELECT created_at, tokens FROM messages').all().forEach(r => {
    const k = dayKey(r.created_at);
    if (tokenMap.has(k)) tokenMap.set(k, tokenMap.get(k) + r.tokens);
  });

  // 智能体增长（按创建日累计）
  const agentRows = db.prepare('SELECT created_at FROM agents ORDER BY created_at').all();
  const agentGrowth = days.map(d => agentRows.filter(r => dayKey(r.created_at) <= d).length);

  // TOP10
  const topChat = db.prepare(`
    SELECT a.name, COUNT(m.id) c FROM messages m
    JOIN sessions s ON s.id=m.session_id JOIN agents a ON a.id=s.agent_id
    WHERE m.role='user' GROUP BY a.id ORDER BY c DESC LIMIT 10`).all();
  const topUsers = db.prepare(`
    SELECT a.name, COUNT(DISTINCT s.username) c FROM sessions s
    JOIN agents a ON a.id=s.agent_id GROUP BY a.id ORDER BY c DESC LIMIT 10`).all();
  const topTokens = db.prepare(`
    SELECT a.name, COALESCE(SUM(m.tokens),0) c FROM messages m
    JOIN sessions s ON s.id=m.session_id JOIN agents a ON a.id=s.agent_id
    GROUP BY a.id ORDER BY c DESC LIMIT 10`).all();

  res.json({
    code: 0,
    data: {
      cards: { agentTotal, agentPublished, userTotal, kbTotal, kbFiles, tokenTotal, taskTotal },
      days,
      activeUsers,
      tokensByDay: days.map(d => tokenMap.get(d)),
      agentGrowth,
      topChat, topUsers, topTokens,
    },
  });
});

/** 运营监控 */
router.get('/operation', (req, res) => {
  const days = lastNDays(7);
  const spaces = db.prepare('SELECT type, COUNT(*) c FROM spaces GROUP BY type').all();
  const spaceTotal = spaces.reduce((s, x) => s + x.c, 0);
  const spaceByType = { enterprise: 0, dept: 0, personal: 0 };
  spaces.forEach(s => { spaceByType[s.type] = s.c; });

  const agentsBySpace = { enterprise: 0, dept: 0, personal: 0 };
  db.prepare(`SELECT s.type t, COUNT(a.id) c FROM agents a LEFT JOIN spaces s ON s.id=a.space_id GROUP BY s.type`).all()
    .forEach(r => { agentsBySpace[r.t || 'personal'] = r.c; });

  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;

  // 活跃 & 留存（演示口径：活跃=当日有消息；留存=7 日内曾活跃用户在最近一日仍活跃的比例）
  const activeRows = db.prepare('SELECT m.created_at, s.username FROM messages m JOIN sessions s ON s.id = m.session_id').all();
  const activeMap = new Map(days.map(d => [d, new Set()]));
  activeRows.forEach(r => { const k = dayKey(r.created_at); if (activeMap.has(k)) activeMap.get(k).add(r.username); });
  const activeSeries = days.map(d => activeMap.get(d).size);
  const userSeries = days.map(() => users);
  const agentTotal = db.prepare('SELECT COUNT(*) c FROM agents').get().c;
  const agentSeries = days.map(() => agentTotal);
  const ever = new Set(); activeRows.forEach(r => ever.add(r.username));
  const latest = activeMap.get(days[days.length - 1]) || new Set();
  const retention = ever.size ? Math.round([...ever].filter(u => latest.has(u)).length / ever.size * 100) : 0;

  // 会话记录（运营视角：全平台）
  const sessions = db.prepare(`
    SELECT s.*, a.name AS agent_name, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS msg_count
    FROM sessions s LEFT JOIN agents a ON a.id=s.agent_id ORDER BY s.updated_at DESC LIMIT 100`).all();

  res.json({
    code: 0,
    data: {
      cards: { spaceTotal, spaceByType, agentTotal, agentsBySpace, users, retention },
      days, activeSeries, userSeries, agentSeries,
      sessions,
    },
  });
});

// 用户列表（运营监控用）
router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT id, username, nickname, role, dept, status, created_at FROM users ORDER BY id').all();
  res.json({ code: 0, data: rows });
});

// 会话详情（运营监控查看对话内容）
router.get('/sessions/:id/messages', (req, res) => {
  res.json({ code: 0, data: db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(req.params.id) });
});

// 消息链路追踪详情（全链路：KB命中/工具调用/模型耗时）
router.get('/messages/:id/trace', (req, res) => {
  const t = db.prepare('SELECT * FROM chat_traces WHERE message_id=? ORDER BY id DESC LIMIT 1').get(req.params.id);
  if (!t) return res.json({ code: 404, msg: '该消息无链路记录（可能产生于升级前或非对话入口）' });
  const parse = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  res.json({
    code: 0,
    data: {
      ...t,
      kb_hits: parse(t.kb_hits, []),
      tool_calls: parse(t.tool_calls, []),
    },
  });
});

// 链路统计概览（追踪覆盖率/平均耗时/工具使用次数）
router.get('/traces/summary', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) c FROM messages WHERE role='assistant'").get().c;
  const traced = db.prepare('SELECT COUNT(DISTINCT message_id) c FROM chat_traces').get().c;
  const avg = db.prepare('SELECT COALESCE(AVG(latency_ms),0) v FROM chat_traces').get().v;
  const toolUses = db.prepare("SELECT tool_calls FROM chat_traces WHERE tool_calls != '[]'").all()
    .reduce((s, r) => { try { return s + JSON.parse(r.tool_calls).length; } catch { return s; } }, 0);
  const kbHits = db.prepare("SELECT kb_hits FROM chat_traces WHERE kb_hits != '[]'").all()
    .reduce((s, r) => { try { return s + JSON.parse(r.kb_hits).length; } catch { return s; } }, 0);
  res.json({ code: 0, data: { total, traced, avgLatency: Math.round(avg), toolUses, kbHits } });
});

module.exports = router;
