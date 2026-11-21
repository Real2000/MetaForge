/**
 * D2-1 代码索引与仓库语义检索 API（2026-11-21）
 *
 * 流程：登记仓库（服务器本地目录）→ 建索引（按函数/类切片 + 本地哈希向量）→
 *       只读检索（符号+关键词+语义混合）→ 读文件 → 补丁 propose（dry-run diff）
 *       → 人工确认 apply（写前备份）→ 可 rollback（按备份一键回滚）。
 *
 * 安全：全部路由 JWT 认证；仓库按 owner 隔离（管理员可见全部）；
 *       路径经 realpath 解析 + 逃逸校验；可选 CODE_INDEX_ROOTS 白名单（分号/冒号分隔的绝对前缀），
 *       设置后仅允许登记其下的目录；写盘仅限仓库根内且必须先 propose 再 apply。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const ci = require('../lib/code-index');
const csearch = require('../lib/code-search');
const retriever = require('../lib/retriever');

const router = express.Router();
router.use(auth);

const isAdmin = (u) => u && u.role === 'admin';
const MAX_CHUNKS = 100000;        // 单仓库索引块上限（防超大仓爆库）
const INDEX_TOKEN_BUDGET = 4000;  // 单块送入向量的字符上限

/** 归属可见性：管理员可见全部；其他用户仅可见自己登记的仓库（读/写一致，防按 id 越权读文件） */
function repoOf(id, user) {
  const r = db.prepare('SELECT * FROM code_repos WHERE id=?').get(id);
  if (!r) return null;
  if (isAdmin(user)) return r;
  return r.owner === user.username ? r : null;
}

/** 允许登记的根目录白名单（未配置则允许任意存在的目录；配置了但无有效项则全部拒绝） */
function allowedRoots() {
  const raw = process.env.CODE_INDEX_ROOTS || '';
  const configured = raw.trim().length > 0;
  const roots = raw.split(/[;:]/).map(s => s.trim()).filter(Boolean).map(p => {
    try { return fs.realpathSync(p); } catch { return null; }
  }).filter(Boolean);
  return { configured, roots };
}

/** 校验并解析仓库根目录（realpath + 目录 + 白名单） */
function resolveRoot(rootPath) {
  const p = String(rootPath || '').trim();
  if (!p) return { ok: false, msg: '仓库路径不能为空' };
  if (!path.isAbsolute(p)) return { ok: false, msg: '请提供绝对路径' };
  let real;
  try { real = fs.realpathSync(p); } catch { return { ok: false, msg: '路径不存在或不可访问' }; }
  let st; try { st = fs.statSync(real); } catch { return { ok: false, msg: '路径不可访问' }; }
  if (!st.isDirectory()) return { ok: false, msg: '仓库路径必须是目录' };
  if (real === path.sep) return { ok: false, msg: '不允许以文件系统根目录作为仓库' };
  const { configured, roots } = allowedRoots();
  if (configured && !roots.some(r => real === r || real.startsWith(r + path.sep))) {
    return { ok: false, msg: '该路径不在允许索引的目录白名单（CODE_INDEX_ROOTS）内' };
  }
  return { ok: true, real };
}

/* ============================ 仓库 CRUD ============================ */

router.get('/repos', (req, res) => {
  const rows = isAdmin(req.user)
    ? db.prepare('SELECT * FROM code_repos ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM code_repos WHERE owner=? ORDER BY id DESC').all(req.user.username);
  res.json({ code: 0, data: rows });
});

