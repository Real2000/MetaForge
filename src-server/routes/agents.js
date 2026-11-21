/** 智能体 + 空间 + 测评（2026-10-22 P3：协作与可见性权限层全链路接入）
 *  LLMOps 提示词版本管理（2026-10-31 计划 #10）：
 *  - PUT /api/agents/:id 保存时 prompt/user_prompt 有实际差异 → 自动记快照到 agent_prompt_versions
 *  - GET  /api/agents/:id/prompt-versions 版本列表（最多 50 条，权限=可编辑者：版本含提示词全文，泄露面等同编辑权限）
 *  - POST /api/agents/:id/prompt-versions/:vid/rollback 回滚写回 + 再记一条新版本（note='回滚到 vN'，完整审计链） */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { chatOnce } = require('../lib/llm');
const { canView, canEdit, isOwnerLevel, parseJsonArr } = require('../lib/agent-access');
const { sanitizeMetadata } = require('../lib/kb-metadata'); // V1.2 #2 2026-10-30：kb_metadata_filter 入参清洗
const { requireFeature, hasFeature } = require('../lib/edition'); // V2.2 #8 2026-10-31：License 特性闸门（中间件工厂）；V3.1 #12：audit_flow 审核流判定
const { spaceFilterSql } = require('../lib/space-utils'); // V2.4 #9 2026-10-31：统一空间过滤
const { getSoftLimit, agentQuotaBlock } = require('../lib/plans'); // V2.4 #8 2026-10-31：edition+plan配额限制
const { runTool, validateAgentTools, TOOL_DEFS, AGENT_TOOL_DENY } = require('../lib/tools'); // P5.34b copy 过滤依赖 AGENT_TOOL_DENY（此前漏导入被 catch 吞错致副本工具恒空——测试轮实锤修复）
const { diffWorkflows } = require('../lib/workflow-diff'); // C2 2026-11-10：画布版本节点/连线级 diff（纯函数）

const router = express.Router();
router.use(auth);

/** LLMOps：写一条提示词版本快照（version 在 agent 内自增；同步 INSERT 微秒级，不阻塞保存响应）。
 *  prompt/userPrompt 存变更后的值；note 记录来源（'提示词修改' / '回滚到 vN'）。返回新版本号。 */
