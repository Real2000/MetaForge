/**
 * P2-4 专家目录 / P2-5 子智能体库 / P2-6 技能目录 / P2-7 插件体系 / P2-8 市场对接
 *
 * 统一按业务域分类的资产目录管理与远程市场 Hub 对接。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

/* ==================== P2-4 专家目录 ==================== */

router.get('/experts', (req, res) => {
  const { category, status, page = 1, pageSize = 50 } = req.query;
  let sql = 'SELECT * FROM expert_catalog WHERE 1=1';
  const args = [];
  if (category) { sql += ' AND category=?'; args.push(category); }
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY id DESC';
  const total = dal.getq(`SELECT COUNT(*) c FROM expert_catalog WHERE 1=1${category?' AND category=?':''}${status?' AND status=?':''}`, [...(category?[category]:[]), ...(status?[status]:[])]).c;
  const rows = dal.q(sql + ' LIMIT ? OFFSET ?', [...args, +pageSize, (+page - 1) * +pageSize]);
  res.json({ code: 0, data: { list: rows, total, page: +page, pageSize: +pageSize } });
});

router.post('/experts', adminOnly, (req, res) => {
  const { agent_id, identifier, name_zh, name_en, description_zh, description_en, welcome, icon, color, category, tags, prompt, version } = req.body || {};
  if (!identifier) return res.json({ code: 400, msg: '请提供英文标识' });
  try {
    const info = dal.runq(`INSERT INTO expert_catalog (agent_id,identifier,name_zh,name_en,description_zh,description_en,welcome,icon,color,category,tags,prompt,version,status,created_by,published_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`, [agent_id || null, identifier, name_zh || '', name_en || '', description_zh || '', description_en || '', welcome || '', icon || '🤖', color || '#818cf8',
        category || '', JSON.stringify(tags || []), prompt || '', version || 1, req.user.username, req.user.username, now(), now()]);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '创建专家目录', `expert:${identifier}`, req.ip, now()]);
    res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.json({ code: 400, msg: '标识或关联智能体已存在' });
    throw e;
  }
});

router.put('/experts/:id', adminOnly, (req, res) => {
  const { name_zh, name_en, description_zh, description_en, welcome, icon, color, category, tags, prompt, version, status, agent_id } = req.body || {};
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries({ name_zh, name_en, description_zh, description_en, welcome, icon, color, category, prompt, status })) {
    if (v !== undefined) { fields.push(`${k}=?`); vals.push(v); }
  }
  if (tags !== undefined) { fields.push('tags=?'); vals.push(JSON.stringify(tags)); }
  if (agent_id !== undefined) { fields.push('agent_id=?'); vals.push(agent_id); }
  if (version !== undefined) { fields.push('version=?'); vals.push(version); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(req.params.id);
  dal.runq(`UPDATE expert_catalog SET ${fields.join(',')} WHERE id=?`, [...vals]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '更新专家目录', `expert:${req.params.id}`, req.ip, now()]);
  res.json({ code: 0 });
});

router.put('/experts/:id/publish', adminOnly, (req, res) => {
  const e = dal.getq('SELECT * FROM expert_catalog WHERE id=?', [req.params.id]);
  if (!e) return res.json({ code: 404, msg: '专家不存在' });
  const action = req.body.action || 'publish';
  if (action === 'publish') {
    dal.runq("UPDATE expert_catalog SET status='published',version=version+1,published_by=?,updated_at=? WHERE id=?", [req.user.username, now(), e.id]);
  } else if (action === 'deprecate') {
    dal.runq("UPDATE expert_catalog SET status='deprecated',updated_at=? WHERE id=?", [now(), e.id]);
  } else {
    return res.json({ code: 400, msg: 'action 应为 publish 或 deprecate' });
  }
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, `专家${action==='publish'?'发布':'下架'}`, e.identifier || `#${e.id}`, req.ip, now()]);
  res.json({ code: 0 });
});

/* ==================== P2-5 子智能体库 ==================== */

router.get('/sub-agents', (req, res) => {
  const { category, page = 1, pageSize = 50 } = req.query;
  let sql = "SELECT * FROM sub_agent_library WHERE status='active'";
  const args = [];
  if (category) { sql += ' AND category=?'; args.push(category); }
  sql += ' ORDER BY id DESC';
  const total = dal.getq("SELECT COUNT(*) c FROM sub_agent_library WHERE status='active'" + (category?' AND category=?':''), [...args]).c;
  const rows = dal.q(sql + ' LIMIT ? OFFSET ?', [...args, +pageSize, (+page - 1) * +pageSize]);
  res.json({ code: 0, data: { list: rows, total, page: +page, pageSize: +pageSize } });
});

