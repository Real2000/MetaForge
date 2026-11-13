/**
 * P1-15 文档预览套件（2026-11-13）
 *
 * 统一查看器：知识库分块预览、对话产物预览、分享页预览共用同一套入口与渲染链路。
 * 依赖全部本地自托管（public/vendor，无外网 CDN）：
 *   - PDF   → pdfjs-dist 3.11.174（legacy UMD + worker + cmaps/standard_fonts，支持中文扫描件字体映射）
 *   - DOCX  → docx-preview 0.4.1（UMD，依赖全局 JSZip 3.10.1）
 *   - XLSX  → SheetJS 0.18.5（xlsx.full.min.js，支持 xls/xlsx/csv/ods）
 *   - PPTX  → pptx-preview 1.0.7（纯前端渲染，依赖全局 JSZip）
 *   - 图片/文本/Markdown → 原生
 *
 * 设计要点：
 *   1) 按需懒加载：只有真正打开对应格式时才加载对应库，首屏零额外体积（pdf.js worker 约 1.1MB）；
 *   2) 渲染降级：库加载失败或解析异常 → 展示错误原因 + 「下载原文」/「新窗口打开」，绝不白屏；
 *   3) 同源 Cookie 鉴权：fetch 默认携带 HttpOnly Cookie，受保护资源走 /api/doc/raw（P1-16 权限校验）；
 *   4) 渲染隔离：docx/pptx 渲染出的 HTML 限定在沙箱容器内（图片、样式不外溢），不执行脚本。
 */

import { t } from './i18n.js';

const VENDOR = {
  jszip: '/vendor/jszip/jszip.min.js',
  pdf: '/vendor/pdfjs/pdf.min.js',
  docx: '/vendor/docx-preview/docx-preview.min.js',
  xlsx: '/vendor/xlsx/xlsx.full.min.js',
  pptx: '/vendor/pptx-preview/pptx-preview.umd.js',
};

const KIND_BY_EXT = {
  pdf: 'pdf',
  docx: 'docx', doc: 'docx', rtf: 'docx',
  xlsx: 'xlsx', xls: 'xlsx', csv: 'xlsx', ods: 'xlsx',
  pptx: 'pptx', ppt: 'pptx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', log: 'text', yml: 'text', yaml: 'text', xml: 'text', html: 'text',
};

const KIND_LABEL = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PPT', image: '图片', text: '文本', chunks: '分块' };

const scriptState = {}; // src → Promise
function loadScript(src) {
  if (scriptState[src]) return scriptState[src];
  scriptState[src] = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { delete scriptState[src]; reject(new Error('依赖加载失败：' + src)); };
    document.head.appendChild(el);
  });
  return scriptState[src];
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  return m ? m[1] : '';
}