function insertPromptVersion(agentId, prompt, userPrompt, editedBy, note) {
  const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_prompt_versions WHERE agent_id=?').get(agentId).v || 0) + 1;
  db.prepare(`INSERT INTO agent_prompt_versions (agent_id, version, prompt, user_prompt, edited_by, note, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
    .run(agentId, version, prompt || '', userPrompt || '', editedBy || '', note || '');
  return version;
}

/** LLMOps：提示词变更判定——NULL/'' 归一为 '' 后逐字比对（PUT 为全量覆盖语义，parseBody 未传
 *  prompt 时取 ''，故"未传导致的清空"同样是真实变更需要记快照；值无差异则不产生版本记录） */
function promptChanged(oldAgent, newPrompt, newUserPrompt) {
  const norm = v => (v == null ? '' : String(v));
  return norm(oldAgent.prompt) !== norm(newPrompt) || norm(oldAgent.user_prompt) !== norm(newUserPrompt);
}

const TYPE_MAP = { enterprise: '企业智能体', digital: '数字员工', dept: '部门AI助理', other: '其他' };
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE_MAP).map(([k, v]) => [v, k]));

// 列表（type: enterprise/digital/dept；admin 可看全部含 draft，普通用户仅 published 且通过可见性过滤——
// P3 协作与团队：visibility=restricted 的智能体仅创建者/协作者/指定部门成员/指定成员可见）
router.get('/', (req, res) => {
  const { type, keyword } = req.query;
  let sql = 'SELECT a.*, s.name AS space_name FROM agents a LEFT JOIN spaces s ON s.id=a.space_id WHERE 1=1';
  const args = [];
  if (type && TYPE_MAP[type]) { sql += ' AND a.type=?'; args.push(type); }
  if (req.user.role !== 'admin') { sql += ' AND a.status=?'; args.push('published'); }
  if (keyword) { sql += ' AND (a.name LIKE ? OR a.description LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
  // V2.4 #9 租户化（2026-10-31）：空间隔离——普通用户仅见自己空间内的智能体
  // 管理员用户见全部（管理界面需要跨空间操作）。使用 space-utils 统一过滤，避免各处手写 SQL 语义分叉。
  const { sqlStr: spaceFilter, args: spaceArgs } = spaceFilterSql('a', req.user);
  sql += spaceFilter;
  args.push(...spaceArgs);
  sql += ' ORDER BY a.updated_at DESC';
  let rows = db.prepare(sql).all(...args);
  if (req.user.role !== 'admin') rows = rows.filter(a => canView(a, req.user)); // P3 可见性过滤
  res.json({ code: 0, data: rows });
});

router.get('/categories', (req, res) => {
  // 测试轮修复：原 status="published" 双引号在 SQLite 是标识符引用 → no such column 500（接口从未可用过）
  const rows = db.prepare("SELECT category, COUNT(*) c FROM agents WHERE status='published' GROUP BY category ORDER BY c DESC").all();
  res.json({ code: 0, data: rows });
});

/** V3.1 #12 审核流（2026-11-03）：写一条审核流水（幂等辅助，不抛错） */
function insertReview(agentId, action, operator, comment) {
  db.prepare(`INSERT INTO agent_reviews (agent_id, action, operator, comment, created_at) VALUES (?,?,?,?,datetime('now','localtime'))`)
    .run(agentId, action, operator || '', String(comment || '').slice(0, 500));
}

/** V3.1 #12：当前请求是否需走人工审核——企业版（audit_flow 特性）且非 admin 发布者。
 *  社区/专业版与管理员直接发布（用户决策：社区版提审自动通过）；管理员是审核主体，自发布不自审 */
function needsReview(req) {
  return hasFeature('audit_flow') && req.user.role !== 'admin';
}

// 协作成员选择器数据源（P3）：全平台启用用户的基础信息（用户名/昵称/部门/角色，无敏感字段），
// 供编排页「协作与可见性」区块选择可见部门/成员与协作者
router.get('/members', (req, res) => {
  const rows = db.prepare("SELECT username, nickname, dept, role FROM users WHERE status=1 ORDER BY role='admin' DESC, username").all();
  res.json({ code: 0, data: rows });
});

// V3.1 #12 审核流（2026-11-03）：待审核队列（仅管理员）——status='review' 的智能体 + 提审人/提审说明/提交时间
router.get('/review-queue', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '需要管理员权限' });
  const rows = db.prepare(`
    SELECT a.id, a.name, a.description, a.type, a.category, a.visibility, a.owner, a.updated_at,
           (SELECT r.operator FROM agent_reviews r WHERE r.agent_id=a.id AND r.action='submit' ORDER BY r.id DESC LIMIT 1) AS submit_by,
           (SELECT r.comment  FROM agent_reviews r WHERE r.agent_id=a.id AND r.action='submit' ORDER BY r.id DESC LIMIT 1) AS submit_comment,
           (SELECT r.created_at FROM agent_reviews r WHERE r.agent_id=a.id AND r.action='submit' ORDER BY r.id DESC LIMIT 1) AS submitted_at
    FROM agents a WHERE a.status='review' ORDER BY a.updated_at DESC`).all();
  res.json({ code: 0, data: rows });
});

// V1.2 审查加固 2026-10-30：智能体挂载知识库归属校验——kb_id 存在时须为本人库或管理员。
// 此前 POST/PUT 均无校验：普通用户可挂他人私有库（自增 ID 可枚举），chat/openapi/share/workflow
// 四条检索链路均不校验库归属（仅校验智能体可见性）→ 越权读取他人库全量内容（内容级 ACL 的行级地基）
function denyKbNotOwned(kbId, user) {
  if (!kbId) return null;
  const kb = db.prepare('SELECT owner FROM kbs WHERE id=?').get(kbId);
  if (!kb) return { code: 400, msg: '知识库不存在' };
  if (user.role === 'admin' || kb.owner === user.username) return null;
  return { code: 403, msg: '无权挂载他人的知识库（仅创建者或管理员）' };
}

// P2-6 修复 2026-11-09：智能体挂载空间归属校验——space_id 存在时须为本人空间或管理员。
// 此前 POST/PUT 均无校验：普通用户可把智能体挂到他人/企业空间（自增 ID 可枚举），放大了对其他用户的可见范围。
function denySpaceNotOwned(spaceId, user) {
  if (!spaceId) return null;
  if (user.role === 'admin') return null;
  const space = db.prepare('SELECT owner FROM spaces WHERE id=?').get(spaceId);
  if (!space) return { code: 400, msg: '空间不存在' };
  if (space.owner === user.username) return null;
  return { code: 403, msg: '无权挂载到该空间（仅空间创建者或管理员）' };
}

function parseBody(b) {
  let tools = [];
  try { tools = Array.isArray(b.tools) ? b.tools : JSON.parse(b.tools || '[]'); } catch { tools = []; }
  // P5.34（审查 F1②）：工具白名单校验——create_task/local_exec 不可配进智能体（防 API 直调注入
  // 持久化自动执行/外设操作类工具；对话链路中首页助手的服务端默认集不受此限）
  const toolDeny = validateAgentTools(tools);
  if (toolDeny) tools = []; // 校验失败时清空，由路由返回 400（parseBody 不持有 res）
  let mcpServers = [];
  try { mcpServers = Array.isArray(b.mcp_servers) ? b.mcp_servers : JSON.parse(b.mcp_servers || '[]'); } catch { mcpServers = []; }
  let variables = [];
  try { variables = Array.isArray(b.variables) ? b.variables : JSON.parse(b.variables || '[]'); } catch { variables = []; }
  let childIds = [];
  try { childIds = Array.isArray(b.child_ids) ? b.child_ids.map(Number).filter(Boolean) : JSON.parse(b.child_ids || '[]'); } catch { childIds = []; }
  return {
    name: (b.name || '').trim().slice(0, 50),
    description: b.description || '',
    type: TYPE_MAP[b.type] ? b.type : (TYPE_NAME[b.type] || 'digital'),
    space_id: b.space_id || null,
    category: b.category || '未分类',
    prompt: b.prompt || '',
    user_prompt: (b.user_prompt || '').slice(0, 2000),
    model: b.model || '',
    temperature: b.temperature ?? 0.7,
    top_p: b.top_p ?? 0.7,
    diversity_mode: ['precise', 'balanced', 'creative', 'custom'].includes(b.diversity_mode) ? b.diversity_mode : 'balanced',
    icon: (b.icon || '').slice(0, 8),
    context_rounds: b.context_rounds ?? 10,
    max_reply: b.max_reply ?? 1024,
    opening: b.opening || '',
    opening_questions: JSON.stringify(Array.isArray(b.opening_questions) ? b.opening_questions : []),
    kb_id: b.kb_id || null,
    status: b.status || 'draft',
    tools: JSON.stringify([...new Set(tools)]),
    mcp_servers: JSON.stringify([...new Set(mcpServers)]),
    long_memory: b.long_memory ? 1 : 0,
    allow_user_model: b.allow_user_model === false || b.allow_user_model === 0 ? 0 : 1,
    suggest_enabled: b.suggest_enabled === false || b.suggest_enabled === 0 ? 0 : 1,
    variables: JSON.stringify(variables.filter(v => v && v.name)),
    child_ids: JSON.stringify([...new Set(childIds)]),
    // ⑦ 路由模式（2026-10-22 P3）：function 主模型 function calling 编排（默认）/ classifier 分类器直达子智能体 / orchestrate 专家团并行编排（D1-2）
    routing_mode: ['function', 'classifier', 'workflow', 'orchestrate'].includes(b.routing_mode) ? b.routing_mode : 'function',
    // P5.34：工具白名单校验结果（null=通过；非 null 时路由返回 400）
    tool_error: toolDeny,
    // P5.1 画布编排 V2：workflow JSON（{nodes:[{id:"node_N",type,position,data}],edges:[{id,source,target,sourceHandle}]}）；null/空串清除
    // edit_mode 独立字段：form 表单（默认）/ canvas 画布（不再依赖 routing_mode 推断）
    edit_mode: b.edit_mode === 'canvas' ? 'canvas' : 'form',
    workflow: (() => {
      const { validateWorkflowV2 } = require('../lib/workflow-schema');
      const r = validateWorkflowV2(b.workflow);
      if (r && r.error) return r; // {error} 交由 PUT 路由返回 400
      // P2-15 变量引用完整性校验（仅在画布模式下执行）
      const wfParsed = r ? r : null;
      if (wfParsed && b.edit_mode === 'canvas') {
        const wfIssues = checkVariableRefs(wfParsed, variables || []);
        wfParsed._varIssues = wfIssues;
        if (wfIssues.length) {
          return wfParsed; // 将问题附加到返回的画布中，由路由判断是否允许保存
        }
      }
      return r ? JSON.stringify(r) : null;
    })(),
  };
}

/**
 * P2-15 变量引用完整性校验：检测画布中 LLM 节点输出引用、必填缺失、断链变量。
 * @param {object} wf      已解析的画布 JSON（{nodes,edges}）
 * @param {Array}  vars    变量声明列表 [{name,type,required}]
 * @returns {Array} 问题描述字符串数组
 */
function checkVariableRefs(wf, vars) {
  const issues = [];
  if (!wf || !wf.nodes) return issues;
  const usedVars = new Set();
  const declaredNames = new Set();
  const requiredMissing = [];
  for (const v of (vars || [])) {
    if (v && v.name) {
      declaredNames.add(v.name);
      if (v.required) requiredMissing.push(v.name);
    }
  }
  for (const node of wf.nodes) {
    const data = node.data || {};
    const dstr = JSON.stringify(data);
    const refs = dstr.match(/\{\{\w+\}\}/g);
    if (refs) refs.forEach(r => usedVars.add(r.slice(2, -2)));
  }
  // 检查边和conditions也含有变量引用
  if (wf.edges) {
    for (const edge of wf.edges) {
      if (edge.condition) {
        const refs = String(edge.condition).match(/\{\{\w+\}\}/g);
        if (refs) refs.forEach(r => usedVars.add(r.slice(2, -2)));
      }
    }
  }
  // 检查必填变量未被引用
  for (const v of requiredMissing) {
    if (!usedVars.has(v)) {
      issues.push(`必填变量「${v}」在画布中未被任何节点引用`);
    }
  }
  return issues;
}

  // V2.2 #8 2026-10-31 License 功能闸门（接线示范）：community 即含 agents 特性，当前实际不拦——
  // 机制先行、付费墙后置（避免误伤存量用户）；后续钉钉/租户/审核流上线时在对应路由挂
  // requireFeature('agents') / requireFeature('dingtalk') 即生效（ldap/tenant 已随 P0-4 2026-11-11 从特性表移除；audit_flow 保留）
  router.post('/', requireFeature('agents'), (req, res) => {
  // V2.4 #8 收尾：叠加 edition 限制——社区版用户最多创建 3 个智能体
  const softLimit = getSoftLimit('agents', req.user.username);
  if (softLimit > 0 && !req.user.plan) {
    const count = db.prepare("SELECT COUNT(*) c FROM agents WHERE owner=? AND source='self'").get(req.user.username).c;
    if (count >= softLimit) {
      return res.json({ code: 402, msg: `免费版最多创建 ${softLimit} 个智能体（当前 ${count} 个）`, data: { upgrade_hint: true } });
    }
  }
  const a = parseBody(req.body || {});
  if (!a.name) return res.json({ code: 400, msg: '智能体名称不能为空' });
  if (a.tool_error) return res.json({ code: 400, msg: a.tool_error }); // P5.34：工具白名单
  const kbDeny = denyKbNotOwned(a.kb_id, req.user); // V1.2 审查加固：挂库归属校验
  if (kbDeny) return res.json(kbDeny);
  const spaceDeny = denySpaceNotOwned(a.space_id, req.user); // P2-6 修复：空间归属校验
  if (spaceDeny) return res.json(spaceDeny);
  // 商业化软约束：免费版智能体数达上限不硬拦，返回升级提示（upgrade_hint 前端弹引导）
  // V2.3 Y3：改用 lib/plans.js agentQuotaBlock 统一封装——与技能市场克隆通道（routes/skills-market.js）
  // 同口径，配额规则/文案变更只改一处；消息与 code/data 逐字对齐原内联实现（防测试断言漂移）
  const quota = agentQuotaBlock(req.user.username);
  if (quota.blocked) return res.json({ code: quota.code, msg: quota.msg, data: quota.data });
  // SinguX 式轻量创建：只需名称（提示词可后置到编排页填写），创建后前端直接跳转编排页
  const info = db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,user_prompt,model,temperature,top_p,diversity_mode,icon,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,tools,mcp_servers,long_memory,allow_user_model,suggest_enabled,variables,child_ids,routing_mode,owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
    .run(a.name, a.description, a.type, a.space_id, a.category, a.prompt, a.user_prompt, a.model, a.temperature, a.top_p, a.diversity_mode, a.icon, a.context_rounds, a.max_reply, a.opening, a.opening_questions, a.kb_id, 'draft', 'self', a.tools, a.mcp_servers, a.long_memory, a.allow_user_model, a.suggest_enabled, a.variables, a.child_ids, a.routing_mode, req.user.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建智能体', a.name, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// 智能体详情（编排页加载完整配置；P3：统一可见性校验——草稿仅 owner/协作者/管理员可见，
// 受限发布的智能体仅名单内可见，防止绕过前端直接拉取）
// P5.16 API 文档自动生成：从 Start/End 节点变量 schema 生成接口契约（Swagger 风格，发布即有零手写）
router.get('/:id/apidoc', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(a, req.user)) return res.json({ code: 403, msg: '无权访问该智能体（未对你开放）' });
  try {
    const { buildApiDoc } = require('../lib/api-doc');
    // 已发布快照优先（线上契约），无快照回退草稿（编辑期预览）
    const host = req.get('host') || `localhost:${process.env.PORT || 3210}`;
    const docSource = a.published_workflow ? { ...a, workflow: a.published_workflow } : a;
    res.json({ code: 0, data: buildApiDoc(docSource, host) });
  } catch (e) {
    res.json({ code: 500, msg: '文档生成失败：' + e.message });
  }
});

router.get('/:id/detail', (req, res) => {
  // SELECT * 含 kb_metadata_filter（V1.2 #2 2026-10-30）：编排页元数据过滤声明自然带出，无需额外拼接
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(a, req.user)) return res.json({ code: 403, msg: '无权访问该智能体（未对你开放）' });

  // P5.9：published_workflow 大 JSON 不整份下发——附轻量状态（有无快照/版本数/草稿是否与快照一致）
  const pubWf = a.published_workflow;
  delete a.published_workflow;
  let pubInfo = { has: false, version: 0, nodes: 0, draftDirty: false };
  if (pubWf) {
    try {
      const p = JSON.parse(pubWf);
      if (p && Array.isArray(p.nodes)) {
        pubInfo.has = true;
        pubInfo.nodes = p.nodes.length;
        // 版本号优先取「内容与当前快照一致的历史版本」（回滚后正确显示 v1 而非 MAX），兜底 MAX(version)
        const matched = db.prepare('SELECT version FROM agent_publish_history WHERE agent_id=? AND workflow=? ORDER BY version DESC LIMIT 1').get(a.id, pubWf);
        pubInfo.version = matched?.version || (db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_publish_history WHERE agent_id=?').get(a.id).v || 0);
        pubInfo.draftDirty = pubWf !== String(a.workflow || ''); // 草稿与快照不一致 = 有未发布改动
      }
    } catch { /* 快照损坏按无快照处理 */ }
  }
  res.json({ code: 0, data: a, pub_wf_info: pubInfo });
});

// 智能体长期记忆列表 / 清空（编排页记忆区块管理）
router.get('/:id/memories', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(agent, req.user)) return res.json({ code: 403, msg: '无权查看该智能体的记忆' });
  // V2.4 #9 收尾：记忆归属校验——非管理员只返回自己创建的记忆（防越权查看其他用户在同一智能体上的聊天记忆）
  const whereClause = req.user.role !== 'admin' ? ' AND username=?' : '';
  const args = req.user.role !== 'admin' ? [req.user.username] : [];
  const rows = db.prepare(`SELECT id, fact, type, confidence, source, summary, summary_source, created_at, username FROM agent_memories WHERE agent_id=? ${whereClause} ORDER BY id DESC LIMIT 200`).all(req.params.id, ...args);
  // P1-4 聚合摘要：按智能体+用户聚合所有记忆，生成摘要统计（老数据无 type 时按 fact 计数，与前端展示兜底一致）
  const stat = { fact: 0, preference: 0, summary: 0 };
  const summaryIds = [];
  for (const r of rows) {
    if (r.type === 'summary') summaryIds.push(r.id);
    const bucket = (r.type === 'preference' || r.type === 'summary') ? r.type : 'fact';
    if (stat.hasOwnProperty(bucket)) stat[bucket]++;
  }
  res.json({ code: 0, data: { list: rows, stat } });
});
router.delete('/:id/memories', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无编辑权限' });
  db.prepare('DELETE FROM agent_memories WHERE agent_id=?').run(old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '清空智能体记忆', '#' + old.id, req.ip, now());
  res.json({ code: 0, msg: '已清空记忆' });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无编辑权限（仅创建者、协作者与管理员可编辑）' });
  const b = req.body || {};
  // 乐观锁（P3 多人协作）：前端携带打开页面时的 updated_at，若期间他人已保存 → 409 冲突，前端确认后 force=1 强制覆盖
  if (!b.force && b.base_updated_at && old.updated_at && b.base_updated_at !== old.updated_at) {
    return res.json({ code: 409, msg: `配置已被其他协作者修改（${(old.updated_at || '').slice(5, 16)}）`, data: { conflict: true, updated_at: old.updated_at } });
  }
  const a = parseBody(b);
  if (!a.name) return res.json({ code: 400, msg: '智能体名称不能为空' });
  if (a.tool_error) return res.json({ code: 400, msg: a.tool_error }); // P5.34：工具白名单
  const kbDeny = denyKbNotOwned(a.kb_id, req.user); // V1.2 审查加固：挂库归属校验（PUT 改绑同样拦截）
  if (kbDeny) return res.json(kbDeny);
  const spaceDenyUpd = denySpaceNotOwned(a.space_id, req.user); // P2-6 修复：空间归属校验
  if (spaceDenyUpd) return res.json(spaceDenyUpd);
  if (a.workflow && a.workflow.error) return res.json({ code: 400, msg: '画布工作流结构错误：' + a.workflow.error });
  // P2-15：变量引用完整性检查
  if (a.edit_mode === 'canvas' && a.workflow && a.workflow._varIssues && a.workflow._varIssues.length) {
    return res.json({ code: 400, msg: '画布变量引用存在问题', data: { issues: a.workflow._varIssues } });
  }
  // 有画布数据但无 start 节点 → 结构错误拒绝（前端画布模式应保证有 start）
  // 可见性与协作者名单：仅归属级（创建者/管理员）可改；协作者保存时保留原值（不能自我提权/改可见范围）
  const permEditable = isOwnerLevel(old, req.user);
  let visibility = old.visibility || 'public', vDepts = old.visible_depts || '[]', vMembers = old.visible_members || '[]', collabs = old.collaborators || '[]';
  if (permEditable) {
    const depts = parseJsonArr(b.visible_depts).map(String).filter(Boolean);
    const members = parseJsonArr(b.visible_members).map(String).filter(Boolean);
    let coll = [...new Set(parseJsonArr(b.collaborators).map(String).filter(Boolean))];
    // 企业版门槛：仅管理员或 enterprise 套餐的创建者可配置协作编辑者（多人协作编辑）
    if (coll.length && req.user.role !== 'admin') {
      const u = db.prepare('SELECT plan FROM users WHERE username=?').get(req.user.username);
      if ((u?.plan || 'free') !== 'enterprise') {
        return res.json({ code: 402, msg: '多人协作编辑为企业版权益（升级后可为智能体添加协作编辑者）', data: { upgrade_hint: true } });
      }
    }
    coll = coll.filter(u => u !== old.owner); // owner 天然全权，不入名单
    visibility = b.visibility === 'restricted' ? 'restricted' : 'public';
    vDepts = JSON.stringify(depts); vMembers = JSON.stringify(members); collabs = JSON.stringify(coll);
  }
  // V1.2 审查加固 2026-10-30：kb_metadata_filter 移入归属级（permEditable）保护——此前协作者可改/清空
  // 他人智能体的检索过滤声明（内容级 ACL 降权面：清空后 public 智能体对全员全库检索）；协作者保存时
  // 保留原值（与可见性/协作者名单同模式）。对象或 JSON 字符串均可，sanitizeMetadata 清洗（$user.dept 占位符
  // 为短字符串不会被截断，原样保留）；空对象/无效存 NULL
  let kbMetaFilter = old.kb_metadata_filter ?? null;
  if (permEditable) {
    const kbMetaClean = sanitizeMetadata(b.kb_metadata_filter); // null/undefined → {}（下面统一归 NULL）
    kbMetaFilter = b.kb_metadata_filter == null
      ? null // 未传 → 清除（与 parseBody 全量覆盖语义一致，前端总是提交完整表单）
      : (Object.keys(kbMetaClean).length ? JSON.stringify(kbMetaClean) : null);
  }
  db.prepare(`UPDATE agents SET name=?,description=?,type=?,space_id=?,category=?,prompt=?,user_prompt=?,model=?,temperature=?,top_p=?,diversity_mode=?,icon=?,context_rounds=?,max_reply=?,opening=?,opening_questions=?,kb_id=?,tools=?,mcp_servers=?,long_memory=?,allow_user_model=?,suggest_enabled=?,variables=?,child_ids=?,routing_mode=?,workflow=?,edit_mode=?,visibility=?,visible_depts=?,visible_members=?,collaborators=?,kb_metadata_filter=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(a.name, a.description, a.type, a.space_id, a.category, a.prompt, a.user_prompt, a.model || old.model, a.temperature, a.top_p, a.diversity_mode, a.icon, a.context_rounds, a.max_reply, a.opening, a.opening_questions, a.kb_id, a.tools, a.mcp_servers, a.long_memory, a.allow_user_model, a.suggest_enabled, a.variables, a.child_ids, a.routing_mode, a.workflow, a.edit_mode, visibility, vDepts, vMembers, collabs, kbMetaFilter, old.id);
  // LLMOps：prompt/user_prompt 有实际差异才自动记版本快照（变更后值），无差异（仅改名称/描述等）不记
  if (promptChanged(old, a.prompt, a.user_prompt)) {
    insertPromptVersion(old.id, a.prompt, a.user_prompt, req.user.username, '提示词修改');
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '编辑智能体', a.name, req.ip, now());
  const nu = db.prepare('SELECT updated_at FROM agents WHERE id=?').get(old.id);
  // P5.12 服务端二次校验（不拦截）：悬空引用清单随保存返回（前端已先校验，双保险/覆盖 API 直改场景）
  let wfWarnings = undefined;
  if (a.workflow && typeof a.workflow === 'string') {
    try {
      const wfObj = JSON.parse(a.workflow);
      const { checkRefs } = require('../lib/workflow-schema');
      const problems = checkRefs(wfObj);
      if (problems.length) wfWarnings = problems.map(p => ({ nodeId: p.nodeId, msg: p.msg }));
    } catch { /* 结构错误已在上文拦截 */ }
  }
  res.json({ code: 0, msg: '已保存', data: { updated_at: nu?.updated_at, wf_warnings: wfWarnings } });
});

