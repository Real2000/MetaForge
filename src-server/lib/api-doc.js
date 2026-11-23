/**
 * API 文档自动生成（P5.16）：从画布 Start/End 节点变量 schema 自动提取 API 契约
 *
 * 设计：单一事实源——画布即契约。Start 节点 variables = 请求参数；End/answer 节点 = 响应字段；
 * 类型顺着引用链推断（纯引用 {{#node.var#}} 查上游输出类型：llm 结构化字段 / assign / code 声明 / iteration.count）。
 * 消费方：① GET /api/agents/:id/apidoc 文档页（Swagger 风格前端渲染）
 *          ② MCP tools/list 的 inputSchema（P5.16 起按 Start 变量生成，调用方在客户端直接看到参数表）
 * 用户零手写：画布上改变量 → 文档/MCP schema 即时同步，发布即有。
 */
const { getNodeOutputs } = require('./workflow-schema');
const { OPENAPI_VERSION, API_VERSION } = require('./version');
// BE-B5：路线标签/描述判定折叠版本前缀；全局规范只列 v1（过滤旧 /api 别名）。
const { stripVersion, isLegacyApiPath } = require('./api-version');

/** OpenAPI 类型映射：画布变量类型 → { type, format, hint } */
const TYPE_MAP_OPENAPI = {
  string:  { type: 'string',  hint: '字符串' },
  number:  { type: 'number',  hint: '数字' },
  file:    { type: 'integer', format: 'file-id', hint: '文件 ID（📄 先调 POST /api/files 上传取得）' },
  'array[file]': { type: 'array', items: { type: 'integer', format: 'file-id' }, hint: '文件 ID 数组（多文件）' },
};

/** 解析 workflow JSON（string/对象兼容；V1 旧图防御性忽略——文档只对 V2 生效） */
function parseWf(agent) {
  let wf = agent && agent.workflow;
  if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { return null; } }
  return wf && Array.isArray(wf.nodes) ? wf : null;
}

