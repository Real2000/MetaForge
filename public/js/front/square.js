/** 前台-智能体广场（对标 SinguX 广场）：已发布智能体集中展示
 *  分类筛选 / 官方筛选 / 我的收藏 / 搜索 / 卡片统计（用户·会话·收藏）/ 详情侧栏 / 开始使用 / 一键复制创建
 */
import { api, getToken } from '../api.js';
import { esc, toast, modal } from '../ui.js';

const AVA = [
  ['#2563eb', '#7c3aed'], ['#059669', '#0d9488'], ['#d97706', '#dc2626'], ['#db2777', '#7c3aed'],
  ['#0891b2', '#2563eb'], ['#65a30d', '#059669'], ['#ea580c', '#d97706'], ['#4f46e5', '#db2777'],
];
const TYPE_TAG = { enterprise: '<span class="tag blue">企业</span>', digital: '<span class="tag green">数字员工</span>', dept: '<span class="tag purple">部门助理</span>', other: '<span class="tag gray">其他</span>' };

export async function render(el) {
  let list = [], categories = [];
  let cat = '全部', keyword = '', officialOnly = false, mineOnly = false;

  el.innerHTML = `
  <style>
    .sq-head{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
    .sq-chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .sq-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}
    .sq-chip:hover{border-color:#93c5fd;color:#2563eb}
    .sq-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
    .sq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px;margin-top:14px}
    .sq-card{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:16px;cursor:pointer;transition:.15s;position:relative;display:flex;flex-direction:column}
    .sq-card:hover{box-shadow:0 8px 24px rgba(37,99,235,.09);transform:translateY(-2px);border-color:#dbeafe}
    .sq-ava{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;flex-shrink:0}
    .sq-titrow{display:flex;gap:12px;align-items:center}
    .sq-name{font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .sq-desc{font-size:12px;color:var(--text-3);line-height:1.6;margin-top:8px;height:58px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
    .sq-stats{display:flex;gap:14px;font-size:11px;color:#9ca3af;margin-top:10px;align-items:center}
    .sq-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;border-top:1px dashed #f1f3f7;padding-top:10px}
    .sq-star{cursor:pointer;font-size:16px;user-select:none}
    .sq-official{position:absolute;top:10px;right:12px;font-size:10px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;padding:2px 8px;border-radius:999px}
    /* P5.17 工作流模板区块 */
    .wf-sec{display:flex;align-items:center;gap:10px;margin:26px 0 4px;flex-wrap:wrap}
    .wf-sec h3{margin:0;font-size:16px;color:var(--text)}
    .wf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px;margin-top:12px}
    .wf-card{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:16px;display:flex;flex-direction:column;transition:.15s;position:relative}
    .wf-card:hover{box-shadow:0 8px 24px rgba(37,99,235,.09);transform:translateY(-2px);border-color:#dbeafe}
    .wf-scene{font-size:11.5px;color:var(--text-3);line-height:1.65;margin-top:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .wf-builtin{position:absolute;top:10px;right:12px;font-size:10px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;padding:2px 8px;border-radius:999px}
  </style>
  <div class="page-head">
    <h2>智能体广场</h2>
    <div class="desc">已发布的智能体在此集中展示——分类浏览、搜索、收藏、一键复制创建，开启你的探索之旅。</div>
  </div>
  <div class="card" style="padding:14px 18px">
    <div class="sq-head">
      <div class="sq-chips" id="chips"></div>
      <div style="display:flex;gap:10px;align-items:center">
        <input class="input" id="kw" placeholder="🔍 搜索智能体名称或描述" style="width:220px">
      </div>
    </div>
  </div>
  <div class="sq-grid" id="grid"></div>
  <div class="wf-sec"><h3>📐 工作流模板</h3><span style="font-size:12px;color:var(--text-3)">预配置画布流程一键复用——复制后改提示词/知识库即可，比从零画快 10 倍</span></div>
  <div class="wf-grid" id="wfGrid"></div>`;

  const grid = el.querySelector('#grid');
  const chipsBox = el.querySelector('#chips');
  const kwInput = el.querySelector('#kw');

  function avaStyle(id) {
    const [a, b] = AVA[id % AVA.length];
    return `background:linear-gradient(135deg,${a},${b})`;
  }

  function renderChips() {
    const chipDefs = [
      { key: '全部', label: '全部' },
      ...categories.map(c => ({ key: c.category, label: `${c.category} ${c.c}` })),
    ];
    chipsBox.innerHTML = `
      ${chipDefs.map(c => `<span class="sq-chip ${cat === c.key ? 'on' : ''}" data-c="${esc(c.key)}">${esc(c.label)}</span>`).join('')}
      <span style="width:1px;height:18px;background:#e5e7eb;margin:0 2px"></span>
      <span class="sq-chip ${officialOnly ? 'on' : ''}" data-off="1">🏛️ 仅官方</span>
      <span class="sq-chip ${mineOnly ? 'on' : ''}" data-mine="1">⭐ 我的收藏</span>`;
    chipsBox.querySelectorAll('[data-c]').forEach(c => c.onclick = () => { cat = c.dataset.c; reload(); });
    const off = chipsBox.querySelector('[data-off]');
    off.onclick = () => { officialOnly = !officialOnly; reload(); };
    const mine = chipsBox.querySelector('[data-mine]');
    mine.onclick = () => { mineOnly = !mineOnly; reload(); };
  }

  function renderGrid() {
    renderChips();
    const shown = list.filter(a =>
      (cat === '全部' || a.category === cat) &&
      (!keyword || a.name.includes(keyword) || (a.description || '').includes(keyword)));
    if (!shown.length) {
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">🛍️</div>${mineOnly ? '还没有收藏的智能体，去逛逛吧～' : '该分类下暂无智能体'}</div>`;
      return;
    }
    grid.innerHTML = shown.map(a => `
      <div class="sq-card" data-id="${a.id}">
        ${a.is_official ? '<span class="sq-official">官方</span>' : ''}
        <div class="sq-titrow">
          <div class="sq-ava" style="${avaStyle(a.id)}">${esc(a.icon || '🤖')}</div>
          <div style="min-width:0">
            <div class="sq-name">${esc(a.name)} ${TYPE_TAG[a.type] || ''}${a.source !== 'self' ? '<span class="tag orange">外部</span>' : ''}</div>
            <div style="font-size:11px;color:#9ca3af;margin-top:2px">来自 ${esc(a.space_name || a.source_name || '平台')}</div>
          </div>
        </div>
        <div class="sq-desc">${esc(a.description || '暂无简介')}</div>
        <div class="sq-stats">
          <span>👥 ${a.user_count || 0} 用户</span><span>💬 ${a.session_count || 0} 会话</span><span>⭐ ${a.fav_count || 0}</span>
          <span class="tag gray" style="margin-left:auto">${esc(a.category)}</span>
        </div>
        <div class="sq-foot">
          <span class="sq-star" data-fav="${a.id}" title="${a.favorited ? '取消收藏' : '收藏'}">${a.favorited ? '⭐' : '☆'}</span>
          <div style="display:flex;gap:8px">
            ${a.allow_copy ? `<button class="btn sm" data-copy="${a.id}">⧉ 复制</button>` : ''}
            <button class="btn sm primary" data-use="${a.id}">开始使用 →</button>
          </div>
        </div>
      </div>`).join('');

    grid.querySelectorAll('.sq-card').forEach(card => {
      card.onclick = e => {
        if (e.target.closest('[data-fav]') || e.target.closest('[data-use]') || e.target.closest('[data-copy]')) return;
        openDetail(+card.dataset.id);
      };
    });
    grid.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { location.hash = '#/chat/' + b.dataset.use; });
    grid.querySelectorAll('[data-fav]').forEach(s => s.onclick = async e => {
      e.stopPropagation();
      const id = +s.dataset.fav;
      const a = list.find(x => x.id === id);
      try {
        if (a.favorited) {
          await api(`/agents/${id}/favorite`, { method: 'DELETE' });
          a.favorited = false; a.fav_count = Math.max((a.fav_count || 0) - 1, 0);
          toast('已取消收藏');
        } else {
          await api(`/agents/${id}/favorite`, { method: 'POST' });
          a.favorited = true; a.fav_count = (a.fav_count || 0) + 1;
          toast('已收藏，可在「我的收藏」中查看');
        }
        renderGrid();
      } catch (err) { toast(err.message, 'err'); }
    });
    grid.querySelectorAll('[data-copy]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const id = +b.dataset.copy;
      try {
        const j = await api(`/agents/${id}/copy`, { method: 'POST' });
        toast(j.msg || '已复制为草稿');
        if (confirm('已复制为你的草稿智能体，是否前往编排页继续完善？')) {
          location.hash = '#/admin/studio/' + j.data.id;
        }
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  /** 详情侧栏（借鉴 SinguX 详情抽屉：完整介绍 + 统计 + 分享 + 收藏 + 复制 + 使用） */
  async function openDetail(id) {
    const a = list.find(x => x.id === id);
    if (!a) return;
    let questions = [];
    try { questions = JSON.parse(a.opening_questions || '[]'); } catch { }
    modal({
      title: '智能体详情',
      body: `
        <div style="display:flex;gap:14px;align-items:center">
          <div class="sq-ava" style="${avaStyle(a.id)};width:56px;height:56px;font-size:28px">${esc(a.icon || '🤖')}</div>
          <div>
            <div style="font-size:17px;font-weight:700">${esc(a.name)} ${TYPE_TAG[a.type] || ''} ${a.is_official ? '<span class="sq-official" style="position:static">官方</span>' : ''}</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:4px">来自 ${esc(a.space_name || a.source_name || '平台')} · ${esc(a.category)} · 模型 ${esc(a.model || '默认')}</div>
          </div>
        </div>
        <div style="font-size:13px;line-height:1.8;color:var(--text);margin:16px 0;padding:12px;background:#f8faff;border-radius:10px">${esc(a.description || '暂无简介')}</div>
        <div style="display:flex;gap:18px;font-size:12px;color:var(--text-3)">
          <span>👥 ${a.user_count || 0} 位用户使用</span>
          <span>💬 ${a.session_count || 0} 次会话</span>
          <span>⭐ ${a.fav_count || 0} 人收藏</span>
        </div>
        ${a.publish_record ? `<div style="margin-top:12px;font-size:12px;color:var(--text-3)">📝 发布记录：${esc(a.publish_record)}</div>` : ''}
        ${questions.length ? `<div style="margin-top:14px"><div style="font-size:12px;color:var(--text-3);margin-bottom:8px">💡 大家都在问：</div>${questions.map(q => `<span class="tag gray" style="margin:0 6px 6px 0;display:inline-block;padding:4px 10px">${esc(q)}</span>`).join('')}</div>` : ''}`,
      foot: `
        <button class="btn" data-fav>${a.favorited ? '⭐ 取消收藏' : '☆ 收藏'}</button>
        ${a.allow_copy ? '<button class="btn" data-copy>⧉ 复制创建</button>' : ''}
        <button class="btn primary" data-use>开始使用 →</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-use]').onclick = () => { close(); location.hash = '#/chat/' + a.id; };
        mask.querySelector('[data-fav]').onclick = async () => {
          try {
            if (a.favorited) {
              await api(`/agents/${a.id}/favorite`, { method: 'DELETE' });
              a.favorited = false; a.fav_count = Math.max((a.fav_count || 0) - 1, 0);
            } else {
              await api(`/agents/${a.id}/favorite`, { method: 'POST' });
              a.favorited = true; a.fav_count = (a.fav_count || 0) + 1;
            }
            close(); renderGrid();
          } catch (e) { toast(e.message, 'err'); }
        };
        const cp = mask.querySelector('[data-copy]');
        if (cp) cp.onclick = async () => {
          try {
            const j = await api(`/agents/${a.id}/copy`, { method: 'POST' });
            close(); toast(j.msg || '已复制为草稿');
            if (confirm('已复制为你的草稿，前往编排页完善？')) location.hash = '#/admin/studio/' + j.data.id;
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function reload() {
    const j = await api(`/agents/square/list?category=${encodeURIComponent(cat)}&official=${officialOnly ? 1 : 0}&mine=${mineOnly ? 1 : 0}`);
    list = j.data.list; categories = j.data.categories;
    renderGrid();
    renderWfTemplates();
  }

  // ---------- P5.17 工作流模板区块（预配置 workflow JSON 一键复用） ----------
  async function renderWfTemplates() {
    const wfGrid = el.querySelector('#wfGrid');
    if (!wfGrid) return;
    let tpls = [];
    try { tpls = (await api('/wf-templates')).data || []; } catch { wfGrid.innerHTML = ''; return; }
    if (keyword) tpls = tpls.filter(t => (t.name + (t.description || '') + (t.category || '')).includes(keyword));
    if (!tpls.length) {
      wfGrid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">📐</div>暂无工作流模板${keyword ? '（搜索不匹配）' : '——在编排页画布上「💾 存为模板」沉淀你的高频流程'}</div>`;
      return;
    }
    wfGrid.innerHTML = tpls.map(t => `
      <div class="wf-card">
        ${t.builtin ? '<span class="wf-builtin">官方模板</span>' : ''}
        <div class="sq-titrow">
          <div class="sq-ava" style="background:linear-gradient(135deg,#2563eb,#7c3aed)">${esc(t.icon || '🎨')}</div>
          <div style="min-width:0">
            <div class="sq-name">${esc(t.name)}</div>
            <div style="font-size:11px;color:#9ca3af;margin-top:2px">${esc(t.category || '通用')} · ${t.nodes_count || 0} 节点 · 用过 ${t.use_count || 0} 次</div>
          </div>
        </div>
        <div class="sq-desc">${esc(t.description || '预配置工作流模板')}</div>
        <div class="wf-scene" title="${esc(t.scene || '')}">💡 ${esc(t.scene || '复制后按需调整节点参数')}</div>
        <div class="sq-foot">
          <span style="font-size:11px;color:#9ca3af">${esc(t.builtin ? '平台内置' : (t.created_by || ''))}</span>
          <div style="display:flex;gap:8px">
            <button class="btn sm" data-wfdetail="${t.id}">🔍 预览</button>
            <button class="btn sm primary" data-wfuse="${t.id}">⧉ 一键复用</button>
          </div>
        </div>
      </div>`).join('');

    wfGrid.querySelectorAll('[data-wfuse]').forEach(b => b.onclick = async () => {
      const t = tpls.find(x => x.id === +b.dataset.wfuse);
      b.disabled = true;
      try {
        const j = await api(`/wf-templates/${b.dataset.wfuse}/create`, { method: 'POST', body: {} });
        toast(j.msg || '已创建草稿');
        if (confirm(`已从「${t.name}」创建草稿，前往编排页调整？\n\n使用提示：${t.scene || ''}`)) location.hash = '#/admin/studio/' + j.data.id;
        renderWfTemplates();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    });
    wfGrid.querySelectorAll('[data-wfdetail]').forEach(b => b.onclick = async () => {
      const t = tpls.find(x => x.id === +b.dataset.wfdetail);
      const j = await api(`/wf-templates/${b.dataset.wfdetail}/detail`);
      const wf = j.data.workflow || {};
      const nodes = wf.nodes || [];
      const NODE_ICON = { start: '🟦', llm: '🟣', tool: '🟠', agent: '🧠', code: '⌨️', iteration: '🔁', assign: '💱', 'if-else': '🟡', end: '🟥', answer: '💬', classifier: '🎯', aggregator: '🔀' };
      modal({
        title: `${t.icon || '🎨'} ${t.name}`, wide: true,
        body: `<div style="font-size:12.5px;line-height:1.7">
          <div style="color:var(--text-2)">${esc(t.description || '')}</div>
          <div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-radius:8px;font-size:12px;color:#92400e">💡 <b>使用说明：</b>${esc(t.scene || '复制后按需调整节点参数')}</div>
          <div style="margin-top:12px;padding:8px 12px;font-size:11.5px;color:#2563eb;background:#eff6ff;border-radius:8px;line-height:1.9;font-family:ui-monospace,monospace">${nodes.map(n => `${NODE_ICON[n.type] || '⚪'} ${esc((n.data && n.data.title) || n.type)}`).join('　→　')}</div>
          <div style="margin-top:8px;font-size:11px;color:var(--text-3)">${nodes.length} 个节点 · ${(wf.edges || []).length} 条连线${(wf.notes || []).length ? ' · ' + wf.notes.length + ' 张便签' : ''}${wf.flow_type === 'chatflow' ? ' · Chatflow' : ''}</div>
        </div>`,
        foot: `<button class="btn" data-close>关闭</button><button class="btn primary" data-use>⧉ 从此模板创建</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-close]').onclick = close;
          mask.querySelector('[data-use]').onclick = async () => {
            try {
              const j2 = await api(`/wf-templates/${t.id}/create`, { method: 'POST', body: {} });
              close(); toast(j2.msg || '已创建草稿');
              if (confirm('已创建草稿，前往编排页调整？')) location.hash = '#/admin/studio/' + j2.data.id;
              renderWfTemplates();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    });
  }

  kwInput.oninput = () => { keyword = kwInput.value.trim(); renderGrid(); };

  await reload();
}
