/**
 * LLM 调用层：
 * 1. 若默认供应商已配置且填了 api_key → 真实调用 OpenAI 兼容 /chat/completions（SSE 流式）
 * 2. 否则 → 内置模拟流式回复（基于提示词/知识库上下文的确定性生成）
 * 统一以 async generator 形式输出 { delta } 事件，结束时返回 { usage }
 *
 * LLMOps 硬超时（2026-10-31 计划 #10）：非流式链路（chatOnce：TOC 提取/GraphRAG 抽取/关键词生成/评测/
 * 任务执行等）支持整体硬超时——供应商网关故障时上游 connect timeout 无限挂起，生产实测把上传请求
 * 拖死 90s+。机制：chatOnce 注入 opts.hardTimeoutMs（默认 120s，环境变量 LLM_TIMEOUT_MS 可覆盖），
 * postModel 内与调用方 signal 合并（AbortSignal.any）后作用于 fetch（含响应体读取阶段）。
 * 【严禁】给流式对话（chat.js → chat()）整体加超时——长回答会被中途截断；hardTimeoutMs 仅由
 * chatOnce 注入，流式路径不传该值则 postModel 行为与旧版完全一致。超时抛 TimeoutError，
 * 现有 isFailoverWorthy 已判定 Timeout 类错误走故障转移（failover 下一候选重新计时）。
 */
const { db } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const circuit = require('./circuit');

function getDefaultProvider() {
  const p = dal.getq('SELECT * FROM providers WHERE is_default=1 AND tenant_id=0');
  return p || dal.getq('SELECT * FROM providers WHERE is_default=1 ORDER BY tenant_id LIMIT 1') || null;
}

/** MT-12：由 username 反查租户（容错 null）——用于构建租户可见的供应商候选。*/
function tenantOfUser(username) {
  if (!username) return null;
  try { const r = dal.getq('SELECT tenant_id FROM users WHERE username=?', [username]); return r && r.tenant_id != null ? Number(r.tenant_id) : null; } catch { return null; }
}

/* ---------------- 网络容错层（2026-10-14）：瞬时故障自动重试 ----------------
 * 实测问题：本机到 TG 网关的 TCP 连接偶发建立卡死（undici 连接超时 ~10s，UND_ERR_CONNECT_TIMEOUT），
 * 网关上游渠道也会瞬时 502。两者重试一次即可恢复，故在「连接建立/响应头」阶段自动重试，
 * 用户不再看到 fetch failed / 502 报错。流式 body 已开始输出后不重试（避免重复输出）。 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 网络错误 → 用户可读文案 */
function friendlyNetError(e) {
  const code = e?.cause?.code || '';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return '连接模型网关超时';
  if (code === 'ECONNRESET') return '与模型网关的连接被重置';
  if (code === 'ECONNREFUSED') return '模型网关拒绝连接（服务可能未启动）';
  if (code === 'ETIMEDOUT') return '与模型网关通信超时';
  if (code === 'EPIPE') return '与模型网关的连接中断';
  if (code === 'EAI_AGAIN') return '模型网关域名解析失败';
  if ((e?.name || '').includes('Timeout')) return '请求超时';
  if (/fetch failed/i.test(e?.message || '')) return '网络连接模型网关失败';
  return e?.message || '未知网络错误';
}

/** 可安全重试的失败：连接类网络错误（发生在响应体消费之前） */
function isRetryableNetErr(e) {
  const code = e?.cause?.code || '';
  return ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)
    || /fetch failed/i.test(e?.message || '');
}

/** 合并多个 AbortSignal（任一触发即触发）。仅 postModel 硬超时使用：
 *  Node ≥20 走 AbortSignal.any；老 Node 降级手动桥接（本项目现跑 Node 24，防御性保留）。 */
