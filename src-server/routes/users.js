/** 用户管理（2026-10-20 / MT-08 租户域内收敛 2026-11-22）：管理员对平台用户的增删改查 / 角色管理 / 重置密码 / 启停
 *  租户域：
 *  - 租户管理员（role=admin，非平台超管）：仅可见/可管本租户（req.user.tenant_id）用户；
 *  - 平台超管（platform_admin=1）：可跨租户（默认全量，可 ?tenant_id= 过滤），新增可指定 tenant_id 并授予平台超管标记。
 *  安全护栏（防锁死）：
 *  - 不能停用 / 降级 / 删除自己的账号；
 *  - 每个租户至少保留一名可用管理员；平台至少保留一名平台超管；
 *  - 管理员重置的初始密码自动打 must_change_pwd=1（该用户下次登录强制改密）；
 *  - 删除用户时事务清理其会话/消息/追踪/收藏/通知已读/长期记忆/自有模型源/技能资产，
 *    名下智能体回收给该租户 admin（平台资产不随账号消失）。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, hashPwd, now } = require('../db');
const { auth, adminOnly, bumpTokenVersion, isPlatformSuperadmin } = require('../lib/auth');

const router = express.Router();
router.use(auth, adminOnly);

// 与 auth.js / db.js 保持一致的常见弱口令黑名单
const WEAK = ['123456', 'admin123', 'demo123', 'password', '111111', '000000', 'abc123'];
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function validPwd(p) {
  if (!p || p.length < 6) return '密码至少 6 位';
  if (WEAK.includes(p)) return '密码过于简单（常见默认口令），请换一个';
  return '';
}

/** 解析当前操作者的租户作用域：平台超管 → body/query 指定或 null(全部)；租户管理员 → 强制本租户 */
function scopedTenantId(req) {
  if (isPlatformSuperadmin(req.user)) {
    const q = (req.query && req.query.tenant_id != null) ? req.query.tenant_id : (req.body && req.body.tenant_id != null ? req.body.tenant_id : null);
    if (q != null && q !== '') { const n = Number(q); return Number.isFinite(n) ? n : null; }
    return null; // 全部
  }
  return req.user.tenant_id || 1;
}

/** 目标用户是否在当前操作者可管范围内 */
function canManage(req, target) {
  if (isPlatformSuperadmin(req.user)) return true;
  return (target.tenant_id || 1) === (req.user.tenant_id || 1);
}

// V1.2 #2（V1.1 审查 F4 收尾）2026-10-30：dept_id 归一——正整数且 departments 表存在该 id 才写入，
// 否则返回 NULL（防悬空引用：手工改库/API 传不存在 id 不产生孤儿部门指向）
function normalizeDeptId(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isInteger(n) || n < 1) return null;
  return dal.getq('SELECT 1 FROM departments WHERE id=?', [n]) ? n : null;
}

// 除密码外的用户档案（列表/编辑回显）；V1.2 #2 补 dept_id；MT-08 补 tenant_id/platform_admin
const PROFILE_COLS = 'id, username, nickname, role, dept, dept_id, status, must_change_pwd, quota_total, quota_used, tenant_id, COALESCE(platform_admin,0) AS platform_admin, created_at';

router.get('/', (req, res) => {
  const tid = scopedTenantId(req);
  let rows;
  if (tid == null) {
    rows = dal.q(`SELECT ${PROFILE_COLS} FROM users ORDER BY tenant_id, role='admin' DESC, id`);
  } else {
    rows = dal.q(`SELECT ${PROFILE_COLS} FROM users WHERE tenant_id=? ORDER BY role='admin' DESC, id`, [tid]);
  }
  res.json({ code: 0, data: rows });
});

