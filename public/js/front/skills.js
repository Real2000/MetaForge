/** 前台-技能（2026-10-20 P3 技能资产化）：可复用的「提示词+工具」组合
 *  浏览（我的 + 他人已发布）/ 创建 / 编辑 / 删除 / 发布开关；
 *  对话输入 @技能名 即调用（技能提示词注入 + 工具并入 function calling）。
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

// 内置工具白名单（与 src-server/lib/tools.js TOOL_DEFS 对齐；技能挂载后对话中可被模型调用）
const TOOL_META = {
  kb_search: { ic: '📚', label: '知识库检索' },
  get_datetime: { ic: '🕐', label: '获取时间' },
  calculator: { ic: '🧮', label: '计算器' },
  image_gen: { ic: '🎨', label: '图片生成' },
};

export async function render(el) {
  let list = [];
  let kw = '';
  let mineOnly = false;

  el.innerHTML = `
  <style>
    .sk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:14px}
    .sk-card{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:16px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;gap:10px}
    .sk-card:hover{box-shadow:0 8px 24px rgba(37,99,235,.09);transform:translateY(-2px);border-color:#dbeafe}
    .sk-titrow{display:flex;gap:12px;align-items:center}
    .sk-ava{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;background:#f0f6ff;flex-shrink:0}
    .sk-name{font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .sk-desc{font-size:12px;color:var(--text-3);line-height:1.6;height:56px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
    .sk-tools{display:flex;flex-wrap:wrap;gap:6px}
    .sk-foot{display:flex;justify-content:space-between;align-items:center;margin-top:auto;border-top:1px dashed #f1f3f7;padding-top:10px}
    .sk-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}
    .sk-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
    .sk-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}
    .sk-form .input,.sk-form textarea{width:100%;box-sizing:border-box}
  </style>
  <div class="page-head">
    <h2>技能</h2>
    <div class="desc">把常用的「提示词 + 工具」沉淀为技能资产——在对话中输入 <b style="color:#2563eb">@技能名</b> 即可调用；发布后他人也能引用。</div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="sk-chip" id="mineChip">⭐ 我的技能</span>
      <input class="input" id="kw" placeholder="🔍 搜索技能名称或描述" style="width:220px">
    </div>
    <button class="btn primary" id="addBtn">＋ 创建技能</button>
  </div>
  <div class="sk-grid" id="grid"></div>`;

  const grid = el.querySelector('#grid');
  const kwInput = el.querySelector('#kw');
  const mineChip = el.querySelector('#mineChip');

  function copyMention(name) {
    const text = '@' + name;
    const done = () => toast(`已复制 ${text}，到对话输入框粘贴即可调用`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => toast(`请在对话中输入 ${text} 调用`));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { toast(`请在对话中输入 ${text} 调用`); }
      ta.remove();
    }
  }

  function openForm(row) {
    const isNew = !row;
    const m = modal({
      title: isNew ? '＋ 创建技能' : `编辑技能：${row.name}`,
      wide: true,
      body: `
        <div class="sk-form">
          <label>技能名称（中文/字母/数字，≤20 字——对话中 @名称 调用，要短要好记）</label>
          <input class="input" id="fName" value="${esc(row?.name || '')}" placeholder="如：周报专家、小红书文案、代码评审" maxlength="20">
          <label>图标（一个 emoji）</label>
          <input class="input" id="fIcon" value="${esc(row?.icon || '✨')}" maxlength="4" style="width:80px">
          <label>描述（技能市场卡片上的一句话介绍）</label>
          <input class="input" id="fDesc" value="${esc(row?.description || '')}" placeholder="把工作要点整理成结构化周报" maxlength="100">
          <label>提示词（核心能力定义，对话 @技能 时注入 system）</label>
          <textarea id="fPrompt" rows="6" placeholder="你是周报生成专家。把用户输入的工作要点整理为「本周完成 / 数据成果 / 问题与风险 / 下周计划」四段式周报……">${esc(row?.prompt || '')}</textarea>
          <label>挂载工具（可选：模型按需调用；不选则为纯提示词技能）</label>
          <div id="fTools" style="display:flex;gap:8px;flex-wrap:wrap">
            ${Object.entries(TOOL_META).map(([id, t]) => `
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);cursor:pointer;border:1px solid #e5e7eb;border-radius:8px;padding:6px 12px">
                <input type="checkbox" value="${id}" ${row?.tools?.includes(id) ? 'checked' : ''}>${t.ic} ${t.label}
              </label>`).join('')}
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:14px">
            <input type="checkbox" id="fStatus" ${(isNew || row.status) ? 'checked' : ''}> 发布（他人可见可 @ 引用；关闭则仅自己可见）
          </label>
        </div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const body = {
            name: mask.querySelector('#fName').value.trim(),
            icon: mask.querySelector('#fIcon').value.trim() || '✨',
            description: mask.querySelector('#fDesc').value.trim(),
            prompt: mask.querySelector('#fPrompt').value.trim(),
            tools: [...mask.querySelectorAll('#fTools input:checked')].map(x => x.value),
            status: mask.querySelector('#fStatus').checked ? 1 : 0,
          };
          if (!body.name) return toast('技能名称不能为空', 'err');
          if (!body.prompt) return toast('提示词不能为空——技能的核心是提示词', 'err');
          try {
            if (isNew) await api('/skillassets', { method: 'POST', body });
            else await api(`/skillassets/${row.id}`, { method: 'PUT', body });
            close(); toast('已保存');
            reload();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openDetail(s) {
    modal({
      title: `${s.icon || '✨'} ${s.name}`,
      body: `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          <span class="tag ${s.mine ? 'blue' : 'gray'}">${s.mine ? '我的技能' : `来自 ${s.owner}`}</span>
          <span class="tag ${s.status ? 'green' : 'gray'}">${s.status ? '已发布' : '私有'}</span>
          ${s.tools?.map(t => `<span class="tag purple">${TOOL_META[t]?.ic || '🔧'} ${TOOL_META[t]?.label || t}</span>`).join('')}
        </div>
        ${s.description ? `<div style="font-size:13px;color:var(--text-3);margin-bottom:12px">${esc(s.description)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">📝 提示词：</div>
        <div style="font-size:13px;line-height:1.8;color:var(--text);padding:12px;background:#f8faff;border-radius:10px;white-space:pre-wrap;max-height:260px;overflow:auto">${esc(s.prompt)}</div>
        <div style="margin-top:14px;padding:10px 12px;background:#fff7e6;border-radius:10px;font-size:12px;color:#92700c">
          💡 在对话输入框输入 <b>@${esc(s.name)}</b>（或点输入区的「✨ 技能」按钮选择）即可调用本技能
        </div>`,
      foot: `<button class="btn" data-copy>⧉ 复制调用词</button>${s.mine ? '<button class="btn" data-edit>编辑</button>' : ''}<button class="btn primary" data-close>关闭</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-copy]').onclick = () => { copyMention(s.name); };
        const ed = mask.querySelector('[data-edit]');
        if (ed) ed.onclick = () => { close(); openForm(s); };
      },
    });
  }

  function renderGrid() {
    const shown = list.filter(s =>
      (!mineOnly || s.mine) &&
      (!kw || s.name.includes(kw) || (s.description || '').includes(kw)));
    mineChip.classList.toggle('on', mineOnly);
    if (!shown.length) {
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">✨</div>${mineOnly ? '你还没有创建技能——点击右上「创建技能」开始' : '暂无技能——创建一个，把常用提示词沉淀为可复用资产'}<br><span style="font-size:12px">创建后对话中 @技能名 即可调用</span></div>`;
      return;
    }
    grid.innerHTML = shown.map(s => `
      <div class="sk-card" data-id="${s.id}">
        <div class="sk-titrow">
          <div class="sk-ava">${esc(s.icon || '✨')}</div>
          <div style="min-width:0">
            <div class="sk-name">${esc(s.name)}
              ${s.mine ? '<span class="tag blue" style="font-size:10px">我的</span>' : `<span class="tag gray" style="font-size:10px">${esc(s.owner)}</span>`}
              ${s.mine && !s.status ? '<span class="tag orange" style="font-size:10px">私有</span>' : ''}
            </div>
            <div style="font-size:11px;color:#9ca3af;margin-top:2px">对话中 @${esc(s.name)} 调用</div>
          </div>
        </div>
        <div class="sk-desc">${esc(s.description || (s.prompt || '').slice(0, 80) || '暂无描述')}</div>
        <div class="sk-tools">${(s.tools || []).map(t => `<span class="tag purple" style="font-size:10px">${TOOL_META[t]?.ic || '🔧'} ${esc(TOOL_META[t]?.label || t)}</span>`).join('') || '<span style="font-size:11px;color:#c0c4cc">纯提示词技能</span>'}</div>
        <div class="sk-foot">
          <button class="btn sm" data-copy="${s.id}">⧉ 复制调用词</button>
          <div style="display:flex;gap:6px">
            ${s.mine ? `<button class="btn sm" data-edit="${s.id}">编辑</button><button class="btn sm" style="color:#dc2626" data-del="${s.id}">删除</button>` : ''}
          </div>
        </div>
      </div>`).join('');

    grid.querySelectorAll('.sk-card').forEach(card => {
      card.onclick = e => {
        if (e.target.closest('[data-copy]') || e.target.closest('[data-edit]') || e.target.closest('[data-del]')) return;
        openDetail(shown.find(s => s.id === +card.dataset.id));
      };
    });
    grid.querySelectorAll('[data-copy]').forEach(b => b.onclick = e => { e.stopPropagation(); copyMention(shown.find(s => s.id === +b.dataset.copy)?.name || ''); });
    grid.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); openForm(list.find(s => s.id === +b.dataset.edit)); });
    grid.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      if (!(await confirmBox('确定删除该技能？'))) return;
      try {
        await api(`/skillassets/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除'); reload();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  async function reload() {
    const j = await api('/skillassets');
    list = j.data;
    renderGrid();
  }

  el.querySelector('#addBtn').onclick = () => openForm(null);
  mineChip.onclick = () => { mineOnly = !mineOnly; renderGrid(); };
  kwInput.oninput = () => { kw = kwInput.value.trim(); renderGrid(); };

  await reload();
}
