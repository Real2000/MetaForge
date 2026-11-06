/**
 * 画布工作流 DAG Runner（2026-10-22 P5.1 重写；P5.2 三节点/条件升级/结构化输出增强）
 *
 * 设计（用户规范）：
 * - runWorkflow(agent, inputVars, context) 签名；拓扑排序（Kahn）定执行顺序
 * - NODE_EXECUTORS 按 type 分发；工具节点直接复用 tools.js runTool
 * - 节点失败默认中断（带节点定位）；data.onError='continue' 可跳过
 * - results（nodeId→输出变量表）+ logs（节点执行日志）
 * - 变量引用 {{#nodeId.variableName#}}；迭代子流程内额外支持 {{item}}/{{index}} 短引用
 *
 * P5.2 新增（用户三条建议）：
 * - code 节点：node:vm 沙箱跑 JS 函数体（超时保护），输入变量注入，return 值成输出
 * - iteration 节点：输入数组逐条执行子流程（data.subflow 完整子图，递归 runGraph），输出 results 数组
 * - assign 赋值器：set/append/clear 操作，流程中间修改变量
 * - if-else 操作符 12 种：equals/not_equals/contains/not_contains/starts_with/gt/gte/lt/lte/is_empty/not_empty/regex（JSON 条件描述+递归求值）
 * - llm：结构化输出（output_schema 注入指令+解析字段成输出变量）、上下文设置（context.use_history 携带会话历史）
 */
const vm = require('node:vm');
const { db } = require('../db');
const { chat, chatOnce } = require('./llm');
const { runTool, buildTools, loadMcpTools, toolRiskOf } = require('./tools'); // P5.34（Y3）：顶层解构——依赖图无环（tools 不回指 workflow），原延迟 require 包装属冗余间接层
const { renderEnv, maskSecrets } = require('./secrets');
const { calcCost } = require('./cost');
const { fileToRich, fileToText } = require('./fileparse'); // P5.14 文件一等变量
const { mask, maskPII } = require('./security');

const MAX_STEPS = 120;        // 防环保护
const CODE_TIMEOUT_MS = 3000; // 代码节点沙箱超时默认
const CODE_MAX_TIMEOUT = 5000;// 代码节点硬上限 5s
const ITER_MAX_ITEMS = 50;    // 迭代条目上限（防失控）
const NODE_DEFAULT_TIMEOUT = 60000;   // P5.5 节点默认超时 60s
const LLM_DEFAULT_TIMEOUT = 120000;   // P5.5 LLM 节点默认 120s
const MAX_RETRY = 3;                  // P5.5 失败重试上限（指数退避）

// P5.5 代码危险模式静态扫描（沙箱外第一道防线：命中直接拒绝执行）
const CODE_FORBIDDEN_RE = /\b(?:require\s*\(|\bprocess\b|child_process|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(|\bWebAssembly\b|\.constructor\s*[.(])/;

/** P5.5 沙箱加固：静态扫描 + 无原型 sandbox + 资源限制（128MB）+ 超时 */
function runCodeSandbox(code, inputs, timeoutMs) {
  if (CODE_FORBIDDEN_RE.test(code)) {
    throw new Error('代码含禁止的系统 API（require/process/eval/Function 等），已拒绝执行');
  }
  const t = Math.max(500, Math.min(timeoutMs || CODE_TIMEOUT_MS, CODE_MAX_TIMEOUT));
  const sandbox = Object.assign(Object.create(null), {
    ...inputs,
    JSON: Object.freeze(JSON), Math: Object.freeze(Math), Date: Object.freeze(Date),
    Number: Object.freeze(Number), String: Object.freeze(String), Boolean: Object.freeze(Boolean),
    Array: Object.freeze(Array), Object: Object.freeze(Object), RegExp: Object.freeze(RegExp),
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    console: Object.freeze({ log() { }, error() { }, warn() { } }),
  });
  const script = new vm.Script('(function(){\n' + code + '\n})()');
  return script.runInNewContext(sandbox, {
    timeout: t,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
  });
}

/** P5.5 节点级超时：Promise.race（超时后流程可控，底层请求自然中止） */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`节点超时（${ms}ms 上限）${label ? '：' + label : ''}`)), ms)),
  ]);
}
/** P5.5 节点级重试：指数退避 700ms*2^n，最多 data.retry 次（≤3）；返回 {out, retries} */
async function withRetry(executorFn, retryCount) {
  const tries = Math.max(0, Math.min(retryCount || 0, MAX_RETRY));
  let lastErr = null;
  for (let i = 0; i <= tries; i++) {
    try { return { out: await executorFn(), retries: i }; }
    catch (e) { lastErr = e; if (i < tries) await new Promise(r => setTimeout(r, 700 * Math.pow(2, i))); }
  }
  throw Object.assign(lastErr, { retries: tries });
}

/** P5.14 文件一等变量：值 → LLM 可读文本（富对象 → [📄 文件 #id：名] + 全文；数组逐个拼接） */
function fileValToText(val) {
  if (val && typeof val === 'object' && !Array.isArray(val) && val.__file) return fileToText(val);
  if (Array.isArray(val) && val.length && val.some(x => x && x.__file)) return val.filter(x => x && x.__file).map(fileToText).join('\n\n');
  return null;
}

