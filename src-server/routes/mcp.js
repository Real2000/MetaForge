/** MCP 服务管理：注册 / 测试 / 刷新工具清单 / 智能体挂载
 *  D2-4 连接器广场：目录（catalog）一键安装 + 凭证托管（加密/掩码）+ 统一连通测试 + 工具级风险分级。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const mcp = require('../lib/mcp');
const catalog = require('../lib/mcp-catalog');
const creds = require('../lib/mcp-credentials');
const { assertPublicHttpUrl } = require('../lib/ssrf-guard'); // SEC-05：MCP 服务 URL 的 SSRF 校验

/** SEC-05：对 MCP 服务 URL 做 SSRF 校验（跳过含 {{占位符}} 的模板 URL，渲染后再校验由 listTools 承担） */
async function checkServerUrl(url) {
  const s = String(url || '').trim();
  if (!s || s.includes('{{')) return;
  await assertPublicHttpUrl(s);
}

const router = express.Router();
router.use(auth);

/** 解析服务连接参数：托管凭据解密 + URL 占位符渲染（明文仅内存态，不落日志） */
function resolveServer(row) {
  let secrets = {};
  try { secrets = creds.getSecrets(row.id); } catch { secrets = {}; }
  const apiKey = creds.API_KEY_NAMES.map(n => secrets[n]).find(Boolean) || row.api_key || '';
  return { ...row, api_key: apiKey, url: creds.renderUrl(row.url, secrets) };
}

/** 列表（普通用户也可读，用于智能体挂载选择；API Key 不回传明文）
 *  D2-4：附凭据名清单（不回值）、健康态与风险摘要。 */
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY id DESC').all();
  res.json({
    code: 0,
    data: rows.map(s => {
      const { api_key, ...rest } = s;
      rest.api_key_set = api_key ? 1 : 0;
      let tools = [];
      let overrides = {};
      try { tools = JSON.parse(s.tools_cache || '[]'); } catch { }
      try { overrides = JSON.parse(s.risk_overrides || '{}') || {}; } catch { overrides = {}; }
      rest.toolNames = tools.map(t => t.originalName || t.name);
      // P5.32：工具级风险分级清单（徽标展示；低风险仅在 trusted=1 时对话中免确认）
      // P5.34：人工标注优先——risk 为生效值（override ?? 启发式），override 非空表示管理员已手动定级
      rest.toolList = tools.map(t => {
        const ov = overrides[t.originalName] || null;
        return { name: t.originalName || t.name, risk: ov || (t.risk === 'low' ? 'low' : 'high'), override: ov };
      });
      // D2-4：凭据名清单（掩码，不回值）+ 健康态 + 风险摘要
      try { rest.credentials = creds.listSecrets(s.id).map(c => ({ name: c.name, masked: c.masked })); }
      catch { rest.credentials = []; }
      if (rest.credentials.length) rest.api_key_set = 1;
      rest.health = catalog.healthOf(s);
      rest.risk = catalog.riskSummary(tools);
      return rest;
    }),
  });
});

// 新建（admin）
router.post('/', adminOnly, async (req, res) => {
  const { name, url, api_key, transport } = req.body || {};
  if (!name?.trim() || !url?.trim()) return res.json({ code: 400, msg: '请填写服务名称与 URL' });
  try { await checkServerUrl(url.trim()); } catch (e) { return res.json({ code: 400, msg: e.message }); }
  const info = db.prepare(`INSERT INTO mcp_servers (name,url,api_key,transport,status,created_at) VALUES (?,?,?,?,1,datetime('now','localtime'))`)
    .run(name.trim(), url.trim(), api_key || '', transport === 'sse' ? 'sse' : 'http');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '注册MCP服务', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// 编辑（admin）——P5.32：trusted 信任开关（显式标记后才允许该服务的只读工具降为 low 免确认）
// P5.33 审查修复（R2/F9）：trusted 未传时保留原值——此前停用/启用按钮只传 status 会静默清零信任并写失真审计
router.put('/:id', adminOnly, async (req, res) => {
  const old = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const { name, url, api_key, transport, status, trusted } = req.body || {};
  if (url && String(url).trim() !== old.url) { try { await checkServerUrl(url.trim()); } catch (e) { return res.json({ code: 400, msg: e.message }); } }
  const nextTrusted = trusted !== undefined ? (trusted === 1 || trusted === true ? 1 : 0) : (old.trusted ? 1 : 0);
  if (nextTrusted !== (old.trusted ? 1 : 0)) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, nextTrusted ? '信任MCP服务' : '取消信任MCP服务', `${old.name}（${nextTrusted ? '只读工具免确认' : '全部工具恢复确认'}）`, req.ip, now());
  }
  db.prepare('UPDATE mcp_servers SET name=?,url=?,api_key=?,transport=?,status=?,trusted=? WHERE id=?')
    .run(name || old.name, url || old.url, api_key !== undefined ? api_key : old.api_key, transport || old.transport, status ?? old.status, nextTrusted, old.id);
  res.json({ code: 0, msg: '已保存' });
});