function mergeAbortSignals(signals) {
  const live = signals.filter(Boolean);
  if (!live.length) return null;
  if (live.length === 1) return live[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live);
  const ctrl = new AbortController();
  const onAbort = () => {
    for (const s of live) s.removeEventListener('abort', onAbort);
    ctrl.abort(live.find(s => s.aborted)?.reason);
  };
  for (const s of live) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
}

/** P5.19 节点级故障转移条件：超时/网络抖动/429 限流/5xx（可降级到备用模型的失败类型）。
 *  4xx 确定性错误（鉴权失败/模型不存在/参数错）不在内——换模型也不解决（备用模型同样鉴权体系），
 *  报错让用户改配置才是正解。 */
function isFailoverWorthy(e) {
  if (isRetryableNetErr(e)) return true; // 连接超时/重置/拒连/域名解析（cause code）
  if ((e?.name || '').includes('Timeout') || /timeout|timed? ?out/i.test(e?.message || '')) return true; // 请求超时
  if (/aborted|AbortError/i.test(e?.name || '') || /aborted/i.test(e?.message || '')) return true; // 超时主动中止
  if (/网络连接模型网关失败|与模型网关|超时/.test(e?.message || '')) return true; // P5.19：friendlyNetError 中文文案兜底（连接超时/重置/拒连/域名解析）
  // P5.28：供应商 400 携带 JSON 解析类错误（Unterminated string / Expecting value 等）——实测为
  // 供应商流式侧瞬时 bug（长请求体/超长生成时偶发，同模型重试或换模型常可过），非本地配置问题：允许降级重试
  if (/返回\s+400|HTTP\s+400/i.test(e?.message || '') && /Unterminated|Expecting|JSON|parse|string/i.test(e?.message || '')) return true;
  const m = /返回\s+(\d{3})/.exec(e?.message || '') || /HTTP\s+(\d{3})/.exec(e?.message || '') || /status[:\s]+(\d{3})/i.exec(e?.message || '');
  if (m) { const s = +m[1]; return s === 429 || (s >= 500 && s <= 599); } // 429 限流 / 5xx 服务端故障
  return false; // 其余（鉴权 401/403、模型不存在 404、真参数 400 等）不降级
}

/** 带自动重试的 POST（默认 3 次尝试，退避 700ms/1400ms）。
 *  重试范围：① fetch 抛连接类错误；② 网关返回 502/503/504（上游瞬时故障）。
 *  4xx 等确定性错误不重试，直接返回由调用方按原有逻辑抛详细错误。
 *  LLMOps 硬超时（2026-10-31）：opts.hardTimeoutMs（默认 undefined 行为不变）为整次调用的
 *  总预算（含自动重试）——signal 在循环外创建，超时后重试因 signal 已 aborted 立即失败，
 *  不会空耗预算。动机：供应商网关 connect timeout 挂起生产上传 90s+（2026-10-31 实测）。
 *  与调用方 signal（如停止生成）合并而非覆盖；仅非流式链路（chatOnce）注入该值，
 *  流式对话不传则与旧版行为完全一致（长回答不会被截断）。 */