// P5.3 画布工作流运行测试（SSE 实时推送）：输入变量表 → DAG Runner → 节点事件流式推送 + 最终输出/日志/结果缓存
// body: { input, vars?, startFrom?, presetResults? }（startFrom+presetResults = 从此节点重跑）
router.post('/:id/workflow-test', async (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无编辑权限' });
  const b = req.body || {};
  // V1 旧图自动升级（防御：直接改库/旧客户端提交）
  // P5.9 版本管理：运行测试跑**草稿**（编辑者验证未发布改动，Dify 调试语义）——线上对话走 published_workflow 快照
  let agentRow = { ...old };
  if (old.workflow) {
    try {
      const wf = JSON.parse(old.workflow);
      if (wf && Array.isArray(wf.nodes) && wf.nodes.length && wf.nodes[0].config !== undefined) {
        const { migrateWorkflowData } = require('../lib/workflow-schema');
        agentRow.workflow = JSON.stringify(migrateWorkflowData(wf));
      }
    } catch { }
  }
  const hasNodes = (() => { try { return (JSON.parse(agentRow.workflow || 'null')?.nodes || []).length > 0; } catch { return false; } })();
  if (!hasNodes) return res.json({ code: 400, msg: '尚未编排工作流（请先在画布模式中搭建）' });
  const inputVars = { input: String(b.input || '').slice(0, 2000) };
  // P5.14 文件一等变量：start 定义了 file/array[file] 的变量，入参传 fileId（数字/数组/{file_id}）不字符串化；其余变量仍字符串截断
  const startVarTypes = {};
  try {
    const wfParsed = JSON.parse(agentRow.workflow || '{}');
    for (const v of (wfParsed.nodes || []).find(n => n.type === 'start')?.data?.variables || []) {
      if (v.name) startVarTypes[v.name] = v.type || 'string';
    }
  } catch { }
  for (const [k, v] of Object.entries(b.vars || {})) {
    const vt = startVarTypes[k];
    if (vt === 'file' || vt === 'array[file]') inputVars[k] = v; // fileId 数字 / [id,...] / {file_id} 透传
    else inputVars[k] = String(v).slice(0, 500);
  }
  // 重跑参数（P5.3）：startFrom 前序节点沿用 presetResults 缓存
  const startFrom = b.startFrom ? String(b.startFrom).slice(0, 24) : null;
  const presetResults = (b.presetResults && typeof b.presetResults === 'object') ? b.presetResults : null;

  // SSE 流（text/event-stream）：node 事件实时推送节点状态（含入参出参），done/error 收尾
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { } };

  const t0 = Date.now();
  // P5.5 运行实例落库：先插 running 行，结束后更新（env 密钥已在 Runner 内 maskSecrets 脱敏）
  const { maskSecrets } = require('../lib/secrets');
  const runInfo = db.prepare(`INSERT INTO workflow_runs (agent_id, trigger_type, status, inputs, started_at) VALUES (?,?,?,?,datetime('now','localtime'))`)
    .run(old.id, b.startFrom ? 'manual-rerun' : 'manual', 'running', maskSecrets(JSON.stringify(inputVars)).slice(0, 4000));

  try {
    const { runWorkflow } = require('../lib/workflow');
    const r = await runWorkflow(agentRow, inputVars, {
      startFrom, presetResults,
      sessionVars: {}, // P5.7 会话变量：运行测试为临时态（start 定义默认值起，不读不写会话持久层）
      _currentRunId: runInfo.lastInsertRowid, // P5.8 #9：agent 节点的子运行关联本 run（下钻链路）
      onEvent: evt => {
        if (evt.event === 'nodeStart') send({ type: 'node', nodeId: evt.nodeId, title: evt.title, nodeType: evt.type, status: 'running' });
        if (evt.event === 'nodeDone') send({ type: 'node', nodeId: evt.nodeId, title: evt.title, nodeType: evt.type, status: evt.ok ? 'success' : 'error', ms: evt.ms, preview: evt.preview, inputs: evt.inputs || null, outputFull: evt.outputFull || null, retries: evt.retries || 0, childRunId: evt.childRunId || null, childMode: evt.childMode || null, viaError: !!evt.viaError, tokens: evt.tokens ?? null, tokens_in: evt.tokens_in ?? null, tokens_out: evt.tokens_out ?? null, cost_cny: evt.cost_cny ?? null, cost_priced: evt.cost_priced === undefined ? null : !!evt.cost_priced, model_used: evt.model_used || null, usage_summary: evt.usage_summary || null }); // P5.8 下钻 / P5.11 异常分支 / P5.13 成本可视化透传
        if (evt.event === 'nodeSkip') send({ type: 'node', nodeId: evt.nodeId, title: evt.title, nodeType: evt.type, status: evt.preset ? 'preset' : 'skipped' });
        // P5.10 流式调试：LLM 节点逐字流出（前端节点卡片实时显示）
        if (evt.event === 'nodeStream') send({ type: 'node_stream', nodeId: evt.nodeId, title: evt.title, delta: evt.delta });
        // P5.6 Chatflow 直接回复：即时回传（测试弹窗显示 💬 直接回复条目）
        if (evt.event === 'nodeReply') send({ type: 'reply', nodeId: evt.nodeId, title: evt.title, text: evt.text });
      },
    });
    // results 裁剪后回传（前端缓存用于「从此节点重跑」；每变量 ≤1500 字符防 payload 过大）
    // P5.14 文件一等变量：file 富对象保完整 JSON（重跑时 Runner normalizePresetVars 对称还原；text 可能长但重跑需全文）
    const resultsSlim = {};
    for (const [nid, vars] of Object.entries(r.results || {})) {
      resultsSlim[nid] = {};
      for (const [k, v] of Object.entries(vars || {})) {
        const isFileObj = (v && typeof v === 'object' && v.__file) || (Array.isArray(v) && v.length && v[0]?.__file);
        resultsSlim[nid][k] = isFileObj ? JSON.stringify(v) : String(v ?? '').slice(0, 1500);
      }
    }
    // P5.5 更新运行实例：成功（P5.13 起直接取 Runner usage 汇总，不再正则扫日志）
    const totalTokens = r.usage?.totalTokens ?? 0;
    db.prepare(`UPDATE workflow_runs SET status='success', outputs=?, node_logs=?, total_tokens=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run(maskSecrets(String(r.output ?? '')).slice(0, 8000), JSON.stringify(r.logs).slice(0, 100000), totalTokens, Date.now() - t0, runInfo.lastInsertRowid);
    send({ type: 'done', output: r.output, logs: r.logs, results: resultsSlim, sessionVars: r.sessionVars || {}, runId: runInfo.lastInsertRowid, usage: r.usage || null, durationMs: Date.now() - t0 }); // P5.13 done 附 usage 汇总与总耗时
  } catch (e) {
    db.prepare(`UPDATE workflow_runs SET status='error', outputs='', node_logs=?, error=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run(JSON.stringify(e.logs || []).slice(0, 100000), maskSecrets(String(e.message || '')).slice(0, 500), Date.now() - t0, runInfo.lastInsertRowid);
    send({ type: 'error', message: e.message, logs: e.logs || [], runId: runInfo.lastInsertRowid });
  } finally {
    try { res.end(); } catch { }
  }
});

