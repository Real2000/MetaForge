/** 通用 UI 组件：toast / modal / confirm / charts / 分页 / 转义 */
import { t } from './i18n.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 图表主题色（全站浅色唯一外观，P5.23 三态机制已随暗色模式退役） ----------------
 * Canvas 手绘图表无法吃 CSS 变量，统一在此取色 */
export function chartColors() {
  return { grid: '#eef1f6', text: '#9ca3af', dot: '#ffffff' };
}

export function toast(msg, type = 'ok') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = (type === 'ok' ? '✔ ' : type === 'err' ? '✖ ' : 'ℹ ') + esc(msg);
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 2600);
}

/**
 * 弹窗。返回 { close }。
 * opts: { title, body (html or element), foot (html), wide, onMount(el), noFooter }
 */
export function modal(opts) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${opts.wide ? 'wide' : ''}">
      <div class="modal-head"><h4>${esc(opts.title || '')}</h4><span class="modal-close">✕</span></div>
      <div class="modal-body"></div>
      ${opts.noFooter ? '' : '<div class="modal-foot"></div>'}
    </div>`;
  const body = mask.querySelector('.modal-body');
  if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
  const foot = mask.querySelector('.modal-foot');
  if (foot && opts.foot) foot.innerHTML = opts.foot;
  const close = () => { mask.style.opacity = '0'; setTimeout(() => mask.remove(), 120); };
  mask.querySelector('.modal-close').onclick = close;
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  opts.onMount?.(mask, close);
  return { close, mask };
}

/** 确认框，返回 Promise<boolean> */
export function confirmBox(msg, title = '操作确认') {
  return new Promise(resolve => {
    const m = modal({
      title,
      body: `<div style="font-size:14px;line-height:1.7;color:var(--text)">${esc(msg)}</div>`,
      foot: `<button class="btn" data-no>${t('取消')}</button><button class="btn primary" data-yes>${t('确定')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
        mask.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
      },
    });
  });
}

/* ---------------- Canvas 图表（零依赖） ---------------- */
function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth || 500;
  canvas.width = w * dpr; canvas.height = (height || 240) * dpr;
  canvas.style.width = '100%'; canvas.style.height = (height || 240) + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h: height || 240 };
}

export function lineChart(canvas, labels, values, color = '#2563eb') {
  const { ctx, w, h } = setupCanvas(canvas, 240);
  const pad = { l: 40, r: 14, t: 16, b: 28 };
  const max = Math.max(...values, 1), min = 0;
  const X = i => pad.l + (i / Math.max(labels.length - 1, 1)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - ((v - min) / (max - min)) * (h - pad.t - pad.b);
  ctx.clearRect(0, 0, w, h);
  const cc = chartColors();
  // grid
  ctx.strokeStyle = cc.grid; ctx.fillStyle = cc.text; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(v), pad.l - 6, y + 4);
  }
  ctx.textAlign = 'center';
  const step = Math.ceil(labels.length / 7);
  labels.forEach((l, i) => { if (i % step === 0) ctx.fillText(l, X(i), h - 8); });
  // area
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, color + '33'); grad.addColorStop(1, color + '05');
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(X(values.length - 1), h - pad.b); ctx.lineTo(X(0), h - pad.b); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // dots
  values.forEach((v, i) => {
    ctx.beginPath(); ctx.arc(X(i), Y(v), 3, 0, 7); ctx.fillStyle = cc.dot; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  });
}

export function barChart(canvas, labels, values, color = '#2563eb') {
  const { ctx, w, h } = setupCanvas(canvas, 240);
  const pad = { l: 40, r: 14, t: 16, b: 28 };
  const max = Math.max(...values, 1);
  ctx.clearRect(0, 0, w, h);
  const cc = chartColors();
  ctx.strokeStyle = cc.grid; ctx.fillStyle = cc.text; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h - pad.t - pad.b) * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(max * i / 4), pad.l - 6, y + 4);
  }
  const bw = Math.min(36, (w - pad.l - pad.r) / labels.length * 0.55);
  ctx.textAlign = 'center';
  labels.forEach((l, i) => {
    const x = pad.l + (i + 0.5) / labels.length * (w - pad.l - pad.r);
    const bh = (h - pad.t - pad.b) * (values[i] / max);
    const grad = ctx.createLinearGradient(0, h - pad.b - bh, 0, h - pad.b);
    grad.addColorStop(0, color); grad.addColorStop(1, color + '99');
    ctx.fillStyle = grad;
    ctx.beginPath();
    const r = Math.min(5, bw / 2);
    const top = h - pad.b - bh, xx = x - bw / 2;
    ctx.moveTo(xx, h - pad.b); ctx.lineTo(xx, top + r); ctx.arcTo(xx, top, xx + r, top, r);
    ctx.lineTo(xx + bw - r, top); ctx.arcTo(xx + bw, top, xx + bw, top + r, r); ctx.lineTo(xx + bw, h - pad.b); ctx.closePath(); ctx.fill();
    const step = Math.ceil(labels.length / 7);
    if (i % step === 0) { ctx.fillStyle = cc.text; ctx.fillText(l, x, h - 8); }
  });
}

/** 简易分页渲染。返回 {render(list,total)->void} 由调用方管理 */
export function pager(container, { page, size, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / size));
  container.innerHTML = `<span>${t('共')} ${total} ${t('条')}</span>
    <button class="btn sm" ${page <= 1 ? 'disabled' : ''} data-p>${t('上一页')}</button>
    <span>${page} / ${pages}</span>
    <button class="btn sm" ${page >= pages ? 'disabled' : ''} data-n>${t('下一页')}</button>`;
  container.querySelector('[data-p]')?.addEventListener('click', () => page > 1 && onChange(page - 1));
  container.querySelector('[data-n]')?.addEventListener('click', () => page < pages && onChange(page + 1));
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + u[i];
}
export function fmtNum(n) { return (n || 0).toLocaleString('zh-CN'); }
export function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + t(' 天 ') : '') + h + t(' 小时 ') + m + t(' 分');
}
