/** 连接器广场（D2-4，2026-11-21）：MCP 服务与异构平台的统一目录
 *  - 浏览精选目录（分类/类型/关键词过滤、仅看已安装）
 *  - 一键安装（管理员）：按条目预填端点 + 表单填写凭据 → 落库 + 托管凭据 + 首测连通
 *  - 已安装项：健康态 / 工具数 / 风险摘要 / 连通测试 / 凭据管理
 *  纯 DOM 事件委托，零依赖。 */
import { api, getUser } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const HEALTH_TAG = { ok: 'green', down: 'red', unknown: 'gray', warn: 'orange' };
const TYPE_LABEL = { mcp: 'MCP 服务', platform: '异构平台' };
let S = { items: [], categories: [], category: '全部', type: '', q: '', onlyInstalled: false };

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🔌 ${t('连接器广场')} <span class="sub">${t('MCP 服务与异构平台 · 一键安装 · 凭据托管 · 连通测试')}</span></h2>
    <div class="desc">${t('从精选目录一键接入 MCP 服务器与第三方平台：端点自动预填、凭据加密托管（仅掩码回显）、装完即测连通，工具级风险分级沿用「受信任才免确认」白名单口径。')}</div>
  </div>
  <div class="card" style="padding:14px;margin-bottom:14px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <input class="input" id="cxQ" placeholder="${t('搜索名称 / 说明 / 标签…')}" style="flex:1;min-width:200px">
      <select class="input" id="cxCat" style="width:auto"></select>
      <div id="cxType" style="display:flex;gap:6px">
        <button class="btn sm primary" data-type="">${t('全部')}</button>
        <button class="btn sm" data-type="mcp">${t('MCP 服务')}</button>
        <button class="btn sm" data-type="platform">${t('异构平台')}</button>
      </div>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text-2)"><input type="checkbox" id="cxInstalled"> ${t('仅看已安装')}</label>
    </div>
  </div>
  <div id="cxGrid">${t('加载中…')}</div>`;
  box.querySelector('#cxQ').oninput = (e) => { S.q = e.target.value; renderGrid(); };
  box.querySelector('#cxCat').onchange = (e) => { S.category = e.target.value; renderGrid(); };
  box.querySelector('#cxInstalled').onchange = (e) => { S.onlyInstalled = e.target.checked; renderGrid(); };
  box.querySelector('#cxType').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]'); if (!b) return;
    S.type = b.dataset.type;
    box.querySelectorAll('#cxType [data-type]').forEach(x => x.classList.toggle('primary', x === b));
    renderGrid();
  });
  box.addEventListener('click', onDelegatedClick);
  await loadCatalog();
  return { destroy: () => box.removeEventListener('click', onDelegatedClick) };
}

async function loadCatalog() {
  const grid = document.getElementById('cxGrid');
  if (!grid) return;
  try {
    const r = await api('/mcp/catalog');
    S.items = r.data.items || [];
    S.categories = r.data.categories || [];
    const catSel = document.getElementById('cxCat');
    if (catSel) catSel.innerHTML = ['全部', ...S.categories].map(c => `<option value="${c}">${esc(c)}</option>`).join('');
  } catch (e) {
    grid.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">${esc(e.message)}</div>`;
    return;
  }
  renderGrid();
}

function filtered() {
  return S.items.filter(e => {
    if (S.type && e.type !== S.type) return false;
    if (S.category !== '全部' && e.category !== S.category) return false;
    if (S.onlyInstalled && !e.installed) return false;
    if (S.q) {
      const kw = S.q.toLowerCase();
      if (!((e.name + e.description + (e.tags || []).join('') + e.category).toLowerCase().includes(kw))) return false;
    }
    return true;
  });
}

function renderGrid() {
  const grid = document.getElementById('cxGrid');
  if (!grid) return;
  const isAdmin = (getUser() || {}).role === 'admin';
  const list = filtered();
  if (!list.length) { grid.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-3)">${t('没有匹配的连接器')}</div>`; return; }
  grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">${list.map(e => cardHTML(e, isAdmin)).join('')}</div>`;
}

