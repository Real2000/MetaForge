/**
 * 画布工作流数据模型 V2（2026-10-22 P5.1，按用户规范重构）
 *
 * 结构：
 * {
 *   nodes: [ { id:"node_2", type:"start|llm|tool|agent|if-else|end", position:{x,y}, data:{...} } ],
 *   edges: [ { id:"e_1", source:"node_2", target:"node_3", sourceHandle:"out"|"分支名" } ],
 *   viewport: { x, y, zoom }
 * }
 *
 * 关键设计（用户规范）：
 * - 变量引用统一 {{#nodeId.variableName#}}（跨节点引用无歧义，取代 V1 的 {{input}}/{{n2}}/{{vars.x}} 混用）
 * - 每个节点 data 内声明输出变量 schema（名字+类型），下游引用可校验
 * - position 存画布坐标，刷新不丢布局
 *
 * 各节点 data 结构与输出变量：
 * - start:   { title, variables:[{name,type,label,default,required}] }                → 输出：input（用户消息）+ 每个自定义变量
 * - llm:     { title, model, system_prompt, prompt, max_tokens, temperature,
 *             output_schema(结构化输出 JSON Schema), context:{use_history,rounds} }   → 输出：text（+ 结构化输出各字段）
 * * - tool:    { title, toolId, args(JSON 字符串，值可含模板), _fields(试运行发现的字段清单) } → 输出：result（+ _fields 各字段，P5.6）
 * - agent:   { title, agentId, input(模板) }                                          → 输出：reply
 * - code:    { title, code(JS 函数体), inputs(JSON:变量名→模板引用), timeout }         → 输出：output（+ return 对象各字段）
 * - iteration: { title, input(数组模板), subflow:{nodes,edges}(子流程图) }            → 输出：results（逐条结果数组）+ count
 * - assign: { title, assignments:[{variable,value,operator:set|append|clear}] }      → 输出：各 assignment.variable
 * - if-else: { title, cases:[{label,isFallback,conditions:[{variable,type,value}],logical}] }
 *           → 输出：branch（命中分支名）；操作符：equals/not_equals/contains/not_contains/starts_with/gt/gte/lt/lte/is_empty/not_empty/regex
 * - end:     { title, outputs:[{variable,value}] }                                    → 输出：首个 variable 为对话回复
 *
 * AI-08（2026-11-23）工作流知识库检索节点：
 * - knowledge: { title, kb_id, query(模板，默认 {{#start.input#}}), top_n(1~50，默认 5),
 *               threshold(相似度阈值，空=0.01), rerank_enabled(''=沿用库级|'on'|'off'),
 *               rerank_model(''=默认), metadata_filter(JSON，AND 语义，同 agents.kb_metadata_filter),
 *               rewrite(true=多轮改写，默认 true) }
 *           → 输出：chunks（命中片段数组：file/kb/score/bm25/vec/rerank_score/content）
 *                   + text（拼接上下文，可直接嵌入下游 LLM prompt）+ count（命中条数）
 *
 * P5.6 新增（体验进阶）：
 * - answer:    { title, text(模板) }                        → 输出：text（Chatflow 直接回复：执行时即时回传，流程继续）
 * - classifier: { title, categories:[{name}], instruction, model } → 输出：class_name + branch（LLM 分类，出边 sourceHandle=类别名/default，分支机制同 if-else）
 * - aggregator: { title, sources:[{variable:模板引用}], mode:first|array } → 输出：output（first=第一个非空 / array=数组拼接，另出 array 变量）
 * 根字段：{ nodes, edges, viewport, flow_type: 'workflow'|'chatflow', groups:[{id,name,color,nodeIds,collapsed}], notes:[{id,x,y,w,h,text,color}] }（P5.6 分组 / P5.15 便签）
 */

