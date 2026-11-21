/**
 * D2-4 MCP 与连接器广场 · 目录内核（2026-11-21）
 *
 * 纯逻辑（零依赖、零 DB）：把「值得接入」的 MCP 服务与异构平台做成一份可浏览的
 * 预设目录（广场），供前端一键展示、一键安装。安装动作（落库/连通/凭证）由
 * routes/mcp.js 负责，本模块只负责目录数据 + 归一化 + 展示态推导，便于单测。
 *
 * 目录条目字段：
 *   id            稳定标识（安装时作为 mcp_servers.catalog_id 落库）
 *   type          'mcp'（MCP 服务，可一键安装）| 'platform'（异构平台，跳转配置）
 *   name          展示名
 *   icon          图标（emoji）
 *   category      分类（见 CATEGORIES）
 *   description   一句话说明
 *   transport     MCP 传输（http | sse）
 *   url           默认端点（本地/官方；可在安装弹窗内修改）
 *   docs          官方文档
 *   tags          标签
 *   credentials   需要的凭据 [{ name, label, required, secret, hint }]（secret 默认 true）
 *   defaultTrusted 安装后是否默认可信（1=其只读工具免确认）
 *   riskNote      风险说明
 */
'use strict';

const CATEGORIES = [
  '文件与终端', '代码与仓库', '数据与存储', '信息检索',
  '记忆与知识', '推理与规划', '协作与通知', '自动化', '异构平台',
];

