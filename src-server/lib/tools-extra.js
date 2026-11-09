/**
 * 扩展工具集（2026-10-22 P3，飞书教程库对标 7 方向中的工具类六件）：
 * ① db_query  Text2SQL（自然语言查平台业务库，只读白名单校验，Markdown 表格返回）
 * ① db_chart  图表生成（ECharts 配置落盘 HTML，[CHART:url|标题] 卡片）
 * ③ web_search 联网搜索（Tavily 可选 → Bing 中国 → DuckDuckGo → 百度 四级兜底）
 * ③ web_fetch 网页正文抓取（jina reader 优先 → 直抓降级）
 * ⑥ export_word Markdown 转 Word（docx 包，[WORD:url|文件名] 下载卡片）
 * ② tts       语音合成（msedge-tts 微软接口，[AUDIO:url] 播放卡片）
 * ④ doc_review 知识库文档评审（合同/标书/通用三模板，报告 + Word 导出）
 * 由 tools.js 在加载时 Object.assign 合并进 TOOL_DEFS。
 * ctx: { kbId, mcpServers }（runTool 透传）
 */
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const { chatOnce } = require('./llm');
const { check } = require('./security'); // P5.33：create_task 任务指令敏感词校验

/* ---------------- 公共工具函数 ---------------- */
const UPLOADS = path.join(__dirname, '..', '..', 'public', 'uploads');
function ensureUploads(sub) {
  const dir = path.join(UPLOADS, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------------- P5.33 审查修复（F2）：SSRF 防护 ----------------
 * web_fetch 此前仅校验 http(s) 前缀——私网/环回/链路本地/云元数据地址全部可达，且被 P5.31 引入
 * 无人值守执行链（系统任务智能体默认工具）放大。三层防护：
 *  ① 字面量 IP / DNS 解析后 IP 黑名单（私网、环回、链路本地 169.254、保留段、IPv6 本地）
 *  ② 重定向手动逐跳校验（防 302 跳入内网，上限 3 跳）
 *  ③ jina reader 前置校验（防内网目标地址外泄给第三方代理）
 * 内网知识源场景由管理员设 AGENT_FETCH_ALLOW_PRIVATE=1 显式放行 */
const dns = require('dns');
const FETCH_ALLOW_PRIVATE = process.env.AGENT_FETCH_ALLOW_PRIVATE === '1';
function ipIsPrivate(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return true;
  const [a, b] = parts;
  return a === 127 || a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || a >= 224; // 224+ 组播/保留段
}
async function assertPublicHttpUrl(rawUrl) {
  if (!/^https?:\/\//i.test(rawUrl)) throw new Error('仅支持 http(s) 完整链接');
  if (FETCH_ALLOW_PRIVATE) return; // 管理员显式放行（内网知识源场景）
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('链接格式非法'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? [host]
    : (await dns.promises.lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (!ips.length) throw new Error(`域名解析失败：${host}`);
  for (const ip of ips) {
    if (ipIsPrivate(ip)) throw new Error(`安全策略拒绝访问内网/本机地址（${host} → ${ip}）。如需抓取内网知识源，请管理员设置环境变量 AGENT_FETCH_ALLOW_PRIVATE=1 后重启服务`);
  }
}
/** 手动逐跳重定向（每跳重新过私网校验；上限 3 跳） */
async function fetchWithRedirectGuard(url, opts = {}, maxHops = 3) {
  let cur = url;
  for (let i = 0; i <= maxHops; i++) {
    await assertPublicHttpUrl(cur);
    const res = await fetch(cur, { ...opts, redirect: 'manual', signal: opts.signal || AbortSignal.timeout(15000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      cur = new URL(loc, cur).toString();
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多（>3）');
}

/* =============== ① db_query：Text2SQL =============== */
/** 敏感表黑名单：含凭据/密钥/鉴权信息的表不允许 LLM 生成 SQL 访问
 *  P0-2 加固（2026-11-09）补漏 4 张：platforms（Dify/Coze token 与控制台口令——凭据类）、
 *  feedbacks（实际表名 feedbacks；原误写 feedback 从未命中）、user_tool_keys（用户级工具 API Key，
 *  与 user_providers 同类）、sqlite_master（sqlite_schema 的孪生视图，原只列了后者） */
const DB_DENY_TABLES = new Set([
  'users', 'providers', 'user_providers', 'user_tool_keys', 'agent_api_keys', 'share_sessions',
  'secrets', 'platforms', 'feedbacks', 'sqlite_master',
  'sqlite_sequence', 'sqlite_stat1', 'sqlite_schema',
  // P5.33 审查修复（F7）：消息/会话/审计类表拒绝 LLM 生成 SQL 横读（对话内容/任务产出/操作日志含
  // 全体用户数据；api 层已修 IDOR，SQL 层不可再开面）
  'messages', 'sessions', 'task_runs', 'chat_traces', 'op_logs', 'err_logs', 'agent_memories',
  'notifications', 'feedback', 'enterprise_leads', 'localbridge_devices', 'localbridge_tasks',
  'mcp_tokens', 'wf_files', 'words', 'word_categories',
]);

/** SELECT 语句安全校验：单条、只读、无危险关键词、表黑名单、强制 LIMIT
 *  P0-2 加固（2026-11-09）：表引用提取在归一副本上进行——原正则 \b(?:from|join)\s+([\w]+) 对
 *  SQLite 接受的全部标识符引用形态均提取失败，敏感表黑名单可被直接旁路：
 *    FROM "secrets"（双引号）/ FROM `secrets`（反引号，MySQL 兼容）/ FROM [secrets]（方括号，MSSQL 兼容）/
 *    FROM main.secrets（默认库名前缀）/ FROM"secrets"（关键字与标识符间无空格——SQLite 词法宽松）
 *  归一方式：引用符（" ` [）替换为空格 + 剥离 main. 前缀，只在归一副本上做引用提取与关键词检查
 *  （执行的仍是清洗后的原句；归一只会让分析看到"更多"引用，不会更少——安全方向）。 */
function sanitizeSelectSql(raw) {
  let sql = String(raw || '').trim()
    .replace(/^```(sql)?\s*/i, '').replace(/```\s*$/i, '')
    .replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();
  if (!sql) return { err: 'SQL 为空' };
  if (/;/.test(sql)) return { err: '仅支持单条查询语句（禁止分号拼接多条语句）' };
  if (!/^(select|with)\b/i.test(sql)) return { err: '仅允许 SELECT / WITH 只读查询' };
  // P0-2 加固：pragma_ 前缀捕获 pragma_table_info 等 SQLite 表值函数（\bpragma\b 因后跟 _ 无词边界
  // 原正则漏过——schema 探测面，与 sqlite_master 同类收口）
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|pragma|pragma_[a-z_]*|grant|revoke|replace\s+into|load_extension|readfile|writefile|fts3|fts4|fts5)\b/i.test(sql)) {
    return { err: '检测到写操作或危险关键词，已拒绝执行' };
  }
  // P0-2 加固：归一副本上提取表引用（覆盖引用符 / 库名前缀 / 无空格三组旁路向量；
  // 提取正则的 (?:前缀.)? 同样兼容归一后 'main . users' 的点号两侧空格形态）
  const norm = sql.replace(/[`"\[]/g, ' ').replace(/\bmain\s*\.\s*/gi, ' ');
  const refs = [...norm.matchAll(/\b(?:from|join)\s+(?:[a-zA-Z_][\w]*\s*\.\s*)?([a-zA-Z_][\w]*)/gi)].map(m => m[1].toLowerCase());
  for (const t of refs) {
    if (DB_DENY_TABLES.has(t)) return { err: `不允许访问敏感表：${t}` };
  }
  const lm = /\blimit\s+(\d+)\s*(offset\s+\d+)?\s*$/i.exec(sql);
  if (lm) {
    if (+lm[1] > 500) sql = sql.slice(0, lm.index) + 'LIMIT 500' + (lm[2] ? ' ' + lm[2] : '');
  } else {
    sql += ' LIMIT 200';
  }
  return { sql };
}
function dbCell(v) {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 80); } catch { return String(v); } }
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}
function mdEscapeCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

const db_query = {
  schema: {
    type: 'function',
    function: {
      name: 'db_query',
      description: 'Text2SQL：把自然语言数据问题转成 SQL，查询平台自身业务库（智能体/会话/消息/知识库/任务/反馈等统计）。仅支持只读 SELECT。返回 Markdown 表格。若用户需要图表，可接着用 db_chart 工具把查询结果画成图。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '数据问题，如「最近 30 天每天新增多少会话」「智能体按状态分布统计」' },
        },
        required: ['question'],
      },
    },
  },
  run: async (args) => {
    const question = String(args.question || '').trim();
    if (!question) return '缺少 question 参数';
    // 1. 读取库 schema（排除敏感表），供 LLM 生成 SQL
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()
      .map(r => r.name).filter(t => !DB_DENY_TABLES.has(t));
    const schemaParts = [];
    for (const t of tables) {
      try {
        const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
          .map(c => `${c.name} ${c.type || 'TEXT'}${c.pk ? ' PK' : ''}`);
        schemaParts.push(`${t}(${cols.join(', ')})`);
      } catch { }
    }
    // 2. LLM 生成 SQL（低温、只输出 SQL）
    let r;
    try {
      r = await chatOnce([
        { role: 'system', content: '你是 SQLite SQL 专家。只输出一条 SQL 语句本身，不要解释、不要 markdown 代码块、不要分号外的任何文字。' },
        {
          role: 'user', content: `数据库表结构如下：\n${schemaParts.join('\n')}\n\n用户问题：${question}\n\n要求：\n- SQLite 方言，只读 SELECT（可用 WITH/COUNT/SUM/AVG/GROUP BY）\n- 时间列均为 TEXT 'YYYY-MM-DD HH:MM:SS' 格式，比较时用 datetime() 或字符串截断\n- 常用时间函数参考：datetime('now','localtime','-30 days')；日期分组用 substr(created_at,1,10)\n- 结果加合理 LIMIT（≤200）`,
        },
      ], { temperature: 0.1, max_reply: 600 });
    } catch (e) {
      return 'SQL 生成失败：' + e.message;
    }
    const check = sanitizeSelectSql(r.full);
    if (check.err) return `生成的 SQL 未通过安全校验（${check.err}）。请换一种问法，或直接用 calculator/get_datetime 等工具。`;
    // 3. 执行并格式化为 Markdown 表格
    try {
      const stmt = db.prepare(check.sql);
      const cols = stmt.columns().map(c => c.name);
      const rows = stmt.all();
      if (!rows.length) return `查询执行成功，但结果为空（0 行）。\n\n执行的 SQL：\n${check.sql}`;
      const show = rows.slice(0, 50);
      const head = `| ${cols.map(c => mdEscapeCell(c)).join(' | ')} |`;
      const sep = `| ${cols.map(() => '---').join(' | ')} |`;
      const body = show.map(row => `| ${cols.map(c => mdEscapeCell(dbCell(row[c]))).join(' | ')} |`).join('\n');
      let out = `查询成功，共 ${rows.length} 行${rows.length > 50 ? `（仅展示前 50 行）` : ''}。\n\n${head}\n${sep}\n${body}\n\n执行的 SQL：\n\`\`\`sql\n${check.sql}\n\`\`\``;
      if (rows.length && rows.length <= 200) out += `\n\n如需直观展示，可调用 db_chart 工具把以上数据绘制为图表。`;
      return out;
    } catch (e) {
      return `SQL 执行失败：${e.message}\n\n生成的 SQL：${check.sql}`;
    }
  },
};

/* =============== ① db_chart：ECharts 图表卡片 =============== */
function buildChartOption(type, title, cats, series, xName, yName) {
  if (type === 'pie') {
    const s0 = series[0] || { name: title, data: [] };
    return {
      title: { text: title, left: 'center', top: 10, textStyle: { fontSize: 16 } },
      tooltip: { trigger: 'item', formatter: '{b}: {c}（{d}%）' },
      legend: { orient: 'vertical', left: 10, top: 'middle', type: 'scroll' },
      series: [{
        name: s0.name || title, type: 'pie', radius: ['32%', '62%'], center: ['55%', '55%'],
        data: cats.map((c, i) => ({ name: String(c), value: s0.data[i] ?? 0 })),
        label: { formatter: '{b}\n{d}%' },
      }],
    };
  }
  return {
    title: { text: title, left: 'center', top: 10, textStyle: { fontSize: 16 } },
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { top: 36 } : undefined,
    grid: { left: 56, right: 30, bottom: 60, top: 80 },
    xAxis: { type: 'category', data: cats, name: xName || '', nameLocation: 'end', axisLabel: { rotate: cats.length > 6 ? 30 : 0 } },
    yAxis: { type: 'value', name: yName || '' },
    series: series.map(s => ({
      name: s.name, type, data: s.data, smooth: type === 'line',
      itemStyle: type === 'bar' ? { borderRadius: [4, 4, 0, 0] } : undefined,
    })),
  };
}

const db_chart = {
  schema: {
    type: 'function',
    function: {
      name: 'db_chart',
      description: '把结构化数据绘制为图表卡片（柱状图/折线图/饼图），在对话中内嵌展示。先用 db_query 查询得到数据后调用本工具。数据由你直接以数组参数传入。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '图表标题，如「最近 30 天每日新增会话」' },
          chart_type: { type: 'string', enum: ['bar', 'line', 'pie'], description: '图表类型：bar 柱状 / line 折线 / pie 饼图' },
          categories: { type: 'array', items: { type: 'string' }, description: '类目轴数据（x 轴或饼图各项名称），如 ["10-01","10-02"]' },
          series: {
            type: 'array', description: '数据系列，每项含名称与数值数组（pie 取第一个系列）',
            items: {
              type: 'object', properties: {
                name: { type: 'string', description: '系列名称，如「新增会话数」' },
                data: { type: 'array', items: { type: 'number' }, description: '与 categories 等长的数值数组' },
              }, required: ['name', 'data'],
            },
          },
          x_name: { type: 'string', description: 'x 轴名称（可选）' },
          y_name: { type: 'string', description: 'y 轴名称（可选）' },
        },
        required: ['title', 'chart_type', 'categories', 'series'],
      },
    },
  },
  run: async (args) => {
    const title = String(args.title || '图表').replace(/[\|\[\]`\n]/g, ' ').trim().slice(0, 60) || '图表';
    const type = ['bar', 'line', 'pie'].includes(args.chart_type) ? args.chart_type : 'bar';
    const cats = (Array.isArray(args.categories) ? args.categories : []).map(c => String(c)).slice(0, 120);
    let series = (Array.isArray(args.series) ? args.series : [])
      .map(s => ({
        name: String((s && s.name) || '系列'),
        data: (Array.isArray(s && s.data) ? s.data : []).map(v => Number(v) || 0),
      }))
      .filter(s => s.data.length)
      .slice(0, 6);
    if (!cats.length || !series.length) return '参数不完整：需要 categories（类目数组）和至少一个 series（含 name/data）';
    // 对齐长度：以最短为准截断，避免错位
    const len = Math.min(cats.length, ...series.map(s => s.data.length));
    const catsF = cats.slice(0, len);
    series = series.map(s => ({ name: s.name, data: s.data.slice(0, len) }));
    const option = buildChartOption(type, title, catsF, series, args.x_name, args.y_name);
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&"]/g, '')}</title>
<script src="/vendor/echarts.min.js"></script>
<style>html,body{margin:0;padding:0;height:100%;background:#fff;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}#c{width:100%;height:100%;min-height:300px}</style>
</head><body><div id="c"></div>
<script>
var opt = ${JSON.stringify(option).replace(/</g, '\\u003c')};
var chart = echarts.init(document.getElementById('c'));
chart.setOption(opt);
window.addEventListener('resize', function () { chart.resize(); });
</script></body></html>`;
    try {
      const dir = ensureUploads('charts');
      const fname = `chart-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`;
      fs.writeFileSync(path.join(dir, fname), html);
      return `图表「${title}」已生成（${type === 'pie' ? '饼图' : type === 'line' ? '折线图' : '柱状图'}，${len} 个类目，${series.length} 个系列）：\n\n[CHART:/uploads/charts/${fname}|${title}]\n\n请在回答中原样保留以上标记（前端渲染为图表卡片），并用文字总结数据要点。`;
    } catch (e) {
      return '图表生成失败：' + e.message;
    }
  },
};

/* =============== ③ web_search：四级兜底联网搜索 =============== */
async function searchTavily(q, n) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: q, max_results: n, search_depth: 'basic' }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await res.json();
  return (j.results || []).map(r => ({ title: r.title || '(无标题)', url: r.url, snippet: (r.content || '').slice(0, 200) })).filter(x => x.url);
}
async function searchBing(q, n) {
  const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=' + n + '&mkt=zh-CN', {
    headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept': 'text/html' },
    signal: AbortSignal.timeout(9000),
  });
  const html = await res.text();
  const out = [];
  for (const b of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b) || /class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(b);
    out.push({ title: stripTags(a[2]), url: a[1], snippet: p ? stripTags(p[1]).slice(0, 200) : '' });
    if (out.length >= n) break;
  }
  return out.filter(x => x.title && x.url);
}
async function searchDDG(q, n) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': FETCH_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'q=' + encodeURIComponent(q) + '&kl=cn-zh',
    signal: AbortSignal.timeout(9000),
  });
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|<\/div>\s*<\/div>\s*<\/div>|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    let url = m[1];
    const u = /uddg=([^&]+)/.exec(url);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { } }
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    out.push({ title: stripTags(m[2]), url, snippet: sn ? stripTags(sn[1]).slice(0, 200) : '' });
  }
  return out.filter(x => x.title && /^https?:/.test(x.url));
}
function parseBaidu(html, n) {
  const out = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const t = stripTags(m[2]);
    if (t && m[1]) out.push({ title: t, url: m[1], snippet: '' });
  }
  return out;
}
async function searchBaidu(q, n) {
  const res = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=' + n, {
    headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(9000),
  });
  return parseBaidu(await res.text(), n);
}