/** End/answer 模板 → 输出类型推断：纯引用查上游节点输出类型，混合文字 string，默认 string */
function inferOutType(tpl, nodes) {
  const s = String(tpl ?? '').trim();
  const m = /^\{\{\s*#\s*([\w\u4e00-\u9fa5.-]+)\s*#\s*\}\}$/.exec(s); // 整串恰为一个引用
  if (m) {
    const dot = m[1].indexOf('.');
    const nid = m[1].slice(0, dot), varName = m[1].slice(dot + 1);
    const node = nodes.find(n => n.id === nid);
    if (node) {
      const hit = getNodeOutputs(node).find(o => o.name === varName);
      if (hit) {
        if (hit.type === 'number') return { type: 'number', desc: `引用 ${node.data?.title || nid} 的 ${varName}` };
        if (hit.type === 'array') return { type: 'array', desc: `引用 ${node.data?.title || nid} 的 ${varName}（JSON 数组串）` };
        return { type: 'string', desc: `引用 ${node.data?.title || nid} 的 ${varName}` };
      }
    }
    return { type: 'string', desc: `引用 {{#${m[1]}#}}` };
  }
  if (!s) return { type: 'string', desc: '空模板' };
  if (/\{\{/.test(s)) return { type: 'string', desc: '模板拼接（含变量引用）' };
  return { type: 'string', desc: '固定文本' };
}

/**
 * 提取 API 契约（纯函数，可测）
 * @param agent 智能体整行
 * @returns { isCanvas, flowType, input: [{name,type,label,required,default,hint}], output: [{name,type,desc,source}] }
 */
function extractApiContract(agent) {
  const wf = parseWf(agent);
  const isCanvas = !!(wf && (agent.edit_mode === 'canvas' || agent.routing_mode === 'workflow'));
  if (!isCanvas || !wf) {
    // 表单模式：单参数对话式（input 文本 → 模型回复）
    return {
      isCanvas: false,
      input: [{ name: 'input', type: 'string', label: '任务/指令文本', required: true, default: '', hint: '对话式调用：一段完整任务描述' }],
      output: [{ name: 'reply', type: 'string', desc: '模型回复（提示词+知识库检索增强）', source: '对话引擎' }],
    };
  }
  const start = wf.nodes.find(n => n.type === 'start');
  // ---------- 输入参数（Start 节点 variables + input）----------
  const input = [{ name: 'input', type: 'string', label: '任务/用户消息', required: true, default: '', hint: '绑定 {{#start.input#}}——流程主输入' }];
  for (const v of (start?.data?.variables) || []) {
    if (!v.name) continue;
    const t = TYPE_MAP_OPENAPI[v.type] ? v.type : 'string';
    input.push({
      name: String(v.name).slice(0, 40), type: t, label: String(v.label || v.name).slice(0, 60),
      required: !!(v.required && t !== 'file' && t !== 'array[file]'), // 文件变量经上传获取，不作硬性必填
      default: t === 'file' || t === 'array[file]' ? '' : String(v.default ?? ''),
      hint: TYPE_MAP_OPENAPI[t].hint,
    });
  }
  // ---------- 输出字段（answer 直接回复 + End 节点 outputs，类型顺引用链推断）----------
  const output = [];
  for (const n of wf.nodes) {
    if (n.type === 'answer') {
      const inf = inferOutType(n.data?.text, wf.nodes);
      output.push({ name: String(n.data?.title || '直接回复').slice(0, 40), type: inf.type, desc: `${inf.desc}（Chatflow 直接回复，流式输出）`, source: `answer 节点 ${n.id}` });
    }
  }
  for (const n of wf.nodes) {
    if (n.type !== 'end') continue;
    (n.data?.outputs || []).forEach((o, i) => {
      const inf = inferOutType(o.value, wf.nodes);
      output.push({
        name: String(o.variable || (i === 0 ? 'reply' : `out_${i + 1}`)).slice(0, 40),
        type: inf.type, desc: inf.desc + (i === 0 ? '；首个输出为对话回复' : ''),
        source: `end 节点 ${n.id}`,
      });
    });
  }
  if (!output.length) output.push({ name: 'reply', type: 'string', desc: '（未配置 End 输出——运行时回退 start.input）', source: '兜底' });
  return { isCanvas: true, flowType: wf.flow_type === 'chatflow' ? 'chatflow' : 'workflow', input, output };
}

/** MCP tools/list 的 inputSchema（画布按 Start 变量生成；task 为 input 的兼容别名） */
function buildMcpInputSchema(agent) {
  const c = extractApiContract(agent);
  const props = {};
  const required = [];
  for (const p of c.input) {
    const m = TYPE_MAP_OPENAPI[p.type] || TYPE_MAP_OPENAPI.string;
    props[p.name] = p.type === 'array[file]'
      ? { type: 'array', items: { type: 'integer' }, description: `${p.label}——${m.hint}` }
      : { type: m.type, ...(m.format ? { format: m.format } : {}), description: `${p.label}——${m.hint}` };
    if (p.required) required.push(p.name);
  }
  props.task = { type: 'string', description: 'input 的兼容别名（同义传入任务文本即可）' };
  if (!required.includes('input')) required.push('input');
  return { type: 'object', properties: props, required };
}

/** OpenAPI 3.0 文档对象（标准 Swagger 风格；MCP 通道 + OpenAI 兼容通道） */
function buildOpenApi(agent, host) {
  const c = extractApiContract(agent);
  const base = `http://${host}`;
  const inputProps = {}, inputRequired = [];
  for (const p of c.input) {
    const m = TYPE_MAP_OPENAPI[p.type] || TYPE_MAP_OPENAPI.string;
    inputProps[p.name] = p.type === 'array[file]'
      ? { type: 'array', items: { type: 'integer', format: 'file-id' }, description: p.hint }
      : { type: m.type, ...(m.format ? { format: m.format } : {}), description: `${p.label}——${p.hint}` };
    if (p.required) inputRequired.push(p.name);
  }
  const outputProps = {};
  for (const o of c.output) outputProps[o.name] = { type: o.type, description: `${o.desc}（${o.source}）` };
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: `智能体 API：${agent.name}`,
      description: (agent.description || '专业智能体') + (c.isCanvas ? `\n\n画布工作流（${c.flowType === 'chatflow' ? 'Chatflow 多轮对话式' : 'Workflow 一次性执行'}）——参数与输出由 Start/End 节点自动生成。` : '\n\n表单模式（提示词+知识库检索增强）。'),
      version: '1.0.0',
    },
    servers: [{ url: base }],
    paths: {
      '/mcp': {
        post: {
          summary: `MCP 调用：${agent.name}（tools/call agent_${agent.id}）`,
          description: 'Streamable HTTP + JSON-RPC 2.0；Bearer MCP 令牌鉴权（管理端「MCP 服务」页生成）。先 initialize 握手，再 tools/call。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jsonrpc: { type: 'string', enum: ['2.0'] },
                    id: { type: 'integer' },
                    method: { type: 'string', enum: ['tools/call'] },
                    params: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', enum: [`agent_${agent.id}`] },
                        arguments: { $ref: '#/components/schemas/AgentInput' },
                      },
                      required: ['name', 'arguments'],
                    },
                  },
                  required: ['jsonrpc', 'method', 'params'],
                },
                example: buildMcpCallExample(agent),
              },
            },
          },
          responses: { '200': { description: 'JSON-RPC 响应（content[0].text 为智能体输出）' } },
        },
      },
      '/openapi/v1/chat/completions': {
        post: {
          summary: `OpenAI 兼容调用：${agent.name}`,
          description: 'model 填 `agent-${agent.id}-${agent.name}`；Bearer sk-ap-xxx 密钥鉴权（管理端「API」创建）。该通道为对话式（仅传 input 文本，不支持结构化变量——完整参数请用 MCP 通道）。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    model: { type: 'string', enum: [`agent-${agent.id}-${agent.name}`] },
                    messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string', description: '任务文本（→ input）' } } } },
                    stream: { type: 'boolean', description: 'SSE 流式（默认 false）' },
                  },
                  required: ['model', 'messages'],
                },
              },
            },
          },
          responses: { '200': { description: 'OpenAI 兼容响应' } },
        },
      },
    },
    components: {
      schemas: {
        AgentInput: { type: 'object', properties: inputProps, required: inputRequired },
        AgentOutput: { type: 'object', properties: outputProps },
      },
    },
  };
}

