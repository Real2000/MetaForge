/**
 * 工具系统（function calling）：
 * - 内置工具：kb_search / get_datetime / calculator / image_gen（QwenImage，多供应商路由）
 * - MCP 工具：智能体挂载的 MCP 服务工具（mcp_ 前缀路由到对应 server）
 * ctx: { kbId, mcpServers: [MCP server 记录], defaultImageModel?, metadataFilter? }
 * V1.2 审查加固 2026-10-30：metadataFilter 为智能体声明的知识库元数据过滤（chat 链路按请求用户解析后传入）
 */
const { retrieve } = require('./retriever');
const mcp = require('./mcp');
const { db } = require('../db');
const skills = require('./skills'); // 文生图委托给 skills.genImage（多供应商路由 + 重试容错，避免绑死默认供应商）
const { AGENT_TOOL_DENY } = require('./tool-deny'); // P5.34b：抽零依赖模块（db.js 迁移也引用，避免循环依赖）

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
      // V1.2 审查加固 2026-10-30：kb_search 同样受智能体元数据过滤约束——ctx.metadataFilter 由 chat 主链路/
      // 子智能体链路传入（无值=不过滤，兼容编排页试运行等无最终用户语义的调用方）
      const hits = await retrieve(args.query || '', ctx.kbId, 5, 0.01, { metadataFilter: ctx.metadataFilter || undefined });
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

  // U1-4 浏览器自动化工具（GUI Agent 工具化）
  browser_use: {
    schema: {
      type: 'function',
      function: {
        name: 'browser_use',
        description: '使用浏览器自动化执行网页操作：导航、截图、点击、输入文本。适合需要访问外部网页、抓取屏幕内容的场景。高危操作需审批。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要访问的网页地址（必须以 http:// 或 https:// 开头）' },
            action: { type: 'string', enum: ['navigate', 'screenshot', 'click', 'type'], description: '操作类型：navigate=导航/screenshot=截图/click=点击元素/type=输入文本' },
            selector: { type: 'string', description: 'CSS 选择器（click/type 必填，如 #submit-button）' },
            text: { type: 'string', description: '输入的文本（type 必填）' },
          },
          required: ['url', 'action'],
        },
      },
    },
    run: async (args) => {
      const { url, action, selector, text } = args || {};
      if (!url) return '请提供 URL';
      try {
        const ba = require('./browser-automation');
        const session = await ba.launchSession();
        if (!session || !session.session_id) return '浏览器自动化不可用（需要安装 playwright：npm install playwright）';
        const sid = session.session_id;
        if (action === 'navigate' || !action) {
          const nav = await ba.navigate(sid, url);
          await ba.closeSession(sid);
          return `✅ 已导航到 ${url}（标题：${nav?.title || ''}）`;
        }
        if (action === 'screenshot' || !action) {
          await ba.navigate(sid, url);
          const shot = await ba.screenshot(sid);
          await ba.closeSession(sid);
          return `已截取 ${url} 的屏幕截图（${shot?.size || 0} 字节）。请注意：base64 图片数据仅在当前对话中可用，不会持久化。\n![截图](data:image/png;base64,${shot?.base64 || ''})`;
        }
        if (action === 'click') {
          await ba.navigate(sid, url);
          await ba.click(sid, selector);
          await ba.closeSession(sid);
          return `✅ 已在 ${url} 页面上点击元素「${selector}」`;
        }
        if (action === 'type') {
          await ba.navigate(sid, url);
          await ba.typeText(sid, selector, text);
          await ba.closeSession(sid);
          return `✅ 已在 ${url} 的「${selector}」输入文本`;
        }
        await ba.closeSession(sid);
        return `未知操作：${action}`;
      } catch (e) {
        return `浏览器自动化执行失败：${e.message}`;
      }
    },
  },
};