router.post('/sub-agents', (req, res) => {
  const { name_zh, name_en, description_zh, description_en, prompt, tools, model_recommend, category, icon, source } = req.body || {};
  if (!name_zh) return res.json({ code: 400, msg: '请提供中文名称' });
  const info = dal.runq(`INSERT INTO sub_agent_library (name_zh,name_en,description_zh,description_en,prompt,tools,model_recommend,category,icon,source,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [name_zh, name_en || '', description_zh || '', description_en || '', prompt || '', JSON.stringify(tools || []), model_recommend || '', category || '', icon || '🧩', source || 'builtin', req.user.username, now(), now()]);
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
});

router.put('/sub-agents/:id', adminOnly, (req, res) => {
  const { name_zh, name_en, description_zh, description_en, prompt, tools, model_recommend, category, icon, agent_id, status } = req.body || {};
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries({ name_zh, name_en, description_zh, description_en, prompt, model_recommend, category, icon, status })) {
    if (v !== undefined) { fields.push(`${k}=?`); vals.push(v); }
  }
  if (tools !== undefined) { fields.push('tools=?'); vals.push(JSON.stringify(tools)); }
  if (agent_id !== undefined) { fields.push('agent_id=?'); vals.push(agent_id); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(req.params.id);
  dal.runq(`UPDATE sub_agent_library SET ${fields.join(',')} WHERE id=?`, [...vals]);
  res.json({ code: 0 });
});

router.post('/sub-agents/:id/mount', (req, res) => {
  // 一键挂载到智能体
  if (!req.user) return res.json({ code: 401, msg: '未登录' });
  const sub = dal.getq("SELECT * FROM sub_agent_library WHERE id=? AND status='active'", [req.params.id]);
  if (!sub) return res.json({ code: 404, msg: '子智能体不存在' });
  const info = dal.runq(`INSERT INTO agents (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,tools,long_memory,allow_user_model,suggest_enabled,variables,child_ids,routing_mode,owner,created_at,updated_at)
    VALUES (?,?,'chat',?,?,?,?,0.7,10,2000,'','[]',null,'draft','custom','[]',1,1,0,'[]','[]','function',?,?,?)`, [sub.name_zh, sub.description_zh + (sub.description_en ? ' / ' + sub.description_en : ''), req.user.space_id || 0, sub.category || '',
      sub.prompt || '', sub.model_recommend || '', req.user.username, now(), now()]);
  // 记录挂载
  dal.runq('UPDATE sub_agent_library SET agent_id=?,updated_at=? WHERE id=?', [Number(info.lastInsertRowid), now(), sub.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '挂载子智能体', `${sub.name_zh}→agent#${info.lastInsertRowid}`, req.ip, now()]);
  res.json({ code: 0, data: { agent_id: Number(info.lastInsertRowid) } });
});

/* ==================== P2-7 插件 ==================== */

router.get('/plugins', (req, res) => {
  const rows = dal.q('SELECT * FROM plugins ORDER BY id DESC');
  res.json({ code: 0, data: rows });
});

router.post('/plugins', adminOnly, (req, res) => {
  const { plugin_id, name, name_en, type, entry, icon, description, version, author, homepage, runtime, settings_schema } = req.body || {};
  if (!plugin_id) return res.json({ code: 400, msg: '请提供 plugin_id' });
  try {
    const info = dal.runq(`INSERT INTO plugins (plugin_id,name,name_en,type,entry,icon,description,version,author,homepage,runtime,settings_schema,enabled,installed_by,installed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`, [plugin_id, name || '', name_en || '', type || 'tool', entry || '', icon || '🧩', description || '', version || '1.0.0', author || '', homepage || '',
        runtime || 'node', JSON.stringify(settings_schema || {}), req.user.username, now(), now()]);
    res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.json({ code: 400, msg: 'plugin_id 已存在' });
    throw e;
  }
});

router.put('/plugins/:id', adminOnly, (req, res) => {
  const { name, enabled, settings_schema, version } = req.body || {};
  const fields = []; const vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (enabled !== undefined) { fields.push('enabled=?'); vals.push(enabled ? 1 : 0); }
  if (settings_schema !== undefined) { fields.push('settings_schema=?'); vals.push(JSON.stringify(settings_schema)); }
  if (version !== undefined) { fields.push('version=?'); vals.push(version); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(req.params.id);
  dal.runq(`UPDATE plugins SET ${fields.join(',')} WHERE id=?`, [...vals]);
  res.json({ code: 0 });
});

/* ==================== P2-8 市场 Hub 对接 ==================== */

router.get('/hubs', (req, res) => {
  const rows = dal.q('SELECT id,name,url,type,enabled,last_sync_at,sync_status,created_at,updated_at FROM market_hubs ORDER BY id DESC');
  res.json({ code: 0, data: rows });
});

router.post('/hubs', adminOnly, (req, res) => {
  const { name, url, type } = req.body || {};
  if (!name || !url) return res.json({ code: 400, msg: '请提供名称和 URL' });
  const info = dal.runq('INSERT INTO market_hubs (name,url,type,enabled,created_at,updated_at) VALUES (?,?,?,1,?,?)', [name, url, type || 'skill', now(), now()]);
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid) } });
});

router.put('/hubs/:id', adminOnly, (req, res) => {
  const { name, url, enabled, type } = req.body || {};
  const fields = []; const vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (url !== undefined) { fields.push('url=?'); vals.push(url); }
  if (enabled !== undefined) { fields.push('enabled=?'); vals.push(enabled ? 1 : 0); }
  if (type !== undefined) { fields.push('type=?'); vals.push(type); }
  if (!fields.length) return res.json({ code: 400, msg: '无更新字段' });
  fields.push('updated_at=?'); vals.push(now()); vals.push(req.params.id);
  dal.runq(`UPDATE market_hubs SET ${fields.join(',')} WHERE id=?`, [...vals]);
  res.json({ code: 0 });
});

router.post('/hubs/:id/sync', adminOnly, (req, res) => {
  const hub = dal.getq('SELECT * FROM market_hubs WHERE id=?', [req.params.id]);
  if (!hub) return res.json({ code: 404, msg: 'Hub 不存在' });
  // 预留：远程 Hub 同步协议位。实现时从 hub.url 加载远程清单
  dal.runq("UPDATE market_hubs SET sync_status='success',last_sync_at=? WHERE id=?", [now(), hub.id]);
  res.json({ code: 0, data: { msg: '同步完成（桩响应，远程 Hub 协议待实现）' } });
});

module.exports = router;