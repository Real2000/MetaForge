/** 会话 + 对话（SSE 流式：敏感词→知识库检索→模型/模拟→输出过滤→落库统计） */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { chat, chatOnce } = require('../lib/llm');
const { retrieve } = require('../lib/retriever');
const { check, countHits, mask, detectPII, maskPII, detectInjection, logSecurityEvent } = require('../lib/security');
const dify = require('../lib/dify');
const coze = require('../lib/coze');
const { buildTools, runTool, loadMcpTools, toolRiskOf, AGENT_TOOL_DENY } = require('../lib/tools');
const skills = require('../lib/skills');
const { checkQuota, addUsage } = require('../lib/quota');
const { parseSkillMentions, parseAgentMentions } = require('../lib/skill-mention');
const { canView } = require('../lib/agent-access');
const { finishExternalTurn } = require('../lib/chat-sink'); // P5.33：外部/技能链路统一收尾（唯一记账/落库/审计点）

const router = express.Router();

// V1.2 审查加固 2026-10-30：resolveKbFilter 迁至 lib/kb-metadata.js（chat/share/openapi/workflow 四链路共用；
// 挂 router 导出会引发 workflow→chat 循环依赖）；此处引用，文件尾透传导出（smoke 单测沿用 chat.js 入口）
const { resolveKbFilter } = require('../lib/kb-metadata');

// P5.25 工具确认等待队列（模块级）：stream 请求注册等待 → /confirm 决议路由跨请求唤醒
const toolConfirmRegistry = new Map(); // key → { resolve, username, expires }
router.use(auth);

/** 生成用户问题建议（3 条追问）。失败返回空数组，不影响对话主流程 */
async function genSuggestions(userInput, assistantReply, agentName) {
  try {
    const r = await chatOnce([
      { role: 'system', content: `你是追问建议生成器。根据用户的提问与智能体的回答，生成 3 条用户最可能想继续追问的问题。
规则：每条不超过 25 字；紧扣上文、有递进价值；输出纯 JSON 数组格式（如 ["问题1","问题2","问题3"]），不要其他任何文字。` },
      { role: 'user', content: `智能体：${agentName || 'AI 助手'}\n用户提问：${userInput.slice(0, 300)}\n智能体回答（节选）：${(assistantReply || '').slice(0, 600)}` },
    ], { temperature: 0.5, max_reply: 200, agentName: '追问建议' });
    const m = (r.full || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return arr.filter(x => typeof x === 'string' && x.trim()).slice(0, 3).map(x => x.trim().slice(0, 30));
  } catch { return []; }
}

/** 长期记忆提取（借鉴 SinguX「记忆-长期记忆」）：从本轮对话中提取值得跨会话记住的用户特征事实，
 *  去重后落库 agent_memories。失败静默，不影响对话主流程 */
async function extractMemory(agent, username, userInput, assistantReply) {
  try {
    const existing = db.prepare('SELECT fact FROM agent_memories WHERE agent_id=? AND username=?').all(agent.id, username).map(r => r.fact);
    const r = await chatOnce([
      { role: 'system', content: `你是用户记忆提取器。根据对话内容提取值得长期记住的当前用户特征事实（如职业、偏好、称呼、业务背景），忽略一次性问题内容。
规则：只输出 JSON 数组（如 ["用户是银行客户经理","用户偏好简洁回复"]），最多 3 条，每条不超过 25 字；没有值得记住的内容输出 []；不要其他任何文字。` },
      { role: 'user', content: `已知记忆：${existing.join('；') || '（无）'}\n用户提问：${userInput.slice(0, 200)}\n智能体回答（节选）：${(assistantReply || '').slice(0, 300)}` },
    ], { temperature: 0.3, max_reply: 150, agentName: '记忆提取' });
    const m = (r.full || '').match(/\[[\s\S]*\]/);
    if (!m) return;
    const facts = JSON.parse(m[0]).filter(x => typeof x === 'string' && x.trim()).slice(0, 3).map(x => x.trim().slice(0, 40));
    for (const f of facts) {
      if (existing.some(e => e.includes(f) || f.includes(e))) continue; // 去重（含互为子串）
      db.prepare('INSERT INTO agent_memories (agent_id,username,fact,created_at) VALUES (?,?,?,?)').run(agent.id, username, f, now());
    }
  } catch { /* 静默 */ }
}

/** 会话标题自动生成（P2）：首条对话后把「新会话」替换为语义化标题；失败回退输入前 20 字。
 *  生成后经 SSE 'title' 事件推送，前端实时更新侧栏会话列表，无需刷新 */
async function genSessionTitle(sessionId, userInput, agentName) {
  try {
    const sess = db.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId);
    if (!sess || (sess.title !== '新会话' && sess.title !== '默认会话')) return null; // 仅首次命名
    const r = await chatOnce([
      { role: 'system', content: '你会话标题生成器。根据用户的第一条提问，生成一个 4~12 字的简洁中文标题（名词短语，无标点、无引号）。只输出标题本身。' },
      { role: 'user', content: `智能体：${agentName || 'AI 助手'}\n用户提问：${userInput.slice(0, 200)}` },
    ], { temperature: 0.3, max_reply: 30, agentName: '标题生成' });
    let title = (r.full || '').trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 20);
    if (!title || title.includes('\n')) title = userInput.trim().slice(0, 20); // 兜底：输入截断
    db.prepare('UPDATE sessions SET title=? WHERE id=?').run(title, sessionId);
    return title;
  } catch {
    const fallback = userInput.trim().slice(0, 20);
    try { db.prepare("UPDATE sessions SET title=? WHERE id=? AND (title='新会话' OR title='默认会话')").run(fallback, sessionId); } catch { }
    return fallback;
  }
}

// 会话列表（P3：支持 keyword 关键词搜索——命中会话标题或任意消息内容）
router.get('/sessions', (req, res) => {
  const { agent_id, keyword } = req.query;
  let sql = 'SELECT s.*, a.name AS agent_name FROM sessions s LEFT JOIN agents a ON a.id=s.agent_id WHERE s.username=?';
  const args = [req.user.username];
  if (agent_id && agent_id !== 'home') { sql += ' AND s.agent_id=?'; args.push(agent_id); }
  else if (agent_id === 'home') {
    sql += ' AND s.agent_id IS NULL';
  }
  const kw = String(keyword || '').trim();
  if (kw) {
    sql += ' AND (s.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.content LIKE ?))';
    args.push(`%${kw}%`, `%${kw}%`);
  }
  sql += ' ORDER BY s.updated_at DESC LIMIT 100';
  res.json({ code: 0, data: db.prepare(sql).all(...args) });
});

// 会话消息（关联 chat_traces 回填引用来源与工具调用，历史消息同样可见；含追问建议）
// P5.30 安全止血：此前仅按 session_id 查询、不校验归属——任何登录用户可凭他人会话 id 读取全部对话内容（IDOR）。
// 对齐评价类路由的归属校验模式；管理端查用户会话走 /api/stats/*（已有 adminOnly 防护），本路由保持仅本人可读
router.get('/sessions/:id/messages', (req, res) => {
  const sess = db.prepare('SELECT username FROM sessions WHERE id=?').get(req.params.id);
  if (!sess) return res.json({ code: 404, msg: '会话不存在' });
  if (sess.username !== req.user.username) return res.json({ code: 403, msg: '无权访问该会话' });
  const rows = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(req.params.id);
  const traceStmt = db.prepare('SELECT kb_hits, tool_calls, suggestions FROM chat_traces WHERE message_id=? ORDER BY id DESC LIMIT 1');
  const out = rows.map(m => {
    if (m.role !== 'assistant') return m;
    const t = traceStmt.get(m.id);
    if (!t) return m;
    try {
      return { ...m, kbHits: JSON.parse(t.kb_hits || '[]'), toolCalls: JSON.parse(t.tool_calls || '[]'), suggestions: JSON.parse(t.suggestions || '[]') };
    } catch { return m; }
  });
  res.json({ code: 0, data: out });
});

