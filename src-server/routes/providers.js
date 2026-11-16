/** 模型接入：供应商 CRUD / 模型管理 / 设默认 / 同步模型 / 连通测试 / 健康面板（P4：全量模型+类型体系） */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const circuit = require('../lib/circuit');
const { classifyModel } = require('../lib/model-types');
const { encrypt, decrypt } = require('../lib/crypto-util');

const router = express.Router();
router.use(auth, adminOnly);

function parseTypes(str) {
  try { return JSON.parse(str || '{}') || {}; } catch { return {}; }
}
/** 按模型类型补全 model_types 映射（缺失项自动分类） */
function ensureTypes(ms, typesObj) {
  const out = { ...typesObj };
  (ms || []).forEach(m => { if (!out[m]) out[m] = classifyModel(m); });
  return out;
}

/** U1-6：解析/校验请求体里的 model_price（对象或 JSON 字符串）。返回规范化 JSON 字符串；非法返回 null */
function parsePriceBody(v) {
  let obj = v;
  if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { return null; } }
  if (v === undefined || v === null) return null;
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [m, p] of Object.entries(obj)) {
    const input = Number(p && p.input), output = Number(p && p.output);
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null; // 单价非法即整体拒绝（负价会污染报表）
    out[m] = { input, output };
  }
  return JSON.stringify(out);
}

/** P5.30 安全止血：API Key 脱敏展示（保留前 3 后 4）——此前 GET /api/providers 把完整 Key 明文回传浏览器，
 *  XSS 或浏览器缓存泄露即丢全网关 Key。编辑语义改为「留空不修改」（前端 models.js 同步适配，PUT 侧另有掩码防御） */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 3) + '****' + k.slice(-4);
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM providers ORDER BY id').all().map(p => {
    const plain = decrypt(p.api_key);
    return { ...p, api_key: maskKey(plain), model_types: parseTypes(p.model_types) };
  });
  res.json({ code: 0, data: rows });
});

// 健康面板（2026-10-20 P1）：最近调用状态 + 熔断中的模型（管理页指示灯数据源）
router.get('/health', (req, res) => {
  res.json({ code: 0, data: circuit.healthReport() });
});

router.post('/', (req, res) => {
  const { name, base_url, api_key, models, remark, model_price } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '供应商名称不能为空' });
  const ms = typeof models === 'string' ? models.split(/[,，\s]+/).filter(Boolean) : (models || []);
  const configured = 1;
  const priceJson = parsePriceBody(model_price);
  if (model_price !== undefined && priceJson === null) return res.json({ code: 400, msg: '模型单价格式不正确（应为 {"模型名":{"input":x,"output":y}}，元/千Token，非负）' });
  const encryptedKey = api_key ? encrypt(api_key) : '';
  const info = db.prepare(`INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,model_price,created_at) VALUES (?,?,?,?,?,0,?,?,datetime('now','localtime'))`)
    .run(name.trim(), base_url || '', encryptedKey, JSON.stringify(ms), configured, remark || '', priceJson || '{}');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '新增模型供应商', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  const { name, base_url, api_key, models, remark, auth_type, auth_config, status, status_msg, model_price } = req.body || {};
  let ms;
  if (Array.isArray(models)) ms = models;
  else if (typeof models === 'string' && models) ms = models.split(/[,，\s]+/).filter(Boolean);
  else ms = JSON.parse(old.models || '[]');
  // P5.30 安全止血：api_key 为空或含掩码一律视为「不修改」
  const keyIn = typeof api_key === 'string' ? api_key.trim() : '';
  const nextKey = keyIn && !keyIn.includes('****') ? encrypt(keyIn) : old.api_key;
  const configured = base_url && nextKey ? 1 : old.configured;
  const nextAuthType = auth_type || old.auth_type || 'bearer';
  const nextAuthConfig = auth_config !== undefined ? (typeof auth_config === 'string' ? auth_config : JSON.stringify(auth_config)) : (old.auth_config || '{}');
  // U1-6：model_price 未传保持原值；传入必须合法（非法拒绝保存，负价会污染成本报表）
  const priceJson = parsePriceBody(model_price);
  if (model_price !== undefined && priceJson === null) return res.json({ code: 400, msg: '模型单价格式不正确（应为 {"模型名":{"input":x,"output":y}}，元/千Token，非负）' });
  const nextPrice = model_price !== undefined ? priceJson : (old.model_price || '{}');
  db.prepare('UPDATE providers SET name=?,base_url=?,api_key=?,models=?,configured=?,remark=?,auth_type=?,auth_config=?,status=?,status_msg=?,model_price=? WHERE id=?')
    .run(name || old.name, base_url ?? old.base_url, nextKey, JSON.stringify(ms), configured, remark ?? old.remark,
      nextAuthType, nextAuthConfig, status !== undefined ? status : (old.status ?? 1), status_msg ?? old.status_msg ?? '', nextPrice, old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '配置模型供应商', name || old.name, req.ip, now());
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (old?.is_default) return res.json({ code: 400, msg: '默认供应商不可删除，请先切换默认' });
  db.prepare('DELETE FROM providers WHERE id=?').run(req.params.id);
  res.json({ code: 0, msg: '已删除' });
});