/** 官方/社区常用 MCP 参考实现 + 异构平台预设（V1 精选） */
const CATALOG = [
  {
    id: 'filesystem', type: 'mcp', name: '文件系统', icon: '📁', category: '文件与终端',
    description: '在受控根目录内读写、检索文件，供智能体访问本地文档与代码。',
    transport: 'http', url: 'http://127.0.0.1:38101/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tags: ['官方', '本地'],
    credentials: [{ name: 'root_dir', label: '根目录（绝对路径）', required: true, secret: false, hint: '如 /Users/you/work，仅此目录内可访问' }],
    defaultTrusted: 0,
    riskNote: '含写类工具（写文件/移动），默认高风险需确认；已信任后只读工具可免确认。',
  },
  {
    id: 'fetch', type: 'mcp', name: '网页抓取 Fetch', icon: '🌐', category: '信息检索',
    description: '抓取网页并转为 Markdown，供智能体读取在线资料。',
    transport: 'http', url: 'http://127.0.0.1:38102/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    tags: ['官方', '只读'],
    credentials: [],
    defaultTrusted: 1,
    riskNote: '只读类工具，信任后对话中免确认；注意内网地址抓取可能触发 SSRF 风险。',
  },
  {
    id: 'git', type: 'mcp', name: 'Git 仓库', icon: '🌿', category: '代码与仓库',
    description: '查看仓库状态、提交历史、差异与文件内容（只读），辅助代码问答。',
    transport: 'http', url: 'http://127.0.0.1:38103/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    tags: ['官方', '只读'],
    credentials: [{ name: 'repo_path', label: '仓库路径', required: true, secret: false, hint: '本地 Git 仓库绝对路径' }],
    defaultTrusted: 1,
    riskNote: '只读类工具；如需提交/推送请用写类工具并保持确认。',
  },
  {
    id: 'sqlite', type: 'mcp', name: 'SQLite 查询', icon: '🗄️', category: '数据与存储',
    description: '对 SQLite 数据库执行 SQL 查询（读/写），供数据分析类智能体使用。',
    transport: 'http', url: 'http://127.0.0.1:38104/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    tags: ['官方', '数据'],
    credentials: [{ name: 'db_path', label: '数据库文件路径', required: true, secret: false, hint: '如 /data/app.db' }],
    defaultTrusted: 0,
    riskNote: '含写类工具（write/insert/update/delete），默认高风险需确认。',
  },
  {
    id: 'memory', type: 'mcp', name: '知识图谱记忆', icon: '🧠', category: '记忆与知识',
    description: '基于知识图谱的长期记忆，存/取实体与关系，增强跨会话记忆。',
    transport: 'http', url: 'http://127.0.0.1:38105/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tags: ['官方'],
    credentials: [],
    defaultTrusted: 0,
    riskNote: '含写类工具（创建/删除实体），默认高风险需确认。',
  },
  {
    id: 'sequential-thinking', type: 'mcp', name: '结构化推理', icon: '🪜', category: '推理与规划',
    description: '引导智能体分步结构化推理，适合复杂问题的拆解与规划。',
    transport: 'http', url: 'http://127.0.0.1:38106/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    tags: ['官方', '推理'],
    credentials: [],
    defaultTrusted: 1,
    riskNote: '纯推理工具，无副作用，可信后免确认。',
  },
  {
    id: 'time', type: 'mcp', name: '时间与时区', icon: '⏰', category: '信息检索',
    description: '获取当前时间与时区换算，补齐模型的时间感知。',
    transport: 'http', url: 'http://127.0.0.1:38107/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    tags: ['官方', '只读'],
    credentials: [],
    defaultTrusted: 1,
    riskNote: '只读工具，无可写副作用。',
  },
  {
    id: 'github', type: 'mcp', name: 'GitHub', icon: '🐙', category: '代码与仓库',
    description: '访问 GitHub 仓库、Issue、Pull Request 与代码搜索（远程官方 MCP 服务）。',
    transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    docs: 'https://github.com/github/github-mcp-server',
    tags: ['远程', '需令牌'],
    credentials: [{ name: 'api_key', label: 'GitHub Personal Access Token', required: true, secret: true, hint: '以 Bearer 头携带；建议最小权限、设置过期' }],
    defaultTrusted: 0,
    riskNote: '含写类工具（创建 Issue/PR、评论），默认高风险需确认，建议最小授权令牌。',
  },
  {
    id: 'postgres', type: 'mcp', name: 'PostgreSQL 只读', icon: '🐘', category: '数据与存储',
    description: '对 PostgreSQL 执行只读查询，用于报表与数据分析。',
    transport: 'http', url: 'http://127.0.0.1:38108/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    tags: ['数据', '只读'],
    credentials: [{ name: 'connection_string', label: '连接串（只读账号）', required: true, secret: true, hint: 'postgres://user:pwd@host:5432/db' }],
    defaultTrusted: 1,
    riskNote: '请务必使用只读数据库账号；含写类工具时按高风险处理。',
  },
  {
    id: 'slack', type: 'mcp', name: 'Slack 通知', icon: '💬', category: '协作与通知',
    description: '向 Slack 频道发送消息、读取频道历史，打通团队协作。',
    transport: 'http', url: 'http://127.0.0.1:38109/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    tags: ['协作', '需令牌'],
    credentials: [{ name: 'api_key', label: 'Slack Bot Token', required: true, secret: true, hint: 'xoxb- 开头的 Bot Token' }],
    defaultTrusted: 0,
    riskNote: '含写类工具（发送消息），默认高风险需确认。',
  },
  {
    id: 'puppeteer', type: 'mcp', name: '浏览器自动化', icon: '🎭', category: '自动化',
    description: '驱动无头浏览器导航、截图、抓取与交互，用于网页自动化任务。',
    transport: 'http', url: 'http://127.0.0.1:38110/mcp',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    tags: ['自动化'],
    credentials: [],
    defaultTrusted: 0,
    riskNote: '可执行页面脚本与提交表单，默认高风险需确认，仅接入可信站点。',
  },
  {
    id: 'coze', type: 'platform', name: '扣子 Coze', icon: '🟣', category: '异构平台',
    description: '纳管扣子（Coze）空间的 Bot：配置个人访问令牌后同步应用清单并转发对话。',
    transport: 'http', url: 'https://api.coze.cn',
    docs: 'https://www.coze.cn/space',
    tags: ['异构', '需令牌'],
    credentials: [{ name: 'api_key', label: '个人访问令牌（PAT）', required: true, secret: true, hint: '用于拉取 Bot 清单与转发对话' }],
    defaultTrusted: 0,
    riskNote: '外部平台调用，注意令牌权限与额度。',
  },
  {
    id: 'dify', type: 'platform', name: 'Dify', icon: '🔷', category: '异构平台',
    description: '纳管 Dify 应用：配置控制台账号或 API Base 后，同步应用并获取 Service API Key。',
    transport: 'http', url: 'https://api.dify.ai/v1',
    docs: 'https://dify.ai/zh',
    tags: ['异构', '自部署可改'],
    credentials: [{ name: 'api_key', label: 'API Key（可选）', required: false, secret: true, hint: '自部署可留空，在接入管理内配置控制台账号' }],
    defaultTrusted: 0,
    riskNote: '外部平台调用，注意端点与凭据归属。',
  },
];

