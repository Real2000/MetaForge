/** 认证路由：登录 / 当前用户 / 修改密码 */
const express = require('express');
const { db, hashPwd, verifyPwd, now } = require('../db');
const { sign, auth, TOKEN_TTL_MS } = require('../lib/auth');
const { createLimiter, clientIp } = require('../lib/rate-limit');

const router = express.Router();

// P5.30 安全止血：登录接口按 IP 限流（此前可无限暴力尝试；与 share/openapi 同一套滑动窗口实现，10 次/分钟/IP）
const loginLimiter = createLimiter({ name: 'login', windowMs: 60000, max: 10, keyFn: clientIp, msg: '登录尝试过于频繁，请 1 分钟后再试' });

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  if (!username || !password) return res.json({ code: 400, msg: '请输入账号和密码' });
  const user = db.prepare('SELECT * FROM users WHERE username=? AND status=1').get(username);
  const v = user ? verifyPwd(password, user.password) : { ok: false };
  if (!user || !v.ok) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, '登录失败', '账号或密码错误', ip, now());
    return res.json({ code: 401, msg: '账号或密码错误' });
  }
  // 旧 SALT 密码平滑迁移：登录成功即重写为新 SALT 哈希（一次性，用户无感）
  if (v.legacy) db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPwd(password), user.id);
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '登录系统', '密码登录成功', ip, now());
  res.json({ code: 0, data: { token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, dept: user.dept, onboarded: user.onboarded ? 1 : 0 }, must_change_pwd: user.must_change_pwd ? 1 : 0 } });
});

router.get('/me', auth, (req, res) => res.json({ code: 0, data: req.user }));

// 新手引导完成标记（完成或跳过均标记，仅弹一次）
router.post('/onboarding', auth, (req, res) => {
  db.prepare('UPDATE users SET onboarded=1 WHERE id=?').run(req.user.id);
  res.json({ code: 0, msg: '引导已完成' });
});

router.post('/change-password', auth, (req, res) => {
  const { oldPwd, newPwd } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const v = verifyPwd(oldPwd || '', user.password);
  if (!v.ok) return res.json({ code: 400, msg: '原密码错误' });
  if (!newPwd || newPwd.length < 6) return res.json({ code: 400, msg: '新密码至少 6 位' });
  // 弱口令限制：新密码不得与常见默认密码相同（P0 安全要求）
  const WEAK = ['123456', 'admin123', 'demo123', 'password', '111111', '000000', 'abc123'];
  if (WEAK.includes(newPwd)) return res.json({ code: 400, msg: '新密码过于简单（常见默认口令），请换一个' });
  db.prepare('UPDATE users SET password=?, must_change_pwd=0 WHERE id=?').run(hashPwd(newPwd), user.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '修改密码', '密码已更新' + (user.must_change_pwd ? '（弱口令强制改密完成）' : ''), req.ip, now());
  res.json({ code: 0, msg: '密码修改成功' });
});

module.exports = router;
