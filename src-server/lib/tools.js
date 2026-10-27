/**
 * 工具系统（function calling）：
 * - 内置工具：kb_search / get_datetime / calculator / image_gen（QwenImage，多供应商路由）
 * - MCP 工具：智能体挂载的 MCP 服务工具（mcp_ 前缀路由到对应 server）
 * ctx: { kbId, mcpServers: [MCP server 记录], defaultImageModel? }
 */
const { retrieve } = require('./retriever');
const mcp = require('./mcp');
const { db } = require('../db');
const skills = require('./skills'); // 文生图委托给 skills.genImage（多供应商路由 + 重试容错，避免绑死默认供应商）

const TOOL_DEFS = {
  kb_search: {
    schema: {
      type: 'function',
      function: {
        name: 'kb_search',
        description: '在智能体关联的企业知识库中检索相关资料。当问题可能涉及公司制度、产品文档、业务知识时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或问题' },
          },
          required: ['query'],
        },
      },
    },
    run: async (args, ctx) => {
      if (!ctx.kbId) return '当前智能体未关联知识库，无法检索。';
      const hits = await retrieve(args.query || '', ctx.kbId, 5, 0.01);
      if (!hits.length) return '知识库中未检索到相关内容。';
      return hits.map((h, i) => `[${i + 1}]（来源：${h.file || h.kb}，得分${h.score}）${h.content}`).join('\n');
    },
  },
  get_datetime: {
    schema: {
      type: 'function',
      function: {
        name: 'get_datetime',
        description: '获取当前的日期、时间与星期。涉及"今天/现在/几点"等时间问题时使用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const now = new Date();
      const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
      return `当前时间：${now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（星期${week}，北京时间）`;
    },
  },
  calculator: {
    schema: {
      type: 'function',
      function: {
        name: 'calculator',
        description: '精确计算算术表达式，支持 + - * / % ^ ( ) 与小数。涉及数值计算时使用，避免心算出错。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '算术表达式，如 (1+2)*3.5/7' },
          },
          required: ['expression'],
        },
      },
    },
    run: async (args) => {
      const val = safeCalc(args.expression || '');
      return typeof val === 'number' ? `计算结果：${val}` : `表达式无法计算：${val}`;
    },
  },
  image_gen: {
    schema: {
      type: 'function',
      function: {
        name: 'image_gen',
        description: '文生图：根据文字描述生成图片（QwenImage，多供应商自动路由）。适合海报、插图、示意等视觉内容需求。返回图片链接，回答中用 markdown 图片语法展示。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（中英文均可，具体到主体/风格/构图）' },
            size: { type: 'string', description: '尺寸，可选：1024x1024 / 1280x720 / 720x1280，默认 1024x1024' },
          },
          required: ['prompt'],
        },
      },
    },
    run: async (args) => {
      const size = /^\d{3,4}x\d{3,4}$/.test(args.size || '') ? args.size : '1024x1024';
      try {
        // 委托 skills.genImage：逐供应商尝试（默认优先）+ 网络重试容错 + b64 本地落盘
        const r = await skills.genImage(args.prompt || '', size);
        // P5.20 修复：去掉「请在回答中原样保留…」内部指令——画布 end 直引 {{#node_3.result#}} 时该行会透传给用户
        //（指令外泄）；markdown 图本身可直接渲染，LLM 转述场景有 schema 描述引导足够。
        return `图片已生成（模型 ${r.model}，尺寸 ${r.size}）：\n\n![生成图片](${r.url})`;
      } catch (e) {
        return '图片生成失败：' + e.message;
      }
    },
  },
};

