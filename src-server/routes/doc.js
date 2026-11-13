/**
 * P1-15 / P1-16 文档预览接口（2026-11-13）
 *
 * GET /api/doc/meta   预览元信息（名称/格式/大小/受控原文地址/是否可内联预览）
 * GET /api/doc/raw    受控原文流（权限校验通过后才吐字节；html/svg 强制附件，防同源脚本执行）
 *
 * 权限判定统一收敛在 lib/doc-perm.js：wf_files 归属、知识库归属、产物目录路径白名单。
 * 前端 public/js/viewer.js 通过这两个接口加载文档，知识库分块预览走 /api/knowledge/files/:id/chunks。
 */
const express = require('express');
const fs = require('fs');
const { auth } = require('../lib/auth');
const { db, now } = require('../db');
const { resolvePreview } = require('../lib/doc-perm');

const router = express.Router();
router.use(auth);

function rawUrl(q) {
  const p = new URLSearchParams();
  p.set('src', q.src);
  if (q.id != null) p.set('id', String(q.id));
  if (q.path) p.set('path', String(q.path));
  return '/api/doc/raw?' + p.toString();
}

router.get('/meta', (req, res) => {
  const r = resolvePreview(req.user, req.query);
  if (!r.ok) return res.json({ code: r.code, msg: r.msg });
  const previewable = r.kind === 'kb' ? true : (r.inline && !r.downloadOnly);
  res.json({
    code: 0,
    data: {
      kind: r.kind,
      name: r.name,
      ext: r.ext,
      size: r.size,
      previewable,
      renderMode: r.kind === 'kb' ? 'chunks' : (previewable ? r.ext : 'download'),
      url: rawUrl(req.query),
      download: r.kind === 'wf' ? `/api/files/${+req.query.id}/download` : rawUrl(req.query),
    },
  });
});

router.get('/raw', (req, res) => {
  const r = resolvePreview(req.user, req.query);
  if (!r.ok) return res.status([400, 401, 403, 404].includes(r.code) ? r.code : 400).json({ code: r.code, msg: r.msg });

  // 知识库文件：只有解析文本，无原文 → 以文本流返回（查看器按 chunks 模式渲染更完整）
  if (r.kind === 'kb') {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=60');
    return res.send(r.text || '');
  }

  const buf = r.buf || (r.abs ? fs.readFileSync(r.abs) : null);
  if (!buf) return res.status(404).json({ code: 404, msg: '文件不存在' });

  const inline = r.inline && !r.downloadOnly;
  const safeName = encodeURIComponent(String(r.name || 'file').replace(/[\r\n"]/g, ''));
  res.set('Content-Type', inline ? r.mime : 'application/octet-stream');
  res.set('Content-Length', String(buf.length));
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=60');
  if (!inline) res.set('Content-Security-Policy', 'sandbox');
  res.send(buf);
});

// 预览审计（前端记录一次打开行为；失败不阻塞用户，仅尽力写入）
router.post('/preview-log', (req, res) => {
  const { src, id, path: p, name } = req.body || {};
  const r = resolvePreview(req.user, { src, id, path: p });
  if (!r.ok) return res.json({ code: r.code, msg: r.msg });
  try {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, '预览文档', `${r.kind}:${r.name}${name && name !== r.name ? '（' + name + '）' : ''}`, req.ip, now());
  } catch { }
  res.json({ code: 0 });
});

module.exports = router;