router.post('/repos', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.json({ code: 400, msg: '仓库名称不能为空' });
  const rr = resolveRoot(b.root_path);
  if (!rr.ok) return res.json({ code: 400, msg: rr.msg });
  const info = db.prepare(`INSERT INTO code_repos (owner,name,root_path,description,status,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(req.user.username, name.slice(0, 100), rr.real, String(b.description || '').slice(0, 500), 'new', now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '登记代码仓库', `${name}（${rr.real}）`, req.ip, now());
  res.json({ code: 0, data: db.prepare('SELECT * FROM code_repos WHERE id=?').get(info.lastInsertRowid) });
});

router.get('/repos/:id', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在或不可见' });
  const byKind = db.prepare("SELECT chunk_kind k, COUNT(*) c FROM code_index WHERE repo_id=? GROUP BY chunk_kind").all(r.id);
  const langStat = db.prepare("SELECT lang, COUNT(DISTINCT file_path) files FROM code_index WHERE repo_id=? GROUP BY lang ORDER BY files DESC").all(r.id);
  res.json({ code: 0, data: { ...r, by_kind: byKind, langs: langStat } });
});

router.delete('/repos/:id', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在（只能删除自己登记的仓库）' });
  db.prepare('DELETE FROM code_index WHERE repo_id=?').run(r.id);
  db.prepare('DELETE FROM code_patches WHERE repo_id=?').run(r.id);
  db.prepare('DELETE FROM code_patch_backups WHERE repo_id=?').run(r.id);
  db.prepare('DELETE FROM code_repos WHERE id=?').run(r.id);
  res.json({ code: 0, msg: '已删除' });
});

/* ============================ 建索引 ============================ */

router.post('/repos/:id/index', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在（只能索引自己的仓库）' });
  let root;
  try { root = fs.realpathSync(r.root_path); } catch { return res.json({ code: 400, msg: '仓库目录不可访问（可能已移动）' }); }

  const t0 = Date.now();
  const files = ci.scanFiles(root, { maxFiles: Number(req.body && req.body.maxFiles) || 20000 });
  // 清旧索引，重建
  db.prepare('DELETE FROM code_index WHERE repo_id=?').run(r.id);
  const ins = db.prepare(`INSERT INTO code_index
    (repo_id,owner,file_path,lang,chunk_kind,symbol_name,symbol_parent,start_line,end_line,content,embedding,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let chunkCount = 0, symbolCount = 0, fileCount = 0;
  const insertMany = db.transaction((rows) => { for (const row of rows) ins.run(...row); });
  let batch = [];
  const flush = () => { if (batch.length) { insertMany(batch); batch = []; } };

  for (const rel of files) {
    if (chunkCount >= MAX_CHUNKS) break;
    const rd = ci.readRepoFile(root, rel);
    if (!rd.ok) continue;
    const lang = ci.detectLang(rel);
    let chunks;
    try { chunks = ci.chunkFile(rd.content, lang); } catch { chunks = []; }
    if (!chunks.length) continue;
    fileCount++;
    for (const c of chunks) {
      if (chunkCount >= MAX_CHUNKS) break;
      const vec = JSON.stringify([...retriever.embed(c.content.slice(0, INDEX_TOKEN_BUDGET))]);
      batch.push([r.id, r.owner, rel, lang, c.kind, c.name || '', c.parent || '', c.startLine, c.endLine, c.content, 'H:' + vec, now()]);
      chunkCount++;
      if (['function', 'class', 'method'].includes(c.kind)) symbolCount++;
      if (batch.length >= 500) flush();
    }
  }
  flush();
  const durationMs = Date.now() - t0;
  db.prepare('UPDATE code_repos SET status=?, file_count=?, symbol_count=?, chunk_count=?, error=?, indexed_at=? WHERE id=?')
    .run('ready', fileCount, symbolCount, chunkCount, '', now(), r.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '建立代码索引', `${r.name}（${fileCount} 文件 / ${symbolCount} 符号 / ${chunkCount} 块 / ${durationMs}ms）`, req.ip, now());
  res.json({ code: 0, data: { file_count: fileCount, symbol_count: symbolCount, chunk_count: chunkCount, duration_ms: durationMs } });
});

/* ============================ 只读检索 ============================ */

router.get('/repos/:id/search', async (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在或不可见' });
  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return res.json({ code: 400, msg: '缺少查询词 q' });
  const topN = Math.min(50, Math.max(1, Number(req.query.top) || 8));
  const lang = String(req.query.lang || '').trim();
  const pathLike = String(req.query.path || '').trim();
  let rows = db.prepare('SELECT * FROM code_index WHERE repo_id=?').all(r.id);
  if (lang) rows = rows.filter(x => x.lang === lang);
  if (pathLike) rows = rows.filter(x => x.file_path.includes(pathLike));
  if (rows.length > 50000) rows = rows.slice(0, 50000); // 超大仓搜索上限（V1 边界）
  const results = await csearch.search(rows, q, topN, {
    rerankEnabled: req.query.rerank !== '0',
    rerankModel: req.query.rerankModel,
  });
  res.json({ code: 0, data: { query: q, count: results.length, candidates: rows.length, results } });
});

/* ============================ 读文件（只读） ============================ */

router.get('/repos/:id/file', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在或不可见' });
  let root; try { root = fs.realpathSync(r.root_path); } catch { return res.json({ code: 400, msg: '仓库目录不可访问' }); }
  const rd = ci.readRepoFile(root, req.query.path);
  if (!rd.ok) return res.json({ code: 400, msg: rd.msg });
  res.json({ code: 0, data: { path: String(req.query.path), lang: ci.detectLang(String(req.query.path)), content: rd.content, lines: rd.content.split('\n').length } });
});

/* ============================ 补丁：propose / apply / rollback ============================ */