const web_search = {
  schema: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索：实时检索互联网获取最新信息（新闻、行情、政策、技术资料等）。回答时须为引用的事实标注来源链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（可用空格分隔多个词）' },
          count: { type: 'number', description: '结果条数 3~10，默认 6' },
        },
        required: ['query'],
      },
    },
  },
  run: async (args) => {
    const q = String(args.query || '').trim().slice(0, 200);
    if (!q) return '缺少 query 参数';
    const n = Math.min(Math.max(Math.round(+args.count) || 6, 3), 10);
    const engines = [
      ['Tavily', () => searchTavily(q, n)],
      ['Bing', () => searchBing(q, n)],
      ['DuckDuckGo', () => searchDDG(q, n)],
      ['百度', () => searchBaidu(q, n)],
    ];
    for (const [name, fn] of engines) {
      try {
        const list = await fn();
        if (list && list.length) {
          const body = list.map((x, i) => `${i + 1}. **${x.title}**\n   链接：${x.url}${x.snippet ? `\n   摘要：${x.snippet}` : ''}`).join('\n\n');
          return `联网搜索「${q}」（${name}）共 ${list.length} 条结果：\n\n${body}\n\n【引用要求】回答中引用以上信息时，须以 markdown 链接标注来源（如 [来源](url)）。`;
        }
      } catch { /* 换下一个引擎 */ }
    }
    return `联网搜索暂不可用（各搜索引擎均未返回结果，可能被限流或网络受限）。请如实告知用户暂时无法联网检索，不要编造搜索结果。`;
  },
};

