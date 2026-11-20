/**
 * 专家团式并行编排 V1（D1-2，2026-11-20）
 *
 * 把画布 DAG Runner 的状态/重试/超时/成本语义搬到「多智能体编排」层：
 *  - 强制任务图 JSON（nodes + depends_on）→ validateTaskGraph 校验环与悬空依赖
 *  - planLevels 拓扑分层（同层节点可并行）→ runTaskGraph 按层并行执行（并发上限）
 *  - 节点级超时 + 指数退避重试；失败节点可经 rerunNode 单独重跑
 *  - 验证节点必填（requireVerify，默认 true）：至少一个 type='verify' 节点负责验收
 *
 * 设计原则：本模块保持纯逻辑 + 可注入执行器（runAgent/runVerify），既供 chat.js 编排链路调用，
 * 也供 smoke 单测直接验证（不触碰真实模型/网络）。
 */

const MAX_CONCURRENCY = 4;            // 同层并行上限（防子智能体调用风暴）
const DEFAULT_TIMEOUT_MS = 120000;    // 单节点默认超时（与画布 LLM 节点一致）
const MAX_RETRY = 3;                  // 单节点最大重试次数
const RETRY_BASE_MS = 700;            // 指数退避基数（700ms * 2^n）

/** 归一化一个原始节点：稳定字段、容错缺省 */
function normalizeNode(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = String(r.id ?? '').trim();
  const type = r.type === 'verify' ? 'verify' : (r.type === 'agent' ? 'agent' : (r.agent_id != null ? 'agent' : 'verify'));
  const agentId = r.agent_id != null && r.agent_id !== '' ? Number(r.agent_id) : null;
  const depends = Array.isArray(r.depends_on) ? r.depends_on.map(x => String(x).trim()).filter(Boolean)
    : (Array.isArray(r.dependsOn) ? r.dependsOn.map(x => String(x).trim()).filter(Boolean) : []);
  return {
    id,
    type,
    agent_id: agentId,
    task: String(r.task ?? r.title ?? '').trim(),
    title: String(r.title ?? r.name ?? '').trim(),
    depends_on: [...new Set(depends)],
  };
}

/**
 * 拓扑分层（Kahn）：同层节点彼此无依赖，可并行执行。
 * @returns {{ ok:boolean, levels?:string[][], error?:string }}
 */
