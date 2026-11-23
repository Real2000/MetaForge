/**
 * MCP Server 端点（2026-10-22 P3 ⑤）：把已发布智能体暴露为 MCP 工具
 * - POST /mcp          Streamable HTTP + JSON-RPC 2.0（initialize / tools/list / tools/call / ping）
 * - Bearer 令牌鉴权（mcp_tokens 表，管理员在「MCP 服务」页生成/停用/删除）
 * - GET/POST/DELETE /api/mcp-server/...  服务端信息与令牌管理（管理员）
 * 注意路径避让：客户端管理路由已占用 /api/mcp（routes/mcp.js），本端点用 /mcp 与 /api/mcp-server
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { runAgent } = require('../lib/workflow');
const { extractApiContract, buildMcpInputSchema } = require('../lib/api-doc'); // P5.16：文档/schema 同源
const { hashKey, maskPrefix } = require('../lib/apikey'); // SEC-02a：令牌哈希存储/比对

const router = express.Router();

// CORS（浏览器内 MCP 客户端跨域调用放行；本地客户端不受影响）
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** 执行智能体（MCP 工具调用）：经统一入口 runAgent——画布模式按编排图执行（P5.16：结构化参数注入 start 变量），表单模式走提示词+知识库检索 */
async function runAgentAsTool(agent, input, inputVars) {
  const r = await runAgent(agent, String(input ?? ''), { triggerType: 'mcp', inputVars });
  return r.text;
}

function listPublishedAgents() {
  return dal.q(`SELECT id,name,description,edit_mode,routing_mode,workflow FROM agents WHERE status='published' ORDER BY id`);
}

// ================= MCP 协议端点（POST /mcp，Bearer 令牌） =================
router.post('/', async (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  // SEC-02a：库中 token 列为 HMAC 哈希——按哈希比对
  const tk = dal.getq('SELECT * FROM mcp_tokens WHERE token=? AND status=1', [hashKey(token)]);
  if (!tk) {
    return res.status(401).json({ jsonrpc: '2.0', id: (req.body || {}).id ?? null, error: { code: -32001, message: 'Unauthorized: invalid or disabled MCP token' } });
  }
  const msg = req.body || {};
  const { id, method, params } = msg;
  // notification（无 id）：确认类通知一律 202 空响应（Streamable HTTP 规范）
  if (id === undefined || id === null) {
    try { dal.runq('UPDATE mcp_tokens SET last_used_at=? WHERE id=?', [now(), tk.id]); } catch { }
    return res.status(202).end();
  }
  const ok = result => res.json({ jsonrpc: '2.0', id, result });
  const err = (code, message) => res.status(200).json({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-platform-mcp', version: '1.0.0', title: '智能体平台 MCP 服务' },
          instructions: '本服务把平台已发布智能体暴露为 MCP 工具（agent_{id}）。画布工作流的工具参数由 Start 节点变量自动生成（input + 自定义变量，文件参数传上传后的文件 ID）；表单模式传 input 任务文本即可（task 为兼容别名）。工具清单与参数 schema 见 tools/list；完整接口文档在平台管理端「智能体管理 → 📄 文档」。',
        });
      case 'ping':
        return ok({});
      case 'tools/list': {
        const agents = listPublishedAgents();
        // SEC-02a：取消全域令牌——仅暴露令牌绑定的智能体（未绑定的令牌不返回任何工具）
        const scoped = agents.filter(a => a.id === tk.agent_id);
        return ok({
          tools: scoped.map(a => {
            const c = extractApiContract(a);
            return {
              name: `agent_${a.id}`,
              description: `${a.name}：${(a.description || '专业智能体').slice(0, 200)}${c.isCanvas ? `（画布工作流执行，参数：${c.input.map(p => p.name + (p.type === 'file' || p.type === 'array[file]' ? '📄' : '')).join(' / ')}）` : ''}`,
              inputSchema: buildMcpInputSchema(a), // P5.16：Start 节点变量自动生成（调用方客户端直接看到参数表）
            };
          }),
        });
      }
      case 'tools/call': {
        const name = (params || {}).name || '';
        const m = /^agent_(\d+)$/.exec(name);
        if (!m) return err(-32602, `Invalid tool name: ${name}（工具名形如 agent_{id}，请先 tools/list 查看清单）`);
        // SEC-02a：取消全域令牌——必须绑定具体智能体才可调用
        if (!tk.agent_id) {
          return ok({ content: [{ type: 'text', text: '令牌未绑定智能体（全域令牌已停用，请重新生成绑定到具体智能体的令牌）' }], isError: true });
        }
        if (tk.agent_id !== +m[1]) {
          return ok({ content: [{ type: 'text', text: `令牌无权访问该智能体（令牌已绑定作用域，仅可调用 agent_${tk.agent_id}）` }], isError: true });
        }
        const agent = dal.getq(`SELECT * FROM agents WHERE id=? AND status='published'`, [+m[1]]);
        if (!agent) return ok({ content: [{ type: 'text', text: `智能体不存在或未发布：${name}` }], isError: true });
        // P5.16：arguments 按参数 schema 展开——input（task 兼容别名）+ Start 节点变量直达（file 类型传文件 ID）
        const args = (params || {}).arguments || {};
        const input = args.input !== undefined ? args.input : args.task;
        if (!input || !String(input).trim()) return ok({ content: [{ type: 'text', text: '缺少 input 参数：请把任务描述传入 input（task 为兼容别名）；画布工作流的结构化参数名见 tools/list 的 inputSchema。' }], isError: true });
        const inputVars = {};
        for (const [k, v] of Object.entries(args)) {
          if (k === 'input' || k === 'task') continue;
          inputVars[k] = v; // 非定义变量由 Runner 自然忽略（start 只取声明过的 variables）
        }
        try {
          const text = await runAgentAsTool(agent, String(input), inputVars);
          try { dal.runq('UPDATE mcp_tokens SET calls=calls+1, last_used_at=? WHERE id=?', [now(), tk.id]); } catch { }
          return ok({ content: [{ type: 'text', text: text || '（智能体未返回内容）' }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `智能体执行失败：${e.message}` }], isError: true });
        }
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, 'Internal error: ' + e.message);
  }
});

