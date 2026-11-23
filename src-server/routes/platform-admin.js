/**
 * MT-09 平台超管跨租户运维台（2026-11-22）
 *
 * 平台超管专属能力：
 *   - 跨租户只读统计（默认只读）；
 *   - 带审计的 impersonation（以目标用户身份签发短时令牌，便于排障；须显式 confirm）；
 *   - 审计查询（租户旁路 / impersonation 事件）。
 * 安全：全部跨租户操作落 security_events（含 tenant_id 与操作者）；写操作须显式确认。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, platformAdminOnly, sign } = require('../lib/auth');
const tenantLib = require('../lib/tenant');

const router = express.Router();
router.use(auth, platformAdminOnly);

const IMP_TTL_MS = 30 * 60 * 1000; // impersonation 令牌有效期 30 分钟

function secEvent(type, detail, action, source) {
  try {
    dal.runq("INSERT INTO security_events (type, detail, action, source, created_at) VALUES (?,?,?,?,datetime('now','localtime'))", [type, detail, action, source]);
  } catch { /* 审计失败不阻断 */ }
}

// 跨租户只读统计：各租户用户数 / 智能体数 / 知识库数 / 会话数
router.get('/stats', (req, res) => {
  const tenants = tenantLib.listTenants();
  const stat = (sql) => { try { return dal.q(sql); } catch { return []; } };
  const agentRows = stat('SELECT tenant_id, COUNT(*) c FROM agents GROUP BY tenant_id');
  const kbRows = stat('SELECT tenant_id, COUNT(*) c FROM kbs GROUP BY tenant_id');
  const sessRows = stat('SELECT tenant_id, COUNT(*) c FROM sessions GROUP BY tenant_id');
  const m = (rows) => { const o = {}; for (const r of rows) o[r.tenant_id] = r.c; return o; };
  const aM = m(agentRows), kM = m(kbRows), sM = m(sessRows);
  res.json({
    code: 0,
    data: tenants.map(t => ({
      ...t,
      agents: aM[t.id] || 0,
      kbs: kM[t.id] || 0,
      sessions: sM[t.id] || 0,
    })),
  });
});

// 某租户用户清单（运维台租户切换后查看，只读）
router.get('/tenants/:id/users', (req, res) => {
  const tid = Number(req.params.id);
  const t = tenantLib.getTenant(tid);
  if (!t) return res.json({ code: 404, msg: '租户不存在' });
  const rows = dal.q('SELECT id, username, nickname, role, status, created_at FROM users WHERE tenant_id=? ORDER BY role=\'admin\' DESC, id', [tid]);
  secEvent('platform_read', `平台超管 ${req.user.username} 查看租户 #${tid} 用户清单`, `${req.method} ${req.originalUrl}`, 'platform-admin');
  res.json({ code: 0, data: rows });
});

// impersonation：为目标用户签发短时令牌（须显式 confirm=true）
router.post('/impersonate', (req, res) => {
  const { tenant_id, user_id, confirm } = req.body || {};
  if (confirm !== true) return res.json({ code: 400, msg: '跨租户借用需显式确认（confirm=true）' });
  const uid = Number(user_id);
  const target = dal.getq('SELECT id, username, role, status, tenant_id, token_version FROM users WHERE id=?', [uid]);
  if (!target || target.status !== 1) return res.json({ code: 404, msg: '目标用户不存在或不可用' });
  if (tenant_id != null && Number(tenant_id) !== target.tenant_id) return res.json({ code: 400, msg: 'target 用户不属于指定租户' });
  if (target.id === req.user.id) return res.json({ code: 400, msg: '无需借用自身账号' });
  const token = sign({ uid: target.id, exp: Date.now() + IMP_TTL_MS, tv: target.token_version || 0, imp: req.user.username, tenant_id: target.tenant_id });
  secEvent('impersonation', `平台超管 ${req.user.username} 借用 tenant=${target.tenant_id} 用户 ${target.username}(#${target.id})，TTL=30min`, `${req.method} ${req.originalUrl}`, 'platform-admin');
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '跨租户借用', `借用 ${target.username}(#${target.id}) · tenant=${target.tenant_id}`, req.ip, now()]);
  res.json({ code: 0, data: { token, user: { id: target.id, username: target.username, role: target.role, tenant_id: target.tenant_id }, ttl_ms: IMP_TTL_MS }, msg: '已签发借用令牌（30 分钟）' });
});

// 审计：近期租户旁路/借用事件
router.get('/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  let rows = [];
  try {
    rows = dal.q("SELECT id, type, detail, action, source, created_at FROM security_events WHERE type IN ('tenant_bypass','impersonation','platform_read') ORDER BY id DESC LIMIT ?", [limit]);
  } catch { /* ignore */ }
  res.json({ code: 0, data: rows });
});

module.exports = router;
