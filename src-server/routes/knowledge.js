/** 知识库：库 CRUD / 文件上传解析 / 召回测试 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { retrieve, rerankModels } = require('../lib/retriever');
const { generateForFile } = require('../lib/keywordgen');
const { extractMetadataForFile, sanitizeMetadata } = require('../lib/kb-metadata'); // V1.2 #2 2026-10-30：自动元数据抽取 + 入参清洗
const { retrieveGraph } = require('../lib/graphrag');

const router = express.Router();
router.use(auth);

// P5.30 安全止血：写操作归属校验——此前 PUT/DELETE/上传对任何登录用户放行（可改删他人知识库、向他人知识库注入内容）。
// P0-1: owner 规范化——存量已迁移（nickname→username），创建时写入 req.user.username，校验仅比较 username 与 admin
function denyIfNotAllowed(kb, user) {
  if (!kb) return { code: 404, msg: '知识库不存在' };
  if (user.role === 'admin') return null;
  if (kb.owner === user.username) return null;
  return { code: 403, msg: '无权管理该知识库（仅创建者或管理员）' };
}

// V1.1 #1 2026-10-30：解析失败落库——此前三个失败出口（解析异常/文本过短/切片为空）直接 return 400 不留痕，
// error_msg 恒空无从排查。失败记录 status='failed' + error_msg（截断 500 字符防超长）+ chunk_count=0，
// 供「解析日志」页展示失败原因、支持重传/删除。三处失败点 kb 校验已过、kb.id 可用
function insertFailedFile(kb, name, byteSize, source, errMsg, req) {
  const msg = String(errMsg || '未知原因').slice(0, 500);
  // V1.1 审查加固 2026-10-30：name 截 200（对齐 files.js 先例）/ source 白名单，防存储滥用
  const safeName = String(name || '未命名').slice(0, 200);
  const safeSource = ['upload', 'api', 'pipeline'].includes(source) ? source : 'upload';
  db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,source,error_msg,parsed_at,created_at)
    VALUES (?,?,?,'failed',0,?,?,NULL,datetime('now','localtime'))`)
    .run(kb.id, safeName, byteSize || 0, safeSource, msg);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '知识库文件解析失败', `${kb.name} / ${safeName}：${msg.slice(0, 200)}`, req.ip, now());
}

router.get('/', (req, res) => {
  // V1.2 审查加固 2026-10-30：库列表加 owner 过滤——此前任意登录用户可看全平台库名/描述/配置（含
  // auto_metadata、分块参数），与 agents 挂库归属校验组合是攻击链的侦察环节；管理员仍见全部（管理页需要）
  const rows = db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id) AS file_count
    FROM kbs k WHERE (?='admin' OR k.owner=?) ORDER BY k.id DESC`).all(req.user.role, req.user.username);
  res.json({ code: 0, data: rows });
});

router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '知识库名称不能为空' });
  const info = db.prepare(`INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES (?,?,1,?,datetime('now','localtime'))`)
    .run(name.trim(), description || '', req.user.username);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建知识库', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const { name, description, enabled, chunk_size, chunk_overlap, chunk_separator, auto_metadata } = req.body || {};
  const old = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(old, req.user);
  if (deny) return res.json(deny);
  // V1.2 #2 2026-10-30：auto_metadata 开关归一（0/1；未传保留原值）——开启后上传文件后台 LLM 自动抽取元数据
  const autoMeta = auto_metadata == null ? (old.auto_metadata ?? 0) : (auto_metadata ? 1 : 0);
  db.prepare('UPDATE kbs SET name=?,description=?,enabled=?,chunk_size=?,chunk_overlap=?,chunk_separator=?,auto_metadata=? WHERE id=?')
    .run(name || old.name, description ?? old.description, enabled ?? old.enabled,
      chunk_size ?? old.chunk_size, chunk_overlap ?? old.chunk_overlap, chunk_separator ?? old.chunk_separator, autoMeta, old.id);
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

// 文件列表（SELECT * 已含迁移列 source/error_msg/parsed_at/updated_at，前端直接可用，无需额外字段拼接）
// V1.1 审查加固 2026-10-30：补归属校验——此前无校验，任意登录用户可看他人库文件元数据；
// 本轮 error_msg（含解析器内部报错）入库后若继续敞开，/:id/logs 的收紧设计将被旁路，故与 logs 同权
router.get('/:id/files', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  res.json({ code: 0, data: db.prepare('SELECT * FROM kb_files WHERE kb_id=? ORDER BY id DESC').all(req.params.id) });
});

// V1.1 #1 2026-10-30：解析日志——分页列表 + 四态汇总统计（前端「解析日志」页数据源）
// 权限比 files 列表更严（admin/owner 才可看）：日志含失败原因细节（可能带解析器内部报错信息），不向普通用户开放
// processing/pending 态在当前同步架构下恒为 0，为 #5 摄取管道异步化后的预留演进位（非缺陷）
router.get('/:id/logs', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
  const total = db.prepare('SELECT COUNT(*) AS c FROM kb_files WHERE kb_id=?').get(kb.id).c;
  const list = db.prepare(`SELECT id,name,source,size,status,chunk_count,error_msg,parsed_at,created_at
    FROM kb_files WHERE kb_id=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(kb.id, pageSize, (page - 1) * pageSize);
  // V1.1 审查加固 2026-10-30：stats 由 5 次独立 COUNT 合并为单条 GROUP BY（配合 idx_kb_files_kb 索引，防行数膨胀后同步驱动阻塞事件循环）
  const stats = { total, success: 0, failed: 0, processing: 0 };
  db.prepare('SELECT status, COUNT(*) AS c FROM kb_files WHERE kb_id=? GROUP BY status').all(kb.id).forEach(r => {
    if (r.status === 'success') stats.success = r.c;
    else if (r.status === 'failed') stats.failed = r.c;
    else if (r.status === 'processing' || r.status === 'pending') stats.processing += r.c; // 四态预设计：#5 管道异步化后的预留态
  });
  res.json({
    code: 0,
    data: {
      list, total, page, page_size: pageSize,
      stats,
    },
  });
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
  const { name, content, file_b64, source } = req.body || {};
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
    insertFailedFile(kb, name, byteSize, source, '文件解析失败：' + e.message, req); // V1.1 #1：解析异常也落库留痕
    return res.json({ code: 400, msg: '文件解析失败：' + e.message });
  }
  text = (text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (text.length < 8) {
    insertFailedFile(kb, name, byteSize, source, '解析后无有效文本内容（扫描版 PDF 需先 OCR）', req); // V1.1 #1：失败落库
    return res.json({ code: 400, msg: '解析后无有效文本内容（扫描版 PDF 需先 OCR）' });
  }

  // 智能切片（使用知识库配置参数）
  const chunkSize = kb.chunk_size || 500;
  const chunkOverlap = kb.chunk_overlap || 0;
  const sep = kb.chunk_separator || '\n\s*\n';
  const sepRe = new RegExp(sep);
  const chunks = [];
  for (const para of text.split(sepRe)) {
    const p = para.trim();
    if (p.length < 8) continue;
    if (p.length <= chunkSize) { chunks.push(p); continue; }
    // 超长段落：按句边界切 ~chunkSize 字
    let cur = '';
    for (const sent of p.split(/(?<=[。！？；.!?;])/)) {
      if ((cur + sent).length > chunkSize && cur) { chunks.push(cur.trim()); cur = sent; }
      else cur += sent;
    }
    if (cur.trim().length >= 8) chunks.push(cur.trim());
  }
  // 重叠切片：对相邻两块各取末尾 overlap 字符追加到前一块
  if (chunkOverlap > 0 && chunks.length > 1) {
    for (let i = chunks.length - 1; i > 0; i--) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (prev.length > chunkOverlap) {
        chunks[i - 1] = prev + '\n' + next.slice(0, chunkOverlap);
      }
    }
  }
  if (!chunks.length) {
    insertFailedFile(kb, name, byteSize, source, '切片后无有效片段', req); // V1.1 #1：失败落库
    return res.json({ code: 400, msg: '切片后无有效片段' });
  }

  // TOC目录增强（2026-10-30）：用LLM提取目录结构，按章节标记分块（失败不阻塞上传）
  // 注意：chunks 统一保持字符串数组，章节归属单独存 chapterIds —— 避免对象混入导致 join 产生 [object Object]
  let toc = null;
  let chapterIds = chunks.map(() => null);
  try {
    const { extractToc, assignChapterIds } = require('../lib/tocService');
    toc = await extractToc(text, chunkSize);
    if (toc && toc.length) {
      const withChapters = chunks.map(c => ({ content: c }));
      assignChapterIds(withChapters, toc);
      chapterIds = withChapters.map(c => c.chapterId || null);
      // TOC 每章节定位：首个包含该标题的分块索引；未命中继承上一章节位置
      let lastIdx = 0;
      for (const t of toc) {
        let found = -1;
        for (let i = 0; i < chunks.length; i++) {
          if (chunks[i].includes(t.title)) { found = i; break; }
        }
        t.startChunkIdx = found >= 0 ? found : lastIdx;
        lastIdx = t.startChunkIdx;
      }
    }
  } catch { /* TOC提取失败不阻塞上传 */ }

  // 父子切片（2026-10-28 P2 父子切片）：子分片 ~200 字精准召回，父分片 ~1000 字保持上下文完整
  // 按顺序每 4-6 个字分片合并为一个父分片（尽可能接近 1000 字）
  const hasParentSlice = chunkSize > 200; // 只有 chunkSize > 200 时才需要分割父子切片
  let parentChunks = [];
  let childToParent = []; // 每个子分片对应的父分片索引（-1 = 独立，不关联）
  if (hasParentSlice && chunks.length >= 2) {
    // 计算每个父分片应该包含的子分片数
    const pSize = 1000; // 目标父分片大小
    const childCount = Math.max(2, Math.round(pSize / chunkSize));
    parentChunks = [];
    childToParent = [];
    for (let i = 0; i < chunks.length; i += childCount) {
      const group = chunks.slice(i, i + childCount);
      parentChunks.push(group.join('\n'));
      for (let j = 0; j < group.length; j++) childToParent.push(parentChunks.length - 1);
    }
  } else {
    childToParent = chunks.map(() => -1);
  }

  const info = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,source,parsed_at,created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
    .run(kb.id, name, byteSize, 'success', chunks.length, source || 'upload');
  // 先插父分片，再插子分片
  if (hasParentSlice && parentChunks.length) {
    const insParent = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,parent_id) VALUES (?,?,?,?)');
    parentChunks.forEach(pc => insParent.run(info.lastInsertRowid, kb.id, pc, null));
  }
  const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,parent_id,chapter_id) VALUES (?,?,?,?,?)');
  const parentStartIdx = hasParentSlice ? parentChunks.length : 0;
  chunks.forEach((c, i) => {
    const parentId = hasParentSlice && childToParent[i] >= 0 ? (parentStartIdx + childToParent[i] + 1) : null;
    ins.run(info.lastInsertRowid, kb.id, c, parentId, chapterIds[i]); // chapter_id = TOC 章节归属
  });
  // 如果有 TOC，回写入 kbs 表
  if (toc && toc.length) {
    db.prepare('UPDATE kbs SET toc=? WHERE id=?').run(JSON.stringify(toc), kb.id);
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '上传知识库文件', `${kb.name} / ${name}（${chunks.length} 片段）`, req.ip, now());
  // 自动关键词/问法生成（2026-10-29）：上传响应后后台 best-effort 生成，不阻塞上传；无模型/失败静默跳过
  generateForFile(info.lastInsertRowid).catch(() => { });
  // V1.2 #2 2026-10-30：自动元数据抽取——库开启 auto_metadata 时上传后 fire-and-forget 后台抽取
  // （与 generateForFile 并列）；未开启/无供应商/失败均静默跳过，不阻塞上传
  if (kb.auto_metadata) extractMetadataForFile(info.lastInsertRowid).catch(() => { });
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

