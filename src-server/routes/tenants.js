/**
 * MT-10 租户开通闭环（2026-11-22）
 *
 * 平台超管专属：租户开通（建租户 + 派生首个管理员）、停/启用、列举。
 * 权限：platformAdminOnly（平台超管）——普通租户管理员不可见、不可操作租户本体。
 * 审计：每次写操作落 op_logs（含平台超管操作者），停用同时踢出该租户全部在线会话。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, platformAdminOnly } = require('../lib/auth');
const tenantLib = require('../lib/tenant');

const router = express.Router();
router.use(auth, platformAdminOnly);

function audit(actor, action, detail, ip) {
  try {
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [actor, action, detail, ip, now()]);
  } catch { /* 审计失败不阻断 */ }
}

// 租户列表（含用户数）
router.get('/', (req, res) => {
  res.json({ code: 0, data: tenantLib.listTenants() });
});

// 单租户详情
router.get('/:id', (req, res) => {
  const t = tenantLib.getTenant(Number(req.params.id));
  if (!t) return res.json({ code: 404, msg: '租户不存在' });
  const users = dal.q('SELECT id, username, nickname, role, status FROM users WHERE tenant_id=? ORDER BY role=\'admin\' DESC, id', [t.id]);
  res.json({ code: 0, data: { ...t, users } });
});

// 开通租户（建租户 + 派生首个管理员）
router.post('/', (req, res) => {
  const { name, plan, adminUsername, adminPassword, adminNickname, note } = req.body || {};
  const r = tenantLib.createTenant({ name, plan, adminUsername, adminPassword, adminNickname, note });
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  audit(req.user.username, '开通租户', `${name}（管理员 ${r.adminUsername}，plan=${plan || 'free'}）`, req.ip);
  res.json({ code: 0, data: { id: r.tenantId, adminUsername: r.adminUsername }, msg: '租户已开通' });
});

// 停/启用租户
router.put('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = (req.body || {}).status;
  const r = tenantLib.setTenantStatus(id, status);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  audit(req.user.username, '变更租户状态', `租户 #${id} → ${r.status}`, req.ip);
  res.json({ code: 0, msg: r.status === 'disabled' ? '租户已停用（在线会话已踢出）' : '租户已启用' });
});

module.exports = router;
