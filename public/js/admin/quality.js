/** 后台-对话质量（#10 LLMOps 质量看板四视图）：反馈质量 | Token 成本 | 检索命中率 | 评测得分
 *  视图一「反馈质量」= 原功能：用户 👍/👎 与「解决了吗」调研聚合 + 差评/未解决列表（定位低分对话）
 *  新增三视图消费 GET /api/chat/quality 扩展的 llm/kb/eval 数据块（四视图一次拉取，切换纯前端渲染不再发请求）
 */
import { api } from '../api.js';
import { esc, modal, fmtNum } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let data = null;
  let type = 'all'; // 反馈视图内过滤：all | down | unsolved
  let view = 'fb';  // 四视图：fb | llm | kb | eval

  el.innerHTML = `
  <style>
    .qz-content{max-width:380px;font-size:12.5px;line-height:1.7}
    .qz-q{color:var(--text-2);font-size:12px;margin-top:4px}
  </style>
  <div class="page-head">
    <h2>${t('对话质量')}</h2>
    <div class="desc">${t('LLMOps 质量看板四视图——反馈质量 / Token 成本 / 检索命中率 / 评测得分，定位低分对话，针对性优化提示词与知识库。')}</div>
  </div>
  <div class="card" style="padding:10px 18px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span class="fb-chip" data-v="fb">👍 ${t('反馈质量')}</span>
    <span class="fb-chip" data-v="llm">💰 ${t('Token 成本')}</span>
    <span class="fb-chip" data-v="kb">📚 ${t('检索命中率')}</span>
    <span class="fb-chip" data-v="eval">🧪 ${t('评测得分')}</span>
    <span style="font-size:12px;color:var(--text-3);margin-left:auto" id="qzHint">💡 ${t('点击行查看完整问答上下文')}</span>
  </div>
  <div id="vFb">
    <div class="grid-4" id="statCards" style="margin-bottom:14px"></div>
    <div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="fb-chip" data-t="all">${t('待改进（差评+未解决）')}</span>
      <span class="fb-chip" data-t="down">${t('仅差评')}</span>
      <span class="fb-chip" data-t="unsolved">${t('仅未解决')}</span>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th style="width:120px">${t('用户')}</th><th style="width:110px">${t('智能体')}</th><th>${t('问题 → 回答（摘录）')}</th><th style="width:86px">${t('类型')}</th><th style="width:135px">${t('时间')}</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table></div>
    </div>
  </div>
  <div id="vLlm" style="display:none"></div>
  <div id="vKb" style="display:none"></div>
  <div id="vEval" style="display:none"></div>`;

  const tbody = el.querySelector('#tbody');

  // ---------- 视图一：反馈质量（原有功能原样保留） ----------
  function renderFilters() {
    el.querySelectorAll('[data-t]').forEach(c => {
      c.classList.toggle('on', c.dataset.t === type);
      c.onclick = () => { type = c.dataset.t; renderFilters(); renderTable(); };
    });
  }

  function openDetail(row) {
    modal({
      title: `💬 ${t('反馈详情')} #${row.id}`,
      wide: true,
      body: `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
          <span class="tag blue">${esc(row.nickname || row.username)}</span>
          <span class="tag gray">${esc(row.agent_name || t('首页助手'))}</span>
          ${row.rating === -1 ? `<span class="tag red">👎 ${t('差评')}</span>` : ''}
          ${row.solved === 2 ? `<span class="tag orange">❌ ${t('未解决')}</span>` : ''}
          <span class="tag gray">${esc((row.created_at || '').slice(0, 16))}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">👤 ${t('用户问题：')}</div>
        <div style="font-size:13px;line-height:1.8;padding:12px 14px;background:#f8faff;border-radius:10px;margin-bottom:14px;white-space:pre-wrap">${esc(row.question || t('（无对应提问记录）'))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">🤖 ${t('智能体回答：')}</div>
        <div style="font-size:13px;line-height:1.8;padding:12px 14px;background:#fef2f2;border-radius:10px;white-space:pre-wrap;max-height:320px;overflow:auto">${esc(row.content)}</div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask, close) { mask.querySelector('[data-close]').onclick = close; },
    });
  }

  function renderTable() {
    const list = (data.list || []).filter(r =>
      type === 'all' || (type === 'down' ? r.rating === -1 : r.solved === 2));
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">${type === 'all' ? t('暂无待改进反馈——好评与解决统计见上方卡片，继续保持') : t('该类型暂无反馈')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => `
      <tr>
        <td><b>${esc(r.nickname || r.username)}</b><div style="font-size:11px;color:var(--text-3)">${esc(r.username)}</div></td>
        <td style="font-size:12px">🤖 ${esc(r.agent_name || t('首页助手'))}</td>
        <td>
          <div class="qz-q">Q：${esc((r.question || '—').slice(0, 60))}${(r.question || '').length > 60 ? '…' : ''}</div>
          <div class="qz-content">A：${esc(r.content.slice(0, 90))}${r.content.length > 90 ? '…' : ''}</div>
        </td>
        <td>${r.rating === -1 ? `<span class="tag red">👎 ${t('差评')}</span>` : ''}${r.solved === 2 ? `<span class="tag orange">${t('未解决')}</span>` : ''}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc((r.created_at || '').slice(0, 16))}</td>
      </tr>`).join('');
    // 行点击查看详情（排除空态行）
    tbody.querySelectorAll('tr').forEach((tr, i) => {
      if (list[i]) { tr.style.cursor = 'pointer'; tr.onclick = () => openDetail(list[i]); }
    });
  }

  // ---------- 视图二：Token 成本（llm 块） ----------
  // 纯 CSS 柱状图（项目内零依赖先例：ui.js Canvas 图表用于折线/柱状；此处轻量 14 天柱用 div 高度条即可，与全局风格一致）
  const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);

  function renderLlm() {
    const box = el.querySelector('#vLlm');
    const L = data.llm || {};
    const days = Array.isArray(L.tokens_by_day) ? L.tokens_by_day : [];
    const max = Math.max(...days.map(d => +d.tokens || 0), 0);
    const total = days.reduce((s, d) => s + (+d.tokens || 0), 0);
    const calls = days.reduce((s, d) => s + (+d.calls || 0), 0);
    const topTable = (title, rows, key) => `
      <div class="card" style="flex:1;min-width:320px;padding:14px 18px">
        <b style="font-size:13px">${esc(t(title))}</b>
        <div class="table-wrap" style="margin-top:8px"><table class="tbl">
          <thead><tr><th>${key === 'model' ? t('模型') : t('智能体')}</th><th style="width:100px">tokens</th><th style="width:80px">${t('调用次数')}</th></tr></thead>
          <tbody>${(rows || []).length ? (rows || []).map(r => `
            <tr><td style="font-size:12px"><b>${esc(key === 'model' ? r.model : r.agent_name)}</b></td>
            <td style="font-size:12px">${fmtNum(r.tokens)}</td>
            <td style="font-size:12px">${fmtNum(r.calls)}</td></tr>`).join('') :
            `<tr><td colspan="3" class="empty">${t('暂无数据')}</td></tr>`}
           </tbody></table></div>
      </div>`;
    box.innerHTML = `
      <div class="card" style="padding:14px 18px;margin-bottom:14px">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:2px">
          <b style="font-size:14px">📈 ${t('近 14 天 Token 消耗')}</b>
          <span style="font-size:12px;color:var(--text-3)">${t('合计')} <b>${fmtNum(total)}</b> tokens · ${fmtNum(calls)} ${t('次调用（chat_traces 全链路口径，含技能/外部转发链路）')}</span>
        </div>
        ${max > 0 ? `
        <div style="display:flex;align-items:flex-end;gap:5px;height:150px;margin-top:14px">
          ${days.map(d => `
          <div style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px" title="${esc(d.day)}：${fmtNum(d.tokens)} tokens / ${fmtNum(d.calls)} 次">
            <span style="font-size:10px;color:var(--text-3)">${d.tokens ? fmtTok(d.tokens) : ''}</span>
            <div style="width:66%;max-width:36px;height:${Math.max(d.tokens / max * 100, 2).toFixed(1)}%;background:linear-gradient(180deg,#3b82f6,#93c5fd);border-radius:4px 4px 0 0"></div>
          </div>`).join('')}
        </div>
        <div style="display:flex;gap:5px;margin-top:6px">
          ${days.map((d, i) => `<span style="flex:1;text-align:center;font-size:10px;color:var(--text-3)">${i % 2 === 0 ? esc(String(d.day).slice(5)) : ''}</span>`).join('')}
        </div>` : `<div class="empty" style="padding:26px">${t('近 14 天暂无 token 消耗记录')}</div>`}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
        ${topTable(t('按模型 TOP10'), L.tokens_by_model, 'model')}
        ${topTable(t('按智能体 TOP10'), L.tokens_by_agent, 'agent')}
      </div>`;
  }

  // ---------- 视图三：检索命中率（kb 块） ----------
  function renderKb() {
    const box = el.querySelector('#vKb');
    const K = data.kb || {};
    const hr = K.hit_rate;
    const miss = Math.max((+K.total_with_kb || 0) - (+K.hit_count || 0), 0);
    box.innerHTML = `
      <div class="grid-4" style="margin-bottom:14px">
        <div class="stat"><div class="s-label">${t('知识库检索命中率')}</div>
          <div class="s-num" style="color:${hr == null ? 'var(--text-3)' : hr >= 70 ? '#059669' : hr >= 40 ? '#d97706' : '#dc2626'}">${hr == null ? '—' : hr + '%'}</div></div>
        <div class="stat"><div class="s-label">${t('命中对话数')}</div><div class="s-num" style="color:#059669">${fmtNum(K.hit_count || 0)}</div></div>
        <div class="stat"><div class="s-label">${t('挂库对话总数')}</div><div class="s-num">${fmtNum(K.total_with_kb || 0)}</div></div>
        <div class="stat"><div class="s-label">${t('未命中数')}</div><div class="s-num" style="color:${miss ? '#dc2626' : 'var(--text)'}">${fmtNum(miss)}</div></div>
      </div>
      <div class="card" style="padding:14px 18px">
        <b style="font-size:13px">📖 ${t('口径说明')}</b>
        <div style="font-size:12px;line-height:2;color:var(--text-2);margin-top:6px">
          · ${t('分母（挂库对话总数）＝当前仍关联知识库的智能体的全部对话记录；智能体后来解绑知识库或已删除的历史对话不计入（chat_traces 未记录检索时刻的挂库状态，按 agents 当前配置关联，属近似口径）')}<br>
          · ${t('命中 ＝ 该轮对话知识库检索返回了至少一条内容（kb_hits 非空）；挂库但未检索到内容计为未命中')}<br>
          · ${t('命中率低时优先检查：知识库分块质量、检索阈值、智能体与知识库的内容匹配度')}
        </div>
      </div>`;
  }

  // ---------- 视图四：评测得分（eval 块，V1.3 #6 评测集） ----------
  function renderEval() {
    const box = el.querySelector('#vEval');
    const E = Array.isArray(data.eval) ? data.eval : [];
    if (!E.length) {
      box.innerHTML = `<div class="card" style="padding:40px;text-align:center">
        <div style="font-size:28px;margin-bottom:8px">🧪</div>
        <div style="color:var(--text-3);font-size:13px">${t('暂无评测数据（V1.3 #6 评测集）——到智能体详情或知识库详情创建评测集并运行后，此处将展示近 14 天得分趋势')}</div>
      </div>`;
      return;
    }
    const max = Math.max(...E.map(e => +e.avg_score || 0), 0);
    const avg = E.length ? (E.reduce((s, e) => s + (+e.avg_score || 0), 0) / E.length).toFixed(2) : '0';
    box.innerHTML = `
      <div class="card" style="padding:14px 18px;margin-bottom:14px">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:2px">
          <b style="font-size:14px">🧪 ${t('近 14 天评测得分趋势')}</b>
          <span style="font-size:12px;color:var(--text-3)">${t('日均分')} <b>${esc(String(avg))}</b> · ${fmtNum(E.reduce((s, e) => s + (+e.runs || 0), 0))} ${t('次评测运行（仅统计已完成的评测）')}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:5px;height:150px;margin-top:14px">
          ${E.map(e => `
          <div style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px" title="${esc(e.day)}：${t('平均')} ${e.avg_score} ${t('分')} / ${fmtNum(e.runs)} ${t('次运行')}">
            <span style="font-size:10px;color:var(--text-3)">${esc(String(e.avg_score ?? ''))}</span>
            <div style="width:66%;max-width:36px;height:${Math.max((+e.avg_score || 0) / (max || 1) * 100, 2).toFixed(1)}%;background:linear-gradient(180deg,#059669,#6ee7b7);border-radius:4px 4px 0 0"></div>
          </div>`).join('')}
        </div>
        <div style="display:flex;gap:5px;margin-top:6px">
          ${E.map((e, i) => `<span style="flex:1;text-align:center;font-size:10px;color:var(--text-3)">${i % 2 === 0 ? esc(String(e.day).slice(5)) : ''}</span>`).join('')}
        </div>
      </div>`;
  }

  // ---------- 视图切换（四视图数据一次拉取，切换纯前端渲染不再发请求） ----------
  const HINTS = {
    fb: () => `💡 ${t('点击行查看完整问答上下文')}`,
    llm: () => `💡 ${t('悬停柱体查看当日明细；TOP10 按累计 tokens 排序')}`,
    kb: () => `💡 ${t('分母为当前仍挂知识库的智能体对话（近似口径，详见卡片说明）')}`,
    eval: () => `💡 ${t('数据来自 V1.3 #6 评测集（仅统计已完成的评测运行）')}`,
  };
  function renderView() {
    el.querySelectorAll('[data-v]').forEach(c => {
      c.classList.toggle('on', c.dataset.v === view);
      c.onclick = () => { view = c.dataset.v; renderView(); };
    });
    el.querySelector('#qzHint').textContent = HINTS[view] ? HINTS[view]() : '';
    el.querySelector('#vFb').style.display = view === 'fb' ? '' : 'none';
    el.querySelector('#vLlm').style.display = view === 'llm' ? '' : 'none';
    el.querySelector('#vKb').style.display = view === 'kb' ? '' : 'none';
    el.querySelector('#vEval').style.display = view === 'eval' ? '' : 'none';
    if (view === 'llm') renderLlm();
    if (view === 'kb') renderKb();
    if (view === 'eval') renderEval();
  }

  async function load() {
    data = (await api('/chat/quality')).data;
    const s = data.stat;
    el.querySelector('#statCards').innerHTML = `
      <div class="stat"><div class="s-label">${t('用户满意度')}</div><div class="s-num" style="color:${s.satisfaction == null ? 'var(--text-3)' : s.satisfaction >= 80 ? '#059669' : s.satisfaction >= 60 ? '#d97706' : '#dc2626'}">${s.satisfaction == null ? '—' : s.satisfaction + '%'}</div><div class="s-unit" style="font-size:11px;color:var(--text-3)">👍${s.rated_up} / 👎${s.rated_down}</div></div>
      <div class="stat"><div class="s-label">${t('问题解决率')}</div><div class="s-num" style="color:${s.resolve_rate == null ? 'var(--text-3)' : s.resolve_rate >= 80 ? '#059669' : '#dc2626'}">${s.resolve_rate == null ? '—' : s.resolve_rate + '%'}</div><div class="s-unit" style="font-size:11px;color:var(--text-3)">${t('解决')}${s.solved_yes} / ${t('未解决')}${s.solved_no}</div></div>
      <div class="stat"><div class="s-label">${t('好评数')}</div><div class="s-num" style="color:#059669">${s.rated_up}</div></div>
      <div class="stat"><div class="s-label">${t('差评数')}</div><div class="s-num" style="color:${s.rated_down ? '#dc2626' : 'var(--text)'}">${s.rated_down}</div></div>`;
    renderFilters();
    renderTable();
    renderView();
  }

  // 复用反馈页的 chip 样式（fb-chip 类在 feedback 页 scoped style，这里补一份；四视图切换与反馈过滤共用）
  const st = document.createElement('style');
  st.textContent = '.fb-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}.fb-chip:hover{border-color:#93c5fd;color:#2563eb}.fb-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}';
  el.prepend(st);

  await load();
}
