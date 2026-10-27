/** 技能资产（2026-10-20 P3 技能资产化）：可复用的「提示词+工具」组合
 *  前台「技能」页浏览/创建/管理；对话输入 @技能名 即调用（chat.js /stream 解析注入）。
 *  可见性：status=1 已发布（全员可见可 @ 引用），status=0 私有（仅本人）。
 *  技能名限制中文/字母/数字/下划线/中划线且 ≤20 字（@解析按标记精确匹配需要短名）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { TOOL_DEFS, AGENT_TOOL_DENY } = require('../lib/tools');

const router = express.Router();
router.use(auth);

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/;

function normSkill(row, username) {
  let tools = [];
  try { tools = JSON.parse(row.tools || '[]'); } catch { }
  return { ...row, tools, mine: row.owner === username };
}

// 技能列表：本人全部（含私有）在前 + 他人已发布在后
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM skill_assets WHERE owner=? OR status=1 ORDER BY owner=? DESC, id DESC')
    .all(req.user.username, req.user.username);
  res.json({ code: 0, data: rows.map(r => normSkill(r, req.user.username)) });
});

router.post('/', (req, res) => {
  const { name, description, icon, prompt, tools, status } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.json({ code: 400, msg: '技能名称不能为空' });
  if (!NAME_RE.test(n)) return res.json({ code: 400, msg: '名称仅支持中文/字母/数字/下划线/中划线，且不超过 20 字（@调用需要短名）' });
  if (!String(prompt || '').trim()) return res.json({ code: 400, msg: '提示词不能为空——技能的核心是提示词' });
  if (db.prepare('SELECT id FROM skill_assets WHERE owner=? AND name=?').get(req.user.username, n)) {
    return res.json({ code: 400, msg: '你已有同名技能' });
  }
  // P5.34b（审查 F3）：技能工具白名单——排除违禁（create_task/local_exec，防 API 直调注入后借 @技能
  // 在 auto 权限下静默外设操作/造任务）与未知工具（保留剔除语义，同 agents import 口径）
  const toolIds = (Array.isArray(tools) ? tools : []).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
  const info = db.prepare('INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.username, n, String(description || '').slice(0, 200), String(icon || '✨').slice(0, 4),
      String(prompt).slice(0, 4000), JSON.stringify(toolIds), status ? 1 : 0, now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '创建技能', `${n}（${toolIds.length ? '工具：' + toolIds.join('/') : '纯提示词' }，${status ? '已发布' : '私有'}）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM skill_assets WHERE id=? AND owner=?').get(req.params.id, req.user.username);
  if (!old) return res.json({ code: 404, msg: '技能不存在（只能编辑自己的技能）' });
  const { name, description, icon, prompt, tools, status } = req.body || {};
  const n = String(name ?? old.name).trim();
  if (!NAME_RE.test(n)) return res.json({ code: 400, msg: '名称仅支持中文/字母/数字/下划线/中划线，且不超过 20 字' });
  if (!String(prompt ?? (old.prompt || '')).trim()) return res.json({ code: 400, msg: '提示词不能为空' });
  const dup = db.prepare('SELECT id FROM skill_assets WHERE owner=? AND name=? AND id != ?').get(req.user.username, n, old.id);
  if (dup) return res.json({ code: 400, msg: '你已有同名技能' });
  const toolIds = (Array.isArray(tools) ? tools : JSON.parse(old.tools || '[]')).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t)); // P5.34b：同 POST 口径排除违禁
  db.prepare('UPDATE skill_assets SET name=?,description=?,icon=?,prompt=?,tools=?,status=? WHERE id=?')
    .run(n, String(description ?? old.description).slice(0, 200), String(icon ?? old.icon).slice(0, 4),
      String(prompt ?? old.prompt).slice(0, 4000), JSON.stringify(toolIds),
      status == null ? old.status : (status ? 1 : 0), old.id);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM skill_assets WHERE id=? AND owner=?').run(req.params.id, req.user.username);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
