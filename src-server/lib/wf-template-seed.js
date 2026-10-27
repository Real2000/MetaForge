/**
 * 工作流模板内置种子（P5.17）：企业高频场景，一键复用
 * 每个模板 = 预配置 workflow JSON + 场景说明（复制后改提示词/知识库即可用）
 * 幂等 seed：slug 已存在则跳过（管理员可另存同名变体）
 */

// ---------- 模板 1：周报自动生成 ----------
const WEEKLY_REPORT = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 80, y: 200 }, data: { title: '开始', variables: [
      { name: 'team', type: 'string', label: '团队/部门名', default: '产品部' },
      { name: 'week', type: 'string', label: '本周周数', default: '' },
    ] } },
    { id: 'node_1', type: 'code', position: { x: 420, y: 200 }, data: { title: '拉取本周数据', timeout: 5000,
      code: `// 拉取本周业务数据。示例为模拟数据——
// 接企业真实数据时替换为调用数据接口 / 或改用 db_query 工具节点查平台库
const data = {
  team: input_vars.team || '产品部',
  week: input_vars.week || '本周',
  metrics: {
    需求交付: { 本周: 12, 上周: 9, 目标: 10 },
    缺陷新增: { 本周: 5, 上周: 11, 目标: 8 },
    线上事故: { 本周: 0, 上周: 1, 目标: 0 },
    客户满意度: { 本周: 96.2, 上周: 94.8, 目标: 95 },
  },
};
return { output: JSON.stringify(data), data_raw: data };`,
      inputs: '{"team":"{{#start.team#}}","week":"{{#start.week#}}"}' } },
    { id: 'node_2', type: 'llm', position: { x: 780, y: 200 }, data: { title: 'LLM 总结周报',
      system_prompt: '你是资深团队周报撰写助手。基于输入的结构化数据生成一份可直接发给管理层的周报，要求：1) 开头一段总体结论（含环比变化）；2) 分维度要点（用「目标达成/未达成」标注）；3) 风险与下周计划；4) 语言精炼克制，数字必须与输入一致，不编造。',
      prompt: '团队：{{#start.team#}}（{{#start.week#}}）\n本周数据：\n{{#node_1.output#}}\n\n请生成周报正文（Markdown）。',
      max_tokens: 2048, temperature: 0.4 } },
    { id: 'node_3', type: 'tool', position: { x: 1140, y: 200 }, data: { title: '导出 Word 周报', toolId: 'export_word',
      args: '{"title":"{{#start.team#}}周报","markdown":"{{#node_2.text#}}"}' } },
    { id: 'node_4', type: 'end', position: { x: 1500, y: 200 }, data: { title: '输出', outputs: [
      { variable: 'weekly_report', value: '{{#node_2.text#}}' } ] } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'node_1' },
    { id: 'e2', source: 'node_1', target: 'node_2' },
    { id: 'e3', source: 'node_2', target: 'node_3' },
    { id: 'e4', source: 'node_2', target: 'node_4' },
  ],
  viewport: { x: 40, y: 60, zoom: 0.85 }, flow_type: 'workflow', groups: [], notes: [],
};

