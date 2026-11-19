/**
 * U0-6 A2A Agent Card 暴露 + Task 端点（2026-11-13）
 *
 * 遵循 A2A（Agent-to-Agent）协议 1.0 GA 规范（Linux 基金会 / Agentic AI Foundation），
 * 使外部智能体（LangGraph / CrewAI / Google ADK 等）可以发现并调用本平台已发布智能体。
 *
 * 端点：
 *   GET  /.well-known/agent-card.json   — 平台级 Agent Card（能力声明 + 已发布智能体列表）
 *   GET  /api/a2a/agents/:id/card      — 单个智能体的 Agent Card
 *   POST /api/a2a/tasks                — 创建任务（JSON-RPC，外部智能体调用）
 *   GET  /api/a2a/tasks/:id            — 查询任务状态（Task 八态生命周期）
 *
 * 安全模型：
 *   - /.well-known/agent-card.json 公开访问（发现用）
 *   - /api/a2a/* 需要 Bearer Token（与 MCP Server 共享 mcp_tokens 表或独立 a2a_tokens）
 */
const express = require('express');
const { db, now } = require('../db');
const { runAgent } = require('../lib/workflow');
const { auth, adminOnly } = require('../lib/auth');
const jws = require('../lib/a2a-jws');
const a2aOauth = require('../lib/a2a-oauth');

// 免 auth：/.well-known/agent-card.json 公开
const publicRouter = express.Router();
const authRouter = express.Router();
const adminRouter = express.Router(); // U2-7 Phase 3：密钥管理（平台 auth + adminOnly）

/* ---------- Task 八态 ---------- */
const TASK_STATES = ['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled', 'input-required'];

/* ---------- 帮助函数 ---------- */

function safeParse(s, def) {
  try { return JSON.parse(s || '') || def; } catch { return def; }
}

/**
 * 为某智能体生成 Agent Card
 */
function buildAgentCard(agent) {
  const wf = safeParse(agent.workflow || '{}', {});
  const pwf = safeParse(agent.published_workflow || '{}', {});
  const inputs = pwf.nodes ? pwf.nodes.filter(n => n.type === 'start' || n.type === 'StartNode').flatMap(n => {
    const v = n.data?.variables || [];
    return Array.isArray(v) ? v.map(x => ({ name: x.name || '', type: x.type || 'string', required: x.required ?? true })) : [];
  }) : [];
  const outputs = pwf.nodes ? pwf.nodes.filter(n => n.type === 'end' || n.type === 'EndNode').flatMap(n => {
    const v = n.data?.outputVariables || n.data?.outputs || [];
    return Array.isArray(v) ? v.map(x => ({ name: typeof x === 'string' ? x : (x.name || ''), type: 'string' })) : [];
  }) : [];
  return {
    agent_id: agent.id,
    name: agent.name,
    description: agent.description || '',
    icon: agent.icon || '🤖',
    skills: (() => {
      try { return JSON.parse(agent.tools || '[]').map(t => ({ name: t, type: 'builtin_tool' })); } catch { return []; }
    })(),
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(inputs.map(i => [i.name, { type: i.type, description: i.name }])),
      required: inputs.filter(i => i.required).map(i => i.name),
    },
    output_schema: {
      type: 'object',
      properties: Object.fromEntries(outputs.map(i => [i.name, { type: i.type }])),
    },
    authentication: 'bearer',
    transport: ['streamable_http', 'json_rpc'],
    status: agent.status === 'published' ? 'active' : 'inactive',
    version: agent.version || 1,
    updated_at: agent.updated_at || agent.created_at,
  };
}

/* ---------- /.well-known/agent-card.json（公开） ---------- */

publicRouter.get('/.well-known/agent-card.json', (req, res) => {
  const agents = db.prepare("SELECT id,name,description,icon,tools,workflow,published_workflow,status,updated_at,created_at FROM agents WHERE status='published'").all();
  const cards = agents.map(a => buildAgentCard(a));
  res.json({
    schema: 'agent-card-v1',
    platform: { name: '智能体开发平台', version: 'p5.37', a2a_version: '1.0' },
    agents: cards,
    total: cards.length,
    generated_at: new Date().toISOString(),
  });
});

/* ---------- U2-7 Phase 3：OAuth client_credentials 令牌端点（RFC 7523 private_key_jwt） ----------
 * 挂在 publicRouter（自身以 client_assertion 鉴权）；单独挂 body 解析器——server.js 中
 * express.json() 注册在 publicRouter 之后，此处需自带解析。 */
