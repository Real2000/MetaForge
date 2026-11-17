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
    // P0 修复（2026-11-11）：列表接口按既定约定透传 DB TEXT 字段（JSON 字符串，与 studio.js 自行 parse 一致），
    // 须先数组化再取数——字符串 '[]'?.length 为真值直接 .join 会崩（生产实测报
    // a.visible_depts.join is not a function）；兼容存量数据三种形态：数组/JSON 字符串/null 与非法 JSON
    const toArr = v => Array.isArray(v) ? v : (() => { try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })();
    const depts = toArr(a.visible_depts), members = toArr(a.visible_members);
    const tip = [depts.length ? depts.join('/') : '', members.length ? `+${members.length}${t('名成员')}` : ''].filter(Boolean).join(' ');
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
      <!-- A3（2026-11-10）：每个分类下都新增智能体占位卡片（而非仅 digital/all），点击时自动携带当前分类的 type -->
      <div class="agent-card new-agent-card" data-type="${tab === 'all' ? 'digital' : tab}">＋ ${t('新增智能体')}</div>`;

    grid.querySelectorAll('.agent-card[data-id]').forEach(card => {
      card.onclick = () => { location.hash = '#/chat/' + card.dataset.id; };
    });
    const n = grid.querySelector('.new-agent-card');
    if (n) n.onclick = () => openCreate(n.dataset.type || 'digital');
  }

  async function openCreate(type = 'digital') {
    const createType = type; // 创建类型：enterprise / digital / dept / other
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="tabs" id="cfgTabs" style="margin-bottom:16px">
        <div class="tab active" data-i="0">${t('基本配置')}</div>
        <div class="tab" data-i="1">${t('AI 模型配置')}</div>
        <div class="tab" data-i="2">${t('页面配置')}</div>
      </div>
      <div data-pane="0">
        <div class="form-item"><label>${t('智能体名称')}<span class="req">*</span></label><input class="input" id="f_name" maxlength="20" placeholder="${t('最多 20 字')}"></div>
        <div class="form-item"><label>${t('简介')}</label><textarea class="input" id="f_desc" maxlength="100" placeholder="${t('简单描述你的智能体（100 字内）')}"></textarea></div>
        <div class="form-item"><label>${t('角色 / 提示词设定')}<span class="req">*</span>
          <button class="btn" id="aiOptimize" style="padding:2px 10px;font-size:12px">✨ ${t('AI 优化')}</button></label>
          <textarea class="input" id="f_prompt" style="min-height:120px" maxlength="2000" placeholder="${t('定义智能体的身份定位、能力范围、回复规则。也可只写一句简单描述，点击右上角「AI 优化」自动生成结构化提示词')}"></textarea>
          <div class="hint">${t('支持一键导入示例：')}<a href="javascript:;" id="impPrompt">${t('公文写作专家提示词')}</a>　<a href="javascript:;" id="impPrompt2">${t('翻译助手提示词')}</a></div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>${t('所属分类')}</label><input class="input" id="f_cat" placeholder="${t('如：办公 / 研发 / 市场')}" value="${t('办公')}"></div>
          <div class="form-item"><label>${t('关联知识库')}</label>
            <select class="input" id="f_kb"><option value="">${t('不关联（仅大模型回复）')}</option>${kbs.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
            <div class="hint">${t('仅显示有权限的知识库；关联后对话自动检索增强')}</div>
          </div>
        </div>
      </div>
      <div data-pane="1" style="display:none">
        <div class="form-item"><label>${t('AI 模型')}<span class="req">*</span></label>
          <select class="input" id="f_model">${models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.real ? '' : t('（演示）')}</option>`).join('')}</select>
        </div>
        <div class="form-item"><label>${t('温度')} <span class="hint" style="display:inline">${t('（精准 ←→ 创意）')}</span></label>
          <input type="range" id="f_temp" min="0" max="1" step="0.1" value="0.7" style="width:100%">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3)"><span>${t('精准')}</span><span>${t('平衡')}</span><span>${t('创意')}</span></div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>${t('携带上下文轮数')}</label><input class="input" id="f_ctx" type="number" min="1" max="50" value="10"></div>
          <div class="form-item"><label>${t('最大回复长度（tokens）')}</label><input class="input" id="f_max" type="number" min="128" max="8192" value="1024"></div>
        </div>
      </div>
      <div data-pane="2" style="display:none">
        <div class="form-item"><label>${t('开场白')}</label><textarea class="input" id="f_open" maxlength="200" placeholder="${t('对话开始时智能体主动发送的欢迎语（200 字内）')}"></textarea></div>
        <div class="form-item"><label>${t('开场预置问题')}</label>
          <div id="qList"></div>
          <button class="btn sm" id="addQ" style="margin-top:8px">＋ ${t('添加问题')}</button>
          <div class="hint">${t('展示在对话开场，用户点击即可快速提问')}</div>
        </div>
      </div>`;

    const typeName = { enterprise: t('企业智能体'), digital: t('数字员工'), dept: t('部门AI助理'), other: t('其他') };
    const m = modal({
      title: `${t('新增智能体（')} ${typeName[createType] || t('数字员工')}）`,
      body, wide: true,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn" id="aiBtn">✨ ${t('AI 辅导')}</button><button class="btn primary" data-save>${t('创建')}</button>`,
      onMount(mask, close) {
        const qs = [];
        const qList = mask.querySelector('#qList');
        function addQ(v = '') {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
          row.innerHTML = `<input class="input" placeholder="${t('问题内容')}" maxlength="60" value="${esc(v)}"><button class="btn sm danger">${t('删除')}</button>`;
          row.querySelector('button').onclick = () => { row.remove(); };
          qList.appendChild(row);
        }
        mask.querySelector('#addQ').onclick = () => addQ();
        mask.querySelector('#impPrompt').onclick = () => { mask.querySelector('#f_prompt').value = t('你是公文写作专家，熟悉企业行政公文的规范格式。根据用户需求撰写通知、请示、会议纪要、通报等文体，格式规范、用语严谨。'); };
        mask.querySelector('#impPrompt2').onclick = () => { mask.querySelector('#f_prompt').value = t('你是一位专业、精准的翻译助手。将用户输入的中文翻译成英文，或英文翻译成中文。译文准确传达原意、表达自然流畅。只输出译文本身。'); };
        // AI 优化提示词：简单描述 → 结构化提示词（借鉴 SinguX「优化」按钮）
        mask.querySelector('#aiOptimize').onclick = async () => {
          const btn = mask.querySelector('#aiOptimize');
          const pe = mask.querySelector('#f_prompt');
          if (!pe.value.trim() && !mask.querySelector('#f_name').value.trim()) return toast(t('请先填写名称或简单描述'), 'err');
          btn.disabled = true; btn.textContent = `⏳ ${t('优化中…')}`;
          try {
            const j = await api('/agents/optimize-prompt', { method: 'POST', body: {
              name: mask.querySelector('#f_name').value.trim(),
              description: mask.querySelector('#f_desc').value.trim(),
              prompt: pe.value.trim(),
            } });
            pe.value = j.data.prompt;
            toast(t('提示词已优化生成'));
          } catch (e) { toast(e.message, 'err'); }
          btn.disabled = false; btn.textContent = `✨ ${t('AI 优化')}`;
        };

        mask.querySelectorAll('#cfgTabs .tab').forEach(tn => {
          tn.onclick = () => {
            mask.querySelectorAll('#cfgTabs .tab').forEach(x => x.classList.remove('active'));
            tn.classList.add('active');
            mask.querySelectorAll('[data-pane]').forEach(p => p.style.display = p.dataset.pane === tn.dataset.i ? '' : 'none');
          };
        });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const payload = {
            name: mask.querySelector('#f_name').value.trim(),
            description: mask.querySelector('#f_desc').value.trim(),
            type: createType,
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
          if (!payload.name) return toast(t('请填写智能体名称'), 'err');
          if (!payload.prompt) return toast(t('请填写提示词设定'), 'err');
          try {
            await api('/agents', { method: 'POST', body: payload });
            toast(t('智能体创建成功（草稿）'));
            close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };

        // U2-6 Phase 2：AI 辅导入口（打开对话弹窗 → 建议 → 一键创建）
        mask.querySelector('#aiBtn').onclick = async () => {
          openAiAdvisor(close);
        };
      },
    });
  }

  /** U2-6 Phase 2：AI 辅导对话弹窗 + 建议卡片 + 一键创建 */
  function openAiAdvisor(closeCreateModal) {
    const conv = []; // 对话历史
    const rootEl = document.createElement('div');
    rootEl.innerHTML = `
      <div style="display:flex;flex-direction:column;height:420px">
        <div style="flex:1;overflow-y:auto;padding:12px 16px;background:#f8faff;border-radius:10px;margin-bottom:12px" id="aiMsgs">
          <div style="text-align:center;color:#818cf8;font-size:13px;padding:24px 0">💬 ${t('描述你想要的智能体，我来帮您创建！')}</div>
          <div style="text-align:center;color:#9ca3af;font-size:12px;margin-bottom:8px">${t('试试这样说：')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:12px">
            <span class="quick-q" data-hint="${esc('帮我创建一个翻译助手，英汉互译、保留格式')}">🌍 ${t('翻译助手')}</span>
            <span class="quick-q" data-hint="${esc('我想做一个公文写作机器人，帮我写通知、会议纪要')}">📄 ${t('公文写作')}</span>
            <span class="quick-q" data-hint="${esc('创建一个数据分析师，能回答销售数据、做报表')}">📊 ${t('数据分析')}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <textarea class="input" id="aiInput" style="flex:1;min-height:44px;resize:none" placeholder="${t('描述你的需求…')}" rows="2"></textarea>
          <button class="send-btn" id="aiSend" style="padding:0 18px">${t('发送')}</button>
        </div>
      </div>`;
    const m = modal({
      title: `✨ ${t('AI 辅导创建智能体')}`,
      body: rootEl,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" id="aiCreateBtn" style="display:none">🚀 ${t('一键创建')}</button>`,
      wide: true,
      onMount(mask, close) {
        let suggestion = null;
        const msgsEl = mask.querySelector('#aiMsgs');
        const chatInput = mask.querySelector('#aiInput');
        const aiBtn = mask.querySelector('#aiCreateBtn');
        const sendBtn = mask.querySelector('#aiSend');
        [mask.querySelector('#aiInput'), ...mask.querySelectorAll('[data-hint]')].forEach(el => {
          el?.addEventListener('click', () => {
            if (el.dataset.hint) chatInput.value = el.dataset.hint;
            aiClicked();
          });
        });
        async function aiClicked() {
          const text = chatInput.value.trim();
          if (!text) return toast(t('请描述你的需求'), 'err');
          conv.push({ role: 'user', content: text });
          msgsEl.innerHTML += `<div style="margin-bottom:10px;text-align:right"><span style="display:inline-block;background:#2563eb;color:#fff;border-radius:10px;padding:6px 12px;font-size:13px">${escH(text)}</span></div>`;
          chatInput.value = '';
          msgsEl.innerHTML += `<div style="margin-bottom:10px"><div class="typing" style="display:inline-flex;gap:4px"><span></span><span></span><span></span></div></div>`;
          msgsEl.scrollTop = msgsEl.scrollHeight;
          sendBtn.disabled = true; aiBtn.style.display = 'none'; suggestion = null;
          try {
            const j = await api('/agents/generate-suggestion', { method: 'POST', body: { messages: conv } });
            if (j.code !== 0) throw new Error(j.msg);
            msgsEl.querySelector('.typing')?.remove();
            suggestion = j.data.suggestion;
            // 渲染建议卡片
            const c = suggestion;
            msgsEl.innerHTML += `
              <div style="margin-bottom:10px">
                <div style="display:inline-block;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;max-width:100%;font-size:13px;line-height:1.7">
                  <div style="font-weight:600;margin-bottom:4px">📋 ${t('建议方案')}</div>
                  <div><b>${t('名称')}：</b>${escH(c.name)}</div>
                  <div><b>${t('描述')}：</b>${escH(c.description || '')}</div>
                  <div style="margin-top:6px"><b>${t('确认问题')}：</b><br>${(c.confirm_questions || []).map((q, i) => `<span style="display:inline-block;background:#f3f4f6;border-radius:8px;padding:4px 10px;margin:2px">${i+1}. ${escH(q)}</span>`).join('')}</div>
                </div>
              </div>`;
            msgsEl.scrollTop = msgsEl.scrollHeight;
            aiBtn.style.display = ''; // 显示一键创建按钮
          } catch (e) {
            msgsEl.querySelector('.typing')?.remove();
            msgsEl.innerHTML += `<div style="margin-bottom:10px;color:#dc2626;font-size:13px">⚠ ${escH(e.message)}</div>`;
          }
          sendBtn.disabled = false;
        }
        sendBtn.onclick = aiClicked;
        chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiClicked(); } });
        // 一键创建：调用 bulk-create → 关闭弹窗 → 关闭创建弹窗 → 跳转编排页
        aiBtn.onclick = async () => {
          if (!suggestion || !suggestion.name) return;
          aiBtn.disabled = true; aiBtn.textContent = '⏳ ' + t('创建中…');
          try {
            const j = await api('/agents/bulk-create', { method: 'POST', body: { suggestion } });
            if (j.code !== 0) throw new Error(j.msg);
            const agentId = j.data.id;
            toast(t('智能体已创建，正在跳转编排页…'));
            close(); // 关闭辅导弹窗
            if (closeCreateModal) closeCreateModal(); // 关闭创建弹窗
            // 跳转到编排页
            location.hash = '#/admin/studio/' + agentId;
          } catch (e) { toast(e.message, 'err'); }
          aiBtn.disabled = false; aiBtn.textContent = '🚀 ' + t('一键创建');
        };
        mask.querySelector('[data-cancel]').onclick = close;
      },
    });
  }

  async function load() {
    const sp = window.__currentSpace || '';
    const sq = sp ? `?space_id=${sp}` : '';
    const [ja, jm, jk] = await Promise.all([
      api('/agents' + sq), api('/chat/models'), api('/knowledge' + sq),
    ]);
    list = ja.data; models = jm.data; kbs = jk.data;
    renderGrid();
  }

  seg.querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderGrid(); });
  el.querySelector('#kw').oninput = e => { keyword = e.target.value.trim(); renderGrid(); };

  await load();
}
