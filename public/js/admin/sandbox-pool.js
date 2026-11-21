/** D3-3 沙箱池（后台）— 预热/快照/并发隔离/租户配额
 *  - 指标：冷启动（验收 < 3 秒）/ 预热命中率 / 隔离越权 0 例 / 池内空闲忙碌
 *  - 租户配额：max_concurrent 并发上限 + warm_size 预热进程数
 *  - 快照：预置环境目录镜像，激活后新工作进程目录由其播种
 *  内核 src-server/lib/sandbox-pool.js
 */
import { api } from '../api.js';
import { esc, toast, confirmBox, modal } from '../ui.js';
import { t } from '../i18n.js';

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🧊 ${t('沙箱池')}</h2>
    <span class="sub" style="color:var(--text-3);font-size:13px">${t('预热进程 + 快照播种 + 按租户并发配额；隔离越权 0 例')}</span>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">📈 ${t('池指标')} <span class="sub">${t('验收线：冷启动 < 3 秒')}</span></h3>
    <div id="sbMetrics">${t('加载中…')}</div>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3>🧪 ${t('执行与自检')}</h3>
      <div style="display:flex;gap:8px">
        <button class="btn sm" id="sbWarm">${t('预热进程')}</button>
        <button class="btn sm" id="sbIsolation">${t('隔离自检')}</button>
      </div>
    </div>
    <textarea class="input" id="sbCode" rows="3" style="width:100%;font-family:monospace;font-size:12px" placeholder="${t('console.log("hello from pool")')}">console.log('hello from pool')</textarea>
    <div style="margin-top:8px"><button class="btn primary sm" id="sbRun">${t('池化执行')}</button></div>
    <div id="sbRunOut" style="margin-top:10px;font-size:12px"></div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>🧮 ${t('租户并发配额')}</h3>
        <button class="btn sm" id="sbQuotaAdd">${t('新增配额')}</button>
      </div>
      <div id="sbQuotas">${t('加载中…')}</div>
    </div>
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>💾 ${t('环境快照')}</h3>
        <button class="btn sm" id="sbSnapAdd">${t('创建快照')}</button>
      </div>
      <div id="sbSnaps">${t('加载中…')}</div>
    </div>
  </div>`;

  function metricCard(label, value, target, ok) {
    const color = ok === true ? 'var(--ok,#16a34a)' : ok === false ? 'var(--danger,#dc2626)' : 'var(--text-3)';
    return `<div style="flex:1;min-width:150px;padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;background:var(--bg-2,#fafbfc)">
      <div style="font-size:12px;color:var(--text-3)">${esc(label)}</div>
      <div style="font-size:26px;font-weight:700;color:${color};margin:6px 0">${value == null ? '—' : value}</div>
      <div style="font-size:12px;color:${color}">${ok === true ? '✓ ' + t('达标') : ok === false ? '✗ ' + t('未达标') : ''} <span style="color:var(--text-3)">${esc(target)}</span></div>
    </div>`;
  }

  async function loadMetrics() {
    const el = box.querySelector('#sbMetrics');
    try {
      const d = (await api('/sandbox/pool/stats')).data || {};
      const r = d.runs || {}, p = d.pool || {};
      el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${metricCard(t('冷启动均值'), r.avgColdStartMs == null ? null : r.avgColdStartMs + 'ms', `${t('目标 <')} ${d.target || 3000}ms`, r.coldStartMet)}
        ${metricCard(t('预热命中率'), r.hitRate == null ? null : r.hitRate + '%', `${t('命中')} ${r.poolHits || 0} / ${t('冷启')} ${r.coldStarts || 0}`)}
        ${metricCard(t('池内空闲 / 忙碌'), `${p.idle || 0} / ${p.busy || 0}`, `${t('总计')} ${p.total || 0}`)}
        ${metricCard(t('运行总数'), r.total || 0, `${t('成功')} ${r.success || 0}`)}
      </div>`;
    } catch (e) { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; }
  }

  async function loadQuotas() {
    const el = box.querySelector('#sbQuotas');
    try {
      const d = (await api('/sandbox/pool/quotas')).data || {};
      const list = d.list || [];
      if (!list.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无租户配额——使用默认：并发 2 / 预热 1')}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr><th>${t('租户')}</th><th>${t('并发上限')}</th><th>${t('预热数')}</th><th>${t('当前忙碌')}</th><th>${t('状态')}</th><th></th></tr></thead><tbody>${list.map(q => `
        <tr><td style="font-size:12px">${esc(q.tenant)}</td>
        <td style="font-size:12px">${q.max_concurrent}</td>
        <td style="font-size:12px">${q.warm_size}</td>
        <td style="font-size:12px">${q.busy || 0}</td>
        <td><span class="tag ${q.enabled ? 'green' : 'gray'}">${q.enabled ? t('启用') : t('停用')}</span></td>
        <td><button class="btn sm" data-edit="${esc(q.tenant)}">${t('编辑')}</button></td></tr>`).join('')}</tbody></table>`;
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openQuotaForm(list.find(x => x.tenant === b.dataset.edit)));
    } catch (e) { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; }
  }

  function openQuotaForm(row) {
    const r = row || { tenant: '', max_concurrent: 2, warm_size: 1, max_idle: 1, enabled: true };
    modal({
      title: t('租户并发配额'),
      body: `<div style="display:flex;flex-direction:column;gap:10px">
        <label>${t('租户（用户名）')}<input class="input" id="qTenant" value="${esc(r.tenant)}" ${row ? 'readonly' : ''}></label>
        <label>${t('并发上限（0=不限）')}<input class="input" id="qConc" type="number" value="${r.max_concurrent}"></label>
        <label>${t('预热进程数')}<input class="input" id="qWarm" type="number" value="${r.warm_size}"></label>
        <label>${t('状态')}<select class="input" id="qEnabled"><option value="1" ${r.enabled ? 'selected' : ''}>${t('启用')}</option><option value="0" ${!r.enabled ? 'selected' : ''}>${t('停用')}</option></select></label>
      </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('保存')}</button>`,
      onMount(m, close) {
        m.querySelector('[data-cancel]').onclick = close;
        m.querySelector('[data-go]').onclick = async () => {
          const body = {
            tenant: m.querySelector('#qTenant').value.trim(),
            max_concurrent: Number(m.querySelector('#qConc').value),
            warm_size: Number(m.querySelector('#qWarm').value),
            enabled: m.querySelector('#qEnabled').value === '1',
          };
          if (!body.tenant) { toast(t('租户不能为空'), 'err'); return; }
          try { await api('/sandbox/pool/quota/upsert', { method: 'POST', body }); toast(t('已保存'), 'ok'); close(); loadQuotas(); loadMetrics(); }
          catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function loadSnaps() {
    const el = box.querySelector('#sbSnaps');
    try {
      const list = (await api('/sandbox/snapshots')).data || [];
      if (!list.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无快照——创建后新工作进程将携带其环境')}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr><th>${t('名称')}</th><th>${t('体积')}</th><th>Node</th><th>${t('状态')}</th><th></th></tr></thead><tbody>${list.map(s => `
        <tr><td style="font-size:12px">${esc(s.name)}<div style="color:var(--text-3);font-size:11px">${esc(s.source_dir)}</div></td>
        <td style="font-size:12px">${esc(s.size_human)}</td>
        <td style="font-size:11px;color:var(--text-3)">${esc(s.node_version)}</td>
        <td><span class="tag ${s.active ? 'green' : 'gray'}">${s.active ? t('已激活') : t('未激活')}</span></td>
        <td style="white-space:nowrap">
          ${s.active ? '' : `<button class="btn sm" data-act="${s.id}">${t('激活')}</button> `}
          <button class="btn danger sm" data-del="${s.id}">${t('删除')}</button></td></tr>`).join('')}</tbody></table>`;
      el.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
        try { await api('/sandbox/snapshots/' + b.dataset.act + '/activate', { method: 'POST' }); toast(t('已激活'), 'ok'); loadSnaps(); }
        catch (e) { toast(e.message, 'err'); }
      });
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!(await confirmBox(t('删除该快照？快照目录将被移除。')))) return;
        try { await api('/sandbox/snapshots/' + b.dataset.del, { method: 'DELETE' }); toast(t('已删除'), 'ok'); loadSnaps(); }
        catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; }
  }

  box.querySelector('#sbQuotaAdd').onclick = () => openQuotaForm(null);

  box.querySelector('#sbSnapAdd').onclick = () => modal({
    title: t('创建环境快照'),
    body: `<div style="display:flex;flex-direction:column;gap:10px">
      <label>${t('快照名称')}<input class="input" id="sName" placeholder="${t('例如：node-with-deps')}"></label>
      <label>${t('源目录（绝对或相对路径）')}<input class="input" id="sSrc" placeholder="${t('例如：/tmp/base-env')}"></label>
    </div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('创建')}</button>`,
    onMount(m, close) {
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('[data-go]').onclick = async () => {
        const body = { name: m.querySelector('#sName').value.trim(), source: m.querySelector('#sSrc').value.trim() };
        if (!body.name || !body.source) { toast(t('名称与源目录必填'), 'err'); return; }
        try { await api('/sandbox/snapshots', { method: 'POST', body }); toast(t('已创建'), 'ok'); close(); loadSnaps(); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  box.querySelector('#sbWarm').onclick = async () => {
    try { const d = (await api('/sandbox/pool/warm', { method: 'POST', body: {} })).data; toast(`${t('已预热')}：${t('空闲')} ${d.pool.idle}`, 'ok'); loadMetrics(); }
    catch (e) { toast(e.message, 'err'); }
  };

  box.querySelector('#sbIsolation').onclick = async () => {
    const el = box.querySelector('#sbRunOut');
    el.innerHTML = `<span style="color:var(--text-3)">${t('自检中…')}</span>`;
    try {
      const d = (await api('/sandbox/pool/isolation')).data || {};
      el.innerHTML = `<div style="margin-bottom:6px"><span class="tag ${d.passed ? 'green' : 'red'}">${d.passed ? '✓ ' + t('隔离越权 0 例') : '✗ ' + t('越权') + ' ' + d.violations + ' ' + t('例')}</span></div>
        ${(d.checks || []).map(c => `<div style="font-size:12px;color:${c.ok ? 'var(--text-2)' : 'var(--danger,#dc2626)'}">${c.ok ? '✓' : '✗'} ${esc(c.name)} <span style="color:var(--text-3)">(${esc(c.detail)})</span></div>`).join('')}`;
      loadMetrics();
    } catch (e) { el.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
  };

  box.querySelector('#sbRun').onclick = async () => {
    const el = box.querySelector('#sbRunOut');
    const code = box.querySelector('#sbCode').value;
    el.innerHTML = `<span style="color:var(--text-3)">${t('执行中…')}</span>`;
    try {
      const d = (await api('/sandbox/pool/run', { method: 'POST', body: { code } })).data || {};
      el.innerHTML = `<span class="tag ${d.status === 'success' ? 'green' : 'orange'}">${esc(d.status)}</span>
        <span style="color:var(--text-3);font-size:12px"> · ${t('耗时')} ${d.durationMs}ms · ${d.poolHit ? t('预热命中') : t('冷启动') + (d.coldStartMs != null ? ' ' + d.coldStartMs + 'ms' : '')} · slot ${esc(d.slot || '-')}</span>
        <pre style="margin-top:6px;white-space:pre-wrap;background:var(--bg-2,#f6f7f9);padding:8px;border-radius:8px">${esc(d.stdout || d.stderr || '')}</pre>`;
      loadMetrics();
    } catch (e) { el.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
  };

  loadMetrics();
  loadQuotas();
  loadSnaps();
}