function planLevels(nodes) {
  const ids = new Set(nodes.map(n => n.id));
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const outs = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) continue; // 悬空依赖在 validate 阶段单独报错；此处不参与分层
      indeg.set(n.id, indeg.get(n.id) + 1);
      outs.get(dep).push(n.id);
    }
  }
  const levels = [];
  let frontier = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  let visited = 0;
  while (frontier.length) {
    levels.push(frontier);
    visited += frontier.length;
    const next = [];
    for (const id of frontier) {
      for (const t of outs.get(id)) {
        indeg.set(t, indeg.get(t) - 1);
        if (indeg.get(t) === 0) next.push(t);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) return { ok: false, error: '任务图存在环路，无法拓扑排序' };
  return { ok: true, levels };
}

/**
 * 校验任务图：结构 / id 唯一 / 悬空依赖 / 环 / 子智能体归属 / 验证节点必填。
 * @param {object} spec         原始任务图 { nodes:[...] }
 * @param {object} opts
 * @param {number[]} opts.allowedAgentIds  允许使用的子智能体 id（agent.child_ids）
 * @param {boolean}  opts.requireVerify    是否强制验证节点（默认 true）
 * @returns {{ ok:boolean, errors:string[], graph?:{nodes:object[]}, levels?:string[][] }}
 */
function validateTaskGraph(spec, { allowedAgentIds = [], requireVerify = true } = {}) {
  const errors = [];
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) {
    return { ok: false, errors: ['任务图为空或缺少 nodes 数组'] };
  }
  if (spec.nodes.length > 24) errors.push(`任务图节点数过多（${spec.nodes.length} > 24）`);

  const allowed = new Set((allowedAgentIds || []).map(Number).filter(Number.isFinite));
  const nodes = [];
  const ids = new Set();
  for (const raw of spec.nodes) {
    const n = normalizeNode(raw);
    if (!n.id) { errors.push('存在缺少 id 的节点'); continue; }
    if (ids.has(n.id)) { errors.push(`节点 id 重复：${n.id}`); continue; }
    ids.add(n.id);
    if (!n.task) errors.push(`节点 ${n.id} 缺少 task 描述`);
    if (n.type === 'agent') {
      if (n.agent_id == null || !Number.isFinite(n.agent_id)) {
        errors.push(`agent 节点 ${n.id} 缺少合法 agent_id`);
      } else if (allowed.size && !allowed.has(n.agent_id)) {
        errors.push(`节点 ${n.id} 引用了未挂载的子智能体 #${n.agent_id}`);
      }
    }
    nodes.push(n);
  }

  // 悬空依赖：depends_on 指向不存在的节点
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) errors.push(`节点 ${n.id} 依赖不存在的节点「${dep}」（悬空依赖）`);
      if (dep === n.id) errors.push(`节点 ${n.id} 依赖自身`);
    }
  }

  // 环检测（仅当无悬空问题时分层才有意义）
  let levels = null;
  if (!errors.length) {
    const pl = planLevels(nodes);
    if (!pl.ok) errors.push(pl.error);
    else levels = pl.levels;
  }

  // 验证节点必填
  if (requireVerify && !nodes.some(n => n.type === 'verify')) {
    errors.push('任务图必须包含至少一个验证节点（type="verify"）用于验收');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], graph: { nodes }, levels };
}

/** 单节点执行超时包装（底层请求自然中止；此处保证流程可控） */
function withTimeout(promiseFactory, ms, label) {
  return Promise.race([
    Promise.resolve().then(promiseFactory),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`节点超时（${ms}ms 上限）${label ? '：' + label : ''}`)), Math.max(500, ms || DEFAULT_TIMEOUT_MS))),
  ]);
}

/** 单节点重试：指数退避，最多 maxRetry 次（≤ MAX_RETRY） */
async function withRetry(fn, maxRetry) {
  const tries = Math.max(0, Math.min(maxRetry || 0, MAX_RETRY));
  let lastErr;
  for (let attempt = 0; attempt <= tries; attempt++) {
    try { return { out: await fn(), retries: attempt }; }
    catch (e) {
      lastErr = e;
      if (attempt < tries) await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
    }
  }
  throw Object.assign(lastErr || new Error('执行失败'), { retries: tries });
}

/** 受限并发执行一批任务（worker 池） */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 归一化执行器返回：允许返回 string（纯文本）或 { text, tokens, costCny, usage } */
function normalizeOutcome(r) {
  if (r && typeof r === 'object') {
    return {
      text: String(r.text ?? r.output ?? ''),
      tokens: Number(r.tokens ?? r.usage?.totalTokens ?? 0) || 0,
      costCny: Number(r.costCny ?? r.usage?.costCny ?? 0) || 0,
    };
  }
  const text = String(r ?? '');
  return { text, tokens: Math.ceil(text.length * 0.6), costCny: 0 };
}

/** 汇总某节点的依赖上下文（上游输出拼接） */
function collectDeps(node, state) {
  const parts = [];
  for (const dep of node.depends_on) {
    const s = state[dep];
    if (!s) continue;
    if (s.status === 'done' && s.output) parts.push(`【${dep}｜${s.title || s.type}】\n${s.output}`);
    else if (s.status === 'failed') parts.push(`【${dep}】上游节点执行失败：${s.error || '未知错误'}`);
    else if (s.status === 'blocked') parts.push(`【${dep}】上游节点被阻断（依赖失败）`);
  }
  return parts.join('\n\n');
}

