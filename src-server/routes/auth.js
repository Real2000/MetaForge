/** 认证路由：登录 / 当前用户 / 修改密码 / 钉钉扫码登录（V1.3 #4 2026-10-30 mock 骨架） */
const express = require('express');
const crypto = require('crypto');
const { db, hashPwd, verifyPwd, hashPwdAsync, now } = require('../db');
const { sign, auth, adminOnly, revokeToken, bumpTokenVersion, TOKEN_TTL_MS, setAuthCookie, clearAuthCookie } = require('../lib/auth');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const { loadSecrets } = require('../lib/secrets'); // 钉钉 OAuth 凭证（DINGTALK_APP_KEY/APP_SECRET）
const { mint: mintExchange, consume: consumeExchange } = require('../lib/exchange-code'); // #14：一次性交换码换 JWT
const { upsertDingtalkUser } = require('./dingtalk'); // 扫码登录用户映射复用 user_add_org 同款规则

const router = express.Router();

// ---------- P1-2 登录失败锁定配置（2026-11-11） ----------
const MAX_LOGIN_ATTEMPTS = 5;       // 最大失败次数
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 锁定 15 分钟（毫秒）
const LOCKOUT_DURATION_MIN = 15;    // 锁定 15 分钟（用于显示）

/** 记录登录失败（次数 + 时间戳 + 锁定时间）*/
function countFailedLogin(username, ip) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE username=?').get(username);
  if (!row) {
    const until = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
    // 修复（2026-11-12 P1-2 bug）：INSERT 列序与实参错位——last_attempt 收到 until、
    // locked_until 收到 now()（本地时间字符串），导致首次失败即被"永久锁定"
    // （本地时间字符串被 new Date() 按 UTC 解析恒大于当前时刻）。
    // 正确对位：attempts=1, last_attempt=now(), locked_until=null（未达 5 次不锁）
    db.prepare('INSERT INTO login_attempts (username, ip, attempts, last_attempt, locked_until, created_at) VALUES (?,?,1,?,?,?)')
      .run(username, ip, now(), null, now());
    return;
  }
  const next_attempts = row.attempts + 1;
  const until = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
  // 检查是否已被锁定
  if (row.locked_until && new Date(row.locked_until) > new Date()) return; // 已锁定，不动递增计数
  db.prepare('UPDATE login_attempts SET attempts=?, ip=?, last_attempt=?, locked_until=? WHERE id=?')
    .run(next_attempts, ip, now(), next_attempts >= MAX_LOGIN_ATTEMPTS ? until : null, row.id);
}

/** 检查登录锁定状态：返回 { locked, remaining, msg } */
function checkLoginLock(username) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE username=?').get(username);
  if (!row) return { locked: false, remaining: MAX_LOGIN_ATTEMPTS, msg: '' };
  // 检查锁定时间是否已过
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const remainSec = Math.ceil((new Date(row.locked_until) - new Date()) / 1000);
    return { locked: true, remaining: 0, msg: `账号已被锁定，请 ${Math.ceil(remainSec / 60)} 分钟后再试` };
  }
  const attempts = row.attempts || 0;
  return { locked: false, remaining: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts), msg: attempts >= 3 ? `登录失败 ${attempts} 次，还剩 ${MAX_LOGIN_ATTEMPTS - attempts} 次尝试机会` : '' };
}

/** 登录成功后清除失败计数 */
function clearLoginAttempts(username) {
  db.prepare('DELETE FROM login_attempts WHERE username=?').run(username);
}