// P5.6 工具试运行：画布工具节点属性面板「⚡ 试运行」——填测试参数跑一次，返回结果与顶层字段清单（前端写回 data._fields 供引用校验）
router.post('/:id/tool-test', async (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无编辑权限' });
  const { toolId, args } = req.body || {};
  const tid = String(toolId || '').trim();
  if (!tid) return res.json({ code: 400, msg: '缺少 toolId 参数' });
  let argsObj = {};
  try { argsObj = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {}); } catch (e) { return res.json({ code: 400, msg: 'args 不是合法 JSON：' + e.message }); }
  try {
    // 内置工具与 MCP 工具均可试运行（runTool 统一分发；MCP 工具常返回 JSON 对象 → 字段发现主战场）
    const r = await runTool(tid, JSON.stringify(argsObj || {}), { kbId: old.kb_id, mcpServers: old.mcp_servers });
    const resultStr = String(r);
    // 顶层字段发现（与 Runner flattenToolResult 同语义；截取防止超长）
    let fields = [];
    try {
      const p = JSON.parse(resultStr);
      if (p && typeof p === 'object' && !Array.isArray(p)) fields = Object.keys(p).filter(k => k !== 'result').slice(0, 30);
    } catch { }
    res.json({ code: 0, data: { result: resultStr.slice(0, 8000), fields } });
  } catch (e) {
    res.json({ code: 500, msg: '工具执行失败：' + e.message });
  }
});

// P5.5 运行历史：列表（最近 50 条）+ 单条详情（节点级 Trace 回溯）
router.get('/:id/runs', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无查看权限' });
  const rows = db.prepare(`SELECT id, trigger_type, status, inputs, outputs, total_tokens, total_duration_ms, error, started_at, finished_at
    FROM workflow_runs WHERE agent_id=? ORDER BY id DESC LIMIT 50`).all(old.id)
    .map(r => ({ ...r, inputs: r.inputs?.slice(0, 200), outputs: r.outputs?.slice(0, 200) })); // 列表只给摘要
  res.json({ code: 0, data: rows });
});
router.get('/:id/runs/:runId', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无查看权限' });
  let row = db.prepare('SELECT * FROM workflow_runs WHERE id=? AND agent_id=?').get(req.params.runId, old.id);
  // P5.8 #9 下钻：子运行行本身归属子智能体——允许通过父智能体入口按 runId 直查（parent_run_id 非空的子 run）
  if (!row) {
    const sub = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(req.params.runId);
    if (sub && sub.parent_run_id) {
      const parent = db.prepare('SELECT agent_id FROM workflow_runs WHERE id=?').get(sub.parent_run_id);
      if (parent && parent.agent_id === old.id) row = sub;
    }
  }
  if (!row) return res.json({ code: 404, msg: '运行记录不存在' });
  let nodeLogs = [];
  try { nodeLogs = JSON.parse(row.node_logs || '[]'); } catch { }
  // P5.8 #9：子运行清单（agent 节点触发的子智能体 run，含子智能体名/模式，前端展示下钻入口）
  const childRuns = db.prepare(`SELECT r.id, r.agent_id, r.trigger_type, r.status, r.total_duration_ms, r.outputs, a.name AS agent_name, a.edit_mode AS child_mode
    FROM workflow_runs r LEFT JOIN agents a ON a.id=r.agent_id WHERE r.parent_run_id=? ORDER BY r.id`).all(row.id)
    .map(r => ({ ...r, outputs: r.outputs?.slice(0, 120) }));
  res.json({ code: 0, data: { ...row, node_logs: undefined, nodeLogs, childRuns } });
});

