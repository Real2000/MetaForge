/** 代码仓库检索（D2-1，2026-11-21）：登记仓库 → 建索引 → 符号+语义混合检索 → 看文件 → 补丁 propose/apply/rollback
 *  - 仓库列表 + 登记表单（服务器本地目录）
 *  - 详情：索引统计 + 检索框（命中通道徽章/高亮词）+ 源码查看 + 补丁与一键回滚
 *  纯 DOM 事件委托，零依赖。 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const CH_TAG = { symbol: 'purple', both: 'green', bm25: 'blue', vec: 'orange', none: 'gray' };
const CH_LABEL = { symbol: '符号', both: '多通道', bm25: '关键词', vec: '语义', none: '—' };
let S = { repos: [], current: null };

export async function render(box) {
  box.innerHTML = `
  <div class="page-head" style="display:flex;justify-content:space-between;align-items:center">
    <h2>🔎 ${t('代码检索')} <span class="sub">${t('仓库索引 · 函数/类切片 · 符号+语义混合检索')}</span></h2>
    <button class="btn primary" id="newRepo">＋ ${t('登记仓库')}</button>
  </div>
  <div id="codeBody">${t('加载中…')}</div>`;
  box.querySelector('#newRepo').onclick = () => repoForm();
  box.addEventListener('click', onDelegatedClick);
  await loadRepos();
  return { destroy: () => box.removeEventListener('click', onDelegatedClick) };
}

async function loadRepos() {
  const body = document.getElementById('codeBody');
  try { const r = await api('/code/repos'); S.repos = r.data || []; }
  catch (e) { body.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">${esc(e.message)}</div>`; return; }
  if (!S.repos.length) {
    body.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-3)">${t('还没有登记代码仓库，点击右上角「登记仓库」开始')}</div>`;
    return;
  }
  body.innerHTML = `<div class="grid-3">${S.repos.map(r => `
    <div class="card" style="padding:18px;cursor:pointer" data-open="${r.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <h3 style="margin:0 0 6px">📦 ${esc(r.name)}</h3>
        <span class="tag ${r.status === 'ready' ? 'green' : r.status === 'error' ? 'red' : 'gray'}">${esc(r.status)}</span>
      </div>
      <div style="font-size:12px;color:var(--text-3);word-break:break-all">${esc(r.root_path)}</div>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px">${r.file_count} ${t('文件')} · ${r.symbol_count} ${t('符号')} · ${r.chunk_count} ${t('块')}</div>
      <div class="mk-cardbtn" style="margin-top:12px">
        <button class="btn sm primary" data-index="${r.id}">⚙ ${t('建索引')}</button>
        <button class="btn sm" data-open="${r.id}">🔍 ${t('检索')}</button>
        <button class="btn sm" style="color:#dc2626" data-del="${r.id}">${t('删除')}</button>
      </div>
    </div>`).join('')}</div>`;
}

function onDelegatedClick(e) {
  const el = e.target.closest('[data-index],[data-open],[data-del],[data-apply],[data-rollback],[data-file],[data-search],[data-propose]');
  if (!el) return;
  if (el.dataset.del != null && !el.dataset.open) { e.stopPropagation(); return removeRepo(el.dataset.del); }
  if (el.dataset.index != null) { e.stopPropagation(); return indexRepo(el.dataset.index); }
  if (el.dataset.open != null) return openRepo(el.dataset.open);
  if (el.dataset.search != null) return doSearch();
  if (el.dataset.file != null) return openFile(el.dataset.file);
  if (el.dataset.propose != null) return proposeFile(el.dataset.propose);
  if (el.dataset.apply != null) return applyPatch(el.dataset.apply);
  if (el.dataset.rollback != null) return rollback(el.dataset.rollback);
}

/* ---------------- 登记 / 删除 / 索引 ---------------- */

