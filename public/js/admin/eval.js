/** D3-4 评测体系（后台）— 发布基线（任务成功率/步数/人工干预率）+ SWE-bench-lite 接入
 *  - 指标：各套件最新基线达标状态（成功率 ≥ 70% / 干预率 ≤ 20%）+ 回退数
 *  - 采集基线：选择套件，可用「实测用例 JSON / 既有评测集 / 智能体遥测」三种数据源
 *  - 基线列表：每次与同套件上一条对比（成功率↑/步数↓/干预率↓ = 无回退）
 *  - 发布关联：canvas 智能体每次发布的版本 → 关联基线
 *  内核 src-server/lib/eval-suite.js
 */
import { api } from '../api.js';
import { esc, toast, confirmBox, modal } from '../ui.js';
import { t } from '../i18n.js';

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🧪 ${t('评测体系')}</h2>
    <span class="sub" style="color:var(--text-3);font-size:13px">${t('发布基线（任务成功率 / 步数 / 人工干预率）+ SWE-bench-lite 接入；每次发布有可对比基线')}</span>
  </div>
  <div class="card" style="padding:22px;margin-bottom:16px">
    <h3 style="margin-bottom:12px">📈 ${t('指标总览')} <span class="sub">${t('验收线：成功率 ≥ 70%、干预率 ≤ 20%')}</span></h3>
    <div id="evMetrics">${t('加载中…')}</div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>🧷 ${t('采集发布基线')}</h3>
        <button class="btn sm" id="evImport">${t('SWE-bench-lite 导入')}</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <label style="font-size:12px;color:var(--text-3)">${t('套件（选内置模板或既有评测集）')}
          <select class="input" id="evSuite"><option value="">${t('加载中…')}</option></select></label>
        <label style="font-size:12px;color:var(--text-3)">${t('发布标签（可选）')}<input class="input" id="evLabel" placeholder="${t('例如：客服助手 v3 发布')}"></label>
        <label style="font-size:12px;color:var(--text-3)">${t('数据源')}
          <select class="input" id="evSrc">
            <option value="telemetry">${t('智能体遥测（成功率/步数/干预率取自真实对话）')}</option>
            <option value="cases">${t('实测用例 JSON（[{id,score,steps,intervened}]）')}</option>
          </select></label>
        <input class="input" id="evAgent" placeholder="${t('智能体 ID（遥测数据源必填）')}">
        <textarea class="input" id="evCases" rows="3" style="font-family:monospace;font-size:12px;display:none" placeholder='[{"id":"q1","score":1,"steps":3},{"id":"q2","score":0,"steps":7,"intervened":true}]'></textarea>
        <div><button class="btn primary sm" id="evRun">${t('采集并对比')}</button></div>
      </div>
      <div id="evOut" style="margin-top:10px;font-size:12px"></div>
    </div>
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>📚 ${t('发布历史关联基线')}</h3>
        <div style="display:flex;gap:6px"><input class="input" id="evRelAgent" placeholder="${t('智能体 ID')}" style="width:110px"><button class="btn sm" id="evRelLoad">${t('查看')}</button></div>
      </div>
      <div id="evReleases"><div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('输入智能体 ID 查看每次发布对应的基线')}</div></div>
    </div>
  </div>
  <div class="card" style="padding:22px;margin-top:16px">
    <h3 style="margin-bottom:12px">📋 ${t('基线记录')} <span class="sub">${t('每条与同套件上一条对比')}</span></h3>
    <div id="evList">${t('加载中…')}</div>
  </div>`;

  const color = (ok) => ok === true ? 'var(--ok,#16a34a)' : ok === false ? 'var(--danger,#dc2626)' : 'var(--text-3)';
  function metricCard(label, value, target, ok) {
    return `<div style="flex:1;min-width:150px;padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;background:var(--bg-2,#fafbfc)">
      <div style="font-size:12px;color:var(--text-3)">${esc(label)}</div>
      <div style="font-size:26px;font-weight:700;color:${color(ok)};margin:6px 0">${value == null ? '—' : value}</div>
      <div style="font-size:12px;color:${color(ok)}">${ok === true ? '✓ ' + t('达标') : ok === false ? '✗ ' + t('未达标') : ''} <span style="color:var(--text-3)">${esc(target)}</span></div>
    </div>`;
  }

  async function loadMetrics() {
    const el = box.querySelector('#evMetrics');
    try {
      const d = (await api('/eval/metrics')).data || {};
      const latest = (d.suites || [])[0];
      const m = latest ? latest.metrics : null;
      el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${metricCard(t('任务成功率'), m ? m.successRate + '%' : null, `${t('目标 ≥ 70%')}`, m ? m.meetsSuccess : null)}
        ${metricCard(t('平均步数'), m ? m.avgSteps : null, `${t('参考（越低越好）')}`)}
        ${metricCard(t('人工干预率'), m ? m.interventionRate + '%' : null, `${t('目标 ≤ 20%')}`, m ? m.meetsIntervention : null)}
        ${metricCard(t('套件 / 回退'), `${d.suiteCount || 0} / ${d.regressions || 0}`, `${t('基线总数')} ${d.total || 0}`, (d.regressions || 0) === 0)}
      </div>${latest ? `<div style="margin-top:8px;font-size:12px;color:var(--text-3)">${t('最新套件')}：${esc(latest.suite)} · ${esc(latest.label || '')}</div>` : ''}`;
    } catch (e) { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; }
  }

  async function loadSuites() {
    const sel = box.querySelector('#evSuite');
    try {
      const list = (await api('/eval/suites')).data.suites || [];
      sel.innerHTML = list.map(s =>
        `<option value="${esc(s.name)}" data-type="${esc(s.suite_type)}" data-ref="${s.ref_id != null ? s.ref_id : ''}" data-ev="${s.evaluation_id != null ? s.evaluation_id : ''}">${esc(s.label || s.name)}${s.builtin ? ' · ' + t('内置') : ''}</option>`).join('');
    } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  }

  function diffTag(d) {
    if (!d || d.prev == null) return `<span class="tag gray">${t('首次')}</span>`;
    if (d.trend === 'up') return `<span class="tag ${d.lowerBetter ? 'red' : 'green'}">↑ ${d.delta > 0 ? '+' : ''}${d.delta}</span>`;
    if (d.trend === 'down') return `<span class="tag ${d.lowerBetter ? 'green' : 'red'}">↓ ${d.delta}</span>`;
    return `<span class="tag gray">${t('持平')}</span>`;
  }

  async function loadList() {
    const el = box.querySelector('#evList');
    try {
      const list = (await api('/eval/baselines?limit=100')).data || [];
      if (!list.length) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">${t('暂无基线——采集或发布一次即生成可对比基线')}</div>`; return; }
      el.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
        <th>${t('套件')}</th><th>${t('标签')}</th><th>${t('任务成功率')}</th><th>${t('步数')}</th><th>${t('干预率')}</th><th>${t('对比')}</th><th>${t('时间')}</th><th></th></tr></thead><tbody>
        ${list.map(b => `<tr>
          <td style="font-size:12px">${esc(b.suite)}<div style="color:var(--text-3);font-size:11px">${esc(b.suite_type)}${b.agent_version ? ' · v' + b.agent_version : ''}</div></td>
          <td style="font-size:12px">${esc(b.label || '—')}</td>
          <td style="font-size:12px"><span style="color:${color(b.metrics.meetsSuccess)}">${b.metrics.successRate}%</span> <span style="color:var(--text-3)">(${b.metrics.passed}/${b.metrics.total})</span></td>
          <td style="font-size:12px">${b.metrics.avgSteps}</td>
          <td style="font-size:12px"><span style="color:${color(b.metrics.meetsIntervention)}">${b.metrics.interventionRate}%</span></td>
          <td style="white-space:nowrap">${diffTag(b.diff && b.diff.successRate)} <span class="tag ${b.verdict && b.verdict.ok ? 'green' : 'red'}">${b.verdict && b.verdict.ok ? t('无回退') : t('回退')}</span></td>
          <td style="font-size:11px;color:var(--text-3)">${esc((b.created_at || '').slice(5, 16))}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-view="${b.id}">${t('详情')}</button> <button class="btn danger sm" data-del="${b.id}">${t('删除')}</button></td></tr>`).join('')}
      </tbody></table></div>`;
      el.querySelectorAll('[data-view]').forEach(x => x.onclick = () => openDetail(x.dataset.view));
      el.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => {
        if (!(await confirmBox(t('删除该基线？此操作不可恢复。')))) return;
        try { await api('/eval/baselines/' + x.dataset.del, { method: 'DELETE' }); toast(t('已删除'), 'ok'); loadList(); loadMetrics(); }
        catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { el.innerHTML = `<div style="color:var(--danger,#dc2626)">${esc(e.message)}</div>`; }
  }

  async function openDetail(id) {
    try {
      const b = (await api('/eval/baselines/' + id)).data;
      const cases = b.cases || [];
      modal({
        title: `${t('基线详情')} #${b.id} · ${esc(b.suite)}`,
        wide: true,
        body: `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">
            <span class="tag blue">${b.metrics.total} ${t('用例')}</span>
            <span class="tag ${b.metrics.meetsSuccess ? 'green' : 'red'}">${t('成功率')} ${b.metrics.successRate}%</span>
            <span class="tag gray">${t('步数')} ${b.metrics.avgSteps}</span>
            <span class="tag ${b.metrics.meetsIntervention ? 'green' : 'red'}">${t('干预率')} ${b.metrics.interventionRate}%</span>
            <span class="tag ${b.verdict && b.verdict.ok ? 'green' : 'red'}">${esc((b.verdict && b.verdict.reasons || []).join('；'))}</span>
          </div>
          <div class="table-wrap" style="max-height:400px;overflow:auto"><table class="table"><thead><tr><th>${t('用例')}</th><th>${t('通过')}</th><th>${t('得分')}</th><th>${t('步数')}</th><th>${t('干预')}</th></tr></thead><tbody>
          ${cases.map(c => `<tr><td style="font-size:12px">${esc(c.id || '—')}${c.note ? `<div style="color:var(--text-3);font-size:11px">${esc(c.note)}</div>` : ''}</td>
            <td><span class="tag ${c.passed ? 'green' : 'red'}">${c.passed ? t('通过') : t('未过')}</span></td>
            <td style="font-size:12px">${c.score}</td><td style="font-size:12px">${c.steps}</td><td>${c.intervened ? '<span class="tag orange">✓</span>' : ''}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('无用例明细')}</td></tr>`}
          </tbody></table></div>`,
        foot: `<button class="btn" data-close>${t('关闭')}</button>`,
        onMount(m, close) { m.querySelector('[data-close]').onclick = close; },
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  // 数据源切换
  const srcSel = box.querySelector('#evSrc');
  srcSel.onchange = () => {
    const isCases = srcSel.value === 'cases';
    box.querySelector('#evCases').style.display = isCases ? '' : 'none';
    box.querySelector('#evAgent').style.display = isCases ? 'none' : '';
  };

  box.querySelector('#evRun').onclick = async () => {
    const out = box.querySelector('#evOut');
    const sel = box.querySelector('#evSuite');
    const opt = sel.selectedOptions[0];
    const suite = sel.value;
    if (!suite) { toast(t('请选择套件'), 'err'); return; }
    const src = srcSel.value;
    let cases = null, agent_id = null;
    if (src === 'cases') {
      try { cases = JSON.parse(box.querySelector('#evCases').value || '[]'); } catch { toast(t('用例 JSON 解析失败'), 'err'); return; }
      if (!cases.length) { toast(t('请填写用例 JSON'), 'err'); return; }
    } else {
      agent_id = Number(box.querySelector('#evAgent').value);
      if (!agent_id) { toast(t('遥测数据源需填写智能体 ID'), 'err'); return; }
    }
    out.innerHTML = `<span style="color:var(--text-3)">${t('采集中…')}</span>`;
    try {
      const body = { suite, suite_type: opt?.dataset.type || 'agent', ref_id: opt?.dataset.ref ? Number(opt.dataset.ref) : undefined, label: box.querySelector('#evLabel').value.trim() };
      if (cases) body.cases = cases; else body.agent_id = agent_id;
      const b = (await api('/eval/baselines', { method: 'POST', body })).data;
      out.innerHTML = `<span class="tag ${b.metrics.meetsSuccess ? 'green' : 'red'}">${t('成功率')} ${b.metrics.successRate}%</span>
        <span class="tag gray">${t('步数')} ${b.metrics.avgSteps}</span>
        <span class="tag ${b.metrics.meetsIntervention ? 'green' : 'red'}">${t('干预率')} ${b.metrics.interventionRate}%</span>
        <span class="tag ${b.verdict && b.verdict.ok ? 'green' : 'red'}">${esc((b.verdict && b.verdict.reasons || []).join('；'))}</span>`;
      loadList(); loadMetrics();
    } catch (e) { out.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
  };

  box.querySelector('#evImport').onclick = async () => {
    let tpl = {};
    try { tpl = (await api('/eval/template/swe-bench-lite')).data; } catch { }
    modal({
      title: 'SWE-bench-lite ' + t('导入'),
      wide: true,
      body: `<div style="font-size:12px;line-height:1.8;color:var(--text-2);margin-bottom:8px">
          ${t('粘贴 SWE-bench-lite instance 数组，导入为平台内部用例（成功判据：补丁通过 FAIL_TO_PASS 测试数 / 总测试数）。')}
          <div style="margin-top:6px;color:var(--text-3)">${t('样例')}：<code style="font-size:11px">${esc(JSON.stringify(tpl.sample || []))}</code></div>
        </div>
        <textarea class="input" id="sbInst" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder='[{"instance_id":"...","FAIL_TO_PASS":["t1","t2"],"passed_tests":2}]'>${esc(JSON.stringify(tpl.sample || [], null, 0))}</textarea>
        <div id="sbImpOut" style="margin-top:8px;font-size:12px"></div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('导入预览')}</button>`,
      onMount(m, close) {
        m.querySelector('[data-cancel]').onclick = close;
        m.querySelector('[data-go]').onclick = async () => {
          const o = m.querySelector('#sbImpOut');
          let rows; try { rows = JSON.parse(m.querySelector('#sbInst').value || '[]'); } catch { toast(t('JSON 解析失败'), 'err'); return; }
          try {
            const d = (await api('/eval/import/swe-bench-lite', { method: 'POST', body: { instances: rows } })).data;
            o.innerHTML = `<span class="tag green">${d.cases.length} ${t('条用例')}</span> <span class="tag blue">${t('成功率')} ${d.metrics.successRate}%</span> <span class="tag gray">${t('步数')} ${d.metrics.avgSteps}</span>`;
          } catch (e) { o.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
        };
      },
    });
  };

  box.querySelector('#evRelLoad').onclick = async () => {
    const id = Number(box.querySelector('#evRelAgent').value);
    const el = box.querySelector('#evReleases');
    if (!id) { toast(t('请填写智能体 ID'), 'err'); return; }
    el.innerHTML = `<span style="color:var(--text-3)">${t('加载中…')}</span>`;
    try {
      const list = (await api('/eval/releases/' + id)).data || [];
      if (!list.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('该智能体暂无发布历史（画布模式发布才记录版本）')}</div>`; return; }
      el.innerHTML = list.map(r => `<div style="padding:10px 0;border-bottom:1px solid var(--line,#eee)">
        <div style="font-size:13px"><b>v${r.version}</b> <span style="color:var(--text-3);font-size:12px">${esc(r.note || '')} · ${esc(r.published_by || '')} · ${esc((r.created_at || '').slice(0, 16))}</span></div>
        ${r.baseline ? `<div style="margin-top:4px;font-size:12px">${t('基线')}：<span style="color:${color(r.baseline.metrics.meetsSuccess)}">${t('成功率')} ${r.baseline.metrics.successRate}%</span> · ${t('步数')} ${r.baseline.metrics.avgSteps} · <span style="color:${color(r.baseline.metrics.meetsIntervention)}">${t('干预率')} ${r.baseline.metrics.interventionRate}%</span> <span class="tag ${r.baseline.verdict && r.baseline.verdict.ok ? 'green' : 'red'}">${r.baseline.verdict && r.baseline.verdict.ok ? t('无回退') : t('回退')}</span></div>` : `<div style="margin-top:4px;font-size:12px;color:var(--text-3)">${t('无关联基线')}</div>`}
      </div>`).join('');
    } catch (e) { el.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
  };

  loadMetrics();
  loadSuites();
  loadList();
}
