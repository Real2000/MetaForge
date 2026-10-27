/**
 * 本地演示 MCP Server（Streamable HTTP 传输，单文件零依赖）
 * 提供金融场景工具：
 *   - query_exchange_rate：查询货币对汇率（演示数据）
 *   - search_regulation：检索金融监管规则（内置知识）
 * 启动：node mcp-demo-server.js [端口]（默认 9100）
 * 端点：http://127.0.0.1:9100/mcp
 */
const http = require('http');
const crypto = require('crypto');

const PORT = +process.argv[2] || 9100;

// ---- 工具实现 ----
const REGULATIONS = [
  { id: 'R-2023-015', title: '个人金融信息保护', body: '金融机构收集个人金融信息须遵循最小必要原则，不得超出业务需要范围收集；敏感信息处理须取得客户单独同意。' },
  { id: 'R-2023-042', title: '理财适当性管理', body: '销售理财产品须完成客户风险测评，产品风险等级与客户风险承受能力须匹配；R4 及以上产品仅面向合格投资者。' },
  { id: 'R-2024-008', title: '反洗钱客户尽调', body: '自然人客户单笔或当日累计现金交易 5 万元以上须核对身份证件；可疑交易应在确认后 2 个工作日内报送反洗钱监测中心。' },
  { id: 'R-2024-019', title: '互联网贷款风控', body: '互联网贷款授信审批核心环节不得外包；单户消费贷额度上限 20 万元，期限不超过 5 年。' },
  { id: 'R-2025-003', title: '数据跨境传输', body: '向境外提供个人金融信息须通过安全评估、标准合同或认证三条路径之一，并向监管部门报备。' },
];

const TOOLS = [
  {
    name: 'query_exchange_rate',
    description: '查询货币对汇率（如 USD/CNY、EUR/CNY、HKD/CNY），返回买入价/卖出价（演示数据，非实时行情）',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: '基础货币代码，如 USD' },
        quote: { type: 'string', description: '目标货币代码，如 CNY' },
      },
      required: ['base', 'quote'],
    },
  },
  {
    name: 'search_regulation',
    description: '检索金融监管规则库（个人信息保护/理财适当性/反洗钱/互联网贷款/数据跨境），返回规则编号、标题与要点',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '检索关键词，如 反洗钱、理财、数据跨境' },
      },
      required: ['keyword'],
    },
  },
];

const RATES = {
  'USD/CNY': { buy: 7.12, sell: 7.15 },
  'EUR/CNY': { buy: 7.72, sell: 7.76 },
  'HKD/CNY': { buy: 0.91, sell: 0.93 },
  'JPY/CNY': { buy: 0.048, sell: 0.049 },
  'GBP/CNY': { buy: 8.98, sell: 9.03 },
};

function handleToolCall(name, args) {
  if (name === 'query_exchange_rate') {
    const pair = `${(args.base || '').toUpperCase()}/${(args.quote || '').toUpperCase()}`;
    const r = RATES[pair];
    if (!r) return { content: [{ type: 'text', text: `暂无 ${pair} 的汇率数据。支持：${Object.keys(RATES).join('、')}` }] };
    return { content: [{ type: 'text', text: `${pair} 汇率（演示数据）：买入价 ${r.buy} / 卖出价 ${r.sell}` }] };
  }
  if (name === 'search_regulation') {
    const kw = String(args.keyword || '').trim();
    const hits = REGULATIONS.filter(r => (r.title + r.body).includes(kw));
    if (!hits.length) return { content: [{ type: 'text', text: `规则库中未检索到「${kw}」相关内容。可试：反洗钱、理财、个人信息、贷款、数据跨境` }] };
    return { content: [{ type: 'text', text: hits.map(h => `【${h.id}】${h.title}：${h.body}`).join('\n') }] };
  }
  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
}

// ---- JSON-RPC 分发 ----
function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'finance-mcp-demo', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null; // 202
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    try {
      return { jsonrpc: '2.0', id, result: handleToolCall(params.name, params.arguments || {}) };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/mcp')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const resp = dispatch(JSON.parse(body));
        if (!resp) { res.writeHead(202); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-' + crypto.randomBytes(8).toString('hex') });
        res.end(JSON.stringify(resp));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    });
    return;
  }
  // GET → 提示（不做 SSE 流，保持极简）
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('finance-mcp-demo (Streamable HTTP). POST JSON-RPC to /mcp');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mcp-demo] 金融工具 MCP Server 已启动: http://127.0.0.1:${PORT}/mcp`);
  console.log('[mcp-demo] 工具: query_exchange_rate / search_regulation');
});