// ================= 服务端管理（/api/mcp-server/*，管理员） =================
// 信息卡：端点地址 / 协议 / 鉴权方式 / 可用工具清单
router.get('/info', auth, adminOnly, (req, res) => {
  const agents = listPublishedAgents();
  const host = req.get('host') || `localhost:${process.env.PORT || 3210}`;
  res.json({
    code: 0, data: {
      endpoint: `http://${host}/mcp`,
      protocol: 'Streamable HTTP（JSON-RPC 2.0）',
      auth: 'Authorization: Bearer <令牌>',
      commands: { initialize: 'initialize', tools_list: 'tools/list', tools_call: 'tools/call' },
      tools: agents.map(a => ({ name: `agent_${a.id}`, agent: a.name, description: (a.description || '').slice(0, 100), params: extractApiContract(a).input.map(p => `${p.name}${p.required ? '*' : ''}:${p.type}`.replace(/(file|array\[file\])/, '📄$1')).join(' · ') })),
      hint: '在 MCP 客户端（Claude Code / Cursor / Cherry Studio 等）添加自定义 MCP 服务器：URL 填上方端点，鉴权头填 Authorization: Bearer <令牌>，即可调用平台已发布智能体。生成令牌时必须绑定单个智能体（作用域令牌仅能调用绑定的智能体，最小授权；全域令牌已停用）。',
    },
  });
});

// 令牌列表（脱敏展示：仅前缀掩码，不回传哈希；P2-2：附带 agent_id/agent_name 作用域信息）
router.get('/tokens', auth, adminOnly, (req, res) => {
  const rows = dal.q(`SELECT t.id, t.name, t.agent_id, t.status, t.calls, t.last_used_at, t.created_at, t.token_prefix, a.name AS agent_name
    FROM mcp_tokens t LEFT JOIN agents a ON a.id = t.agent_id ORDER BY t.id DESC`)
    .map(t => ({ ...t, token: t.token_prefix || '' }));
  res.json({ code: 0, data: rows });
});

// 生成令牌（创建时完整返回一次，之后列表脱敏）
// SEC-02a：仅存哈希 + 前缀掩码；取消全域令牌——必须绑定具体已发布智能体（D-3：仅 agent 级 + space/租户级）
router.post('/tokens', auth, adminOnly, (req, res) => {
  const name = String((req.body || {}).name || '').slice(0, 30) || 'MCP 令牌';
  const raw = (req.body || {}).agent_id;
  if (raw === undefined || raw === null || raw === '') return res.json({ code: 400, msg: '必须绑定一个已发布智能体（全域令牌已停用）' });
  const agentId = Number(raw);
  if (!Number.isInteger(agentId) || agentId <= 0) return res.json({ code: 400, msg: 'agent_id 参数非法（正整数）' });
  const agent = dal.getq("SELECT id, name FROM agents WHERE id=? AND status='published'", [agentId]);
  if (!agent) return res.json({ code: 400, msg: '绑定的智能体不存在或未发布' });
  const token = 'mcp_' + crypto.randomBytes(24).toString('hex');
  dal.runq('INSERT INTO mcp_tokens (token,token_prefix,name,agent_id,status,created_at) VALUES (?,?,?,?,1,?)', [hashKey(token), maskPrefix(token), name, agentId, now()]);
  res.json({ code: 0, data: { token, name, agent_id: agentId }, msg: '令牌已生成（已绑定智能体作用域，仅本次完整展示，请立即保存）' });
});

// 停用 / 启用
router.patch('/tokens/:id', auth, adminOnly, (req, res) => {
  const row = dal.getq('SELECT * FROM mcp_tokens WHERE id=?', [+req.params.id]);
  if (!row) return res.json({ code: 404, msg: '令牌不存在' });
  dal.runq('UPDATE mcp_tokens SET status=? WHERE id=?', [row.status ? 0 : 1, row.id]);
  res.json({ code: 0, msg: row.status ? '已停用' : '已启用' });
});

// 删除令牌
router.delete('/tokens/:id', auth, adminOnly, (req, res) => {
  dal.runq('DELETE FROM mcp_tokens WHERE id=?', [+req.params.id]);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
