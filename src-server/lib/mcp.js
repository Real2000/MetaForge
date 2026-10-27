/**
 * MCP（Model Context Protocol）客户端，Streamable HTTP 传输（JSON-RPC 2.0 over HTTP POST）。
 * 协议流程：initialize → notifications/initialized → tools/list → tools/call
 * 会话标识：Mcp-Session-Id 响应头（存在时后续请求携带）。
 * 兼容 SSE 响应（text/event-stream 里的 data: 行）与 JSON 响应。
 */

function parseRpcResult(bodyText, contentType) {
  let payload = bodyText;
  if (contentType && contentType.includes('text/event-stream')) {
    // SSE：取所有 data: 行合并（单条 JSON-RPC 响应）
    const datas = bodyText.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .filter(Boolean);
    if (!datas.length) throw new Error('MCP SSE 响应无 data 行');
    payload = datas[0];
    for (const d of datas) {
      try {
        const j = JSON.parse(d);
        if (j.id !== undefined && (j.result !== undefined || j.error !== undefined)) { payload = d; break; }
      } catch { }
    }
  }
  const j = JSON.parse(payload);
  if (j.error) throw new Error(`MCP 错误 ${j.error.code}：${j.error.message}`);
  return j.result;
}

/** 单次 JSON-RPC POST。session 可选（{id}）。返回 {result, sessionId} */
async function rpc(url, apiKey, method, params, session, timeoutMs = 20000) {
  const body = { jsonrpc: '2.0', id: Date.now() % 2147483647, method, ...(params !== undefined ? { params } : {}) };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  if (session?.id) headers['Mcp-Session-Id'] = session.id;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sid = res.headers.get('mcp-session-id') || session?.id || '';
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`MCP HTTP ${res.status}: ${t.slice(0, 150)}`);
  }
  const text = await res.text();
  if (!text.trim()) return { result: null, sessionId: sid }; // 202 Accepted（通知类）
  return { result: parseRpcResult(text, res.headers.get('content-type') || ''), sessionId: sid };
}

/** 初始化会话并返回 sessionId（可复用缓存） */
async function connect(server, timeoutMs = 15000) {
  const { result, sessionId } = await rpc(server.url, server.api_key, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agent-platform', version: '1.0.0' },
  }, null, timeoutMs);
  // 发送 initialized 通知（无 id，接受 202）
  try {
    await rpc(server.url, server.api_key, 'notifications/initialized', undefined, { id: sessionId }, 8000);
  } catch { /* 部分实现不要求 */ }
  return { serverInfo: result?.serverInfo || {}, sessionId };
}

/** P5.32 MCP 工具风险分级（白名单式，安全优先）；P5.33 审查修复（R1/F6）改分词整词匹配：
 *  - 名称先做驼峰拆分再按非字母数字切词，整词比对写类词表——修复原 \b 词边界对 snake_case（create_user）
 *    与驼峰（DeleteAll）全部失效的实锤缺陷，并补 wipe/erase/purge/destroy 等同义词
 *  - 分词含任一写类词 → 永远 high（即使 server 声明 readOnlyHint 也按 high——注解由 server 自报，不可盲信），
 *    覆盖 fetch_and_send / get_flag_then_delete 类组合动词伪装
 *  - destructiveHint=true → high；readOnlyHint=true 仅在首词为读动词且无写类词时才采信（防 xdelete+readOnlyHint 伪装）
 *  - 首词为读动词（get/read/search/…）→ low；其余未知 → high（保守）
 *  - 分级结果仅在 server.trusted=1（管理员显式信任）时生效——默认 0 时整类 high（tools.js toolRiskOf 查询时判定）
 *  返回值随 listTools 落入 tools_cache 持久化，向后兼容：无 risk 字段的旧缓存一律按 high */
const MCP_WRITE_WORDS = new Set(['create', 'write', 'update', 'delete', 'remove', 'drop', 'insert', 'post', 'put', 'patch', 'send', 'submit', 'exec', 'execute', 'run', 'move', 'rename', 'copy', 'upload', 'set', 'add', 'edit', 'modify', 'clear', 'reset', 'close', 'cancel', 'confirm', 'approve', 'pay', 'transfer', 'publish', 'deploy', 'install', 'kill', 'stop', 'start', 'reboot', 'restart', 'wipe', 'erase', 'purge', 'destroy', 'nuke', 'format', 'rm', 'truncate', 'grant', 'revoke', 'lock', 'unlock']);
const MCP_READ_VERBS = new Set(['get', 'read', 'search', 'find', 'query', 'list', 'fetch', 'view', 'show', 'describe', 'lookup', 'select', 'check', 'count', 'analyze', 'summarize', 'summary', 'scan', 'browse']);
const MCP_WRITE_CN_RE = /(写入|修改|删除|发送|创建|执行|上传|发布|停用|启用|变更|提交|支付|转移|清除|销毁)/;
/** 工具名分词：驼峰拆分 + 非字母数字切分（覆盖 snake_case / kebab-case / 混合） */
function tokenizeToolName(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
function gradeMcpToolRisk(originalName, description, annotations = {}) {
  const tokens = tokenizeToolName(originalName);
  const hasWrite = tokens.some(t => MCP_WRITE_WORDS.has(t)) || MCP_WRITE_CN_RE.test(String(description || ''));
  if (hasWrite) return 'high';
  if (annotations && annotations.destructiveHint === true) return 'high';
  const firstRead = tokens.length > 0 && MCP_READ_VERBS.has(tokens[0]);
  if (annotations && annotations.readOnlyHint === true && firstRead) return 'low';
  if (firstRead) return 'low';
  return 'high'; // 未知命名/无注解 → 保守按 high
}

/** 拉取工具清单（OpenAI tools 兼容格式 + MCP 原始信息 + P5.32 风险分级） */
async function listTools(server) {
  const { sessionId } = await connect(server);
  const { result } = await rpc(server.url, server.api_key, 'tools/list', {}, { id: sessionId });
  const tools = (result?.tools || []).map(t => ({
    // 命名空间化：避免不同 MCP 服务的工具重名
    name: `mcp_${t.name}`,
    originalName: t.name,
    description: t.description || '',
    annotations: t.annotations || {}, // MCP 规范注解（readOnlyHint/destructiveHint 等，分级依据）
    risk: gradeMcpToolRisk(t.name, t.description, t.annotations), // P5.32 分级结果随 tools_cache 持久化
    schema: {
      type: 'function',
      function: {
        name: `mcp_${t.name}`,
        description: `[${server.name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    },
  }));
  return { tools, sessionId };
}

/** 调用 MCP 工具。argsJson 为 JSON 字符串 */
async function callTool(server, toolName, argsJson, timeoutMs = 30000) {
  const { sessionId } = await connect(server);
  let args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { }
  const { result } = await rpc(server.url, server.api_key, 'tools/call', {
    name: toolName,
    arguments: args,
  }, { id: sessionId }, timeoutMs);
  // result: {content: [{type, text}|...], isError?}
  if (result?.isError) {
    const t = (result.content || []).map(c => c.text || '').join(' ');
    throw new Error(`MCP 工具执行错误：${t.slice(0, 200)}`);
  }
  const parts = (result?.content || []).map(c => {
    if (c.type === 'text') return c.text;
    if (c.type === 'image') return `[图片：${c.mimeType || ''}]`;
    if (c.type === 'resource') return `[资源：${c.resource?.uri || ''}]`;
    return JSON.stringify(c);
  });
  return parts.join('\n') || '(空结果)';
}

module.exports = { connect, listTools, callTool, gradeMcpToolRisk };
