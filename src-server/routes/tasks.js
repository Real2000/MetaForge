/** 任务管理：CRUD / 立即执行 / 执行记录（P5.31：任务归属——创建者自有，管理员全局可见可管） */
const express = require('express');
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { runTask } = require('../lib/scheduler');
const { parseCron } = require('../lib/cron');
const { canView } = require('../lib/agent-access');

const router = express.Router();

// P5.31 归属校验：任务仅创建者或管理员可管（历史任务 username='' 视为管理员创建）；只读接口单独过滤
function denyIfNotTaskOwner(task, user) {
  if (!task) return { code: 404, msg: '任务不存在' };
  if (user.role === 'admin') return null;
  if (task.username && task.username === user.username) return null;
  return { code: 403, msg: '无权管理该任务（仅创建者或管理员）' };
}

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
  // P5.31：非管理员仅见自己创建的任务（此前全部任务对所有用户可见可删——越权面）；管理员全局可见
  const where = req.user.role === 'admin' ? '' : ' WHERE t.username=?';
  const args = req.user.role === 'admin' ? [] : [req.user.username];
  const rows = db.prepare(`
    SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.target_id${where}
    ORDER BY t.id DESC`).all(...args);
  res.json({ code: 0, data: rows });
});

router.post('/', (req, res) => {
  const { name, target_id, exec_type, cron, params } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '任务名称不能为空' });
  if (!target_id) return res.json({ code: 400, msg: '请选择任务主体（智能体）' });
  // P5.31：非管理员绑定智能体需有使用权限（与对话链路 canView 同权限，防绑定受限智能体借定时任务越权调用）
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(target_id);
  if (!agent || agent.status !== 'published') return res.json({ code: 400, msg: '目标智能体不存在或未发布' });
  if (req.user.role !== 'admin' && !canView(agent, req.user)) return res.json({ code: 403, msg: '无权绑定该智能体（未对你开放）' });
  if (exec_type === 'cron' && (!cron || !parseCron(cron))) return res.json({ code: 400, msg: 'Cron 表达式不合法（五段：分 时 日 月 周，如 0 9 * * *）' });
  // P5.31：非管理员任务数量配额（防批量造任务烧 token；与 create_task 工具同限）
  if (req.user.role !== 'admin') {
    const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE username=? AND enabled=1').get(req.user.username).c;
    if (cnt >= 20) return res.json({ code: 400, msg: '已达任务数量上限（20 个启用中），请先停用或删除不需要的任务' });
  }
  // P5.8 #11：exec_type 支持 once/cron/webhook；webhook 自动生成鉴权 token
  const et = exec_type === 'cron' ? 'cron' : (exec_type === 'webhook' ? 'webhook' : 'once');
  const webhookToken = et === 'webhook' ? 'whk_' + crypto.randomBytes(16).toString('hex') : '';
  const info = db.prepare(`INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,webhook_token,enabled,username,created_at)
    VALUES (?, 'agent', ?, ?, ?, ?, ?, 1, ?, datetime('now','localtime'))`)
    .run(name.trim(), target_id, et, et === 'cron' ? cron : null, params || '{}', webhookToken, req.user.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建任务', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, webhook_token: webhookToken || undefined } });
});

// P5.8 #11：生成/重置 Webhook token（启用 webhook 触发；返回完整调用 URL）
router.post('/:id/webhook-token', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(old, req.user); // P5.31：归属校验
  if (deny) return res.json(deny);
  const token = 'whk_' + crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE tasks SET exec_type='webhook', webhook_token=? WHERE id=?").run(token, old.id);
  const host = req.get('host') || `localhost:${process.env.PORT || 3210}`;
  res.json({ code: 0, data: { webhook_token: token, url: `http://${host}/api/tasks/webhook/${token}` }, msg: 'Webhook 已启用' });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(old, req.user); // P5.31：归属校验
  if (deny) return res.json(deny);
  const { name, target_id, exec_type, cron, params } = req.body || {};
  if (exec_type === 'cron' && (!cron || !parseCron(cron))) return res.json({ code: 400, msg: 'Cron 表达式不合法' });
  const et = exec_type === 'cron' ? 'cron' : (exec_type === 'webhook' ? 'webhook' : (exec_type || old.exec_type));
  db.prepare('UPDATE tasks SET name=?,target_id=?,exec_type=?,cron=?,params=? WHERE id=?')
    .run(name || old.name, target_id || old.target_id, et, et === 'cron' ? (cron || old.cron) : null, params ?? old.params, old.id);
  res.json({ code: 0, msg: '已保存' });
});

router.post('/:id/toggle', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(old, req.user); // P5.31：归属校验
  if (deny) return res.json(deny);
  db.prepare('UPDATE tasks SET enabled=? WHERE id=?').run(old.enabled ? 0 : 1, old.id);
  res.json({ code: 0, msg: old.enabled ? '已停用' : '已启用' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(old, req.user); // P5.31：归属校验
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM task_runs WHERE task_id=?').run(req.params.id);
  if (old) db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除任务', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

router.post('/:id/run', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(task, req.user); // P5.31：归属校验
  if (deny) return res.json(deny);
  if (!task.enabled) return res.json({ code: 400, msg: '任务已停用，无法执行' });
  const r = await runTask(task);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '手动执行任务', `${task.name}（${r.status === 'success' ? '成功' : '失败'}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

router.get('/:id/runs', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  const deny = denyIfNotTaskOwner(task, req.user); // P5.31：归属校验（执行记录含产出内容，不可泄露）
  if (deny) return res.json(deny);
  res.json({ code: 0, data: db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC LIMIT 50').all(req.params.id) });
});

module.exports = router;
