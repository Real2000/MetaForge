/**
 * D3-1 3D 与数字人 V1 API（2026-11-21）
 *
 * 覆盖：
 *  - 3D 资产生成：提交任务 → 第三方 3D 服务（复用 providers 多供应商路由，OpenAI 风格 /3d/generations）
 *    → 成功产物落 media 存储并登记为 assets(kind='3d')；未配置任何供应商时降级为本地占位模型（provider=local-stub）。
 *  - 3D 资产导出：源格式 → 目标格式（可转换性判定 + 导出记录）。
 *  - 数字人合规评估（评估先行）：结构化问卷 → 评分 → 结论闸门，供创作/发布前把关。
 *  - 指标：3D 任务成功率（验收 ≥ 70%）。
 *
 * 全部路由要求 JWT 认证（router.use(auth)），资源按 owner 归属隔离（管理员可见全部）。
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const model3d = require('../lib/model3d');
const digitalHuman = require('../lib/digital-human');
const { getConfiguredProviders, postModel } = require('../lib/llm');

const router = express.Router();
router.use(auth);

const isAdmin = (u) => u && u.role === 'admin';
const canSee = (owner, user) => owner === '' || owner === user.username || isAdmin(user);
const parseJson = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');
const MODELS_DIR = path.join(UPLOAD_ROOT, 'models3d');

/** 逐供应商调用第三方 3D 服务；返回 { url, model, provider } */
async function call3DService(body) {
  const ps = getConfiguredProviders();
  if (!ps.length) return null; // 无可用供应商 → 交由上层降级
  const errs = [];
  for (const p of ps) {
    try {
      const res = await postModel(p.base_url.replace(/\/+$/, '') + '/3d/generations',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        body, { signal: AbortSignal.timeout(120000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j.error && (j.error.message || j.error)) || 'HTTP ' + res.status);
      const item = (j.data || [])[0] || j;
      if (item && item.url) return { url: item.url, model: j.model || body.model, provider: p.name, format: j.format || body.format };
      if (item && item.b64_json) {
        fs.mkdirSync(MODELS_DIR, { recursive: true });
        const fmt = model3d.normFormat(j.format || body.format);
        const fname = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fmt}`;
        fs.writeFileSync(path.join(MODELS_DIR, fname), Buffer.from(item.b64_json, 'base64'));
        return { url: `/uploads/models3d/${fname}`, model: j.model || body.model, provider: p.name, format: fmt };
      }
      throw new Error('3D 渠道返回异常（无 url/b64_json）');
    } catch (e) { errs.push(`${p.name}：${e.message}`); }
  }
  throw new Error(`3D 生成失败（已尝试 ${ps.length} 个供应商）——${errs.join('；').slice(0, 200)}`);
}

/** 本地占位模型（离线降级）：写最小 glTF，provider=local-stub */
function stub3D(body) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const fmt = model3d.normFormat(body.format);
  const buf = model3d.placeholderGltf(body.prompt);
  const fname = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gltf`;
  fs.writeFileSync(path.join(MODELS_DIR, fname), buf);
  return { url: `/uploads/models3d/${fname}`, model: body.model, provider: 'local-stub', format: 'gltf', stub: true };
}

/** 执行一次 3D 生成任务（落库 → 调用 → 更新状态 → 登记素材） */
async function runTask(taskId) {
  const task = db.prepare('SELECT * FROM model3d_tasks WHERE id=?').get(taskId);
  if (!task) return null;
  const t0 = Date.now();
  db.prepare('UPDATE model3d_tasks SET status=?, provider=? WHERE id=?').run('running', '', task.id);
  const body = model3d.buildGenRequest(task.prompt, { format: task.format });
  let result = null, err = '';
  try {
    result = await call3DService(body);
    if (!result) result = stub3D(body); // 未配置供应商 → 本地占位
  } catch (e) { err = e.message; }
  const duration = Date.now() - t0;
  if (result) {
    // 登记为创作资产（kind='3d'），与 D1-3 创作资产闭环打通
    const info = db.prepare(`INSERT INTO assets (project_id,kind,name,url,thumb,source,prompt,tags,real_person,digital_human,meta,owner,space_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(task.project_id != null ? task.project_id : null, '3d',
        String(task.prompt || '3D 资产').slice(0, 60), result.url, '', 'generated',
        String(task.prompt || '').slice(0, 2000), '[]', 0, 0,
        JSON.stringify({ format: result.format, provider: result.provider, task_id: task.id, stub: !!result.stub }),
        task.username, 0, now());
    const assetId = info.lastInsertRowid;
    db.prepare('UPDATE model3d_tasks SET status=?,model=?,provider=?,url=?,asset_id=?,duration_ms=?,finished_at=? WHERE id=?')
      .run('success', result.model, result.provider, result.url, assetId, duration, now(), task.id);
  } else {
    db.prepare('UPDATE model3d_tasks SET status=?,error=?,duration_ms=?,finished_at=? WHERE id=?')
      .run('failed', String(err).slice(0, 300), duration, now(), task.id);
  }
  return db.prepare('SELECT * FROM model3d_tasks WHERE id=?').get(task.id);
}

/* ============================ 3D 生成 ============================ */

/** 提交 3D 生成任务 */
router.post('/generate', async (req, res) => {
  const b = req.body || {};
  const prompt = String(b.prompt || '').trim();
  if (!prompt) return res.json({ code: 400, msg: '请输入 3D 生成提示词' });
  const format = model3d.normFormat(b.format);
  const projectId = b.project_id != null && b.project_id !== '' ? Number(b.project_id) : null;
  if (projectId != null) {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p) return res.json({ code: 404, msg: '项目不存在' });
    if (!canSee(p.owner || '', req.user)) return res.json({ code: 403, msg: '无权操作该项目' });
  }
  const info = db.prepare(`INSERT INTO model3d_tasks (username,project_id,prompt,format,status,created_at)
    VALUES (?,?,?,?,?,?)`).run(req.user.username, projectId, prompt.slice(0, 2000), format, 'queued', now());
  const row = await runTask(info.lastInsertRowid);
  res.json({ code: 0, data: model3d.normalizeTask(row), raw: { status: row.status, error: row.error || '' } });
});

/** 任务列表（owner 隔离；支持按项目/状态过滤） */
router.get('/tasks', (req, res) => {
  const cond = [], args = [];
  if (!isAdmin(req.user)) { cond.push('username=?'); args.push(req.user.username); }
  if (req.query.project_id != null && req.query.project_id !== '') { cond.push('project_id=?'); args.push(Number(req.query.project_id)); }
  if (req.query.status) { cond.push('status=?'); args.push(String(req.query.status)); }
  const rows = db.prepare(`SELECT * FROM model3d_tasks ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
  res.json({ code: 0, data: rows.map(model3d.normalizeTask), stats: model3d.taskStats(rows) });
});

router.get('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM model3d_tasks WHERE id=?').get(req.params.id);
  if (!row) return res.json({ code: 404, msg: '任务不存在' });
  if (!canSee(row.username, req.user)) return res.json({ code: 403, msg: '无权访问该任务' });
  res.json({ code: 0, data: model3d.normalizeTask(row) });
});

/** 重跑失败/历史任务（生成新任务，保留原记录用于成功率追溯） */
router.post('/tasks/:id/retry', async (req, res) => {
  const row = db.prepare('SELECT * FROM model3d_tasks WHERE id=?').get(req.params.id);
  if (!row) return res.json({ code: 404, msg: '任务不存在' });
  if (!canSee(row.username, req.user)) return res.json({ code: 403, msg: '无权操作该任务' });
  const info = db.prepare(`INSERT INTO model3d_tasks (username,project_id,prompt,format,status,created_at)
    VALUES (?,?,?,?,?,?)`).run(row.username, row.project_id, row.prompt, row.format, 'queued', now());
  const newRow = await runTask(info.lastInsertRowid);
  res.json({ code: 0, data: model3d.normalizeTask(newRow), raw: { status: newRow.status, error: newRow.error || '' } });
});

/* ============================ 3D 资产导出 ============================ */

/** 导出 3D 资产到目标格式 */
router.post('/assets/:id/export', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.json({ code: 404, msg: '素材不存在' });
  if (!canSee(a.owner || '', req.user)) return res.json({ code: 403, msg: '无权导出该素材' });
  const meta = parseJson(a.meta, {});
  const sourceFormat = meta.format || model3d.detectFormat(a.url) || 'glb';
  const targetFormat = String((req.body || {}).target_format || sourceFormat).toLowerCase();
  const plan = model3d.exportPlan(sourceFormat, targetFormat);
  if (!plan.ok) return res.json({ code: 400, msg: plan.message });
  // 同格式直接指向源文件；需转换的记录转换计划（真实几何转换由下游服务完成，V1 记录可转换性）
  const url = plan.needConvert ? '' : a.url;
  const info = db.prepare(`INSERT INTO asset_exports (asset_id,username,source_format,target_format,need_convert,status,url,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(a.id, req.user.username, sourceFormat, targetFormat, plan.needConvert ? 1 : 0,
      plan.needConvert ? 'pending' : 'done', url, plan.message, now());
  res.json({ code: 0, data: {
    id: info.lastInsertRowid, asset_id: a.id, source_format: sourceFormat, target_format: targetFormat,
    need_convert: plan.needConvert, status: plan.needConvert ? 'pending' : 'done', url, message: plan.message,
  } });
});

router.get('/exports', (req, res) => {
  const cond = [], args = [];
  if (!isAdmin(req.user)) { cond.push('username=?'); args.push(req.user.username); }
  if (req.query.asset_id != null && req.query.asset_id !== '') { cond.push('asset_id=?'); args.push(Number(req.query.asset_id)); }
  const rows = db.prepare(`SELECT * FROM asset_exports ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
  res.json({ code: 0, data: rows });
});

/* ============================ 数字人合规评估 ============================ */

/** 评估项定义（供前端渲染问卷） */
router.get('/dh/items', (req, res) => {
  res.json({ code: 0, data: { items: digitalHuman.ASSESS_ITEMS, decisions: digitalHuman.DECISION_LABEL } });
});

/** 提交合规评估（可关联素材/项目，落库供追溯） */
router.post('/dh/assess', (req, res) => {
  const b = req.body || {};
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
  const result = digitalHuman.assess(answers);
  const assetId = b.asset_id != null && b.asset_id !== '' ? Number(b.asset_id) : null;
  const projectId = b.project_id != null && b.project_id !== '' ? Number(b.project_id) : null;
  if (assetId != null) {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    if (!a) return res.json({ code: 404, msg: '素材不存在' });
    if (!canSee(a.owner || '', req.user)) return res.json({ code: 403, msg: '无权评估该素材' });
    // 评估结论回写到素材合规标记（decision!==approve → 标记 digital_human 待复核）
    db.prepare('UPDATE assets SET digital_human=?, meta=? WHERE id=?')
      .run(result.decision === 'approve' ? 0 : 1, JSON.stringify({ ...parseJson(a.meta, {}), dh_assessment: { decision: result.decision, level: result.level, score: result.score } }), assetId);
  }
  const info = db.prepare(`INSERT INTO dh_assessments (asset_id,project_id,username,answers,score,level,decision,reasons,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(assetId, projectId, req.user.username, JSON.stringify(answers), result.score, result.level, result.decision,
      JSON.stringify(result.reasons), String(b.note || '').slice(0, 500), now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, asset_id: assetId, project_id: projectId, ...result } });
});

/** 评估记录列表 */
router.get('/dh/assessments', (req, res) => {
  const cond = [], args = [];
  if (!isAdmin(req.user)) { cond.push('username=?'); args.push(req.user.username); }
  if (req.query.project_id != null && req.query.project_id !== '') { cond.push('project_id=?'); args.push(Number(req.query.project_id)); }
  if (req.query.asset_id != null && req.query.asset_id !== '') { cond.push('asset_id=?'); args.push(Number(req.query.asset_id)); }
  const rows = db.prepare(`SELECT * FROM dh_assessments ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args)
    .map((r) => ({ ...r, answers: parseJson(r.answers, {}), reasons: parseJson(r.reasons, []) }));
  res.json({ code: 0, data: rows });
});

/* ============================ 指标 ============================ */

/** 3D 任务成功率（验收 ≥ 70%）+ 导出/合规概览 */
router.get('/stats', (req, res) => {
  const all = isAdmin(req.user)
    ? db.prepare('SELECT * FROM model3d_tasks').all()
    : db.prepare('SELECT * FROM model3d_tasks WHERE username=?').all(req.user.username);
  const stats = model3d.taskStats(all);
  const recent = all.slice(-20).reverse().map(model3d.normalizeTask);
  const exports = db.prepare('SELECT * FROM asset_exports ORDER BY id DESC LIMIT 50').all();
  const dh = db.prepare('SELECT decision, COUNT(*) c FROM dh_assessments GROUP BY decision').all();
  const dhSummary = { approve: 0, review: 0, reject: 0 };
  for (const r of dh) dhSummary[r.decision] = r.c;
  res.json({ code: 0, data: { stats, recent, exports, dh: dhSummary } });
});

module.exports = router;