async function postModel(url, headers, body, { tries = 3, signal, hardTimeoutMs } = {}) {
  const hardMs = Number.isFinite(+hardTimeoutMs) && +hardTimeoutMs > 0 ? +hardTimeoutMs : 0;
  const timeoutSignal = hardMs ? AbortSignal.timeout(hardMs) : null;
  const fetchSignal = mergeAbortSignals([signal, timeoutSignal]);
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), ...(fetchSignal ? { signal: fetchSignal } : {}) });
      if ([502, 503, 504].includes(res.status) && i < tries) {
        await res.text().catch(() => ''); // 排空响应体，保持连接可复用
        lastErr = new Error(`模型供应商返回 ${res.status}`);
        await sleep(700 * i);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (timeoutSignal?.aborted) {
        // LLMOps 硬超时触发：不重试直接抛（保留 TimeoutError name——isFailoverWorthy 已判定
        // Timeout 走故障转移，failover 到下一候选时重新计时）。注明 env 覆盖方式便于运维调整。
        const err = new Error(`模型请求整体超时（${(hardMs / 1000).toFixed(1)}s，可用环境变量 LLM_TIMEOUT_MS 调整）`);
        err.name = 'TimeoutError';
        err.cause = e;
        throw err;
      }
      if (e?.name === 'AbortError' || e?.aborted) throw e; // P5.29 停止生成：调用方主动中止直接透传原错误（不重试、不包装，保住 name 标记供上层识别）
      if (i < tries && isRetryableNetErr(e)) {
        await sleep(700 * i);
        continue;
      }
      // 不可重试（如主动中止/超时）或网络类错误重试耗尽 → 友好文案抛出
      const retried = i > 1 ? `（已自动重试 ${i - 1} 次仍失败）` : '';
      const err = new Error(`${friendlyNetError(e)}${retried}，请稍后重试`);
      throw err;
    }
  }
  throw new Error(`${lastErr?.message || '网关持续返回 5xx'}（已自动重试 ${tries - 1} 次仍失败，模型服务暂不可用）`);
}

/** P5.34（审查 Y5）：多轮工具循环的 usage 累计——此前每轮覆盖只保留末轮，前几轮 prompt/completion
 *  token 被丢弃（scheduler 记账与 calcCost 偏少）。口径：求和 = 用户实际计费口径（每轮全价，
 *  后续轮的 prompt 含累积上下文也照计）。null/缺字段安全处理，单轮调用行为不变 */
function accumulateUsage(acc, u) {
  if (!u || typeof u !== 'object') return acc;
  const num = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
  if (!acc) return { prompt_tokens: num(u.prompt_tokens), completion_tokens: num(u.completion_tokens), total_tokens: num(u.total_tokens) };
  return {
    prompt_tokens: (acc.prompt_tokens || 0) + num(u.prompt_tokens),
    completion_tokens: (acc.completion_tokens || 0) + num(u.completion_tokens),
    total_tokens: (acc.total_tokens || 0) + num(u.total_tokens),
  };
}

/** 真实调用：OpenAI 兼容 SSE。yield {delta} 或 {toolCall}；返回 usage
 *  支持 function calling 循环：opts.tools（OpenAI 格式）+ opts.executeTool(name, argsJson) → string
 *  P1：partial 标记 —— 错误发生时是否已对外输出过内容（决定上层能否换模型重试，避免重复输出）
 */