// ---------- 对话质量反馈（2026-10-20 体验优化） ----------
// 👍/👎 消息级评价落库（校验消息属于本人会话；再次点击同一值=取消，不同值=改评）
router.post('/messages/:id/rating', (req, res) => {
  const m = db.prepare('SELECT m.*, s.username FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  if (m.username !== req.user.username) return res.json({ code: 403, msg: '只能评价自己会话中的消息' });
  const v = (req.body || {}).value === 1 ? 1 : ((req.body || {}).value === -1 ? -1 : 0);
  if (!v) return res.json({ code: 400, msg: '评价值无效（1 或 -1）' });
  db.prepare('UPDATE messages SET rating=? WHERE id=?').run(m.rating === v ? 0 : v, m.id);
  res.json({ code: 0, msg: m.rating === v ? '已取消评价' : '感谢你的反馈' });
});

// 「这个回答解决你的问题了吗」二选一调研落库（1=解决了 0=没解决）
router.post('/messages/:id/solved', (req, res) => {
  const m = db.prepare('SELECT m.*, s.username FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  if (m.username !== req.user.username) return res.json({ code: 403, msg: '只能评价自己会话中的消息' });
  const v = (req.body || {}).value ? 1 : 0;
  db.prepare('UPDATE messages SET solved=? WHERE id=?').run(v ? 1 : 2, m.id);
  res.json({ code: 0, msg: '感谢你的反馈' });
});

// 管理端对话质量报表（admin）：差评/未解决消息 + 上下文问题 + 统计
router.get('/quality', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.session_id, m.content, m.rating, m.solved, m.created_at,
           s.username, s.agent_id, s.title AS session_title,
           u.nickname, a.name AS agent_name,
           (SELECT content FROM messages pm WHERE pm.session_id=m.session_id AND pm.role='user' AND pm.id<m.id ORDER BY pm.id DESC LIMIT 1) AS question
    FROM messages m
    JOIN sessions s ON s.id=m.session_id
    LEFT JOIN users u ON u.username=s.username
    LEFT JOIN agents a ON a.id=s.agent_id
    WHERE m.role='assistant' AND (m.rating=-1 OR m.solved=2)
    ORDER BY m.id DESC LIMIT 200`).all();
  const stat = {
    rated_up: db.prepare("SELECT COUNT(*) c FROM messages WHERE rating=1").get().c,
    rated_down: db.prepare("SELECT COUNT(*) c FROM messages WHERE rating=-1").get().c,
    solved_yes: db.prepare("SELECT COUNT(*) c FROM messages WHERE solved=1").get().c,
    solved_no: db.prepare("SELECT COUNT(*) c FROM messages WHERE solved=2").get().c,
  };
  stat.satisfaction = (stat.rated_up + stat.rated_down) ? Math.round(stat.rated_up / (stat.rated_up + stat.rated_down) * 100) : null;
  stat.resolve_rate = (stat.solved_yes + stat.solved_no) ? Math.round(stat.solved_yes / (stat.solved_yes + stat.solved_no) * 100) : null;
  res.json({ code: 0, data: { list: rows, stat } });
});

/** 子智能体编排（SinguX 式：主智能体作为编排器，把子智能体注册为 function calling 工具路由执行）
 *  每个子智能体注册为 agent_call_{slug}，参数 {task}；执行时载入子智能体配置（提示词/模型/知识库）一次性调用 */
function buildChildTools(childIds) {
  let ids = [];
  try { ids = JSON.parse(childIds || '[]'); } catch { }
  if (!ids.length) return [];
  // P3 修复（2026-10-22）：补 tools/mcp_servers 列——子智能体编排执行时同样启用其挂载的工具
  // V1.2 #2 2026-10-30：补 kb_metadata_filter 列——子智能体知识库检索同样联动其元数据过滤声明
  const children = db.prepare(`SELECT id,name,description,prompt,model,temperature,top_p,max_reply,kb_id,kb_metadata_filter,tools,mcp_servers FROM agents WHERE id IN (${ids.map(() => '?').join(',')}) AND status='published'`).all(...ids);
  return children.map(c => ({
    schema: {
      type: 'function',
      function: {
        name: `agent_call_${c.id}`,
        description: `调用子智能体「${c.name}」完成任务。${(c.description || '').slice(0, 120)}。适用时把需要它处理的完整任务描述传入 task 参数。`,
        parameters: {
          type: 'object',
          properties: { task: { type: 'string', description: '交给该子智能体执行的完整任务描述（含必要背景）' } },
          required: ['task'],
        },
      },
    },
    child: c,
  }));
}

/** 执行子智能体：注入其提示词 + 知识库检索；P3 修复（2026-10-22）：子智能体配置了工具/MCP 时
 *  走 chat() 完整工具循环（真实执行 function calling），而非 chatOnce 纯文本一次性调用（防 LLM 编造工具输出）；无工具时保持原链路
 *  V1.2 #2 2026-10-30：user 参数——子智能体检索同样按其 kb_metadata_filter 过滤（$user.dept 按发起用户部门解析） */
async function runChildAgent(child, task, maxReply, user) {
  let system = child.prompt || '你是「' + child.name + '」，请专业、准确地完成交给你的任务。';
  if (child.kb_id) {
    // V1.2 #2：子智能体知识库检索联动元数据过滤（原调用仅 3 参，threshold 0.01 为其原默认值）
    const hits = await retrieve(task, child.kb_id, 4, 0.01, { metadataFilter: resolveKbFilter(child, user) || undefined });
    if (hits.length) {
      system += `\n\n以下是知识库检索到的相关内容，请优先依据这些内容：\n${hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n')}`;
    }
  }
  const opts = { model: child.model, temperature: child.temperature ?? 0.5, top_p: child.top_p, max_reply: Math.min(child.max_reply || 1024, 2048), agentName: child.name };
  // P3：子智能体自带工具 → 完整工具循环（工具真实执行）；否则纯文本一次调用
  let childToolIds = [];
  try { childToolIds = JSON.parse(child.tools || '[]'); } catch { }
  const childMcpTools = loadMcpTools(child.mcp_servers || '[]');
  const schemas = buildTools(childToolIds, childMcpTools, []);
  if (schemas.length) {
    const gen = chat([
      { role: 'system', content: system },
      { role: 'user', content: String(task || '').slice(0, 4000) },
    ], {
      ...opts,
      tools: schemas,
      // P5.34b（审查 F1）：子智能体工具执行闸门——与 workflow.runAgent 的 UNATTENDED_DENY 同构。
      // 此前为 runTool 直调（无确认卡也无 deny），存量含 create_task 的子智能体在 perm=auto 下可静默造任务
      executeTool: (name, argsJson) => {
        if (name === 'create_task' || name === 'local_exec') {
          return `⛔ 工具 ${name} 不允许在子智能体执行上下文中调用——请直接完成当前任务，不要尝试创建新任务或操作本地设备。`;
        }
        // V1.2 审查加固 2026-10-30：子智能体工具执行同样受元数据过滤约束（kb_search 旁路收口）
        return runTool(name, argsJson, { kbId: child.kb_id || null, mcpServers: child.mcp_servers || '[]', metadataFilter: resolveKbFilter(child, user) || undefined });
      },
    });
    let full = '';
    while (true) {
      const r = await gen.next();
      if (r.done) { full = r.value.full; break; }
    }
    return (full || '').slice(0, 4000);
  }
  const r = await chatOnce([
    { role: 'system', content: system },
    { role: 'user', content: String(task || '').slice(0, 4000) },
  ], opts);
  return (r.full || '').slice(0, 4000);
}

/** ⑦ 分类器路由（2026-10-22 P3）：routing_mode='classifier' 时先用轻量意图分类直达子智能体，低置信回退主模型 function calling */
async function classifyIntent(input, agent, childTools) {
  const list = childTools.map(c => `- agent_${c.child.id}（${c.child.name}）：${(c.child.description || '专业子智能体').slice(0, 80)}`).join('\n');
  const r = await chatOnce([
    { role: 'system', content: '你是意图路由分类器。根据用户输入判断应交给哪个子智能体处理。只输出 JSON，不要任何其他文字。' },
    {
      role: 'user', content: `可选子智能体：\n${list}\n\n用户输入：${String(input).slice(0, 1000)}\n\n规则：若某个子智能体明显匹配则选它；都不合适、属于通用问题或需要多智能体协作时选 null。\n只输出 JSON：{"agent_id": <数字或null>, "confidence": <0~1小数>, "reason": "<≤30字>"}`,
    },
  ], { model: agent.model, temperature: 0.1, max_reply: 200 });
  const m = /\{[\s\S]*\}/.exec(r.full || '');
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const conf = Math.min(1, Math.max(0, +j.confidence || 0));
    if (j.agent_id == null || conf < 0.6) return null;
    const c = childTools.find(t => +t.child.id === +j.agent_id);
    return c ? { child: c.child, confidence: conf, reason: j.reason || '' } : null;
  } catch { return null; }
}