const BY_ID = new Map(CATALOG.map(e => [e.id, e]));

/** 归一化条目（补全缺省字段，前端安全消费） */
function normalize(entry) {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    icon: entry.icon || (entry.type === 'platform' ? '🔌' : '🧩'),
    category: entry.category || '其他',
    description: entry.description || '',
    transport: entry.transport || 'http',
    url: entry.url || '',
    docs: entry.docs || '',
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    credentials: (entry.credentials || []).map(c => ({
      name: c.name, label: c.label || c.name,
      required: !!c.required, secret: c.secret !== false, hint: c.hint || '',
    })),
    defaultTrusted: entry.defaultTrusted ? 1 : 0,
    riskNote: entry.riskNote || '',
  };
}

/** 列出目录（可按 type / category / 关键词过滤） */
function listCatalog({ type, category, q } = {}) {
  let items = CATALOG.map(normalize);
  if (type) items = items.filter(e => e.type === type);
  if (category && category !== '全部') items = items.filter(e => e.category === category);
  if (q) {
    const kw = String(q).toLowerCase();
    items = items.filter(e => (e.name + e.description + e.tags.join('') + e.category).toLowerCase().includes(kw));
  }
  return { items, categories: CATEGORIES.slice() };
}

/** 取条目（归一化）；不存在返回 null */
function getEntry(id) {
  const e = BY_ID.get(String(id || ''));
  return e ? normalize(e) : null;
}

/** 必填凭据名清单 */
function requiredCredentials(entry) {
  return normalize(entry).credentials.filter(c => c.required).map(c => c.name);
}

/** 已安装匹配：按 catalog_id 优先，回落到 URL 相同 */
function matchInstalled(entry, servers) {
  const e = normalize(entry);
  if (!Array.isArray(servers)) return null;
  return servers.find(s => s.catalog_id && s.catalog_id === e.id)
    || servers.find(s => (s.url || '').trim() === e.url.trim())
    || null;
}

/** 健康态（纯函数）：由 server 展示字段推导 */
function healthOf(server) {
  if (!server) return { level: 'unknown', label: '未接入' };
  if (server.status === 0 || server.status === false) return { level: 'down', label: '已停用' };
  if (server.last_error) return { level: 'down', label: '连接异常' };
  if (!server.last_check_at) return { level: 'unknown', label: '未测试' };
  return { level: 'ok', label: '正常' };
}

/** 风险摘要（纯函数）：工具清单 → {total, low, high} */
function riskSummary(tools) {
  const list = Array.isArray(tools) ? tools : [];
  let low = 0;
  for (const t of list) if (t && t.risk === 'low') low++;
  return { total: list.length, low, high: list.length - low };
}

module.exports = {
  CATEGORIES, CATALOG,
  listCatalog, getEntry, requiredCredentials, matchInstalled, healthOf, riskSummary, normalize,
};