// P5.34：管理员逐工具人工定级（人工值优先于启发式）——level: 'low'|'high' 显式定级，
// 'auto' 清除标注回落启发式。人工 high 恒 high（即使 server trusted）；人工 low 仅在 trusted=1 时免确认
router.put('/:id/tool-risk', adminOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const { tool, level } = req.body || {};
  const toolName = String(tool || '').trim();
  if (!toolName) return res.json({ code: 400, msg: '缺少工具名（tool）' });
  if (!['low', 'high', 'auto'].includes(level)) return res.json({ code: 400, msg: 'level 仅支持 low / high / auto（auto=清除标注回落启发式）' });
  // 工具需在已拉取的清单内（防任意 key 注入）
  let tools = [];
  try { tools = JSON.parse(old.tools_cache || '[]'); } catch { }
  if (!tools.some(t => (t.originalName || t.name) === toolName)) {
    return res.json({ code: 400, msg: `工具「${toolName}」不在清单中，请先「刷新工具」` });
  }
  let overrides = {};
  try { overrides = JSON.parse(old.risk_overrides || '{}') || {}; } catch { overrides = {}; }
  if (level === 'auto') delete overrides[toolName];
  else overrides[toolName] = level;
  db.prepare('UPDATE mcp_servers SET risk_overrides=? WHERE id=?').run(JSON.stringify(overrides), old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, 'MCP工具定级', `${old.name} / ${toolName} → ${level === 'auto' ? '自动（启发式）' : level}`, req.ip, now());
  res.json({ code: 0, msg: level === 'auto' ? '已恢复启发式定级' : `已定级为 ${level === 'low' ? '低风险（只读）' : '高风险（写类）'}` });
});

// 删除（admin）
router.delete('/:id', adminOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  creds.purgeServer(old.id); // D2-4：级联清理托管凭据，避免孤立密文
  db.prepare('DELETE FROM mcp_servers WHERE id=?').run(old.id);
  // 解除全部智能体挂载
  const agents = db.prepare("SELECT id, mcp_servers FROM agents WHERE mcp_servers != '[]'").all();
  agents.forEach(a => {
    try {
      const ids = JSON.parse(a.mcp_servers || '[]').filter(id => id !== old.id);
      db.prepare('UPDATE agents SET mcp_servers=? WHERE id=?').run(JSON.stringify(ids), a.id);
    } catch { }
  });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除MCP服务', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// 测试连接 + 刷新工具清单（admin）
router.post('/:id/refresh', adminOnly, async (req, res) => {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!server) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const t0 = Date.now();
  try {
    const { tools } = await mcp.listTools(resolveServer(server));
    const latency = Date.now() - t0;
    db.prepare('UPDATE mcp_servers SET tools_cache=?, last_check_at=?, last_error=?, last_tool_count=?, last_latency_ms=?, last_test_at=? WHERE id=?')
      .run(JSON.stringify(tools), now(), '', tools.length, latency, now(), server.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '刷新MCP工具', `${server.name}（${tools.length} 个工具，低风险 ${tools.filter(t => t.risk === 'low').length} 个，${latency}ms）`, req.ip, now());
    res.json({ code: 0, data: { count: tools.length, latency_ms: latency, tools: tools.map(t => ({ name: t.originalName, desc: (t.description || '').slice(0, 100), risk: t.risk })) } });
  } catch (e) {
    db.prepare('UPDATE mcp_servers SET last_check_at=?, last_error=?, last_test_at=? WHERE id=?').run(now(), e.message, now(), server.id);
    res.json({ code: 502, msg: '连接失败：' + e.message });
  }
});