// P3 扩展工具（2026-10-22）：Text2SQL / 图表 / 联网 / 行情 / Word 导出 / TTS / 文档评审（tools-extra.js 注册合并；只取工具定义，忽略其导出的辅助函数）
const _extra = require('./tools-extra');
for (const _k of ['db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'export_word', 'tts', 'doc_review', 'run_code', 'local_exec']) {
  if (_extra[_k] && _extra[_k].schema) TOOL_DEFS[_k] = _extra[_k];
}

// P5.25 工具风险分级（对话权限「默认权限/全自动执行」的判定依据）：
//  - low（默认）：纯读/纯算，执行无副作用——get_datetime/calculator/kb_search/db_query/db_chart/web_search/web_fetch/stock_quote/doc_review
//  - medium：产出外部可见产物或花费 token 较多——image_gen/export_word/tts/子智能体调用 agent_call_*
//  - high：MCP 任意工具（能力不可枚举，可能含写操作/对外发送）——按 mcp_ 前缀整体归 high
// 「默认权限」下 medium/high 执行前需用户确认；「全自动执行」全部放行；low 永不拦截（确认疲劳无意义）。
const TOOL_RISK = {
  low: ['get_datetime', 'calculator', 'kb_search', 'db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'doc_review'],
  medium: ['image_gen', 'export_word', 'tts', 'run_code'],
};
function toolRiskOf(name) {
  if (name.startsWith('mcp_') || name.startsWith('agent_call_') || name.startsWith('local_')) return 'high';
  for (const [level, ids] of Object.entries(TOOL_RISK)) if (ids.includes(name)) return level;
  return 'medium'; // 未知工具保守按 medium（需确认而非放行）
}

/** 安全算术求值（递归下降，不用 eval） */
function safeCalc(expr) {
  const s = String(expr).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/，/g, '');
  let pos = 0;
  function peek() { return s[pos]; }
  function eat(ch) { if (s[pos] === ch) { pos++; return true; } return false; }
  function number() {
    const m = /^\d+(\.\d+)?/.exec(s.slice(pos));
    if (!m) throw new Error('非法数字');
    pos += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    if (eat('(')) { const v = expr0(); if (!eat(')')) throw new Error('括号不匹配'); return v; }
    if (eat('-')) return -factor();
    if (eat('+')) return factor();
    return number();
  }
  function power() {
    let base = factor();
    if (eat('^')) return Math.pow(base, power());
    return base;
  }
  function term() {
    let v = power();
    while (true) {
      if (eat('*')) v *= power();
      else if (eat('/')) v /= power();
      else if (eat('%')) v %= power();
      else return v;
    }
  }
  function expr0() {
    let v = term();
    while (true) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  try {
    if (!/^[-+().0-9*/%^\s×÷，]+$/.test(String(expr))) return '包含不支持的字符';
    const v = expr0();
    if (pos !== s.length) return '表达式格式错误';
    if (!isFinite(v)) return '结果非有限数';
    return Math.round(v * 1e10) / 1e10;
  } catch (e) {
    return e.message;
  }
}

/** 组装 OpenAI tools 数组：内置工具 + MCP 工具（mcpTools: [{schema}]）+ 子智能体工具（childTools: [{schema}]，agent_call_ 前缀） */
function buildTools(toolIds, mcpTools = [], childTools = []) {
  const builtin = (toolIds || []).filter(id => TOOL_DEFS[id]).map(id => TOOL_DEFS[id].schema);
  return [...builtin, ...mcpTools.map(t => t.schema), ...(childTools || []).map(t => t.schema)];
}

/** 加载智能体挂载的 MCP 服务工具清单（从缓存读，避免每次连接） */
function loadMcpTools(agentMcpIds) {
  let ids = [];
  try { ids = JSON.parse(agentMcpIds || '[]'); } catch { }
  if (!ids.length) return [];
  const servers = db.prepare(`SELECT * FROM mcp_servers WHERE status=1`).all().filter(s => ids.includes(s.id));
  const out = [];
  for (const s of servers) {
    try {
      const tools = JSON.parse(s.tools_cache || '[]');
      tools.forEach(t => out.push({ ...t, server: s }));
    } catch { }
  }
  return out;
}

/** 执行工具调用（内置 / MCP 路由） */
async function runTool(name, argsJson, ctx = {}) {
  // MCP 工具：mcp_xxx → 在挂载的 MCP 工具清单中查找并调用对应 server
  if (name.startsWith('mcp_')) {
    const mcpTools = loadMcpTools(ctx.mcpServers || '[]');
    const t = mcpTools.find(x => x.name === name);
    if (!t) return `未知 MCP 工具：${name}（请在后台刷新 MCP 工具清单）`;
    try {
      return await mcp.callTool(t.server, t.originalName, argsJson);
    } catch (e) {
      return `MCP 工具执行失败：${e.message}`;
    }
  }
  const tool = TOOL_DEFS[name];
  if (!tool) return `未知工具：${name}`;
  let args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { }
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `工具执行失败：${e.message}`;
  }
}

module.exports = { TOOL_DEFS, buildTools, runTool, loadMcpTools, toolRiskOf };
