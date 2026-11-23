/**
 * 企业级智能体平台 - 服务入口
 * 前台：首页对话 / 智能体 / 知识库 / 任务管理
 * 后台：数据看板 / 智能体管理 / 用户管理 / 知识库管理 / 接入管理 / 模型接入 / 安全合规 / 用量与配额 / 系统监控 / 运营监控
 */

// U2-1 / N7-P2 集群引导：WEB_CONCURRENCY>1 时用 Node cluster 派生多 worker，主进程不监听端口。
// 未设置或 =1 时保持单进程行为不变；PM2 环境（存在 pm_id）由 PM2 负责多实例，此处不重复派生。
const cluster = require('node:cluster');
const WEB_CONCURRENCY = Math.max(1, parseInt(process.env.WEB_CONCURRENCY || '1', 10) || 1);
if (WEB_CONCURRENCY > 1 && !process.env.pm_id && cluster.isPrimary) {
  console.log(`[cluster] 主进程启动，派生 ${WEB_CONCURRENCY} 个 worker（WEB_CONCURRENCY=${WEB_CONCURRENCY}）`);
  // U2-1 / N7-P2：fork 前先在本进程完成一次数据库初始化与迁移，避免多 worker 并发执行
  // 「先查列→再 ALTER」内联迁移导致的 duplicate column 竞争（如 sessions.active_branch）。
  try { require('./src-server/db'); console.log('[cluster] 主进程已完成数据库初始化与迁移，开始派生 worker'); }
  catch (e) { console.error('[cluster] 主进程预迁移失败（worker 将自行迁移）:', e && e.message); }
  let shuttingDown = false;
  const live = new Set();
  const spawn = () => {
    const w = cluster.fork();
    live.add(w.id);
    w.on('exit', () => {
      live.delete(w.id);
      if (shuttingDown && live.size === 0) process.exit(0); // 全部 worker 退出后主进程随之退出，避免留下空壳
    });
    return w;
  };
  for (let i = 0; i < WEB_CONCURRENCY; i++) spawn();
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) { console.warn(`[cluster] worker ${worker.process.pid} 已退出（停机中，不再重启）`); return; }
    if (!worker.exitedAfterDisconnect) {
      console.warn(`[cluster] worker ${worker.process.pid} 退出（code=${code} signal=${signal}），自动重启`);
      spawn();
    }
  });
  // 主进程收到终止信号 → 停止派生并通知全部 worker 优雅停机，自身在 worker 全部退出后退出
  const shutdownPrimary = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cluster] 主进程收到 ${sig}，停止派生并终止全部 worker…`);
    for (const id in cluster.workers) { try { cluster.workers[id].kill(sig); } catch { } }
    setTimeout(() => process.exit(0), 8000).unref(); // 兜底：worker 未及时退出时强制结束
  };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdownPrimary(sig));
  return; // 主进程不加载应用、不监听端口
}

// P2-23 OTEL 外部追踪（必须在所有模块加载前初始化；OTEL_ENABLED=1 时生效）
if (process.env.OTEL_ENABLED === '1') {
  try { require('./src-server/lib/opentelemetry'); } catch { }
}
const express = require('express');
const path = require('path');
const { startScheduler } = require('./src-server/lib/scheduler');
const { editionBanner, checkExpiryNotice } = require('./src-server/lib/edition'); // V2.2 #8 2026-10-31：版本分级（License 缺失/无效自动降级社区版，不阻塞启动）
const fs = require('fs');

const app = express();

// SEC-01 限流 IP 可信化（2026-11-22）：受信代理配置统一出口，影响 req.ip 与 clientIp 取值。
// 默认（未设 AGENT_TRUST_PROXY）为直连，Express 不采信 X-Forwarded-For，堵住伪造 XFF 绕过按 IP 限流/爆破锁定。
const { trustProxySetting } = require('./src-server/lib/rate-limit');
app.set('trust proxy', trustProxySetting());

// SEC-06 全局安全响应头（2026-11-22）：任意响应统一注入，防 MIME 嗅探/点击劫持/信息外泄。
// HSTS 仅生产（或 AGENT_ENABLE_HSTS=1）启用，避免本地 HTTP 开发被浏览器强制 HTTPS。
// CSP 先以 Report-Only 下发（不破坏 SPA 内联脚本/样式），观察无大规模违规后再切强制。
// 分享页 /share/* 需要被白名单域名 iframe 嵌入：跳过此处 X-Frame-Options，交由该路由动态下发 frame-ancestors。
const isProd = process.env.NODE_ENV === 'production' || process.env.AGENT_ENABLE_HSTS === '1';
const APP_CSP_REPORT_ONLY = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(), payment=()');
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (!String(req.path).startsWith('/share/')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy-Report-Only', APP_CSP_REPORT_ONLY);
  }
  next();
});

// BE-B1（M2 批次3，2026-11-22）：统一响应契约——错误一律以对应 HTTP 状态码返回（成功仍 code:0）。
// 中央中间件一次性覆盖既有全部「HTTP 200 + 业务错误码」响应点，body 原样保留（前后端 j.code 逻辑零破坏）；
// 凭据/机器协议/webhook 端点豁免（见 lib/response.js）。置于全部路由之前。
app.use(require('./src-server/lib/response').contract());

// U0-6 A2A Agent Card 公开发现端点（必须在任何鉴权中间件之前注册）
const { publicRouter, authRouter, adminRouter } = require('./src-server/routes/a2a');
app.use(publicRouter); // /.well-known/agent-card.json 公开访问
app.use('/api/a2a/admin', adminRouter); // U2-7 Phase 3：密钥管理（平台管理员）
app.use('/api/a2a', authRouter); // /api/a2a/* 需认证
const PORT = process.env.PORT || 3210;

// MT-13：捕获原始报文（req.rawBody）供支付回调 HMAC 验签逐字节比对（防重排/篡改）
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // 知识库支持 PDF/DOCX base64 上传

// 静态文件服务（必须在 API 路由之前，且沙箱产物中间件在最后）
const staticOptions = { maxAge: 0, etag: false, lastModified: false };

// P0-3/#P1-2 2026-10-28/2026-11-03 安全加固：sandbox 产物强制下载（防 .html 文件同源执行窃取 localStorage token）
// + #P1-2 CSP sandbox 头（2026-11-03：纵深防御层——即使浏览器忽略 Content-Disposition 也无法执行脚本）
const expressStatic = require('express').static;
app.use('/uploads/sandbox', (req, res, next) => {
  const filePath = path.join(__dirname, 'public', 'uploads', 'sandbox', path.normalize(req.path));
  if (!filePath.startsWith(path.join(__dirname, 'public', 'uploads', 'sandbox'))) return res.status(403).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="sandbox-output.txt"');
    res.set('Content-Security-Policy', 'sandbox'); // P1-2：沙箱产物禁止执行脚本/表单/导航等
  }
  next();
}, expressStatic(path.join(__dirname, 'public'), staticOptions));
// 通用静态文件服务
app.use(expressStatic(path.join(__dirname, 'public'), staticOptions));

// MT-03（2026-11-22）：租户上下文中间件——置于全部业务路由之前。
// 单租户（默认）→ req.tenant={id:1}（零行为变更）；多租户（AGENT_MULTI_TENANT=1）→ 解析失败即 403。
const { tenantContext } = require('./src-server/lib/auth');
app.use(tenantContext);

// API 路由
app.use('/api/auth', require('./src-server/routes/auth'));
app.use('/api/auth/sso', require('./src-server/routes/sso'));

app.use('/api/agents', require('./src-server/routes/agents'));
app.use('/api/memories', require('./src-server/routes/memories')); // P1-5 记忆管理（查看/搜索/合并/删除/导出，adminOnly）
app.use('/api/channel', require('./src-server/routes/channel')); // P1-7 渠道适配层（统一入站模型 + 出站发送封装）
app.use('/api/sandbox', require('./src-server/routes/sandbox')); // P1-11~13 沙箱执行子线（运行记录/远程主机/执行测试）
app.use('/api/chat', require('./src-server/routes/chat'));
app.use('/api/knowledge', require('./src-server/routes/knowledge'));
app.use('/api/tasks', require('./src-server/routes/tasks'));
app.use('/api/providers', require('./src-server/routes/providers'));
app.use('/api/platforms', require('./src-server/routes/platforms'));
app.use('/api/security', require('./src-server/routes/security'));
app.use('/api/monitor', require('./src-server/routes/logs'));
app.use('/api/stats', require('./src-server/routes/stats'));
// API 发布（OpenAI 兼容，密钥自鉴权）与分享链接（免登录）
app.use('/openapi', require('./src-server/routes/openapi'));
app.use('/api/share', require('./src-server/routes/share'));
app.use('/api/departments', require('./src-server/routes/departments')); // P0 组织部门树
// V1.3 #4 2026-10-30 钉钉集成回调（mock 阶段：验签/解密/幂等/组织同步；服务器对服务器推送无登录态，安全靠验签，路由内故意不挂 auth）
app.use('/api/dingtalk', require('./src-server/routes/dingtalk'));
// P5.14 文件一等变量：工作流文件上传/下载（画布 file 变量 + 聊天附件共用）
app.use('/api/files', require('./src-server/routes/files'));
app.use('/api/doc', require('./src-server/routes/doc')); // P1-15/16 文档预览（受控原文流 + 权限校验）
// P2-16 工具注册表统一化（内置工具 + MCP + 子智能体同表登记）
app.use('/api/tools', require('./src-server/routes/tools'));
// MCP 服务管理与行业模板库（P2）
app.use('/api/mcp', require('./src-server/routes/mcp'));
app.use('/api/templates', require('./src-server/routes/templates'));
app.use('/api/wf-templates', require('./src-server/routes/wf-templates')); // P5.17 工作流模板库
// 通知中心（铃铛消息：发布上架广播 / 系统公告）
app.use('/api/notify', require('./src-server/routes/notify'));
// 用量报表与配额管理（P2）
app.use('/api/quota', require('./src-server/routes/quota'));
app.use('/api/billing', require('./src-server/routes/billing')); // D2-2 计费用量感知闭环（预检/预留/结算/对账）
// 用户自有模型源（P3）：自带 Key 接入个人 OpenAI 兼容服务，仅本人可见可用
app.use('/api/usermodels', require('./src-server/routes/usermodels'));
app.use('/api/tool-keys', require('./src-server/routes/tool-keys')); // P3-2：用户级工具 API Key（weather/translate 等，加密落盘掩码回显）
// 技能资产（P3）：提示词+工具组合资产化，对话中 @技能名 调用
app.use('/api/skillassets', require('./src-server/routes/skillassets'));
// V2.2 #7 技能/模版市场：工作流模版/技能资产/MCP 工具/异构应用四区聚合 + 收藏 + 一键克隆
app.use('/api/skills-market', require('./src-server/routes/skills-market'));
// V2.3 Y7 版本/License 管理端点：GET 版本快照（登录可看，普通用户脱敏）+ POST 热重载（仅管理员，写 op_logs 审计）
app.use('/api/edition', require('./src-server/routes/edition'));
// 用户管理：管理员对用户的增删改查/角色管理/重置密码/启停
app.use('/api/users', require('./src-server/routes/users'));
// MT-10 租户开通闭环（2026-11-22）：平台超管开通/停用租户（建租户 + 派生首个管理员）
app.use('/api/tenants', require('./src-server/routes/tenants'));
// MT-09 平台超管跨租户运维台（2026-11-22）：跨租户只读统计 / 带审计 impersonation / 审计查询
app.use('/api/platform-admin', require('./src-server/routes/platform-admin'));
// MT-13 支付/订阅闭环（2026-11-22）：下单/回调验签(免登录)/订单/钱包/退款/对账
app.use('/api/payment', require('./src-server/routes/payment'));
// 意见反馈（帮助体系）：全站反馈通道 + 管理员闭环处理（站内信回告提交者）
app.use('/api/feedback', require('./src-server/routes/feedback'));
// P5.27 本地桥（桌面操控客户端服务）：设备配对 + 任务队列（轮询模式，桥端 device_token 鉴权）
app.use('/api/localbridge', require('./src-server/routes/localbridge').router);
// 商业化（2026-10-20）：套餐定价/企业线索/账单发票/客户成功洞察（plans 与 lead 免登录）
app.use('/api/biz', require('./src-server/routes/biz'));
// U2-3 插件运行时管理（安装/卸载/启用/沙箱试运行）
app.use('/api/plugins', require('./src-server/routes/plugins'));
// P5.5 通用密钥管理（画布 {{env.XXX}} 占位符数据源；仅管理员）
app.use('/api/secrets', require('./src-server/routes/secrets'));
// P2-1~3 协作房间+任务分解+人机协同（2026-11-13）
app.use('/api/collab', require('./src-server/routes/collab'));
// P2-4~8 专家目录+子智能体库+插件+市场Hub对接（2026-11-13）
app.use('/api/catalog', require('./src-server/routes/catalog'));
// U2-5 市场商品管理（智能体发行为市场可购买商品）
app.use('/api/market', require('./src-server/routes/market-products'));
// U2-5 Phase 2 市场订单管理（购买/订阅/支付回调）
app.use('/api/market/orders', require('./src-server/routes/market-orders'));
// P1-20 配置中心（统一配置管理，格式检查 + 脱敏回显 + 审计日志）
app.use('/api/config', require('./src-server/routes/config'));
// U1-1 内建数据库（用户自定义表CRUD + 行数据管理）
app.use('/api/database', require('./src-server/routes/database'));
// P1-21 API 文档站（自动生成 OpenAPI 规范 + Redoc 渲染页面）
app.use('/api/api-docs', require('./src-server/routes/api-docs'));
// P2-20 语音供应商管理（2026-11-13）
app.use('/api/voice-providers', require('./src-server/routes/voice-providers'));
// P2-18 浏览器自动化（2026-11-13）
app.use('/api/browser', require('./src-server/routes/browser'));
// D1-3 创作资产 V1（2026-11-20）：项目/素材库/分镜三件套
app.use('/api/creation', require('./src-server/routes/creation'));
// D3-1 3D 与数字人 V1（2026-11-21）：3D 资产生成/导出 + 数字人合规评估
app.use('/api/model3d', require('./src-server/routes/model3d'));
// D3-2 经验自进化 V1（2026-11-21）：专家×任务类型可靠度聚合 + 编排优选 + 自进化验收指标
app.use('/api/experience', require('./src-server/routes/experience'));
// D3-4 评测体系 V1（2026-11-21）：发布基线（成功率/步数/干预率）+ SWE-bench-lite 接入
app.use('/api/eval', require('./src-server/routes/eval'));
// D2-1 代码索引与仓库语义检索（2026-11-21）：只读检索 + 补丁 propose/apply/rollback
app.use('/api/code', require('./src-server/routes/code'));
// P3 MCP Server（2026-10-22 ⑤）：已发布智能体暴露为 MCP 工具（Streamable HTTP + Bearer 令牌；管理端 /api/mcp-server）
app.use('/mcp', require('./src-server/routes/mcp-server'));
app.use('/api/mcp-server', require('./src-server/routes/mcp-server'));

// 健康检查
app.get('/api/health', (req, res) => res.json({ code: 0, data: { ok: true, ts: Date.now() } }));

// 分享页面（/share/:token → share.html，前端自解析 token）
// V3.1 #12 嵌入代码（2026-11-03）：按 token 对应智能体的 embed_domains 白名单动态下发 CSP
// frame-ancestors（点击劫持防护核心——安全报告 T2.1）：白名单域名 + 'self' 可嵌；未配置白名单仅 'self'。
// share API 响应头同源处理见 routes/share.js；此处覆盖页面级（iframe 嵌的是页面而非 API）。
app.get('/share/*', (req, res) => {
  try {
    const { db } = require('./src-server/db');
    const token = String(req.path.split('/')[2] || '').slice(0, 64);
    const a = token ? db.prepare('SELECT embed_domains FROM agents WHERE share_token=? AND share_enabled=1').get(token) : null;
    const domains = String(a && a.embed_domains || '')
      .split(/[,\n;，；]/).map(s => s.trim().toLowerCase()).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)); // 域名格式白名单校验
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${domains.length ? ' ' + domains.join(' ') : ''}`);
  } catch { res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); } // 兜底：查询失败也保底防嵌
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// SPA 兑底
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 全局异常兜底 → 异常日志
const { db, now } = require('./src-server/db');
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  try { db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('http', `${req.method} ${req.url}: ${err.message}`, now()); } catch { }
  res.status(500).json({ code: 500, msg: '服务内部错误：' + err.message });
});

