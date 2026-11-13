/**
 * P2-16 工具注册表统一化（2026-11-13）
 *
 * 内置工具、MCP 工具、子智能体工具同一注册表登记，提供查询和注册接口。
 * GET  /api/tools               — 全部已注册工具列表
 * GET  /api/tools/:name         — 单个工具详情
 * GET  /api/tools/categories    — 工具分类列表（用于前端筛选）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { TOOL_DEFS } = require('../lib/tools');

const router = express.Router();
router.use(auth);

/** 所有已注册工具（TOOL_DEFS + MCP 工具 + 子智能体工具） */
function getAllTools() {
  const tools = [];

  // 1) 内置工具
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    let category = 'builtin';
    let risk = 'low';
    let schema = null;
    try {
      if (def.schema && def.schema.function) {
        schema = def.schema.function;
        if (schema.description) {
          if (schema.description.includes('危险') || schema.description.includes('系统') || schema.description.includes('admin')) {
            risk = 'high';
          }
        }
      }
    } catch { }
    tools.push({
      name,
      type: 'builtin',
      category,
      risk,
      description: def.schema ? (def.schema.function && def.schema.function.description) || schema?.description || name : name,
      parameters: (schema && schema.parameters) ? schema.parameters : null,
    });
  }

  // 2) MCP 工具
  try {
    const mcpServers = db.prepare('SELECT * FROM mcp_servers').all();
    for (const s of mcpServers) {
      let tc = [];
      try { tc = JSON.parse(s.tools_cache || '[]'); } catch { tc = []; }
      for (const t of tc) {
        tools.push({
          name: `${t.name}@${s.id}`,
          type: 'mcp',
          category: 'mcp',
          risk: 'high',
          description: t.description || t.name || '',
          server_id: s.id,
          server_name: s.name || '',
        });
      }
    }
  } catch { }

  // 3) 子智能体工具
  try {
    const agents = db.prepare("SELECT id, name, description FROM agents WHERE status='published' AND source NOT IN ('system','platform')").all();
    for (const a of agents) {
      tools.push({
        name: `agent:${a.id}`,
        type: 'sub_agent',
        category: 'sub_agent',
        risk: 'low',
        description: a.description || a.name || '',
        agent_id: a.id,
        agent_name: a.name,
      });
    }
  } catch { }

  return tools;
}

router.get('/', (req, res) => {
  const { type, category, risk, q, page = 1, pageSize = 100 } = req.query;
  let list = getAllTools();
  if (type) list = list.filter(t => t.type === type);
  if (category) list = list.filter(t => t.category === category);
  if (risk) list = list.filter(t => t.risk === risk);
  if (q) {
    const query = String(q).toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(query) || (t.description && t.description.toLowerCase().includes(query)));
  }
  const total = list.length;
  const start = (+page - 1) * +pageSize;
  const paged = list.slice(start, start + +pageSize);
  res.json({ code: 0, data: { list: paged, total, page: +page, pageSize: +pageSize } });
});

router.get('/categories', (req, res) => {
  const list = getAllTools();
  const cats = {};
  for (const t of list) {
    if (!cats[t.category]) cats[t.category] = { category: t.category, count: 0, types: {} };
    cats[t.category].count++;
    if (!cats[t.category].types[t.type]) cats[t.category].types[t.type] = 0;
    cats[t.category].types[t.type]++;
  }
  res.json({ code: 0, data: Object.values(cats) });
});

router.get('/:name', (req, res) => {
  const all = getAllTools();
  const tool = all.find(t => t.name === req.params.name);
  if (!tool) return res.json({ code: 404, msg: '工具不存在' });
  res.json({ code: 0, data: tool });
});

module.exports = router;