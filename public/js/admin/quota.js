/** 后台-用量与配额（P2）：用户 Token 配额管理 + 全平台用量报表 */
import { api } from '../api.js';
import { esc, toast, modal, lineChart } from '../ui.js';

export async function render(el) {
  let report = null;

  el.innerHTML = `
  <div class="page-head">
    <h2>用量与配额</h2>
    <div class="desc">用户级 Token 配额管理与全平台用量统计——配额为 0 表示不限制；对话 / 技能 / 分享页 / API 调用统一记账。</div>
  </div>
  <div id="summary" class="grid-4" style="margin-bottom:14px"></div>
  <div class="card" style="margin-bottom:14px;padding:14px 18px">
    <h3 style="margin:0 0 8px">近 14 天用量趋势</h3>
    <canvas id="trendC"></canvas>
  </div>
  <div class="grid-2" style="align-items:start">
    <div class="card"><h3 style="margin:0 0 10px">👤 用户配额</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>用户</th><th>部门</th><th>已用 / 配额</th><th>占比</th><th>操作</th></tr></thead><tbody id="tbody"></tbody></table></div></div>
    <div>
      <div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 10px">🤖 智能体用量 TOP（近 30 天）</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>智能体</th><th>Tokens</th><th>调用次数</th></tr></thead><tbody id="agentTb"></tbody></table></div></div>
      <div class="card"><h3 style="margin:0 0 10px">🧠 模型用量 TOP（近 30 天）</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>模型</th><th>Tokens</th><th>调用次数</th></tr></thead><tbody id="modelTb"></tbody></table></div></div>
    </div>
  </div>`;

  function fmt(n) { return (n || 0).toLocaleString('zh-CN'); }

  function renderAll() {
    // 汇总卡片
    el.querySelector('#summary').innerHTML = `
      <div class="stat"><div class="s-label">用户总数</div><div class="s-num">${fmt(report.summary.total_users)}</div></div>
      <div class="stat"><div class="s-label">受限用户</div><div class="s-num">${fmt(report.summary.limited_users)}</div></div>
      <div class="stat"><div class="s-label">配额总量</div><div class="s-num">${report.summary.quota_total ? fmt(report.summary.quota_total) : '∞'}</div></div>
      <div class="stat"><div class="s-label">累计已用</div><div class="s-num">${fmt(report.summary.quota_used)}<span class="s-unit">tokens</span></div></div>`;

    // 用户表
    el.querySelector('#tbody').innerHTML = report.rows.map(r => `
      <tr>
        <td><b>${esc(r.nickname || r.username)}</b><br><span style="font-size:11px;color:var(--text-3)">${esc(r.username)}${r.status === 0 ? '（停用）' : ''}</span></td>
        <td style="color:var(--text-3)">${esc(r.dept || '-')}</td>
        <td><b>${fmt(r.quota_used)}</b> / ${r.unlimited ? '<span style="color:#059669">不限</span>' : fmt(r.quota_total)}</td>
        <td>${r.unlimited ? '<span class="tag green">不限</span>' : `<div style="background:#f1f3f7;border-radius:6px;height:8px;width:80px;overflow:hidden"><div style="width:${r.percent}%;height:100%;background:${r.percent >= 100 ? '#ef4444' : r.percent >= 80 ? '#f59e0b' : '#2563eb'}"></div></div><span style="font-size:11px;color:var(--text-3)">${r.percent}%</span>`}</td>
        <td><button class="btn link" data-set="${esc(r.username)}">设置配额</button></td>
      </tr>`).join('');

    el.querySelectorAll('[data-set]').forEach(b => b.onclick = () => openSet(b.dataset.set));

    // 智能体 / 模型表
    el.querySelector('#agentTb').innerHTML = report.byAgent.map(a => `
      <tr><td>🤖 ${esc(a.agent_name || '首页助手')}</td><td><b>${fmt(a.tokens)}</b></td><td style="color:var(--text-3)">${fmt(a.calls)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">暂无数据</td></tr>';
    el.querySelector('#modelTb').innerHTML = report.byModel.map(m => `
      <tr><td class="mono">${esc(m.model)}</td><td><b>${fmt(m.tokens)}</b></td><td style="color:var(--text-3)">${fmt(m.calls)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">暂无数据</td></tr>';

    // 趋势图
    const c = el.querySelector('#trendC');
    if (c) lineChart(c, report.trend.map(t => t.day.slice(5)), report.trend.map(t => t.tokens));
  }

  function openSet(username) {
    const r = report.rows.find(x => x.username === username);
    modal({
      title: `设置配额 - ${r.nickname || username}`,
      body: `
        <div class="form-item"><label>Token 配额（当前已用 ${fmt(r.quota_used)}）</label>
          <input class="input" id="q_total" type="number" min="0" step="10000" value="${r.quota_total || 0}" placeholder="0 = 不限制">
          <div class="hint">常用档位：
            <a href="javascript:;" data-q="0">不限</a> ·
            <a href="javascript:;" data-q="100000">10 万</a> ·
            <a href="javascript:;" data-q="1000000">100 万</a> ·
            <a href="javascript:;" data-q="5000000">500 万</a>
          </div>
        </div>`,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        mask.querySelectorAll('[data-q]').forEach(a => a.onclick = () => { mask.querySelector('#q_total').value = a.dataset.q; });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const total = Math.max(0, Math.floor(+mask.querySelector('#q_total').value || 0));
          try {
            const j = await api(`/quota/users/${username}`, { method: 'PUT', body: { total } });
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
}
