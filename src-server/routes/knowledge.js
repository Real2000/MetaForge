/** 知识库：库 CRUD / 文件上传解析 / 召回测试 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { retrieve } = require('../lib/retriever');

const router = express.Router();
router.use(auth);

// P5.30 安全止血：写操作归属校验——此前 PUT/DELETE/上传对任何登录用户放行（可改删他人知识库、向他人知识库注入内容）。
// kbs.owner 存的是创建者昵称或用户名（历史设计，创建时写入 nickname||username），两者任一命中 + 管理员放行。
// 彻底方案（owner 列改存 username）为中期项，届时需迁移存量数据
function denyIfNotAllowed(kb, user) {
  if (!kb) return { code: 404, msg: '知识库不存在' };
  if (user.role === 'admin') return null;
  if (kb.owner === user.username || (user.nickname && kb.owner === user.nickname)) return null;
  return { code: 403, msg: '无权管理该知识库（仅创建者或管理员）' };
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id) AS file_count
    FROM kbs k ORDER BY k.id DESC`).all();
  res.json({ code: 0, data: rows });
});

router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '知识库名称不能为空' });
  const info = db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES (?,?,1,?,datetime('now','localtime'))`)
    .run(name.trim(), description || '', req.user.nickname || req.user.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建知识库', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const { name, description, enabled } = req.body || {};
  const old = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(old, req.user);
  if (deny) return res.json(deny);
  db.prepare('UPDATE kbs SET name=?,description=?,enabled=? WHERE id=?')
    .run(name || old.name, description ?? old.description, enabled ?? old.enabled, old.id);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(old, req.user);
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(req.params.id);
  db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(req.params.id);
  db.prepare('DELETE FROM kbs WHERE id=?').run(req.params.id);
  if (old) db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除知识库', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// 文件列表
router.get('/:id/files', (req, res) => {
  res.json({ code: 0, data: db.prepare('SELECT * FROM kb_files WHERE kb_id=? ORDER BY id DESC').all(req.params.id) });
});

// 上传并解析。两种方式：
// ① { name, content }            —— 直接粘贴文本（txt/md）
// ② { name, file_b64 }           —— 二进制文件（PDF/DOCX/TXT/MD），自动解析提取文本
// 切片：按空行分段；超长段落按 ~500 字在句边界二次切分
router.post('/:id/files', async (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  if (!kb) return res.json({ code: 404, msg: '知识库不存在' });
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：防向他人知识库注入内容
  if (deny) return res.json(deny);
  const { name, content, file_b64 } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '请提供文件名' });

  let text = '';
  let byteSize = 0;
  try {
    if (file_b64) {
      const buf = Buffer.from(file_b64, 'base64');
      byteSize = buf.length;
      // P5.14 提取公共解析（fileparse.js）：PDF/DOCX/TXT/MD → 文本（与工作流文件上传同一实现）
      text = (await require('../lib/fileparse').parseFileBuffer(name, buf)).text;
    } else if (typeof content === 'string') {
      text = content;
      byteSize = Buffer.byteLength(content);
    } else {
      return res.json({ code: 400, msg: '请提供文件内容（粘贴文本或上传文件）' });
    }
  } catch (e) {
    return res.json({ code: 400, msg: '文件解析失败：' + e.message });
  }
  text = (text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (text.length < 8) return res.json({ code: 400, msg: '解析后无有效文本内容（扫描版 PDF 需先 OCR）' });

  // 智能切片
  const chunks = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (p.length < 8) continue;
    if (p.length <= 500) { chunks.push(p); continue; }
    // 超长段落：按句边界切 ~500 字
    let cur = '';
    for (const sent of p.split(/(?<=[。！？；.!?;])/)) {
      if ((cur + sent).length > 500 && cur) { chunks.push(cur.trim()); cur = sent; }
      else cur += sent;
    }
    if (cur.trim().length >= 8) chunks.push(cur.trim());
  }
  if (!chunks.length) return res.json({ code: 400, msg: '切片后无有效片段' });

  const info = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,datetime('now','localtime'))`)
    .run(kb.id, name, byteSize, 'success', chunks.length);
  const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)');
  chunks.forEach(c => ins.run(info.lastInsertRowid, kb.id, c));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '上传知识库文件', `${kb.name} / ${name}（${chunks.length} 片段）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, chunks: chunks.length } });
});

router.delete('/files/:fileId', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  const kb = f ? db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id) : null;
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：文件级写操作同样校验库归属
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE file_id=?').run(req.params.fileId);
  db.prepare('DELETE FROM kb_files WHERE id=?').run(req.params.fileId);
  res.json({ code: 0, msg: '已删除' });
});

// 重新解析（演示：仅刷新时间戳）
router.post('/files/:fileId/reparse', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：同上
  if (deny) return res.json(deny);
  db.prepare("UPDATE kb_files SET status='success' WHERE id=?").run(f.id);
  res.json({ code: 0, msg: '重新解析完成' });
});

// 召回测试（混合检索：BM25 + 向量 RRF 融合；P2 升级 async 双引擎）
router.post('/recall-test', async (req, res) => {
  const { kb_id, file_id, query, top_n, threshold } = req.body || {};
  if (!query?.trim()) return res.json({ code: 400, msg: '请输入测试问题' });
  let kbId = kb_id || null;
  if (file_id) {
    const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(file_id);
    kbId = f ? f.kb_id : kbId;
  }
  const hits = await retrieve(query, kbId, top_n || 5, threshold ?? 0.01);
  res.json({ code: 0, data: { query, hits, count: hits.length, mode: 'hybrid' } });
});

module.exports = router;