const server = app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  智能体平台已启动');
  console.log(`  前台入口:  http://localhost:${PORT}/`);
  console.log('  默认账号:  admin（首次登录强制改密）');
  console.log('             demo（首次登录强制改密）');
  console.log(`  当前版本:  ${editionBanner()}`); // V2.2 #8：License 验签后横幅（专业版/企业版含到期信息，降级时展示原因）
  if (WEB_CONCURRENCY > 1 || process.env.pm_id) {
    const { isClusterMode } = require('./src-server/lib/cluster-lock');
    console.log(`  运行模式:  集群（worker=${process.pid}${process.env.pm_id != null ? ` pm_id=${process.env.pm_id}` : ''}，选主=${isClusterMode() ? '启用' : '关闭'}）`);
  }
  // U2-1 / N7-P3：读写分离状态（未配置副本时回退主库，不额外打印）
  try {
    const rs = require('./src-server/lib/db-read').status();
    if (rs.enabled) console.log(`  读写分离:  启用（只读副本=${rs.path}）`);
  } catch { }
  console.log('==============================================');
  startScheduler();
  setTimeout(checkExpiryNotice, 60 * 1000).unref(); // V2.2 #8：License 到期提醒（启动 1 分钟后首查）
  setInterval(checkExpiryNotice, 24 * 3600 * 1000).unref(); // 每 24h 复查（unref 不阻退出；notifications 当日同标题去重）
});