// 发布 / 下架 / 提审（SinguX 式发布体系：发布记录 + 分类 + 发布范围 + 允许复制为模板；P3：协作者可发布，受限智能体不上广场）
// V3.1 #12 审核流（2026-11-03）：企业版（audit_flow）非 admin 发布 → 提审进 review 状态待管理员审批；
// 社区/专业版与管理员发布直接生效（用户决策：社区版提审自动通过，管理员是审核主体不自审）
router.post('/:id/publish', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无发布权限（仅创建者、协作者与管理员）' });
  // 审核中不可重复提审（重复点击/前端状态不同步防护）
  if (old.status === 'review') return res.json({ code: 400, msg: '该智能体正在审核中，请等待管理员审批（或先联系管理员处理）' });
  const to = old.status === 'published' ? 'draft' : 'published';
  // V3.1 #12：企业版且非 admin 的发布意图 → 转提审（draft/rejected → review），不入发布分支
  if (to === 'published' && needsReview(req)) {
    const b = req.body || {};
    const record = (b.record || '').trim().slice(0, 200);
    db.prepare(`UPDATE agents SET status='review', publish_record=?, review_comment='', updated_at=datetime('now','localtime') WHERE id=?`).run(record, old.id);
    insertReview(old.id, 'submit', req.user.username, record);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '提交审核', old.name, req.ip, now());
    return res.json({ code: 0, msg: '已提交审核，等待管理员审批（企业版发布需审核）' });
  }
  let publishedVersion = null;
  if (to === 'published') {
    const b = req.body || {};
    const record = (b.record || '').trim().slice(0, 200);
    const category = (b.category || old.category || '未分类').trim().slice(0, 20);
    const isOfficial = req.user.role === 'admin' && b.is_official ? 1 : (old.is_official || 0);
    const allowCopy = b.allow_copy === false || b.allow_copy === 0 ? 0 : 1;
    // P5.9 版本管理：发布时把画布草稿快照存 published_workflow（运行时走快照，编辑草稿不影响线上）
    let snapSql = null, nodeCount = 0;
    if (old.edit_mode === 'canvas' || old.routing_mode === 'workflow') {
      const { validateWorkflowV2 } = require('../lib/workflow-schema');
      let wf = null;
      try { wf = JSON.parse(old.workflow || 'null'); } catch { wf = null; }
      const v = wf && validateWorkflowV2(wf);
      if (v && !v.error) { snapSql = JSON.stringify(v); nodeCount = v.nodes.length; }
    }
    const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_publish_history WHERE agent_id=?').get(old.id).v || 0) + 1;
    db.prepare(`UPDATE agents SET status='published', publish_record=?, category=?, is_official=?, allow_copy=?, published_workflow=COALESCE(?, published_workflow), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(record, category, isOfficial, allowCopy, snapSql, old.id);
    // P5.9 发布历史：每次发布存一条（快照 JSON + 版本号 + 说明）；画布智能体才入历史（表单模式无画布快照）
    if (snapSql) {
      publishedVersion = version;
      db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(old.id, version, snapSql, record, nodeCount, req.user.username);
    }
    // V3.1 #12：免审直发也记一条流水（auto_approve：社区/专业版或管理员直发），审核链完整可审计
    insertReview(old.id, 'auto_approve', req.user.username, '免审直发（' + (req.user.role === 'admin' ? '管理员' : '社区/专业版自动通过') + '）');
    // 发布到广场 → 全员广播通知（避免重复发布刷新；仅首次上架或记录变化时发送）
    // P3：受限可见（visibility=restricted）的智能体不上广场、不全员广播（仅指定范围可见）
    const restricted = (old.visibility === 'restricted' && b.visibility !== 'public');
    if (b.to_square !== false && !restricted) {
      const broadcast = (b.to_square === true) || old.status !== 'published';
      if (broadcast) {
        db.prepare(`INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES ('*',?,?,?,?,0,?)`)
          .run(`新智能体上架：${old.name}`, `「${old.name}」已发布到广场${record ? '——' + record : ''}，点击前往使用。`, 'agent_publish', `#/square`, now());
      }
    }
    // D3-4 评测体系：发布时自动采集一条可对比基线（复用该智能体最近评测集结果，无则回退真实遥测；
    // 同步 DB 聚合、零额外模型调用，fire-and-forget 不阻塞发布响应）。canvas 模式对齐发布历史版本号。
    try { require('../lib/eval-suite').autoCaptureOnPublish(old, snapSql ? version : null, req.user); } catch { /* 基线采集失败不影响发布 */ }
  } else {
    db.prepare(`UPDATE agents SET status='draft', updated_at=datetime('now','localtime') WHERE id=?`).run(old.id);
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, to === 'published' ? '发布智能体' : '下架智能体', old.name, req.ip, now());
  res.json({ code: 0, msg: to === 'published' ? (publishedVersion ? `已发布（画布快照 v${publishedVersion}，线上即刻生效）` : '已发布') : '已下架', data: publishedVersion ? { version: publishedVersion } : undefined });
});

// V3.1 #12 审核流（2026-11-03）：管理员审批——approve（复用发布逻辑：快照/历史/广场广播）/ reject（驳回带意见）
router.post('/:id/review', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '审核需要管理员权限' });
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (old.status !== 'review') return res.json({ code: 400, msg: '该智能体不在审核中（当前状态：' + old.status + '）' });
  const { action } = req.body || {};
  const comment = String((req.body || {}).comment || '').trim().slice(0, 500);
  if (action === 'approve') {
    // 复用发布分支逻辑（快照/版本历史/广场广播）——提审人写入 publish 相关字段（record 用提审说明，管理员审批不改发布说明）
    const record = old.publish_record || '';
    let snapSql = null, nodeCount = 0;
    if (old.edit_mode === 'canvas' || old.routing_mode === 'workflow') {
      const { validateWorkflowV2 } = require('../lib/workflow-schema');
      let wf = null;
      try { wf = JSON.parse(old.workflow || 'null'); } catch { wf = null; }
      const v = wf && validateWorkflowV2(wf);
      if (v && !v.error) { snapSql = JSON.stringify(v); nodeCount = v.nodes.length; }
    }
    const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_publish_history WHERE agent_id=?').get(old.id).v || 0) + 1;
    db.prepare(`UPDATE agents SET status='published', publish_record=?, published_workflow=COALESCE(?, published_workflow), review_comment='', updated_at=datetime('now','localtime') WHERE id=?`)
      .run(record, snapSql, old.id);
    if (snapSql) {
      db.prepare(`INSERT INTO agent_publish_history (agent_id, version, workflow, note, nodes, published_by, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(old.id, version, snapSql, record, nodeCount, old.owner || req.user.username);
    }
    insertReview(old.id, 'approve', req.user.username, comment);
    // 广场广播（同发布分支语义：受限智能体不上广场）
    if ((old.visibility || 'public') !== 'restricted') {
      db.prepare(`INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES ('*',?,?,?,?,0,?)`)
        .run(`新智能体上架：${old.name}`, `「${old.name}」审核通过已发布到广场${record ? '——' + record : ''}，点击前往使用。`, 'agent_publish', `#/square`, now());
    }
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '审核通过', old.name + (comment ? '（' + comment + '）' : ''), req.ip, now());
    return res.json({ code: 0, msg: '已审核通过并发布' + (snapSql ? `（画布快照 v${version}）` : '') });
  }
  if (action === 'reject') {
    if (!comment) return res.json({ code: 400, msg: '驳回必须填写审核意见（提审人需知道整改方向）' });
    db.prepare(`UPDATE agents SET status='rejected', review_comment=?, updated_at=datetime('now','localtime') WHERE id=?`).run(comment, old.id);
    insertReview(old.id, 'reject', req.user.username, comment);
    // 通知提审人（不在场的管理员操作后，提审人下次登录可见）
    db.prepare(`INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)`)
      .run(old.owner || '', `审核驳回：${old.name}`, `「${old.name}」未通过审核——${comment}。请修改后重新提审。`, 'agent_review', `#/admin/studio/${old.id}`, now());
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '审核驳回', old.name + '（' + comment + '）', req.ip, now());
    return res.json({ code: 0, msg: '已驳回，意见已通知提审人' });
  }
  return res.json({ code: 400, msg: 'action 仅支持 approve / reject' });
});

// P5.9 版本历史：列表（版本号/说明/发布人/节点数；不含大 JSON）
router.get('/:id/publish-history', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无查看权限' });
  const rows = db.prepare(`SELECT version, note, nodes, published_by, created_at FROM agent_publish_history WHERE agent_id=? ORDER BY version DESC LIMIT 50`).all(old.id);
  res.json({ code: 0, data: rows });
});

// P5.9 一键回滚：把历史版本快照写回草稿 + published_workflow 同步更新（线上立即生效）
router.post('/:id/publish-history/:version/rollback', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无回滚权限' });
  const hist = db.prepare('SELECT * FROM agent_publish_history WHERE agent_id=? AND version=?').get(old.id, +req.params.version);
  if (!hist) return res.json({ code: 404, msg: '该版本不存在' });
  // 校验快照仍可解析（防损坏数据回灌）
  let wf = null;
  try { wf = JSON.parse(hist.workflow || 'null'); } catch { wf = null; }
  if (!wf || !Array.isArray(wf.nodes)) return res.json({ code: 400, msg: '该版本快照数据损坏，无法回滚' });
  db.prepare(`UPDATE agents SET workflow=?, published_workflow=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(hist.workflow, hist.workflow, old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '回滚智能体版本', `${old.name} → v${hist.version}`, req.ip, now());
  res.json({ code: 0, msg: `已回滚到 v${hist.version}（草稿与线上快照均已恢复该版本）` });
});

// C2（2026-11-10 V3.2 收尾）：画布版本对比——两份快照（或快照↔当前草稿）的节点/连线级 diff。
// GET /:id/publish-history/diff?a=<version>&b=<version|draft>；核心算法在 lib/workflow-diff.js（纯函数，smoke 全覆盖）
router.get('/:id/publish-history/diff', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无查看权限' });
  const a = req.query.a, b = req.query.b;
  if (!a || !b) return res.json({ code: 400, msg: '缺少 a/b 版本参数' });
  // 取快照：draft = agents.workflow 当前草稿；数字 = agent_publish_history 快照
  const load = (v) => {
    if (v === 'draft') {
      if (!old.workflow) return { err: '该智能体没有画布草稿' };
      return { wf: old.workflow, label: '草稿' };
    }
    const row = db.prepare('SELECT workflow, created_at FROM agent_publish_history WHERE agent_id=? AND version=?').get(old.id, +v);
    if (!row) return { err: `版本 v${v} 不存在` };
    return { wf: row.workflow, label: `v${v}`, created_at: row.created_at };
  };
  const ra = load(a), rb = load(b);
  if (ra.err) return res.json({ code: 404, msg: ra.err });
  if (rb.err) return res.json({ code: 404, msg: rb.err });
  // 快照解析容错（防损坏数据进入 diff）
  const parse = (s, name) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
  const wa = parse(ra.wf), wb = parse(rb.wf);
  if (!wa || !Array.isArray(wa.nodes)) return res.json({ code: 400, msg: `${ra.label} 快照数据损坏，无法对比` });
  if (!wb || !Array.isArray(wb.nodes)) return res.json({ code: 400, msg: `${rb.label} 快照数据损坏，无法对比` });
  // 节点 id → 展示信息（类型/名称）：两侧合并，供前端把连线两端渲染成节点名而非裸 id
  const nodeMap = {};
  for (const n of [...(wa.nodes || []), ...(wb.nodes || [])]) {
    if (n && n.id != null && !nodeMap[n.id]) nodeMap[String(n.id)] = { type: n.type || '', label: String((n.data && (n.data.label || n.data.name)) || '') };
  }
  res.json({
    code: 0,
    data: {
      a: { version: a, label: ra.label, created_at: ra.created_at || null },
      b: { version: b, label: rb.label, created_at: rb.created_at || null },
      diff: diffWorkflows(wa, wb),
      nodeMap,
    },
  });
});

// ---------- LLMOps 提示词版本管理（2026-10-31 计划 #10） ----------

// 版本列表：version DESC 上限 50。权限=可编辑者（与 PUT 同款 canEdit 校验）——
// 版本含提示词全文，泄露面等同编辑权限，故不放宽到仅可见者
router.get('/:id/prompt-versions', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无查看权限（提示词版本仅创建者、协作者与管理员可见）' });
  const rows = db.prepare(`SELECT id, version, prompt, user_prompt, edited_by, note, created_at FROM agent_prompt_versions WHERE agent_id=? ORDER BY version DESC LIMIT 50`).all(old.id);
  res.json({ code: 0, data: rows });
});

// 一键回滚：把该版本的 prompt/user_prompt 写回 agents 表 + 自动记一条新版本
// （note='回滚到 vN'——回滚是显式操作，即使值与当前相同也留痕"谁在何时回滚"，完整审计链）
router.post('/:id/prompt-versions/:vid/rollback', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canEdit(old, req.user)) return res.json({ code: 403, msg: '无回滚权限（仅创建者、协作者与管理员）' });
  const ver = db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id=? AND version=?').get(old.id, +req.params.vid);
  if (!ver) return res.json({ code: 404, msg: '该版本不存在' });
  db.prepare(`UPDATE agents SET prompt=?, user_prompt=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(ver.prompt || '', ver.user_prompt || '', old.id);
  const nv = insertPromptVersion(old.id, ver.prompt, ver.user_prompt, req.user.username, `回滚到 v${ver.version}`);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '回滚提示词版本', `${old.name} → 恢复 v${ver.version}（记为 v${nv}）`, req.ip, now());
  res.json({ code: 0, msg: `已回滚到 v${ver.version}`, data: { version: nv } });
});