// 各节点类型的静态输出变量（动态部分由 getNodeOutputs 计算：llm schema 字段 / assign 变量 / code.return 字段）
const NODE_OUTPUT_SCHEMA = {
  start:   [{ name: 'input', type: 'string', label: '用户消息' }],
  llm:     [{ name: 'text', type: 'string', label: '模型回复' }],
  tool:    [{ name: 'result', type: 'string', label: '工具结果' }],
  agent:   [{ name: 'reply', type: 'string', label: '子智能体回复' }],
  code:    [{ name: 'output', type: 'string', label: '代码返回值' }],
  iteration: [{ name: 'results', type: 'array', label: '逐条结果数组' }, { name: 'count', type: 'number', label: '条目数' }],
  assign:  [],
  'if-else': [{ name: 'branch', type: 'string', label: '命中分支名' }],
  answer:  [{ name: 'text', type: 'string', label: '直接回复内容' }],
  classifier: [{ name: 'class_name', type: 'string', label: '命中类别名' }, { name: 'branch', type: 'string', label: '命中分支名' }],
  aggregator: [{ name: 'output', type: 'string', label: '聚合值（首个非空）' }, { name: 'array', type: 'array', label: '数组模式拼接结果' }],
  knowledge: [{ name: 'chunks', type: 'array', label: '命中片段数组（file/kb/score/rerank_score/content）' }, { name: 'text', type: 'string', label: '拼接上下文（可直接嵌入 LLM prompt）' }, { name: 'count', type: 'number', label: '命中条数' }],
  end:     [],
};

// 分支条件操作符清单（P1 升级：10 种）
const OPERATORS = {
  equals:      { label: '等于', arity: 1 },
  not_equals:  { label: '不等于', arity: 1 },
  contains:    { label: '包含', arity: 1 },
  not_contains: { label: '不包含', arity: 1 },
  starts_with: { label: '以…开头', arity: 1 },
  gt:          { label: '大于', arity: 1, numeric: true },
  gte:         { label: '大于等于', arity: 1, numeric: true },
  lt:          { label: '小于', arity: 1, numeric: true },
  lte:         { label: '小于等于', arity: 1, numeric: true },
  is_empty:    { label: '为空', arity: 0 },
  not_empty:   { label: '不为空', arity: 0 },
  regex:       { label: '正则匹配', arity: 1 },
};

/**
 * 计算节点实际输出变量（静态 schema + 动态部分）：
 * - llm 配了 output_schema → schema 各字段名成输出变量
 * - assign → assignments[].variable 成输出变量
 * - code → return 对象无法静态分析，静态给 output；若 data.outputs 显式声明则一并列出
 * - start → input + data.variables
 */
function getNodeOutputs(node) {
  const base = NODE_OUTPUT_SCHEMA[node.type] || [];
  const d = node.data || {};
  const out = [...base];
  // P5.11：画了 __error__ 出边的节点暴露 {{#节点.__error__#}}（失败原因；成功时无值不渲染）——checkRefs/变量选择器合法
  if (node.type !== 'start' && d.has_error_edge) out.push({ name: '__error__', type: 'string', label: '失败原因（⚡异常分支）' });
  if (node.type === 'start') {
    // P5.14 文件一等变量：file/array[file] 类型在变量选择器/校验侧带 📄 标识（引用语义同普通变量，运行时自动注入内容）
    for (const v of d.variables || []) if (v.name) {
      const isFile = v.type === 'file' || v.type === 'array[file]';
      out.push({ name: v.name, type: v.type || 'string', label: v.label || v.name + (isFile ? '（📄文件）' : '') });
    }
    // P5.7 会话变量（跨轮次持久）：{{#start.名称#}} 引用，assign 用 session.名称 写入
    for (const v of d.session_vars || []) if (v.name) out.push({ name: String(v.name), type: 'string', label: `${v.name}（会话变量💾）` });
  }
  if (node.type === 'llm' && d.output_schema) {
    let schema = d.output_schema;
    if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { schema = null; } }
    const props = schema?.properties || (schema && typeof schema === 'object' && !schema.properties ? schema : null);
    if (props && typeof props === 'object') {
      for (const k of Object.keys(props)) out.push({ name: k, type: props[k]?.type || 'string', label: `${k}（结构化）` });
    }
  }
  if (node.type === 'assign') {
    for (const a of d.assignments || []) if (a.variable) out.push({ name: a.variable, type: 'string', label: `${a.variable}（赋值）` });
  }
  if (node.type === 'code' && Array.isArray(d.outputs)) {
    for (const k of d.outputs) out.push({ name: String(k), type: 'string', label: `${k}（代码字段）` });
  }
  // P5.6 工具节点动态字段：试运行后写入 data._fields（顶层 JSON 键扁平化成输出变量，下游可 {{#node.field#}} 直引）
  if (node.type === 'tool' && Array.isArray(d._fields)) {
    for (const k of d._fields) out.push({ name: String(k), type: 'string', label: `${k}（工具字段）` });
  }
  return out;
}

// V1 type → V2 type 映射
const TYPE_MAP = { start: 'start', llm: 'llm', tool: 'tool', agent: 'agent', branch: 'if-else', output: 'end' };