// ---------- 模板 2：客户投诉处理 ----------
const COMPLAINT = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 80, y: 220 }, data: { title: '开始', variables: [
      { name: 'customer', type: 'string', label: '客户称呼', default: '客户' },
    ] } },
    { id: 'node_1', type: 'llm', position: { x: 420, y: 120 }, data: { title: '意图分类与情绪判断',
      system_prompt: '你是客服投诉分类专家。读取投诉文本，输出 JSON：{"intent":"退款|物流|产品质量|服务态度|其他","urgency":"高|中|低","emotion":"愤怒|不满|一般"}。只输出 JSON，不要多余文字。',
      prompt: '投诉文本：\n{{#start.input#}}',
      output_schema: '{ "type": "object", "properties": { "intent": { "type": "string" }, "urgency": { "type": "string" }, "emotion": { "type": "string" } } }',
      max_tokens: 512, temperature: 0.2 } },
    { id: 'node_2', type: 'tool', position: { x: 780, y: 120 }, data: { title: '检索处理规范', toolId: 'kb_search',
      args: '{"query":"{{#node_1.intent#}} 投诉 处理流程 赔偿标准"}' } },
    { id: 'node_3', type: 'llm', position: { x: 1140, y: 120 }, data: { title: '生成回复建议（待人工审核）',
      system_prompt: '你是资深客服专家。基于投诉分类与知识库规范，生成一条回复建议：1) 先共情安抚（结合情绪等级调整语气）；2) 明确处理方案与依据（引用知识库规范）；3) 高紧急度时给出升级建议；4) 结尾提醒——此建议需人工审核后发送，输出包含「【人工审核要点】」小节列出审核人需要确认的事项。',
      prompt: '客户：{{#start.customer#}}\n投诉原文：\n{{#start.input#}}\n\n分类结果：意图 {{#node_1.intent#}} / 紧急度 {{#node_1.urgency#}} / 情绪 {{#node_1.emotion#}}\n\n知识库处理规范：\n{{#node_2.result#}}',
      max_tokens: 1536, temperature: 0.5 } },
    { id: 'node_4', type: 'end', position: { x: 1500, y: 220 }, data: { title: '输出（建议·需人工审核）', outputs: [
      { variable: 'reply_draft', value: '{{#node_3.text#}}' } ] } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'node_1' },
    { id: 'e2', source: 'node_1', target: 'node_2' },
    { id: 'e3', source: 'node_2', target: 'node_3' },
    { id: 'e4', source: 'node_3', target: 'node_4' },
  ],
  viewport: { x: 40, y: 60, zoom: 0.85 }, flow_type: 'workflow', groups: [], notes: [
    { id: 'note_1', x: 1130, y: 340, w: 320, h: 110, text: '回复建议不直接发送客户——\n人工审核通过后再发出（合规要求）', color: '#fef08a' },
  ],
};

