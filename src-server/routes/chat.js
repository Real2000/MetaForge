/** 会话 + 对话（SSE 流式：敏感词→知识库检索→模型/模拟→输出过滤→落库统计） */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, now, upsertCheckpoint, getCheckpoint, deleteCheckpoint } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { chat, chatOnce } = require('../lib/llm');
const { retrieve } = require('../lib/retriever');
const { check, countHits, mask, detectPII, maskPII, detectInjection, logSecurityEvent } = require('../lib/security');
const dify = require('../lib/dify');
const coze = require('../lib/coze');
const { buildTools, runTool, loadMcpTools, toolRiskOf, AGENT_TOOL_DENY } = require('../lib/tools');
const skills = require('../lib/skills');
const { checkQuota, addUsage } = require('../lib/quota');
const { recordModelUsage } = require('../lib/billing'); // U1-6：主链路成本归因记账
const billingGate = require('../lib/billing-gate'); // D2-2：计费预检—预留—结算闸门
const { parseSkillMentions, parseAgentMentions } = require('../lib/skill-mention');
const { canView } = require('../lib/agent-access');
const { finishExternalTurn } = require('../lib/chat-sink'); // P5.33：外部/技能链路统一收尾（唯一记账/落库/审计点）

const router = express.Router();

// V1.2 审查加固 2026-10-30：resolveKbFilter 迁至 lib/kb-metadata.js（chat/share/openapi/workflow 四链路共用；
// 挂 router 导出会引发 workflow→chat 循环依赖）；此处引用，文件尾透传导出（smoke 单测沿用 chat.js 入口）
const { resolveKbFilter } = require('../lib/kb-metadata');
// D1-2 专家团式并行编排：任务图校验/分层/并发执行/单节点重跑（纯逻辑，可测试）
const orchestrator = require('../lib/orchestrator');
const { validateTaskGraph, runTaskGraph } = orchestrator;
// D3-2 经验自进化：专家×任务类型可靠度聚合 + 编排优选（纯逻辑；记录回写复用 experience 路由的 recordRun）
const experience = require('../lib/experience');
const experienceRoutes = require('./experience');

// P5.25 工具确认等待队列（U0-5 P1 抽到 lib/tool-confirm-registry）：stream 请求注册等待 →
// 前端 /confirm 与 IM 卡片回调 /card-callback 两条决议路径共用同一份注册表跨请求唤醒
const toolConfirmRegistry = require('../lib/tool-confirm-registry'); // { register, get, del, resolveByKey }
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
 *  去重后落库 agent_memories。P1-4 增加 type/confidence/source/summary 字段，支持事实/偏好/摘要三种类型 */
