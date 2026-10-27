/** 任务管理：CRUD / 立即执行 / 执行记录 */
const express = require('express');
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { runTask } = require('../lib/scheduler');
const { parseCron } = require('../lib/cron');

const router = express.Router();

// P5.8 #11 Webhook 触发端点（免 auth，token 鉴权）——须在 router.use(auth) 之前注册
// POST /api/tasks/webhook/:token  body 可传 {input|message|text|content} 覆盖默认输入；兼容企业微信/钉钉格式
router.post('/webhook/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const task = db.prepare('SELECT * FROM tasks WHERE webhook_token=? AND enabled=1').get(token);
  if (!task) return res.status(404).json({ code: 404, msg: 'Webhook 不存在或已停用' });
  if (task.exec_type !== 'webhook') return res.status(400).json({ code: 400, msg: '该任务未启用 Webhook 触发模式' });
  // 请求体覆盖默认 input：body.input / message / text / content / text.content（兼容企微钉钉）
  let input = '';
  const b = req.body;
  if (b && typeof b === 'object') {
    input = String(b.input || b.message || (b.text && b.text.content) || b.content || '').trim();
  } else if (typeof b === 'string') {
    input = b.trim();
  }
  if (input) {
    try { const p = JSON.parse(task.params || '{}'); p.input = input; task.params = JSON.stringify(p); } catch { /* 保持原 params */ }
  }
  try {
    const r = await runTask(task);
    res.json({ code: 0, data: { status: r.status, output: r.output } });
  } catch (e) {
    res.status(500).json({ code: 500, msg: 'Webhook 执行失败：' + e.message });
  }
});

router.use(auth);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.target_id
    ORDER BY t.id DESC`).all();
  res.json({ code: 0, data: rows });
});

router.post('/', (req, res) => {
  const { name, target_id, exec_type, cron, params } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '任务名称不能为空' });
  if (!target_id) return res.json({ code: 400, msg: '请选择任务主体（智能体）' });
  if (exec_type === 'cron' && (!cron || !parseCron(cron))) return res.json({ code: 400, msg: 'Cron 表达式不合法（五段：分 时 日 月 周，如 0 9 * * *）' });
  // P5.8 #11：exec_type 支持 once/cron/webhook；webhook 自动生成鉴权 token
  const et = exec_type === 'cron' ? 'cron' : (exec_type === 'webhook' ? 'webhook' : 'once');
  const webhookToken = et === 'webhook' ? 'whk_' + crypto.randomBytes(16).toString('hex') : '';
  const info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,webhook_token,enabled,created_at)
    VALUES (?, 'agent', ?, ?, ?, ?, ?, 1, datetime('now','localtime'))`)
    .run(name.trim(), target_id, et, et === 'cron' ? cron : null, params || '{}', webhookToken);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建任务', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, webhook_token: webhookToken || undefined } });
});

// P5.8 #11：生成/重置 Webhook token（启用 webhook 触发；返回完整调用 URL）
router.post('/:id/webhook-token', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '任务不存在' });
  const token = 'whk_' + crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE tasks SET exec_type='webhook', webhook_token=? WHERE id=?").run(token, old.id);
  const host = req.get('host') || `localhost:${process.env.PORT || 3210}`;
  res.json({ code: 0, data: { webhook_token: token, url: `http://${host}/api/tasks/webhook/${token}` }, msg: 'Webhook 已启用' });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '任务不存在' });
  const { name, target_id, exec_type, cron, params } = req.body || {};
  if (exec_type === 'cron' && (!cron || !parseCron(cron))) return res.json({ code: 400, msg: 'Cron 表达式不合法' });
  const et = exec_type === 'cron' ? 'cron' : (exec_type === 'webhook' ? 'webhook' : (exec_type || old.exec_type));
  db.prepare('UPDATE tasks SET name=?,target_id=?,exec_type=?,cron=?,params=? WHERE id=?')
    .run(name || old.name, target_id || old.target_id, et, et === 'cron' ? (cron || old.cron) : null, params ?? old.params, old.id);
  res.json({ code: 0, msg: '已保存' });
});

router.post('/:id/toggle', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '任务不存在' });
  db.prepare('UPDATE tasks SET enabled=? WHERE id=?').run(old.enabled ? 0 : 1, old.id);
  res.json({ code: 0, msg: old.enabled ? '已停用' : '已启用' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM task_runs WHERE task_id=?').run(req.params.id);
  if (old) db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除任务', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

router.post('/:id/run', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.json({ code: 404, msg: '任务不存在' });
  if (!task.enabled) return res.json({ code: 400, msg: '任务已停用，无法执行' });
  const r = await runTask(task);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '手动执行任务', `${task.name}（${r.status === 'success' ? '成功' : '失败'}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

router.get('/:id/runs', (req, res) => {
  res.json({ code: 0, data: db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC LIMIT 50').all(req.params.id) });
});

module.exports = router;
