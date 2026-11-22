/**
 * API 文档站（BE-B4 / M2 批次3，2026-11-22）
 *
 * GET  /api/api-docs/openapi.json — OpenAPI 3.1 JSON 规范（运行时自动采集）
 * GET  /api/api-docs/            — 自带「试调」控制台的文档页（零 CDN、离线可用）
 * GET  /api/api-docs/sdk         — SDK 下载清单
 *
 * 变更（BE-B4）：
 *  - 由 Express 运行时路由表自动采集替代硬编码 ROUTE_MAP（spec 覆盖全部已注册路由）
 *  - 升级 OpenAPI 3.0.3 → 3.1.0
 *  - 版本号单一来源（lib/version.js）
 *  - 文档页内置轻量「Try it」控制台（填参 → 发送 → 看响应），无需外部 Swagger UI 资源
 *  - 同一规范亦暴露为 /openapi/openapi.json（见 routes/openapi.js）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { buildGlobalOpenApi } = require('../lib/api-doc');
const { PLATFORM_VERSION, API_VERSION, OPENAPI_VERSION, SDK_VERSION } = require('../lib/version');

const router = express.Router();

/** SDK 信息区块（文档页展示下载与三行代码用法） */
function sdkDownloads() {
  const dir = path.join(__dirname, '..', '..', 'public', 'downloads');
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^agent-platform-sdk-\d/.test(f) && f.endsWith('.tgz')) out.push({ name: f, lang: 'TypeScript/Node', url: '/downloads/' + f, kind: 'tgz' });
      if (/^agent_platform_sdk-\d/.test(f) && f.endsWith('.whl')) out.push({ name: f, lang: 'Python', url: '/downloads/' + f, kind: 'whl' });
    }
  } catch { /* 目录不存在时返回空 */ }
  return out;
}

/** SDK 元数据区块（spec.x-sdk） */
function sdkMeta() {
  return {
    name: 'agent-platform-sdk', version: SDK_VERSION,
    languages: ['TypeScript/Node', 'Python'],
    auth: 'agent_api_keys（Bearer sk-ap-xxx）',
    downloads: sdkDownloads(),
    quickstart: {
      typescript: "const { AgentPlatform } = require('agent-platform-sdk'); const ap = new AgentPlatform({ baseUrl, apiKey: 'sk-ap-xxx' }); const r = await ap.chat.completions.create({ model: 'agent-1-名称', messages: [{ role: 'user', content: '你好' }] });",
      python: "from agent_platform import AgentPlatform; ap = AgentPlatform(base_url, 'sk-ap-xxx'); r = ap.chat.completions.create(model='agent-1-名称', messages=[{'role': 'user', 'content': '你好'}])",
    },
  };
}

/** 构建全站规范（含 x-sdk 扩展） */
function buildSpec(app) {
  return buildGlobalOpenApi(app, {
    version: API_VERSION,
    extra: { 'x-sdk': sdkMeta(), 'x-platform-version': PLATFORM_VERSION },
  });
}

/* ---------- 路由 ---------- */

router.get('/openapi.json', (req, res) => {
  res.json(buildSpec(req.app));
});

router.get('/sdk', (req, res) => {
  res.json({ code: 0, data: { name: 'agent-platform-sdk', version: SDK_VERSION, downloads: sdkDownloads() } });
});

