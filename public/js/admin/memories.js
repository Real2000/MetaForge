/** 后台-记忆管理（2026-11-12 P1-5）：跨智能体长期记忆统一管理
 *  统计卡片 + 筛选（关键词/类型/智能体/用户）+ 列表（多选合并/单删）+ 导出 JSON/CSV
 *  隔离约束：合并仅限同一智能体+同一用户名下的记忆（前后端双重校验）
 */
import { api, getToken } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const TYPE_META = {
  fact: { ic: '📌', label: () => t('事实'), cls: 'blue' },
  preference: { ic: '⭐', label: () => t('偏好'), cls: 'purple' },
  summary: { ic: '🧾', label: () => t('摘要'), cls: 'orange' },
};

export async function render(el) {
  let data = null;
  let q = '', tp = 'all', agentId = 'all', username = 'all';
  const checked = new Set();

  el.innerHTML = `
  <style>
    .mm-filter{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .mm-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}
    .mm-chip:hover{border-color:#93c5fd;color:#2563eb}
    .mm-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
    .mm-search{padding:6px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;width:220px}
    .mm-sel{padding:6px 10px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;max-width:180px}
    .mm-bar{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#f0f7ff;border-radius:8px;margin-bottom:10px;font-size:12px}
  </style>
  <div class="page-head">
    <h2>${t('记忆管理')}</h2>
    <div class="desc">${t('全平台智能体长期记忆的统一视图——查看/搜索/合并/删除/导出。合并仅限同一智能体、同一用户名下的记忆，防注入归属错乱。')}</div>
  </div>
  <div class="grid-4" id="statCards" style="margin-bottom:14px"></div>
  <div class="card" style="padding:12px 18px;margin-bottom:14px">
    <div class="mm-filter">
      <input class="mm-search" id="qInput" placeholder="${t('搜索记忆内容…')}">
      <button class="btn sm" id="qBtn">${t('搜索')}</button>
      <span style="width:1px;height:16px;background:#e5e7eb"></span>
      <span id="typeChips"></span>
      <select class="mm-sel" id="agentSel"></select>
      <select class="mm-sel" id="userSel"></select>
      <span style="flex:1"></span>
      <button class="btn sm" id="expJson">⬇ JSON</button>
      <button class="btn sm" id="expCsv">⬇ CSV</button>
    </div>
  </div>
  <div id="selBar"></div>
  <div class="card">
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th style="width:36px"><input type="checkbox" id="chkAll"></th><th style="width:120px">${t('智能体')}</th><th style="width:100px">${t('用户')}</th><th style="width:90px">${t('类型')}</th><th>${t('记忆内容')}</th><th style="width:70px">${t('置信度')}</th><th style="width:130px">${t('时间')}</th><th style="width:70px">${t('操作')}</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
  </div>`;

  const tbody = el.querySelector('#tbody');

  function renderStat() {
    const s = data.stat;
    el.querySelector('#statCards').innerHTML = `
      <div class="stat"><div class="s-label">${t('记忆总数')}</div><div class="s-num">${s.total}</div></div>
      <div class="stat"><div class="s-label">📌 ${t('事实')}</div><div class="s-num">${s.fact}</div></div>
      <div class="stat"><div class="s-label">⭐ ${t('偏好')}</div><div class="s-num">${s.preference}</div></div>
      <div class="stat"><div class="s-label">🧾 ${t('摘要')}</div><div class="s-num">${s.summary}</div></div>`;
  }

  function renderFilters() {
    const chips = [{ k: 'all', label: t('全类型') }, ...Object.entries(TYPE_META).map(([k, v]) => ({ k, label: `${v.ic} ${v.label()}` }))];
    el.querySelector('#typeChips').innerHTML = chips.map(c => `<span class="mm-chip ${tp === c.k ? 'on' : ''}" data-tp="${c.k}">${c.label}</span>`).join('');
    el.querySelectorAll('[data-tp]').forEach(c => c.onclick = () => { tp = c.dataset.tp; checked.clear(); renderFilters(); load(); });

    const agents = [...new Map(data.list.filter(r => r.agent_id).map(r => [r.agent_id, r.agent_name])).entries()];
    const users = [...new Set(data.list.map(r => r.username))];
    el.querySelector('#agentSel').innerHTML = `<option value="all">${t('全部智能体')}</option>` +
      agents.map(([id, name]) => `<option value="${id}" ${String(agentId) === String(id) ? 'selected' : ''}>${esc(name || '#' + id)}</option>`).join('');
    el.querySelector('#userSel').innerHTML = `<option value="all">${t('全部用户')}</option>` +
      users.map(u => `<option value="${esc(u)}" ${username === u ? 'selected' : ''}>${esc(u)}</option>`).join('');
    el.querySelector('#agentSel').onchange = e => { agentId = e.target.value; checked.clear(); load(); };
    el.querySelector('#userSel').onchange = e => { username = e.target.value; checked.clear(); load(); };
  }

  function renderSelBar() {
    const bar = el.querySelector('#selBar');
    if (!checked.size) { bar.innerHTML = ''; return; }
    const rows = data.list.filter(r => checked.has(r.id));
    const mergeable = new Set(rows.map(r => `${r.agent_id}|${r.username}`)).size === 1;
    bar.innerHTML = `<div class="mm-bar">✅ ${t('已选 {n} 条').replace('{n}', checked.size)}
      ${mergeable
        ? `<button class="btn sm primary" id="mergeBtn">🔗 ${t('合并选中')}</button>`
        : `<span style="color:#f59e0b">⚠️ ${t('勾选项属于不同智能体或用户，无法合并')}</span>`}
      <span style="flex:1"></span>
      <button class="btn sm" id="clearSel">${t('取消选择')}</button></div>`;
    const mb = bar.querySelector('#mergeBtn');
    if (mb) mb.onclick = () => openMerge(rows);
    bar.querySelector('#clearSel').onclick = () => { checked.clear(); renderSelBar(); renderTable(); el.querySelector('#chkAll').checked = false; };
  }

  function openMerge(rows) {
    const preview = rows.map(r => `· ${r.fact}`).join('\n');
    modal({
      title: `🔗 ${t('合并 {n} 条记忆').replace('{n}', rows.length)}（${esc(rows[0].agent_name || '#' + rows[0].agent_id)} · ${esc(rows[0].username)}）`,
      wide: true,
      body: `
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">${t('被合并的记忆：')}</div>
        <div style="font-size:12.5px;line-height:1.8;color:var(--text);padding:10px 12px;background:#f8faff;border-radius:10px;margin-bottom:12px;white-space:pre-wrap">${esc(preview)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">${t('合并后的内容（将保留为一条，其余删除）：')}</div>
        <textarea id="mmText" rows="4" class="input" style="width:100%;box-sizing:border-box;resize:vertical" placeholder="${t('用一句话概括这些记忆，例如：用户是软件工程师，负责智能体平台开发')}">${esc(rows[0].fact)}</textarea>
        <div style="font-size:12px;color:var(--text-3);margin-top:10px">${t('合并后类型：')}
          <select id="mmType" class="mm-sel" style="margin-left:6px">
            ${Object.entries(TYPE_META).map(([k, v]) => `<option value="${k}">${v.ic} ${v.label()}</option>`).join('')}
          </select></div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('确认合并')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const text = mask.querySelector('#mmText').value.trim();
          const type = mask.querySelector('#mmType').value;
          if (!text) return toast(t('请填写合并后的内容'), 'err');
          try {
            const j = await api('/memories/merge', { method: 'POST', body: { ids: rows.map(r => r.id), text, type } });
            if (j.code !== 0) return toast(j.msg || t('合并失败'), 'err');
            toast(j.msg || t('已合并'));
            checked.clear(); close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderTable() {
    const list = data.list;
    tbody.innerHTML = list.length ? list.map(r => {
      const tm = TYPE_META[r.type] || { ic: '📌', label: () => t('事实'), cls: 'blue' };
      const conf = (r.confidence == null || r.confidence === '') ? '-' : `${Math.round(r.confidence * 100)}%`;
      return `
      <tr>
        <td><input type="checkbox" data-chk="${r.id}" ${checked.has(r.id) ? 'checked' : ''}></td>
        <td style="font-size:12px">${esc(r.agent_name || '#' + r.agent_id)}</td>
        <td style="font-size:12px">${esc(r.username)}</td>
        <td><span class="tag ${tm.cls}">${tm.ic} ${tm.label()}</span></td>
        <td style="font-size:12.5px;line-height:1.6">${esc(r.fact)}</td>
        <td style="font-size:12px;color:var(--text-3)">${conf}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc((r.created_at || '').slice(0, 16))}</td>
        <td><button class="btn sm danger" data-del="${r.id}">${t('删除')}</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="empty">${t('没有符合条件的记忆')}</td></tr>`;

    tbody.querySelectorAll('[data-chk]').forEach(c => c.onchange = () => {
      const id = +c.dataset.chk;
      if (c.checked) checked.add(id); else checked.delete(id);
      renderSelBar();
    });
    tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除这条记忆？该操作不可恢复。'))) return;
      const j = await api(`/memories/${b.dataset.del}`, { method: 'DELETE' });
      toast(j.msg || t('已删除')); checked.delete(+b.dataset.del); load();
    });
    const all = el.querySelector('#chkAll');
    all.checked = list.length > 0 && list.every(r => checked.has(r.id));
    all.onchange = () => {
      list.forEach(r => all.checked ? checked.add(r.id) : checked.delete(r.id));
      renderTable(); renderSelBar();
    };
    renderSelBar();
  }

  async function exportMemories(format) {
    const params = new URLSearchParams({ format });
    if (q) params.set('q', q);
    if (tp !== 'all') params.set('type', tp);
    if (agentId !== 'all') params.set('agent_id', agentId);
    if (username !== 'all') params.set('username', username);
    const res = await fetch(`/api/memories/export?${params.toString()}`, { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!res.ok) return toast(t('导出失败'), 'err');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `memories-${new Date().toISOString().slice(0, 10)}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
    toast(t('已导出当前筛选结果'));
  }

  async function load() {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tp !== 'all') params.set('type', tp);
    if (agentId !== 'all') params.set('agent_id', agentId);
    if (username !== 'all') params.set('username', username);
    data = (await api(`/memories?${params.toString()}`)).data;
    renderStat();
    renderFilters();
    renderTable();
  }

  el.querySelector('#expJson').onclick = () => exportMemories('json');
  el.querySelector('#expCsv').onclick = () => exportMemories('csv');

  el.querySelector('#qBtn').onclick = () => { q = el.querySelector('#qInput').value.trim(); checked.clear(); load(); };
  el.querySelector('#qInput').onkeydown = e => { if (e.key === 'Enter') el.querySelector('#qBtn').click(); };

  await load();
}
