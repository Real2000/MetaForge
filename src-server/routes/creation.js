/**
 * 创作资产 V1 API（D1-3，2026-11-20）
 *
 * 三件套闭环：projects（项目）/ assets（素材库）/ shots（分镜）。
 *  - 全部路由要求 JWT 认证（router.use(auth)），资源按 owner 归属隔离（管理员可见全部）
 *  - 「生成时优先引用已有资产」：POST /projects/:id/match-assets 返回匹配候选；
 *    POST /shots/:id/resolve 命中即复用（attach）否则提示需生成
 *  - 复用现有 media 存储：素材 url 直接指向 public/uploads/*（image_gen→gen-images、video→videos）
 *  - 真人素材/数字人合规标记：real_person/digital_human → complianceOf 分级
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const creation = require('../lib/creation');

const router = express.Router();
router.use(auth);

const KINDS = ['image', 'video', 'audio', 'text', 'other'];
const PROJECT_KINDS = ['video', 'image', 'mixed'];
const PROJECT_STATUS = ['draft', 'active', 'archived'];
const SHOT_STATUS = ['draft', 'ready', 'generated'];

const isAdmin = (u) => u && u.role === 'admin';
/** 归属可见性：本人或管理员 */
function canSee(row, user) {
  return !row || row.owner === '' || row.owner === user.username || isAdmin(user);
}
const parseJson = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

/* ============================ 项目 ============================ */

router.get('/projects', (req, res) => {
  const scope = isAdmin(req.user) ? '' : 'WHERE owner=?';
  const rows = db.prepare(`SELECT * FROM projects ${scope} ORDER BY id DESC`).all(...(isAdmin(req.user) ? [] : [req.user.username]));
  const stat = (pid) => {
    const a = db.prepare('SELECT COUNT(*) c FROM assets WHERE project_id=?').get(pid).c;
    const s = db.prepare('SELECT COUNT(*) c FROM shots WHERE project_id=?').get(pid).c;
    const r = db.prepare('SELECT COUNT(*) c FROM shots WHERE project_id=? AND asset_id IS NOT NULL').get(pid).c;
    return { assets: a, shots: s, reused: r };
  };
  res.json({ code: 0, data: rows.map(p => ({ ...p, meta: parseJson(p.meta, {}), ...stat(p.id) })) });
});

router.post('/projects', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.json({ code: 400, msg: '项目名称不能为空' });
  const kind = PROJECT_KINDS.includes(b.kind) ? b.kind : 'video';
  const info = db.prepare(`INSERT INTO projects (name,description,kind,cover,owner,space_id,status,meta,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(name, String(b.description || '').slice(0, 500), kind, String(b.cover || ''), req.user.username,
      Number(b.space_id) || 0, PROJECT_STATUS.includes(b.status) ? b.status : 'draft', JSON.stringify(b.meta || {}), now(), now());
  res.json({ code: 0, data: db.prepare('SELECT * FROM projects WHERE id=?').get(info.lastInsertRowid) });
});

router.get('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权访问该项目' });
  const shots = db.prepare('SELECT * FROM shots WHERE project_id=? ORDER BY seq,id').all(p.id).map(s => ({ ...s, meta: parseJson(s.meta, {}) }));
  const assets = db.prepare('SELECT * FROM assets WHERE project_id=? ORDER BY id DESC').all(p.id).map(a => ({ ...a, tags: parseJson(a.tags, []), meta: parseJson(a.meta, {}), compliance: creation.complianceOf(a) }));
  res.json({ code: 0, data: { ...p, meta: parseJson(p.meta, {}), shots, assets, stats: creation.reuseStats(shots) } });
});

router.put('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权修改该项目' });
  const b = req.body || {};
  db.prepare(`UPDATE projects SET name=?,description=?,kind=?,cover=?,status=?,meta=?,updated_at=? WHERE id=?`)
    .run(String(b.name ?? p.name), String(b.description ?? p.description).slice(0, 500),
      PROJECT_KINDS.includes(b.kind) ? b.kind : p.kind, String(b.cover ?? p.cover),
      PROJECT_STATUS.includes(b.status) ? b.status : p.status, JSON.stringify(b.meta ?? parseJson(p.meta, {})), now(), p.id);
  res.json({ code: 0, data: db.prepare('SELECT * FROM projects WHERE id=?').get(p.id) });
});

router.delete('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权删除该项目' });
  // 级联删分镜；素材不删除（回归全局素材库，避免误删生成物）
  db.prepare('DELETE FROM shots WHERE project_id=?').run(p.id);
  db.prepare('UPDATE assets SET project_id=NULL WHERE project_id=?').run(p.id);
  db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
  res.json({ code: 0, msg: '已删除项目（分镜一并删除，素材保留为全局素材）' });
});

/* ============================ 素材 ============================ */

router.get('/assets', (req, res) => {
  const { project_id, kind } = req.query;
  const cond = [], args = [];
  if (!isAdmin(req.user)) { cond.push('owner=?'); args.push(req.user.username); }
  if (project_id != null && project_id !== '') { cond.push('project_id=?'); args.push(Number(project_id)); }
  if (kind) { cond.push('kind=?'); args.push(String(kind)); }
  const rows = db.prepare(`SELECT * FROM assets ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args);
  res.json({ code: 0, data: rows.map(a => ({ ...a, tags: parseJson(a.tags, []), meta: parseJson(a.meta, {}), compliance: creation.complianceOf(a) })) });
});