router.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API 文档 - 智能体开发平台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b0e15;color:#e8ecf5}
header{padding:16px 24px;border-bottom:1px solid #252a38;background:#0f1219;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
header h1{font-size:17px;font-weight:700;background:linear-gradient(135deg,#818cf8,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
header .sub{font-size:12px;color:#8b93a7;margin-top:2px}
header a{font-size:13px;color:#818cf8;text-decoration:none;padding:6px 14px;border:1px solid rgba(129,140,248,.3);border-radius:6px}
header a:hover{background:rgba(129,140,248,.1)}
.container{display:flex;height:calc(100vh - 66px)}
.side{width:280px;min-width:220px;border-right:1px solid #252a38;overflow-y:auto;padding:8px 0}
.side .grp{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5f6880;padding:10px 16px 4px}
.side a{display:block;padding:5px 16px;font-size:12.5px;color:#a8b0c4;text-decoration:none;border-left:3px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side a:hover,.side a.active{color:#e8ecf5;background:rgba(129,140,248,.06);border-left-color:#818cf8}
.main{flex:1;overflow-y:auto;padding:20px 28px}
.op{border:1px solid #252a38;border-radius:8px;margin-bottom:16px;overflow:hidden}
.op .head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#12161f}
.m{font-size:11px;font-weight:700;padding:2px 9px;border-radius:5px;color:#fff;text-transform:uppercase}
.m.get{background:#2563eb}.m.post{background:#16a34a}.m.put{background:#d97706}.m.patch{background:#7c3aed}.m.delete{background:#dc2626}
.op .path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#cbd5e1}
.op .sum{font-size:12px;color:#8b93a7;margin-left:auto;max-width:46%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op .body{padding:12px 14px;border-top:1px solid #252a38}
.op .body h4{font-size:12px;color:#a5b4fc;margin:10px 0 6px}
.op .body h4:first-child{margin-top:0}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:5px 9px;border:1px solid #252a38;text-align:left}
th{background:#1a1e2b;color:#c3cadd}
textarea,input{width:100%;background:#0b0e15;border:1px solid #303747;color:#e8ecf5;border-radius:6px;padding:7px 9px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
button{padding:6px 14px;border-radius:5px;border:1px solid #303747;background:#1a1e2b;color:#e8ecf5;cursor:pointer;font-size:12.5px}
button:hover{background:#232936}
.btn-run{margin-top:10px;background:#4338ca;border-color:#4338ca}
.btn-run:hover{background:#4f46e5}
.resp{margin-top:10px;background:#0b0e15;border:1px solid #303747;border-radius:6px;padding:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto;color:#a8b0c4}
.resp.ok{border-color:#166534}.resp.bad{border-color:#7f1d1d}
.badge{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;background:rgba(129,140,248,.16);color:#a5b4fc;border:1px solid rgba(129,140,248,.3);margin-left:8px}
.hint{font-size:12px;color:#6b7385;margin:6px 0 0;line-height:1.6}
@media(max-width:768px){.container{flex-direction:column;height:auto}.side{width:100%;max-height:180px;border-right:none;border-bottom:1px solid #252a38}.main{padding:14px}}
</style>
</head>
<body>
<header>
<div><h1>🚀 智能体开发平台 API</h1><div class="sub">平台 ${PLATFORM_VERSION} · OpenAPI ${OPENAPI_VERSION} · 运行时自动采集</div></div>
<a href="/api/api-docs/openapi.json" download>📥 下载 openapi.json</a>
</header>
<div class="container">
<nav class="side" id="nav"></nav>
<main class="main" id="main"><p class="hint">从左侧选择一个端点查看详情与试调。</p></main>
</div>
<script>
let spec = null;
const $ = (s) => document.querySelector(s);

async function boot() {
  spec = await (await fetch('/api/api-docs/openapi.json')).json();
  renderNav();
}

function renderNav() {
  const groups = {};
  for (const p of Object.keys(spec.paths).sort()) {
    const seg = p.replace(/^\\//,'').split('/');
    const t = ((seg[0] === 'api' || seg[0] === 'openapi') && seg[1]) ? seg[1] : (seg[0] || 'root');
    (groups[t] = groups[t] || []).push(p);
  }
  const html = [];
  for (const t of Object.keys(groups).sort()) {
    html.push('<div class="grp">' + t + ' (' + groups[t].length + ')</div>');
    for (const p of groups[t]) html.push('<a href="#" data-path="' + p + '">' + p + '</a>');
  }
  $('#nav').innerHTML = html.join('');
  $('#nav').querySelectorAll('a').forEach(a => a.onclick = (e) => { e.preventDefault(); show(a.dataset.path); });
}

function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

function show(p) {
  $('#nav').querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.path === p));
  const methods = spec.paths[p];
  const out = [];
  for (const m of Object.keys(methods)) {
    const op = methods[m];
    const params = (op.parameters || []).filter(x => x.in === 'path');
    const id = 'op-' + Math.random().toString(36).slice(2, 8);
    const rows = params.map(x =>
      '<tr><td><code>' + x.name + '</code></td><td>path</td><td>' + (x.schema && x.schema.type || 'string') + '</td><td>' +
      '<input data-role="param" data-name="' + x.name + '" placeholder="' + x.name + '"></td></tr>').join('');
    const hasBody = m === 'post' || m === 'put' || m === 'patch';
    out.push(
      '<div class="op"><div class="head"><span class="m ' + m + '">' + m + '</span><span class="path">' + esc(p) + '</span><span class="sum">' + esc(op.summary || '') + '</span></div>' +
      '<div class="body">' +
      (op.description ? '<p class="hint">' + esc(op.description) + '</p>' : '') +
      (rows ? '<h4>路径参数</h4><table><tr><th>名称</th><th>位置</th><th>类型</th><th>值</th></tr>' + rows + '</table>' : '') +
      (hasBody ? '<h4>请求体（JSON）</h4><textarea data-role="body" rows="5" placeholder="{ }"></textarea>' : '') +
      '<h4>响应</h4><table><tr><th>状态码</th><th>说明</th></tr>' +
        Object.keys(op.responses || {}).sort().map(c => '<tr><td>' + c + '</td><td>' + esc((op.responses[c] || {}).description || '') + '</td></tr>').join('') +
      '</table>' +
      '<button class="btn-run" data-method="' + m + '" data-path="' + esc(p) + '">▶ 试调</button>' +
      '<div class="resp" style="display:none"></div>' +
      '</div></div>');
  }
  $('#main').innerHTML = out.join('');
  $('#main').querySelectorAll('.btn-run').forEach(b => b.onclick = () => tryIt(b));
}

async function tryIt(btn) {
  const op = btn.closest('.op');
  const respEl = op.querySelector('.resp');
  let url = btn.dataset.path;
  op.querySelectorAll('input[data-role="param"]').forEach(inp => {
    url = url.replace('{' + inp.dataset.name + '}', encodeURIComponent(inp.value || inp.dataset.name));
  });
  const bodyEl = op.querySelector('[data-role="body"]');
  const opt = { method: btn.dataset.method.toUpperCase(), headers: { 'Accept': 'application/json' }, credentials: 'include' };
  if (bodyEl && bodyEl.value.trim()) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = bodyEl.value.trim();
  }
  btn.disabled = true; respEl.style.display = 'block'; respEl.className = 'resp'; respEl.textContent = '请求中…';
  try {
    const r = await fetch(url, opt);
    const text = await r.text();
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    respEl.className = 'resp ' + (r.ok ? 'ok' : 'bad');
    respEl.textContent = 'HTTP ' + r.status + ' ' + r.statusText + '\\n\\n' + pretty;
  } catch (e) {
    respEl.className = 'resp bad';
    respEl.textContent = '请求失败：' + e.message;
  } finally { btn.disabled = false; }
}

boot();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;