/** P5.14 结构化传值：纯引用匹配（整串恰为一个 {{#node.var#}}）——tool args 等按值传递场景的入口 */
const REF_ONLY = /^\{\{\s*#\s*([\w\u4e00-\u9fa5.-]+)\s*#\s*\}\}$/;
/** P5.14 结构化传值：按引用名取原始值（不做文本化）——results 优先，start 变量回退 inputVars；无效引用返回 undefined */
function resolveRefRaw(ref, results, inputVars) {
  const dot = ref.indexOf('.');
  if (dot < 0) return undefined;
  const nid = ref.slice(0, dot), varName = ref.slice(dot + 1);
  if (results[nid] && results[nid][varName] !== undefined) return results[nid][varName];
  if (nid === 'start' && inputVars && inputVars[varName] !== undefined) return inputVars[varName];
  return undefined;
}

/** 渲染模板：{{#node.var#}} → 实际值；{{env.X}} 密钥运行时注入；未定义引用保留原样；V1 兼容 {{input}}/{{vars.x}}；子流程 {{item}}/{{index}} */
function render(tpl, results, inputVars) {
  // P5.12 修复：引用正则支持中文节点 id/变量名（[\w.-] 不含中文——中文 id 的引用此前渲染与校验均被跳过）
  return renderEnv(String(tpl ?? '')).replace(/\{\{\s*#\s*([\w\u4e00-\u9fa5.-]+)\s*#\s*\}\}/g, (m, ref) => {
    const dot = ref.indexOf('.');
    if (dot < 0) return m;
    const nid = ref.slice(0, dot), varName = ref.slice(dot + 1);
    const val = results[nid]?.[varName];
    if (val === undefined && nid === 'start' && inputVars && inputVars[varName] !== undefined) {
      const fv = fileValToText(inputVars[varName]); // P5.14：start 输入侧的 file 富对象（preset 回灌路径）
      if (fv != null) return fv;
      return String(inputVars[varName]);
    }
    if (val !== undefined) {
      const fv = fileValToText(val); // P5.14：file 富对象 → 文本化注入（LLM/code/工具同语义）
      if (fv != null) return fv;
    }
    return val === undefined ? m : String(val);
  }).replace(/\{\{\s*(input|item|index|vars\.[\w]+)\s*\}\}/g, (m, k) => {
    if (k === 'input') return inputVars?.input ?? m;
    if (k === 'item') return inputVars?.item ?? m;
    if (k === 'index') return inputVars?.index ?? m;
    const vn = k.slice(5);
    return inputVars?.[vn] !== undefined ? String(inputVars[vn]) : m;
  });
}

/** 拓扑排序（Kahn 算法）：返回执行顺序数组；有环抛错 */
function topologicalSort(nodes, edges) {
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const outs = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    indeg.set(e.target, indeg.get(e.target) + 1);
    outs.get(e.source).push(e);
  }
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of outs.get(id)) {
      indeg.set(e.target, indeg.get(e.target) - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (order.length !== nodes.length) throw new Error('工作流存在环路，无法拓扑排序');
  return order;
}

/**
 * if-else 条件评估（P1 升级：12 种操作符，JSON 条件描述+递归求值）
 * cases 顺序判定 = IF/ELIF/ELSE 语义：第一条命中返回其 label；全不命中走 isFallback 兜底
 */
function evaluateConditions(cases, resolvedVars) {
  for (const c of cases || []) {
    if (c.isFallback) continue; // 兜底分支只在全不命中时生效
    const conds = c.conditions || [];
    const logical = (c.logical || 'AND').toUpperCase();
    const hits = conds.map(cd => evalCondition(cd, resolvedVars));
    const hit = logical === 'OR' ? hits.some(Boolean) : hits.every(Boolean);
    if (hit) return c.label;
  }
  const fb = (cases || []).find(c => c.isFallback);
  if (fb) return fb.label;
  throw new Error('if-else 无命中分支且未配置兜底（否则）');
}

/** 单条件求值：variable（点分引用或裸名）+ 操作符 + 值 */
function evalCondition(cd, resolvedVars) {
  const s = String(resolvedVars[cd.variable] ?? '');
  const v = String(cd.value ?? '');
  switch (cd.type) {
    case 'equals': return s === v;
    case 'not_equals': return s !== v;
    case 'contains': return s.includes(v);
    case 'not_contains': return !s.includes(v);
    case 'starts_with': return s.startsWith(v);
    case 'gt': { const a = Number(s), b = Number(v); return Number.isFinite(a) && Number.isFinite(b) && a > b; }
    case 'gte': { const a = Number(s), b = Number(v); return Number.isFinite(a) && Number.isFinite(b) && a >= b; }
    case 'lt': { const a = Number(s), b = Number(v); return Number.isFinite(a) && Number.isFinite(b) && a < b; }
    case 'lte': { const a = Number(s), b = Number(v); return Number.isFinite(a) && Number.isFinite(b) && a <= b; }
    case 'is_empty': return s.trim() === '';
    case 'not_empty': return s.trim() !== '';
    case 'regex': { try { return new RegExp(v).test(s); } catch { return false; } }
    default: return false;
  }
}

/** 计算激活节点集：从 start 沿命中分支传导（if-else/classifier 只走 sourceHandle=命中分支的出边） */
function computeActive(nodes, edges, branchOf, errorOf) {
  const active = new Set();
  const stack = [nodes.find(n => n.type === 'start')?.id].filter(Boolean);
  while (stack.length) {
    const id = stack.pop();
    if (active.has(id)) continue;
    active.add(id);
    const src = nodes.find(n => n.id === id);
    const inError = errorOf && errorOf.has(id); // P5.11：该节点已失败且画了 __error__ 异常出边 → 激活切换到异常分支
    for (const e of edges.filter(x => x.source === id)) {
      const handle = e.sourceHandle || 'out';
      if (handle === '__error__') { if (!inError) continue; } // 异常边仅失败后激活
      else if (inError) continue;                              // 失败节点不再走正常出边
      const isBranchNode = src?.type === 'if-else' || src?.type === 'classifier'; // P5.6：分类器复用分支机制
      if (isBranchNode && handle !== (branchOf[id] || '')) continue;
      if (!active.has(e.target)) stack.push(e.target);
    }
  }
  return active;
}

/** P5.6 问题分类器：构建强约束分类提示词（只输出类别名） */
function buildClassifyPrompt(categories, question, instruction) {
  return `你是一个问题分类器。请把用户输入分到下面类别中的恰好一个，只输出类别名本身，不要任何其他文字、标点、序号或解释。

类别列表：
${categories.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${instruction ? `\n分类补充说明：${instruction}\n` : ''}
用户输入：${question}`;
}

/** P5.6 问题分类器：解析模型返回（精确命中 > 包含命中；均未命中返回 null → 走 default 分支） */
function parseClassifyReply(reply, categories) {
  const s = String(reply || '').trim().replace(/^["'「『]|["'」』]$/g, '').replace(/^[\d.、\-\s]+/, '');
  if (categories.includes(s)) return s;
  for (const c of categories) if (s.includes(c)) return c;
  return null;
}

/** P5.6 工具结果扁平化：可 JSON.parse 为对象时顶层键成输出变量（对象/数组 JSON 化，原始类型保留） */
function flattenToolResult(resultStr) {
  const out = {};
  let obj = null;
  try { const p = JSON.parse(String(resultStr)); if (p && typeof p === 'object' && !Array.isArray(p)) obj = p; } catch { }
  if (obj) for (const [k, v] of Object.entries(obj).slice(0, 30)) {
    if (k === 'result') continue; // 防与整体 result 键冲突
    out[k] = (v === null || typeof v === 'string') ? (v ?? '')
      : (typeof v === 'number' || typeof v === 'boolean') ? v : JSON.stringify(v);
  }
  return out;
}

/** 单节点输入解析：data 内模板字段解析为实际值 */
function resolveInputs(node, results, inputVars) {
  const r = (tpl) => render(tpl, results, inputVars);
  const d = node.data || {};
  switch (node.type) {
    case 'start': {
      const out = { input: inputVars.input ?? '' };
      for (const v of d.variables || []) out[v.name] = inputVars[v.name] ?? v.default ?? '';
      return out;
    }
    case 'llm': return { system_prompt: r(d.system_prompt || ''), prompt: r(d.prompt || '') };
    case 'tool': {
      // P5.14 文件一等变量·结构化传值：args 先解析为 JSON 模板对象，再逐字段求值——
      // ① 字段值为纯引用 {{#node.var#}} → 原始值直达（file 富对象/数组整对象传递给工具；文本/数字原样）
      //   （旧实现整体 render 后再 parse：文件全文/长文本含引号换行会破坏 JSON 结构，工具只能收到 {_raw} 垃圾）
      // ② 混合模板（引用与其他文字拼接）→ render 文本化，保持既有语义
      // ③ 模板本身非合法 JSON 对象 → 回退旧渲染语义（存量兼容）
      let tplObj = null;
      const rawTpl = String(d.args || '{}').trim();
      if (rawTpl.startsWith('{')) {
        try { const p = JSON.parse(rawTpl); if (p && typeof p === 'object' && !Array.isArray(p)) tplObj = p; } catch { tplObj = null; }
      }
      if (tplObj) {
        const args = {};
        for (const [k, v] of Object.entries(tplObj)) {
          if (typeof v !== 'string') { args[k] = v; continue; }
          const m = REF_ONLY.exec(v.trim());
          if (m) {
            const rawVal = resolveRefRaw(m[1], results, inputVars);
            if (rawVal !== undefined) { args[k] = rawVal; continue; } // 富对象/数字/字符串原始值直达
          }
          args[k] = r(v);
        }
        return { args };
      }
      let args = {};
      const raw = r(d.args || '{}');
      try { args = JSON.parse(raw); } catch { args = { _raw: raw }; }
      return { args };
    }
    case 'agent': return { input: r(d.input || '{{#start.input#}}') };
    case 'code': {
      // 输入变量映射：data.inputs = { 变量名: 模板引用 }，全部解析后注入沙箱
      const inputs = {};
      let map = d.inputs || {};
      if (typeof map === 'string') { try { map = JSON.parse(map); } catch { map = {}; } }
      for (const [k, tpl] of Object.entries(map)) inputs[k] = r(String(tpl));
      return { inputs };
    }
    case 'iteration': {
      // 输入数组：模板解析 → JSON.parse 数组 / 逗号换行分拆
      let arr = [];
      const raw = r(d.input || '[]');
      try {
        const p = JSON.parse(raw);
        arr = Array.isArray(p) ? p : [p];
      } catch {
        arr = String(raw).split(/\n+/).map(x => x.trim()).filter(Boolean);
        if (arr.length <= 1 && String(raw).includes(',')) arr = String(raw).split(',').map(x => x.trim()).filter(Boolean);
      }
      return { items: arr };
    }
    case 'assign': {
      const assignments = (d.assignments || []).map(a => ({
        variable: a.variable, operator: a.operator || 'set', value: a.operator === 'clear' ? '' : r(a.value ?? ''),
      }));
      // P5.7 会话变量基值：session.名称 的 append 需基于当前持久值（start 输出中已注入）累积
      const sessBase = {};
      for (const a of d.assignments || []) {
        const m = /^session\.([\w-]+)$/.exec(String(a.variable || ''));
        if (m) sessBase[m[1]] = results.start?.[m[1]] ?? '';
      }
      return { assignments, sessBase };
    }
    case 'answer': return { text: r(d.text || '') }; // P5.6 直接回复（Chatflow）
    case 'classifier': return { question: r(d.question || '{{#start.input#}}'), instruction: String(d.instruction || '') }; // P5.6 问题分类器
    case 'aggregator': return { sources: (d.sources || []).map(s => r(String(s?.variable ?? ''))) }; // P5.6 变量聚合器
    case 'answer': return { text: r(d.text || '') }; // P5.6 直接回复（Chatflow）
    case 'classifier': return { question: r(d.question || '{{#start.input#}}'), instruction: String(d.instruction || '') }; // P5.6 问题分类器
    case 'aggregator': return { sources: (d.sources || []).map(s => r(String(s?.variable ?? ''))) }; // P5.6 变量聚合器
    case 'if-else': {
      const vars = {};
      for (const c of d.cases || []) for (const cd of c.conditions || []) {
        const key = cd.variable || 'input';
        if (key.includes('.')) {
          const rendered = render('{{#' + key + '#}}', results, inputVars);
          vars[key] = /^\{\{.*\}\}$/.test(rendered) ? '' : rendered;
        } else {
          vars[key] = inputVars[key] ?? '';
        }
      }
      return vars;
    }
    case 'end': return { outputs: (d.outputs || []).map(o => ({ variable: o.variable, value: r(o.value) })) };
    default: return {};
  }
}

/** llm 消息组装（纯函数，可测）：system + 历史（Chatflow 默认携带，Workflow opt-in）+ user + 结构化输出指令 */
function buildLlmMessages(d, inputs, ctx) {
  const messages = [];
  if (inputs.system_prompt) messages.push({ role: 'system', content: inputs.system_prompt });
  // P2 上下文设置：携带对话历史（Chatflow 式；运行测试无历史则忽略）
  // P5.6：Chatflow 模式下默认携带历史（Workflow 保持 opt-in）
  const useHistory = d.context?.use_history !== undefined ? !!d.context.use_history : ctx.flowType === 'chatflow';
  if (useHistory && Array.isArray(ctx.history) && ctx.history.length) {
    const rounds = Math.max(1, Math.min(d.context?.rounds ?? 3, 20));
    messages.push(...ctx.history.slice(-rounds * 2));
  }
  messages.push({ role: 'user', content: inputs.prompt || '（空提示词）' });
  let schemaObj = null;
  if (d.output_schema) {
    try { schemaObj = typeof d.output_schema === 'string' ? JSON.parse(d.output_schema) : d.output_schema; } catch { schemaObj = null; }
    if (schemaObj) {
      messages[messages.length - 1].content += '\n\n【输出要求】请严格输出符合以下 JSON Schema 的 JSON 对象（不要 markdown 代码块标记、不要任何多余文字）：\n' + JSON.stringify(schemaObj);
    }
  }
  return { messages, schemaObj };
}

/** P5.14 文件一等变量：把入参的 fileId（数字/数组/{file_id}）解析为富对象（查 wf_files；不存在报错） */
async function resolveFileVar(raw, type, varName) {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) return '';
  const ids = type === 'array[file]'
    ? (Array.isArray(raw) ? raw.map(x => typeof x === 'object' && x ? x.file_id : x) : [raw]).map(Number).filter(x => Number.isFinite(x))
    : [typeof raw === 'object' && raw ? raw.file_id : raw].map(Number).filter(x => Number.isFinite(x));
  if (!ids.length) return '';
  const get = db.prepare('SELECT * FROM wf_files WHERE id=?');
  const rich = [];
  for (const fid of ids) {
    const row = get.get(fid);
    if (!row) throw new Error(`文件变量「${varName}」引用的文件不存在（id=${fid}，可能已被清理）`);
    rich.push(fileToRich(row));
  }
  return type === 'array[file]' ? rich : rich[0];
}

/** 节点执行器注册表 */
const NODE_EXECUTORS = {
  start: async (node, inputs, ctx) => {
    const out = { input: inputs.input };
    for (const v of node.data?.variables || []) {
      // P5.14 文件一等变量：file / array[file] 类型 → fileId 解析为富对象（name/text/url 随变量流转）
      if (v.type === 'file' || v.type === 'array[file]') {
        out[v.name] = await resolveFileVar(inputs[v.name], v.type, v.name);
      } else {
        out[v.name] = inputs[v.name] ?? '';
      }
    }
    // P5.7 会话变量（跨轮次持久）：持久值（ctx.sessionVars，聊天路由从 sessions.wf_vars 加载）优先，未持久过用默认值
    for (const v of node.data?.session_vars || []) {
      const name = String(v?.name || '').trim();
      if (!name) continue;
      out[name] = ctx?.sessionVars && ctx.sessionVars[name] !== undefined && ctx.sessionVars[name] !== null
        ? String(ctx.sessionVars[name]) : (v.default ?? '');
    }
    return out;
  },

  llm: async (node, inputs, ctx) => {
    const d = node.data || {};
    const { messages, schemaObj } = buildLlmMessages(d, inputs, ctx);
    // P5.10 流式调试：直接消费 chat() 生成器——delta 经 onEvent 发 nodeStream（40ms 合并节流防事件洪泛），
    // 结尾拿完整 full（变量输出/结构化解析语义不变）。chatOnce 仍保留给 classifier/agent 等短回复场景。
    const gen = chat(messages, {
      model: d.model || ctx.agent?.model || undefined,
      // P5.19 节点级故障转移：主模型超时/429/5xx 时按用户指定顺序切备用模型（节点级，不依赖全网关兑底）
      fallbackModels: Array.isArray(d.fallback_models) ? d.fallback_models.filter(x => x && x !== (d.model || '')) : undefined,
      temperature: d.temperature ?? ctx.agent?.temperature ?? 0.7,
      max_reply: Math.min(d.max_tokens || ctx.agent?.max_reply || 1024, 8192),
    });
    let full = '', usage = null, fallbackUsed = null;
    let buf = '', bufT0 = 0; // 节流缓冲：40ms 内的 delta 合并成一条事件
    const emitStream = (force) => {
      if (!buf) return;
      if (force || Date.now() - bufT0 >= 40) {
        try { ctx?.onEvent?.({ event: 'nodeStream', nodeId: node.id, title: node.data?.title || node.id, delta: buf }); } catch { }
        buf = ''; bufT0 = Date.now();
      }
    };
    while (true) {
      const r = await gen.next();
      if (r.done) { usage = r.value?.usage ?? null; full = r.value?.full || ''; fallbackUsed = r.value?.fallback_used || null; break; }
      if (r.value?.delta) { full += r.value.delta; buf += r.value.delta; emitStream(false); }
    }
    emitStream(true); // 尾包冲刷
    const text = full;
    // P5.13 成本可视化：tokens 细分（usage 为 OpenAI 格式；mock 只有 total）+ 成本随节点输出
    const tokensIn = usage?.prompt_tokens ?? null;
    const tokensOut = usage?.completion_tokens ?? null;
    const modelUsed = d.model || ctx.agent?.model || '';
    const cost = calcCost(modelUsed, tokensIn, tokensOut);
    const out = { text, tokens: usage?.total_tokens ?? null, tokens_in: tokensIn, tokens_out: tokensOut,
      tokens_detail: usage ? { in: tokensIn, out: tokensOut, total: usage.total_tokens } : null,
      cost_cny: +(cost.total.toFixed(6)), cost_priced: cost.priced, model_used: modelUsed,
      // P5.19：实际启用的备用模型（主模型正常时为 null；降级时下游可 {{#node.fallback_used#}} 感知）
      fallback_used: fallbackUsed };
    // 结构化输出：解析 JSON 字段并入输出变量（text 保留原文）
    if (schemaObj) {
      try {
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(out, parsed);
        else out.parsed = parsed;
      } catch { out._json_error = '结构化输出解析失败（模型未返回合法 JSON）'; }
    }
    return out;
  },

  tool: async (node, inputs, ctx) => {
    const toolId = node.data?.toolId || '';
    const r = await runTool(toolId, JSON.stringify(inputs.args || {}), {
      kbId: ctx.agent?.kb_id, mcpServers: ctx.agent?.mcp_servers,
    });
    const resultStr = String(r);
    // P5.6：结果可解析为 JSON 对象时顶层键扁平化成输出变量（{{#node.field#}} 直引；
    // 试运行发现的字段由前端写回 data._fields 供引用校验；与 code 节点扁平化语义一致）
    return { result: resultStr, ...flattenToolResult(resultStr) };
  },

  /** P0 子智能体节点；P5.8 #9：改走统一入口 runAgent——画布子智能体按其编排图执行（递归）并落 workflow_runs
   *  （parent_run_id 关联父 run），返回 childRunId 供前端下钻查看子画布执行轨迹 */
  agent: async (node, inputs, ctx) => {
    const child = db.prepare('SELECT * FROM agents WHERE id=?').get(node.data?.agentId);
    if (!child) throw new Error(`子智能体不存在（id=${node.data?.agentId}）`);
    const r = await runAgent(child, String(inputs.input ?? ''), {
      triggerType: 'agent_node',       // 子智能体节点调用来源
      parentRunId: ctx?._currentRunId || null, // #9 关联父 run（chat/manual/mcp/schedule 触发的当前 run）
      username: ctx?.username,
      history: ctx?.history,
    });
    const out = { reply: String(r?.text ?? '') };
    if (r?.runId) out.childRunId = r.runId;  // 下钻调试入口（canvas 模式子运行）
    if (r?.mode) out.childMode = r.mode;     // canvas=子画布轨迹可下钻 / form=单次 LLM 无轨迹
    // P5.13 成本可视化：子运行 usage 汇总透传（含子画布全部 LLM 节点累计）
    if (r?.usage) out.usage_summary = r.usage;
    return out;
  },

  /** P0 代码节点：沙箱执行（静态扫描+无原型+资源限制+超时；输出过敏感词/PII 过滤） */
  code: async (node, inputs) => {
    const d = node.data || {};
    const code = String(d.code || 'return null;');
    const out = runCodeSandbox(code, inputs.inputs, d.timeout);
    if (out === null || out === undefined) return { output: '' };
    // 输出安全过滤：敏感词 mask + PII 脱敏（P5.5）——仅作用于字符串；
    // 数字/布尔/null 等原始类型无脱敏必要，保留原始类型（扁平变量语义与 P5.2 一致）
    const safe = (s) => maskPII(mask(String(s)));
    if (typeof out === 'object' && !Array.isArray(out)) {
      const flat = {};
      for (const [k, v] of Object.entries(out)) flat[k] = Array.isArray(v) || (v && typeof v === 'object') ? safe(JSON.stringify(v)) : (typeof v === 'string' ? safe(v) : v);
      return { output: safe(JSON.stringify(out)), ...flat };
    }
    return { output: safe(Array.isArray(out) ? JSON.stringify(out) : String(out)) };
  },

  /** P5.6 直接回复（Chatflow）：模板渲染结果即时回传（主循环发 nodeReply 事件），流程继续往下跑 */
  answer: async (node, inputs) => ({ text: String(inputs.text ?? '') }),

  /** P5.6 问题分类器：LLM 单轮分类 → { class_name, branch }；分支机制同 if-else（出边 sourceHandle=类别名/default） */
  classifier: async (node, inputs, ctx) => {
    const d = node.data || {};
    const categories = (d.categories || []).map(c => String((c && c.name) || c || '').trim()).filter(Boolean).slice(0, 12);
    if (!categories.length) throw new Error('问题分类器未配置类别（属性面板至少添加一个类别）');
    const r = await chatOnce([
      { role: 'user', content: buildClassifyPrompt(categories, inputs.question, inputs.instruction) },
    ], {
      model: d.model || ctx.agent?.model || undefined,
      temperature: 0, max_reply: 64,
    });
    const hit = parseClassifyReply(r?.full || '', categories);
    return { class_name: hit || '', branch: hit || 'default' };
  },

  /** P5.6 变量聚合器：并行/条件分支汇合点——first=首个非空（未命中分支缺输出兼容）/ array=拼数组 */
  aggregator: async (node, inputs) => {
    const mode = node.data?.mode === 'array' ? 'array' : 'first';
    const raw = (inputs.sources || []);
    const vals = raw.filter(v => v !== undefined && v !== null && String(v) !== '');
    if (mode === 'array') {
      const arr = raw.map(v => (typeof v === 'string' ? v : JSON.stringify(v)));
      return { output: JSON.stringify(arr), array: arr };
    }
    return { output: vals.length ? vals[0] : '' };
  },

  /** P0 变量赋值器：set / append / clear；输出 = 各 assignment.variable 变量；session.前缀 = 会话变量（P5.7，append 基于持久值累积） */
  assign: async (node, inputs) => {
    const out = {};
    const sessBase = (variable) => {
      const m = /^session\.([\w-]+)$/.exec(String(variable || ''));
      return m ? (inputs.sessBase?.[m[1]] ?? '') : null; // null=非会话变量
    };
    for (const a of inputs.assignments || []) {
      if (!a.variable) continue;
      if (a.operator === 'clear') out[a.variable] = '';
      else if (a.operator === 'append') {
        const base = sessBase(a.variable);
        out[a.variable] = (base !== null ? base : (out[a.variable] ?? '')) + a.value;
      }
      else out[a.variable] = a.value;
    }
    return out;
  },

  /** P0 列表迭代：输入数组逐条执行子流程（data.subflow 子图递归 runGraph），汇总 results */
  iteration: async (node, inputs, ctx) => {
    const subflow = node.data?.subflow;
    if (!subflow || !Array.isArray(subflow.nodes) || !subflow.nodes.length) {
      throw new Error('迭代节点未配置子流程（请在属性面板「编辑子流程」中搭建）');
    }
    const items = (inputs.items || []).slice(0, ITER_MAX_ITEMS);
    const results = [];
    const subLogs = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const r = await runGraph(subflow, { input: String(item ?? ''), item: typeof item === 'object' ? JSON.stringify(item) : String(item ?? ''), index: String(i) }, {
        agent: ctx.agent, username: ctx.username, history: ctx.history, flowType: ctx.flowType,
        onEvent: evt => ctx.onEvent?.({ ...evt, nodeId: `${node.id}#${i + 1}/${items.length}:${evt.nodeId}` }),
        subflowDepth: (ctx.subflowDepth || 0) + 1,
      });
      results.push(r.output);
      subLogs.push(...r.logs.map(l => ({ ...l, nodeId: `${node.id}#${i + 1}:${l.nodeId}` })));
      if ((node.data?.onError || 'abort') !== 'continue' && r.logs.some(l => l.status === 'error')) {
        throw new Error(`迭代第 ${i + 1}/${items.length} 条执行失败（子流程详见日志）`);
      }
    }
    ctx._iterLogs?.push(...subLogs);
    return { results: JSON.stringify(results), results_array: results, count: results.length };
  },

  'if-else': async (node, inputs) => ({ branch: evaluateConditions(node.data?.cases, inputs) }),

  end: async (node, inputs) => {
    const out = {};
    for (const o of inputs.outputs || []) out[o.variable] = o.value;
    return { ...out, reply: inputs.outputs?.[0]?.value ?? '' };
  },

  /** P5.20 HTTP 请求节点：调用外部 HTTP API，支持 GET/POST/PUT/DELETE，超时+鉴权+模板渲染URL和请求体 */
  http_request: async (node, inputs, ctx) => {
    const d = node.data || {};
    const method = (d.method || 'GET').toUpperCase();
    const url = String(d.url || '');
    if (!url) throw new Error('HTTP请求节点未配置 URL');
    const timeout = Math.min(Math.max(parseInt(d.timeout) || 30, 1), 120);
    const headers = typeof d.headers === 'object' && d.headers ? { ...d.headers } : {};
    let body = String(d.body || '');
    if (method !== 'GET') {
      const rendered = body.replace(/\{\{#(.*?)#\}\}/g, (_, ref) => {
        const m = /^([\w-]+)(?:\.([\w-]+))?$/.exec(ref.trim());
        if (!m) return '';
        return String(inputs[m[1]]?.[m[2]] ?? inputs[m[1]] ?? '');
      });
      body = rendered;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
      const r = await fetch(url, {
        method, headers, body: method !== 'GET' ? body : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const respText = await r.text();
      let respJson = null;
      try { respJson = JSON.parse(respText); } catch {}
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        text: respText,
        json: respJson,
        ok: r.ok,
      };
    } catch (e) {
      return { status: 0, text: String(e?.message || e), json: null, error: String(e?.message || e), ok: false };
    }
  },

  /** JS/Python 沙箱代码节点：支持 JS（源码沙箱，禁用 require/process/eval/Function）和 Python（子进程 python3） */
  code_sandbox: async (node, inputs) => {
    const d = node.data || {};
    const language = d.language || 'javascript';
    const code = String(d.code || '').trim();
    if (!code) throw new Error('代码节点未配置代码');
    const t = Math.max(500, Math.min(parseInt(d.timeout) || 3000, 5000));
    if (language === 'python') {
      try {
        const { execSync } = require('child_process');
        const out = execSync(code, { timeout: t, encoding: 'utf-8', maxBuffer: 64 * 1024 });
        const text = String(out || '').trim();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        return { output: text, parsed, language: 'python', execution_time_ms: t };
      } catch (e) {
        throw new Error('Python 代码执行失败：' + String(e?.message || e).slice(0, 200));
      }
    }
    // 默认 JS 沙箱（复用现有 runCodeSandbox——禁止 require/process/eval/Function 等）
    const out = runCodeSandbox(code, (inputs.inputs || {}), t);
    if (out === null || out === undefined) return { output: '' };
    const safe = (s) => maskPII(mask(String(s)));
    if (typeof out === 'object' && !Array.isArray(out)) {
      const flat = {};
      for (const [k, v] of Object.entries(out)) flat[k] = Array.isArray(v) || (v && typeof v === 'object') ? safe(JSON.stringify(v)) : (typeof v === 'string' ? safe(v) : v);
      return { output: safe(JSON.stringify(out)), ...flat, language: 'javascript', execution_time_ms: t };
    }
    return { output: safe(Array.isArray(out) ? JSON.stringify(out) : String(out)), language: 'javascript', execution_time_ms: t };
  },

  /** 条件循环节点：每次迭代先判定条件，true 执行子流程继续循环；false 退出并（可选）累积结果 */
  condition_loop: async (node, inputs, ctx) => {
    const subflow = node.data?.subflow;
    if (!subflow || !Array.isArray(subflow.nodes) || !subflow.nodes.length) {
      throw new Error('条件循环节点未配置子流程（请在属性面板「编辑子流程」中搭建）');
    }
    const maxIters = Math.min(parseInt(node.data?.max_iterations) || 10, 50);
    const condition = String(node.data?.condition || '').trim();
    if (!condition) throw new Error('条件循环节点未配置退出条件表达式');
    // 条件求值：通过 JS 沙箱执行条件表达式（安全：禁用危险 API）
    const evalCondition = (vars) => {
      try {
        const checkCode = `return Boolean(${condition})`;
        return !!runCodeSandbox(checkCode, { ...(vars || {}), __iter_count: __iterCountSoFar, __total: vars?.__list?.length ?? 0 }, 2000);
      } catch { return false; }
    };
    const results = [];
    const subLogs = [];
    for (let i = 0; i < maxIters; i++) {
      const shouldContinue = evalCondition({ ...inputs, __iter_index: i, __prev_result: results.length ? results[results.length - 1] : null });
      if (!shouldContinue) break;
      const item = typeof inputs.__list?.[i] !== 'undefined' ? inputs.__list[i] : inputs;
      const iterInputs = { input: String(item ?? ''), item: typeof item === 'object' ? JSON.stringify(item) : String(item ?? ''), index: String(i), __condition_pass: true };
      const r = await runGraph(subflow, iterInputs, {
        agent: ctx.agent, username: ctx.username, history: ctx.history, flowType: ctx.flowType,
        onEvent: evt => ctx.onEvent?.({ ...evt, nodeId: `${node.id}#${i + 1}/${maxIters}:${evt.nodeId}` }),
        subflowDepth: (ctx.subflowDepth || 0) + 1,
      });
      results.push(r.output);
      subLogs.push(...r.logs.map(l => ({ ...l, nodeId: `${node.id}#${i + 1}:${l.nodeId}` })));
      if ((node.data?.onError || 'abort') !== 'continue' && r.logs.some(l => l.status === 'error')) {
        throw new Error(`条件循环第 ${i + 1}/${maxIters} 次执行失败`);
      }
    }
    ctx._iterLogs?.push(...subLogs);
    return { results: JSON.stringify(results), results_array: results, count: results.length, max_reached: false, iterations_executed: results.length };
  },

  /** 变量赋值节点：增强版 assign，支持 set/append/clear/delete 运算符 + session. 会话变量 + 深层路径（user.name） */
  variable_assign: async (node, inputs) => {
    const d = node.data || {};
    const out = {};
    const vars = d.variables || [];
    // 解析会话变量基值（append 基于持久值累积）
    const sessBase = (variable) => {
      const m = /^session\.([\w-]+)$/.exec(String(variable || ''));
      return m ? (out[m[1]] ?? inputs[m[1]] ?? '') : null;
    };
    for (const v of vars) {
      const name = String(v.variable || '').trim();
      if (!name || name === '__proto__' || name === 'constructor') continue; // 原型污染防御
      const value = v.value ?? '';
      const operator = v.operator || 'set';
      if (operator === 'clear') out[name] = '';
      else if (operator === 'delete') out[name] = null; // 下游引用走 undefined
      else if (operator === 'append') {
        const base = sessBase(name);
        out[name] = (base !== null ? base : (out[name] ?? '')) + String(value);
      }
      else if (operator === 'set') {
        // 尝试 JSON 解析（用户打字时可能直接传 JSON 对象），前端会标 ${} 时效变量、JSON 竟不是模板字面量
        let parsed = null;
        try { parsed = JSON.parse(String(value)); } catch {}
        out[name] = parsed !== null && parsed !== undefined ? parsed : String(value);
      }
    }
    return out;
  },

  /** 消息通知节点：向用户发送系统通知（铃铛），支持直接文本内容（占位待扩展邮件/企微 bot） */
  notification: async (node, inputs) => {
    const d = node.data || {};
    const title = String(d.title || '').trim();
    const content = String(d.content || '').trim();
    if (!title && !content) throw new Error('消息通知节点未填写通知标题或内容');
    const safeTitle = title ? title.slice(0, 100) : '(无标题)';
    const safeContent = (content || String(inputs.message || '')).slice(0, 500);
    db.prepare('INSERT INTO notifications (username,title,content,type,created_at) VALUES (?,?,?,\'workflow\',datetime(\'now\',\'localtime\'))')
      .run(inputs._username || d.username || '', safeTitle, safeContent);
    return { sent: true, title: safeTitle, content: safeContent, recipient: inputs._username || d.username || '' };
  },

  /** P5.20 数据库查询节点：对平台的 SQLite 执行只读查询（SELECT），返回结果集 */
  database_query: async (node, inputs) => {
    const sql = String(node.data?.sql || '').trim();
    if (!sql) throw new Error('数据库查询节点未配置 SQL');
    // 模板渲染 SQL 中的变量引用
    const rendered = sql.replace(/\{\{#(.*?)#\}\}/g, (_, ref) => {
      const m = /^([\w-]+)(?:\.([\w-]+))?$/.exec(ref.trim());
      if (!m) return '';
      const val = String(inputs[m[1]]?.[m[2]] ?? inputs[m[1]] ?? '');
      // SQL 安全：只允许字母数字下划线，防 SQL 注入
      if (/[^a-zA-Z0-9_\s\-.]/.test(val)) return '';
      return val;
    });
    try {
      const rows = db.prepare(rendered).all();
      return { rows, count: rows.length, json: JSON.stringify(rows) };
    } catch (e) {
      throw new Error('数据库查询失败：' + String(e?.message || e));
    }
  },

  /** P5.20 延时节点：按配置毫秒数等待后继续（sleep），支持变量引用 */
  delay: async (node, inputs) => {
    const ms = Math.min(Math.max(parseInt(node.data?.ms) || 1000, 0), 60000);
    await new Promise(r => setTimeout(r, ms));
    return { waited: ms };
  },

  /** P5.20 日志节点：将输入变量写入 err_logs 作为调试日志，输出原样透传 */
  logger: async (node, inputs) => {
    const { level, message, ...rest } = inputs;
    const msg = String(message || level || '');
    const extra = Object.keys(rest).length ? JSON.stringify(rest) : '';
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
      .run('workflow-logger', (msg + (extra ? ' | ' + extra : '')).slice(0, 1000), now());
    return { logged: true, message: msg, extra: rest };
  },

  /** P5.20 数据转换节点：对输入执行 JSONata/模板变换，输出结果 */
  transform: async (node, inputs) => {
    const expr = String(node.data?.expression || '').trim();
    if (!expr) throw new Error('数据转换节点未配置表达式');
    const { expression, ...vars } = inputs;
    // 简单模板渲染模式：替换 {{#variable#}} 占位符
    const rendered = expr.replace(/\{\{#(.*?)#\}\}/g, (_, ref) => {
      const m = /^([\w-]+)(?:\.([\w-]+))?$/.exec(ref.trim());
      if (!m) return '';
      return String(vars[m[1]]?.[m[2]] ?? vars[m[1]] ?? '');
    });
    // 尝试 JSON 解析输出（若渲染结果形如 JSON 对象或数组）
    let parsed = null;
    try { parsed = JSON.parse(rendered); } catch {}
    return { result: rendered, parsed, json: parsed ? JSON.stringify(parsed) : rendered };
  },
};

/**
 * 单图执行核心（主图与 iteration 子流程共用）。
 * @param wf          {nodes, edges}
 * @param inputVars   输入变量表（子流程含 item/index）
 * @param ctx         { agent, username, history?, onEvent?, subflowDepth?, startFrom?, presetResults? }
 *   startFrom/presetResults：P5.3 调试可视化——从此节点重跑（前序节点沿用 presetResults 缓存，不重新执行）
 */
async function runGraph(wf, inputVars = {}, ctx = {}) {
  if ((ctx.subflowDepth || 0) > 3) throw new Error('迭代嵌套层数超限（≤3）');
  const nodes = wf.nodes, edges = wf.edges || [];
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

  const startNode = nodes.find(n => n.type === 'start');
  if (!startNode) throw new Error('工作流缺少开始（start）节点');
  // P5.7 会话变量写入收集器（主图创建；轮末由路由层持久化到 sessions.wf_vars）
  if (!ctx._sessionWrites) ctx._sessionWrites = {};
  const sessVarNames = new Set((startNode.data?.session_vars || []).map(v => String(v?.name || '').trim()).filter(Boolean));
  const effectiveInputs = { ...(inputVars || {}) };
  if (effectiveInputs.input === undefined) effectiveInputs.input = '';
  for (const v of startNode.data?.variables || []) {
    if (effectiveInputs[v.name] === undefined) effectiveInputs[v.name] = v.default ?? '';
  }

  const order = topologicalSort(nodes, edges);
  const results = {};
  const logs = [];
  const branchOf = {};
  const errorOf = new Set(); // P5.11 异常分支：已失败且画了 __error__ 出边的节点（激活切换到异常分支）
  const emit = (evt) => { try { ctx.onEvent?.(evt); } catch { } };

  // P5.3 从此节点重跑：startFrom 之前的节点沿用 presetResults（不执行），if-else 缓存分支参与激活计算
  // P5.14 文件一等变量：preset 里 file 变量为 JSON 字符串（resultsSlim 序列化），此处对称还原为富对象
  const normalizePresetVars = (vars) => {
    if (!vars || typeof vars !== 'object') return vars || {};
    for (const k of Object.keys(vars)) {
      const v = vars[k];
      if (typeof v === 'string' && v.startsWith('{"__file"')) {
        try { const o = JSON.parse(v); if (o && o.__file) vars[k] = o; } catch { }
      } else if (typeof v === 'string' && v.startsWith('[{"__file"')) {
        try { const a = JSON.parse(v); if (Array.isArray(a) && a[0]?.__file) vars[k] = a; } catch { }
      }
    }
    return vars;
  };
  const preset = ctx.presetResults || {};
  for (const nid of Object.keys(preset)) preset[nid] = normalizePresetVars(preset[nid]);
  const skipSet = new Set();
  if (ctx.startFrom) {
    if (!nodeMap[ctx.startFrom]) throw new Error(`重跑起点节点不存在：${ctx.startFrom}`);
    for (const id of order) {
      if (id === ctx.startFrom) break;
      skipSet.add(id);
    }
  }

  let output = '';
  const answers = []; // P5.6 Chatflow 直接回复汇总（有 answer 执行过则优先于 end 作为最终回复）
  let steps = 0;
  for (const id of order) {
    if (++steps > MAX_STEPS) throw new Error('执行步数超限（疑似异常图结构）');
    const node = nodeMap[id];
    if (!node) continue;

    // 重跑模式：前序节点直接注入缓存结果
    if (skipSet.has(id)) {
      const cached = preset[id] || {};
      results[id] = cached;
      if (node.type === 'if-else' || node.type === 'classifier') branchOf[id] = cached.branch;
      logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'preset', duration: 0, note: '重跑：沿用上次运行结果' });
      emit({ event: 'nodeSkip', nodeId: id, type: node.type, title: node.data?.title || id, preset: true });
      continue;
    }

    const active = computeActive(nodes, edges, branchOf, errorOf);
    if (!active.has(id)) {
      logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'skipped', duration: 0, note: '分支未命中，跳过' });
      emit({ event: 'nodeSkip', nodeId: id, type: node.type, title: node.data?.title || id });
      continue;
    }

    const t0 = Date.now();
    emit({ event: 'nodeStart', nodeId: id, type: node.type, title: node.data?.title || id });
    let inputs = null;
    try {
      inputs = resolveInputs(node, results, effectiveInputs);
      const executor = NODE_EXECUTORS[node.type];
      if (!executor) throw new Error(`未知节点类型：${node.type}`);
      const iterCtx = { agent: ctx.agent, username: ctx.username, history: ctx.history, flowType: ctx.flowType, onEvent: ctx.onEvent, subflowDepth: ctx.subflowDepth, sessionVars: ctx.sessionVars, _sessionWrites: ctx._sessionWrites, _iterLogs: [], _currentRunId: ctx._currentRunId };
      // P5.5 节点级超时 + 重试（指数退避；code 节点沙箱自带超时不重复包）
      const d = node.data || {};
      const timeoutMs = node.type === 'code' ? null : (d.timeout || (node.type === 'llm' ? LLM_DEFAULT_TIMEOUT : NODE_DEFAULT_TIMEOUT));
      const retryN = node.type === 'code' ? 0 : (d.retry || 0);
      let out, retries = 0;
      if (timeoutMs) {
        const r = await withRetry(() => withTimeout(executor(node, inputs, iterCtx), timeoutMs, d.title), retryN);
        out = r.out; retries = r.retries;
      } else {
        const r = await withRetry(() => executor(node, inputs, iterCtx), retryN);
        out = r.out; retries = r.retries;
      }
      results[id] = out;
      if (node.type === 'if-else' || node.type === 'classifier') branchOf[id] = out.branch;
      // P5.7 会话变量：assign 写 session.名称 → 同步进 start 输出（下游节点立即拿到新值）+ 收集变更（轮末持久化）
      if (node.type === 'assign') {
        for (const a of inputs.assignments || []) {
          const m = /^session\.([\w-]+)$/.exec(String(a.variable || ''));
          if (m && sessVarNames.has(m[1])) {
            const val = out[a.variable] ?? out[m[1]] ?? '';
            (results.start || (results.start = {}))[m[1]] = val;
            ctx._sessionWrites[m[1]] = val;
          }
        }
      }
      // P5.6 直接回复：执行到 answer 节点即时回传全文（聊天 SSE 流式 / 运行测试弹窗显示），流程继续
      if (node.type === 'answer') {
        answers.push(String(out.text ?? ''));
        emit({ event: 'nodeReply', nodeId: id, title: node.data?.title || id, text: String(out.text ?? '') });
      }
      if (node.type === 'iteration' && iterCtx._iterLogs.length) {
        logs.push(...iterCtx._iterLogs);
        iterCtx._iterLogs.length = 0;
      }

      // P5.5：摘要/入参/出参落库与 SSE 回传前统一密钥脱敏（{{env.X}} 注入的值不落任何持久化日志）
      // P5.14：file 富对象摘要化显示（[📄 #id 名] / [📄×N]），不再 [object Object]
      const pv = (v) => (v && typeof v === 'object' && v.__file) ? `[📄 #${v.id} ${v.name}]`
        : (Array.isArray(v) && v.length && v[0]?.__file) ? `[📄×${v.length}]`
        : String(v ?? '');
      const preview = maskSecrets(Object.keys(out).slice(0, 3).map(k => `${k}=${pv(out[k]).replace(/\s+/g, ' ').slice(0, 60)}`).join(' | '));
      // P5.8 #9：agent 节点附子运行 id（前端下钻查看子画布轨迹；childMode=canvas 时可下钻）
      const childInfo = node.type === 'agent' && out.childRunId ? { childRunId: out.childRunId, childMode: out.childMode || 'canvas' } : {};
      // P5.13 成本可视化：tokens/费用直接附事件与日志（llm 节点明细；agent 节点带子运行累计）
      const costInfo = node.type === 'llm' && out.tokens != null
        ? { tokens: out.tokens, tokens_in: out.tokens_in, tokens_out: out.tokens_out, cost_cny: out.cost_cny, cost_priced: out.cost_priced, model_used: out.model_used }
        : node.type === 'agent' && out.usage_summary
          ? { tokens: out.usage_summary.totalTokens, cost_cny: out.usage_summary.costCny, cost_priced: out.usage_summary.priced, usage_summary: out.usage_summary }
          : {};
      logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'success', duration: Date.now() - t0, retries, ...childInfo, ...costInfo,
        output: preview, inputs: maskSecrets(JSON.stringify(inputs)).slice(0, 2000), outputFull: maskSecrets(JSON.stringify(out)).slice(0, 2000) });
      emit({ event: 'nodeDone', nodeId: id, type: node.type, title: node.data?.title || id, ok: true, ms: Date.now() - t0, preview, retries, ...childInfo, ...costInfo,
        inputs: maskSecrets(JSON.stringify(inputs)).slice(0, 2000), outputFull: maskSecrets(JSON.stringify(out)).slice(0, 2000) });

      if (node.type === 'end' && !output) output = out.reply;
    } catch (err) {
      // P5.11 异常分支（最高优先级）：节点画了 __error__ 出边 → 不中断不走策略，错误信息成输出变量（补救节点可引用），激活切换到异常分支
      const hasErrorEdge = edges.some(e => e.source === id && (e.sourceHandle || 'out') === '__error__');
      if (hasErrorEdge) {
        results[id] = { __error__: maskSecrets(String(err.message || '节点执行失败')).slice(0, 500) };
        errorOf.add(id);
        logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'error', duration: Date.now() - t0, error: maskSecrets(err.message), retries: err.retries || 0, viaError: true,
          inputs: inputs ? maskSecrets(JSON.stringify(inputs)).slice(0, 2000) : null, note: '已转入异常分支（流程继续）' });
        emit({ event: 'nodeDone', nodeId: id, type: node.type, title: node.data?.title || id, ok: false, ms: Date.now() - t0, preview: maskSecrets(err.message), retries: err.retries || 0, viaError: true });
        continue;
      }
      logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'error', duration: Date.now() - t0, error: maskSecrets(err.message), retries: err.retries || 0,
        inputs: inputs ? maskSecrets(JSON.stringify(inputs)).slice(0, 2000) : null });
      emit({ event: 'nodeDone', nodeId: id, type: node.type, title: node.data?.title || id, ok: false, ms: Date.now() - t0, preview: maskSecrets(err.message) });
      const policy = node.data?.onError || 'abort';
      // P5.5 失败策略三选一：abort 中断 / continue 跳过 / default 使用默认值继续
      if (policy === 'continue') {
        results[id] = {};
        continue;
      }
      if (policy === 'default') {
        // 默认值注入：按节点主输出字段（llm→text / tool→result / agent→reply / code→output / 其他→output）
        const mainKey = { llm: 'text', tool: 'result', agent: 'reply', code: 'output' }[node.type] || 'output';
        results[id] = { [mainKey]: String(node.data?.default_output ?? ''), _fallback: true };
        logs.push({ nodeId: id, nodeType: node.type, title: node.data?.title || node.type, status: 'fallback', duration: 0, note: '使用默认值继续' });
        emit({ event: 'nodeDone', nodeId: id, type: node.type, title: node.data?.title || id, ok: true, ms: 0, preview: '失败后使用默认值继续' });
        continue;
      }
      const e = new Error(`节点 ${node.data?.title || id} 执行失败：${err.message}`);
      e.logs = logs;
      throw e;
    }
  }

  // P5.6 Chatflow：直接回复优先于 end 作为最终输出（Dify 语义：chatflow 的回复全部来自 answer 节点）
  if (answers.length) output = answers.filter(x => String(x).trim() !== '').join('\n\n');
  if (!output) output = results[startNode.id]?.input ?? '（工作流执行完成，但未经过输出节点）';
  // P5.7 会话变量：返回本轮结束时的快照（初始持久值 + 本轮写入），路由层落库
  const sessionVars = { ...(ctx.sessionVars || {}), ...ctx._sessionWrites };
  // P5.13 成本可视化：全图 usage 汇总（llm 节点明细累计 + agent 节点子运行累计；耗时/费用/最贵最慢节点）
  let usage = { totalTokens: 0, tokensIn: 0, tokensOut: 0, costCny: 0, priced: false, nodes: [] };
  for (const l of logs) {
    if (l.status !== 'success' && !l.viaError) continue;
    if (l.nodeType === 'llm' && l.tokens != null) {
      usage.totalTokens += Number(l.tokens) || 0;
      usage.tokensIn += Number(l.tokens_in) || 0;
      usage.tokensOut += Number(l.tokens_out) || 0;
      usage.costCny += Number(l.cost_cny) || 0;
      if (l.cost_priced) usage.priced = true;
      usage.nodes.push({ nodeId: l.nodeId, title: l.title, type: 'llm', tokens: l.tokens, costCny: l.cost_cny, duration: l.duration, model: l.model_used });
    } else if (l.nodeType === 'agent' && l.tokens != null) {
      usage.totalTokens += Number(l.tokens) || 0;
      usage.costCny += Number(l.cost_cny) || 0;
      if (l.cost_priced) usage.priced = true;
      usage.nodes.push({ nodeId: l.nodeId, title: l.title, type: 'agent', tokens: l.tokens, costCny: l.cost_cny, duration: l.duration, model: '子智能体累计' });
    }
  }
  usage.costCny = +usage.costCny.toFixed(6);
  return { output, results, logs, sessionVars, usage };
}