router.post('/sessions', (req, res) => {
  const { agent_id, title } = req.body || {};
  const info = db.prepare('INSERT INTO sessions (agent_id,title,username,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(agent_id || null, title || '新会话', req.user.username, now(), now());
  // 广场使用统计：创建智能体会话时 +1（SinguX 广场卡片使用数口径）
  if (agent_id) {
    try { db.prepare('UPDATE agents SET use_count=use_count+1 WHERE id=?').run(agent_id); } catch { }
  }
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.delete('/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=? AND username=?').run(req.params.id, req.user.username);
  db.prepare('DELETE FROM messages WHERE session_id=?').run(req.params.id);
  res.json({ code: 0, msg: '已删除' });
});

router.patch('/sessions/:id', (req, res) => {
  db.prepare('UPDATE sessions SET title=? WHERE id=? AND username=?').run((req.body || {}).title || '新会话', req.params.id, req.user.username);
  res.json({ code: 0 });
});

// 可用模型列表（前台首页下拉）。
// P4（2026-10-22）：模型类型分类（chat/image/video/tts/embedding），前台四模式模型隔离按 type 过滤
const { classifyModel } = require('../lib/model-types');

router.get('/models', (req, res) => {
  const ps = db.prepare('SELECT name, models, configured, api_key, is_default FROM providers WHERE configured=1').all();
  const out = [];
  for (const p of ps) {
    let ms = [];
    try { ms = JSON.parse(p.models || '[]'); } catch { ms = []; }
    // P4（2026-10-22）：全量返回（对话/生图/视频/语音/嵌入），type 分类由前端按模式隔离；不再用 isChatModel 过滤
    ms.forEach(m => out.push({ name: m, provider: p.name, real: !!(p.api_key), is_default: p.is_default, source: 'platform', type: classifyModel(m) }));
  }
  // P3 用户自有模型：本人启用中的模型源追加（自带 Key，下拉标注「我的」；类型实时分类）
  const ups = db.prepare("SELECT id, name, models FROM user_providers WHERE username=? AND status=1 AND api_key != '' AND base_url != '' ORDER BY id").all(req.user.username);
  for (const up of ups) {
    let ms = [];
    try { ms = JSON.parse(up.models || '[]'); } catch { ms = []; }
    ms.forEach(m => out.push({ name: m, provider: up.name + '（我的）', real: true, is_default: 0, source: 'user', type: classifyModel(m) }));
  }
  // 去重：同名模型用户自有优先（自带 Key 优先路由），平台默认供应商次之，先到先得；
  // 用户条目覆盖平台同名条目时保留 is_default 标记（不影响下拉默认选中）
  const seen = new Map();
  for (const m of out) {
    const prev = seen.get(m.name);
    if (!prev) { seen.set(m.name, m); continue; }
    if (m.source === 'user' && prev.source !== 'user') {
      seen.set(m.name, { ...m, is_default: prev.is_default || m.is_default });
    } else if (m.is_default && !prev.is_default) {
      seen.set(m.name, { ...prev, is_default: 1 });
    }
  }
  const list = [...seen.values()];
  if (!list.length) list.push({ name: 'demo-simulate', provider: '内置演示引擎', real: false, is_default: 1 });
  res.json({ code: 0, data: list });
});

/**
 * P5.25 工具执行确认决议：{ key, approve: true/false }（「默认权限」下前端确认卡回调）
 * 校验归属（仅发起用户本人可决议）与时效；批准唤醒等待的 executeTool 继续执行，拒绝则返回拒因。
 */
router.post('/confirm', (req, res) => {
  const { key, approve } = req.body || {};
  if (!key) return res.status(400).json({ code: 400, msg: '缺少 key' });
  const entry = toolConfirmRegistry.get(key);
  if (!entry) return res.status(404).json({ code: 404, msg: '确认请求不存在或已处理（可能已超时）' });
  if (entry.username !== req.user.username) return res.status(403).json({ code: 403, msg: '仅发起对话的用户可确认' });
  entry.resolve(approve === true);
  res.json({ code: 0, msg: approve === true ? '已批准执行' : '已拒绝执行' });
});

/**
 * SSE 对话。body: { session_id, agent_id, model?, content, attachments? }
 * P5.14：attachments = 文件 id 数组（POST /api/files 上传后携带）——start 定义 file/array[file] 变量时自动配对，否则文本化拼入输入
 */
router.post('/stream', async (req, res) => {
  const { session_id, agent_id, model, content, skill, attachments } = req.body || {};
  const input = (content || '').trim();
  const attachCount = (Array.isArray(attachments) ? attachments : []).length;
  if (!input && !attachCount) return res.status(400).json({ code: 400, msg: '消息不能为空' }); // P5.14：纯附件消息可发送
  // P5.30 安全止血：会话归属校验必须在 writeHead(SSE) 之前——stream 链路的消息落库/会话更新/历史上下文读取
  // 全部以 session_id 为键（不校验归属），任何登录用户可向他人会话写入消息并污染其模型上下文（IDOR）
  if (session_id) {
    const own = db.prepare('SELECT id FROM sessions WHERE id=? AND username=?').get(session_id, req.user.username);
    if (!own) return res.status(403).json({ code: 403, msg: '无权访问该会话' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // P5.29 停止生成：客户端 fetch abort → 连接断开 → res 'close' 三层联动中止——
  // ① send 守卫（断开后不再写流，避免对已销毁连接 write）② abortCleanups 立即结束工具确认等待（不等 120s 超时）
  // ③ ac.abort() 中断模型供应商 fetch（真正停止烧 token，经 llm.js signal 透传链路）
  // ⚠️ 必须监听 res 而非 req：req 的 'close' 在请求体被 body-parser 消费完（Readable 流耗尽自动销毁）时就会触发——
  //    实测踩坑：每个带 body 的 POST 刚进路由就误判"用户停止"，模型 fetch 被秒杀、0 tokens 落库、SSE 流即关。
  //    res 的 'close' 语义是「底层连接关闭」：正常流程先 res.end()（writableEnded=true）再关——不算中断；
  //    客户端中止时连接直接断（writableEnded=false）——才是真正的停止生成。
  let clientClosed = false;
  const abortCleanups = [];
  const ac = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return; // 正常结束（已 res.end）后的连接关闭不算中断
    clientClosed = true;
    try { ac.abort(); } catch { }
    while (abortCleanups.length) { try { abortCleanups.shift()(); } catch { } }
  });
  const send = (event, data) => { if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    // 0. 用户 Token 配额检查（P2：模型调用之前拦截，超限友好提示）
    const quotaMsg = checkQuota(req.user.username);
    if (quotaMsg) {
      send('blocked', { msg: quotaMsg });
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run(req.user.username, '配额拦截', 'Token 配额已耗尽', req.ip, now());
      return res.end();
    }

    // 1. 输入敏感词
    const inCheck = check(input, 'input');
    if (inCheck.blocked) {
      countHits(inCheck.words);
      send('blocked', { msg: `您的输入包含违规词汇（${inCheck.words.map(w => w.word).join('、')}），已被安全合规策略拦截。` });
      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'user', input, 0, now());
      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'assistant', '【内容安全拦截】您的输入包含违规词汇，无法处理，请文明提问。', 0, now());
      db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), session_id);
      return res.end();
    }

    // 1b. 提示词注入检测（风险分 ≥ 5 拦截；低风险仅告警）
    const inject = detectInjection(input);
    if (inject.risk >= 5) {
      logSecurityEvent('injection_blocked', `风险分${inject.risk}：${inject.hits.map(h => h.msg).join('、')} | 输入：${input.slice(0, 100)}`, '拦截', 'chat');
      send('blocked', { msg: `检测到疑似提示词注入攻击（${inject.hits.map(h => h.msg).join('、')}），已按安全策略拦截。` });
      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'user', input, 0, now());
      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'assistant', '【安全拦截】检测到疑似提示词注入，无法处理该请求。', 0, now());
      db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), session_id);
      return res.end();
    }
    if (inject.risk > 0) {
      logSecurityEvent('injection_warn', `风险分${inject.risk}：${inject.hits.map(h => h.msg).join('、')} | 输入：${input.slice(0, 100)}`, '放行并记录', 'chat');
      send('notice', { msg: `⚠ 检测到疑似提示注入特征（${inject.hits.map(h => h.msg).join('、')}），已记录审计。` });
    }

    // 1c. 输入 PII 识别（不拦截，记录告警；用于合规审计）
    const piiHits = detectPII(input);
    if (piiHits.length) {
      logSecurityEvent('pii_input', `输入含 ${piiHits.map(p => p.type).join('、')}`, '记录并送模型', 'chat');
      send('notice', { msg: `🔒 检测到个人信息（${[...new Set(piiHits.map(p => p.type))].join('、')}），已按合规要求记录，输出时将自动脱敏。` });
    }

    // 1d. 创作技能分流（首页 AI 助手多模态：图片/视频/PPT/语音，绕过智能体链路）
    if (skill === 'image' || skill === 'video' || skill === 'ppt' || skill === 'tts') {
      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'user', input, 0, now());
      const t0 = Date.now();
      send('delta', { text: '' }); // 触发前端“生成中”状态
      try {
        let reply = '';
        if (skill === 'image') {
          send('notice', { msg: '🎨 正在生成图片（QwenImage，约需 10~30 秒）…' });
          const r = await skills.genImage(input, '1024x1024');
          reply = `图片已生成（QwenImage 1024×1024）：\n\n![生成图片](${r.url})`;
        } else if (skill === 'video') {
          send('notice', { msg: '🎬 视频任务已提交（minimax h3，异步生成，生成完成后自动展示）…' });
          const r = await skills.createVideoTask(input);
          reply = `视频生成任务已创建（${r.seconds}秒 · ${r.aspectRatio}）：\n\n[VIDEO:${r.taskId}]`;
        } else if (skill === 'ppt') {
          send('notice', { msg: '📊 正在构思大纲并生成 PPT（约需 30~60 秒）…' });
          const r = await skills.genPPT(input);
          reply = `PPT 已生成：《${r.title}》共 ${r.pages} 页。\n\n[PPT:${r.url}|${r.filename}|${r.pages}]\n\n可直接下载编辑，也可告诉我需要调整的部分。`;
        } else if (skill === 'tts') {
          send('notice', { msg: '🎙️ 正在用自有昇腾算力合成语音（Qwen3-TTS）…' });
          const r = await skills.genTTS(input);
          reply = `语音已合成（昇腾 Qwen3-TTS·${r.source === 'ascend' ? '自有算力' : '备用源'}）：\n\n[AUDIO:${r.url}]`;
        }
        // P5.33：统一收尾（脱敏/落库/记账/审计/trace/done）经 ConversationSink——唯一记账点，
        // P5.30 修的「双记 bug」此后结构性不可能复发；tokens 缺省按脱敏后内容估算（与原逻辑一致）
        finishExternalTurn({
          send, sessionId: session_id, username: req.user.username, ip: req.ip,
          input, full: reply, agent: null,
          modelLabel: skill, modeLabel: `skill:${skill}`, tStart: t0,
          opAction: 'AI创作', opDetail: `技能 ${skill}：${input.slice(0, 50)}`,
        });
      } catch (e) {
        db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('skill', `${skill} 生成失败：${e.message}`, now());
        send('error', { msg: `生成失败：${e.message}` });
      }
      return res.end();
    }

    const agent = agent_id ? db.prepare('SELECT * FROM agents WHERE id=?').get(agent_id) : null;
    if (agent_id && !agent) { send('error', { msg: '智能体不存在' }); return res.end(); }
    // P3 协作与可见性：受限/草稿智能体仅名单内可见，防止绕过前端直接调接口对话
    if (agent && !canView(agent, req.user)) { send('error', { msg: '无权使用该智能体（未对你开放）' }); return res.end(); }

    // ---------- 外部 Dify 智能体：真实转发（敏感词检测前置已通过） ----------
    const tStart = Date.now();
    if (agent && agent.source === 'dify' && agent.external_app_id) {
      const plat = db.prepare('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC').get('dify');
      if (!plat) { send('error', { msg: '未找到启用的 Dify 平台接入配置' }); return res.end(); }
      if (!agent.external_api_key) { send('error', { msg: '该外部智能体未配置 Service API Key，请在外挂平台重新同步' }); return res.end(); }
      if (agent.external_mode !== 'chat' && agent.external_mode !== 'completion') {
        send('error', { msg: `该 Dify 应用为 ${agent.external_mode || 'workflow'} 类型，暂不支持对话转发` });
        return res.end();
      }

      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'user', input, Math.ceil(input.length * 0.6), now());

      const sess = session_id ? db.prepare('SELECT * FROM sessions WHERE id=?').get(session_id) : null;
      let full = '';
      let usage = null;
      let extConvId = sess?.ext_conversation_id || '';
      try {
        if (agent.external_mode === 'chat') {
          const gen = dify.chatStream(plat.endpoint, agent.external_api_key, {
            query: input,
            user: `ap-${req.user.username}`,
            conversationId: extConvId,
          });
          while (true) {
            const r = await gen.next();
            if (r.done) { full = r.value.full || ''; usage = r.value.usage; extConvId = r.value.conversationId || extConvId; break; }
            send('delta', { text: r.value.delta });
          }
        } else {
          const r = await dify.completionOnce(plat.endpoint, agent.external_api_key, { query: input, user: `ap-${req.user.username}` });
          full = r.full; usage = r.usage;
          send('delta', { text: full });
        }
      } catch (e) {
        console.error('[chat] Dify 转发异常：', e);
        db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('chat-service', 'Dify 转发异常：' + e.message, now());
        send('error', { msg: '外部智能体调用失败：' + e.message });
        return res.end();
      }

      // P5.33：统一收尾经 ConversationSink（脱敏/落库/ext会话回写/记账/审计/trace/done）；
      // tokens 外部 usage 优先（0 视为缺省按内容估算，与原 || 语义一致）
      finishExternalTurn({
        send, sessionId: session_id, username: req.user.username, ip: req.ip,
        input, full, agent,
        modelLabel: agent.model || 'dify-app', modeLabel: 'dify', tStart,
        tokens: usage?.total_tokens || undefined,
        extConvId,
        opDetail: (pt) => `与「${agent.name}」对话（Dify 真实转发，${pt} tokens）`,
      });
      return res.end();
    }

    // ---------- 外部扣子(Coze)智能体：真实转发 /v3/chat（Bot 需发布为 API 渠道） ----------
    if (agent && agent.source === 'coze' && agent.external_app_id) {
      // 工作流类型应用（低代码项目）：经 /v1/workflow/run 真实调用（长任务，阻塞等待后返回视频链接）
      if (agent.external_mode === 'workflow') {
        db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
          .run(session_id, 'user', input, Math.ceil(input.length * 0.6), now());

        const plat = db.prepare('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC').get('coze');
        const token = plat?.token?.startsWith('pat_') ? plat.token : (agent.external_api_key || '');
        if (!token.startsWith('pat_')) {
          const msg = '未配置有效的扣子个人访问令牌（PAT），请在接入管理中配置';
          db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
            .run(session_id, 'assistant', msg, 0, now());
          send('delta', { text: msg });
          send('done', { content: msg, tokens: 0 });
          return res.end();
        }

        // 先发进度提示（视频生成为长任务，通常 2-5 分钟）
        send('delta', { text: `🎬 正在调用扣子工作流「${agent.name}」生成视频，请耐心等待 2-5 分钟…\n\n` });

        try {
          const t0 = Date.now();
          const r = await coze.runWorkflow(token, agent.external_app_id, {
            input,
            mode: '1',
            style: '漫画风格',
          });
          // 工作流输出：vedio_url（原拼写）/ sub_video_url
          const d = r.data || {};
          let videoUrl = d.vedio_url || d.video_url || d.sub_video_url || (typeof d === 'string' ? d : '');
          let reply;
          if (videoUrl) {
            reply = `✅ 视频生成完成（耗时 ${Math.round((Date.now() - t0) / 1000)} 秒）：\n\n${videoUrl}\n\n` +
              `>[扣子执行明细](${r.debug_url || ''})`.replace(/\(\/\)/, '()') +
              `\n\n您可以在浏览器打开链接下载视频（链接有时效，请尽快保存）。`;
          } else {
            reply = `工作流执行完成（耗时 ${Math.round((Date.now() - t0) / 1000)} 秒），但未返回视频链接。返回内容：\n\n${JSON.stringify(d).slice(0, 800)}`;
          }
          // P5.33：统一收尾经 ConversationSink——Coze 工作流链路保持原差异：不过滤输出、不记账、tokens 按输入+输出估算
          send('delta', { text: reply });
          finishExternalTurn({
            send, sessionId: session_id, username: req.user.username, ip: req.ip,
            input, full: reply, agent,
            modelLabel: agent.model || 'coze-workflow', modeLabel: 'coze-workflow', tStart,
            tokens: Math.ceil((input.length + reply.length) * 0.6),
            maskOutput: false, billUsage: false,
            opDetail: (pt) => `与「${agent.name}」对话（Coze 工作流真实调用，${pt} tokens，耗时 ${Math.round((Date.now() - t0) / 1000)}s）`,
          });
          return res.end();
        } catch (e) {
          console.error('[chat] Coze 工作流调用异常：', e);
          db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('chat-service', 'Coze 工作流调用异常：' + e.message, now());
          const errMsg = '扣子工作流调用失败：' + e.message + '\n\n可稍后重试，或到扣子工作台直接运行。';
          db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
            .run(session_id, 'assistant', errMsg, 0, now());
          send('delta', { text: errMsg });
          send('done', { content: errMsg, tokens: 0 });
          return res.end();
        }
      }
      const plat = db.prepare('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC').get('coze');
      const token = plat?.token?.startsWith('pat_') ? plat.token : (agent.external_api_key || '');
      if (!token.startsWith('pat_')) { send('error', { msg: '未配置有效的扣子个人访问令牌（PAT），请在接入管理中配置后重新同步' }); return res.end(); }

      db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
        .run(session_id, 'user', input, Math.ceil(input.length * 0.6), now());

      const sess = session_id ? db.prepare('SELECT * FROM sessions WHERE id=?').get(session_id) : null;
      let full = '';
      let usage = null;
      let extConvId = sess?.ext_conversation_id || '';
      try {
        const gen = coze.chatStream(token, agent.external_app_id, {
          query: input,
          user: `ap-${req.user.username}`,
          conversationId: extConvId,
        });
        while (true) {
          const r = await gen.next();
          if (r.done) { full = r.value.full || ''; usage = r.value.usage; extConvId = r.value.conversationId || extConvId; break; }
          send('delta', { text: r.value.delta });
        }
      } catch (e) {
        console.error('[chat] Coze 转发异常：', e);
        db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('chat-service', 'Coze 转发异常：' + e.message, now());
        send('error', { msg: '外部扣子智能体调用失败：' + e.message });
        return res.end();
      }

      // P5.33：统一收尾经 ConversationSink（同 Dify：脱敏/ext会话回写/usage 优先记账）
      finishExternalTurn({
        send, sessionId: session_id, username: req.user.username, ip: req.ip,
        input, full, agent,
        modelLabel: agent.model || 'coze-bot', modeLabel: 'coze', tStart,
        tokens: usage?.total_tokens || undefined,
        extConvId,
        opDetail: (pt) => `与「${agent.name}」对话（Coze 真实转发，${pt} tokens）`,
      });
      return res.end();
    }

    // ---------- 平台内置智能体链路（tStart 已在外层声明，覆盖 Dify/Coze/本地三条链路） ----------

    // 1f. P3 @技能解析：提取 @技能名（本人技能优先 → 他人已发布），技能提示词注入 system、工具并入 function calling；
    //     标记从送模型的内容中移除（用户消息原文保留展示，检索/理解更准）
    const skillPool = db.prepare('SELECT * FROM skill_assets WHERE status=1 OR owner=?').all(req.user.username);
    const { skills: usedSkills, content: _c1 } = parseSkillMentions(input, skillPool, req.user.username);
    if (usedSkills.length) {
      send('notice', { msg: `✨ 已启用技能：${usedSkills.map(s => `${s.icon || '✨'} ${s.name}`).join('、')}` });
    }

    // 1g. P5.24 @专家解析：剩余 @ 标记匹配已发布智能体（canView 过滤：公开 + 本人有权限的受限智能体），
    //     专家 prompt 注入 system（以专业身份回答）；与技能同语法、链式接在技能解析之后（同名时技能优先）
    const expertPool = db.prepare("SELECT id,name,icon,type,description,prompt,tools,owner,status,visibility,collaborators,visible_members,visible_depts FROM agents WHERE status='published'").all()
      .filter(a => canView(a, req.user));
    const { agents: usedExperts, content: chatInput } = parseAgentMentions(_c1, expertPool);
    if (usedExperts.length) {
      send('notice', { msg: `🎓 已指定专家：${usedExperts.map(a => `${a.icon || '🤖'} ${a.name}`).join('、')}` });
    }

    // P5.14 文件一等变量：聊天附件（POST /api/files 上传的 fileId）→ 画布 start 的 file/array[file] 变量自动配对；
    // 未定义 file 变量时文本化拼入输入（表单模式/普通智能体也能读附件）
    const attachIds = [...new Set((Array.isArray(attachments) ? attachments : []).map(Number).filter(Number.isFinite))].slice(0, 10);
    const attachRows = attachIds.map(id => db.prepare('SELECT * FROM wf_files WHERE id=?').get(id)).filter(Boolean);
    if (attachIds.length !== attachRows.length) send('notice', { msg: '⚠️ 部分附件不存在或已被清理' });
    let attachVarMap = null; // 画布 file 变量 → fileId 映射（有映射时不拼文本防重复）
    if (attachRows.length) {
      const isCanvasAgent = !!(agent && agent.workflow && (agent.edit_mode === 'canvas' || agent.routing_mode === 'workflow'));
      let startFileVars = [];
      if (isCanvasAgent) {
        try {
          const wfDef = JSON.parse(agent.published_workflow || agent.workflow || 'null');
          startFileVars = ((wfDef?.nodes || []).find(n => n.type === 'start')?.data?.variables) || [];
        } catch { }
      }
      const fileVars = startFileVars.filter(v => v && v.name && (v.type === 'file' || v.type === 'array[file]'));
      if (fileVars.length) {
        attachVarMap = {};
        const arrVar = fileVars.find(v => v.type === 'array[file]');
        if (arrVar) attachVarMap[arrVar.name] = attachRows.map(f => f.id);
        fileVars.filter(v => v.type === 'file').slice(0, attachRows.length).forEach((v, i) => { attachVarMap[v.name] = attachRows[i].id; });
        send('notice', { msg: `📎 附件已绑定文件变量：${attachRows.map(f => `📄 ${f.name}`).join('、')}` });
      } else if (isCanvasAgent) {
        send('notice', { msg: '💡 本智能体未定义 file 变量，附件将以文本形式注入输入（可在画布 start 节点定义 file 变量获得结构化流转）' });
      }
    }
    // P5.28 修复：fileToText 期望富对象（.text），db 原始行字段是 text_content——此前直接传行对象导致
    // 「Cannot read properties of undefined (reading 'length')」（附件文本化路径从未真正跑通过；画布 file 变量路径不受影响）
    const { fileToRich, fileToText } = require('../lib/fileparse');
    // 附件文本化注入（截断 24000 字/文件防超长请求触发供应商 400 流式 bug）
    const attachText = (attachRows.length && !attachVarMap) ? '\n\n' + attachRows.map(r => { const txt = fileToText(fileToRich(r)); return txt.length > 24000 ? txt.slice(0, 24000) + '\n…（文件过长已截断）' : txt; }).join('\n\n') : '';

    // 2. 知识库检索（混合检索：BM25 + 向量，RRF 融合；@技能标记已移除，检索更准）
    let kbContext = [];
    let kbHits = [];
    if (agent && agent.kb_id) {
      // V1.2 #2 2026-10-30：元数据过滤联动——resolveKbFilter 解析 agent.kb_metadata_filter
      // （$user.dept 占位符按请求用户部门替换）；有过滤且无命中即无上下文（fail-closed 设计语义，不兑底放开）。
      // threshold 0.01 为原 3 参调用的默认值，显式写出保语义不变
      kbHits = await retrieve(chatInput.trim() || input, agent.kb_id, 5, 0.01, { metadataFilter: resolveKbFilter(agent, req.user) || undefined });
      kbContext = kbHits.map(h => h.content);
      if (kbHits.length) send('kb', { hits: kbHits });
    }

    // 3. 组装 messages（含历史轮数）
    const history = agent?.context_rounds
      ? db.prepare('SELECT role, content FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(session_id, agent.context_rounds * 2)
      : db.prepare('SELECT role, content FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 20) ORDER BY id').all(session_id);

    // 3b. SinguX 式记忆与变量注入（借鉴「变量/长期记忆」）：
    //  - 变量：提示词中可用 {{USER_NAME}}/{{AGENT_NAME}} 等系统变量占位符，自定义变量清单注入说明；
    //  - 长期记忆：开启后注入该用户与本智能体的历史记忆事实，回复后异步提取新记忆
    const varValues = {
      SYS_USER_ID: req.user.username, USER_UID: String(req.user.id || req.user.username),
      USER_NAME: req.user.nickname || req.user.username, USER_LANG: 'zh-CN',
      AGENT_ID: agent?.id || '', AGENT_NAME: agent?.name || 'AI 助手',
      CONVERSATION_ID: String(session_id || ''), REQUEST_ID: `${Date.now()}`,
    };
    const applyVars = (text) => String(text || '').replace(/\{\{\s*(SYS_USER_ID|USER_UID|USER_NAME|USER_LANG|AGENT_ID|AGENT_NAME|CONVERSATION_ID|REQUEST_ID)\s*\}\}/g, (_, k) => varValues[k] ?? '');

    let system = applyVars(agent?.prompt) || '你是企业智能体平台的 AI 助手，请专业、清晰地回答用户问题。';
    // P5.27d/P5.28 首页助手能力声明（agent 为空 = 默认对话入口）：四大场景路由 + 可用工具 + 反编造约束。
    // 动机（实测两个问题）：① 历史会话里"我无法操作您的电脑"的旧回复会把模型带偏（工具已具备却仍拒绝）；
    // ② 模型看到历史成功案例后会直接"声称已创建"而不调工具（桌面实际没有该文件夹——编造）。
    if (!agent) {
      system += `\n\n【四大核心场景】你是能干可靠的 AI 办公搭子，用户请求按场景选路径执行（不必自我设限）：
◆ 整理文件：📎 附件（PDF/DOCX/XLSX/CSV/TXT/MD）自动解析为文本（Excel 为 Markdown 表格）——提取关键信息、汇总摘要、输出脑图大纲（markdown 层级列表）或整理成新文档。
◆ 深度调研：用 web_search 检索 + web_fetch 抓取原文，多源交叉整理行业资讯/竞品动向；用户要"持续监控/定时推送/每天提醒"时，直接用 create_task 工具创建定时任务（把监控对象、信息源要求与输出格式写成自包含指令；创建前会弹确认卡，向用户展示中文计划预览）。
◆ 文档PPT：报告/公文/总结直接撰写；用户要 Word 文档时**必须用 export_word 工具**（title+markdown 参数，勿用 run_code 拼 XML）；PPT 走「📊 PPT生成」技能。
◆ 代码应用：数据计算/转换/批量处理用 run_code 沙箱执行（fs 为全局）；生成演示页面/小工具时让沙箱产出 .html 文件并给用户预览链接。

【本机能力】你已连接用户的本地设备（若已配对），具备工具 local_exec：可在用户桌面/主目录创建文件夹、打开本机应用（macOS 应用用注册英文名，如备忘录=Notes）、列目录、发系统通知。当用户要求操作其电脑（如"在桌面建文件夹""打开某应用"）时：必须实际调用对应工具执行，严禁未调用工具就声称已完成操作；若工具返回未配对/离线，如实转告用户安装「我的设备」页的客户端。历史对话中"无法操作您的电脑"的旧回复已过时——现在你有真实工具。

【工作方式】需求模糊时先拆解（明确目标→规划步骤→逐步执行）；涉及附件必先读附件内容再作答；产文件一律交付可下载链接。`;
    }
    let agentVariables = [];
    try { agentVariables = JSON.parse(agent?.variables || '[]'); } catch { agentVariables = []; }
    if (agentVariables.length) {
      system += `\n\n【用户特征变量】以下变量用于记录用户特征，使回复更个性化（对话中自然获取，无需逐一追问）：\n${agentVariables.map(v => `- ${v.name}：${v.desc || '（未描述）'}`).join('\n')}`;
    }
    let memRows = [];
    if (agent?.long_memory) {
      memRows = db.prepare('SELECT fact FROM agent_memories WHERE agent_id=? AND username=? ORDER BY id DESC LIMIT 20').all(agent.id, req.user.username);
      if (memRows.length) {
        system += `\n\n【长期记忆】已记住的当前用户特征（回复时自然利用，无需重复询问）：\n${memRows.map(m => '- ' + m.fact).join('\n')}`;
      }
    }
    if (usedSkills.length) {
      system += `\n\n【已启用技能】用户在本条消息中通过 @ 调用了以下技能，请严格按各技能提示词的要求完成任务：\n${usedSkills.map(s => `◆ 技能「${s.name}」：${s.prompt}`).join('\n')}`;
    }
    // P5.24 指定专家：注入专家智能体的设定（专业身份 + 描述 + 提示词，单专家截断 3000 字防 prompt 膨胀）；
    // 专家配置的工具已在下方并入 function calling——提示词里声称的工具能力在本会话真实可用（防无工具编造数据）
    if (usedExperts.length) {
      const expertTools = new Set();
      for (const a of usedExperts) { let et = []; try { et = JSON.parse(a.tools || '[]'); } catch { et = []; } et.forEach(x => expertTools.add(x)); }
      system += `\n\n【指定专家】用户在本条消息中通过 @ 指定了以下平台智能体专家，请以对应专家的专业身份与口吻回答（多位专家时按各自专长分工协作、综合输出）：\n${usedExperts.map(a => `◆ 专家「${a.name}」（${a.description || '平台智能体'}）：\n${String(a.prompt || '').slice(0, 3000)}`).join('\n')}${expertTools.size ? `\n（专家配置的工具已启用：${[...expertTools].join('、')}——涉及数据/事实时必须调用工具真实获取，禁止凭记忆编造。）` : ''}`;
    }
    if (kbContext.length) {
      system += `\n\n以下是知识库检索到的相关内容（带来源编号），请优先依据这些内容回答：\n${kbContext.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`;
      system += `\n\n【引用规范】回答中引用了某条资料时，必须在对应句子末尾标注来源编号，格式如 [1] 或 [2]；多条来源可并列如 [1][3]。知识库没有的内容请如实说明，不要编造。`;
    }
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: (chatInput.trim() || '（用户通过 @ 调用了技能/专家，请按其设定开始服务）') + attachText }]; // P5.14：附件文本化注入（表单/普通链路）

    db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
      .run(session_id, 'user', input, Math.ceil(input.length * 0.6), now());

    // 4. 模型调用（真实/模拟），流式转发；智能体配置了工具时启用 function calling（内置 + MCP）
    let full = '';
    const toolTrace = [];
    let agentTools = [];
    try { agentTools = JSON.parse(agent?.tools || '[]'); } catch { agentTools = []; }
    // P5.27c 首页 AI 助手默认工具集：无 agent（首页/新建会话）时不再"裸聊"——
    // 挂上本地操控(local_exec)+沙箱(run_code)+查询计算类，让「帮我在桌面建文件夹」这类请求在任意入口都能真执行。
    // P5.31 新增 create_task：定时/持续监控场景对话内直接创建（high 风险，默认权限下弹确认卡）。
    // 权限闸门兑底：local_exec/run_code 归 medium/high，默认权限下执行前仍弹确认卡。
    if (!agent) {
      agentTools = ['get_datetime', 'calculator', 'web_search', 'db_query', 'run_code', 'local_exec', 'create_task'];
    }
    // P3 @技能携带的工具并入（去重；技能工具经 buildTools 走同一 function calling 循环）
    // P5.24 @专家携带的工具并入（去重；指定专家 = 完整能力：提示词 + 工具，与技能同链路）——
    // 没有工具并入时专家会「声称查询」却无工具可用，模型只能编造数据（实测发现）
    // P5.34b（审查 F4）：技能/专家并入统一过滤违禁工具（组装点收敛——存量配置的 create_task/
    // local_exec 不再进入 function calling；新写入已被 agents 白名单拦截，此处兕存量）
    const safeToolId = (tid) => typeof tid === 'string' && !AGENT_TOOL_DENY.has(tid);
    for (const s of usedSkills) {
      let st = []; try { st = JSON.parse(s.tools || '[]'); } catch { st = []; }
      for (const tid of st) if (safeToolId(tid) && !agentTools.includes(tid)) agentTools.push(tid);
    }
    // P5.24 @专家携带的工具并入（去重；指定专家 = 完整能力：提示词 + 工具，与技能同链路）——
    // 没有工具并入时专家会「声称查询」却无工具可用，模型只能编造数据（实测发现）
    for (const a of usedExperts) {
      let et = []; try { et = JSON.parse(a.tools || '[]'); } catch { et = []; }
      for (const tid of et) if (safeToolId(tid) && !agentTools.includes(tid)) agentTools.push(tid);
    }
    const mcpTools = loadMcpTools(agent?.mcp_servers || '[]');
    // 子智能体编排（SinguX 式）：子智能体注册为 function calling 工具，主模型自主路由
    const childTools = agent ? buildChildTools(agent.child_ids) : [];
    if (childTools.length) {
      system += `\n\n【多智能体协作】你是编排器，可调用以下子智能体分工完成任务（用对应工具）：\n${childTools.map(c => `- agent_call_${c.child.id}（${c.child.name}）：${c.child.description || '专业子智能体'}`).join('\n')}\n简单问题直接回答，需要子智能体专业能力时先调用工具再把结果整合给用户，并说明由哪个子智能体完成。`;
      messages[0].content = system; // 组装好的 messages 同步增强后的 system
    }
    const allTools = buildTools(agentTools, mcpTools, childTools);
    // ⑦ P5.1 画布工作流路由（DAG Runner）：edit_mode='canvas'（或 routing_mode='workflow'）且已编排 → 按图执行
    let workflowGen = null;
    {
      const useCanvas = agent && agent.workflow && (agent.edit_mode === 'canvas' || agent.routing_mode === 'workflow');
      if (useCanvas) {
        let wf = null, wfRaw = agent.published_workflow || agent.workflow;
        // P5.9 版本管理：对话运行优先已发布快照（编辑中的草稿不影响线上）；无快照回退草稿
        try { wf = JSON.parse(wfRaw || 'null'); } catch { wf = null; }
        if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) { wfRaw = agent.workflow; try { wf = JSON.parse(wfRaw || 'null'); } catch { wf = null; } }
        const isV2 = wf && Array.isArray(wf.nodes) && wf.nodes.length && wf.nodes[0].config === undefined;
        if (wf && Array.isArray(wf.nodes) && wf.nodes.length) {
          send('notice', { msg: '🎨 本智能体已启用画布工作流，按编排图执行：' + wf.nodes.length + ' 节点' });
          workflowGen = (async function* () {
            const { runWorkflow } = require('../lib/workflow');
            // P5.9：把选中版本（快照或草稿）固化为执行输入（防 runWorkflow 读回草稿）；
            // V1 旧图自动升级（防御）后按新 Runner 签名执行
            let agentRow = { ...agent, workflow: typeof wfRaw === 'string' ? wfRaw : JSON.stringify(wf) };
            if (!isV2) {
              const { migrateWorkflowData } = require('../lib/workflow-schema');
              agentRow = { ...agent, workflow: JSON.stringify(migrateWorkflowData(wf)) };
            }
            // P5.5 运行实例落库（对话触发）
            const wfT0 = Date.now();
            const { maskSecrets } = require('../lib/secrets');
            // P5.7 会话变量：从会话行加载持久值（容错；未持久过的变量由 Runner 用 start 定义默认值兜底）
            let wfSessionVars = {};
            try {
              const sessRow = session_id ? db.prepare('SELECT wf_vars FROM sessions WHERE id=?').get(session_id) : null;
              wfSessionVars = JSON.parse(sessRow?.wf_vars || '{}') || {};
              if (typeof wfSessionVars !== 'object' || Array.isArray(wfSessionVars)) wfSessionVars = {};
            } catch { wfSessionVars = {}; }
            const runInfo = db.prepare(`INSERT INTO workflow_runs (agent_id, trigger_type, status, inputs, started_at) VALUES (?,?,?,?,datetime('now','localtime'))`)
              .run(agent.id, 'chat', 'running', maskSecrets(JSON.stringify({ input: chatInput.trim() || input, session_vars: wfSessionVars })).slice(0, 4000));
            // P5.6 Chatflow 直接回复：answer 节点内容即时走 delta 通道流式转发；执行结束 done.content 与汇总一致（前端整体替换，不重复）
            const deltas = [];
            let wake = null, runSettled = false;
            const onEvent = evt => {
              // P5.10 流式调试：LLM 节点逐字事件在此链路不转发（聊天页的回复流走 answer 的 nodeReply→delta 通道，
              // llm 中间输出非最终回复，避免误发）；onEvent 未匹配的 nodeStream 自然丢弃
              if (evt.event === 'nodeStream') return;
              if (evt.event === 'nodeStart') send('tool', { name: `${evt.title || evt.nodeId}（${evt.type}）`, status: 'executing' });
              if (evt.event === 'nodeDone') send('tool', { name: `${evt.title || evt.nodeId}（${evt.type}）`, status: evt.ok ? 'finished' : 'failed', result: (evt.preview || '').slice(0, 120) });
              if (evt.event === 'nodeSkip') send('tool', { name: `${evt.title || evt.nodeId}（${evt.type}）`, status: 'finished', result: '分支未命中，跳过' });
              if (evt.event === 'nodeReply') { deltas.push(String(evt.text ?? '')); if (wake) { const w = wake; wake = null; w(); } }
            };
            const runP = runWorkflow(agentRow, { input: (chatInput.trim() || input) + attachText, ...(attachVarMap || {}) }, { // P5.14：file 变量配对注入（有变量时 attachText 为空，不重复）
              username: req.user.username,
              history: history.map(h => ({ role: h.role, content: h.content })), // P2 llm 上下文设置：携带会话历史（P5.6 Chatflow 下 llm 默认启用）
              sessionVars: wfSessionVars, // P5.7 会话变量（跨轮次持久）
              _currentRunId: runInfo.lastInsertRowid, // P5.8 #9：agent 节点的子运行关联本 run（下钻链路）
              onEvent,
            }).then(rr => {
              runSettled = true; wake?.();
              const totalTokens = rr.usage?.totalTokens ?? 0; // P5.13 改用 Runner usage 汇总（不再正则扫日志）
              db.prepare(`UPDATE workflow_runs SET status='success', outputs=?, node_logs=?, total_tokens=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
                .run(maskSecrets(String(rr.output ?? '')).slice(0, 8000), JSON.stringify(rr.logs).slice(0, 100000), totalTokens, Date.now() - wfT0, runInfo.lastInsertRowid);
              // P5.7 会话变量写回：本轮结束快照持久化到会话行（下一轮 start 注入；值过长截断防护）
              try {
                if (rr.sessionVars && Object.keys(rr.sessionVars).length) {
                  db.prepare('UPDATE sessions SET wf_vars=? WHERE id=?').run(maskSecrets(JSON.stringify(rr.sessionVars)).slice(0, 20000), session_id);
                }
              } catch { /* 会话变量持久化失败不影响对话 */ }
              return rr;
            }).catch(err => {
              runSettled = true; wake?.();
              db.prepare(`UPDATE workflow_runs SET status='error', outputs='', node_logs=?, error=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
                .run(JSON.stringify(err.logs || []).slice(0, 100000), maskSecrets(String(err.message || '')).slice(0, 500), Date.now() - wfT0, runInfo.lastInsertRowid);
              throw err;
            });
            while (true) {
              while (deltas.length) yield { delta: deltas.shift() };
              if (runSettled) break;
              await new Promise(r => { wake = r; });
            }
            const r = await runP;
            return { full: r.output, model: agent.model, provider: 'workflow' };
          })();
        }
      }
    }
    // ⑦ 分类器路由：classifier 模式先意图分类，高置信直达子智能体（跳过主模型编排）；失败/低置信回退原 function calling 流程
    let classifierGen = null;
    if (agent?.routing_mode === 'classifier' && childTools.length && chatInput.trim()) {
      let hit = null;
      try { hit = await classifyIntent(input, agent, childTools); } catch { hit = null; }
      if (hit) {
        const tname = `agent_call_${hit.child.id}`;
        send('tool', { name: tname, status: 'executing' });
        try {
          const r = await runChildAgent(hit.child, input, agent?.max_reply, req.user);
          toolTrace.push({ name: tname, result: `分类器直达（置信度 ${Math.round(hit.confidence * 100)}%：${hit.reason}）` });
          send('tool', { name: tname, status: 'finished', result: r.slice(0, 200) });
          const outText = r + `\n\n> 🧭 由子智能体「${hit.child.name}」直接处理（路由置信度 ${Math.round(hit.confidence * 100)}%）`;
          classifierGen = (async function* () {
            return { full: outText, model: hit.child.model, provider: 'classifier-route' };
          })();
        } catch (e) {
          send('tool', { name: tname, status: 'finished', result: '执行失败，回退主模型处理' });
        }
      }
    }
    // P5.25 对话权限闸门（图 2 语义）：「默认权限」下 medium/high 风险工具执行前需用户确认——
    // SSE 推 tool_confirm 事件 → 前端在消息流中弹确认卡 → 用户批准/拒绝 → POST /api/chat/confirm 决议唤醒等待；
    // 「全自动执行」（perm='auto'）全部放行；low 风险永不拦截（确认疲劳无意义）；120s 未决议按拒绝处理防会话悬挂
    const chatPerm = String((req.body || {}).perm || 'default') === 'auto' ? 'auto' : 'default';
    const waitUserConfirm = (toolKey, name, argsJson) => new Promise(resolve => {
      const timer = setTimeout(() => { toolConfirmRegistry.delete(toolKey); resolve('timeout'); }, 120000);
      // P5.29：用户停止生成时立即结束确认等待（否则主循环会卡到 120s 超时才落库 partial）
      abortCleanups.push(() => { clearTimeout(timer); toolConfirmRegistry.delete(toolKey); resolve('stopped'); });
      toolConfirmRegistry.set(toolKey, { resolve: v => { clearTimeout(timer); toolConfirmRegistry.delete(toolKey); resolve(v); }, username: req.user.username, expires: Date.now() + 120000 });
      send('tool_confirm', { key: toolKey, name, args: argsJson });
    });
    const executeTool = async (name, argsJson) => {
      // P5.32：MCP 工具传入挂载上下文做细粒度分级（trusted 服务器的只读工具降为 low 免确认疲劳；其余仍 high）
      const risk = toolRiskOf(name, { mcpServers: agent?.mcp_servers || '[]' });
      // P5.34（审查建议③）：create_task 即使「全自动执行」也强制确认——持久化自动执行实体不应被
      // 一次性授权（auto）静默创建；防提示词注入借 auto 权限批量造任务烧 token
      const needConfirm = risk !== 'low' && (chatPerm === 'default' || name === 'create_task');
      if (needConfirm) {
        const toolKey = `${session_id}:${Date.now()}:${name}`;
        send('tool', { name, status: 'awaiting' });
        const verdict = await waitUserConfirm(toolKey, name, argsJson);
        if (verdict !== true) {
          const reason = verdict === false ? '用户拒绝执行' : '等待确认超时（120 秒）';
          send('notice', { msg: `⛔ ${name} 未执行：${reason}` });
          return `工具 ${name} 未获得用户授权（${reason}）。请基于已有信息回答，或询问用户是否允许执行该操作。`;
        }
      }
      send('tool', { name, status: 'executing' });
      // 子智能体工具：agent_call_{id} → 阻塞执行子智能体（含其知识库检索）
      if (name.startsWith('agent_call_')) {
        const c = childTools.find(t => t.schema.function.name === name);
        if (!c) return '未知子智能体：' + name;
        let args = {};
        try { args = JSON.parse(argsJson || '{}'); } catch { }
        return runChildAgent(c.child, args.task, agent?.max_reply, req.user).then(r => `子智能体「${c.child.name}」的执行结果：\n${r}`);
      }
      // P5.27：ctx 补 username——local_exec 按用户路由到其默认设备
      // V1.2 审查加固 2026-10-30：主链路工具执行同样受智能体元数据过滤约束（kb_search 旁路收口——
      // 否则主链路检索被过滤，LLM 经 function calling 调 kb_search 却全库检索，机密分块经工具结果回流对话）
      return runTool(name, argsJson, { kbId: agent?.kb_id || null, mcpServers: agent?.mcp_servers || '[]', username: req.user.username, metadataFilter: resolveKbFilter(agent, req.user) || undefined });
    };
    const gen = workflowGen || classifierGen || chat(messages, {
      model: model || agent?.model,
      username: req.user.username, // P3：用户自有模型优先路由（自带 Key 只为选中的模型买单）
      temperature: agent?.temperature,
      top_p: agent?.top_p,
      max_reply: agent?.max_reply,
      kbContext,
      agentName: agent?.name,
      tools: allTools,
    // 工具执行回调：先推送「执行中」事件（借鉴 SinguX PROCESSING 事件），完成事件由 toolCall 结果推送
    // P5.25 对话权限闸门：perm='default' 时 medium/high 风险工具执行前需用户确认（SSE 推 tool_confirm，
    // 前端弹卡 → POST /api/chat/confirm 决议）；perm='auto' 全部放行（P5.34 起唯一例外：create_task 恒确认）；low 永不拦截。
      executeTool,
      signal: ac.signal, // P5.29 停止生成：客户端断开时中止模型 fetch（workflow/classifier 链路无 fetch 级中止，靠循环内 clientClosed 兑底跳出）
    });
    let genMeta = null;
    let stopped = false; // P5.29：用户点了「停止生成」（客户端断连 → ac.abort 中断模型流，已生成部分照常落库）
    try {
      while (true) {
        const r = await gen.next();
        if (r.done) { full = r.value.full; genMeta = r.value; break; }
        if (r.value.delta) { full += r.value.delta; send('delta', { text: r.value.delta }); }
        if (r.value.toolCall) {
          toolTrace.push(r.value.toolCall);
          send('tool', { name: r.value.toolCall.name, status: 'finished', result: r.value.toolCall.result });
        }
        if (clientClosed) { stopped = true; break; } // 非模型 fetch 链路（workflow 等）的断连兑底跳出
      }
    } catch (e) {
      if (clientClosed || e?.name === 'AbortError' || e?.aborted) stopped = true; // 模型 fetch 被 abort：保留已生成部分落库
      else throw e;
    }

    // 5. 输出敏感词过滤 + PII 脱敏（身份证/手机号/银行卡/邮箱/护照）
    const maskedWords = mask(full);
    const piiMasked = maskPII(maskedWords);
    // P5.25 假图防御：模型偶尔绕过工具直接编造本地图片 URL（实测发生：无 tool_calls 却输出 /uploads/gen-images/...）
    // ——markdown 图片语法逐图校验文件存在，不存在的替换为占位说明（防用户点开 404 假图）；外链与普通链接不受影响
    const sanitizeFakeImages = (text) => String(text || '').replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      try {
        if (!/^(?:\/uploads|\/api\/files\/download)/.test(url)) return m; // 外链不管
        const fsPath = path.join(__dirname, '..', '..', 'public', url.split('?')[0]);
        if (!fs.existsSync(fsPath)) return `（⚠️ ${alt || '图片'}未生成成功——模型引用了不存在的本地图片路径，请重试，或在「默认权限」下批准 image_gen 工具执行。）`;
        return m;
      } catch { return m; }
    });
    const outMasked = sanitizeFakeImages(piiMasked);
    let blockedNote = '';
    if (outMasked !== full) {
      const outCheck = check(full, 'output');
      if (outCheck.words.length) {
        countHits(outCheck.words);
        blockedNote += outCheck.words.map(w => w.word).join('、');
      }
      const outPii = detectPII(full);
      if (outPii.length) {
        const types = [...new Set(outPii.map(p => p.type))];
        blockedNote += (blockedNote ? '；PII:' : 'PII:') + types.join('、');
        logSecurityEvent('pii_output', `输出含 ${types.join('、')}，已自动脱敏`, '自动脱敏', 'chat');
      }
      send('notice', { msg: outPii.length && !outCheck.words.length ? '🔒 回复中的个人信息已按合规要求自动脱敏。' : '回复内容包含违规词汇或个人信息，已自动脱敏处理。' });
    }

    const tokens = Math.ceil(outMasked.length * 0.6);
    const promptChars = messages.reduce((s, m) => s + (m.content || '').length, 0);
    const msgInfo = db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
      .run(session_id, 'assistant', outMasked, tokens, now());
    addUsage(req.user.username, tokens); // P2 配额记账（本地模型链路）
    db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), session_id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '对话调用', `与 ${agent ? '「' + agent.name + '」' : '首页助手'} 对话（${tokens} tokens${stopped ? '，用户停止生成' : ''}${usedSkills.length ? '，@技能 ' + usedSkills.map(s => s.name).join('/') : ''}${toolTrace.length ? '，工具×' + toolTrace.length : ''}${genMeta?.provider ? '，@' + genMeta.provider + '/' + (genMeta.model || model || '') : ''}）`, req.ip, now());
    // 全链路追踪落库（model+provider 记录实际路由到的供应商，多供应商路由后可追溯）
    db.prepare('INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,blocked,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(session_id, msgInfo.lastInsertRowid, agent?.id || null, genMeta?.model || model || agent?.model || '', 'real', Date.now() - tStart, tokens, promptChars,
        JSON.stringify(kbHits.map(h => ({ file: h.file, kb: h.kb, score: h.score, bm25: h.bm25, vec: h.vec, excerpt: h.content.slice(0, 120) }))),
        JSON.stringify(toolTrace), blockedNote, now());

    send('done', { content: outMasked, tokens, model: genMeta?.model, provider: genMeta?.provider, mid: Number(msgInfo.lastInsertRowid) });

    // 用户问题建议（借鉴 SinguX「用户问题建议」）：回复后推荐 3 条追问，done 后异步生成不阻塞主回复；
    // 生成后回写 chat_traces，历史会话回看时建议同样可见；智能体可经 suggest_enabled 关闭
    // P5.29：用户停止生成时不再异步生成建议/标题/记忆——已停止的对话不值得再烧一次模型调用，直接收尾
    const wantSuggestions = !stopped && (agent ? agent.suggest_enabled !== 0 : true);
    (wantSuggestions
      ? genSuggestions(input, outMasked, agent?.name)
      : Promise.resolve([])
    )
      .then(list => {
        if (list.length) {
          send('suggestions', { list });
          try {
            db.prepare('UPDATE chat_traces SET suggestions=? WHERE message_id=?').run(JSON.stringify(list), msgInfo.lastInsertRowid);
          } catch { /* 回写失败不影响对话 */ }
        }
        // 会话标题自动生成（P2）：首条对话后命名「新会话」，SSE 推送前端实时更新侧栏
        if (stopped) return null; // P5.29：用户停止生成——标题也不再异步生成，直接收尾
        return genSessionTitle(session_id, input, agent?.name);
      })
      .then(title => {
        if (title) send('title', { sid: session_id, title });
        // 长期记忆（借鉴 SinguX「记忆-长期记忆」）：开启后异步提取本轮值得记住的用户特征事实
        if (!stopped && agent?.long_memory) { // P5.29：停止的对话不提取记忆（内容不完整）
          return extractMemory(agent, req.user.username, input, outMasked);
        }
      })
      .catch(() => { /* 建议/标题/记忆生成失败不影响对话 */ })
      .finally(() => res.end());
    return;
  } catch (e) {
    console.error('[chat] 对话异常：', e);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('chat-service', '对话链路异常：' + e.message, now());
    send('error', { msg: '对话服务异常：' + e.message });
  }
  res.end();
});

