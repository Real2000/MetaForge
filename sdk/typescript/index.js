/**
 * 智能体开发平台官方 TypeScript/JavaScript SDK（U1-8）— 实现文件
 *
 * 契约与用法见 index.d.ts（三行代码完成一次对话）：
 *   const { AgentPlatform } = require('agent-platform-sdk');
 *   const ap = new AgentPlatform({ baseUrl: 'http://localhost:3210', apiKey: 'sk-ap-xxx' });
 *   const r = await ap.chat.completions.create({ model: 'agent-1-助手', messages: [{ role: 'user', content: '你好' }] });
 *
 * 零运行时依赖：Node 18+ 原生 fetch；SSE 解析自实现（OpenAI chunk 协议）。
 */

/** SDK 错误：携带 HTTP 状态与平台返回的 error 结构（OpenAI 兼容错误信封） */
class AgentPlatformError extends Error {
  constructor(message, status, apiError) {
    super(message);
    this.name = 'AgentPlatformError';
    this.status = status;
    this.apiError = apiError; // { message, type } | null
  }
}

/** 平台 API 错误信封解析（非 2xx 时平台返回 { error: { message, type } }） */
function raise(res, bodyText) {
  let apiError = null;
  try {
    const j = JSON.parse(bodyText);
    if (j && j.error && typeof j.error === 'object') {
      apiError = { message: String(j.error.message ?? ''), type: String(j.error.type ?? 'unknown') };
    }
  } catch { /* 非 JSON 错误体（网关 HTML 等）按 null 处理 */ }
  throw new AgentPlatformError(
    apiError ? `平台返回 ${res.status}：${apiError.message}（${apiError.type}）` : `HTTP ${res.status}：${String(bodyText).slice(0, 200)}`,
    res.status,
    apiError,
  );
}

/** SSE 逐行解析器（OpenAI chunk 协议：`data: {...}` 行 + `data: [DONE]` 终止行）。
 *  平台流式实现为「结束时一次性下发完整 delta + [DONE]」——解析器按标准协议实现，两种服务端行为均正确消费。 */
async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // 忽略空行/注释行
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;
      try { yield JSON.parse(payload); } catch { /* 坏行跳过，流不断 */ }
    }
  }
}

class AgentPlatform {
  constructor(opts) {
    if (!opts || !opts.baseUrl) throw new Error('baseUrl 不能为空（如 http://localhost:3210）');
    if (!opts.apiKey) throw new Error('apiKey 不能为空（后台「智能体管理 → API」创建的 sk-ap-xxx 密钥）');
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    if (typeof this.fetchImpl !== 'function') throw new Error('当前运行时无 fetch（需 Node 18+ 或注入 fetchImpl）');
  }

  _req(path, init = {}) {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async _json(res) {
    const text = await res.text();
    if (!res.ok) raise(res, text);
    return JSON.parse(text);
  }

  /** 对话补全（OpenAI 兼容）。非流式返回完整结果；stream:true 返回异步迭代器逐块产出 */
  async chatCompletions(params) {
    if (params && params.stream) {
      const res = await this._req('/openapi/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: params.model, messages: params.messages, stream: true }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        raise(res, t);
      }
      return parseSse(res.body);
    }
    const res = await this._req('/openapi/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: params.model, messages: params.messages, stream: false }),
    });
    return this._json(res);
  }

  /** 列出可用智能体（model id 形如 agent-<id>-<名称>） */
  async listModels() {
    const res = await this._req('/openapi/v1/models');
    const j = await this._json(res);
    return Array.isArray(j && j.data) ? j.data : [];
  }

  /** 便捷方法：一轮对话直接拿回复文本（非流式）。 */
  async chatOnce(model, message, system) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });
    const r = await this.chatCompletions({ model, messages });
    return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
  }
}

// OpenAI SDK 风格的命名空间结构：ap.chat.completions.create(...)
Object.defineProperty(AgentPlatform.prototype, 'chat', {
  get() {
    return {
      completions: {
        create: p => this.chatCompletions(p),
      },
    };
  },
});

module.exports = { AgentPlatform, AgentPlatformError };
module.exports.default = AgentPlatform;
