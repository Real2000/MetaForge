/**
 * P1-16 文档权限校验（2026-11-13）
 *
 * 统一「文件台账 → 预览权限」判定层，供 /api/doc/* 预览接口、知识库分块预览、分享页预览共用。
 * 目标：未授权不可预览（此前 /uploads/exports 等产物目录是公开静态资源，仅靠不可猜文件名兜底）。
 *
 * 支持的文件来源（src）：
 *   - wf       工作流/聊天附件文件（wf_files 表）：创建者本人或 admin 可预览
 *   - kb       知识库文件（kb_files 表）：库创建者或 admin 可预览（RAM 权限同写权限）
 *   - export   对话/工具产物目录（public/uploads/exports）：登录用户可预览（平台内部产物，禁匿名）
 *   - sandbox  沙箱产物（public/uploads/sandbox）：登录用户可预览（禁止 html/svg 内联渲染）
 *
 * 设计约束：
 *   1) 路径强校验：只允许 public/uploads 下的已登记子目录，路径穿越（..）一律拒绝；
 *   2) 类型白名单：只对可安全内联展示的扩展名开放 inline，html/svg 等一律下载不可内联执行；
 *   3) 判定与取字节分离：本模块只做判定，读取由调用方完成（wf 走 DB、目录类走磁盘）。
 */
const path = require('path');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const fs = require('fs');

const { db } = require('../db');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');
const UPLOAD_ROOT = path.join(PUBLIC_ROOT, 'uploads');
const DIR_SOURCES = { export: 'exports', sandbox: 'sandbox' };

// 可内联预览的扩展名（与前端 viewer 支持的渲染器一致）
const INLINE_EXTS = new Set([
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'pptx', 'ppt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'markdown', 'json', 'log',
]);
// 允许下载但禁止内联（防同源脚本执行）的扩展名
const DOWNLOAD_ONLY_EXTS = new Set(['html', 'htm', 'svg', 'xml', 'js', 'mjs', 'xhtml']);

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  log: 'text/plain; charset=utf-8',
};

function extOf(name) {
  return (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
}

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

/** 解析 public/uploads 下的相对路径（结构层校验：只做穿越拦截，不要求文件存在） */
function resolveUploadPath(rawPath) {
  if (!rawPath) return null;
  let clean;
  try { clean = decodeURIComponent(String(rawPath)).split('?')[0].split('#')[0]; } catch { return null; }
  if (!clean.startsWith('/uploads/')) return null;
  const abs = path.resolve(PUBLIC_ROOT, '.' + clean);
  if (!(abs === UPLOAD_ROOT || abs.startsWith(UPLOAD_ROOT + path.sep))) return null;
  return abs;
}

/** 取真实路径并二次校验（防符号链接逃逸出 uploads 目录）；文件不存在返回 null */
function realUploadPath(abs) {
  let real, realRoot;
  try { real = fs.realpathSync(abs); } catch { return null; }
  try { realRoot = fs.realpathSync(UPLOAD_ROOT); } catch { realRoot = UPLOAD_ROOT; }
  if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return null;
  return real;
}

/** wf_files 归属判定：创建者本人或 admin */
function canViewWfFile(user, row) {
  if (!row) return { ok: false, code: 404, msg: '文件不存在' };
  if (isAdmin(user)) return { ok: true };
  const owner = row.created_by || '';
  if (!owner) return { ok: true }; // 历史数据无归属：登录用户可见（与既有 download 接口兼容）
  if (owner === (user && user.username)) return { ok: true };
  return { ok: false, code: 403, msg: '无权预览此文件（仅创建者可查看）' };
}

/** kb 归属判定：库创建者本人或 admin */
function canViewKb(user, kb) {
  if (!kb) return { ok: false, code: 404, msg: '知识库不存在' };
  if (isAdmin(user)) return { ok: true };
  if (kb.owner && kb.owner === (user && user.username)) return { ok: true };
  return { ok: false, code: 403, msg: '无权预览此知识库文件（仅创建者可查看）' };
}

/**
 * 统一预览判定
 * @param {object} user  req.user
 * @param {object} q     { src, id, path }
 * @returns {{ok:boolean, code?:number, msg?:string, kind?:string, name?:string, abs?:string, buf?:Buffer, size?:number, ext?:string, mime?:string, inline?:boolean}}
 */
function resolvePreview(user, q = {}) {
  if (!user) return { ok: false, code: 401, msg: '未登录' };
  const src = String(q.src || '').toLowerCase();

  if (src === 'wf') {
    const row = dal.getq('SELECT id,name,ext,size,content_b64,created_by,source,created_at FROM wf_files WHERE id=?', [+q.id]);
    const deny = canViewWfFile(user, row);
    if (!deny.ok) return deny;
    if (!row.content_b64) return { ok: false, code: 404, msg: '原文未保留（仅解析文本可用）' };
    const buf = Buffer.from(row.content_b64, 'base64');
    const ext = (row.ext || extOf(row.name)).toLowerCase();
    return { ok: true, kind: 'wf', name: row.name, ext, size: buf.length, buf, mime: MIME[ext] || 'application/octet-stream', inline: INLINE_EXTS.has(ext) };
  }

  if (src === 'kb') {
    const f = dal.getq('SELECT id,kb_id,name,size,status FROM kb_files WHERE id=?', [+q.id]);
    if (!f) return { ok: false, code: 404, msg: '文件不存在' };
    const kb = dal.getq('SELECT id,owner,name FROM kbs WHERE id=?', [f.kb_id]);
    const deny = canViewKb(user, kb);
    if (!deny.ok) return deny;
    // kb_files 只保留解析文本与分块，原文不入库：由调用方改用 /api/knowledge/files/:id/chunks 预览
    const chunks = dal.q('SELECT content FROM kb_chunks WHERE file_id=? ORDER BY id ASC', [f.id]);
    return { ok: true, kind: 'kb', name: f.name, ext: extOf(f.name), size: f.size || 0, text: chunks.map(c => c.content || '').join('\n\n'), chunks };
  }

  if (DIR_SOURCES[src]) {
    const abs0 = resolveUploadPath(q.path);
    if (!abs0) return { ok: false, code: 400, msg: '非法文件路径' };
    const dirRoot = path.join(UPLOAD_ROOT, DIR_SOURCES[src]);
    if (!(abs0.startsWith(dirRoot + path.sep))) return { ok: false, code: 403, msg: '路径不在允许的目录内' };
    const abs = realUploadPath(abs0);
    if (!abs) return { ok: false, code: 404, msg: '文件不存在' };
    let st;
    try { st = fs.statSync(abs); } catch { return { ok: false, code: 404, msg: '文件不存在' }; }
    if (!st.isFile()) return { ok: false, code: 404, msg: '文件不存在' };
    const name = path.basename(abs);
    const ext = extOf(name);
    // 登录即可预览：平台内部产物目录不允许匿名访问（静态目录仍在，此处为受控预览通道）
    return {
      ok: true, kind: src, name, ext, size: st.size, abs,
      mime: MIME[ext] || 'application/octet-stream',
      inline: INLINE_EXTS.has(ext),
      downloadOnly: DOWNLOAD_ONLY_EXTS.has(ext),
    };
  }

  return { ok: false, code: 400, msg: '未知的文件来源（src 应为 wf/kb/export/sandbox）' };
}

module.exports = {
  resolvePreview,
  resolveUploadPath,
  realUploadPath,
  canViewWfFile,
  canViewKb,
  INLINE_EXTS,
  DOWNLOAD_ONLY_EXTS,
  MIME,
  extOf,
};