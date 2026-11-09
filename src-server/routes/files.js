/**
 * 工作流文件 API（P5.14 文件一等变量）
 *
 * POST   /api/files            上传（{ name, file_b64, source } → 解析 → wf_files 表 → { id }）
 * GET    /api/files/:id        元数据（不含原文）——P1-2 修复：校验 created_by 归属
 * GET    /api/files/:id/download  原文下载（content_b64 回放；未存原文时 404 提示）——P1-2 修复：校验 created_by 归属
 *
 * 安全：登录鉴权 / 扩展名白名单（pdf docx txt md）/ 单文件 ≤ 8MB / b64 不回读明文（仅下载接口按需吐原文）
 */
const express = require('express');
const router = express.Router();
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { FILE_EXTS, parseFileBuffer } = require('../lib/fileparse');

router.use(auth); // 登录鉴权（下载接口同鉴权：文件属平台资产，防匿名遍历）

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB

router.post('/', async (req, res) => {
  const { name, file_b64, source } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '请提供文件名' });
  if (!file_b64) return res.json({ code: 400, msg: '请提供文件内容（file_b64）' });
  let buf;
  try { buf = Buffer.from(file_b64, 'base64'); } catch { return res.json({ code: 400, msg: 'file_b64 不是合法 base64' }); }
  if (!buf.length) return res.json({ code: 400, msg: '文件内容为空' });
  if (buf.length > MAX_FILE_BYTES) return res.json({ code: 400, msg: `文件过大（${(buf.length / 1048576).toFixed(1)}MB），上限 8MB` });
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (!FILE_EXTS.includes(ext)) return res.json({ code: 400, msg: `暂不支持 .${ext} 格式，支持：${FILE_EXTS.map(e => e.toUpperCase()).join(' / ')}` });
  let text = '';
  try { text = (await parseFileBuffer(name, buf)).text; } catch (e) { return res.json({ code: 400, msg: '文件解析失败：' + e.message }); }
  if (text.length < 4) return res.json({ code: 400, msg: '解析后无有效文本内容（扫描版 PDF 需先 OCR）' });
  const src = ['manual', 'chat'].includes(source) ? source : 'manual';
  const info = db.prepare(`INSERT INTO wf_files (name,ext,size,text_content,content_b64,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(String(name).slice(0, 200), ext, buf.length, text, buf.toString('base64'), src, req.user?.username || '', now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user?.username || '匿名', '上传工作流文件', `${name}（${(buf.length / 1024).toFixed(0)}KB，解析 ${text.length} 字）`, req.ip, now());
  res.json({ code: 0, data: { id: Number(info.lastInsertRowid), name, ext, size: buf.length, text_len: text.length, url: `/api/files/${info.lastInsertRowid}/download` } });
});

router.get('/:id', (req, res) => {
  const f = db.prepare('SELECT id,name,ext,size,length(text_content) AS text_len,source,created_at,created_by FROM wf_files WHERE id=?').get(+req.params.id);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  // P1-2 修复：非管理员只能访问自己上传的文件
  if (req.user?.role !== 'admin' && f.created_by && f.created_by !== req.user?.username) {
    return res.json({ code: 403, msg: '无权访问此文件（仅创建者可查看自己上传的文件）' });
  }
  res.json({ code: 0, data: { ...f, url: `/api/files/${f.id}/download` } });
});

router.get('/:id/download', (req, res) => {
  const f = db.prepare('SELECT id,name,ext,content_b64,size,created_by FROM wf_files WHERE id=?').get(+req.params.id);
  if (!f) return res.status(404).json({ code: 404, msg: '文件不存在' });
  // P1-2 修复：非管理员只能下载自己上传的文件
  if (req.user?.role !== 'admin' && f.created_by && f.created_by !== req.user?.username) {
    return res.status(403).json({ code: 403, msg: '无权下载此文件（仅创建者可下载自己上传的文件）' });
  }
  if (!f.content_b64) return res.status(404).json({ code: 404, msg: '原文未保留（仅解析文本可用）' });
  const buf = Buffer.from(f.content_b64, 'base64');
  const mime = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown' }[f.ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(buf);
});

module.exports = router;