/** 依据文件名/显式 kind 判定渲染类型 */
export function kindOf(name, explicit) {
  if (explicit) return explicit;
  const ext = extOf(name);
  return KIND_BY_EXT[ext] || '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .dv-mask{position:fixed;inset:0;background:rgba(6,8,15,.72);backdrop-filter:blur(6px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px}
  .dv-box{width:min(1180px,96vw);height:min(88vh,900px);background:var(--bg-card,#11141d);border:1px solid var(--border,#252a38);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55)}
  .dv-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border,#252a38);flex-wrap:wrap}
  .dv-title{font-size:14px;font-weight:600;color:var(--text,#e8ecf5);max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dv-badge{font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(129,140,248,.16);color:#a5b4fc;border:1px solid rgba(129,140,248,.3)}
  .dv-meta{font-size:11px;color:var(--text-3,#8b93a7)}
  .dv-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
  .dv-body{flex:1;overflow:auto;background:var(--bg,#0b0e15);padding:0}
  .dv-body.dv-center{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--text-3,#8b93a7);font-size:13px}
  .dv-loading{width:26px;height:26px;border:2px solid rgba(129,140,248,.25);border-top-color:#818cf8;border-radius:50%;animation:dv-spin .8s linear infinite}
  @keyframes dv-spin{to{transform:rotate(360deg)}}
  .dv-err{max-width:560px;text-align:center;line-height:1.7;color:#fca5a5;font-size:13px}
  .dv-pdf-page{display:block;margin:12px auto;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4);border-radius:4px;max-width:100%}
  .dv-pdf-pn{text-align:center;font-size:11px;color:var(--text-3,#8b93a7);padding-bottom:8px}
  .dv-text{padding:20px 24px;font-size:13px;line-height:1.9;color:var(--text,#e8ecf5);white-space:pre-wrap;word-break:break-word}
  .dv-chunk{border-left:3px solid #818cf8;background:rgba(129,140,248,.06);margin:0 20px 12px;padding:10px 14px;border-radius:0 8px 8px 0;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.85;color:var(--text,#e8ecf5)}
  .dv-chunk-no{font-size:11px;color:#a5b4fc;margin-bottom:4px;font-weight:600}
  .dv-img{max-width:100%;max-height:100%;display:block;margin:0 auto;padding:16px}
  .dv-docx{padding:16px;background:#f2f3f5;min-height:100%}
  .dv-docx .docx-wrapper{background:transparent;padding:0;display:flex;flex-direction:column;align-items:center}
  .dv-sheet-tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border,#252a38);position:sticky;top:0;background:var(--bg-card,#11141d);z-index:2;flex-wrap:wrap}
  .dv-sheet-tab{font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--border,#252a38);background:transparent;color:var(--text-2,#a8b0c4);cursor:pointer}
  .dv-sheet-tab.on{background:rgba(129,140,248,.18);border-color:rgba(129,140,248,.5);color:#c7d2fe}
  .dv-sheet-table{width:100%;border-collapse:collapse;font-size:12px;color:var(--text,#e8ecf5);background:var(--bg-card,#11141d)}
  .dv-sheet-table td,.dv-sheet-table th{border:1px solid var(--border,#252a38);padding:4px 8px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
  .dv-sheet-wrap{padding:12px}
  .dv-pptx{padding:16px;display:flex;flex-direction:column;align-items:center;gap:14px}
  .dv-pptx .pptx-preview-slide-wrapper{box-shadow:0 3px 16px rgba(0,0,0,.45);margin-bottom:10px}
  @media (max-width:720px){.dv-box{height:92vh;width:98vw}.dv-title{max-width:40vw}}
  `;
  const el = document.createElement('style');
  el.id = 'dv-style';
  el.textContent = css;
  document.head.appendChild(el);
}

function isRelative(url) { return typeof url === 'string' && url.startsWith('/'); }
function isHttp(url) { return typeof url === 'string' && /^https?:\/\//i.test(url); }
function safeUrl(url) { return isRelative(url) || isHttp(url) ? url : ''; }

async function fetchArrayBuffer(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.msg) msg = j.msg; } catch { }
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.msg) msg = j.msg; } catch { }
    throw new Error(msg);
  }
  return res.text();
}

/* ---------------- 各格式渲染器 ---------------- */

async function renderPdf(buf, body) {
  await loadScript(VENDOR.pdf);
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdf.js 未就绪');
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  const doc = await lib.getDocument({
    data: buf,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise;
  const maxPages = Math.min(doc.numPages, 100); // 防超长文档卡死浏览器
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(320, (body.clientWidth || 900) - 48);
    const scale = Math.min(2, Math.max(0.5, avail / base.width));
    const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
    const canvas = document.createElement('canvas');
    canvas.className = 'dv-pdf-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / (window.devicePixelRatio || 1)) + 'px';
    canvas.style.height = Math.floor(viewport.height / (window.devicePixelRatio || 1)) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    body.appendChild(canvas);
    const pn = document.createElement('div');
    pn.className = 'dv-pdf-pn';
    pn.textContent = `${i} / ${doc.numPages}`;
    body.appendChild(pn);
  }
  if (doc.numPages > maxPages) {
    const tip = document.createElement('div');
    tip.className = 'dv-pdf-pn';
    tip.textContent = t('已渲染前 {n} 页（共 {m} 页），完整内容请下载原文查看').replace('{n}', maxPages).replace('{m}', doc.numPages);
    body.appendChild(tip);
  }
}

async function renderDocx(buf, body) {
  await loadScript(VENDOR.jszip); // docx-preview 的 UMD 构建要求全局 JSZip
  await loadScript(VENDOR.docx);
  const lib = window.docx;
  if (!lib || typeof lib.renderAsync !== 'function') throw new Error('docx-preview 未就绪');
  const host = document.createElement('div');
  host.className = 'dv-docx';
  body.appendChild(host);
  await lib.renderAsync(buf, host, null, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true, ignoreFonts: false });
}

async function renderXlsx(buf, body) {
  await loadScript(VENDOR.xlsx);
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS 未就绪');
  const wb = XLSX.read(buf, { type: 'array' });
  if (!wb.SheetNames.length) throw new Error('工作簿无工作表');
  const tabs = document.createElement('div');
  tabs.className = 'dv-sheet-tabs';
  const wrap = document.createElement('div');
  wrap.className = 'dv-sheet-wrap';
  body.appendChild(tabs);
  body.appendChild(wrap);
  const MAX_ROWS = 2000;
  const draw = (name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
    const shown = rows.slice(0, MAX_ROWS);
    const html = shown.map(r => `<tr>${r.map(c => `<td>${esc(c == null ? '' : c)}</td>`).join('')}</tr>`).join('');
    wrap.innerHTML = `<table class="dv-sheet-table">${html || `<tr><td>${esc(t('（空表）'))}</td></tr>`}</table>`
      + (rows.length > MAX_ROWS ? `<div class="dv-pdf-pn" style="padding-top:8px">${esc(t('仅显示前 {n} 行（共 {m} 行）').replace('{n}', MAX_ROWS).replace('{m}', rows.length))}</div>` : '');
    [...tabs.children].forEach(b => b.classList.toggle('on', b.dataset.name === name));
  };
  wb.SheetNames.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'dv-sheet-tab';
    b.dataset.name = name;
    b.textContent = name;
    b.onclick = () => draw(name);
    tabs.appendChild(b);
    if (i === 0) setTimeout(() => draw(name), 0);
  });
}

async function renderPptx(buf, body) {
  await loadScript(VENDOR.jszip);
  await loadScript(VENDOR.pptx);
  const lib = window.pptxPreview;
  if (!lib || typeof lib.init !== 'function') throw new Error('pptx-preview 未就绪');
  const host = document.createElement('div');
  host.className = 'dv-pptx';
  body.appendChild(host);
  const width = Math.min(960, Math.max(360, (body.clientWidth || 900) - 32));
  const previewer = lib.init(host, { width, height: Math.round(width * 9 / 16) });
  await previewer.preview(buf);
}

/* ---------------- 主入口 ---------------- */

let activeCleanup = null;

/**
 * 打开统一文档查看器
 * @param {object} opts
 *   name        文件名（用于判定格式与标题）
 *   url         原文地址（相对路径或 http/https），与 text/chunks 三选一
 *   text        纯文本全文（知识库分块预览/无法二进制渲染时）
 *   chunks      分块数组（[{content}]），渲染为带序号的段落
 *   kind        强制指定渲染类型：pdf/docx/xlsx/pptx/image/text/chunks
 *   title       自定义标题（默认取 name）
 *   size        文件大小（字节，可选，仅展示）
 *   downloadUrl 下载地址（默认同 url）
 *   note        头部补充说明（如「知识库全文 · 依序拼接」）
 */
export function openViewer(opts = {}) {
  injectStyle();
  const { name, url, text, chunks, kind, title, size, downloadUrl, note } = opts;
  const k = Array.isArray(chunks) && chunks.length ? (kind || 'chunks') : kindOf(name || url, kind);
  const dl = safeUrl(downloadUrl || url || '');

  const mask = document.createElement('div');
  mask.className = 'dv-mask';
  mask.innerHTML = `
    <div class="dv-box" role="dialog" aria-modal="true" aria-label="${esc(title || name || '文档预览')}">
      <div class="dv-head">
        <span class="dv-title" title="${esc(title || name || '')}">${esc(title || name || '文档预览')}</span>
        <span class="dv-badge">${esc(KIND_LABEL[k] || '文件')}</span>
        ${size ? `<span class="dv-meta">${fmtBytes(size)}</span>` : ''}
        ${note ? `<span class="dv-meta">${esc(note)}</span>` : ''}
        <div class="dv-actions">
          ${dl ? `<a class="btn sm" href="${esc(dl)}" download="${esc(name || '')}" style="text-decoration:none">${t('下载原文')}</a>` : ''}
          <button class="btn sm" data-dv-close>${t('关闭')}</button>
        </div>
      </div>
      <div class="dv-body dv-center"><div class="dv-loading"></div><span>${t('正在渲染…')}</span></div>
    </div>`;
  document.body.appendChild(mask);
  document.body.style.overflow = 'hidden';

  const body = mask.querySelector('.dv-body');
  const close = () => {
    try { activeCleanup && activeCleanup(); } catch { }
    activeCleanup = null;
    mask.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  mask.querySelector('[data-dv-close]').onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  activeCleanup = () => { /* 预留：pdf 多页渲染中断 */ };

  const fail = (err) => {
    body.className = 'dv-body dv-center';
    body.innerHTML = `<div class="dv-err">⚠️ ${esc(t('无法渲染该文档'))}<br><span style="color:var(--text-3,#8b93a7);font-size:12px">${esc(err && err.message ? err.message : String(err))}</span></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        ${dl ? `<a class="btn sm" href="${esc(dl)}" download style="text-decoration:none">${t('下载原文查看')}</a>
        <a class="btn sm" href="${esc(dl)}" target="_blank" rel="noopener" style="text-decoration:none">${t('新窗口打开')}</a>` : ''}
      </div>`;
  };

  const run = async () => {
    // 1) 纯文本 / 分块
    if (k === 'chunks') {
      body.className = 'dv-body';
      body.innerHTML = `<div style="height:12px"></div>` + chunks.map((c, i) => `
        <div class="dv-chunk"><div class="dv-chunk-no">#${i + 1}</div>${esc(c.content || c.text || c)}</div>`).join('');
      return;
    }
    if (k === 'text') {
      body.className = 'dv-body';
      const t0 = typeof text === 'string' ? text : '';
      if (t0) { body.innerHTML = `<div class="dv-text">${esc(t0)}</div>`; return; }
      if (!dl) throw new Error('无文本内容');
      const txt = await fetchText(dl);
      body.innerHTML = `<div class="dv-text">${esc(txt)}</div>`;
      return;
    }
    if (k === 'image') {
      body.className = 'dv-body dv-center';
      if (!dl) throw new Error('缺少图片地址');
      body.innerHTML = `<img class="dv-img" src="${esc(dl)}" alt="${esc(name || '')}">`;
      return;
    }
    if (!dl) throw new Error(k ? `缺少文件地址（${KIND_LABEL[k]}）` : '不支持的格式，无法预览');
    // 2) 二进制文档
    body.className = 'dv-body';
    body.innerHTML = '';
    const buf = await fetchArrayBuffer(dl);
    if (k === 'pdf') return renderPdf(buf, body);
    if (k === 'docx') return renderDocx(buf, body);
    if (k === 'xlsx') return renderXlsx(buf, body);
    if (k === 'pptx') return renderPptx(buf, body);
    throw new Error(`暂不支持 .${extOf(name || url)} 格式的在线预览`);
  };

  run().catch(fail);
  return { close };
}

/** 便捷方法：知识库分块 / 全文预览 */
export function openTextPreview(name, content, opts = {}) {
  return openViewer({ name, text: content, kind: 'text', ...opts });
}

/**
 * 把 /uploads/{exports,sandbox}/xxx 映射到受控预览通道（P1-16 权限校验）。
 * 其他路径原样返回（外链/已受控地址）。
 */
export function uploadRawUrl(p) {
  const s = String(p || '');
  const m = s.match(/^\/uploads\/(exports|sandbox)\//);
  if (!m) return s;
  const src = m[1] === 'exports' ? 'export' : m[1]; // 目录名 exports ↔ 来源标识 export
  return `/api/doc/raw?src=${src}&path=${encodeURIComponent(s)}`;
}

// 全局委托：任何元素带 data-doc-preview="<url>"（可选 data-doc-name / data-doc-kind）即可点击预览
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[data-doc-preview]') : null;
  if (!el) return;
  e.preventDefault();
  openViewer({
    url: uploadRawUrl(el.dataset.docPreview),
    name: el.dataset.docName || '',
    kind: el.dataset.docKind || '',
  });
});

export default { openViewer, openTextPreview, kindOf, uploadRawUrl };