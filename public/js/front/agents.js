/** 前台-智能体：三级矩阵浏览 + 创建 + 进入对话（P3：受限可见智能体带 🔒 徽标） */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

const AVA = [
  ['#2563eb', '#7c3aed'], ['#059669', '#0d9488'], ['#d97706', '#dc2626'], ['#db2777', '#7c3aed'],
  ['#0891b2', '#2563eb'], ['#65a30d', '#059669'], ['#ea580c', '#d97706'], ['#4f46e5', '#db2777'],
];
const ICONS = ['🤖', '🎯', '📝', '💡', '📊', '🛠️', '🌐', '📚', '✍️', '🧩'];

export async function render(el) {
  let list = [];
  let tab = 'all'; // P3 补充（2026-10-22）：默认「全部」——一览所有类型，避免误以为其他分类的智能体丢失
  let keyword = '';
  let models = [];
  let kbs = [];
  let spaces = [];
  let agents = []; // V2.4 #9 空间过滤：智能体列表数据
  let evals = []; // V2.4 #9：评测数据
  let platforms = []; // V2.4 #9：平台列表数据
  let mcpServers = []; // V2.4 #9：MCP服务列表数据

  el.innerHTML = `
    <div class="page-head">
      <h2>${t('智能体')}</h2>
      <div class="desc">${t('以企业智能体、数字员工、部门 AI 助理为组合的智能体矩阵，融合「企业 - 部门 - 个人」三级轻量化协同体系，打造一站式 AI 办公入口。')}</div>
    </div>
    <div class="card" style="padding:14px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
        <div class="seg" id="typeSeg">
          <button data-t="all">${t('全部')}</button>
          <button data-t="enterprise">${t('企业智能体')}</button>
          <button data-t="digital">${t('数字员工')}</button>
          <button data-t="dept">${t('部门AI助理')}</button>
          <button data-t="other">${t('其他')}</button>
        </div>
        <input class="input" id="kw" placeholder="🔍 ${t('搜索智能体名称')}" style="width:240px">
      </div>
    </div>
    <div class="agent-grid" id="grid" style="margin-top:14px"></div>`;

  const grid = el.querySelector('#grid');
  const seg = el.querySelector('#typeSeg');

  function avaStyle(i) {
    const [a, b] = AVA[i % AVA.length];
    return `background:linear-gradient(135deg,${a},${b})`;
  }
  function typeTag(t2) {
    return { enterprise: `<span class="tag blue">${t('企业')}</span>`, digital: `<span class="tag green">${t('数字员工')}</span>`, dept: `<span class="tag purple">${t('部门助理')}</span>`, other: `<span class="tag gray">${t('其他')}</span>` }[t2] || '';
  }
  function visTag(a) {
    // P3 可见范围徽标：restricted = 🔒 受限（仅指定范围可见）
    if (a.visibility !== 'restricted') return '';
    const tip = [a.visible_depts?.length ? a.visible_depts.join('/') : '', a.visible_members?.length ? `+${a.visible_members.length}${t('名成员')}` : ''].filter(Boolean).join(' ');
    return `<span class="tag orange" title="${t('受限可见')}：${esc(tip || t('指定范围'))}">🔒 ${t('受限')}</span>`;
  }

  function renderGrid() {
    // P3 补充：「全部」视图不过滤类型（其余保持单类过滤），新增智能体入口在全部/数字员工视图均可见
    const shown = list.filter(a => (tab === 'all' || a.type === tab) && (!keyword || a.name.includes(keyword) || (a.description || '').includes(keyword)));
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.t === tab));
    grid.innerHTML = shown.map((a, i) => `
      <div class="agent-card" data-id="${a.id}">
        <div class="a-ava" style="${avaStyle(i)}">${ICONS[a.id % ICONS.length]}</div>
        <div class="a-info">
          <div class="a-name">${esc(a.name)} ${typeTag(a.type)}${visTag(a)}${a.source !== 'self' ? `<span class="tag orange" title="${t('经接入管理同步')}">${t('外部')}</span>` : ''}</div>
          <div class="a-desc">${esc(a.description || t('暂无简介'))}</div>
          <div class="a-meta">
            <span class="tag gray">${esc(a.model || '')}</span>
            ${a.kb_id ? `<span class="tag blue">📚 ${t('知识库')}</span>` : ''}
            <span class="tag gray">${esc(a.category)}</span>
          </div>
        </div>
      </div>`).join('') + `
      ${tab === 'digital' || tab === 'all' ? `<div class="agent-card new-agent-card" id="newAgent">＋ ${t('新增智能体')}</div>` : ''}`;

    grid.querySelectorAll('.agent-card[data-id]').forEach(card => {
      card.onclick = () => { location.hash = '#/chat/' + card.dataset.id; };
    });
    const n = grid.querySelector('#newAgent');
    if (n) n.onclick = () => openCreate();
  }

  async function openCreate() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="tabs" id="cfgTabs" style="margin-bottom:16px">
        <div class="tab active" data-i="0">基本配置</div>
        <div class="tab" data-i="1">AI 模型配置</div>
        <div class="tab" data-i="2">页面配置</div>
      </div>
      <div data-pane="0">
        <div class="form-item"><label>智能体名称<span class="req">*</span></label><input class="input" id="f_name" maxlength="20" placeholder="最多 20 字"></div>
        <div class="form-item"><label>简介</label><textarea class="input" id="f_desc" maxlength="100" placeholder="简单描述你的智能体（100 字内）"></textarea></div>
        <div class="form-item"><label>角色 / 提示词设定<span class="req">*</span>
          <button class="btn" id="aiOptimize" style="padding:2px 10px;font-size:12px">✨ AI 优化</button></label>
          <textarea class="input" id="f_prompt" style="min-height:120px" maxlength="2000" placeholder="定义智能体的身份定位、能力范围、回复规则。也可只写一句简单描述，点击右上角「AI 优化」自动生成结构化提示词"></textarea>
          <div class="hint">支持一键导入示例：<a href="javascript:;" id="impPrompt">公文写作专家提示词</a>　<a href="javascript:;" id="impPrompt2">翻译助手提示词</a></div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>所属分类</label><input class="input" id="f_cat" placeholder="如：办公 / 研发 / 市场" value="办公"></div>
          <div class="form-item"><label>关联知识库</label>
            <select class="input" id="f_kb"><option value="">不关联（仅大模型回复）</option>${kbs.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
            <div class="hint">仅显示有权限的知识库；关联后对话自动检索增强</div>
          </div>
        </div>
      </div>
      <div data-pane="1" style="display:none">
        <div class="form-item"><label>AI 模型<span class="req">*</span></label>
          <select class="input" id="f_model">${models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.real ? '' : '（演示）'}</option>`).join('')}</select>
        </div>
        <div class="form-item"><label>温度 <span class="hint" style="display:inline">（精准 ←→ 创意）</span></label>
          <input type="range" id="f_temp" min="0" max="1" step="0.1" value="0.7" style="width:100%">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3)"><span>精准</span><span>平衡</span><span>创意</span></div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>携带上下文轮数</label><input class="input" id="f_ctx" type="number" min="1" max="50" value="10"></div>
          <div class="form-item"><label>最大回复长度（tokens）</label><input class="input" id="f_max" type="number" min="128" max="8192" value="1024"></div>
        </div>
      </div>
      <div data-pane="2" style="display:none">
        <div class="form-item"><label>开场白</label><textarea class="input" id="f_open" maxlength="200" placeholder="对话开始时智能体主动发送的欢迎语（200 字内）"></textarea></div>
        <div class="form-item"><label>开场预置问题</label>
          <div id="qList"></div>
          <button class="btn sm" id="addQ" style="margin-top:8px">＋ 添加问题</button>
          <div class="hint">展示在对话开场，用户点击即可快速提问</div>
        </div>
      </div>`;

    const m = modal({
      title: '新增智能体（数字员工）',
      body, wide: true,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建</button>',
      onMount(mask, close) {
        const qs = [];
        const qList = mask.querySelector('#qList');
        function addQ(v = '') {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
          row.innerHTML = `<input class="input" placeholder="问题内容" maxlength="60" value="${esc(v)}"><button class="btn sm danger">删除</button>`;
          row.querySelector('button').onclick = () => { row.remove(); };
          qList.appendChild(row);
        }
        mask.querySelector('#addQ').onclick = () => addQ();
        mask.querySelector('#impPrompt').onclick = () => { mask.querySelector('#f_prompt').value = '你是公文写作专家，熟悉企业行政公文的规范格式。根据用户需求撰写通知、请示、会议纪要、通报等文体，格式规范、用语严谨。'; };
        mask.querySelector('#impPrompt2').onclick = () => { mask.querySelector('#f_prompt').value = '你是一位专业、精准的翻译助手。将用户输入的中文翻译成英文，或英文翻译成中文。译文准确传达原意、表达自然流畅。只输出译文本身。'; };
        // AI 优化提示词：简单描述 → 结构化提示词（借鉴 SinguX「优化」按钮）
        mask.querySelector('#aiOptimize').onclick = async () => {
          const btn = mask.querySelector('#aiOptimize');
          const pe = mask.querySelector('#f_prompt');
          if (!pe.value.trim() && !mask.querySelector('#f_name').value.trim()) return toast('请先填写名称或简单描述', 'err');
          btn.disabled = true; btn.textContent = '⏳ 优化中…';
          try {
            const j = await api('/agents/optimize-prompt', { method: 'POST', body: {
              name: mask.querySelector('#f_name').value.trim(),
              description: mask.querySelector('#f_desc').value.trim(),
              prompt: pe.value.trim(),
            } });
            pe.value = j.data.prompt;
            toast('提示词已优化生成');
          } catch (e) { toast(e.message, 'err'); }
          btn.disabled = false; btn.textContent = '✨ AI 优化';
        };

        mask.querySelectorAll('#cfgTabs .tab').forEach(t => {
          t.onclick = () => {
            mask.querySelectorAll('#cfgTabs .tab').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            mask.querySelectorAll('[data-pane]').forEach(p => p.style.display = p.dataset.pane === t.dataset.i ? '' : 'none');
          };
        });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const payload = {
            name: mask.querySelector('#f_name').value.trim(),
            description: mask.querySelector('#f_desc').value.trim(),
            type: 'digital',
            category: mask.querySelector('#f_cat').value.trim() || '未分类',
            prompt: mask.querySelector('#f_prompt').value.trim(),
            kb_id: +mask.querySelector('#f_kb').value || null,
            model: mask.querySelector('#f_model').value,
            temperature: +mask.querySelector('#f_temp').value,
            context_rounds: +mask.querySelector('#f_ctx').value,
            max_reply: +mask.querySelector('#f_max').value,
            opening: mask.querySelector('#f_open').value.trim(),
            opening_questions: [...qList.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean),
            space_id: window.__currentSpace || 0,
          };
          if (!payload.name) return toast('请填写智能体名称', 'err');
          if (!payload.prompt) return toast('请填写提示词设定', 'err');
          try {
            await api('/agents', { method: 'POST', body: payload });
            toast('智能体创建成功（草稿）');
            close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    const sp = window.__currentSpace || '';
    const sq = sp ? `?space_id=${sp}` : '';
    const [ja, js, je, jm, jk, jp, jmcp] = await Promise.all([
      api('/agents' + sq), api('/agents/spaces/list'), api('/agents/evaluations'), api('/chat/models'), api('/knowledge' + sq), api('/platforms'), api('/mcp'),
    ]);
    list = ja.data; spaces = js.data; evals = je.data; models = jm.data; kbs = jk.data; platforms = jp.data; mcpServers = jmcp.data;
    renderCurrent();
  }

  seg.querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderGrid(); });
  el.querySelector('#kw').oninput = e => { keyword = e.target.value.trim(); renderGrid(); };

  await load();
}