/* =============== ③ web_fetch：网页正文抓取 =============== */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
const web_fetch = {
  schema: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定网页的正文内容（自动转 Markdown/纯文本）。配合 web_search 使用：先搜索找到链接，再抓取正文深入了解。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网页链接（http/https）' },
        },
        required: ['url'],
      },
    },
  },
  run: async (args) => {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return '仅支持 http(s) 完整链接';
    // P5.33 审查修复（F2）：SSRF 前置防护——私网/环回/云元数据地址直接拒绝（含 jina 路径，防内网目标外泄）
    try {
      await assertPublicHttpUrl(url);
    } catch (e) {
      return `⛔ ${e.message}`;
    }
    // 1) jina reader（正文抽取质量最好）
    try {
      const res = await fetch('https://r.jina.ai/' + url, {
        headers: { 'User-Agent': FETCH_UA, 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const t = (await res.text()).trim();
        if (t.length > 200) {
          return `网页正文（${url}，jina reader 抽取，${t.length} 字符）：\n\n${t.length > 4000 ? t.slice(0, 4000) + '\n\n（内容过长已截断）' : t}`;
        }
      }
    } catch { /* 降级直抓 */ }
    // 2) 直接抓取并抽正文（重定向逐跳校验，防 302 跳入内网）
    try {
      const res = await fetchWithRedirectGuard(url, {
        headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
      const ct = res.headers.get('content-type') || '';
      if (!/text\/|html|xml|json|markdown/i.test(ct)) return `该链接是二进制资源（${ct.split(';')[0]}），无法转为文本阅读。`;
      const text = htmlToText(await res.text());
      if (!text) return '网页抓取成功但正文为空（可能是动态渲染页面），建议换用其他来源。';
      return `网页正文（${url}，${text.length} 字符）：\n\n${text.length > 4000 ? text.slice(0, 4000) + '\n\n（内容过长已截断）' : text}`;
    } catch (e) {
      return `网页抓取失败：${e.message}。建议检查链接有效性或换用其他来源。`;
    }
  },
};

/* =============== ③ stock_quote：股票/指数实时行情（东财+腾讯双源，教程23/30 正解） =============== */
/**
 * 网络层修复（2026-10-22 全量验收发现）：服务进程内全局 fetch（undici）的连接池复用 stale socket，
 * 对短 keep-alive 的行情 CDN 产生 UND_ERR_SOCKET 竞态（独立进程直调正常、服务内偶发失败）。
 * 改用 node:https + agent:false（每次全新连接，不进任何池），并加腾讯行情第二数据源双保险。
 */
const https = require('https');
function httpsGetRaw(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      agent: false, // 关键：绕开全局连接池，每次新建连接
      headers: { 'User-Agent': FETCH_UA, Accept: '*/*', ...headers },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
        else reject(new Error('HTTP ' + res.statusCode));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}
async function httpsGetJsonRetry(url, headers, tries = 2) {
  let lastErr;
  for (let i = 0; i <= tries; i++) {
    try { return JSON.parse((await httpsGetRaw(url, headers)).toString('utf8')); }
    catch (e) { lastErr = e; }
    if (i < tries) await new Promise(r => setTimeout(r, 500 + i * 500));
  }
  throw lastErr;
}
/** 腾讯行情兜底：QuoteID(1.600519) → sh600519；0.x→sz / 116.x→hk / 其他市场跳过 */
function quoteFromTencent(quoteId, code) {
  const m = /^(\d+)\.(.+)$/.exec(quoteId || '');
  if (!m) return null;
  const pref = { '1': 'sh', '0': 'sz' }[m[1]] || (m[1] === '116' ? 'hk' : null);
  if (!pref) return null;
  return new Promise(async (resolve, reject) => {
    try {
      const buf = await httpsGetRaw('https://qt.gtimg.cn/q=' + pref + m[2], { Referer: 'https://gu.qq.com/' });
      const text = new TextDecoder('gbk').decode(buf);
      const body = /"([^"]*)"/.exec(text);
      if (!body || !body[1]) return reject(new Error('腾讯行情响应为空'));
      const f = body[1].split('~');
      // 腾讯字段：1 名称 2 代码 3 现价 4 昨收 5 今开 31 涨跌 32 涨跌幅 33 最高 34 最低 36 成交量(手) 37 成交额(万) 38 换手率 39 市盈率
      resolve({
        name: f[1], code: f[2], price: f[3], prev: f[4], open: f[5],
        chg: f[31], chgPct: f[32], high: f[33], low: f[34],
        volHand: f[36], amt: f[37], turnover: f[38], pe: f[39],
      });
    } catch (e) { reject(e); }
  });
}
const stock_quote = {
  schema: {
    type: 'function',
    function: {
      name: 'stock_quote',
      description: '查询股票/指数实时行情（东方财富/腾讯双数据源自动切换）：传入名称或代码，返回最新价、涨跌幅、今开/最高/最低、成交量额、换手率、市盈率等结构化数据。查行情数据必须优先用本工具（通用网页搜索拿不到可靠行情），web_search 仅用于查相关资讯新闻。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '股票名称或代码，如「贵州茅台」「600519」「上证指数」「比亚迪」' },
        },
        required: ['name'],
      },
    },
  },
  run: async (args) => {
    const q = String(args.name || '').trim().slice(0, 30);
    if (!q) return '缺少 name 参数（股票名称或代码）';
    try {
      // 1) 名称/代码 → secid（东财搜索建议；原生 https 新连接 + 重试）
      const sj = await httpsGetJsonRetry('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8', { Referer: 'https://www.eastmoney.com/' });
      const cand = (sj.QuotationCodeTable?.Data || []).filter(x => x.QuoteID);
      if (!cand.length) {
        return `未找到「${q}」对应的股票或指数，请确认名称或代码（示例：贵州茅台 / 600519 / 上证指数）。也可改用 web_search 查询相关资讯。`;
      }
      const pick = cand[0];
      const multi = cand.length > 1 ? `\n（另有候选：${cand.slice(1, 5).map(x => `${x.Name}(${x.Code})`).join('、')}，如需切换请指定代码）` : '';
      const fmtNum = v => { const n = +v; return isNaN(n) ? String(v) : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }); };
      // 2) 主源：东财行情；失败自动切腾讯源
      try {
        const qj = await httpsGetJsonRetry('https://push2.eastmoney.com/api/qt/stock/get?secid=' + encodeURIComponent(pick.QuoteID) + '&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f162,f168,f169,f170&ut=fa5fd1943c7b386f172d6893dbfba10b', { Referer: 'https://quote.eastmoney.com/' });
        const d = qj.data || {};
        if (d.f43 == null) throw new Error('东财无行情数据');
        const px = v => (v == null || v === '-') ? '-' : (v / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
        const upDown = (d.f170 ?? 0) >= 0 ? '🔴 上涨' : '🟢 下跌';
        return `【${d.f58}（${d.f57}）实时行情】${upDown}（东方财富数据）
最新价：${px(d.f43)} 元　涨跌：${px(d.f169)} 元（${px(d.f170)}%）
今开：${px(d.f46)}　最高：${px(d.f44)}　最低：${px(d.f45)}　昨收：${px(d.f60)}
成交量：${(d.f47 / 10000).toFixed(2)} 万手　成交额：${(d.f48 / 100000000).toFixed(2)} 亿元
换手率：${px(d.f168)}%　市盈率(动)：${px(d.f162)}${multi}
数据来源：东方财富公开行情接口（约15分钟内延迟）；需要趋势对比可继续用 db_chart 绘图。`;
      } catch (e) {
        // 3) 兜底源：腾讯行情（GBK）
        const t = await quoteFromTencent(pick.QuoteID, pick.Code);
        if (t && t.price && +t.price > 0) {
          const pct = +t.chgPct || 0;
          const upDown = pct >= 0 ? '🔴 上涨' : '🟢 下跌';
          return `【${t.name}（${t.code}）实时行情】${upDown}（腾讯财经数据·备用源）
最新价：${fmtNum(t.price)} 元　涨跌：${fmtNum(t.chg)} 元（${fmtNum(t.chgPct)}%）
今开：${fmtNum(t.open)}　最高：${fmtNum(t.high)}　最低：${fmtNum(t.low)}　昨收：${fmtNum(t.prev)}
成交量：${fmtNum(t.volHand)} 手　成交额：${fmtNum(t.amt)} 万元
换手率：${fmtNum(t.turnover)}%　市盈率：${fmtNum(t.pe)}${multi}
数据来源：腾讯财经公开行情（备用源，约15分钟内延迟）；需要趋势对比可继续用 db_chart 绘图。`;
        }
        throw e;
      }
    } catch (e) {
      const cause = e?.cause ? `（底层原因：${e.cause.code || e.cause.message || e.cause}）` : '';
      return `行情查询失败：${e.message}${cause}。本工具已正常集成在平台中（东财+腾讯双源均尝试），此为数据源临时网络波动——请直接重试一次；若仍失败，可改用 web_search 查询相关资讯（但注意网页搜索拿不到结构化行情数据）。`;
    }
  },
};