async function* callReal(provider, messages, opts = {}) {
  const url = provider.base_url.replace(/\/+$/, '') + '/chat/completions';
  const useTools = Array.isArray(opts.tools) && opts.tools.length > 0 && typeof opts.executeTool === 'function';
  let history = [...messages];
  let usage = null;
  let full = '';
  let emitted = false; // 是否已 yield 过事件（一旦 true，失败后上层不可换模型重试）
  let dsmlPending = ''; // P5.28：跨 chunk 的未闭合 DSML 标记片段（拼齐后统一剥离）

  const MAX_ROUNDS = 4;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const isFinalRound = round === MAX_ROUNDS - 1;
    const body = {
      model: opts.model,
      messages: history,
      temperature: opts.temperature ?? 0.7,
      ...(opts.top_p != null ? { top_p: opts.top_p } : {}), // 生成多样性参数（SinguX 式模型设置）
      // P5.28 关键修复：工具调用轮的 max_tokens 下限提到 8192——此前 1024 会把超长 tool_calls arguments
      // （如 export_word/run_code 携带整篇文档或代码）在生成中途拦腰截断，拼出残缺 JSON 回填下一轮请求，
      // 供应商解析 arguments 报 400 Unterminated string（三模型同症状实锤）。纯文本轮沿用原值。
      max_tokens: Math.max(opts.max_reply || 1024, useTools && !isFinalRound ? 8192 : 0),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (useTools && !isFinalRound) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    // 自动重试容错：连接超时/重置/网关 5xx 自动重试（实测瞬时故障重试即恢复）
    // LLMOps：透传 hardTimeoutMs（仅 chatOnce 注入，流式为 undefined 行为不变）+ 调用方 signal（合并而非覆盖）
    let res;
    try {
      res = await postModel(url, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.api_key }, body, { signal: opts.signal, hardTimeoutMs: opts.hardTimeoutMs });
    } catch (e) {
      e.partial = emitted; // 响应头阶段失败：未输出过内容则上层可换模型降级
      throw e;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      const err = new Error(`模型供应商返回 ${res.status}: ${text.slice(0, 200)}`);
      err.partial = emitted;
      throw err;
    }
    const decoder = new TextDecoder();
    let buf = '';
    let roundContent = '';
    const toolAcc = new Map(); // index → {id, name, args}
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta;
            // P5.28：部分模型在长 max_tokens 预算下会把工具调用语法当正文输出（DSML/ChatML 特殊标记泄漏）——
            // 输出侧即时剥离（用户不可见残缺语法），未完成的标记片段留待下一 chunk 拼齐后判断
            if (d?.content) {
              // P5.28：部分模型在长输出预算下把工具调用语法当正文吐出（DSML/ChatML 标记泄漏到 content）——
              // 输出侧剥离（用户不可见残缺语法）；跨 chunk 未闭合片段用 pending 拼齐后统一处理
              let piece = d.content;
              if (piece.includes('\uFF5C') || piece.includes('<|')) {
                if (dsmlPending) { piece = dsmlPending + piece; dsmlPending = ''; }
                const OPEN = new RegExp('<[\uFF5C|]{1,2}(?:DSML|tool_calls|invoke|parameter|assistant|/tool_calls|/invoke|/parameter|/assistant)[\uFF5C|]{0,2}[^>\n]{0,80}?>?', 'g');
                const TAIL = new RegExp('<[\uFF5C|]{1,2}(?:DSML|tool_calls|invoke|parameter|assistant)[^>\n]{0,200}$');
                const m = TAIL.exec(piece);
                if (m) { dsmlPending = m[0]; piece = piece.slice(0, m.index); }
                piece = piece.replace(OPEN, '').replace(new RegExp('<\|[^>\n]{0,120}?>', 'g'), '');
              }
              if (piece) { roundContent += piece; full += piece; emitted = true; yield { delta: piece }; }
            }
            // P5.19 顺带修复：思考型模型（glm5.2 等）SSE 把过程内容放 reasoning_content / reasoning 字段——
            // 此前只读 content 导致这类模型 full 恒为空（流式显示与变量输出全空）。思考内容并入 full（下游可引用），
            // 但不加 emitted 标记（思考不算"已对外输出正文"，故障转移语义不受影响）。
            else if (d?.reasoning_content || d?.reasoning) {
              const rc = String(d.reasoning_content || d.reasoning || '');
              full += rc; yield { delta: rc };
            }
            if (Array.isArray(d?.tool_calls)) {
              for (const tc of d.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolAcc.has(idx)) toolAcc.set(idx, { id: '', name: '', args: '' });
                const acc = toolAcc.get(idx);
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
            if (j.usage) usage = accumulateUsage(usage, j.usage); // P5.34：多轮累计（原覆盖只留末轮）
          } catch { /* 忽略不完整片段 */ }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError' || e?.aborted) { e.partial = emitted; throw e; } // P5.29 停止生成：透传中止错误（partial=中断前已输出内容保留）
      // 流中断（此阶段已可能输出部分内容，不能安全重试）：转友好文案，已输出部分保留
      const err = new Error(`生成中断：${friendlyNetError(e)}`);
      err.partial = emitted;
      throw err;
    }

    // 无工具调用 → 本轮流即最终答案
    if (!useTools || toolAcc.size === 0 || isFinalRound) {
      return { usage, full, mode: 'real', model: opts.model, provider: provider.name };
    }

    // 有工具调用 → 执行并回填，进入下一轮
    const toolCalls = [...toolAcc.values()].filter(t => t.name);
    history.push({ role: 'assistant', content: roundContent || null, tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })) });
    for (const tc of toolCalls) {
      let result = '';
      try { result = await opts.executeTool(tc.name, tc.args || '{}'); } catch (e) { result = '工具执行失败：' + e.message; }
      history.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 4000) });
      emitted = true;
      yield { toolCall: { name: tc.name, args: tc.args, result: String(result).slice(0, 500) } };
    }
  }
  return { usage, full, mode: 'real', provider: provider.name };
}

