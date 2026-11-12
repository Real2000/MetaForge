/** 沙箱执行管理（2026-11-12 P1-11~13）
 *  GET  /api/sandbox/runs           运行记录查询（P1-13，adminOnly）
 *  GET  /api/sandbox/stats          运行统计
 *  GET  /api/sandbox/hosts          远程主机列表（P1-12）
 *  POST /api/sandbox/hosts/upsert   主机登记（凭据密文，strict 模式须带指纹）
 *  POST /api/sandbox/hosts/:id/toggle 主机启停
 *  DELETE /api/sandbox/hosts/:id    删除主机
 *  POST /api/sandbox/hosts/:id/exec 远程执行测试（adminOnly，白名单+密钥校验全链路）
 *  POST /api/sandbox/test           本地子进程沙箱执行测试（adminOnly 验收用）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { runIsolated, runCommand } = require('../lib/sandbox');
const { upsertHost, listHosts, deleteHost, execRemote } = require('../lib/remote-hosts');

const router = express.Router();
router.use(auth);

// ---------------- P1-13 运行记录 ----------------
router.get('/runs', adminOnly, (req, res) => {
  const { run_env, status, owner, q } = req.query;
  const wh = [];
  const args = [];
  if (run_env && run_env !== 'all') { wh.push('run_env=?'); args.push(run_env); }
  if (status && status !== 'all') { wh.push('status=?'); args.push(status); }
  if (owner) { wh.push('owner=?'); args.push(owner); }
  if (q) { wh.push('(code_digest LIKE ? OR stdout_excerpt LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT * FROM sandbox_runs${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
  res.json({ code: 0, data: rows });
});

router.get('/stats', adminOnly, (req, res) => {
  const stat = {
    total: db.prepare('SELECT COUNT(*) c FROM sandbox_runs').get().c,
    success: db.prepare("SELECT COUNT(*) c FROM sandbox_runs WHERE status='success'").get().c,
    failed: db.prepare("SELECT COUNT(*) c FROM sandbox_runs WHERE status='failed'").get().c,
    timeout: db.prepare("SELECT COUNT(*) c FROM sandbox_runs WHERE status='timeout'").get().c,
    denied: db.prepare("SELECT COUNT(*) c FROM sandbox_runs WHERE status='denied'").get().c,
    byEnv: {},
  };
  for (const r of db.prepare('SELECT run_env, COUNT(*) c FROM sandbox_runs GROUP BY run_env').all()) {
    stat.byEnv[r.run_env] = r.c;
  }
  res.json({ code: 0, data: stat });
});

// ---------------- P1-12 远程主机管理 ----------------
router.get('/hosts', adminOnly, (req, res) => {
  res.json({ code: 0, data: listHosts() });
});

router.post('/hosts/upsert', adminOnly, (req, res) => {
  const b = req.body || {};
  try {
    const r = upsertHost({
      id: b.id ? Number(b.id) : undefined,
      name: b.name, host: b.host, port: b.port ? Number(b.port) : undefined,
      username: b.username, credential: b.credential, credentialType: b.credential_type,
      fingerprint: b.fingerprint, knownHostsMode: b.known_hosts_mode,
      dockerEnabled: b.docker_enabled, enabled: b.enabled, createdBy: req.user.username,
    });
    res.json({ code: 0, data: r, msg: b.id ? '已保存' : '已登记' });
  } catch (e) { res.json({ code: 400, msg: e.message }); }
});

router.post('/hosts/:id/toggle', adminOnly, (req, res) => {
  const old = db.prepare('SELECT id, enabled FROM remote_hosts WHERE id=?').get(Number(req.params.id));
  if (!old) return res.json({ code: 404, msg: '主机不存在' });
  const next = old.enabled ? 0 : 1;
  db.prepare('UPDATE remote_hosts SET enabled=?, updated_at=? WHERE id=?').run(next, now(), old.id);
  res.json({ code: 0, data: { enabled: !!next } });
});

router.delete('/hosts/:id', adminOnly, (req, res) => {
  deleteHost(Number(req.params.id));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '删除远程主机', `#${req.params.id}`, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

/** 远程执行测试：白名单 + 密钥校验 + 审计全链路（不真执行危险命令——固定回显 hostname） */
router.post('/hosts/:id/exec', adminOnly, async (req, res) => {
  const command = String(req.body?.command || 'hostname && echo OK').slice(0, 300);
  const r = await execRemote(Number(req.params.id), command, { owner: req.user.username, timeoutMs: 15000 });
  if (r.status === 'denied') return res.json({ code: 403, msg: r.stderr, data: r });
  res.json({ code: 0, data: r, msg: `执行完成（${r.status}）` });
});

// ---------------- P1-11 沙箱执行测试 ----------------
/** 本地子进程沙箱验收：POST /api/sandbox/test { code, netAllow?, timeoutMs? } */
router.post('/test', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.code) return res.json({ code: 400, msg: 'code 必填' });
  const r = await runIsolated({
    code: String(b.code),
    netAllow: Array.isArray(b.netAllow) ? b.netAllow : [],
    timeoutMs: Number(b.timeoutMs) || 15000,
    owner: req.user.username,
  });
  res.json({ code: 0, data: r });
});

/** 命令分级测试：POST /api/sandbox/test-cmd { cmd } */
router.post('/test-cmd', adminOnly, async (req, res) => {
  const r = await runCommand(String(req.body?.cmd || ''), { owner: req.user.username, timeoutMs: 10000 });
  res.json({ code: 0, data: r, msg: r.status === 'denied' ? '命令被白名单拒绝' : `执行完成（${r.status}）` });
});

module.exports = router;
