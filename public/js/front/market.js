/** 前台-技能市场（V2.2 #7 2026-10-31；P3-2 融合 2026-11-06）：五区聚合运营位
 *  对标 Dify 插件市场 / Coze Skills 商店——内置工具 / 技能资产（含 CRUD）/ 工作流模版 / MCP 工具 / 异构应用。
 *  P3-2 融合（2026-11-06）：原独立「技能」页（#/skills → 本页重定向）CRUD 整合进「技能资产」tab；
 *  新增「内置工具」tab 展示 TOOL_DEFS 全量清单（后端动态生成单一事实来源，含 P3-2 新增 11 个）——
 *  含参数徽章 / 风险分级 / 可配 Key 标记（跳「我的模型」页配置）；后续所有新工具自动出现在本页。
 *  卡片视觉沿用 front/agents.js 的 agent-grid/agent-card 体系；全部用户可控字段经 esc() 转义。
 *  V2.3 F5：主端点只拉本地四区保首屏速度，「异构应用」tab 由 /skills-market/platforms 独立端点异步填充。
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

/** MCP 工具风险徽章（low 绿 / middle 橙 / high 红 / auto 灰——middle 为预留档） */
const RISK_META = {
  low: { cls: 'green', label: '低风险' },
  middle: { cls: 'orange', label: '中风险' },
  high: { cls: 'red', label: '高风险' },
  auto: { cls: 'gray', label: '未定级' },
};

/** 异构平台徽章（Dify 蓝 / Coze 紫） */
const PLAT_META = {
  dify: { cls: 'blue', label: 'Dify' },
  coze: { cls: 'purple', label: 'Coze' },
};

/** 内置工具图标映射（名称 → emoji；后端不存 icon，前端纯展示层映射，未命中回落 🔧） */
const TOOL_ICON = {
  kb_search: '📚', get_datetime: '🕐', calculator: '🧮', image_gen: '🎨',
  db_query: '🗄️', db_chart: '📊', web_search: '🔍', web_fetch: '🌐',
  stock_quote: '📈', export_word: '📄', tts: '🔊', doc_review: '📋', run_code: '💻',
  // P3-2 工具市场扩展（2026-11-06）
  uuid_gen: '🔑', hash_tool: '🔐', base64_tool: '🧬', json_tool: '🧾', text_count: '🔤',
  date_calc: '📅', unit_convert: '⚖️', cron_explain: '⏰', weather_query: '🌤️',
  translate_text: '🌍', exchange_rate: '💱',
};

