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
    openapi: '3.0.3',
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

module.exports = { extractApiContract, buildMcpInputSchema, buildApiDoc, buildOpenApi, buildMcpCallExample, inferOutType };