// ---------- 智能体广场（SinguX 式：已发布智能体集中展示，分类/搜索/官方/收藏/统计；P3：仅公开展示 public 智能体） ----------
router.get('/square/list', (req, res) => {
  const { category, keyword, official, mine } = req.query;
  let sql = `SELECT a.id,a.name,a.description,a.type,a.category,a.icon,a.model,a.source,a.source_name,a.is_official,a.allow_copy,a.fav_count,a.use_count,
      a.publish_record,a.updated_at,a.opening_questions,
      s.name AS space_name,
      (SELECT COUNT(DISTINCT s2.username) FROM sessions s2 WHERE s2.agent_id=a.id) AS user_count,
      (SELECT COUNT(*) FROM sessions s3 WHERE s3.agent_id=a.id) AS session_count
    FROM agents a LEFT JOIN spaces s ON s.id=a.space_id WHERE a.status='published' AND COALESCE(a.visibility,'public')='public'`;
  const args = [];
  if (category && category !== '全部') { sql += ' AND a.category=?'; args.push(category); }
  if (official === '1' || official === 'true') { sql += ' AND a.is_official=1'; }
  if (keyword) { sql += ' AND (a.name LIKE ? OR a.description LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
  if (mine === '1') { sql += ` AND a.id IN (SELECT agent_id FROM favorites WHERE username=?)`; args.push(req.user.username); }
  sql += ' ORDER BY a.is_official DESC, (a.use_count + a.fav_count * 3) DESC, a.updated_at DESC';
  let rows = db.prepare(sql).all(...args);
  // 标记当前用户收藏状态
  const favSet = new Set(db.prepare('SELECT agent_id FROM favorites WHERE username=?').all(req.user.username).map(r => r.agent_id));
  rows = rows.map(r => ({ ...r, favorited: favSet.has(r.id) }));
  // 分类列表（带计数，仅公开智能体）
  const cats = db.prepare(`SELECT category, COUNT(*) c FROM agents WHERE status='published' AND COALESCE(visibility,'public')='public' GROUP BY category ORDER BY c DESC`).all();
  res.json({ code: 0, data: { list: rows, categories: cats } });
});

// 收藏 / 取消收藏（广场 ⭐；冗余计数 fav_count 同步维护）
router.post('/:id/favorite', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(a, req.user)) return res.json({ code: 403, msg: '无权访问该智能体' });
  try {
    db.prepare('INSERT INTO favorites (username,agent_id,created_at) VALUES (?,?,?)').run(req.user.username, a.id, now());
    db.prepare('UPDATE agents SET fav_count=fav_count+1 WHERE id=?').run(a.id);
  } catch {
    return res.json({ code: 400, msg: '已收藏过该智能体' });
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '收藏智能体', a.name, req.ip, now());
  res.json({ code: 0, msg: '已收藏' });
});
router.delete('/:id/favorite', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  const info = db.prepare('DELETE FROM favorites WHERE username=? AND agent_id=?').run(req.user.username, a.id);
  if (info.changes) db.prepare('UPDATE agents SET fav_count=MAX(fav_count-1,0) WHERE id=?').run(a.id);
  res.json({ code: 0, msg: '已取消收藏' });
});

// 复制创建（SinguX「允许复制（模板）」：复制他人智能体为我的草稿，知识库/工具/编排全量带回；P3：需可见才可复制）
router.post('/:id/copy', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(a, req.user)) return res.json({ code: 403, msg: '无权访问该智能体' });
  if (!a.allow_copy) return res.json({ code: 403, msg: '该智能体未开放复制（模板）' });
  const name = ((req.body || {}).name || a.name + '（副本）').slice(0, 50);
  // P5.34b（审查 F2/Y1）：复制时过滤违禁与未知工具——否则存量被注入的 create_task/local_exec
  // 可借复制无限传播（复制语义保留：剔除而非拒收，与对话链路组装点过滤同口径）
  let copyTools = [];
  try { copyTools = JSON.parse(a.tools || '[]').filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t)); } catch { copyTools = []; }
  const info = db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,user_prompt,model,temperature,top_p,diversity_mode,icon,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,source_name,tools,mcp_servers,long_memory,allow_user_model,suggest_enabled,variables,child_ids,owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
    .run(name, a.description, a.type, a.space_id, a.category, a.prompt, a.user_prompt, a.model, a.temperature, a.top_p, a.diversity_mode, a.icon,
      a.context_rounds, a.max_reply, a.opening, a.opening_questions, a.kb_id, 'draft', 'self', '', JSON.stringify(copyTools), a.mcp_servers,
      a.long_memory, a.allow_user_model, a.suggest_enabled, a.variables, a.child_ids, req.user.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '复制智能体', `${a.name} → ${name}`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: '已复制为我的草稿' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(old, req.user)) return res.json({ code: 403, msg: '无删除权限（仅创建者与管理员，协作者不可删除）' });
  db.prepare('DELETE FROM agents WHERE id=?').run(old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除智能体', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// ---------- API 发布（OpenAI 兼容端点密钥；P3：归属级权限） ----------
const crypto = require('crypto');

router.get('/:id/api-keys', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（API 密钥仅创建者与管理员可管理）' });
  const rows = db.prepare('SELECT id,agent_id,key,name,status,created_at,last_used_at FROM agent_api_keys WHERE agent_id=? ORDER BY id DESC').all(req.params.id);
  res.json({ code: 0, data: rows });
});

router.post('/:id/api-keys', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（API 密钥仅创建者与管理员可管理）' });
  const key = 'sk-ap-' + crypto.randomBytes(20).toString('hex');
  const name = (req.body || {}).name || '默认密钥';
  const info = db.prepare('INSERT INTO agent_api_keys (agent_id,key,name,status,created_at) VALUES (?,?,?,1,datetime(\'now\',\'localtime\'))')
    .run(agent.id, key, name);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建智能体API密钥', `${agent.name}（${name}）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, key } });
});

router.post('/:id/api-keys/:kid/toggle', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（API 密钥仅创建者与管理员可管理）' });
  const k = db.prepare('SELECT * FROM agent_api_keys WHERE id=? AND agent_id=?').get(req.params.kid, req.params.id);
  if (!k) return res.json({ code: 404, msg: '密钥不存在' });
  db.prepare('UPDATE agent_api_keys SET status=? WHERE id=?').run(k.status ? 0 : 1, k.id);
  res.json({ code: 0, msg: k.status ? '已停用' : '已启用' });
});

router.delete('/:id/api-keys/:kid', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（API 密钥仅创建者与管理员可管理）' });
  db.prepare('DELETE FROM agent_api_keys WHERE id=? AND agent_id=?').run(req.params.kid, req.params.id);
  res.json({ code: 0, msg: '已删除' });
});

// ---------- 分享链接（支持有效期：expires_days 0=永久 / 1 / 7 / 30 天；P3：归属级权限） ----------
router.post('/:id/share', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（分享链接仅创建者与管理员可管理）' });
  const enable = (req.body || {}).enable;
  if (enable) {
    let token = agent.share_token;
    if (!token) {
      token = crypto.randomBytes(12).toString('hex');
      db.prepare('UPDATE agents SET share_token=? WHERE id=?').run(token, agent.id);
    }
    // 有效期：默认沿用已有；显式传 0 表示永久
    let expiresAt = agent.share_expires_at;
    const days = (req.body || {}).expires_days;
    if (days != null) {
      expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') : null;
    }
    db.prepare('UPDATE agents SET share_enabled=1, share_expires_at=? WHERE id=?').run(expiresAt, agent.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '开启智能体分享', `${agent.name}${expiresAt ? '（有效期至 ' + expiresAt + '）' : '（永久）'}`, req.ip, now());
    res.json({ code: 0, data: { share_token: token, url: `/share/${token}`, expires_at: expiresAt } });
  } else {
    db.prepare('UPDATE agents SET share_enabled=0 WHERE id=?').run(agent.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '关闭智能体分享', agent.name, req.ip, now());
    res.json({ code: 0, msg: '已关闭分享' });
  }
});