/* =============== ⑥ export_word：Markdown → Word =============== */
const DOCX = require('docx');
function mdInlineRuns(text) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0, m;
  const t = String(text || '');
  while ((m = re.exec(t))) {
    if (m.index > last) runs.push(new DOCX.TextRun(t.slice(last, m.index)));
    if (m[2] != null) runs.push(new DOCX.TextRun({ text: m[2], bold: true }));
    else if (m[4] != null) runs.push(new DOCX.TextRun({ text: m[4], italics: true }));
    else if (m[6] != null) runs.push(new DOCX.TextRun({ text: m[6], font: 'Courier New', color: 'C7254E', size: 19 }));
    last = re.lastIndex;
  }
  if (last < t.length) runs.push(new DOCX.TextRun(t.slice(last)));
  return runs.length ? runs : [new DOCX.TextRun('')];
}
function mdToDocxChildren(md) {
  const children = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let inCode = false, codeBuf = [], tableBuf = [], listIdx = 0, prevWasList = false;
  const HEAD_CFG = { 1: { size: 32, before: 260, after: 140 }, 2: { size: 28, before: 220, after: 120 }, 3: { size: 24, before: 180, after: 100 } };
  function flushTable() {
    const rows = tableBuf.map(r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => mdInlineRuns(c.replace(/\*\*/g, '').trim())));
    tableBuf = [];
    if (!rows.length) return;
    children.push(new DOCX.Table({
      width: { size: 100, type: DOCX.WidthType.PERCENTAGE },
      rows: rows.map((cells, ri) => new DOCX.TableRow({
        children: cells.map(c => new DOCX.TableCell({
          shading: ri === 0 ? { type: DOCX.ShadingType.CLEAR, fill: 'DEEBF7' } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new DOCX.Paragraph({ children: c })],
        })),
      })),
    }));
    children.push(new DOCX.Paragraph({ text: '', spacing: { after: 80 } }));
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (/^```/.test(line.trim())) {
      if (inCode) {
        codeBuf.forEach(c => children.push(new DOCX.Paragraph({
          shading: { type: DOCX.ShadingType.CLEAR, fill: 'F5F5F5' },
          spacing: { after: 0, line: 240 },
          children: [new DOCX.TextRun({ text: c || ' ', font: 'Courier New', size: 18 })],
        })));
        children.push(new DOCX.Paragraph({ text: '', spacing: { after: 120 } }));
        codeBuf = []; inCode = false;
      } else { flushTable(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(rawLine); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { tableBuf.push(line); continue; }
    flushTable();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const cfg = HEAD_CFG[h[1].length];
      children.push(new DOCX.Paragraph({
        spacing: { before: cfg.before, after: cfg.after },
        children: [new DOCX.TextRun({ text: h[2].replace(/\*\*/g, ''), bold: true, size: cfg.size, color: '1F4E79' })],
      }));
      prevWasList = false; continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      children.push(new DOCX.Paragraph({
        border: { bottom: { style: DOCX.BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
        spacing: { after: 160 }, text: '',
      }));
      prevWasList = false; continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      children.push(new DOCX.Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: mdInlineRuns(ul[1]) }));
      prevWasList = true; listIdx = 0; continue;
    }
    const ol = /^\s*(\d+)[.、]\s+(.*)$/.exec(line);
    if (ol) {
      listIdx = prevWasList ? listIdx + 1 : (parseInt(ol[1], 10) || 1);
      children.push(new DOCX.Paragraph({
        indent: { left: 420, hanging: 260 }, spacing: { after: 60 },
        children: [new DOCX.TextRun(`${listIdx}. `), ...mdInlineRuns(ol[2])],
      }));
      prevWasList = true; continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      children.push(new DOCX.Paragraph({
        indent: { left: 420 }, spacing: { after: 80 },
        border: { left: { style: DOCX.BorderStyle.SINGLE, size: 18, color: '9DC3E6' } },
        children: mdInlineRuns(quote[1]).map(r => r),
      }));
      prevWasList = false; continue;
    }
    if (!line.trim()) { children.push(new DOCX.Paragraph({ text: '', spacing: { after: 80 } })); prevWasList = false; continue; }
    children.push(new DOCX.Paragraph({ spacing: { after: 100, line: 300 }, children: mdInlineRuns(line) }));
    prevWasList = false;
  }
  if (inCode && codeBuf.length) codeBuf.forEach(c => children.push(new DOCX.Paragraph({ shading: { type: DOCX.ShadingType.CLEAR, fill: 'F5F5F5' }, children: [new DOCX.TextRun({ text: c, font: 'Courier New', size: 18 })] })));
  flushTable();
  return children;
}
async function mdToWordFile(md, title) {
  const doc = new DOCX.Document({
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 21 } } } },
    sections: [{ properties: {}, children: mdToDocxChildren(md) }],
  });
  const buf = await DOCX.Packer.toBuffer(doc);
  const dir = ensureUploads('exports');
  const safe = String(title || '文档').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || '文档';
  const fname = `${safe}-${Date.now()}.docx`;
  fs.writeFileSync(path.join(dir, fname), buf);
  return `/uploads/exports/${fname}`;
}
const export_word = {
  schema: {
    type: 'function',
    function: {
      name: 'export_word',
      description: '把 Markdown 内容导出为 Word 文档（.docx，支持标题/加粗/列表/表格/代码块/引用），生成下载链接。适合报告、方案、总结等需要交付文件的场景。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题（同时作为文件名）' },
          markdown: { type: 'string', description: '完整的 Markdown 文档内容' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  run: async (args) => {
    const title = String(args.title || '文档').replace(/[\\/:*?"<>|\[\]]+/g, '-').trim().slice(0, 40) || '文档';
    const md = String(args.markdown || '').trim();
    if (!md) return '缺少 markdown 参数（文档内容为空）';
    try {
      const url = await mdToWordFile(md, title);
      return `Word 文档「${title}.docx」已生成：\n\n[WORD:${url}|${title}.docx]\n\n请在回答中原样保留以上标记（前端渲染为下载卡片），不要重复粘贴全文。`;
    } catch (e) {
      return 'Word 导出失败：' + e.message;
    }
  },
};

/* =============== ② tts：语音合成（P4 2026-10-22：优先自有昇腾算力 Qwen3-TTS，微软 msedge-tts 回退） =============== */
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,}-\w+$/;
const tts = {
  schema: {
    type: 'function',
    function: {
      name: 'tts',
      description: '文本转语音：把一段文字合成为可播放的 MP3 音频。优先使用自有昇腾算力（Qwen3-TTS 中文音色），昇腾不可用时回退微软 Edge 语音。适合朗读、播报、语音版回答等场景。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要合成的文本（≤1500 字，纯文本，不含 markdown 语法）' },
          voice: { type: 'string', description: '昇腾音色 ID（可选，默认音色）；微软音色格式 zh-CN-XiaoxiaoNeural 等仅在昇腾不可用回退时生效' },
        },
        required: ['text'],
      },
    },
  },
  run: async (args) => {
    const text = String(args.text || '').replace(/[#*`>|_\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!text) return '缺少 text 参数';
    const sec = Math.max(1, Math.round(text.length / 4.2));
    // ① 首选：自有昇腾算力（Qwen3-TTS）
    try {
      const { genTTS } = require('./skills');
      const r = await genTTS(text, args.voice);
      return `语音已合成（昇腾 Qwen3-TTS·自有算力，约 ${sec} 秒）：\n\n[AUDIO:${r.url}]\n\n请在回答中原样保留以上标记（前端渲染为音频播放卡片）。`;
    } catch (ascendErr) {
      // ② 回退：微软 msedge-tts
      try {
        const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
        const engine = new MsEdgeTTS();
        await engine.setMetadata(VOICE_RE.test(String(args.voice || '')) ? args.voice : 'zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = engine.toStream(text);
        const chunks = [];
        for await (const c of audioStream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length < 200) throw new Error('返回空音频');
        const dir = ensureUploads('audio');
        const fname = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`;
        fs.writeFileSync(path.join(dir, fname), buf);
        return `语音已合成（微软语音·备用源，约 ${sec} 秒）：\n\n[AUDIO:/uploads/audio/${fname}]\n\n请在回答中原样保留以上标记（前端渲染为音频播放卡片）。`;
      } catch (e) {
        return `语音合成失败（昇腾：${ascendErr.message.slice(0, 120)}；微软备用源：${e.message}）。请稍后重试。`;
      }
    }
  },
};

/* =============== ④ doc_review：文档评审（知识库文档 + 工作流/对话上传文件） =============== */
const REVIEW_TEMPLATES = {
  contract: {
    name: '合同风险审查',
    dims: ['主体资格与签约权限', '价款与支付条款', '违约责任与赔偿上限', '知识产权归属', '保密与数据安全', '争议解决与管辖', '解除与终止条件', '义务对等性（不利条款）'],
  },
  bid: {
    name: '投标文件符合性检查',
    dims: ['资质要求响应', '技术参数偏离', '商务条款响应', '报价完整性', '格式与签章要求', '交付与售后承诺', '废标风险项'],
  },
  general: {
    name: '通用文档评审',
    dims: ['内容完整性', '逻辑一致性', '表述准确性', '数据与事实核对', '格式规范性', '潜在风险点'],
  },
};
function parseIssuesJSON(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.issues) ? j.issues.filter(x => x && (x.problem || x.suggestion)) : [];
  } catch { return []; }
}
/** P5.14 文件一等变量：file_id 参数取值（数字 / file 富对象 {__file,id} / array[file] 取首个） */
function fileIdOf(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (Array.isArray(v)) {
    const first = v.find(x => x && (x.__file || x.id)) || v[0];
    return fileIdOf(first);
  }
  if (typeof v === 'object') return Number(v.id) || Number(v.__file) || 0;
  return Number(v) || 0;
}
const doc_review = {
  schema: {
    type: 'function',
    function: {
      name: 'doc_review',
      description: '对文档做专业评审，输出结构化报告（问题分级 + 原文定位 + 整改建议），并自动生成 Word 报告供下载。支持两类评审对象：①对话/画布上传的文件（传 file_id，画布 args 写纯引用 {{#start.变量#}} 自动注入文件对象）；②知识库已解析文档（传 file_name 或不传取最新）。内置模板：contract 合同风险审查 / bid 投标文件符合性检查 / general 通用文档评审，也可自定义评审维度。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'number', description: '上传文件的 ID（对话📎附件或画布 start 文件变量）——传入则直接评审该文件，优先于知识库定位' },
          file_name: { type: 'string', description: '知识库文档名称（可只给关键词，模糊匹配；不填则评审知识库最新一份文档）' },
          template: { type: 'string', enum: ['contract', 'bid', 'general'], description: '评审模板，默认 general' },
          kb_id: { type: 'number', description: '知识库 ID（不填则用当前智能体关联的知识库）' },
          custom_dims: { type: 'array', items: { type: 'string' }, description: '自定义评审维度列表（传入则覆盖模板维度）' },
        },
        required: [],
      },
    },
  },
  run: async (args, ctx) => {
    // P5.14 文件一等变量：file_id（数字/富对象/数组取首个）→ 直接评审上传文件（wf_files），优先级最高
    // 典型链路：画布 start(file 变量) → doc_review 工具节点 args {"file_id":"{{#start.contract#}}"} → 富对象直达
    const fid = fileIdOf(args.file_id);
    if (fid) {
      const wf = db.prepare('SELECT * FROM wf_files WHERE id=?').get(fid);
      if (!wf) return `文件 #${fid} 不存在或已被清理，请重新上传后重试。`;
      const full = String(wf.text_content || '').trim();
      if (!full) return `文件「${wf.name}」未解析出文本内容，无法评审（扫描版 PDF 需先 OCR）。`;
      return await reviewBody({ name: wf.name, full }, args);
    }
    // —— 知识库文档定位（原有链路：显式 kb_id 参数 > 智能体关联知识库 > 跨库模糊匹配）——
    const kbId = +args.kb_id || +ctx.kbId || 0;
    const nameLike = args.file_name ? `%${String(args.file_name).slice(0, 100)}%` : null;
    let file = null;
    if (kbId) {
      file = nameLike
        ? db.prepare('SELECT * FROM kb_files WHERE kb_id=? AND name LIKE ? ORDER BY id DESC').get(kbId, nameLike)
        : db.prepare('SELECT * FROM kb_files WHERE kb_id=? ORDER BY id DESC').get(kbId);
    } else {
      // 未关联知识库：在全部知识库中查找（按文件名匹配；无文件名则取最新一份）
      file = nameLike
        ? db.prepare('SELECT * FROM kb_files WHERE name LIKE ? ORDER BY id DESC').get(nameLike)
        : db.prepare('SELECT * FROM kb_files ORDER BY id DESC').get();
    }
    if (!file) {
      const list = db.prepare('SELECT f.name, k.name AS kb FROM kb_files f LEFT JOIN kbs k ON f.kb_id=k.id ORDER BY f.id DESC LIMIT 10').all()
        .map(f => `${f.name}（${f.kb || '未命名库'}）`).join('、');
      return `未找到${args.file_name ? `「${args.file_name}」` : '可评审的文档'}。`
        + (list ? `平台现有已解析文档：${list}。请确认文件名，或将待评审文件上传到任意知识库后告诉我文件名，或直接以附件上传（file_id 直达）。` : '平台还没有已解析的文档，请先在「知识库管理」上传（PDF/DOCX/TXT 均可），或以附件上传待评审文件。');
    }
    const chunks = db.prepare('SELECT content FROM kb_chunks WHERE file_id=? ORDER BY id').all(file.id);
    const full = chunks.map(c => c.content || '').join('\n').trim();
    if (!full) return `文档「${file.name}」还没有解析出文本内容，无法评审。`;
    return await reviewBody({ name: file.name, full }, args);
  },
};

