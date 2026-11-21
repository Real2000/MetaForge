/** D3-2 经验自进化（后台）— 专家×任务类型可靠度 + 编排优选 + 自进化验收指标
 *  - 指标：经验对 / 覆盖专家 / 总运行次数 / 二次成功率提升（验收 ≥ 15pp）
 *  - 任务类型经验分布：各类型首跑 vs 复跑成功率
 *  - 专家可靠度排行：按任务类型选出高分专家（编排「优先高分」的依据）
 *  内核 src-server/lib/experience.js（纯逻辑）
 */
import { api } from '../api.js';
import { esc, toast, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🧠 ${t('经验自进化')}</h2>
    <span class="sub" style="color:var(--text-3);font-size:13px">${t('按「专家×任务类型」积累可靠度，编排优先选用高分专家')}</span>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">📈 ${t('自进化指标')} <span class="sub">${t('验收线：同类任务二次成功率提升 ≥ 15pp')}</span></h3>
    <div id="xpMetrics">${t('加载中…')}</div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>🏷️ ${t('任务类型经验分布')}</h3>
        <select class="input" id="xpType" style="width:170px;font-size:12px"><option value="">${t('全部类型')}</option></select>
      </div>
      <div id="xpByType">${t('加载中…')}</div>
    </div>
    <div class="card" style="padding:22px"><h3 style="margin-bottom:12px">🏅 ${t('专家可靠度排行')}</h3><div id="xpTop">${t('加载中…')}</div></div>
  </div>
  <div class="card" style="padding:22px;margin-top:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3>🗂️ ${t('经验明细（专家 × 任务类型）')}</h3>
      <button class="btn danger sm" id="xpReset">${t('清空经验')}</button>
    </div>
    <div id="xpRecords">${t('加载中…')}</div>
  </div>`;

  let types = [];
  try { types = (await api('/experience/task-types')).data.types || []; } catch { /* 忽略 */ }
  const sel = box.querySelector('#xpType');
  types.forEach(ty => { const o = document.createElement('option'); o.value = ty.key; o.textContent = ty.label; sel.appendChild(o); });

  function metricCard(label, value, target, ok) {
    const color = ok === true ? 'var(--ok,#16a34a)' : ok === false ? 'var(--danger,#dc2626)' : 'var(--text-3)';
    return `<div style="flex:1;min-width:150px;padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;background:var(--bg-2,#fafbfc)">
      <div style="font-size:12px;color:var(--text-3)">${esc(label)}</div>
      <div style="font-size:26px;font-weight:700;color:${color};margin:6px 0">${value == null ? '—' : value}</div>
      <div style="font-size:12px;color:${color}">${ok === true ? '✓ ' + t('达标') : ok === false ? '✗ ' + t('未达标') : ''} <span style="color:var(--text-3)">${esc(target)}</span></div>
    </div>`;
  }

  function loadMetrics() {
    const el = box.querySelector('#xpMetrics');
    api('/experience/stats').then(j => {
      const d = j.data || {}, ov = d.overview || {}, ev = d.evolution || {};
      el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${metricCard(t('二次成功率提升'), ev.delta == null ? null : (ev.delta > 0 ? '+' : '') + ev.delta + 'pp', `${t('目标 ≥')} ${ev.target != null ? ev.target : 15}pp`, ev.meetsTarget)}
        ${metricCard(t('经验对（专家×类型）'), ov.pairs || 0, `${t('覆盖')} ${ov.agents || 0} ${t('专家')} / ${ov.taskTypes || 0} ${t('类型')}`)}
        ${metricCard(t('累计运行次数'), ov.totalRuns || 0, `${t('成功')} ${ov.totalSuccess || 0}`)}
        ${metricCard(t('整体成功率'), ov.successRate == null ? null : ov.successRate + '%', `${t('首跑')} ${ev.firstRate == null ? '—' : ev.firstRate + '%'} / ${t('复跑')} ${ev.repeatRate == null ? '—' : ev.repeatRate + '%'}`)}
      </div>`;
      renderByType(d.byType || []);
      renderTop(d.top || []);
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  function renderByType(rows) {
    const el = box.querySelector('#xpByType');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无经验数据——编排运行后会按任务类型自动积累')}</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>${t('任务类型')}</th><th>${t('专家数')}</th><th>${t('首跑成功率')}</th><th>${t('复跑成功率')}</th><th>${t('提升')}</th></tr></thead><tbody>${rows.map(r => `
      <tr><td>${esc(r.type_label || r.task_type)}</td>
      <td style="font-size:12px">${r.agents || 0}</td>
      <td style="font-size:12px">${r.firstRate == null ? '—' : r.firstRate + '%'} <span style="color:var(--text-3)">(${r.firstRuns})</span></td>
      <td style="font-size:12px">${r.repeatRate == null ? '—' : r.repeatRate + '%'} <span style="color:var(--text-3)">(${r.repeatRuns})</span></td>
      <td><span class="tag ${(r.delta || 0) >= 15 ? 'green' : (r.delta || 0) > 0 ? 'orange' : 'gray'}">${r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + r.delta + 'pp'}</span></td></tr>`).join('')}</tbody></table>`;
  }

  function renderTop(rows) {
    const el = box.querySelector('#xpTop');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无专家经验——编排运行后自动积累')}</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>#</th><th>${t('专家')}</th><th>${t('任务类型')}</th><th>${t('可靠度')}</th><th>${t('成功率')}</th><th>${t('样本')}</th></tr></thead><tbody>${rows.map((r, i) => `
      <tr><td style="color:var(--text-3)">${i + 1}</td>
      <td style="font-size:12px">${esc(r.name || '#' + r.agent_id)}</td>
      <td style="font-size:12px">${esc(r.type_label)}</td>
      <td><b style="color:${r.reliability >= 60 ? 'var(--ok,#16a34a)' : r.reliability < 40 ? 'var(--danger,#dc2626)' : 'inherit'}">${r.reliability}</b></td>
      <td style="font-size:12px">${r.successRate == null ? '—' : r.successRate + '%'}</td>
      <td style="font-size:12px">${r.runs}${r.confidence ? '' : ` <span style="color:var(--text-3)">${t('样本少')}</span>`}</td></tr>`).join('')}</tbody></table>`;
  }

  let records = [];
  function loadRecords() {
    const el = box.querySelector('#xpRecords');
    api('/experience/records').then(j => {
      records = j.data || [];
      if (!records.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无经验记录')}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr><th>${t('专家')}</th><th>${t('任务类型')}</th><th>${t('运行')}</th><th>${t('成功')}</th><th>${t('失败')}</th><th>${t('首/复跑')}</th><th>${t('均耗时')}</th><th>${t('最近')}</th></tr></thead><tbody>${records.map(r => `
        <tr><td style="font-size:12px">#${r.agent_id}</td>
        <td style="font-size:12px">${esc(r.type_label)}</td>
        <td style="font-size:12px">${r.runs}</td>
        <td style="font-size:12px">${r.success}</td>
        <td style="font-size:12px">${r.failed}</td>
        <td style="font-size:12px">${(r.first_runs || 0)} / ${(r.repeat_runs || 0)}</td>
        <td style="font-size:12px">${r.avgDurationMs ? Math.round(r.avgDurationMs / 1000) + 's' : '—'}</td>
        <td style="font-size:11px;color:var(--text-3)">${esc((r.lastAt || '').slice(0, 16))}</td></tr>`).join('')}</tbody></table>`;
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  sel.onchange = () => loadTopByType(sel.value);
  function loadTopByType(taskType) {
    api('/experience/agents' + (taskType ? '?task_type=' + encodeURIComponent(taskType) : '')).then(j => {
      renderTop((j.data || []).filter(x => x.runs > 0).slice(0, 20));
    }).catch(() => { });
  }

  box.querySelector('#xpReset').onclick = async () => {
    if (!(await confirmBox(t('确定清空全部经验数据？此操作不可恢复。')))) return;
    try { await api('/experience/reset', { method: 'POST' }); toast(t('已清空'), 'ok'); loadMetrics(); loadRecords(); }
    catch (e) { toast(e.message, 'err'); }
  };

  loadMetrics();
  loadRecords();
}