router.post('/:id/default', (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  // 修复：原代码漏了 .run()，导致「清空其他默认」从未执行 → 出现多个默认供应商并存
  db.prepare('UPDATE providers SET is_default=0').run();
  db.prepare('UPDATE providers SET is_default=1 WHERE id=?').run(old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '设置默认供应商', old.name, req.ip, now());
  res.json({ code: 0, msg: `已将「${old.name}」设为默认` });
});

/** 用供应商 Key 真实调用一次对应类型接口（P4：按类型选端点——chat→/chat/completions、image→/images/generations、
 *  video→/videos/generations、tts→/audio/speech、embedding→/embeddings），验证模型可调用。
 *  返回 { ok, msg }；/models 列表接口能通不代表有调用权限，403 等问题只有真实调用才暴露 */
async function verifyModelByType(base_url, api_key, model, type = 'chat') {
  const base = base_url.replace(/\/+$/, '');
  let url, body;
  if (type === 'image') { url = base + '/images/generations'; body = { model, prompt: 'ping', size: '720x1280', n: 1 }; }
  else if (type === 'video') { url = base + '/videos/generations'; body = { model, prompt: 'ping', duration: 10, aspect_ratio: '16:9' }; }
  else if (type === 'tts') { url = base + '/audio/speech'; body = { model, input: 'ping' }; }
  else if (type === 'embedding') { url = base + '/embeddings'; body = { model, input: 'ping' }; }
  else { url = base + '/chat/completions'; body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }; }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(api_key ? { Authorization: 'Bearer ' + api_key } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) return { ok: true, msg: '调用成功' };
    // 兼容两种错误格式：{"error":"文本"}（TG 网关）与 {"error":{"message":"..."}}（OpenAI 标准）
    let detail = '';
    try {
      const j = await r.json();
      detail = typeof j.error === 'string' ? j.error : (j.error?.message || j.message || '');
    } catch { }
    return { ok: false, msg: `HTTP ${r.status}${detail ? '：' + detail : ''}` };
  } catch (e) {
    return { ok: false, msg: '无法连接：' + e.message };
  }
}