// D2-4：统一连通测试（admin）——连接 + 拉清单 + 计时 + 风险摘要 + 健康态
router.post('/:id/test', adminOnly, async (req, res) => {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!server) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const t0 = Date.now();
  try {
    const { tools } = await mcp.listTools(resolveServer(server));
    const latency = Date.now() - t0;
    db.prepare('UPDATE mcp_servers SET tools_cache=?, last_check_at=?, last_error=?, last_tool_count=?, last_latency_ms=?, last_test_at=? WHERE id=?')
      .run(JSON.stringify(tools), now(), '', tools.length, latency, now(), server.id);
    const fresh = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(server.id);
    res.json({ code: 0, data: { ok: true, latency_ms: latency, tool_count: tools.length, risk: catalog.riskSummary(tools), health: catalog.healthOf(fresh) } });
  } catch (e) {
    db.prepare('UPDATE mcp_servers SET last_error=?, last_test_at=? WHERE id=?').run(e.message, now(), server.id);
    const fresh = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(server.id);
    res.json({ code: 502, msg: '连接失败：' + e.message, data: { ok: false, health: catalog.healthOf(fresh) } });
  }
});

// 预检 URL 连通性（未保存前测试）
router.post('/probe', adminOnly, async (req, res) => {
  const { url, api_key } = req.body || {};
  if (!url?.trim()) return res.json({ code: 400, msg: '请填写 URL' });
  try {
    await checkServerUrl(url.trim());
    const { tools } = await mcp.listTools({ url: url.trim(), api_key: api_key || '' });
    res.json({ code: 0, data: { count: tools.length, tools: tools.map(t => ({ name: t.originalName, desc: (t.description || '').slice(0, 100) })) } });
  } catch (e) {
    res.json({ code: 502, msg: '连接失败：' + e.message });
  }
});

/* ---------------- D2-4 连接器广场 ---------------- */

/** 广场目录（登录即可浏览；已安装项附健康态、工具数、风险摘要与凭据名） */
router.get('/catalog', (req, res) => {
  const { items, categories } = catalog.listCatalog({
    type: req.query.type, category: req.query.category, q: req.query.q,
  });
  const servers = db.prepare('SELECT * FROM mcp_servers').all();
  const data = items.map(e => {
    const hit = catalog.matchInstalled(e, servers);
    let tools = [];
    try { tools = JSON.parse((hit && hit.tools_cache) || '[]'); } catch { }
    return {
      ...e,
      installed: !!hit,
      installed_id: hit ? hit.id : null,
      installed_name: hit ? hit.name : '',
      health: catalog.healthOf(hit),
      tool_count: hit ? (hit.last_tool_count || tools.length) : 0,
      risk: hit ? catalog.riskSummary(tools) : null,
      credential_names: hit ? creds.listSecrets(hit.id).map(c => c.name) : e.credentials.map(c => c.name),
    };
  });
  res.json({ code: 0, data: { items: data, categories } });
});

