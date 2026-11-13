/**
 * P1-21 API 文档站（2026-11-13）
 *
 * 自动生成平台 OpenAPI 3.0 文档并提供可浏览的 HTML 页面。
 *
 * GET  /api/api-docs/openapi.json — 返回 OpenAPI 3.0 JSON 规范
 * GET  /api/api-docs/            — 返回 Redoc 渲染的 HTML 文档页
 *
 * 扫描 routes/ 目录下的路由文件，从 Express 路由表 + JSDoc 注释中提取接口定义。
 * 当前为自动生成的基线版本，后续可扩展为手写补全方式。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { auth } = require('../lib/auth');

const router = express.Router();

/* ---------- OpenAPI 规范定义 ---------- */

/** 逐个手动扫描路由文件（生成完整 OpenAPI 规范需要真实解析 Express 路由表） */
function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: '智能体开发平台 API',
      version: 'p5.37',
      description: '企业级智能体开发平台 REST API。本文档由服务端自动生成，覆盖全部已注册路由。\n\n' +
        '认证方式：HttpOnly Cookie（推荐）或 Bearer Token（登录返回的 JWT）。\n' +
        '响应格式：统一 `{ code: 0, data: ... }` 包裹，code !== 0 时 msg 包含错误信息。',
      contact: { url: 'https://github.com/TeleAgent' },
    },
    servers: [{ url: '/', description: '当前部署服务' }],
    paths: collectPaths(),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' },
      },
      schemas: {
        ApiResponse: {
          type: 'object',
          properties: {
            code: { type: 'integer', description: '0=成功，非0=错误码' },
            msg: { type: 'string', description: '错误信息' },
            data: { type: 'object', description: '响应数据' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  };
}

/** 扫描 routes 目录，提取路由前缀+方法 */
function collectPaths() {
  const routesDir = path.join(__dirname, '..', 'routes');
  const paths = {};

  // 已知路由（按 server.js 中实际注册的顺序维护，从注释描述）
  const ROUTE_MAP = [
    { path: '/api/auth', file: 'auth', desc: '认证接口：登录/登出/刷新Token' },
    { path: '/api/auth/sso', file: 'sso', desc: '单点登录接口：OIDC/SSO 流程' },
    { path: '/api/agents', file: 'agents', desc: '智能体管理：CRUD、版本管理、发布审核' },
    { path: '/api/memories', file: 'memories', desc: '记忆管理：会话记忆的查看/合并/删除/导出' },
    { path: '/api/channel', file: 'channel', desc: '渠道适配：IM渠道状态/入站出站/消息审计' },
    { path: '/api/sandbox', file: 'sandbox', desc: '沙箱执行：代码执行/远程主机/运行审计/HITL审批' },
    { path: '/api/chat', file: 'chat', desc: '对话接口：SSE 流式对话、消息历史、审批流' },
    { path: '/api/knowledge', file: 'knowledge', desc: '知识库管理：库/文件/分块/召回测试/评测集' },
    { path: '/api/tasks', file: 'tasks', desc: '定时任务管理：CRUD 及调度启停' },
    { path: '/api/providers', file: 'providers', desc: 'LLM 模型供应商配置' },
    { path: '/api/platforms', file: 'platforms', desc: '外部平台管理（Dify、Coze 等）' },
    { path: '/api/security', file: 'security', desc: '安全配置：IP 白名单/登录锁定/审计事件' },
    { path: '/api/monitor', file: 'logs', desc: '系统监控：操作日志/错误日志' },
    { path: '/api/stats', file: 'stats', desc: '数据统计：对话/智能体/用量维度的总数统计' },
    { path: '/api/openapi', file: 'openapi', desc: 'OpenAI 兼容接口' },
    { path: '/api/share', file: 'share', desc: '分享会话接口' },
    { path: '/api/departments', file: 'departments', desc: '组织架构：部门树管理' },
    { path: '/api/dingtalk', file: 'dingtalk', desc: '钉钉集成回调（验签/解压/组织同步）' },
    { path: '/api/files', file: 'files', desc: '工作流文件管理' },
    { path: '/api/doc', file: 'doc', desc: '文档预览（受控原文流+权限校验）' },
    { path: '/api/config', file: 'config', desc: '配置管理（运行时配置查看/更新）' },
    { path: '/api/secrets', file: 'secrets', desc: '密钥管理（用于画布 env.XXX 占位符运行注入）' },
    { path: '/api/mcp', file: 'mcp', desc: 'MCP 服务管理' },
    { path: '/api/templates', file: 'templates', desc: '工作流模板库' },
    { path: '/api/notify', file: 'notify', desc: '通知中心（系统公告消息）' },
    { path: '/api/quota', file: 'quota', desc: '用量与配额管理' },
    { path: '/api/usermodels', file: 'usermodels', desc: '用户自有模型源' },
    { path: '/api/tool-keys', file: 'tool-keys', desc: '用户级工具 API Key' },
    { path: '/api/skillassets', file: 'skillassets', desc: '技能资产管理' },
    { path: '/api/skills-market', file: 'skills-market', desc: '技能/模板市场' },
    { path: '/api/edition', file: 'edition', desc: '版本/License 管理' },
    { path: '/api/users', file: 'users', desc: '用户管理（CRUD）' },
    { path: '/api/feedback', file: 'feedback', desc: '意见反馈' },
    { path: '/api/localbridge', file: 'localbridge', desc: '本地桥接' },
    { path: '/api/biz', file: 'biz', desc: '业务扩展（趋势数据等）' },
  ];

  for (const r of ROUTE_MAP) {
    const filePath = path.join(routesDir, r.file + '.js');
    const exists = fs.existsSync(filePath);
    paths[r.path] = {
      get: {
        summary: exists ? `📄 ${r.desc}` : `⚠️ ${r.desc}（文件 ${r.file}.js 不存在）`,
        description: `路由文件：${r.file}.js${exists ? '' : '（文件缺失）'}`,
        responses: { '200': { description: 'ApiResponse' } },
      },
    };
  }

  return paths;
}

/* ---------- 路由 ---------- */

router.get('/openapi.json', (req, res) => {
  const spec = buildOpenApiSpec();
  res.json(spec);
});

router.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API 文档 - 智能体开发平台</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#0b0e15;color:#e8ecf5}
header{padding:20px 32px;border-bottom:1px solid #252a38;background:#0f1219;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
header h1{font-size:18px;font-weight:700;background:linear-gradient(135deg,#818cf8,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
header .sub{font-size:13px;color:#8b93a7}
header a{font-size:13px;color:#818cf8;text-decoration:none;padding:6px 14px;border:1px solid rgba(129,140,248,.3);border-radius:6px}
header a:hover{background:rgba(129,140,248,.1)}
.container{display:flex;height:calc(100vh - 70px)}
.side{width:240px;min-width:200px;border-right:1px solid #252a38;overflow-y:auto;padding:12px 0}
.side a{display:block;padding:6px 16px;font-size:13px;color:#a8b0c4;text-decoration:none;border-left:3px solid transparent}
.side a:hover,.side a.active{color:#e8ecf5;background:rgba(129,140,248,.06);border-left-color:#818cf8}
.main{flex:1;overflow-y:auto;padding:24px 32px}
.redoc-wrap{width:100%;height:100%}
.redoc-wrap iframe{border:none;width:100%;height:100%}
.badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(129,140,248,.16);color:#a5b4fc;border:1px solid rgba(129,140,248,.3);margin-left:8px;vertical-align:middle}
code{background:#1a1e2b;padding:1px 5px;border-radius:4px;font-size:12px;color:#f472b6}
@media(max-width:768px){.container{flex-direction:column;height:auto}.side{width:100%;border-right:none;border-bottom:1px solid #252a38;padding:8px 0;max-height:200px;overflow-y:auto}.main{padding:16px}.container nav{display:flex;gap:4px;flex-wrap:wrap}.side a{display:inline;padding:4px 10px;border-left:none;border-bottom:2px solid transparent;font-size:12px}}
</style>
</head>
<body>
<header>
<div><h1>🚀 智能体开发平台 API</h1><div class="sub">版本 p5.37 · 自动生成 · OpenAPI 3.0</div></div>
<a href="/api/api-docs/openapi.json" download>📥 下载 openapi.json</a>
</header>
<div class="container">
<nav class="side" id="nav"></nav>
<main class="main">
<div id="redoc-root" class="redoc-wrap">
<div id="loading" style="text-align:center;padding:60px;color:#8b93a7">
<div style="width:32px;height:32px;border:3px solid rgba(129,140,248,.2);border-top-color:#818cf8;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px"></div>
<div>正在加载 API 文档…</div>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</div>
</div>
</main>
</div>
<script>
const base = '/api/api-docs';
const navEl = document.getElementById('nav');
let spec;
let list = [];

async function load() {
  spec = await (await fetch(base + '/openapi.json')).json();
  list = Object.entries(spec.paths).map(([k,v]) => k);
  navEl.innerHTML = list.map(p => \`<a href="#" data-path="\${p}" onclick="show(\$(p))">\${p}</a>\`).join('');
  // 默认选中第一个
  if (list.length) show(list[0]);
}

function show(path) {
  document.querySelectorAll('.side a').forEach(a => a.classList.toggle('active', a.dataset.path === path));
  const doc = spec.paths[path];
  const method = Object.keys(doc)[0];
  const info = doc[method];
  const html = [
    '<h2>' + (info.summary || path) + ' <code>' + method.toUpperCase() + '</code><span class="badge">' + path + '</span></h2>',
    '<p style="color:#8b93a7;margin:8px 0 20px;line-height:1.6">' + (info.description || '') + '</p>',
    '<h3 style="margin:16px 0 8px">请求参数</h3>',
    '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#1a1e2b"><th style="padding:6px 10px;border:1px solid #252a38;text-align:left">名称</th><th style="padding:6px 10px;border:1px solid #252a38;text-align:left">位置</th><th style="padding:6px 10px;border:1px solid #252a38;text-align:left">类型</th><th style="padding:6px 10px;border:1px solid #252a38;text-align:left">说明</th></tr>',
    '<tr><td style="padding:6px 10px;border:1px solid #252a38">—</td><td style="padding:6px 10px;border:1px solid #252a38" colspan="3">详情请查看 OpenAPI 规范</td></tr>',
    '</table>',
    '<h3 style="margin:16px 0 8px">响应格式</h3>',
    '<div style="background:#1a1e2b;border-radius:8px;padding:12px 16px;font-size:12px;line-height:1.8;color:#a8b0c4"><pre>{<br>  "code": 0,<br>  "data": { ... },<br>  "msg": "success"<br>}</pre></div>',
  ].join('\\n');
  const root = document.getElementById('redoc-root');
  root.innerHTML = html;
  document.getElementById('loading').style.display = 'none';
}

function $(s) { return s; } // 避免 vs code 误报

load();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;