// 添加模型：按类型真实调用校验（防把无权限/不存在的模型加入清单），通过才入库并标注类型
router.post('/:id/models', async (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  const m = ((req.body || {}).model || '').trim();
  if (!m) return res.json({ code: 400, msg: '模型名不能为空' });
  if (!old.base_url) return res.json({ code: 400, msg: '供应商未配置服务地址，请先在「配置」中填写' });
  const type = ['chat', 'image', 'video', 'tts', 'embedding'].includes((req.body || {}).type) ? (req.body || {}).type : classifyModel(m);
  const ms = JSON.parse(old.models || '[]');
  if (ms.includes(m)) return res.json({ code: 400, msg: '模型已存在' });
  // 按类型真实连通性校验（列表能通 ≠ 有调用权限，如 TG 网关「仅限自有算力模型」403）
  const v = await verifyModelByType(old.base_url, decrypt(old.api_key), m, type);
  if (!v.ok) {
    return res.json({ code: 400, msg: `校验未通过，未添加：${v.msg}。请确认模型标识正确且当前 API Key 有调用权限（网关类供应商通常仅开放自有算力模型）` });
  }
  ms.push(m);
  const types = ensureTypes(ms, parseTypes(old.model_types));
  types[m] = type;
  db.prepare('UPDATE providers SET models=?,model_types=? WHERE id=?').run(JSON.stringify(ms), JSON.stringify(types), old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '添加模型', `${old.name} → ${m}（类型 ${type}，真实调用校验通过）`, req.ip, now());
  res.json({ code: 0, msg: `校验通过，已添加 ${type === 'chat' ? '对话' : type === 'image' ? '生图' : type === 'video' ? '视频' : type === 'tts' ? '语音' : '嵌入'}模型 ${m}` });
});

router.delete('/:id/models/:model', (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  const ms = JSON.parse(old.models || '[]').filter(m => m !== req.params.model);
  db.prepare('UPDATE providers SET models=? WHERE id=?').run(JSON.stringify(ms), old.id);
  res.json({ code: 0, msg: '已移除模型' });
});

// 同步模型：调用 {base_url}/models（OpenAI 兼容）拉取**全量**模型（P4：不再过滤非文本，
// 生图/视频/语音等全部入清单并自动分类，前台四模式按类型分别使用）
router.post('/:id/sync', async (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  const plainKey = decrypt(old.api_key);
  if (!old.base_url || !plainKey) return res.json({ code: 400, msg: '请先填写服务地址与 API Key' });
  try {
    const url = old.base_url.replace(/\/+$/, '') + '/models';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + plainKey }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const all = (j.data || []).map(x => x.id).filter(Boolean).slice(0, 60);
    if (!all.length) throw new Error('未同步到任何模型');
    const types = {};
    all.forEach(m => { types[m] = classifyModel(m); });
    db.prepare('UPDATE providers SET models=?,model_types=?,configured=1 WHERE id=?').run(JSON.stringify(all), JSON.stringify(types), old.id);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '同步模型', `${old.name}（${all.length} 个，含生图/视频/语音等全类型）`, req.ip, now());
    res.json({ code: 0, data: { count: all.length } });
  } catch (e) {
    res.json({ code: 400, msg: '同步失败：' + e.message + '（可改用手动添加模型）' });
  }
});

// 连通测试：两级——① /models 列表（网络与鉴权）② 清单第一个模型真实调用（调用权限）。
// 仅测列表会漏掉「列表能拉到但无权调用」的情况（如网关 403 仅限自有算力模型）
router.post('/:id/test', async (req, res) => {
  const old = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '供应商不存在' });
  if (!old.base_url) return res.json({ code: 400, msg: '未配置服务地址' });
  const plainKey = decrypt(old.api_key);
  try {
    const url = old.base_url.replace(/\/+$/, '') + '/models';
    const r = await fetch(url, { headers: plainKey ? { Authorization: 'Bearer ' + plainKey } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ code: 0, data: { ok: false, status: r.status, msg: `❌ 列表接口返回 ${r.status}（检查地址与 API Key）` } });
    const ms = JSON.parse(old.models || '[]');
    if (!ms.length) return res.json({ code: 0, data: { ok: true, status: r.status, msg: '✅ 网关连通（尚未接入模型，请先添加或同步模型）' } });
    // 对清单第一个模型按类型做真实调用，验证调用权限
    const types = parseTypes(old.model_types);
    const v = await verifyModelByType(old.base_url, plainKey, ms[0], types[ms[0]] || classifyModel(ms[0]));
    res.json({
      code: 0,
      data: { ok: v.ok, status: r.status, msg: v.ok ? `✅ 网关连通，模型 ${ms[0]} 可正常调用` : `⚠️ 网关连通，但模型 ${ms[0]} 调用失败：${v.msg}（建议移除该模型或更换 Key）` },
    });
  } catch (e) {
    res.json({ code: 0, data: { ok: false, status: 0, msg: '❌ 无法连接：' + e.message } });
  }
});

