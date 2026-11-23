/**
 * 画布工作流引擎（2026-10-22 P5.1 数据模型 V2：按用户规范重构）
 * 布局：左侧节点库（基础组件/平台工具/子智能体）· 中间点阵画布（拖放/平移/缩放/贝塞尔连线）· 右侧属性面板
 * 对外接口：createCanvas(root, opts) → { getWorkflow, setWorkflow, destroy }
 *   opts: { initial(wf 对象), models(模型清单), agents(其它智能体[{id,name,icon}]), agentId, markDirty(fn) }
 * V2 数据：{nodes:[{id:"node_N"|"start",type,position:{x,y},data}],edges:[{id,source,target,sourceHandle}],viewport}
 * 变量引用统一 {{#nodeId.variableName#}}（如 {{#start.input#}}、{{#node_3.text#}}）；属性面板提供变量选择器下拉插入
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

// 节点类型注册表（V2 type 名：start/llm/tool/agent/if-else/end + P5.2：code/iteration/assign）
export const NODE_TYPES = {
  start:   { icon: '🟦', color: '#1d4ed8', label: t('开始（输入）'), def: { title: t('开始（输入）'), variables: [], session_vars: [] } },
  llm:     { icon: '🟣', color: '#7c3aed', label: t('大模型'), def: { title: t('大模型'), model: '', system_prompt: '', prompt: '', max_tokens: 1024, temperature: 0.7, output_schema: '', context: { use_history: false, rounds: 3 } } },
  tool:    { icon: '🟠', color: '#ea580c', label: t('工具'), def: { title: t('工具'), toolId: 'web_search', args: '{}' } },
  agent:   { icon: '🧠', color: '#0284c7', label: t('子智能体'), def: { title: t('子智能体'), agentId: '', input: '{{#start.input#}}' } },
  code:    { icon: '⌨️', color: '#0891b2', label: t('代码'), def: { title: t('代码'), code: 'return input;', inputs: '{"input":"{{#start.input#}}"}', timeout: 3000 } },
  iteration: { icon: '🔁', color: '#16a34a', label: t('列表迭代'), def: { title: t('列表迭代'), input: '[]', subflow: null } },
  assign:  { icon: '💱', color: '#9333ea', label: t('变量赋值'), def: { title: t('变量赋值'), assignments: [{ variable: '', value: '', operator: 'set' }] } },
  'if-else': { icon: '🟡', color: '#d97706', label: t('判断分支'), def: { title: t('判断分支'), cases: [
    { label: 'IF', conditions: [{ variable: 'start.input', type: 'contains', value: '' }], logical: 'AND' },
    { label: 'ELSE', isFallback: true, conditions: [] },
  ] } },
  // P5.6 体验进阶三节点
  answer:  { icon: '💬', color: '#2563eb', label: t('直接回复'), def: { title: t('直接回复'), text: '{{#start.input#}}' } },
  classifier: { icon: '🎯', color: '#c026d3', label: t('问题分类器'), def: { title: t('问题分类器'), categories: [{ name: t('闲聊') }, { name: t('业务咨询') }], instruction: '', model: '' } },
  aggregator: { icon: '🔀', color: '#0d9488', label: t('变量聚合器'), def: { title: t('变量聚合器'), sources: [{ variable: '' }], mode: 'first' } },
  knowledge: { icon: '📚', color: '#059669', label: t('知识库检索'), def: { title: t('知识库检索'), kb_id: '', query: '{{#start.input#}}', top_n: 5, threshold: '', rerank_enabled: '', rerank_model: '', metadata_filter: '', rewrite: true } },
  end:     { icon: '🟥', color: '#dc2626', label: t('输出（结束）'), def: { title: t('输出（结束）'), outputs: [{ variable: 'result', value: '{{#start.input#}}' }] } },
};

// 各节点类型的静态输出变量（动态部分由 allVars 计算）；与后端 NODE_OUTPUT_SCHEMA 对齐
export const NODE_OUTPUTS = {
  start: [{ name: 'input', label: t('用户消息') }],
  llm: [{ name: 'text', label: t('模型回复') }],
  tool: [{ name: 'result', label: t('工具结果') }],
  agent: [{ name: 'reply', label: t('子智能体回复') }],
  code: [{ name: 'output', label: t('代码返回值') }],
  iteration: [{ name: 'results', label: t('逐条结果数组') }, { name: 'count', label: t('条目数') }],
  assign: [],
  'if-else': [{ name: 'branch', label: t('命中分支名') }],
  answer: [{ name: 'text', label: t('直接回复内容') }],
  classifier: [{ name: 'class_name', label: t('命中类别名') }, { name: 'branch', label: t('命中分支名') }],
  aggregator: [{ name: 'output', label: t('聚合值（首个非空）') }, { name: 'array', label: t('数组拼接结果') }],
  knowledge: [{ name: 'chunks', label: t('命中片段数组') }, { name: 'text', label: t('拼接上下文（可直接嵌入 LLM 提示词）') }, { name: 'count', label: t('命中条数') }],
  end: [],
};

// 分支操作符（P1：与后端 OPERATORS 对齐）
export const OPERATORS = [
  ['equals', t('等于')], ['not_equals', t('不等于')], ['contains', t('包含')], ['not_contains', t('不包含')],
  ['starts_with', t('以…开头')], ['gt', t('大于')], ['gte', t('大于等于')], ['lt', t('小于')], ['lte', t('小于等于')],
  ['is_empty', t('为空')], ['not_empty', t('不为空')], ['regex', t('正则匹配')],
];
const NO_VALUE_OPS = new Set(['is_empty', 'not_empty']); // 无需值输入的操作符

// 平台工具节点清单（与 TOOL_META 对齐；tool 节点下拉用）
export const TOOL_OPTIONS = [
  ['web_search', '🌐', t('联网搜索')], ['web_fetch', '🔗', t('网页抓取')], ['get_datetime', '🕐', t('时间查询')],
  ['calculator', '🧮', t('精确计算')], ['image_gen', '🎨', t('文生图')], ['tts', '🔊', t('语音合成')],
  ['kb_search', '📚', t('知识库检索')], ['db_query', '🗃️', t('Text2SQL')], ['db_chart', '📊', t('数据图表')],
  ['stock_quote', '💵', t('股票行情')], ['export_word', '📄', t('Word 导出')], ['doc_review', '🔍', t('文档评审')],
];

export function createCanvas(root, opts = {}) {
  // P5.18 模型透明化：兼容两种传参（旧：字符串数组 / 新：{name,type} 对象数组）——
  // LLM 节点仅对话模型可选，但全部模型分组可见（生图/视频/语音标注用途去向，不再"凭空消失"）
  let models = (opts.models || []).map(m => (typeof m === 'string' ? { name: m, type: 'chat' } : m));
  const TYPE_TAG = { image: t('🎨 生图'), video: t('🎬 视频'), tts: t('🎙️ 语音'), embedding: t('🧠 嵌入') };
  const TYPE_GUIDE = { image: t('用「文生图」工具节点'), video: t('画布暂无视频节点——用前台视频创作模式'), tts: t('用「语音合成」工具节点'), embedding: t('知识库检索用（不出现在对话下拉）') };
  function modelOptions(sel) {
    const chats = models.filter(m => (m.type || 'chat') === 'chat');
    const others = models.filter(m => (m.type || 'chat') !== 'chat');
    return `<option value="">${t('跟随智能体默认')}</option>` +
      (chats.length ? `<optgroup label="💬 ${t('对话模型（本节点可用）')}">${chats.map(m => `<option value="${esc(m.name)}" ${sel === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>` : '') +
      (others.length ? `<optgroup label="${t('其他类型模型（本节点不可用）')}">${others.map(m => `<option disabled>⛔ ${esc(m.name)} · ${TYPE_TAG[m.type] || m.type}${TYPE_GUIDE[m.type] ? '——' + t(TYPE_GUIDE[m.type]) : ''}</option>`).join('')}</optgroup>` : '');
  }
  let agents = opts.agents || [];
  let kbs = opts.kbs || []; // AI-08：知识检索节点下拉数据源（studio 传入当前用户可见库清单）
  let wf = opts.initial && Array.isArray(opts.initial.nodes) ? JSON.parse(JSON.stringify(opts.initial)) : { nodes: [], edges: [], viewport: { x: 60, y: 40, zoom: 1 } };
  // 容错兜底：外部造数/导入的 JSON 可能缺 viewport（正常保存链路经 validateWorkflowV2 会补），缺失会使 applyViewport 崩掉整页
  if (!wf.viewport || typeof wf.viewport !== 'object') wf.viewport = { x: 60, y: 40, zoom: 1 };
  // P5.6 根字段规范化：flow_type（Workflow/Chatflow 双模式）+ groups（节点分组）+ notes（P5.15 便签，纯注释）
  if (wf.flow_type !== 'chatflow') wf.flow_type = 'workflow';
  if (!Array.isArray(wf.groups)) wf.groups = [];
  if (!Array.isArray(wf.notes)) wf.notes = [];
  let selSet = null;      // P5.6 橡皮筋多选（Set<nodeId>，仅用于建分组）
  let searchDim = null;   // P5.6 Ctrl+F 搜索态（Set<匹配nodeId>；null=未搜索）
  // 当前坏引用集合（节点 id → refs[]，删除节点后计算，renderNodes/renderProp/小地图标红）——
  // 必须在首次 applyViewport()（>10 节点时触发 renderMinimap 读此表）之前声明，避免 TDZ 崩溃
  let refWarnings = {};
  let validationProblems = null; // P5.12：Map<nodeId, problems[]>（保存/校验时填充，画布渲染角标）
  let seq = (wf.nodes || []).reduce((m, n) => { const num = Number(String(n.id).replace(/^node_/, '')); return Math.max(m, Number.isFinite(num) ? num : 0); }, 0);
  let sel = null;          // 选中节点 id 或 {edge: index}
  let cb = null;           // onChange 回调
  // P5.3 调试可视化：运行状态（nodeId → {status, ms, error, inputs, outputFull}）与上次运行缓存（重跑用）
  let runState = {};
  let lastRun = null;      // { input, results }
  let propTab = 'config';  // 属性面板当前 tab：config | result

  // ---------- DOM 骨架 ----------
  root.innerHTML = `
  <style>
    .cv-wrap{display:flex;height:100%;min-height:0;background:var(--bg,#f5f7fb);font-size:13px}
    .cv-lib{width:216px;flex-shrink:0;background:var(--card,#fff);border-right:1px solid var(--border,#e5e7eb);overflow-y:auto;padding:10px 0}
    .cv-lib .grp{margin:6px 12px 4px;font-size:11px;color:var(--text-3,#9ca3af);letter-spacing:1px;font-weight:600}
    .cv-lib .card{display:flex;align-items:center;gap:8px;margin:4px 10px;padding:8px 10px;border-radius:8px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);cursor:grab;user-select:none;transition:.12s}
    .cv-lib .card:hover{border-color:var(--brand,#2563eb);box-shadow:0 2px 8px rgba(37,99,235,.12)}
    .cv-lib .card:active{cursor:grabbing}
    .cv-lib .card .ic{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;flex-shrink:0}
    .cv-lib .card .nm{font-size:12.5px;color:var(--text,#374151);line-height:1.25}
    .cv-lib .card .nm small{display:block;font-size:10.5px;color:var(--text-3,#9ca3af)}
    .cv-stage{flex:1;position:relative;overflow:hidden;background:var(--bg,#f9fafb);cursor:default}
    .cv-stage.panning{cursor:grabbing}
    .cv-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
    .cv-dots{position:absolute;inset:-2000px;background-image:radial-gradient(var(--border,#d7dce3) 1px,transparent 1px);background-size:22px 22px;pointer-events:none}
    .cv-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
    .cv-svg path{pointer-events:stroke}
    .cv-node{position:absolute;width:212px;background:var(--card,#fff);border:1px solid var(--border,#d1d5db);border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.06);user-select:none}
    .cv-node.sel{border-color:var(--brand,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
    /* P5.3 调试可视化：节点运行状态 */
    .cv-node.running{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18);animation:cvpulse 1.2s ease-in-out infinite}
    .cv-node.success{border-color:#059669;box-shadow:0 0 0 2px rgba(5,150,105,.12)}
    .cv-node.error{border-color:#dc2626;box-shadow:0 0 0 2px rgba(220,38,38,.12)}
    .cv-node.skipped{opacity:.5}
    .cv-node.preset{opacity:.75;border-style:dashed}
    .cv-status{padding:4px 10px 6px;border-top:1px dashed var(--border,#eef0f3);font-size:10.5px;display:flex;gap:6px;align-items:center;min-height:18px;color:var(--text-2,#6b7280)}
    .cv-status .err{color:#dc2626;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .cv-spin{width:11px;height:11px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:cvspin .8s linear infinite;flex-shrink:0}
    /* P5.10 流式调试：LLM 节点逐字预览（尾部跟随；JS 侧 scrollLeft 对齐右端） */
    .cv-stream{color:var(--text-2,#6b7280);flex:1;overflow-x:auto;white-space:nowrap;max-height:18px;line-height:18px;font-size:10.5px}::-webkit-scrollbar{height:0}
    @keyframes cvspin{to{transform:rotate(360deg)}}
    @keyframes cvpulse{0%,100%{box-shadow:0 0 0 3px rgba(37,99,235,.18)}50%{box-shadow:0 0 0 6px rgba(37,99,235,.08)}}
    .cv-json{white-space:pre-wrap;word-break:break-all;background:var(--surface-2,#f3f4f6);border-radius:8px;padding:8px 10px;font-family:ui-monospace,monospace;font-size:10.5px;line-height:1.6;max-height:220px;overflow-y:auto}
    .cv-prop-tabs{display:flex;gap:0;border-bottom:1px solid var(--border,#eef0f3);margin-bottom:10px}
    .cv-prop-tabs button{flex:1;padding:6px 0;border:none;background:none;cursor:pointer;font-size:12px;color:var(--text-3,#9ca3af);border-bottom:2px solid transparent}
    .cv-prop-tabs button.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb);font-weight:600}
    .cv-node .nh{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border,#eef0f3);cursor:grab}
    .cv-node .nh:active{cursor:grabbing}
    .cv-node .nh .ic{width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;flex-shrink:0}
    .cv-node .nh .tt{font-size:12.5px;font-weight:600;color:var(--text,#111827);flex:1;line-height:1.2}
    .cv-node .nh .tt small{display:block;font-weight:400;font-size:10.5px;color:var(--text-3,#9ca3af)}
    .cv-node .nh .del{border:none;background:none;color:var(--text-3,#9ca3af);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px}
    .cv-node .nh .del:hover{color:#dc2626;background:#fee2e2}
    .cv-node .nb{padding:7px 10px;font-size:11px;color:var(--text-2,#6b7280);line-height:1.5;min-height:20px;max-height:52px;overflow:hidden}
    .cv-anchor-in{position:absolute;left:-7px;top:26px;width:12px;height:12px;border-radius:50%;background:#fff;border:2.5px solid var(--text-3,#9ca3af);cursor:crosshair;z-index:2}
    .cv-anchor-out{position:absolute;right:-7px;width:12px;height:12px;border-radius:50%;background:#fff;border:2.5px solid var(--brand,#2563eb);cursor:crossbar;z-index:2}
    /* P5.11 异常分支出口：红色小端口（节点底部中央；仅失败时激活） */
    .cv-anchor-err{position:absolute;bottom:-7px;left:50%;transform:translateX(-50%);width:12px;height:12px;border-radius:50%;background:#fff;border:2.5px solid #dc2626;cursor:crosshair;z-index:3}
    .cv-anchor-err:hover{transform:translateX(-50%) scale(1.3);box-shadow:0 0 0 4px rgba(220,38,38,.18)}
    .cv-node.has-err-edge{border-color:#dc2626}
    .cv-err-tag{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#dc2626;background:#fee2e2;border-radius:4px;padding:0 4px;margin-left:4px}
    /* P5.12 校验角标：节点卡片右上角红点（悬停看问题详情） */
    .cv-badge-dot{position:absolute;right:8px;top:-5px;width:11px;height:11px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25);cursor:help;z-index:4}
    .cv-anchor-out:hover,.cv-anchor-in:hover{transform:scale(1.25)}
    .cv-anchor-out{cursor:crosshair}
    .cv-branch-row{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:3px 10px;font-size:10.5px;color:var(--text-2,#6b7280);position:relative}
    .cv-tools{position:absolute;left:14px;bottom:14px;display:flex;gap:6px;z-index:5}
    .cv-tools button{width:30px;height:30px;border-radius:8px;border:1px solid var(--border,#d1d5db);background:var(--card,#fff);cursor:pointer;font-size:13px;color:var(--text-2,#6b7280)}
    .cv-tools button:hover{border-color:var(--brand,#2563eb);color:var(--brand,#2563eb)}
    .cv-tools button:disabled{opacity:.4;cursor:not-allowed}
    /* P5.4 变量选择浮层 */
    .cv-varpop{position:absolute;z-index:60;background:var(--card,#fff);border:1px solid var(--border,#d1d5db);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);max-height:230px;overflow-y:auto;min-width:220px;font-size:12px}
    .cv-varpop .vh{padding:6px 10px;font-size:10.5px;color:var(--text-3,#9ca3af);border-bottom:1px solid var(--border,#eef0f3);position:sticky;top:0;background:var(--card,#fff)}
    .cv-varpop .vi{padding:6px 10px;cursor:pointer;display:flex;gap:6px;align-items:center}
    .cv-varpop .vi:hover,.cv-varpop .vi.act{background:var(--surface-3,#eff6ff);color:var(--brand,#2563eb)}
    .cv-varpop .vi code{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-3,#9ca3af)}
    .cv-varpop .empty{padding:10px;color:var(--text-3,#9ca3af)}
    /* P5.4 坏引用标红 */
    .cv-node.warning{border-color:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.14)}
    .cv-refwarn{color:#dc2626;font-size:10.5px;margin-top:3px}
    /* P5.4 小地图 */
    .cv-minimap{position:absolute;right:14px;bottom:14px;z-index:5;width:170px;height:104px;background:rgba(255,255,255,.92);border:1px solid var(--border,#d1d5db);border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08);overflow:hidden;cursor:pointer}
    .cv-minimap .mm-node{position:absolute;border-radius:2px}
    .cv-minimap .mm-view{position:absolute;border:1.5px solid var(--brand,#2563eb);border-radius:3px;background:rgba(37,99,235,.06)}
    .cv-zoomlab{position:absolute;left:56px;bottom:19px;font-size:11px;color:var(--text-3,#9ca3af);z-index:5}
    .cv-prop{width:300px;flex-shrink:0;border-left:1px solid var(--border,#e5e7eb);background:var(--card,#fff);overflow-y:auto;padding:14px 16px}
    .cv-prop h4{margin:0 0 4px;font-size:13px;color:var(--text,#111827)}
    .cv-prop .fd{margin:10px 0}
    .cv-prop .fd label{display:block;font-size:11.5px;color:var(--text-2,#6b7280);margin-bottom:4px}
    .cv-prop .fd .input,.cv-prop .fd textarea,.cv-prop .fd select{width:100%;box-sizing:border-box}
    .cv-prop textarea{min-height:76px;resize:vertical}
    .cv-prop .hint{font-size:11px;color:var(--text-3,#9ca3af);line-height:1.6}
    .cv-prop .code{font-family:ui-monospace,monospace;font-size:10.5px;background:var(--surface-2,#f3f4f6);padding:1px 5px;border-radius:4px}
    .cv-run{position:absolute;right:16px;top:12px;z-index:6}
    .cv-empty{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);text-align:center;color:var(--text-3,#9ca3af);font-size:13px;line-height:2;pointer-events:none}
    /* P5.6 画布搜索：非匹配节点变暗 + 定位闪烁 */
    .cv-node.dim{opacity:.18}
    .cv-node.flash{animation:cvflash 1.4s ease-out}
    @keyframes cvflash{0%{box-shadow:0 0 0 8px rgba(37,99,235,.55)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}
    .cv-search{position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:8;display:flex;gap:6px;align-items:center;background:var(--card,#fff);border:1px solid var(--border,#d1d5db);border-radius:10px;padding:6px 8px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
    .cv-search input{border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:4px 8px;font-size:12px;width:220px;outline:none}
    .cv-search .cnt{font-size:11px;color:var(--text-3,#9ca3af);white-space:nowrap}
    /* P5.6 节点分组：底板 + 组头 + 折叠卡片 + 橡皮筋选区 */
    .cv-group{position:absolute;border-radius:14px;border:1.5px dashed;pointer-events:none;z-index:0}
    .cv-group .cv-gh{position:absolute;left:10px;top:-13px;display:flex;gap:6px;align-items:center;pointer-events:auto;background:var(--card,#fff);border-radius:8px;padding:2px 8px;font-size:11px;color:#fff;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.1);user-select:none}
    .cv-group .cv-gh button{border:none;background:rgba(255,255,255,.22);color:#fff;cursor:pointer;border-radius:5px;font-size:10.5px;padding:1px 5px;line-height:1.5}
    .cv-group .cv-gh button:hover{background:rgba(255,255,255,.4)}
    .cv-gcard{position:absolute;width:212px;background:var(--card,#fff);border:1.5px solid;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.06);padding:10px 12px;font-size:12px;cursor:pointer;z-index:1;user-select:none}
    .cv-gcard:hover{box-shadow:0 4px 12px rgba(0,0,0,.12)}
    .cv-gcard .gt{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px}
    .cv-gcard .gc{font-size:10.5px;color:var(--text-3,#9ca3af);margin-top:3px}
    .cv-selbar{position:absolute;left:50%;top:52px;transform:translateX(-50%);z-index:8;display:flex;gap:6px;background:var(--card,#fff);border:1px solid var(--border,#d1d5db);border-radius:10px;padding:5px 8px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
    .cv-rubber{position:absolute;border:1.5px dashed #2563eb;background:rgba(37,99,235,.08);pointer-events:none;z-index:7;border-radius:4px}
    .cv-node.grp-sel{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18)}
    /* P5.15 画布便签（Figma sticky note）：双击空白创建，纯注释不参与执行 */
    .cv-note{position:absolute;background:var(--nc,#fef08a);border-radius:4px 10px 10px 10px;box-shadow:0 3px 10px rgba(0,0,0,.14);z-index:1;display:flex;flex-direction:column;overflow:hidden}
    .cv-note:hover{box-shadow:0 6px 16px rgba(0,0,0,.2)}
    .cv-note-bar{display:flex;align-items:center;justify-content:space-between;padding:2px 6px;cursor:grab;user-select:none;background:rgba(0,0,0,.04)}
    .cv-note-bar:active{cursor:grabbing}
    .cv-note-grip{font-size:11px;opacity:.45;line-height:1.2}
    .cv-note-del{border:none;background:transparent;cursor:pointer;font-size:10.5px;opacity:.4;border-radius:4px;padding:0 3px;line-height:1.6}
    .cv-note-del:hover{opacity:1;background:rgba(0,0,0,.08)}
    .cv-note-ta{flex:1;border:none;background:transparent;resize:none;outline:none;font-size:12px;line-height:1.55;color:#713f12;padding:6px 9px;font-family:inherit}
    .cv-note-ta::placeholder{color:rgba(113,63,18,.4)}
    /* P5.15 右键菜单 */
    .cv-menu{position:fixed;z-index:9999;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:5px;min-width:168px;font-size:12.5px}
    .cv-menu .mi{display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;color:var(--text,#111827)}
    .cv-menu .mi:hover{background:var(--surface-2,#f3f4f6)}
    .cv-menu .mi.danger{color:#dc2626}
    .cv-menu .mi .k{margin-left:auto;font-size:10.5px;color:var(--text-3,#9ca3af)}
    .cv-menu .sep{height:1px;background:var(--border,#e5e7eb);margin:4px 6px}
    .cv-menu .eg{display:grid;grid-template-columns:repeat(6,1fr);gap:2px;padding:4px}
    .cv-menu .eg button{border:none;background:transparent;font-size:16px;cursor:pointer;border-radius:6px;padding:3px;line-height:1.3}
    .cv-menu .eg button:hover{background:var(--surface-2,#f3f4f6)}
    /* P5.22 折叠屏展开态（561-800：Mate XT 全展开 744 / Z Fold 717 / Pixel Fold 791 / iPad mini 768）：
       组件库常驻左栏（🧩 可收起让位画布），属性面板保持右侧抽屉+遮罩。
       注：本内嵌块晚于 app.css 注入，同特异性下此处声明生效——画布档位样式统一收口于此，勿移去 app.css（会被本块覆盖）。 */
    @media (min-width: 561px) and (max-width: 800px) {
      .cv-wrap { flex-direction: row; }
      .cv-lib { position: static; transform: none; box-shadow: none; }
      .cv-lib.hidden { display: none; }
      .cv-stage { min-height: 0; }
      /* 属性面板抽屉规则显式覆盖整个 561-800 档——app.css 的抽屉定义止于 768，
         769-800（Pixel Fold 等）若不在此声明会回落为桌面静态列、挤死画布 */
      .cv-prop {
        position: fixed; right: 0; top: 0; bottom: 0; z-index: 70;
        width: min(66vw, 340px);
        transform: translateX(102%); transition: transform .25s ease;
        box-shadow: -8px 0 30px rgba(0,0,0,.18); border-left: none;
        background: var(--card, #fff);
      }
      .cv-prop.open { transform: none; }
      .cv-panels-btn { display: inline-flex; }
    }
    /* P5.22 超窄（≤560：三折叠单屏 / 折叠外屏 / 小屏手机）：画布顶部按钮组改流式换行——
       六个按钮绝对定位（right 12~492px）在 <560px 必然溢出视口（390px 起「模板/存为模板」已被裁切）。
       按钮为 .cv-stage 直接子元素，改 static 后按 DOM 序自然成行换行，画布世界层为 absolute 不受影响。 */
    @media (max-width: 560px) {
      .cv-stage > button { position: static !important; display: inline-flex; margin: 8px 0 0 8px; }
      .cv-stage > button:first-of-type { margin-left: 12px; }
    }
  </style>
  <div class="cv-wrap">
    <div class="cv-drawer-mask" id="cvDrawerMask"></div>
    <div class="cv-lib" id="cvLib"></div>
    <div class="cv-stage" id="cvStage">
      <div class="cv-world" id="cvWorld">
        <div class="cv-dots"></div>
        <svg class="cv-svg" id="cvSvg" width="10" height="10"></svg>
      </div>
      <div class="cv-empty" id="cvEmpty">🎨 ${t('画布为空——从左侧拖入节点开始编排')}<br>${t('从节点右侧圆点拖出连线，接到下一节点左侧圆点')}<br>${t('滚轮缩放 · 空白处拖动平移 · 双击空白加便签 · Shift 拖框多选 · 右键节点更多操作')}</div>
      <div class="cv-tools">
        <button id="cvUndo" title="${t('撤销 (Ctrl+Z)')}">↶</button>
        <button id="cvRedo" title="${t('重做 (Ctrl+Y / Ctrl+Shift+Z)')}">↷</button>
        <button id="cvZoomOut" title="${t('缩小')}">−</button>
        <button id="cvZoomIn" title="${t('放大')}">＋</button>
        <button id="cvFit" title="${t('适应画布')}">⊡</button>
      </div>
      <div class="cv-minimap" id="cvMini" style="display:none"><div id="cvMiniHost" style="position:absolute;inset:0"></div></div>
      <div class="cv-zoomlab" id="cvZoomLab">100%</div>
      <button class="btn primary cv-run" id="cvRun">▶ ${t('运行测试')}</button>
      <button class="btn cv-runs-btn" id="cvRunsBtn" style="position:absolute;right:110px;top:12px;z-index:6">🕘 ${t('运行历史')}</button>
      <button class="btn" id="cvModeBtn" style="position:absolute;right:212px;top:12px;z-index:6" title="${t('Workflow 一次性执行 / Chatflow 多轮对话（llm 默认携带历史，直接回复节点流式输出）')}">⚙️ Workflow</button>
      <button class="btn" id="cvSearchBtn" style="position:absolute;right:330px;top:12px;z-index:6" title="${t('搜索节点（Ctrl+F）')}">🔍</button>
      <button class="btn cv-panels-btn" id="cvLibBtn" style="position:absolute;left:12px;top:12px;z-index:6" title="${t('组件库（窄屏）')}">🧩</button>
      <button class="btn cv-panels-btn" id="cvPropBtn" style="position:absolute;left:56px;top:12px;z-index:6" title="${t('属性面板（窄屏）')}">⚙️</button>
      <button class="btn" id="cvTplBtn" style="position:absolute;right:412px;top:12px;z-index:6" title="${t('从工作流模板导入（覆盖当前画布，先确认）')}">📐 ${t('模板')}</button>
      <button class="btn" id="cvSaveTplBtn" style="position:absolute;right:492px;top:12px;z-index:6" title="${t('把当前画布存为工作流模板（广场可见，团队可复用）')}">💾 ${t('存为模板')}</button>
    </div>
    <div class="cv-prop" id="cvProp"></div>
  </div>`;

  const $ = s => root.querySelector(s);
  const lib = $('#cvLib'), stage = $('#cvStage'), world = $('#cvWorld'), svg = $('#cvSvg'), prop = $('#cvProp');
  // P5.6 剪贴板复制（降级方案：execCommand）
  function copyText(text) {
    return new Promise(resolve => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => { resolve(fallbackCopy(text)); });
      } else resolve(fallbackCopy(text));
    });
    function fallbackCopy(tx) {
      const ta = document.createElement('textarea');
      ta.value = tx; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { }
      ta.remove(); return ok;
    }
  }

  // ---------- 节点库 ----------
  function libCard(type, meta, sub) {
    return `<div class="card" draggable="false" data-type="${type}">
      <span class="ic" style="background:${meta.color}">${meta.icon}</span>
      <span class="nm">${esc(meta.label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    </div>`;
  }
  function renderLib() {
    lib.innerHTML = `
      <div class="grp">${t('基础组件')}</div>
      ${libCard('start', NODE_TYPES.start, t('定义输入变量'))}
      ${libCard('llm', NODE_TYPES.llm, t('提示词 + 模型'))}
      ${libCard('code', NODE_TYPES.code, t('JS 沙箱 · 零 LLM 成本'))}
      ${libCard('iteration', NODE_TYPES.iteration, t('数组逐条子流程'))}
      ${libCard('assign', NODE_TYPES.assign, t('set / append / clear'))}
      ${libCard('if-else', NODE_TYPES['if-else'], t('多条件 IF/ELIF/ELSE'))}
      ${libCard('aggregator', NODE_TYPES.aggregator, t('并行分支汇合取值'))}
      ${libCard('knowledge', NODE_TYPES.knowledge, t('检索知识库片段供下游引用（RAG）'))}
      ${libCard('end', NODE_TYPES.end, t('最终回复模板'))}
      <div class="grp">💬 ${t('对话（Chatflow）')}</div>
      ${libCard('answer', NODE_TYPES.answer, t('流式即时回复，流程继续'))}
      ${libCard('classifier', NODE_TYPES.classifier, t('LLM 意图分类 → 多分支'))}
      <div class="grp">${t('平台工具')}</div>
      ${TOOL_OPTIONS.map(([id, ic, label]) => `
        <div class="card" data-type="tool" data-tool="${id}">
          <span class="ic" style="background:${NODE_TYPES.tool.color}">${ic}</span>
          <span class="nm">${esc(label)}<small>${esc(id)}</small></span>
        </div>`).join('')}
      <div class="grp">${t('子智能体')}</div>
      ${agents.length ? agents.slice(0, 30).map(a => `
        <div class="card" data-type="agent" data-agent="${a.id}">
          <span class="ic" style="background:${NODE_TYPES.agent.color}">${esc(a.icon || '🧠')}</span>
          <span class="nm">${esc(a.name)}<small>#${a.id}</small></span>
        </div>`).join('') : `<div class="grp" style="font-weight:400">${t('暂无其它智能体')}</div>`}`;
  }
  renderLib();

  // ---------- 世界坐标 ----------
  function toWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - wf.viewport.x) / wf.viewport.zoom, y: (clientY - r.top - wf.viewport.y) / wf.viewport.zoom };
  }
  function applyViewport() {
    world.style.transform = `translate(${wf.viewport.x}px,${wf.viewport.y}px) scale(${wf.viewport.zoom})`;
    $('#cvZoomLab').textContent = Math.round(wf.viewport.zoom * 100) + '%';
    renderMinimap();
  }
  applyViewport();

  // ---------- 节点渲染 ----------
  // P5.13 前端费用格式化（与后端 lib/cost.js fmtCost 同语义；priced:false → 内置估价加 ~ 前缀）
  function fmtCostFront(cny, priced) {
    const v = Number(cny) || 0;
    if (v === 0) return '¥0';
    const s = v >= 0.01 ? '¥' + v.toFixed(3) : '¥' + v.toFixed(4);
    return priced === false ? '~' + s : s;
  }
  // P5.3 节点状态徽标（运行中 spinner / 成功耗时 / 失败摘要 / 跳过 / 沿用）
  function statusBadge(rs) {
    if (rs.status === 'running') {
      // P5.10 流式调试：LLM 生成中逐字显示（尾部滚动态预览）
      if (rs.streamText) return `<span class="cv-spin"></span><span class="cv-stream">${esc(rs.streamText)}</span>`;
      return `<span class="cv-spin"></span><span style="color:#2563eb">${t('执行中…')}</span>`;
    }
    // P5.13 成本可视化：成功徽标附 tokens 与费用（比 Dify 更直接——直接在节点卡片上显示）
    if (rs.status === 'success') {
      const cost = (rs.tokens != null && Number(rs.tokens) > 0)
        ? ` <span style="color:var(--text-3,#9ca3af);white-space:nowrap">· ${rs.tokens} tokens${rs.cost_cny != null ? ' · ' + fmtCostFront(rs.cost_cny, rs.cost_priced) : ''}</span>` : '';
      return `<span style="color:#059669">✅ ${rs.ms != null ? (rs.ms >= 1000 ? (rs.ms / 1000).toFixed(1) + 's' : rs.ms + 'ms') : ''}</span>${cost}`;
    }
    if (rs.status === 'error') {
      if (rs.viaError) return `<span style="color:#d97706">⚡</span><span class="err" title="${esc(rs.error || '')}">${esc((rs.error || '').slice(0, 40))}</span><span style="color:#d97706">${t('→已走异常分支')}</span>`;
      return `<span style="color:#dc2626">❌</span><span class="err" title="${esc(rs.error || '')}">${esc((rs.error || '').slice(0, 60))}</span>`;
    }
    if (rs.status === 'skipped') return `<span>⏭️ ${t('跳过（分支未命中）')}</span>`;
    if (rs.status === 'preset') return `<span>↺ ${t('沿用上次结果')}</span>`;
    return '';
  }
  // P5.11：节点卡高度估算（分支行数×24 + 头部/体部；异常分支锚点定位用）
  function nodeHeightOf(n) {
    let h = 78; // 头部 + 体部基线
    if (n.type === 'if-else') h = 44 + (n.data?.cases || []).length * 24 + 18;
    else if (n.type === 'classifier') h = 44 + ((n.data?.categories || []).length + 1) * 24 + 18;
    if (runState[n.id]) h += 26; // 运行状态条
    return h;
  }
  function nodeBody(n) {
    const d = n.data || {};
    if (n.type === 'start') {
      const vs = (d.variables || []).filter(v => v.name);
      const svs = (d.session_vars || []).filter(v => v.name);
      const parts = [];
      if (vs.length) parts.push(...vs.map(v => (v.type === 'file' || v.type === 'array[file]' ? '📄' : '📘') + ` {{#${esc(n.id + '.' + v.name)}#}}${v.type === 'array[file]' ? ' ×N' : ''}`));
      if (svs.length) parts.push(...svs.map(v => `💾{{#${esc(n.id + '.' + v.name)}#}}`));
      if (parts.length) return parts.join(' · ');
      return t('输入变量：{{#start.input#}}（用户消息）');
    }
    if (n.type === 'llm') return `🤖 ${esc(d.model || t('默认模型'))}${(d.fallback_models || []).length ? ` · 🛡️+${d.fallback_models.length}` : ''}${d.output_schema ? ` · 📋${t('结构化')}` : ''}${d.context?.use_history ? ` · 💬${t('带历史')}` : ''} · ${esc((d.prompt || '').replace(/\s+/g, ' ').slice(0, 26) || t('待填'))}`;
    if (n.type === 'tool') { const f = TOOL_OPTIONS.find(x => x[0] === d.toolId); return `${f ? f[1] + ' ' : '🔧 '}${esc(d.toolId || '?')}`; }
    if (n.type === 'agent') { const a = agents.find(x => String(x.id) === String(d.agentId)); return a ? `🧠 ${esc(a.name)}` : `⚠️ ${t('未选择智能体')}`; }
    if (n.type === 'code') return `⌨️ ${esc(String(d.code || '').replace(/\s+/g, ' ').slice(0, 40) || 'return …')}`;
    if (n.type === 'iteration') return `🔁 ${d.subflow?.nodes?.length ? t('{n} 步子流程').replace('{n}', d.subflow.nodes.length) : `⚠️ ${t('未配置子流程')}`} · ${t('输入数组')}`;
    if (n.type === 'assign') return (d.assignments || []).map(a => `💱 ${esc(a.variable || '?')} ${esc(a.operator || 'set')}${a.operator === 'clear' ? '' : ' ' + esc(String(a.value || '').slice(0, 10))}`).slice(0, 2).join(' · ') + ((d.assignments || []).length > 2 ? ' …' : '');
    if (n.type === 'if-else') return (d.cases || []).map(c => `⇢ ${esc(c.label || '?')}${c.isFallback ? t('（兜底）') : esc((c.conditions || []).map(cd => `${OPERATORS.find(o => o[0] === cd.type)?.[1] || cd.type}${cd.value ? ' ' + String(cd.value).slice(0, 6) : ''}`).join(c.logical === 'OR' ? t(' 或 ') : t(' 且 ')))}`).join(' · ');
    if (n.type === 'answer') return `💬 ${esc(String(d.text || '').replace(/\s+/g, ' ').slice(0, 34) || t('待配置'))}`;
    if (n.type === 'classifier') return (d.categories || []).map(c => `⇢ ${esc(c.name || '?')}`).join(' · ') + ' · ⇢ default';
    if (n.type === 'aggregator') return `🔀 ${d.mode === 'array' ? t('数组拼接') : t('首个非空')} × ${(d.sources || []).length}`;
    if (n.type === 'knowledge') { const k = kbs.find(x => String(x.id) === String(d.kb_id)); return k ? `📚 ${esc(k.name)} · Top${d.top_n || 5}` : `⚠️ ${t('未选择知识库')}`; }
    if (n.type === 'end') return `📤 ${esc(String(d.outputs?.[0]?.value || '').replace(/\s+/g, ' ').slice(0, 34) || '待配置')}`;
    return '';
  }
  function renderNodes() {
    world.querySelectorAll('.cv-node,.cv-group,.cv-gcard').forEach(el => el.remove());
    // P5.11：有 __error__ 出边的节点集合（卡片红框+⚡标记）
    const errEdgeOf = new Set(wf.edges.filter(e => (e.sourceHandle || 'out') === '__error__').map(e => e.source));
    // P5.6 分组底板（垫在节点下；折叠组渲染紧凑卡片代替节点）
    const collapsedOf = {};
    for (const g of wf.groups || []) for (const nid of g.nodeIds || []) collapsedOf[nid] = g;
    for (const g of wf.groups || []) {
      const members = (g.nodeIds || []).map(id => wf.nodes.find(n => n.id === id)).filter(Boolean);
      if (!members.length) continue;
      const minX = Math.min(...members.map(n => n.position.x)) - 18, minY = Math.min(...members.map(n => n.position.y)) - 22;
      const maxX = Math.max(...members.map(n => n.position.x + 212)) + 18, maxY = Math.max(...members.map(n => n.position.y + 130)) + 14;
      if (g.collapsed) {
        // 折叠：紧凑分组卡片（名称+节点数，点击展开；连线重锚到卡片边缘）
        const card = document.createElement('div');
        card.className = 'cv-gcard';
        card.dataset.gid = g.id;
        card.style.left = (minX + maxX) / 2 - 106 + 'px'; card.style.top = (minY + maxY) / 2 - 30 + 'px';
        card.style.borderColor = g.color;
        card.innerHTML = `<div class="gt"><span style="width:10px;height:10px;border-radius:3px;background:${esc(g.color)};display:inline-block"></span>🏷 ${esc(g.name)}</div><div class="gc">${members.length} ${t('个节点已折叠 · 点击展开')} ▸</div>`;
        card.onclick = () => { g.collapsed = false; markDirty(); renderNodes(); renderMinimap(); pushHistory(); };
        world.appendChild(card);
      } else {
        const box = document.createElement('div');
        box.className = 'cv-group';
        box.dataset.gid = g.id;
        box.style.left = minX + 'px'; box.style.top = minY + 'px';
        box.style.width = (maxX - minX) + 'px'; box.style.height = (maxY - minY) + 'px';
        box.style.borderColor = g.color; box.style.background = g.color + '14';
        box.innerHTML = `<div class="cv-gh" style="background:${esc(g.color)}">
          <span data-gdrag>🏷 ${esc(g.name)}</span>
          <button data-gcollapse title="${t('折叠分组')}">▾</button>
          <button data-gmenu title="${t('重命名/换色/解散')}">⋯</button></div>`;
        world.appendChild(box);
        const gh = box.querySelector('.cv-gh');
        gh.querySelector('[data-gcollapse]').onclick = ev => { ev.stopPropagation(); g.collapsed = true; markDirty(); renderNodes(); renderMinimap(); pushHistory(); };
        gh.querySelector('[data-gmenu]').onclick = ev => { ev.stopPropagation(); groupMenu(g); };
        // 组头拖动 → 整组节点平移
        gh.addEventListener('mousedown', ev => {
          if (ev.target.closest('button')) return;
          ev.preventDefault(); ev.stopPropagation();
          const sx = ev.clientX, sy = ev.clientY;
          const origins = members.map(n => ({ n, x: n.position.x, y: n.position.y }));
          const mv = e2 => { for (const o of origins) { o.n.position.x = o.x + (e2.clientX - sx) / wf.viewport.zoom; o.n.position.y = o.y + (e2.clientY - sy) / wf.viewport.zoom; } renderNodes(); };
          const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); markDirty(); pushHistory(); };
          window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
        });
      }
    }
    for (const n of wf.nodes) {
      const meta = NODE_TYPES[n.type] || { icon: '❓', color: '#6b7280', label: n.type };
      const el = document.createElement('div');
      const rs = runState[n.id];
      // P5.12 校验角标：悬空引用/必填缺失 → 红点（右上角，鼠标悬停看详情）；孤立节点 → 灰点
      el.className = 'cv-node' + (sel === n.id ? ' sel' : '') + (rs ? ' ' + rs.status : '') + (refWarnings[n.id]?.length ? ' warning' : '') + (selSet?.has(n.id) ? ' grp-sel' : '') + (searchDim && !searchDim.has(n.id) ? ' dim' : '') + (errEdgeOf.has(n.id) ? ' has-err-edge' : '');
      if (collapsedOf[n.id]?.collapsed) el.style.display = 'none';
      el.style.left = n.position.x + 'px'; el.style.top = n.position.y + 'px';
      el.dataset.id = n.id;
      el.innerHTML = `
        <span class="cv-anchor-in" title="输入"></span>
        <div class="nh">
          <span class="ic" style="background:${meta.color}">${esc(n.data?.icon || meta.icon)}</span>
          <span class="tt">${refWarnings[n.id]?.length ? '<b style="color:#d97706">⚠ </b>' : ''}${esc(n.data?.title || meta.label)}${errEdgeOf.has(n.id) ? '<span class="cv-err-tag" title="' + t('已画异常分支：失败时走红色虚线到补救节点') + '">⚡' + t('异常') + '</span>' : ''}<small>${esc(n.id)} · ${esc(nodeBody(n)).slice(0, 40)}</small></span>
          <button class="del" title="删除节点">✕</button>
        </div>
        <div class="nb">${esc(nodeBody(n))}</div>
        ${n.type === 'if-else' ? (n.data?.cases || []).map((c, idx) => `
          <div class="cv-branch-row">${esc(c.label || '?')}</div>
          <span class="cv-anchor-out" data-branch="${esc(c.label || '')}" style="top:${44 + idx * 24 + 8}px"></span>`).join('')
          : n.type === 'classifier' ? [...(n.data?.categories || []).map(c => c.name || '?'), 'default'].map((nm, idx) => `
          <div class="cv-branch-row">${esc(nm)}</div>
          <span class="cv-anchor-out" data-branch="${esc(nm)}" style="top:${44 + idx * 24 + 8}px"></span>`).join('')
          : `<span class="cv-anchor-out" style="top:26px"></span>`}
        ${n.type !== 'start' ? `<span class="cv-anchor-err" data-branch="__error__" title="${t('异常分支出口（红色）：节点失败时走这条连线到补救节点，不中断流程')}——⚡"></span>` : ''}
        ${rs ? `<div class="cv-status">${statusBadge(rs)}</div>` : ''}
        ${(validationProblems?.get(n.id)?.length) ? `<span class="cv-badge-dot" style="background:${validationProblems.get(n.id)[0].level === 'error' ? '#dc2626' : '#9ca3af'}" title="${esc(validationProblems.get(n.id).map(p => p.msg).join('\n'))}"></span>` : ''}`;
      world.appendChild(el);
    }
    $('#cvEmpty').style.display = wf.nodes.length ? 'none' : '';
    renderNotes(); // P5.15 便签随图渲染（纯注释，不参与执行）
    renderEdges();
    renderMinimap();
  }

  // ---------- P5.15 画布便签（Figma sticky note）：双击空白创建，黄/多色卡片写注释 TODO，拖动/改色/右键管理 ----------
  const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#fed7aa'];
  function renderNotes() {
    world.querySelectorAll('.cv-note').forEach(el => el.remove());
    for (const note of wf.notes || []) {
      const el = document.createElement('div');
      el.className = 'cv-note';
      el.dataset.id = note.id;
      el.style.cssText = `left:${note.x}px;top:${note.y}px;width:${note.w}px;height:${note.h}px;--nc:${note.color || '#fef08a'}`;
      el.innerHTML = `<div class="cv-note-bar"><span class="cv-note-grip">⠿</span><button class="cv-note-del" title="${t('删除便签')}">✕</button></div>
        <textarea class="cv-note-ta" placeholder="${t('写点注释 / TODO…')}（${t('右键改色')}）">${esc(note.text || '')}</textarea>`;
      world.appendChild(el);
      const ta = el.querySelector('.cv-note-ta');
      ta.addEventListener('input', () => { note.text = ta.value; markDirty(); pushHistoryDebounced(); });
      // 阻断便签内交互冒泡到画布（防触发平移/清选中）
      for (const evName of ['mousedown', 'dblclick']) el.addEventListener(evName, e => e.stopPropagation());
      // 拖动（按住便签头部/边框空白）
      const bar = el.querySelector('.cv-note-bar');
      bar.addEventListener('mousedown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const sx = ev.clientX, sy = ev.clientY, ox = note.x, oy = note.y;
        const mv = e2 => { note.x = ox + (e2.clientX - sx) / wf.viewport.zoom; note.y = oy + (e2.clientY - sy) / wf.viewport.zoom; el.style.left = note.x + 'px'; el.style.top = note.y + 'px'; };
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); markDirty(); pushHistory(); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      });
      el.querySelector('.cv-note-del').addEventListener('click', ev => {
        ev.stopPropagation();
        wf.notes = (wf.notes || []).filter(x => x.id !== note.id);
        markDirty(); renderNotes(); pushHistory();
      });
      el.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); showNoteMenu(note, ev.clientX, ev.clientY); });
    }
  }
  function showNoteMenu(note, cx, cy) {
    showMenu(cx, cy, `
      <div class="eg">${NOTE_COLORS.map(c => `<button data-nc="${c}" title="${t('换成这个颜色')}" style="background:${c};border:1px solid rgba(0,0,0,.08)"></button>`).join('')}</div>
      <div class="sep"></div>
      <div class="mi" data-act="dup">⧉ ${t('复制文本')}</div>
      <div class="mi danger" data-act="del">🗑 ${t('删除便签')}<span class="k">Del</span></div>`,
      mask => {
        mask.querySelectorAll('[data-nc]').forEach(b => b.onclick = () => { note.color = b.dataset.nc; markDirty(); renderNotes(); pushHistory(); closeCvMenu(); });
        mask.querySelector('[data-act=dup]').onclick = () => { try { navigator.clipboard.writeText(note.text || ''); toast(t('便签文本已复制')); } catch { } closeCvMenu(); };
        mask.querySelector('[data-act=del]').onclick = () => { wf.notes = (wf.notes || []).filter(x => x.id !== note.id); markDirty(); renderNotes(); pushHistory(); closeCvMenu(); };
      });
  }

  // ---------- P5.15 右键菜单（节点 / 便签）：复制·从此运行·历史·重命名·改图标·删除 ----------
  function closeCvMenu() { root.querySelector('.cv-menu')?.remove(); }
  function showMenu(cx, cy, html, onMount) {
    closeCvMenu();
    const menu = document.createElement('div');
    menu.className = 'cv-menu';
    menu.style.left = Math.min(cx, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(cy, window.innerHeight - 260) + 'px';
    menu.innerHTML = html;
    root.appendChild(menu);
    menu.addEventListener('mousedown', e => e.stopPropagation()); // 菜单内点击不冒泡到画布
    onMount?.(menu);
    return menu;
  }
  function showNodeMenu(nodeId, cx, cy) {
    const n = wf.nodes.find(x => x.id === nodeId);
    if (!n) return;
    showMenu(cx, cy, `
      <div class="mi" data-act="copy">⧉ ${t('复制节点')}<span class="k">Ctrl+C</span></div>
      <div class="mi" data-act="paste">📋 ${t('粘贴')}<span class="k">Ctrl+V</span></div>
      <div class="sep"></div>
      <div class="mi" data-act="run">▶ ${t('从此节点运行')}</div>
      <div class="mi" data-act="runs">🕘 ${t('运行历史')}</div>
      <div class="sep"></div>
      <div class="mi" data-act="rename">✏️ ${t('重命名')}</div>
      <div class="mi" data-act="icon">🎨 ${t('改图标')}</div>
      <div class="sep"></div>
      <div class="mi danger" data-act="del">🗑 ${t('删除')}<span class="k">Del</span></div>`,
      mask => {
        mask.querySelector('[data-act=copy]').onclick = () => { closeCvMenu(); copyNodes([nodeId]); };
        mask.querySelector('[data-act=paste]').onclick = () => { closeCvMenu(); pasteNodes(); };
        mask.querySelector('[data-act=run]').onclick = () => { closeCvMenu(); selectNode(nodeId); runTestSSE(nodeId); };
        mask.querySelector('[data-act=runs]').onclick = () => { closeCvMenu(); $('#cvRunsBtn').click(); };
        mask.querySelector('[data-act=rename]').onclick = () => {
          closeCvMenu();
          const meta = NODE_TYPES[n.type] || { label: n.type };
          const m = modal({
            title: '✏️ ' + t('重命名节点'),
            body: `<div class="fd" style="margin:0"><label>${t('节点标题')}</label><input class="input" id="cvRen" value="${esc(n.data?.title || meta.label)}" maxlength="30"></div>`,
            foot: `<button class="btn primary" id="cvRenGo">${t('保存')}</button>`,
            onMount(bmask, close) {
              bmask.querySelector('#cvRenGo').onclick = () => {
                const v = bmask.querySelector('#cvRen').value.trim();
                if (v) { n.data.title = v; markDirty(); selectNode(n.id); pushHistory(); }
                close();
              };
              bmask.querySelector('#cvRen').focus();
            },
          });
        };
        mask.querySelector('[data-act=icon]').onclick = () => {
          const ICONS = ['🟦', '🟣', '🟠', '🧠', '⌨️', '🔁', '💱', '🟡', '🟥', '🔍', '📄', '🌐', '📊', '🎨', '💬', '⚙️', '⭐', '🚀', '💡', '🎯', '🧮', '⚖️', '📡', '🗂️'];
          const meta = NODE_TYPES[n.type] || { icon: '❓' };
          showMenu(cx, cy, `<div class="eg">${ICONS.map(ic => `<button data-ic="${ic}">${ic}</button>`).join('')}</div>
            <div class="sep"></div><div class="mi" data-act="reset">↺ ${t('恢复默认图标')}${n.data.icon ? `（${meta.icon}）` : ''}</div>`,
            m2 => {
              m2.querySelectorAll('[data-ic]').forEach(b => b.onclick = () => { n.data.icon = b.dataset.ic; markDirty(); selectNode(n.id); pushHistory(); closeCvMenu(); });
              m2.querySelector('[data-act=reset]').onclick = () => { delete n.data.icon; markDirty(); selectNode(n.id); pushHistory(); closeCvMenu(); };
            });
        };
        mask.querySelector('[data-act=del]').onclick = () => { closeCvMenu(); delNode(nodeId); };
      });
  }
  world.addEventListener('contextmenu', e => {
    const nodeEl = e.target.closest('.cv-node');
    const noteEl = e.target.closest('.cv-note');
    if (!nodeEl && !noteEl) return; // 空白右键保留浏览器默认
    e.preventDefault();
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      // 右键未选中的节点：先选中（Shift 不改变现有多选）
      if (selSet && selSet.size > 1 && selSet.has(id)) { showSelBar(); }
      else if (!selSet?.has(id)) selectNode(id);
      showNodeMenu(id, e.clientX, e.clientY);
    } else {
      showNoteMenu((wf.notes || []).find(x => x.id === noteEl.dataset.id), e.clientX, e.clientY);
    }
  });
  // 具名引用以便 destroy 统一移除（防编排页进出泄漏 window 监听器）
  const onCvMenuClose = e => { if (!e.target.closest('.cv-menu')) closeCvMenu(); };
  const onCvEsc = e => { if (e.key === 'Escape') closeCvMenu(); };
  window.addEventListener('mousedown', onCvMenuClose, true);
  window.addEventListener('keydown', onCvEsc);

  // ---------- P5.15 双击画布空白 → 创建便签（立即进入编辑态） ----------
  stage.addEventListener('dblclick', e => {
    if (e.target.closest('.cv-node') || e.target.closest('.cv-note') || e.target.closest('.cv-lib') || e.target.closest('.cv-prop') || e.target.closest('button') || e.target.closest('.cv-svg') || e.target.closest('.cv-tools') || e.target.closest('.cv-minimap')) return;
    if (document.querySelector('[data-subflow-open]')) return;
    const p = toWorld(e.clientX, e.clientY);
    const note = { id: 'note_' + (Date.now() % 100000), x: Math.round(p.x), y: Math.round(p.y), w: 200, h: 140, text: '', color: NOTE_COLORS[0] };
    (wf.notes || (wf.notes = [])).push(note);
    markDirty(); renderNotes(); pushHistory();
    setTimeout(() => { const ta = world.querySelector(`.cv-note[data-id="${note.id}"] .cv-note-ta`); ta?.focus(); }, 60);
  });

  // ---------- 连线渲染（SVG 贝塞尔） ----------
  function anchorPos(nodeId, side, sourceHandle) {
    const n = wf.nodes.find(x => x.id === nodeId);
    if (!n) return null;
    // P5.6 折叠分组重锚：节点在折叠组内 → 锚点改到分组卡片边缘
    const g = (wf.groups || []).find(gr => gr.collapsed && (gr.nodeIds || []).includes(nodeId));
    if (g) {
      const members = (g.nodeIds || []).map(id => wf.nodes.find(x => x.id === id)).filter(Boolean);
      if (members.length) {
        const minX = Math.min(...members.map(m => m.position.x)) - 18, minY = Math.min(...members.map(m => m.position.y)) - 22;
        const maxX = Math.max(...members.map(m => m.position.x + 212)) + 18, maxY = Math.max(...members.map(m => m.position.y + 130)) + 14;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        if (side === 'in') return { x: cx - 106 - 7, y: cy };
        return { x: cx + 106 + 7, y: cy };
      }
    }
    if (side === 'in') return { x: n.position.x - 7, y: n.position.y + 32 };
    // P5.11 异常分支出口：节点底部中央（红色端口）
    if (sourceHandle === '__error__') return { x: n.position.x + 106, y: n.position.y + nodeHeightOf(n) + 7 };
    if (n.type === 'if-else') {
      const idx = (n.data?.cases || []).findIndex(c => c.label === sourceHandle);
      const y = n.position.y + 44 + Math.max(0, idx) * 24 + 8;
      return { x: n.position.x + 212 + 7, y };
    }
    // P5.6 问题分类器：分支锚点（类别名 + default 兜底行）
    if (n.type === 'classifier') {
      const cats = [...(n.data?.categories || []).map(c => c.name || ''), 'default'];
      const idx = cats.findIndex(nm => nm === sourceHandle);
      const y = n.position.y + 44 + Math.max(0, idx) * 24 + 8;
      return { x: n.position.x + 212 + 7, y };
    }
    return { x: n.position.x + 212 + 7, y: n.position.y + 32 };
  }
  function bezier(p1, p2) {
    const dx = Math.max(36, Math.abs(p2.x - p1.x) * 0.45);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
  }
  function renderEdges() {
    const W = 5000, H = 4000;
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    let paths = '';
    wf.edges.forEach((e, i) => {
      const p1 = anchorPos(e.source, 'out', e.sourceHandle), p2 = anchorPos(e.target, 'in');
      if (!p1 || !p2) return;
      const isSel = sel && sel.edge === i;
      const isErr = (e.sourceHandle || 'out') === '__error__'; // P5.11：异常分支边红色虚线
      paths += `<path d="${bezier(p1, p2)}" fill="none" stroke="${isSel ? '#dc2626' : isErr ? '#f87171' : '#93c5fd'}" stroke-width="${isSel ? 2.6 : isErr ? 1.8 : 2}"${isErr ? ' stroke-dasharray="6 4"' : ''} data-edge="${i}" style="cursor:pointer"/>`;
    });
    svg.innerHTML = paths;
  }

  // ---------- 增删节点 / 边 ----------
  function addNode(type, x, y, preset) {
    seq++;
    const meta = NODE_TYPES[type];
    const id = type === 'start' ? (wf.nodes.some(n => n.type === 'start') ? 'start_' + seq : 'start') : 'node_' + seq;
    const n = { id, type, position: { x: Math.round(x), y: Math.round(y) }, data: JSON.parse(JSON.stringify(meta.def)) };
    if (preset?.toolId) n.data.toolId = preset.toolId;
    if (preset?.agentId) n.data.agentId = String(preset.agentId);
    wf.nodes.push(n);
    pushHistory();
    markDirty(); renderNodes(); selectNode(n.id);
    return n;
  }
  // P5.4 扫描引用某节点变量的位置（删除前提示用）：返回 [{nodeId, field, ref}]
  function findRefsTo(nodeId) {
    const hits = [];
    const RE = new RegExp('\\{\\{\\s*#\\s*' + nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[\\w.-]+\\s*#\\s*\\}\\}', 'g');
    const scan = (n, field, text) => {
      if (String(text || '').match(RE)) hits.push({ nodeId: n.id, field, preview: String(text || '').slice(0, 60) });
    };
    for (const n of wf.nodes) {
      const d = n.data || {};
      if (n.id === nodeId) continue;
      if (n.type === 'llm') { scan(n, 'system_prompt', d.system_prompt); scan(n, 'prompt', d.prompt); }
      if (n.type === 'tool') scan(n, 'args', d.args);
      if (n.type === 'agent') scan(n, 'input', d.input);
      if (n.type === 'code') for (const [k, v] of Object.entries(d.inputs || {})) scan(n, `inputs.${k}`, v);
      if (n.type === 'iteration') scan(n, 'input', d.input);
      if (n.type === 'assign') (d.assignments || []).forEach((a, i) => scan(n, `assignments[${i}].value`, a.value));
      if (n.type === 'answer') scan(n, 'text', d.text);
      if (n.type === 'aggregator') (d.sources || []).forEach((s, i) => scan(n, `sources[${i}].variable`, s.variable));
      if (n.type === 'end') (d.outputs || []).forEach((o, i) => scan(n, `outputs[${i}].value`, o.value));
    }
    return hits;
  }
  function refreshRefWarnings() {
    refWarnings = {};
    // P5.12 升级：node+变量双重校验——节点不存在 → 整条引用坏；节点存在但变量未在输出集 → 同样标坏
    // （含动态变量：start 变量/会话变量、llm 结构化字段、assign 变量、code 自定义输出、tool 试运行 _fields）
    const ids = new Set(wf.nodes.map(n => n.id));
    const varsOf = {};
    for (const n of wf.nodes) {
      varsOf[n.id] = new Set(allVars().filter(v => v.ref.startsWith(n.id + '.')).map(v => v.ref.slice(n.id.length + 1)));
    }
    const addWarn = (n, ref) => { (refWarnings[n.id] || (refWarnings[n.id] = [])).push(ref); };
    for (const n of wf.nodes) {
      const d = n.data || {};
      const texts = [];
      if (n.type === 'llm') texts.push(d.system_prompt, d.prompt);
      if (n.type === 'tool') texts.push(d.args);
      if (n.type === 'agent') texts.push(d.input);
      if (n.type === 'code') texts.push(...Object.values(d.inputs || {}));
      if (n.type === 'iteration') texts.push(d.input);
      if (n.type === 'assign') texts.push(...(d.assignments || []).map(a => a.value));
      if (n.type === 'answer') texts.push(d.text);
      if (n.type === 'aggregator') texts.push(...(d.sources || []).map(s => s.variable));
      if (n.type === 'end') texts.push(...(d.outputs || []).map(o => o.value));
      for (const t of texts) {
        String(t || '').replace(/\{\{\s*#\s*([\w\u4e00-\u9fa5.-]+)\s*#\s*\}\}/g, (m, ref) => { // P5.12：中文节点 id 支持
          const dot = ref.indexOf('.');
          const nid = dot < 0 ? ref : ref.slice(0, dot);
          const varName = dot < 0 ? '' : ref.slice(dot + 1);
          if (!ids.has(nid)) addWarn(n, ref);
          else if (varName && !(varsOf[nid]?.has(varName))) addWarn(n, ref); // 变量级校验
          return m;
        });
      }
    }
  }
  // ---------- P5.12 保存时自动校验：悬空引用 / 孤立节点 / 必填缺失 ----------
  // 返回 { ok, problems: [{level:'error'|'warn', nodeId, type, msg}] }——error 级运行必失败，warn 级提示
  function validateWorkflow() {
    const problems = [];
    const ids = new Set(wf.nodes.map(n => n.id));
    // ① 悬空引用（node+变量级；引用了不存在节点或未声明的输出变量）
    refreshRefWarnings();
    for (const [nid, refs] of Object.entries(refWarnings)) {
      for (const ref of refs) {
        problems.push({ level: 'error', nodeId: nid, type: 'ref', msg: t('引用了不存在的变量 {{#{ref}#}}').replace('{ref}', ref) });
      }
    }
    // ② 孤立节点：未连入主流程（从 start 可达之外的节点）
    const reachable = new Set();
    const stack = [wf.nodes.find(n => n.type === 'start')?.id].filter(Boolean);
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of wf.edges) if (e.source === id && !reachable.has(e.target)) stack.push(e.target);
    }
    for (const n of wf.nodes) {
      if (n.type === 'start') continue;
      if (!reachable.has(n.id)) problems.push({ level: 'warn', nodeId: n.id, type: 'orphan', msg: t('未连接到主流程（不会执行）') });
    }
    // ③ 必填项缺失
    for (const n of wf.nodes) {
      const d = n.data || {};
      if (n.type === 'llm') {
        if (!(String(d.prompt || '').trim())) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('提示词为空') });
        if (!d.model && !models.length) { /* 跟随智能体默认模型——平台无模型时才无默认可跟，不报 */ }
        if (d.output_schema) { try { JSON.parse(typeof d.output_schema === 'string' ? d.output_schema : JSON.stringify(d.output_schema)); } catch { problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('结构化输出 Schema 不是合法 JSON') }); } }
      }
      if (n.type === 'tool' && !d.toolId) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('未选择工具') });
      if (n.type === 'agent' && !d.agentId) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('未选择子智能体') });
      if (n.type === 'code') {
        if (!(String(d.code || '').trim())) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('代码为空') });
        try { const m = typeof d.inputs === 'string' ? JSON.parse(d.inputs || '{}') : (d.inputs || {}); if (typeof m !== 'object' || Array.isArray(m)) throw new Error(); } catch { problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('输入变量 JSON 不合法') }); }
      }
      if (n.type === 'iteration') {
        if (!d.subflow?.nodes?.length) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('未搭建子流程') });
        const raw = String(d.input || '[]').replace(/\{\{[^}]*\}\}/g, 'x'); // 模板替换后试探
        try { const arr = JSON.parse(raw); if (!Array.isArray(arr)) { /* 换行分隔文本也合法 */ } } catch { if (!raw.trim()) problems.push({ level: 'warn', nodeId: n.id, type: 'required', msg: t('输入数组为空（运行时将为空迭代）') }); }
      }
      if (n.type === 'if-else') {
        const cases = d.cases || [];
        if (!cases.some(c => !c.isFallback && (c.conditions || []).some(cd => cd.variable))) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('IF 分支未配置条件') });
        if (!cases.some(c => c.isFallback)) problems.push({ level: 'warn', nodeId: n.id, type: 'required', msg: t('无 ELSE 兜底分支（全不命中时流程断头）') });
      }
      if (n.type === 'classifier') {
        if (!(d.categories || []).some(c => (c.name || '').trim())) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('未配置类别') });
      }
      if (n.type === 'assign') {
        (d.assignments || []).forEach((a, i) => { if (!a.variable && a.operator !== 'clear') problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('赋值 {n} 未填变量名').replace('{n}', i + 1) }); });
      }
      if (n.type === 'aggregator') {
        if (!(d.sources || []).some(s => (s.variable || '').trim())) problems.push({ level: 'error', nodeId: n.id, type: 'required', msg: t('未配置聚合来源') });
      }
      if (n.type === 'answer' && !(String(d.text || '').trim())) problems.push({ level: 'warn', nodeId: n.id, type: 'required', msg: t('回复内容为空') });
      if (n.type === 'end' && !((d.outputs || [])[0]?.value ?? '').trim()) problems.push({ level: 'warn', nodeId: n.id, type: 'required', msg: t('输出模板为空') });
    }
    return { ok: !problems.some(p => p.level === 'error'), problems };
  }

  function delNode(id) {
    // P5.4 引用检查：有下游引用 → 确认弹窗列出引用位置（不静默删）
    const refs = findRefsTo(id);
    const node = wf.nodes.find(n => n.id === id);
    if (refs.length && !delNode._force) {
      modal({
        title: '⚠️ ' + t('删除节点将产生失效引用'),
        body: `<div style="font-size:12.5px;line-height:1.8;color:var(--text-2)">${t('以下')} <b>${refs.length}</b> ${t('处引用了')} <span class="code">${esc(id)}</span> ${t('的输出变量，删除后这些引用将失效（标红）')}：<br>` +
          refs.slice(0, 8).map(r => `· <b>${esc(r.nodeId)}</b> ${t('的')} ${esc(r.field)}：<span class="code">${esc(r.preview)}</span>`).join('<br>') +
          (refs.length > 8 ? `<br>… ${t('等共')} ${refs.length} ${t('处')}` : '') + `</div>`,
        foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn danger" data-del>${t('仍然删除')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-close]').onclick = close;
          mask.querySelector('[data-del]').onclick = () => { close(); delNode._force = true; delNode(id); delNode._force = false; };
        },
      });
      return;
    }
    wf.nodes = wf.nodes.filter(n => n.id !== id);
    wf.edges = wf.edges.filter(e => e.source !== id && e.target !== id);
    if (sel === id) sel = null;
    refreshRefWarnings();
    markDirty(); renderNodes(); renderProp(); pushHistory();
    if (refs.length) toast(`⚠️ ${t('已删除，')} ${refs.length} ${t('处引用失效已在画布标红')}`);
  }
  function markDirty() { opts.markDirty?.(); }

  // ---------- P5.4 撤销/重做（快照栈，≤50 步；结构性变更后 push，属性编辑 debounce） ----------
  const HISTORY_MAX = 50;
  let history = [], histIdx = -1, histTimer = null;
  function pushHistory() {
    const snap = JSON.stringify({ nodes: wf.nodes, edges: wf.edges, viewport: wf.viewport, groups: wf.groups, flow_type: wf.flow_type, notes: wf.notes });
    if (history[histIdx] === snap) return;
    history = history.slice(0, histIdx + 1); // 丢弃 redo 分支
    history.push(snap);
    if (history.length > HISTORY_MAX) history.shift();
    histIdx = history.length - 1;
    updateHistBtns();
  }
  function pushHistoryDebounced() { clearTimeout(histTimer); histTimer = setTimeout(pushHistory, 600); }
  function restoreHistory(dir) {
    const next = histIdx + dir;
    if (next < 0 || next >= history.length) return;
    histIdx = next;
    const snap = JSON.parse(history[histIdx]);
    wf.nodes = snap.nodes; wf.edges = snap.edges; wf.viewport = snap.viewport;
    wf.groups = Array.isArray(snap.groups) ? snap.groups : [];
    wf.notes = Array.isArray(snap.notes) ? snap.notes : []; // P5.15 便签随快照恢复
    wf.flow_type = snap.flow_type === 'chatflow' ? 'chatflow' : 'workflow';
    updateModeBtn();
    sel = wf.nodes.some(n => n.id === sel) ? sel : null;
    selSet = selSet ? new Set([...selSet].filter(id => wf.nodes.some(n => n.id === id))) : null; // 多选集过滤已删节点
    refreshRefWarnings(); // 恢复后重算坏引用（删掉的节点可能回来了）
    markDirty(); renderNodes(); renderProp(); applyViewport(); updateHistBtns();
    if (selSet && selSet.size) showSelBar(); else root.querySelector('.cv-selbar')?.remove();
    toast(dir < 0 ? t('已撤销') : t('已重做'));
  }
  function updateHistBtns() {
    const u = $('#cvUndo'), r = $('#cvRedo');
    if (u) u.disabled = histIdx <= 0;
    if (r) r.disabled = histIdx >= history.length - 1;
  }
  $('#cvUndo').onclick = () => restoreHistory(-1);
  $('#cvRedo').onclick = () => restoreHistory(1);
  pushHistory(); // 初始快照

  // ---------- 属性面板 ----------
  function selectNode(id) {
    sel = id; renderNodes(); renderProp();
    // P5.21/P5.22 窄屏与折叠屏展开态：属性面板为抽屉时，选中节点自动展开（手机上点节点即改参数）
    if (propIsDrawer()) togglePanels('prop', true);
  }

  // ---------- P5.21/P5.22 面板抽屉开关（属性面板 ≤800px 均为右侧抽屉） ----------
  // 档位：≤560 组件库走抽屉；561-800 组件库为常驻左栏（🧩 收起/展开，折叠屏展开态/小平板）；>800 桌面三栏
  // 抽屉为 fixed 覆盖层会盖住画布与左上角入口按钮——补一层半透明遮罩：打开即罩住画布防误触，点遮罩收起
  const cvMask = $('#cvDrawerMask');
  const libIsColumn = () => window.innerWidth > 560;
  const propIsDrawer = () => window.innerWidth <= 800;
  function syncMask() { if (cvMask) cvMask.classList.toggle('open', !!(lib?.classList.contains('open') || $('#cvProp')?.classList.contains('open'))); }
  function closeDrawers() { lib?.classList.remove('open'); $('#cvProp')?.classList.remove('open'); syncMask(); }
  function togglePanels(which, force) {
    const el = which === 'lib' ? lib : $('#cvProp');
    if (!el) return;
    const open = typeof force === 'boolean' ? force : !el.classList.contains('open');
    // 互斥：开一个关另一个（窄屏空间只容一屉）
    if (open) { (which === 'lib' ? $('#cvProp') : lib)?.classList.remove('open'); }
    el.classList.toggle('open', open);
    syncMask();
  }
  if (cvMask) cvMask.onclick = closeDrawers; // 点遮罩收起（移动端标准抽屉交互）
  const cvLibBtn = $('#cvLibBtn'), cvPropBtn = $('#cvPropBtn');
  if (cvLibBtn) cvLibBtn.onclick = () => {
    if (libIsColumn()) { lib.classList.remove('open'); lib.classList.toggle('hidden'); syncMask(); } // 常驻栏收起/展开
    else togglePanels('lib');
  };
  if (cvPropBtn) cvPropBtn.onclick = () => togglePanels('prop');
  // 点击画布空白时收起抽屉（不干扰节点选中——选中路径走 selectNode 的自动开屉；遮罩生效时事件先落在遮罩上，此处为兜底）
  stage.addEventListener('mousedown', e => { if (propIsDrawer() && !e.target.closest('.cv-prop') && !e.target.closest('.cv-lib')) closeDrawers(); }, { capture: true });
  // P5.22 折叠屏：折叠/展开瞬间视口跨档（560/800 边界）——重置面板态，防遮罩滞留或常驻栏错位。
  // 监听挂 window：SPA 反复进出编排页会重复挂载，先摘旧实例的监听防堆积。
  const onCvViewportShift = () => { closeDrawers(); lib.classList.remove('hidden'); };
  let cvLastW = window.innerWidth;
  const onCvResize = () => {
    const w = window.innerWidth;
    if ((cvLastW <= 560) !== (w <= 560) || (cvLastW <= 800) !== (w <= 800)) onCvViewportShift();
    cvLastW = w;
  };
  if (window.__cvViewportShiftCleanup) window.__cvViewportShiftCleanup();
  window.addEventListener('resize', onCvResize);
  // Device Posture API（渐进增强，部分安卓折叠机 WebView 支持姿势上报）：折/展切换同样重置面板态
  let cvPostureHandler = null;
  if (navigator.devicePosture && typeof navigator.devicePosture.addEventListener === 'function') {
    cvPostureHandler = () => onCvViewportShift();
    try { navigator.devicePosture.addEventListener('change', cvPostureHandler); } catch { }
  }
  window.__cvViewportShiftCleanup = () => {
    window.removeEventListener('resize', onCvResize);
    if (cvPostureHandler && navigator.devicePosture?.removeEventListener) { try { navigator.devicePosture.removeEventListener('change', cvPostureHandler); } catch { } }
  };
  // 全图可用变量（动态输出：llm 结构化字段 / assign 变量 / code.output / iteration.results；子流程内另有 item/index）
  function allVars() {
    const out = [];
    for (const n of wf.nodes) {
      if (n.type === 'start') {
        out.push({ ref: `start.input`, label: t('开始·用户消息') });
        // P5.11 异常分支：画了 __error__ 出边的节点暴露 {{#节点.__error__#}}（失败原因，补救节点可引用）
        for (const n2 of wf.nodes) {
          if (n2.type === 'start' || !wf.edges.some(e => e.source === n2.id && (e.sourceHandle || 'out') === '__error__')) continue;
          out.push({ ref: `${n2.id}.__error__`, label: t('{n}·失败原因（⚡异常分支）').replace('{n}', n2.data?.title || n2.id) });
        }
        for (const v of n.data?.variables || []) if (v.name) out.push({ ref: `start.${v.name}`, label: t('开始·{n}').replace('{n}', v.name) });
        // P5.7 会话变量（跨轮次持久）：{{#start.名称#}} 引用，assign 写 session.名称
        for (const v of n.data?.session_vars || []) if (v.name) out.push({ ref: `start.${v.name}`, label: t('开始·{n}（💾会话变量）').replace('{n}', v.name) });
      } else if (n.type === 'llm') {
        out.push({ ref: `${n.id}.text`, label: t('{n}·模型回复').replace('{n}', n.data?.title || n.id) });
        // 结构化输出字段
        if (n.data?.output_schema) {
          try {
            const sc = JSON.parse(typeof n.data.output_schema === 'string' ? n.data.output_schema : JSON.stringify(n.data.output_schema));
            const props = sc?.properties || (sc && typeof sc === 'object' ? sc : null);
            if (props && typeof props === 'object') for (const k of Object.keys(props)) out.push({ ref: `${n.id}.${k}`, label: t('{n}·{k}（结构化）').replace('{n}', n.data?.title || n.id).replace('{k}', k) });
          } catch { }
        }
      } else if (n.type === 'assign') {
        for (const a of n.data?.assignments || []) if (a.variable) out.push({ ref: `${n.id}.${a.variable}`, label: t('{n}·{k}（赋值）').replace('{n}', n.data?.title || n.id).replace('{k}', a.variable) });
      } else {
        for (const o of NODE_OUTPUTS[n.type] || []) out.push({ ref: `${n.id}.${o.name}`, label: t('{n}·{k}').replace('{n}', n.data?.title || n.id).replace('{k}', o.label) });
        if (n.type === 'code' && Array.isArray(n.data?.outputs)) {
          for (const k of n.data.outputs) out.push({ ref: `${n.id}.${k}`, label: t('{n}·{k}（代码字段）').replace('{n}', n.data?.title || n.id).replace('{k}', k) });
        }
        // P5.6 工具试运行发现的字段（data._fields）成可引用变量
        if (n.type === 'tool' && Array.isArray(n.data?._fields)) {
          for (const k of n.data._fields) out.push({ ref: `${n.id}.${k}`, label: t('{n}·{k}（工具字段）').replace('{n}', n.data?.title || n.id).replace('{k}', k) });
        }
      }
    }
    return out;
  }
  function varPicker(targetSel) {
    const vs = allVars();
    return `<div style="display:flex;gap:6px;margin-top:4px">
      <select id="cvVarSel" style="flex:1"><option value="">${t('插入变量…')}</option>${vs.map(v => `<option value="{{#${esc(v.ref)}#}}">${esc(v.label)}</option>`).join('')}</select>
      <button class="btn sm" id="cvVarIns" data-target="${targetSel}">＋</button></div>`;
  }
  // P5.5 生产选项块：节点级超时 / 失败重试（指数退避）/ 失败策略三选一（abort|continue|default+默认值）
  function prodOptions(n, c) {
    const isLlm = n.type === 'llm';
    const defTimeout = isLlm ? 120000 : 60000;
    return `
        <div class="fd"><label>⏱ ${t('超时（毫秒，0=默认')} ${isLlm ? '120s' : '60s'}）</label>
          <input class="input" type="number" min="0" max="600000" data-k="timeout" value="${c.timeout ?? defTimeout}"></div>
        <div class="fd"><label>🔁 ${t('失败重试次数（0~3，指数退避）')}</label>
          <input class="input" type="number" min="0" max="3" data-k="retry" value="${c.retry ?? 0}"></div>
        <div class="fd"><label>${t('失败策略')}</label>
          <select class="input" data-k="onError">
            <option value="abort" ${(c.onError || 'abort') === 'abort' ? 'selected' : ''}>${t('中断整个流程（默认）')}</option>
            <option value="continue" ${c.onError === 'continue' ? 'selected' : ''}>${t('跳过并继续')}</option>
            <option value="default" ${c.onError === 'default' ? 'selected' : ''}>${t('使用默认值继续')}</option>
          </select></div>
        ${c.onError === 'default' ? `<div class="fd"><label>${t('默认输出值（失败时注入主输出变量）')}</label>
          <textarea class="input" data-k="default_output" style="min-height:48px">${esc(c.default_output ?? '')}</textarea></div>` : ''}
        <div class="hint" style="margin-top:6px">⚡ ${t('异常分支（优先于以上策略）：把节点底部红色端口连到补救节点——失败时不中断，错误原因存')} <span class="code">{{#${n.id}.__error__#}}</span> ${t('可引用；如「知识库检索失败→不用知识库直接答」「SQL 报错→告知数据暂不可用」')}。</div>`;
  }

  // P5.3 运行结果视图：完整入参/出参 JSON + 状态耗时 + 从此节点重跑
  function renderPropResult(n, rs) {
    const meta = NODE_TYPES[n.type];
    const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
    const statusLine = rs.status === 'success'
      ? `<span style="color:#059669">✅ ${t('成功')} · ${rs.ms != null ? (rs.ms >= 1000 ? (rs.ms / 1000).toFixed(1) + 's' : rs.ms + 'ms') : ''}</span>`
      : rs.status === 'error' ? (rs.viaError ? `<span style="color:#d97706">⚡ ${t('失败（已走异常分支，流程继续）')}</span>` : `<span style="color:#dc2626">❌ ${t('失败')}</span>`)
        : rs.status === 'preset' ? `<span>↺ ${t('沿用上次运行结果（重跑跳过）')}</span>`
          : rs.status === 'skipped' ? `<span>⏭️ ${t('跳过（分支未命中）')}</span>`
            : `<span style="color:#2563eb">⏳ ${t('执行中…')}</span>`;
    prop.innerHTML = `
      <div class="cv-prop-tabs"><button data-tab="config">${t('配置')}</button><button class="on">${t('运行结果')}</button></div>
      <h4><span style="color:${meta.color}">${meta.icon}</span> ${esc(n.data?.title || meta.label)} <small style="color:var(--text-3)">${esc(n.id)}</small></h4>
      <div class="fd" style="margin-top:8px">${statusLine}</div>
      ${rs.error ? `<div class="fd"><label>❌ ${t('错误信息')}</label><div class="cv-json" style="color:#dc2626">${esc(rs.error)}</div></div>` : ''}
      ${rs.childRunId ? `<div class="fd"><button class="btn primary" id="cvDrill" style="width:100%">🔍 ${t('下钻查看子智能体内部执行轨迹')}</button>
        <div class="hint">${t('子智能体按其自身编排图执行（run #' + rs.childRunId + '）——点开看它内部每一轮调用了哪些节点、输出了什么')}</div></div>` : ''}
      ${rs.inputs ? `<div class="fd"><label>📥 ${t('入参（完整）')}</label><div class="cv-json">${esc(pretty(rs.inputs))}</div></div>` : ''}
      ${rs.outputFull ? `<div class="fd"><label>📤 ${t('出参（完整）')}</label><div class="cv-json">${esc(pretty(rs.outputFull))}</div></div>` : ''}
      <button class="btn primary" id="cvRerun" style="width:100%;margin-top:6px">▶ ${t('从此节点重跑')}</button>
      <div class="hint">${t('前序节点沿用上次结果缓存，仅本节点及下游重新执行（改完配置秒验改动）')}。</div>`;
    prop.querySelector('[data-tab="config"]').onclick = () => { propTab = 'config'; renderProp(); };
    prop.querySelector('#cvDrill')?.addEventListener('click', () => openChildRun(rs.childRunId, n.data?.title));
    prop.querySelector('#cvRerun').onclick = () => runTestSSE(n.id);
  }

  // P5.4 `{` 变量选择浮层（全局单例）：模板字段输入 { 触发，列出上游变量；继续输入过滤；↑↓ 选择、Enter/Tab/点击插入；Esc 关闭
  let varPop = null, varPopCtx = null; // { ta, startPos, filter }
  function closeVarPop() { varPop?.remove(); varPop = null; varPopCtx = null; }
  function bindVarPopup() {
    // 绑定当前属性面板中所有模板类 textarea（prompt/system_prompt/args/input/code inputs/end template）
    prop.querySelectorAll('textarea[data-k], textarea#cvCodeIn').forEach(ta => {
      if (ta.dataset.varBound) return;
      ta.dataset.varBound = '1';
      ta.addEventListener('input', () => maybeShowVarPop(ta));
      ta.addEventListener('keydown', e => {
        if (!varPop) return;
        if (e.key === 'Escape') { closeVarPop(); return; }
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
          e.preventDefault();
          const items = [...(varPop?.querySelectorAll('.vi') || [])];
          if (!items.length) { closeVarPop(); return; }
          let idx = items.findIndex(x => x.classList.contains('act'));
          if (e.key === 'ArrowDown') idx = Math.min(items.length - 1, idx + 1);
          else if (e.key === 'ArrowUp') idx = Math.max(0, idx - 1);
          else { insertVarRef(items[Math.max(0, idx)]); return; }
          items.forEach(x => x.classList.toggle('act', x === items[idx]));
          items[idx].scrollIntoView({ block: 'nearest' });
        }
      });
      ta.addEventListener('blur', () => setTimeout(closeVarPop, 180));
    });
  }
  function maybeShowVarPop(ta) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = before.match(/\{([^{}\n]*)$/); // 触发：光标前有未闭合的 {
    if (!m) { if (varPopCtx && varPopCtx.ta === ta) closeVarPop(); return; }
    const filter = m[1].toLowerCase();
    // 已输入 {{# 的情况不算触发（避免在编辑既有引用时重复弹）
    if (filter.startsWith('{') || filter.includes('#')) { closeVarPop(); return; }
    const cands = allVars().filter(v => !filter || v.ref.toLowerCase().includes(filter) || v.label.toLowerCase().includes(filter)).slice(0, 12);
    closeVarPop();
    if (!cands.length) return;
    varPopCtx = { ta, startPos: pos - m[0].length }; // { 的位置
    varPop = document.createElement('div');
    varPop.className = 'cv-varpop';
    varPop.innerHTML = `<div class="vh">${t('选择变量插入（↑↓ 选择 · Enter 插入 · Esc 关闭）')}</div>` +
      cands.map((v, i) => `<div class="vi ${i === 0 ? 'act' : ''}" data-ref="${esc(v.ref)}"><span>{{#${esc(v.ref)}#}}</span><code style="margin-left:auto">${esc(v.label)}</code></div>`).join('');
    // 定位：textarea 下方（简单对齐左下角）
    const r = ta.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    varPop.style.left = (r.left - host.left) + 'px';
    varPop.style.top = (r.bottom - host.top + 4) + 'px';
    varPop.style.maxWidth = Math.max(240, r.width) + 'px';
    root.appendChild(varPop);
    varPop.querySelectorAll('.vi').forEach(item => item.onmousedown = e => { e.preventDefault(); insertVarRef(item); });
  }
  function insertVarRef(item) {
    if (!varPopCtx || !item) { closeVarPop(); return; }
    const ta = varPopCtx.ta, ref = item.dataset.ref;
    const pos = ta.selectionStart;
    // 删除触发的 {（从 startPos 到当前光标，去掉过滤词）
    ta.value = ta.value.slice(0, varPopCtx.startPos) + `{{#${ref}#}}` + ta.value.slice(pos);
    const newPos = varPopCtx.startPos + ref.length + 7;
    ta.setSelectionRange(newPos, newPos);
    closeVarPop();
    ta.dispatchEvent(new Event('input')); // 触发数据同步
    ta.focus();
  }

  // ---------- P5.4 小地图（>10 节点显示；缩略节点+视口框；点击定位视口中心） ----------
  function renderMinimap() {
    const mini = $('#cvMini'), host = $('#cvMiniHost');
    if (!mini || !host) return;
    if (wf.nodes.length <= 10) { mini.style.display = 'none'; return; }
    mini.style.display = '';
    const PAD = 60;
    const xs = wf.nodes.map(n => n.position.x), ys = wf.nodes.map(n => n.position.y);
    const minX = Math.min(...xs) - PAD, minY = Math.min(...ys) - PAD;
    const maxX = Math.max(...xs.map(x => x + 212)) + PAD, maxY = Math.max(...ys.map(y => y + 140)) + PAD;
    const W = maxX - minX, H = maxY - minY;
    const scale = Math.min(mini.clientWidth / W, mini.clientHeight / H, 0.28);
    const ox = (mini.clientWidth - W * scale) / 2, oy = (mini.clientHeight - H * scale) / 2;
    let html = '';
    // P5.6 分组底板（半透明色块，折叠组加边框标记）
    for (const g of wf.groups || []) {
      const members = (g.nodeIds || []).map(id => wf.nodes.find(n => n.id === id)).filter(Boolean);
      if (!members.length) continue;
      const gx1 = Math.min(...members.map(n => n.position.x)) - 18, gy1 = Math.min(...members.map(n => n.position.y)) - 22;
      const gx2 = Math.max(...members.map(n => n.position.x + 212)) + 18, gy2 = Math.max(...members.map(n => n.position.y + 130)) + 14;
      html += `<div style="position:absolute;left:${ox + (gx1 - minX) * scale}px;top:${oy + (gy1 - minY) * scale}px;width:${(gx2 - gx1) * scale}px;height:${(gy2 - gy1) * scale}px;background:${g.color}22;border-radius:3px;${g.collapsed ? 'outline:1.5px solid ' + g.color + ';' : ''}"></div>`;
    }
    for (const n of wf.nodes) {
      const meta = NODE_TYPES[n.type] || { color: '#6b7280' };
      html += `<div class="mm-node" style="left:${ox + (n.position.x - minX) * scale}px;top:${oy + (n.position.y - minY) * scale}px;width:${Math.max(3, 212 * scale)}px;height:${Math.max(3, 52 * scale)}px;background:${meta.color};opacity:.75;${refWarnings[n.id]?.length ? 'outline:1.5px solid #d97706;' : ''}"></div>`;
    }
    // 视口框：stage 可视世界区域 = (-viewport.x/zoom, -viewport.y/zoom) 起，宽高 = stage/zoom
    const r = stage.getBoundingClientRect();
    const vw = r.width / wf.viewport.zoom, vh = r.height / wf.viewport.zoom;
    const vx = -wf.viewport.x / wf.viewport.zoom, vy = -wf.viewport.y / wf.viewport.zoom;
    html += `<div class="mm-view" style="left:${ox + (vx - minX) * scale}px;top:${oy + (vy - minY) * scale}px;width:${vw * scale}px;height:${vh * scale}px"></div>`;
    host.innerHTML = html;
  }
  // 点击小地图：视口居中到对应世界坐标
  $('#cvMini').onclick = e => {
    if (!wf.nodes.length) return;
    const mini = $('#cvMini');
    const rect = mini.getBoundingClientRect();
    const PAD = 60;
    const xs = wf.nodes.map(n => n.position.x), ys = wf.nodes.map(n => n.position.y);
    const minX = Math.min(...xs) - PAD, minY = Math.min(...ys) - PAD;
    const maxX = Math.max(...xs.map(x => x + 212)) + PAD, maxY = Math.max(...ys.map(y => y + 140)) + PAD;
    const W = maxX - minX, H = maxY - minY;
    const scale = Math.min(mini.clientWidth / W, mini.clientHeight / H, 0.28);
    const ox = (mini.clientWidth - W * scale) / 2, oy = (mini.clientHeight - H * scale) / 2;
    const cx = (e.clientX - rect.left - ox) / scale + minX;
    const cy = (e.clientY - rect.top - oy) / scale + minY;
    const r = stage.getBoundingClientRect();
    wf.viewport.x = r.width / 2 - cx * wf.viewport.zoom;
    wf.viewport.y = r.height / 2 - cy * wf.viewport.zoom;
    applyViewport(); renderMinimap();
  };

  function renderProp() {
    if (sel == null || typeof sel === 'object') {
      prop.innerHTML = `<h4>⬅ ${t('未选中节点')}</h4>
        <div class="hint" style="margin-top:8px">${t('点击画布中的节点查看与配置参数')}<br><br>${t('可用变量（统一 {{#节点.变量#}} 引用）')}：<br><span class="code">${esc(allVars().map(v => `{{#${v.ref}#}}`).join(' · ')).slice(0, 400)}</span></div>`;
      return;
    }
    const n = wf.nodes.find(x => x.id === sel);
    if (!n) { prop.innerHTML = ''; return; }
    const meta = NODE_TYPES[n.type];
    const c = n.data || (n.data = {});
    // P5.3 双 tab：配置 | 运行结果（有运行数据时）
    const rs = runState[n.id];
    if (propTab === 'result' && rs) {
      renderPropResult(n, rs);
      return;
    }
    if (propTab === 'result' && !rs) {
      prop.innerHTML = `<div class="cv-prop-tabs"><button class="on">${t('运行结果')}</button><button data-tab="config">${t('配置')}</button></div>
        <div class="hint" style="margin-top:12px">${t('该节点暂无运行数据——先点右上「▶ 运行测试」执行一次')}。</div>`;
      prop.querySelector('[data-tab="config"]').onclick = () => { propTab = 'config'; renderProp(); };
      return;
    }
    const tabs = rs ? `<div class="cv-prop-tabs"><button class="${propTab === 'config' ? 'on' : ''}" data-tab="config">${t('配置')}</button><button class="${propTab === 'result' ? 'on' : ''}" data-tab="result">${t('运行结果')}</button></div>` : '';
    let body = '';
    if (n.type === 'start') {
      body = `<div class="hint">${t('用户消息自动绑定为 {{#start.input#}}；可定义额外变量（供下游引用，默认值可留空）')}。${t('📄 文件类型：测试/聊天上传文件后按 id 流转，引用时自动注入内容')}</div>` +
        (c.variables || []).map((v, i) => `
        <div class="fd"><label>${t('变量')} ${i + 1}${v.type === 'file' || v.type === 'array[file]' ? ' <span style="color:#d97706">📄</span>' : ''}</label>
          <div style="display:flex;gap:6px">
            <input class="input" data-k="variables.name" data-i="${i}" value="${esc(v.name || '')}" placeholder="变量名" style="flex:1">
            <select class="input" data-k="variables.type" data-i="${i}" style="width:112px" title="${t('变量类型')}">
              <option value="string" ${!v.type || v.type === 'string' ? 'selected' : ''}>${t('文本')}</option>
              <option value="number" ${v.type === 'number' ? 'selected' : ''}>${t('数字')}</option>
              <option value="file" ${v.type === 'file' ? 'selected' : ''}>📄 ${t('文件')}</option>
              <option value="array[file]" ${v.type === 'array[file]' ? 'selected' : ''}>📄 ${t('文件数组')}</option>
            </select>
            <button class="btn" data-delvar="${i}">✕</button>
          </div>
          ${(v.type === 'file' || v.type === 'array[file]') ? `<div class="hint" style="margin-top:4px">${t('运行时传文件 id（测试弹窗/聊天附件上传）；引用')} <span class="code">{{#start.${esc(v.name || '名称')}#}}</span> ${t('自动注入文件内容')}</div>` : `<input class="input" data-k="variables.default" data-i="${i}" value="${esc(v.default || '')}" placeholder="${t('默认值')}" style="margin-top:6px">`}
        </div>`).join('') +
        `<button class="btn" id="cvAddVar" style="width:100%">＋ ${t('添加变量')}</button>` +
        `<div class="fd" style="margin-top:14px"><label>💾 ${t('会话变量（跨轮次持久）')}</label>
          <div class="hint">${wf.flow_type === 'chatflow' ? `Chatflow ${t('下按会话持久：每轮从会话加载，assign 用')} <span class="code">session.名称</span> ${t('写入，轮末自动存回（姓名/偏好/累计计数等跨轮记忆）')}` : `${t('当前为 Workflow 单次执行——会话变量仅本轮内生效（临时态）；跨轮持久需切「💬 Chatflow」')}`}</div></div>` +
        (c.session_vars || []).map((v, i) => `
        <div class="fd" style="border:1px dashed #93c5fd;border-radius:8px;padding:8px;background:rgba(37,99,235,.03)"><label>💾 ${t('会话变量')} ${i + 1}</label>
          <div style="display:flex;gap:6px">
            <input class="input" data-k="svars.name" data-i="${i}" value="${esc(v.name || '')}" placeholder="${t('变量名（如 user_name）')}">
            <input class="input" data-k="svars.default" data-i="${i}" value="${esc(v.default || '')}" placeholder="${t('默认值（如 游客）')}">
            <button class="btn" data-delsvar="${i}">✕</button>
          </div>
          <input class="input" data-k="svars.desc" data-i="${i}" value="${esc(v.desc || '')}" placeholder="${t('说明（可选，如 用户登记的姓名）')}" style="margin-top:6px">
          <div class="hint" style="margin-top:4px">${t('引用')} <span class="code">{{#start.${esc(v.name || '名称')}#}}</span> · assign ${t('写入')} <span class="code">session.${esc(v.name || '名称')}</span></div></div>`).join('') +
        `<button class="btn" id="cvAddSVar" style="width:100%">＋ 💾 ${t('添加会话变量')}</button>`;
    } else if (n.type === 'llm') {
      body = `
        <div class="fd"><label>${t('模型')}</label>
          <select class="input" data-k="model">
            ${modelOptions(c.model)}
          </select>
           <div class="hint">💡 ${t('仅对话模型可用于本节点；其余类型已列出并标注去向（生图/语音用工具节点，视频用前台视频模式）')}——${t('全部')} ${models.length} ${t('个模型')}（${t('对话')} ${models.filter(m => (m.type || 'chat') === 'chat').length}）</div></div>
        <div class="fd"><label>${t('系统提示词（可选）')}</label>
          <textarea class="input" data-k="system_prompt" style="min-height:56px">${esc(c.system_prompt || '')}</textarea></div>
        <div class="fd"><label>🛡️ ${t('备用模型（故障转移，可多选）')}</label>
          <div id="cvFbModels" style="display:flex;flex-wrap:wrap;gap:6px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px;max-height:110px;overflow-y:auto">
            ${models.filter(m => (m.type || 'chat') === 'chat' && m.name !== (c.model || '')).map(m => `
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-2);cursor:pointer;background:var(--surface-2,#f3f4f6);border-radius:12px;padding:3px 10px">
                <input type="checkbox" data-fbm="${esc(m.name)}" ${(c.fallback_models || []).includes(m.name) ? 'checked' : ''}>${esc(m.name)}
              </label>`).join('') || `<span class="hint">${t('无其他对话模型可作备用')}</span>`}
          </div>
          <div class="hint">⚡ ${t('主模型')}<b>${t('超时 / 429 限流 / 5xx 故障')}</b>${t('时，按勾选顺序自动切备用模型重试——模型供应商抖一下，企业工作流不挂')}（${t('鉴权/参数类 4xx 不切换，报错更准')}）${(c.fallback_models || []).length ? `<br>📍 ${t('当前顺序：')}<span class="code">${(c.fallback_models || []).join(' → ')}</span>${t('（取消重勾可调整顺序）')}` : ''}</div></div>
        <div class="fd"><label>${t('提示词')}</label>
          <textarea class="input" data-k="prompt" id="cvPromptTa" placeholder="${t('例：把以下内容改写得更礼貌：{{#start.input#}}')}">${esc(c.prompt || '')}</textarea>
          ${varPicker('cvPromptTa')}</div>
        <div class="fd"><label>${t('最大输出 tokens')}</label>
          <input class="input" type="number" data-k="max_tokens" value="${c.max_tokens ?? 1024}"></div>
        <div class="fd"><label>${t('温度')}（0~1）</label>
          <input class="input" type="number" step="0.1" min="0" max="1" data-k="temperature" value="${c.temperature ?? 0.7}"></div>
        <div class="fd"><label>📋 ${t('结构化输出 JSON Schema（可选）')}</label>
          <textarea class="input" data-k="output_schema" id="cvSchemaTa" style="min-height:72px" placeholder='${t('例：{"properties":{"customer":{"type":"string"},"amount":{"type":"number"}}}——各字段成为下游可引用变量')}'>${esc(typeof c.output_schema === 'string' ? (c.output_schema || '') : JSON.stringify(c.output_schema || ''))}</textarea>
          <div class="hint">${t('填写后模型被要求严格输出 JSON，各字段可直接')} <span class="code">{{#${n.id}.字段#}}</span> ${t('引用（如抽取客户名/金额/日期）')}</div></div>
        <div class="fd"><label>💬 ${t('上下文设置')}</label>
          <label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" data-k="ctx_history" ${c.context?.use_history ? 'checked' : ''}> ${t('携带对话历史（多轮对话式工作流）')}</label>
          ${c.context?.use_history ? `<div style="display:flex;gap:6px;margin-top:6px;align-items:center"><span style="font-size:11px;color:var(--text-3)">${t('携带轮数')}</span><input class="input" type="number" min="1" max="20" data-k="ctx_rounds" value="${c.context?.rounds ?? 3}" style="width:70px"></div>` : ''}</div>
        ${prodOptions(n, c)}
        <div class="hint">🤖 ${t('输出变量')}：<span class="code">{{#${n.id}.text#}}</span></div>`;
    } else if (n.type === 'tool') {
      body = `
        <div class="fd"><label>${t('工具')}</label>
          <select class="input" data-k="toolId">
            ${TOOL_OPTIONS.map(([id, ic, label]) => `<option value="${id}" ${c.toolId === id ? 'selected' : ''}>${ic} ${esc(label)}（${id}）</option>`).join('')}
          </select></div>
        <div class="fd"><label>${t('参数 JSON')}</label>
          <textarea class="input" data-k="args" id="cvArgsTa">${esc(c.args || '{}')}</textarea>
          ${varPicker('cvArgsTa')}
          <div class="hint">${t('例')}：<span class="code">{"query":"{{#start.input#}}"}</span></div>
          <div class="hint">📄 ${t('值为纯引用时传递原始对象（含文件变量）')}：<span class="code">{"file_id":"{{#start.变量#}}"}</span>${t('——文档评审等工具可直接评审上传的文件；混合文字的模板仍按文本渲染')}</div></div>
        <div class="fd"><button class="btn" id="cvToolTry" style="width:100%">⚡ ${t('试运行（跑一次看返回字段）')}</button>
          <div class="hint" style="margin-top:4px">${t('真实执行一次该工具，展示返回 JSON 与顶层字段——字段可点击复制成')} <span class="code">{{#${n.id}.字段#}}</span> ${t('供下游引用（同时写入节点字段清单）')}</div></div>
        <div id="cvToolTryOut"></div>
        ${(c._fields || []).length ? `<div class="fd"><label>📋 ${t('已发现字段（点击复制引用）')}</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${(c._fields || []).map(f => `<button class="btn sm" data-field="${esc(f)}" style="font-family:ui-monospace,monospace">{{#${n.id}.${esc(f)}#}}</button>`).join('')}</div></div>` : ''}
        ${prodOptions(n, c)}
        <div class="hint">🔧 ${t('输出变量')}：<span class="code">{{#${n.id}.result#}}</span>${(c._fields || []).length ? ' · ' + (c._fields || []).map(f => `<span class="code">{{#${n.id}.${esc(f)}#}}</span>`).join(' ') : ''}</div>
        <div class="hint">🔐 ${t('参数中可用')} <span class="code">{{env.XXX}}</span> ${t('引用服务端密钥（后台「密钥管理」配置，不落画布 JSON）')}</div>`;
    } else if (n.type === 'agent') {
      body = `
        <div class="fd"><label>${t('选择子智能体')}</label>
          <select class="input" data-k="agentId">
            <option value="">${t('请选择…')}</option>
            ${agents.map(a => `<option value="${a.id}" ${String(c.agentId) === String(a.id) ? 'selected' : ''}>${esc(a.icon || '🧠')} ${esc(a.name)}</option>`).join('')}
          </select></div>
        <div class="fd"><label>${t('传给它的输入（模板）')}</label>
          <textarea class="input" data-k="input" id="cvAgentIn">${esc(c.input || '{{#start.input#}}')}</textarea>
          ${varPicker('cvAgentIn')}</div>
        ${prodOptions(n, c)}
        <div class="hint">🧠 ${t('输出变量')}：<span class="code">{{#${n.id}.reply#}}</span></div>`;
    } else if (n.type === 'code') {
      body = `
        <div class="fd"><label>${t('输入变量（JSON：变量名→模板）')}</label>
          <textarea class="input" data-k="inputs" id="cvCodeIn" style="min-height:60px">${esc(typeof c.inputs === 'string' ? (c.inputs || '{}') : JSON.stringify(c.inputs || {}))}</textarea>
          ${varPicker('cvCodeIn')}
          <div class="hint">${t('例')}：<span class="code">{"raw":"{{#start.input#}}"}</span> → ${t('代码内直接用变量')} <span class="code">raw</span></div></div>
        <div class="fd"><label>⌨️ ${t('代码（JS 函数体，return 值作输出）')}</label>
          <textarea class="input" data-k="code" id="cvCodeTa" style="min-height:150px;font-family:ui-monospace,monospace;font-size:11.5px">${esc(c.code || 'return input;')}</textarea>
          <div class="hint">${t('沙箱执行（无网络/无文件，3 秒超时）；字符串拼接/JSON 解析/数组处理零 LLM 成本；return 对象的各字段成为下游变量')}</div></div>
        <div class="fd"><label>${t('超时（毫秒）')}</label>
          <input class="input" type="number" data-k="timeout" value="${c.timeout ?? 3000}"></div>
        <div class="hint">⌨️ ${t('输出变量')}：<span class="code">{{#${n.id}.output#}}</span>（${t('return 对象字段同名可用')}）</div>`;
    } else if (n.type === 'iteration') {
      const subCount = c.subflow?.nodes?.length || 0;
      body = `
        <div class="fd"><label>${t('输入数组（模板）')}</label>
          <textarea class="input" data-k="input" id="cvIterIn" style="min-height:60px" placeholder='${t('JSON 数组或换行分隔文本，如 {{#node_2.output#}} 或 ["a","b"]')}'>${esc(c.input || '[]')}</textarea>
          ${varPicker('cvIterIn')}</div>
        <div class="fd"><label>🔁 ${t('子流程（逐条执行）')}</label>
          <button class="btn" id="cvEditSub" style="width:100%">${subCount ? `✏️ ${t('编辑子流程')}（${subCount} ${t('节点')}）` : `➕ ${t('搭建子流程')}`}</button>
          <div class="hint">${t('子流程内用')} <span class="code">{{item}}</span>（${t('当前条目')}）/<span class="code">{{index}}</span>（${t('序号')}）；${t('其 end 首输出逐条汇总为')} <span class="code">{{#${n.id}.results#}}</span>（${t('JSON 数组')}）</div></div>
        <div class="fd"><label>${t('单条失败策略')}</label>
          <select class="input" data-k="onError">
            <option value="abort" ${(c.onError || 'abort') === 'abort' ? 'selected' : ''}>${t('中断（默认）')}</option>
            <option value="continue" ${c.onError === 'continue' ? 'selected' : ''}>${t('跳过该条继续')}</option>
          </select></div>
        <div class="hint">🔁 ${t('输出变量')}：<span class="code">{{#${n.id}.results#}}</span> · <span class="code">{{#${n.id}.count#}}</span></div>`;
    } else if (n.type === 'assign') {
      body = `<div class="hint">${t('流程中间修改变量：set 赋值 / append 追加 / clear 清空；赋值后下游用')} <span class="code">{{#${n.id}.变量名#}}</span> ${t('引用')}。</div>` +
        `<div class="hint" style="margin-top:6px">💾 ${t('会话变量：变量名写')} <span class="code">session.名称</span> ${t('（start 已定义的会话变量）→ 跨轮次持久（写入后下游 {{#start.名称#}} 立即生效，轮末存回会话）')}。</div>` +
        (c.assignments || []).map((a, i) => `
        <div class="fd" style="border:1px solid var(--border,#eef0f3);border-radius:8px;padding:8px">
          <label>${t('赋值')} ${i + 1}</label>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <input class="input" data-k="assignments.variable" data-i="${i}" value="${esc(a.variable || '')}" placeholder="${t('变量名')}">
            <select class="input" style="width:90px" data-k="assignments.operator" data-i="${i}">
              <option value="set" ${(a.operator || 'set') === 'set' ? 'selected' : ''}>set</option>
              <option value="append" ${a.operator === 'append' ? 'selected' : ''}>append</option>
              <option value="clear" ${a.operator === 'clear' ? 'selected' : ''}>clear</option>
            </select>
            <button class="btn" data-delassign="${i}">✕</button>
          </div>
          ${a.operator !== 'clear' ? `<textarea class="input" data-k="assignments.value" data-i="${i}" style="min-height:48px" placeholder="${t('值（支持变量模板）')}">${esc(a.value || '')}</textarea>` : ''}
        </div>`).join('') +
        `<button class="btn" id="cvAddAssign" style="width:100%">＋ ${t('添加赋值')}</button>`;
    } else if (n.type === 'if-else') {
      body = `<div class="hint">${t('IF/ELIF/ELSE：按顺序判定，第一条命中即走对应出边；ELSE 兜底。多条件用 AND/OR 组合；每个分支从节点右侧对应行圆点拖出连线。')}</div>` +
        (c.cases || []).map((cs, i) => `
        <div class="fd" style="border:1px solid var(--border,#eef0f3);border-radius:8px;padding:8px">
          <label>${cs.isFallback ? 'ELSE ' : (i === 0 ? 'IF ' : 'ELIF ')}${t('分支')}</label>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <input class="input" data-k="cases.label" data-i="${i}" value="${esc(cs.label || '')}" placeholder="${t('分支名（连线标签）')}">
            <button class="btn" data-delrule="${i}">✕</button>
          </div>
          ${cs.isFallback ? `<div class="hint">${t('兜底分支：全不命中时走这里')}</div>` : `
          ${(cs.conditions || []).map((cd, j) => `
          <div style="display:flex;gap:5px;margin-top:${j ? 4 : 0}px;align-items:center">
            <select class="input" style="flex:1.1" data-k="cd.variable" data-i="${i}" data-j="${j}">
              ${allVars().map(v => `<option value="${esc(v.ref)}" ${cd.variable === v.ref ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
            </select>
            <select class="input" style="flex:1" data-k="cd.type" data-i="${i}" data-j="${j}">
              ${OPERATORS.map(([id, lb]) => `<option value="${id}" ${cd.type === id ? 'selected' : ''}>${lb}</option>`).join('')}
            </select>
            ${NO_VALUE_OPS.has(cd.type) ? '' : `<input class="input" style="flex:0.9" data-k="cd.value" data-i="${i}" data-j="${j}" value="${esc(cd.value || '')}" placeholder="${t('值')}">`}
            <button class="btn" data-delcond="${i}" data-j="${j}" style="padding:2px 6px">✕</button>
          </div>`).join('')}
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <select class="input" style="width:92px" data-k="cases.logical" data-i="${i}">
              <option value="AND" ${(cs.logical || 'AND') === 'AND' ? 'selected' : ''}>AND（且）</option>
              <option value="OR" ${cs.logical === 'OR' ? 'selected' : ''}>OR（或）</option>
            </select>
            <button class="btn sm" data-addcond="${i}" style="flex:1">＋ ${t('条件')}</button>
          </div>`}
        </div>`).join('') +
        `<button class="btn" id="cvAddRule" style="width:100%">＋ ${t('添加 ELIF 分支')}</button>`;
    } else if (n.type === 'answer') {
      body = `
        <div class="fd"><label>💬 ${t('回复内容（模板）')}</label>
          <textarea class="input" data-k="text" id="cvAnsTa" style="min-height:100px" placeholder="${t('例：好的，已收到您的问题：{{#start.input#}}')}">${esc(c.text || '')}</textarea>
          ${varPicker('cvAnsTa')}</div>
        ${wf.flow_type === 'chatflow' ? `<div class="hint">💬 <b>Chatflow 模式</b>：${t('执行到此节点即时流式回复用户，流程继续往下；最终回复=各直接回复拼接（end 不再产出回复）')}。</div>` : `<div class="hint">⚙️ <b>Workflow 模式</b>：${t('当前为一次性执行，直接回复内容会在运行结果中展示；客服/多轮场景建议切「💬 Chatflow」（右上模式按钮）')}。</div>`}
        <div class="hint">📤 ${t('输出变量')}：<span class="code">{{#${n.id}.text#}}</span>（${t('下游可引用')}）</div>`;
    } else if (n.type === 'classifier') {
      body = `<div class="hint">🎯 ${t('LLM 意图分类：用户输入分到 N 个类别之一，每个类别一条分支（右侧对应行圆点拖出连线）；未命中走 default 兑底')}。</div>` +
        (c.categories || []).map((ct, i) => `
        <div class="fd" style="border:1px solid var(--border,#eef0f3);border-radius:8px;padding:8px">
          <label>${t('类别')} ${i + 1}</label>
          <div style="display:flex;gap:6px">
            <input class="input" data-k="cats.name" data-i="${i}" value="${esc(ct.name || '')}" placeholder="${t('类别名（如 售后咨询）')}">
            <button class="btn" data-delcat="${i}">✕</button>
          </div></div>`).join('') +
        `<button class="btn" id="cvAddCat" style="width:100%">＋ ${t('添加类别')}</button>
        <div class="fd"><label>📝 ${t('分类补充说明（可选）')}</label>
          <textarea class="input" data-k="instruction" style="min-height:56px" placeholder="${t('例：订单物流类问物流进度；售后类问退换货与维修')}">${esc(c.instruction || '')}</textarea></div>
        <div class="fd"><label>${t('分类模型')}</label>
          <select class="input" data-k="model">
            ${modelOptions(c.model)}
          </select>
          <div class="hint">💡 ${t('同大模型节点：仅对话模型可用，其余类型仅供查看')}</div></div>
        ${prodOptions(n, c)}
        <div class="hint">📤 ${t('输出变量')}：<span class="code">{{#${n.id}.class_name#}}</span>（${t('命中类别名，下游可引用')}）</div>`;
    } else if (n.type === 'aggregator') {
      body = `<div class="hint">🔀 ${t('并行/条件分支汇合点：first=取第一个非空（未命中分支缺输出兼容）；array=全部拼成数组')}。</div>` +
        (c.sources || []).map((s, i) => `
        <div class="fd" style="border:1px solid var(--border,#eef0f3);border-radius:8px;padding:8px">
          <label>${t('来源')} ${i + 1}</label>
          <div style="display:flex;gap:6px">
            <input class="input" data-k="aggr.variable" data-i="${i}" value="${esc(s.variable || '')}" placeholder="{{#node_1.output#}}">
            <button class="btn" data-delagg="${i}">✕</button>
          </div></div>`).join('') +
        `<button class="btn" id="cvAddAggSrc" style="width:100%">＋ ${t('添加来源')}</button>
        <div class="fd"><label>${t('聚合方式')}</label>
          <select class="input" data-k="aggr.mode">
            <option value="first" ${(c.mode || 'first') === 'first' ? 'selected' : ''}>${t('first · 首个非空')}</option>
            <option value="array" ${c.mode === 'array' ? 'selected' : ''}>${t('array · 拼成数组')}</option>
           </select></div>
         <div class="hint">📤 ${t('输出变量')}：<span class="code">{{#${n.id}.output#}}</span>${c.mode === 'array' ? ` · <span class="code">{{#${n.id}.array#}}</span>（${t('数组')}）` : ''}</div>`;
    } else if (n.type === 'knowledge') {
      // AI-08（2026-11-23）知识库检索节点：一等 RAG 节点——检索指定库，输出 chunks/text/count 供下游引用
      body = `
        <div class="fd"><label>📚 ${t('知识库')}</label>
          <select class="input" data-k="kb_id">
            <option value="">${t('请选择…')}</option>
            ${kbs.map(k => `<option value="${k.id}" ${String(c.kb_id) === String(k.id) ? 'selected' : ''}>📚 ${esc(k.name)}（${k.doc_count || 0} ${t('文档')}）</option>`).join('')}
          </select>
          ${kbs.length ? '' : `<div class="hint">⚠️ ${t('暂无可选知识库——请先在「知识库」页创建并上传文档')}</div>`}</div>
        <div class="fd"><label>${t('检索查询（模板）')}</label>
          <textarea class="input" data-k="query" id="cvKbQueryTa">${esc(c.query || '{{#start.input#}}')}</textarea>
          ${varPicker('cvKbQueryTa')}
          <div class="hint">💡 ${t('默认检索用户消息；可引用上游变量构造精准查询（如分类器命中类 → 按类检索；前置 LLM 抽取关键词 → 关键词检索）')}</div></div>
        <div class="fd" style="display:flex;gap:10px">
          <div style="flex:1"><label>${t('返回条数 TopN')}</label>
            <input class="input" type="number" min="1" max="50" data-k="top_n" value="${c.top_n ?? 5}"></div>
          <div style="flex:1"><label>${t('相似度阈值')}</label>
            <input class="input" type="number" step="0.01" min="0" max="1" data-k="threshold" value="${c.threshold ?? ''}" placeholder="0.01">
            <div class="hint">${t('留空 = 0.01 不过滤')}</div></div>
        </div>
        <div class="fd" style="display:flex;gap:10px">
          <div style="flex:1"><label>⚡ ${t('重排')}</label>
            <select class="input" data-k="rerank_enabled">
              <option value="" ${(c.rerank_enabled ?? '') === '' ? 'selected' : ''}>${t('沿用库级默认')}</option>
              <option value="on" ${c.rerank_enabled === 'on' ? 'selected' : ''}>${t('强制开启')}</option>
              <option value="off" ${c.rerank_enabled === 'off' ? 'selected' : ''}>${t('强制关闭')}</option>
            </select></div>
          <div style="flex:1"><label>${t('重排模型（可选）')}</label>
            <input class="input" data-k="rerank_model" value="${esc(c.rerank_model || '')}" placeholder="bge-reranker-v2-m3"></div>
        </div>
        <div class="fd"><label>🛡️ ${t('元数据过滤（JSON，可选）')}</label>
          <textarea class="input" data-k="metadata_filter" style="min-height:52px" placeholder='${t('例：{"level":"公开"}——仅命中满足条件的分块（同智能体挂库过滤语义）')}'>${esc(c.metadata_filter || '')}</textarea></div>
        <div class="fd"><label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" data-k="kb_rewrite" ${(c.rewrite ?? true) !== false ? 'checked' : ''}> ${t('多轮改写（携带对话历史消解指代；Chatflow 多轮场景建议开启）')}</label></div>
        <div class="fd"><button class="btn" id="cvKbTest" style="width:100%">🧪 ${t('节点级召回测试（按当前配置跑一次）')}</button>
          <div class="hint" style="margin-top:4px">${t('用当前配置真实检索一次验证命中质量——查询中的变量模板先按默认值代入；与「运行测试」独立，不产生节点输出')}</div></div>
        <div id="cvKbTestOut"></div>
        ${prodOptions(n, c)}
        <div class="hint">📚 ${t('输出变量')}：<span class="code">{{#${n.id}.text#}}</span>（${t('拼接上下文')}） · <span class="code">{{#${n.id}.count#}}</span> · <span class="code">{{#${n.id}.chunks#}}</span><br>💡 ${t('下游 LLM 提示词嵌')} <span class="code">{{#${n.id}.text#}}</span> ${t('即为经典 RAG 编排；可一图多库多次检索')}</div>`;
    } else if (n.type === 'end') {
      body = `
        <div class="fd"><label>${t('最终回复模板')}</label>
          <textarea class="input" data-k="outputs0.value" id="cvEndTpl" style="min-height:120px">${esc(c.outputs?.[0]?.value || '')}</textarea>
          ${varPicker('cvEndTpl')}</div>
        <div class="hint">🟥 ${t('首个输出作为对话最终回复')}；${t('可用变量')}：<span class="code">${esc(allVars().map(v => `{{#${v.ref}#}}`).join('·')).slice(0, 200)}</span></div>`;
    }
    prop.innerHTML = `${tabs}<h4><span style="color:${meta.color}">${meta.icon}</span> ${esc(c.title || meta.label)} <small style="color:var(--text-3)">${esc(n.id)}</small></h4>${refWarnings[n.id]?.length ? `<div class="cv-refwarn">⚠ ${t('存在失效引用：')} ${refWarnings[n.id].map(r => `{{#${esc(r)}#}}`).join('、')}（${t('引用的节点已删除，请修正或清除')}）</div>` : ''}${body}`;
    // tab 切换（有运行结果时）
    prop.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { propTab = b.dataset.tab; renderProp(); });

    // 变量选择器：插入到目标输入框光标处
    prop.querySelectorAll('#cvVarIns').forEach(b => b.onclick = () => {
      const ta = prop.querySelector('#' + b.dataset.target);
      const selEl = prop.querySelector('#cvVarSel');
      if (!ta || !selEl || !selEl.value) return;
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + selEl.value + ta.value.slice(pos);
      ta.dispatchEvent(new Event('input'));
    });

    // 表单事件
    // P5.4 `{` 触发变量选择浮层：模板字段输入 { 弹浮层，过滤+点选/回车/Tab 插入 {{#node.var#}}
    bindVarPopup();
    prop.querySelectorAll('[data-k]').forEach(inp => {
      const handler = () => {
        const key = inp.dataset.k, i = +inp.dataset.i, j = +inp.dataset.j;
        let v = inp.value;
        if (key === 'max_tokens') v = Number(v) || 1024;
        if (key === 'temperature') v = Math.max(0, Math.min(1, Number(v) || 0.7));
        if (key === 'timeout') v = Number(v) || (n.type === 'code' ? 3000 : 60000);
        if (key === 'retry') v = Math.max(0, Math.min(3, Number(v) || 0));
        // AI-08 知识检索节点：数值字段规范化 + checkbox 语义
        if (key === 'top_n') v = Math.max(1, Math.min(Number(v) || 5, 50));
        if (key === 'threshold') v = (v === '' ? '' : Math.max(0, Math.min(Number(v) || 0, 1)));
        if (key === 'kb_id') v = Number(v) || 0;
        if (key === 'kb_rewrite') v = inp.checked;
        if (key === 'onError') { c.onError = v; renderProp(); renderNodes(); markDirty(); pushHistoryDebounced(); return; }
        if (key === 'ctx_history') { v = inp.checked; }
        if (key === 'cases.logical') { c.cases[i].logical = v; markDirty(); return; }
        if (key === 'cases.label') { c.cases[i].label = v; renderProp(); renderNodes(); }
        // P5.6 分类器类别改名：同步出边 sourceHandle（旧名→新名，防断链）
        else if (key === 'cats.name') {
          const old = c.categories[i].name;
          c.categories[i].name = v;
          if (old && old !== v) for (const e of wf.edges) if (e.source === n.id && (e.sourceHandle || 'out') === old) e.sourceHandle = v;
          renderProp(); renderNodes();
        }
        // P5.6 聚合器来源/方式
        else if (key === 'aggr.variable') c.sources[i].variable = v;
        else if (key === 'aggr.mode') { c.mode = v; renderProp(); }
        else if (key === 'cd.variable') c.cases[i].conditions[j].variable = v;
        else if (key === 'cd.type') { c.cases[i].conditions[j].type = v; renderProp(); renderNodes(); }
        else if (key === 'cd.value') c.cases[i].conditions[j].value = v;
        else if (key === 'ctx_history') { c.context = { ...(c.context || {}), use_history: v }; renderProp(); }
        else if (key === 'ctx_rounds') { c.context = { ...(c.context || {}), rounds: Number(v) || 3 }; }
        else if (key === 'kb_rewrite') { c.rewrite = v; }
        else if (key === 'variables.name') { c.variables[i].name = v; renderProp(); renderNodes(); }
        else if (key === 'variables.default') c.variables[i].default = v;
        else if (key === 'variables.type') { c.variables[i].type = v; if (v === 'file' || v === 'array[file]') c.variables[i].default = ''; renderProp(); renderNodes(); } // P5.14 文件类型（切类型清默认值）
        // P5.7 会话变量编辑
        else if (key === 'svars.name') { c.session_vars[i].name = v; renderProp(); renderNodes(); }
        else if (key === 'svars.default') c.session_vars[i].default = v;
        else if (key === 'svars.desc') c.session_vars[i].desc = v;
        else if (key === 'outputs0.value') { (c.outputs || (c.outputs = [{}]))[0].value = v; }
        else if (key === 'assignments.variable') { c.assignments[i].variable = v; renderProp(); renderNodes(); }
        else if (key === 'assignments.operator') { c.assignments[i].operator = v; renderProp(); renderNodes(); }
        else if (key === 'assignments.value') c.assignments[i].value = v;
        else c[key] = v;
        markDirty();
        pushHistoryDebounced(); // 属性编辑防抖入撤销栈
        renderNodes();
      };
      // checkbox 用 change，其余 input+change
      inp.oninput = handler;
      inp.onchange = handler;
    });
    prop.querySelector('#cvAddVar')?.addEventListener('click', () => { (c.variables || (c.variables = [])).push({ name: '', type: 'string', label: '', default: '', required: false }); markDirty(); renderProp(); renderNodes(); });
    // P5.19 备用模型勾选：维护 fallback_models 顺序（勾选追加到末尾、取消移除——"取消重勾"即可调序）
    prop.querySelectorAll('[data-fbm]').forEach(cb => cb.onchange = () => {
      const list = Array.isArray(c.fallback_models) ? [...c.fallback_models] : [];
      const idx = list.indexOf(cb.dataset.fbm);
      if (cb.checked && idx < 0) list.push(cb.dataset.fbm);
      if (!cb.checked && idx >= 0) list.splice(idx, 1);
      c.fallback_models = list;
      markDirty(); pushHistoryDebounced(); renderProp(); renderNodes();
    });
    prop.querySelector('#cvAddRule')?.addEventListener('click', () => { (c.cases || (c.cases = [])).push({ label: '', conditions: [{ variable: 'start.input', type: 'contains', value: '' }], logical: 'AND' }); markDirty(); renderProp(); renderNodes(); });
    prop.querySelectorAll('[data-delvar]').forEach(b => b.onclick = () => { c.variables.splice(+b.dataset.delvar, 1); markDirty(); renderProp(); renderNodes(); });
    prop.querySelectorAll('[data-delrule]').forEach(b => b.onclick = () => {
      const lb = c.cases[+b.dataset.delrule].label;
      c.cases.splice(+b.dataset.delrule, 1);
      wf.edges = wf.edges.filter(e => !(e.source === n.id && e.sourceHandle === lb));
      markDirty(); renderProp(); renderNodes();
    });
    // if-else 多条件：添加/删除条件行
    prop.querySelectorAll('[data-addcond]').forEach(b => b.onclick = () => {
      const i = +b.dataset.addcond;
      (c.cases[i].conditions || (c.cases[i].conditions = [])).push({ variable: 'start.input', type: 'equals', value: '' });
      markDirty(); renderProp();
    });
    prop.querySelectorAll('[data-delcond]').forEach(b => b.onclick = () => {
      const i = +b.dataset.delcond, j = +b.dataset.j;
      c.cases[i].conditions.splice(j, 1);
      if (!c.cases[i].conditions.length) c.cases[i].conditions.push({ variable: 'start.input', type: 'contains', value: '' });
      markDirty(); renderProp();
    });
    // assign：添加/删除赋值
    prop.querySelector('#cvAddAssign')?.addEventListener('click', () => { (c.assignments || (c.assignments = [])).push({ variable: '', value: '', operator: 'set' }); markDirty(); renderProp(); renderNodes(); });
    prop.querySelectorAll('[data-delassign]').forEach(b => b.onclick = () => { c.assignments.splice(+b.dataset.delassign, 1); markDirty(); renderProp(); renderNodes(); });
    // P5.6 问题分类器：类别增删改（改名同步出边 sourceHandle）
    prop.querySelector('#cvAddCat')?.addEventListener('click', () => { (c.categories || (c.categories = [])).push({ name: '' }); markDirty(); renderProp(); renderNodes(); });
    prop.querySelectorAll('[data-delcat]').forEach(b => b.onclick = () => {
      const i = +b.dataset.delcat, nm = c.categories[i]?.name;
      c.categories.splice(i, 1);
      if (nm) wf.edges = wf.edges.filter(e => !(e.source === n.id && e.sourceHandle === nm));
      markDirty(); renderProp(); renderNodes();
    });
    // P5.6 变量聚合器：来源增删
    prop.querySelector('#cvAddAggSrc')?.addEventListener('click', () => { (c.sources || (c.sources = [])).push({ variable: '' }); markDirty(); renderProp(); });
    prop.querySelectorAll('[data-delagg]').forEach(b => b.onclick = () => { c.sources.splice(+b.dataset.delagg, 1); markDirty(); renderProp(); });
    // P5.6 已发现字段：点击复制 {{#node.field#}}
    prop.querySelectorAll('[data-field]').forEach(b => b.onclick = () => {
      const ref = `{{#${n.id}.${b.dataset.field}#}}`;
      copyText(ref).then(ok => toast(ok ? t('已复制：') + ref : ref));
    });
    // P5.6 工具试运行：真实执行一次 → 展示 JSON + 字段（写回 data._fields 供引用校验）
    prop.querySelector('#cvToolTry')?.addEventListener('click', () => {
      const m = modal({
        title: '⚡ ' + t('试运行：') + esc(c.toolId || '?'),
        body: `<div class="fd" style="margin:0"><label>${t('测试参数 JSON')}</label>
          <textarea class="input" id="cvTryArgs" style="min-height:80px;font-family:ui-monospace,monospace">${esc(c.args || '{}')}</textarea>
          <div class="hint">${t('含')} <span class="code">{{#node.var#}}</span> ${t('模板的参数会在运行时解析；这里原样提交（若需变量请先在画布填默认值）')}</div></div>
          <div id="cvTryOut" style="margin-top:8px"></div>`,
        foot: `<button class="btn primary" id="cvTryGo">▶ ${t('执行')}</button>`,
        onMount(mask, close) {
          mask.querySelector('#cvTryGo').onclick = async () => {
            const out = mask.querySelector('#cvTryOut');
            out.innerHTML = `<div class="hint">⏳ ${t('执行中…')}</div>`;
            try {
              const j = await api(`/agents/${opts.agentId}/tool-test`, { method: 'POST', body: { toolId: c.toolId, args: mask.querySelector('#cvTryArgs').value } });
              if (j.code !== 0) throw new Error(j.msg || '执行失败');
              let pretty = j.data.result;
              try { pretty = JSON.stringify(JSON.parse(j.data.result), null, 2); } catch { }
              const fields = j.data.fields || [];
              out.innerHTML = `<div class="fd"><label>📤 ${t('返回结果')}</label><div class="cv-json">${esc(String(pretty).slice(0, 4000))}</div></div>` +
                (fields.length ? `<div class="fd"><label>📋 ${t('顶层字段（点击复制引用）')}</label><div style="display:flex;flex-wrap:wrap;gap:6px">` +
                  fields.map(f => `<button class="btn sm" data-copyfield="${esc(f)}" style="font-family:ui-monospace,monospace">{{#${n.id}.${esc(f)}#}}</button>`).join('') + '</div></div>' : '') +
                `<div class="hint">${fields.length ? t('字段清单已写入节点，下游变量选择器可直选') : t('该工具返回非 JSON 对象，仅整体')} <span class="code">{{#${n.id}.result#}}</span></div>`;
              if (fields.length) { c._fields = fields; markDirty(); pushHistoryDebounced(); }
              out.querySelectorAll('[data-copyfield]').forEach(b => b.onclick = () => {
                const ref = `{{#${n.id}.${b.dataset.copyfield}#}}`;
                copyText(ref).then(ok => toast(ok ? t('已复制：') + ref : ref));
              });
            } catch (e) { out.innerHTML = `<div style="color:#dc2626">❌ ${esc(e.message)}</div>`; }
          };
        },
      });
    });
    // AI-08 知识检索节点级召回测试：复用库级 /knowledge/recall-test（归属校验服务端做），弹窗输入典型问题验证命中质量
    prop.querySelector('#cvKbTest')?.addEventListener('click', () => {
      const kbId = Number(c.kb_id);
      const kbName = kbs.find(x => String(x.id) === String(c.kb_id))?.name || '?';
      if (!kbId) { toast(t('请先选择知识库')); return; }
      const modal2 = modal({
        title: '🧪 ' + t('节点级召回测试：') + esc(kbName),
        body: `<div class="fd" style="margin:0"><label>${t('测试问题')}</label>
          <textarea class="input" id="cvKbTestQ" style="min-height:64px" placeholder="${t('输入一个典型问题，验证当前 TopN/阈值/重排配置下的命中质量')}"></textarea>
          <div class="hint">${t('查询模板')}: <span class="code">${esc(String(c.query || '{{#start.input#}}'))}</span>——${t('模板变量在运行测试时才渲染；本测试用你输入的问题直接检索')}</div></div>
          <div id="cvKbTestOut" style="margin-top:8px"></div>`,
        foot: `<button class="btn primary" id="cvKbTestGo">▶ ${t('检索')}</button>`,
        onMount(mask, close) {
          mask.querySelector('#cvKbTestGo').onclick = async () => {
            const out = mask.querySelector('#cvKbTestOut');
            const q = mask.querySelector('#cvKbTestQ').value.trim();
            if (!q) { out.innerHTML = `<div class="hint" style="color:#dc2626">${t('请输入测试问题')}</div>`; return; }
            out.innerHTML = `<div class="hint">⏳ ${t('检索中…')}</div>`;
            try {
              let mFilter = null;
              try { mFilter = c.metadata_filter ? JSON.parse(c.metadata_filter) : null; } catch { throw new Error(t('元数据过滤不是合法 JSON——请先修正节点配置')); }
              const j = await api('/knowledge/recall-test', { method: 'POST', body: {
                kb_id: kbId, query: q,
                top_n: Number(c.top_n) || 5,
                threshold: (c.threshold === '' || c.threshold == null) ? undefined : Number(c.threshold),
                ...(c.rerank_enabled === 'on' ? { rerank_enabled: true } : c.rerank_enabled === 'off' ? { rerank_enabled: false } : {}),
                ...(c.rerank_model ? { rerank_model: String(c.rerank_model) } : {}),
                ...(mFilter && typeof mFilter === 'object' && Object.keys(mFilter).length ? { metadataFilter: mFilter } : {}),
              } });
              if (j.code !== 0) throw new Error(j.msg || t('检索失败'));
              const hits = j.data.hits || [];
              out.innerHTML = `<div class="fd"><label>📤 ${t('命中')} ${j.data.count} ${t('条')} · ${j.data.mode} · ${j.data.rerankApplied ? '⚡ ' + t('重排已生效') : t('重排未生效')}</label>` +
                (hits.map((h, i2) => `<div style="border-top:1px solid var(--border,#eef0f3);padding:6px 0;font-size:12px">
                  <div style="color:var(--text-3)">#${i2 + 1} ${esc(h.file || h.kb || '')} · score ${(+h.score).toFixed(3)}${h.rerank_score != null ? ` · ${t('重排')} ${(+h.rerank_score).toFixed(3)}` : ''}</div>
                  <div>${esc(String(h.content || '').slice(0, 140))}…</div></div>`).join('') || `<div class="hint" style="color:#d97706">⚠️ ${t('0 命中——检查分块内容/阈值设置')}</div>`) + '</div>';
            } catch (e) { out.innerHTML = `<div style="color:#dc2626">❌ ${esc(e.message)}</div>`; }
          };
        },
      });
    });
    // iteration：编辑子流程（嵌套画布弹窗——复用 createCanvas 递归）
    prop.querySelector('#cvEditSub')?.addEventListener('click', () => {
      const defaultSub = () => ({
        nodes: [
          { id: 'start', type: 'start', position: { x: 60, y: 120 }, data: { title: t('迭代开始'), variables: [{ name: 'item', type: 'string', label: t('当前条目') }, { name: 'index', type: 'string', label: t('序号') }] } },
          { id: 'node_1', type: 'code', position: { x: 380, y: 120 }, data: { title: t('处理'), code: 'return { out: item };', inputs: '{"item":"{{item}}","index":"{{index}}"}', timeout: 3000 } },
          { id: 'node_2', type: 'end', position: { x: 700, y: 120 }, data: { title: t('迭代输出'), outputs: [{ variable: 'r', value: '{{#node_1.out#}}' }] } },
        ],
        edges: [{ id: 'e_1', source: 'start', target: 'node_1', sourceHandle: 'out' }, { id: 'e_2', source: 'node_1', target: 'node_2', sourceHandle: 'out' }],
        viewport: { x: 40, y: 30, zoom: 1 },
      });
      const sub = c.subflow && c.subflow.nodes?.length ? c.subflow : defaultSub();
      // 全屏弹层
      const mask = document.createElement('div');
      mask.dataset.subflowOpen = '1';
      mask.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(15,23,42,.5);display:flex;flex-direction:column';
      mask.innerHTML = `
        <div style="background:var(--card,#fff);padding:10px 16px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border,#e5e7eb)">
          <b style="font-size:14px">🔁 ${t('迭代子流程')}</b>
          <span style="font-size:11.5px;color:var(--text-3,#9ca3af)">${t('逐条执行：')}<span class="code" style="font-family:ui-monospace,monospace">{{item}}</span>=${t('当前条目')} <span class="code" style="font-family:ui-monospace,monospace">{{index}}</span>=${t('序号')}；${t('end 首输出逐条汇总为 results')}</span>
          <div style="flex:1"></div>
          <button class="btn primary" id="cvSubSave">${t('保存子流程')}</button>
          <button class="btn" id="cvSubCancel">${t('取消')}</button>
        </div>
        <div id="cvSubHost" style="flex:1;min-height:0;background:var(--card,#fff)"></div>`;
      document.body.appendChild(mask);
      const subAPI = createCanvas(mask.querySelector('#cvSubHost'), {
        initial: sub,
        models, agents, agentId: opts.agentId,
        markDirty: () => { },
      });
      mask.querySelector('#cvSubSave').onclick = () => {
        c.subflow = subAPI.getWorkflow();
        subAPI.destroy(); mask.remove();
        markDirty(); renderProp(); renderNodes();
        toast(t('子流程已保存'));
      };
      mask.querySelector('#cvSubCancel').onclick = () => { subAPI.destroy(); mask.remove(); };
    });
  }

  // ---------- 交互：节点库拖放 ----------
  let dragGhost = null, dropInfo = null;
  lib.addEventListener('mousedown', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    const type = card.dataset.type;
    const preset = { toolId: card.dataset.tool, agentId: card.dataset.agent };
    dragGhost = document.createElement('div');
    dragGhost.textContent = NODE_TYPES[type].label;
    dragGhost.style.cssText = 'position:fixed;z-index:999;padding:6px 12px;border-radius:8px;background:#2563eb;color:#fff;font-size:12px;pointer-events:none;opacity:.92';
    document.body.appendChild(dragGhost);
    dropInfo = { type, preset };
    moveGhost(e);
  });
  function moveGhost(e) { if (dragGhost) { dragGhost.style.left = (e.clientX + 12) + 'px'; dragGhost.style.top = (e.clientY - 14) + 'px'; } }
  // 具名引用以便 destroy 统一移除（防编排页进出泄漏拖拽监听器）
  const onCvDragMove = e => {
    if (!dropInfo) return;
    moveGhost(e);
    stage.classList.toggle('drag-over', e.target.closest('.cv-stage') != null);
  };
  const onCvDragUp = e => {
    if (!dropInfo) return;
    const inStage = e.target.closest && (e.target.closest('.cv-stage') || e.target.closest('.cv-world') || e.target.closest('.cv-node') || e.target.closest('.cv-svg'));
    if (inStage) {
      const p = toWorld(e.clientX, e.clientY);
      addNode(dropInfo.type, p.x - 106, p.y - 20, dropInfo.preset);
    }
    dragGhost?.remove(); dragGhost = null; dropInfo = null;
    stage.classList.remove('drag-over');
  };
  window.addEventListener('mousemove', onCvDragMove);
  window.addEventListener('mouseup', onCvDragUp);

  // ---------- 交互：节点拖动 / 选中 / 删除 ----------
  world.addEventListener('mousedown', e => {
    const nodeEl = e.target.closest('.cv-node');
    if (e.target.closest('.del')) { e.preventDefault(); delNode(nodeEl.dataset.id); return; }
    if (nodeEl && !e.target.closest('.cv-anchor-out') && !e.target.closest('.cv-anchor-in') && !e.target.closest('.cv-anchor-err')) {
      e.preventDefault();
      const dragId = nodeEl.dataset.id;
      // P5.15 批量移动：拖动多选集中任一节点 → 整批同 delta（分组底板由后续 renderNodes 重算）
      if (selSet && selSet.has(dragId)) {
        const moving = [...selSet].map(pid => {
          const n = wf.nodes.find(x => x.id === pid);
          return n ? { n, ox: n.position.x, oy: n.position.y, el: world.querySelector(`.cv-node[data-id="${CSS.escape(pid)}"]`) } : null;
        }).filter(Boolean);
        const sx = e.clientX, sy = e.clientY;
        const mv = ev => {
          const dx = (ev.clientX - sx) / wf.viewport.zoom, dy = (ev.clientY - sy) / wf.viewport.zoom;
          for (const m of moving) {
            m.n.position.x = m.ox + dx; m.n.position.y = m.oy + dy;
            if (m.el) { m.el.style.left = m.n.position.x + 'px'; m.el.style.top = m.n.position.y + 'px'; }
          }
          renderEdges();
        };
        const up = () => {
          window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
          markDirty(); renderNodes(); renderMinimap(); pushHistory(); // 整批重渲染：分组底板/小地图同步
          // U1-7：拖拽结束上报位置变更（实时协作 node:move 轻指令；位置无语义不计入 diff 版本）
          opts.onMoveEnd?.(moving.filter(Boolean).map(m2 => ({ id: m2.n.id, x: Math.round(m2.n.position.x), y: Math.round(m2.n.position.y) })));
        };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
        return;
      }
      selectNode(dragId);
      const n = wf.nodes.find(x => x.id === dragId);
      const sx = e.clientX, sy = e.clientY, ox = n.position.x, oy = n.position.y;
      const mv = ev => { n.position.x = ox + (ev.clientX - sx) / wf.viewport.zoom; n.position.y = oy + (ev.clientY - sy) / wf.viewport.zoom; nodeEl.style.left = n.position.x + 'px'; nodeEl.style.top = n.position.y + 'px'; renderEdges(); };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); markDirty(); pushHistory(); opts.onMoveEnd?.([{ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }]); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return;
    }
    // 输出锚点（正常 + P5.11 异常分支红色端口）→ 开始连线（sourceHandle=分支名/__error__）
    const outA = e.target.closest('.cv-anchor-out') || e.target.closest('.cv-anchor-err');
    if (outA && nodeEl) {
      e.preventDefault();
      startLink(nodeEl.dataset.id, outA.dataset.branch || 'out', e);
      return;
    }
    // 输入锚点被点击（作为连线终点由 startLink 处理）
    if (e.target.closest('.cv-anchor-in')) { e.preventDefault(); return; }
    // 点击空白：取消选中 + 清除多选
    if (!nodeEl && !e.target.closest('.cv-svg')) {
      sel = null;
      if (selSet) { selSet = null; root.querySelector('.cv-selbar')?.remove(); }
      renderNodes(); renderProp();
    }
  });

  // ---------- 连线拖拽（sourceHandle=分支名；start→首个 llm 自动引用补全） ----------
  function startLink(fromId, sourceHandle, e) {
    const p1 = anchorPos(fromId, 'out', sourceHandle);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#60a5fa'); path.setAttribute('stroke-width', '2.2');
    svg.appendChild(path);
    const mv = ev => {
      const p2 = toWorld(ev.clientX, ev.clientY);
      path.setAttribute('d', bezier(p1, p2));
    };
    const up = ev => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      path.remove();
      const tgt = ev.target.closest && ev.target.closest('.cv-node');
      if (tgt) {
        const toId = tgt.dataset.id;
        if (toId !== fromId) {
          // 入边唯一：覆盖目标节点已有入边；同源同 handle 出边唯一：覆盖
          wf.edges = wf.edges.filter(ed => !(ed.target === toId) && !(ed.source === fromId && (ed.sourceHandle || 'out') === sourceHandle));
          wf.edges.push({ id: 'e_' + (wf.edges.length + 1) + '_' + Date.now() % 1000, source: fromId, target: toId, sourceHandle });
          pushHistory();
          markDirty(); renderNodes();
        }
      }
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    mv(e);
  }

  // ---------- 点击连线选中 / 删除 ----------
  svg.addEventListener('mousedown', e => {
    const p = e.target.closest('path[data-edge]');
    if (!p) return;
    e.stopPropagation();
    const i = +p.dataset.edge;
    const wasSel = sel && sel.edge === i;
    sel = wasSel ? null : { edge: i };
    renderNodes(); renderProp();
    if (wasSel) { wf.edges.splice(i, 1); sel = null; markDirty(); renderNodes(); pushHistory(); toast(t('已删除连线')); }
    else toast(t('再次点击删除该连线'));
  });

  // ---------- 画布平移 / 缩放（P5.6：空白处 Shift+拖拽 = 橡皮筋框选） ----------
  stage.addEventListener('mousedown', e => {
    if (e.target.closest('.cv-node') || e.target.closest('.cv-lib') || e.target.closest('.cv-tools') || e.target.closest('.cv-run') || e.target.closest('button') || e.target.closest('.cv-gcard') || e.target.closest('.cv-search') || e.target.closest('.cv-selbar') || e.target.closest('path') || e.target.closest('.cv-gh') || e.target.closest('.cv-note')) return;
    e.preventDefault();
    // P5.6 橡皮筋多选：Shift+拖拽框选节点 → 分组入口
    if (e.shiftKey) {
      const rb = document.createElement('div');
      rb.className = 'cv-rubber';
      stage.appendChild(rb);
      const sx = e.clientX, sy = e.clientY, sr = stage.getBoundingClientRect();
      const mv = ev => {
        const x1 = Math.min(sx, ev.clientX) - sr.left, y1 = Math.min(sy, ev.clientY) - sr.top;
        const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
        rb.style.cssText = `left:${x1}px;top:${y1}px;width:${w}px;height:${h}px`;
      };
      const up = ev => {
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
        rb.remove();
        const p1 = toWorld(Math.min(sx, ev.clientX), Math.min(sy, ev.clientY));
        const p2 = toWorld(Math.max(sx, ev.clientX), Math.max(sy, ev.clientY));
        const hit = wf.nodes.filter(n => n.position.x + 212 > p1.x && n.position.x < p2.x && n.position.y + 100 > p1.y && n.position.y < p2.y);
        // P5.15：Shift = 追加选择（Figma 语义）；普通 Shift 框选 = 重建选择集
        const base = ev.shiftKey && selSet ? [...selSet] : [];
        const merged = [...new Set([...base, ...hit.map(n => n.id)])];
        if (merged.length) { selSet = new Set(merged); renderNodes(); showSelBar(); }
        else clearSelSet();
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return;
    }
    stage.classList.add('panning');
    const sx = e.clientX, sy = e.clientY, ox = wf.viewport.x, oy = wf.viewport.y;
    const mv = ev => { wf.viewport.x = ox + ev.clientX - sx; wf.viewport.y = oy + ev.clientY - sy; applyViewport(); };
    const up = () => { stage.classList.remove('panning'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  stage.addEventListener('wheel', e => {
    if (e.target.closest('.cv-lib') || e.target.closest('.cv-prop')) return;
    e.preventDefault();
    const old = wf.viewport.zoom;
    const nz = Math.max(0.3, Math.min(2, old * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    wf.viewport.x = cx - (cx - wf.viewport.x) * (nz / old);
    wf.viewport.y = cy - (cy - wf.viewport.y) * (nz / old);
    wf.viewport.zoom = nz;
    applyViewport();
  }, { passive: false });
  $('#cvZoomIn').onclick = () => { wf.viewport.zoom = Math.min(2, wf.viewport.zoom * 1.15); applyViewport(); };
  $('#cvZoomOut').onclick = () => { wf.viewport.zoom = Math.max(0.3, wf.viewport.zoom / 1.15); applyViewport(); };

  // ---------- P5.21 触屏支持（安卓/iOS/鸿蒙/平板）：单指平移·节点拖动 / 双指捏合缩放 / tap 选中 ----------
  // 事件模型：把 touch 映射到与 mouse 同源的画布操作（平移=viewport、节点=n.position、缩放=wheel 公式）
  let tMode = null; // pan | node | pinch | ignore
  let tStart = null, tNode = null, tPinch0 = null, tMoved = false;
  const TAP_MOVE_PX = 8, TAP_MS = 320;
  stage.addEventListener('touchstart', e => {
    if (e.target.closest('.cv-lib') || e.target.closest('.cv-prop') || e.target.closest('.cv-tools') || e.target.closest('.cv-menu') || e.target.closest('.cv-selbar') || e.target.closest('button') || e.target.closest('.cv-note-bar')) return; // 面板/控件内部滚动与交互不劫持
    const t = e.touches;
    if (t.length === 2) { // 双指 → pinch 缩放（围绕两指中点）
      e.preventDefault();
      tMode = 'pinch';
      tMoved = true;
      const r = stage.getBoundingClientRect();
      tPinch0 = {
        dist: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
        zoom: wf.viewport.zoom,
        cx: (t[0].clientX + t[1].clientX) / 2 - r.left,
        cy: (t[0].clientY + t[1].clientY) / 2 - r.top,
        vx: wf.viewport.x, vy: wf.viewport.y,
      };
      return;
    }
    if (t.length !== 1) return;
    const nodeEl = e.target.closest('.cv-node');
    const noteEl = e.target.closest('.cv-note');
    const t0 = t[0];
    tStart = { x: t0.clientX, y: t0.clientY, t: Date.now(), ox: wf.viewport.x, oy: wf.viewport.y };
    tMoved = false;
    if (nodeEl && !e.target.closest('.cv-anchor-out') && !e.target.closest('.cv-anchor-in') && !e.target.closest('.cv-anchor-err') && !e.target.closest('.del')) {
      // 单指按在节点上 → 节点拖动（多选批量语义与 mouse 一致）
      e.preventDefault();
      tMode = 'node';
      const nid = nodeEl.dataset.id;
      selectNode(nid);
      const n = wf.nodes.find(x => x.id === nid);
      if (selSet && selSet.has(nid) && selSet.size > 1) {
        tNode = { ids: [...selSet].map(pid => ({ n: wf.nodes.find(x => x.id === pid), ox: 0, oy: 0 })) };
        for (const m of tNode.ids) { m.ox = m.n.position.x; m.oy = m.n.position.y; }
        tNode.elList = tNode.ids.map(m => ({ n: m.n, el: world.querySelector(`.cv-node[data-id="${CSS.escape(m.n.id)}"]`) }));
      } else {
        tNode = { single: true, n, ox: n.position.x, oy: n.position.y, el: nodeEl };
      }
      stage.classList.add('panning');
    } else if (!nodeEl && !noteEl && !e.target.closest('.cv-svg')) {
      tMode = 'pan'; // 空白单指 → 画布平移
      e.preventDefault();
      stage.classList.add('panning');
    } else if (e.target.closest('.cv-svg')) {
      tMode = 'pan'; // SVG 连线层也允许平移（tap 到 path 上不误删边——touchmove 阈值保护）
      e.preventDefault();
      stage.classList.add('panning');
    } else {
      tMode = 'ignore'; // 便签内 textarea 等交给浏览器
    }
  }, { passive: false });
  stage.addEventListener('touchmove', e => {
    if (!tMode || tMode === 'ignore') return;
    const t = e.touches;
    if (tMode === 'pinch') {
      if (t.length !== 2 || !tPinch0) return;
      e.preventDefault();
      const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const nz = Math.max(0.3, Math.min(2, tPinch0.zoom * (dist / (tPinch0.dist || 1))));
      const k = nz / tPinch0.zoom;
      wf.viewport.zoom = nz;
      wf.viewport.x = tPinch0.cx - (tPinch0.cx - tPinch0.vx) * k;
      wf.viewport.y = tPinch0.cy - (tPinch0.cy - tPinch0.vy) * k;
      applyViewport();
      return;
    }
    if (t.length !== 1 || !tStart) return;
    const t0 = t[0];
    const dx = t0.clientX - tStart.x, dy = t0.clientY - tStart.y;
    if (Math.abs(dx) > TAP_MOVE_PX || Math.abs(dy) > TAP_MOVE_PX) tMoved = true;
    if (!tMoved) return;
    e.preventDefault();
    if (tMode === 'pan') {
      wf.viewport.x = tStart.ox + dx;
      wf.viewport.y = tStart.oy + dy;
      applyViewport();
    } else if (tMode === 'node') {
      const mx = dx / wf.viewport.zoom, my = dy / wf.viewport.zoom;
      if (tNode.single) {
        tNode.n.position.x = tNode.ox + mx; tNode.n.position.y = tNode.oy + my;
        if (tNode.el) { tNode.el.style.left = tNode.n.position.x + 'px'; tNode.el.style.top = tNode.n.position.y + 'px'; }
      } else {
        for (const m of tNode.elList) { m.n.position.x = m.ox + mx; m.n.position.y = m.oy + my; if (m.el) { m.el.style.left = m.n.position.x + 'px'; m.el.style.top = m.n.position.y + 'px'; } }
      }
      renderEdges();
    }
  }, { passive: false });
  stage.addEventListener('touchend', e => {
    stage.classList.remove('panning');
    const wasTap = tStart && !tMoved && (Date.now() - tStart.t) < TAP_MS;
    if (tMode === 'node' && tMoved) { markDirty(); renderNodes(); renderMinimap(); pushHistory(); }
    if (wasTap && tMode === 'pan') {
      // tap 空白：取消选中（与 mouse 点击空白一致）
      sel = null;
      if (selSet) { selSet = null; root.querySelector('.cv-selbar')?.remove(); }
      renderNodes(); renderProp();
    }
    if (wasTap && tMode === 'pinch') { /* 双指轻点无语义 */ }
    tMode = null; tStart = null; tNode = null; tPinch0 = null; tMoved = false;
  });
  stage.addEventListener('touchcancel', () => { stage.classList.remove('panning'); tMode = null; tStart = null; tNode = null; tPinch0 = null; tMoved = false; });

  // P5.21 组件库触屏：无 drag 语义 → 点击即添加（画布可视中心落点，避开既有节点错位叠放）
  lib.addEventListener('click', e => {
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return; // 纯桌面不启用（避免与 drag 双触发）
    const card = e.target.closest('.card');
    if (!card) return;
    const type = card.dataset.type;
    if (!type || !NODE_TYPES[type]) return;
    const r = stage.getBoundingClientRect();
    const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    // 视觉中心落点：若已有节点落在附近则右下让位（简单防重叠）
    let x = p.x - 106, y = p.y - 60;
    while (wf.nodes.some(n => Math.abs(n.position.x - x) < 30 && Math.abs(n.position.y - y) < 30)) { x += 44; y += 44; }
    addNode(type, x, y, { toolId: card.dataset.tool, agentId: card.dataset.agent });
    if (lib.classList.contains('open')) togglePanels('lib', false); // 窄屏抽屉自动收起
  });
  $('#cvFit').onclick = () => {
    if (!wf.nodes.length) { wf.viewport = { x: 60, y: 40, zoom: 1 }; applyViewport(); return; }
    const r = stage.getBoundingClientRect();
    const minX = Math.min(...wf.nodes.map(n => n.position.x)) - 60, minY = Math.min(...wf.nodes.map(n => n.position.y)) - 60;
    const maxX = Math.max(...wf.nodes.map(n => n.position.x + 212)) + 60, maxY = Math.max(...wf.nodes.map(n => n.position.y + 140)) + 60;
    const zoom = Math.max(0.3, Math.min(1.4, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    wf.viewport = { x: -minX * zoom + 20, y: -minY * zoom + 10, zoom };
    applyViewport();
  };

  // ---------- Delete 键删除选中节点（子流程弹窗打开时让位，防误删主图节点）；Ctrl+Z/Shift+Z 撤销重做 ----------
  const keyHandler = e => {
    const inField = !!(e.target && e.target.closest && e.target.closest('input,textarea,select'));
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      if (inField) return; // 输入框内浏览器原生 undo
      e.preventDefault();
      restoreHistory(e.shiftKey ? 1 : -1);
      return;
    }
    // P5.6 画布搜索（Ctrl+F / Cmd+F；子流程弹窗打开时让位）
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      if (inField) return;
      if (document.querySelector('[data-subflow-open]')) return;
      if (!root.isConnected) return;
      e.preventDefault();
      if (root.querySelector('.cv-search')) closeSearch(); else openSearch();
      return;
    }
    // P5.15 复制节点（Ctrl/Cmd+C）：多选 selSet 优先，单选 sel 兜底；含集合内部连线
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      if (inField) return;
      if (document.querySelector('[data-subflow-open]')) return;
      const ids = selSet?.size ? [...selSet] : (sel && typeof sel === 'string' ? [sel] : []);
      if (ids.length) { e.preventDefault(); copyNodes(ids); }
      return;
    }
    // P5.15 粘贴节点（Ctrl/Cmd+V）：新 id + 位置偏移 + 内部连线重建，粘贴后整批选中
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
      if (inField) return;
      if (document.querySelector('[data-subflow-open]')) return;
      e.preventDefault();
      pasteNodes();
      return;
    }
    // P5.15 重做第二键位（Ctrl/Cmd+Y；Ctrl+Shift+Z 已有）
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
      if (inField) return;
      if (document.querySelector('[data-subflow-open]')) return;
      e.preventDefault();
      restoreHistory(1);
      return;
    }
    // P5.15 Tab 在节点间跳转（Shift+Tab 反向）：选中 + 居中 + 闪烁
    if (e.key === 'Tab') {
      if (inField) return;
      if (document.querySelector('[data-subflow-open]')) return;
      e.preventDefault();
      jumpNode(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (inField) return;
    if (document.querySelector('[data-subflow-open]')) return; // 子画布自己的实例处理
    // P5.15：多选批量删除优先（>1 才走批量——单个沿用单删引用确认）
    if (selSet && selSet.size > 1) { batchDelete([...selSet]); e.preventDefault(); return; }
    if (sel != null && typeof sel === 'string') { delNode(sel); e.preventDefault(); }
  };
  window.addEventListener('keydown', keyHandler);

  // ---------- P5.3 运行测试（SSE 实时推送：节点状态渲染 + 日志流 + 从此节点重跑） ----------
  // SSE 流式执行：POST fetch + reader 逐行解析 data: {...}
  async function runTestSSE(startFrom) {
    // P5.12 运行前置校验：error 级问题（悬空引用/必填缺失）直接拦截——别等运行到第 5 个节点才报错
    const v = runValidation();
    const errs = v.problems.filter(p => p.level === 'error');
    if (errs.length && !startFrom) { // 重跑场景沿用缓存不重校验（用户明确要重跑）
      modal({
        title: '🚨 ' + t('画布存在') + `${errs.length}` + t('个错误，运行会失败'),
        body: `<div style="font-size:12.5px;line-height:1.9">${errs.slice(0, 8).map(p => `<div>· <b class="code">${esc(p.nodeId)}</b>：${esc(p.msg)}</div>`).join('')}${errs.length > 8 ? `<div>… ${t('等共')} ${errs.length} ${t('处')}</div>` : ''}</div>
          <div class="hint" style="margin-top:8px">${t('修复后再运行——节点右上角红点已标出位置，点属性面板可改')}。</div>`,
        foot: `<button class="btn primary" data-close>${t('去修复')}</button>`,
        onMount(mask, close) { mask.querySelector('[data-close]').onclick = close; },
      });
      return;
    }
    runState = {};
    renderNodes();
    // P5.14 文件一等变量：start 自定义变量输入区（file/array[file] → 上传按钮；文本 → 输入框。
    // 顺带补齐既有缺口——测试弹窗此前只传 input，自定义变量无法在测试时传值）
    const startVars = (wf.nodes.find(n => n.type === 'start')?.data?.variables || []).filter(v => v.name);
    const varFields = startVars.map(v => {
      if (v.type === 'file' || v.type === 'array[file]') {
        return `<div class="fd" style="margin:0;margin-top:10px"><label>📄 ${esc(v.name)}${v.type === 'array[file]' ? `（${t('可多选')}）` : ''}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn" id="cvFileUp-${esc(v.name)}">📎 ${t('选择文件')}</button>
            <span class="hint" id="cvFileLab-${esc(v.name)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t('未选择（PDF/DOCX/TXT/MD ≤8MB）')}</span>
          </div>
          <input type="file" id="cvFileInp-${esc(v.name)}" accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md" ${v.type === 'array[file]' ? 'multiple' : ''} style="display:none">
        </div>`;
      }
      return `<div class="fd" style="margin:0;margin-top:10px"><label>${esc(v.name)}（{{#start.${esc(v.name)}#}}）</label>
        <input class="input" id="cvVar-${esc(v.name)}" value="${esc(v.default || '')}" placeholder="${t('变量值（空用默认）')}">
      </div>`;
    }).join('');
    const m = modal({
      title: '▶ ' + (startFrom ? t('从此节点重跑：') + startFrom : t('运行测试')) + ` <span style="font-size:10.5px;color:#d97706;font-weight:400">${t('（测试草稿——线上对话走已发布快照）')}</span>`,
      body: `<div class="fd" style="margin:0"><label>${t('输入测试文本')}（{{#start.input#}}）</label>
        <textarea class="input" id="cvTestInput" style="min-height:80px">${esc((lastRun && !startFrom ? lastRun.input : '') || opts.defaultInput || '你好，这是一条工作流测试输入。')}</textarea></div>
        ${varFields}
        <div id="cvTestOut" style="margin-top:10px;font-size:12.5px"></div>`,
      foot: `<button class="btn primary" id="cvTestGo">${startFrom ? t('重跑') : t('执行')}</button>`,
      onMount(mask, close) {
        // P5.14 文件上传：选择 → base64 → POST /api/files → fileId 记入 input.dataset（执行时组进 vars）
        for (const v of startVars) {
          if (v.type !== 'file' && v.type !== 'array[file]') continue;
          const btn = mask.querySelector(`#cvFileUp-${CSS.escape(v.name)}`);
          const inp = mask.querySelector(`#cvFileInp-${CSS.escape(v.name)}`);
          const lab = mask.querySelector(`#cvFileLab-${CSS.escape(v.name)}`);
          if (!btn || !inp || !lab) continue;
          btn.onclick = () => inp.click();
          inp.onchange = async () => {
            const files = [...inp.files].slice(0, v.type === 'array[file]' ? 10 : 1);
            if (!files.length) return;
            lab.textContent = '⏳ ' + t('上传解析中…');
            const ids = [];
            try {
              for (const f of files) {
                const b64 = await new Promise((ok, err) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1] || ''); rd.onerror = err; rd.readAsDataURL(f); });
                const r = await fetch('/api/files', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }, // P2-3：Cookie 化后同源自动鉴权
                  body: JSON.stringify({ name: f.name, file_b64: b64, source: 'manual' }),
                });
                const j = await r.json();
                if (j.code !== 0) throw new Error(j.msg || '上传失败');
                ids.push(j.data.id);
              }
              inp.dataset.fileIds = JSON.stringify(ids);
              lab.innerHTML = ids.map(id => `✅ <b>#${id}</b>`).join('、') + ' ' + esc(files.map(f => f.name).join('、'));
            } catch (e) {
              inp.dataset.fileIds = '';
              lab.textContent = '❌ ' + (e.message || '上传失败');
            }
          };
        }
        mask.querySelector('#cvTestGo').onclick = async () => {
          const out = mask.querySelector('#cvTestOut');
          const input = mask.querySelector('#cvTestInput').value;
          // P5.14：start 变量收集（file → dataset.fileIds；文本 → 输入值非空才传）
          const vars = {};
          for (const v of startVars) {
            if (v.type === 'file' || v.type === 'array[file]') {
              const raw = mask.querySelector(`#cvFileInp-${CSS.escape(v.name)}`)?.dataset.fileIds;
              const ids = (() => { try { return raw ? JSON.parse(raw) : []; } catch { return []; } })();
              if (ids.length) vars[v.name] = v.type === 'array[file]' ? ids : ids[0];
            } else {
              const val = mask.querySelector(`#cvVar-${CSS.escape(v.name)}`)?.value;
              if (val != null && String(val).trim() !== '') vars[v.name] = val;
            }
          }
          runState = {};
          renderNodes();
          out.innerHTML = `<div class="hint">⏳ ${t('执行中…')}（${t('节点状态实时同步到画布；大模型节点真实调网关计费')}）</div><div id="cvTestLogs"></div>`;
          const logsHost = out.querySelector('#cvTestLogs');
          const body = { input, ...(Object.keys(vars).length ? { vars } : {}) };
          if (startFrom && lastRun) { body.startFrom = startFrom; body.presetResults = lastRun.results; }
          try {
            const res = await fetch(`/api/agents/${opts.agentId}/workflow-test`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }, // P2-3：Cookie 化后同源自动鉴权
              body: JSON.stringify(body),
            });
            if (!res.ok || !res.body) throw new Error(t('SSE 连接失败（{n}）').replace('{n}', res.status));
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const parts = buf.split('\n\n');
              buf = parts.pop();
              for (const part of parts) {
                const line = part.trim();
                if (!line.startsWith('data:')) continue;
                let evt = null;
                try { evt = JSON.parse(line.slice(5)); } catch { continue; }
                handleSSEEvent(evt, logsHost);
              }
            }
          } catch (e) {
            out.insertAdjacentHTML('beforeend', `<div style="color:#dc2626;margin-top:8px">❌ ${esc(e.message)}</div>`);
          }
        };
      },
    });
  }

  // SSE 事件处理：更新 runState（节点状态）→ 画布实时渲染；日志追加；done 缓存 lastRun（重跑用）
  // P5.10 流式调试：LLM 节点逐字渲染（60ms 节流——高频 node_stream 不重绘整画布，只改目标卡片 status 区）
  let streamRenderTimer = null;
  function scheduleStreamRender(nodeId) {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = null;
      const el = world.querySelector(`.cv-node[data-id="${CSS.escape(nodeId)}"] .cv-status`);
      const rs = runState[nodeId];
      if (el && rs) {
        el.innerHTML = statusBadge(rs);
        const st = el.querySelector('.cv-stream'); // 尾部跟随：滚动到最右
        if (st) st.scrollLeft = st.scrollWidth;
      }
    }, 60);
  }
  // P5.10 流式调试：测试弹窗日志行同步滚动（行预览实时更新，完成后由 nodeDone 行覆盖）
  function streamLogLine(evt, logsHost) {
    if (!logsHost) return;
    let line = logsHost.querySelector(`[data-streamline="${CSS.escape(evt.nodeId)}"]`);
    if (!line) {
      line = document.createElement('div');
      line.dataset.streamline = evt.nodeId;
      line.style.cssText = 'display:flex;gap:8px;padding:3px 0;border-bottom:1px dashed var(--border,#eef0f3);align-items:center';
      line.innerHTML = `<span class="cv-spin" style="width:9px;height:9px"></span><b style="min-width:110px">${esc(evt.nodeId)} ${esc(evt.title || '')}</b><span style="color:var(--text-2);flex:1;white-space:nowrap;overflow-x:auto;max-height:16px;font-size:10.5px"></span>`;
      logsHost.appendChild(line);
    }
    const txt = line.lastElementChild;
    txt.textContent = String(evt.delta ?? ''); // 每次只显示最新一批（滚动观感）
    txt.scrollLeft = txt.scrollWidth;
    line.scrollIntoView({ block: 'nearest' });
  }
  function handleSSEEvent(evt, logsHost) {
    // P5.10 流式调试：LLM 生成中——delta 追加进 runState.streamText（节点卡片尾部预览 + 测试日志行同步滚动）
    if (evt.type === 'node_stream') {
      const rs = runState[evt.nodeId];
      if (rs && rs.status === 'running') {
        rs.streamText = ((rs.streamText || '') + String(evt.delta ?? '')).slice(-120); // 卡片只留尾部 120 字
        scheduleStreamRender(evt.nodeId);
        streamLogLine(evt, logsHost);
      }
      return;
    }
    // P5.6 直接回复：💬 日志条目（Chatflow 流式回传；Workflow 模式同样展示内容）
    if (evt.type === 'reply') {
      logsHost?.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed #dbeafe;background:rgba(37,99,235,.04);border-radius:6px">
        <span style="color:#2563eb">💬</span>
        <b style="min-width:110px">${esc(evt.nodeId)} ${esc(evt.title || '')}</b>
        <span style="color:var(--text-2);flex:1;white-space:pre-wrap">${esc(String(evt.text || '').slice(0, 200))}</span></div>`);
      return;
    }
    if (evt.type === 'node') {
      const isMainNode = wf.nodes.some(n => n.id === evt.nodeId); // 子流程节点（#分隔）不对应画布 DOM，只进日志
      if (isMainNode) {
        runState[evt.nodeId] = {
          status: evt.status, ms: evt.ms, error: evt.status === 'error' ? evt.preview : null,
          inputs: evt.inputs || null, outputFull: evt.outputFull || null,
          childRunId: evt.childRunId || null, childMode: evt.childMode || null, // P5.8 #9 子智能体下钻
          viaError: !!evt.viaError, // P5.11：失败已走异常分支（流程继续）
          tokens: evt.tokens ?? null, tokens_in: evt.tokens_in ?? null, tokens_out: evt.tokens_out ?? null, // P5.13：节点卡片直接显示 tokens+费用
          cost_cny: evt.cost_cny ?? null, cost_priced: evt.cost_priced == null ? null : !!evt.cost_priced,
          model_used: evt.model_used || null, usage_summary: evt.usage_summary || null,
        };
        delete runState[evt.nodeId]?.streamText; // P5.10：节点结束清除流式预览（成功徽标/错误信息接管）
        logsHost?.querySelector(`[data-streamline="${CSS.escape(evt.nodeId)}"]`)?.remove(); // 流式日志行移除（后续 nodeDone 行接管）
        renderNodes();
        if (sel === evt.nodeId && propTab === 'result') renderProp(); // 结果视图实时刷新
      }
      // 日志行（主图与子流程节点都记）；P5.8 #9 agent 节点带子 run 时加下钻按钮
      const icon = evt.status === 'success' ? '✅' : evt.status === 'error' ? (evt.viaError ? '⚡' : '❌') : evt.status === 'running' ? '⏳' : evt.status === 'preset' ? '↺' : '⏭️';
      const color = evt.status === 'success' ? '#059669' : evt.status === 'error' ? (evt.viaError ? '#d97706' : '#dc2626') : evt.status === 'running' ? '#2563eb' : '#9ca3af';
      logsHost?.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px dashed var(--border,#eef0f3);align-items:center${evt.viaError ? ';background:rgba(217,119,6,.05);border-radius:6px' : ''}">
        <span style="color:${color}">${icon}</span>
        <b style="min-width:110px">${esc(evt.nodeId)} ${esc(evt.title || '')}</b>
        <span style="color:var(--text-2);flex:1">${esc((evt.preview || (evt.status === 'running' ? '执行中…' : '') || '').slice(0, 90))}${evt.viaError ? ` <span style="color:#d97706">→ ${t('已走异常分支')}</span>` : ''}</span>
        ${evt.ms != null ? `<span style="color:var(--text-3)">${evt.ms}ms</span>` : ''}
        ${Number(evt.tokens) > 0 ? `<span style="color:var(--text-3);white-space:nowrap">${evt.tokens} tokens</span>` : ''}
        ${evt.cost_cny != null && Number(evt.cost_cny) > 0 ? `<span style="color:var(--text-3);white-space:nowrap">${fmtCostFront(evt.cost_cny, evt.cost_priced)}</span>` : ''}
        ${evt.childRunId ? `<button class="btn sm" data-childrun="${evt.childRunId}" title="${t('查看子智能体内部执行轨迹')}">🔍 ${t('下钻')}</button>` : ''}</div>`);
      const drillBtn = logsHost?.querySelector(`[data-childrun="${evt.childRunId}"]:not([data-bound])`);
      if (drillBtn && evt.childRunId) { drillBtn.dataset.bound = '1'; drillBtn.onclick = () => openChildRun(evt.childRunId, evt.title); }
    }
    if (evt.type === 'done') {
      lastRun = { input: document.querySelector('#cvTestInput')?.value || '', results: evt.results || {} };
      // 日志同步：done 里的 logs 含完整入参出参（SSE 中途断流时的兑底全量）
      const outHost = logsHost?.parentElement;
      // P5.13 成本汇总条：总耗时 · 总 token · ¥费用；最贵/最慢节点一眼可见（直接在测试弹窗顶部展示）
      let costBar = '';
      if (evt.usage) {
        const u = evt.usage;
        const nodes = u.nodes || [];
        const topCost = nodes.filter(n => Number(n.costCny) > 0).sort((a, b) => b.costCny - a.costCny)[0] || null;
        // 最慢节点覆盖全部节点（从 runState 找 ms 最大；兜底 usage.nodes 的 duration）
        const slowEntry = Object.entries(runState).filter(([, rs]) => rs?.status === 'success' && Number(rs.ms) > 0).sort((a, b) => b[1].ms - a[1].ms)[0] || null;
        const slowNode = slowEntry ? wf.nodes.find(n => n.id === slowEntry[0]) : null;
        const slowTitle = slowEntry ? (slowNode?.data?.title || slowEntry[0]) : (nodes.filter(n => Number(n.duration) > 0).sort((a, b) => b.duration - a.duration)[0]?.title || null);
        const slowMs = slowEntry ? slowEntry[1].ms : (nodes.filter(n => Number(n.duration) > 0).sort((a, b) => b.duration - a.duration)[0]?.duration || null);
        const msLab = (ms) => ms == null ? '' : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
        const inOut = (u.tokensIn || u.tokensOut) ? `（${t('入')} ${u.tokensIn} / ${t('出')} ${u.tokensOut}）` : '';
        costBar = `<div style="margin-top:12px;background:rgba(37,99,235,.05);border:1px solid #bfdbfe;border-radius:8px;padding:8px 12px;font-size:12px">
          <b>📊 ${t('本次运行汇总')}</b>
          <div style="margin-top:4px;color:var(--text-2)">⏱ ${t('总耗时')} <b>${evt.durationMs != null ? ((evt.durationMs / 1000).toFixed(1) + 's') : '—'}</b> · 🔢 ${t('总 token')} <b>${u.totalTokens || 0}</b>${inOut} · 💰 ${t('费用')} <b>${fmtCostFront(u.costCny, u.priced)}</b>${u.priced ? '' : ` <span class="hint">${t('（内置估价，非网关实价）')}</span>`}</div>
          ${topCost ? `<div style="margin-top:3px;color:var(--text-2)">💰 ${t('最贵节点')}：<b>${esc(topCost.title || topCost.nodeId || '')}</b> ${fmtCostFront(topCost.costCny, u.priced)}${esc(topCost.model ? ' · ' + topCost.model : '')}</div>` : ''}
          ${slowTitle ? `<div style="margin-top:2px;color:var(--text-2)">⏱ ${t('最慢节点')}：<b>${esc(slowTitle)}</b> ${msLab(slowMs)}</div>` : ''}
        </div>`;
      }
      outHost?.insertAdjacentHTML('beforeend', costBar + `<div style="margin-top:12px"><b>📤 ${t('最终输出')}</b><div style="white-space:pre-wrap;background:var(--surface-2,#f3f4f6);border-radius:8px;padding:10px;margin-top:6px">${esc(evt.output || '')}</div></div>` +
        (evt.sessionVars && Object.keys(evt.sessionVars).length ? `<div style="margin-top:8px"><b>💾 ${t('会话变量（本轮结束时）')}</b><div style="background:rgba(37,99,235,.05);border:1px dashed #93c5fd;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:11.5px">${Object.entries(evt.sessionVars).map(([k, v]) => `<div><span class="code">{{#start.${esc(k)}#}}</span> = <b>${esc(String(v ?? '').slice(0, 80))}</b></div>`).join('')}<div class="hint" style="margin-top:4px">${t('运行测试为临时态（不持久化）；Chatflow 对话中轮末自动存回会话')}</div></div></div>` : '') +
        `<div class="hint" style="margin-top:8px">💡 ${t('点击画布任意节点 → 右侧「运行结果」tab 查看完整入参/出参，可「从此节点重跑」')}</div>`);
    }
    if (evt.type === 'error') {
      logsHost?.parentElement?.insertAdjacentHTML('beforeend', `<div style="color:#dc2626;margin-top:8px">❌ ${esc(evt.message || '')}</div>`);
    }
  }

  $('#cvRun').onclick = () => runTestSSE(null);

  // ---------- P5.8 #9 子智能体下钻：弹层展示子画布执行轨迹（嵌套可继续下钻） ----------
  async function openChildRun(runId, label) {
    const m = modal({
      title: `🔍 ${t('子智能体执行轨迹')} · run #${runId}${label ? ' · ' + esc(label) : ''}`,
      body: `<div id="cvDrillHost">⏳ ${t('加载中…')}</div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        (async () => {
          const host = mask.querySelector('#cvDrillHost');
          try {
            const j = await api(`/agents/${opts.agentId}/runs/${runId}`);
            const d = j.data || {};
            const logs = d.nodeLogs || [];
            host.innerHTML = `
              <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:12px">
                <span style="color:${d.status === 'success' ? '#059669' : '#dc2626'}">${d.status === 'success' ? '✅ 成功' : '❌ ' + esc(d.error || '失败')}</span>
                <span style="color:var(--text-3)">${d.total_duration_ms >= 1000 ? (d.total_duration_ms / 1000).toFixed(1) + 's' : d.total_duration_ms + 'ms'}${d.total_tokens ? ' · ' + d.total_tokens + ' tokens' : ''} · ${t('子智能体')} #${d.agent_id}</span>
              </div>
              <div class="hint" style="margin-bottom:8px">📥 ${t('任务输入')}：<span class="code">${esc((d.inputs || '').slice(0, 140))}</span><br>📤 ${t('回复输出')}：<span class="code">${esc((d.outputs || '').slice(0, 160))}</span></div>
              <b style="font-size:12px">${t('子画布节点 Trace')}</b>
              <div style="margin-top:6px;max-height:300px;overflow-y:auto">${logs.map(l => `
                <div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border,#eef0f3);font-size:11.5px;align-items:center">
                  <span style="color:${l.status === 'success' ? '#059669' : l.status === 'error' ? '#dc2626' : l.status === 'preset' ? '#0284c7' : '#9ca3af'}">${l.status === 'success' ? '✅' : l.status === 'error' ? '❌' : l.status === 'preset' ? '↺' : l.status === 'fallback' ? '⚠️' : '⏭️'}</span>
                  <b style="min-width:100px">${esc(l.nodeId)} ${esc(l.title || '')}</b>
                  <span style="color:var(--text-2);flex:1">${esc((l.output || l.error || l.note || '').slice(0, 70))}${l.retries ? ` <span style="color:#d97706">（重试×${l.retries}）</span>` : ''}</span>
                  <span style="color:var(--text-3)">${l.duration}ms</span>
                  ${l.childRunId ? `<button class="btn sm" data-childrun="${l.childRunId}" title="${t('查看该子智能体内部执行轨迹')}">🔍 ${t('下钻')}</button>` : ''}
                </div>`).join('') || `<div class="hint">${t('（表单模式子智能体：单次 LLM 调用，无画布轨迹）')}</div>`}</div>`;
            host.querySelectorAll('[data-childrun]').forEach(b => b.onclick = () => { close(); openChildRun(b.dataset.childrun); }); // 嵌套下钻
          } catch (e) { host.innerHTML = `<div style="color:#dc2626;padding:12px">❌ ${esc(e.message)}</div>`; }
        })();
      },
    });
  }

  // P5.5 运行历史：列表 + 节点级 Trace 详情（关页面后可回看） ----------
  $('#cvRunsBtn').onclick = async () => {
    const box = modal({
      title: '🕘 ' + t('运行历史（最近 50 次）'),
      body: `<div id="cvRunsList">⏳ ${t('加载中…')}</div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        (async () => {
          const host = mask.querySelector('#cvRunsList');
          try {
            const j = await api(`/agents/${opts.agentId}/runs`);
            if (!j.data?.length) { host.innerHTML = `<div class="hint" style="padding:16px">${t('暂无运行记录——点「▶ 运行测试」跑一次')}</div>`; return; }
            host.innerHTML = j.data.map(r => `
              <div style="display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border,#eef0f3);border-radius:8px;margin-bottom:6px;cursor:pointer" data-run="${r.id}">
                <span style="color:${r.status === 'success' ? '#059669' : r.status === 'error' ? '#dc2626' : '#d97706'}">${r.status === 'success' ? '✅' : r.status === 'error' ? '❌' : '⏳'}</span>
                <b style="min-width:64px">#${r.id}</b>
                <span style="font-size:11px;color:var(--text-3);min-width:80px">${esc(r.trigger_type || '')}</span>
                <span style="font-size:11px;color:var(--text-3);min-width:64px">${r.total_duration_ms >= 1000 ? (r.total_duration_ms / 1000).toFixed(1) + 's' : r.total_duration_ms + 'ms'}</span>
                <span style="font-size:11px;color:var(--text-3);min-width:70px">${r.total_tokens ? r.total_tokens + ' tk' : '—'}</span>
                <span style="font-size:11px;color:var(--text-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.outputs || r.error || '')}">${esc((r.outputs || r.error || '').slice(0, 60))}</span>
                <span style="font-size:10.5px;color:var(--text-3)">${esc((r.started_at || '').slice(5, 16))}</span>
              </div>`).join('');
            host.querySelectorAll('[data-run]').forEach(row => row.onclick = async () => {
              const detail = await api(`/agents/${opts.agentId}/runs/${row.dataset.run}`);
              const d = detail.data || {};
              const logs = d.nodeLogs || [];
              box.mask.querySelector('.modal-body').innerHTML = `
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
                  <button class="btn sm" id="cvRunsBack">← ${t('返回列表')}</button>
                  <b>#${d.id}</b>
                  <span style="color:${d.status === 'success' ? '#059669' : '#dc2626'}">${d.status === 'success' ? '✅ 成功' : '❌ ' + esc(d.error || '失败')}</span>
                  <span style="font-size:11px;color:var(--text-3)">${d.total_duration_ms >= 1000 ? (d.total_duration_ms / 1000).toFixed(1) + 's' : d.total_duration_ms + 'ms'}${d.total_tokens ? ' · ' + d.total_tokens + ' tokens' : ''} · ${esc(d.trigger_type)} · ${esc((d.started_at || '').slice(5, 19))}</span>
                </div>
                <div class="hint" style="margin-bottom:6px">📥 ${t('入参')}：<span class="code">${esc((d.inputs || '').slice(0, 120))}</span></div>
                <div class="hint" style="margin-bottom:8px">📤 ${t('最终输出')}：<span class="code">${esc((d.outputs || '').slice(0, 160))}</span></div>
                <b style="font-size:12px">${t('节点 Trace')}</b>
                ${(d.childRuns || []).length ? `<div style="margin:6px 0;padding:6px 10px;border:1px dashed #93c5fd;border-radius:8px;background:rgba(37,99,235,.04)"><b style="font-size:11.5px">🔍 ${t('子智能体运行')}（${d.childRuns.length}）</b>${d.childRuns.map(c => `
                  <div style="display:flex;gap:8px;align-items:center;font-size:11.5px;padding:3px 0">
                    <span style="color:${c.status === 'success' ? '#059669' : '#dc2626'}">${c.status === 'success' ? '✅' : '❌'}</span>
                    <b>#${c.id}</b><span style="color:var(--text-2)">${esc(c.agent_name || ('#' + c.agent_id))}</span>
                    <span style="color:var(--text-3);font-size:10.5px">${c.child_mode === 'canvas' ? t('画布模式') : t('表单模式')} · ${c.total_duration_ms}ms</span>
                    <span style="color:var(--text-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.outputs || '')}</span>
                    ${c.child_mode === 'canvas' ? `<button class="btn sm" data-childrun="${c.id}">🔍 ${t('下钻')}</button>` : ''}
                  </div>`).join('')}</div>` : ''}
                <div style="margin-top:6px;max-height:340px;overflow-y:auto">${logs.map(l => `
                  <div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border,#eef0f3);font-size:11.5px;align-items:center">
                    <span style="color:${l.status === 'success' ? '#059669' : l.status === 'error' ? '#dc2626' : l.status === 'preset' ? '#0284c7' : '#9ca3af'}">${l.status === 'success' ? '✅' : l.status === 'error' ? '❌' : l.status === 'preset' ? '↺' : l.status === 'fallback' ? '⚠️' : '⏭️'}</span>
                    <b style="min-width:100px">${esc(l.nodeId)} ${esc(l.title || '')}</b>
                    <span style="color:var(--text-2);flex:1">${esc((l.output || l.error || l.note || '').slice(0, 80))}${l.retries ? ` <span style="color:#d97706">（重试×${l.retries}）</span>` : ''}</span>
                    <span style="color:var(--text-3)">${l.duration}ms</span>
                    ${l.childRunId ? `<button class="btn sm" data-childrun="${l.childRunId}" title="${t('查看该子智能体内部执行轨迹')}">🔍 ${t('下钻')}</button>` : ''}
                  </div>`).join('')}</div>`;
              box.mask.querySelector('#cvRunsBack').onclick = () => { $('#cvRunsBtn').click(); };
              box.mask.querySelectorAll('[data-childrun]').forEach(b => b.onclick = () => openChildRun(b.dataset.childrun));
            });
          } catch (e) { host.innerHTML = `<div style="color:#dc2626;padding:12px">❌ ${esc(e.message)}</div>`; }
        })();
      },
    });
  };

  // ---------- P5.6 Workflow/Chatflow 模式切换（存 workflow JSON 根 flow_type） ----------
  function updateModeBtn() { const b = $('#cvModeBtn'); if (b) b.textContent = wf.flow_type === 'chatflow' ? '💬 Chatflow' : '⚙️ Workflow'; }
  $('#cvModeBtn').onclick = () => {
    wf.flow_type = wf.flow_type === 'chatflow' ? 'workflow' : 'chatflow';
    markDirty(); updateModeBtn(); pushHistory();
    toast(wf.flow_type === 'chatflow'
      ? t('💬 已切换 Chatflow：对话触发整图执行，llm 默认携带历史，直接回复节点流式输出')
      : t('⚙️ 已切换 Workflow：一次性执行，不带历史（llm 仍可单独勾选携带）'));
    renderProp();
  };
  updateModeBtn();

  // ---------- P5.6 画布搜索（Ctrl+F：标题/ID/类型过滤 + ↑↓Enter 定位闪烁） ----------
  function closeSearch() {
    searchDim = null;
    root.querySelector('.cv-search')?.remove();
    renderNodes();
  }
  function focusNode(id) {
    const n = wf.nodes.find(x => x.id === id);
    if (!n) return;
    const r = stage.getBoundingClientRect();
    wf.viewport.x = r.width / 2 - (n.position.x + 106) * wf.viewport.zoom;
    wf.viewport.y = r.height / 2 - (n.position.y + 60) * wf.viewport.zoom;
    applyViewport();
    selectNode(id);
    const el = world.querySelector(`.cv-node[data-id="${CSS.escape(id)}"]`);
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1500);
  }
  // P5.12：studio 校验报告「点击行定位节点」入口
  window.addEventListener('cv-focus-node', e => { if (root.isConnected && e.detail) focusNode(e.detail); });
  function openSearch() {
    if (document.querySelector('[data-subflow-open]')) return; // 子流程弹窗打开时让位
    closeSearch();
    const box = document.createElement('div');
    box.className = 'cv-search';
    box.innerHTML = `<input id="cvSearchInp" placeholder="${t('搜索节点标题 / ID / 类型…')}"><span class="cnt" id="cvSearchCnt"></span><button class="btn sm" id="cvSearchClose">✕</button>`;
    stage.appendChild(box);
    const inp = box.querySelector('#cvSearchInp');
    let matches = [], idx = -1;
    const apply = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { searchDim = null; matches = []; }
      else {
        matches = wf.nodes.filter(n => {
          const hay = `${n.data?.title || ''} ${n.id} ${NODE_TYPES[n.type]?.label || n.type}`.toLowerCase();
          return hay.includes(q);
        });
        searchDim = new Set(matches.map(n => n.id));
      }
      idx = -1;
      box.querySelector('#cvSearchCnt').textContent = q && !inp.value.trim() ? '' : (matches.length ? `${matches.length}/${wf.nodes.length}` : (inp.value.trim() ? t('无匹配') : ''));
      renderNodes();
    };
    inp.oninput = apply;
    inp.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!matches.length) return;
        idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        focusNode(matches[idx].id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (matches.length) { idx = idx < 0 ? 0 : idx; focusNode(matches[idx].id); }
      } else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    };
    box.querySelector('#cvSearchClose').onclick = closeSearch;
    inp.focus();
  }
  $('#cvSearchBtn').onclick = openSearch;

  // ---------- P5.17 工作流模板：📥 导入 / 💾 存为模板 ----------
  async function openWfTemplates() {
    let tpls = [];
    try { tpls = (await api('/wf-templates')).data || []; } catch (e) { toast(e.message, 'err'); return; }
    if (!tpls.length) { toast(t('模板库为空——先用画布编排一个流程再「💾 存为模板」')); return; }
    const m = modal({
      title: '📐 ' + t('从工作流模板导入'),
      body: `<div class="hint" style="margin-bottom:10px">${t('导入会')}<b style="color:var(--danger)">${t('覆盖当前画布')}</b>（${t('撤销可回退）——选一个高频场景开干：')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${tpls.map(tp => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);padding:12px;cursor:pointer" data-tplid="${tp.id}">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:20px">${tp.icon || '🎨'}</span>
              <div><b style="font-size:13px">${esc(tp.name)}</b><div style="font-size:10.5px;color:var(--text-3)">${esc(tp.category || '通用')} · ${tp.nodes_count || 0} ${t('节点')} · ${t('用过')} ${tp.use_count || 0} ${t('次')}</div></div>
            </div>
            <div style="font-size:11.5px;color:var(--text-3);line-height:1.6;margin-top:6px">${esc((tp.description || '').slice(0, 90))}</div>
          </div>`).join('')}
        </div>`,
      onMount(mask, close) {
        mask.querySelectorAll('[data-tplid]').forEach(card => card.onclick = async () => {
          try {
            const j = await api(`/wf-templates/${card.dataset.tplid}/detail`);
            close();
            setWorkflow(j.data.workflow, { keepHistory: true });
            markDirty();
            toast(`📐 ${t('已导入模板「')}${j.data.name}${t('」——节点/连线/便签全部就位，改提示词后即可用')}（Ctrl+Z ${t('可撤销')}）`);
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  }
  async function saveAsTemplate() {
    const wfNow = getWorkflow();
    if (!wfNow.nodes.length || wfNow.nodes.length < 2) { toast(t('画布为空或只有单节点——先编排一个完整流程再存模板')); return; }
    const m = modal({
      title: '💾 ' + t('存为工作流模板'),
      body: `<div class="hint" style="margin-bottom:10px">${t('当前画布（')}${wfNow.nodes.length} ${t('节点')} · ${wfNow.edges.length} ${t('连线')}）${t('将存为模板，出现在广场与编排页模板库，团队一键复用')}</div>
        <div class="fd" style="margin:0"><label>${t('模板名称')}*</label><input class="input" id="wftName" maxlength="40" placeholder="${t('如：周报自动生成')}"></div>
        <div class="fd"><label>${t('图标')}</label><input class="input" id="wftIcon" maxlength="4" value="🎨" style="width:80px"></div>
        <div class="fd"><label>${t('分类')}</label><input class="input" id="wftCat" maxlength="20" placeholder="${t('如：办公提效 / 客户服务 / 财务分析')}" style="width:200px"></div>
        <div class="fd"><label>${t('一句话描述')}</label><input class="input" id="wftDesc" maxlength="300" placeholder="${t('输入 → 处理 → 输出（用于广场卡片展示）')}"></div>
        <div class="fd"><label>${t('使用说明（复制后改哪几处）')}</label><textarea class="input" id="wftScene" maxlength="500" placeholder="${t('如：① 改 code 节点接真实数据源；② 提示词按需调整')}" style="min-height:60px"></textarea></div>`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn primary" id="wftGo">${t('存入模板库')}</button>`,
      onMount(mask, close) {
        mask.querySelector('#wftGo').onclick = async () => {
          const name = mask.querySelector('#wftName').value.trim();
          if (!name) { toast(t('模板名称不能为空')); return; }
          try {
            const j = await api('/wf-templates', { method: 'POST', body: {
              name,
              icon: mask.querySelector('#wftIcon').value.trim() || '🎨',
              category: mask.querySelector('#wftCat').value.trim() || '通用',
              description: mask.querySelector('#wftDesc').value.trim(),
              scene: mask.querySelector('#wftScene').value.trim(),
              workflow: wfNow,
            } });
            toast(j.msg || '已存为模板'); close();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }
  $('#cvTplBtn').onclick = openWfTemplates;
  $('#cvSaveTplBtn').onclick = saveAsTemplate;

  // ---------- P5.15 复制/粘贴/批量删除/节点跳转（快捷键基础设施） ----------
  let clip = null; // {nodes:[...], edges:[...]} 选区快照（节点深拷贝 + 集合内部连线）
  function copyNodes(ids) {
    const set = new Set(ids);
    clip = {
      nodes: ids.map(id => wf.nodes.find(n => n.id === id)).filter(Boolean).map(n => JSON.parse(JSON.stringify(n))),
      edges: wf.edges.filter(e => set.has(e.source) && set.has(e.target)).map(e => JSON.parse(JSON.stringify(e))),
    };
    toast(`⧉ ${t('已复制')} ${clip.nodes.length} ${t('个节点')}${clip.edges.length ? ` · ${clip.edges.length} ${t('条连线')}` : ''}（Ctrl+V ${t('粘贴')}）`);
  }
  function pasteNodes() {
    if (!clip?.nodes?.length) { toast(t('剪贴板为空——先选中节点按 Ctrl+C 复制')); return; }
    const idMap = {};
    for (const src of clip.nodes) {
      seq++;
      idMap[src.id] = src.type === 'start' ? 'start_' + seq : 'node_' + seq;
    }
    const created = clip.nodes.map(src => ({
      id: idMap[src.id], type: src.type,
      position: { x: Math.round(src.position.x + 34), y: Math.round(src.position.y + 34) }, // 右下偏移与原件区分
      data: JSON.parse(JSON.stringify(src.data || {})),
    }));
    wf.nodes.push(...created);
    for (const e of clip.edges) {
      wf.edges.push({ id: 'e_' + (wf.edges.length + 1) + '_' + Date.now() % 1000, source: idMap[e.source], target: idMap[e.target], sourceHandle: e.sourceHandle || 'out' });
    }
    selSet = new Set(Object.values(idMap));
    sel = created[created.length - 1].id;
    markDirty(); renderNodes(); renderProp(); showSelBar(); pushHistory();
    toast(`📋 ${t('已粘贴')} ${created.length} ${t('个节点（可拖动/删除/继续编辑）')}`);
  }
  function batchDelete(ids) {
    const idSet = new Set(ids);
    if (idSet.has(wf.nodes.find(n => n.type === 'start')?.id)) {
      toast(`⚠️ ${t('开始节点不能删除（工作流必须有 start）')}`); return;
    }
    // 外部引用统计（集合内部互相引用不算失效）
    const extRefs = [];
    for (const id of ids) for (const r of findRefsTo(id)) if (!idSet.has(r.nodeId)) extRefs.push(r);
    const m = modal({
      title: '🗑 ' + t('批量删除节点'),
      body: `<div style="font-size:12.5px;line-height:1.9;color:var(--text-2)">${t('将删除')} <b>${ids.length}</b> ${t('个节点及其间连线')}${extRefs.length ? `<br>⚠️ <b>${extRefs.length}</b> ${t('处外部引用将失效（画布标红）')}：` + extRefs.slice(0, 6).map(r => `<span class="code">{{#${esc(r.nodeId)}.${esc((r.field || '').split('.')[0])}#}}</span>`).join(' ') : ''}</div>`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn danger" data-go>${t('删除')}${ids.length} ${t('个')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-go]').onclick = () => {
          wf.nodes = wf.nodes.filter(n => !idSet.has(n.id));
          wf.edges = wf.edges.filter(e => !idSet.has(e.source) && !idSet.has(e.target));
          for (const g of wf.groups || []) g.nodeIds = (g.nodeIds || []).filter(x => !idSet.has(x));
          wf.groups = (wf.groups || []).filter(g => g.nodeIds.length);
          sel = null; selSet = null; root.querySelector('.cv-selbar')?.remove();
          refreshRefWarnings(); markDirty(); renderNodes(); renderProp(); pushHistory();
          close();
          toast(`🗑 ${t('已删除')} ${ids.length} ${t('个节点')}${extRefs.length ? `（${extRefs.length} ${t('处引用已标红')}）` : ''}`);
        };
      },
    });
  }
  function centerOn(n) {
    const r = stage.getBoundingClientRect();
    wf.viewport.x = r.width / 2 - (n.position.x + 106) * wf.viewport.zoom;
    wf.viewport.y = r.height / 2 - (n.position.y + 65) * wf.viewport.zoom;
    applyViewport();
  }
  function jumpNode(dir) {
    if (!wf.nodes.length) return;
    let idx = wf.nodes.findIndex(n => n.id === sel);
    idx = idx < 0 ? (dir > 0 ? 0 : wf.nodes.length - 1) : (idx + dir + wf.nodes.length) % wf.nodes.length;
    const n = wf.nodes[idx];
    clearSelSet(); selectNode(n.id); centerOn(n);
    const el = world.querySelector(`.cv-node[data-id="${CSS.escape(n.id)}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // ---------- P5.6 橡皮筋框选（空白处 Shift+拖拽）→ 多选 → 批量操作 / 分组 ----------
  function clearSelSet() { selSet = null; root.querySelector('.cv-selbar')?.remove(); renderNodes(); }
  function showSelBar() {
    root.querySelector('.cv-selbar')?.remove();
    const bar = document.createElement('div');
    bar.className = 'cv-selbar';
    bar.innerHTML = `<span style="font-size:11.5px;color:var(--text-2)">${selSet.size} ${t('个节点已框选')}</span>
      <button class="btn sm" id="cvCopyBtn">⧉ ${t('复制')}</button>
      <button class="btn sm" id="cvDelBtn" style="color:#dc2626">🗑 ${t('删除')}</button>
      <button class="btn primary sm" id="cvGroupBtn">🏷 ${t('设为分组')}</button>
      <button class="btn sm" id="cvSelClear">✕</button>`;
    stage.appendChild(bar);
    bar.querySelector('#cvCopyBtn').onclick = () => { copyNodes([...selSet]); };
    bar.querySelector('#cvDelBtn').onclick = () => { batchDelete([...selSet]); };
    bar.querySelector('#cvGroupBtn').onclick = () => { createGroupFromSel(); };
    bar.querySelector('#cvSelClear').onclick = clearSelSet;
  }
  function createGroupFromSel() {
    const ids = [...selSet];
    if (!ids.length) return;
    const COLORS = ['#2563eb', '#059669', '#d97706', '#c026d3', '#0d9488', '#dc2626'];
    const m = modal({
      title: '🏷 ' + t('创建分组'),
      body: `<div class="fd" style="margin:0"><label>${t('分组名称（如 数据获取阶段）')}</label>
        <input class="input" id="cvGrpName" placeholder="${t('分组名称')}"></div>
        <div class="fd"><label>${t('颜色')}</label><div style="display:flex;gap:8px">${COLORS.map((c, i) => `<label style="cursor:pointer"><input type="radio" name="cvGrpColor" value="${c}" ${i === 0 ? 'checked' : ''}><span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${c};vertical-align:-2px;margin-left:4px"></span></label>`).join('')}</div></div>
        <div class="hint">${t('共')} ${ids.length} ${t('个节点；已在他组的节点会移入新组（旧组空则自动解散）；组可折叠/重命名/换色/解散')}</div>`,
      foot: `<button class="btn primary" id="cvGrpGo">${t('创建')}</button>`,
      onMount(mask, close) {
        mask.querySelector('#cvGrpGo').onclick = () => {
          const name = mask.querySelector('#cvGrpName').value.trim() || t('未命名分组');
          const color = mask.querySelector('input[name="cvGrpColor"]:checked')?.value || '#2563eb';
          // 移出旧组（空组自动解散）
          for (const g of wf.groups || []) g.nodeIds = (g.nodeIds || []).filter(x => !ids.includes(x));
          wf.groups = (wf.groups || []).filter(g => g.nodeIds.length);
          wf.groups.push({ id: 'grp_' + Date.now() % 100000, name, color, nodeIds: ids, collapsed: false });
          close(); clearSelSet();
          markDirty(); renderNodes(); renderMinimap(); pushHistory();
          toast(t('分组已创建（组头可拖动整组/折叠/管理）'));
        };
      },
    });
  }
  function groupMenu(g) {
    const COLORS = ['#2563eb', '#059669', '#d97706', '#c026d3', '#0d9488', '#dc2626'];
    const m = modal({
      title: '🏷 ' + t('分组管理：') + esc(g.name),
      body: `<div class="fd" style="margin:0"><label>${t('重命名')}</label><input class="input" id="cvGrpRen" value="${esc(g.name)}"></div>
        <div class="fd"><label>${t('颜色')}</label><div style="display:flex;gap:8px">${COLORS.map(c => `<label style="cursor:pointer"><input type="radio" name="cvGrpRenC" value="${c}" ${g.color === c ? 'checked' : ''}><span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${c};vertical-align:-2px;margin-left:4px"></span></label>`).join('')}</div></div>
        <div class="hint">${g.nodeIds.length} ${t('个节点')} · ${g.collapsed ? t('已折叠') : t('展开中')}</div>`,
      foot: `<button class="btn" id="cvGrpDis">${t('解散分组')}</button><button class="btn primary" id="cvGrpSave">${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('#cvGrpSave').onclick = () => {
          g.name = mask.querySelector('#cvGrpRen').value.trim() || g.name;
          g.color = mask.querySelector('input[name="cvGrpRenC"]:checked')?.value || g.color;
          close(); markDirty(); renderNodes(); renderMinimap(); pushHistory();
        };
        mask.querySelector('#cvGrpDis').onclick = () => {
          wf.groups = (wf.groups || []).filter(x => x.id !== g.id);
          close(); markDirty(); renderNodes(); renderMinimap(); pushHistory();
          toast(t('分组已解散（节点保留）'));
        };
      },
    });
  }

  // ---------- 对外接口（V2 序列化） ----------
  function getWorkflow() {
    return {
      nodes: wf.nodes.map(n => ({ id: n.id, type: n.type, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data || {} })),
      edges: wf.edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'out' })),
      viewport: { x: Math.round(wf.viewport.x), y: Math.round(wf.viewport.y), zoom: +wf.viewport.zoom.toFixed(2) },
      flow_type: wf.flow_type === 'chatflow' ? 'chatflow' : 'workflow', // P5.6 双模式
      groups: (wf.groups || []).map(g => ({ id: g.id, name: g.name, color: g.color, nodeIds: [...(g.nodeIds || [])], collapsed: !!g.collapsed })), // P5.6 分组
      notes: (wf.notes || []).map(n => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h), text: String(n.text || ''), color: n.color || '#fef08a' })), // P5.15 便签
    };
  }
  function setWorkflow(w, opts) {
    // P5.6：flow_type/groups 随节点/边一并载入（此前重建对象时被丢弃，导致刷新后模式/分组丢失）
    wf = w && Array.isArray(w.nodes)
      ? { nodes: w.nodes, edges: w.edges || [], viewport: w.viewport || { x: 60, y: 40, zoom: 1 },
          flow_type: w.flow_type === 'chatflow' ? 'chatflow' : 'workflow',
          groups: Array.isArray(w.groups) ? w.groups : [],
          notes: Array.isArray(w.notes) ? w.notes : [] } // P5.15 便签随图载入
      : { nodes: [], edges: [], viewport: { x: 60, y: 40, zoom: 1 }, flow_type: 'workflow', groups: [], notes: [] };
    seq = (wf.nodes || []).reduce((m, n) => { const num = Number(String(n.id).replace(/^node_/, '')); return Math.max(m, Number.isFinite(num) ? num : 0); }, 0);
    sel = null; selSet = null; searchDim = null;
    root.querySelector('.cv-selbar')?.remove(); closeCvMenu();
    updateModeBtn();
    refreshRefWarnings();
    if (opts && opts.keepHistory) pushHistory(); // P5.17 模板导入：保留撤销栈（Ctrl+Z 回到导入前）
    else { history = []; histIdx = -1; pushHistory(); }
    renderNodes(); renderProp(); applyViewport(); renderMinimap();
  }
  function destroy() {
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('keydown', onCvEsc);
    window.removeEventListener('mousedown', onCvMenuClose, true);
    window.removeEventListener('mousemove', onCvDragMove);
    window.removeEventListener('mouseup', onCvDragUp);
    if (window.__cvViewportShiftCleanup) window.__cvViewportShiftCleanup(); // 清 resize + devicePosture
    closeVarPop(); closeCvMenu();
    root.innerHTML = '';
  }
  // P5.12 对外：保存前校验（返回问题清单）+ 校验结果注入（渲染红点角标）
  function runValidation() {
    const r = validateWorkflow();
    validationProblems = new Map();
    for (const p of r.problems) {
      if (!validationProblems.has(p.nodeId)) validationProblems.set(p.nodeId, []);
      validationProblems.get(p.nodeId).push(p);
    }
    renderNodes();
    return r;
  }
  function clearValidation() { validationProblems = null; renderNodes(); }

  // ---------- U1-7 实时协作支持：远程增量应用 / 位置应用 / 坐标换算 / stage 引用 ----------
  /** 应用服务端广播的画布增量（diffWorkflows 输出；added 含完整 node/edge）。
   *  走 markDirty → 触发既有自动保存；触发的回环提交服务端 diff=0 会吸收（仅 ack 不广播） */
  function applyDiff(d) {
    if (!d || !d.nodes || !d.edges) return { ok: false };
    const ek = e => e.id || `${e.source || '?'}|${e.target || '?'}|${e.sourceHandle || ''}`;
    const rmIds = new Set((d.nodes.removed || []).map(r => String(r.id)));
    if (rmIds.size) {
      wf.nodes = wf.nodes.filter(n => !rmIds.has(String(n.id)));
      if (sel && rmIds.has(String(sel))) sel = null;
      if (selSet) selSet = new Set([...selSet].filter(id2 => !rmIds.has(String(id2))));
    }
    for (const a of (d.nodes.added || [])) {
      if (a.node && typeof a.node === 'object' && a.node.id != null && !wf.nodes.some(n => String(n.id) === String(a.node.id))) {
        wf.nodes.push({ ...a.node, position: a.node.position || { x: 0, y: 0 }, data: a.node.data || {} });
      }
    }
    for (const c of (d.nodes.changed || [])) {
      const n = wf.nodes.find(x => String(x.id) === String(c.id));
      if (n) {
        n.data = (n.data && typeof n.data === 'object') ? n.data : {};
        for (const f of (c.fields || [])) n.data[f.key] = f.to; // 字段级覆盖（含对象/数组深值）
      }
    }
    for (const r of (d.edges.removed || [])) wf.edges = wf.edges.filter(e => ek(e) !== r.key);
    for (const a of (d.edges.added || [])) {
      if (a.edge && typeof a.edge === 'object' && !wf.edges.some(e => ek(e) === ek(a.edge))) {
        wf.edges.push({ id: a.edge.id, source: a.edge.source, target: a.edge.target, sourceHandle: a.edge.sourceHandle || 'out' });
      }
    }
    for (const c of (d.edges.changed || [])) {
      const e = wf.edges.find(x => ek(x) === c.key);
      if (e) for (const f of (c.fields || [])) if (['id', 'source', 'target', 'sourceHandle'].includes(f.key)) e[f.key] = f.to;
    }
    refreshRefWarnings(); markDirty(); renderNodes(); renderProp(); renderMinimap(); pushHistory();
    return { ok: true };
  }
  /** 应用远程位置移动（node:move 轻指令；不重渲染属性面板） */
  function applyMoves(moves) {
    if (!Array.isArray(moves)) return;
    for (const v of moves) {
      const n = wf.nodes.find(x => String(x.id) === String(v.id));
      if (n && Number.isFinite(+v.x) && Number.isFinite(+v.y)) { n.position.x = +v.x; n.position.y = +v.y; }
    }
    markDirty(); renderNodes(); renderEdges(); renderMinimap();
  }
  /** 画布世界坐标 → stage 容器内像素坐标（远程光标层定位；stage 为 position:relative） */
  function worldToStage(x, y) {
    return { x: x * wf.viewport.zoom + wf.viewport.x, y: y * wf.viewport.zoom + wf.viewport.y };
  }

  refreshRefWarnings();
  renderNodes(); renderProp();
  return { getWorkflow, setWorkflow, destroy, pushHistory, validate: runValidation, clearValidation,
    // U1-7：实时协作 API（toWorld 已有：世界坐标换算；getStageEl：光标层挂载点）
    applyDiff, applyMoves, toWorld, worldToStage, getStageEl: () => stage };
}
