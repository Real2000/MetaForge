/**
 * 企业级智能体平台 - 服务入口
 * 前台：首页对话 / 智能体 / 知识库 / 任务管理
 * 后台：数据看板 / 智能体管理 / 用户管理 / 知识库管理 / 接入管理 / 模型接入 / 安全合规 / 用量与配额 / 系统监控 / 运营监控
 */
const express = require('express');
const path = require('path');
const { startScheduler } = require('./src-server/lib/scheduler');
const { editionBanner, checkExpiryNotice } = require('./src-server/lib/edition'); // V2.2 #8 2026-10-31：版本分级（License 缺失/无效自动降级社区版，不阻塞启动）
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '20mb' })); // 知识库支持 PDF/DOCX base64 上传

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
// MCP 服务管理与行业模板库（P2）
app.use('/api/mcp', require('./src-server/routes/mcp'));
app.use('/api/templates', require('./src-server/routes/templates'));
app.use('/api/wf-templates', require('./src-server/routes/wf-templates')); // P5.17 工作流模板库
// 通知中心（铃铛消息：发布上架广播 / 系统公告）
app.use('/api/notify', require('./src-server/routes/notify'));
// 用量报表与配额管理（P2）
app.use('/api/quota', require('./src-server/routes/quota'));
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
// 意见反馈（帮助体系）：全站反馈通道 + 管理员闭环处理（站内信回告提交者）
app.use('/api/feedback', require('./src-server/routes/feedback'));
// P5.27 本地桥（桌面操控客户端服务）：设备配对 + 任务队列（轮询模式，桥端 device_token 鉴权）
app.use('/api/localbridge', require('./src-server/routes/localbridge').router);
// 商业化（2026-10-20）：套餐定价/企业线索/账单发票/客户成功洞察（plans 与 lead 免登录）
app.use('/api/biz', require('./src-server/routes/biz'));
// P5.5 通用密钥管理（画布 {{env.XXX}} 占位符数据源；仅管理员）
app.use('/api/secrets', require('./src-server/routes/secrets'));
// P2-1~3 协作房间+任务分解+人机协同（2026-11-13）
app.use('/api/collab', require('./src-server/routes/collab'));
// P2-4~8 专家目录+子智能体库+插件+市场Hub对接（2026-11-13）
app.use('/api/catalog', require('./src-server/routes/catalog'));
// P1-20 配置中心（统一配置管理，格式检查 + 脱敏回显 + 审计日志）
app.use('/api/config', require('./src-server/routes/config'));
// P1-21 API 文档站（自动生成 OpenAPI 规范 + Redoc 渲染页面）
app.use('/api/api-docs', require('./src-server/routes/api-docs'));
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
  console.log('==============================================');
  startScheduler();
  setTimeout(checkExpiryNotice, 60 * 1000).unref(); // V2.2 #8：License 到期提醒（启动 1 分钟后首查）
  setInterval(checkExpiryNotice, 24 * 3600 * 1000).unref(); // 每 24h 复查（unref 不阻退出；notifications 当日同标题去重）
});

// 优雅停机（2026-10-20 P1）：SIGTERM/SIGINT 时停止接新连接、等待存量请求收尾、数据库落盘
// 悬挂的 SSE 长连接由 5 秒兜底强退处理，避免卡死重启流程
function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，优雅停机中（停止接新连接，等待请求收尾）…`);
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