// P0-1 修复 2026-11-09：服务端节点类型白名单——原实现对未知类型"保留原值"直接放行（注释称
// "Runner 落节点失败日志"，但保存成功的图可被运行测试/对话/定时/MCP/Webhook 链路真实执行；
// 未来若新增同名执行器或存量图携带未注册类型，即成直通后门）。保存入口改为白名单强校验：
// 白名单 = NODE_OUTPUT_SCHEMA 已建模类型 + Runner NODE_EXECUTORS 注册的扩展执行器类型。
// 扩展类型以静态清单维护（不 require workflow.js——db.js 启动期即加载本模块，
// workflow→db→workflow-schema→workflow 会构成加载环），与 NODE_EXECUTORS 的 keys 一一对应，
// 新增执行器时须同步登记（smoke 有回归用例锁定清单不漂移）。
const EXT_EXECUTOR_TYPES = [
  'http_request', 'code_sandbox', 'condition_loop', 'variable_assign',
  'notification', 'database_query', 'delay', 'logger', 'transform',
  'knowledge', // AI-08（2026-11-23）：工作流知识库检索节点（画布一等节点）
];
const ALLOWED_NODE_TYPES = new Set([...Object.keys(NODE_OUTPUT_SCHEMA), 'tool', ...EXT_EXECUTOR_TYPES]);

/** V1→V2 单节点 config 转换 */
function convertConfigV1(type, config) {
  const c = config || {};
  switch (type) {
    case 'start':
      return { title: '开始（输入）', variables: (c.vars || []).map(v => ({ name: v.name, type: 'string', label: v.name, default: v.default || '', required: false })) };
    case 'llm':
      return { title: '大模型', model: c.model || '', system_prompt: '', prompt: c.prompt || '', max_tokens: c.maxReply || 1024, temperature: c.temperature ?? 0.7 };
    case 'tool':
      return { title: '工具', toolId: c.toolId || 'web_search', args: c.args || '{}' };
    case 'agent':
      return { title: '子智能体', agentId: String(c.agentId || ''), input: c.input || '{{#start.input#}}' };
    case 'branch':
      return { title: '判断分支', cases: (c.rules || []).map(r => ({
        label: r.label || '分支',
        conditions: [{ variable: r.source || 'input', type: r.type === 'nonempty' ? 'nonempty' : 'contains', value: r.value || '' }],
        logical: 'AND',
      })) };
    case 'output':
      return { title: '输出（结束）', outputs: [{ variable: 'result', value: c.template || '{{input}}' }] };
    default:
      return { ...c };
  }
}

/** V1 模板 → V2 模板：{{input}}→{{#start.input#}}、{{n1}}→{{#start.input#}}（start 节点）、{{n2}}→{{#node_2.text#}}、{{vars.x}}→{{#start.x#}} */
function convertTemplateV1(tpl, idMap) {
  return String(tpl || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key) => {
    const k = key.trim();
    if (k === 'input') return '{{#start.input#}}';
    const nm = k.match(/^n(\d+)$/) || k.match(/^node(\d+)$/);
    if (nm) {
      const nid = idMap[Number(nm[1])];
      if (nid) return `{{#${nid === 'start' ? nid + '.input' : nid + '.text'}#}}`;
      return m;
    }
    if (k.startsWith('vars.')) return '{{#start.' + k.slice(5) + '#}}';
    return m;
  });
}

/**
 * V1 workflow → V2 workflow 整体迁移
 * V1: {nodes:[{id:number,type,x,y,config}], edges:[{from,to,branch}], viewport}
 */