/**
 * 按图执行：拓扑分层 → 同层并行（并发上限）→ 逐节点超时/重试。
 * 下游节点若存在失败/阻断的上游，则标记为 blocked（不执行），保障状态可解释、可重跑。
 *
 * @param {{nodes:object[]}} graph  已校验的图（validateTaskGraph 的 graph）
 * @param {object} opts
 * @param {function} opts.runAgent   (node, ctx) => string|{text,tokens,costCny}；ctx={input,deps}
 * @param {function} opts.runVerify  (node, ctx) => string|{...}
 * @param {function} [opts.onEvent]  事件回调 {event:'nodeStart'|'nodeDone'|'nodeBlocked', nodeId,type,title,ok,preview}
 * @param {number}   [opts.maxConcurrency]
 * @param {number}   [opts.timeoutMs]
 * @param {function} [opts.onNodeState] (nodeId, state) 每节点状态变化时回调（用于持久化 checkpoint）
 * @returns {{ nodes:object, order:string[], totalTokens:number, totalCostCny:number, totalDurationMs:number, ok:boolean }}
 */
async function runTaskGraph(graph, opts = {}) {
  const { runAgent, runVerify, onEvent, onNodeState } = opts;
  const maxConcurrency = opts.maxConcurrency || MAX_CONCURRENCY;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (typeof runAgent !== 'function') throw new Error('runTaskGraph 需要 runAgent 执行器');

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const state = {};
  for (const n of graph.nodes) {
    state[n.id] = { id: n.id, type: n.type, agent_id: n.agent_id, title: n.title || n.task.slice(0, 20), status: 'pending', output: '', error: '', retries: 0, tokens: 0, costCny: 0, durationMs: 0, startedAt: null };
  }
  const { levels } = planLevels(graph.nodes);
  const t0 = Date.now();
  let totalTokens = 0, totalCostCny = 0;

  const emit = (evt) => { try { onEvent && onEvent(evt); } catch { /* 事件回调失败不影响执行 */ } };
  const setState = (id, patch) => { Object.assign(state[id], patch); try { onNodeState && onNodeState(id, state[id]); } catch { /* checkpoint 失败不影响执行 */ } };

  for (const level of levels) {
    await runPool(level, maxConcurrency, async (id) => {
      const node = nodeMap.get(id);
      // 上游失败/阻断 → 本节点 blocked（不执行，保留可重跑）
      const brokenUp = node.depends_on.find(d => state[d] && (state[d].status === 'failed' || state[d].status === 'blocked'));
      if (brokenUp) {
        setState(id, { status: 'blocked', error: `上游节点 ${brokenUp} 未成功` });
        emit({ event: 'nodeBlocked', nodeId: id, type: node.type, title: state[id].title, reason: `上游 ${brokenUp} 未成功` });
        return;
      }
      const ctx = { input: opts.input, deps: collectDeps(node, state) };
      setState(id, { status: 'running', startedAt: Date.now() });
      emit({ event: 'nodeStart', nodeId: id, type: node.type, title: state[id].title, agent_id: node.agent_id });
      const exec = node.type === 'verify' ? (runVerify || runAgent) : runAgent;
      const nodeT0 = Date.now();
      try {
        const { out, retries } = await withRetry(() => withTimeout(() => exec(node, ctx), timeoutMs, state[id].title), opts.retry ?? 1);
        const norm = normalizeOutcome(out);
        totalTokens += norm.tokens; totalCostCny += norm.costCny;
        setState(id, { status: 'done', output: norm.text, retries, tokens: norm.tokens, costCny: norm.costCny, durationMs: Date.now() - nodeT0 });
        emit({ event: 'nodeDone', nodeId: id, type: node.type, title: state[id].title, ok: true, preview: norm.text.slice(0, 120), retries });
      } catch (e) {
        setState(id, { status: 'failed', error: String(e && e.message || e), retries: e && e.retries || 0, durationMs: Date.now() - nodeT0 });
        emit({ event: 'nodeDone', nodeId: id, type: node.type, title: state[id].title, ok: false, preview: String(e && e.message || e).slice(0, 120) });
      }
    });
  }

  const ok = graph.nodes.every(n => state[n.id].status === 'done');
  return { nodes: state, order: levels.flat(), levels, totalTokens, totalCostCny, totalDurationMs: Date.now() - t0, ok };
}