/** 评审主体（两路共用）：模板/维度选择 → 分段 LLM 评审 → 去重分级 → 报告 + Word 导出
 *  @param doc { name, full }  @param args 工具入参（template/custom_dims） */
async function reviewBody(doc, args) {
  const { name: fileName, full } = doc;
    const tpl = REVIEW_TEMPLATES[args.template] || REVIEW_TEMPLATES.general;
    const dims = (Array.isArray(args.custom_dims) && args.custom_dims.length ? args.custom_dims : tpl.dims)
      .map(d => String(d).slice(0, 40)).slice(0, 10);
    // 分段评审（每段 ≤6000 字，最多 6 段）
    const SEGS = 6000, MAX_SEGS = 6;
    const segs = [];
    for (let i = 0; i < full.length && segs.length < MAX_SEGS; i += SEGS) segs.push(full.slice(i, i + SEGS));
    const allIssues = [];
    for (let i = 0; i < segs.length; i++) {
      try {
        const r = await chatOnce([
          { role: 'system', content: `你是资深评审专家，正在对文档进行「${tpl.name}」。只输出 JSON，不要任何其他文字。` },
          {
            role: 'user', content: `请从以下维度逐项审查文档片段，找出具体问题：\n${dims.map((d, di) => `${di + 1}. ${d}`).join('\n')}\n\n只输出 JSON（无问题输出 {"issues":[]}）：\n{"issues":[{"dim":"维度名","level":"高|中|低","quote":"原文关键句(≤60字，须为原文片段)","problem":"问题说明(≤80字)","suggestion":"整改建议(≤80字)"}]}\n\n文档片段（第 ${i + 1}/${segs.length} 段）：\n${segs[i]}`,
          },
        ], { temperature: 0.2, max_reply: 1600 });
        parseIssuesJSON(r.full).forEach(x => allIssues.push(x));
      } catch { /* 单段失败跳过 */ }
    }
    // 汇总去重（按 quote 相同合并）
    const seen = new Set();
    const issues = allIssues.filter(x => {
      const k = (x.quote || x.problem || '').slice(0, 40);
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
    const lv = s => (s === '高' ? '高' : s === '中' ? '中' : '低');
    const cnt = { 高: 0, 中: 0, 低: 0 };
    issues.forEach(x => { cnt[lv(x.level)]++; });
    issues.sort((a, b) => ({ 高: 0, 中: 1, 低: 2 }[lv(a.level)] - { 高: 0, 中: 1, 低: 2 }[lv(b.level)]));
    // 生成报告
    const stamp = now();
    let report = `# 「${fileName}」${tpl.name}报告\n\n`;
    report += `> 评审时间：${stamp}　|　模板：${tpl.name}　|　评审范围：${segs.length} 段 / ${full.length} 字（超长部分未评审）\n\n`;
    report += `## 一、总体结论\n\n共发现 **${issues.length}** 个问题：🔴 高风险 ${cnt.高} 个、🟡 中风险 ${cnt.中} 个、🟢 低风险 ${cnt.低} 个。\n`;
    if (cnt.高 > 0) report += `\n⚠️ 存在 ${cnt.高} 个高风险项，建议**暂缓推进**，优先完成高风险整改后再确认。`;
    else if (issues.length) report += `\n整体风险可控，建议按清单逐项完善。`;
    else report += `\n本次评审未发现问题，文档质量良好（自动评审仅供参考）。`;
    if (issues.length) {
      report += `\n\n## 二、问题清单\n\n| # | 维度 | 级别 | 原文定位 | 问题 |\n|---|------|------|----------|------|\n`;
      issues.forEach((x, i) => {
        const icon = lv(x.level) === '高' ? '🔴' : lv(x.level) === '中' ? '🟡' : '🟢';
        report += `| ${i + 1} | ${x.dim || '—'} | ${icon} ${lv(x.level)} | ${(x.quote || '—').slice(0, 40)} | ${(x.problem || '—').slice(0, 60)} |\n`;
      });
      report += `\n## 三、详细分析与整改建议\n\n`;
      issues.forEach((x, i) => {
        const icon = lv(x.level) === '高' ? '🔴' : lv(x.level) === '中' ? '🟡' : '🟢';
        report += `### ${i + 1}. [${icon} ${lv(x.level)}] ${x.dim || '未分类'}\n\n`;
        if (x.quote) report += `- **原文**：「${x.quote}」\n`;
        if (x.problem) report += `- **问题**：${x.problem}\n`;
        if (x.suggestion) report += `- **建议**：${x.suggestion}\n`;
        report += `\n`;
      });
    }
    report += `\n## 评审说明\n\n本报告由平台「文档评审」工具自动生成（模板：${tpl.name}；维度：${dims.join('、')}），供决策参考；重要合同、标书请务必由专业人员人工复核。\n`;
    // 报告落 Word
    let wordMark = '';
    try {
      const url = await mdToWordFile(report, `${fileName}-${tpl.name}报告`);
      wordMark = `[WORD:${url}|${fileName}-${tpl.name}报告.docx]`;
    } catch { /* Word 失败不阻塞报告返回 */ }
    const summary = `评审完成：「${fileName}」（${full.length} 字，评审 ${segs.length} 段），共发现 ${issues.length} 个问题（🔴高 ${cnt.高} / 🟡中 ${cnt.中} / 🟢低 ${cnt.低}）。`;
    return `${summary}\n\n请基于以下评审报告回答用户：总结主要风险与建议；回答中须原样保留 Word 报告标记 ${wordMark}，用户可下载完整报告。\n\n---\n\n${report}`;
}

/* =============== ⑨ run_code：Node 代码沙箱（P5.26 工具生态补齐） ===============
 * 动机：用户问「桌面创建文件夹」暴露的期望——AI 需要一个"真执行"的工具证明全自动执行价值。
 * 平台网页 AI 碰不到用户电脑，但可以给模型一个**服务端沙箱**：跑 JS/算法/数据处理，
 * 在限定目录内可创建文件（产物挂 /uploads 下载），让「执行」有真实语义。
 *
 * 安全边界（执行前静态拦截 + 运行时硬限制双层）：
 *  - 静态 DENY：require/import 动态模块、process.exit/kill、child_process、fs 写沙箱外路径、
 *    网络调用（http/https/net/dns/fetch）、eval/Function 构造器、构造器链/globalThis/原型攀爬（P5.30）——防逃逸与横向移动
 *  - P5.30 运行时加固：沙箱上下文关闭字符串代码生成（eval/new Function 失效）+ 抹平注入宿主对象的 constructor 跳板；
 *    ⚠️ 已知边界：node:vm 非安全边界（官方文档明示），对不可信用户完全隔离需迁移子进程（中期项）
 *  - 运行时：V8 脚本级 10s 超时（防同步死循环）+ 异步返回值 Promise.race 限时兑底；stdout+stderr 各截 8KB；工作目录 = .temp/sandbox-<id>（一次性）
 *  - fs 读写代理：只允许工作目录内路径（resolve 后前缀校验），读文件额外放行 /uploads 与项目内只读
 *  - 产物：沙箱目录内新文件 → 拷贝到 public/uploads/sandbox/ 供下载，回复中给链接
 */
const SANDBOX_TIMEOUT_MS = 10000;
const SANDBOX_OUT_LIMIT = 8 * 1024;
const SANDBOX_DENY_PATTERNS = [
  { re: /require\s*\(\s*['"][^'"]*(?:child_process|net|dns|http|https|tls|cluster|dgram|worker_threads|vm|repl|fs\.promises?[^'"]*)['"]/i, msg: '禁止 require 系统模块（child_process/net/http/fs 等不在白名单）' },
  { re: /(?:^|\W)import\s+[^;]*from\s+['"](?:child_process|net|dns|http|https|tls|cluster|worker_threads|vm)['"]/i, msg: '禁止 import 系统模块（网络/进程/线程不在白名单）' },
  { re: /process\s*\.\s*(?:exit|kill|abort|binding|dlopen)/i, msg: '禁止 process.exit/kill 等进程控制' },
  { re: /process\s*\.\s*(?:env|execPath|pid)\b/gi, msg: '禁止读取 process.env / execPath（密钥与宿主信息）' },
  { re: /\beval\s*\(|new\s+Function\s*\(|require\s*\.main|module\s*\.\s*(?:constructor|exports\s*=\s*require)/i, msg: '禁止 eval / new Function / 动态 require（逃逸向量）' },
  { re: /fetch\s*\(|XMLHttpRequest|WebSocket\s*\(/i, msg: '禁止网络请求（沙箱离线运行）' },
  // P5.30 安全止血（对齐工作流 code 节点 CODE_FORBIDDEN_RE）：堵构造器链逃逸向量。
  // 此前缺少以下规则，Buffer.constructor.constructor('return process')() 可拿到宿主 process（进而读 process.env/require）
  { re: /\.constructor\s*[.(]/i, msg: '禁止构造器链调用（.constructor( 或 .constructor[ 为已知逃逸向量）' },
  { re: /\bglobalThis\b/i, msg: '禁止访问 globalThis（宿主全局逃逸向量）' },
  { re: /__proto__|getPrototypeOf|setPrototypeOf/i, msg: '禁止原型链攀爬（__proto__/getPrototypeOf 为逃逸向量）' },
  { re: /\bWebAssembly\b/i, msg: '禁止 WebAssembly（逃逸向量）' },
];
const SANDBOX_ALLOWED_READ_PREFIXES = ['/uploads/']; // 相对项目根的额外只读区

/* =============== ⑩ local_exec：本地桥桌面操控（P5.27） ===============
 * 轮询模式：入队 localbridge_tasks → 用户电脑上的桥 daemon 拉取执行 → 回推结果 → 此处等待唤醒。
 * ctx.username 决定路由到该用户的**默认设备**；无设备/离线给出可行动的引导（装客户端）。
 * 安全：op 白名单双层（此处 + 桥端）；工具级归 high 风险（tools.js 分级表前缀 local_），默认权限必弹确认卡。
 */
const LOCAL_EXEC_WAIT_MS = 60000;

const local_exec = {
  schema: {
    type: 'function',
    function: {
      name: 'local_exec',
      description: '操作用户已配对的本地电脑（需用户安装「TeleAgent 智能体平台助手」客户端并配对）。支持四类白名单操作：mkdir（在用户主目录内创建文件夹，target 为相对主目录的路径如 "Desktop/新项目"）、list_dir（列目录，返回名称与类型）、open_app（打开本机应用，app 为应用注册名——macOS 上中文应用常以英文名注册，如备忘录=Notes、访达=Finder、微信=WeChat、Safari=Safari；失败时可用 list_dir 查 /Applications 目录确认真实应用名）、notify（发送系统通知）。操作在用户本机执行，结果实时返回；设备离线或未配对会明确提示。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['mkdir', 'list_dir', 'open_app', 'notify'], description: '操作类型' },
          target: { type: 'string', description: 'mkdir/list_dir 用：相对用户主目录的路径（禁止绝对路径与路径穿越）' },
          app: { type: 'string', description: 'open_app 用：应用名' },
          text: { type: 'string', description: 'notify 用：通知内容（≤200 字）' },
        },
        required: ['op'],
      },
    },
  },
  run: async (args, ctx = {}) => {
    const { OPS_WHITELIST } = require('../routes/localbridge');
    const op = String(args.op || '');
    if (!OPS_WHITELIST.includes(op)) return `⛔ 不支持的操作「${op}」（白名单：${OPS_WHITELIST.join('/')}）`;
    const username = ctx.username;
    if (!username) return '⛔ 缺少用户上下文，无法路由到设备';
    const dev = db.prepare('SELECT * FROM localbridge_devices WHERE username=? AND is_default=1').get(username)
      || db.prepare('SELECT * FROM localbridge_devices WHERE username=? ORDER BY last_seen DESC LIMIT 1').get(username);
    if (!dev) {
      return `❌ 您还没有配对的本地设备。请：1) 下载安装「TeleAgent 智能体平台助手」（平台右上角「设备」页有安装包与引导）；2) 安装后首次打开会提示输入网页端生成的 6 位配对码；3) 配对成功后即可让我操作您的电脑（建文件夹/开应用等白名单操作）。请向用户转述此引导。`;
    }
    const online = dev.last_seen && new Date(now()).getTime() - new Date(dev.last_seen).getTime() < 30000;
    if (!online) return `❌ 设备「${dev.device_name}」离线（心跳超过 30s）。请提示用户打开本机的「TeleAgent 智能体平台助手」（菜单栏 🤖 图标），确认它正在运行后重试。`;
    // 参数白名单化清洗（防注入多余字段进桥）
    const params = {};
    if (op === 'mkdir' || op === 'list_dir') params.target = String(args.target || '').slice(0, 300);
    if (op === 'open_app') params.app = String(args.app || '').slice(0, 60);
    if (op === 'notify') params.text = String(args.text || '').slice(0, 200);
    // 入队
    const info = db.prepare('INSERT INTO localbridge_tasks (device_id,username,op,params,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(dev.id, username, op, JSON.stringify(params), 'pending', now(), now());
    const taskId = info.lastInsertRowid;
    // 等待回推（500ms 轮询 DB，60s 超时）
    const t0 = Date.now();
    while (Date.now() - t0 < LOCAL_EXEC_WAIT_MS) {
      await new Promise(r => setTimeout(r, 500));
      const t = db.prepare('SELECT status, result FROM localbridge_tasks WHERE id=?').get(taskId);
      if (t && (t.status === 'done' || t.status === 'failed')) {
        let result = {}; try { result = JSON.parse(t.result || '{}'); } catch { }
        if (t.status === 'done' && result.ok) {
          const d = result.data || {};
          // mkdir 语义化摘要：新建 vs 已存在（existed 为创建前的存在性，桥端已修正）
          let summary = '';
          if (op === 'mkdir') {
            summary = d.existed ? `（路径已存在：${d.path}，未重复创建）` : `（已新建：${d.path}）`;
          }
          return `✅ 本机操作成功（${op}，设备「${dev.device_name}」）${summary}：\n${JSON.stringify(d, null, 2).slice(0, 2000)}`;
        }
        return `⛔ 本机操作失败（${op}）：${result.error || '未知错误'}。请告知用户失败原因，询问是否重试。`;
      }
    }
    // 超时：任务留队列（桥恢复后 poll 仍会执行并回推），提示已排队
    return `⏳ 任务已下发至设备「${dev.device_name}」但 60 秒内未收到执行结果（设备可能正忙或网络抖动）。任务仍在队列中，桥恢复后会执行；请告知用户稍后可在设备侧查看结果，或直接重试。`;
  },
};

const run_code = {
  schema: {
    type: 'function',
    function: {
      name: 'run_code',
      description: '在安全沙箱中执行 JavaScript 代码（Node 环境，无网络）并返回 stdout/stderr。适合：数学与算法计算、数据转换/统计、正则/文本批量处理、批量生成文件（产物可下载）。注意：沙箱无 require/import——fs、console、Math、JSON、Buffer、Date 等已作为全局直接可用（如 fs.writeFileSync("a.txt", "内容")），不要写 const fs = require("fs")。写文件仅限沙箱工作目录（相对路径），产物自动提供下载链接。超时 10 秒，输出各截断 8KB。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 JavaScript 源码（自包含，不要用 require/import）' },
          purpose: { type: 'string', description: '一句话说明本次执行目的（展示给用户确认卡）' },
        },
        required: ['code'],
      },
    },
  },
  run: async (args) => {
    const code = String(args.code || '');
    const purpose = String(args.purpose || '代码沙箱执行');
    if (!code.trim()) return '缺少 code 参数';
    if (code.length > 60000) return '代码过长（>60KB），请拆分任务';
    // ① 静态危险模式拦截（给出原因，模型可改写后重试）
    for (const p of SANDBOX_DENY_PATTERNS) {
      const m = code.match(p.re);
      if (m) return `⛔ 代码未通过沙箱安全检查：${p.msg}\n命中位置片段：${m[0].slice(0, 60)}`;
    }
    // ② 一次性工作目录
    const sbId = `sb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workDir = path.join(__dirname, '..', '..', '.temp', `sandbox-${sbId}`);
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'sandbox');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    // ③ 受限 fs 代理：写/删仅限 workDir；读额外放行白名单前缀；禁止生成 HTML 文件
    const SANDBOX_ALLOWED_EXT = ['.json', '.csv', '.tsv', '.txt', '.md', '.xml', '.yaml', '.yml', '.log', '.sql', '.py', '.js', '.ts', '.c', '.cpp', '.h', '.java', '.rb', '.sh', '.bat', '.ps1', ''];
    const inWorkDir = p => { try { const r = path.resolve(workDir, p); return r === workDir || r.startsWith(workDir + path.sep); } catch { return false; } };
    const canRead = p => {
      if (inWorkDir(p)) return true;
      try {
        const rel = String(p).replace(/^\.?\//, '');
        return SANDBOX_ALLOWED_READ_PREFIXES.some(pre => rel.startsWith(pre));
      } catch { return false; }
    };
    const fsShim = {
      writeFileSync: (p, ...rest) => {
        if (!inWorkDir(p)) throw new Error(`沙箱拒绝写入沙箱外路径：${p}`);
        const ext = path.extname(p).toLowerCase();
        if (!SANDBOX_ALLOWED_EXT.includes(ext)) throw new Error(`沙箱禁止生成 ${ext} 文件（仅允许：${SANDBOX_ALLOWED_EXT.join(', ')})`);
        return fs.writeFileSync(path.resolve(workDir, p), ...rest);
      },
      readFileSync: (p, ...rest) => { if (!canRead(p)) throw new Error(`沙箱拒绝读取受限路径：${p}`); return fs.readFileSync(path.resolve(workDir, p), ...rest); },
      existsSync: p => inWorkDir(p) ? fs.existsSync(path.resolve(workDir, p)) : (canRead(p) && fs.existsSync(path.resolve(workDir, p))),
      mkdirSync: (p, ...rest) => { if (!inWorkDir(p)) throw new Error(`沙箱拒绝在沙箱外建目录：${p}`); return fs.mkdirSync(path.resolve(workDir, p), ...rest); },
      unlinkSync: p => { if (!inWorkDir(p)) throw new Error(`沙箱拒绝删除沙箱外路径：${p}`); return fs.unlinkSync(path.resolve(workDir, p)); },
      readdirSync: p => { if (!canRead(p)) throw new Error(`沙箱拒绝列目录：${p}`); return fs.readdirSync(path.resolve(workDir, p)); },
      statSync: p => { if (!canRead(p)) throw new Error(`沙箱拒绝取 stat：${p}`); return fs.statSync(path.resolve(workDir, p)); },
      appendFileSync: (p, ...rest) => { if (!inWorkDir(p)) throw new Error(`沙箱拒绝追加沙箱外路径：${p}`); return fs.appendFileSync(path.resolve(workDir, p), ...rest); },
    };
    // ④ vm 隔离运行（独立上下文 + V8 脚本级超时防死循环；fs 仅注入受 fsShim 代理的版本）
    const vm = require('vm');
    const sandbox = {
      console: { log: (...a) => { out.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); }, error: (...a) => { err.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); }, warn: (...a) => { out.push('[warn] ' + a.join(' ')); }, info: (...a) => { out.push(a.join(' ')); } },
      Math, JSON, Date, Buffer, RegExp, Array, Object, String, Number, Boolean, Map, Set, Promise, Symbol, Error, TypeError, RangeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, URL, URLSearchParams, TextEncoder, TextDecoder, BigInt, structuredClone, queueMicrotask, clearImmediate, setImmediate,
      fs: fsShim,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 8000)), // 沙箱内定时器也限 8s
      clearTimeout, setInterval: (fn, ms) => setInterval(fn, Math.min(Number(ms) || 1000, 8000)), clearInterval,
      URLSearchParams,
    };
    sandbox.globalThis = sandbox;
    // P5.30 安全止血：抹平注入的宿主对象及其方法的自身 constructor（打断 Buffer.constructor → 宿主 Function 的逃逸跳板；
    // 与静态拦截、codeGeneration:false 三层防护叠加。注：不影响实例的 prototype.constructor，平台自身代码不依赖全局构造器的 .constructor）
    const shadowCtor = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 1) return;
      for (const v of Object.values(obj)) {
        if (typeof v === 'function') { try { Object.defineProperty(v, 'constructor', { value: undefined, writable: true, configurable: true }); } catch { } }
        else if (v && typeof v === 'object') shadowCtor(v, depth + 1);
      }
    };
    for (const v of Object.values(sandbox)) {
      if (typeof v === 'function') { try { Object.defineProperty(v, 'constructor', { value: undefined, writable: true, configurable: true }); } catch { } }
      else if (v && typeof v === 'object' && v !== sandbox) shadowCtor(v, 1);
    }
    const out = [];
    const err = [];
    let timedOut = false;
    try {
      const script = new vm.Script(code, { filename: `sandbox-${sbId}.js` });
      // P5.30 安全止血：codeGeneration.strings=false —— 沙箱上下文内 eval/new Function 直接抛 EvalError（运行时层堵逃逸）
      const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      const timer = setTimeout(() => { timedOut = true; }, SANDBOX_TIMEOUT_MS);
      const start = Date.now();
      // runInContext 同步执行：V8 脚本级 timeout 中断同步长循环（上方 timer 仅作标记兑底）
      // P3-3（2026-11-09）：原注释声称「改用 child_process 隔离 + kill 兑底」与实现不符（实际为 vm + 脚本超时），已改为如实描述；
      // 已知边界见函数头注释：node:vm 非完全安全隔离，不可信用户场景迁移子进程属中期项
      timer.unref?.();
      const value = script.runInContext(ctx, { timeout: SANDBOX_TIMEOUT_MS }); // V8 脚本级超时（防死循环）
      clearTimeout(timer);
      // 若返回 Promise，等待它（最多剩佘时间）
      if (value && typeof value.then === 'function') {
        await Promise.race([value, new Promise((_, rej) => setTimeout(() => rej(new Error('async timeout')), SANDBOX_TIMEOUT_MS))]);
      }
      const dur = Date.now() - start;
      // ⑤ 收集产物（工作目录内新生成的文件）
      const artifacts = [];
      try {
        for (const f of fs.readdirSync(workDir)) {
          const st = fs.statSync(path.join(workDir, f));
          if (st.isFile() && st.size <= 20 * 1024 * 1024) {
            // P0-3 安全加固：HTML 产物重命名为 .html.txt 防 XSS（同域上传 /uploads 可用 HTML 窃取 token）
            let destName;
            if (/\.html?$/i.test(f)) {
              destName = `${sbId}-${f.replace(/\.html?$/i, '')}.html.txt`;
            } else {
              destName = `${sbId}-${f}`;
            }
            fs.copyFileSync(path.join(workDir, f), path.join(uploadsDir, destName));
            const url = `/uploads/sandbox/${destName}`;
            artifacts.push({ name: f, size: st.size, url });
          }
        }
      } catch { }
      // ⑥ 清理一次性沙箱目录（产物已拷出）
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { }
      const outText = out.join('\n').slice(0, SANDBOX_OUT_LIMIT);
      const errText = err.join('\n').slice(0, SANDBOX_OUT_LIMIT);
      let result = `✅ 沙箱执行完成（${dur}ms${timedOut ? '，注意：触及超时上限' : ''}）`;
      if (purpose) result += ` — ${purpose}`;
      result += `\n\n--- stdout ---\n${outText || '（无输出）'}`;
      if (errText) result += `\n\n--- stderr ---\n${errText}`;
      if (artifacts.length) {
        result += `\n\n--- 产物文件（可直接下载） ---\n${artifacts.map(a => `- ${a.name}（${(a.size / 1024).toFixed(1)} KB）：${a.url}${/\.html?$/i.test(a.name) ? '（保存为 .html.txt，下载后改回 .html 即可预览）' : ''}`).join('\n')}`;
        // P0-3 安全加固：HTML 产物已重命名为 .html.txt，不再提示浏览器预览，改为下载提示
        result += `\n请在回答中用 markdown 链接展示以上产物（[文件名](url)）供用户使用；${artifacts.some(a => /\.html?$/i.test(a.name)) ? 'HTML 文件已重命名为 .html.txt 防止浏览器直接执行，下载后将后缀改回 .html 即可在本地预览。' : ''}`;
      }
      if (out.join('\n').length > SANDBOX_OUT_LIMIT) result += `\n\n（stdout 已截断至 8KB）`;
      return result;
    } catch (e) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { }
      const msg = String(e && e.message || e);
      if (/Script execution timed out|timed out|timeout/i.test(msg)) {
        return `⛔ 沙箱执行超时（${SANDBOX_TIMEOUT_MS / 1000}s 上限）：代码可能存在死循环或过长计算。请优化算法或拆分任务。`;
      }
      return `⛔ 沙箱执行出错：${msg.slice(0, 400)}${err.length ? '\nstderr: ' + err.join('\n').slice(0, 400) : ''}`;
    }
  },
};

/* =============== ⑪ create_task：对话内一键创建定时任务（P5.31） ===============
 * 动机：README 遗留 backlog——「持续监控」场景此前只能引导用户去任务页手工建，对话闭环断裂。
 * 用户在对话中说「每天早上9点帮我监控XX」→ 模型换算 cron 并调用本工具 →（默认权限下先弹确认卡，
 * 含中文计划预览）→ 批准后落库 tasks（username 归属），30s 调度器自动接管执行。
 *
 * 安全设计（工具级 high 风险，默认权限必走 P5.25 确认卡）：
 *  - 归属：ctx.username 必填，任务记在当前用户名下（任务页仅本人/管理员可见可管）
 *  - cron 白名单校验：parseCron + nextFire（永不触发的表达式如「2月31日」直接拒绝）
 *  - 数量配额：非管理员启用中任务上限 20（防提示词注入批量造任务烧 token）
 *  - agent_id 可选：指定时校验 published + canView（与对话链路同权限）；未指定绑定系统「定时任务执行助手」
 */
const MAX_USER_TASKS = 20;
const SYS_TASK_AGENT_NAME = '定时任务执行助手';

const create_task = {
  schema: {
    type: 'function',
    function: {
      name: 'create_task',
      description: '为当前用户创建定时任务（Cron 周期执行，结果可在「任务管理」页查看）。用户表达「定时/每天/每周/工作日/持续监控/定期提醒/每天早上」等意图时使用。schedule 必须是标准五段 cron（分 时 日 月 周）：「每天早上9点」→"0 9 * * *"；「工作日9点」→"0 9 * * 1-5"；「每周一9点半」→"30 9 * * 1"。任务会按计划自动执行 prompt 描述的完整指令。创建前会请求用户确认。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称（≤30 字，如「每日科技资讯监控」）' },
          schedule: { type: 'string', description: '五段 cron 表达式（分 时 日 月 周），如 "0 9 * * *"' },
          schedule_desc: { type: 'string', description: '执行计划的中文描述（如「每天 09:00」「工作日 09:00」），展示在确认卡中' },
          prompt: { type: 'string', description: '任务执行时发送给 AI 的完整自包含指令：写清监控/处理对象、信息来源要求、输出格式（摘要要点+来源），任务执行时看不到本次对话上下文' },
          agent_id: { type: 'number', description: '可选：绑定的智能体 id（不填用系统「定时任务执行助手」，自带联网检索/计算/Word 导出能力）' },
        },
        required: ['name', 'schedule', 'prompt'],
      },
    },
  },
  run: async (args, ctx = {}) => {
    const username = ctx.username;
    if (!username) return '⛔ 缺少用户上下文，无法创建任务';
    const name = String(args.name || '').trim().slice(0, 30); // 与 schema 描述对齐（≤30 字）
    const schedule = String(args.schedule || '').trim();
    const prompt = String(args.prompt || '').trim();
    const scheduleDesc = String(args.schedule_desc || '').trim().slice(0, 60);
    const agentId = Number(args.agent_id) || 0;
    if (!name) return '⛔ 缺少任务名称（name）';
    if (!prompt) return '⛔ 缺少任务执行指令（prompt）——任务执行时看不到当前对话，指令必须自包含';
    if (prompt.length > 4000) return '⛔ 任务指令过长（>4000 字），请精简';
    const { parseCron, nextFire, describeCron } = require('./cron');
    if (!parseCron(schedule)) {
      return `⛔ 定时计划不合法："${schedule}"。schedule 必须是五段 cron（分 时 日 月 周），如 "0 9 * * *"（每天 09:00）、"30 9 * * 1-5"（工作日 09:30）。请把用户的时间描述换算后重试。`;
    }
    const nextTs = nextFire(schedule);
    if (!nextTs) return `⛔ 该计划在一年内不会触发（如「2 月 30 日」类无效日期组合），请修正 schedule。`;
    // 用户行（角色判断 + 权限校验用）
    const me = db.prepare('SELECT id, username, nickname, role, dept FROM users WHERE username=? AND status=1').get(username);
    if (!me) return '⛔ 当前账号不可用，无法创建任务';
    // P5.33 审查修复（Y7）：任务指令过输入敏感词检测——模型转写的 prompt 是间接内容，
    // 注入可借它把违规指令固化成 7×24 自动执行；blocked 时拒绝创建
    const promptCheck = check(prompt, 'input');
    if (promptCheck.blocked) {
      return `⛔ 任务执行指令包含违规词汇（${promptCheck.words.map(w => w.word).join('、')}），已按安全策略拒绝创建。`;
    }
    // 数量配额（管理员不受限）
    if (me.role !== 'admin') {
      const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE username=? AND enabled=1').get(username).c;
      if (cnt >= MAX_USER_TASKS) {
        return `⛔ 已达任务数量上限（启用中 ${MAX_USER_TASKS} 个）。请先在「任务管理」页停用或删除不需要的任务后再创建。`;
      }
    }
    // 执行主体：显式指定 → 校验可见性（与对话链路 canView 同权限）；未指定 → 系统智能体
    let agent = null;
    if (agentId) {
      agent = db.prepare("SELECT * FROM agents WHERE id=? AND status='published'").get(agentId);
      if (!agent) return `⛔ 指定的智能体（id=${agentId}）不存在或未发布，请改用其他智能体或留空`;
      const { canView } = require('./agent-access');
      if (!canView(agent, me)) return `⛔ 无权绑定智能体「${agent.name}」（未对你开放）`;
    } else {
      // P5.34（Y4 完整方案）：按 system_key 稳定标识查找系统执行智能体（agents.name 无唯一约束，
      // 名称查找可被用户自建同名智能体劫持；system_key 由 db.js 迁移打标 + 部分唯一索引保证）
      agent = db.prepare("SELECT * FROM agents WHERE system_key='system_task_runner' AND status='published'").get();
      if (!agent) return '⛔ 系统执行智能体未初始化，请联系管理员检查服务启动日志后重试';
    }
    const info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,username,created_at)
      VALUES (?,?,?,?,?,?,1,?,datetime('now','localtime'))`)
      .run(name, 'agent', agent.id, 'cron', schedule, JSON.stringify({ input: prompt.slice(0, 4000) }), username);
    const planText = scheduleDesc || describeCron(schedule);
    const nextText = new Date(nextTs).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ').slice(0, 16);
    return [
      `✅ 定时任务已创建（id=${info.lastInsertRowid}）`,
      `・名称：${name}`,
      `・计划：${planText}（cron：${schedule}）`,
      `・下次执行：${nextText}`,
      `・执行主体：${agent.name}`,
      `・执行指令：${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`,
      '',
      `请向用户确认以上信息；任务可在「任务管理」页查看执行记录、停用或删除。`,
    ].join('\n');
  },
};

module.exports = { db_query, db_chart, web_search, web_fetch, stock_quote, export_word, tts, doc_review, run_code, local_exec, create_task, sanitizeSelectSql, fileIdOf, assertPublicHttpUrl, fetchWithRedirectGuard, ipIsPrivate };