function cardHTML(e, isAdmin) {
  const health = e.health || { level: 'unknown', label: '' };
  const reqNames = (e.credentials || []).filter(c => c.required).map(c => c.label || c.name);
  const credChips = (e.credentials || []).map(c => `<span class="tag ${c.required ? 'orange' : 'gray'}" style="font-size:10px">${c.secret ? '🔒' : '📝'} ${esc(c.label || c.name)}${c.required ? '*' : ''}</span>`).join(' ') || `<span class="tag gray" style="font-size:10px">${t('无需凭据')}</span>`;
  const risk = e.risk;
  const meta = e.installed
    ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
         <span class="tag ${HEALTH_TAG[health.level] || 'gray'}">${esc(health.label)}</span>
         <span class="tag gray">${e.tool_count || 0} ${t('工具')}</span>
         ${risk ? `<span class="tag green">${t('读')} ${risk.low}</span><span class="tag orange">${t('写')} ${risk.high}</span>` : ''}
         ${(e.credential_names || []).length ? `<span class="tag purple">🔐 ${(e.credential_names || []).length} ${t('凭据')}</span>` : ''}
       </div>`
    : `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${credChips}</div>`;
  const actions = e.installed
    ? `<button class="btn sm" data-test="${e.installed_id}">⚡ ${t('连通测试')}</button>
       ${isAdmin ? `<button class="btn sm" data-creds="${e.installed_id}" data-name="${esc(e.installed_name || e.name)}">🔐 ${t('凭据')}</button>` : ''}
       ${isAdmin ? `<button class="btn sm primary" data-install="${e.id}">↻ ${t('重新安装')}</button>` : ''}`
    : (isAdmin
      ? `<button class="btn sm primary" data-install="${e.id}">＋ ${t('一键安装')}</button>`
      : `<span style="font-size:12px;color:var(--text-3)">${t('需管理员在后台安装')}</span>`);
  return `
  <div class="card" style="padding:16px;display:flex;flex-direction:column">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="display:flex;gap:10px;align-items:center">
        <div style="font-size:26px;line-height:1">${e.icon}</div>
        <div>
          <div style="font-weight:600">${esc(e.name)}</div>
          <div style="margin-top:3px">
            <span class="tag ${e.type === 'mcp' ? 'blue' : 'purple'}" style="font-size:10px">${t(TYPE_LABEL[e.type] || e.type)}</span>
            <span class="tag gray" style="font-size:10px">${esc(e.category)}</span>
          </div>
        </div>
      </div>
      ${e.installed ? `<span class="tag green" style="font-size:10px">✔ ${t('已安装')}</span>` : ''}
    </div>
    <div style="font-size:13px;color:var(--text-2);margin-top:10px;flex:1">${esc(e.description)}</div>
    <div style="font-size:11px;color:var(--text-3);margin-top:8px;word-break:break-all">🔗 ${esc(e.url)}</div>
    ${meta}
    <div style="margin-top:10px;font-size:11px;color:var(--text-3)">⚠ ${esc(e.riskNote)}</div>
    <div class="mk-cardbtn" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${actions}
      ${e.docs ? `<a class="btn sm" href="${esc(e.docs)}" target="_blank" rel="noopener">${t('文档')}</a>` : ''}
    </div>
  </div>`;
}

function onDelegatedClick(e) {
  const el = e.target.closest('[data-install],[data-test],[data-creds]');
  if (!el) return;
  if (el.dataset.install != null) return installModal(el.dataset.install);
  if (el.dataset.test != null) return testConn(el.dataset.test, el);
  if (el.dataset.creds != null) return credsModal(el.dataset.creds, el.dataset.name);
}

/* ---------------- 一键安装 ---------------- */
function installModal(entryId) {
  const e = S.items.find(x => x.id === entryId);
  if (!e) return;
  const credFields = (e.credentials || []).map(c => `
    <label>${esc(c.label || c.name)}${c.required ? '<span class="req">*</span>' : ''}</label>
    <input class="input mono" id="cred_${esc(c.name)}" type="${c.secret ? 'password' : 'text'}" placeholder="${esc(c.hint || '')}" ${c.required ? '' : ''}>`).join('') || `<div style="font-size:12px;color:var(--text-3)">${t('该连接器无需凭据')}</div>`;
  modal({
    title: `＋ ${t('安装连接器')}：${e.name}`,
    body: `<div class="sk-form">
      <label>${t('服务名称')}</label><input class="input" id="cxName" value="${esc(e.installed_name || e.name)}">
      <label>${t('端点 URL')}</label><input class="input mono" id="cxUrl" value="${esc(e.url)}">
      ${credFields}
      <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="cxTrusted" ${e.defaultTrusted ? 'checked' : ''}> ${t('信任该服务（只读类工具在对话「默认权限」下免确认）')}</label>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">🔐 ${t('凭据 AES-256-GCM 加密落库，接口仅掩码回显；安装后将自动测试连通。')}</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:4px">⚠ ${esc(e.riskNote)}</div>
    </div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('安装并测试')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-save]').onclick = async () => {
        const credentials = {};
        for (const c of (e.credentials || [])) {
          const v = mask.querySelector('#cred_' + CSS.escape(c.name)).value.trim();
          if (v) credentials[c.name] = v;
        }
        const body = {
          catalog_id: e.id,
          name: mask.querySelector('#cxName').value.trim(),
          url: mask.querySelector('#cxUrl').value.trim(),
          trusted: mask.querySelector('#cxTrusted').checked ? 1 : 0,
          credentials,
        };
        const btn = mask.querySelector('[data-save]'); btn.disabled = true; btn.textContent = t('安装中…');
        try {
          const r = await api('/mcp/install', { method: 'POST', body });
          close();
          const d = r.data;
          toast(d.tested && d.tested.ok
            ? `${t('已安装')}：${t('连通')} ${d.tested.tool_count} ${t('工具')}（${d.tested.latency_ms}ms）`
            : `${t('已安装，但连通测试未通过：')}${(d.tested && d.tested.error) || ''}`, d.tested && d.tested.ok ? 'ok' : 'err');
          await loadCatalog();
        } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = t('安装并测试'); }
      };
    },
  });
}