/** MCP tools/call curl 示例（参数按 Start 变量预填，可直接复制调试） */
function buildMcpCallExample(agent) {
  const c = extractApiContract(agent);
  const args = {};
  for (const p of c.input) {
    if (p.type === 'file') args[p.name] = 0;
    else if (p.type === 'array[file]') args[p.name] = [];
    else if (p.type === 'number') args[p.name] = Number(p.default) || 0;
    else args[p.name] = p.default || `（${p.label}）`;
  }
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `agent_${agent.id}`, arguments: args } };
}

/** 文档页数据（GET /api/agents/:id/apidoc）：契约 + 双通道信息 + 示例 + OpenAPI JSON */
function buildApiDoc(agent, host) {
  const c = extractApiContract(agent);
  const mcpExample = buildMcpCallExample(agent);
  const openaiBody = {
    model: `agent-${agent.id}-${agent.name}`,
    messages: [{ role: 'user', content: '（任务文本）' }],
  };
  return {
    agent: { id: agent.id, name: agent.name, description: agent.description || '', status: agent.status, edit_mode: agent.edit_mode },
    contract: c,
    channels: [
      {
        key: 'mcp', name: 'MCP 通道（推荐·完整参数）',
        endpoint: `http://${host}/mcp`,
        protocol: 'Streamable HTTP + JSON-RPC 2.0',
        auth: 'Authorization: Bearer <MCP 令牌>（管理端「MCP 服务」页生成）',
        tool: `agent_${agent.id}`,
        steps: [
          `initialize（协议握手）`,
          `tools/list（查看工具清单与参数 schema）`,
          `tools/call：name=agent_${agent.id}，arguments 按 AgentInput 填写`,
        ],
        example: mcpExample,
        curl: `curl -X POST http://${host}/mcp \\\n  -H "Authorization: Bearer <MCP令牌>" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(mcpExample)}'`,
      },
      {
        key: 'openai', name: 'OpenAI 兼容通道（对话式）',
        endpoint: `http://${host}/openapi/v1/chat/completions`,
        protocol: 'OpenAI Chat Completions',
        auth: 'Authorization: Bearer sk-ap-xxx（管理端「API」创建密钥）',
        model: `agent-${agent.id}-${agent.name}`,
        note: '仅传 input 文本（messages 最后一条 user 消息）；结构化变量（含文件）请走 MCP 通道。',
        example: openaiBody,
        curl: `curl -X POST http://${host}/openapi/v1/chat/completions \\\n  -H "Authorization: Bearer sk-ap-xxx" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(openaiBody)}'`,
      },
    ],
    fileUpload: c.input.some(p => p.type === 'file' || p.type === 'array[file]')
      ? { endpoint: `POST http://${host}/api/files`, body: '{ "name": "合同.pdf", "file_b64": "…", "source": "manual" }', returns: 'data.id（填入文件参数）', auth: '登录 Token / MCP 通道调用方由平台用户代传' }
      : null,
    openapi: buildOpenApi(agent, host),
  };
}