// ---------- 视频生成任务代理（多供应商路由，任务归属优先） ----------
// 查询进度：前端轮询。完成时后端将 mp4 缓存到本地 public/uploads/videos/，
// 返回静态 content_url（<video> 标签无法携带 Authorization 头，必须走静态文件）
router.get('/video/tasks/:taskId', async (req, res) => {
  try {
    const q = await skills.queryVideoTask(req.params.taskId);
    const j = q.data;       // 任务状态（查询/拉内容直连归属供应商，不再绑死默认供应商）
    const prov = q.provider;
    const status = j.status || j.state || 'queued';
    const done = ['succeeded', 'success', 'completed', 'complete'].includes(status);
    const out = {
      task_id: req.params.taskId,
      status: done ? 'succeeded' : status,
      progress: typeof j.progress === 'number' ? j.progress : (done ? 100 : 0),
      content_url: `/api/chat/video/tasks/${req.params.taskId}/content`,
    };
    if (done) {
      // 缓存到本地（幂等：已存在直接用；用归属供应商拉取）
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '..', '..', 'public', 'uploads', 'videos');
      fs.mkdirSync(dir, { recursive: true });
      const local = path.join(dir, `${req.params.taskId}.mp4`);
      if (!fs.existsSync(local) && prov) {
        const url = prov.base_url.replace(/\/+$/, '') + `/videos/tasks/${encodeURIComponent(req.params.taskId)}/content`;
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + prov.api_key }, signal: AbortSignal.timeout(120000) });
        if (r.ok) fs.writeFileSync(local, Buffer.from(await r.arrayBuffer()));
      }
      if (fs.existsSync(local)) out.content_url = `/uploads/videos/${req.params.taskId}.mp4`;
    }
    res.json({ code: 0, data: out });
  } catch (e) {
    res.json({ code: 502, msg: '查询失败：' + e.message });
  }
});

// mp4 内容流式代理（上游需鉴权，浏览器直链不可达，经平台转发；归属供应商优先，否则逐个尝试）
router.get('/video/tasks/:taskId/content', async (req, res) => {
  const candidates = skills.videoProviderOf(req.params.taskId)
    ? [skills.videoProviderOf(req.params.taskId)]
    : skills.providers();
  if (!candidates.length) return res.status(502).json({ code: 502, msg: '未配置模型供应商' });
  let lastErr = '';
  for (const p of candidates) {
    try {
      const url = p.base_url.replace(/\/+$/, '') + `/videos/tasks/${encodeURIComponent(req.params.taskId)}/content`;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + p.api_key }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
      const len = r.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      const buf = Buffer.from(await r.arrayBuffer());
      return res.send(buf);
    } catch (e) { lastErr = e.message; }
  }
  res.status(502).json({ code: 502, msg: '获取视频内容失败' + (lastErr ? '（' + lastErr + '）' : '') });
});

// V1.2 #2 2026-10-30：resolveKbFilter 挂到 router 导出上（冒烟用例直测占位符替换/fail-closed 语义，无需起服务）
module.exports = router;
module.exports.resolveKbFilter = resolveKbFilter;