// P3 扩展工具（2026-10-22）：Text2SQL / 图表 / 联网 / 行情 / Word 导出 / TTS / 文档评审（tools-extra.js 注册合并；只取工具定义，忽略其导出的辅助函数）
const _extra = require('./tools-extra');
for (const _k of ['db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'export_word', 'tts', 'doc_review', 'run_code', 'local_exec', 'create_task']) {
  if (_extra[_k] && _extra[_k].schema) TOOL_DEFS[_k] = _extra[_k];
}

// P3-2 工具市场扩展（2026-11-06）：tools-market.js 注册 11 个新工具（15 → 26）——
// 8 个纯本地计算（uuid_gen/hash_tool/base64_tool/json_tool/text_count/date_calc/unit_convert/cron_explain）
// + 3 个网络查询（weather_query/translate_text/exchange_rate，前两者支持用户自有 API Key）
// 同时 re-export getUserToolKey（用户级工具 key 读取，路由与测试用）
const _market = require('./tools-market');
for (const _k of ['uuid_gen', 'hash_tool', 'base64_tool', 'json_tool', 'text_count', 'date_calc', 'unit_convert', 'cron_explain', 'weather_query', 'translate_text', 'exchange_rate']) {
  if (_market[_k] && _market[_k].schema) TOOL_DEFS[_k] = _market[_k];
}
const { getUserToolKey } = _market;

// P5.25 工具风险分级（对话权限「默认权限/全自动执行」的判定依据）：
//  - low（默认）：纯读/纯算，执行无副作用——get_datetime/calculator/kb_search/db_query/db_chart/web_search/web_fetch/stock_quote/doc_review
//  - medium：产出外部可见产物或花费 token 较多——image_gen/export_word/tts/子智能体调用 agent_call_*
//  - high：持久化自动执行实体（create_task，P5.31）与 MCP 任意工具（能力不可枚举，可能含写操作/对外发送）——按 mcp_ 前缀整体归 high
// 「默认权限」下 medium/high 执行前需用户确认；「全自动执行」全部放行；low 永不拦截（确认疲劳无意义）。
const TOOL_RISK = {
  low: ['get_datetime', 'calculator', 'kb_search', 'db_query', 'db_chart', 'web_search', 'web_fetch', 'stock_quote', 'doc_review',
    // P3-2 工具市场（2026-11-06）：11 个新工具全部只读无副作用，与 web_search/stock_quote 同级 low
    'uuid_gen', 'hash_tool', 'base64_tool', 'json_tool', 'text_count', 'date_calc', 'unit_convert', 'cron_explain',
    'weather_query', 'translate_text', 'exchange_rate'],
  medium: ['image_gen', 'export_word', 'tts', 'run_code'],
  high: ['create_task', 'browser_use'], // P5.31：定时任务；U1-4：浏览器自动化（高危操作如网页操作需确认）
};
function toolRiskOf(name, ctx = {}) {
  if (name.startsWith('agent_call_') || name.startsWith('local_')) return 'high';
  // P5.32 MCP 细粒度分级（白名单式）：默认整类 high；仅当①执行上下文提供了智能体挂载的 MCP 清单
  // ②对应 server 管理员显式 trusted=1 ③该工具分级结果为 low 时才降为 low——任一不满足保守按 high。
  // 无 ctx（旧调用方/未知来源）与旧缓存（无 risk 字段）均安全回落 high，向后兼容。
  if (name.startsWith('mcp_')) {
    if (ctx.mcpServers) {
      const t = loadMcpTools(ctx.mcpServers).find(x => x.name === name);
      if (t && t.server && t.server.trusted && t.risk === 'low') return 'low';
    }
    return 'high';
  }
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

// P5.34（审查 F1②）：智能体可配置工具白名单——create_task（持久化自动执行实体）与
// local_exec（外设操作）不允许配进智能体（对话链路仅首页助手服务端默认集可用且有确认卡）；
// 前端 studio 工具清单本就不含这两项，此处为 API 直调注入兑底。run_code 允许（沙箱已加固 + medium 确认卡）。
// 违禁集定义在 lib/tool-deny.js（零依赖，db.js 存量清洗也引用）
/** 校验智能体工具清单。返回 null=合法；否则返回错误信息（含违禁工具名） */
function validateAgentTools(toolIds) {
  const bad = (toolIds || []).filter(t => AGENT_TOOL_DENY.has(t) || !TOOL_DEFS[t]);
  if (bad.length) {
    const denied = bad.filter(t => AGENT_TOOL_DENY.has(t));
    if (denied.length) return `工具 ${denied.join('、')} 不允许配置到智能体（持久化任务/本机操作类仅首页助手可用）`;
    return `未知工具：${bad.join('、')}`;
  }
  return null;
}

/** 组装 OpenAI tools 数组：内置工具 + MCP 工具（mcpTools: [{schema}]）+ 子智能体工具（childTools: [{schema}]，agent_call_ 前缀） */
function buildTools(toolIds, mcpTools = [], childTools = []) {
  const builtin = (toolIds || []).filter(id => TOOL_DEFS[id]).map(id => TOOL_DEFS[id].schema);
  return [...builtin, ...mcpTools.map(t => t.schema), ...(childTools || []).map(t => t.schema)];
}

/** 加载智能体挂载的 MCP 服务工具清单（从缓存读，避免每次连接）
 *  P5.34：应用管理员逐工具人工标注（mcp_servers.risk_overrides）——人工值优先于刷新时算好的启发式值 */
function loadMcpTools(agentMcpIds) {
  let ids = [];
  try { ids = JSON.parse(agentMcpIds || '[]'); } catch { }
  if (!ids.length) return [];
  const servers = db.prepare(`SELECT * FROM mcp_servers WHERE status=1`).all().filter(s => ids.includes(s.id));
  const out = [];
  for (const s of servers) {
    let overrides = {};
    try { overrides = JSON.parse(s.risk_overrides || '{}') || {}; } catch { overrides = {}; }
    try {
      const tools = JSON.parse(s.tools_cache || '[]');
      tools.forEach(t => {
        const ov = overrides[t.originalName];
        out.push({ ...t, server: s, risk: ov || t.risk, risk_override: ov || null });
      });
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

module.exports = { TOOL_DEFS, buildTools, runTool, loadMcpTools, toolRiskOf, validateAgentTools, AGENT_TOOL_DENY, getUserToolKey };