/* ================================================================
 * 全站 OpenAPI 3.1 契约（BE-B4 / M2 批次3，2026-11-22）
 *
 * 由 Express 运行时路由表自动采集（collectRoutes）——替代早前硬编码的
 * ROUTE_MAP：spec 天然覆盖全部已注册路由，新增/删除路由零维护自动同步。
 * 方法级 operation 补 tags / summary / path 参数 / 标准错误码；开放端点
 * /openapi/* 叠加手写的富定义（请求体、示例、细分错误码）。
 * ================================================================ */

/** 路由前缀 → 分组标签（tag）：/api|/openapi 取第二段，其余取首段（BE-B5：折叠 /api/v1 版本前缀） */
function tagFor(p) {
  const segs = String(stripVersion(p)).replace(/^\//, '').split('/');
  if ((segs[0] === 'api' || segs[0] === 'openapi') && segs[1]) return segs[1];
  return segs[0] || 'root';
}

/** 路由前缀 → 中文描述（仅用于 summary 富化，非路由存在性来源） */
const ROUTE_DESC = {
  '/api/auth': '认证接口：登录/登出/刷新 Token',
  '/api/agents': '智能体管理：CRUD、版本管理、发布审核',
  '/api/memories': '记忆管理：会话记忆的查看/合并/删除/导出',
  '/api/channel': '渠道适配：IM 渠道状态/入站出站/消息审计',
  '/api/sandbox': '沙箱执行：代码执行/远程主机/运行审计/HITL 审批',
  '/api/chat': '对话接口：SSE 流式对话、消息历史、审批流',
  '/api/knowledge': '知识库管理：库/文件/分块/召回测试/评测集',
  '/api/tasks': '定时任务管理：CRUD 及调度启停',
  '/api/providers': 'LLM 模型供应商配置',
  '/api/platforms': '外部平台管理（Dify、Coze 等）',
  '/api/security': '安全配置：IP 白名单/登录锁定/审计事件',
  '/api/monitor': '系统监控：操作日志/错误日志',
  '/api/stats': '数据统计：对话/智能体/用量维度的总数统计',
  '/openapi': 'OpenAI 兼容开放接口（对外商用契约）',
  '/api/share': '分享会话接口',
  '/api/departments': '组织架构：部门树管理',
  '/api/dingtalk': '钉钉集成回调（验签/解压/组织同步）',
  '/api/files': '工作流文件管理',
  '/api/doc': '文档预览（受控原文流+权限校验）',
  '/api/config': '配置管理（运行时配置查看/更新）',
  '/api/secrets': '密钥管理（画布 env.XXX 占位符运行注入）',
  '/api/mcp': 'MCP 服务管理',
  '/api/templates': '工作流模板库',
  '/api/notify': '通知中心（系统公告消息）',
  '/api/quota': '用量与配额管理',
  '/api/usermodels': '用户自有模型源',
  '/api/tool-keys': '用户级工具 API Key',
  '/api/skillassets': '技能资产管理',
  '/api/skills-market': '技能/模板市场',
  '/api/edition': '版本/License 管理',
  '/api/users': '用户管理（CRUD）',
  '/api/tenants': '多租户管理：租户开通/停用/概览',
  '/api/platform-admin': '平台超管运维台',
  '/api/billing': '计费用量：预检/预留/结算/对账',
  '/api/payment': '支付与订阅：下单/回调/套餐',
  '/api/feedback': '意见反馈',
  '/api/a2a': 'A2A 智能体互操作（Agent-to-Agent）',
};

/** 取某完整路径最长匹配前缀的描述（BE-B5：折叠 /api/v1 版本前缀） */
function descFor(p) {
  const p0 = stripVersion(p);
  let best = '';
  for (const k of Object.keys(ROUTE_DESC)) {
    if ((p0 === k || p0.startsWith(k + '/')) && k.length > best.length) best = k;
  }
  return best ? ROUTE_DESC[best] : '';
}

/** 路由路径 → OpenAPI 路径：`:id` → `{id}` */
function toOapiPath(p) {
  return String(p).replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*([A-Za-z0-9_]*)/g, '{wildcard}');
}