/** 新增素材：既可直接登记生成物 URL（复用现有 media 存储路径），也可先建后填 */
router.post('/assets', (req, res) => {
  const b = req.body || {};
  const kind = KINDS.includes(b.kind) ? b.kind : 'image';
  const info = db.prepare(`INSERT INTO assets (project_id,kind,name,url,thumb,source,prompt,tags,real_person,digital_human,meta,owner,space_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.project_id != null && b.project_id !== '' ? Number(b.project_id) : null, kind,
      String(b.name || '').slice(0, 200), String(b.url || ''), String(b.thumb || ''),
      ['generated', 'uploaded', 'imported'].includes(b.source) ? b.source : 'generated',
      String(b.prompt || '').slice(0, 2000), JSON.stringify(creation.normTags(b.tags)),
      Number(b.real_person) ? 1 : 0, Number(b.digital_human) ? 1 : 0, JSON.stringify(b.meta || {}),
      req.user.username, Number(b.space_id) || 0, now());
  res.json({ code: 0, data: db.prepare('SELECT * FROM assets WHERE id=?').get(info.lastInsertRowid) });
});

router.put('/assets/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '素材不存在' });
  if (!canSee(a, req.user)) return res.json({ code: 403, msg: '无权修改该素材' });
  const b = req.body || {};
  db.prepare(`UPDATE assets SET project_id=?,kind=?,name=?,url=?,thumb=?,prompt=?,tags=?,real_person=?,digital_human=?,meta=? WHERE id=?`)
    .run(b.project_id === undefined ? a.project_id : (b.project_id === '' || b.project_id == null ? null : Number(b.project_id)),
      KINDS.includes(b.kind) ? b.kind : a.kind, String(b.name ?? a.name).slice(0, 200), String(b.url ?? a.url),
      String(b.thumb ?? a.thumb), String(b.prompt ?? a.prompt).slice(0, 2000),
      JSON.stringify(b.tags === undefined ? parseJson(a.tags, []) : creation.normTags(b.tags)),
      b.real_person === undefined ? a.real_person : (Number(b.real_person) ? 1 : 0),
      b.digital_human === undefined ? a.digital_human : (Number(b.digital_human) ? 1 : 0),
      JSON.stringify(b.meta ?? parseJson(a.meta, {})), a.id);
  res.json({ code: 0, data: db.prepare('SELECT * FROM assets WHERE id=?').get(a.id) });
});

router.delete('/assets/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '素材不存在' });
  if (!canSee(a, req.user)) return res.json({ code: 403, msg: '无权删除该素材' });
  // 引用该素材的分镜解除引用（避免悬空 asset_id）
  db.prepare('UPDATE shots SET asset_id=NULL, status=CASE WHEN status=? THEN ? ELSE status END WHERE asset_id=?').run('generated', 'ready', a.id);
  db.prepare('DELETE FROM assets WHERE id=?').run(a.id);
  res.json({ code: 0, msg: '已删除素材（引用它的分镜已解除引用）' });
});

/** 从生成结果导入素材（复用现有 media 存储：直接登记 /uploads/* 生成物 URL） */
router.post('/assets/import', (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.json({ code: 400, msg: '缺少生成物 url' });
  // 安全：仅接受本地生成物路径或 http(s) 外链，拒绝其它协议
  if (!/^(?:\/uploads\/|https?:\/\/)/.test(String(b.url))) return res.json({ code: 400, msg: 'url 必须是 /uploads/ 本地路径或 http(s) 链接' });
  const kind = KINDS.includes(b.kind) ? b.kind : 'image';
  const info = db.prepare(`INSERT INTO assets (project_id,kind,name,url,thumb,source,prompt,tags,real_person,digital_human,meta,owner,space_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.project_id != null && b.project_id !== '' ? Number(b.project_id) : null, kind,
      String(b.name || '生成素材').slice(0, 200), String(b.url), '', 'imported', String(b.prompt || '').slice(0, 2000),
      JSON.stringify(creation.normTags(b.tags)), Number(b.real_person) ? 1 : 0, Number(b.digital_human) ? 1 : 0,
      JSON.stringify(b.meta || {}), req.user.username, Number(b.space_id) || 0, now());
  res.json({ code: 0, data: db.prepare('SELECT * FROM assets WHERE id=?').get(info.lastInsertRowid) });
});

/* ============================ 分镜 ============================ */

router.get('/shots', (req, res) => {
  const { project_id } = req.query;
  if (project_id == null || project_id === '') return res.json({ code: 400, msg: '缺少 project_id' });
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权访问该项目' });
  const rows = db.prepare('SELECT * FROM shots WHERE project_id=? ORDER BY seq,id').all(project_id).map(s => ({ ...s, meta: parseJson(s.meta, {}) }));
  res.json({ code: 0, data: rows, stats: creation.reuseStats(rows) });
});

router.post('/shots', (req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(b.project_id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权修改该项目' });
  const seq = Number.isFinite(Number(b.seq)) ? Number(b.seq) : (db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM shots WHERE project_id=?').get(p.id).n);
  const info = db.prepare(`INSERT INTO shots (project_id,seq,title,description,prompt,asset_id,kind,duration,status,meta,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, seq, String(b.title || '').slice(0, 200), String(b.description || '').slice(0, 1000),
      String(b.prompt || '').slice(0, 2000), b.asset_id != null && b.asset_id !== '' ? Number(b.asset_id) : null,
      KINDS.includes(b.kind) ? b.kind : 'image', Number(b.duration) || 0,
      SHOT_STATUS.includes(b.status) ? b.status : (b.asset_id != null ? 'ready' : 'draft'),
      JSON.stringify(b.meta || {}), now(), now());
  res.json({ code: 0, data: db.prepare('SELECT * FROM shots WHERE id=?').get(info.lastInsertRowid) });
});

router.put('/shots/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shots WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '分镜不存在' });
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(s.project_id);
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权修改该分镜' });
  const b = req.body || {};
  db.prepare(`UPDATE shots SET seq=?,title=?,description=?,prompt=?,asset_id=?,kind=?,duration=?,status=?,meta=?,updated_at=? WHERE id=?`)
    .run(Number.isFinite(Number(b.seq)) ? Number(b.seq) : s.seq, String(b.title ?? s.title), String(b.description ?? s.description),
      String(b.prompt ?? s.prompt), b.asset_id === undefined ? s.asset_id : (b.asset_id === '' || b.asset_id == null ? null : Number(b.asset_id)),
      KINDS.includes(b.kind) ? b.kind : s.kind, b.duration === undefined ? s.duration : Number(b.duration) || 0,
      SHOT_STATUS.includes(b.status) ? b.status : s.status, JSON.stringify(b.meta ?? parseJson(s.meta, {})), now(), s.id);
  res.json({ code: 0, data: db.prepare('SELECT * FROM shots WHERE id=?').get(s.id) });
});

router.delete('/shots/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shots WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '分镜不存在' });
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(s.project_id);
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权删除该分镜' });
  db.prepare('DELETE FROM shots WHERE id=?').run(s.id);
  res.json({ code: 0, msg: '已删除分镜' });
});

/** 分镜引用已有素材（复用）：校验素材归属同一项目或全局、且本人可见 */
router.post('/shots/:id/attach', (req, res) => {
  const s = db.prepare('SELECT * FROM shots WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '分镜不存在' });
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(s.project_id);
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权修改该分镜' });
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get((req.body || {}).asset_id);
  if (!a) return res.json({ code: 404, msg: '素材不存在' });
  if (!canSee(a, req.user)) return res.json({ code: 403, msg: '无权引用该素材' });
  if (a.project_id != null && a.project_id !== s.project_id) return res.json({ code: 400, msg: '素材不属于本项目，无法复用' });
  db.prepare('UPDATE shots SET asset_id=?, status=?, updated_at=? WHERE id=?').run(a.id, 'generated', now(), s.id);
  res.json({ code: 0, data: db.prepare('SELECT * FROM shots WHERE id=?').get(s.id), msg: '已复用已有素材' });
});

/** 生成时「优先引用已有资产」：按提示词匹配本项目/全局素材，命中即复用，否则提示需生成 */
router.post('/shots/:id/resolve', (req, res) => {
  const s = db.prepare('SELECT * FROM shots WHERE id=?').get(req.params.id);
  if (!s) return res.json({ code: 404, msg: '分镜不存在' });
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(s.project_id);
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权操作该分镜' });
  const text = String((req.body || {}).text || s.prompt || s.description || s.title || '');
  const candidates = db.prepare('SELECT * FROM assets WHERE project_id=? OR (project_id IS NULL AND owner=?)').all(s.project_id, req.user.username)
    .map(a => ({ ...a, tags: parseJson(a.tags, []) }));
  const matched = creation.matchAssets(candidates, text, { limit: 3, minScore: 1, kinds: [s.kind === 'video' ? 'video' : 'image'] });
  if (matched.length) {
    db.prepare('UPDATE shots SET asset_id=?, status=?, updated_at=? WHERE id=?').run(matched[0].asset.id, 'generated', now(), s.id);
    return res.json({ code: 0, data: { reused: true, asset: matched[0].asset, score: matched[0].score, candidates: matched }, msg: `复用已有素材「${matched[0].asset.name || '#' + matched[0].asset.id}」（相关度 ${matched[0].score}）` });
  }
  res.json({ code: 0, data: { reused: false, need_generate: true, prompt: text, candidates: [] }, msg: '未匹配到可复用素材，需生成新素材' });
});

/** 项目统计：素材复用率（验收口径） */
router.get('/projects/:id/stats', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, msg: '项目不存在' });
  if (!canSee(p, req.user)) return res.json({ code: 403, msg: '无权访问该项目' });
  const shots = db.prepare('SELECT asset_id FROM shots WHERE project_id=?').all(p.id);
  const assets = db.prepare('SELECT COUNT(*) c FROM assets WHERE project_id=?').get(p.id).c;
  const reusedAssets = db.prepare('SELECT COUNT(DISTINCT asset_id) c FROM shots WHERE project_id=? AND asset_id IS NOT NULL').get(p.id).c;
  res.json({ code: 0, data: { ...creation.reuseStats(shots), assets, reused_assets: reusedAssets } });
});

module.exports = router;