/** 模拟回复：确定性规则生成，按小块流式吐出 */
function mockAnswer(messages, opts = {}) {
  const userMsg = [...messages].reverse().find(m => m.role === 'user');
  // AI-11（2026-11-23）多模态兼容：user 消息 content 可能为数组（[{type:'text'},{type:'image_url'}]，
  // 见 visionDescribe）——拼接其中 text 片段；原 (content||'').trim() 对数组抛 TypeError，
  // 是图搜图/图片理解在演示模式下的实测崩溃点（防御式：任何未来多模态消息走 mock 不再崩）
  const raw = userMsg?.content;
  const q = (Array.isArray(raw)
    ? raw.filter(p => p && p.type === 'text').map(p => p.text || '').join(' ')
    : String(raw ?? '')).trim();
  const kbCtx = opts.kbContext || [];
  const agentName = opts.agentName || '';

  if (kbCtx.length) {
    // 知识库命中：拼接切片作答（演示检索增强）
    const body = kbCtx.map((c, i) => `${i + 1}. ${c}`).join('\n');
    return `根据知识库检索到的内容，为您解答如下：\n\n${body}\n\n以上内容来自${agentName ? '「' + agentName + '」' : '平台'}关联知识库的 ${kbCtx.length} 个相关片段。如需了解更多细节，欢迎继续提问。`;
  }
  if (/翻译|translate/i.test(q)) {
    return `以下是为您完成的翻译：\n\n原文：${q}\n\n译文：（演示模式）Translation service is running in demo mode. Configure a model provider API Key in 后台「模型接入」to enable real model output.`;
  }
  if (/(你好|您好|hi|hello|在吗)/i.test(q)) {
    return `您好！我是${agentName ? '「' + agentName + '」' : 'MetaForge AI 助手'}。当前处于内置演示模式（未配置真实模型 Key）。我可以协助您：\n\n1. 解答 MetaForge 平台功能相关问题\n2. 进行文本创作、翻译与整理\n3. 基于知识库内容做检索问答\n\n请问有什么可以帮您？`;
  }
  return `收到您的指令：「${q.slice(0, 120)}」\n\n（当前为内置演示模式回复：进入管理后台 → 模型接入，为默认供应商填写 API Key 并保存后，此处将调用真实大模型输出流式回答。当前回复链路已完整验证：敏感词检测 → 知识库检索 → 模型调用 → 流式输出 → 用量统计。）`;
}

/** 模拟流式 generator */
async function* callMock(messages, opts = {}) {
  const text = mockAnswer(messages, opts);
  const pieces = text.match(/[\s\S]{1,6}/g) || [];
  for (const p of pieces) {
    await new Promise(r => setTimeout(r, 18));
    yield { delta: p };
  }
  return { usage: { total_tokens: Math.ceil(text.length * 0.6) }, full: text, mode: 'mock' };
}

// 非文本模型识别（TTS/图片/视频/向量等不能用于 chat/completions）
// 注意：minimax h3 / Ref2VA 为文生视频模型（t2va），名称本身不含 video 字样，需显式匹配
// 注意：VL 系列是多模态对话模型（Qwen-VL 纯文本对话可用），不在黑名单内
const NON_TEXT_MODEL_RE = /tts|asr|speech|whisper|embedding|rerank|image|video|audio|voice|ocr|t2v|a2v|realtime|sensevoice|minimax[\s-]?h\d|ref2va/i;

