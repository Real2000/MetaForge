/** 工具 API Key 管理（P3-2 2026-11-06 工具市场扩展）：用户为需要鉴权的内置工具填自己的 Key
 *  - 存储：user_tool_keys 表（username+tool_name 唯一，api_key AES-256-GCM 加密落盘，与 user_providers 同一套 crypto-util）
 *  - 隐私保护对齐 usermodels：列表只回掩码（头3尾4），编辑传掩码/空保留旧值，绝不回明文
 *  - 白名单校验：只允许登记 KEYED_TOOLS 内的工具（防止把 key 写到无关工具名下造成语义混乱）
 *  - 工具消费：lib/tools-market.js getUserToolKey 按 ctx.username 读取解密（对话主链路带 username；未配置走免费公共源兜底）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { encrypt, decrypt } = require('../lib/crypto-util');
const { KEYED_TOOL_META } = require('../lib/tools-market');

const router = express.Router();
router.use(auth);

/** 可配用户 Key 的工具清单（tool_name → 展示元信息）——元数据单一事实来源在 lib/tools-market.js KEYED_TOOL_META */
const KEYED_TOOLS = KEYED_TOOL_META;

function maskKey(k) {
  const s = String(k || '');
  return s ? s.slice(0, 3) + '****' + s.slice(-4) : '';
}

/** 可配工具清单（前端渲染用）：合并已登记状态 */
router.get('/meta', (req, res) => {
  const rows = dal.q('SELECT tool_name FROM user_tool_keys WHERE username=?', [req.user.username]);
  const registered = new Set(rows.map(r => r.tool_name));
  res.json({
    code: 0,
    data: Object.entries(KEYED_TOOLS).map(([name, meta]) => ({
      tool_name: name,
      ...meta,
      registered: registered.has(name),
    })),
  });
});

/** 本人 Key 列表（掩码回显，绝不回明文） */
router.get('/', (req, res) => {
  const rows = dal.q('SELECT id, tool_name, api_key, note, status, created_at FROM user_tool_keys WHERE username=? ORDER BY id', [req.user.username]);
  res.json({
    code: 0,
    data: rows.map(r => ({
      ...r,
      api_key: maskKey(decrypt(r.api_key)),
      key_set: !!r.api_key,
      label: KEYED_TOOLS[r.tool_name]?.label || r.tool_name,
    })),
  });
});

/** 登记工具 Key */
router.post('/', (req, res) => {
  const { tool_name, api_key, note } = req.body || {};
  if (!tool_name || !KEYED_TOOLS[tool_name]) {
    return res.json({ code: 400, msg: `不支持的工具：${tool_name || '(空)'}（可配：${Object.keys(KEYED_TOOLS).join(' / ')}）` });
  }
  if (!api_key || !String(api_key).trim()) return res.json({ code: 400, msg: 'API Key 不能为空' });
  const dup = dal.getq('SELECT id FROM user_tool_keys WHERE username=? AND tool_name=?', [req.user.username, tool_name]);
  if (dup) return res.json({ code: 400, msg: '该工具已配置过 Key，请直接编辑' });
  const info = dal.runq('INSERT INTO user_tool_keys (username,tool_name,api_key,note,status,created_at) VALUES (?,?,?,?,1,?)', [req.user.username, tool_name, encrypt(String(api_key).trim()), String(note || '').slice(0, 100), now()]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '配置工具 API Key', `${KEYED_TOOLS[tool_name].label}`, req.ip, now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

/** 编辑（Key 掩码/空保留旧值——与 usermodels 同一套编辑保护语义） */
router.put('/:id', (req, res) => {
  const old = dal.getq('SELECT * FROM user_tool_keys WHERE id=? AND username=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '工具 Key 记录不存在' });
  const { api_key, note, status } = req.body || {};
  const keepKey = (api_key == null || api_key === '' || String(api_key).includes('****')) ? old.api_key : encrypt(String(api_key).trim());
  dal.runq('UPDATE user_tool_keys SET api_key=?,note=?,status=? WHERE id=?', [keepKey, note == null ? old.note : String(note).slice(0, 100), status == null ? old.status : (status ? 1 : 0), old.id]);
  res.json({ code: 0, msg: '已保存' });
});

/** 删除 */
router.delete('/:id', (req, res) => {
  dal.runq('DELETE FROM user_tool_keys WHERE id=? AND username=?', [req.params.id, req.user.username]);
  res.json({ code: 0, msg: '已删除' });
});

/** 连通测试：按工具走对应供应商的免费校验端点（只验鉴权不花额度） */
router.post('/:id/test', async (req, res) => {
  const old = dal.getq('SELECT * FROM user_tool_keys WHERE id=? AND username=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '工具 Key 记录不存在' });
  const plainKey = decrypt(old.api_key);
  if (!plainKey) return res.json({ code: 0, data: { ok: false, msg: '❌ 未配置 Key' } });
  try {
    let ok = false, msg = '';
    if (old.tool_name === 'weather_query') {
      // 和风天气：geoapi 城市查询（轻量免费端点，只验 Key 有效性）
      const r = await fetch(`https://geoapi.qweather.com/v2/city/lookup?location=beijing&key=${encodeURIComponent(plainKey)}`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      ok = j.code === '200';
      msg = ok ? '✅ Key 有效（和风天气接口连通）' : `❌ 校验失败：${j.code === '401' ? 'Key 无效或未授权' : 'code ' + j.code}`;
    } else if (old.tool_name === 'translate_text') {
      // DeepL：usage 端点（免费额度查询，只验鉴权）
      const r = await fetch('https://api-free.deepl.com/v2/usage', {
        headers: { Authorization: `DeepL-Auth-Key ${plainKey}` },
        signal: AbortSignal.timeout(8000),
      });
      ok = r.ok;
      if (ok) {
        const u = await r.json().catch(() => ({}));
        msg = `✅ Key 有效（本月已用 ${u.character_count ?? '?'} / ${u.character_limit ?? '?'} 字符）`;
      } else {
        msg = `❌ 校验失败：HTTP ${r.status}（403 = Key 无效或非 Free 计划端点）`;
      }
    } else {
      return res.json({ code: 0, data: { ok: false, msg: '该工具无需连通测试' } });
    }
    res.json({ code: 0, data: { ok, msg } });
  } catch (e) {
    res.json({ code: 0, data: { ok: false, msg: '❌ 无法连接：' + e.message } });
  }
});

module.exports = router;
