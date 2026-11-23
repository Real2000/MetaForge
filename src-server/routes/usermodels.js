/** 我的模型（2026-10-20 P3）：用户自有 OpenAI 兼容模型源 CRUD + 连通测试
 *  用户自带 API Key 接入个人/第三方模型服务，与平台供应商完全隔离——仅本人可见可用；
 *  对话选模型时同名模型优先路由用户自有渠道（见 llm.js buildCandidates ⓪ 段）。
 *  隐私保护：列表接口不回传完整 Key（仅显示头尾掩码）；编辑时不回传明文，占位提交保留旧值。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { encrypt, decrypt } = require('../lib/crypto-util');
const { assertPublicHttpUrl } = require('../lib/ssrf-guard'); // SEC-05：用户自填 URL 的服务端请求统一过 SSRF 校验

const router = express.Router();
router.use(auth);

function maskKey(k) {
  const s = String(k || '');
  return s ? s.slice(0, 3) + '****' + s.slice(-4) : '';
}

function parseModels(models, oldJson) {
  if (Array.isArray(models)) return models.filter(Boolean);
  if (typeof models === 'string' && models.trim()) return models.split(/[,，\s]+/).filter(Boolean);
  try { return JSON.parse(oldJson || '[]'); } catch { return []; }
}

router.get('/', (req, res) => {
  const rows = dal.q('SELECT * FROM user_providers WHERE username=? ORDER BY id', [req.user.username]);
  res.json({
    code: 0,
    data: rows.map(r => ({ ...r, api_key: maskKey(decrypt(r.api_key)), key_set: !!r.api_key })),
  });
});

router.post('/', async (req, res) => {
  const { name, base_url, api_key, models } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '名称不能为空' });
  if (!base_url?.trim()) return res.json({ code: 400, msg: '服务地址不能为空（OpenAI 兼容，如 https://api.xxx.com/v1）' });
  // SEC-05：SSRF 校验（拒绝私网/环回/云元数据地址，除非管理员 AGENT_FETCH_ALLOW_PRIVATE=1）
  try { await assertPublicHttpUrl(base_url.trim()); } catch (e) { return res.json({ code: 400, msg: e.message }); }
  const cnt = dal.getq('SELECT COUNT(*) c FROM user_providers WHERE username=?', [req.user.username]).c;
  if (cnt >= 10) return res.json({ code: 400, msg: '每人最多接入 10 个模型源' });
  const ms = parseModels(models, '[]');
  if (!ms.length) return res.json({ code: 400, msg: '请至少填写一个模型标识（逗号或空格分隔）' });
  const info = dal.runq('INSERT INTO user_providers (username,name,base_url,api_key,models,status,created_at) VALUES (?,?,?,?,?,1,?)', [req.user.username, name.trim(), base_url.trim(), api_key ? encrypt(api_key) : '', JSON.stringify(ms), now()]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '接入我的模型', `${name.trim()}（${ms.length} 个模型）`, req.ip, now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', async (req, res) => {
  const old = dal.getq('SELECT * FROM user_providers WHERE id=? AND username=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '模型源不存在' });
  const { name, base_url, api_key, models, status } = req.body || {};
  // SEC-05：改地址同样过 SSRF 校验
  if (base_url && base_url.trim()) { try { await assertPublicHttpUrl(base_url.trim()); } catch (e) { return res.json({ code: 400, msg: e.message }); } }
  const ms = parseModels(models, old.models);
  // Key 编辑保护：未传/传空/传掩码（****）都保留旧值；只有传新明文才覆盖
  const keepKey = (api_key == null || api_key === '' || String(api_key).includes('****')) ? old.api_key : encrypt(api_key);
  dal.runq('UPDATE user_providers SET name=?,base_url=?,api_key=?,models=?,status=? WHERE id=?', [name?.trim() || old.name, base_url?.trim() || old.base_url, keepKey, JSON.stringify(ms),
      status == null ? old.status : (status ? 1 : 0), old.id]);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  dal.runq('DELETE FROM user_providers WHERE id=? AND username=?', [req.params.id, req.user.username]);
  res.json({ code: 0, msg: '已删除' });
});

// 连通测试（与后台模型接入同一套两级校验）：① /models 列表（网络与鉴权）② 清单第一个模型真实调用（调用权限）
router.post('/:id/test', async (req, res) => {
  const old = dal.getq('SELECT * FROM user_providers WHERE id=? AND username=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '模型源不存在' });
  if (!old.base_url) return res.json({ code: 0, data: { ok: false, msg: '❌ 未配置服务地址' } });
  // SEC-05：连通测试是真实出站请求——先过 SSRF 校验（防把本机/内网地址作为探测目标）
  try { await assertPublicHttpUrl(old.base_url); } catch (e) { return res.json({ code: 0, data: { ok: false, msg: '❌ ' + e.message } }); }
  try {
    const url = old.base_url.replace(/\/+$/, '') + '/models';
    const plainKey = decrypt(old.api_key);
    const r = await fetch(url, { headers: plainKey ? { Authorization: 'Bearer ' + plainKey } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ code: 0, data: { ok: false, msg: `❌ 列表接口返回 ${r.status}（检查地址与 API Key）` } });
    const ms = JSON.parse(old.models || '[]');
    if (!ms.length) return res.json({ code: 0, data: { ok: true, msg: '✅ 网关连通（尚未配置模型，请补充模型清单）' } });
    let v;
    try {
      const cr = await fetch(old.base_url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + decrypt(old.api_key) },
        body: JSON.stringify({ model: ms[0], messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(20000),
      });
      v = cr.ok
        ? { ok: true, msg: `✅ 连通，模型 ${ms[0]} 可正常调用` }
        : { ok: false, msg: `⚠️ 网关连通，但模型 ${ms[0]} 调用失败：HTTP ${cr.status}（建议核对模型标识或 Key 权限）` };
    } catch (e) {
      v = { ok: false, msg: `⚠️ 网关连通，但模型 ${ms[0]} 调用失败：${e.message}` };
    }
    res.json({ code: 0, data: v });
  } catch (e) {
    res.json({ code: 0, data: { ok: false, msg: '❌ 无法连接：' + e.message } });
  }
});

module.exports = router;