/** 已配置供应商清单（默认优先，跨供应商路由用）。MT-12：传入 tenantId 时仅返回「平台基线(0) ∪ 本租户」*/
function getConfiguredProviders(tenantId) {
  const base = "SELECT * FROM providers WHERE configured=1 AND api_key != '' AND base_url != ''";
  if (Number.isFinite(Number(tenantId))) {
    return dal.q(`${base} AND (tenant_id=0 OR tenant_id=?) ORDER BY is_default DESC, id`, [Number(tenantId)]);
  }
  return dal.q(`${base} ORDER BY is_default DESC, id`);
}

function safeModels(p) {
  try { return JSON.parse(p.models || '[]'); } catch { return []; }
}

/** 候选模型列表（2026-10-20 P1 熔断降级；P3 增加用户自有供应商优先路由）：
 *  排序：⓪ 用户自有供应商（本人自带 Key 接入的模型源，仅精确匹配指定模型时参与——自带 Key 只为自己选的模型买单，不作全平台兜底）；
 *        ① 指定模型且拥有它的平台供应商（默认供应商优先）；② 各平台供应商的其他可用文本模型（默认优先）。
 *  过滤：非文本模型（TTS/图片/视频/向量）排除；熔断中的模型跳过——
 *  若过滤后为空（平台供应商全部熔断）则忽略熔断状态保底放行（宁可再试也不直接拒绝服务）。 */
function buildCandidates(model, opts = {}) {
  // MT-12：以请求租户（opts.tenantId 或由 opts.username 反查）限定可见供应商，防跨租户路由
  const _tid = opts.tenantId != null ? Number(opts.tenantId) : tenantOfUser(opts.username);
  const providers = getConfiguredProviders(_tid);
  const seen = new Set();
  const out = [];
  const push = (p, m) => {
    if (!m || NON_TEXT_MODEL_RE.test(m)) return;
    const k = p.id + ':' + m;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ p, model: m });
  };
  // ⓪ P3 用户自有供应商：虚拟 id 'u{n}'（与平台供应商的熔断 key 天然隔离，互不串扰）
  if (model && opts.username && !NON_TEXT_MODEL_RE.test(model)) {
    const ups = dal.q("SELECT id, name, base_url, api_key, models FROM user_providers WHERE username=? AND status=1 AND api_key != '' AND base_url != '' ORDER BY id", [opts.username]);
    for (const up of ups) {
      const p = { ...up, id: 'u' + up.id, name: (up.name || '自有模型') + '（我的）' };
      if (safeModels(up).includes(model) && !circuit.isOpen(p, model)) push(p, model);
    }
  }
  // ① 指定模型的归属供应商（providers 已按默认优先排序）；熔断中的跳过（由 ③ 保底兜住全熔断场景）
  if (model) {
    for (const p of providers) {
      if (safeModels(p).includes(model) && !circuit.isOpen(p, model)) push(p, model);
    }
  }
  // ② 各供应商的其他可用模型（跳过熔断中）
  for (const p of providers) {
    for (const m of safeModels(p)) {
      if (!circuit.isOpen(p, m)) push(p, m);
    }
  }
  // ③ 保底：平台供应商全部熔断时忽略熔断状态重算（用户自有 Key 不参与兜底，避免替平台流量买单）
  if (!out.length) {
    for (const p of providers) for (const m of safeModels(p)) push(p, m);
  }
  return out.slice(0, 5); // 最多尝试 5 个候选，避免极端情况下全网关遍历
}