// ---------- 模板 3：财报解读 ----------
const FINANCIAL_REPORT = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 80, y: 200 }, data: { title: '开始', variables: [
      { name: 'report', type: 'file', label: '财报 PDF/文本' },
      { name: 'focus', type: 'string', label: '关注重点', default: '营收、利润、负债与现金流' },
    ] } },
    { id: 'node_1', type: 'llm', position: { x: 420, y: 200 }, data: { title: '提取关键财务数据',
      system_prompt: '你是财务数据提取专家。从财报全文中提取关键指标，输出 JSON：{"revenue":数字,"revenue_yoy":数字(同比%),"net_profit":数字,"profit_yoy":数字,"debt_ratio":数字(%),"cash_flow":数字,"highlights":[要点1,要点2,...]}（单位与原文一致，缺失填 null，不编造）。',
      prompt: '财报全文：\n{{#start.report#}}\n\n关注重点：{{#start.focus#}}',
      output_schema: '{ "type": "object", "properties": { "revenue": { "type": "number" }, "revenue_yoy": { "type": "number" }, "net_profit": { "type": "number" }, "profit_yoy": { "type": "number" }, "debt_ratio": { "type": "number" }, "cash_flow": { "type": "number" }, "highlights": { "type": "array", "items": { "type": "string" } } } }',
      max_tokens: 1024, temperature: 0.1 } },
    { id: 'node_2', type: 'code', position: { x: 780, y: 200 }, data: { title: '指标校验与增长计算',
      code: `// 结构化提取结果透传 + 简单校验（数字字段异常时标记）
const d = typeof input_vars.extracted === 'string' ? JSON.parse(input_vars.extracted || '{}') : (input_vars.extracted || {});
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const checked = {
  revenue: num(d.revenue), revenue_yoy: num(d.revenue_yoy),
  net_profit: num(d.net_profit), profit_yoy: num(d.profit_yoy),
  debt_ratio: num(d.debt_ratio), cash_flow: num(d.cash_flow),
  highlights: Array.isArray(d.highlights) ? d.highlights : [],
  // 利润率（可算才算，避免 NaN）
  net_margin: (num(d.revenue) && num(d.net_profit)) ? +(d.net_profit / d.revenue * 100).toFixed(2) : null,
};
return { output: JSON.stringify(checked), metrics: checked };`,
      inputs: '{"extracted":"{{#node_1.text#}}"}', timeout: 3000 } },
    { id: 'node_3', type: 'llm', position: { x: 1140, y: 200 }, data: { title: '综合分析解读',
      system_prompt: '你是首席财务分析师。基于提取并校验后的指标生成财报解读：1) 一句话总体评价；2) 核心指标解读（营收/利润/负债/现金流，同比变化必须引用给定数字）；3) 三张图表建议（每张给出图表类型、标题、数据系列——供后续绘图）；4) 风险提示与关注点。语言专业克制，区分「数据支撑的结论」与「推断」。',
      prompt: '关注重点：{{#start.focus#}}\n校验后指标：\n{{#node_2.output#}}\n\n请生成解读报告（Markdown）。',
      max_tokens: 3072, temperature: 0.3 } },
    { id: 'node_4', type: 'tool', position: { x: 1500, y: 200 }, data: { title: '导出解读报告', toolId: 'export_word',
      args: '{"title":"财报解读报告","markdown":"{{#node_3.text#}}"}' } },
    { id: 'node_5', type: 'end', position: { x: 1860, y: 200 }, data: { title: '输出', outputs: [
      { variable: 'analysis', value: '{{#node_3.text#}}' } ] } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'node_1' },
    { id: 'e2', source: 'node_1', target: 'node_2' },
    { id: 'e3', source: 'node_2', target: 'node_3' },
    { id: 'e4', source: 'node_3', target: 'node_4' },
    { id: 'e5', source: 'node_3', target: 'node_5' },
  ],
  viewport: { x: 20, y: 60, zoom: 0.75 }, flow_type: 'workflow', groups: [], notes: [],
};

const SEEDS = [
  {
    slug: 'weekly-report',
    name: '周报自动生成',
    icon: '📋',
    category: '办公提效',
    description: '输入团队与周数 → 拉取本周数据 → LLM 总结成管理层周报 → 自动导出 Word。数据源示例为模拟数据，换成真实接口或 db_query 即可。',
    scene: '复制后改三处：① code 节点「拉取本周数据」换成你的真实数据源；② LLM 提示词按你的周报格式调整；③ 想定时生成可到「任务管理」配置定时触发。',
    workflow: WEEKLY_REPORT,
  },
  {
    slug: 'complaint-handler',
    name: '客户投诉处理',
    icon: '🎧',
    category: '客户服务',
    description: '接收投诉文本 → LLM 意图分类（退款/物流/质量/态度）→ 知识库检索处理规范 → 生成回复建议 → 人工审核后发送。含审核要点小节，合规可控。',
    scene: '复制后改两处：① 把公司客服规范/赔偿标准上传到知识库并关联；② LLM「生成回复建议」的语气与话术按品牌调性调整。画布上的黄色便签提醒了人工审核环节。',
    workflow: COMPLAINT,
  },
  {
    slug: 'fin-report-reader',
    name: '财报解读',
    icon: '📈',
    category: '财务分析',
    description: '上传财报 PDF → LLM 提取关键财务数据（结构化）→ 代码校验与利润率计算 → 生成专业解读与图表建议 → 导出 Word 报告。',
    scene: '复制后改两处：① LLM 提取字段按你的报表科目调整（output_schema 同步改）；② 关注重点变量支持调用时传入。文件变量 report 直传财报 PDF 即可（文件一等变量）。',
    workflow: FINANCIAL_REPORT,
  },
];

module.exports = { SEEDS };
