/** API 封装 + 登录态
 *  P2-3 彻底修复 2026-11-09（HttpOnly Cookie 改造）：
 *  - token 不再写入任何 JS 可读存储（localStorage/sessionStorage 全部撤除）——认证凭据由服务端
 *    Set-Cookie 下发的 HttpOnly Cookie 承载（document.cookie 不可读，XSS 无法窃取外带）；
 *    同源 fetch 默认携带 Cookie，服务端 auth 中间件 Bearer 头/ Cookie 双通道兼容。
 *  - setLogin 的 token 参数仅保留在内存变量（页面级生命周期，刷新即失——刷新后由 Cookie 重新鉴权，
 *    服务端 /auth/me 恢复用户态）；登录响应里的 token 仍存在（兼容 API 调用方），但前端不再持久化。
 *  - ap_user（昵称/角色等 UI 展示信息，非凭据）仍存 localStorage 供路由守卫与界面渲染；
 *    权限真正的边界在服务端 adminOnly，此处仅做展示层。
 *  - 模块加载时清理历史版本遗留的存量 token（旧 token 在 TTL 内仍有效，不清理则 XSS 依旧可读——
 *    迁移安全的关键一步）。 */
const TOKEN_KEY = 'ap_token';
const USER_KEY = 'ap_user';

let memToken = ''; // 内存态 token（仅本页生命周期，兼容少数需要显式携带 Bearer 的调用方）

// 迁移清理：一次性移除历史版本写入 localStorage/sessionStorage 的存量 token（幂等）
try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { }

function getUserStored() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}
function persistUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { }
}
function clearUser() {
  try { localStorage.removeItem(USER_KEY); } catch { }
}

export function getToken() { return memToken; }
export function getUser() { return getUserStored(); }
export function setLogin(token, user) { memToken = String(token || ''); persistUser(user); }
export function logout() { memToken = ''; clearUser(); }

/** 构造请求头：内存 token 存在时附 Bearer（显式通道），否则省略——同源请求自动带 HttpOnly Cookie */
function authHeaders(extra) {
  const h = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (memToken) h.Authorization = 'Bearer ' + memToken;
  return h;
}

export async function api(path, opts = {}) {
  // P5.23 弱网反馈：>8s 未返回弹出慢请求提示（不中断请求，恢复后自动消失；toast 模块延迟引入避免环依赖）
  let slowTip = null;
  const slowTimer = setTimeout(async () => {
    try { const { toast } = await import('./ui.js'); slowTip = toast('网络较慢，正在努力加载…', 'info'); } catch { }
  }, 8000);
  try {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: authHeaders(opts.headers),
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
      headers: authHeaders(),
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
