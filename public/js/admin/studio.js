/** 后台-智能体编排页（借鉴 SinguX 编排页：左侧配置面板 + 中间编辑区 + 右侧预览调试）
 *  路由：#/admin/studio/:id（P3：非管理员若有编辑权也可进入——owner/协作者）
 *  七大配置区块：提示词（系统/用户）| 工具（内置+MCP）| 知识（知识库）| 记忆（变量/长期记忆）| 对话体验（建议/自有模型）| 界面配置（图标/开场白/预置问题）| 协作与可见性（P3）
 *  修改后 2 秒自动保存（草稿），右侧实时调试对话；多人协作下带乐观锁冲突检测（409）
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';
import { mountChat } from '../chat-component.js';
import { createCanvas } from './canvas.js';

const TYPE_NAME = { enterprise: '企业智能体', digital: '数字员工', dept: '部门AI助理', other: '其他' };
const ICON_POOL = ['🤖', '🎯', '📝', '💡', '📊', '🛠️', '🌐', '📚', '✍️', '🧩', '🧠', '💼', '🛡️', '📈', '🎨', '🎬', '⚖️', '🏦', '💬', '🔍'];
const TOOL_META = {
  kb_search: { icon: '📚', label: '知识库检索', tip: '智能体自主决定何时检索关联知识库（RAG 工具化）' },
  get_datetime: { icon: '🕐', label: '时间查询', tip: '获取当前日期时间与星期' },
  calculator: { icon: '🧮', label: '精确计算', tip: '算术表达式精确求值，避免心算出错' },
  image_gen: { icon: '🎨', label: '文生图', tip: '调用 QwenImage 生成图片（经 TG 网关计费）' },
  db_query: { icon: '🗃️', label: 'Text2SQL', tip: '自然语言查询平台业务库（只读 SELECT 安全校验），返回 Markdown 表格' },
  db_chart: { icon: '📊', label: '数据图表', tip: '把数据绘制为 ECharts 柱/折/饼图，对话内嵌图表卡片' },
  web_search: { icon: '🌐', label: '联网搜索', tip: 'Bing/百度等四级兜底实时检索互联网，回答自动标注来源' },
  web_fetch: { icon: '🔗', label: '网页抓取', tip: '抓取指定链接正文（jina reader 优先，直抓降级）' },
  stock_quote: { icon: '💵', label: '股票行情', tip: '东方财富公开接口：股票/指数实时行情（价格涨跌幅/成交量/换手率）' },
  export_word: { icon: '📄', label: 'Word 导出', tip: 'Markdown 转 .docx 文档（标题/表格/代码块），生成下载卡片' },
  tts: { icon: '🔊', label: '语音合成', tip: '微软接口文字转 MP3 音频，对话内直接播放' },
  doc_review: { icon: '🔍', label: '文档评审', tip: '对知识库文档做合同/标书/通用评审，输出风险分级 Word 报告' },
};
// 生成多样性预设（SinguX：精确/平衡/创意/自定义）
const DIVERSITY = {
  precise: { label: '精确模式', t: 0.1, p: 0.3 },
  balanced: { label: '平衡模式', t: 0.7, p: 0.7 },
  creative: { label: '创意模式', t: 1.0, p: 0.9 },
  custom: { label: '自定义', t: null, p: null },
};
const SYS_VARS = ['SYS_USER_ID', 'USER_UID', 'USER_NAME', 'USER_LANG', 'AGENT_ID', 'AGENT_NAME', 'CONVERSATION_ID', 'REQUEST_ID'];

export async function render(el, params) {
  const id = params[0] ? +params[0] : null;
  if (!id) { el.innerHTML = '<div class="empty-box">缺少智能体 ID</div>'; return; }

  let cfg, models, kbs, mcpServers, childCandidates = [], members = [];
  let pubInfo = { has: false, version: 0, nodes: 0, draftDirty: false }; // P5.9 发布快照状态
  const me = getUser() || {};
  try {
    const [ja, jm, jk, jmc, jall] = await Promise.all([
      api(`/agents/${id}/detail`), api('/chat/models'), api('/knowledge'), api('/mcp'), api('/agents'),
    ]);
    cfg = ja.data; models = jm.data; kbs = jk.data; mcpServers = jmc.data;
    pubInfo = ja.pub_wf_info || { has: false, version: 0, nodes: 0, draftDirty: false }; // P5.9 快照状态（版本/未发布改动）
    // 子智能体候选：已发布且非自身（SinguX「技能-子智能体」多智能体编排）
    childCandidates = (jall.data || []).filter(a => a.status === 'published' && a.id !== id);
    // 协作成员选择数据源（P3）：失败不阻塞页面
    try { members = (await api('/agents/members')).data || []; } catch { }
  } catch (e) {
    el.innerHTML = `<div class="empty-box"><div class="big">⚠️</div>${esc(e.message || '加载失败')}<button class="btn" style="margin-top:12px" onclick="location.hash='${me.role === 'admin' ? '#/admin/agents' : '#/agents'}'">${t('返回')}</button></div>`;
    return;
  }

  // ---------- 本地可编辑状态 ----------
  const S = {
    name: cfg.name || '', description: cfg.description || '', type: cfg.type || 'enterprise', category: cfg.category || '未分类',
    icon: cfg.icon || '🤖',
    prompt: cfg.prompt || '', user_prompt: cfg.user_prompt || '',
    model: cfg.model || '', temperature: cfg.temperature ?? 0.7, top_p: cfg.top_p ?? 0.7,
    diversity_mode: DIVERSITY[cfg.diversity_mode] ? cfg.diversity_mode : 'balanced',
    context_rounds: cfg.context_rounds ?? 10, max_reply: cfg.max_reply ?? 1024,
    kb_id: cfg.kb_id || null,
    opening: cfg.opening || '',
    opening_questions: (() => { try { return JSON.parse(cfg.opening_questions || '[]'); } catch { return []; } })(),
    tools: (() => { try { return JSON.parse(cfg.tools || '[]'); } catch { return []; } })(),
    mcp_servers: (() => { try { return JSON.parse(cfg.mcp_servers || '[]'); } catch { return []; } })(),
    long_memory: cfg.long_memory ? 1 : 0,
    allow_user_model: cfg.allow_user_model === 0 ? 0 : 1,
    suggest_enabled: cfg.suggest_enabled === 0 ? 0 : 1,
    variables: (() => { try { return JSON.parse(cfg.variables || '[]'); } catch { return []; } })(),
    child_ids: (() => { try { return JSON.parse(cfg.child_ids || '[]').map(Number); } catch { return []; } })(),
    // ⑦ 路由模式（2026-10-22 P3）：function 主模型编排（默认）/ classifier 分类器直达 / workflow 画布工作流（P5）
    routing_mode: ['function', 'classifier', 'workflow'].includes(cfg.routing_mode) ? cfg.routing_mode : 'function',
    // P5 画布工作流：{nodes,edges,viewport}（V2）
    workflow: (() => { try { return JSON.parse(cfg.workflow || 'null'); } catch { return null; } })(),
    // P5.1：编辑模式独立字段（form/canvas；不再依赖 routing_mode 推断）
    edit_mode: cfg.edit_mode === 'canvas' ? 'canvas' : 'form',
    is_official: cfg.is_official ? 1 : 0,
    allow_copy: cfg.allow_copy === 0 ? 0 : 1,
    publish_record: cfg.publish_record || '',
    status: cfg.status,
    // P3 协作与可见性
    visibility: cfg.visibility || 'public',
    visible_depts: (() => { try { return JSON.parse(cfg.visible_depts || '[]'); } catch { return []; } })(),
    visible_members: (() => { try { return JSON.parse(cfg.visible_members || '[]'); } catch { return []; } })(),
    collaborators: (() => { try { return JSON.parse(cfg.collaborators || '[]'); } catch { return []; } })(),
  };
  let baseUpdated = cfg.updated_at || ''; // 乐观锁基准：打开页面时的版本，保存成功后跟进
  let permEditable = me.role === 'admin' || (cfg.owner || '') === me.username; // 归属级：可改可见性/协作者
  let isCollaborator = S.collaborators.includes(me.username);
  let view = 'prompt'; // prompt | tools | kb | memory | exp | ui
  let promptTab = 'system'; // system | user
  // P0-3 收尾 2026-10-30：部门树缓存（collab 视图「可见部门」数据源）——
  // null=未加载/加载中，Array=树节点（[] 为空表），deptTreeFailed=true=加载失败降级文本 chips
  let deptTree = null, deptTreeFailed = false, deptTreeLoaded = false;
  let saveTimer = null, lastSavedAt = '', dirty = false;

  // ---------- 页面骨架 ----------
  el.innerHTML = `
  <style>
    .studio{display:flex;flex-direction:column;height:100vh;background:var(--bg,#f5f7fb)}
    .studio-top{display:flex;align-items:center;gap:12px;padding:10px 18px;background:var(--card,#fff);border-bottom:1px solid var(--border,#e5e7eb);flex-shrink:0}
    .studio-top .t-name{font-size:16px;font-weight:700;color:var(--text,#111827)}
    .studio-body{flex:1;display:flex;min-height:0}
    .st-left{width:250px;flex-shrink:0;background:var(--card,#fff);border-right:1px solid var(--border,#e5e7eb);overflow-y:auto;padding:10px 0}
    .st-group{padding:4px 0}
    .st-group>p{margin:0;padding:8px 16px 4px;font-size:11px;color:var(--text-3,#9ca3af);letter-spacing:1px}
    .st-item{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;font-size:13px;cursor:pointer;color:var(--text,#374151)}
    .st-item:hover{background:var(--surface-2,#f3f4f6)}
    .st-item.active{background:var(--surface-3,#eff6ff);color:var(--brand,#2563eb);font-weight:600}
    .st-item .sub{font-size:11px;color:var(--text-3,#9ca3af)}
    .st-mid{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg,#fbfbfd)}
    .st-mid-head{padding:10px 20px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--card,#fff);display:flex;align-items:center;gap:10px;flex-shrink:0}
    .st-edit{flex:1;overflow-y:auto;padding:18px 22px;color:var(--text,#111827)}
    .st-right{width:420px;flex-shrink:0;border-left:1px solid var(--border,#e5e7eb);background:var(--card,#fff);display:flex;flex-direction:column;min-height:0}
    .st-right .chat-layout .chat-side{display:none}
    .st-right .chat-layout{display:block;height:100%}
    .st-right .chat-layout .chat-main{height:100%;display:flex;flex-direction:column}
    /* P5.21 全设备适配：studio 顶栏与三栏布局的窄屏/平板重排 */
    @media (max-width: 1080px) {
      .st-right { width: 340px; }
      .st-left { width: 218px; }
    }
    @media (max-width: 768px) {
      .studio { height: 100dvh; }
      .studio-top { flex-wrap: wrap; gap: 8px; padding: 8px 10px; }
      .studio-top .t-name { font-size: 14px; }
      .studio-top #stSaved { display: none; }
      .studio-body { flex-direction: column; }
      /* 左栏配置导航 → 顶部横向滚动条（手机上纵向三栏放不下，改横滑） */
      .st-left { width: 100%; border-right: none; border-bottom: 1px solid var(--border,#e5e7eb); display: flex; overflow-x: auto; padding: 6px 8px; gap: 4px; -webkit-overflow-scrolling: touch; }
      .st-left::-webkit-scrollbar { display: none; }
      /* 右侧预览调试 → 底部可展开区（默认收起 40vh 高度上限，画布/编辑区优先） */
      .st-right { width: 100%; border-left: none; border-top: 1px solid var(--border,#e5e7eb); max-height: 42vh; }
      .st-mid-head { padding: 8px 10px; flex-wrap: wrap; }
      .st-mid-head > span:last-child { display: none; }
    }
    @media (max-width: 480px) {
      .studio-top .seg button { padding: 5px 10px; font-size: 11px; }
      .studio-top .btn { font-size: 12px; padding: 5px 10px; }
    }
    .seg{display:inline-flex;border:1px solid var(--border,#d1d5db);border-radius:8px;overflow:hidden}
    .seg button{padding:5px 14px;font-size:12px;border:none;background:var(--card,#fff);cursor:pointer;color:var(--text-2,#6b7280)}
    .seg button.on{background:var(--brand,#2563eb);color:#fff}
    .sw{position:relative;width:36px;height:20px;background:var(--border,#d1d5db);border-radius:10px;cursor:pointer;transition:.2s;flex-shrink:0}
    .sw.on{background:var(--brand,#2563eb)}
    .sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.2s}
    .sw.on::after{left:18px}
    .st-field{margin-bottom:16px}
    .st-field>label{display:block;font-size:12px;font-weight:600;color:var(--text,#374151);margin-bottom:6px}
    .st-field .hint{font-size:11px;color:var(--text-3,#9ca3af);margin-top:4px}
    .st-input,.st-select,.st-ta{width:100%;box-sizing:border-box;border:1px solid var(--border,#d1d5db);border-radius:8px;padding:8px 10px;font-size:13px;background:var(--card,#fff);color:var(--text,#111827)}
    .st-ta{resize:vertical;font-family:inherit;line-height:1.6}
    .icon-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px}
    .icon-grid span{font-size:18px;text-align:center;padding:6px 0;border-radius:6px;cursor:pointer}
    .icon-grid span:hover{background:var(--surface-3,#eff6ff)}
    .icon-grid span.on{background:var(--brand,#2563eb)}
    .mem-row{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface-2,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;font-size:12px}
    .mem-row .del{cursor:pointer;color:var(--danger,#ef4444);margin-left:auto}
    /* P3 协作与可见性 */
    .chip-pick{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .chip-pick .chip{padding:4px 10px;border:1px solid var(--border,#d1d5db);border-radius:999px;font-size:12px;cursor:pointer;color:var(--text-2,#6b7280);background:var(--card,#fff)}
    .chip-pick .chip.on{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb);color:#fff}
    .collab-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;font-size:12px;background:var(--card,#fff)}
    /* P0-3 收尾 2026-10-30：可见部门树多选组件（沿用现有 CSS 变量；变量未定义时内联兑底） */
    .dtree{border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff);max-height:260px;overflow-y:auto;padding:4px 0;margin-top:6px;font-size:12px}
    .dt-row{display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;color:var(--text,#374151)}
    .dt-row:hover{background:var(--surface-2,#f3f4f6)}
    .dt-row input[type=checkbox]{flex-shrink:0;cursor:pointer}
    .dt-row input[type=checkbox]:disabled{cursor:not-allowed}
    .dt-fold{width:16px;flex-shrink:0;text-align:center;color:var(--text-3,#9ca3af);cursor:pointer;font-size:10px;user-select:none}
    .dt-fold.leaf{cursor:default}
    .dt-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dt-cnt{font-size:10px;color:var(--text-3,#9ca3af);background:var(--surface-2,#f3f4f6);border-radius:999px;padding:1px 6px;flex-shrink:0}
    .dt-kids.collapsed{display:none}
  </style>
  <div class="studio">
    <div class="studio-top">
      <button class="btn" id="stBack">← 返回</button>
      <span id="stIcon" style="font-size:22px">${esc(S.icon)}</span>
      <div>
        <div class="t-name" id="stName">${esc(S.name)}</div>
        <div style="font-size:11px;color:var(--text-3,#9ca3af)" id="stMeta">${esc(TYPE_NAME[S.type] || S.type)} · <span id="stStatus">${S.status === 'published' ? '已发布' : '草稿'}</span><span id="stPubVer"></span></div>
      </div>
      <div style="flex:1"></div>
      <span style="font-size:12px;color:var(--text-3,#9ca3af)" id="stSaved"></span>
      <div class="seg" id="stModeSeg" title="编辑模式切换">
        <button data-m="form" class="on">📝 ${t('表单模式')}</button>
        <button data-m="canvas">🎨 ${t('画布模式')}</button>
      </div>
      <button class="btn" id="stSave">${t('保存')}</button>
      <button class="btn" id="stVersionBtn" title="${t('发布版本历史（快照/说明/一键回滚）')}">🕘 ${t('版本')}</button>
      <button class="btn primary" id="stPublish">${S.status === 'published' ? '下架' : '发布'}</button>
    </div>
    <div class="studio-body" id="stBody">
      <div id="stFormArea" style="display:flex;flex:1;min-height:0">
      <aside class="st-left" id="stLeft"></aside>
      <div class="st-mid">
        <div class="st-mid-head">
          <span style="font-size:13px;font-weight:600;color:var(--text,#374151)">🧠 ${t('会话模型')}</span>
          <button class="btn sm" id="stModelBtn">${esc(S.model || t('未选择（用平台默认）'))}</button>
          <div style="flex:1"></div>
          <span style="font-size:11px;color:var(--text-3,#9ca3af)">${t('编排修改后约 2 秒自动保存')}</span>
        </div>
        <div class="st-edit" id="stEdit"></div>
      </div>
      <div class="st-right" id="stRight">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border,#e5e7eb);font-size:13px;font-weight:700;flex-shrink:0;color:var(--text,#111827)">🖥️ ${t('预览与调试')}</div>
        <div id="stChat" style="flex:1;min-height:0"></div>
      </div>
      </div>
      <div id="stCanvasArea" style="display:none;flex:1;min-height:0"></div>
    </div>
  </div>`;

  const $ = sel => el.querySelector(sel);

  // ---------- 左栏：六大配置区块 ----------
  function renderLeft() {
    const sections = [
      { group: '提示词', items: [
        { key: 'prompt', icon: '✍️', label: '提示词设定', sub: S.prompt ? '已配置' : '待配置' },
      ] },
      { group: '工具', items: [
        { key: 'tools', icon: '🛠️', label: '插件与工具', sub: `${S.tools.length + S.mcp_servers.length} 个 · ${S.child_ids.length} 子智能体` },
      ] },
      { group: '知识', items: [
        { key: 'kb', icon: '📚', label: '文本知识库', sub: S.kb_id ? (kbs.find(k => k.id === S.kb_id)?.name || '已关联') : '未关联' },
      ] },
      { group: '记忆', items: [
        { key: 'memory', icon: '🧠', label: '变量与长期记忆', sub: `${S.variables.length} 变量 · ${S.long_memory ? '记忆开' : '记忆关'}` },
      ] },
      { group: '对话体验', items: [
        { key: 'exp', icon: '💬', label: '体验设置', sub: `${S.suggest_enabled ? '建议开' : '建议关'} · ${S.allow_user_model ? '可选模型' : '锁定模型'}` },
      ] },
      { group: '界面配置', items: [
        { key: 'ui', icon: '🎨', label: t('开场白与形象'), sub: S.opening ? t('已配置') : t('待配置') },
      ] },
      { group: t('协作'), items: [
        { key: 'collab', icon: '👥', label: t('协作与可见性'), sub: S.visibility === 'restricted' ? t('受限') + ` · ${S.visible_depts.length + S.visible_members.length} ${t('可见')}` : t('全员'), },
      ] },
    ];
    $('#stLeft').innerHTML = sections.map(sec => `
      <div class="st-group"><p>${esc(sec.group)}</p>
        ${sec.items.map(it => `<div class="st-item ${view === it.key ? 'active' : ''}" data-view="${it.key}">
          <span>${it.icon} ${esc(it.label)}</span><span class="sub">${esc(it.sub)}</span></div>`).join('')}
      </div>`).join('');
    $('#stLeft').querySelectorAll('[data-view]').forEach(d => d.onclick = () => { view = d.dataset.view; renderLeft(); renderEdit(); });
  }

  // ---------- 中栏：编辑区 ----------
  function renderEdit() {
    const box = $('#stEdit');
    if (view === 'prompt') {
      box.innerHTML = `
        <div class="seg" style="margin-bottom:12px">
          <button data-pt="system" class="${promptTab === 'system' ? 'on' : ''}">系统提示词</button>
          <button data-pt="user" class="${promptTab === 'user' ? 'on' : ''}">用户提示词</button>
          <div style="flex:1"></div>
        </div>
        ${promptTab === 'system' ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-2,#6b7280)">对大模型进行角色塑造（支持变量占位符 {{USER_NAME}} 等）</span>
            <button class="btn sm" id="stOptimize">✨ AI 优化</button>
          </div>
          <textarea class="st-ta" id="edPrompt" rows="16" placeholder="# 角色&#10;你是…">${esc(S.prompt)}</textarea>
        ` : `
          <div style="font-size:12px;color:var(--text-2,#6b7280);margin-bottom:8px">预置指令、问题或请求——对话时自动填入用户输入框，可修改后发送</div>
          <textarea class="st-ta" id="edUserPrompt" rows="14" placeholder="如：请帮我总结这篇研报的核心观点">${esc(S.user_prompt)}</textarea>
        `}`;
      box.querySelectorAll('[data-pt]').forEach(b => b.onclick = () => { promptTab = b.dataset.pt; renderEdit(); });
      const p = box.querySelector('#edPrompt');
      if (p) {
        p.oninput = () => { S.prompt = p.value; scheduleSave(); };
        box.querySelector('#stOptimize').onclick = async () => {
          const btn = box.querySelector('#stOptimize');
          btn.disabled = true; btn.textContent = '优化中…';
          try {
            const j = await api('/agents/optimize-prompt', { method: 'POST', body: { name: S.name, description: S.description, prompt: S.prompt } });
            S.prompt = j.data.prompt; renderEdit(); toast('已生成结构化提示词'); scheduleSave();
          } catch (e) { toast(e.message, 'err'); }
          btn.disabled = false; btn.textContent = '✨ AI 优化';
        };
      }
      const up = box.querySelector('#edUserPrompt');
      if (up) up.oninput = () => { S.user_prompt = up.value; scheduleSave(); };
    }

    if (view === 'tools') {
      box.innerHTML = `
        <div class="st-field"><label>内置工具（Function Calling，多选）</label>
          ${Object.entries(TOOL_META).map(([k, m]) => `
            <label style="display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--card,#fff)">
              <input type="checkbox" data-tool="${k}" ${S.tools.includes(k) ? 'checked' : ''}>
              <span>${m.icon} <b>${m.label}</b></span>
              <span style="font-size:11px;color:var(--text-3,#9ca3af)">${m.tip}</span>
            </label>`).join('')}
        </div>
        <div class="st-field"><label>MCP 服务挂载（多选，工具名 mcp_ 前缀）</label>
          ${mcpServers.length ? mcpServers.map(m => `
            <label style="display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--card,#fff)">
              <input type="checkbox" data-mcp="${m.id}" ${S.mcp_servers.includes(m.id) ? 'checked' : ''}>
              <span>🧩 <b>${esc(m.name)}</b></span>
              <span style="font-size:11px;color:var(--text-3,#9ca3af)">状态 ${m.status ? '启用' : '停用'}</span>
            </label>`).join('') : '<div class="hint">暂无已注册的 MCP 服务（可在「MCP 服务」页注册）</div>'}
        </div>
        <div class="st-field"><label>子智能体编排（SinguX 式多智能体：本智能体作编排器，按需路由到子智能体执行）</label>
          ${childCandidates.length ? childCandidates.map(c => `
            <label style="display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--card,#fff)">
              <input type="checkbox" data-child="${c.id}" ${S.child_ids.includes(c.id) ? 'checked' : ''}>
              <span>${esc(c.icon || '🤖')} <b>${esc(c.name)}</b></span>
              <span style="font-size:11px;color:var(--text-3,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((c.description || '').slice(0, 40))}</span>
            </label>`).join('') : '<div class="hint">暂无可选的已发布智能体（先发布其他智能体后可挂为子智能体）</div>'}
          <div class="hint">开启后对话时主模型自动判断并把任务分给子智能体（各带自己的提示词/模型/知识库），适合「1 编排器 + N 专家」架构</div>
          <div class="st-field" style="margin-top:10px"><label>路由模式（到达子智能体的方式）</label>
            <div style="display:flex;gap:10px">
              <label style="flex:1;display:flex;gap:6px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;cursor:pointer;background:var(--card,#fff)">
                <input type="radio" name="rtMode" value="function" ${S.routing_mode === 'function' ? 'checked' : ''}>
                <span><b>🤖 主模型编排</b>（默认）<br><span style="font-size:11px;color:var(--text-3,#9ca3af)">function calling：主模型自主决定何时调用哪个子智能体，可多轮协作</span></span>
              </label>
              <label style="flex:1;display:flex;gap:6px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;cursor:pointer;background:var(--card,#fff)">
                <input type="radio" name="rtMode" value="classifier" ${S.routing_mode === 'classifier' ? 'checked' : ''}>
                <span><b>🧭 分类器直达</b><br><span style="font-size:11px;color:var(--text-3,#9ca3af)">先意图分类，高置信直接交给子智能体（更快更省）；低置信自动回退主模型</span></span>
              </label>
              <label style="flex:1;display:flex;gap:6px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;cursor:pointer;background:var(--card,#fff)">
                <input type="radio" name="rtMode" value="workflow" ${S.routing_mode === 'workflow' ? 'checked' : ''}>
                <span><b>🎨 画布工作流</b><br><span style="font-size:11px;color:var(--text-3,#9ca3af)">按画布编排的节点图执行（切换到「画布模式」搭建流程，含分支/工具/子智能体节点）</span></span>
              </label>
            </div>
          </div>
        </div>`;
      box.querySelectorAll('[data-tool]').forEach(c => c.onchange = () => {
        S.tools = [...box.querySelectorAll('[data-tool]:checked')].map(x => x.dataset.tool);
        scheduleSave(); renderLeft();
      });
      box.querySelectorAll('[data-mcp]').forEach(c => c.onchange = () => {
        S.mcp_servers = [...box.querySelectorAll('[data-mcp]:checked')].map(x => +x.dataset.mcp);
        scheduleSave(); renderLeft();
      });
      box.querySelectorAll('[data-child]').forEach(c => c.onchange = () => {
        S.child_ids = [...box.querySelectorAll('[data-child]:checked')].map(x => +x.dataset.child);
        scheduleSave(); renderLeft();
      });
      box.querySelectorAll('input[name="rtMode"]').forEach(r => r.onchange = () => {
        S.routing_mode = r.value;
        scheduleSave();
      });
    }

    if (view === 'kb') {
      box.innerHTML = `
        <div class="st-field"><label>关联文本知识库（RAG 检索增强）</label>
          <select class="st-select" id="edKb">
            <option value="">不关联</option>
            ${kbs.map(k => `<option value="${k.id}" ${S.kb_id === k.id ? 'selected' : ''}>📚 ${esc(k.name)}（${k.doc_count || 0} 文档）</option>`).join('')}
          </select>
          <div class="hint">对话时自动检索关联知识库并注入上下文，回答带来源编号</div>
        </div>`;
      $('#edKb').onchange = e => { S.kb_id = e.target.value ? +e.target.value : null; scheduleSave(); renderLeft(); };
    }

    if (view === 'memory') {
      box.innerHTML = `
        <div class="st-field"><label>长期记忆</label>
          <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff)">
            <div class="sw ${S.long_memory ? 'on' : ''}" id="swMem"></div>
            <div style="flex:1"><b style="font-size:13px">跨会话记住用户特征</b>
              <div class="hint">开启后每轮对话自动提取值得记住的用户特征（职业/偏好/称呼），后续对话自动注入，无需重复告知</div></div>
          </div>
          <div id="memFacts" style="margin-top:10px"></div>
        </div>
        <div class="st-field"><label>自定义变量（用户特征）</label>
          <div class="hint" style="margin-bottom:8px">用于保存用户个人信息，让智能体记住用户的特征，使回复更加个性化。对话中自然获取。</div>
          <div style="margin-bottom:8px;padding:8px 10px;background:var(--surface-2,#f9fafb);border:1px dashed #d1d5db;border-radius:8px;font-size:11px;color:var(--text-2,#6b7280)">
            系统变量（提示词中可直接用 {{变量名}} 占位）：${SYS_VARS.map(v => '{{' + v + '}}').join(' ')}
          </div>
          <div id="varList"></div>
          <button class="btn sm" id="addVar">＋ 添加变量</button>
        </div>`;
      $('#swMem').onclick = async () => {
        S.long_memory = S.long_memory ? 0 : 1; scheduleSave(); renderEdit(); renderLeft();
      };
      renderMemFacts(); renderVars();
      $('#addVar').onclick = () => { S.variables.push({ name: '', desc: '' }); renderVars(); };
    }

    if (view === 'exp') {
      box.innerHTML = `
        <div class="st-field"><label>对话体验设置</label>
          <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:8px;background:var(--card,#fff)">
            <div class="sw ${S.suggest_enabled ? 'on' : ''}" id="swSug"></div>
            <div style="flex:1"><b style="font-size:13px">用户问题建议</b>
              <div class="hint">回复完成后自动推荐 3 条追问，点击即可继续对话</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:8px;background:var(--card,#fff)">
            <div class="sw ${S.allow_user_model ? 'on' : ''}" id="swModel"></div>
            <div style="flex:1"><b style="font-size:13px">允许用户选择自有模型</b>
              <div class="hint">关闭后对话页隐藏模型下拉，锁定为编排配置的会话模型</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff)">
            <span style="font-size:20px">⏰</span>
            <div style="flex:1"><b style="font-size:13px">定时任务</b>
              <div class="hint">让智能体定时自动执行任务（Cron）</div></div>
            <a class="btn sm" href="#/tasks" target="_self">前往任务中心</a>
          </div>
        </div>`;
      $('#swSug').onclick = () => { S.suggest_enabled = S.suggest_enabled ? 0 : 1; scheduleSave(); renderEdit(); renderLeft(); };
      $('#swModel').onclick = () => { S.allow_user_model = S.allow_user_model ? 0 : 1; scheduleSave(); renderEdit(); renderLeft(); };
    }

    if (view === 'ui') {
      box.innerHTML = `
        <div class="st-field"><label>名称与类型</label>
          <input class="st-input" id="edName" value="${esc(S.name)}" maxlength="50" style="margin-bottom:8px" placeholder="智能体名称（50 字内）">
          <textarea class="st-ta" id="edDesc" rows="2" style="margin-bottom:8px" placeholder="智能体功能介绍，将展示给用户">${esc(S.description)}</textarea>
          <select class="st-select" id="edType">
            ${Object.entries(TYPE_NAME).map(([k, v]) => `<option value="${k}" ${S.type === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="st-field"><label>图标</label>
          <div class="icon-grid" id="iconGrid">
            ${ICON_POOL.map(ic => `<span class="${S.icon === ic ? 'on' : ''}" data-ic="${ic}">${ic}</span>`).join('')}
          </div>
        </div>
        <div class="st-field"><label>开场白文案</label>
          <textarea class="st-ta" id="edOpening" rows="3" placeholder="您好！我是…，可以帮您…">${esc(S.opening)}</textarea>
        </div>
        <div class="st-field"><label>开场白预置问题</label>
          <div id="oqList"></div>
          <button class="btn sm" id="addOq">＋ 添加预置问题</button>
        </div>`;
      $('#edName').oninput = e => { S.name = e.target.value; $('#stName').textContent = S.name; scheduleSave(); };
      $('#edDesc').oninput = e => { S.description = e.target.value; scheduleSave(); };
      $('#edType').onchange = e => { S.type = e.target.value; $('#stMeta').textContent = `${TYPE_NAME[S.type]} · ${S.status === 'published' ? '已发布' : '草稿'}`; scheduleSave(); };
      $('#edOpening').oninput = e => { S.opening = e.target.value; scheduleSave(); renderLeft(); };
      $('#iconGrid').querySelectorAll('[data-ic]').forEach(s => s.onclick = () => {
        S.icon = s.dataset.ic; $('#stIcon').textContent = S.icon;
        $('#iconGrid').querySelectorAll('span').forEach(x => x.classList.toggle('on', x === s));
        scheduleSave();
      });
      $('#addOq').onclick = () => { S.opening_questions.push(''); renderOq(); };
      renderOq();
    }

    // ---------- P3 协作与可见性 ----------
    if (view === 'collab') {
      // P0-3 收尾 2026-10-30：可见部门数据源改为部门树（GET /departments/tree，进入视图懒加载一次）；
      // 请求失败静默回落 members 文本派生 chips（下方 deptTreeFailed 分支，降级路径必须保留）
      if (!deptTreeLoaded) {
        deptTreeLoaded = true;
        api('/departments/tree')
          .then(j => { deptTree = Array.isArray(j.data) ? j.data : []; if (view === 'collab') renderEdit(); })
          .catch(() => { deptTreeFailed = true; if (view === 'collab') renderEdit(); }); // 静默降级不弹错
      }
      const memberName = u => { const m = members.find(x => x.username === u); return m ? (m.nickname || m.username) : u; };
      const notMe = u => u !== me.username;
      // P0-3 收尾 2026-10-30：visible_depts 分流——纯数字 = 部门树 ID（新格式，树勾选产生）；
      // 非纯数字 = 历史文本部门名（旧格式 users.dept 文本，单独 chip 展示可移除）
      const legacyDepts = S.visible_depts.map(String).filter(x => !/^\d+$/.test(x));
      const idPicked = S.visible_depts.map(String).filter(x => /^\d+$/.test(x));
      // 部门树节点递归渲染：层级深度缩进 + 折叠箭头（默认全展开）+ 复选框（ID 已选初始勾选；协作者只读 disabled）
      const nodeHtml = (n, depth) => `
        <div class="dt-node">
          <label class="dt-row" style="padding-left:${10 + depth * 18}px">
            <span class="dt-fold ${n.children?.length ? '' : 'leaf'}" data-fold="${n.id}">${n.children?.length ? '▾' : '·'}</span>
            <input type="checkbox" data-dtid="${n.id}" ${idPicked.includes(String(n.id)) ? 'checked' : ''} ${permEditable ? '' : 'disabled'}>
            <span class="dt-name" title="${esc(n.path || '')}">${esc(n.name)}</span>
            ${n.children?.length ? `<span class="dt-cnt">${n.children.length}</span>` : ''}
          </label>
          ${n.children?.length ? `<div class="dt-kids" data-kids="${n.id}">${n.children.map(c => nodeHtml(c, depth + 1)).join('')}</div>` : ''}
        </div>`;
      // 可见部门区块：树优先 → 空表提示 → 加载中 → 失败降级文本 chips（旧交互完整保留）
      let deptArea = '';
      if (deptTreeFailed) {
        const allDepts = [...new Set(members.map(m => m.dept).filter(Boolean))];
        deptArea = `<div class="chip-pick" id="deptChips">${allDepts.length ? allDepts.map(d => `<span class="chip ${S.visible_depts.map(String).includes(d) ? 'on' : ''}" data-dept="${esc(d)}">${esc(d)}</span>`).join('') : `<span class="hint">${t('暂无部门数据（先在用户管理中为用户设置部门）')}</span>`}</div>
            <div class="hint">⚠️ ${t('部门树加载失败，已降级为文本部门选择')}</div>`;
      } else if (deptTree === null) {
        deptArea = `<div class="hint">⏳ ${t('部门树加载中…')}</div>`;
      } else if (!deptTree.length) {
        deptArea = `<div class="hint">🏢 ${t('暂无部门数据，请先在管理后台维护组织架构')}</div>`;
      } else {
        deptArea = `<div class="dtree" id="deptTree">${deptTree.map(n => nodeHtml(n, 0)).join('')}</div>`;
      }
      // 历史文本部门（部门树上线前保存的旧格式）：单独 chip 列表展示，✕ 可移除
      const legacyArea = legacyDepts.length ? `
            <div style="font-size:12px;font-weight:600;color:var(--text,#374151);margin:10px 0 4px">${t('历史部门')}（${legacyDepts.length}）</div>
            <div class="chip-pick" id="legacyDeptChips">${legacyDepts.map(d => `<span class="chip on" data-legacy="${esc(d)}">${esc(d)}${permEditable ? ' ✕' : ''}</span>`).join('')}</div>
            <div class="hint">${t('历史文本部门，建议在组织架构中建对应部门后改用部门树')}</div>` : '';
      box.innerHTML = `
        <div class="st-field"><label>👥 ${t('协作与可见性')}</label>
          <div class="hint" style="margin-bottom:10px">${t('控制谁能在智能体列表与对话中看到该智能体；创建者与协作者始终可见（含草稿）。')}</div>
          <label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--card,#fff)">
            <input type="radio" name="vis" value="public" ${S.visibility !== 'restricted' ? 'checked' : ''} ${permEditable ? '' : 'disabled'}>
            <span><b style="font-size:13px">${t('全员可见')}</b><span style="font-size:11px;color:var(--text-3,#9ca3af);margin-left:6px">${t('发布后全员可用，可上架广场')}</span></span>
          </label>
          <label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:8px;cursor:pointer;background:var(--card,#fff)">
            <input type="radio" name="vis" value="restricted" ${S.visibility === 'restricted' ? 'checked' : ''} ${permEditable ? '' : 'disabled'}>
            <span><b style="font-size:13px">${t('受限可见')}</b><span style="font-size:11px;color:var(--text-3,#9ca3af);margin-left:6px">${t('仅指定部门/成员可见；不广播、不上广场')}</span></span>
          </label>
          <div id="restrictArea" style="display:${S.visibility === 'restricted' ? '' : 'none'};margin-top:10px;padding:12px;border:1px dashed var(--border,#d1d5db);border-radius:10px">
            <div style="font-size:12px;font-weight:600;color:var(--text,#374151);margin-bottom:6px">${t('可见部门')}</div>
            ${deptArea}${legacyArea}
            <div style="font-size:12px;font-weight:600;color:var(--text,#374151);margin:12px 0 6px">${t('可见成员')}</div>
            <select class="st-select" id="memberPick" style="max-width:280px">
              <option value="">${t('＋ 添加可见成员…')}</option>
              ${members.filter(m => !S.visible_members.includes(m.username)).map(m => `<option value="${esc(m.username)}">${esc(m.nickname || m.username)}${m.dept ? ' · ' + esc(m.dept) : ''}</option>`).join('')}
            </select>
            <div class="chip-pick" id="memberChips">${S.visible_members.map(u => `<span class="chip on" data-member="${esc(u)}">${esc(memberName(u))} ✕</span>`).join('') || `<span class="hint">${t('未指定成员')}</span>`}</div>
          </div>
        </div>
        <div class="st-field"><label>🤝 ${t('协作编辑者')}（${t('多人共同配置一个智能体')}）</label>
          <div class="hint" style="margin-bottom:8px">${t('协作者可进入本编排页共同编辑配置（含提示词/模型/知识库），但不能删除智能体或修改可见范围。企业版权益。')}</div>
          ${permEditable ? `
          <select class="st-select" id="collabPick" style="max-width:280px">
            <option value="">${t('＋ 添加协作编辑者…')}</option>
            ${members.filter(m => !S.collaborators.includes(m.username) && notMe(m.username) && m.username !== cfg.owner).map(m => `<option value="${esc(m.username)}">${esc(m.nickname || m.username)}${m.dept ? ' · ' + esc(m.dept) : ''}${m.role === 'admin' ? ' · ' + t('管理员') : ''}</option>`).join('')}
          </select>` : `<div class="hint">${t('仅创建者与管理员可管理协作者')}</div>`}
          <div id="collabList" style="margin-top:8px">
            ${S.collaborators.filter(notMe).map(u => `
              <div class="collab-row">✍️ <b>${esc(memberName(u))}</b><span style="color:var(--text-3,#9ca3af)">@${esc(u)}</span>
                ${permEditable ? `<span class="del" data-cdel="${esc(u)}">✕</span>` : ''}</div>`).join('') || `<div class="hint">${t('暂无协作者，当前仅你可编辑')}</div>`}
          </div>
          ${cfg.owner ? `<div class="hint" style="margin-top:8px">${t('创建者')}：${esc(memberName(cfg.owner))} @${esc(cfg.owner)}</div>` : ''}
        </div>`;
      // 单选可见范围
      box.querySelectorAll('input[name="vis"]').forEach(r => r.onchange = () => {
        S.visibility = r.value; scheduleSave(); renderEdit(); renderLeft();
      });
      // P0-3 收尾 2026-10-30：部门树勾选——勾选把 String(dept.id) 存入 S.visible_depts，取消移除；2 秒自动保存
      box.querySelectorAll('#deptTree input[data-dtid]').forEach(c => c.onchange = () => {
        const idStr = String(c.dataset.dtid);
        if (c.checked) { if (!S.visible_depts.map(String).includes(idStr)) S.visible_depts.push(idStr); }
        else S.visible_depts = S.visible_depts.filter(x => String(x) !== idStr);
        scheduleSave();
      });
      // 部门树折叠/展开（默认全展开）：阻止 label 默认行为，避免点箭头误切换复选框
      box.querySelectorAll('#deptTree .dt-fold:not(.leaf)').forEach(f => f.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        const kids = box.querySelector(`#deptTree .dt-kids[data-kids="${f.dataset.fold}"]`);
        if (!kids) return;
        const collapsed = kids.classList.toggle('collapsed');
        f.textContent = collapsed ? '▸' : '▾';
      });
      // 历史文本部门 chip：点击移除（协作者只读无 ✕，与现有 radio disabled 一致）
      box.querySelectorAll('#legacyDeptChips .chip').forEach(c => c.onclick = () => {
        if (!permEditable) return;
        S.visible_depts = S.visible_depts.filter(x => String(x) !== c.dataset.legacy);
        scheduleSave(); renderEdit();
      });
      // 降级路径：文本部门 chips（树加载失败时旧交互保留；协作者只读保护与 radio disabled 一致）
      box.querySelectorAll('#deptChips .chip').forEach(c => c.onclick = () => {
        if (!permEditable) return;
        const d = c.dataset.dept;
        if (S.visible_depts.map(String).includes(d)) S.visible_depts = S.visible_depts.filter(x => String(x) !== d);
        else S.visible_depts.push(d);
        c.classList.toggle('on'); scheduleSave();
      });
      // 成员 chips
      const mp = box.querySelector('#memberPick');
      if (mp) mp.onchange = () => {
        if (!mp.value) return;
        S.visible_members.push(mp.value); scheduleSave(); renderEdit();
      };
      box.querySelectorAll('#memberChips .chip').forEach(c => c.onclick = () => {
        S.visible_members = S.visible_members.filter(u => u !== c.dataset.member);
        scheduleSave(); renderEdit();
      });
      // 协作者
      const cp = box.querySelector('#collabPick');
      if (cp) cp.onchange = async () => {
        if (!cp.value) return;
        S.collaborators.push(cp.value); scheduleSave(); renderEdit();
      };
      box.querySelectorAll('[data-cdel]').forEach(d => d.onclick = () => {
        S.collaborators = S.collaborators.filter(u => u !== d.dataset.cdel);
        scheduleSave(); renderEdit();
      });
    }
  }

  // 记忆事实列表
  async function renderMemFacts() {
    const box = el.querySelector('#memFacts');
    if (!box) return;
    try {
      const j = await api(`/agents/${id}/memories`);
      box.innerHTML = j.data.length ? `
        <div style="font-size:12px;font-weight:600;color:var(--text,#374151);margin-bottom:6px">已记住 ${j.data.length} 条用户特征</div>
        ${j.data.slice(0, 10).map(m => `<div class="mem-row">📌 ${esc(m.fact)}<span style="color:var(--text-3,#9ca3af);font-size:10px">${esc((m.created_at || '').slice(5, 10))}</span></div>`).join('')}
        ${j.data.length > 10 ? `<div class="hint">仅显示最近 10 条</div>` : ''}
        <button class="btn sm danger" id="clearMem" style="margin-top:6px">清空记忆</button>` :
        '<div class="hint">暂无记忆。开启长期记忆并对话后，系统自动提取用户特征。</div>';
      const btn = el.querySelector('#clearMem');
      if (btn) btn.onclick = async () => {
        if (!await confirmBox('清空该智能体对当前用户的全部记忆？')) return;
        await api(`/agents/${id}/memories`, { method: 'DELETE' });
        toast('已清空'); renderMemFacts();
      };
    } catch { box.innerHTML = '<div class="hint">记忆加载失败</div>'; }
  }

  // 变量列表编辑
  function renderVars() {
    const box = el.querySelector('#varList');
    if (!box) return;
    box.innerHTML = S.variables.map((v, i) => `
      <div class="mem-row">
        <input class="st-input" style="width:150px" data-vn="${i}" value="${esc(v.name || '')}" placeholder="变量名（如 user_role）">
        <input class="st-input" style="flex:1" data-vd="${i}" value="${esc(v.desc || '')}" placeholder="描述（如 用户所属业务条线）">
        <span class="del" data-vdel="${i}">✕</span>
      </div>`).join('') || '<div class="hint" style="margin-bottom:6px">暂无自定义变量</div>';
    box.querySelectorAll('[data-vn]').forEach(inp => inp.oninput = () => { S.variables[+inp.dataset.vn].name = inp.value.trim(); scheduleSave(); });
    box.querySelectorAll('[data-vd]').forEach(inp => inp.oninput = () => { S.variables[+inp.dataset.vd].desc = inp.value; scheduleSave(); });
    box.querySelectorAll('[data-vdel]').forEach(d => d.onclick = () => { S.variables.splice(+d.dataset.vdel, 1); renderVars(); renderLeft(); scheduleSave(); });
  }

  // 预置问题编辑
  function renderOq() {
    const box = el.querySelector('#oqList');
    if (!box) return;
    box.innerHTML = S.opening_questions.map((q, i) => `
      <div class="mem-row">
        <input class="st-input" style="flex:1" data-oq="${i}" value="${esc(q)}" placeholder="预置问题，如：帮我总结平台功能">
        <span class="del" data-oqdel="${i}">✕</span>
      </div>`).join('') || '<div class="hint" style="margin-bottom:6px">暂无预置问题</div>';
    box.querySelectorAll('[data-oq]').forEach(inp => inp.oninput = () => { S.opening_questions[+inp.dataset.oq] = inp.value; scheduleSave(); });
    box.querySelectorAll('[data-oqdel]').forEach(d => d.onclick = () => { S.opening_questions.splice(+d.dataset.oqdel, 1); renderOq(); scheduleSave(); });
  }

  // ---------- 模型设置弹窗 ----------
  // P5.18 模型透明化：全量分组——对话模型可选，其他类型禁用展示并标注去向（表单模式智能体为纯对话式）
  const TYPE_TAG = { image: '🎨 生图', video: '🎬 视频', tts: '🎙️ 语音', embedding: '🧠 嵌入' };
  const TYPE_GUIDE = { image: '画布「文生图」工具节点', video: '前台视频创作模式', tts: '画布「语音合成」工具节点', embedding: '知识库检索用' };
  function modelOptionsForm(sel) {
    const chats = (models || []).filter(m => (m.type || 'chat') === 'chat');
    const others = (models || []).filter(m => (m.type || 'chat') !== 'chat');
    return `<option value="">跟随平台默认供应商</option>` +
      (chats.length ? `<optgroup label="💬 对话模型（会话可用）">${chats.map(m => `<option value="${esc(m.name)}" ${sel === m.name ? 'selected' : ''}>${esc(m.name)}${m.real ? '' : '（演示）'}</option>`).join('')}</optgroup>` : '') +
      (others.length ? `<optgroup label="其他类型模型（会话不可用，仅供查看）">${others.map(m => `<option disabled>⛔ ${esc(m.name)} · ${TYPE_TAG[m.type] || m.type}——${TYPE_GUIDE[m.type] || ''}</option>`).join('')}</optgroup>` : '');
  }
  function openModelCfg() {
    const body = `
      <div class="st-field"><label>会话模型</label>
        <select class="st-select" id="mdModel">
          ${modelOptionsForm(S.model)}
        </select>
        <div class="hint" style="margin-top:4px;font-size:11px;color:var(--text-3)">💡 平台共 ${ (models || []).length } 个模型：对话 ${(models || []).filter(m => (m.type || 'chat') === 'chat').length} 个可选；生图/视频/语音模型各有专用入口（已在下方标注）</div>
      </div>
      <div class="st-field"><label>生成多样性</label>
        <div class="seg" id="mdSeg">
          ${Object.entries(DIVERSITY).map(([k, v]) => `<button data-dm="${k}" class="${S.diversity_mode === k ? 'on' : ''}">${v.label}</button>`).join('')}
        </div>
      </div>
      <div class="st-field"><label>生成随机性 temperature（0~2，调高更发散，降低更遵循指令）</label>
        <input class="st-input" id="mdTemp" type="number" step="0.1" min="0" max="2" value="${S.temperature}">
      </div>
      <div class="st-field"><label>Top p（0~1，累计概率采样，建议不与 temperature 同时大幅调整）</label>
        <input class="st-input" id="mdTopP" type="number" step="0.05" min="0" max="1" value="${S.top_p}">
      </div>
      <div class="st-field"><label>携带上下文轮数（越多越连贯，Token 消耗越大）</label>
        <input class="st-input" id="mdRounds" type="number" step="1" min="0" max="100" value="${S.context_rounds}">
      </div>
      <div class="st-field"><label>最大回复长度（Tokens，100 Tokens ≈ 150 汉字）</label>
        <input class="st-input" id="mdMax" type="number" step="128" min="128" max="32768" value="${S.max_reply}">
      </div>`;
    modal({
      title: '🧠 模型设置', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>确定</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        const seg = mask.querySelector('#mdSeg');
        seg.querySelectorAll('[data-dm]').forEach(b => b.onclick = () => {
          const k = b.dataset.dm;
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          if (k !== 'custom') { // 预设模式自动填参数
            mask.querySelector('#mdTemp').value = DIVERSITY[k].t;
            mask.querySelector('#mdTopP').value = DIVERSITY[k].p;
          }
          mask.querySelector('#mdModel').dataset.dm = k;
        });
        // 手动改参数 = 切到自定义
        ['#mdTemp', '#mdTopP'].forEach(s => mask.querySelector(s).oninput = () => {
          mask.querySelector('#mdModel').dataset.dm = 'custom';
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.dm === 'custom'));
        });
        mask.querySelector('[data-save]').onclick = async () => {
          const dm = mask.querySelector('#mdModel').dataset.dm || S.diversity_mode;
          S.model = mask.querySelector('#mdModel').value;
          S.diversity_mode = dm;
          S.temperature = +mask.querySelector('#mdTemp').value || 0.7;
          S.top_p = +mask.querySelector('#mdTopP').value || 0.7;
          S.context_rounds = +mask.querySelector('#mdRounds').value || 10;
          S.max_reply = +mask.querySelector('#mdMax').value || 1024;
          $('#stModelBtn').textContent = S.model || '未选择（用平台默认）';
          await save(true);
          close();
        };
      },
    });
  }

  // ---------- 保存（自动 + 手动；P3：携带乐观锁基准，冲突时弹窗由用户决定覆盖或刷新） ----------
  let lastConflictAt = 0;
  async function save(silent, force) {
    const payload = {
      name: S.name, description: S.description, type: S.type, category: S.category,
      prompt: S.prompt, user_prompt: S.user_prompt,
      model: S.model, temperature: S.temperature, top_p: S.top_p, diversity_mode: S.diversity_mode,
      icon: S.icon, context_rounds: S.context_rounds, max_reply: S.max_reply,
      opening: S.opening, opening_questions: S.opening_questions.filter(Boolean),
      kb_id: S.kb_id, tools: S.tools, mcp_servers: S.mcp_servers,
      long_memory: S.long_memory, allow_user_model: S.allow_user_model, suggest_enabled: S.suggest_enabled,
      variables: S.variables.filter(v => v.name),
      child_ids: S.child_ids,
      routing_mode: S.routing_mode,
      // P5 画布工作流：画布模式取画布实时数据；表单模式保留已存（切换过画布后 cvAPI 已就绪则取最新）
      workflow: (studioMode === 'canvas' || cvAPI) ? (cvAPI ? cvAPI.getWorkflow() : S.workflow) : S.workflow,
      edit_mode: S.edit_mode || 'form',
      // P3 协作与可见性（仅归属级字段会被后端采纳，协作者提交自动忽略）
      visibility: S.visibility, visible_depts: S.visible_depts, visible_members: S.visible_members, collaborators: S.collaborators,
      base_updated_at: baseUpdated, // 乐观锁基准
      force: !!force,
    };
    // P5.12 保存时自动校验：画布模式跑一遍（悬空引用/孤立节点/必填缺失）——
    // 不拦截保存（草稿要能存）但弹报告+画布红点；silent 自动保存只在「有 error 级且首次」提示，手动保存每次弹
    let validationResult = null;
    if ((studioMode === 'canvas' || cvAPI) && cvAPI && payload.workflow?.nodes?.length) {
      validationResult = cvAPI.validate();
      if (validationResult.problems.length) {
        await reportValidation(validationResult, silent);
      } else cvAPI.clearValidation();
    }
    try {
      const j = await api(`/agents/${id}`, { method: 'PUT', body: payload });
      dirty = false;
      if (j.data?.updated_at) baseUpdated = j.data.updated_at; // 跟进最新版本号
      lastSavedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      $('#stSaved').textContent = `${t('草稿自动保存于')} ${lastSavedAt}`;
      if (!silent) toast(t('已保存'));
    } catch (e) {
      // 乐观锁冲突（409）：他人已修改 → 弹窗提示，刷新查看或强制覆盖（5 秒节流防自动保存期间弹窗轰炸）
      if (e.code === 409 && !force) {
        dirty = false;
        if (!silent || Date.now() - lastConflictAt > 5000) {
          lastConflictAt = Date.now();
          modal({
            title: '⚠️ ' + t('配置已被其他协作者修改'),
            body: `<div style="font-size:13px;line-height:1.9;color:var(--text-2)">${esc(e.message)}。<br>${t('为避免覆盖他人的修改，请选择：')}<br>· <b>${t('刷新查看')}</b>：${t('加载最新配置（本页未保存的修改将丢弃）')}<br>· <b>${t('仍要覆盖')}</b>：${t('以本页内容为准强制保存')}</div>`,
            foot: `<button class="btn" data-reload>${t('刷新查看')}</button><button class="btn danger" data-force>${t('仍要覆盖')}</button>`,
            onMount(mask, close) {
              mask.querySelector('[data-reload]').onclick = () => { close(); location.reload(); };
              mask.querySelector('[data-force]').onclick = async () => { close(); await save(silent, true); };
            },
          });
        }
        return;
      }
      if (!silent) toast((t('保存失败')) + '：' + e.message, 'err');
      $('#stSaved').textContent = t('保存失败');
    }
  }
  // P5.12 校验报告弹窗：error（运行必失败）/ warn（提示）分组；点击行定位节点；「仍然保存」继续，「去修复」关闭
  async function reportValidation(v, silent) {
    const errors = v.problems.filter(p => p.level === 'error');
    const warns = v.problems.filter(p => p.level === 'warn');
    // 静默自动保存：仅 error 级且与上次提示不同才弹（避免每 2s 刷屏）
    if (silent) {
      const sig = v.problems.map(p => p.nodeId + p.msg).sort().join('|');
      if (!errors.length || sig === lastValidationSig) return;
      lastValidationSig = sig;
    } else lastValidationSig = null;
    return new Promise(resolve => {
      modal({
        title: (errors.length ? '🚨 ' : '⚠️ ') + t('画布校验') + `（${errors.length} ${t('错误')} · ${warns.length} ${t('提示')}）`,
        body: `<div class="hint" style="margin-bottom:8px">${t('错误级问题运行必然失败；提示级可能不符合预期。点击行可在画布定位该节点')}。</div>
          <div style="max-height:300px;overflow-y:auto">
          ${errors.map(p => `<div class="st-vrow st-verr" data-node="${esc(p.nodeId)}"><b style="color:#dc2626">●</b><span class="code">${esc(p.nodeId)}</span><span style="flex:1">${esc(p.msg)}</span></div>`).join('')}
          ${warns.map(p => `<div class="st-vrow st-vwarn" data-node="${esc(p.nodeId)}"><b style="color:#9ca3af">●</b><span class="code">${esc(p.nodeId)}</span><span style="flex:1">${esc(p.msg)}</span></div>`).join('')}
          </div>`,
        foot: `${errors.length ? `<button class="btn" data-fix>${t('去修复')}</button><button class="btn warn" data-anyway>${t('仍然保存')}</button>` : `<button class="btn primary" data-fix>知道了</button>`}`,
        onMount(mask, close) {
          const style = document.createElement('style');
          style.textContent = '.st-vrow{display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:6px;margin-bottom:4px;font-size:12px;cursor:pointer}.st-vrow:hover{background:var(--surface-3,#eff6ff)}.st-verr{background:rgba(220,38,38,.05)}.st-vwarn{background:rgba(156,163,175,.08)}';
          mask.appendChild(style);
          mask.querySelectorAll('[data-node]').forEach(row => row.onclick = () => {
            close();
            switchMode('canvas'); // 确保画布可见
            // 定位节点：复用画布 flash（经 cvAPI 暴露）——简化：切换后选中
            setTimeout(() => { window.dispatchEvent(new CustomEvent('cv-focus-node', { detail: row.dataset.node })); }, 100);
          });
          mask.querySelector('[data-fix]')?.addEventListener('click', close);
          const anyBtn = mask.querySelector('[data-anyway]');
          if (anyBtn) anyBtn.onclick = () => { close(); resolve(true); }; // 继续保存
          else resolve(true);
        },
      });
    });
  }
  let lastValidationSig = null;

  function scheduleSave() {
    dirty = true;
    $('#stSaved').textContent = '修改中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(true), 2000);
  }

  // ---------- 顶栏事件 ----------
  $('#stBack').onclick = () => { location.hash = me.role === 'admin' ? '#/admin/agents' : '#/agents'; };
  $('#stSave').onclick = () => save(false);
  $('#stModelBtn').onclick = openModelCfg;

  // ---------- P5 画布模式：拖拽工作流编排（表单/画布双模式切换 + P5.4 双向转换） ----------
  let cvAPI = null;
  let studioMode = 'form';
  function initCanvas() {
    if (cvAPI) return;
    // P5.18 模型透明化：传全量模型（含 type）——画布分组展示，非对话模型禁用可见并标注去向
    const allModels = (models || []).map(m => ({ name: m.name, type: m.type || 'chat' }));
    cvAPI = createCanvas($('#stCanvasArea'), {
      agentId: id,
      initial: S.workflow,
      models: allModels,
      agents: childCandidates.map(a => ({ id: a.id, name: a.name, icon: a.icon })),
      markDirty: () => { if (pubInfo.has && !pubInfo.draftDirty) { pubInfo.draftDirty = true; renderPubVerBadge(); } scheduleSave(); }, // P5.9：画布真实交互才标「未发布改动」（自动保存/序列化差异不误报）
    });
  }
  // P5.4 表单→画布；P5.8 #12 无损转换：表单配置完整映射——
  // kb_id → 📚知识库检索节点（llm 前，检索结果注入提示词上下文）；
  // 内置工具 → 工具节点链（llm 后，按表单勾选顺序串联，链尾输出进 end）；
  // 提示词/模型/温度/max_reply → llm 节点。MCP 工具无画布节点类型，保留在表单字段（toast 提示）。
  function buildWorkflowFromForm() {
    const nodes = [{ id: 'start', type: 'start', position: { x: 60, y: 160 }, data: { title: '开始（输入）', variables: [] } }];
    const edges = [];
    let prev = 'start', seq = 0;
    const nid = () => 'node_' + (++seq);
    const link = () => { edges.push({ id: 'e_' + seq, source: prev, target: nodes[nodes.length - 1].id, sourceHandle: 'out' }); prev = nodes[nodes.length - 1].id; };
    // 知识库 → kb_search 节点（llm 前）
    let kbNodeId = null;
    if (S.kb_id) {
      kbNodeId = nid();
      nodes.push({ id: kbNodeId, type: 'tool', position: { x: 340, y: 40 }, data: { title: '知识库检索', toolId: 'kb_search', args: '{"query":"{{#start.input#}}","top_k":4}' } });
      link();
    }
    // 大模型节点（知识库结果作为上下文注入 prompt）
    const llmId = nid();
    nodes.push({ id: llmId, type: 'llm', position: { x: 340, y: 200 }, data: {
      title: '大模型', model: S.model || '', system_prompt: S.prompt || '',
      prompt: kbNodeId ? '{{#start.input#}}\n\n【知识库检索结果（优先依据）】\n{{#' + kbNodeId + '.result#}}' : '{{#start.input#}}',
      max_tokens: S.max_reply || 1024, temperature: S.temperature ?? 0.7,
    } });
    link();
    // 工具节点链（llm 后；仅内置工具可转换，MCP 保留表单）
    let lastOut = `${llmId}.text`;
    const builtin = (S.tools || []).filter(x => TOOL_META[x]);
    for (const tid of builtin) {
      const id = nid();
      const argKey = ['web_fetch', 'stock_quote', 'doc_review', 'export_word', 'tts'].includes(tid) ? 'input' : 'query';
      nodes.push({ id, type: 'tool', position: { x: 340, y: 200 + seq * 150 }, data: {
        title: TOOL_META[tid].label, toolId: tid, args: `{"${argKey}":"{{#start.input#}}"}`,
      } });
      link();
      lastOut = `${id}.result`;
    }
    // end 引用链尾
    nodes.push({ id: 'node_' + (++seq), type: 'end', position: { x: 340, y: 200 + seq * 150 + 60 }, data: { title: '输出（结束）', outputs: [{ variable: 'result', value: `{{#${lastOut}#}}` }] } });
    link();
    return { nodes, edges, viewport: { x: 40, y: 40, zoom: 1 }, flow_type: 'workflow', groups: [] };
  }
  // P5.8 #12 简单链判定（画布→表单回填前提）：线性链 start →（kb_search 工具节点）? → llm →（工具节点）* → end
  // （节点线性串联；P5.4 旧版仅认三节点，现放宽为含工具/知识库节点的线性链）
  function isSimpleChain(wf) {
    if (!wf || !Array.isArray(wf.nodes) || wf.nodes.length < 3) return false;
    const types = wf.nodes.map(n => n.type);
    if (types[0] !== 'start' || types[types.length - 1] !== 'end') return false;
    const llmIdx = types.indexOf('llm');
    if (llmIdx < 0) return false;
    for (let i = 1; i < types.length - 1; i++) {
      if (types[i] === 'llm') continue;
      if (types[i] !== 'tool') return false;                       // 中间仅工具节点（不允许分支/迭代/子智能体/代码）
      if (i < llmIdx && wf.nodes[i].data?.toolId !== 'kb_search') return false; // llm 前只允许知识库检索
    }
    const es = wf.edges || [];
    if (es.length !== wf.nodes.length - 1) return false;           // 线性：边数 = 节点数 - 1
    const inDeg = {}; es.forEach(e => inDeg[e.target] = (inDeg[e.target] || 0) + 1);
    return wf.nodes.every(n => n.id === 'start' || inDeg[n.id] === 1); // 除首外每节点恰一入边
  }
  // P5.8 #12 画布→表单（简单链回填）：提示词/模型 + 工具清单（内置工具节点）+ 知识库检索节点提示
  // （kb_search 节点的知识库 id 运行时取 agent.kb_id，画布不存——检测到节点时提示表单确认关联，不静默改）
  function syncFormFromCanvas() {
    const wf = cvAPI?.getWorkflow();
    if (!isSimpleChain(wf)) return false;
    const llm = wf.nodes.find(n => n.type === 'llm');
    if (!llm) return false;
    let changed = false;
    if (llm.data?.system_prompt && llm.data.system_prompt !== S.prompt) { S.prompt = llm.data.system_prompt; changed = true; }
    if (llm.data?.model && llm.data.model !== S.model) { S.model = llm.data.model; changed = true; }
    if (llm.data?.prompt && /^\{\{#start\.input#\}\}$/.test(llm.data.prompt.trim())) { /* 标准结构：user 固定引用输入，无需回填 */ }
    // 工具节点（llm 后）→ 表单内置工具清单（MCP 工具在表单走 mcp_servers 字段，画布无节点不冲突）
    const toolsOnCanvas = wf.nodes.filter(n => n.type === 'tool' && n.data?.toolId !== 'kb_search').map(n => n.data?.toolId).filter(x => TOOL_META[x]);
    if (JSON.stringify(toolsOnCanvas) !== JSON.stringify(S.tools || [])) { S.tools = toolsOnCanvas; changed = true; }
    return changed;
  }
  function switchMode(m) {
    if (m === studioMode) return;
    const prev = studioMode;
    studioMode = m;
    $('#stFormArea').style.display = m === 'form' ? 'flex' : 'none';
    $('#stCanvasArea').style.display = m === 'canvas' ? 'block' : 'none';
    $('#stModeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    // P5.1：edit_mode 独立字段记录编辑模式
    S.edit_mode = m;
    if (m === 'canvas') {
      // P5.4 双向转换：空画布 + 表单已配提示词 → 自动生成 开始→大模型→输出 三节点（不空画布开档）
      if (!S.workflow?.nodes?.length && (S.prompt || '').trim()) {
        S.workflow = buildWorkflowFromForm();
        const extra = [];
        if (S.kb_id) extra.push('📚知识库检索节点');
        if ((S.tools || []).filter(x => TOOL_META[x]).length) extra.push(`🛠️${(S.tools || []).filter(x => TOOL_META[x]).length}个工具节点`);
        toast('已按表单配置生成画布：开始' + (S.kb_id ? '→知识库检索' : '') + '→大模型' + ((S.tools || []).filter(x => TOOL_META[x]).length ? '→工具链' : '') + '→输出（提示词已带入）' + (extra.length ? '，含 ' + extra.join('、') : ''));
      }
      initCanvas();
      if (S.workflow?.nodes?.length) cvAPI.setWorkflow(S.workflow);
      // 画布模式下自动切到 workflow 路由（对话按图执行）；切回表单不强制回退
      if (S.routing_mode !== 'workflow') {
        S.routing_mode = 'workflow';
        toast(t('已切换为「画布工作流」路由：对话将按画布图执行'));
      }
    } else if (prev === 'canvas') {
      // P5.4 画布→表单：简单单链图回填表单提示词/模型（复杂图不覆盖表单）
      if (cvAPI) {
        const changed = syncFormFromCanvas();
        if (changed) { toast('简单链画布配置已同步回表单（提示词/模型/工具清单）'); renderEdit(); }
        else if (!isSimpleChain(cvAPI.getWorkflow())) toast(t('复杂画布结构：表单提示词保持不变（对话按画布图执行）'));
      }
    }
    scheduleSave();
  }
  $('#stModeSeg').querySelectorAll('button').forEach(b => b.onclick = () => switchMode(b.dataset.m));
  // P5.1：按 edit_mode 字段恢复编辑模式（form 默认；canvas 或已有画布/ workflow 路由进入画布）
  if (cfg.edit_mode === 'canvas' || S.workflow?.nodes?.length || S.routing_mode === 'workflow') switchMode('canvas');

  // ---------- 发布对话框（SinguX 式发布体系：发布记录 + 分类 + 官方标识 + 允许复制为模板 + 广场广播） ----------
  // ---------- P5.9 版本管理：草稿/发布分离 ----------
  // 状态徽标：已发布版本 + 草稿未发布改动提示（画布模式才显示）
  function renderPubVerBadge() {
    const el = document.getElementById('stPubVer');
    if (!el) return;
    const isCanvas = S.edit_mode === 'canvas' || S.routing_mode === 'workflow';
    if (!isCanvas || !pubInfo.has) { el.innerHTML = ''; return; }
    el.innerHTML = ` · <span style="color:#059669">快照 v${pubInfo.version}（${pubInfo.nodes} 节点）</span>` +
      (pubInfo.draftDirty ? `<span style="color:#d97706"> · ⚠️ 草稿有未发布改动（线上不受影响）</span>` : '');
  }
  renderPubVerBadge();
  // 版本历史弹窗：列表（版本/说明/发布人/节点数）+ 一键回滚（快照写回草稿+线上，确认后生效）
  $('#stVersionBtn').onclick = async () => {
    const m = modal({
      title: '🕘 ' + t('发布版本历史'),
      body: `<div id="stVerList">⏳ ${t('加载中…')}</div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        (async () => {
          const host = mask.querySelector('#stVerList');
          try {
            const j = await api(`/agents/${id}/publish-history`);
            const rows = j.data || [];
            if (!rows.length) { host.innerHTML = `<div class="hint" style="padding:14px">${t('暂无发布版本——发布一次画布智能体即存快照（表单模式无版本）')}</div>`; return; }
            host.innerHTML = `<div class="hint" style="margin-bottom:8px">💾 ${t('每次发布存一份画布快照；运行时走已发布快照（编辑草稿不影响线上）。回滚 = 把该版本写回草稿并同步线上（即刻生效）')}。</div>` +
              rows.map(r => `
              <div style="display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--border,#eef0f3);border-radius:8px;margin-bottom:6px">
                <b style="min-width:46px;color:#2563eb">v${r.version}</b>
                <span style="color:var(--text-2);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.note || '')}">${esc(r.note || '（无发布说明）')}</span>
                <span style="font-size:11px;color:var(--text-3)">${r.nodes} ${t('节点')}</span>
                <span style="font-size:11px;color:var(--text-3)">${esc(r.published_by || '')} · ${esc((r.created_at || '').slice(5, 16))}</span>
                ${r.version === pubInfo.version ? `<span class="tag green">${t('当前线上')}</span>` : `<button class="btn sm" data-rb="${r.version}">⏪ ${t('回滚到此')}</button>`}
              </div>`).join('');
            host.querySelectorAll('[data-rb]').forEach(b => b.onclick = async () => {
              const v = b.dataset.rb;
              if (!await confirmBox(`回滚到 v${v}：该版本快照将写回草稿并同步线上（即刻生效，当前草稿改动会被覆盖）。确定回滚？`, '回滚确认')) return;
              try {
                const rj = await api(`/agents/${id}/publish-history/${v}/rollback`, { method: 'POST', body: {} });
                toast(rj.msg || '已回滚');
                close();
                location.reload(); // 草稿已变——整页重载加载新图
              } catch (e) { toast(e.message, 'err'); }
            });
          } catch (e) { host.innerHTML = `<div style="color:#dc2626;padding:12px">❌ ${esc(e.message)}</div>`; }
        })();
      },
    });
  };

  function openPublishDlg() {
    const isPub = S.status === 'published';
    if (isPub) { // 已发布 → 直接下架（保持轻量）
      confirmBox('下架后该智能体将从广场与前台隐藏（历史会话保留）。确定下架？', '下架确认').then(async ok => {
        if (!ok) return;
        const j = await api(`/agents/${id}/publish`, { method: 'POST', body: {} });
        S.status = 'draft';
        $('#stStatus').textContent = '已下架（草稿）';
        $('#stPublish').textContent = '发布';
        toast(j.msg);
      });
      return;
    }
    const cats = ['未分类', '办公', '工作', '通用', '市场', '研发', '数据', '生活', '金融', '教育'];
    const isCanvas = S.edit_mode === 'canvas' || S.routing_mode === 'workflow';
    modal({
      title: '🚀 发布智能体',
      body: `
        ${isCanvas ? `<div style="padding:8px 12px;border:1px dashed #93c5fd;border-radius:8px;background:rgba(37,99,235,.04);margin-bottom:10px;font-size:12px;color:var(--text-2)">💾 ${t('发布将存画布快照')} <b>v${pubInfo.version + 1}</b>${pubInfo.draftDirty ? `（${t('当前草稿有未发布改动，本次一并生效')}）` : ''}——${t('运行时走快照，后续编辑草稿不影响线上，改坏可从「🕘 版本」一键回滚')}</div>` : ''}
        <div class="st-field"><label>发布记录（本次更新说明，≤200 字）</label>
          <textarea class="st-ta" id="pbRecord" rows="3" placeholder="如：新增知识库检索增强，优化回复结构">${esc(S.publish_record || '')}</textarea>
        </div>
        <div class="st-field"><label>分类选择（广场分类筛选项）</label>
          <input class="st-input" id="pbCat" list="pbCatList" value="${esc(S.category || '未分类')}" maxlength="20">
          <datalist id="pbCatList">${cats.map(c => `<option value="${c}">`).join('')}</datalist>
        </div>
        <div class="st-field"><label>发布范围</label>
          <label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;background:#fff;cursor:pointer">
            <input type="checkbox" id="pbSquare" checked>
            <span><b style="font-size:13px">发布到广场</b><span style="font-size:11px;color:var(--text-3,#9ca3af);margin-left:6px">全员广播通知 + 广场卡片展示</span></span>
          </label>
          <label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:6px;background:#fff;cursor:pointer">
            <input type="checkbox" id="pbCopy" ${S.allow_copy ? 'checked' : ''}>
            <span><b style="font-size:13px">允许复制（模板）</b><span style="font-size:11px;color:var(--text-3,#9ca3af);margin-left:6px">他人可在广场一键复制为草稿</span></span>
          </label>
          <label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:#fff;cursor:pointer">
            <input type="checkbox" id="pbOfficial" ${S.is_official ? 'checked' : ''}>
            <span><b style="font-size:13px">官方智能体</b><span style="font-size:11px;color:var(--text-3,#9ca3af);margin-left:6px">广场优先展示 + 官方徽标</span></span>
          </label>
        </div>`,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>发 布</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          if (dirty) await save(true);
          if (!S.prompt.trim()) {
            if (!await confirmBox('提示词为空，发布后智能体将使用默认系统提示词。仍要发布？')) return;
          }
          try {
            const j = await api(`/agents/${id}/publish`, { method: 'POST', body: {
              record: mask.querySelector('#pbRecord').value.trim(),
              category: mask.querySelector('#pbCat').value.trim() || '未分类',
              to_square: mask.querySelector('#pbSquare').checked,
              allow_copy: mask.querySelector('#pbCopy').checked,
              is_official: mask.querySelector('#pbOfficial').checked,
            } });
            S.status = 'published';
            S.category = mask.querySelector('#pbCat').value.trim() || '未分类';
            $('#stStatus').textContent = '已发布';
            $('#stPublish').textContent = '下架';
            if (j.data?.version) { pubInfo.has = true; pubInfo.version = j.data.version; pubInfo.draftDirty = false; renderPubVerBadge(); }
            toast(j.msg || '已发布');
            close();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }
  $('#stPublish').onclick = openPublishDlg;

  // ---------- 右侧：预览与调试（复用聊天组件） ----------
  let openingQuestions = [];
  try { openingQuestions = JSON.parse(cfg.opening_questions || '[]'); } catch { }
  mountChat($('#stChat'), {
    getAgentId: () => id,
    getAgentBanner: () => ({
      name: S.name, desc: S.description, icon: S.icon || '🤖',
      opening: S.opening, openingQuestions: S.opening_questions.filter(Boolean),
    }),
    getUserPrompt: () => S.user_prompt,
    allowModelSwitch: () => S.allow_user_model !== 0,
  });

  renderLeft();
  renderEdit();
  $('#stSaved').textContent = t('就绪');
  // 返回 destroy：路由切换时清理画布 window 监听器（防编排页进出泄漏）
  return { destroy() { if (cvAPI && typeof cvAPI.destroy === 'function') cvAPI.destroy(); } };
}