function migrateWorkflowData(wf) {
  if (!wf || !Array.isArray(wf.nodes)) return null;
  // V2 判定：节点带 position 字段或无 config 字段
  if (wf.nodes.length && wf.nodes[0].position !== undefined && wf.nodes[0].config === undefined) return wf;
  const idMap = {};
  for (const n of wf.nodes) idMap[Number(n.id)] = 'node_' + n.id;
  const nodes = wf.nodes.map(n => {
    const v2Type = TYPE_MAP[n.type] || n.type;
    const data = convertConfigV1(n.type, n.config);
    return { id: 'node_' + n.id, type: v2Type, position: { x: n.x || 0, y: n.y || 0 }, data };
  });
  // start 节点统一重命名为 "start"（DAG Runner 以 type=start 定位；模板引用同步映射）
  const startIdx = nodes.findIndex(n => n.type === 'start');
  if (startIdx >= 0 && nodes[startIdx].id !== 'start') {
    const oldId = nodes[startIdx].id;
    nodes[startIdx].id = 'start';
    for (const k of Object.keys(idMap)) if (idMap[k] === oldId) idMap[k] = 'start';
  }
  const edges = (wf.edges || []).map((e, i) => ({
    id: 'e_' + (i + 1),
    source: idMap[e.from] || String(e.from),
    target: idMap[e.to] || String(e.to),
    sourceHandle: e.branch || 'out',
  }));
  // 节点内模板字段统一转换（idMap 已含 start 重命名）
  for (const n of nodes) {
    const d = n.data;
    if (n.type === 'llm' && d.prompt) d.prompt = convertTemplateV1(d.prompt, idMap);
    if (n.type === 'tool' && d.args) d.args = convertTemplateV1(d.args, idMap);
    if (n.type === 'agent' && d.input) d.input = convertTemplateV1(d.input, idMap);
    if (n.type === 'end' && Array.isArray(d.outputs)) d.outputs.forEach(o => { o.value = convertTemplateV1(String(o.value ?? ''), idMap); });
  }
  return { nodes, edges, viewport: wf.viewport || { x: 60, y: 40, zoom: 1 } };
}

/**
 * V2 结构校验与规范化（保存入口；失败返回 {error}）
 * 限制：≤100 节点 / ≤200 边 / 必须有 start / end 可选（无 end 时以 start 输出兜底）
 */
function validateWorkflowV2(w) {
  if (w == null || w === '') return null;
  if (typeof w === 'string') { try { w = JSON.parse(w); } catch { return { error: 'workflow 不是合法 JSON' }; } }
  if (typeof w !== 'object' || !Array.isArray(w.nodes) || !Array.isArray(w.edges)) return { error: 'workflow 缺少 nodes/edges 数组' };
  if (w.nodes.length > 100) return { error: '节点数超限（≤100）' };
  if (w.edges.length > 200) return { error: '连线数超限（≤200）' };
  const ids = new Set();
  const nodes = w.nodes.map((n, i) => {
    const id = String(n.id || '').trim().slice(0, 24) || `node_${i + 1}`;
    if (ids.has(id)) return { error: `节点 id 重复：${id}` };
    ids.add(id);
    const type = TYPE_MAP[n.type] || String(n.type || '').slice(0, 20);
    // P0-1：未知/未注册节点类型拒绝（原"保留原值"放行 → 恶意/拼错类型可混入保存图，见 ALLOWED_NODE_TYPES 注释）
    if (!ALLOWED_NODE_TYPES.has(type)) return { error: `不支持的节点类型：${type}` };
    return {
      id,
      type,
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
      data: (n.data && typeof n.data === 'object') ? n.data : {},
    };
  }).filter(n => !n.error);
  if (!nodes.some(n => n.type === 'start')) return { error: '缺少开始（start）节点' };
  // P5.12：从边推导 has_error_edge 标记（有 __error__ 出边的节点暴露 {{#节点.__error__#}} 变量，getNodeOutputs 用）
  for (const e of (w.edges || [])) {
    if ((e.sourceHandle || 'out') !== '__error__') continue;
    const src = nodes.find(n => n.id === String(e.source || '').trim());
    if (src && src.type !== 'start') src.data.has_error_edge = true;
  }
  const edges = w.edges.slice(0, 200).map((e, i) => {
    const source = String(e.source || '').slice(0, 24), target = String(e.target || '').slice(0, 24);
    if (!ids.has(source) || !ids.has(target) || source === target) return null;
    return { id: String(e.id || `e_${i + 1}`).slice(0, 16), source, target, sourceHandle: String(e.sourceHandle || 'out').slice(0, 30) };
  }).filter(Boolean);
  // P5.6 根字段：flow_type（Workflow/Chatflow 双模式）+ groups（节点分组）——规范化并透传
  const flow_type = w.flow_type === 'chatflow' ? 'chatflow' : 'workflow';
  const groups = Array.isArray(w.groups) ? w.groups.slice(0, 30).map((g, i) => ({
    id: String(g.id || `grp_${i + 1}`).slice(0, 24),
    name: String(g.name || '分组').slice(0, 30),
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(g.color)) ? g.color : '#3b82f6',
    nodeIds: Array.isArray(g.nodeIds) ? g.nodeIds.map(String).filter(x => ids.has(x)).slice(0, 100) : [],
    collapsed: !!g.collapsed,
  })).filter(g => g.nodeIds.length) : [];
  return { nodes, edges, viewport: { x: Number(w.viewport?.x) || 0, y: Number(w.viewport?.y) || 0, zoom: Number(w.viewport?.zoom) || 1 }, flow_type, groups,
    // P5.15 画布便签：纯前端注释（执行引擎不感知），随图持久化——双击空白创建，颜色/尺寸规范化
    notes: Array.isArray(w.notes) ? w.notes.slice(0, 30).map((n, i) => ({
      id: String(n.id || `note_${i + 1}`).slice(0, 24),
      x: Number(n.x) || 0, y: Number(n.y) || 0,
      w: Math.max(120, Math.min(480, Number(n.w) || 200)), h: Math.max(80, Math.min(400, Number(n.h) || 140)),
      text: String(n.text || '').slice(0, 2000),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(n.color)) ? n.color : '#fef08a',
    })) : [] };
}

