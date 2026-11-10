/** 后台-运营监控：空间/智能体/用户/留存 + 会话记录审计 */
import { api } from '../api.js';
import { esc, toast, modal, lineChart, fmtNum } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  el.innerHTML = `<div class="empty-box"><div class="big">⏳</div>${t('加载中…')}</div>`;
  const [jo, ju] = await Promise.all([api('/stats/operation'), api('/stats/users')]);
  const d = jo.data;
  const users = ju.data;

  el.innerHTML = `
    <div class="page-head"><h2>${t('运营监控')}</h2><div class="desc">${t('空间分布、智能体分布、活跃/留存趋势与全平台会话审计。')}</div></div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">${t('空间总量')}</div><div class="num" style="color:#059669">${d.cards.spaceTotal}</div>
        <div class="sub">${t('企业')} ${d.cards.spaceByType.enterprise} · ${t('部门')} ${d.cards.spaceByType.dept} · ${t('个人')} ${d.cards.spaceByType.personal}</div>
        <div class="accent" style="background:#059669"></div></div>
      <div class="stat-card"><div class="label">${t('智能体总量')}</div><div class="num" style="color:#2563eb">${d.cards.agentTotal}</div>
        <div class="sub">${t('企业')} ${d.cards.agentsBySpace.enterprise} · ${t('部门')} ${d.cards.agentsBySpace.dept} · ${t('个人')} ${d.cards.agentsBySpace.personal}</div>
        <div class="accent" style="background:#2563eb"></div></div>
      <div class="stat-card"><div class="label">${t('平台用户')}</div><div class="num" style="color:#7c3aed">${d.cards.users}</div>
        <div class="sub">${t('管理员')} ${users.filter(u => u.role === 'admin').length} ${t('人')}</div>
        <div class="accent" style="background:#7c3aed"></div></div>
      <div class="stat-card"><div class="label">${t('7 日留存率')}</div><div class="num" style="color:#d97706">${d.cards.retention}%</div>
        <div class="sub">${t('7 日内活跃用户最近一日仍活跃')}</div>
        <div class="accent" style="background:#d97706"></div></div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h3>${t('活跃用户数')} <span class="sub">${t('近 7 天')}</span></h3><div class="chart-box"><canvas id="o1"></canvas></div></div>
      <div class="card"><h3>${t('用户总量趋势')} <span class="sub">${t('近 7 天')}</span></h3><div class="chart-box"><canvas id="o2"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>${t('会话记录审计')} <span class="sub">${t('全平台最近 100 条会话')}</span></h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('会话')}</th><th>${t('所属智能体')}</th><th>${t('用户')}</th><th>${t('消息数')}</th><th>${t('最近活跃')}</th><th>${t('操作')}</th></tr></thead>
        <tbody>${d.sessions.map(s => `
          <tr>
            <td>${esc(s.title || t('新会话'))}</td>
            <td>${s.agent_name ? '🤖 ' + esc(s.agent_name) : `<span class="tag gray">${t('首页助手')}</span>`}</td>
            <td><b>${esc(s.username)}</b></td>
            <td>${s.msg_count}</td>
            <td style="color:var(--text-3);font-size:12px">${esc(s.updated_at || '')}</td>
            <td><button class="btn link" data-view="${s.id}">${t('查看对话')}</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  const labels = d.days.map(s => s.slice(5));
  lineChart(el.querySelector('#o1'), labels, d.activeSeries, '#059669');
  lineChart(el.querySelector('#o2'), labels, d.userSeries, '#7c3aed');

  el.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    const j = await api(`/stats/sessions/${b.dataset.view}/messages`);
    modal({
      title: t('会话内容审计'),
      body: j.data.map(m => `
        <div class="msg ${m.role === 'user' ? 'user' : 'bot'}" style="margin-bottom:14px">
          <div class="m-avatar">${m.role === 'user' ? 'Me' : 'AI'}</div>
          <div class="m-body"><div class="m-name">${m.role === 'user' ? t('用户') : t('智能体')} · ${esc(m.created_at)}${m.role === 'assistant' ? ` <button class="btn link" data-trace="${m.id}" style="font-size:11px;padding:0 4px">🔍 ${t('链路')}</button>` : ''}</div>
          <div class="m-bubble">${esc(m.content)}</div></div>
        </div>`).join('') || `<div class="empty-box">${t('无消息')}</div>`,
      wide: true,
      onMount(mask) { bindTrace(mask); },
    });
  });

  /** 链路追踪详情弹窗 */
  function bindTrace(scope) {
    scope.querySelectorAll('[data-trace]').forEach(b => b.onclick = async () => {
      let j;
      try { j = await api(`/stats/messages/${b.dataset.trace}/trace`); } catch (e) { toast(e.message, 'err'); return; }
      const td = j.data;
      const toolCalls = td.tool_calls || [];
      const kbHits = td.kb_hits || [];
      const body = `
        <div class="grid-stats" style="grid-template-columns:repeat(4,1fr)">
          <div class="stat-card"><div class="label">${t('调用模式')}</div><div class="num" style="font-size:18px">${td.mode === 'dify' ? t('Dify 转发') : td.mode === 'real' ? t('真实模型') : td.mode}</div></div>
          <div class="stat-card"><div class="label">${t('模型')}</div><div class="num" style="font-size:18px">${esc(td.model || '-')}</div></div>
          <div class="stat-card"><div class="label">${t('耗时')}</div><div class="num" style="font-size:18px">${td.latency_ms} ms</div></div>
          <div class="stat-card"><div class="label">Token / Prompt</div><div class="num" style="font-size:18px">${td.tokens} / ${td.prompt_chars}${t('字')}</div></div>
        </div>
        <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-top:12px">
          <h3 style="margin:0 0 8px">📚 ${t('知识库命中')}（${kbHits.length}）</h3>
          ${kbHits.length ? kbHits.map((h, i) => `
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                <b>[${i + 1}] ${esc(h.file || h.kb || '-')}</b>
                <span>${t('融合')} ${h.score} · BM25 ${h.bm25} · ${t('向量')} ${h.vec}</span>
              </div>
              <div style="font-size:12px;color:var(--text-2)">${esc(h.excerpt || '')}</div>
            </div>`).join('') || '' : `<div class="hint">${t('本轮未触发知识库检索')}</div>`}
        </div>
        <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-top:12px">
          <h3 style="margin:0 0 8px">🔧 ${t('工具调用')}（${toolCalls.length}）</h3>
          ${toolCalls.length ? toolCalls.map(tc => `
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px">
              <b style="font-size:13px">${esc(tc.name)}</b>
              <div style="font-size:12px;color:var(--text-2);margin-top:4px">${t('参数：')}${esc((tc.args || '').slice(0, 150))}</div>
              <div style="font-size:12px;margin-top:4px">${t('结果：')}${esc((tc.result || '').slice(0, 200))}</div>
            </div>`).join('') || '' : `<div class="hint">${t('本轮未调用工具')}</div>`}
        </div>
        ${td.blocked ? `<div class="hint" style="color:var(--danger)">⚠ ${t('输出脱敏词：')}${esc(td.blocked)}</div>` : ''}`;
      modal({ title: `${t('链路追踪详情（')}${esc(td.created_at || '')}）`, body, wide: true });
    });
  }
}
