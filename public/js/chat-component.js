/** 可复用聊天组件：会话列表 + 消息流 + SSE 输入框
 * mount(el, opts) opts: { getAgentId(), getAgentBanner() -> {name, desc, icon, opening, openingQuestions} | null, defaultModel, skills?: true }
 */
import { api, sseChat, getToken } from './api.js';
import { esc, toast, modal, confirmBox } from './ui.js';
import { t, getLang } from './i18n.js';
import './viewer.js'; // P1-15 统一文档查看器（注册 data-doc-preview 委托，产物卡预览用）

/** 错误文案兜底翻译（服务端已尽量给中文，仍可能透出英文原文——最后一道防线） */
function friendlyError(msg) {
  const s = String(msg || '');
  const MAP = [
    [/timeout|timed? ?out|ETIMEDOUT/i, t('模型服务响应超时')],
    [/rate ?limit|429/i, t('请求过于频繁，触发限流')],
    [/401|unauthorized|invalid.*key|api ?key/i, t('鉴权失败（API Key 无效或已过期）')],
    [/404|not ?found/i, t('请求的模型或接口不存在')],
    [/50[0234]|upstream|bad ?gateway|service unavailable/i, t('模型服务暂时繁忙')],
    [/fetch failed|network|econn|dns|ENOTFOUND|EAI_AGAIN/i, t('网络连接异常')],
    [/JSON|parse|unexpected token/i, t('响应数据解析失败')],
    [/quota|配额/i, t('Token 配额不足')],
  ];
  for (const [re, zh] of MAP) if (re.test(s)) return zh;
  return s;
}

// 技能定义（豆包式多模态入口）；label/placeholder 经 t() 出文案（模块加载时求值一次，语言切换会整页刷新）
const SKILLS = [
  { id: null, icon: '💬', label: t('对话'), ph: t('输入消息，Enter 发送，Shift+Enter 换行') },
  { id: 'image', icon: '🎨', label: t('图片生成'), ph: t('描述你想生成的画面，如：一张蓝色科技风的产品海报') },
  { id: 'video', icon: '🎬', label: t('视频生成'), ph: t('描述你想生成的视频画面，如：机器人挥手打招呼，镜头拉近') },
  { id: 'tts', icon: '🎙️', label: t('语音生成'), ph: t('输入要合成语音的文本，如：欢迎语或公告内容') },
  { id: 'ppt', icon: '📊', label: t('PPT生成'), ph: t('输入 PPT 主题，如：智能体平台产品介绍') },
];
// P4 模型隔离（2026-10-22）：每种创作模式只显示对应类型的模型——对话→chat、图片→image、视频→video、语音→tts、PPT→chat（大纲由对话模型生成）
const SKILL_MODEL_TYPE = { chat: 'chat', image: 'image', video: 'video', tts: 'tts', ppt: 'chat' };

