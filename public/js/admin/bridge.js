/** D2-3 桌面端升级通道（后台）— 发布清单管理 + 更新成功率/崩溃率指标
 *  - 发布清单：登记/更新/下线/删除；显示文件是否就位与实际 sha256
 *  - 指标：更新成功率（验收 ≥ 95%）/ 崩溃率（验收 < 0.5%）+ 最近更新与崩溃记录
 *  - 决策内核 src-server/lib/bridge-update.js（版本比较/发布选择/完整性/指标）
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox, fmtBytes } from '../ui.js';
import { t } from '../i18n.js';

const PLATFORMS = ['any', 'darwin', 'win32', 'linux'];
const ARCHS = ['any', 'x64', 'arm64'];
const CHANNELS = ['stable', 'beta'];

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🛰️ ${t('桌面端升级')}</h2>
    <span class="sub" style="color:var(--text-3);font-size:13px">${t('客户端自动更新通道：发布清单 + 更新成功率 / 崩溃率')}</span>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">📈 ${t('更新与稳定性指标')} <span class="sub">${t('验收线：更新成功率 ≥ 95%、崩溃率 < 0.5%')}</span></h3>
    <div id="metrics">${t('加载中…')}</div>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3>📦 ${t('发布清单')}</h3>
      <button class="btn primary" id="newReleaseBtn">＋ ${t('登记发布')}</button>
    </div>
    <div id="releaseList">${t('加载中…')}</div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px"><h3 style="margin-bottom:12px">🧾 ${t('最近更新记录')}</h3><div id="updateLog">${t('加载中…')}</div></div>
    <div class="card" style="padding:22px"><h3 style="margin-bottom:12px">💥 ${t('最近崩溃上报')}</h3><div id="crashLog">${t('加载中…')}</div></div>
  </div>`;

  box.querySelector('#newReleaseBtn').onclick = () => releaseForm();

  function metricCard(label, value, target, ok) {
    const color = ok === true ? 'var(--ok,#16a34a)' : ok === false ? 'var(--danger,#dc2626)' : 'var(--text-3)';
    return `<div style="flex:1;min-width:150px;padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;background:var(--bg-2,#fafbfc)">
      <div style="font-size:12px;color:var(--text-3)">${esc(label)}</div>
      <div style="font-size:26px;font-weight:700;color:${color};margin:6px 0">${value == null ? '—' : value}</div>
      <div style="font-size:12px;color:${color}">${ok === true ? '✓ ' + t('达标') : ok === false ? '✗ ' + t('未达标') : ''} <span style="color:var(--text-3)">${esc(target)}</span></div>
    </div>`;
  }

  function loadMetrics() {
    const el = box.querySelector('#metrics');
    api('/localbridge/update-stats').then(j => {
      const d = j.data || {}, s = d.stats || {};
      el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${metricCard(t('更新成功率'), s.successRate == null ? null : s.successRate + '%', t('目标 ≥ 95%'), s.meetsSuccessTarget)}
        ${metricCard(t('崩溃率'), s.crashRate == null ? null : s.crashRate + '%', t('目标 < 0.5%'), s.meetsCrashTarget)}
        ${metricCard(t('更新尝试'), s.total || 0, t('成功 / 失败 / 回滚') + ` ${s.success || 0} / ${s.failed || 0} / ${s.rollback || 0}`)}
        ${metricCard(t('崩溃设备'), s.crashDevices || 0, t('崩溃次数') + ` ${s.crashes || 0}`)}
      </div>`;
      renderUpdates(d.updates || []);
      renderCrashes(d.crashes || []);
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  function renderUpdates(rows) {
    const el = box.querySelector('#updateLog');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无更新记录')}</div>`; return; }
    const TAG = { success: 'green', failed: 'red', rollback: 'orange' };
    el.innerHTML = `<table class="table"><thead><tr><th>${t('时间')}</th><th>${t('设备')}</th><th>${t('版本')}</th><th>${t('结果')}</th><th>${t('耗时')}</th><th>${t('说明')}</th></tr></thead><tbody>${rows.map(r => `
      <tr><td style="font-size:12px;color:var(--text-3)">${esc(r.created_at || '')}</td>
      <td style="font-size:12px">${esc(r.username || ('#' + (r.device_id ?? '—')))}</td>
      <td style="font-size:12px">${esc(r.from_version || '')} → ${esc(r.to_version || '')}</td>
      <td><span class="tag ${TAG[r.status] || 'gray'}">${esc(r.status)}</span></td>
      <td style="font-size:12px">${r.duration_ms || 0}ms</td>
      <td style="font-size:12px;color:var(--text-3)">${esc((r.error || '').slice(0, 60))}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderCrashes(rows) {
    const el = box.querySelector('#crashLog');
    if (!rows.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无崩溃上报')}</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>${t('时间')}</th><th>${t('设备')}</th><th>${t('版本')}</th><th>${t('类型')}</th><th>${t('信息')}</th></tr></thead><tbody>${rows.map(r => `
      <tr><td style="font-size:12px;color:var(--text-3)">${esc(r.created_at || '')}</td>
      <td style="font-size:12px">${esc(r.username || ('#' + (r.device_id ?? '—')))}</td>
      <td style="font-size:12px">${esc(r.version || '')}</td>
      <td><span class="tag red">${esc(r.kind || '')}</span></td>
      <td style="font-size:12px;color:var(--text-3)" title="${esc(r.stack || '')}">${esc((r.message || '').slice(0, 70))}</td></tr>`).join('')}</tbody></table>`;
  }

  function loadReleases() {
    const el = box.querySelector('#releaseList');
    api('/localbridge/releases').then(j => {
      const rows = j.data || [];
      if (!rows.length) { el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:13px">${t('还没有发布记录——点「登记发布」上传一个客户端包（如 bridge.js），客户端即可自动检查更新。')}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr>
        <th>${t('版本')}</th><th>${t('平台/架构')}</th><th>${t('通道')}</th><th>${t('文件')}</th><th>${t('大小')}</th><th>${t('强制')}</th><th>sha256</th><th>${t('状态')}</th><th></th>
      </tr></thead><tbody>${rows.map(r => `
        <tr>
          <td><b>${esc(r.version)}</b></td>
          <td style="font-size:12px">${esc(r.platform)}/${esc(r.arch)}</td>
          <td style="font-size:12px">${esc(r.channel)}</td>
          <td style="font-size:12px">${esc(r.file_name || '—')} ${r.file_exists ? '<span class="tag green">就位</span>' : '<span class="tag gray">缺文件</span>'}</td>
          <td style="font-size:12px">${fmtBytes(r.size || r.actual_size || 0)}</td>
          <td>${r.mandatory ? `<span class="tag red">${t('强制')}</span>` : `<span class="tag gray">${t('可选')}</span>`}${r.min_version ? `<div style="font-size:11px;color:var(--text-3)">≥${esc(r.min_version)}</div>` : ''}</td>
          <td style="font-size:11px;font-family:ui-monospace,monospace;color:var(--text-3)" title="${esc(r.sha256 || '')}">${esc((r.sha256 || '-').slice(0, 10))}</td>
          <td>${r.status === 'active' ? `<span class="tag green">${t('在售')}</span>` : `<span class="tag gray">${t('归档')}</span>`}</td>
          <td style="white-space:nowrap">
            ${r.status === 'active' ? `<button class="btn sm" data-arch="${r.id}">${t('下线')}</button> ` : ''}
            <button class="btn sm" style="color:var(--danger,#dc2626)" data-del="${r.id}">${t('删除')}</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
      el.querySelectorAll('[data-arch]').forEach(b => b.onclick = async () => {
        if (!(await confirmBox(t('下线后客户端将不再收到该版本更新，确定？')))) return;
        try { await api(`/localbridge/releases/${b.dataset.arch}`, { method: 'DELETE' }); toast(t('已下线'), 'ok'); loadReleases(); loadMetrics(); } catch (e) { toast(e.message, 'err'); }
      });
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!(await confirmBox(t('彻底删除该发布记录（不可恢复），确定？')))) return;
        try { await api(`/localbridge/releases/${b.dataset.del}?hard=1`, { method: 'DELETE' }); toast(t('已删除'), 'ok'); loadReleases(); loadMetrics(); } catch (e) { toast(e.message, 'err'); }
      });
    }).catch(e => { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; });
  }

  function releaseForm() {
    modal({
      title: `📦 ${t('登记发布')}`,
      wide: true,
      body: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
        <label>${t('版本号')} <span style="color:var(--danger)">*</span><input class="input" id="fVer" placeholder="1.2.0"></label>
        <label>${t('通道')}<select class="input" id="fChan">${CHANNELS.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
        <label>${t('平台')}<select class="input" id="fPlat">${PLATFORMS.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
        <label>${t('架构')}<select class="input" id="fArch">${ARCHS.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
        <label style="grid-column:1/-1">${t('文件名')} <span class="sub">${t('置于 public/downloads/ 下；文件在库时自动计算 sha256/大小')}</span><input class="input" id="fFile" placeholder="bridge-1.2.0.js"></label>
        <label style="grid-column:1/-1">${t('更新说明')}<textarea class="input" id="fNotes" rows="3" placeholder="${t('本次更新内容（纯文本/Markdown）')}"></textarea></label>
        <label style="grid-column:1/-1">${t('低于此版本的客户端强制升级（可选）')}<input class="input" id="fMin" placeholder="1.0.0"></label>
        <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px"><input type="checkbox" id="fMand"> ${t('标记为强制更新')}</label>
        <div id="fMsg" style="grid-column:1/-1;color:var(--danger,#dc2626)"></div>
      </div>`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn primary" id="fSave">${t('保存')}</button>`,
      onMount(m, close) {
        m.querySelector('[data-close]').onclick = close;
        m.querySelector('#fSave').onclick = async () => {
          const body = {
            version: m.querySelector('#fVer').value.trim(),
            channel: m.querySelector('#fChan').value,
            platform: m.querySelector('#fPlat').value,
            arch: m.querySelector('#fArch').value,
            file_name: m.querySelector('#fFile').value.trim(),
            notes: m.querySelector('#fNotes').value,
            min_version: m.querySelector('#fMin').value.trim(),
            mandatory: m.querySelector('#fMand').checked,
          };
          if (!body.version) { m.querySelector('#fMsg').textContent = t('请填写版本号'); return; }
          try { await api('/localbridge/releases', { method: 'POST', body }); toast(t('发布已登记'), 'ok'); close(); loadReleases(); loadMetrics(); }
          catch (e) { m.querySelector('#fMsg').textContent = e.message; }
        };
      },
    });
  }

  loadMetrics();
  loadReleases();
}