// 新增用户（初始密码由管理员设置，首次登录强制改密）
router.post('/', (req, res) => {
  const { username, nickname, role, dept, dept_id, password, platform_admin } = req.body || {};
  const uname = String(username || '').trim();
  if (!USERNAME_RE.test(uname)) return res.json({ code: 400, msg: '用户名需 3~20 位字母/数字/下划线' });
  if (dal.getq('SELECT id FROM users WHERE username=?', [uname])) return res.json({ code: 400, msg: '用户名已存在' });
  const pwdErr = validPwd(password);
  if (pwdErr) return res.json({ code: 400, msg: pwdErr });
  const r = role === 'admin' ? 'admin' : 'user';
  // MT-08：租户归属——租户管理员固定本租户；平台超管可指定 tenant_id（缺省默认租户）
  let tid;
  if (isPlatformSuperadmin(req.user)) {
    tid = req.body.tenant_id != null && req.body.tenant_id !== '' ? Number(req.body.tenant_id) : (req.user.tenant_id || 1);
  } else {
    tid = req.user.tenant_id || 1;
  }
  if (!Number.isFinite(tid) || tid < 1) return res.json({ code: 400, msg: '目标租户无效' });
  if (!dal.getq('SELECT 1 FROM tenants WHERE id=?', [tid])) return res.json({ code: 400, msg: '目标租户不存在' });
  // 平台超管标记仅平台超管可授予
  const pAdmin = (isPlatformSuperadmin(req.user) && platform_admin) ? 1 : 0;
  const deptId = normalizeDeptId(dept_id);
  const info = dal.runq('INSERT INTO users (username,password,nickname,role,dept,dept_id,status,must_change_pwd,created_at,tenant_id,platform_admin) VALUES (?,?,?,?,?,?,1,1,?,?,?)', [uname, hashPwd(password), String(nickname || uname).slice(0, 30), r, String(dept || '').slice(0, 30), deptId, now(), tid, pAdmin]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '新增用户', `${uname}（${r === 'admin' ? '管理员' : '普通用户'}${dept ? '·' + dept : ''}，租户#${tid}，首登强制改密）`, req.ip, now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// 编辑用户：昵称 / 角色 / 部门 / 启停
router.put('/:id', (req, res) => {
  const target = dal.getq(`SELECT ${PROFILE_COLS} FROM users WHERE id=?`, [req.params.id]);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  if (!canManage(req, target)) return res.json({ code: 403, msg: '仅可管理本租户用户' });
  const { nickname, role, dept, dept_id, status, platform_admin } = req.body || {};
  const isSelf = target.id === req.user.id;
  const newRole = role === 'admin' || role === 'user' ? role : target.role;
  const newStatus = status == null ? target.status : (status ? 1 : 0);

  // 防锁死：自己的角色与启停不可经此变更（自己改密走「修改密码」入口）
  if (isSelf && newRole !== target.role) return res.json({ code: 400, msg: '不能变更自己的角色' });
  if (isSelf && newStatus === 0) return res.json({ code: 400, msg: '不能停用自己的账号' });
  // MT-08：本租户至少保留一名可用管理员
  if (target.role === 'admin' && (newRole !== 'admin' || newStatus === 0)) {
    const others = dal.getq("SELECT COUNT(*) c FROM users WHERE role='admin' AND status=1 AND id != ? AND tenant_id=?", [target.id, target.tenant_id || 1]).c;
    if (others === 0) return res.json({ code: 400, msg: '该租户至少需要保留一名可用管理员' });
  }
  // MT-08：平台超管标记变更——仅平台超管可操作，且平台至少保留一名平台超管
  let newPAdmin = target.platform_admin;
  if (platform_admin != null && isPlatformSuperadmin(req.user)) {
    newPAdmin = platform_admin ? 1 : 0;
    if (target.platform_admin === 1 && newPAdmin === 0) {
      const others = dal.getq("SELECT COUNT(*) c FROM users WHERE COALESCE(platform_admin,0)=1 AND status=1 AND id != ?", [target.id]).c;
      if (others === 0) return res.json({ code: 400, msg: '平台至少需要保留一名平台超管' });
    }
  }
  // V1.2 #2：dept_id 绑定——未传保留原值；显式传 null/非法 id 归 NULL；前端部门树下拉会与 dept 文本同时提交
  const newDeptId = dept_id === undefined ? (target.dept_id ?? null) : normalizeDeptId(dept_id);
  dal.runq('UPDATE users SET nickname=?,role=?,dept=?,dept_id=?,status=?,platform_admin=? WHERE id=?', [String(nickname ?? target.nickname).slice(0, 30), newRole, String(dept ?? target.dept).slice(0, 30), newDeptId, newStatus, newPAdmin, target.id]);
  // SEC-07：停用账号即吊销其全部令牌（token_version +1），在线会话立即失效
  if (newStatus === 0 && target.status !== 0) bumpTokenVersion(target.id);
  const changes = [];
  if (newRole !== target.role) changes.push(newRole === 'admin' ? '升为管理员' : '转为普通用户');
  if (newStatus !== target.status) changes.push(newStatus === 0 ? '停用' : '启用');
  if (newPAdmin !== target.platform_admin) changes.push(newPAdmin ? '授予平台超管' : '撤销平台超管');
  if (String(dept ?? target.dept) !== target.dept || newDeptId !== (target.dept_id ?? null)) changes.push('部门调整');
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '编辑用户', `${target.username}${changes.length ? '：' + changes.join('、') : '（资料更新）'}`, req.ip, now()]);
  res.json({ code: 0, msg: '已保存' });
});

// 管理员重置密码：成功后该用户首登强制改密（不记录密码明文）
router.put('/:id/reset-password', (req, res) => {
  const target = dal.getq('SELECT id, username, tenant_id FROM users WHERE id=?', [req.params.id]);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  if (!canManage(req, target)) return res.json({ code: 403, msg: '仅可管理本租户用户' });
  const pwdErr = validPwd((req.body || {}).newPwd);
  if (pwdErr) return res.json({ code: 400, msg: pwdErr });
  dal.runq('UPDATE users SET password=?, must_change_pwd=1 WHERE id=?', [hashPwd((req.body || {}).newPwd), target.id]);
  bumpTokenVersion(target.id);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '重置密码', `${target.username}（该用户下次登录需强制修改密码，已踢出其它登录端）`, req.ip, now()]);
  res.json({ code: 0, msg: `已重置 ${target.username} 的密码，其下次登录将要求修改` });
});