/** 一键安装（admin）：按目录条目创建 MCP 服务 + 托管凭据 + 首测连通 */
router.post('/install', adminOnly, async (req, res) => {
  const { catalog_id, name, url, trusted, credentials } = req.body || {};
  const entry = catalog.getEntry(catalog_id);
  if (!entry) return res.json({ code: 400, msg: '目录条目不存在：' + catalog_id });
  if (entry.type !== 'mcp') return res.json({ code: 400, msg: '该条目为异构平台，请在「接入管理」内配置' });

  const finalName = String(name || entry.name).trim();
  const finalUrl = String(url || entry.url).trim();
  if (!finalName || !finalUrl) return res.json({ code: 400, msg: '服务名称与 URL 必填' });

  // 必填凭据校验
  const provided = (credentials && typeof credentials === 'object') ? credentials : {};
  const missing = catalog.requiredCredentials(entry).filter(n => !String(provided[n] || '').trim());
  if (missing.length) return res.json({ code: 400, msg: '缺少必填凭据：' + missing.join('、') });

  // 同目录已安装 → 覆盖升级（保留 id，更新 url/trusted）
  const exist = db.prepare("SELECT id FROM mcp_servers WHERE catalog_id=?").get(entry.id);
  const nextTrusted = trusted !== undefined ? (trusted ? 1 : 0) : entry.defaultTrusted;
  let id, upgraded = false;
  if (exist) {
    db.prepare('UPDATE mcp_servers SET name=?,url=?,transport=?,trusted=?,status=1 WHERE id=?')
      .run(finalName, finalUrl, entry.transport, nextTrusted, exist.id);
    id = exist.id; upgraded = true;
  } else {
    const info = db.prepare("INSERT INTO mcp_servers (name,url,api_key,transport,status,trusted,catalog_id,source,created_at) VALUES (?,?,'',?,1,?,?,'catalog',datetime('now','localtime'))")
      .run(finalName, finalUrl, entry.transport, nextTrusted, entry.id);
    id = Number(info.lastInsertRowid);
  }

  // 托管凭据（加密落盘）
  const savedCreds = [];
  for (const c of entry.credentials) {
    const v = String(provided[c.name] || '').trim();
    if (!v) continue;
    const r = creds.setSecret(id, c.name, v);
    if (r.ok) savedCreds.push(c.name);
  }

  // 首测连通（非致命）
  let tested = { ok: false, tool_count: 0, latency_ms: 0 };
  try {
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);
    const t0 = Date.now();
    const { tools } = await mcp.listTools(resolveServer(server));
    const latency = Date.now() - t0;
    db.prepare('UPDATE mcp_servers SET tools_cache=?,last_check_at=?,last_error=?,last_tool_count=?,last_latency_ms=?,last_test_at=? WHERE id=?')
      .run(JSON.stringify(tools), now(), '', tools.length, latency, now(), id);
    tested = { ok: true, tool_count: tools.length, latency_ms: latency };
  } catch (e) {
    db.prepare('UPDATE mcp_servers SET last_error=?,last_test_at=? WHERE id=?').run(e.message, now(), id);
    tested = { ok: false, error: e.message, tool_count: 0, latency_ms: 0 };
  }

  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, upgraded ? '广场升级连接器' : '广场安装连接器',
      `${entry.name}（来源 ${entry.id}，凭据 ${savedCreds.join('/') || '无'}，${tested.ok ? '连通 ' + tested.tool_count + ' 工具' : '连通失败'}）`, req.ip, now());

  res.json({ code: 0, msg: upgraded ? '连接器已更新' : '连接器已安装', data: { id, name: finalName, catalog_id: entry.id, upgraded, credentials: savedCreds, tested, health: catalog.healthOf(db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id)) } });
});

/** 凭证列表（admin，掩码回显） */
router.get('/:id/credentials', adminOnly, (req, res) => {
  const server = db.prepare('SELECT id FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!server) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  res.json({ code: 0, data: creds.listSecrets(server.id) });
});

/** 写入/更新凭证（admin） */
router.post('/:id/credentials', adminOnly, (req, res) => {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!server) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const { name, value } = req.body || {};
  const r = creds.setSecret(server.id, name, value);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '配置连接器凭据', `${server.name} / ${r.name}（${r.action}）`, req.ip, now());
  res.json({ code: 0, msg: r.action === 'created' ? '凭据已保存' : '凭据已更新', data: { name: r.name } });
});

/** 删除凭证（admin） */
router.delete('/:id/credentials/:name', adminOnly, (req, res) => {
  const server = db.prepare('SELECT id FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!server) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  creds.deleteSecret(server.id, req.params.name);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;

