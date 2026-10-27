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
      try { tools = JSON.parse(s.tools_cache || '[]'); } catch { }
      rest.toolNames = tools.map(t => t.originalName || t.name);
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

// 编辑（admin）
router.put('/:id', adminOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: 'MCP 服务不存在' });
  const { name, url, api_key, transport, status } = req.body || {};
  db.prepare('UPDATE mcp_servers SET name=?,url=?,api_key=?,transport=?,status=? WHERE id=?')
    .run(name || old.name, url || old.url, api_key !== undefined ? api_key : old.api_key, transport || old.transport, status ?? old.status, old.id);
  res.json({ code: 0, msg: '已保存' });
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
      .run(req.user.username, '刷新MCP工具', `${server.name}（${tools.length} 个工具）`, req.ip, now());
    res.json({ code: 0, data: { count: tools.length, tools: tools.map(t => ({ name: t.originalName, desc: (t.description || '').slice(0, 100) })) } });
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