/* ---------------- 连通测试 ---------------- */
async function testConn(id, btn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('测试中…'); }
  try {
    const r = await api(`/mcp/${id}/test`, { method: 'POST', body: {} });
    toast(`${t('连通正常')}：${r.data.tool_count} ${t('工具')} · ${r.data.latency_ms}ms（${t('读')} ${r.data.risk.low} / ${t('写')} ${r.data.risk.high}）`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  if (btn) { btn.disabled = false; btn.textContent = old; }
  await loadCatalog();
}

/* ---------------- 凭据管理 ---------------- */
async function credsModal(id, name) {
  let list = [];
  try { list = (await api(`/mcp/${id}/credentials`)).data || []; } catch (e) { return toast(e.message, 'err'); }
  const rows = list.map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line)">
      <b style="font-family:monospace">${esc(c.name)}</b>
      <span class="mono" style="color:var(--text-3)">${esc(c.masked)}</span>
      <span style="flex:1"></span>
      <button class="btn sm" style="color:#dc2626" data-cdel="${esc(c.name)}">${t('删除')}</button>
    </div>`).join('') || `<div style="font-size:13px;color:var(--text-3)">${t('暂无凭据')}</div>`;
  modal({
    title: `🔐 ${t('凭据托管')}：${name || ''}`,
    body: `<div class="sk-form">
      <div style="margin-bottom:10px">${rows}</div>
      <label>${t('凭据名')}</label><input class="input mono" id="cdName" placeholder="api_key">
      <label>${t('凭据值')}</label><input class="input mono" id="cdVal" type="password" placeholder="${t('仅保存，不回显明文')}">
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">${t('名以字母/下划线开头；值加密落库，接口仅回掩码（头3尾2）。')}</div>
    </div>`,
    foot: `<button class="btn" data-close>${t('关闭')}</button><button class="btn primary" data-add>${t('保存凭据')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-close]').onclick = close;
      mask.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => {
        if (!await confirmBox(t('删除凭据「{n}」？').replace('{n}', b.dataset.cdel))) return;
        try { await api(`/mcp/${id}/credentials/${encodeURIComponent(b.dataset.cdel)}`, { method: 'DELETE' }); toast(t('已删除')); close(); credsModal(id, name); }
        catch (e) { toast(e.message, 'err'); }
      });
      mask.querySelector('[data-add]').onclick = async () => {
        const n = mask.querySelector('#cdName').value.trim();
        const v = mask.querySelector('#cdVal').value;
        if (!n || !v) return toast(t('凭据名与值均不能为空'), 'err');
        try { await api(`/mcp/${id}/credentials`, { method: 'POST', body: { name: n, value: v } }); toast(t('已保存')); close(); credsModal(id, name); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