/**
 * 统一入口（P1 候选降级版 + P5.19 节点级故障转移）。返回 generator；耗尽后得到 {usage, full, mode, model, provider}
 * 行为：候选列表逐个尝试；响应头阶段失败（未输出任何内容）→ 记熔断并自动降级下一候选；
 * 流中途断开（已输出部分内容）→ 不降级（避免重复输出），如实报错。
 * P5.19：opts.fallbackModels（LLM 节点配置的备用模型列表）插队到候选链最前——
 * 主模型挂了按用户指定顺序切备用（超时/429/5xx），而不是全网关随机兑底。
 */
function chat(messages, opts = {}) {
  async function* withFallback() {
    let model = opts.model;
    if (NON_TEXT_MODEL_RE.test(model || '')) model = undefined; // 非文本模型直接丢弃
    const candidates = buildCandidates(model, opts);
    // P5.19 节点级故障转移：备用模型按用户指定顺序排到主模型候选之后、全网关兜底之前。
    // 已存在于兜底段的备用模型要"前移"到指定位置（而非跳过）——否则顺序不受控，429 时可能先撞非备用模型。
    const fbList = (Array.isArray(opts.fallbackModels) ? opts.fallbackModels : [])
      .map(x => String(x || '').trim()).filter(x => x && !NON_TEXT_MODEL_RE.test(x) && x !== model);
    if (fbList.length && candidates.length) {
      const providers = getConfiguredProviders(opts.tenantId != null ? Number(opts.tenantId) : tenantOfUser(opts.username));
      // 先移除候选链中已存在的同名模型（全网关兜底段自然存在的），再按序插到主模型候选之后
      for (const fm of fbList) {
        const idx = candidates.findIndex(c => c.model === fm);
        if (idx >= 0) candidates.splice(idx, 1);
      }
      const mainEnd = model ? candidates.findIndex(c => c.model !== model) : 1; // 主模型各供应商候选之后（无指定模型则首位后）
      const insertPos = Math.max(1, mainEnd < 0 ? candidates.length : mainEnd);
      let added = 0;
      for (const fm of fbList) {
        for (const p of providers) {
          if (safeModels(p).includes(fm) && !candidates.some(c => c.p.id === p.id && c.model === fm)) {
            candidates.splice(insertPos + added, 0, { p, model: fm });
            added++;
            break; // 每个备用模型只插入一个归属供应商（与主模型同链路语义）
          }
        }
      }
    }
    if (!candidates.length) {
      return yield* callMock(messages, opts); // P5.10 修复：透传 callMock 的 return 值（此前无值 return 导致 chatOnce 拿到 undefined → full 丢失）
    }
    let lastErr = null;
    let fbUsed = null; // P5.19：实际启用的备用模型（成功时回报给上层日志/成本核算）
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      try {
        const result = yield* callReal(cand.p, messages, { ...opts, model: cand.model });
        circuit.recordSuccess(cand.p, cand.model);
        if (fbList.includes(cand.model)) fbUsed = cand.model;
        return fbUsed ? { ...result, fallback_used: fbUsed } : result;
      } catch (e) {
        lastErr = e;
        if (e?.name === 'AbortError' || e?.aborted) throw e; // P5.29 停止生成：用户中止——不降级换模型、不计熔断失败
        circuit.recordFail(cand.p, cand.model, e);
        if (e.partial) throw e; // 已输出过内容，换模型会重复输出
        // P5.19：非故障转移型错误（4xx 鉴权/参数类）直接抛——换备用模型无意义，报错更准
        if (candidates.length > 1 && !isFailoverWorthy(e) && i < candidates.length - 1) {
          throw Object.assign(new Error(`模型调用失败（${e.message}）——该错误非网络/限流/服务端故障，自动切备用模型意义不大，请检查模型配置`), { noFailover: true, cause: e });
        }
        const next = i + 1 < candidates.length;
        console.warn(`[llm] ${cand.model}@${cand.p.name} 调用失败${next ? `，自动降级到下一候选` : '（已无更多候选）'}：${String(e.message || '').slice(0, 120)}`);
      }
    }
    throw lastErr;
  }
  return withFallback();
}