/**
 * DAG Runner 主入口（按用户规范签名）。
 * @param agent      智能体整行（含 workflow/kb_id/mcp_servers/model…）
 * @param inputVars  输入变量表（至少含 input；start 自定义变量可覆盖默认值）
 * @param context    { onEvent(evt), username?, history?, startFrom?, presetResults? }
 * @returns { output（对话回复）, results（nodeId→输出变量表）, logs（执行日志含完整入参出参，重跑时含 preset 标记） }
 */
async function runWorkflow(agent, inputVars = {}, context = {}) {
  let wf = agent.workflow;
  if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { wf = null; } }
  if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) throw new Error('未编排工作流（画布为空）');
  // P5.6：flow_type 透传给子图执行（Chatflow 下 llm 默认携带历史）
  return runGraph(wf, inputVars, { ...context, flowType: wf.flow_type === 'chatflow' ? 'chatflow' : 'workflow' });
}

/**
 * 统一执行入口 runAgent（2026-10-26 差异化能力 #9/#10/#11 共用基础）
 * 按智能体配置一次性执行：canvas 模式走画布引擎（落 workflow_runs），form 模式走 chatOnce + 知识库检索。
 * 用于 MCP 工具调用 / 定时任务 / 画布 agent 节点 / Webhook 等无状态一次性场景。
 * （对话流式多轮工具循环仍由 chat.js 负责，不复刻此处）
 *
 * @param agent      智能体整行（含 workflow/edit_mode/routing_mode/kb_id/prompt/model…）
 * @param input      任务文本
 * @param ctx        { triggerType?, parentRunId?, username?, history?, onEvent?, inputVars? }
 *                   triggerType: manual/mcp/schedule/agent_node/webhook（canvas 模式落 run 时记录来源）
 *                   parentRunId: #9 子智能体节点调用时关联父 run（下钻调试链路）
 *                   inputVars:  P5.16 结构化参数（MCP tools/call arguments 等）——canvas 模式并入 start 变量注入；
 *                               file 类型传 fileId 由 Runner resolveFileVar 解析为富对象
 * @returns { text, mode, run?, runId? }  text=回复；mode='canvas'|'form'；canvas 时 run 含 results/logs/sessionVars
 */