async function extractMemory(agent, username, userInput, assistantReply) {
  try {
    const existing = db.prepare('SELECT fact, type FROM agent_memories WHERE agent_id=? AND username=?').all(agent.id, username).map(r => ({ fact: r.fact, type: r.type }));
    const existingFacts = existing.map(r => r.fact);
    const r = await chatOnce([
      { role: 'system', content: `你是用户记忆提取器。根据对话内容提取值得长期记住的当前用户特征事实（如职业、偏好、称呼、业务背景），忽略一次性问题内容。
规则：只输出 JSON 数组（如 ["用户是银行客户经理","用户偏好简洁回复"]），最多 3 条，每条不超过 25 字；没有值得记住的内容输出 []；不要其他任何文字。` },
      { role: 'user', content: `已知记忆：${existingFacts.join('；') || '（无）'}\n用户提问：${userInput.slice(0, 200)}\n智能体回答（节选）：${(assistantReply || '').slice(0, 300)}` },
    ], { temperature: 0.3, max_reply: 150, agentName: '记忆提取' });
    const m = (r.full || '').match(/\[[\s\S]*\]/);
    if (!m) return;
    const facts = JSON.parse(m[0]).filter(x => typeof x === 'string' && x.trim()).slice(0, 3).map(x => x.trim().slice(0, 40));
    for (const f of facts) {
      if (existingFacts.some(e => e.includes(f) || f.includes(e))) continue; // 去重（含互为子串）
      const type = /偏好|喜欢|不喜欢|希望|想要/.test(f) ? 'preference' : 'fact';
      db.prepare('INSERT INTO agent_memories (agent_id,username,fact,type,confidence,source,created_at) VALUES (?,?,?,?,1.0,?,?)').run(agent.id, username, f, type, 'chat', now());
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
  // MT-05（2026-11-22）：多租户下强制注入 tenant_id（单租户 scope=null，零回归）。
  const scope = require('../lib/dal').tenantScope(req);
  let sql = 'SELECT s.*, a.name AS agent_name FROM sessions s LEFT JOIN agents a ON a.id=s.agent_id WHERE s.username=?';
  const args = [req.user.username];
  if (scope != null) { sql += ' AND s.tenant_id=?'; args.push(scope); }
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
  // P1-6 分支回放：?branch=br-xxx 查看归档线；默认返回当前活跃线（sessions.active_branch，老数据 main）
  const branch = String(req.query.branch || '').trim() || (db.prepare('SELECT active_branch FROM sessions WHERE id=?').get(req.params.id)?.active_branch || 'main');
  const rows = db.prepare('SELECT * FROM messages WHERE session_id=? AND branch=? ORDER BY id').all(req.params.id, branch);
  const traceStmt = db.prepare('SELECT kb_hits, tool_calls, suggestions FROM chat_traces WHERE message_id=? ORDER BY id DESC LIMIT 1');
  const out = rows.map(m => {
    if (m.role !== 'assistant') return m;
    const t = traceStmt.get(m.id);
    if (!t) return m;
    try {
      return { ...m, kbHits: JSON.parse(t.kb_hits || '[]'), toolCalls: JSON.parse(t.tool_calls || '[]'), suggestions: JSON.parse(t.suggestions || '[]') };
    } catch { return m; }
  });
  res.json({ code: 0, data: { branch, list: out } });
});

// ---------------- P1-6 会话检查点 v2：断点续跑 + 分支回放（2026-11-12） ----------------
// ① GET /chat/sessions/:id/checkpoint —— 查询未完成检查点（前端打开会话时探测「继续生成」卡片）
router.get('/sessions/:id/checkpoint', (req, res) => {
  const sess = db.prepare('SELECT username FROM sessions WHERE id=?').get(req.params.id);
  if (!sess) return res.json({ code: 404, msg: '会话不存在' });
  if (sess.username !== req.user.username) return res.json({ code: 403, msg: '无权访问该会话' });
  const ck = getCheckpoint(req.params.id);
  // done 态不该出现（完成即删）；generating 态视为进行中无需续跑；仅 aborted 可续
  if (!ck || ck.status === 'done' || ck.status === 'generating') return res.json({ code: 0, data: null });
  res.json({ code: 0, data: ck });
});

// ② POST /chat/sessions/:id/resume —— 续跑：把 partial 作为前情继续生成，产出一条完整 assistant 消息
//    不重复写 user 消息；续写不带工具/检索（纯文本续写，避免重复副作用）
router.post('/sessions/:id/resume', async (req, res) => {
  const sess = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id);
  if (!sess) return res.json({ code: 404, msg: '会话不存在' });
  if (sess.username !== req.user.username) return res.json({ code: 403, msg: '无权访问该会话' });
  const ck = getCheckpoint(req.params.id);
  if (!ck || ck.status !== 'aborted') return res.json({ code: 400, msg: '该会话没有可续跑的检查点' });
  if (ck.partial_content.length < 10) return res.json({ code: 400, msg: '中断内容过短，无续跑价值，请重新提问' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let clientClosed = false;
  res.on('close', () => { if (!res.writableEnded) clientClosed = true; });
  const send = (event, data) => { if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  try {
    // 续跑前情：历史 + partial 快照 + 续写指令（明确要求接续而非重答）
    const history = db.prepare('SELECT role, content FROM messages WHERE session_id=? AND branch=IFNULL((SELECT active_branch FROM sessions WHERE id=?),"main") ORDER BY id').all(req.params.id, req.params.id)
      .map(m => ({ role: m.role, content: m.content }));
    const resumePrompt = [
      `你之前的回复在生成中途意外中断，已生成内容如下（可能不完整，句子可能戛然而止）：`,
      `"""\n${ck.partial_content}\n"""`,
      `请从中断处自然续写，直接接续上文语义与格式（不要重复已生成内容，不要道歉，不要重新开头；若上文是 markdown 列表/代码块中断，则补完该结构）。`,
    ].join('\n');
    const messages = [...history, { role: 'user', content: resumePrompt }];

    const gen = chat(messages, { model: ck.model || undefined, username: req.user.username, max_reply: undefined });
    send('delta', { text: '' }); // 触发前端"生成中"态
    let full = '';
    let genMeta = null;
    let ckLastLen = 0;
    try {
      while (true) {
        const r = await gen.next();
        if (r.done) { full = r.value.full; genMeta = r.value; break; }
        if (r.value.delta) { full += r.value.delta; send('delta', { text: r.value.delta }); }
        if (full.length - ckLastLen >= 200) {
          ckLastLen = full.length;
          try { upsertCheckpoint(req.params.id, { userContent: ck.user_content, partialContent: full, status: 'generating', model: ck.model }); } catch { }
        }
        if (clientClosed) break; // 客户端断开：保留 generating 态检查点（重开可再续）
      }
    } catch (e) {
      if (clientClosed || e?.name === 'AbortError' || e?.aborted) { /* 断开：保留快照 */ }
      else {
        try { upsertCheckpoint(req.params.id, { userContent: ck.user_content, partialContent: full || ck.partial_content, status: 'aborted', model: ck.model }); } catch { }
        throw e;
      }
    }
    if (clientClosed) return res.end(); // 断开：partial 已在检查点，重开会话可再续跑

    // 续跑完成：完整内容落库为一条 assistant 消息 + 清检查点
    const tokens = Math.ceil(full.length * 0.6);
    const msgInfo = db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
      .run(req.params.id, 'assistant', full, tokens, now());
    addUsage(req.user.username, tokens);
    // U1-6 成本归因（续跑链路）：模型取检查点/路由记录的 model，输入按检查点存量内容估算
    try {
      recordModelUsage({
        username: req.user.username,
        model: genMeta?.model || ck.model || 'default',
        provider: genMeta?.provider,
        promptTokens: Math.ceil((ck.user_content || '').length * 0.6) + Math.ceil((ck.partial_content || '').length * 0.6),
        completionTokens: tokens,
        meta: { mode: 'resumed' },
      });
    } catch (e) { console.error('[chat] U1-6 续跑成本归因失败（不阻断）：', e.message); }
    db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), req.params.id);
    deleteCheckpoint(req.params.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '断点续跑', `会话 #${req.params.id} 从 ${ck.partial_content.length} 字符处续写至 ${full.length} 字符`, req.ip, now());
    send('done', { content: full, tokens, model: genMeta?.model, provider: genMeta?.provider, mid: Number(msgInfo.lastInsertRowid), resumed: true });
    res.end();
  } catch (e) {
    console.error('[chat] 续跑异常：', e);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('chat-service', '断点续跑异常：' + e.message, now());
    send('error', { msg: '续跑失败：' + e.message });
    res.end();
  }
});

// ③ GET /chat/sessions/:id/branches —— 分支列表（回放产生的归档线）
//    main = 当前活跃线；br-{ts} = 从某消息回放后归档的旧线（只读保留，防误删上下文）
router.get('/sessions/:id/branches', (req, res) => {
  const sess = db.prepare('SELECT username FROM sessions WHERE id=?').get(req.params.id);
  if (!sess) return res.json({ code: 404, msg: '会话不存在' });
  if (sess.username !== req.user.username) return res.json({ code: 403, msg: '无权访问该会话' });
  const rows = db.prepare(`SELECT branch, COUNT(*) AS msgs, MIN(created_at) AS since, MAX(created_at) AS until
    FROM messages WHERE session_id=? GROUP BY branch ORDER BY branch='main' DESC, since DESC`).all(req.params.id);
  res.json({ code: 0, data: rows });
});

// ④ POST /chat/messages/:id/replay —— 分支回放：从该消息（锚点）后重新生成
//    语义：锚点之后的所有消息从 main 归档到 br-{ts}（只读保留），main 截断至锚点，
//    模型对锚点消息（user 问句）重新作答。原消息保留在归档线，不删除任何内容。
router.post('/messages/:id/replay', async (req, res) => {
  const m = db.prepare('SELECT m.*, s.username AS sess_owner FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.json({ code: 404, msg: '消息不存在' });
  if (m.sess_owner !== req.user.username) return res.json({ code: 403, msg: '无权回放该会话消息' });
  if (m.role !== 'assistant') return res.json({ code: 400, msg: '只能从 AI 回复处回放' });
  // 锚点必须仍在 main 分支上（归档线只读，不允许在归档线上再回放）
  if ((m.branch || 'main') !== 'main') return res.json({ code: 400, msg: '归档分支为只读，请回到当前主线回放' });

  // 锚点的问句：锚点本身是 assistant → 其前面最近的一条 user 消息（同 main 分支）
  const anchorUser = db.prepare(`SELECT id, content FROM messages WHERE session_id=? AND role='user' AND branch='main' AND id<? ORDER BY id DESC LIMIT 1`)
    .get(m.session_id, m.id);
  if (!anchorUser) return res.json({ code: 400, msg: '未找到锚点对应的用户问句，无法回放' });

  const branchName = `br-${Date.now()}`;
  // 归档锚点及其后所有 main 分支消息 → br-{ts}；main 截断在锚点之前（事务保证原子）
  const tx = db.transaction(() => {
    db.prepare(`UPDATE messages SET branch=? WHERE session_id=? AND branch='main' AND id>=?`)
      .run(branchName, m.session_id, m.id);
    db.prepare('UPDATE sessions SET active_branch=?, updated_at=? WHERE id=?')
      .run('main', now(), m.session_id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '分支回放', `会话 #${m.session_id}：消息 #${m.id} 起归档为 ${branchName}，主线将重新生成`, req.ip, now());
  });
  tx();
  res.json({ code: 0, data: { branch: branchName, anchor_msg_id: m.id, user_question_id: anchorUser.id, user_question: anchorUser.content }, msg: '已回放，正在重新生成' });
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
// #10 LLMOps（2026-10-31）四视图扩展：data 追加 llm（token 成本）/ kb（检索命中率）/ eval（评测得分趋势）
// 三新块；原有 list/stat 字段与结构保持不变（防破坏现有前端），由 public/js/admin/quality.js 四视图消费。
// 聚合全部 SQL 下推（stats.js L17 教训：禁止全表读进内存 JS 聚合——SUM/GROUP BY + LIMIT），仅对聚合结果做 ≤14 行空天补齐
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

  // ---------- #10 LLMOps：llm 块（token 成本） ----------
  // 近 14 天窗口（Asia/Shanghai，与 now() 落库时区一致）；days 仅用于补齐空天（14 行结果，非全表操作）
  const days14 = Array.from({ length: 14 }, (_, i) =>
    new Date(Date.now() - (13 - i) * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  const since14 = days14[0] + ' 00:00:00';
  const dayRows = db.prepare(`SELECT substr(created_at,1,10) AS d, COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS calls
    FROM chat_traces WHERE created_at >= ? GROUP BY substr(created_at,1,10)`).all(since14);
  const dayMap = new Map(dayRows.map(r => [r.d, r]));
  const llm = {
    // 按天（空天补 0，保证前端 14 天柱状连续）
    tokens_by_day: days14.map(d => ({ day: d, tokens: dayMap.get(d)?.tokens || 0, calls: dayMap.get(d)?.calls || 0 })),
    // 按模型 TOP10（空 model 归「未知」）
    tokens_by_model: db.prepare(`SELECT CASE WHEN model IS NULL OR model='' THEN '未知' ELSE model END AS model,
      COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS calls
      FROM chat_traces GROUP BY model ORDER BY tokens DESC LIMIT 10`).all(),
    // 按智能体 TOP10（agent 已删显示「已删除」；agent_id 为 NULL = 首页助手直连对话）
    tokens_by_agent: db.prepare(`SELECT CASE WHEN t.agent_id IS NULL THEN '首页助手' ELSE COALESCE(a.name,'已删除') END AS agent_name,
      COALESCE(SUM(t.tokens),0) AS tokens, COUNT(*) AS calls
      FROM chat_traces t LEFT JOIN agents a ON a.id=t.agent_id
      GROUP BY t.agent_id ORDER BY tokens DESC LIMIT 10`).all(),
  };

  // ---------- #10 LLMOps：kb 块（检索命中率） ----------
  // 口径说明：chat_traces 未记录检索时刻 agent 是否挂库（kb_id 不落 trace，历史对话无法精确回放当时配置），
  // 采用「JOIN agents 当前配置」近似——分母 = agent 当前仍挂知识库（agents.kb_id 非空）的全部对话 trace；
  // agent 已删除或已解绑知识库的历史对话不计入分母（挂库总量低估，命中率在口径内精确）。
  // 命中定义 = kb_hits 为非空 JSON 数组（写入端 JSON.stringify(kbHits)：未命中/外部链路固定写 '[]'，
  // 正常不会产生 NULL/''，SQL 仍防御性排除）。「挂库未命中」在分母内、「历史未挂库」已排除——
  // 本表内可区分的边界即止于此，无法区分的部分不计入（宁少勿错）。
  const kbRow = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN t.kb_hits IS NOT NULL AND t.kb_hits != '' AND t.kb_hits != '[]' THEN 1 ELSE 0 END),0) AS hit
    FROM chat_traces t JOIN agents a ON a.id=t.agent_id
    WHERE a.kb_id IS NOT NULL AND a.kb_id != ''`).get();
  const kb = {
    hit_rate: kbRow.total ? Math.round(kbRow.hit / kbRow.total * 100) : null, // 无挂库对话时 null（前端显示「—」）
    hit_count: kbRow.hit,
    total_with_kb: kbRow.total,
  };

  // ---------- #10 LLMOps：eval 块（评测得分趋势，V1.3 #6 evaluations 表） ----------
  // 近 14 天每次重跑的按天平均得分趋势；仅计入 status='done' 的已完结评测（running 时 score 无意义）；
  // agent 级与知识库级（type='agent'/'kb'）合并统计口径（LLMOps 质量大盘不区分用途）；无数据返回空数组
  const evalTrend = db.prepare(`SELECT substr(created_at,1,10) AS day, ROUND(AVG(score),2) AS avg_score, COUNT(*) AS runs
    FROM evaluations WHERE created_at >= ? AND status='done'
    GROUP BY substr(created_at,1,10) ORDER BY day`).all(since14);

  res.json({ code: 0, data: { list: rows, stat, llm, kb, eval: evalTrend } });
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
        // D1-1（决策2=A）：放开 local_exec——子智能体可在设备档位+确认卡约束下操作本地设备；仅保留 create_task 禁入
        if (name === 'create_task') {
          return `⛔ 工具 ${name} 不允许在子智能体执行上下文中调用——请直接完成当前任务，不要尝试创建新任务。`;
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

/** ⑧ D1-2 专家团编排（2026-11-20）：让编排器产出「任务图 JSON」——节点=子智能体/验证，depends_on 表达依赖 */
async function planTaskGraph(agent, childTools, userInput, history) {
  const list = childTools.map(c => `- agent_id=${c.child.id}（${c.child.name}）：${(c.child.description || '专业子智能体').slice(0, 80)}`).join('\n');
  const hist = (history || []).slice(-4).map(h => `${h.role}: ${String(h.content || '').slice(0, 200)}`).join('\n');
  // D3-2 经验自进化：按用户任务的归类，给出各候选专家的历史可靠度提示，引导编排器优先高分专家
  //（读取失败不阻断编排——经验只是"增益"，非"依赖"）
  let hint = '';
  try {
    const taskType = experience.classifyTask(userInput);
    const agents = childTools.map(c => ({ id: c.child.id, name: c.child.name }));
    const records = db.prepare('SELECT * FROM agent_experience').all();
    hint = experience.experienceHint(experience.rankAgents(agents, records, taskType));
  } catch { /* 经验读取失败不影响编排 */ }
  const sys = `你是专家团编排器。把用户的复杂任务拆解为「任务图 JSON」，由多个子智能体分工并尽可能并行完成，最后安排一个验证节点验收。
只输出 JSON，不要任何解释文字，也不要 markdown 代码围栏。
JSON 结构示例：
{"nodes":[
  {"id":"n1","type":"agent","agent_id":<子智能体id>,"task":"交给该子智能体的完整、自包含任务描述","depends_on":[]},
  {"id":"n2","type":"agent","agent_id":<子智能体id>,"task":"...","depends_on":["n1"]},
  {"id":"verify","type":"verify","task":"验收：核对上游产出是否完整、正确并满足用户需求，列明问题与建议","depends_on":["n1","n2"]}
]}
规则：
- depends_on 写它依赖的节点 id；无依赖的节点会并行执行，有依赖的等待上游完成。
- 恰好包含 1 个 type="verify" 的验证节点，且它依赖所有产出节点。
- 只能使用下方列出的子智能体；不得编造 agent_id。
- 若下方提供「历史经验参考」，在能力相当的情况下优先选用可靠度更高的子智能体（样本偏少者仅供参考，不要因单次记录就否定某专家）。
- 节点总数 2~8；任务简单就不要强行拆分。
- 任务描述要自包含（下游节点会同时收到上游产出）。`;
  const usr = `可选子智能体：\n${list}\n\n${hint ? hint + '\n\n' : ''}${hist ? '近期对话：\n' + hist + '\n\n' : ''}用户任务：${String(userInput).slice(0, 1500)}`;
  const r = await chatOnce([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ], { model: agent.model, temperature: 0.2, max_reply: 1200, agentName: '任务图编排' });
  const m = /\{[\s\S]*\}/.exec(r.full || '');
  if (!m) throw new Error('编排器未返回任务图 JSON');
  return JSON.parse(m[0]);
}

/** 验证节点执行器：用主模型对上游产出做验收，输出结论/问题清单/建议 */
async function runVerifyNode(agent, node, ctx) {
  const sys = `你是验收官。根据「原始任务」「验收要求」与「上游产出」，逐条核对是否满足要求。输出：① 结论（通过/不通过）② 存在的问题或缺口清单 ③ 可行的改进建议。简洁务实，不要复述原文，不要提及"节点""编排"等内部术语。`;
  const usr = `原始任务：${String(ctx.input || '').slice(0, 1000)}\n\n验收要求：${node.task || '核对上游产出是否完整、正确、满足用户需求'}\n\n上游产出：\n${ctx.deps || '（无）'}`;
  const r = await chatOnce([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ], { model: agent.model, temperature: 0.2, max_reply: 800, agentName: '验收节点' });
  return r.full || '';
}

/** 汇总器：把各节点产出与验证结论整合为对用户的最终答复 */
async function synthesizeOrchestration(agent, input, runResult, graph) {
  const parts = graph.nodes.map(n => {
    const s = runResult.nodes[n.id] || {};
    return `【${n.id}｜${n.title || n.task?.slice(0, 16) || n.type}】(${s.status || '未知'})\n${s.status === 'done' ? (s.output || '') : (s.error || s.output || '无产出')}`;
  });
  const sys = `你是编排汇总器。把各子智能体的产出与验证结论整合为对用户的最终答复：结构清晰、去重、突出结论与可执行建议；验证发现的问题要如实说明。直接输出最终答复，不要提及"节点""编排""子智能体"等内部术语。`;
  const usr = `用户任务：${String(input).slice(0, 800)}\n\n各环节产出：\n${parts.join('\n\n').slice(0, 6000)}`;
  const r = await chatOnce([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ], { model: agent.model, temperature: 0.4, max_reply: agent.max_reply || 2048, agentName: agent.name });
  return r.full || '';
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
  // P3-8（2026-11-09）：SELECT 移除 api_key 列——原仅用于 truthiness（real 标记），改为 SQL 端布尔表达式
  // has_key，密钥材料不再进入 JS 内存/响应链路，防后续维护误用（真实 Key 使用方一律走 decrypt 专用查询）
  const ps = db.prepare("SELECT name, models, configured, (api_key IS NOT NULL AND api_key != '') AS has_key, is_default FROM providers WHERE configured=1").all();
  const out = [];
  for (const p of ps) {
    let ms = [];
    try { ms = JSON.parse(p.models || '[]'); } catch { ms = []; }
    // P4（2026-10-22）：全量返回（对话/生图/视频/语音/嵌入），type 分类由前端按模式隔离；不再用 isChatModel 过滤
    ms.forEach(m => out.push({ name: m, provider: p.name, real: !!p.has_key, is_default: p.is_default, source: 'platform', type: classifyModel(m) }));
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
 * P5.25 工具执行确认决议：{ key, approve: true/false, reason? }
 * 校验归属（仅发起用户本人可决议）与时效；批准唤醒等待的 executeTool 继续执行，拒绝则返回拒因。
 * P1-14：决议即记录审批人（approver）与决策时间——审计可追溯"谁批的"；
 * 批准的记录由 executeTool 执行完成后回写终态 executed。
 */
router.post('/confirm', (req, res) => {
  const { key, approve, reason } = req.body || {};
  if (!key) return res.status(400).json({ code: 400, msg: '缺少 key' });
  const entry = toolConfirmRegistry.get(key);
  if (!entry) return res.status(404).json({ code: 404, msg: '确认请求不存在或已处理（可能已超时）' });
  if (entry.username !== req.user.username) return res.status(403).json({ code: 403, msg: '仅发起对话的用户可确认' });
  toolConfirmRegistry.resolveByKey(key, approve === true, req.user.username, reason);
  res.json({ code: 0, msg: approve === true ? '已批准执行' : '已拒绝执行' });
});

/** P1-14 审批记录查询（adminOnly）：五态审批台账 */
router.get('/approvals', adminOnly, (req, res) => {
  const { status, q } = req.query;
  const wh = [];
  const args = [];
  if (status && status !== 'all') { wh.push('status=?'); args.push(status); }
  if (q) { wh.push('(tool_name LIKE ? OR requester LIKE ? OR approver LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT * FROM tool_approvals${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
  res.json({ code: 0, data: rows });
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
  // D2-2：本请求的计费预留句柄——结算置 gateSettled；异常/中断由 releaseGate 幂等回滚
  let gateId = null, gateSettled = false;
  const releaseGate = (reason) => {
    if (gateId && !gateSettled) { try { billingGate.release(gateId, reason); } catch { /* 回滚失败不阻断 */ } }
    gateId = null;
  };
  const settleGate = ({ promptTokens, completionTokens, model, provider }) => {
    if (!gateId) return;
    try { billingGate.settle({ request_id: gateId, promptTokens, completionTokens, model, provider }); } catch { /* 结算失败不阻断 */ }
    gateSettled = true; gateId = null;
  };
  res.on('close', () => {
    if (res.writableEnded) return; // 正常结束（已 res.end）后的连接关闭不算中断
    clientClosed = true;
    releaseGate('client_aborted'); // D2-2：客户端中止——未结算的预留即刻回滚（释放并发名额）
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

    // 0b. D2-2 计费预检：并发上限 + 成本配额（在 Token 配额之上再兜一层），命中即拦截并落 blocked 台账
    const gate = billingGate.precheck({ username: req.user.username, model: model || '', provider: '', promptText: input });
    if (!gate.ok) {
      send('blocked', { msg: gate.reason });
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run(req.user.username, '计费拦截', `${gate.code}：${gate.reason}`, req.ip, now());
      return res.end();
    }
    gateId = gate.request_id; // 预留成功——后续 settle 结算 / release 回滚

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
          // P3-5（2026-11-09）：创建时传入归属用户，轮询/拉内容端点据此拒绝非本人访问
          const r = await skills.createVideoTask(input, 4, '16:9', req.user.username);
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
      // tokens 外部 usage 优先（0 视为缺省按内容估算，与原 || 语义一致）；U1-6 拆分基数同传真实 usage
      finishExternalTurn({
        send, sessionId: session_id, username: req.user.username, ip: req.ip,
        input, full, agent,
        modelLabel: agent.model || 'dify-app', modeLabel: 'dify', tStart,
        tokens: usage?.total_tokens || undefined,
        promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
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

      // P5.33：统一收尾经 ConversationSink（同 Dify：脱敏/ext会话回写/usage 优先记账）；U1-6 拆分基数同传真实 usage
      finishExternalTurn({
        send, sessionId: session_id, username: req.user.username, ip: req.ip,
        input, full, agent,
        modelLabel: agent.model || 'coze-bot', modeLabel: 'coze', tStart,
        tokens: usage?.total_tokens || undefined,
        promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
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
    // P1-2 修复：attachments 注入 wf_files 数据时仅查询自己上传的文件（非管理员）
    // 如果 attachRows.length < attachIds.length 说明有文件被过滤（非己上传），通知用户
    const ownFilter = (req.user?.role !== 'admin' && req.user?.username)
      ? (id) => db.prepare('SELECT * FROM wf_files WHERE id=? AND created_by=?').get(id, req.user.username)
      : (id) => db.prepare('SELECT * FROM wf_files WHERE id=?').get(id);
    const attachRows = attachIds.map(id => ownFilter(id)).filter(Boolean);
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

    // 3. 组装 messages 用的历史轮数（AI-01：提前到检索之前，供多轮指代消解改写查询使用）
    let history = agent?.context_rounds
      ? db.prepare('SELECT role, content FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(session_id, agent.context_rounds * 2)
      : db.prepare('SELECT role, content FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 20) ORDER BY id').all(session_id);

    // 2. 知识库检索（混合检索：BM25 + 向量，RRF 融合；@技能标记已移除，检索更准）
    let kbContext = [];
    let kbHits = [];
    const retrievalTrace = {}; // AI-09/AI-13：检索诊断（改写/重排/引擎），随 chat_traces.retrieval_trace 落库
    if (agent && agent.kb_id) {
      // V1.2 #2 2026-10-30：元数据过滤联动——resolveKbFilter 解析 agent.kb_metadata_filter
      // （$user.dept 占位符按请求用户部门替换）；有过滤且无命中即无上下文（fail-closed 设计语义，不兑底放开）。
      // threshold 0.01 为原 3 参调用的默认值，显式写出保语义不变
      // AI-01：传入 history → 检索前多轮指代消解改写（改写失败静默回落原 query，绝不阻断）
      kbHits = await retrieve(chatInput.trim() || input, agent.kb_id, 5, 0.01, { metadataFilter: resolveKbFilter(agent, req.user) || undefined, history, username: req.user?.username, tenantId: req.user?.tenant_id, trace: retrievalTrace });
      kbContext = kbHits.map(h => h.content);
      if (kbHits.length) send('kb', { hits: kbHits });
    }

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
      memRows = db.prepare('SELECT fact, type, confidence FROM agent_memories WHERE agent_id=? AND username=? ORDER BY type ASC, confidence DESC LIMIT 20').all(agent.id, req.user.username);
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
    // AI-06：长对话上下文压缩——超 token 预算时折叠早期轮次为摘要、保留最近 N 轮原文（context_rounds 为上限）；
    // 任何异常静默回落原 history，绝不阻断对话（与 AI-01 改写同哲学）
    try {
      const cr = await require('../lib/context-manager').compressHistory(history, {
        contextRounds: agent?.context_rounds, username: req.user?.username, tenantId: req.user?.tenant_id, trace: retrievalTrace.context,
      });
      if (cr.compressed) { history = cr.messages; send('notice', { msg: `🗜️ 会话较长，已压缩较早的 ${cr.summarizedTurns} 条历史为摘要（保留最近轮次原文）` }); }
    } catch { /* 压缩失败不影响对话 */ }
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
    // ⑧ D1-2 专家团式并行编排：routing_mode='orchestrate' 时先产出任务图 JSON → 校验（环/悬空/验证节点必填）
    //   → 按图并行执行（并发上限/超时/重试）→ 汇总结论；计划不可用则回退主模型 function calling 编排（不破坏存量）
    let orchestrateGen = null;
    if (agent?.routing_mode === 'orchestrate' && childTools.length && (chatInput.trim() || input)) {
      const childIds = childTools.map(t => t.child.id);
      const childMap = new Map(childTools.map(t => [t.child.id, t.child]));
      const orchInput = chatInput.trim() || input;
      let spec = null, planErr = '';
      try { spec = await planTaskGraph(agent, childTools, orchInput, history); }
      catch (e) { planErr = e.message; }
      const v = spec ? validateTaskGraph(spec, { allowedAgentIds: childIds }) : { ok: false, errors: ['编排计划生成失败' + (planErr ? '：' + planErr : '')] };
      if (!v.ok) {
        send('notice', { msg: `🧩 专家团编排不可用（${(v.errors || [])[0] || '未知原因'}），已回退主模型编排` });
      } else {
        orchestrateGen = (async function* () {
          send('notice', { msg: `🧩 专家团并行编排：${v.graph.nodes.length} 节点 / ${v.levels.length} 层（同层并行）` });
          const t0 = Date.now();
          const runInfo = db.prepare(`INSERT INTO orchestration_runs (agent_id,session_id,username,status,graph,started_at) VALUES (?,?,?,?,?,?)`)
            .run(agent.id, session_id || null, req.user.username, 'running', JSON.stringify(v.graph), now());
          const runId = runInfo.lastInsertRowid;
          const nodeLogs = {};
          const evTag = evt => `${evt.title || evt.nodeId}（${evt.type === 'verify' ? '验收' : '子智能体#' + evt.agent_id}）`;
          const onEvent = evt => {
            if (evt.event === 'nodeStart') send('tool', { name: evTag(evt), status: 'executing' });
            else if (evt.event === 'nodeDone') send('tool', { name: evTag(evt), status: evt.ok ? 'finished' : 'failed', result: (evt.preview || '').slice(0, 120) });
            else if (evt.event === 'nodeBlocked') send('tool', { name: `${evt.title || evt.nodeId}`, status: 'finished', result: '上游未成功，已跳过' });
          };
          const runAgent = (node, ctx) => {
            const child = childMap.get(node.agent_id);
            if (!child) throw new Error(`子智能体 #${node.agent_id} 不存在`);
            const task = node.task + (ctx.deps ? `\n\n【上游产出】\n${ctx.deps}` : '');
            return runChildAgent(child, task, agent?.max_reply, req.user).then(t => ({ text: t }));
          };
          const runVerify = (node, ctx) => runVerifyNode(agent, node, { ...ctx, input: orchInput }).then(t => ({ text: t }));
          let runResult;
          try {
            runResult = await runTaskGraph(v.graph, {
              runAgent, runVerify, input: orchInput, onEvent,
              onNodeState: (id, st) => { nodeLogs[id] = { status: st.status, error: st.error, retries: st.retries, durationMs: st.durationMs, tokens: st.tokens }; },
            });
          } catch (e) {
            db.prepare(`UPDATE orchestration_runs SET status='error', error=?, node_logs=?, total_duration_ms=?, finished_at=? WHERE id=?`)
              .run(String(e.message || e).slice(0, 500), JSON.stringify(nodeLogs), Date.now() - t0, now(), runId);
            throw e;
          }
          // D3-2 经验自进化：把各子智能体节点的产出结果回写为经验（按节点任务归类累积「专家×任务类型」可靠度）；
          // 回写失败不影响编排结果——经验是增益，非依赖
          try {
            for (const n of v.graph.nodes) {
              if (n.type !== 'agent' || n.agent_id == null) continue;
              const st = runResult.nodes[n.id];
              if (!st || (st.status !== 'done' && st.status !== 'failed')) continue;
              experienceRoutes.recordRun({ agent_id: n.agent_id, task_text: n.task, success: st.status === 'done', duration_ms: st.durationMs || 0 });
            }
          } catch { /* 经验回写失败不影响编排结果 */ }
          let final = '';
          try { final = await synthesizeOrchestration(agent, orchInput, runResult, v.graph); }
          catch (e) { final = '（汇总失败，以下为各环节产出）\n' + String(e.message || e); }
          const summary = orchestrator.summarizeRun(runResult);
          const out = final + `\n\n> 🧩 专家团编排：${summary.total} 节点 / ${summary.levels} 层 / ${summary.done} 成功${summary.failed ? ' · ' + summary.failed + ' 失败' : ''} · 并行度 ${Math.round(summary.parallelRatio * 100)}% · 耗时 ${(summary.durationMs / 1000).toFixed(1)}s`;
          db.prepare(`UPDATE orchestration_runs SET status=?, node_logs=?, result=?, total_tokens=?, total_duration_ms=?, finished_at=? WHERE id=?`)
            .run(runResult.ok ? 'success' : 'partial', JSON.stringify(runResult.nodes), out.slice(0, 8000), runResult.totalTokens, summary.durationMs, now(), runId);
          yield { delta: out };
          return { full: out, model: agent.model, provider: 'orchestrate' };
        })();
      }
    }
    // P5.25 对话权限闸门（图 2 语义）：「默认权限」下 medium/high 风险工具执行前需用户确认——
    // SSE 推 tool_confirm 事件 → 前端在消息流中弹确认卡 → 用户批准/拒绝 → POST /api/chat/confirm 决议唤醒等待；
    // 「全自动执行」（perm='auto'）全部放行；low 风险永不拦截（确认疲劳无意义）；120s 未决议按拒绝处理防会话悬挂
    const chatPerm = String((req.body || {}).perm || 'default') === 'auto' ? 'auto' : 'default';
    // P1-14 HITL 五态审批：pending → approved/rejected/expired；批准且执行完 → executed
    // 每次确认全程落 tool_approvals（含审批人与决策时间），审计可查
    const waitUserConfirm = (toolKey, name, argsJson) => new Promise(resolve => {
      db.prepare('INSERT INTO tool_approvals (confirm_key, tool_name, args_json, requester, status, created_at) VALUES (?,?,?,?,"pending",?)')
        .run(toolKey, name, String(argsJson || '').slice(0, 500), req.user.username, now());
      const finalizeApproval = (status, approver, reason) => {
        db.prepare('UPDATE tool_approvals SET status=?, approver=?, decision_at=?, reason=? WHERE confirm_key=? AND status=\'pending\'')
          .run(status, approver || '', now(), String(reason || '').slice(0, 200), toolKey);
      };
      const timer = setTimeout(() => { toolConfirmRegistry.del(toolKey); finalizeApproval('expired'); resolve('timeout'); }, 120000);
      // P5.29：用户停止生成时立即结束确认等待（否则主循环会卡到 120s 超时才落库 partial）
      abortCleanups.push(() => { clearTimeout(timer); toolConfirmRegistry.del(toolKey); finalizeApproval('expired'); resolve('stopped'); });
      toolConfirmRegistry.register(toolKey, { resolve: v => { clearTimeout(timer); toolConfirmRegistry.del(toolKey); resolve(v); }, finalizeApproval, username: req.user.username, expires: Date.now() + 120000 });
      send('tool_confirm', { key: toolKey, name, args: argsJson });
      // U0-5 R3：向发起用户绑定的「已启用」IM 渠道异步推审批卡。
      // 无绑定/无凭证一律静默跳过（前端 SSE 卡为兜底），失败绝不阻塞前端审批链。
      (async () => {
        try {
          const { send: channelSend, getUserChannelBindings } = require('../lib/channel');
          const binds = getUserChannelBindings(req.user.username);
          if (!binds.length) return;
          const base = `${req.protocol || 'http'}://${req.get ? req.get('host') : ''}`;
          const cbUrl = act => `${base}/api/channel/card-callback?callbackData=${encodeURIComponent(toolKey)}&action=${act}`;
          const argsPreview = String(argsJson || '').slice(0, 300) || '（无参数）';
          for (const b of binds) {
            await channelSend({ channel: b.channel_type, receivers: [b.channel_user_id] }, {
              type: 'card',
              title: `审批请求：${name}`,
              content: argsPreview,
              card: {
                buttons: [
                  { text: '批准', action: 'approve', url: cbUrl('approve') },
                  { text: '拒绝', action: 'reject', url: cbUrl('reject') },
                ],
                callbackData: toolKey,
              },
            });
          }
        } catch { /* 推送失败不影响前端审批 */ }
      })();
    });
    const executeTool = async (name, argsJson) => {
      // P5.32：MCP 工具传入挂载上下文做细粒度分级（trusted 服务器的只读工具降为 low 免确认疲劳；其余仍 high）
      const risk = toolRiskOf(name, { mcpServers: agent?.mcp_servers || '[]' });
      // P5.34（审查建议③）：create_task 即使「全自动执行」也强制确认——持久化自动执行实体不应被
      // 一次性授权（auto）静默创建；防提示词注入借 auto 权限批量造任务烧 token
      const needConfirm = risk !== 'low' && (chatPerm === 'default' || name === 'create_task');
      let approvedApprovalId = null; // P1-14：批准的审批行——工具实际执行完成后升终态 executed
      if (needConfirm) {
        const toolKey = `${session_id}:${Date.now()}:${name}`;
        send('tool', { name, status: 'awaiting' });
        const verdict = await waitUserConfirm(toolKey, name, argsJson);
        if (verdict !== true) {
          const reason = verdict === false ? '用户拒绝执行' : '等待确认超时（120 秒）';
          send('notice', { msg: `⛔ ${name} 未执行：${reason}` });
          return `工具 ${name} 未获得用户授权（${reason}）。请基于已有信息回答，或询问用户是否允许执行该操作。`;
        }
        const approvedRow = db.prepare('SELECT id FROM tool_approvals WHERE confirm_key=? AND status=?').get(toolKey, 'approved');
        approvedApprovalId = approvedRow ? approvedRow.id : null;
      }
      // P1-14：工具真正执行完毕（含异常）才把审批升为 executed——"批准且已兑现"语义
      const markExecuted = () => {
        if (approvedApprovalId != null) {
          try {
            db.prepare('UPDATE tool_approvals SET status=?, decision_at=? WHERE id=? AND status=?')
              .run('executed', now(), approvedApprovalId, 'approved');
          } catch { /* 审计回写失败不影响工具结果 */ }
        }
      };
      send('tool', { name, status: 'executing' });
      // 子智能体工具：agent_call_{id} → 阻塞执行子智能体（含其知识库检索）
      if (name.startsWith('agent_call_')) {
        const c = childTools.find(t => t.schema.function.name === name);
        if (!c) { markExecuted(); return '未知子智能体：' + name; }
        let args = {};
        try { args = JSON.parse(argsJson || '{}'); } catch { }
        try {
          const r = await runChildAgent(c.child, args.task, agent?.max_reply, req.user);
          markExecuted();
          return `子智能体「${c.child.name}」的执行结果：\n${r}`;
        } catch (e) { markExecuted(); throw e; }
      }
      // P5.27：ctx 补 username——local_exec 按用户路由到其默认设备
      // V1.2 审查加固 2026-10-30：主链路工具执行同样受智能体元数据过滤约束（kb_search 旁路收口——
      // 否则主链路检索被过滤，LLM 经 function calling 调 kb_search 却全库检索，机密分块经工具结果回流对话）
      try {
        const r = await runTool(name, argsJson, { kbId: agent?.kb_id || null, mcpServers: agent?.mcp_servers || '[]', username: req.user.username, metadataFilter: resolveKbFilter(agent, req.user) || undefined });
        markExecuted();
        return r;
      } catch (e) { markExecuted(); throw e; }
    };
    if (!model && agent?.model === 'auto') {
      try {
        const { autoRoute } = require('../lib/model-router');
        const routeResult = await autoRoute({ input, attachments: req.body?.attachments, agentName: agent?.name, tenantId: req.user.tenant_id });
        if (routeResult.ok) {
          model = routeResult.model;
          console.log(`[route] ${agent?.name} auto → ${routeResult.model}@${routeResult.provider}`);
        } else {
          console.warn(`[route] ${agent?.name} auto route failed: ${routeResult.error}`);
        }
      } catch (e) { console.warn('[route] auto route exception:', e.message); }
    }
    const gen = workflowGen || classifierGen || orchestrateGen || chat(messages, {
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
    // P1-6 会话检查点 v2：每 ~200 字符节流 UPSERT 生成快照——断网/崩溃后重新打开会话可「继续生成」；
    // 仅本地模型链路（workflow/classifier 无逐字流，检查点意义小，靠 partial 落库兼容）
    let ckLastLen = 0;
    const ckThrottle = 200;
    const ckSave = (status) => {
      try {
        upsertCheckpoint(session_id, {
          userContent: input,
          partialContent: full,
          status,
          model: genMeta?.model || model || agent?.model || '',
        });
      } catch { /* 检查点写失败不影响对话主链路 */ }
    };
    try {
      while (true) {
        const r = await gen.next();
        if (r.done) { full = r.value.full; genMeta = r.value; break; }
        if (r.value.delta) { full += r.value.delta; send('delta', { text: r.value.delta }); }
        if (r.value.toolCall) {
          toolTrace.push(r.value.toolCall);
          send('tool', { name: r.value.toolCall.name, status: 'finished', result: r.value.toolCall.result });
        }
        // P1-6：生成中节流写检查点（generating 态；resume 时不重复写——防覆盖续跑前的快照）
        if (full.length - ckLastLen >= ckThrottle) { ckLastLen = full.length; ckSave('generating'); }
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
    // D2-2 计费结算：按真实用量与单价精确结算预留（幂等；与成本归因同基数）
    settleGate({ promptTokens: Math.ceil(promptChars * 0.6), completionTokens: tokens, model: genMeta?.model || model || agent?.model || 'default', provider: genMeta?.provider });
    // U1-6 成本归因（主链路）：按真实单价计成本；拆分基数与既有口径一致（输入按 promptChars 估算、输出按 tokens）
    try {
      recordModelUsage({
        username: req.user.username,
        model: genMeta?.model || model || agent?.model || 'default',
        provider: genMeta?.provider,
        promptTokens: Math.ceil(promptChars * 0.6),
        completionTokens: tokens,
        meta: { mode: 'real' },
      });
    } catch (e) { console.error('[chat] U1-6 成本归因失败（不阻断）：', e.message); }
    db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), session_id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '对话调用', `与 ${agent ? '「' + agent.name + '」' : '首页助手'} 对话（${tokens} tokens${stopped ? '，用户停止生成' : ''}${usedSkills.length ? '，@技能 ' + usedSkills.map(s => s.name).join('/') : ''}${toolTrace.length ? '，工具×' + toolTrace.length : ''}${genMeta?.provider ? '，@' + genMeta.provider + '/' + (genMeta.model || model || '') : ''}）`, req.ip, now());
    // 全链路追踪落库（model+provider 记录实际路由到的供应商，多供应商路由后可追溯）
    db.prepare('INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,blocked,retrieval_trace,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(session_id, msgInfo.lastInsertRowid, agent?.id || null, genMeta?.model || model || agent?.model || '', 'real', Date.now() - tStart, tokens, promptChars,
        JSON.stringify(kbHits.map(h => ({ file: h.file, kb: h.kb, score: h.score, bm25: h.bm25, vec: h.vec, rerank_score: h.rerank_score, excerpt: h.content.slice(0, 120) }))),
        JSON.stringify(toolTrace), blockedNote, JSON.stringify(retrievalTrace), now());

    send('done', { content: outMasked, tokens, model: genMeta?.model, provider: genMeta?.provider, mid: Number(msgInfo.lastInsertRowid) });

    // P1-6：正常完成（含用户主动停止但已落库）即清理检查点——续跑只对「中断未完成」的生成有意义
    deleteCheckpoint(session_id);

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
    // P1-6：异常中断——检查点标记 aborted（保留 partial 快照），用户重开会话可「继续生成」；
    // 顺带把已流出的 partial 落一条 assistant 消息（带续跑标记），前端据此展示续跑卡片
    try {
      const ck = getCheckpoint(session_id);
      if (ck && ck.status !== 'aborted') {
        upsertCheckpoint(session_id, { userContent: ck.user_content, partialContent: ck.partial_content, status: 'aborted', model: ck.model });
      }
    } catch { /* 检查点维护失败不影响错误上报 */ }
    send('error', { msg: '对话服务异常：' + e.message });
  } finally {
    releaseGate('unsettled'); // D2-2：未走到结算点即回滚预留（结算后 gateId 已置空，此处无副作用）
  }
  res.end();
});