// ---------- V3.1 #12 嵌入代码（2026-11-03）：第三方站点嵌入（iframe / JS 浮窗两种） ----------
// 安全设计（对齐安全报告 T2.1/T2.3）：
//   ① 嵌入前提 = 已发布 + 已开启分享（复用 share_token 免登链路，不新开匿名面）
//   ② 域名白名单 embed_domains 驱动 server.js 的 CSP frame-ancestors（未配置=仅 'self' 可嵌，防点击劫持）
//   ③ 权限 = isOwnerLevel（嵌入暴露面管理属归属级决策，与分享开关同档）
//   ④ 域名格式严格校验（防 CSP 头注入：逗号/引号/通配符一律拒绝）
router.post('/:id/embed-config', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（嵌入配置仅创建者与管理员可管理）' });
  const raw = String((req.body || {}).domains || '');
  // 解析 + 格式校验：支持逗号/换行/中文分隔符；每项须为纯域名（含子域），拒绝 http 前缀（只按域匹配）
  const items = raw.split(/[,\n;，；]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = items.filter(d => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.length > 253);
  if (bad.length) return res.json({ code: 400, msg: `域名格式不合法：${bad.join('、')}（应为纯域名如 example.com，不带 http:// 前缀）` });
  const uniq = [...new Set(items)].slice(0, 20); // 上限 20 个（防 CSP 头超长）
  db.prepare('UPDATE agents SET embed_domains=? WHERE id=?').run(uniq.join(','), agent.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '配置嵌入域名', `${agent.name}：${uniq.length ? uniq.join(',') : '（清空，仅本站可嵌）'}`, req.ip, now());
  res.json({ code: 0, msg: uniq.length ? `已允许 ${uniq.length} 个域名嵌入（CSP 即刻生效）` : '已清空域名白名单（仅本站可嵌入）', data: { domains: uniq } });
});

// 嵌入代码生成：iframe 直嵌 + JS 浮窗两种 snippet（含域名白名单回显；未达前提时返回引导信息）
router.get('/:id/embed-code', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '无权限（嵌入代码仅创建者与管理员可获取）' });
  if (agent.status !== 'published') return res.json({ code: 400, msg: '请先发布该智能体（嵌入页面仅对已发布智能体可用）', data: { need: 'publish' } });
  if (!agent.share_enabled || !agent.share_token) return res.json({ code: 400, msg: '请先开启分享链接（嵌入复用分享链路的免登会话）', data: { need: 'share' } });
  const domains = String(agent.embed_domains || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!domains.length) return res.json({ code: 400, msg: '请先配置允许嵌入的域名白名单（防点击劫持：未配置时仅本站可嵌）', data: { need: 'domains' } });
  // 站点根地址：协议 + Host（嵌入方按此拼 URL；反代/子路径部署天然兼容）
  const origin = `${req.protocol}://${req.headers.host || 'localhost'}`;
  const shareUrl = `${origin}/share/${agent.share_token}`;
  const iframe = `<iframe src="${shareUrl}" title="${agent.name.replace(/"/g, '&quot;')}" style="width:100%;height:640px;border:0;border-radius:12px" loading="lazy" allow="clipboard-write"></iframe>`;
  const script = `<!-- 智能体嵌入浮窗：${agent.name}（在页面右下角渲染对话球，点击展开） -->\n<script>\n(function(){var s=document.createElement('script');s.async=true;\ns.src="${origin}/embed/widget.js?token=${agent.share_token}";\ndocument.body.appendChild(s);})();\n</script>`;
  res.json({ code: 0, data: { domains, share_url: shareUrl, iframe, script, note: `已允许嵌入的域名：${domains.join('、')}（配置变更在「嵌入」弹窗中保存，CSP 即刻生效）` } });
});

// ---------- 提示词 AI 优化（借鉴 SinguX「优化」按钮：AI 根据简单描述生成结构化提示词） ----------
router.post('/optimize-prompt', async (req, res) => {
  const { name, description, prompt } = req.body || {};
  const raw = (prompt || '').trim() || (description || '').trim();
  if (!raw && !name) return res.json({ code: 400, msg: '请先填写智能体名称或简单描述' });
  try {
    const meta = [
      { role: 'system', content: `你是提示词工程专家。请根据用户提供的智能体信息，产出一份高质量的中文系统提示词（System Prompt）。
要求：
1. 使用「# 角色 / # 技能 / # 限制」分节结构，条理清晰；
2. 明确身份定位、能力范围、回复规则与边界（不编造、专业语气等）；
3. 结合智能体名称与用途描述做针对性设计；
4. 只输出提示词本身，不要任何解释说明、不要代码块包裹。
字数控制在 150~400 字。` },
      { role: 'user', content: `智能体名称：${name || '（未提供）'}\n用途/简单描述：${raw || '（未提供，请按名称合理推断）'}\n\n请生成优化后的系统提示词。` },
    ];
    const r = await chatOnce(meta, { temperature: 0.4, max_reply: 800, agentName: '提示词优化' });
    const out = (r.full || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!out) return res.json({ code: 500, msg: '优化失败：模型未返回内容' });
    res.json({ code: 0, data: { prompt: out } });
  } catch (e) {
    res.json({ code: 500, msg: '提示词优化失败：' + e.message });
  }
});

