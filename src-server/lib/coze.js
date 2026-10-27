/**
 * 扣子（Coze）对接层（真纳管）：
 * 1. listWorkspaces：GET /v1/workspaces 拉取 PAT 可访问的团队/个人空间
 * 2. listBots：GET /v1/bots?workspace_id=xx 拉取空间内智能体（Bot）清单（自动翻页）
 * 3. chatStream：POST /v3/chat 流式对话（要求该 Bot 已在扣子侧发布为 API 渠道），
 *    SSE 协议与 lib/llm.js 的 chat() / dify.js 的 chatStream() 一致。
 * 认证：个人访问令牌 PAT（Authorization: Bearer pat_xxx），在扣子「API 管理 → 个人访问令牌」创建，
 * 需勾选「团队空间管理(listBot/listWorkspace) + Bot 管理 + 对话」权限。
 */
const API_BASE = 'https://api.coze.cn';

/** PAT 请求封装：统一处理 Coze code!=0 业务错误 */
async function cozeFetch(path, token, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  if (res.status === 401) throw new Error('PAT 令牌无效或已过期（HTTP 401），请到扣子「API 管理 → 个人访问令牌」重新生成');
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Coze API ${path} 返回 HTTP ${res.status}: ${t.slice(0, 150)}`);
  }
  const j = await res.json();
  if (j.code !== 0) throw new Error(`Coze API ${path} 错误(${j.code}): ${j.msg || ''}`);
  return j.data;
}

/** 列出 PAT 可访问的工作空间（含个人空间） */
async function listWorkspaces(token) {
  const data = await cozeFetch('/v1/workspaces', token);
  // { total_count, workspaces: [{ id, name, role_type, ... }] }
  return (data && data.workspaces) || [];
}

/** 列出指定空间内的智能体（Bot，自动翻页），返回 [{ bot_id, name, description, update_time, ... }] */
async function listBots(token, workspaceId) {
  const items = [];
  let pageNum = 0;
  while (true) {
    const data = await cozeFetch(`/v1/bots?workspace_id=${workspaceId}&page_size=50&page_num=${pageNum}`, token);
    items.push(...((data && data.items) || []));
    if (!data || !data.has_more || pageNum > 20) break;
    pageNum++;
  }
  return items;
}

/** 获取空间内全部智能体（遍历所有工作空间），返回 { spaces:[{id,name,bot_count}], bots:[{...bot, workspace_id, workspace_name}] } */
async function listAllBots(token) {
  const spaces = await listWorkspaces(token);
  const bots = [];
  const spaceInfo = [];
  for (const sp of spaces) {
    const list = await listBots(token, sp.id);
    spaceInfo.push({ id: sp.id, name: sp.name || sp.id, bot_count: list.length });
    for (const b of list) bots.push({ ...b, workspace_id: sp.id, workspace_name: sp.name });
  }
  return { spaces: spaceInfo, bots };
}

/**
 * Bot 流式对话（v3/chat，SSE）。
 * 与 llm.js chat() 协议一致：yield {delta}，返回 {usage, full, mode:'coze', conversationId}
 * 注意：Bot 需在扣子侧发布且授权给 PAT 的「对话」权限；未发布会抛出明确错误。
 */
async function* chatStream(token, botId, opts = {}) {
  const res = await fetch(API_BASE + '/v3/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      bot_id: botId,
      user_id: opts.user || 'agent-platform',
      stream: true,
      auto_save_history: true,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      additional_messages: [
        { role: 'user', content: String(opts.query || ''), content_type: 'text' },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let hint = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      if (j.code === 4101) hint = '该 Bot 未发布为 API 渠道或 PAT 缺少对话权限，请到扣子发布后重试';
      else if (j.msg) hint = j.msg;
    } catch { /* 保留原文 */ }
    throw new Error(`Coze 对话返回 ${res.status}: ${hint}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  let conversationId = opts.conversationId || '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    let eventName = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('event:')) { eventName = t.slice(6).trim(); continue; }
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        // v3/chat 事件：conversation.message.delta 为增量；conversation.chat.failed 为失败
        if (eventName === 'conversation.message.delta' && typeof j.content === 'string') {
          full += j.content;
          if (j.conversation_id) conversationId = j.conversation_id;
          yield { delta: j.content };
        } else if (eventName === 'conversation.chat.completed') {
          usage = j.usage || usage;
          if (j.conversation_id) conversationId = j.conversation_id;
        } else if (eventName === 'conversation.chat.failed' || eventName === 'conversation.chat.requires_action') {
          throw new Error('Coze Bot 执行失败：' + (j.last_error?.msg || j.msg || eventName));
        } else if (eventName === 'done' && j.usage) {
          usage = j.usage;
        }
      } catch (e) {
        if (e.message?.startsWith('Coze Bot 执行失败')) throw e;
        /* 忽略不完整片段 */
      }
    }
  }
  return { usage, full, mode: 'coze', conversationId };
}

/** 列出指定空间内的工作流（低代码应用的工作流资源，page_num 从 1 开始），返回 [{ workflow_id, workflow_name, app_id, description, ... }] */
async function listWorkflows(token, workspaceId) {
  const items = [];
  let pageNum = 1;
  while (true) {
    const data = await cozeFetch(`/v1/workflows?workspace_id=${workspaceId}&page_size=50&page_num=${pageNum}`, token);
    items.push(...((data && data.items) || []));
    if (!data || !data.has_more || pageNum > 20) break;
    pageNum++;
  }
  return items;
}

/** 获取空间内全部工作流（遍历工作空间） */
async function listAllWorkflows(token) {
  const spaces = await listWorkspaces(token);
  const out = [];
  for (const sp of spaces) {
    const wfs = await listWorkflows(token, sp.id);
    for (const w of wfs) out.push({ ...w, workspace_id: sp.id, workspace_name: sp.name });
  }
  return out;
}

/**
 * 运行工作流（POST /v1/workflow/run，同步阻塞直到完成，长任务需较大 timeout）。
 * parameters 为开始节点输入（如 { input: '...', mode: '1', style: '漫画风格' }）。
 * 返回 { data: {...输出变量}, debug_url }；失败抛错（含扣子侧错误信息）。
 */
async function runWorkflow(token, workflowId, parameters, timeoutMs = 600000) {
  const res = await fetch(API_BASE + '/v1/workflow/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ workflow_id: String(workflowId), parameters: parameters || {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error('PAT 令牌无效或已过期（HTTP 401），请到扣子重新生成');
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) {
    throw new Error(`Coze 工作流运行失败(${j.code || res.status}): ${j.msg || ''}`);
  }
  return { data: j.data, debug_url: j.debug_url };
}

module.exports = { listWorkspaces, listBots, listAllBots, listWorkflows, listAllWorkflows, runWorkflow, chatStream, API_BASE };
