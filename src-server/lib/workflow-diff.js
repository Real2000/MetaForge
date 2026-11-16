/**
 * 工作流（画布 JSON）版本 diff —— C2（2026-11-10 V3.2 收尾计划最后一项）
 *
 * 用途：agent_publish_history 两个版本快照之间、或快照 ↔ 当前草稿 的节点/连线级对比。
 * 画布 JSON 结构（P5.1 V2）：{ nodes:[{id,type,position:{x,y},data:{...}}], edges:[{id,source,target,sourceHandle}] }
 *
 * 设计要点：
 *  - 节点按 id 匹配；连线有 id 用 id，无 id 用 source|target|sourceHandle 组合键（外部导入的 JSON 可能缺 id）
 *  - position 变化不算差异（拖布局无语义，仅影响画布外观）
 *  - 节点差异给字段级明细：data 顶层 key 逐项稳定 stringify 深比较（防 key 顺序不同误判）
 *  - 容错：非对象 / 缺 nodes、edges 数组一律按空处理（不抛异常；损坏快照由接口层提前拦截）
 */

/** 稳定字符串化：对象 key 递归排序后序列化，保证同构不同序的值判定相等 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/** 连线匹配键：优先 id，缺 id 用组合键 */
function edgeKey(e) {
  return e.id || `${e.source || '?'}|${e.target || '?'}|${e.sourceHandle || ''}`;
}

/** 节点展示名：优先 data.label（用户起的节点名），缺失回退 data.name，再回退空串（前端补类型名） */
function nodeLabel(n) {
  return String((n.data && (n.data.label || n.data.name)) || '');
}

/** 规范化 workflow：返回 { nodes: Map(id->node), edges: Map(key->edge) }，容忍损坏结构 */
function norm(wf) {
  const nodes = new Map(), edges = new Map();
  const o = wf && typeof wf === 'object' ? wf : {};
  for (const n of Array.isArray(o.nodes) ? o.nodes : []) {
    if (n && typeof n === 'object' && n.id != null) nodes.set(String(n.id), n);
  }
  for (const e of Array.isArray(o.edges) ? o.edges : []) {
    if (e && typeof e === 'object') edges.set(edgeKey(e), e);
  }
  return { nodes, edges };
}

/** 节点 data 顶层字段级对比（from/to 为可展示原始值；深对象给稳定 JSON 串） */
function diffNodeData(aData, bData) {
  const a = aData && typeof aData === 'object' ? aData : {};
  const b = bData && typeof bData === 'object' ? bData : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const fields = [];
  for (const k of keys) {
    const sa = stable(a[k] ?? null), sb = stable(b[k] ?? null);
    if (sa !== sb) fields.push({ key: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return fields;
}

/**
 * 对比两份画布 JSON。
 * @returns {{
 *   nodes: { added: Array, removed: Array, changed: Array },
 *   edges: { added: Array, removed: Array, changed: Array },
 *   summary: { nodesAdded, nodesRemoved, nodesChanged, fieldsChanged, edgesAdded, edgesRemoved, edgesChanged, total }
 * }}
 */
function diffWorkflows(a, b) {
  const A = norm(a), B = norm(b);

  const nodes = { added: [], removed: [], changed: [] };
  for (const [id, nb] of B.nodes) {
    // U1-7：added 携带完整 node 对象（node 字段，纯增量兼容）——实时协作接收方按 diff 即可重建画布，无需再拉全量
    if (!A.nodes.has(id)) nodes.added.push({ id, type: nb.type || '', label: nodeLabel(nb), node: nb });
  }
  for (const [id, na] of A.nodes) {
    const nb = B.nodes.get(id);
    if (!nb) { nodes.removed.push({ id, type: na.type || '', label: nodeLabel(na) }); continue; }
    const fields = diffNodeData(na.data, nb.data);
    if (fields.length) nodes.changed.push({ id, type: nb.type || '', label: nodeLabel(nb) || nodeLabel(na), fields });
  }

  const edges = { added: [], removed: [], changed: [] };
  const edgeBrief = e => ({ key: edgeKey(e), source: e.source || '', target: e.target || '', sourceHandle: e.sourceHandle || '' });
  for (const [k, eb] of B.edges) {
    // U1-7：added 携带完整 edge 对象（edge 字段，纯增量兼容）
    if (!A.edges.has(k)) edges.added.push({ ...edgeBrief(eb), edge: eb });
  }
  for (const [k, ea] of A.edges) {
    const eb = B.edges.get(k);
    if (!eb) { edges.removed.push(edgeBrief(ea)); continue; }
    // 组合键命中的连线仍可能内容不同（如带 id 连线改了 source/target）；逐字段比较
    const fields = diffNodeData(ea, eb);
    if (fields.length) edges.changed.push({ ...edgeBrief(eb), fields });
  }

  const fieldsChanged = nodes.changed.reduce((s, n) => s + n.fields.length, 0);
  const summary = {
    nodesAdded: nodes.added.length,
    nodesRemoved: nodes.removed.length,
    nodesChanged: nodes.changed.length,
    fieldsChanged,
    edgesAdded: edges.added.length,
    edgesRemoved: edges.removed.length,
    edgesChanged: edges.changed.length,
  };
  summary.total = summary.nodesAdded + summary.nodesRemoved + summary.nodesChanged
    + summary.edgesAdded + summary.edgesRemoved + summary.edgesChanged;
  return { nodes, edges, summary };
}

module.exports = { diffWorkflows, stable, edgeKey };
