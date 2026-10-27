/** MCP 服务管理：注册 / 测试 / 刷新工具清单 / 智能体挂载 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const mcp = require('../lib/mcp');

const router = express.Router();
router.use(auth);

// 列表（普通用户也可读，用于智能体挂载选择；API Key 不回传明文）
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
      return rest;
    }),
  });
});

// 新建（admin）
router.post('/', adminOnly, (req, res) => {
  const { name, url, api_key, transport } = req.body || {};
  if (!name?.trim() || !url?.trim()) return res.json({ code: 400, msg: '请填写服务名称与 URL' });
  const info = db.prepare(`INSERT INTO mcp_servers (name,url,api_key,transport,status,created_at) VALUES (?,?,?,?,1,datetime('now','localtime'))`)
    .run(name.trim(), url.trim(), api_key || '', transport === 'sse' ? 'sse' : 'http');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '注册MCP服务', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// 编辑（admin）——P5.32：trusted 信任开关（显式标记后才允许该服务的只读工具降为 low 免确认）
// P5.33 审查修复（R2/F9）：trusted 未传时保留原值——此前停用/启用按钮只传 status 会静默清零信任并写失真审计
router.put('/:id', adminOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const { name, url, api_key, transport, status, trusted } = req.body || {};
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
  try {
    const { tools, sessionId } = await mcp.listTools(server);
    db.prepare('UPDATE mcp_servers SET tools_cache=?, last_check_at=?, last_error=? WHERE id=?')
      .run(JSON.stringify(tools), now(), '', server.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '刷新MCP工具', `${server.name}（${tools.length} 个工具，低风险 ${tools.filter(t => t.risk === 'low').length} 个）`, req.ip, now());
    res.json({ code: 0, data: { count: tools.length, tools: tools.map(t => ({ name: t.originalName, desc: (t.description || '').slice(0, 100), risk: t.risk })) } });
  } catch (e) {
    db.prepare('UPDATE mcp_servers SET last_check_at=?, last_error=? WHERE id=?').run(now(), e.message, server.id);
    res.json({ code: 502, msg: '连接失败：' + e.message });
  }
});

// 预检 URL 连通性（未保存前测试）
router.post('/probe', adminOnly, async (req, res) => {
  const { url, api_key } = req.body || {};
  if (!url?.trim()) return res.json({ code: 400, msg: '请填写 URL' });
  try {
    const { tools } = await mcp.listTools({ url: url.trim(), api_key: api_key || '' });
    res.json({ code: 0, data: { count: tools.length, tools: tools.map(t => ({ name: t.originalName, desc: (t.description || '').slice(0, 100) })) } });
  } catch (e) {
    res.json({ code: 502, msg: '连接失败：' + e.message });
  }
});

module.exports = router;