// 删除用户：事务清理名下数据；名下智能体回收给本租户 admin
router.delete('/:id', (req, res) => {
  const target = dal.getq('SELECT id, username, role, tenant_id, COALESCE(platform_admin,0) AS platform_admin FROM users WHERE id=?', [req.params.id]);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  if (!canManage(req, target)) return res.json({ code: 403, msg: '仅可管理本租户用户' });
  if (target.id === req.user.id) return res.json({ code: 400, msg: '不能删除自己的账号' });
  if (target.role === 'admin') {
    const others = dal.getq("SELECT COUNT(*) c FROM users WHERE role='admin' AND status=1 AND id != ? AND tenant_id=?", [target.id, target.tenant_id || 1]).c;
    if (others === 0) return res.json({ code: 400, msg: '该租户至少需要保留一名可用管理员' });
  }
  if (target.platform_admin === 1) {
    const others = dal.getq("SELECT COUNT(*) c FROM users WHERE COALESCE(platform_admin,0)=1 AND status=1 AND id != ?", [target.id]).c;
    if (others === 0) return res.json({ code: 400, msg: '平台至少需要保留一名平台超管' });
  }
  const tid = target.tenant_id || 1;
  db.transaction((uid, uname) => {
    const sids = dal.q('SELECT id FROM sessions WHERE username=?', [uname]).map(r => r.id);
    if (sids.length) {
      const inClause = sids.map(() => '?').join(',');
      dal.runq(`DELETE FROM messages WHERE session_id IN (${inClause})`, [...sids]);
      dal.runq(`DELETE FROM chat_traces WHERE session_id IN (${inClause})`, [...sids]);
    }
    dal.runq('DELETE FROM sessions WHERE username=?', [uname]);
    dal.runq('DELETE FROM favorites WHERE username=?', [uname]);
    dal.runq('DELETE FROM notification_reads WHERE username=?', [uname]);
    dal.runq('DELETE FROM agent_memories WHERE username=?', [uname]);
    dal.runq('DELETE FROM user_providers WHERE username=?', [uname]);
    dal.runq('DELETE FROM skill_assets WHERE owner=?', [uname]);
    // 名下智能体回收给本租户 admin（取该租户首个管理员，缺省回落 admin）
    const tAdmin = dal.getq("SELECT username FROM users WHERE role='admin' AND tenant_id=? ORDER BY id LIMIT 1", [tid]);
    dal.runq('UPDATE agents SET owner=? WHERE owner=?', [tAdmin ? tAdmin.username : 'admin', uname]);
    dal.runq('DELETE FROM users WHERE id=?', [uid]);
  })(target.id, target.username);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '删除用户', `${target.username}（会话/收藏/记忆/自有模型源/技能已清理，名下智能体回收给租户管理员）`, req.ip, now()]);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