/** 提取模板中全部 {{#node.var#}} 引用（供引用存在性校验） */
function extractRefs(tpl) {
  const out = [];
  // P5.12 修复：引用正则支持中文节点 id/变量名（与 Runner render 同步；\w 不含中文）
  String(tpl || '').replace(/\{\{\s*#\s*([\w\u4e00-\u9fa5.-]+)\s*#\s*\}\}/g, (m, ref) => { out.push(ref); return m; });
  return out;
}

/** 校验图内全部引用：返回 [{nodeId, ref, exists:false, msg}]（空数组=全部合法）；使用 getNodeOutputs 动态变量全集 */
function checkRefs(wf) {
  const vars = new Set(); // node.var 全集
  for (const n of wf.nodes || []) {
    for (const o of getNodeOutputs(n)) vars.add(`${n.id}.${o.name}`);
  }
  const problems = [];
  for (const n of wf.nodes || []) {
    const texts = [];
    if (n.type === 'llm') texts.push(n.data?.prompt, n.data?.system_prompt);
    if (n.type === 'tool') texts.push(n.data?.args);
    if (n.type === 'agent') texts.push(n.data?.input);
    if (n.type === 'code') texts.push(...Object.values(n.data?.inputs || {}));
    if (n.type === 'iteration') texts.push(n.data?.input);
    if (n.type === 'assign') texts.push(...(n.data?.assignments || []).map(a => a.value));
    if (n.type === 'answer') texts.push(n.data?.text);
    if (n.type === 'aggregator') texts.push(...(n.data?.sources || []).map(s => s.variable));
    if (n.type === 'knowledge') texts.push(n.data?.query); // AI-08：检索查询模板可引用上游变量
    if (n.type === 'end') texts.push(...(n.data?.outputs || []).map(o => o.value));
    // 迭代子流程内的引用也校验（item/index 特殊变量放行）
    if (n.type === 'iteration' && n.data?.subflow?.nodes) {
      for (const sn of n.data.subflow.nodes) {
        const stexts = [];
        if (sn.type === 'llm') stexts.push(sn.data?.prompt, sn.data?.system_prompt);
        if (sn.type === 'tool') stexts.push(sn.data?.args);
        if (sn.type === 'agent') stexts.push(sn.data?.input);
        if (sn.type === 'end') stexts.push(...(sn.data?.outputs || []).map(o => o.value));
        for (const t of stexts) {
          for (const ref of extractRefs(t)) {
            if (ref === 'item' || ref === 'index') continue; // 迭代特殊变量
            if (!vars.has(ref) && !/^\w+\.(item|index)$/.test(ref)) problems.push({ nodeId: n.id, ref, exists: false, msg: `子流程引用了不存在的变量 {{#${ref}#}}` });
          }
          // 子流程短引用 {{item}}/{{index}}
          String(t || '').replace(/\{\{\s*(item|index|input)\s*\}\}/g, () => { return ''; });
        }
      }
    }
    for (const t of texts) {
      for (const ref of extractRefs(t)) {
        if (!vars.has(ref)) problems.push({ nodeId: n.id, ref, exists: false, msg: `引用了不存在的变量 {{#${ref}#}}` });
      }
    }
  }
  return problems;
}

module.exports = { NODE_OUTPUT_SCHEMA, OPERATORS, TYPE_MAP, getNodeOutputs, migrateWorkflowData, convertTemplateV1, validateWorkflowV2, extractRefs, checkRefs, ALLOWED_NODE_TYPES };
