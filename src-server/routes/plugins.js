/**
 * U2-3 插件运行时管理路由（2026-11-16）
 *
 * GET    /api/plugins                          — 已安装插件列表（含启用状态与版本信息）
 * GET    /api/plugins/:id                      — 插件详情
 * POST   /api/plugins/install                  — 安装插件（从 market_hub 远程或直接指定 plugin_id）
 * POST   /api/plugins/:id/uninstall            — 卸载插件
 * POST   /api/plugins/:id/toggle               — 启用/停用
 * POST   /api/plugins/:id/test                 — 沙箱试运行（安装后验证可用性）
 * GET    /api/plugins/remote/sync              — 同步远程市场 hub 列表（刷新 market_hubs）
 *
 * 与 skills-market 的关系：
 *   skills-market.js 负责市场浏览/克隆/收藏（前端消费侧）；
 *   plugins.js 负责插件的安装/卸载/运行时管理（后台管理侧）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

/* ---------- 插件列表 ---------- */
router.get('/', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM plugins ORDER BY id DESC').all();
  res.json({ code: 0, data: rows });
});

/* ---------- 插件详情 ---------- */
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM plugins WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '插件不存在' });
  res.json({ code: 0, data: p });
});

/* ---------- 安装插件 ---------- */
router.post('/install', adminOnly, async (req, res) => {
  const { plugin_id, name, entry, runtime, settings_schema, description, version, author, permissions, permissions_file } = req.body || {};
  if (!plugin_id) return res.json({ code: 400, msg: '插件 ID 不能为空' });
  if (!entry) return res.json({ code: 400, msg: '插件入口文件不能为空' });

  // 幂等：已存在同 plugin_id 则 UPDATE（覆盖安装）
  const exist = db.prepare('SELECT * FROM plugins WHERE plugin_id=?').get(plugin_id);
  if (exist) {
    db.prepare('UPDATE plugins SET name=?,name_en=?,type=?,entry=?,icon=?,description=?,version=?,author=?,runtime=?,settings_schema=?,permissions=?,updated_at=? WHERE id=?')
      .run(name || exist.name, '', 'tool', entry, '🧩', description || '', version || '1.0.0', author || 'system', runtime || 'node', _js(settings_schema || '{}'), _js(permissions || '[]'), now(), exist.id);
    // 卸载后重新加载（刷新 TOOL_DEFS）
    const { unloadPlugin, loadPlugin } = require('../lib/plugin-loader');
    unloadPlugin(plugin_id);
    if (enabled !== false) {
      exist.enabled = 1;
      loadPlugin(exist);
    }
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '更新插件', plugin_id, req.ip, now());
    return res.json({ code: 0, msg: '插件已更新', data: { id: exist.id, updated: true } });
  }

  // 新增安装
  const info = db.prepare('INSERT INTO plugins (plugin_id,name,type,entry,icon,description,version,author,runtime,settings_schema,permissions,enabled,installed_by,installed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)')
    .run(plugin_id, name || plugin_id, 'tool', entry, '🧩', description || '', version || '1.0.0', author || 'system', runtime || 'node', _js(settings_schema || '{}'), _js(permissions || '[]'), req.user.username, now(), now(), now());
  // 自动加载到 TOOL_DEFS
  const { loadPlugin } = require('../lib/plugin-loader');
  loadPlugin(info.lastInsertRowid);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '安装插件', plugin_id, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: '插件已安装' });
});

/* ---------- 卸载插件 ---------- */
router.post('/:id/uninstall', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM plugins WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '插件不存在' });
  const { unloadPlugin } = require('../lib/plugin-loader');
  unloadPlugin(p.plugin_id);
  db.prepare('DELETE FROM plugins WHERE id=?').run(p.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '卸载插件', p.plugin_id, req.ip, now());
  res.json({ code: 0, msg: '已卸载' });
});

/* ---------- 启用/停用 ---------- */
router.post('/:id/toggle', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM plugins WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '插件不存在' });
  const next = p.enabled ? 0 : 1;
  db.prepare('UPDATE plugins SET enabled=?,updated_at=? WHERE id=?').run(next, now(), p.id);
  const { loadPlugin, unloadPlugin } = require('../lib/plugin-loader');
  if (next) loadPlugin(p.id);
  else unloadPlugin(p.plugin_id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, next ? '启用插件' : '停用插件', p.plugin_id, req.ip, now());
  res.json({ code: 0, msg: next ? '已启用' : '已停用' });
});

/* ---------- 沙箱试运行（安装后验证） ---------- */
router.post('/:id/test', adminOnly, async (req, res) => {
  const p = db.prepare('SELECT * FROM plugins WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '插件不存在' });
  const { runIsolated } = require('../lib/sandbox');
  try {
    const args = req.body?.args || '{}';
    const result = await runIsolated({
      code: p.entry,
      args: typeof args === 'string' ? JSON.parse(args) : args,
      timeoutMs: 30000,
      runtime: p.runtime || 'node',
    });
    res.json({ code: 0, data: result, msg: '试运行成功' });
  } catch (e) {
    res.json({ code: 400, msg: '试运行失败：' + e.message });
  }
});

/* ---------- 远程市场同步（刷新 market_hubs） ---------- */
router.get('/remote/sync', adminOnly, async (req, res) => {
  const { loadAllSync, listHubs, syncOne } = require('../lib/market-sync');
  try {
    const result = await loadAllSync();
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: 500, msg: '同步失败：' + e.message });
  }
});

// 工具：JSON 容错
function _js(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v || ''); }
}

module.exports = router;
