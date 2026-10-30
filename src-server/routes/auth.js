/** 认证路由：登录 / 当前用户 / 修改密码 / 钉钉扫码登录（V1.3 #4 2026-10-30 mock 骨架） */
const express = require('express');
const crypto = require('crypto');
const { db, hashPwd, verifyPwd, hashPwdAsync, now } = require('../db');
const { sign, auth, revokeToken, TOKEN_TTL_MS } = require('../lib/auth');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const { loadSecrets } = require('../lib/secrets'); // 钉钉 OAuth 凭证（DINGTALK_APP_KEY/APP_SECRET）
const { upsertDingtalkUser } = require('./dingtalk'); // 扫码登录用户映射复用 user_add_org 同款规则

const router = express.Router();

// P5.30 安全止血：登录接口按 IP 限流（此前可无限暴力尝试；与 share/openapi 同一套滑动窗口实现，10 次/分钟/IP）
const loginLimiter = createLimiter({ name: 'login', windowMs: 60000, max: 10, keyFn: clientIp, msg: '登录尝试过于频繁，请 1 分钟后再试' });

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  if (!username || !password) return res.json({ code: 400, msg: '请输入账号和密码' });
  const user = db.prepare('SELECT * FROM users WHERE username=? AND status=1').get(username);
  const v = user ? await verifyPwd(password, user.password) : { ok: false };
  if (!user || !v.ok) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, '登录失败', '账号或密码错误', ip, now());
    return res.json({ code: 401, msg: '账号或密码错误' });
  }
  // 旧 SALT 密码平滑迁移：登录成功即重写为新 SALT 哈希（一次性，用户无感）
  if (v.legacy) db.prepare('UPDATE users SET password=? WHERE id=?').run(await hashPwdAsync(password), user.id);
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '登录系统', '密码登录成功', ip, now());
  res.json({ code: 0, data: { token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, dept: user.dept, onboarded: user.onboarded ? 1 : 0 }, must_change_pwd: user.must_change_pwd ? 1 : 0 } });
});

router.get('/me', auth, (req, res) => res.json({ code: 0, data: req.user }));

// P0-4 登出：吊销当前 token（仅做令牌废弃，不改状态）
router.post('/logout', auth, (req, res) => {
  revokeToken(req);
  res.json({ code: 0, msg: '已退出登录' });
});

// 新手引导完成标记（完成或跳过均标记，仅弹一次）
router.post('/onboarding', auth, (req, res) => {
  db.prepare('UPDATE users SET onboarded=1 WHERE id=?').run(req.user.id);
  res.json({ code: 0, msg: '引导已完成' });
});

router.post('/login/change-password', auth, async (req, res) => {
  const { oldPwd, newPwd } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const v = await verifyPwd(oldPwd || '', user.password);
  if (!v.ok) return res.json({ code: 400, msg: '原密码错误' });
  if (!newPwd || newPwd.length < 6) return res.json({ code: 400, msg: '新密码至少 6 位' });
  // 弱口令限制：新密码不得与常见默认密码相同（P0 安全要求）
  const WEAK = ['123456', 'admin123', 'demo123', 'password', '111111', '000000', 'abc123'];
  if (WEAK.includes(newPwd)) return res.json({ code: 400, msg: '新密码过于简单（常见默认口令），请换一个' });
  db.prepare('UPDATE users SET password=?, must_change_pwd=0 WHERE id=?').run(await hashPwdAsync(newPwd), user.id);
  // 改密后吊销当前 token（旧 token 立即失效）
  revokeToken(req);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '修改密码', '密码已更新' + (user.must_change_pwd ? '（弱口令强制改密完成）' : ''), req.ip, now());
  res.json({ code: 0, msg: '密码修改成功' });
});

// ==================== 钉钉扫码登录（V1.3 #4 2026-10-30，mock 骨架：本地纯逻辑，真实联调后续单独立项） ====================
// OAuth state 防 CSRF：模块级 Map 缓存 5 分钟（/dingtalk/url 签发 ↔ /dingtalk/callback 校验一次性消费）
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const oauthStates = new Map(); // state → { expire, origin }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of oauthStates) if (v.expire < t) oauthStates.delete(k);
}, 60 * 1000).unref(); // unref：不阻塞进程退出

