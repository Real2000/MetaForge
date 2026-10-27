/** 用户管理（2026-10-20）：管理员对平台用户的增删改查 / 角色管理 / 重置密码 / 启停
 *  安全护栏（防锁死）：
 *  - 不能停用 / 降级 / 删除自己的账号；
 *  - 平台至少保留一名可用管理员（停用或降级最后一名管理员前会被拦截）；
 *  - 管理员重置的初始密码自动打 must_change_pwd=1（该用户下次登录强制改密，与 P0 治理闭环）；
 *  - 删除用户时事务清理其会话/消息/追踪/收藏/通知已读/长期记忆/自有模型源/技能资产，
 *    名下智能体回收给 admin（平台资产不随账号消失）。
 */
const express = require('express');
const { db, hashPwd, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

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

// 除密码外的用户档案（列表/编辑回显）
const PROFILE_COLS = 'id, username, nickname, role, dept, status, must_change_pwd, quota_total, quota_used, created_at';

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${PROFILE_COLS} FROM users ORDER BY role='admin' DESC, id`).all();
  res.json({ code: 0, data: rows });
});

// 新增用户（初始密码由管理员设置，首次登录强制改密）
router.post('/', (req, res) => {
  const { username, nickname, role, dept, password } = req.body || {};
  const uname = String(username || '').trim();
  if (!USERNAME_RE.test(uname)) return res.json({ code: 400, msg: '用户名需 3~20 位字母/数字/下划线' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(uname)) return res.json({ code: 400, msg: '用户名已存在' });
  const pwdErr = validPwd(password);
  if (pwdErr) return res.json({ code: 400, msg: pwdErr });
  const r = role === 'admin' ? 'admin' : 'user';
  const info = db.prepare('INSERT INTO users (username,password,nickname,role,dept,status,must_change_pwd,created_at) VALUES (?,?,?,?,?,1,1,?)')
    .run(uname, hashPwd(password), String(nickname || uname).slice(0, 30), r, String(dept || '').slice(0, 30), now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '新增用户', `${uname}（${r === 'admin' ? '管理员' : '普通用户'}${dept ? '·' + dept : ''}，首登强制改密）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// 编辑用户：昵称 / 角色 / 部门 / 启停
router.put('/:id', (req, res) => {
  const target = db.prepare(`SELECT ${PROFILE_COLS} FROM users WHERE id=?`).get(req.params.id);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  const { nickname, role, dept, status } = req.body || {};
  const isSelf = target.id === req.user.id;
  const newRole = role === 'admin' || role === 'user' ? role : target.role;
  const newStatus = status == null ? target.status : (status ? 1 : 0);

  // 防锁死：自己的角色与启停不可经此变更（自己改密走「修改密码」入口）
  if (isSelf && newRole !== target.role) return res.json({ code: 400, msg: '不能变更自己的角色' });
  if (isSelf && newStatus === 0) return res.json({ code: 400, msg: '不能停用自己的账号' });
  // 至少保留一名可用管理员
  if (target.role === 'admin' && (newRole !== 'admin' || newStatus === 0)) {
    const others = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status=1 AND id != ?").get(target.id).c;
    if (others === 0) return res.json({ code: 400, msg: '平台至少需要保留一名可用管理员' });
  }
  db.prepare('UPDATE users SET nickname=?,role=?,dept=?,status=? WHERE id=?')
    .run(String(nickname ?? target.nickname).slice(0, 30), newRole, String(dept ?? target.dept).slice(0, 30), newStatus, target.id);
  const changes = [];
  if (newRole !== target.role) changes.push(newRole === 'admin' ? '升为管理员' : '转为普通用户');
  if (newStatus !== target.status) changes.push(newStatus === 0 ? '停用' : '启用');
  if (String(dept ?? target.dept) !== target.dept) changes.push('部门调整');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '编辑用户', `${target.username}${changes.length ? '：' + changes.join('、') : '（资料更新）'}`, req.ip, now());
  res.json({ code: 0, msg: '已保存' });
});

// 管理员重置密码：成功后该用户首登强制改密（不记录密码明文）
router.put('/:id/reset-password', (req, res) => {
  const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  const pwdErr = validPwd((req.body || {}).newPwd);
  if (pwdErr) return res.json({ code: 400, msg: pwdErr });
  db.prepare('UPDATE users SET password=?, must_change_pwd=1 WHERE id=?').run(hashPwd((req.body || {}).newPwd), target.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '重置密码', `${target.username}（该用户下次登录需强制修改密码）`, req.ip, now());
  res.json({ code: 0, msg: `已重置 ${target.username} 的密码，其下次登录将要求修改` });
});

// 删除用户：事务清理名下数据；名下智能体回收给 admin
router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.json({ code: 404, msg: '用户不存在' });
  if (target.id === req.user.id) return res.json({ code: 400, msg: '不能删除自己的账号' });
  if (target.role === 'admin') {
    const others = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status=1 AND id != ?").get(target.id).c;
    if (others === 0) return res.json({ code: 400, msg: '平台至少需要保留一名可用管理员' });
  }
  const removed = db.transaction((uid, uname) => {
    const sids = db.prepare('SELECT id FROM sessions WHERE username=?').all(uname).map(r => r.id);
    if (sids.length) {
      const inClause = sids.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE session_id IN (${inClause})`).run(...sids);
      db.prepare(`DELETE FROM chat_traces WHERE session_id IN (${inClause})`).run(...sids);
    }
    db.prepare('DELETE FROM sessions WHERE username=?').run(uname);
    db.prepare('DELETE FROM favorites WHERE username=?').run(uname);
    db.prepare('DELETE FROM notification_reads WHERE username=?').run(uname);
    db.prepare('DELETE FROM agent_memories WHERE username=?').run(uname);
    db.prepare('DELETE FROM user_providers WHERE username=?').run(uname);
    db.prepare('DELETE FROM skill_assets WHERE owner=?').run(uname);
    db.prepare("UPDATE agents SET owner='admin' WHERE owner=?").run(uname);
    db.prepare('DELETE FROM users WHERE id=?').run(uid);
  })(target.id, target.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '删除用户', `${target.username}（会话/收藏/记忆/自有模型源/技能已清理，名下智能体回收给 admin）`, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