module.exports = router;
module.exports.verifyModelByType = verifyModelByType; // 导出供冒烟测试校验端点映射

/* ==================== P2-9 模型能力注册表 ==================== */

// 注册模型能力
router.post('/capabilities', adminOnly, (req, res) => {
  const { model_name, provider_name, capability, priority, enabled } = req.body || {};
  if (!model_name || !capability) return res.json({ code: 400, msg: '请提供 model_name 和 capability' });
  const allowed = ['text', 'vision', 'audio', 'embedding', 'rerank', 'image_gen', 'video_gen', 'tool_call', 'streaming'];
  if (!allowed.includes(capability)) return res.json({ code: 400, msg: `capability 必须为以下之一：${allowed.join(', ')}` });
  try {
    const info = db.prepare(`INSERT OR REPLACE INTO model_capabilities (model_name,provider_name,capability,priority,enabled,created_at)
      VALUES (?,?,?,?,?,datetime('now','localtime'))`)
      .run(model_name, provider_name || '', capability, priority || 0, enabled !== undefined ? (enabled ? 1 : 0) : 1);
    res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 按模型名查询能力
router.get('/capabilities', (req, res) => {
  const { model_name, capability, provider_name } = req.query;
  let sql = 'SELECT * FROM model_capabilities WHERE 1=1';
  const args = [];
  if (model_name) { sql += ' AND model_name=?'; args.push(model_name); }
  if (capability) { sql += ' AND capability=?'; args.push(capability); }
  if (provider_name) { sql += ' AND provider_name=?'; args.push(provider_name); }
  sql += ' ORDER BY model_name, priority DESC';
  const rows = db.prepare(sql).all(...args);
  res.json({ code: 0, data: rows });
});

// 按能力筛选可用模型（合并供应商的 model_types + model_capabilities 注册表）
router.get('/capabilities/filter', (req, res) => {
  const { capability } = req.query;
  if (!capability) return res.json({ code: 400, msg: '请指定 capability' });
  // 1. 从已配置供应商的 model_types 中提取
  const ps = db.prepare("SELECT name, models FROM providers WHERE configured=1").all();
  const fromType = [];
  for (const p of ps) {
    let mt = {};
    try { mt = JSON.parse(p.model_types || '{}'); } catch {}
    for (const [model, type] of Object.entries(mt)) {
      if (type === capability) fromType.push({ model, provider: p.name, source: 'model_types' });
    }
  }
  // 2. 从 model_capabilities 注册表中提取
  const regRows = db.prepare('SELECT * FROM model_capabilities WHERE capability=? AND enabled=1').all(capability);
  const fromReg = regRows.map(r => ({ model: r.model_name, provider: r.provider_name || '*', source: 'registry' }));
  // 3. 合并去重
  const seen = new Set();
  const merged = [];
  for (const item of [...fromType, ...fromReg]) {
    const key = `${item.model}:${item.provider}`;
    if (!seen.has(key)) { seen.add(key); merged.push(item); }
  }
  res.json({ code: 0, data: merged });
});

// 删除能力注册
router.delete('/capabilities/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM model_capabilities WHERE id=?').run(req.params.id);
  res.json({ code: 0 });
});
