/** 后台-系统监控：服务监控（真实指标）+ 操作日志 + 异常日志 */
import { api } from '../api.js';
import { esc, toast, lineChart, fmtBytes, fmtNum, fmtUptime, pager, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let tab = 'server';
  el.innerHTML = `
    <div class="page-head"><h2>${t('系统监控')}</h2><div class="desc">${t('服务资源实时监控（CPU/内存/磁盘真实指标）与操作、异常日志审计。')}</div></div>
    <div class="tabs" id="tabs">
      <div class="tab active" data-t="server">${t('服务监控')}</div>
      <div class="tab" data-t="op">${t('操作日志')}</div>
      <div class="tab" data-t="err">${t('异常日志')}</div>
    </div>
    <div id="pane"></div>`;
  const pane = el.querySelector('#pane');
  let timer = null;

  el.querySelectorAll('#tabs .tab').forEach(tb => tb.onclick = () => {
    el.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('active'));
    tb.classList.add('active');
    tab = tb.dataset.t;
    clearInterval(timer);
    tab === 'server' ? loadServer() : tab === 'op' ? loadOp(1) : loadErr(1);
  });

  // ---------- 服务监控 ----------
  async function loadServer() {
    pane.innerHTML = `<div class="empty-box"><div class="big">📡</div>${t('采集中…')}</div>`;
    const draw = async () => {
      try {
        const j = await api('/monitor/server');
        const d = j.data;
        const memPct = d.mem.pct;
        const diskPct = d.disk ? d.disk.pct : 0;
        pane.innerHTML = `
          <div class="grid-stats">
            ${[
          { l: t('CPU 使用率'), v: (d.samples.at(-1)?.cpu ?? 0) + '%', c: '#2563eb', p: d.samples.at(-1)?.cpu ?? 0 },
          { l: t('内存使用率'), v: memPct + '%', c: '#7c3aed', p: memPct, sub: `${fmtBytes(d.mem.total - d.mem.free)} / ${fmtBytes(d.mem.total)}` },
          { l: t('磁盘使用率'), v: diskPct + '%', c: diskPct > 80 ? '#dc2626' : '#059669', p: diskPct, sub: d.disk ? `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)}` : '-' },
          { l: t('运行时长'), v: fmtUptime(d.uptime), c: '#d97706', sub: t('进程已运行 {n}').replace('{n}', fmtUptime(d.processUptime)) },
        ].map(c => `
              <div class="stat-card">
                <div class="label">${c.l}</div>
                <div class="num" style="color:${c.c};font-size:22px">${c.v}</div>
                <div class="progressbar" style="margin-top:8px"><i style="width:${Math.min(c.p, 100)}%"></i></div>
                ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
                <div class="accent" style="background:${c.c}"></div>
              </div>`).join('')}
          </div>
          <div class="grid-2" style="margin-top:16px">
            <div class="card"><h3>${t('CPU 使用率（实时 90s）')}<button class="btn sm" id="refBtn" style="margin-left:auto">${t('刷新')}</button></h3><div class="chart-box"><canvas id="cpuChart"></canvas></div></div>
            <div class="card"><h3>${t('内存使用率（实时 90s）')}</h3><div class="chart-box"><canvas id="memChart"></canvas></div></div>
          </div>
          <div class="card" style="margin-top:16px"><h3>${t('系统信息')}</h3>
            <div class="kv">
              <span class="k">${t('主机名')}</span><span>${esc(d.hostname)}</span>
              <span class="k">${t('操作系统')}</span><span>${esc(d.os)}</span>
              <span class="k">CPU</span><span>${esc(d.cpuModel)} × ${d.cpus} ${t('核')}</span>
              <span class="k">${t('Node 版本')}</span><span class="mono">${esc(d.nodeVersion)}</span>
              <span class="k">${t('系统负载')}</span><span class="mono">${d.loadavg.map(x => x.toFixed(2)).join(' / ')}</span>
            </div>
          </div>`;
        const labels = d.samples.map(s => new Date(s.t).toLocaleTimeString('zh-CN', { hour12: false }).slice(3));
        lineChart(pane.querySelector('#cpuChart'), labels, d.samples.map(s => s.cpu), '#2563eb');
        lineChart(pane.querySelector('#memChart'), labels, d.samples.map(s => s.mem), '#7c3aed');
        pane.querySelector('#refBtn').onclick = draw;
      } catch (e) {
        pane.innerHTML = `<div class="empty-box"><div class="big">⚠️</div>${esc(e.message)}</div>`;
      }
    };
    await draw();
    timer = setInterval(draw, 3000);
  }

  // ---------- 操作日志 ----------
  async function loadOp(page) {
    const kw = pane.querySelector?.('#op_kw')?.value?.trim() || '';
    const j = await api(`/monitor/op-logs?page=${page}&size=15${kw ? `&keyword=${encodeURIComponent(kw)}` : ''}`);
    const { list, total } = j.data;
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <input class="input" id="op_kw" placeholder="${t('🔍 搜索用户/操作/详情')}" style="width:260px" value="${esc(kw)}">
          <span style="color:var(--text-2)">${t('共 {n} 条').replace('{n}', total)}</span>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('时间')}</th><th>${t('用户')}</th><th>${t('操作')}</th><th>${t('详情')}</th><th>IP</th></tr></thead>
          <tbody>${list.map(l => `
            <tr>
              <td style="color:var(--text-3);white-space:nowrap">${esc(l.created_at)}</td>
              <td><b>${esc(l.username)}</b></td>
              <td><span class="tag blue">${esc(t(l.action))}</span></td>
              <td style="color:var(--text-2)">${esc(l.detail || '-')}</td>
              <td class="mono">${esc(l.ip || '-')}</td>
            </tr>`).join('') || `<tr><td colspan="5" class="empty">${t('暂无日志')}</td></tr>`}
           </tbody>
         </table></div>
        <div class="pager" id="opPager"></div>
      </div>`;
    pane.querySelector('#op_kw').oninput = () => loadOp(1);
    pager(pane.querySelector('#opPager'), { page, size: 15, total, onChange: loadOp });
  }

  // ---------- 异常日志 ----------
  async function loadErr(page) {
    const j = await api(`/monitor/err-logs?page=${page}&size=15`);
    const { list, total } = j.data;
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <span style="color:var(--text-2)">${t('共 {n} 条异常').replace('{n}', total)}</span>
          <button class="btn danger" id="clearErr">${t('清空异常日志')}</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('时间')}</th><th>${t('来源')}</th><th>${t('异常信息')}</th></tr></thead>
          <tbody>${list.map(l => `
            <tr>
              <td style="color:var(--text-3);white-space:nowrap">${esc(l.created_at)}</td>
              <td><span class="tag red">${esc(l.source)}</span></td>
              <td style="color:var(--danger)">${esc(l.message)}</td>
            </tr>`).join('') || `<tr><td colspan="3" class="empty">${t('暂无异常')}</td></tr>`}
           </tbody>
         </table></div>
        <div class="pager" id="errPager"></div>
      </div>`;
    pane.querySelector('#clearErr').onclick = async () => {
      if (!await confirmBox(t('清空全部异常日志？'))) return;
      await api('/monitor/err-logs', { method: 'DELETE' });
      toast(t('已清空')); loadErr(1);
    };
    pager(pane.querySelector('#errPager'), { page, size: 15, total, onChange: loadErr });
  }

  await loadServer();
  // 返回 destroy：路由切换时清理 3s 轮询 interval，防 N 次进出 N 个 interval 叠加泄漏
  return { destroy() { clearInterval(timer); timer = null; } };
}
