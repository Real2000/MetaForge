/**
 * P2-20 语音供应商配置（2026-11-13）
 *
 * 独立语音供应商管理接口，支持 STT（语音识别）/TTS（语音合成）双模式。
 * 每个供应商可配置模型、音色列表、速率选项、语言等。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth, adminOnly);

// U0-2（N3-P2）流式适配位：供应商流式能力可选值
const STREAM_TYPES = ['batch', 'ws', 'http-chunk'];

// 获取全部语音供应商
router.get('/', (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM voice_providers WHERE 1=1';
  const args = [];
  if (type) { sql += ' AND type=?'; args.push(type); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...args);
  res.json({ code: 0, data: rows });
});

// 创建语音供应商
router.post('/', (req, res) => {
  const { name, type, base_url, api_key, endpoint, model_name, voices, languages, rate_options, is_default, remark, stream_type, stream_endpoint } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '名称不能为空' });
  const st = (stream_type === undefined || stream_type === null || stream_type === '') ? 'batch' : stream_type;
  if (!STREAM_TYPES.includes(st)) return res.json({ code: 400, msg: `stream_type 非法（应为 ${STREAM_TYPES.join(' / ')}）` });
  const info = db.prepare(`INSERT INTO voice_providers (name,type,base_url,api_key,endpoint,model_name,voices,languages,rate_options,configured,is_default,remark,stream_type,stream_endpoint,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      name, type || 'both', base_url || '', api_key || '', endpoint || '', model_name || '',
      JSON.stringify(voices || []), JSON.stringify(languages || []), JSON.stringify(rate_options || []),
      (base_url && api_key) ? 1 : 0, is_default ? 1 : 0, remark || '', st, stream_endpoint || '', now(), now()
    );
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '创建语音供应商', name, req.ip, now());
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
});

// 更新语音供应商
router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM voice_providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '语音供应商不存在' });
  const { name, type, base_url, api_key, endpoint, model_name, voices, languages, rate_options, is_default, remark, stream_type, stream_endpoint } = req.body || {};
  const keyIn = typeof api_key === 'string' ? api_key.trim() : '';
  const nextKey = keyIn && !keyIn.includes('****') ? api_key : old.api_key;
  const configured = (base_url || old.base_url) && nextKey ? 1 : old.configured;
  let nextStreamType = old.stream_type || 'batch';
  if (stream_type !== undefined && stream_type !== null && stream_type !== '') {
    if (!STREAM_TYPES.includes(stream_type)) return res.json({ code: 400, msg: `stream_type 非法（应为 ${STREAM_TYPES.join(' / ')}）` });
    nextStreamType = stream_type;
  }
  db.prepare(`UPDATE voice_providers SET name=?,type=?,base_url=?,api_key=?,endpoint=?,model_name=?,voices=?,languages=?,rate_options=?,configured=?,is_default=?,remark=?,stream_type=?,stream_endpoint=?,updated_at=? WHERE id=?`)
    .run(
      name || old.name, type || old.type, base_url ?? old.base_url, nextKey, endpoint ?? old.endpoint,
      model_name ?? old.model_name, JSON.stringify(voices || JSON.parse(old.voices || '[]')),
      JSON.stringify(languages || JSON.parse(old.languages || '[]')),
      JSON.stringify(rate_options || JSON.parse(old.rate_options || '[]')),
      configured, is_default !== undefined ? (is_default ? 1 : 0) : old.is_default, remark ?? old.remark,
      nextStreamType, stream_endpoint ?? old.stream_endpoint, now(), old.id
    );
  res.json({ code: 0 });
});

// 删除语音供应商
router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM voice_providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '语音供应商不存在' });
  if (old.is_default) return res.json({ code: 400, msg: '默认供应商不可删除，请先切换默认' });
  db.prepare('DELETE FROM voice_providers WHERE id=?').run(old.id);
  res.json({ code: 0 });
});

// 测试连接
router.post('/:id/test', async (req, res) => {
  const p = db.prepare('SELECT * FROM voice_providers WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '语音供应商不存在' });
  try {
    const base = p.base_url.replace(/\/+$/, '');
    const url = base + (p.endpoint || '/v1/audio/speech');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.api_key },
      body: JSON.stringify({ model: 'test', input: 'test' }),
      signal: AbortSignal.timeout(10000),
    });
    res.json({ code: 0, data: { ok: r.ok, status: r.status, msg: r.ok ? '连通成功' : `HTTP ${r.status}` } });
  } catch (e) {
    res.json({ code: 0, data: { ok: false, status: 0, msg: '连接失败：' + e.message } });
  }
});

module.exports = router;