function repoForm() {
  modal({
    title: `＋ ${t('登记代码仓库')}`,
    body: `<div class="sk-form">
      <label>${t('仓库名称')}</label><input class="input" id="rpName" placeholder="${t('如：MetaForge 主仓')}">
      <label>${t('服务器本地绝对路径')}</label><input class="input" id="rpPath" placeholder="/Users/you/project">
      <label>${t('描述（可选）')}</label><input class="input" id="rpDesc">
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">${t('仅索引服务器可读的本地目录；自动忽略 .git/node_modules/dist 等与二进制文件。')}</div>
    </div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('登记')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-save]').onclick = async () => {
        const body = { name: mask.querySelector('#rpName').value.trim(), root_path: mask.querySelector('#rpPath').value.trim(), description: mask.querySelector('#rpDesc').value.trim() };
        if (!body.name || !body.root_path) return toast(t('名称与路径不能为空'), 'err');
        try { const r = await api('/code/repos', { method: 'POST', body }); close(); toast(t('已登记')); await loadRepos(); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function removeRepo(id) {
  const ok = await confirmBox(t('删除仓库？将同时清除其索引与补丁记录（不删除磁盘文件）'));
  if (!ok) return;
  try { await api(`/code/repos/${id}`, { method: 'DELETE' }); toast(t('已删除')); await loadRepos(); }
  catch (e) { toast(e.message, 'err'); }
}

async function indexRepo(id) {
  const btn = document.querySelector(`[data-index="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('索引中…'); }
  try {
    const r = await api(`/code/repos/${id}/index`, { method: 'POST', body: {} });
    toast(`${t('索引完成')}：${r.data.file_count} ${t('文件')} / ${r.data.symbol_count} ${t('符号')}（${r.data.duration_ms}ms）`);
  } catch (e) { toast(e.message, 'err'); }
  await loadRepos();
}

/* ---------------- 仓库详情：检索 ---------------- */

async function openRepo(id) {
  const body = document.getElementById('codeBody');
  body.innerHTML = `<div class="card" style="padding:20px">${t('加载中…')}</div>`;
  let r;
  try { r = (await api(`/code/repos/${id}`)).data; } catch (e) { body.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">${esc(e.message)}</div>`; return; }
  S.current = r;
  const langs = (r.langs || []).slice(0, 8).map(l => `<span class="tag gray">${esc(l.lang)} ×${l.files}</span>`).join(' ');
  body.innerHTML = `
    <div class="card" style="padding:20px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h3 style="margin:0">📦 ${esc(r.name)} <span class="tag ${r.status === 'ready' ? 'green' : 'gray'}">${esc(r.status)}</span></h3>
          <div style="font-size:12px;color:var(--text-3);word-break:break-all;margin-top:4px">${esc(r.root_path)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:6px">${r.file_count} ${t('文件')} · ${r.symbol_count} ${t('符号')} · ${r.chunk_count} ${t('块')} ${r.indexed_at ? '· ' + t('索引于') + ' ' + esc(r.indexed_at) : ''}</div>
          <div style="margin-top:8px">${langs}</div>
        </div>
        <div>
          <button class="btn primary" data-index="${r.id}">⚙ ${t('重建索引')}</button>
          <button class="btn" id="codeBack">← ${t('返回列表')}</button>
        </div>
      </div>
    </div>
    <div class="card" style="padding:18px;margin-bottom:14px">
      <div style="display:flex;gap:10px;align-items:center">
        <input class="input" id="codeQ" placeholder="${t('搜索符号 / 函数名 / 代码内容（支持 camelCase 拆词）')}" style="flex:1">
        <button class="btn primary" data-search="1">🔍 ${t('检索')}</button>
      </div>
      <div id="codeResults" style="margin-top:12px"></div>
    </div>
    <div class="card" style="padding:18px">
      <h3 style="margin-top:0">📝 ${t('补丁记录')}</h3>
      <div id="codePatches">${t('加载中…')}</div>
    </div>`;
  document.getElementById('codeBack').onclick = () => loadRepos();
  document.getElementById('codeQ').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  await loadPatches(r.id);
}

async function doSearch() {
  const q = document.getElementById('codeQ').value.trim();
  const out = document.getElementById('codeResults');
  if (!q) return toast(t('请输入查询词'), 'err');
  out.innerHTML = `<div style="color:var(--text-3);font-size:13px">${t('检索中…')}</div>`;
  try {
    const r = await api(`/code/repos/${S.current.id}/search?q=${encodeURIComponent(q)}&top=8`);
    const list = r.data.results || [];
    if (!list.length) { out.innerHTML = `<div style="color:var(--text-3);font-size:13px">${t('无命中')}</div>`; return; }
    out.innerHTML = list.map(x => `
      <div class="card" style="padding:12px;margin-bottom:10px;border:1px solid var(--line)">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="tag ${CH_TAG[x.channels] || 'gray'}">${t(CH_LABEL[x.channels] || x.channels)}</span>
          <span class="tag gray">${esc(x.chunk_kind)}</span>
          ${x.symbol_name ? `<b>${esc(x.symbol_name)}</b>` : ''}
          <span style="font-size:12px;color:var(--text-3)">${esc(x.file_path)}:${x.start_line}-${x.end_line}</span>
          <span style="flex:1"></span>
          <span style="font-size:11px;color:var(--text-3)">score ${x.score}</span>
          <button class="btn sm" data-file="${esc(x.file_path)}">${t('查看文件')}</button>
          <button class="btn sm" data-propose="${esc(x.file_path)}">✎ ${t('提议补丁')}</button>
        </div>
        <pre style="margin:8px 0 0;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:180px;white-space:pre-wrap">${highlight(x.content, x.hit_terms)}</pre>
      </div>`).join('');
  } catch (e) { out.innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`; }
}

function highlight(text, terms) {
  let h = esc(text);
  for (const term of (terms || []).slice(0, 10)) {
    if (!term) continue;
    try { h = h.replace(new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark style="background:#fde68a">$1</mark>'); } catch { }
  }
  return h;
}

async function openFile(path) {
  try {
    const r = await api(`/code/repos/${S.current.id}/file?path=${encodeURIComponent(path)}`);
    modal({
      title: `${r.data.path} · ${r.data.lang}`,
      wide: true,
      body: `<pre style="background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;overflow:auto;font-size:12px;max-height:60vh;white-space:pre">${esc(r.data.content)}</pre>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button><button class="btn primary" data-prop>✎ ${t('提议补丁')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-prop]').onclick = () => { close(); proposeFile(path); };
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 补丁 propose / apply / rollback ---------------- */

function proposeFile(path) {
  modal({
    title: `✎ ${t('提议补丁')}：${path}`,
    wide: true,
    body: `<div class="sk-form">
      <label>${t('待替换内容（find，需与文件当前内容精确匹配）')}</label>
      <textarea id="pfFind" rows="4" placeholder="${t('原文片段')}"></textarea>
      <label>${t('替换为（replace）')}</label>
      <textarea id="pfRepl" rows="4" placeholder="${t('新片段')}"></textarea>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pfAll"> ${t('替换全部匹配')}</label>
      <div id="pfDiff" style="margin-top:10px"></div>
    </div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-prop>${t('生成补丁（dry-run）')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-prop]').onclick = async () => {
        const body = { path, find: mask.querySelector('#pfFind').value, replace: mask.querySelector('#pfRepl').value, all: mask.querySelector('#pfAll').checked };
        if (!body.find) return toast(t('find 不能为空'), 'err');
        try {
          const r = await api(`/code/repos/${S.current.id}/patch/propose`, { method: 'POST', body });
          const d = r.data;
          mask.querySelector('#pfDiff').innerHTML = `
            <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">${t('差异预览')}（+${d.additions} -${d.deletions}，补丁 #${d.patch_id} 已保存待确认）</div>
            <pre style="background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:240px;white-space:pre-wrap">${esc(d.diff)}</pre>
            <button class="btn primary" style="margin-top:10px" data-apply="${d.patch_id}">✓ ${t('确认应用（写前自动备份）')}</button>`;
          const ap = mask.querySelector(`[data-apply="${d.patch_id}"]`);
          if (ap) ap.onclick = async () => { await applyPatch(d.patch_id); close(); };
          await loadPatches(S.current.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function applyPatch(pid) {
  try {
    const r = await api(`/code/repos/${S.current.id}/patch/${pid}/apply`, { method: 'POST', body: {} });
    toast(`${t('补丁已应用')}（备份 #${r.data.backup_id}，可回滚）`);
    if (document.getElementById('codePatches')) await loadPatches(S.current.id);
  } catch (e) { toast(e.message, 'err'); }
}

async function rollback(backupId) {
  const ok = await confirmBox(t('回滚该补丁？将用备份内容覆盖当前文件'));
  if (!ok) return;
  try { await api(`/code/repos/${S.current.id}/patch/rollback`, { method: 'POST', body: { backup_id: Number(backupId) } }); toast(t('已回滚')); await loadPatches(S.current.id); }
  catch (e) { toast(e.message, 'err'); }
}

async function loadPatches(repoId) {
  const box = document.getElementById('codePatches');
  if (!box) return;
  let rows = [];
  try { rows = (await api(`/code/repos/${repoId}/patches`)).data || []; } catch { }
  if (!rows.length) { box.innerHTML = `<div style="font-size:13px;color:var(--text-3)">${t('暂无补丁记录')}</div>`; return; }
  const statTag = { proposed: 'orange', applied: 'green', rolled_back: 'gray' };
  box.innerHTML = rows.map(p => `
    <div style="padding:10px 0;border-bottom:1px dashed var(--line)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="tag ${statTag[p.status] || 'gray'}">${esc(p.status)}</span>
        <b>${esc(p.file_path)}</b>
        <span style="font-size:12px;color:var(--text-3)">+${p.additions} -${p.deletions} · ${esc(p.created_at)}</span>
        <span style="flex:1"></span>
        ${p.status === 'proposed' ? `<button class="btn sm primary" data-apply="${p.id}">✓ ${t('应用')}</button>` : ''}
        ${p.status === 'applied' && p.backup_id ? `<button class="btn sm" style="color:#dc2626" data-rollback="${p.backup_id}">↩ ${t('回滚')}</button>` : ''}
      </div>
    </div>`).join('');
}
