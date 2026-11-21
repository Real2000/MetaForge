/** D3-1 3D 与数字人（后台）— 3D 任务成功率指标 + 数字人合规评估
 *  - 指标：3D 任务成功率（验收 ≥ 70%）+ 任务数 + 导出/合规概览
 *  - 3D 生成任务：最近任务列表（含 provider/格式/状态）、失败可重跑
 *  - 数字人合规评估：结构化问卷 → 结论闸门（通过/需复核/拒绝）；记录可追溯
 *  内核 src-server/lib/model3d.js 与 digital-human.js（纯逻辑）
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🧊 ${t('3D 与数字人')}</h2>
    <span class="sub" style="color:var(--text-3);font-size:13px">${t('3D 资产生成与导出 + 数字人合规评估（评估先行）')}</span>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">📈 ${t('3D 任务指标')} <span class="sub">${t('验收线：3D 任务成功率 ≥ 70%')}</span></h3>
    <div id="m3Metrics">${t('加载中…')}</div>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">🧾 ${t('最近 3D 生成任务')}</h3>
    <div id="m3Tasks">${t('加载中…')}</div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>🛡️ ${t('数字人合规评估')}</h3>
        <button class="btn primary" id="dhNew">＋ ${t('发起评估')}</button>
      </div>
      <div id="dhList">${t('加载中…')}</div>
    </div>
    <div class="card" style="padding:22px"><h3 style="margin-bottom:12px">⬇ ${t('最近导出记录')}</h3><div id="m3Exports">${t('加载中…')}</div></div>
  </div>`;

  box.querySelector('#dhNew').onclick = () => dhForm();

  function metricCard(label, value, target, ok) {
    const color = ok === true ? 'var(--ok,#16a34a)' : ok === false ? 'var(--danger,#dc2626)' : 'var(--text-3)';
    return `<div style="flex:1;min-width:150px;padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;background:var(--bg-2,#fafbfc)">
      <div style="font-size:12px;color:var(--text-3)">${esc(label)}</div>
      <div style="font-size:26px;font-weight:700;color:${color};margin:6px 0">${value == null ? '—' : value}</div>
      <div style="font-size:12px;color:${color}">${ok === true ? '✓ ' + t('达标') : ok === false ? '✗ ' + t('未达标') : ''} <span style="color:var(--text-3)">${esc(target)}</span></div>
    </div>`;
  }

  function loadMetrics() {
    const el = box.querySelector('#m3Metrics');
    api('/model3d/stats').then(j => {
      const d = j.data || {}, s = d.stats || {}, dh = d.dh || {};
      el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${metricCard(t('3D 任务成功率'), s.successRate == null ? null : s.successRate + '%', t('目标 ≥ 70%'), s.meetsTarget)}
        ${metricCard(t('3D 任务数'), s.total || 0, t('成功 / 失败 / 进行中') + ` ${s.success || 0} / ${s.failed || 0} / ${s.running || 0}`)}
        ${metricCard(t('合规评估'), (dh.approve || 0) + (dh.review || 0) + (dh.reject || 0), t('通过 / 复核 / 拒绝') + ` ${dh.approve || 0} / ${dh.review || 0} / ${dh.reject || 0}`)}
        ${metricCard(t('导出记录'), (d.exports || []).length, t('近 50 条'))}
      </div>`;
      renderTasks(s.recent || d.recent || []);
      renderExports(d.exports || []);
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  function renderTasks(rows) {
    const el = box.querySelector('#m3Tasks');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无 3D 生成任务——到「创作资产」项目中点「生成 3D 资产」体验')}</div>`; return; }
    const TAG = { success: 'green', failed: 'red', running: 'orange', queued: 'gray' };
    el.innerHTML = `<table class="table"><thead><tr><th>${t('时间')}</th><th>${t('用户')}</th><th>${t('提示词')}</th><th>${t('格式')}</th><th>${t('通道')}</th><th>${t('状态')}</th><th>${t('耗时')}</th><th></th></tr></thead><tbody>${rows.map(r => `
      <tr><td style="font-size:12px;color:var(--text-3)">${esc(r.created_at || '')}</td>
      <td style="font-size:12px">${esc(r.username || '')}</td>
      <td style="font-size:12px" title="${esc(r.prompt)}">${esc((r.prompt || '').slice(0, 40))}</td>
      <td style="font-size:12px">${esc(r.format || '')}</td>
      <td style="font-size:12px">${esc(r.provider || '—')}</td>
      <td><span class="tag ${TAG[r.status] || 'gray'}">${esc(r.status)}</span>${r.error ? `<div style="font-size:11px;color:var(--danger,#dc2626)" title="${esc(r.error)}">${esc(r.error.slice(0, 40))}</div>` : ''}</td>
      <td style="font-size:12px">${r.duration_ms || 0}ms</td>
      <td>${r.status === 'failed' ? `<button class="btn sm" data-retry="${r.id}">${t('重跑')}</button>` : (r.url ? `<a class="btn sm" href="${esc(r.url)}" target="_blank">${t('查看')}</a>` : '')}</td></tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
      try { await api(`/model3d/tasks/${b.dataset.retry}/retry`, { method: 'POST' }); toast(t('已重跑'), 'ok'); loadMetrics(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  function renderExports(rows) {
    const el = box.querySelector('#m3Exports');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无导出记录')}</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>${t('时间')}</th><th>${t('用户')}</th><th>${t('资产')}</th><th>${t('格式')}</th><th>${t('结果')}</th></tr></thead><tbody>${rows.map(r => `
      <tr><td style="font-size:12px;color:var(--text-3)">${esc(r.created_at || '')}</td>
      <td style="font-size:12px">${esc(r.username || '')}</td>
      <td style="font-size:12px">#${r.asset_id}</td>
      <td style="font-size:12px">${esc(r.source_format)} → ${esc(r.target_format)}</td>
      <td><span class="tag ${r.need_convert ? 'orange' : 'green'}">${esc(r.status)}</span></td></tr>`).join('')}</tbody></table>`;
  }

  const DEC_TAG = { approve: 'green', review: 'orange', reject: 'red' };
  function loadDh() {
    const el = box.querySelector('#dhList');
    api('/model3d/dh/assessments').then(j => {
      const rows = j.data || [];
      if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无评估记录——点「发起评估」对数字人/真人合成素材做合规把关')}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr><th>${t('时间')}</th><th>${t('用户')}</th><th>${t('素材')}</th><th>${t('得分')}</th><th>${t('结论')}</th></tr></thead><tbody>${rows.map(r => `
        <tr><td style="font-size:12px;color:var(--text-3)">${esc(r.created_at || '')}</td>
        <td style="font-size:12px">${esc(r.username || '')}</td>
        <td style="font-size:12px">${r.asset_id ? '#' + r.asset_id : '（单次评估）'}</td>
        <td style="font-size:12px">${r.score}</td>
        <td><span class="tag ${DEC_TAG[r.decision] || 'gray'}">${esc(r.decision)}</span>
          <div style="font-size:11px;color:var(--text-3)">${esc((r.reasons || []).map(x => x.msg).join('；').slice(0, 50))}</div></td></tr>`).join('')}</tbody></table>`;
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  async function dhForm() {
    let items = [];
    try { items = (await api('/model3d/dh/items')).data.items || []; } catch { /* 用空表单兜底 */ }
    const bodyHtml = items.map(it => `<label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;font-size:13px">
        <input type="checkbox" id="dh_${esc(it.key)}"> <span>${esc(it.label)}</span></label>`).join('') +
      `<div class="st-field" style="margin-top:10px"><label>${t('关联素材 ID（可选）')}</label><input class="input" id="dhAsset" style="width:100%" placeholder="${t('留空则为单次评估')}"></div>`;
    modal({
      title: `🛡️ ${t('数字人合规评估')}`,
      wide: true,
      body: `<div style="font-size:12px;color:var(--text-3);margin-bottom:10px">${t('勾选表示「是」；未勾选表示「否」。涉及真人/数字人请如实填写。')}</div>${bodyHtml}`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn primary" id="dhOk">${t('评估')}</button>`,
      onMount(m, close) {
        m.querySelector('[data-close]').onclick = close;
        m.querySelector('#dhOk').onclick = async () => {
          const answers = {};
          for (const it of items) answers[it.key] = m.querySelector('#dh_' + it.key)?.checked ? 1 : 0;
          const assetId = m.querySelector('#dhAsset').value.trim();
          try {
            const r = await api('/model3d/dh/assess', { method: 'POST', body: { answers, asset_id: assetId || undefined } });
            const d = r.data;
            alert(`${t('评估结论')}：${d.decisionLabel}\n${t('风险级别')}：${d.level} · ${t('得分')}：${d.score}\n\n${t('必要动作')}：\n${(d.requiredActions || []).map(x => '· ' + x).join('\n') || '（无）'}`);
            close(); loadDh(); loadMetrics();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  loadMetrics();
  loadDh();
}
