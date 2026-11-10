/** 后台-数据看板 */
import { api } from '../api.js';
import { esc, lineChart, barChart, fmtNum } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  el.innerHTML = `<div class="empty-box"><div class="big">⏳</div>${t('加载中…')}</div>`;
  const j = await api('/stats/dashboard');
  const d = j.data;
  const cards = [
    { label: t('智能体总量'), num: d.cards.agentTotal, color: '#2563eb', sub: `${t('已发布')} ${d.cards.agentPublished} · ${t('含草稿（前台只展示已发布，且分类 tab 会再过滤——数字小于本卡为正常）')}` },
    { label: t('用户总量'), num: d.cards.userTotal, color: '#7c3aed', sub: t('平台注册用户') },
    { label: t('知识库数量'), num: d.cards.kbTotal, color: '#059669', sub: `${t('文件')} ${d.cards.kbFiles} ${t('个')}` },
    { label: t('Token 总消耗'), num: fmtNum(d.cards.tokenTotal), color: '#d97706', sub: t('全部会话累计') },
    { label: t('定时/单次任务'), num: d.cards.taskTotal, color: '#db2777', sub: t('任务管理模块') },
  ];

  // 今日摘要（口径透明化：活跃=当日发过消息的去重用户数；测试者反馈"总消耗 7900 但趋势图 0"实为误读——图上今日是用户数 1，非 token）
  const today = d.days[d.days.length - 1] || '';
  const todayIdx = d.days.length - 1;
  const todayActive = d.activeUsers[todayIdx] ?? 0;
  const todayTokens = d.tokensByDay[todayIdx] ?? 0;

  el.innerHTML = `
    <div class="page-head"><h2>${t('数据看板')}</h2><div class="desc">${t('平台核心运营指标总览（统计范围：全部数据 / 近 7 天趋势）')}</div></div>
    <div class="grid-stats">${cards.map(c => `
      <div class="stat-card">
        <div class="label">${c.label}</div>
        <div class="num" style="color:${c.color}">${c.num}</div>
        <div class="sub">${c.sub}</div>
        <div class="accent" style="background:${c.color}"></div>
      </div>`).join('')}
    </div>
    <div class="card" style="margin-top:16px;padding:10px 16px;display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--text-2)">
      <b style="color:var(--text)">📊 ${t('今日（')}${today}）</b>
      <span>👤 ${t('活跃用户')} <b style="color:var(--text)">${todayActive}</b> ${t('人（发过消息的账号去重——1 人也是正常值，非 0 值异常）')}</span>
      <span>🪙 ${t('Token 消耗')} <b style="color:var(--text)">${fmtNum(todayTokens)}</b>（${t('与右上角「Token 总消耗」口径不同：趋势图仅计当日')}）</span>
      <span>💬 ${t('消息量与模型调用次数不入趋势图（另一口径）')}</span>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h3>${t('活跃用户趋势')} <span class="sub">${t('近 7 天 · 纵轴 = 当日发消息的去重用户数（人）')}</span></h3><div class="chart-box"><canvas id="c1"></canvas></div></div>
      <div class="card"><h3>${t('Token 消耗趋势')} <span class="sub">${t('近 7 天 · 纵轴 = 当日 messages.tokens 合计')}</span></h3><div class="chart-box"><canvas id="c2"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>${t('智能体增长趋势')} <span class="sub">${t('累计创建数')}</span></h3><div class="chart-box"><canvas id="c3"></canvas></div></div>
    <div class="grid-3" style="margin-top:16px">
      ${[
      { title: t('智能体对话数 TOP10'), key: 'topChat', unit: t('次') },
      { title: t('智能体用户数 TOP10'), key: 'topUsers', unit: t('人') },
      { title: t('Token 消耗 TOP10'), key: 'topTokens', unit: '' },
    ].map(cfg => `
      <div class="card">
        <h3>${cfg.title}</h3>
        <table class="tbl"><tbody>
          ${d[cfg.key].map((r, i) => `
            <tr><td style="width:34px">${['🥇', '🥈', '🥉'][i] || (i + 1)}</td><td>${esc(r.name)}</td><td style="text-align:right"><b>${fmtNum(r.c)}</b> ${cfg.unit}</td></tr>`).join('')
      || `<tr><td class="empty" colspan="3">${t('暂无数据')}</td></tr>`}
         </tbody></table>
      </div>`).join('')}
    </div>`;

  const labels = d.days.map(s => s.slice(5));
  lineChart(el.querySelector('#c1'), labels, d.activeUsers, '#2563eb');
  lineChart(el.querySelector('#c2'), labels, d.tokensByDay, '#d97706');
  barChart(el.querySelector('#c3'), labels, d.agentGrowth, '#7c3aed');
}