/** 从路由路径提取 path 参数 */
function pathParams(p) {
  const out = [];
  const re = /:([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(p))) out.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  if (/\*/.test(p)) out.push({ name: 'wildcard', in: 'path', required: true, schema: { type: 'string' } });
  return out;
}

/** 标准响应集（BE-B1 后错误一律以对应 HTTP 状态码返回，故此处列真实错误码） */
function defaultResponses(hasPathParam) {
  const r = {
    200: { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiResponse' } } } },
    400: { description: '请求参数错误 / 业务校验失败' },
    401: { description: '未认证（缺少或无效凭据）' },
    403: { description: '无权限 / 租户或作用域拒绝' },
    500: { description: '服务端错误' },
  };
  if (hasPathParam) r[404] = { description: '资源不存在' };
  return r;
}

/** 拼接挂载前缀与子路径，规范化斜杠 */
function joinSeg(prefix, seg) {
  const p = (prefix || '').replace(/\/+$/, '');
  let s = String(seg == null ? '' : seg);
  if (!s.startsWith('/')) s = '/' + s;
  let full = (p + s).replace(/\/{2,}/g, '/');
  if (full.length > 1) full = full.replace(/\/+$/, '');
  return full || '/';
}

/** 从 Express 层 regexp 还原挂载路径（如 `^\/api\/auth\/?(?=\/|$)` → `/api/auth`） */
function mountPathOf(layer) {
  const src = (layer.regexp && layer.regexp.source) || '';
  if (/^\^\\\/\?\(\?=\\\/\|\$\)$/.test(src)) return ''; // 根挂载
  const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

/**
 * 运行时采集 Express 全部已注册路由（含多级 router 嵌套）。
 * @returns [{ path, method }]  method 为小写
 */
function collectRoutes(app) {
  const out = [];
  const root = app && (app._router || app.router);
  const stack = root && root.stack;
  if (Array.isArray(stack)) walk(stack, '');
  return out;
  function walk(layers, prefix) {
    for (const layer of layers) {
      if (layer.route) {
        const rp = layer.route.path;
        const methods = Object.keys(layer.route.methods || {}).filter(k => layer.route.methods[k]);
        const ps = Array.isArray(rp) ? rp : [rp];
        for (const p of ps) for (const m of methods) if (p) out.push({ path: joinSeg(prefix, p), method: m.toLowerCase() });
      } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, joinSeg(prefix, mountPathOf(layer)));
      }
    }
  }
}

function operationFor(route) {
  const params = pathParams(route.path);
  const desc = descFor(route.path);
  const op = {
    tags: [tagFor(route.path)],
    summary: desc || `${route.method.toUpperCase()} ${route.path}`,
    responses: defaultResponses(params.length > 0),
  };
  if (params.length) op.parameters = params;
  return op;
}

