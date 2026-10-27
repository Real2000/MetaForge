/** API 封装 + 登录态 */
const TOKEN_KEY = 'ap_token';
const USER_KEY = 'ap_user';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
export function setLogin(token, user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); }
export function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

export async function api(path, opts = {}) {
  // P5.23 弱网反馈：>8s 未返回弹出慢请求提示（不中断请求，恢复后自动消失；toast 模块延迟引入避免环依赖）
  let slowTip = null;
  const slowTimer = setTimeout(async () => {
    try { const { toast } = await import('./ui.js'); slowTip = toast('网络较慢，正在努力加载…', 'info'); } catch { }
  }, 8000);
  try {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken(), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { logout(); location.hash = '#/login'; throw new Error('登录已过期'); }
    const j = await res.json().catch(() => ({ code: 500, msg: '响应解析失败' }));
    if (j.code !== 0 && !(opts.rawResponse)) {
      // 携带业务错误码与数据（P3：乐观锁 409 冲突 / 升级引导 402 需要读 data）
      const err = new Error(j.msg || '请求失败'); err.code = j.code; err.data = j.data; throw err;
    }
    return j;
  } finally {
    clearTimeout(slowTimer);
    // 慢提示 toast 自带 2.6s 自动消失（ui.js toast 语义），无需手动清理
  }
}

/** POST SSE 流式对话。handlers: {onKb, onDelta, onNotice, onTool, onSuggestions, onBlocked, onDone, onError, onAborter, onAborted}
 *  P5.29 停止生成：onAborter(abortFn) 在请求发出前同步交出中断句柄（调用方存下，点击停止按钮时执行）；
 *  中断后 fetch/reader 抛 AbortError → 转为 onAborted 回调（不抛给调用方，组件清理逻辑照常走） */
export async function sseChat(body, handlers) {
  const ctrl = new AbortController();
  handlers.onAborter?.(() => ctrl.abort());
  let res;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify(body),
      signal: ctrl.signal, // P5.29：停止生成——中断请求（后端 req 'close' 感知断连后中止模型流）
    });
  } catch (e) {
    if (e?.name === 'AbortError') { handlers.onAborted?.(); return; }
    handlers.onError?.(new Error('连接失败：' + (e.message || '网络异常')));
    return;
  }
  if (!res.ok || !res.body) { handlers.onError?.(new Error('HTTP ' + res.status)); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop();
      for (const b of blocks) {
        let event = 'message', data = '';
        for (const line of b.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (event === 'delta') handlers.onDelta?.(j.text);
        else if (event === 'kb') handlers.onKb?.(j.hits);
        else if (event === 'notice') handlers.onNotice?.(j.msg);
        else if (event === 'tool') handlers.onTool?.(j);
        else if (event === 'tool_confirm') handlers.onToolConfirm?.(j); // P5.25：权限确认（「默认权限」下高危工具执行前）
        else if (event === 'suggestions') handlers.onSuggestions?.(j.list);
        else if (event === 'title') handlers.onTitle?.(j); // P2 会话标题自动生成推送
        else if (event === 'blocked') handlers.onBlocked?.(j.msg);
        else if (event === 'done') handlers.onDone?.(j);
        else if (event === 'error') handlers.onError?.(new Error(j.msg));
      }
    }
  } catch (e) {
    // P5.29：用户停止（abort）→ onAborted；网络断开 → onError（此前未捕获直接炸到调用方，按钮永久卡死）
    if (e?.name === 'AbortError') { handlers.onAborted?.(); return; }
    handlers.onError?.(new Error('流中断：' + (e.message || '网络异常')));
  }
}
