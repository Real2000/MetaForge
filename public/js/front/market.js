/** 前台-技能市场（V2.2 #7 2026-10-31）：工作流模版 / 技能资产 / MCP 工具 / 异构应用 四区聚合运营位
 *  对标 Dify 插件市场 / Coze Skills 商店——统一入口：浏览 / 搜索 / 收藏（market_favorites）/ 一键克隆。
 *  卡片视觉沿用 front/agents.js 的 agent-grid/agent-card 体系；全部用户可控字段经 esc() 转义。
 */
import { api } from '../api.js';
import { esc, toast } from '../ui.js';
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

export async function render(el) {
  let data = null;          // 聚合响应（四区 + stats）
  let tab = 'wf';           // 当前 tab：wf / skill / mcp / plat
  let kw = '';
  let favOnly = false;
  const favSet = new Set(); // 「type:id」收藏键（乐观更新本地维护）

  el.innerHTML = `
  <style>
    .mk-star{position:absolute;top:8px;right:10px;border:none;background:none;cursor:pointer;font-size:16px;line-height:1;padding:4px;color:#c0c6d0;transition:.12s;z-index:2}
    .mk-star:hover{transform:scale(1.18)}
    .mk-star.on{color:#f59e0b}
    .mk-cardbtn{margin-top:10px;display:flex;gap:8px;justify-content:flex-end}
    .mk-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .mk-sub{font-size:11px;color:var(--text-3,#9ca3af);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mk-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:var(--card,#fff);font-size:12px;cursor:pointer;color:var(--text-2,#4b5563)}
    .mk-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
  </style>
  <div class="page-head">
    <h2>${t('技能市场')}</h2>
    <div class="desc">${t('工作流模版、技能资产、MCP 工具与异构纳管应用的统一聚合入口——收藏高频资产，一键克隆为自己的智能体草稿。')}</div>
    <div style="margin-top:8px"><span class="tag blue" id="mkStats">${t('加载中…')}</span></div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="seg" id="mkTabs">
      <button data-t="wf">${t('工作流模版')}</button>
      <button data-t="skill">${t('技能资产')}</button>
      <button data-t="mcp">${t('MCP 工具')}</button>
      <button data-t="plat">${t('异构应用')}</button>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="mk-chip" id="mkFavChip">⭐ ${t('仅看收藏')}</span>
      <input class="input" id="mkKw" placeholder="🔍 ${t('搜索名称或描述')}" style="width:220px">
    </div>
  </div>
  <div class="agent-grid" id="mkGrid" style="margin-top:14px"></div>`;

  const grid = el.querySelector('#mkGrid');
  const tabs = el.querySelector('#mkTabs');
  const statsEl = el.querySelector('#mkStats');
  const favChip = el.querySelector('#mkFavChip');
  const kwInput = el.querySelector('#mkKw');

  const hit = (kw2, ...fields) => !kw2 || fields.some(f => String(f || '').includes(kw2));

  function starHTML(type, id, on) {
    return `<button class="mk-star ${on ? 'on' : ''}" data-fav="${esc(type)}:${esc(String(id))}" title="${on ? t('取消收藏') : t('收藏')}">${on ? '⭐' : '☆'}</button>`;
  }

  function renderGrid() {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.t === tab));
    favChip.classList.toggle('on', favOnly);
    if (!data) return;
    const inFav = (type, id) => favSet.has(`${type}:${id}`);

    let items = [];
    if (tab === 'wf') items = data.wf_templates.map(x => ({ ...x, _t: 'wf_template' }));
    else if (tab === 'skill') items = data.skill_assets.map(x => ({ ...x, _t: 'skill_asset' }));
    else if (tab === 'mcp') items = data.mcp_tools.map(x => ({ ...x, _t: 'mcp_tool' }));
    else items = (data.platforms || []).map(x => ({ ...x, _t: 'platform' }));

    const shown = items.filter(x => (!favOnly || inFav(x._t, x.id)) && hit(kw, x.name, x.tool_name, x.app_name, x.description, x.app_desc, x.server_name, x.category));

    if (!shown.length) {
      const emptyMap = {
        wf: ['📐', '暂无工作流模版', '在编排页画布上「💾 存为模板」沉淀你的高频流程'],
        skill: ['✨', '暂无技能资产', '到「技能」页创建，发布后进入市场供他人克隆'],
        mcp: ['🔧', '暂无 MCP 工具', '管理员在「MCP 服务」注册并刷新工具清单后，这里自动聚合'],
        plat: ['🔌', '暂无异构应用', '管理员在「接入管理」配置 Dify/扣子并同步后，这里自动聚合（外部平台故障时静默跳过）'],
      };
      const [ic, msg, sub] = emptyMap[tab];
      grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1"><div class="big">${ic}</div>${favOnly ? t('该区暂无收藏项——点击卡片右上角 ☆ 收藏') : t(msg)}<br><span style="font-size:12px">${t(sub)}</span></div>`;
      return;
    }

    grid.innerHTML = shown.map(x => {
      if (x._t === 'wf_template') {
        return `<div class="agent-card">
          ${starHTML('wf_template', x.id, inFav('wf_template', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#2563eb,#7c3aed)">${esc(x.icon || '🎨')}</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.name)} <span class="tag gray">${esc(x.category || '通用')}</span>${x.builtin ? '<span class="tag blue">官方</span>' : ''}</div>
            <div class="a-desc">${esc(x.description || '预配置工作流模板')}</div>
            <div class="a-meta">
              <span class="tag orange" title="${t('被使用次数')}">🔥 ${t('用过')} ${Number(x.use_count) || 0} ${t('次')}</span>
            </div>
            <div class="mk-cardbtn"><button class="btn sm primary" data-clone="wf_template:${x.id}">⧉ ${t('用模板创建')}</button></div>
          </div>
        </div>`;
      }
      if (x._t === 'skill_asset') {
        return `<div class="agent-card">
          ${starHTML('skill_asset', x.id, inFav('skill_asset', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#059669,#0d9488)">${esc(x.icon || '✨')}</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.name)} ${x.owned_by_me ? '<span class="tag blue">我的</span>' : `<span class="tag gray">${esc(x.owner)}</span>`}</div>
            <div class="a-desc">${esc(x.description || '提示词 + 工具组合技能')}</div>
            <div class="mk-cardbtn"><button class="btn sm primary" data-clone="skill_asset:${x.id}">⧉ ${t('克隆为我的智能体')}</button></div>
          </div>
        </div>`;
      }
      if (x._t === 'mcp_tool') {
        const r = RISK_META[x.risk] || RISK_META.auto;
        return `<div class="agent-card">
          ${starHTML('mcp_tool', x.id, inFav('mcp_tool', x.id))}
          <div class="a-ava" style="background:linear-gradient(135deg,#d97706,#dc2626)">🔧</div>
          <div class="a-info">
            <div class="mk-name">${esc(x.tool_name)} <span class="tag ${r.cls}">${t(r.label)}</span>${x.server_trusted ? '<span class="tag green" title="' + t('服务已信任：只读工具对话中免确认') + '">🛡 ' + t('可信') + '</span>' : ''}</div>
            <div class="mk-sub">📦 ${t('服务')}：${esc(x.server_name)}</div>
            <div class="a-desc">${esc(x.description || 'MCP 工具（描述由服务清单提供）')}</div>
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
          <div class="a-desc">${esc(x.app_desc || '外部平台应用（经异构纳管同步）')}</div>
          <div class="a-meta"><span class="tag gray">${t('来源：异构纳管')}</span></div>
        </div>
      </div>`;
    }).join('');

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
  }

  function updateStats() {
    if (!data) return;
    statsEl.textContent = t('共 N 项资产 · 我收藏 M').replace('N', data.stats.total).replace('M', favSet.size);
  }

  async function load() {
    try {
      const j = await api('/skills-market');
      data = j.data;
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

  tabs.querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderGrid(); });
  favChip.onclick = () => { favOnly = !favOnly; renderGrid(); };
  kwInput.oninput = () => { kw = kwInput.value.trim(); renderGrid(); };

  await load();
}