// ---------- 视频生成任务代理（多供应商路由，任务归属优先） ----------
// 查询进度：前端轮询。完成时后端将 mp4 缓存到本地 public/uploads/videos/，
// 返回静态 content_url（<video> 标签无法携带 Authorization 头，必须走静态文件）
router.get('/video/tasks/:taskId', async (req, res) => {
  // P3-5（2026-11-09）：任务归属校验——创建时已记录归属用户（内存），非本人且非管理员拒绝轮询；
  // 重启后归属失忆则回落放行（与修复前一致，见 skills.js 注释的已知边界）
  const owner = skills.videoOwnerOf(req.params.taskId);
  if (owner && owner !== req.user.username && req.user.role !== 'admin') {
    return res.json({ code: 403, msg: '无权查看该视频任务（仅创建者本人可查看）' });
  }
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
  // P3-5（2026-11-09）：内容拉取同归属校验（与进度轮询同口径；流式端点用 HTTP 403）
  const owner = skills.videoOwnerOf(req.params.taskId);
  if (owner && owner !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ code: 403, msg: '无权获取该视频内容（仅创建者本人可下载）' });
  }
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

// ==================== P2-17 会话变量与状态 ====================

// GET /api/chat/sessions/:id/vars — 获取会话变量
router.get('/sessions/:id/vars', auth, (req, res) => {
  const s = db.prepare('SELECT id, wf_vars FROM sessions WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '会话不存在' });
  let vars = {};
  try { vars = JSON.parse(s.wf_vars || '{}'); } catch { vars = {}; }
  res.json({ code: 0, data: vars });
});

// PUT /api/chat/sessions/:id/vars — 更新会话变量（全量替换）
router.put('/sessions/:id/vars', auth, (req, res) => {
  const s = db.prepare('SELECT id FROM sessions WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '会话不存在' });
  const { vars } = req.body || {};
  const payload = typeof vars === 'object' && vars !== null ? JSON.stringify(vars) : (vars || '{}');
  db.prepare('UPDATE sessions SET wf_vars=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(payload, s.id);
  res.json({ code: 0 });
});

// PATCH /api/chat/sessions/:id/vars — 合并更新会话变量（增量）
router.patch('/sessions/:id/vars', auth, (req, res) => {
  const s = db.prepare('SELECT id, wf_vars FROM sessions WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '会话不存在' });
  let current = {};
  try { current = JSON.parse(s.wf_vars || '{}'); } catch { current = {}; }
  const { vars } = req.body || {};
  if (typeof vars === 'object' && vars !== null) {
    Object.assign(current, vars);
  }
  db.prepare('UPDATE sessions SET wf_vars=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(JSON.stringify(current), s.id);
  res.json({ code: 0, data: current });
});

// GET /api/chat/sessions/:id/state — 获取会话状态（约定键集：phase/status/context）
router.get('/sessions/:id/state', auth, (req, res) => {
  const s = db.prepare('SELECT id, wf_vars FROM sessions WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '会话不存在' });
  let vars = {};
  try { vars = JSON.parse(s.wf_vars || '{}'); } catch { vars = {}; }
  // 用约定键提取状态层
  const stateKeys = ['phase', 'status', 'context', 'step', 'mode', 'error', 'completed'];
  const state = {};
  for (const k of stateKeys) { if (vars[k] !== undefined) state[k] = vars[k]; }
  res.json({ code: 0, data: state });
});

// ==================== U0-2 STT 语音识别 + 录音上传 ====================

const multer = require('multer');
const sttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

router.post('/stt', auth, sttUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.json({ code: 400, msg: '请上传音频文件' });
  try {
    const sttModule = require('../lib/stt');
    const result = await sttModule.stt({ audio: req.file.buffer, format: req.file.originalname?.split('.').pop() || 'webm', language: req.body?.language || 'zh' });
    if (result.ok) {
      res.json({ code: 0, data: { text: result.text, provider: result.provider } });
    } else {
      res.json({ code: 500, msg: result.error || '语音识别失败' });
    }
  } catch (e) {
    res.json({ code: 500, msg: '语音识别异常：' + e.message });
  }
});

// ===== D1-2 专家团编排：运行查询 + 单节点重跑（失败可重跑单节点）=====
function loadOrchestration(id, user) {
  const row = db.prepare('SELECT * FROM orchestration_runs WHERE id=?').get(id);
  if (!row) return { err: { code: 404, msg: '编排运行不存在' } };
  if (row.username && row.username !== user.username && user.role !== 'admin') return { err: { code: 403, msg: '无权访问该编排运行' } };
  return { row };
}

router.get('/orchestrations/:id', (req, res) => {
  const { row, err } = loadOrchestration(req.params.id, req.user);
  if (err) return res.json(err);
  let graph = null, nodes = null;
  try { graph = JSON.parse(row.graph || 'null'); } catch { }
  try { nodes = JSON.parse(row.node_logs || 'null'); } catch { }
  res.json({ code: 0, data: { ...row, graph, nodes } });
});

router.post('/orchestrations/:id/rerun-node', async (req, res) => {
  try {
    const { row, err } = loadOrchestration(req.params.id, req.user);
    if (err) return res.json(err);
    const nodeId = String((req.body || {}).node_id || '').trim();
    if (!nodeId) return res.json({ code: 400, msg: '缺少 node_id' });
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(row.agent_id);
    if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
    let graph = null; try { graph = JSON.parse(row.graph || 'null'); } catch { }
    if (!graph || !Array.isArray(graph.nodes)) return res.json({ code: 400, msg: '任务图缺失，无法重跑' });
    let nodes = {}; try { nodes = JSON.parse(row.node_logs || '{}') || {}; } catch { }
    const childTools = buildChildTools(agent.child_ids);
    const childMap = new Map(childTools.map(t => [t.child.id, t.child]));
    const input = String((req.body || {}).input || '');
    const runAgent = (node, ctx) => {
      const child = childMap.get(node.agent_id);
      if (!child) throw new Error(`子智能体 #${node.agent_id} 不存在或未发布`);
      const task = node.task + (ctx.deps ? `\n\n【上游产出】\n${ctx.deps}` : '');
      return runChildAgent(child, task, agent.max_reply, req.user).then(t => ({ text: t }));
    };
    const runVerify = (node, ctx) => runVerifyNode(agent, node, { ...ctx, input }).then(t => ({ text: t }));
    const st = await orchestrator.rerunNode(graph, nodes, nodeId, { runAgent, runVerify, input, timeoutMs: orchestrator.DEFAULT_TIMEOUT_MS, retry: 1 });
    db.prepare('UPDATE orchestration_runs SET node_logs=? WHERE id=?').run(JSON.stringify(nodes), row.id);
    res.json({ code: 0, data: { node: st }, msg: `节点 ${nodeId} 已重跑：${st.status}` });
  } catch (e) {
    res.json({ code: 500, msg: '重跑失败：' + (e.message || e) });
  }
});

module.exports = router;
module.exports.resolveKbFilter = resolveKbFilter;
module.exports.buildChildTools = buildChildTools; // D1-2：编排单节点重跑复用子智能体工具构造