export async function render(el) {
  let data = null;          // 主端点聚合响应（四区 + stats；platforms 由独立端点异步填充，初始 []）
  let platLoaded = false;   // F5：异构清单是否已到达（false=加载中；到达后用 platErr 区分成功/失败）
  let platErr = '';         // 异构清单加载失败信息（空串=成功）
  let tab = 'tools';        // 当前 tab：tools（内置工具，P3-2 默认）/ skill / wf / mcp / plat
  let kw = '';
  let favOnly = false;
  let mineOnly = false;     // P3-2 融合：技能资产 tab「仅看我的」（原技能页 mineChip 语义）
  const favSet = new Set(); // 「type:id」收藏键（乐观更新本地维护）

  el.innerHTML = `
  <style>
    .mk-star{position:absolute;top:8px;right:10px;border:none;background:none;cursor:pointer;font-size:16px;line-height:1;padding:4px;color:#c0c6d0;transition:.12s;z-index:2}
    .mk-star:hover{transform:scale(1.18)}
    .mk-star.on{color:#f59e0b}
    .mk-cardbtn{margin-top:10px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .mk-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .mk-sub{font-size:11px;color:var(--text-3,#9ca3af);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mk-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:var(--card,#fff);font-size:12px;cursor:pointer;color:var(--text-2,#4b5563)}
    .mk-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
    .mk-params{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
    .mk-params .tag{font-size:10px}
    /* P3-2 融合：技能 CRUD（自 front/skills.js 迁移） */
    .sk-tools{display:flex;flex-wrap:wrap;gap:6px}
    .sk-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}
    .sk-form .input,.sk-form textarea{width:100%;box-sizing:border-box}
  </style>
  <div class="page-head">
    <h2>${t('技能市场')}</h2>
    <div class="desc">${t('内置工具、技能资产、工作流模版、MCP 工具与异构应用的统一入口——工具开箱即用，技能一键克隆，收藏高频资产。')}</div>
    <div style="margin-top:8px"><span class="tag blue" id="mkStats">${t('加载中…')}</span></div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="seg" id="mkTabs">
      <button data-t="tools">${t('内置工具')}</button>
      <button data-t="skill">${t('技能资产')}</button>
      <button data-t="wf">${t('工作流模版')}</button>
      <button data-t="mcp">${t('MCP 工具')}</button>
      <button data-t="plat">${t('异构应用')}</button>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="mk-chip" id="mkMineChip" style="display:none">⭐ ${t('仅看我的')}</span>
      <span class="mk-chip" id="mkFavChip">☆ ${t('仅看收藏')}</span>
      <input class="input" id="mkKw" placeholder="🔍 ${t('搜索名称或描述')}" style="width:200px">
      <button class="btn primary" id="mkAddSkill">＋ ${t('创建技能')}</button>
    </div>
  </div>
  <div class="agent-grid" id="mkGrid" style="margin-top:14px"></div>`;

  const grid = el.querySelector('#mkGrid');
  const tabs = el.querySelector('#mkTabs');
  const statsEl = el.querySelector('#mkStats');
  const favChip = el.querySelector('#mkFavChip');
  const mineChip = el.querySelector('#mkMineChip');
  const kwInput = el.querySelector('#mkKw');

  const hit = (kw2, ...fields) => !kw2 || fields.some(f => String(f || '').includes(kw2));

  function starHTML(type, id, on) {
    return `<button class="mk-star ${on ? 'on' : ''}" data-fav="${esc(type)}:${esc(String(id))}" title="${on ? t('取消收藏') : t('收藏')}">${on ? '⭐' : '☆'}</button>`;
  }

  /* ---------------- P3-2 融合：技能 CRUD（自 front/skills.js 迁移，工具清单改后端动态） ---------------- */

  function copyMention(name) {
    const text = '@' + name;
    const done = () => toast(`${t('已复制')} ${text}，${t('到对话输入框粘贴即可调用')}`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => toast(`${t('请在对话中输入')} ${text} ${t('调用')}`));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { toast(`${t('请在对话中输入')} ${text} ${t('调用')}`); }
      ta.remove();
    }
  }

  /** 技能创建/编辑弹窗——工具选择从主端点 builtin_tools 动态渲染（P3-2：取代旧 4 项硬编码 TOOL_META） */
  function openSkillForm(row) {
    const isNew = !row;
    const tools = (data?.builtin_tools || []);
    const m = modal({
      title: isNew ? t('＋ 创建技能') : `${t('编辑技能')}：${esc(row.name)}`,
      wide: true,
      body: `
        <div class="sk-form">
          <label>${t('技能名称（中文/字母/数字，≤20 字——对话中 @名称 调用，要短要好记）')}</label>
          <input class="input" id="fName" value="${esc(row?.name || '')}" placeholder="${t('如：周报专家、小红书文案、代码评审')}" maxlength="20">
          <label>${t('图标（一个 emoji）')}</label>
          <input class="input" id="fIcon" value="${esc(row?.icon || '✨')}" maxlength="4" style="width:80px">
          <label>${t('描述（市场卡片上的一句话介绍）')}</label>
          <input class="input" id="fDesc" value="${esc(row?.description || '')}" placeholder="${t('把工作要点整理成结构化周报')}" maxlength="100">
          <label>${t('提示词（核心能力定义，对话 @技能 时注入 system）')}</label>
          <textarea id="fPrompt" rows="6" placeholder="${t('你是周报生成专家。把用户输入的工作要点整理为……')}">${esc(row?.prompt || '')}</textarea>
          <label>${t('挂载内置工具（可选：模型按需调用；不选则为纯提示词技能）')}</label>
          <div id="fTools" style="display:flex;gap:8px;flex-wrap:wrap;max-height:180px;overflow:auto;border:1px solid #e5e7eb;border-radius:10px;padding:10px">
            ${tools.map(x => `
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);cursor:pointer;border:1px solid #e5e7eb;border-radius:8px;padding:6px 12px" title="${esc(x.description)}">
                <input type="checkbox" value="${esc(x.name)}" ${row?.tools?.includes(x.name) ? 'checked' : ''}>${TOOL_ICON[x.name] || '🔧'} ${esc(x.name)}
              </label>`).join('') || `<span style="font-size:12px;color:var(--text-3)">${t('工具清单加载中…')}</span>`}
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:14px">
            <input type="checkbox" id="fStatus" ${(isNew || row.status) ? 'checked' : ''}> ${t('发布（他人可见可 @ 引用；关闭则仅自己可见）')}
          </label>
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
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
          if (!body.name) return toast(t('技能名称不能为空'), 'err');
          if (!body.prompt) return toast(t('提示词不能为空——技能的核心是提示词'), 'err');
          try {
            if (isNew) await api('/skillassets', { method: 'POST', body });
            else await api(`/skillassets/${row.id}`, { method: 'PUT', body });
            close(); toast(t('已保存'));
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  /** 技能详情弹窗（含工具徽章/提示词全文/复制调用词/编辑入口） */
  function openSkillDetail(s) {
    modal({
      title: `${s.icon || '✨'} ${esc(s.name)}`,
      body: `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          <span class="tag ${s.mine ? 'blue' : 'gray'}">${s.mine ? t('我的技能') : `${t('来自')} ${esc(s.owner)}`}</span>
          <span class="tag ${s.status ? 'green' : 'gray'}">${s.status ? t('已发布') : t('私有')}</span>
          ${s.tools?.map(x => `<span class="tag purple">${TOOL_ICON[x] || '🔧'} ${esc(x)}</span>`).join('')}
        </div>
        ${s.description ? `<div style="font-size:13px;color:var(--text-3);margin-bottom:12px">${esc(s.description)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">📝 ${t('提示词')}：</div>
        <div style="font-size:13px;line-height:1.8;color:var(--text);padding:12px;background:#f8faff;border-radius:10px;white-space:pre-wrap;max-height:260px;overflow:auto">${esc(s.prompt || '')}</div>
        <div style="margin-top:14px;padding:10px 12px;background:#fff7e6;border-radius:10px;font-size:12px;color:#92700c">
          💡 ${t('在对话输入框输入')} <b>@${esc(s.name)}</b>（${t('或点输入区的「✨ 技能」按钮选择')}）${t('即可调用本技能')}
        </div>`,
      foot: `<button class="btn" data-copy>⧉ ${t('复制调用词')}</button>${s.mine ? `<button class="btn" data-edit>${t('编辑')}</button>` : ''}<button class="btn primary" data-close>${t('关闭')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-copy]').onclick = () => { copyMention(s.name); };
        const ed = mask.querySelector('[data-edit]');
        if (ed) ed.onclick = () => { close(); openSkillForm(s); };
      },
    });
  }

  /* ---------------- 卡片渲染 ---------------- */

  function renderGrid() {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.t === tab));
    favChip.classList.toggle('on', favOnly);
    mineChip.style.display = tab === 'skill' ? '' : 'none'; // 「仅看我的」只在技能 tab 出现（P3-2 融合）
    mineChip.classList.toggle('on', mineOnly);
    if (!data) return;
    const inFav = (type, id) => favSet.has(`${type}:${id}`);

    let items = [];
    // 版本兼容兑底（2026-11-06）：旧后端（P3-2 融合前）主端点无 builtin_tools 键——
    // 缺失时归一为空数组而非 undefined.map 崩页，内置工具 tab 显示空态提示引导重启服务
    const BT = Array.isArray(data.builtin_tools) ? data.builtin_tools : [];
    if (tab === 'tools') items = BT.map(x => ({ ...x, _t: 'builtin_tool' }));
    else if (tab === 'wf') items = (data.wf_templates || []).map(x => ({ ...x, _t: 'wf_template' }));
    else if (tab === 'skill') items = (data.skill_assets || []).map(x => ({ ...x, _t: 'skill_asset' }));
    else if (tab === 'mcp') items = (data.mcp_tools || []).map(x => ({ ...x, _t: 'mcp_tool' }));
    // F5：异构清单独立端点尚未返回——展示加载态空卡片（到达后 loadPlatforms 会按当前 tab 触发一次重绘）
    else if (!platLoaded) {
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">🔌</div>${t('外部平台清单加载中…')}<br><span style="font-size:12px">${t('Dify / 扣子应用经独立接口异步拉取，到达后自动展示')}</span></div>`;
      return;
    } else if (platErr) {
      // V2.3 审查加固（P2-5）：失败卡片加「点此重试」——重置状态后重调 loadPlatforms（免整页刷新）
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">⚠️</div>${t('外部平台清单加载失败')}：${esc(platErr)}<br><span style="font-size:12px">${t('外部平台故障不影响本地四区浏览')}</span><br><button class="btn sm" id="mkPlatRetry" style="margin-top:8px">↻ ${t('点此重试')}</button></div>`;
      const rb = grid.querySelector('#mkPlatRetry');
      if (rb) rb.onclick = () => { platLoaded = false; platErr = ''; renderGrid(); loadPlatforms(); };
      return;
    } else items = (data.platforms || []).map(x => ({ ...x, _t: 'platform' }));

    const shown = items.filter(x => {
      if (tab === 'skill' && mineOnly && !x.mine) return false; // P3-2 融合：技能 tab「仅看我的」
      if (favOnly && !['skill_asset', 'wf_template', 'mcp_tool'].includes(x._t)) return false; // 内置工具/异构不可收藏，收藏过滤不适用
      if (favOnly && !inFav(x._t, x.id)) return false;
      return hit(kw, x.name, x.tool_name, x.app_name, x.description, x.app_desc, x.server_name, x.category);
    });

    if (!shown.length) {
      // 旧后端识别（2026-11-06）：主端点缺 builtin_tools 键 = 服务端跑的是融合前旧代码——
      // 给出明确引导（重启服务生效）而非误导性的「注册异常」文案
      const legacyBackend = tab === 'tools' && !Array.isArray(data.builtin_tools);
      const emptyMap = {
        tools: legacyBackend
          ? ['⬆️', '内置工具区需要新版服务端', '当前服务端为融合前旧版本（未返回 builtin_tools 字段）——重启 3210 服务（node server.js）后刷新本页即可']
          : ['🧰', '暂无内置工具', '平台工具清单为空（服务端 TOOL_DEFS 注册异常，请联系管理员）'],
        wf: ['📐', '暂无工作流模版', '在编排页画布上「💾 存为模板」沉淀你的高频流程'],
        skill: ['✨', '暂无技能资产', mineOnly ? '你还没有创建技能——点击右上「＋ 创建技能」开始' : '点击「＋ 创建技能」沉淀可复用的提示词+工具组合，发布后进入市场供他人克隆'],
        mcp: ['🔧', '暂无 MCP 工具', '管理员在「MCP 服务」注册并刷新工具清单后，这里自动聚合'],
        plat: ['🔌', '暂无异构应用', '管理员在「接入管理」配置 Dify/扣子并同步后，这里自动聚合（外部平台故障时静默跳过）'],
      };
      const [ic, msg, sub] = emptyMap[tab];
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">${ic}</div>${favOnly ? t('该区暂无收藏项——点击卡片右上角 ☆ 收藏') : t(msg)}<br><span style="font-size:12px">${t(sub)}</span></div>`;
      return;
    }

    grid.innerHTML = shown.map(x => {
      // 内置工具卡（P3-2 新区）：图标/名称/风险徽章/描述/参数徽章/keyed 工具的配置引导
      if (x._t === 'builtin_tool') {
        const r = RISK_META[x.risk] || RISK_META.auto;
        return `<div class="agent-card" data-plugin-id="tool_${esc(x.name)}">
          <div class="a-ava" style="background:linear-gradient(135deg,#0891b2,#2563eb)">${TOOL_ICON[x.name] || '🔧'}</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.name)} <span class="tag ${r.cls}">${t(r.label)}</span>${x.keyed ? `<span class="tag ${x.key_configured ? 'green' : 'orange'}" title="${esc(x.key_provider)}">${x.key_configured ? '🔑 ' + t('已配 Key') : '🔑 ' + t('可配 Key')}</span>` : ''}</div>
            <div class="a-desc">${esc(x.description || '内置工具')}</div>
            <div class="mk-params">
              ${(x.params_required || []).map(p => `<span class="tag blue" title="${t('必填参数')}">${esc(p)}*</span>`).join('')}
              ${(x.params_optional || []).map(p => `<span class="tag gray" title="${t('可选参数')}">${esc(p)}</span>`).join('') || (x.params_required?.length ? '' : `<span class="tag gray">${t('无参数')}</span>`)}
            </div>
            <div class="mk-cardbtn">
              ${x.keyed && !x.key_configured ? `<button class="btn sm" data-gotokey="${esc(x.name)}">🔑 ${t('配置我的 Key')}</button>` : ''}
              <span style="font-size:11px;color:var(--text-3);align-self:center">${t('编排智能体时勾选即用')}</span>
            </div>
          </div>
        </div>`;
      }
      if (x._t === 'wf_template') {
return `<div class="agent-card" data-plugin-id="plat_${x.platform_type}_${x.app_id}">

          ${starHTML('wf_template', x.id, inFav('wf_template', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#2563eb,#7c3aed)">${esc(x.icon || '🎨')}</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.name)} <span class="tag gray">${esc(x.category || '通用')}</span>${x.builtin ? `<span class="tag blue">${t('官方')}</span>` : ''}</div>
            <div class="a-desc">${esc(x.description || '预配置工作流模板')}</div>
            <div class="a-meta">
              <span class="tag orange" title="${t('被使用次数')}">🔥 ${t('用过')} ${Number(x.use_count) || 0} ${t('次')}</span>
            </div>
            <div class="mk-cardbtn"><button class="btn sm primary" data-clone="wf_template:${x.id}">⧉ ${t('用模板创建')}</button></div>
          </div>
        </div>`;
      }
      if (x._t === 'skill_asset') {
        // P3-2 融合：技能卡在市场浏览基础上叠加 CRUD（我的：编辑/删除/发布开关 + 详情 + 复制调用词）
        return `<div class="agent-card" data-plugin-id="skill_${x.id}">
          ${starHTML('skill_asset', x.id, inFav('skill_asset', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#059669,#0d9488)">${esc(x.icon || '✨')}</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.name)} ${x.owned_by_me ? `<span class="tag blue">${t('我的')}</span>` : `<span class="tag gray">${esc(x.owner)}</span>`}${x.owned_by_me && !x.status ? `<span class="tag orange">${t('私有')}</span>` : ''}</div>
            <div class="a-desc">${esc(x.description || t('提示词 + 工具组合技能'))}</div>
            <div class="sk-tools">${(x.tools || []).map(tl => `<span class="tag purple" style="font-size:10px">${TOOL_ICON[tl] || '🔧'} ${esc(tl)}</span>`).join('') || `<span style="font-size:11px;color:#c0c4cc">${t('纯提示词技能')}</span>`}</div>
            <div class="mk-cardbtn">
              <button class="btn sm" data-copy="${x.id}">⧉ ${t('调用词')}</button>
              ${x.owned_by_me ? `<button class="btn sm" data-edit="${x.id}">${t('编辑')}</button><button class="btn sm" data-publish="${x.id}">${x.status ? t('下架') : t('发布')}</button><button class="btn sm" style="color:#dc2626" data-del="${x.id}">${t('删除')}</button>` : `<button class="btn sm primary" data-clone="skill_asset:${x.id}">⧉ ${t('克隆为我的智能体')}</button>`}
            </div>
          </div>
        </div>`;
      }
      if (x._t === 'mcp_tool') {
        const r = RISK_META[x.risk] || RISK_META.auto;
        return `<div class="agent-card" data-plugin-id="mcp_${x.tool_name}">
          ${starHTML('mcp_tool', x.id, inFav('mcp_tool', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#d97706,#dc2626)">🔧</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.tool_name)} <span class="tag ${r.cls}">${t(r.label)}</span>${x.server_trusted ? '<span class="tag green" title="' + t('服务已信任：只读工具对话中免确认') + '">🛡 ' + t('可信') + '</span>' : ''}</div>
            <div class="mk-sub">📦 ${t('服务')}：${esc(x.server_name)}</div>
            <div class="a-desc">${esc(x.description || t('MCP 工具（描述由服务清单提供）'))}</div>
          </div>
        </div>`;
      }
      // 异构应用（不可收藏/克隆——外部资产无本地主键，展示 + 引导到接入管理）
      const pm = PLAT_META[x.platform_type] || { cls: 'gray', label: x.platform_type };
      return `<div class="agent-card">
        <div class="a-ava" style="background:linear-gradient(135deg,${x.platform_type === 'dify' ? '#2563eb,#60a5fa' : '#7c3aed,#a78bfa'})">${x.platform_type === 'dify' ? '🔷' : '🟣'}</div>
        <div class="a-info">
          <div class="mk-name">${esc(x.app_name || x.app_id)} <span class="tag ${pm.cls}">${esc(pm.label)}</span></div>
          <div class="mk-sub">${esc(x.mode || '')}${x.platform_name ? ' · ' + esc(x.platform_name) : ''}</div>
          <div class="a-desc">${esc(x.app_desc || t('外部平台应用（经异构纳管同步）'))}</div>
          <div class="a-meta"><span class="tag gray">${t('来源：异构纳管')}</span></div>
        </div>
      </div>`;
    }).join('');

    // ---- 事件绑定 ----
    // 收藏星切换（乐观更新：先改本地态渲染，接口失败回滚）
    grid.querySelectorAll('.mk-star').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const [type, ...rest] = b.dataset.fav.split(':');
      const id = rest.join(':'); // 工具名可能含冒号，仅按第一个冒号拆分
      const key = `${type}:${id}`;
      const was = favSet.has(key);
      if (was) favSet.delete(key); else favSet.add(key);
      renderGrid();
      try {
        await api('/skills-market/favorites', { method: was ? 'DELETE' : 'POST', body: { item_type: type, item_id: id } });
        toast(was ? t('已取消收藏') : t('已收藏'));
        updateStats();
      } catch (err) {
        if (was) favSet.add(key); else favSet.delete(key); // 回滚乐观更新
        renderGrid();
        toast(err.message, 'err');
      }
    });

    // 内置工具「配置我的 Key」→ 跳我的模型页（工具 Key 区块在此页，P3-2）
    grid.querySelectorAll('[data-gotokey]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      toast(`${t('前往「我的模型」页配置')} ${b.dataset.gotokey} ${t('的 API Key')}`);
      location.hash = '#/models';
    });

    // 一键克隆 → 跳编排页（#/admin/studio/{id}，路由实名为 admin/studio）
    grid.querySelectorAll('[data-clone]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const [type, ...rest] = b.dataset.clone.split(':');
      const id = rest.join(':');
      b.disabled = true;
      try {
        const j = await api('/skills-market/clone', { method: 'POST', body: { item_type: type, item_id: id } });
        toast(j.msg || t('已创建草稿'));
        location.hash = '#/admin/studio/' + j.data.agent_id;
      } catch (err) {
        toast(err.message, 'err');
        b.disabled = false;
      }
    });

    // P3-2 融合：技能卡 CRUD 交互（复制调用词 / 编辑 / 发布开关 / 删除 / 详情）
    const skillOf = (id) => data.skill_assets.find(s => s.id === +id);
    grid.querySelectorAll('.agent-card[data-skill]').forEach(card => {
      card.onclick = e => {
        if (e.target.closest('[data-copy]') || e.target.closest('[data-edit]') || e.target.closest('[data-del]') || e.target.closest('[data-publish]') || e.target.closest('[data-clone]') || e.target.closest('.mk-star')) return;
        openSkillDetail(skillOf(card.dataset.skill));
      };
    });
    grid.querySelectorAll('[data-copy]').forEach(b => b.onclick = e => { e.stopPropagation(); copyMention(skillOf(b.dataset.copy)?.name || ''); });
    grid.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); openSkillForm(skillOf(b.dataset.edit)); });
    grid.querySelectorAll('[data-publish]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const s = skillOf(b.dataset.publish);
      try {
        await api(`/skillassets/${s.id}`, { method: 'PUT', body: { name: s.name, icon: s.icon, description: s.description, prompt: s.prompt, tools: s.tools, status: s.status ? 0 : 1 } });
        toast(s.status ? t('已下架（仅自己可见）') : t('已发布（进入市场）'));
        load();
      } catch (err) { toast(err.message, 'err'); }
    });
    grid.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      if (!(await confirmBox(t('确定删除该技能？')))) return;
      try {
        await api(`/skillassets/${b.dataset.del}`, { method: 'DELETE' });
        toast(t('已删除')); load();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  function updateStats() {
    if (!data) return;
    // 口径说明（F5 + P3-2）：stats.total 来自主端点=本地四区条数之和；异构清单到达后可选追加「+N 异构」展示，
    // 不并入 total——避免主/异构两套口径互相漂移，也避免平台未到达时徽章数字回跳
    // 版本兼容兑底（2026-11-06）：旧后端无 builtin_tools 区，total 按三区实际数现算（stats.total 语义一致）
    const btCount = Array.isArray(data.builtin_tools) ? data.builtin_tools.length : 0;
    const total = (data.stats && typeof data.stats.total === 'number')
      ? data.stats.total
      : btCount + (data.wf_templates || []).length + (data.skill_assets || []).length + (data.mcp_tools || []).length;
    let s = t('共 N 项资产 · 我收藏 M').replace('N', total).replace('M', favSet.size);
    if (platLoaded && !platErr && (data.platforms || []).length) s += ` · +${data.platforms.length} ${t('异构')}`;
    statsEl.textContent = s;
  }

  async function load() {
    try {
      const j = await api('/skills-market');
      data = { ...j.data, platforms: [] }; // F5：主端点不再返回 platforms，本地初始化为空数组待异步填充
      favSet.clear();
      for (const x of data.wf_templates || []) if (x.favorited) favSet.add(`wf_template:${x.id}`);
      for (const x of data.skill_assets || []) if (x.favorited) favSet.add(`skill_asset:${x.id}`);
      for (const x of data.mcp_tools || []) if (x.favorited) favSet.add(`mcp_tool:${x.id}`);
      updateStats();
      renderGrid();
    } catch (e) {
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">⚠️</div>${t('市场加载失败')}：${esc(e.message)}<br><span style="font-size:12px">${e.code === 403 ? t('无访问权限，请联系管理员') : t('请稍后刷新重试')}</span></div>`;
    }
  }

  /** F5：异步加载异构应用清单（独立端点）——不 await、不阻塞首屏；到达后仅当用户正处于 plat tab
   *  才触发一次 renderGrid 刷新，否则等用户切到该 tab 时由点击回调自然读到已填充的 data.platforms。
   *  防循环设计：renderGrid 是同步重绘且不调用本函数，本函数仅在 fetch 恢复时被调用一次（不注册
   *  任何会再次触发自身的事件），到达→重绘→结束为单向链路，不会形成循环。 */
  async function loadPlatforms() {
    if (!data) return; // 主端点失败（如 403）时页面已呈错误态，不再拉异构清单
    try {
      const j = await api('/skills-market/platforms');
      data.platforms = (j.data && j.data.platforms) || [];
      platErr = '';
    } catch (e) {
      data.platforms = [];
      platErr = e.message || String(e); // 失败也置到达态：plat tab 显示失败空卡片而非永久「加载中」
    }
    platLoaded = true;
    updateStats(); // 徽章可选追加「+N 异构」
    if (tab === 'plat') renderGrid(); // 仅当前正处于异构 tab 才重绘一次（避免覆盖用户正在浏览的其他 tab）
  }

  tabs.querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderGrid(); });
  favChip.onclick = () => { favOnly = !favOnly; renderGrid(); };
  mineChip.onclick = () => { mineOnly = !mineOnly; renderGrid(); };
  kwInput.oninput = () => { kw = kwInput.value.trim(); renderGrid(); };
  // P3-2 融合：创建技能入口（原独立技能页 #addBtn，现在市场页承担 CRUD）
  el.querySelector('#mkAddSkill').onclick = () => openSkillForm(null);

  await load();          // 主端点：本地四区（首屏快，F5）
  loadPlatforms();       // 异构清单异步加载（不 await，不阻塞首屏；结果按当前 tab 决定是否重绘）
}