// P5.30 安全止血：登录接口按 IP 限流（此前可无限暴力尝试；与 share/openapi 同一套滑动窗口实现，10 次/分钟/IP）
const loginLimiter = createLimiter({ name: 'login', windowMs: 60000, max: 10, keyFn: clientIp, msg: '登录尝试过于频繁，请 1 分钟后再试' });

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  if (!username || !password) return res.json({ code: 400, msg: '请输入账号和密码' });

  // P1-2 失败锁定检查
  const lock = checkLoginLock(username);
  if (lock.locked) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, '登录失败', lock.msg, ip, now());
    return res.json({ code: 401, msg: lock.msg });
  }

  const user = db.prepare('SELECT * FROM users WHERE username=? AND status=1').get(username);
  const v = user ? await verifyPwd(password, user.password) : { ok: false };
  if (!user || !v.ok) {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, '登录失败', '账号或密码错误', ip, now());
    countFailedLogin(username, ip);
    // 二次查询检查锁定状态更新后的剩余次数
    const lockAfter = checkLoginLock(username);
    if (lockAfter.locked) return res.json({ code: 401, msg: lockAfter.msg });
    return res.json({ code: 401, msg: lock.remaining > 0 ? `账号或密码错误（还剩 ${lock.remaining - 1} 次尝试机会）` : '账号或密码错误' });
  }
  // 登录成功：清除失败计数
  clearLoginAttempts(username);
  // 旧 SALT 密码平滑迁移：登录成功即重写为新 SALT 哈希（一次性，用户无感）
  if (v.legacy) db.prepare('UPDATE users SET password=? WHERE id=?').run(await hashPwdAsync(password), user.id);
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS, tv: user.token_version || 0 });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '登录系统', '密码登录成功', ip, now());
  setAuthCookie(res, token); // P2-3：HttpOnly Cookie 签发（token 不再依赖前端 storage 持久化）
  res.json({ code: 0, data: { token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, dept: user.dept, onboarded: user.onboarded ? 1 : 0 }, must_change_pwd: user.must_change_pwd ? 1 : 0 } });
});

router.get('/me', auth, (req, res) => res.json({ code: 0, data: req.user }));

// P0-4 登出：吊销当前 token（仅做令牌废弃，不改状态）；P2-3：同步清除认证 Cookie
router.post('/logout', auth, (req, res) => {
  revokeToken(req);
  clearAuthCookie(res);
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
  // 改密后吊销当前 token（旧 token 立即失效）——P2-3 连带修复（2026-11-09）：吊销后必须重新签发，
  // 否则改密成功即死会话（旧 Cookie 已吊销 / 前端无可用凭据，进入平台即被 401 踢回登录页）；
  // 该缺陷属存量问题，此前因 must_change_pwd 标记失效（P1-3）+ 前端路径 404 双重死链从未暴露
  // SEC-07（2026-11-22）：改密后吊销该用户「全部端」旧令牌——token_version +1 使所有旧 tv 令牌立即失效，
  // 再为本机重新签发携带新版本号的令牌（本人无缝续用，其它端被踢）。
  revokeToken(req);
  const newTv = bumpTokenVersion(user.id);
  const freshToken = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS, tv: newTv });
  setAuthCookie(res, freshToken); // 旧 Cookie 同名覆盖，浏览器立即换新
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(user.username, '修改密码', '密码已更新' + (user.must_change_pwd ? '（弱口令强制改密完成）' : ''), req.ip, now());
  res.json({ code: 0, msg: '密码修改成功', data: { token: freshToken } });
});

// ==================== 钉钉扫码登录（V1.3 #4 2026-10-30，mock 骨架：本地纯逻辑，真实联调后续单独立项） ====================
// OAuth state 防 CSRF：模块级 Map 缓存 5 分钟（/dingtalk/url 签发 ↔ /dingtalk/callback 校验一次性消费）
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const oauthStates = new Map(); // state → { expire, origin }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of oauthStates) if (v.expire < t) oauthStates.delete(k);
}, 60 * 1000).unref(); // unref：不阻塞进程退出

// ---------- #14（2026-11-03）一次性交换码：钉钉回调不再把 JWT 放进 302 URL ----------
// 原实现 res.redirect(302, front + '/#/login?dingtalk_token=' + token)：JWT 整串暴露在浏览器历史/
// Referer/代理日志，且前端从未实现 dingtalk_token 接收（token 白发）。
// 改为：回调用 lib/exchange-code 签发 60s 一次性随机码走 URL（泄露面为短时效一次性码，用过/过期即废），
// 前端 POST /api/auth/dingtalk/exchange 换 JWT（JSON body 交付，token 不落 URL）。

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
//       → sign 签发与密码登录完全同构的 token（sign 内部自动加 jti）→ 签发 60s 一次性交换码
//       → 302 回前端 #/login?dingtalk_code=xxx，前端 POST /dingtalk/exchange 换 JWT（#14：token 不落 URL）
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
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS, tv: user.token_version || 0 });
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
  // ⑥ #14（2026-11-03）安全收口：JWT 不再走 302 URL。签发 60s 一次性交换码走 URL（泄露后 60s 内
  // 一次性消费即作废），前端 POST /api/auth/dingtalk/exchange 换 JWT（JSON body 交付）
  const exchangeCode = mintExchange({
    token,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, dept: user.dept, onboarded: user.onboarded ? 1 : 0 },
    must_change_pwd: user.must_change_pwd ? 1 : 0, // API 形状与 /auth/login 一致（钉钉用户实际恒 0）
  });
  res.redirect(302, front + '/#/login?dingtalk_code=' + exchangeCode);
});

