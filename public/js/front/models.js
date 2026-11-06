/** 前台-我的模型（2026-10-20 P3）：用户自有 OpenAI 兼容模型源管理
 *  自带 API Key 接入个人/第三方模型服务——与平台供应商隔离，仅本人可见可用；
 *  对话下拉中自有模型标注「我的」，同名模型优先走自有渠道。
 *  卡片式管理：新增 / 编辑 / 启停 / 删除 / 两级连通测试（列表 + 真实调用）。
 *  P3-2 工具市场扩展（2026-11-06）：同页新增「工具 API Key」区块——
 *  为需要鉴权的内置工具（天气查询/文本翻译）登记自己的 Key，加密落盘掩码回显，
 *  未配置时工具走免费公共源兑底，企业内开箱即用。
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

export async function render(el) {
  let list = [];
  let tkMeta = [];   // P3-2：可配 Key 的工具清单（GET /tool-keys/meta）
  let tkList = [];   // P3-2：已登记的工具 Key（掩码）

  el.innerHTML = `
  <style>
    .um-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:14px}
    .um-card{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;transition:.15s}
    .um-card:hover{box-shadow:0 8px 24px rgba(37,99,235,.08);border-color:#dbeafe}
    .um-name{font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .um-meta{font-size:12px;color:var(--text-3);line-height:1.8;word-break:break-all}
    .um-models{display:flex;flex-wrap:wrap;gap:6px}
    .um-foot{display:flex;gap:8px;border-top:1px dashed #f1f3f7;padding-top:10px;margin-top:auto}
    .um-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}
    .um-form .input,.um-form textarea{width:100%;box-sizing:border-box}
  </style>
  <div class="page-head">
    <h2>我的模型</h2>
    <div class="desc">接入你自己的 OpenAI 兼容模型服务（个人网关、第三方中转等）——对话下拉即可选用，同名模型优先走你的自有渠道；也可为联网工具配置自己的 API Key。Key 仅本人可见，与平台供应商完全隔离。</div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="font-size:12px;color:var(--text-3)">🔒 Key 加密存储于本平台数据库，仅本人可用 · 每人最多 10 个模型源 · 接入后在「对话」下拉中选择使用</div>
    <button class="btn primary" id="addBtn">＋ 接入模型源</button>
  </div>
  <div class="um-grid" id="grid"></div>

  <div style="margin-top:34px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <h3 style="font-size:16px;margin:0">🧰 工具 API Key</h3>
    <span style="font-size:12px;color:var(--text-3)">为联网工具填自己的 Key 获得更稳定/高质量服务；未配置时自动使用免费公共源，不影响开箱即用</span>
    <button class="btn" id="tkAddBtn" style="margin-left:auto">＋ 配置工具 Key</button>
  </div>
  <div class="um-grid" id="tkGrid"></div>`;

  const grid = el.querySelector('#grid');

  function openForm(row) {
    const isNew = !row;
    let models = [];
    try { models = JSON.parse((row?.models) || '[]'); } catch { }
    const m = modal({
      title: isNew ? '＋ 接入模型源' : `编辑：${row.name}`,
      wide: true,
      body: `
        <div class="um-form">
          <label>名称（仅自己可见，如「个人 DeepSeek 中转」）</label>
          <input class="input" id="fName" value="${esc(row?.name || '')}" placeholder="我的模型源" maxlength="30">
          <label>服务地址（OpenAI 兼容 Base URL，平台自动拼接 /chat/completions）</label>
          <input class="input" id="fUrl" value="${esc(row?.base_url || '')}" placeholder="https://api.example.com/v1">
          <label>API Key${row?.key_set ? '（留空保留原 Key）' : ''}</label>
          <input class="input" id="fKey" type="password" value="" placeholder="${row?.key_set ? esc(row.api_key) : 'sk-...'}" autocomplete="new-password">
          <label>模型清单（逗号或空格分隔，如 deepseek-chat, gpt-4o-mini）</label>
          <textarea id="fModels" rows="3" placeholder="deepseek-chat, gpt-4o-mini">${esc(models.join(', '))}</textarea>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="fStatus" ${(!row || row.status) ? 'checked' : ''}> 启用（停用后对话下拉不再出现，但配置保留）</label>
        </div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const body = {
            name: mask.querySelector('#fName').value.trim(),
            base_url: mask.querySelector('#fUrl').value.trim(),
            api_key: mask.querySelector('#fKey').value,
            models: mask.querySelector('#fModels').value,
            status: mask.querySelector('#fStatus').checked ? 1 : 0,
          };
          if (!body.name || !body.base_url) return toast('名称与服务地址必填', 'err');
          try {
            if (isNew) await api('/usermodels', { method: 'POST', body });
            else await api(`/usermodels/${row.id}`, { method: 'PUT', body });
            close(); toast('已保存');
            reload();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderGrid() {
    if (!list.length) {
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">🧩</div>还没有接入自己的模型源<br><span style="font-size:12px">点击右上「接入模型源」，填入 OpenAI 兼容服务地址与 API Key 即可使用</span></div>`;
      return;
    }
    grid.innerHTML = list.map(p => `
      <div class="um-card">
        <div class="um-name">${p.status ? '🟢' : '⚪'} ${esc(p.name)} <span class="tag ${p.status ? 'green' : 'gray'}">${p.status ? '启用中' : '已停用'}</span></div>
        <div class="um-meta">地址：${esc(p.base_url)}<br>Key：${p.key_set ? esc(p.api_key) : '<span style="color:#dc2626">未填写</span>'}</div>
        <div class="um-models">${(() => { try { return JSON.parse(p.models || '[]'); } catch { return []; } })().map(x => `<span class="tag blue">${esc(x)}</span>`).join('') || '<span style="font-size:12px;color:#9ca3af">未配置模型</span>'}</div>
        <div class="um-foot">
          <button class="btn sm" data-test="${p.id}">📡 测试</button>
          <button class="btn sm" data-edit="${p.id}">编辑</button>
          <button class="btn sm" data-toggle="${p.id}">${p.status ? '停用' : '启用'}</button>
          <button class="btn sm" style="color:#dc2626" data-del="${p.id}">删除</button>
        </div>
      </div>`).join('');

    grid.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '测试中…';
      try {
        const j = await api(`/usermodels/${b.dataset.test}/test`, { method: 'POST' });
        toast(j.data.msg, j.data.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      b.disabled = false; b.textContent = '📡 测试';
    });
    grid.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(list.find(x => x.id === +b.dataset.edit)));
    grid.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const p = list.find(x => x.id === +b.dataset.toggle);
      try {
        await api(`/usermodels/${p.id}`, { method: 'PUT', body: { status: p.status ? 0 : 1 } });
        toast(p.status ? '已停用' : '已启用');
        reload();
      } catch (e) { toast(e.message, 'err'); }
    });
    grid.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!(await confirmBox('确定删除该模型源？删除后对话下拉将不再出现其模型。'))) return;
      try {
        await api(`/usermodels/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除'); reload();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function reload() {
    const j = await api('/usermodels');
    list = j.data;
    renderGrid();
  }

  // ===== P3-2 工具 API Key 区块（2026-11-06）=====
  const tkGrid = el.querySelector('#tkGrid');

  function openTkForm(row) {
    const isNew = !row;
    const available = tkMeta.filter(m => isNew ? !m.registered : true); // 新增时只列未登记工具
    const m = modal({
      title: isNew ? '＋ 配置工具 Key' : `编辑：${row.label}`,
      body: `
        <div class="um-form">
          <label>工具</label>
          ${isNew
            ? `<select class="input" id="tkTool">${available.map(t => `<option value="${t.tool_name}">${esc(t.label)}</option>`).join('') || '<option value="">（全部工具均已配置）</option>'}</select>`
            : `<div class="tag blue" style="font-size:13px">${esc(row.label)}</div>`}
          <label>API Key${row?.key_set ? '（留空保留原 Key）' : ''}</label>
          <input class="input" id="tkKey" type="password" value="" placeholder="${row?.key_set ? esc(row.api_key) : '粘贴你的 API Key'}" autocomplete="new-password">
          <label>备注（可选，如「个人免费版」）</label>
          <input class="input" id="tkNote" value="${esc(row?.note || '')}" maxlength="100">
          ${!isNew ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="tkStatus" ${row.status ? 'checked' : ''}> 启用（停用后工具回落免费公共源）</label>` : ''}
          ${isNew && available.length ? `<div class="hint" id="tkHint" style="margin-top:8px">${esc(available[0].hint)} <a href="${available[0].key_url}" target="_blank" rel="noopener">获取 Key →</a></div>` : ''}
        </div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        const sel = mask.querySelector('#tkTool');
        if (sel) sel.onchange = () => {
          const t = available.find(x => x.tool_name === sel.value);
          const hint = mask.querySelector('#tkHint');
          if (t && hint) hint.innerHTML = `${esc(t.hint)} <a href="${t.key_url}" target="_blank" rel="noopener">获取 Key →</a>`;
        };
        mask.querySelector('[data-save]').onclick = async () => {
          const body = {
            api_key: mask.querySelector('#tkKey').value,
            note: mask.querySelector('#tkNote').value.trim(),
          };
          try {
            if (isNew) {
              if (!sel || !sel.value) return toast('没有可新增的工具', 'err');
              await api('/tool-keys', { method: 'POST', body: { tool_name: sel.value, ...body } });
            } else {
              body.status = mask.querySelector('#tkStatus').checked ? 1 : 0;
              await api(`/tool-keys/${row.id}`, { method: 'PUT', body });
            }
            close(); toast('已保存');
            reloadTk();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderTkGrid() {
    // 已登记的 Key 卡片 + 未登记的可配工具占位卡（引导配置）
    const unregistered = tkMeta.filter(m => !m.registered);
    if (!tkList.length && !unregistered.length) {
      tkGrid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">🧰</div>暂无可配置 Key 的工具<br><span style="font-size:12px">平台后续上架新工具时会在此提示</span></div>`;
      return;
    }
    tkGrid.innerHTML = tkList.map(p => `
      <div class="um-card">
        <div class="um-name">${p.status ? '🟢' : '⚪'} ${esc(p.label)} <span class="tag ${p.status ? 'green' : 'gray'}">${p.status ? '启用中' : '已停用'}</span></div>
        <div class="um-meta">Key：${p.key_set ? esc(p.api_key) : '<span style="color:#dc2626">未填写</span>'}${p.note ? '<br>备注：' + esc(p.note) : ''}</div>
        <div class="um-foot">
          <button class="btn sm" data-tk-test="${p.id}">📡 测试</button>
          <button class="btn sm" data-tk-edit="${p.id}">编辑</button>
          <button class="btn sm" data-tk-toggle="${p.id}">${p.status ? '停用' : '启用'}</button>
          <button class="btn sm" style="color:#dc2626" data-tk-del="${p.id}">删除</button>
        </div>
      </div>`).join('') + unregistered.map(m => `
      <div class="um-card" style="border-style:dashed;background:#fafbfc">
        <div class="um-name" style="color:var(--text-3)">➕ ${esc(m.label)}</div>
        <div class="um-meta">${esc(m.provider)}<br>${esc(m.hint)}</div>
        <div class="um-foot">
          <button class="btn sm primary" data-tk-new="${m.tool_name}">配置 Key</button>
          <a class="btn sm" href="${m.key_url}" target="_blank" rel="noopener">获取 Key →</a>
        </div>
      </div>`).join('');

    tkGrid.querySelectorAll('[data-tk-test]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '测试中…';
      try {
        const j = await api(`/tool-keys/${b.dataset.tkTest}/test`, { method: 'POST' });
        toast(j.data.msg, j.data.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      b.disabled = false; b.textContent = '📡 测试';
    });
    tkGrid.querySelectorAll('[data-tk-edit]').forEach(b => b.onclick = () => openTkForm(tkList.find(x => x.id === +b.dataset.tkEdit)));
    tkGrid.querySelectorAll('[data-tk-new]').forEach(b => b.onclick = () => openTkForm(null));
    tkGrid.querySelectorAll('[data-tk-toggle]').forEach(b => b.onclick = async () => {
      const p = tkList.find(x => x.id === +b.dataset.tkToggle);
      try {
        await api(`/tool-keys/${p.id}`, { method: 'PUT', body: { status: p.status ? 0 : 1 } });
        toast(p.status ? '已停用（工具回落免费公共源）' : '已启用');
        reloadTk();
      } catch (e) { toast(e.message, 'err'); }
    });
    tkGrid.querySelectorAll('[data-tk-del]').forEach(b => b.onclick = async () => {
      if (!(await confirmBox('确定删除该工具 Key？删除后工具回落免费公共源。'))) return;
      try {
        await api(`/tool-keys/${b.dataset.tkDel}`, { method: 'DELETE' });
        toast('已删除'); reloadTk();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function reloadTk() {
    const [meta, keys] = await Promise.all([api('/tool-keys/meta'), api('/tool-keys')]);
    tkMeta = meta.data;
    tkList = keys.data;
    renderTkGrid();
  }

  el.querySelector('#tkAddBtn').onclick = () => openTkForm(null);
  await reload();
  await reloadTk();
}
