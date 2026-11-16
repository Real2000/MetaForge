/**
 * 智能体开发平台官方 TypeScript/JavaScript SDK（U1-8）
 *
 * 三行代码完成一次对话（验收标准）：
 *   import { AgentPlatform } from 'agent-platform-sdk';
 *   const ap = new AgentPlatform({ baseUrl: 'http://localhost:3210', apiKey: 'sk-ap-xxx' });
 *   const r = await ap.chat.completions.create({ model: 'agent-1-助手', messages: [{ role: 'user', content: '你好' }] });
 *
 * 端点契约（与平台 /openapi 路由一致，OpenAI 兼容）：
 *   GET  /openapi/v1/models           列出已发布智能体（model id 形如 agent-<id>-<名称>）
 *   POST /openapi/v1/chat/completions 对话（Bearer sk-ap-xxx；支持 stream SSE）
 * 认证：agent_api_keys 密钥（后台「智能体管理 → API」创建，model 前缀 agent-<id>- 指定目标智能体）。
 *
 * 零运行时依赖：Node 18+ 原生 fetch；SSE 解析自实现（按 OpenAI chunk 协议逐行解析）。
 * 兼容消费方式：CommonJS（require）与 ESM（动态 import 均可——本文件为 CommonJS 单文件）。
 */

/** SDK 配置 */
export interface SDKOptions {
  /** 平台地址（协议+主机+端口，如 http://localhost:3210；尾斜杠自动去除） */
  baseUrl: string;
  /** agent_api_keys 密钥（sk-ap-xxx） */
  apiKey: string;
  /** 请求超时毫秒（默认 60s；流式为首字节超时语义） */
  timeoutMs?: number;
  /** 自定义 fetch（测试注入用；默认 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

/** 对话消息（OpenAI 兼容结构） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 非流式对话响应（OpenAI 兼容） */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: ChatMessage; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 流式增量块（OpenAI 兼容） */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason?: string | null }>;
}

/** 智能体（models 列表项，id 即 chat 用的 model 名） */
export interface AgentModel {
  id: string;
  object: 'model';
  owned_by: string;
  description?: string;
}

/** SDK 错误：携带 HTTP 状态与平台返回的 error 结构（OpenAI 兼容错误信封） */
export class AgentPlatformError extends Error {
  status: number;
  /** 平台错误信封 { error: { message, type } }；非 JSON 响应时为 null */
  apiError: { message: string; type: string } | null;

  constructor(message: string, status: number, apiError: { message: string; type: string } | null) {
    super(message);
    this.name = 'AgentPlatformError';
    this.status = status;
    this.apiError = apiError;
  }
}

/** 平台 API 错误信封解析（非 2xx 时平台返回 { error: { message, type } }） */
function raise(res: Response, bodyText: string): never {
  let apiError: { message: string; type: string } | null = null;
  try {
    const j = JSON.parse(bodyText);
    if (j && j.error && typeof j.error === 'object') {
      apiError = { message: String(j.error.message ?? ''), type: String(j.error.type ?? 'unknown') };
    }
  } catch { /* 非 JSON 错误体（网关 HTML 等）按 null 处理 */ }
  throw new AgentPlatformError(
    apiError ? `平台返回 ${res.status}：${apiError.message}（${apiError.type}）` : `HTTP ${res.status}：${bodyText.slice(0, 200)}`,
    res.status,
    apiError,
  );
}

/** SSE 逐行解析器（OpenAI chunk 协议：`data: {...}` 行 + `data: [DONE]` 终止行）。
 *  平台流式实现为「结束时一次性下发完整 delta + [DONE]」——解析器按标准协议实现，两种服务端行为均正确消费。 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // 忽略空行/注释行
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;
      try { yield JSON.parse(payload) as ChatCompletionChunk; } catch { /* 坏行跳过，流不断 */ }
    }
  }
}

/** 主客户端类 */
export class AgentPlatform {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SDKOptions) {
    if (!opts || !opts.baseUrl) throw new Error('baseUrl 不能为空（如 http://localhost:3210）');
    if (!opts.apiKey) throw new Error('apiKey 不能为空（后台「智能体管理 → API」创建的 sk-ap-xxx 密钥）');
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis));
    if (typeof this.fetchImpl !== 'function') throw new Error('当前运行时无 fetch（需 Node 18+ 或注入 fetchImpl）');
  }

  /** 对话补全（OpenAI 兼容）。非流式返回完整结果；stream:true 返回异步迭代器逐块产出 */
  readonly chat = {
    completions: {
      create: async (params: {
        model: string;
        messages: ChatMessage[];
        stream?: boolean;
      }): Promise<ChatCompletion | AsyncGenerator<ChatCompletionChunk>> => {
        const res = await this.fetchImpl(`${this.baseUrl}/openapi/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: params.model, messages: params.messages, stream: !!params.stream }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) raise(res, text);
        if (!params.stream) return JSON.parse(text) as ChatCompletion;
        // 流式：res 已被 text() 消费——重新发起（OpenAI SDK 同款策略：流式走独立请求）
        const sres = await this.fetchImpl(`${this.baseUrl}/openapi/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: params.model, messages: params.messages, stream: true }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!sres.ok) {
          const stext = await sres.text().catch(() => '');
          raise(sres, stext);
        }
        return parseSse(sres.body as ReadableStream<Uint8Array>);
      },
    },
  };

  /** 列出可用智能体（model id 形如 agent-<id>-<名称>） */
  async listModels(): Promise<AgentModel[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/openapi/v1/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) raise(res, text);
    const j = JSON.parse(text);
    return Array.isArray(j && j.data) ? j.data : [];
  }

  /** 便捷方法：一轮对话直接拿回复文本（非流式）。 */
  async chatOnce(model: string, message: string, system?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });
    const r = (await this.chat.completions.create({ model, messages })) as ChatCompletion;
    return r.choices?.[0]?.message?.content ?? '';
  }
}

export default AgentPlatform;