async function runAgent(agent, input, ctx = {}) {
  const taskText = String(input ?? '');
  const triggerType = ctx.triggerType || 'manual';
  // canvas 模式：edit_mode='canvas' 或 routing_mode='workflow'，且已编排画布
  const useCanvas = agent && agent.workflow && (agent.edit_mode === 'canvas' || agent.routing_mode === 'workflow');
  if (useCanvas) {
    // P5.9 版本管理：运行时优先已发布快照（published_workflow），无快照的存量画布回退草稿——
    // 编辑中的草稿不影响线上（对话/API/MCP/定时/Webhook/子智能体调用均走此入口）
    let wfRaw = agent.published_workflow || agent.workflow;
    let wf = wfRaw;
    if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { wf = null; } }
    // 快照损坏防御：回退草稿
    if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) { wfRaw = agent.workflow; wf = wfRaw; if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { wf = null; } } }
    if (wf && Array.isArray(wf.nodes) && wf.nodes.length) {
      // 把选中版本固化为执行输入（runWorkflow 按 agentRow.workflow 重新解析——防止快照选择被草稿覆盖）；
      // V1 旧图自动升级（防御）
      let wfStr = typeof wfRaw === 'string' ? wfRaw : JSON.stringify(wf);
      if (wf.nodes[0].config !== undefined) {
        const { migrateWorkflowData } = require('./workflow-schema');
        wfStr = JSON.stringify(migrateWorkflowData(wf));
      }
      const agentRow = { ...agent, workflow: wfStr };
      // 落运行实例（#9/#10/#11 可观测；parent_run_id 关联父 run 形成下钻链路）
      const runRow = db.prepare(`INSERT INTO workflow_runs (agent_id, trigger_type, status, inputs, parent_run_id, started_at) VALUES (?,?,?,?,?,datetime('now','localtime'))`)
        .run(agent.id, triggerType, 'running', maskSecrets(JSON.stringify({ input: taskText.slice(0, 4000), ...(ctx.inputVars || {}) })).slice(0, 4000), ctx.parentRunId || null);
      const t0 = Date.now();
      try {
        // P5.16 结构化参数：ctx.inputVars 并入 start 变量（file 类型 fileId → Runner 富对象）
        const r = await runWorkflow(agentRow, { input: taskText, ...(ctx.inputVars || {}) }, {
          username: ctx.username, history: ctx.history, onEvent: ctx.onEvent,
          _currentRunId: runRow.lastInsertRowid, // #9 透传给 agent 节点作 parentRunId
        });
        // P5.13：直接用 Runner 汇总（正则提取升为直接累计）；无 usage 时兼容归零
        const totalTokens = r.usage?.totalTokens ?? 0;
        db.prepare(`UPDATE workflow_runs SET status='success', outputs=?, node_logs=?, total_tokens=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
          .run(maskSecrets(String(r.output ?? '')).slice(0, 8000), JSON.stringify(r.logs).slice(0, 100000), totalTokens, Date.now() - t0, runRow.lastInsertRowid);
        return { text: String(r.output ?? '').trim(), mode: 'canvas', run: r, runId: runRow.lastInsertRowid, usage: r.usage };
      } catch (err) {
        db.prepare(`UPDATE workflow_runs SET status='error', node_logs=?, error=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
          .run(JSON.stringify(err.logs || []).slice(0, 100000), maskSecrets(String(err.message || '')).slice(0, 500), Date.now() - t0, runRow.lastInsertRowid);
        throw err;
      }
    }
  }
  // form 模式（含 canvas 判定失败回退）：chatOnce + 知识库检索（与 mcp-server runAgentAsTool 同构）
  const { retrieve } = require('./retriever'); // 延迟 require 避免与 retriever 互依
  const { resolveKbFilter } = require('./kb-metadata'); // V1.2 审查加固 2026-10-30：工作流检索同样受元数据过滤约束
  let system = (agent && agent.prompt) || `你是「${(agent && agent.name) || '智能体'}」，请专业、准确地完成交给你的任务。`;
  if (agent && agent.kb_id) {
    try {
      // V1.2 审查加固：chat 触发时 ctx.username 为最终用户——按其部门解析 $user.dept 占位符；
      // 定时/Webhook 触发无用户 → 占位符置哨兵恒不命中（fail-closed），固定值键照常生效
      let wfUser = null;
      if (ctx && ctx.username) {
        try { wfUser = db.prepare('SELECT dept FROM users WHERE username=?').get(ctx.username) || null; } catch { }
      }
      const hits = await retrieve(taskText, agent.kb_id, 4, 0.01, { metadataFilter: resolveKbFilter(agent, wfUser) || undefined });
      if (hits && hits.length) {
        system += `\n\n以下是知识库检索到的相关内容，请优先依据这些内容：\n${hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n')}`;
      }
    } catch { /* kb 检索失败不阻塞主流程 */ }
  }
  // P5.31：智能体配置了工具（如系统「定时任务执行助手」的 web_search/export_word）→ 走 chat() 完整工具循环
  // （真实执行 function calling，防 LLM 编造工具输出；与 chat.js runChildAgent 的 P3 模式同构），否则保持纯文本一次调用。
  // 定时/Webhook/API 触发属可信执行路径，无对话确认卡（P5.25 权限闸门仅对话链路）。
  let agentToolIds = [];
  try { agentToolIds = JSON.parse((agent && agent.tools) || '[]'); } catch { agentToolIds = []; }
  const agentMcpTools = agent ? loadMcpTools(agent.mcp_servers || '[]') : [];
  const toolSchemas = buildTools(agentToolIds, agentMcpTools, []);
  const baseOpts = {
    model: agent && agent.model, temperature: (agent && agent.temperature) ?? 0.5, top_p: agent && agent.top_p,
    max_reply: Math.min((agent && agent.max_reply) || 1024, 2048), agentName: agent && agent.name,
    username: ctx.username, // P5.31：任务归属者（用户自有模型优先路由；无值走平台默认）
  };
  if (toolSchemas.length) {
    // P5.33 审查修复（F1）：runAgent 执行源（定时/Webhook/手动执行/MCP Server/子智能体）均无确认卡交互——
    // create_task（任务造任务的自我复制持久化链）与 local_exec（无人值守桌面操作）在此上下文一律拒绝，
    // 无论智能体如何配置。对话链路不受影响（chat.js 有 P5.25 确认卡 + high 风险闸门）。
    // P5.34b（审查 F6）：MCP 外部工具在无人值守上下文仅放行「低风险」（trusted 服务 + 启发式/人工判 low）——
    // 与对话链路「low 免确认」语义对齐；写类/未知 MCP 工具无人值守时无法弹确认卡，一律拒绝（从严）。
    const UNATTENDED_DENY = new Set(['create_task', 'local_exec']);
    const gen = chat([
      { role: 'system', content: system },
      { role: 'user', content: taskText.slice(0, 4000) },
    ], {
      ...baseOpts,
      tools: toolSchemas,
      executeTool: (name, argsJson) => {
        if (UNATTENDED_DENY.has(name)) {
          return `⛔ 工具 ${name} 不允许在任务执行（定时/Webhook/子智能体）上下文中调用——请直接完成当前任务，不要尝试创建新任务或操作本地设备。`;
        }
        if (String(name).startsWith('mcp_') && toolRiskOf(name, { mcpServers: (agent && agent.mcp_servers) || '[]' }) !== 'low') {
          return `⛔ MCP 工具 ${name} 在无人值守执行中属于写类/未知风险（需用户确认才能执行），已拒绝。请基于已有信息完成任务；只读类 MCP 工具（低风险）可正常使用。`;
        }
        return runTool(name, argsJson, { kbId: (agent && agent.kb_id) || null, mcpServers: (agent && agent.mcp_servers) || '[]', username: ctx.username });
      },
    });
    let full = '';
    let usage = null;
    while (true) {
      const r = await gen.next();
      if (r.done) { full = r.value.full || ''; usage = r.value.usage || null; break; }
    }
    const u = usage || {};
    const c = calcCost(agent && agent.model, u.prompt_tokens, u.completion_tokens);
    return { text: String(full).trim(), mode: 'form-tools', usage: { totalTokens: u.total_tokens ?? 0, tokensIn: u.prompt_tokens ?? 0, tokensOut: u.completion_tokens ?? 0, costCny: +c.total.toFixed(6), priced: c.priced, nodes: [{ title: '单次调用（含工具循环）', type: 'llm', tokens: u.total_tokens ?? 0, costCny: +c.total.toFixed(6), model: (agent && agent.model) || '' }] } };
  }
  const r = await chatOnce([
    { role: 'system', content: system },
    { role: 'user', content: taskText.slice(0, 4000) },
  ], baseOpts);
  // P5.13：form 模式单次调用 usage
  const u = r.usage || {};
  const c = calcCost(agent && agent.model, u.prompt_tokens, u.completion_tokens);
  return { text: (r.full || '').trim(), mode: 'form',
    usage: { totalTokens: u.total_tokens ?? 0, tokensIn: u.prompt_tokens ?? 0, tokensOut: u.completion_tokens ?? 0, costCny: +c.total.toFixed(6), priced: c.priced, nodes: [{ title: '单次调用', type: 'llm', tokens: u.total_tokens ?? 0, costCny: +c.total.toFixed(6), model: (agent && agent.model) || '' }] } };
}

module.exports = { runWorkflow, runAgent, runGraph, render, topologicalSort, evaluateConditions, evalCondition, computeActive, resolveInputs, resolveRefRaw, NODE_EXECUTORS, buildClassifyPrompt, parseClassifyReply, flattenToolResult, buildLlmMessages };