// ---------- 智能体数据分析（借鉴 SinguX「分析」：使用人数/会话数/消息数/token/趋势/最近会话；P3：需编辑权） ----------
router.get('/:id/analytics', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!agent) return res.json({ code: 404, msg: '智能体不存在' });
  if (!canView(agent, req.user)) return res.json({ code: 403, msg: '无权访问该智能体' });
  const aid = agent.id;
  const overview = {
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions WHERE agent_id=?').get(aid).c,
    share_sessions: db.prepare('SELECT COUNT(*) c FROM share_sessions WHERE share_token=?').get(agent.share_token || '__none__').c,
    messages: db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_id=?)`).get(aid).c,
    users: db.prepare(`SELECT COUNT(DISTINCT s.username) c FROM sessions s JOIN users u ON u.username=s.username WHERE s.agent_id=?`).get(aid).c,
    tokens: db.prepare(`SELECT COALESCE(SUM(tokens),0) c FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_id=?)`).get(aid).c,
    avg_latency: Math.round(db.prepare(`SELECT COALESCE(AVG(latency_ms),0) c FROM chat_traces WHERE agent_id=?`).get(aid).c),
  };
  // 近 14 天会话趋势
  const trend = db.prepare(`SELECT substr(created_at,1,10) d, COUNT(*) c FROM sessions WHERE agent_id=? AND created_at >= datetime('now','-14 day','localtime') GROUP BY d ORDER BY d`).all(aid)
    .map(r => ({ day: r.d, count: r.c }));
  // 最近 10 个会话
  const recent = db.prepare(`SELECT s.id, s.title, s.created_at, s.updated_at, u.nickname,
    (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) msg_count
    FROM sessions s LEFT JOIN users u ON u.username=s.username WHERE s.agent_id=? ORDER BY s.updated_at DESC LIMIT 10`).all(aid);
  res.json({ code: 0, data: { overview, trend, recent } });
});

// ---------- 智能体配置导出 / 导入（借鉴 SinguX「导出配置/导入配置」：备份、迁移、交付；P3：导出仅归属级） ----------
router.get('/:id/export', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '智能体不存在' });
  if (!isOwnerLevel(a, req.user)) return res.json({ code: 403, msg: '无权限（配置导出仅创建者与管理员）' });
  const cfg = {
    export_version: 1,
    exported_at: now(),
    platform: 'Agent开发平台',
    agent: {
      name: a.name,
      origin_name: a.name,
      description: a.description, type: a.type, category: a.category,
      prompt: a.prompt, user_prompt: a.user_prompt, model: a.model,
      temperature: a.temperature, top_p: a.top_p, diversity_mode: a.diversity_mode,
      context_rounds: a.context_rounds, max_reply: a.max_reply,
      opening: a.opening, opening_questions: JSON.parse(a.opening_questions || '[]'),
      tools: JSON.parse(a.tools || '[]'), mcp_servers: JSON.parse(a.mcp_servers || '[]'),
      long_memory: a.long_memory, allow_user_model: a.allow_user_model, suggest_enabled: a.suggest_enabled,
      variables: JSON.parse(a.variables || '[]'), icon: a.icon,
      child_ids: JSON.parse(a.child_ids || '[]'),
      kb_name: a.kb_id ? (db.prepare('SELECT name FROM kbs WHERE id=?').get(a.kb_id)?.name || null) : null,
    },
  };
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '导出智能体配置', a.name, req.ip, now());
  res.setHeader('Content-Disposition', `attachment; filename="agent-${a.id}-${encodeURIComponent(a.name)}.json"`);
  res.json(cfg);
});

router.post('/import', (req, res) => {
  const b = req.body || {};
  const cfg = b.config && b.config.agent ? b.config : null;
  if (!cfg) return res.json({ code: 400, msg: '导入失败：不是有效的智能体配置文件（缺少 agent 字段）' });
  const a = cfg.agent;
  if (!a.name) return res.json({ code: 400, msg: '导入失败：配置缺少名称' });
  // P5.34：导入配置同样过工具白名单（外部配置文件不可绕过；未知工具与违禁工具一律拒收——
  // 校验函数对两者均报错；拒收比剔除更安全，与 POST/PUT 行为一致）
  const importTools = Array.isArray(a.tools) ? a.tools : [];
  const importDeny = validateAgentTools(importTools);
  if (importDeny) return res.json({ code: 400, msg: '导入失败：' + importDeny });
  const safeImportTools = importTools.filter(t => TOOL_DEFS[t]); // 防御性二次过滤（当前不可达，保留兑底）
  // 知识库按名称匹配（跨环境 ID 不通用）
  let kbId = null;
  if (a.kb_name) {
    const kb = db.prepare('SELECT id FROM kbs WHERE name=?').get(a.kb_name);
    if (kb) kbId = kb.id;
  }
  const info = db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,user_prompt,model,temperature,top_p,diversity_mode,icon,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,tools,mcp_servers,long_memory,allow_user_model,suggest_enabled,variables,child_ids,owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
    .run(
      (b.name_override || a.name).trim().slice(0, 50),
      a.description || '', a.type || 'digital', null, a.category || '未分类',
      a.prompt || '', a.user_prompt || '', a.model || 'qwen-plus', a.temperature ?? 0.7, a.top_p ?? 0.7,
      ['precise', 'balanced', 'creative', 'custom'].includes(a.diversity_mode) ? a.diversity_mode : 'balanced',
      a.icon || '', a.context_rounds ?? 10, a.max_reply ?? 1024,
      a.opening || '', JSON.stringify(Array.isArray(a.opening_questions) ? a.opening_questions : []),
      kbId, 'draft', 'self',
      JSON.stringify(safeImportTools), JSON.stringify(Array.isArray(a.mcp_servers) ? a.mcp_servers : []),
      a.long_memory ? 1 : 0, a.allow_user_model === false || a.allow_user_model === 0 ? 0 : 1,
      a.suggest_enabled === false || a.suggest_enabled === 0 ? 0 : 1,
      JSON.stringify(Array.isArray(a.variables) ? a.variables.filter(v => v && v.name) : []),
      JSON.stringify(Array.isArray(a.child_ids) ? a.child_ids.map(Number).filter(Boolean) : []),
      req.user.username,
    );
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '导入智能体配置', (b.name_override || a.name) + (kbId ? `（知识库「${a.kb_name}」已按名称匹配）` : a.kb_name ? `（知识库「${a.kb_name}」不存在，已解除关联）` : ''), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: `已导入为草稿「${b.name_override || a.name}」` });
});

// ---------- 空间管理 ----------
router.get('/spaces/list', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可查看空间列表' });
  res.json({ code: 0, data: db.prepare('SELECT * FROM spaces ORDER BY id').all() });
});
router.post('/spaces', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可创建空间' });
  const { name, type, owner, members } = req.body || {};
  if (!name || !['enterprise', 'dept', 'personal'].includes(type)) return res.json({ code: 400, msg: '请填写空间名称并选择类型' });
  const info = db.prepare(`INSERT INTO spaces (name,type,owner,members,created_at) VALUES (?,?,?,?,datetime('now','localtime'))`).run(name, type, owner || req.user.nickname || req.user.username, members || 1);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '新建空间', name, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});
router.put('/spaces/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可修改空间' });
  const { name, type, owner, members } = req.body || {};
  const old = db.prepare('SELECT * FROM spaces WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '空间不存在' });
  db.prepare('UPDATE spaces SET name=?,type=?,owner=?,members=? WHERE id=?').run(name || old.name, type || old.type, owner ?? old.owner, members ?? old.members, old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '修改空间', old.name, req.ip, now());
  res.json({ code: 0, msg: '已保存' });
});
router.delete('/spaces/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.json({ code: 403, msg: '仅管理员可删除空间' });
  const old = db.prepare('SELECT * FROM spaces WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '空间不存在' });
  db.prepare('DELETE FROM spaces WHERE id=?').run(req.params.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除空间', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// ---------- 智能体测评（P3：发起测评需对该智能体有编辑权；查看/删除需有归属权限） ----------
router.get('/evaluations', (req, res) => {
  // V1.3 #6 2026-10-30：type 过滤防污染——evaluations 表已双型共存（type='agent'|'kb'，kb 型带 kb_id），
  // 智能体侧列表仅取 type='agent'（OR type IS NULL 为存量 NULL 双保险：db 迁移已归一，防直改库残留）；
  // 响应 e.* 天然带 type/kb_id 字段（kb 型行恒不出现于此列表，双向隔离见 knowledge.js 评测集端点）
  const rows = db.prepare(`SELECT e.*, a.name AS agent_name FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id WHERE (e.type='agent' OR e.type IS NULL) ORDER BY e.id DESC`).all();
  // 非管理员只返回有权查看的智能体的测评（canView 过滤）
  const filtered = req.user.role === 'admin' ? rows : rows.filter(r => {
    const agent = db.prepare('SELECT owner,collaborators FROM agents WHERE id=?').get(r.agent_id);
    if (!agent) return false;
    return canView(agent, req.user);
  });
  res.json({ code: 0, data: filtered });
});
router.post('/evaluations', async (req, res) => {
  const { name, agent_id, rule_prompt, dataset } = req.body || {};
  if (!name || !agent_id) return res.json({ code: 400, msg: '请填写测评名称并选择智能体' });
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agent_id);
  if (!agent) return res.json({ code: 400, msg: '目标智能体不存在' });
  if (!canEdit(agent, req.user)) return res.json({ code: 403, msg: '无权对该智能体发起测评' });
  let items = [];
  try { items = JSON.parse(dataset || '[]'); } catch { items = []; }
  if (!items.length) return res.json({ code: 400, msg: '请提供测评数据集（JSON 数组：[{q, expect}]）' });
  const results = [];
  let total = 0;
  for (const it of items.slice(0, 20)) {
    const r = await chatOnce([
      { role: 'system', content: agent.prompt || '你是智能助手。' },
      { role: 'user', content: it.q },
    ], { model: agent.model, temperature: 0.2, agentName: agent.name });
    const got = (r.full || '').slice(0, 500);
    // 简单规则评分：期望关键词命中比例
    const keys = String(it.expect || '').split(/[，,、\s]+/).filter(Boolean);
    const hit = keys.filter(k => got.includes(k)).length;
    const score = keys.length ? +(hit / keys.length).toFixed(2) : 1;
    total += score;
    results.push({ q: it.q, expect: it.expect, got, score });
  }
  const score = Math.round((total / results.length) * 100);
  // V1.3 #6 2026-10-30：写入时显式 type='agent' / kb_id=NULL——防知识库侧评测集语义混入智能体测评
  const info = db.prepare(`INSERT INTO evaluations (name,agent_id,rule_prompt,dataset,status,score,result,type,kb_id,created_at) VALUES (?,?,?,?,?,?,?,'agent',NULL,datetime('now','localtime'))`)
    .run(name, agent_id, rule_prompt || '', JSON.stringify(items), 'done', score, JSON.stringify(results));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '新建测评', name + '（得分 ' + score + '）', req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, score } });
});
router.delete('/evaluations/:id', (req, res) => {
  const evalRow = db.prepare('SELECT * FROM evaluations WHERE id=?').get(req.params.id);
  if (!evalRow) return res.json({ code: 404, msg: '测评记录不存在' });
  const agent = db.prepare('SELECT owner,collaborators FROM agents WHERE id=?').get(evalRow.agent_id);
  if (!agent) return res.json({ code: 404, msg: '关联智能体不存在' });
  if (!isOwnerLevel(agent, req.user)) return res.json({ code: 403, msg: '仅管理员或智能体创建者可删除测评' });
  db.prepare('DELETE FROM evaluations WHERE id=?').run(req.params.id);
  res.json({ code: 0, msg: '已删除' });
});

// ---------- U2-6 对话式建 Agent ----------

const GEN_SUGGESTION_SYSTEM = `你是一个智能体创建专家。用户会描述他的需求，你需要根据以下格式输出 JSON 建议：
{
  "name": "建议的智能体名（简洁，限 30 字）",
  "description": "一句话描述",
  "type": "enterprise | digital | dept | other",
  "prompt": "系统提示词（完整，包含角色设定+行为约束+输出格式）",
  "tools": ["web_search", "get_datetime", "calculator", "kb_search"],
  "model": "",
  "variables": [{ "name": "user_name", "type": "string", "label": "用户姓名", "required": true, "desc": "请输入您的姓名" }],
  "confirm_questions": ["确认问题1", "确认问题2"]
}
你现在需要帮助用户创建智能体，请先收集必要信息然后输出建议。输出格式必须是以上 JSON，不需要额外解释。`;

/** POST /api/agents/generate-suggestion — AI 辅导对话，生成智能体创建建议
 *  body: { messages: [{ role, content }] }
 *  将对话历史 + 固定 system prompt 传給 chatOnce 生成 JSON 建议 */
router.post('/generate-suggestion', async (req, res) => {
  const { messages = [] } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.json({ code: 400, msg: 'messages 数组不能为空' });
  }
  try {
    const fullMessages = [{ role: 'system', content: GEN_SUGGESTION_SYSTEM }, ...messages];
    const result = await chatOnce(fullMessages, { model: '' });
    if (!result || !result.full) return res.json({ code: 400, msg: 'AI 未能生成建议，请重试' });
    let suggestion = null;
    try { suggestion = JSON.parse(result.full); } catch { /* 若输出不是纯 JSON，尝试提取第一个 { } 块 */ }
    if (!suggestion) {
      const m = result.full.match(/\{[\s\S]*\}/);
      if (m) { try { suggestion = JSON.parse(m[0]); } catch { } }
    }
    if (!suggestion || !suggestion.name) return res.json({ code: 400, msg: 'AI 返回格式异常，建议重试' });
    res.json({ code: 0, data: { suggestion, raw: result.full } });
  } catch (e) {
    res.json({ code: 500, msg: '建议生成失败：' + e.message });
  }
});

/** POST /api/agents/bulk-create — AI 辅导一键创建智能体
 *  body: { suggestion: { name, description, type, prompt, tools, model, variables } }
 *  创建智能体（state='draft'）并返回 agent_id。调用方可继续编辑/发布 */
router.post('/bulk-create', async (req, res) => {
  const { suggestion } = req.body || {};
  if (!suggestion || !suggestion.name) return res.json({ code: 400, msg: '智能体建议信息不完整' });
  // 校验必填
  const name = String(suggestion.name || '').trim().slice(0, 50);
  if (!name) return res.json({ code: 400, msg: '智能体名不能为空' });
  // 获取个人空间
  const mySpace = db.prepare('SELECT id FROM spaces WHERE owner=? AND type=? LIMIT 1').get(req.user.username, 'personal') || {};
  const spaceId = mySpace.id || 0;
  const variables = Array.isArray(suggestion.variables) ? suggestion.variables : [];
  const tools = Array.isArray(suggestion.tools) ? suggestion.tools : [];
  const prompt = (suggestion.prompt || '').trim();
  const type = ['enterprise', 'digital', 'dept', 'other'].includes(suggestion.type) ? suggestion.type : 'digital';
  try {
    const info = db.prepare(`INSERT INTO agents (name,description,prompt,type,space_id,owner,status,model,tools,variables,edit_mode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'draft',?,?,?,'canvas',?,?)`)
      .run(name, (suggestion.description || '').slice(0, 200), prompt, type, spaceId, req.user.username,
        suggestion.model || '', JSON.stringify(tools), JSON.stringify(variables), now(), now());
    const agentId = info.lastInsertRowid;
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, 'AI 辅导创建智能体', `${name}（#${agentId}）`, req.ip, now());
    res.json({ code: 0, data: { id: agentId, name }, msg: '智能体已创建，可进入编排页进一步编辑' });
  } catch (e) {
    res.json({ code: 500, msg: '创建失败：' + e.message });
  }
});

module.exports = router;