publicRouter.post('/api/a2a/oauth/token',
  express.json({ limit: '1mb' }), express.urlencoded({ extended: false, limit: '1mb' }),
  (req, res) => {
    const { grant_type, client_assertion, client_assertion_type } = req.body || {};
    if (grant_type !== 'client_credentials') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (client_assertion_type !== a2aOauth.ASSERTION_TYPE) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_assertion_type 非法' });
    }
    const self = req.protocol + '://' + (req.headers.host || '') + String(req.originalUrl || '').split('?')[0];
    const r = a2aOauth.exchangeClientCredentials({
      assertion: client_assertion,
      expectedAud: process.env.A2A_TOKEN_AUDIENCE || self,
    });
    if (r.error) return res.status(401).json({ error: r.error, error_description: r.error_description });
    res.json(r);
  });

/* ---------- U2-7 Phase 3：密钥管理路由（平台管理员） ---------- */

adminRouter.use(auth, adminOnly);

// 列出密钥（不含私钥）
adminRouter.get('/keys', (req, res) => {
  res.json({ code: 0, data: { list: jws.listKeys() } });
});

// 新建密钥：私钥仅此响应返回一次
adminRouter.post('/keys', (req, res) => {
  const { name, owner, org_name, alg, scopes, expires_at } = req.body || {};
  if (alg && !jws.ALLOWED_ALGS.includes(alg)) return res.json({ code: 400, msg: '不支持的算法（仅 RS256/ES256）' });
  const k = jws.createKey({
    name: name || '', owner: owner || req.user.username || '', orgName: org_name || '',
    alg: alg || 'RS256', scopes: scopes || 'a2a:call', expiresAt: expires_at || '',
  });
  res.json({ code: 0, data: k, msg: '私钥仅返回一次，请妥善保存' });
});

// 停用密钥
adminRouter.post('/keys/:kid/disable', (req, res) => {
  const ok = jws.disableKey(req.params.kid);
  res.json({ code: ok ? 0 : 404, msg: ok ? '已停用' : '密钥不存在' });
});

/* ---------- API 认证路由 ---------- */

authRouter.use(auth);

// 单个智能体的 Agent Card
authRouter.get('/a2a/agents/:id/card', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND status=?').get(req.params.id, 'published');
  if (!agent) return res.json({ code: 404, msg: '智能体不存在或未发布' });
  res.json({ code: 0, data: buildAgentCard(agent) });
});

// 创建任务（A2A Task）
authRouter.post('/a2a/tasks', async (req, res) => {
  const { agent_id, input, session_id, metadata } = req.body || {};
  if (!agent_id) return res.json({ code: 400, msg: '请指定 agent_id' });
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND status=?').get(agent_id, 'published');
  if (!agent) return res.json({ code: 404, msg: '智能体不存在或未发布' });
  const taskId = 'a2a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  // 记录 A2A 任务 start
  db.prepare(`INSERT INTO a2a_tasks (task_id, agent_id, agent_name, input, status, meta, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'submitted',?,?,?,?)`)
    .run(taskId, agent_id, agent.name, JSON.stringify(input || ''), JSON.stringify(metadata || {}), req.user.username || 'a2a-client', now(), now());
  // 返回 task_id，执行异步
  res.json({ code: 0, data: { task_id: taskId, status: 'submitted' } });
  // 异步执行
  try {
    db.prepare("UPDATE a2a_tasks SET status='working', updated_at=? WHERE task_id=?").run(now(), taskId);
    const r = await runAgent(agent, String(input?.message || input?.text || input || ''), { triggerType: 'a2a', sessionId: session_id });
    const output = { text: r.text || r };
    db.prepare("UPDATE a2a_tasks SET status='completed', output=?, updated_at=? WHERE task_id=?").run(JSON.stringify(output), now(), taskId);
  } catch (e) {
    db.prepare("UPDATE a2a_tasks SET status='failed', error=?, updated_at=? WHERE task_id=?").run(String(e.message).slice(0, 500), now(), taskId);
  }
});

// 查询任务状态
authRouter.get('/a2a/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM a2a_tasks WHERE task_id=?').get(req.params.id);
  if (!task) return res.json({ code: 404, msg: '任务不存在' });
  res.json({ code: 0, data: task });
});

// 列出任务
authRouter.get('/a2a/tasks', (req, res) => {
  const { status, page = 1, pageSize = 50 } = req.query;
  let sql = 'SELECT * FROM a2a_tasks WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  args.push(+pageSize, (+page - 1) * +pageSize);
  const rows = db.prepare(sql).all(...args);
  res.json({ code: 0, data: { list: rows, page: +page, pageSize: +pageSize } });
});

module.exports = { publicRouter, authRouter, adminRouter };