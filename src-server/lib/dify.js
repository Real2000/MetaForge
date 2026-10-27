/**
 * Dify 对接层（真纳管）：
 * 1. consoleLogin：模拟 Dify 控制台登录（1.17+ 密码需 Base64 编码传输，登录态走 Cookie + CSRF）
 * 2. listApps：拉取应用清单（console API）
 * 3. ensureAppApiKey：获取/创建应用 Service API Key（app-xxx）
 * 4. chatStream / completionOnce：调用应用 API（/v1/chat-messages 等），流式协议与 lib/llm.js 的 chat() 一致
 */
const BASE64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

/** 去掉 endpoint 末尾的 /v1，得到 console 根地址 */
function consoleBase(endpoint) {
  return (endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/** 登录 Dify 控制台，返回 { cookie, csrf }（后续 console 请求所需） */
async function consoleLogin(endpoint, email, password) {
  const base = consoleBase(endpoint);
  if (!base) throw new Error('Dify 服务地址未配置');
  const res = await fetch(base + '/console/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: BASE64(password), remember_me: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Dify 控制台登录失败（HTTP ${res.status}）`);
  const j = await res.json().catch(() => ({}));
  if (j.result !== 'success') throw new Error('Dify 控制台登录失败：' + (j.message || '账号或密码错误'));
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const pairs = {};
  for (const c of setCookies) {
    const [kv] = c.split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) pairs[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  const cookie = ['access_token', 'refresh_token', 'csrf_token']
    .filter(k => pairs[k])
    .map(k => `${k}=${pairs[k]}`).join('; ');
  if (!pairs.access_token) throw new Error('Dify 登录成功但未返回会话 Cookie');
  return { cookie, csrf: pairs['csrf_token'] || '' };
}

/** console 请求封装（带 Cookie + CSRF） */
async function consoleFetch(endpoint, session, path, opts = {}) {
  const base = consoleBase(endpoint);
  const res = await fetch(base + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Cookie: session.cookie,
      ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Dify console API ${path} 返回 ${res.status}: ${t.slice(0, 150)}`);
  }
  return res.json();
}

/** 拉取应用清单（自动翻页） */
async function listApps(endpoint, session) {
  const items = [];
  let page = 1;
  while (true) {
    const j = await consoleFetch(endpoint, session, `/console/api/apps?page=${page}&limit=100`);
    items.push(...(j.data || []));
    if (!j.has_more || page > 20) break;
    page++;
  }
  return items; // {id, name, mode, description, ...}
}

/** 获取应用的 Service API Key（无则创建） */
async function ensureAppApiKey(endpoint, session, appId) {
  const list = await consoleFetch(endpoint, session, `/console/api/apps/${appId}/api-keys`);
  const existing = (list.data || []).find(k => k.status === 'active' || k.token);
  if (existing?.token) return existing.token;
  const created = await consoleFetch(endpoint, session, `/console/api/apps/${appId}/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!created.token) throw new Error('Dify 未返回 Service API Key');
  return created.token;
}

/** 删除应用的全部 Service API Key（用于重新生成） */
async function clearAppApiKeys(endpoint, session, appId) {
  const list = await consoleFetch(endpoint, session, `/console/api/apps/${appId}/api-keys`);
  for (const k of (list.data || [])) {
    if (k.id) await consoleFetch(endpoint, session, `/console/api/apps/${appId}/api-keys/${k.id}`, { method: 'DELETE' });
  }
}

/**
 * 对话型应用流式调用（chat / agent-chat / advanced-chat）。
 * 与 lib/llm.js 的 chat() 协议一致：yield {delta}，返回 {usage, full, mode:'dify', conversationId}
 */
async function* chatStream(endpoint, serviceKey, opts = {}) {
  const base = consoleBase(endpoint);
  const res = await fetch(base + '/v1/chat-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + serviceKey },
    body: JSON.stringify({
      inputs: {},
      query: opts.query,
      response_mode: 'streaming',
      user: opts.user || 'agent-platform',
      conversation_id: opts.conversationId || '',
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dify 应用返回 ${res.status}: ${text.slice(0, 200)}`);
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
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        // Dify 的 SSE 事件类型在 data JSON 的 event 字段内（非 event: 行）
        const ev = j.event || '';
        if (ev === 'message' && typeof j.answer === 'string') {
          full += j.answer;
          if (j.conversation_id) conversationId = j.conversation_id;
          yield { delta: j.answer };
        } else if (ev === 'message_end') {
          usage = j.metadata?.usage || usage;
          if (j.conversation_id) conversationId = j.conversation_id;
        } else if (ev === 'error') {
          throw new Error('Dify 应用执行错误：' + (j.message || data.slice(0, 150)));
        }
      } catch (e) {
        if (e.message?.startsWith('Dify 应用执行错误')) throw e;
        /* 忽略不完整片段 */
      }
    }
  }
  return { usage, full, mode: 'dify', conversationId };
}

/** 文本生成型应用单轮调用（completion），非流式取全文 */
async function completionOnce(endpoint, serviceKey, opts = {}) {
  const base = consoleBase(endpoint);
  const res = await fetch(base + '/v1/completion-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + serviceKey },
    body: JSON.stringify({
      inputs: { query: opts.query },
      response_mode: 'blocking',
      user: opts.user || 'agent-platform',
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dify 应用返回 ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  return { full: j.answer || '', usage: j.metadata?.usage || null, mode: 'dify' };
}

module.exports = { consoleBase, consoleLogin, listApps, ensureAppApiKey, clearAppApiKeys, chatStream, completionOnce };
