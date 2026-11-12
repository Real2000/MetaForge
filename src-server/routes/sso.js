/**
 * SSO/OIDC 企业登录路由（P1-1 2026-11-11）：OAuth2 授权码流回调、身份绑定
 * 挂载于 /api/auth/sso
 */
const express = require('express');
const { db, now } = require('../db');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const { generateState, consumeState, exchangeCode, bindOrCreateUser, getEnabledProviders } = require('../lib/sso');
const { decrypt } = require('../lib/crypto-util');
const { sign, setAuthCookie } = require('../lib/auth');

const router = express.Router();

// SSO 回调限流（IP 每 10s 5 次，防回调滥用）
const callbackLimiter = createLimiter({ name: 'sso-callback', windowMs: 10000, max: 5, keyFn: clientIp, msg: 'SSO 回调过于频繁，请稍后重试' });

/** 获取已启用的 SSO 提供方列表（登录页渲染用） */
router.get('/providers', (req, res) => {
  const providers = getEnabledProviders().map(p => ({
    id: p.id,
    name: p.name,
    display_name: p.display_name,
  }));
  res.json({ code: 0, data: providers });
});

/** 发起 OAuth2 授权（跳转至身份提供方） */
router.get('/authorize', (req, res) => {
  const providerId = parseInt(req.query.provider_id) || 0;
  const redirect = String(req.query.redirect || '').slice(0, 500);
  const provider = db.prepare('SELECT * FROM sso_providers WHERE id=? AND enabled=1').get(providerId);
  if (!provider) return res.json({ code: 400, msg: 'SSO 提供方不存在或未启用' });

  const authUrl = provider.authorization_url || provider.issuer + '/authorize';
  const { state, nonce } = generateState(providerId, redirect, provider.name);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.client_id,
    redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/sso/callback`,
    state,
    scope: provider.scopes || 'openid profile email',
  });
  if (nonce) params.set('nonce', nonce);

  res.redirect(authUrl + '?' + params.toString());
});

/** OAuth2 回调（身份验证 + 登录/绑定） */
router.post('/callback', callbackLimiter, async (req, res) => {
  const { code, state } = req.body || {};
  if (!code || !state) return res.json({ code: 400, msg: '缺少必要参数 code 或 state' });

  // 验证并消费 state
  const stateRow = consumeState(state);
  if (!stateRow) return res.json({ code: 400, msg: 'state 无效或已过期（请重新发起登录）' });

  const provider = db.prepare('SELECT * FROM sso_providers WHERE id=? AND enabled=1').get(stateRow.provider_id);
  if (!provider) return res.json({ code: 400, msg: 'SSO 提供方已不存在或未启用' });

  try {
    // 交换令牌并获取用户身份
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/sso/callback`;
    const userInfo = await exchangeCode(provider, code, redirectUri);
    const result = await bindOrCreateUser(provider, userInfo);

    if (result.code === 0) {
      // 登录成功，签发平台 Token
      const u = result.data.user;
      const token = sign({ uid: u.id });
      setAuthCookie(res, token); // 写 HttpOnly Cookie
      // 透传原始 redirect_uri（如果有的话）
      const goto = stateRow.redirect_uri || '/#/home';
      res.json({ code: 0, msg: 'SSO 登录成功', data: { token, user: u, redirect: goto } });
    } else if (result.code === 302) {
      // 需要绑定已有账号：返回绑定所需信息，前端跳转绑定页
      res.json({ code: 302, data: result.data });
    } else {
      res.json(result);
    }
  } catch (e) {
    res.json({ code: 500, msg: 'SSO 身份验证失败：' + e.message });
  }
});

/** 绑定已有平台账号（首次 SSO 登录后） */
router.post('/bind', async (req, res) => {
  const { provider, subject, username, password } = req.body || {};
  if (!provider || !subject || !username || !password) return res.json({ code: 400, msg: '缺少必要参数' });

  // 验证平台账号密码
  const { verifyPwd, hashPwdAsync } = require('../db');
  const user = db.prepare('SELECT * FROM users WHERE username=? AND status=1').get(username);
  if (!user) return res.json({ code: 400, msg: '账号不存在或已停用' });
  const ok = await verifyPwd(password, user.password);
  if (!ok) return res.json({ code: 400, msg: '密码错误' });

  // 建立绑定关系
  db.prepare('INSERT OR IGNORE INTO user_sso_identities (username, provider, subject, last_login, created_at) VALUES (?,?,?,?,?)')
    .run(username, provider, subject, now(), now());

  // 签发 Token 并登录
  const token = sign({ uid: user.id });
  setAuthCookie(res, token);
  res.json({ code: 0, msg: '绑定成功', data: { token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role } } });
});

module.exports = router;