// ---------- GET /dingtalk/url：签发扫码登录跳转地址（登录页发起，未登录可访问） ----------
// V1.3 审查加固 2026-10-30：挂限流（与 loginLimiter 同款——否则高频刷可堆积百万级 state Map 条目，内存膨胀）
const dingUrlLimiter = createLimiter({
  name: 'dingtalk-url',
  windowMs: 60000,
  max: 10,
  keyFn: req => req.ip || clientIp(req),
  msg: '扫码登录请求过于频繁，请稍后再试',
});
router.get('/dingtalk/url', dingUrlLimiter, (req, res) => {
  const s = loadSecrets();
  if (!s.DINGTALK_APP_KEY || !s.DINGTALK_APP_SECRET) {
    return res.json({ code: 503, msg: '钉钉登录未配置' });
  }
  // V1.3 审查加固（H1 止血）：Origin 仅在同源时采信——Origin 是客户端可任意设置的头（CORS 只是浏览器约束，
  // curl 可伪造），直接信任会让攻击者绑定任意 origin 的 state，后续 302 把签发的 token 投到第三方站点（账号接管链）。
  // 完整白名单（DINGTALK_ALLOWED_ORIGIN env）留真实联调阶段；无 Origin 时仅信任 Host（部署域名）
  const reqOrigin = String(req.headers.origin || '');
  let origin = '';
  try {
    if (reqOrigin && new URL(reqOrigin).host === req.headers.host) origin = reqOrigin;
    else if (!reqOrigin) origin = `${req.protocol}://${req.headers.host}`;
  } catch { origin = ''; }
  if (!origin) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run('dingtalk-sync', '钉钉登录发起源校验失败', `Origin=${reqOrigin.slice(0, 60)} Host=${req.headers.host}`, clientIp(req), now());
    return res.json({ code: 403, msg: '发起源校验失败（Origin 与当前站点不同源）' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { expire: Date.now() + OAUTH_STATE_TTL_MS, origin });
  const url = 'https://login.dingtalk.com/oauth2/auth?' + new URLSearchParams({
    redirect_uri: origin + '/api/auth/dingtalk/callback',
    response_type: 'code',
    client_id: s.DINGTALK_APP_KEY,
    scope: 'openid',
    state,
    prompt: 'consent',
  }).toString();
  res.json({ code: 0, data: { url } });
});

// ---------- GET /dingtalk/callback：钉钉扫码回跳（浏览器 302 流程，非 XHR） ----------
// 流程：state 校验（一次性消费防重放）→ code 换用户信息 → user_add_org 同款映射找/建用户
//       → sign 签发与密码登录完全同构的 token（sign 内部自动加 jti）→ 302 回前端哈希路由带 token
router.get('/dingtalk/callback', async (req, res) => {
  const ip = clientIp(req);
  const { code, state } = req.query || {};
  const fail = (detail, status, msg) => {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run('dingtalk-sync', '钉钉扫码登录', '失败：' + detail, ip, now());
    return res.status(status).json({ code: status, msg });
  };
  // ① state 校验（过期/伪造/重复消费均拒绝）；通过即一次性删除（防重放）
  const st = oauthStates.get(String(state || ''));
  oauthStates.delete(String(state || ''));
  if (!st || !code) return fail('state 校验失败（过期、伪造或已消费）', 403, '扫码状态校验失败，请重新发起登录');
  // ② mock 阶段无凭证 → 503（凭证在 secrets 表配置 DINGTALK_APP_KEY/APP_SECRET 后此路才可达）
  const s = loadSecrets();
  if (!s.DINGTALK_APP_KEY || !s.DINGTALK_APP_SECRET) {
    return fail('凭证未配置', 503, '钉钉登录未配置');
  }
  // ③ code 换用户信息（钉钉 SNS 接口；fetch + 8s 超时，失败 502）
  //    旧版协议 query 带 accessKey/timestamp/signature=HMAC-SHA256(appSecret,timestamp)（钉钉官方签名规则）
  let userinfo = null;
  try {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', s.DINGTALK_APP_SECRET).update(ts).digest('base64');
    const r = await fetch('https://oauth.dingtalk.com/sns/getuserinfo_bycode?' + new URLSearchParams({
      accessKey: s.DINGTALK_APP_KEY, timestamp: ts, signature: sig,
    }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmp_auth_code: code }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => null);
    // mock 简化：SNS 侧只拿得到 unionid/nick；企业内 userid/mobile 需后续用企业凭证调 getMember 重取（真实联调阶段补）
    if (!j || j.errcode !== 0 || !j.user_info) {
      return fail('换取用户信息被拒：' + JSON.stringify(j || { errcode: r.status }).slice(0, 200), 502, '钉钉登录换取用户信息失败');
    }
    userinfo = j.user_info;
  } catch (e) {
    return fail('网络调用失败：' + e.message, 502, '钉钉服务暂不可达，请稍后重试');
  }
  // ④ user_add_org 同款映射规则找/建用户（unionid 充当 UserId——mock 简化，真实联调换企业内 userid）
  let user;
  try {
    user = upsertDingtalkUser({ userId: userinfo.unionid || ('sns_' + crypto.randomBytes(8).toString('hex')), nickname: userinfo.nick || '', phone: userinfo.mobile || '', deptIdList: [] });
  } catch (e) {
    return fail('用户映射失败：' + e.message, 500, '钉钉登录用户创建失败');
  }
  // ⑤ 签发与密码登录完全同构的 token（sign 自动加 jti，TOKEN_TTL_MS 同 TTL，/api/auth/me 可直接校验）
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '钉钉扫码登录', '成功（' + (user.created ? '新建用户' : '匹配已有用户') + '）', ip, now());
  // ⑥ 302 重定向回前端（token 走 URL hash 不随请求发服务器；前端适配不在本轮）
  // V1.3 审查加固（H1 止血）：回调时校验 st.origin 的 host 与当前请求 host 一致——原实现直接信任
  // 签发时存的 origin（而它可能来自伪造的 Origin 头），不一致按 fail 拒绝（防签发 token 302 到第三方站点）
  const front = (st.origin || '').replace(/\/+$/, '');
  let originOk = false;
  try { originOk = !!front && new URL(front).host === req.headers.host; } catch { originOk = false; }
  if (!originOk) {
    return fail('重定向目标与当前站点不同源（疑似伪造 origin）', 403, '扫码登录回调源校验失败');
  }
  res.redirect(302, front + '/#/login?dingtalk_token=' + encodeURIComponent(token));
});

module.exports = router;