export function mountChat(el, opts) {
  let sessions = [];
  let currentSession = null;
  let messages = [];
  let currentBranch = 'main'; // P1-6 分支回放：当前查看的分支（main=活跃线，br-*=归档线）
  let branches = [];        // P1-6：归档分支列表
  let pendingCk = null;     // P1-6：aborted 检查点（续跑卡片数据源）
  let streaming = false;
  let models = [];
  let currentModel = '';
  let currentAbort = null; // P5.29 停止生成：当前流的中断句柄（生成中点击停止按钮调用，见 sseChat onAborter）
  let pendingKbHits = null;
  let pendingTools = [];
  let currentSkill = null; // null=对话 | image | video | ppt
  let pendingSuggestions = []; // 本轮追问建议
  let lastFailedInput = null; // 上一次发送失败的输入（错误卡片重试用）
  let pendingAttach = []; // P5.14 文件一等变量：待发送附件 [{id,name}]（📎 上传 → 随下一条消息发送）

  // P5.14 📎 附件上传：选择 → base64 → POST /api/files → 徽标展示（随下一条消息发送；纯附件消息可发）
  // TDZ 修复（2026-10-26）：原为立即执行 IIFE，但引用的 $ 在下方才声明且 el.innerHTML 尚未渲染——
  // ReferenceError 直接中断 mountChat（首页对话区整体崩溃）；改为函数声明 + 在 $ 声明与 DOM 渲染后调用
  function setupAttach() {
    const btn = $('#attachBtn');
    if (!btn) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md';
    inp.multiple = true;
    inp.style.display = 'none';
    el.appendChild(inp);
    const badge = document.createElement('span');
    badge.id = 'attachBadge';
    badge.style.cssText = 'font-size:11.5px;color:#2563eb;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer';
    badge.title = t('点击清空附件');
    badge.onclick = () => { pendingAttach = []; renderAttachBadge(); };
    btn.parentElement.appendChild(badge);
    const renderAttachBadge = () => {
      badge.textContent = pendingAttach.length ? `📎 ${pendingAttach.map(a => a.name).join('、')}` : '';
      badge.style.display = pendingAttach.length ? 'inline-block' : 'none';
    };
    btn.onclick = () => inp.click();
    inp.onchange = async () => {
      const files = [...inp.files].slice(0, 10);
      if (!files.length) return;
      btn.disabled = true;
      badge.textContent = '⏳ ' + t('上传解析中…');
      badge.style.display = 'inline-block';
      try {
        for (const f of files) {
          const b64 = await new Promise((ok, err) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1] || ''); rd.onerror = err; rd.readAsDataURL(f); });
          const r = await fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }, // P2-3：Cookie 化后同源自动鉴权
            body: JSON.stringify({ name: f.name, file_b64: b64, source: 'chat' }),
          });
          const j = await r.json();
          if (j.code !== 0) throw new Error(j.msg || '上传失败');
          pendingAttach.push({ id: j.data.id, name: f.name });
        }
        renderAttachBadge();
        toast(t('附件已上传，将随下一条消息发送') + '（' + pendingAttach.length + '）', 'ok');
      } catch (e) {
        toast('❌ ' + (e.message || t('附件上传失败')), 'err');
        renderAttachBadge();
      } finally {
        btn.disabled = false;
        inp.value = '';
      }
    };
    window.__renderAttachBadge = renderAttachBadge; // doSend 发送后清空回显
  }

  el.innerHTML = `
    <div class="chat-layout">
      <aside class="chat-side">
        <button class="btn primary new-chat" id="newChatBtn">＋ ${t('新建会话')}</button>
        <input id="sessSearch" placeholder="🔍 ${t('搜索历史会话（标题/内容）')}" style="width:100%;box-sizing:border-box;margin:8px 0 2px;padding:6px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:12px;background:var(--card,#fff);color:var(--text);outline:none">
        <div class="sec-title">${t('历史会话')}</div>
        <div class="sess-list" id="sessList"></div>
      </aside>
      <div class="chat-main">
        <div style="display:flex;justify-content:flex-end;padding:0 2px 8px"><div id="quotaStrip" style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:8px;background:var(--surface-2,#f8faff);border:1px solid var(--border,#eef0f4);border-radius:999px;padding:4px 12px"></div></div>
        <div id="quotaBanner"></div>
        <div id="agentBanner"></div>
        <div class="chat-scroll" id="chatScroll"><div class="chat-inner" id="chatInner"></div></div>
        <div class="chat-input-bar">
          ${opts.skills ? `
          <div class="skill-bar" id="skillBar">
            ${SKILLS.map(s => `<button class="skill-btn ${currentSkill === s.id ? 'active' : ''}" data-skill="${s.id ?? ''}" title="${s.label}">${s.icon}<span>${s.label}</span></button>`).join('')}
          </div>` : ''}
          <div class="chat-input-box">
            <textarea id="chatInput" placeholder="${t('输入消息，Enter 发送，Shift+Enter 换行')}"></textarea>
            <div class="chat-tools">
              <div class="left">
                <button class="btn sm" id="voiceBtn" title="${t('语音输入：点击开始，再点结束（浏览器语音识别）')}" style="padding:4px 10px">🎤</button>
                <button class="btn sm" id="voiceRtBtn" title="${t('实时语音对话：连接平台语音通道，边听边说，可随时打断')}" style="padding:4px 10px">🎧</button>
                <button class="btn sm" id="attachBtn" title="${t('附件：上传文件（PDF/DOCX/XLSX/TXT/MD ≤8MB），Excel 自动转表格文本分析')}" style="padding:4px 10px">📎</button>
                <button class="btn sm" id="atSkillBtn" title="${t('调用技能：在消息中插入 @技能名')}" style="padding:4px 10px">✨ ${t('技能')}</button>
                <button class="btn sm" id="linkBtn" title="${t('应用链接：插入 URL 引用（智能体可直接抓取网页内容分析）')}" style="padding:4px 10px">🔗 ${t('链接')}</button>
                <button class="btn sm" id="expertBtn" title="${t('指定专家：插入 @智能体名，以其专业身份与提示词回答')}" style="padding:4px 10px">🎓 ${t('专家')}</button>
                <select class="model-select" id="modelSelect"></select>
                <select id="permSelect" title="${t('权限：默认需确认高危工具，全自动直接执行')}" style="padding:5px 8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:12px;background:var(--card,#fff);color:var(--text-2);outline:none;cursor:pointer">
                  <option value="default">${t('🛡 默认权限')}</option>
                  <option value="auto">${t('⚡ 全自动执行')}</option>
                </select>
                <span style="font-size:12px;color:var(--text-3)" id="chatStatus"></span>
              </div>
              <button class="send-btn" id="sendBtn">${t('发送 ➤')}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button id="chatHelpBtn" title="${t('帮助：常见问题与快捷提问')}" style="position:fixed;right:18px;bottom:185px;width:40px;height:40px;border-radius:50%;border:1px solid var(--border,#dbeafe);background:var(--card,#fff);color:var(--text);box-shadow:0 4px 14px rgba(37,99,235,.18);cursor:pointer;font-size:17px;z-index:40;transition:.15s">❓</button>`;

  // 技能按钮绑定：切换技能 → placeholder 变化 + 高亮
  const skillBtns = el.querySelectorAll('.skill-btn');
  skillBtns.forEach(b => b.onclick = () => {
    const id = b.dataset.skill || null;
    currentSkill = id;
    skillBtns.forEach(x => x.classList.toggle('active', x === b));
    const sk = SKILLS.find(s => s.id === id);
    $('#chatInput').placeholder = sk ? sk.ph : SKILLS[0].ph;
    $('#chatInput').focus();
    renderModelSelect(); // P4：切换模式时重渲模型下拉（按类型隔离）
  });

  const $ = sel => el.querySelector(sel);
  const scrollBox = $('#chatScroll');
  setupAttach(); // P5.14：📎 附件上传绑定（需在 $ 声明与 el.innerHTML 渲染之后执行）

  // 🎤 语音输入（2026-10-22 P3）：浏览器 Web Speech API（Chrome 内置免费识别）；点击开始、再点结束，识别文本追加到输入框
  (function setupVoiceInput() {
    const btn = $('#voiceBtn');
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      btn.title = t('当前浏览器不支持语音输入（建议使用 Chrome）');
      btn.style.opacity = '.45';
      btn.style.cursor = 'not-allowed';
      return;
    }
    let rec = null, listening = false;
    const stop = () => {
      listening = false;
      btn.textContent = '🎤';
      btn.style.background = '';
      btn.style.borderColor = '';
      $('#chatInput').focus();
    };
    btn.onclick = () => {
      if (listening) { try { rec.stop(); } catch { } return; }
      try {
        rec = new SR();
        rec.lang = getLang() === 'en' ? 'en-US' : 'zh-CN';
        rec.interimResults = true;
        rec.continuous = false;
        const base = $('#chatInput').value;
        rec.onresult = (e) => {
          let txt = '';
          for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
          const merged = (base ? base + ' ' : '') + txt.trim();
          if (merged) $('#chatInput').value = merged;
        };
        rec.onerror = stop;
        rec.onend = stop;
        rec.start();
        listening = true;
        btn.textContent = '⏺';
        btn.style.background = '#fee2e2';
        btn.style.borderColor = '#ef4444';
      } catch { stop(); }
    };
  })();

  // 🎧 实时语音对话（2026-11-19 U0-2 P3）：连接平台 /api/voice-ws，边听边说 + 打断（barge-in）
  (function setupRealtimeVoice() {
    const btn = $('#voiceRtBtn');
    if (!btn) return;
    const VR = window.VoiceRealtime;
    if (!VR || !VR.isSupported()) {
      btn.disabled = true;
      btn.title = t('当前浏览器不支持实时语音（需 Chrome/Edge，且允许麦克风）');
      btn.style.opacity = '.45';
      return;
    }
    let session = null, panel = null, replyAcc = '';

    const closePanel = () => { if (panel) { panel.remove(); panel = null; } };
    const ensurePanel = () => {
      if (panel) return panel;
      panel = document.createElement('div');
      panel.className = 'voice-rt-panel';
      panel.innerHTML = `
        <div class="vrt-head"><span class="vrt-dot" id="vrtDot" data-state="idle"></span><span id="vrtState">${t('正在连接…')}</span></div>
        <div class="vrt-sub" id="vrtSub"></div>
        <div class="vrt-actions">
          <button class="btn sm" id="vrtBarge">${t('打断')}</button>
          <button class="btn sm" id="vrtStop">${t('结束')}</button>
        </div>`;
      document.body.appendChild(panel);
      panel.querySelector('#vrtBarge').onclick = () => { if (session) session.interrupt(); };
      panel.querySelector('#vrtStop').onclick = () => stopAll();
      return panel;
    };

    const stopAll = () => {
      try { if (session) session.stop(); } catch { }
      session = null; replyAcc = '';
      closePanel();
      btn.textContent = '🎧';
      btn.style.background = ''; btn.style.borderColor = '';
    };

    btn.onclick = async () => {
      if (session) { stopAll(); return; }
      const p = ensurePanel();
      const sub = p.querySelector('#vrtSub');
      try {
        session = VR.createSession({
          onState: (s) => {
            const map = { idle: t('已结束'), listening: t('聆听中…'), thinking: t('思考中…'), speaking: t('播报中…（可打断）') };
            const st = p.querySelector('#vrtState'); if (st) st.textContent = map[s] || s;
            const dot = p.querySelector('#vrtDot'); if (dot) dot.dataset.state = s;
          },
          onFinal: (text) => { replyAcc = ''; sub.textContent = '🗣 ' + text; },
          onPartial: (text) => { sub.textContent = '🗣 ' + text; },
          onReply: (text) => { replyAcc += text; sub.textContent = '🤖 ' + replyAcc; },
          onDone: () => { replyAcc = ''; },
          onError: (msg) => { sub.textContent = '⚠ ' + msg; },
        });
        await session.start();
        btn.textContent = '⏹';
        btn.style.background = '#fee2e2'; btn.style.borderColor = '#ef4444';
      } catch (e) {
        stopAll();
        toast('❌ ' + (e.message || t('实时语音启动失败')), 'err');
      }
    };
  })();

  function scrollBottom() { scrollBox.scrollTop = scrollBox.scrollHeight; }
  function renderBanner() {
    // hideTopBanner：空状态欢迎区已展示名称/描述，顶部横幅不再重复渲染
    if (opts.hideTopBanner) { $('#agentBanner').innerHTML = ''; return; }
    const b = opts.getAgentBanner?.();
    $('#agentBanner').innerHTML = b ? `
      <div class="agent-banner">
        <div class="big-ava" style="background:linear-gradient(135deg,${b.color1 || '#2563eb'},${b.color2 || '#7c3aed'})">${b.icon || '🤖'}</div>
        <div><h3>${esc(b.name)}</h3><p>${esc(b.desc || '')}</p></div>
      </div>` : '';
  }

  // 用户提示词预填（借鉴 SinguX：编排页配置的预置指令，新会话时自动填入输入框，可编辑后发送）
  function fillUserPrompt() {
    const up = opts.getUserPrompt?.();
    const inp = $('#chatInput');
    if (up && inp && !inp.value) { inp.value = up; inp.focus(); }
  }

  function renderSessions() {
    $('#sessList').innerHTML = sessions.map(s => `
      <div class="sess-item ${currentSession?.id === s.id ? 'active' : ''}" data-id="${s.id}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</span>
        <span class="del" data-del="${s.id}">✕</span>
      </div>`).join('') || `<div style="padding:14px;color:var(--text-3);font-size:12px">${t('暂无历史会话')}</div>`;
    $('#sessList').querySelectorAll('.sess-item').forEach(item => {
      item.onclick = e => {
        if (e.target.dataset.del) return;
        openSession(+item.dataset.id);
      };
    });
    $('#sessList').querySelectorAll('[data-del]').forEach(d => {
      d.onclick = async e => {
        e.stopPropagation();
        if (!confirm(t('删除该会话？'))) return;
        await api('/chat/sessions/' + d.dataset.del, { method: 'DELETE' });
        if (currentSession?.id === +d.dataset.del) { currentSession = null; messages = []; renderMessages(); }
        loadSessions();
      };
    });
  }

  function renderMessages() {
    const inner = $('#chatInner');
    if (!messages.length) {
      const b = opts.getAgentBanner?.();
      const qs = b?.openingQuestions?.length ? b.openingQuestions : [t('帮我总结一下平台功能'), t('写一份会议通知'), t('把这段话翻译成英文：你好世界')];
      const openingHtml = b?.opening ? `
        <div class="msg bot">
          <div class="m-avatar">AI</div>
          <div class="m-body">
            <div class="m-name">${esc(b?.name || 'AI 助手')}</div>
            <div class="m-bubble">${esc(b.opening)}</div>
          </div>
        </div>` : '';
      inner.innerHTML = `
        <div class="welcome-hero">
          <div style="font-size:44px;margin-bottom:12px">${b?.icon || '👋'}</div>
          <h2>${esc(b ? b.name : t('有什么可以帮您？'))}</h2>
          <p>${esc(b?.desc || t('我是智能体平台 AI 助手，支持知识库检索增强与多模型切换'))}</p>
        </div>
        ${openingHtml}
        <div class="quick-qs" style="margin-bottom:22px">${qs.map((q, i) => `<span class="quick-q" data-q="${i}">${esc(q)}</span>`).join('')}</div>`;
      inner.querySelectorAll('.quick-q').forEach(q => {
        q.onclick = () => { $('#chatInput').value = qs[+q.dataset.q]; doSend(); };
      });
      return;
    }
    inner.innerHTML = messages.map(m => {
      const isArch = (m.branch || 'main') !== 'main';
      const nameTag = (isArch ? ' <span class="tag gray" style="font-size:10px">' + t('归档') + '</span>' : '')
        + (m.resumed ? ' <span class="tag green" style="font-size:10px">⏯ ' + t('续跑补全') + '</span>' : '');
      return `
      <div class="msg ${m.role === 'user' ? 'user' : 'bot'}${isArch ? ' arch-branch' : ''}" data-mid="${m.id || ''}" style="${isArch ? 'opacity:.75' : ''}">
        <div class="m-avatar">${m.role === 'user' ? '我' : 'AI'}</div>
        <div class="m-body">
          <div class="m-name">${m.role === 'user' ? (getUserNick()) : (opts.getAgentBanner?.()?.name || t('AI 助手'))}${nameTag}</div>
          ${m.isError ? renderErrorCard(m) : `<div class="m-bubble">${renderBubble(m)}</div>`}
          ${m.role === 'assistant' && m.id && !m.isError ? renderFeedbackBar(m) : ''}
          ${m.role === 'assistant' && m.id && !m.isError && currentBranch === 'main' && !streaming ? renderReplayBtn(m) : ''}
        </div>
      </div>`;
    }).join('');
    bindBubbleEvents();
    bindFeedbackEvents();
    bindErrorEvents();
    bindMediaDynamic();
    bindReplayEvents(); // P1-6：回放按钮事件
    scrollBottom();
  }

  // P1-6 分支回放：AI 回复悬浮「从此回放」按钮（仅主线且非生成中可见）
  function renderReplayBtn(m) {
    return `<div class="replay-bar" style="margin-top:4px;display:flex;gap:6px;font-size:12px">
      <button class="fb-btn" data-replay="${m.id}" title="${t('从这条回复处重新生成——其后对话归档保留，不丢失')}">🔄 ${t('从此回放')}</button>
    </div>`;
  }

  function bindReplayEvents(scope) {
    (scope || el).querySelectorAll('[data-replay]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('从这条回复处重新生成？其后对话将归档为只读分支，不会丢失。'))) return;
      try {
        const j = await api(`/chat/messages/${b.dataset.replay}/replay`, { method: 'POST' });
        if (j.code !== 0) return toast(j.msg || t('回放失败'), 'err');
        toast(t('已归档旧回复——主线已回到你的问题，请重新发送或稍候重新生成'));
        // 重拉消息（main 已截断到锚点前）+ 刷新分支条
        const qs2 = await api(`/chat/sessions/${currentSession.id}/messages`);
        messages = (qs2.data && qs2.data.list) || [];
        currentBranch = 'main';
        renderMessages();
        loadBranches(currentSession.id);
        // P1-6 第二迭代：回放后自动把原问句填回输入框，用户可直接重发（或编辑后重发）
        if (j.data && j.data.user_question) { $('#chatInput').value = j.data.user_question; $('#chatInput').focus(); }
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  // 错误卡片（体验优化）：图标 + 中文文案 + 重试按钮 + 联系反馈，不再裸抛英文堆栈
  function renderErrorCard(m) {
    return `
    <div class="err-card">
      <div class="err-head">⚠️ ${t('回复生成失败')}</div>
      <div class="err-msg">${esc(m.content || t('未知错误'))}</div>
      <div class="err-tips">${t('系统已自动重试并尝试备用模型；你可以稍后重试，或把问题反馈给我们。')}</div>
      <div class="err-acts">
        <button class="btn sm primary" data-retry>🔄 ${t('重试')}</button>
        <button class="btn sm" data-feedback>💬 ${t('联系反馈')}</button>
      </div>
    </div>`;
  }

  function bindErrorEvents(scope) {
    (scope || el).querySelectorAll('[data-retry]').forEach(b => b.onclick = retryLast);
    (scope || el).querySelectorAll('.err-card [data-feedback]').forEach(b => b.onclick = () => window.__openFeedback?.());
  }

  // 对话质量反馈条（体验优化）：👍/👎（可取消/改评）+「这个回答解决你的问题了吗」二选一
  function renderFeedbackBar(m) {
    const r = m.rating || 0;
    const s = m.solved || 0;
    const solvedDone = s > 0;
    return `
    <div class="fb-bar" style="margin-top:6px;display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-3);flex-wrap:wrap">
      <button class="fb-btn ${r === 1 ? 'on-up' : ''}" data-rate="1" title="这个回答有帮助">👍</button>
      <button class="fb-btn ${r === -1 ? 'on-down' : ''}" data-rate="-1" title="这个回答不好">👎</button>
      ${!solvedDone ? `
        <span style="margin-left:8px">${t('这个回答解决你的问题了吗？')}</span>
        <button class="fb-btn" data-solved="1">✅ ${t('解决了')}</button>
        <button class="fb-btn" data-solved="0">❌ ${t('没解决')}</button>`
        : `<span style="margin-left:8px;color:${s === 1 ? 'var(--success,#059669)' : 'var(--warning,#d97706)'}">${s === 1 ? t('✅ 已标记为解决') : t('❌ 已标记为未解决')}${t('，感谢反馈')}</span>`}
    </div>`;
  }

  function bindFeedbackEvents(scope) {
    (scope || el).querySelectorAll('.fb-bar [data-rate]').forEach(b => b.onclick = async () => {
      const mid = b.closest('.msg').dataset.mid;
      if (!mid) return;
      try {
        await api(`/chat/messages/${mid}/rating`, { method: 'POST', body: { value: +b.dataset.rate } });
        const m = messages.find(x => x.id === +mid);
        if (m) m.rating = (m.rating === +b.dataset.rate ? 0 : +b.dataset.rate);
        renderMessages();
        toast(m?.rating ? t('感谢你的反馈') : t('已取消评价'));
      } catch (e) { toast(e.message, 'err'); }
    });
    (scope || el).querySelectorAll('.fb-bar [data-solved]').forEach(b => b.onclick = async () => {
      const mid = b.closest('.msg').dataset.mid;
      if (!mid) return;
      try {
        await api(`/chat/messages/${mid}/solved`, { method: 'POST', body: { value: +b.dataset.solved } });
        const m = messages.find(x => x.id === +mid);
        if (m) m.solved = b.dataset.solved === '1' ? 1 : 2;
        renderMessages();
        toast(t('感谢反馈，我们会持续优化'));
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function getUserNick() {
    try { return JSON.parse(localStorage.getItem('ap_user')).nickname || t('我'); } catch { return t('我'); }
  }

  /**
   * 纯正则 markdown → HTML 渲染器（零依赖）
   * 处理：标题、分割线、引用、加粗、斜体、行内代码、代码块、链接、无序列表、有序列表
   * 内置 HTML 转义，输出安全 HTML。
   */
  function renderMarkdown(text) {
    const s = String(text ?? '');

    // 1. 保护代码块 ```...```（先于一切处理，防止内部被转义或 markdown 解析破坏）
    const codeBlocks = [];
    let tmp = s.replace(/(?:^|\n)```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang, code });
      return `\n\x00CODEBLOCK${idx}\x00\n`; // 换行包裹确保列表分割正确
    });

    // 2. 保护行内代码 `...`（同样防止转义）
    const inlineCodes = [];
    tmp = tmp.replace(/`([^`]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(code);
      return `\x00INLINECODE${idx}\x00`;
    });

    // 3. 保护引用 > 行（提取为一整段，转义后再释放为 HTML 标签，防止 <blockquote> 被转义破坏）
    const blockquotes = [];
    tmp = tmp.replace(/^ {0,3}>[ \t]?(.*)$/gm, (_, content) => {
      const idx = blockquotes.length;
      blockquotes.push(content);
      return `\x00BQ${idx}\x00`;
    });

    // 4. HTML 转义剩余文本（此时所有特殊结构均已被占位符保护，不会破坏引号/尖括号/& 等）
    tmp = tmp.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // 5. 恢复引用（内容已在保护阶段原样保留，这里输出转义后的 HTML）
    tmp = tmp.replace(/\x00BQ(\d+)\x00/g, (_, n) => {
      const content = blockquotes[+n] || '';
      const escaped = content.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      return `<blockquote>${escaped}</blockquote>`;
    });

    // 合并连续的 <blockquote> 为一块
    tmp = tmp.replace(/(<blockquote>.*?(?:\n<blockquote>.*?)*)/g, match => {
      return match.replace(/\n<blockquote>/g, '\n') + '</blockquote>';
    });
    // 去除每个 blockquote 多余的闭合标签（除了最后一个）
    // 上面 replace 的 regex 略激进，改用更精确的逐行合并：
    // 先去掉每个 blockquote 的内部闭合标签（../g 匹配时已包含），改用行解析
    // 更稳健：用 wrapList 风格合并连续 blockquote
    tmp = (function mergeBlockquotes(t) {
      const lines = t.split('\n');
      const out = [];
      let inBq = false;
      for (let i = 0; i < lines.length; i++) {
        if (/^<blockquote>/.test(lines[i])) {
          if (!inBq) { out.push('<blockquote>'); inBq = true; }
          out.push(lines[i].replace(/^<blockquote>(.*)<\/blockquote>$/, '$1'));
        } else {
          if (inBq) { out[out.length - 1] += '</blockquote>'; inBq = false; }
          out.push(lines[i]);
        }
      }
      if (inBq) out[out.length - 1] += '</blockquote>';
      return out.join('\n');
    })(tmp);

    // 6. 分割线（必须优先于 * 加粗/斜体规则）
    tmp = tmp.replace(/^ {0,3}([-*_]){3,}\s*$/gm, '<hr>');

    // 7. 标题（先处理多级标题避免 H3 覆盖 H1；内容已在第 4 步转义）
    tmp = tmp.replace(/^ {0,3}######\s+(.*)$/gm, '<h6>$1</h6>');
    tmp = tmp.replace(/^ {0,3}#####\s+(.*)$/gm, '<h5>$1</h5>');
    tmp = tmp.replace(/^ {0,3}####\s+(.*)$/gm, '<h4>$1</h4>');
    tmp = tmp.replace(/^ {0,3}###\s+(.*)$/gm, '<h3>$1</h3>');
    tmp = tmp.replace(/^ {0,3}##\s+(.*)$/gm, '<h2>$1</h2>');
    tmp = tmp.replace(/^ {0,3}#\s+(.*)$/gm, '<h1>$1</h1>');

    // 8. 图片 ![alt](url) — 在转义后、链接前处理
    tmp = tmp.replace(/!\[([^\]]*)\]\(((?:https?:\/\/|data:image\/|\/)[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');

    // 9. 加粗 **text** 和 __text__
    tmp = tmp.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    tmp = tmp.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // 10. 斜体 *text* 和 _text_（注意不要匹配加粗中的 __）
    tmp = tmp.replace(/\*(.+?)\*/g, '<em>$1</em>');
    tmp = tmp.replace(/(?<!_)_{1}(?!_)(.+?)(?<!_)_{1}(?!_)/g, '<em>$1</em>');

    // 11. 链接 [text](url)
    tmp = tmp.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');

    // 12. 行内代码恢复
    tmp = tmp.replace(/\x00INLINECODE(\d+)\x00/g, (_, n) => {
      const code = inlineCodes[+n] || '';
      return '<code>' + code.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '</code>';
    });

    // 13. 代码块恢复
    tmp = tmp.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, n) => {
      const b = codeBlocks[+n];
      if (!b) return '';
      const lang = b.lang ? `<span class="code-lang">${b.lang}</span>` : '';
      const escaped = b.code.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      return `<pre><code>${lang}${escaped}</code></pre>`;
    });

    // 14. 列表
    tmp = wrapList(tmp, /^ {0,3}[-*]\s+(.+)$/gm, '<ul>', '<li>', '</li>', '</ul>');
    tmp = wrapList(tmp, /^ {0,3}\d+\.\s+(.+)$/gm, '<ol>', '<li>', '</li>', '</ol>');

    return tmp;
  }

  /** 辅助：将连续匹配的行包裹为列表 */
  function wrapList(text, lineRe, openTag, itemOpen, itemClose, closeTag) {
    const lines = text.split('\n');
    const result = [];
    let inList = false;
    // 移除 lineRe 的 g flag（逐行匹配不用 g），否则 .match() 返回完整匹配而非捕获组
    const re = new RegExp(lineRe.source, lineRe.flags.replace('g', ''));
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        if (!inList) { result.push(openTag); inList = true; }
        result.push(itemOpen + m[1] + itemClose);
      } else {
        if (inList) { result[result.length - 1] += closeTag; inList = false; }
        result.push(lines[i]);
      }
    }
    if (inList) result[result.length - 1] += closeTag;
    return result.join('\n');
  }

  function renderBubble(m) {
    // P5.14 附件行：用户消息携带附件时在正文前展示（可下载原文）
    const attachRow = (m.attachments && m.attachments.length)
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${m.attachments.map(a => `<a href="/api/files/${a.id}/download" class="btn sm" style="text-decoration:none" title="${t('下载原文')}">📄 ${esc(a.name)}</a>`).join('')}</div>`
      : '';
    // 引用角标 [n] / 平台专有卡片语法（先 markdown 转换，再叠加平台卡片替换）
    let html = attachRow + renderMarkdown(m.content)
      .replace(/\[(\d{1,2})\]/g, (all, n) =>
        `<sup class="cite-mark" data-cite="${n}">[${n}]</sup>`);
    html = html.replace(/\[VIDEO:([A-Za-z0-9_-]+)\]/g, (all, taskId) =>
      `<div class="video-card" data-task="${taskId}" data-pending="1">
        <div class="v-head">🎬 ${t('视频生成中')}</div>
        <div class="v-progress-wrap"><div class="v-progress"></div></div>
        <div class="v-status">${t('任务已提交，生成完成后自动播放（通常 1~3 分钟）')}</div>
      </div>`);
    html = html.replace(/\[PPT:([^\|\]]+)\|([^\|\]]+)\|(\d+)\]/g, (all, url, fname, pages) =>
      /^https?:\/\//i.test(url) || url.startsWith('/')
        ? `<div class="ppt-card">
        <div class="ppt-icon">📊</div>
        <div class="ppt-info"><b>${esc(fname)}</b><span>${pages} 页 · PPTX · 可下载编辑</span></div>
        <button class="btn sm" data-doc-preview="${esc(url)}" data-doc-name="${esc(fname)}" data-doc-kind="pptx">${t('预览')}</button>
        <a class="btn primary" href="${esc(url)}" download="${esc(fname)}" style="text-decoration:none">${t('⬇ 下载')}</a>
      </div>` : '');
    // P3 扩展产物卡（2026-10-22）：[CHART:url|标题] 图表 iframe 卡 / [WORD:url|名] Word 下载卡 / [AUDIO:url] 音频播放卡
    html = html.replace(/\[CHART:([^\|\]]+)\|([^\|\]]*)\]/g, (all, url, title) =>
      // P2-4 修复：校验 URL 仅允许 http/https 或相对路径（拒 javascript: 等）
      /^https?:\/\//i.test(url) || url.startsWith('/')
        ? `<div class="chart-card">
        <div class="chart-head">📊 ${esc(title || t('数据图表'))}</div>
        <iframe class="chart-frame" src="${esc(url)}" title="${esc(title || 'chart')}" loading="lazy"></iframe>
        <div class="chart-actions"><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener" style="text-decoration:none">${t('🔍 大图查看')}</a></div>
      </div>` : '');
    html = html.replace(/\[WORD:([^\|\]]+)\|([^\|\]]+)\]/g, (all, url, fname) =>
      /^https?:\/\//i.test(url) || url.startsWith('/')
        ? `<div class="word-card">
        <div class="word-icon">📄</div>
        <div class="word-info"><b>${esc(fname)}</b><span>DOCX · ${t('Word 文档')} · ${t('可下载编辑')}</span></div>
        <button class="btn sm" data-doc-preview="${esc(url)}" data-doc-name="${esc(fname)}">${t('预览')}</button>
        <a class="btn primary" href="${esc(url)}" download="${esc(fname)}" style="text-decoration:none">${t('⬇ 下载')}</a>
      </div>` : '');
    html = html.replace(/\[AUDIO:([^\|\]]+)\]/g, (all, url) =>
      /^https?:\/\//i.test(url) || url.startsWith('/')
        ? `<div class="audio-card">
        <div class="audio-head">🔊 ${t('语音播报')}</div>
        <audio controls preload="metadata" src="${esc(url)}"></audio>
      </div>` : '');
    if (m.kbHits?.length) {
      html += `<div class="kb-ref"><div class="kb-ref-title">📚 ${t('引用来源')}（${m.kbHits.length}）<span class="kb-ref-toggle" data-ref-toggle>${t('展开')}</span></div>
        <div class="kb-ref-list" style="display:none">${m.kbHits.map((h, i) => `
          <div class="kb-ref-item"><div class="kb-ref-head"><b>[${i + 1}]</b> ${esc(h.file || h.kb || t('知识库'))}${h.score != null ? ` <span class="tag blue" style="font-size:10px">${t('得分')} ${h.score}</span>` : ''}</div>
          <div class="kb-ref-content">${esc((h.content || '').slice(0, 200))}${(h.content || '').length > 200 ? '…' : ''}</div></div>`).join('')}</div></div>`;
    }
    if (m.toolCalls?.length) {
      html += `<div class="tool-ref">🔧 ${t('已调用工具：')}${m.toolCalls.map(tc => `<span class="tag purple" style="font-size:10px;margin-right:4px">${esc(tc.name)}</span>`).join('')}</div>`;
    }
    // 追问建议条（借鉴 SinguX「用户问题建议」）；挂在消息数据上，历史回看同样可见
    if (m.suggestions?.length) {
      html += `<div class="sug-bar" style="margin:8px 0 2px;display:flex;gap:8px;flex-wrap:wrap"><span style="font-size:12px;color:var(--text-3);align-self:center">${t('💡 继续追问：')}</span>${m.suggestions.map(q => `<span class="quick-q" data-sug-text="${esc(q)}">${esc(q)}</span>`).join('')}</div>`;
    }
    return html;
  }

  // 视频卡片轮询：pending 状态卡片 → 查进度 → 成功换播放器
  async function pollVideoCard(card) {
    const taskId = card.dataset.task;
    if (!taskId || card.dataset.polling === '1') return;
    card.dataset.polling = '1';
    try {
      const r = await fetch('/api/chat/video/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + getToken() } });
      const j = await r.json();
      if (j.code === 0) {
        const d = j.data;
        if (d.status === 'succeeded' || d.status === 'success') {
          card.dataset.pending = '';
          card.innerHTML = `
            <div class="v-head">🎬 ${t('视频已生成')}</div>
            <video controls preload="metadata" src="${d.content_url}"></video>
            <div class="v-actions"><a class="btn" href="${d.content_url}" download="video.mp4" style="text-decoration:none">${t('⬇ 下载视频')}</a></div>`;
          return;
        }
        if (d.status === 'failed' || d.status === 'error' || d.status === 'cancelled') {
          card.dataset.pending = '';
          card.innerHTML = `<div class="v-head">🎬 ${t('视频生成失败')}</div><div class="v-status">${t('请稍后重试或调整描述')}</div>`;
          return;
        }
        const bar = card.querySelector('.v-progress');
        const st = card.querySelector('.v-status');
        if (bar) bar.style.width = Math.max(5, d.progress || 5) + '%';
        // 进度 + 剩余时间估算（按总时长约 2 分钟反推，体验优化）
        if (st) {
          const p = Math.min(95, d.progress || 5);
          const eta = Math.max(1, Math.round(120 * (100 - p) / 100));
          st.textContent = t('生成中… {p}%（预计还需 {eta}）').replace('{p}', p).replace('{eta}', eta < 60 ? eta + ` ${t('秒')}` : Math.round(eta / 60) + ` ${t('分钟')}`);
        }
      }
    } catch { /* 网络抖动继续轮询 */ }
    card.dataset.polling = '';
    setTimeout(() => { if (card.isConnected && card.dataset.pending === '1') pollVideoCard(card); }, 5000);
  }

  function bindMediaDynamic(scope) {
    (scope || el).querySelectorAll('.video-card[data-pending="1"]').forEach(c => pollVideoCard(c));
  }

  // 引用角标点击 → 展开对应来源列表并高亮
  function bindBubbleEvents(scope) {
    (scope || el).querySelectorAll('[data-ref-toggle]').forEach(tg => tg.onclick = () => {
      const list = tg.closest('.kb-ref').querySelector('.kb-ref-list');
      const show = list.style.display === 'none';
      list.style.display = show ? '' : 'none';
      tg.textContent = show ? t('收起') : t('展开');
    });
    (scope || el).querySelectorAll('.cite-mark').forEach(c => c.onclick = () => {
      const ref = c.closest('.m-bubble').querySelector('.kb-ref');
      if (!ref) return;
      const list = ref.querySelector('.kb-ref-list');
      list.style.display = '';
      ref.querySelector('.kb-ref-toggle').textContent = t('收起');
      const item = list.querySelectorAll('.kb-ref-item')[+c.dataset.cite - 1];
      if (item) { item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });       item.style.background = 'var(--surface-2,#fff7e6)'; setTimeout(() => item.style.background = '', 1500); }
    });
    // 追问建议 chip：点击即填入并发送
    (scope || el).querySelectorAll('[data-sug-text]').forEach(s => s.onclick = () => {
      $('#chatInput').value = s.dataset.sugText;
      doSend();
    });
  }

  function streamingBubble(el2) {
    el2.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span style="font-size:12px;color:var(--text-3);margin-left:6px">${t('正在思考…')}</span>`;
  }

  async function loadSessions() {
    const filter = opts.getAgentId?.();
    // P3 会话历史搜索：keyword 命中标题或任意消息内容
    const kw = ($('#sessSearch')?.value || '').trim();
    const qs = new URLSearchParams({ agent_id: filter != null ? String(filter) : 'home' });
    if (kw) qs.set('keyword', kw);
    const j = await api('/chat/sessions?' + qs.toString());
    sessions = j.data;
    renderSessions();
  }

  async function openSession(id) {
    currentSession = sessions.find(s => s.id === id);
    // P1-6：返回结构改为 {branch, list}；同时探测未完成检查点（aborted → 展示「继续生成」卡片）
    const j = await api(`/chat/sessions/${id}/messages`);
    messages = (j.data && j.data.list) || [];
    currentBranch = (j.data && j.data.branch) || 'main';
    renderSessions(); renderMessages();
    checkPendingResume(id);
    loadBranches(id);
  }

  // P1-6 断点续跑：打开会话时若有 aborted 检查点，在消息流末尾追加续跑卡片
  async function checkPendingResume(id) {
    try {
      const j = await api(`/chat/sessions/${id}/checkpoint`);
      pendingCk = j.data || null;
    } catch { pendingCk = null; }
    if (pendingCk && pendingCk.status === 'aborted') renderResumeCard();
  }

  function renderResumeCard() {
    if (!pendingCk) return;
    const inner = $('#chatInner');
    if (!inner || document.getElementById('resumeCard')) return;
    const partial = String(pendingCk.partial_content || '');
    const div = document.createElement('div');
    div.id = 'resumeCard';
    div.className = 'msg bot';
    div.innerHTML = `
      <div class="m-avatar">AI</div>
      <div class="m-body">
        <div class="m-bubble" style="border:1px dashed #f59e0b;background:#fffbeb">
          <div style="font-size:12px;color:#b45309;font-weight:600;margin-bottom:4px">⚠️ ${t('上次回复生成中断')}</div>
          <div style="font-size:12px;color:var(--text-3)">${t('中断处内容：')}${esc(partial.slice(-80))}${partial.length > 80 ? '…' : ''}</div>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button class="btn sm primary" id="resumeBtn">▶️ ${t('继续生成')}</button>
            <button class="btn sm" id="resumeDismiss">${t('忽略')}</button>
          </div>
        </div>
      </div>`;
    inner.appendChild(div);
    $('#resumeBtn').onclick = async () => { div.remove(); await doResume(); };
    $('#resumeDismiss').onclick = () => { div.remove(); pendingCk = null; };
    scrollBottom();
  }

  // P1-6 续跑 SSE：与 doSend 同构的流式渲染（每次 delta 后定位最后一个气泡重绘）
  async function doResume() {
    if (!pendingCk || !currentSession) return;
    streaming = true;
    setSendBtnMode('stop');
    $('#chatStatus').textContent = t('续跑中…');
    const botMsg = { role: 'assistant', content: pendingCk.partial_content || '', resumed: true };
    messages.push(botMsg);
    renderMessages();
    const bubbles = $('#chatInner').querySelectorAll('.m-bubble');
    streamingBubble(bubbles[bubbles.length - 1]);
    await sseChat(null, {
      url: `/api/chat/sessions/${currentSession.id}/resume`,
      method: 'POST',
      body: {},
      onDelta(text) {
        botMsg.content += text;
        const bs = $('#chatInner').querySelectorAll('.m-bubble');
        const live = bs[bs.length - 1];
        if (live) live.innerHTML = renderMarkdown(botMsg.content);
        scrollBottom();
      },
      onDone(j) { botMsg.content = j.content; botMsg.id = j.mid; pendingCk = null; streaming = false; setSendBtnMode('send'); $('#chatStatus').textContent = ''; renderMessages(); },
      onError(e) { toast(e.message, 'err'); botMsg.content = botMsg.content || t('续跑失败'); streaming = false; setSendBtnMode('send'); renderMessages(); },
      onAborted() { toast(t('已停止续跑'), 'info'); streaming = false; setSendBtnMode('send'); renderMessages(); },
    });
  }

  // P1-6 分支列表：会话存在归档线时，顶部展示分支切换条
  async function loadBranches(id) {
    try {
      const j = await api(`/chat/sessions/${id}/branches`);
      branches = (j.data || []).filter(b => b.branch !== 'main');
    } catch { branches = []; }
    renderBranchBar();
  }

  function renderBranchBar() {
    let bar = $('#branchBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'branchBar';
      bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;font-size:12px';
      const inner = $('#chatInner');
      if (inner) inner.parentElement.insertBefore(bar, inner);
    }
    if (!branches.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = `<span style="color:var(--text-3)">🌿 ${t('回放分支：')}</span>` +
      `<span class="mm-chip ${currentBranch === 'main' ? 'on' : ''}" data-br="main">${t('当前主线')}</span>` +
      branches.map(b => `<span class="mm-chip ${currentBranch === b.branch ? 'on' : ''}" data-br="${b.branch}">${b.branch}（${b.msgs}）</span>`).join('');
    bar.querySelectorAll('[data-br]').forEach(c => c.onclick = async () => {
      const br = c.dataset.br;
      if (br === currentBranch) return;
      currentBranch = br;
      const qs = br === 'main' ? '' : `?branch=${br}`;
      const j = await api(`/chat/sessions/${currentSession.id}/messages${qs}`);
      messages = (j.data && j.data.list) || [];
      currentBranch = (j.data && j.data.branch) || br;
      renderMessages(); renderBranchBar();
    });
  }

  async function newSession() {
    const j = await api('/chat/sessions', { method: 'POST', body: { agent_id: opts.getAgentId?.() ?? null, title: t('新会话') } });
    currentSession = { id: j.data.id, title: t('新会话') };
    messages = [];
    loadSessions(); renderMessages();
    fillUserPrompt(); // 新会话预填用户提示词
  }

  async function loadModels() {
    const j = await api('/chat/models');
    models = j.data;
    renderModelSelect();
  }

  // P4 模型隔离（2026-10-26 P5.18 透明化升级）：按模式过滤选择能力，但全量模型分组可见——
  // 当前模式类型可选，其他类型禁用展示并标注「切到对应模式可用」，杜绝"我的模型去哪了"的困惑
  function renderModelSelect() {
    const sel = $('#modelSelect');
    if (!sel) return;
    const allow = opts.allowModelSwitch?.() !== false;
    sel.style.display = allow ? '' : 'none';
    if (!allow) return;
    const need = SKILL_MODEL_TYPE[currentSkill] || 'chat';
    const TYPE_TAG = { chat: `💬 ${t('对话')}`, image: `🎨 ${t('生图')}`, video: `🎬 ${t('视频')}`, tts: `🎙️ ${t('语音')}`, embedding: `🧠 ${t('嵌入')}` };
    const TYPE_MODE = { chat: t('对话模式'), image: `🎨 ${t('图片生成模式')}`, video: `🎬 ${t('视频生成模式')}`, tts: `🎙️ ${t('语音生成模式')}` };
    const pool = models.filter(m => (m.type || 'chat') === need);
    const others = models.filter(m => (m.type || 'chat') !== need && (m.type || 'chat') !== 'embedding');
    sel.innerHTML =
      (pool.length ? `<optgroup label="${t('当前模式可用')}">${pool.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.is_default ? '' : ' · ' + esc(m.provider || '')}${m.real ? '' : '（演示）'}</option>`).join('')}</optgroup>` : `<option value="">${t('当前模式无可用模型')}</option>`) +
      (others.length ? `<optgroup label="${t('其他类型模型（切换模式后可用）')}">${others.map(m => `<option disabled>⛔ ${esc(m.name)} · ${TYPE_TAG[m.type] || m.type}——${t('切到' + (TYPE_MODE[m.type] || '对应模式'))}</option>`).join('')}</optgroup>` : '');
    if (pool.some(m => m.name === currentModel)) { sel.value = currentModel; }
    else { const def = pool.find(m => m.is_default); currentModel = def?.name || pool[0]?.name || ''; sel.value = currentModel; }
    sel.onchange = () => { currentModel = sel.value; };
    // 悬停提示：为什么有些模型不可选
    sel.title = `${t('平台共')} ${models.length} ${t('个模型')}（${t('当前模式类型')} ${TYPE_TAG[need] || need} ${t('可用')} ${pool.length} ${t('个')}）——${t('灰色项为其他类型模型，切到对应创作模式即可选用')}`;
  }

  // 用量透明化 + 预警（帮助体系）：右上角常驻「本月已用/配额」，80%/90% 顶部预警横幅
  // 用量透明化 + 预警 + 升级引导（商业化）：胶囊条 / 预警横幅带「升级」入口（free 用户）
  let myBizPlan = null; // 本轮会话内缓存套餐信息（升级引导用）
  async function loadQuota() {
    let q = null;
    try { q = (await api('/quota/my')).data; } catch { return; }
    if (!myBizPlan) { try { myBizPlan = (await api('/biz/my')).data; } catch { } }
    const isFree = myBizPlan?.plan === 'free' && !myBizPlan?.exempt; // 管理员豁免：不显示升级引导
    const upgradeLink = isFree ? ` · <a href="#/pricing" style="color:var(--brand,#7c3aed);font-weight:600">${t('升级专业版 →')}</a>` : '';
    const strip = $('#quotaStrip');
    const banner = $('#quotaBanner');
    if (!strip || !banner) return;
    const fmt = n => (n || 0).toLocaleString('zh-CN');
    if (q.unlimited) {
      strip.innerHTML = `📊 ${t('本月已用')} ${fmt(q.used)} tokens · <span style="color:var(--success,#059669);font-weight:600">${t('不限额')}</span>${upgradeLink}`;
      banner.innerHTML = '';
      return;
    }
    const pct = q.percent;
    const color = pct >= 90 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#2563eb';
    strip.innerHTML = `📊 ${t('本月已用')} <b style="color:var(--text)">${fmt(q.used)}</b> / ${fmt(q.total)}
      <span style="display:inline-block;width:64px;height:5px;background:var(--border,#f1f3f7);border-radius:6px;overflow:hidden"><span style="display:block;width:${pct}%;height:100%;background:${color}"></span></span>
      <b style="color:${color}">${pct}%</b>`;
    strip.title = `${t('剩余')} ${fmt(q.remaining)} tokens`;
    // 预警横幅：80% 黄色 / 90% 红色（站内信已同步发送，见通知中心）
    if (pct >= 80) {
      const red = pct >= 90;
      const bg = red ? '#fef2f2' : '#fffbeb';
      const bd = red ? '#fecaca' : '#fde68a';
      const tx = red ? '#991b1b' : '#92400e';
      banner.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;padding:9px 14px;border-radius:10px;margin-bottom:10px;font-size:12.5px;
        background:${bg};border:1px solid ${bd};color:${tx}">
        <span style="font-size:15px">${red ? '🚨' : '⚠️'}</span>
        <span style="flex:1">${t('Token 用量已达')} <b>${pct}%</b>（${fmt(q.used)} / ${fmt(q.total)}）${red ? t('，配额即将耗尽——用尽后将无法继续对话') : t('，建议提前关注')}${isFree ? t('；升级专业版额度放大 10 倍') : t('；如需继续使用请联系管理员调整配额')}。</span>
        ${isFree ? `<a href="#/pricing" style="flex-shrink:0;padding:5px 14px;border-radius:8px;background:#7c3aed;color:#fff;font-weight:600;text-decoration:none">🚀 ${t('升级')}</a>` : ''}
        <a href="#/help" style="color:${tx};font-weight:600;flex-shrink:0">${t('了解配额 →')}</a>
      </div>`;
    } else {
      banner.innerHTML = '';
    }
  }

  function ensureSession() {
    if (currentSession) return Promise.resolve();
    return newSession();
  }

  // 实时工具状态条：流式过程中展示「执行中 → 完成」（借鉴 SinguX PROCESSING 事件展示）
  function renderLiveTools(live) {
    if (!pendingTools.length) return;
    let bar = live.parentElement.querySelector('.live-tools');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'live-tools';
      bar.style.cssText = 'margin:4px 0 8px;display:flex;gap:6px;flex-wrap:wrap';
      live.parentElement.insertBefore(bar, live);
    }
    bar.innerHTML = pendingTools.map(x => `
      <span class="tag ${x.status === 'executing' ? 'orange' : 'green'}" style="font-size:11px">
        ${x.status === 'executing' ? '⏳' : '✅'} ${esc(x.name)}${x.status === 'executing' ? ` ${t('执行中…')}` : ''}
      </span>`).join('');
  }

  // P5.29 停止生成按钮态：发送 ↔ 停止切换（蓝色正圆底 + 白色圆角方块图标，见 app.css .send-btn.stop）。
  // 注意：停止态必须保持可点击（点击 = 中断），不能用 disabled 语义（那会点击无效且置灰）
  function setSendBtnMode(mode) {
    const btn = $('#sendBtn');
    if (!btn) return;
    if (mode === 'stop') {
      btn.classList.add('stop');
      btn.disabled = false;
      btn.innerHTML = '<span class="stop-icon"></span>';
      btn.title = t('停止生成');
      btn.setAttribute('aria-label', t('停止生成'));
    } else {
      btn.classList.remove('stop');
      btn.disabled = false;
      btn.innerHTML = t('发送 ➤');
      btn.title = '';
      btn.removeAttribute('aria-label');
    }
  }

  async function doSend(retryText) {
    const input = $('#chatInput');
    const text = (retryText != null ? retryText : input.value).trim();
    const attach = (retryText == null && pendingAttach.length) ? pendingAttach.slice() : []; // P5.14：附件随发送（重试不重复携带）
    if ((!text && !attach.length) || streaming) return; // 纯附件消息可发（后端 P5.14 已放宽）
    if (retryText == null) { input.value = ''; pendingAttach = []; window.__renderAttachBadge?.(); }
    lastFailedInput = null; // 发送成功进入流程，清除上一次失败输入
    await ensureSession();
    messages.push({ role: 'user', content: text || `（📎 ${attach.map(a => a.name).join('、')}）`, attachments: attach.length ? attach : undefined });
    renderMessages();
    streaming = true;
    setSendBtnMode('stop'); // P5.29 停止生成：按钮切换为停止态（不再 disabled——点击即中断）
    $('#chatStatus').textContent = t('思考中…');
    // 生成中速罩提示（长回复感知：顶部固定状态条）
    let genTimer = setTimeout(() => { if (streaming) $('#chatStatus').textContent = t('正在生成回复，请稍候…'); }, 4000);

    const botMsg = { role: 'assistant', content: '' };
    messages.push(botMsg);
    renderMessages();
    // 渲染为流式占位（思考中动画 + 文案）
    const bubbles = $('#chatInner').querySelectorAll('.m-bubble');
    const live = bubbles[bubbles.length - 1];
    streamingBubble(live);
    pendingKbHits = null; pendingTools = []; pendingSuggestions = [];

    await sseChat({
      session_id: currentSession.id,
      agent_id: opts.getAgentId?.() ?? null,
      model: currentModel,
      skill: currentSkill,
      perm: (($('#permSelect') || {}).value) === 'auto' ? 'auto' : 'default', // P5.25：对话权限（默认/全自动）
      content: text,
      ...(attach.length ? { attachments: attach.map(a => a.id) } : {}), // P5.14：附件 fileId（后端按 start 的 file 变量配对/文本化兑底）
    }, {
      onKb(hits) { pendingKbHits = hits; },
      onNotice(msg) { toast(msg, 'info'); }, // 安全提醒/技能启用等即时可见（原先仅内部记录不展示）
      onTool(tool) {
        // 同名工具保留最新状态（executing → finished）
        const exist = pendingTools.find(x => x.name === tool.name && x.status === 'executing');
        if (tool.status === 'executing') pendingTools.push({ name: tool.name, status: 'executing' });
        else if (exist) exist.status = 'finished';
        else pendingTools.push({ name: tool.name, status: 'finished' });
        renderLiveTools(live);
        // 图片生成特殊提示：等待期给出预期时长（体验优化）
        if (tool.name === 'image_gen') {
          const st = $('#chatStatus');
          if (tool.status === 'executing' && st) st.textContent = t('🎨 正在生成图片（约需 10~30 秒）…');
        }
        scrollBottom();
      },
      // P5.25 权限确认卡：「默认权限」下 medium/high 风险工具执行前，消息流内嵌批准/拒绝卡（120s 超时自动拒）
      onToolConfirm(info) {
        let argsPreview = '';
        try {
          const a = JSON.parse(info.args || '{}');
          argsPreview = Object.entries(a).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join('\n') || '（无参数）';
        } catch { argsPreview = String(info.args || '').slice(0, 120); }
        const card = document.createElement('div');
        card.className = 'tool-confirm-card';
        card.innerHTML = `
          <div class="tc-head">🔐 ${t('工具执行确认')} · <b>${esc(info.name)}</b></div>
          <div class="tc-args"><pre>${esc(argsPreview)}</pre></div>
          <div class="tc-tip">${t('当前为「默认权限」：该工具可能产生实际操作或消耗，执行前需你确认。切换「全自动执行」可跳过确认。')}</div>
          <div class="tc-actions">
            <button class="btn sm" data-deny>${t('拒绝')}</button>
            <button class="btn primary sm" data-approve>${t('批准执行')}</button>
          </div>`;
        live.parentElement.insertBefore(card, live.parentElement.firstChild);
        scrollBottom();
        const decide = async approve => {
          card.querySelectorAll('button').forEach(b => b.disabled = true);
          card.querySelector('.tc-actions').innerHTML = approve ? `<span style="color:var(--success,#16a34a);font-size:12px">✅ ${t('已批准，执行中…')}</span>` : `<span style="color:var(--danger,#dc2626);font-size:12px">⛔ ${t('已拒绝执行')}</span>`;
          try { await api('/chat/confirm', { method: 'POST', body: { key: info.key, approve } }); } catch (e) { toast(e.message, 'err'); }
        };
        card.querySelector('[data-approve]').onclick = () => decide(true);
        card.querySelector('[data-deny]').onclick = () => decide(false);
      },
      onDelta(delta) {
        botMsg.content += delta;
        $('#chatStatus').textContent = t('生成中…');
        // 打字机效果：正文 + 闪烁光标（体验优化：长回复可见「还在输出」）
        live.innerHTML = esc(botMsg.content) + '<span class="stream-cursor"></span>';
        scrollBottom();
      },
      onBlocked(msg) {
        botMsg.content = '⛔ ' + msg;
        live.innerHTML = esc(botMsg.content);
        toast(msg, 'err');
      },
      onSuggestions(list) {
        pendingSuggestions = (list || []).slice(0, 3);
        if (!pendingSuggestions.length) return;
        // 注意：onDone 已触发 renderMessages 整体重渲染，闭包里的 live 引用已失效；
        // 建议须挂到消息数据上再重渲染（renderBubble 渲染 .sug-bar），历史回看同样可见
        botMsg.suggestions = pendingSuggestions;
        renderMessages();
      },
      onTitle(j) {
        // P2 会话标题自动生成：服务端推送新标题，同步侧栏会话列表（无需刷新）
        if (j?.sid && j?.title) {
          if (currentSession?.id === +j.sid) currentSession.title = j.title;
          loadSessions();
        }
      },
      onDone(j) {
        botMsg.content = j.content;
        botMsg.kbHits = pendingKbHits;
        botMsg.toolCalls = pendingTools.map(t => ({ name: t.name }));
        botMsg.id = j.mid; // 服务端消息 ID：点赞点踩/解决反馈落库用
        renderMessages();
        $('#chatStatus').textContent = '';
        toast(t('回复完成，请点击 👍/👎 帮助我们改进'), 'info');
      },
      onError(e) {
        // 错误卡片：中文兑底翻译 + 重试按钮 + 联系反馈（体验优化）
        lastFailedInput = text;
        botMsg.isError = true;
        botMsg.content = friendlyError(e.message);
        renderMessages();
        $('#chatStatus').textContent = '';
      },
      // P5.29 停止生成：保存中断句柄 + 用户点击停止后的收尾（保留已输出部分 + 停止标记；后端同步中止模型流并落库 partial）
      onAborter(abortFn) { currentAbort = abortFn; },
      onAborted() {
        botMsg.content = botMsg.content
          ? botMsg.content + `\n\n---\n⏹ ${t('已停止生成，以上为部分内容。')}`
          : `⏹ ${t('已停止生成（尚未输出内容）。')}`;
        renderMessages();
        $('#chatStatus').textContent = '';
        toast(t('已停止生成'), 'info');
      },
    });
    streaming = false;
    currentAbort = null; // P5.29：清理中断句柄
    clearTimeout(genTimer);
    setSendBtnMode('send'); // P5.29 停止生成：恢复发送按钮
    loadSessions();
    loadQuota(); // 对话后刷新用量条与预警横幅
  }

  function retryLast() {
    if (!lastFailedInput || streaming) return;
    // 移除失败占位消息后重发
    const idx = messages.findLastIndex(m => m.isError);
    if (idx > -1) messages.splice(idx, 1);
    renderMessages();
    doSend(lastFailedInput);
  }

  // P5.29 停止生成：生成中点击按钮 = 中断当前流（此时按钮为停止图标）；平时 = 发送。
  // 箭头包裹：避免 event 对象被误作 retryText 参数
  $('#sendBtn').onclick = () => { if (streaming) currentAbort?.(); else doSend(); };
  $('#newChatBtn').onclick = newSession;

  // P3 会话历史搜索：输入防抖 300ms，实时过滤会话列表
  let searchTimer = null;
  $('#sessSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSessions(), 300);
  });

  // P3 @技能：弹出技能库（我的+他人已发布），点击插入 @技能名 到输入框，发送后自动注入技能提示词与工具
  $('#atSkillBtn').onclick = async () => {
    let skillList = [];
    try { skillList = (await api('/skillassets')).data; } catch (e) { return toast(e.message, 'err'); }
    if (!skillList.length) {
      return modal({
        title: t('✨ 技能库'),
        body: `<div style="padding:24px 20px;text-align:center;color:var(--text-3);font-size:13px;line-height:1.8">${t('还没有可用技能')}<br>${t('到「技能」页创建：写好提示词与工具组合')}<br>${t('对话中输入')} <b style="color:var(--brand,#2563eb)">@${t('技能名')}</b> ${t('即可调用')}</div>`,
        foot: `<button class="btn" data-close>${t('关闭')}</button><button class="btn primary" data-go>${t('前往技能页 →')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-close]').onclick = close;
          mask.querySelector('[data-go]').onclick = () => { close(); location.hash = '#/skills'; };
        },
      });
    }
    modal({
      title: t('✨ 选择要调用的技能（点击插入 @技能名）'),
      body: `<div>${skillList.map(s => `
        <div class="at-skill-item" data-name="${esc(s.name)}" style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid var(--surface-2,#f1f3f7);margin-bottom:8px">
          <span style="font-size:22px">${esc(s.icon || '✨')}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(s.name)}
              ${s.mine ? `<span class="tag blue" style="font-size:10px">${t('我的')}</span>` : `<span class="tag gray" style="font-size:10px">${esc(s.owner)}</span>`}
              ${s.tools?.length ? `<span class="tag purple" style="font-size:10px">${t('工具')}×${s.tools.length}</span>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.description || (s.prompt || '').slice(0, 60) || '')}</div>
          </div>
        </div>`).join('')}</div>`,
      noFooter: true,
      onMount(mask, close) {
        mask.querySelectorAll('.at-skill-item').forEach(item => {
          item.onmouseenter = () => item.style.background = 'var(--surface-2,#f8faff)';
          item.onmouseleave = () => item.style.background = '';
          item.onclick = () => {
            const inp = $('#chatInput');
            const cur = inp.value.trim();
            inp.value = (cur ? cur + ' ' : '') + '@' + item.dataset.name + ' ';
            close();
            inp.focus();
          };
        });
      },
    });
  };
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  // P5.24 🔗 应用链接：URL + 标题 → 插入 Markdown 引用（配 web_fetch/联网搜索工具的智能体可直接抓取分析）
  $('#linkBtn').onclick = () => {
    modal({
      title: t('🔗 插入应用链接'),
      body: `
      <div class="form-item">
        <label>${t('链接地址（URL）')}</label>
        <input class="input" id="linkUrl" placeholder="https://example.com/article" style="width:100%">
      </div>
      <div class="form-item" style="margin-top:12px">
        <label>${t('链接标题（可选，用于展示）')}</label>
        <input class="input" id="linkTitle" placeholder="${t('例：行业分析报告')}" style="width:100%">
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text-3);line-height:1.7">${t('插入后可在消息中补充说明，让 AI 结合链接内容回答（智能体具备联网/网页抓取工具时效果最佳）')}</div>`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn primary" data-insert>${t('插入')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-insert]').onclick = () => {
          let url = mask.querySelector('#linkUrl').value.trim();
          const title = mask.querySelector('#linkTitle').value.trim();
          if (!url) return toast(t('请输入链接地址'), 'err');
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // 补协议（裸域名友好）
          try { if (!new URL(url).hostname.includes('.')) return toast(t('链接格式不正确'), 'err'); } catch { return toast(t('链接格式不正确'), 'err'); }
          const md = `[${title || url}](${url})`;
          const inp = $('#chatInput');
          const cur = inp.value;
          // 光标处插入；无光标信息则追加
          const pos = inp.selectionStart ?? cur.length;
          inp.value = cur.slice(0, pos) + (pos > 0 && cur.slice(0, pos) && !/\s$/.test(cur.slice(0, pos)) ? ' ' : '') + md + ' ' + cur.slice(pos);
          close();
          inp.focus();
        };
        setTimeout(() => mask.querySelector('#linkUrl').focus(), 60);
      },
    });
  };

  // P5.24 🎓 指定专家：已发布智能体列表 → 点击插入 @专家名（后端解析注入专家提示词）
  $('#expertBtn').onclick = async () => {
    let agents = [];
    try { agents = (await api('/agents/square/list')).data?.list || []; } catch (e) { return toast(e.message, 'err'); }
    if (!agents.length) {
      return modal({
        title: t('🎓 专家库'),
        body: `<div style="padding:24px 20px;text-align:center;color:var(--text-3);font-size:13px;line-height:1.8">${t('还没有已发布的智能体专家')}<br>${t('到「智能体」页创建并发布，或到「广场」启用现成专家')}<br>${t('对话中输入')} <b style="color:var(--brand,#2563eb)">@${t('专家名')}</b> ${t('即可指定')}</div>`,
        foot: `<button class="btn" data-close>${t('关闭')}</button><button class="btn primary" data-go>${t('前往广场 →')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-close]').onclick = close;
          mask.querySelector('[data-go]').onclick = () => { close(); location.hash = '#/square'; };
        },
      });
    }
    const TYPE_TAG = { enterprise: '企业智能体', digital: '数字员工', dept: '部门AI助理', other: '其他' };
    modal({
      title: t('🎓 选择专家（点击插入 @专家名，以专家身份回答）'),
      body: `<div style="max-height:52vh;overflow-y:auto">${agents.slice(0, 50).map(a => `
        <div class="at-expert-item" data-name="${esc(a.name)}" style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid var(--surface-2,#f1f3f7);margin-bottom:8px">
          <span style="font-size:22px">${esc(a.icon || '🤖')}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(a.name)}
              <span class="tag blue" style="font-size:10px">${t(TYPE_TAG[a.type] || '智能体')}</span>
              ${a.is_official ? `<span class="tag purple" style="font-size:10px">${t('官方')}</span>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.description || '')}</div>
          </div>
          <div style="font-size:11px;color:var(--text-3);flex-shrink:0">👥 ${a.user_count || 0}</div>
        </div>`).join('')}</div>`,
      noFooter: true,
      onMount(mask, close) {
        mask.querySelectorAll('.at-expert-item').forEach(item => {
          item.onmouseenter = () => item.style.background = 'var(--surface-2,#f8faff)';
          item.onmouseleave = () => item.style.background = '';
          item.onclick = () => {
            const inp = $('#chatInput');
            const cur = inp.value.trim();
            inp.value = (cur ? cur + ' ' : '') + '@' + item.dataset.name + ' ';
            close();
            inp.focus();
            toast(t('已指定专家') + '：@' + item.dataset.name, 'ok');
          };
        });
      },
    });
  };

  // 悬浮帮助按钮（帮助体系）：预设高频问题一键填入 + 帮助中心/反馈入口
  const helpBtn = $('#chatHelpBtn');
  if (helpBtn) {
    helpBtn.onmouseenter = () => { helpBtn.style.background = 'var(--surface-2,#f0f6ff)'; helpBtn.style.transform = 'scale(1.08)'; };
    helpBtn.onmouseleave = () => { helpBtn.style.background = ''; helpBtn.style.transform = ''; };
    helpBtn.onclick = () => {
      const QUESTIONS = [
        t('怎么创建自己的智能体？'),
        t('知识库怎么上传和使用？'),
        t('API 怎么调用？在哪里拿密钥？'),
        t('怎么接入我自己的模型？'),
        t('Token 配额用完了怎么办？'),
        t('技能是什么？怎么用？'),
      ];
      modal({
        title: t('❓ 需要帮助？'),
        body: `<div style="font-size:12px;color:var(--text-3);margin-bottom:10px">${t('点击问题直接填入输入框问 AI，或到帮助中心查看详细文档')}</div>
          ${QUESTIONS.map(q => `
          <div class="hlp-q" data-q="${esc(q)}" style="display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--surface-2,#f1f3f7);border-radius:10px;margin-bottom:8px;cursor:pointer;font-size:13px;color:var(--text)">
            <span style="color:var(--brand,#2563eb)">Q</span><span style="flex:1">${esc(q)}</span><span style="color:var(--text-3)">→</span>
          </div>`).join('')}`,
        foot: `<button class="btn" data-feedback>💬 ${t('意见反馈')}</button><button class="btn primary" data-help>📖 ${t('帮助中心')}</button>`,
        onMount(mask, close) {
          mask.querySelectorAll('.hlp-q').forEach(item => {
            item.onmouseenter = () => item.style.background = 'var(--surface-2,#f8faff)';
            item.onmouseleave = () => item.style.background = '';
            item.onclick = () => {
              const inp = $('#chatInput');
              inp.value = item.dataset.q;
              close();
              inp.focus();
            };
          });
          mask.querySelector('[data-help]').onclick = () => { close(); location.hash = '#/help'; };
          mask.querySelector('[data-feedback]').onclick = () => { close(); window.__openFeedback?.(); };
        },
      });
    };
  }

  renderBanner();
  loadModels();
  loadQuota(); // 常驻用量条 + 预警横幅
  loadSessions().then(() => { renderMessages(); fillUserPrompt(); });
}