// ---------- POST /dingtalk/exchange：一次性交换码换 JWT（#14 2026-11-03） ----------
// 前端登录页检测 URL hash 的 dingtalk_code 后 POST 本接口；lib/exchange-code consume 命中即删（防重放）。
// 防暴力猜码：与 loginLimiter 同款限流（32 字节随机码本身不可猜，限流做防御纵深）
const dingExchangeLimiter = createLimiter({
  name: 'dingtalk-exchange',
  windowMs: 60000,
  max: 10,
  keyFn: req => req.ip || clientIp(req),
  msg: '交换码验证过于频繁，请稍后再试',
});
router.post('/dingtalk/exchange', dingExchangeLimiter, (req, res) => {
  const payload = consumeExchange(String((req.body || {}).code || ''));
  if (!payload) return res.status(401).json({ code: 401, msg: '交换码无效或已使用（60 秒有效），请重新扫码登录' });
  setAuthCookie(res, payload.token); // P2-3：钉钉扫码登录同样落 HttpOnly Cookie（与密码登录同构）
  res.json({ code: 0, data: payload });
});

// ==================== P1-3 邀请与开通（2026-11-11） ====================
// 管理员生成邀请码
router.post('/invites', auth, adminOnly, (req, res) => {
  const { role, dept, quota_total, max_use, expires_at } = req.body || {};
  const inviteCode = crypto.randomBytes(6).toString('hex'); // 12 位 hex 码
  const max = Math.min(Math.max(parseInt(max_use) || 1, 1), 100);
  db.prepare(`INSERT INTO invited_users (invite_code, role, dept, quota_total, max_use, expires_at, created_by, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,1,datetime('now','localtime'),datetime('now','localtime'))`)
    .run(inviteCode, role || 'user', dept || '', parseInt(quota_total) || 0, max, expires_at || null, req.user.username);
  res.json({ code: 0, data: { invite_code: inviteCode } });
});

// 被邀请用户使用邀请码注册
router.post('/register', async (req, res) => {
  const { username, password, nickname, invite_code } = req.body || {};
  if (!username || !password || !invite_code) return res.json({ code: 400, msg: '缺少必要参数' });
  let codeInfo = db.prepare('SELECT * FROM invited_users WHERE invite_code=? AND enabled=1').get(invite_code);
  if (!codeInfo) return res.json({ code: 400, msg: '邀请码无效' });
  // 检查过期
  if (codeInfo.expires_at && new Date(codeInfo.expires_at) < new Date()) return res.json({ code: 400, msg: '邀请码已过期' });
  // 检查使用次数
  if (codeInfo.max_use > 0 && codeInfo.use_count >= codeInfo.max_use) return res.json({ code: 400, msg: '邀请码已被使用完毕' });
  // 检查用户名唯一性
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.json({ code: 400, msg: '用户名已被占用' });
  // 创建新用户
  const pwdHash = await hashPwdAsync(password);
  db.prepare('INSERT INTO users (username, password, nickname, role, dept, quota_total, status, must_change_pwd, created_at) VALUES (?,?,?,?,?,?,1,0,datetime(\'now\',\'localtime\'))')
    .run(username, pwdHash, nickname || username, codeInfo.role, codeInfo.dept, codeInfo.quota_total);
  // 增加邀请码使用计数
  db.prepare('UPDATE invited_users SET use_count=use_count+1, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(codeInfo.id);
  // 记录注册日志
  db.prepare('INSERT INTO invite_registrations (username, invite_code, ip, created_at) VALUES (?,?,?,?)')
    .run(username, invite_code, req.ip, now());
  // 签发 Token 自动登录
  const user = db.prepare('SELECT id, username, nickname, role, dept, onboarded, token_version FROM users WHERE username=?').get(username);
  const token = sign({ uid: user.id, tv: user.token_version || 0 });
  setAuthCookie(res, token);
  res.json({ code: 0, msg: '注册成功', data: { token, user } });
});

module.exports = router;