// U1-7 画布多人实时协作：WS 挂载到同一 HTTP server（/api/canvas-ws，upgrade 时经 HttpOnly Cookie 鉴权）
const { attachCanvasCollab } = require('./src-server/lib/canvas-collab');
const canvasCollabHandle = attachCanvasCollab(server);

// U0-2 实时语音对话：WS 语音通道（/api/voice-ws，upgrade 时经 HttpOnly Cookie 鉴权）
const { attachVoiceStream } = require('./src-server/lib/voice-stream');
const voiceStreamHandle = attachVoiceStream(server);

// 优雅停机（2026-10-20 P1）：SIGTERM/SIGINT 时停止接新连接、等待存量请求收尾、数据库落盘
// 悬挂的 SSE 长连接由 5 秒兜底强退处理，避免卡死重启流程
function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，优雅停机中（停止接新连接，等待请求收尾）…`);
  // U2-1 / N7-P2 / MT-15：主动释放集群领导权，使其他进程/重启实例可立即接管调度（无需等待租约 TTL 过期）。
  // 异步 API 按后端分派（同机=DB 租约；跨机=Redis 锁），best-effort 不阻塞停机。
  try { const cl = require('./src-server/lib/cluster-lock'); Promise.resolve(cl.releaseAsync(cl.LOCK_NAME)).catch(() => { }); } catch { }
  try { require('./src-server/lib/db-read').closeReadDb(); } catch { } // U2-1 / N7-P3：关闭只读副本连接
  try { canvasCollabHandle.close(); } catch { } // U1-7：先断 WS 协作长连接，防 server.close 等待它悬挂至 5s 强退
  try { voiceStreamHandle.close(); } catch { } // U0-2：再断 WS 语音长连接（同上）
  server.close(() => {
    try { db.close(); console.log('[server] 数据库已落盘关闭'); } catch { }
    console.log('[server] 停机完成');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[server] 等待超时（可能有长连接），强制退出');
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
