/** 后台-用量与配额（P2）：用户 Token 配额管理 + 全平台用量报表 */
import { api } from '../api.js';
import { esc, toast, modal, lineChart } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let report = null;

  el.innerHTML = `
  <div class="page-head">
    <h2>${t('用量与配额')}</h2>
    <div class="desc">${t('用户级 Token 配额管理与全平台用量统计——配额为 0 表示不限制；对话 / 技能 / 分享页 / API 调用统一记账。')}</div>
  </div>
  <div id="summary" class="grid-4" style="margin-bottom:14px"></div>
  <div class="card" style="margin-bottom:14px;padding:14px 18px">
    <h3 style="margin:0 0 8px">${t('近 14 天用量趋势')}</h3>
    <canvas id="trendC"></canvas>
  </div>
  <div class="grid-2" style="align-items:start">
    <div class="card"><h3 style="margin:0 0 10px">👤 ${t('用户配额')}</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>${t('用户')}</th><th>${t('部门')}</th><th>${t('已用 / 配额')}</th><th>${t('占比')}</th><th>${t('操作')}</th></tr></thead><tbody id="tbody"></tbody></table></div></div>
    <div>
      <div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 10px">🤖 ${t('智能体用量 TOP（近 30 天）')}</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>${t('智能体')}</th><th>Tokens</th><th>${t('调用次数')}</th></tr></thead><tbody id="agentTb"></tbody></table></div></div>
      <div class="card"><h3 style="margin:0 0 10px">🧠 ${t('模型用量 TOP（近 30 天）')}</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>${t('模型')}</th><th>Tokens</th><th>${t('调用次数')}</th></tr></thead><tbody id="modelTb"></tbody></table></div></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px;padding:14px 18px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <h3 style="margin:0">🧮 ${t('计费对账（单价 × 用量 = 应收）')}</h3>
      <input class="input" id="recMonth" type="month" style="width:150px;margin-left:auto">
      <button class="btn" id="recBtn">${t('刷新')}</button>
    </div>
    <div id="recGate" class="grid-4" style="margin:12px 0"></div>
    <div class="table-wrap"><table class="tbl"><thead><tr>
      <th>${t('模型')}</th><th>${t('调用')}</th><th>${t('输入/输出 tokens')}</th><th>${t('单价（元/千Token）')}</th><th>${t('应收')}</th><th>${t('账面')}</th><th>${t('误差')}</th>
    </tr></thead><tbody id="recTb"></tbody></table></div>
  </div>`;

  function fmtMoney(n) { return '¥' + (Number(n) || 0).toFixed(4); }
  function fmt(n) { return (n || 0).toLocaleString('zh-CN'); }

  function renderAll() {
    // 汇总卡片
    el.querySelector('#summary').innerHTML = `
      <div class="stat"><div class="s-label">${t('用户总数')}</div><div class="s-num">${fmt(report.summary.total_users)}</div></div>
      <div class="stat"><div class="s-label">${t('受限用户')}</div><div class="s-num">${fmt(report.summary.limited_users)}</div></div>
      <div class="stat"><div class="s-label">${t('配额总量')}</div><div class="s-num">${report.summary.quota_total ? fmt(report.summary.quota_total) : '∞'}</div></div>
      <div class="stat"><div class="s-label">${t('累计已用')}</div><div class="s-num">${fmt(report.summary.quota_used)}<span class="s-unit">tokens</span></div></div>`;

    // 用户表
    el.querySelector('#tbody').innerHTML = report.rows.map(r => `
      <tr>
        <td><b>${esc(r.nickname || r.username)}</b><br><span style="font-size:11px;color:var(--text-3)">${esc(r.username)}${r.status === 0 ? t('（停用）') : ''}</span></td>
        <td style="color:var(--text-3)">${esc(r.dept || '-')}</td>
        <td><b>${fmt(r.quota_used)}</b> / ${r.unlimited ? `<span style="color:#059669">${t('不限')}</span>` : fmt(r.quota_total)}</td>
        <td>${r.unlimited ? `<span class="tag green">${t('不限')}</span>` : `<div style="background:#f1f3f7;border-radius:6px;height:8px;width:80px;overflow:hidden"><div style="width:${r.percent}%;height:100%;background:${r.percent >= 100 ? '#ef4444' : r.percent >= 80 ? '#f59e0b' : '#2563eb'}"></div></div><span style="font-size:11px;color:var(--text-3)">${r.percent}%</span>`}</td>
        <td><button class="btn link" data-set="${esc(r.username)}">${t('设置配额')}</button></td>
      </tr>`).join('');

    el.querySelectorAll('[data-set]').forEach(b => b.onclick = () => openSet(b.dataset.set));

    // 智能体 / 模型表
    el.querySelector('#agentTb').innerHTML = report.byAgent.map(a => `
      <tr><td>🤖 ${esc(a.agent_name || t('首页助手'))}</td><td><b>${fmt(a.tokens)}</b></td><td style="color:var(--text-3)">${fmt(a.calls)}</td></tr>`).join('') || `<tr><td colspan="3" class="empty">${t('暂无数据')}</td></tr>`;
    el.querySelector('#modelTb').innerHTML = report.byModel.map(m => `
      <tr><td class="mono">${esc(m.model)}</td><td><b>${fmt(m.tokens)}</b></td><td style="color:var(--text-3)">${fmt(m.calls)}</td></tr>`).join('') || `<tr><td colspan="3" class="empty">${t('暂无数据')}</td></tr>`;

    // 趋势图
    const c = el.querySelector('#trendC');
    if (c) lineChart(c, report.trend.map(td => td.day.slice(5)), report.trend.map(td => td.tokens));
  }

  function renderReconcile(rec) {
    const g = rec.gate || {};
    el.querySelector('#recGate').innerHTML = `
      <div class="stat"><div class="s-label">${t('应收合计')}</div><div class="s-num">${fmtMoney(rec.total.expect_cost)}</div></div>
      <div class="stat"><div class="s-label">${t('账面合计')}</div><div class="s-num" style="color:${rec.total.balanced ? '#059669' : '#ef4444'}">${fmtMoney(rec.total.actual_cost)}</div></div>
      <div class="stat"><div class="s-label">${t('对账结果')}</div><div class="s-num" style="font-size:18px;color:${rec.total.balanced ? '#059669' : '#ef4444'}">${rec.total.balanced ? t('账实一致 ✓') : t('存在误差 ✗')}</div></div>
      <div class="stat"><div class="s-label">${t('闸门（拦截/活跃/结算）')}</div><div class="s-num" style="font-size:16px">${g.blocked || 0} / ${g.active || 0} / ${g.settled || 0}</div></div>`;
    el.querySelector('#recTb').innerHTML = (rec.items || []).map(it => `
      <tr>
        <td class="mono">${esc(it.model)}</td>
        <td>${fmt(it.calls)}</td>
        <td>${fmt(it.prompt_tokens)} / ${fmt(it.completion_tokens)}</td>
        <td>${it.priced ? `${it.price_input} / ${it.price_output}` : `<span class="tag gray">${t('未定价')}</span>`}</td>
        <td><b>${fmtMoney(it.expect_cost)}</b></td>
        <td>${fmtMoney(it.actual_cost)}</td>
        <td>${it.priced ? (it.balanced ? `<span class="tag green">0</span>` : `<span class="tag red">${it.diff}</span>`) : '<span style="color:var(--text-3)">-</span>'}</td>
      </tr>`).join('') || `<tr><td colspan="7" class="empty">${t('该月暂无计费记录')}</td></tr>`;
  }

  async function loadReconcile() {
    const month = el.querySelector('#recMonth').value || undefined;
    try {
      const rec = (await api('/billing/reconcile' + (month ? `?month=${month}` : ''))).data;
      renderReconcile(rec);
    } catch (e) { toast(e.message, 'err'); }
  }

  function openSet(username) {
    const r = report.rows.find(x => x.username === username);
    modal({
      title: `${t('设置配额')} - ${r.nickname || username}`,
      body: `
        <div class="form-item"><label>${t('Token 配额（当前已用 {n}）').replace('{n}', fmt(r.quota_used))}</label>
          <input class="input" id="q_total" type="number" min="0" step="10000" value="${r.quota_total || 0}" placeholder="${t('0 = 不限制')}">
          <div class="hint">${t('常用档位：')}
            <a href="javascript:;" data-q="0">${t('不限')}</a> ·
            <a href="javascript:;" data-q="100000">${t('10 万')}</a> ·
            <a href="javascript:;" data-q="1000000">${t('100 万')}</a> ·
            <a href="javascript:;" data-q="5000000">${t('500 万')}</a>
          </div>
        </div>
        <div class="form-item"><label>${t('成本配额（元/月，0 = 不限）')}</label>
          <input class="input" id="q_cost" type="number" min="0" step="1" value="${r.cost_quota || 0}" placeholder="${t('0 = 不限制')}">
        </div>
        <div class="form-item"><label>${t('并发上限（0 = 不限）')}</label>
          <input class="input" id="q_conc" type="number" min="0" step="1" value="${r.max_concurrency || 0}" placeholder="${t('0 = 不限制')}">
          <div class="hint">${t('同一用户同时进行的对话请求数上限；超出即拦截（100% 拦截）。')}</div>
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelectorAll('[data-q]').forEach(a => a.onclick = () => { mask.querySelector('#q_total').value = a.dataset.q; });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const total = Math.max(0, Math.floor(+mask.querySelector('#q_total').value || 0));
          const cost_quota = Math.max(0, +mask.querySelector('#q_cost').value || 0);
          const max_concurrency = Math.max(0, Math.floor(+mask.querySelector('#q_conc').value || 0));
          try {
            const j = await api(`/quota/users/${username}`, { method: 'PUT', body: { total } });
            await api(`/billing/users/${username}`, { method: 'PUT', body: { cost_quota, max_concurrency } });
            toast(j.msg);
            close();
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    report = (await api('/quota/report')).data;
    renderAll();
  }
  await load();
  // D2-2 计费对账（默认当月）
  const now2 = new Date();
  el.querySelector('#recMonth').value = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}`;
  el.querySelector('#recBtn').onclick = loadReconcile;
  el.querySelector('#recMonth').onchange = loadReconcile;
  await loadReconcile();
}
