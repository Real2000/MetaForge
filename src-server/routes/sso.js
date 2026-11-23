/**
 * SSO/OIDC 企业登录路由（P1-1 2026-11-11）：OAuth2 授权码流回调、身份绑定
 * 挂载于 /api/auth/sso
 * 
 * 管理端 CRUD 也挂在同一个 router（adminOnly 保护），避免新增路由文件
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const { getEnabledProviders, generateState, consumeState, exchangeCode, bindOrCreateUser } = require('../lib/sso');
const { encrypt, decrypt } = require('../lib/crypto-util');
const { assertPublicHttpUrl } = require('../lib/ssrf-guard'); // SEC-05：SSO 端点 URL 的 SSRF 校验
const { sign, setAuthCookie, auth } = require('../lib/auth');

const router = express.Router();

// SSO 回调限流（IP 每 10s 5 次，防回调滥用）
const callbackLimiter = createLimiter({ name: 'sso-callback', windowMs: 10000, max: 5, keyFn: clientIp, msg: 'SSO 回调过于频繁，请稍后重试' });

/** 获取已启用的 SSO 提供方列表（登录页渲染用） */
router.get('/providers', (req, res) => {
  const providers = getEnabledProviders().map(p => ({
    id: p.id,
    name: p.name,
    display_name: p.display_name,
    type: p.type || 'oidc',
  }));
  res.json({ code: 0, data: providers });
});

/** OAuth2 授权码回调（POST，非 GET 回调，适配前端发起的最终回调请求） */
router.post('/callback', callbackLimiter, async (req, res) => {
  const { state, code, provider_id } = req.body || {};
  if (!state || !code || !provider_id) return res.json({ code: 400, msg: '缺少参数 state/code/provider_id' });
  try {
    const stateRec = consumeState(state);
    if (!stateRec) return res.json({ code: 400, msg: 'state 无效或已过期，请重新发起登录' });
    // 执行 OAuth2 授权码交换
    const identity = await exchangeCode(code, provider_id);
    const user = await bindOrCreateUser(identity, provider_id);
    const token = sign({ uid: user.id, exp: Date.now() + 7 * 86400000, tv: user.token_version || 0 });
    setAuthCookie(res, token);
    res.json({ code: 0, data: { token, user } });
  } catch (e) {
    res.json({ code: 500, msg: 'SSO 登录失败：' + e.message });
  }
});

// ====================== 以下为管理端 CRUD（adminOnly） ======================
router.use(auth);

// 获取 SSO 提供方列表（含配置字段，仅管理员可见）
router.get('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  const rows = dal.q('SELECT * FROM sso_providers ORDER BY id');
  // 密钥脱敏
  const safe = rows.map(r => ({ ...r, client_secret: r.client_secret ? '••••••••' : '' }));
  res.json({ code: 0, data: safe });
});

// 创建 SSO 提供方
router.post('/', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.json({ code: 400, msg: '提供方名称不能为空' });
  // SEC-05：SSO 端点 URL 出站前需为公网地址（issuer/authorization_url/token_url/userinfo_url）
  for (const k of ['issuer', 'authorization_url', 'token_url', 'userinfo_url']) {
    if (b[k] && String(b[k]).trim()) { try { await assertPublicHttpUrl(String(b[k]).trim()); } catch (e) { return res.json({ code: 400, msg: `字段 ${k} 非法：${e.message}` }); } }
  }
  const secret = String(b.client_secret || '');
  const encrypted = secret ? encrypt(secret) : '';
  dal.runq(`INSERT INTO sso_providers (name, display_name, issuer, client_id, client_secret,
    authorization_url, token_url, userinfo_url, scopes, type, jwt_bind_mode, allow_local_login, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,1,0,datetime('now','localtime'),datetime('now','localtime'))`, [
    name, String(b.display_name || ''), String(b.issuer || ''), String(b.client_id || ''), encrypted,
    String(b.authorization_url || ''), String(b.token_url || ''), String(b.userinfo_url || ''),
    String(b.scopes || ''), String(b.type || 'oidc')]);
  res.json({ code: 0, msg: '已创建' });
});

// 更新 SSO 提供方
router.put('/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  const old = dal.getq('SELECT * FROM sso_providers WHERE id=?', [req.params.id]);
  if (!old) return res.json({ code: 404, msg: 'SSO 提供方不存在' });
  const b = req.body || {};
  // SEC-05：SSO 端点 URL 出站前需为公网地址
  for (const k of ['issuer', 'authorization_url', 'token_url', 'userinfo_url']) {
    if (b[k] && String(b[k]).trim()) { try { await assertPublicHttpUrl(String(b[k]).trim()); } catch (e) { return res.json({ code: 400, msg: `字段 ${k} 非法：${e.message}` }); } }
  }
  const secret = String(b.client_secret || '');
  // 仅当提供了新密钥且与掩码不同时才更新
  const updatedSecret = (secret && secret !== '••••••••') ? encrypt(secret) : old.client_secret;
  dal.runq(`UPDATE sso_providers SET name=?,display_name=?,issuer=?,client_id=?,client_secret=?,
    authorization_url=?,token_url=?,userinfo_url=?,scopes=?,type=?,updated_at=datetime('now','localtime') WHERE id=?`, [String(b.name || ''), String(b.display_name || ''), String(b.issuer || ''), String(b.client_id || ''),
      updatedSecret, String(b.authorization_url || ''), String(b.token_url || ''), String(b.userinfo_url || ''),
      String(b.scopes || ''), String(b.type || 'oidc'), req.params.id]);
  res.json({ code: 0, msg: '已保存' });
});

// 启用/停用切换
router.post('/:id/toggle', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  const old = dal.getq('SELECT id, enabled FROM sso_providers WHERE id=?', [req.params.id]);
  if (!old) return res.json({ code: 404, msg: 'SSO 提供方不存在' });
  const next = old.enabled ? 0 : 1;
  dal.runq('UPDATE sso_providers SET enabled=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [next, old.id]);
  res.json({ code: 0, data: { enabled: !!next } });
});

// 删除 SSO 提供方（先停用后删除）
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  dal.runq('DELETE FROM sso_providers WHERE id=?', [req.params.id]);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