/** 非流式一次性获取（TOC 提取/GraphRAG 抽取/关键词生成/评测/任务执行等）。
 *  LLMOps 硬超时（2026-10-31 计划 #10）：注入 opts.hardTimeoutMs，默认 120s、环境变量
 *  LLM_TIMEOUT_MS 可覆盖——供应商网关 connect timeout 挂起时（2026-10-31 生产实测把上传
 *  请求拖死 90s+）限时抛 TimeoutError 走故障转移，不再无限等待。
 *  仅此非流式入口注入；流式对话（chat.js）不经 chatOnce，长回答不受影响。 */
async function chatOnce(messages, opts = {}) {
  // 优先级：显式 opts.hardTimeoutMs（有限正数，如查询改写 8s）> 环境变量 LLM_TIMEOUT_MS > 默认 120s。
  // 现有调用方不传该值 → 行为与旧版完全一致（AI-01 引入，供 query-rewrite 限时，避免改写拖慢检索）
  const hardTimeoutMs = (Number.isFinite(+opts.hardTimeoutMs) && +opts.hardTimeoutMs > 0)
    ? +opts.hardTimeoutMs
    : (Number(process.env.LLM_TIMEOUT_MS) || 120000);
  const gen = chat(messages, { ...opts, hardTimeoutMs });
  let out = null;
  while (true) {
    const r = await gen.next();
    if (r.done) { out = r.value; break; }
  }
  return out; // { usage, full, mode }
}

/** U1-9：知识库图片理解——用多模态 VL 模型将图片描述为文本。
 *  @param {Buffer} imageBuf  原始图片二进制 Buffer
 *  @param {string}  modelName VL 模型名（如 'qwen-vl-max'，须已在 providers 中有此模型）
 *  @param {string}  [prompt]  描述指令（缺省用默认万用描述提示词）
 *  @returns { {ok:true, text:string} | {ok:false, msg:string} } 返回描述文本或错误信息
 */
async function visionDescribe(imageBuf, modelName, prompt) {
  if (!imageBuf || !modelName) return { ok: false, msg: 'visionDescribe：参数缺失（buf 与 modelName 必填）' };
  try {
    // 图片 → base64 data URI
    let imgBase64 = imageBuf.toString('base64');
    // 降采样太大的 base64（> 3MB 原始图片做缩减避免网关超时）——按比例缩到长边 1024
    if (imageBuf.length > 500 * 1024) {
      try {
        // 用内置 imgResize（极简 HTTP 无依赖方案：不做 libvips/Sharp，只缩 metadata 太复杂，
        // 这里直接截取风险较小——图片太大才截base64前面的部分，对 JPEG/PNG 开头头部影响有限
        // 更稳妥的做法：告知用户图片太大，让 LLM 自行处理大图。先保持原样，后续可加 sharp 优化
        console.log(`[visionDescribe] 图片较大(${(imageBuf.length / 1024).toFixed(0)}KB)，直接传入；模型侧会降采样处理`);
      } catch { /* 降采样不是必需的 */ }
    }
    // 多模态消息结构：支持 content 数组 [{type:'text',text:'...'},{type:'image_url',image_url:{url:'data:...'}}]
    const sys = prompt || '请用简短的文字描述这张图片的主要内容和关键信息。如果图片中有文字，请一并提取。';
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: '请描述这张图片：' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imgBase64}` } },
      ] },
    ];
    const result = await chatOnce(messages, { model: modelName, llmModel: modelName });
    if (result && result.full) {
      const text = String(result.full).trim();
      if (text) return { ok: true, text };
    }
    return { ok: false, msg: '模型返回为空' };
  } catch (e) {
    return { ok: false, msg: `视觉理解模型调用失败：${e.message}` };
  }
}

module.exports = { chat, chatOnce, visionDescribe, getDefaultProvider, getConfiguredProviders, buildCandidates, postModel, friendlyNetError, isFailoverWorthy, accumulateUsage, tenantOfUser };