/**
 * 单节点重跑（失败可重跑单节点）：不改动其他节点，仅重跑指定节点并回写其状态。
 * @param {{nodes:object[]}} graph
 * @param {object} runState     runTaskGraph 返回的 nodes（会被就地更新）
 * @param {string} nodeId
 * @param {object} opts         { runAgent, runVerify, input, timeoutMs, retry, onEvent }
 * @returns {object} 该节点更新后的状态
 */
async function rerunNode(graph, runState, nodeId, opts = {}) {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error(`节点不存在：${nodeId}`);
  const { runAgent, runVerify, onEvent } = opts;
  const exec = node.type === 'verify' ? (runVerify || runAgent) : runAgent;
  const ctx = { input: opts.input, deps: collectDeps(node, runState) };
  const prev = runState[nodeId] || { id: nodeId, type: node.type, title: node.title || '', tokens: 0, costCny: 0 };
  runState[nodeId] = { ...prev, status: 'running', startedAt: Date.now() };
  try { onEvent && onEvent({ event: 'nodeStart', nodeId, type: node.type, title: prev.title, agent_id: node.agent_id, rerun: true }); } catch { }
  const t0 = Date.now();
  try {
    const { out, retries } = await withRetry(() => withTimeout(() => exec(node, ctx), opts.timeoutMs || DEFAULT_TIMEOUT_MS, prev.title), opts.retry ?? 1);
    const norm = normalizeOutcome(out);
    runState[nodeId] = { ...prev, status: 'done', output: norm.text, error: '', retries, tokens: norm.tokens, costCny: norm.costCny, durationMs: Date.now() - t0 };
    try { onEvent && onEvent({ event: 'nodeDone', nodeId, type: node.type, title: prev.title, ok: true, preview: norm.text.slice(0, 120), rerun: true }); } catch { }
  } catch (e) {
    runState[nodeId] = { ...prev, status: 'failed', error: String(e && e.message || e), retries: e && e.retries || 0, durationMs: Date.now() - t0 };
    try { onEvent && onEvent({ event: 'nodeDone', nodeId, type: node.type, title: prev.title, ok: false, preview: String(e && e.message || e).slice(0, 120), rerun: true }); } catch { }
  }
  return runState[nodeId];
}

/** 汇总执行结果用于前端展示 / 归档：节点状态统计 + 并行度 + 耗时/成本。
 *  并行任务占比 = 1 - 串行层数/节点总数（层数越少、同层节点越多 → 并行度越高） */
function summarizeRun(runResult) {
  const list = Object.values(runResult.nodes);
  const done = list.filter(n => n.status === 'done').length;
  const failed = list.filter(n => n.status === 'failed').length;
  const blocked = list.filter(n => n.status === 'blocked').length;
  const total = list.length;
  const levelsCount = Array.isArray(runResult.levels) ? runResult.levels.length : total;
  const parallelRatio = total ? +(1 - levelsCount / total).toFixed(2) : 0;
  return { total, done, failed, blocked, levels: levelsCount, parallelRatio: Math.max(0, parallelRatio), durationMs: runResult.totalDurationMs, tokens: runResult.totalTokens, costCny: +runResult.totalCostCny.toFixed(6) };
}

module.exports = {
  MAX_CONCURRENCY, DEFAULT_TIMEOUT_MS, MAX_RETRY, RETRY_BASE_MS,
  normalizeNode, planLevels, validateTaskGraph,
  runTaskGraph, rerunNode, summarizeRun, collectDeps, normalizeOutcome,
};
