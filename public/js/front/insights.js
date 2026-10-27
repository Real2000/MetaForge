/** 使用分析页 #/insights（客户成功）：智能体使用分析 + 优化建议推送 + 行业模板推荐
 *  数据源 /api/biz/insights：名下智能体的周调用/活跃用户/满意度/知识库召回率
 *  + 规则引擎建议（未发布/零调用/无开场白/召回率低/差评）+ 模板最佳实践。
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';

export async function render(el) {
  let data = null;

  el.innerHTML = `
  <style>
    .is-agent{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid #eef0f4;border-radius:12px;margin-bottom:10px;background:#fff;flex-wrap:wrap}
    .is-agent .a-ava{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;flex-shrink:0}
    .is-stats{display:flex;gap:18px;font-size:12px;color:var(--text-2);flex-wrap:wrap;margin-left:auto}
    .is-stats b{color:var(--text);font-size:16px;display:block;text-align:center}
    .is-adv{display:flex;gap:10px;padding:11px 14px;border-radius:10px;margin-bottom:8px;font-size:13px;line-height:1.7}
    .is-adv.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
    .is-adv.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
    .is-tpl{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
    .is-tpl .tpl{border:1px solid #eef0f4;border-radius:10px;padding:14px;cursor:pointer;transition:.15s;background:#fff}
    .is-tpl .tpl:hover{border-color:#93c5fd;box-shadow:0 6px 18px rgba(37,99,235,.08)}
  </style>
  <div class="page-head">
    <h2>使用分析</h2>
    <div class="desc">你的智能体运行数据、优化建议与行业最佳实践——让智能体越用越好。</div>
  </div>
  <div class="grid-4" id="overview" style="margin-bottom:14px"></div>
  <div class="grid-2" style="align-items:start">
    <div class="card">
      <h3 style="margin:0 0 12px">🤖 我的智能体</h3>
      <div id="agents"></div>
    </div>
    <div>
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin:0 0 12px">💡 优化建议</h3>
        <div id="advises"></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px;display:flex;justify-content:space-between;align-items:center">📚 行业最佳实践
          <a class="btn sm" href="#/admin/agents">从模板创建 →</a>
        </h3>
        <div class="is-tpl" id="tpls"></div>
      </div>
    </div>
  </div>`;

  const AVA = [['#2563eb', '#7c3aed'], ['#059669', '#0d9488'], ['#d97706', '#dc2626'], ['#db2777', '#7c3aed'], ['#0891b2', '#2563eb']];

  function fmt(n) { return (n || 0).toLocaleString('zh-CN'); }

  function renderAll() {
    const list = data.list;
    const totalWeek = list.reduce((s, a) => s + a.weekCalls, 0);
    const published = list.filter(a => a.status === 'published').length;
    const activeAgent = list.filter(a => a.weekCalls > 0).length;
    el.querySelector('#overview').innerHTML = `
      <div class="stat"><div class="s-label">本周总调用</div><div class="s-num">${fmt(totalWeek)}</div><div class="s-unit">次</div></div>
      <div class="stat"><div class="s-label">活跃智能体</div><div class="s-num">${activeAgent}<span class="s-unit">/ ${list.length}</span></div><div class="s-unit">近 7 天有调用</div></div>
      <div class="stat"><div class="s-label">已发布</div><div class="s-num">${published}</div><div class="s-unit">个智能体</div></div>
      <div class="stat"><div class="s-label">累计调用</div><div class="s-num">${fmt(list.reduce((s, a) => s + a.totalCalls, 0))}</div><div class="s-unit">次（全部历史）</div></div>`;

    el.querySelector('#agents').innerHTML = list.length ? list.map((a, i) => `
      <div class="is-agent">
        <div class="a-ava" style="background:linear-gradient(135deg,${AVA[i % AVA.length][0]},${AVA[i % AVA.length][1]})">${esc(a.icon || '🤖')}</div>
        <div style="min-width:140px;flex:1">
          <b style="font-size:14px">${esc(a.name)}</b>
          ${a.status === 'published' ? '<span class="tag green" style="font-size:10px">已发布</span>' : '<span class="tag gray" style="font-size:10px">草稿</span>'}
          ${a.kb_id ? '<span class="tag blue" style="font-size:10px">📚 知识库</span>' : ''}
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">创建于 ${esc((a.created_at || '').slice(0, 10))}</div>
        </div>
        <div class="is-stats">
          <span><b>${a.weekCalls}</b>本周调用</span>
          <span><b>${a.activeUsers}</b>活跃用户</span>
          <span><b>${fmt(a.totalCalls)}</b>累计</span>
          ${a.kbHitRate != null ? `<span><b style="color:${a.kbHitRate < 30 ? '#d97706' : '#059669'}">${a.kbHitRate}%</b>召回率</span>` : ''}
          ${a.ratedCount ? `<span><b style="color:${a.ratingUp <= 0 ? '#dc2626' : '#059669'}">${a.ratingUp > 0 ? '+' : ''}${a.ratingUp}</b>口碑</span>` : ''}
        </div>
        <a class="btn sm" href="#/admin/studio/${a.id}">编排</a>
      </div>`).join('') : '<div class="empty-box"><div class="big">🤖</div>还没有自己的智能体——从右侧行业模板快速创建一个</div>';

    const advs = data.advises;
    el.querySelector('#advises').innerHTML = advs.length ? advs.map(a => `
      <div class="is-adv ${a.level}">${a.level === 'warn' ? '⚠️' : 'ℹ️'} <span>${esc(a.text)}</span></div>`).join('')
      : '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">🎉 一切正常——智能体配置与运行状态良好，继续保持</div>';

    el.querySelector('#tpls').innerHTML = data.templates.map(t => `
      <div class="tpl" data-tpl="${t.id}">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span style="font-size:20px">${esc(t.icon || '📋')}</span><b style="font-size:13px">${esc(t.name)}</b></div>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">${esc(t.industry)} 行业</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">${esc((t.description || '').slice(0, 46))}…</div>
      </div>`).join('');
    el.querySelectorAll('[data-tpl]').forEach(d => d.onclick = () => location.hash = '#/admin/agents');
  }

  async function load() {
    data = (await api('/biz/insights')).data;
    renderAll();
  }

  await load();
}
