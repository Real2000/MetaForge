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
  <div class="card" style="padding:22px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <h3>📈 ${t('多版本趋势')} <span class="sub">${t('同一套件按版本序列，标注回退点与显著性')}</span></h3>
      <div style="display:flex;gap:6px">
        <select class="input" id="evTrendSuite" style="width:230px"><option value="">${t('加载中…')}</option></select>
        <select class="input" id="evTrendAxis" style="width:110px"><option value="version">${t('版本轴')}</option><option value="time">${t('时间轴')}</option></select>
        <button class="btn sm" id="evTrendLoad">${t('查看趋势')}</button>
      </div>
    </div>
    <div id="evTrend"><div style="padding:14px;text-align:center;color:var(--text-3);font-size:13px">${t('选择套件查看多版本三指标走势（成功率 / 步数 / 干预率）与统计显著性')}</div></div>
  </div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>🧷 ${t('采集发布基线')}</h3>
        <button class="btn sm" id="evImport">${t('SWE-bench-lite 导入')}</button>
        <button class="btn sm" id="evRunner">${t('外部 runner 执行')}</button>
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

  // 显著性徽标（两比例 z 检验 / Fisher 精确检验结论）
  function sigBadge(sig) {
    if (!sig || sig.first) return `<span class="tag gray">${t('首次')}</span>`;
    const map = {
      improved: ['green', t('显著提升')], regressed: ['red', t('显著回退')],
      no_change: ['gray', t('变化不显著')], insufficient: ['orange', t('样本不足')],
    };
    const m = map[sig.verdict] || ['gray', sig.verdict];
    const sr = sig.successRate || {};
    const mm = sr.method === 'fisher' ? t('Fisher 精确检验') : t('两比例 z 检验');
    const pv = sr.p != null ? ` p=${sr.p}` : '';
    return `<span class="tag ${m[0]}" title="${mm}${pv}">${m[1]}</span>`;
  }

  // 零依赖手绘 SVG 折线：成功率（绿）/ 干预率（橙）+ Wilson 95% 置信带；回退点标红、显著变化点加环
  function trendSvg(points, axis) {
    const W = 660, H = 220, padL = 36, padR = 16, padT = 16, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB, n = points.length;
    const X = (i) => {
      if (n === 1) return padL + iw / 2;
      if (axis === 'time') {
        const ts = points.map(p => Date.parse(String(p.created_at || '').replace(' ', 'T')) || 0);
        const tmin = Math.min(...ts), tmax = Math.max(...ts);
        if (tmax <= tmin) return padL + iw / 2;
        return padL + iw * (ts[i] - tmin) / (tmax - tmin);
      }
      return padL + iw * i / (n - 1);
    };
    const Y = (v) => padT + ih * (1 - Math.max(0, Math.min(100, v)) / 100);
    const sr = points.map(p => p.metrics.successRate);
    const ir = points.map(p => p.metrics.interventionRate);
    const ciBand = (lo, hi, fill) => {
      const top = hi.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      const bot = lo.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).reverse().join(' ');
      return `<polygon points="${top} ${bot}" fill="${fill}" stroke="none"/>`;
    };
    const srLo = points.map(p => (p.ci && p.ci.successRate ? p.ci.successRate.low : p.metrics.successRate));
    const srHi = points.map(p => (p.ci && p.ci.successRate ? p.ci.successRate.high : p.metrics.successRate));
    const irLo = points.map(p => (p.ci && p.ci.interventionRate ? p.ci.interventionRate.low : p.metrics.interventionRate));
    const irHi = points.map(p => (p.ci && p.ci.interventionRate ? p.ci.interventionRate.high : p.metrics.interventionRate));
    const bands = ciBand(irLo, irHi, 'rgba(245,158,11,0.10)') + ciBand(srLo, srHi, 'rgba(22,163,74,0.14)');
    const line = (arr, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
    const dots = (arr, color, isSr) => arr.map((v, i) => {
      const p = points[i];
      const reg = isSr && p.verdict && !p.verdict.first && !p.verdict.ok;
      const sv = p.significance && p.significance.verdict;
      const r = reg ? 5 : 3.5;
      const fill = reg ? 'var(--danger,#dc2626)' : color;
      const ring = (sv === 'improved' || sv === 'regressed')
        ? `<circle cx="${X(i)}" cy="${Y(v)}" r="${r + 3}" fill="none" stroke="${sv === 'improved' ? '#16a34a' : '#dc2626'}" stroke-width="1.5" opacity="0.55"/>` : '';
      return ring + `<circle cx="${X(i)}" cy="${Y(v)}" r="${r}" fill="${fill}"><title>${esc(p.label || ('#' + p.id))}: ${v}</title></circle>`;
    }).join('');
    const grid = [0, 25, 50, 75, 100].map(g => `<line x1="${padL}" y1="${Y(g)}" x2="${W - padR}" y2="${Y(g)}" stroke="var(--line,#eee)" stroke-width="1"/><text x="${padL - 6}" y="${Y(g) + 4}" font-size="10" fill="var(--text-3)" text-anchor="end">${g}</text>`).join('');
    const xl = points.map((p, i) => `<text x="${X(i)}" y="${H - 8}" font-size="10" fill="var(--text-3)" text-anchor="middle">${esc((p.label || ('#' + p.id)).slice(0, 9))}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-width:${W}px" role="img">${grid}${bands}${xl}${line(sr, 'var(--ok,#16a34a)')}${line(ir, '#f59e0b')}${dots(ir, '#f59e0b', false)}${dots(sr, 'var(--ok,#16a34a)', true)}</svg>
      <div style="font-size:12px;color:var(--text-3);margin-top:4px"><span style="color:var(--ok,#16a34a)">━</span> ${t('任务成功率')} &nbsp; <span style="color:#f59e0b">━</span> ${t('人工干预率')} &nbsp; <span style="display:inline-block;width:10px;height:10px;background:rgba(22,163,74,0.18);vertical-align:middle"></span> ${t('95% 置信带')} &nbsp; <span style="color:var(--danger,#dc2626)">●</span> ${t('回退点')} &nbsp; ◯ ${t('显著变化点')}${axis === 'time' ? ` &nbsp; ⏱ ${t('时间轴')}` : ''}</div>`;
  }

  async function loadTrendSuites() {
    const sel = box.querySelector('#evTrendSuite');
    try {
      const list = (await api('/eval/suites')).data.suites || [];
      sel.innerHTML = list.map(s =>
        `<option value="${esc(s.name)}" data-type="${esc(s.suite_type)}">${esc(s.label || s.name)}${s.builtin ? ' · ' + t('内置') : ''}</option>`).join('');
    } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  }

  async function renderTrend() {
    const sel = box.querySelector('#evTrendSuite');
    const el = box.querySelector('#evTrend');
    const suite = sel.value; const opt = sel.selectedOptions[0];
    if (!suite) { toast(t('请选择套件'), 'err'); return; }
    el.innerHTML = `<span style="color:var(--text-3)">${t('加载中…')}</span>`;
    try {
      const d = (await api(`/eval/trend?suite=${encodeURIComponent(suite)}&suite_type=${encodeURIComponent(opt?.dataset.type || '')}`)).data;
      const pts = d.points || [];
      if (!pts.length) { el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:13px">${t('该套件暂无基线——采集或发布后即可查看趋势')}</div>`; return; }
      const s = d.summary || {};
      const axis = box.querySelector('#evTrendAxis').value || 'version';
      const dirTag = s.direction === 'up' ? `<span class="tag green">↑ +${s.netSuccess}pp</span>`
        : s.direction === 'down' ? `<span class="tag red">↓ ${s.netSuccess}pp</span>` : `<span class="tag gray">${t('持平')}</span>`;
      el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-bottom:10px">
          <span class="tag blue">${pts.length} ${t('个版本')}</span>${dirTag}
          <span class="tag gray">${t('回退')} ${s.regressions || 0}</span>
          <span class="tag red">${t('显著回退')} ${s.significantRegressions || 0}</span>
          <span class="tag green">${t('显著提升')} ${s.significantImprovements || 0}</span>
          <span class="tag gray">${t('干预率净变化')} ${s.netIntervention > 0 ? '+' : ''}${s.netIntervention}pp</span>
          <span class="tag gray">${d.ciLevel || 95}% ${t('置信带')}</span>
        </div>${trendSvg(pts, axis)}
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
          ${pts.map(p => `<div style="font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <b style="min-width:90px">${esc(p.label || ('#' + p.id))}</b>
            <span style="color:var(--text-3)">${t('成功率')} ${p.metrics.successRate}%${p.ci && p.ci.successRate ? ` [${p.ci.successRate.low}~${p.ci.successRate.high}]` : ''} · ${t('步数')} ${p.metrics.avgSteps} · ${t('干预率')} ${p.metrics.interventionRate}%</span>
            ${sigBadge(p.significance)}
          </div>`).join('')}
        </div>`;
    } catch (e) { el.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
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
            ${sigBadge(b.significance)}
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

  async function openRunner() {
    let probe = {};
    try { probe = (await api('/eval/runner/probe')).data || {}; } catch { }
    let tpl = {};
    try { tpl = (await api('/eval/template/swe-bench-lite')).data; } catch { }
    modal({
      title: t('外部 runner 执行 SWE-bench-lite'),
      wide: true,
      body: `<div style="font-size:12px;line-height:1.8;color:var(--text-2);margin-bottom:8px">
          ${t('平台不捆绑 SWE-bench harness；配置外部 runner 命令后即可驱动真实执行（平台把 instances 写入 stdin，读取 predictions JSON）。')}
          <div style="margin-top:6px">${probe.configured ? `<span class="tag green">${t('已配置')}</span> <code>${esc(probe.command)}</code>` : `<span class="tag orange">${t('未配置')}</span>`}</div>
          ${probe.note ? `<div style="color:var(--text-3);margin-top:4px">${esc(probe.note)}</div>` : ''}
        </div>
        <label style="font-size:12px;color:var(--text-3)">${t('runner 命令（留空则用环境变量 SWEBENCH_RUNNER_CMD）')}
          <input class="input" id="rnCmd" placeholder="python3 run_swebench.py --dataset lite" value="${esc(probe.command || '')}"></label>
        <label style="font-size:12px;color:var(--text-3);display:block;margin-top:8px">instances JSON
          <textarea class="input" id="rnInst" rows="6" style="width:100%;font-family:monospace;font-size:12px">${esc(JSON.stringify(tpl.sample || [], null, 0))}</textarea></label>
        <div id="rnOut" style="margin-top:8px;font-size:12px"></div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('执行')}</button>`,
      onMount(m, close) {
        m.querySelector('[data-cancel]').onclick = close;
        m.querySelector('[data-go]').onclick = async () => {
          const o = m.querySelector('#rnOut');
          let rows; try { rows = JSON.parse(m.querySelector('#rnInst').value || '[]'); } catch { toast(t('JSON 解析失败'), 'err'); return; }
          if (!rows.length) { toast(t('instances 为空'), 'err'); return; }
          o.innerHTML = `<span style="color:var(--text-3)">${t('执行中…（受 runner 超时约束）')}</span>`;
          try {
            const d = (await api('/eval/runner/swe-bench-lite', { method: 'POST', body: { instances: rows, command: m.querySelector('#rnCmd').value.trim() || undefined } })).data;
            o.innerHTML = `<span class="tag green">${d.metrics.total} ${t('实例')}</span>
              <span class="tag ${d.metrics.meetsSuccess ? 'green' : 'red'}">${t('成功率')} ${d.metrics.successRate}%</span>
              <span class="tag gray">${t('步数')} ${d.metrics.avgSteps}</span>
              <span class="tag ${d.metrics.meetsIntervention ? 'green' : 'red'}">${t('干预率')} ${d.metrics.interventionRate}%</span>
              ${d.baseline ? `<span class="tag blue">${t('已落基线')} #${d.baseline.id}</span>` : ''}`;
            loadList(); loadMetrics();
          } catch (e) { o.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
        };
      },
    });
  }

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

  box.querySelector('#evTrendLoad').onclick = renderTrend;
  box.querySelector('#evTrendAxis').onchange = () => { if (box.querySelector('#evTrend svg')) renderTrend(); };
  box.querySelector('#evRunner').onclick = openRunner;

  loadMetrics();
  loadSuites();
  loadTrendSuites();
  loadList();
}