/** 开放端点 /openapi/* 富定义（SDK 对接正式契约；自动采集后叠加覆盖） */
function openApiSdkPaths() {
  const json = (obj) => ({ 'application/json': { schema: obj } });
  return {
    '/openapi/openapi.json': {
      get: {
        summary: '本服务 OpenAPI 3.1 规范（本文档数据源）',
        tags: ['openapi'],
        responses: { 200: { description: 'OpenAPI 3.1 JSON', content: json({ type: 'object' }) } },
      },
    },
    '/openapi/v1/models': {
      get: {
        summary: '列出可用智能体（model id = agent-<id>-<名称>）',
        tags: ['openapi'],
        description: 'SDK：`ap.listModels()`。鉴权 Bearer sk-ap-xxx；绑定 agent_id 的密钥仅见绑定智能体。',
        security: [{ apiKeyAuth: [] }],
        responses: {
          200: { description: 'OpenAI models 格式', content: json({ type: 'object', properties: { object: { type: 'string' }, data: { type: 'array', items: { $ref: '#/components/schemas/AgentModel' } } } }) },
          401: { description: '密钥无效或已停用' },
          429: { description: '频率限制（每 Key 60 次/分钟）或日/月配额超限' },
        },
      },
    },
    '/openapi/v1/chat/completions': {
      post: {
        summary: '对话补全（OpenAI 兼容；SDK 主入口）',
        tags: ['openapi'],
        description: 'SDK：`new AgentPlatform({baseUrl, apiKey}).chat.completions.create({model, messages})`。model 形如 agent-<id>-<名称>；messages 取最后一条 user 作为输入；支持 stream（SSE）。',
        security: [{ apiKeyAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string', example: 'agent-1-智能体名称' }, messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } } } }, stream: { type: 'boolean' } } } } } },
        responses: {
          200: { description: 'ChatCompletion 或 SSE 流', content: json({ $ref: '#/components/schemas/ChatCompletion' }) },
          400: { description: '消息为空 / 输入含违规词汇被拦截' },
          401: { description: '密钥无效或已停用' },
          403: { description: '密钥作用域不含目标智能体（key_scope_denied）' },
          404: { description: 'model 不存在或未发布（model_not_found）' },
          429: { description: '频率限制（每 Key 20 次/分钟）或日/月配额超限' },
        },
      },
    },
  };
}

/** 全站 OpenAPI 组件（安全方案 + 通用 Schema） */
function globalComponents() {
  return {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' },
      apiKeyAuth: { type: 'http', scheme: 'bearer', description: '智能体 API 密钥（sk-ap-xxx，agent_api_keys 表；后台「智能体管理→API」创建）——开放端点 /openapi/* 与 SDK 使用' },
    },
    schemas: {
      ApiResponse: {
        type: 'object',
        properties: {
          code: { type: 'integer', description: '0=成功，非 0=业务错误码（错误时 HTTP 状态码同步为对应 4xx/5xx）' },
          msg: { type: 'string', description: '错误信息' },
          data: { type: 'object', description: '响应数据' },
        },
      },
      AgentModel: { type: 'object', properties: { id: { type: 'string', example: 'agent-1-智能体名称' }, object: { type: 'string', example: 'model' }, owned_by: { type: 'string', example: 'agent-platform' }, description: { type: 'string' } } },
      ChatCompletion: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'chatcmpl-ap-1700000000' },
          object: { type: 'string', example: 'chat.completion' },
          created: { type: 'integer' }, model: { type: 'string' },
          choices: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, message: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } }, finish_reason: { type: 'string' } } } },
          usage: { type: 'object', properties: { prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, total_tokens: { type: 'integer' } } },
        },
      },
      Pagination: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' } } },
    },
  };
}

/**
 * 构建全站 OpenAPI 3.1 规范（自动采集 + 富定义叠加）。
 * @param app Express 应用实例
 * @param opts { title, version, description, extra }
 */
function buildGlobalOpenApi(app, opts = {}) {
  const routes = collectRoutes(app);
  const paths = {};
  for (const r of routes) {
    // BE-B5：规范只列 v1——跳过旧 /api/* 双挂载别名（保留 /api/v1/* 与非 /api 对外开放契约）。
    if (isLegacyApiPath(r.path)) continue;
    const op = toOapiPath(r.path);
    if (!paths[op]) paths[op] = {};
    if (!paths[op][r.method]) paths[op][r.method] = operationFor(r);
  }
  // 叠加开放端点富定义（即使未被采集亦保留，保证 SDK 契约稳定）
  for (const [p, methods] of Object.entries(openApiSdkPaths())) {
    if (!paths[p]) paths[p] = {};
    Object.assign(paths[p], methods);
  }
  const tags = [...new Set(Object.values(paths).flatMap(m => Object.values(m).flatMap(o => o.tags || [])))].sort();
  const spec = {
    openapi: OPENAPI_VERSION,
    info: {
      title: opts.title || '智能体开发平台 API',
      version: opts.version || API_VERSION,
      description: opts.description || ('企业级智能体开发平台 REST API。本文档由服务端在运行时自动采集 Express 路由表生成，覆盖全部已注册路由。\n\n' +
        '认证：HttpOnly Cookie（推荐）或 Bearer Token（JWT）；开放端点 /openapi/* 用智能体 API 密钥（sk-ap-xxx）。\n' +
        '响应：统一 `{ code: 0, data }` 包裹，code !== 0 时 HTTP 状态码同步为对应 4xx/5xx（BE-B1 统一响应契约）。'),
      contact: { url: 'https://github.com/Real2000/MetaForge' },
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: '/', description: '当前部署服务' }],
    tags: tags.map(t => ({ name: t })),
    paths,
    components: globalComponents(),
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  };
  if (opts.extra) Object.assign(spec, opts.extra);
  return spec;
}

module.exports = { extractApiContract, buildMcpInputSchema, buildApiDoc, buildOpenApi, buildMcpCallExample, inferOutType, collectRoutes, buildGlobalOpenApi, openApiSdkPaths };