// 分块管理（P1 2026-10-28：列出/编辑/合并/删除单个 chunk）
router.get('/files/:fileId/chunks', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const rows = db.prepare('SELECT c.id, c.content, c.file_id, c.kb_id, c.keywords, c.metadata FROM kb_chunks c WHERE c.file_id=? ORDER BY c.id').all(req.params.fileId); // V1.2 #2：带出 metadata（分块编辑回显）
  res.json({ code: 0, data: { file: { id: f.id, name: f.name, kb_id: f.kb_id }, chunks: rows } });
});

// 手动补生成/重新生成关键词+问法（对存量分块，或内容编辑后刷新；无模型时友好提示）
router.post('/files/:fileId/generate-metadata', async (req, res) => {
  // V1.2 审查加固 2026-10-30：手动补抽取元数据（复刻 generate-keywords 交互）——先传文件后开
  // auto_metadata 的存量文件补抽取途径；库未开启开关时显式提示（防误以为已抽取）
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const r = await extractMetadataForFile(f.id);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  if (r.skipped === 'no_provider') return res.json({ code: 0, data: { ...r, msg: '未配置可用模型供应商，已跳过抽取' } });
  if (r.skipped === 'disabled') return res.json({ code: 400, msg: '该库未开启「自动元数据」，请先在库设置中开启' });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '补抽取元数据', `${kb.name} / ${f.name}（成功 ${r.extracted}/${r.total}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

router.post('/files/:fileId/generate-keywords', async (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const r = await generateForFile(f.id);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  if (r.skipped === 'no_provider') return res.json({ code: 0, data: { ...r, msg: '未配置可用模型供应商，已跳过生成' } });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '生成关键词', `${kb.name} / ${f.name}（成功 ${r.generated}/${r.total}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

// 更新单个 chunk 内容（V1.2 #2 2026-10-30：同步接受 metadata 手工编辑——sanitizeMetadata 清洗后存 JSON 字符串；null/空对象存 NULL 即清除）
router.put('/chunks/:chunkId', (req, res) => {
  const c = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(req.params.chunkId);
  if (!c) return res.json({ code: 404, msg: '分块不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(c.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const { content, metadata } = req.body || {};
  if (content == null) return res.json({ code: 400, msg: '请提供内容' });
  if (metadata !== undefined) {
    const clean = sanitizeMetadata(metadata);
    const metaSql = Object.keys(clean).length ? JSON.stringify(clean) : null;
    db.prepare('UPDATE kb_chunks SET content=?, metadata=? WHERE id=?').run(String(content || ''), metaSql, c.id);
  } else {
    db.prepare('UPDATE kb_chunks SET content=? WHERE id=?').run(String(content || ''), c.id);
  }
  // 更新文件 chunk_count（不做严格同步，简单 +1 即可）
  res.json({ code: 0, msg: '分块已更新' });
});

// 删除单个 chunk
router.delete('/chunks/:chunkId', (req, res) => {
  const c = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(req.params.chunkId);
  if (!c) return res.json({ code: 404, msg: '分块不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(c.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE id=?').run(c.id);
  res.json({ code: 0, msg: '已删除' });
});

// 合并相邻两个 chunk（sourceId 的内容合并到 targetId，然后删除 sourceId）
router.post('/chunks/merge', (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) return res.json({ code: 400, msg: '请指定要合并的两个分块 ID' });
  const source = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(sourceId);
  const target = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(targetId);
  if (!source || !target) return res.json({ code: 404, msg: '分块不存在' });
  if (source.kb_id !== target.kb_id) return res.json({ code: 400, msg: '不能合并不同知识库的分块' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(source.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  db.prepare('UPDATE kb_chunks SET content=? WHERE id=?').run((source.content + '\n' + target.content).trim(), target.id);
  db.prepare('DELETE FROM kb_chunks WHERE id=?').run(source.id);
  res.json({ code: 0, msg: '已合并' });
});

// 可用 Rerank 模型列表（召回测试下拉用，2026-10-29 可视化升级）
router.get('/rerank-models', (req, res) => {
  res.json({ code: 0, data: rerankModels() });
});

// 召回测试（混合检索：BM25 + 向量加权 RRF 融合 + 可选 Rerank；P2 升级 async 双引擎，2026-10-29 支持权重/重排可视化参数）
router.post('/recall-test', async (req, res) => {
  const { kb_id, file_id, query, top_n, threshold, vector_weight, rerank_model, rerank_enabled, metadataFilter } = req.body || {};
  if (!query?.trim()) return res.json({ code: 400, msg: '请输入测试问题' });
  let kbId = kb_id || null;
  if (file_id) {
    const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(file_id);
    kbId = f ? f.kb_id : kbId;
  }
  // V1.1 读侧收口（V1.2 #2 2026-10-30 补齐）：召回测试可检索他人库内容，同样属读越权——
  // 与 logs/files 同模式先查 kb 校验归属；未指定库（全库检索）无归属可校验，仅管理员放行（fail-closed）
  if (kbId) {
    const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(kbId);
    const deny = denyIfNotAllowed(kb, req.user);
    if (deny) return res.json(deny);
  } else if (req.user.role !== 'admin') {
    return res.json({ code: 403, msg: '请选择知识库后测试（全库检索仅管理员可用）' });
  }
  // V1.2 #2 2026-10-30：元数据过滤参数——sanitizeMetadata 清洗后传 retrieve；空对象不传（与无过滤行为一致）
  const mFilter = sanitizeMetadata(metadataFilter);
  const hits = await retrieve(query, kbId, top_n || 5, threshold ?? 0.01, {
    vecWeight: vector_weight,               // 向量权重 0~1（默认 0.5，滑块实时调）
    rerankModel: rerank_model || null,      // 重排模型（下拉选择）
    rerankEnabled: rerank_enabled !== false, // 重排开关（对比效果用）
    ...(Object.keys(mFilter).length ? { metadataFilter: mFilter } : {}), // V1.2 #2：非空才下发（AND 语义，fail-closed）
  });
  res.json({ code: 0, data: { query, hits, count: hits.length, mode: 'hybrid' } });
});

// 知识图谱检索（GraphRAG）：给定查询文本，返回已知实体与关联关系上下文
router.post('/:id/graph-search', async (req, res) => {
  const { query, top_k } = req.body || {};
  if (!query?.trim()) return res.json({ code: 400, msg: '请输入查询内容' });
  // V1.1 读侧收口（V1.2 #2 2026-10-30 补齐）：图谱检索同样暴露库内容，与 logs/files 同模式校验归属
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const data = retrieveGraph(query, req.params.id, top_k || 5);
  res.json({ code: 0, data });
});

// V1.2 #2 2026-10-30：元数据筛选选项——返回该库全部分块的 distinct 元数据键值聚合（前端筛选下拉数据源）。
// metadata 为 JSON 文本，从 JS 侧解析聚合（SQL 不便按键展开）；损坏 JSON/非对象值跳过；owner/admin 可见（denyIfNotAllowed 同权）
router.get('/:id/meta-options', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const rows = db.prepare("SELECT c.metadata FROM kb_chunks c WHERE c.kb_id=? AND c.metadata IS NOT NULL AND c.metadata != ''").all(kb.id);
  const byKey = new Map(); // 键 → Set(去重值集）
  for (const r of rows) {
    let meta = null;
    try { meta = JSON.parse(r.metadata); } catch { continue; } // 损坏 JSON 跳过
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    for (const [k, v] of Object.entries(meta)) {
      if (!k || !k.trim()) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      const set = byKey.get(k);
      if (typeof v === 'string') { if (v) set.add(v); }
      else if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string' && x) set.add(x); }); // 数组值摊平进选项集
    }
  }
  // V1.2 审查加固 2026-10-30：返回 {keys, options} 双结构——原平铺写法在自定义键恰为 "keys" 时会覆盖
  // 键列表字段（sanitizeMetadata 键白名单不设限）；options 内为全部键的 distinct 值集，keys 为键名列表
  const options = {};
  for (const [k, set] of byKey) options[k] = [...set];
  res.json({ code: 0, data: { keys: [...byKey.keys()], options } });
});

module.exports = router;