router.post('/repos/:id/patch/propose', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在（只能对自己的仓库提补丁）' });
  const b = req.body || {};
  const rel = String(b.path || '').trim();
  if (!rel) return res.json({ code: 400, msg: '缺少文件路径 path' });
  let root; try { root = fs.realpathSync(r.root_path); } catch { return res.json({ code: 400, msg: '仓库目录不可访问' }); }
  const rd = ci.readRepoFile(root, rel);
  if (!rd.ok) return res.json({ code: 400, msg: rd.msg });
  const ar = ci.applyFindReplace(rd.content, b.find, b.replace, !!b.all);
  if (!ar.ok) return res.json({ code: 400, msg: ar.msg });
  if (ar.content === rd.content) return res.json({ code: 400, msg: '替换后内容无变化' });
  const d = ci.unifiedDiff(rd.content, ar.content, 'a/' + rel, 'b/' + rel);
  const info = db.prepare(`INSERT INTO code_patches (repo_id,owner,file_path,old_content,new_content,diff,additions,deletions,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'proposed', ?)`)
    .run(r.id, req.user.username, rel, rd.content, ar.content, d.diff, d.additions, d.deletions, now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '提议代码补丁', `${r.name} / ${rel}（+${d.additions} -${d.deletions}）`, req.ip, now());
  res.json({ code: 0, data: { patch_id: info.lastInsertRowid, path: rel, diff: d.diff, additions: d.additions, deletions: d.deletions, replace_count: ar.count, status: 'proposed' } });
});

router.get('/repos/:id/patches', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在或不可见' });
  const rows = db.prepare(`SELECT p.id,p.file_path,p.status,p.additions,p.deletions,p.diff,p.created_at,p.applied_at,
      (SELECT id FROM code_patch_backups b WHERE b.patch_id=p.id ORDER BY b.id DESC LIMIT 1) AS backup_id
    FROM code_patches p WHERE p.repo_id=? ORDER BY p.id DESC LIMIT 50`).all(r.id);
  res.json({ code: 0, data: rows });
});

router.post('/repos/:id/patch/:pid/apply', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在（只能对自己的仓库应用补丁）' });
  const p = db.prepare('SELECT * FROM code_patches WHERE id=? AND repo_id=?').get(req.params.pid, r.id);
  if (!p) return res.json({ code: 404, msg: '补丁不存在' });
  if (p.status !== 'proposed') return res.json({ code: 400, msg: `补丁状态为 ${p.status}，不可重复应用` });
  let root; try { root = fs.realpathSync(r.root_path); } catch { return res.json({ code: 400, msg: '仓库目录不可访问' }); }
  // 应用前校验文件当前内容与提议时一致（防并发/外部改动覆盖）
  const rd = ci.readRepoFile(root, p.file_path);
  if (!rd.ok) return res.json({ code: 400, msg: '文件当前不可读：' + rd.msg });
  if (rd.content !== p.old_content) return res.json({ code: 409, msg: '文件在提议后已被修改，请重新提议补丁（拒绝覆盖外部改动）' });
  // 写前备份
  const abs = path.join(root, p.file_path);
  const bk = db.prepare(`INSERT INTO code_patch_backups (repo_id,owner,file_path,patch_id,content,status,created_at)
    VALUES (?,?,?,?,?, 'active', ?)`).run(r.id, req.user.username, p.file_path, p.id, rd.content, now());
  try { fs.writeFileSync(abs, p.new_content, 'utf8'); }
  catch (e) { db.prepare("UPDATE code_patch_backups SET status='failed' WHERE id=?").run(bk.lastInsertRowid); return res.json({ code: 500, msg: '写盘失败：' + e.message }); }
  db.prepare("UPDATE code_patches SET status='applied', applied_at=? WHERE id=?").run(now(), p.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '应用代码补丁', `${r.name} / ${p.file_path}（备份 #${bk.lastInsertRowid}）`, req.ip, now());
  res.json({ code: 0, msg: '补丁已应用', data: { patch_id: p.id, backup_id: bk.lastInsertRowid, file_path: p.file_path, additions: p.additions, deletions: p.deletions } });
});

router.post('/repos/:id/patch/rollback', (req, res) => {
  const r = repoOf(req.params.id, req.user);
  if (!r) return res.json({ code: 404, msg: '仓库不存在（只能回滚自己的仓库）' });
  const bid = req.body && req.body.backup_id;
  const bk = db.prepare('SELECT * FROM code_patch_backups WHERE id=? AND repo_id=? AND owner=?').get(bid, r.id, req.user.username);
  if (!bk) return res.json({ code: 404, msg: '备份不存在' });
  if (bk.status !== 'active') return res.json({ code: 400, msg: `备份状态为 ${bk.status}，不可回滚` });
  let root; try { root = fs.realpathSync(r.root_path); } catch { return res.json({ code: 400, msg: '仓库目录不可访问' }); }
  const abs = path.join(root, bk.file_path);
  try { fs.writeFileSync(abs, bk.content, 'utf8'); }
  catch (e) { return res.json({ code: 500, msg: '回滚写盘失败：' + e.message }); }
  db.prepare("UPDATE code_patch_backups SET status='rolled_back' WHERE id=?").run(bk.id);
  db.prepare("UPDATE code_patches SET status='rolled_back' WHERE id=?").run(bk.patch_id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '回滚代码补丁', `${r.name} / ${bk.file_path}`, req.ip, now());
  res.json({ code: 0, msg: '已回滚到备份版本', data: { file_path: bk.file_path, backup_id: bk.id } });
});

module.exports = router;
