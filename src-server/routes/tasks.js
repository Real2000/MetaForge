/** 任务管理：CRUD / 立即执行 / 执行记录（P5.31：任务归属——创建者自有，管理员全局可见可管） */
const express = require('express');
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { runTask } = require('../lib/scheduler');
const { parseCron } = require('../lib/cron');
const { canView } = require('../lib/agent-access');
const { createLimiter, clientIp } = require('../lib/rate-limit');

const router = express.Router();

// P5.33 审查修复（F7）：Webhook 免鉴权端点套 IP 限流（30 次/分/IP，防脚本刷爆 token 计费到任务归属者）
const webhookLimiter = createLimiter({ name: 'task-webhook', windowMs: 60000, max: 30, keyFn: clientIp, msg: 'Webhook 调用过于频繁，请 1 分钟后再试' });

// P5.31 归属校验：任务仅创建者或管理员可管（历史任务 username='' 视为管理员创建）；只读接口单独过滤
function denyIfNotTaskOwner(task, user) {
  if (!task) return { code: 404, msg: '任务不存在' };
  if (user.role === 'admin') return null;
  if (task.username && task.username === user.username) return null;
  return { code: 403, msg: '无权管理该任务（仅创建者或管理员）' };
}

// P5.33 审查修复（F4）：任务数量配额检查抽公共函数——创建/启用共用（此前仅创建时检查，
// 「建满20→全停用→再建20→逐个重新启用」可无限绕过上限）
function denyIfOverTaskQuota(user) {
  if (user.role === 'admin') return null;
  const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE username=? AND enabled=1').get(user.username).c;
  if (cnt >= 20) return { code: 400, msg: '已达任务数量上限（20 个启用中），请先停用或删除不需要的任务' };
  return null;
}

// P5.31+P5.33：非管理员绑定智能体需 published + canView（POST 与 PUT 共用；此前 PUT 可改绑任意智能体越权）
function denyIfAgentNotAllowed(targetId, user) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(targetId);
  if (!agent || agent.status !== 'published') return { code: 400, msg: '目标智能体不存在或未发布' };
  if (user.role !== 'admin' && !canView(agent, user)) return { code: 403, msg: '无权绑定该智能体（未对你开放）' };
  return null;
}

// P5.8 #11 Webhook 触发端点（免 auth，token 鉴权）——须在 router.use(auth) 之前注册
// POST /api/tasks/webhook/:token  body 可传 {input|message|text|content} 覆盖默认输入；兼容企业微信/钉钉格式
router.post('/webhook/:token', webhookLimiter, async (req, res) => {
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
  // MT-05（2026-11-22）：多租户下所有查询强制注入 tenant_id（单租户 scope=null，零回归）。
  const scope = require('../lib/dal').tenantScope(req);
  const conds = [], args = [];
  if (req.user.role !== 'admin') { conds.push('t.username=?'); args.push(req.user.username); }
  if (scope != null) { conds.push('t.tenant_id=?'); args.push(scope); }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
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
  const agentDeny = denyIfAgentNotAllowed(target_id, req.user);
  if (agentDeny) return res.json(agentDeny);
  if (exec_type === 'cron' && (!cron || !parseCron(cron))) return res.json({ code: 400, msg: 'Cron 表达式不合法（五段：分 时 日 月 周，如 0 9 * * *）' });
  // P5.31：非管理员任务数量配额（防批量造任务烧 token；与 create_task 工具同限）
  const quotaDeny = denyIfOverTaskQuota(req.user);
  if (quotaDeny) return res.json(quotaDeny);
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
  // P5.33 审查修复（R3/F5）：改绑智能体时同样校验 published + canView——此前 PUT 可把任务改绑到受限/
  // 草稿智能体，无人值守周期执行越权调用（canView 防线只在 POST 闭合）
  if (target_id && +target_id !== +old.target_id) {
    const agentDeny = denyIfAgentNotAllowed(+target_id, req.user);
    if (agentDeny) return res.json(agentDeny);
  }
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
  // P5.33 审查修复（F4）：重新启用时复核任务配额（堵「建满→停用→再建→启用」的无限绕过）
  if (!old.enabled) {
    const quotaDeny = denyIfOverTaskQuota(req.user);
    if (quotaDeny) return res.json(quotaDeny);
  }
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
