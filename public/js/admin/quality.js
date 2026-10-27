/** 后台-对话质量（体验优化）：用户 👍/👎 与「解决了吗」反馈聚合
 *  统计卡片（满意度/解决率/好评差评数）+ 差评&未解决列表（用户/智能体/问题/回答摘录）
 *  用途：定位低评分对话 → 针对性优化智能体提示词与知识库
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';

export async function render(el) {
  let data = null;
  let type = 'all'; // all | down | unsolved

  el.innerHTML = `
  <style>
    .qz-content{max-width:380px;font-size:12.5px;line-height:1.7}
    .qz-q{color:var(--text-2);font-size:12px;margin-top:4px}
  </style>
  <div class="page-head">
    <h2>对话质量</h2>
    <div class="desc">用户在对话中的 👍/👎 评价与「这个回答解决你的问题了吗」调研聚合——定位低分对话，针对性优化提示词与知识库。</div>
  </div>
  <div class="grid-4" id="statCards" style="margin-bottom:14px"></div>
  <div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span class="fb-chip" data-t="all">待改进（差评+未解决）</span>
    <span class="fb-chip" data-t="down">仅差评</span>
    <span class="fb-chip" data-t="unsolved">仅未解决</span>
    <span style="font-size:12px;color:var(--text-3);margin-left:auto">💡 点击行查看完整问答上下文</span>
  </div>
  <div class="card">
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th style="width:120px">用户</th><th style="width:110px">智能体</th><th>问题 → 回答（摘录）</th><th style="width:86px">类型</th><th style="width:135px">时间</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
  </div>`;

  const tbody = el.querySelector('#tbody');

  function renderFilters() {
    el.querySelectorAll('[data-t]').forEach(c => {
      c.classList.toggle('on', c.dataset.t === type);
      c.onclick = () => { type = c.dataset.t; renderFilters(); renderTable(); };
    });
  }

  function openDetail(row) {
    modal({
      title: `💬 反馈详情 #${row.id}`,
      wide: true,
      body: `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
          <span class="tag blue">${esc(row.nickname || row.username)}</span>
          <span class="tag gray">${esc(row.agent_name || '首页助手')}</span>
          ${row.rating === -1 ? '<span class="tag red">👎 差评</span>' : ''}
          ${row.solved === 2 ? '<span class="tag orange">❌ 未解决</span>' : ''}
          <span class="tag gray">${esc((row.created_at || '').slice(0, 16))}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">👤 用户问题：</div>
        <div style="font-size:13px;line-height:1.8;padding:12px 14px;background:#f8faff;border-radius:10px;margin-bottom:14px;white-space:pre-wrap">${esc(row.question || '（无对应提问记录）')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">🤖 智能体回答：</div>
        <div style="font-size:13px;line-height:1.8;padding:12px 14px;background:#fef2f2;border-radius:10px;white-space:pre-wrap;max-height:320px;overflow:auto">${esc(row.content)}</div>`,
      foot: `<button class="btn" data-close>关闭</button>`,
      onMount(mask, close) { mask.querySelector('[data-close]').onclick = close; },
    });
  }

  function renderTable() {
    const list = (data.list || []).filter(r =>
      type === 'all' || (type === 'down' ? r.rating === -1 : r.solved === 2));
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">${type === 'all' ? '暂无待改进反馈——好评与解决统计见上方卡片，继续保持' : '该类型暂无反馈'}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => `
      <tr>
        <td><b>${esc(r.nickname || r.username)}</b><div style="font-size:11px;color:var(--text-3)">${esc(r.username)}</div></td>
        <td style="font-size:12px">🤖 ${esc(r.agent_name || '首页助手')}</td>
        <td>
          <div class="qz-q">Q：${esc((r.question || '—').slice(0, 60))}${(r.question || '').length > 60 ? '…' : ''}</div>
          <div class="qz-content">A：${esc(r.content.slice(0, 90))}${r.content.length > 90 ? '…' : ''}</div>
        </td>
        <td>${r.rating === -1 ? '<span class="tag red">👎 差评</span>' : ''}${r.solved === 2 ? '<span class="tag orange">未解决</span>' : ''}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc((r.created_at || '').slice(0, 16))}</td>
      </tr>`).join('');
    // 行点击查看详情（排除空态行）
    tbody.querySelectorAll('tr').forEach((tr, i) => {
      if (list[i]) { tr.style.cursor = 'pointer'; tr.onclick = () => openDetail(list[i]); }
    });
  }

  async function load() {
    data = (await api('/chat/quality')).data;
    const s = data.stat;
    el.querySelector('#statCards').innerHTML = `
      <div class="stat"><div class="s-label">用户满意度</div><div class="s-num" style="color:${s.satisfaction == null ? 'var(--text-3)' : s.satisfaction >= 80 ? '#059669' : s.satisfaction >= 60 ? '#d97706' : '#dc2626'}">${s.satisfaction == null ? '—' : s.satisfaction + '%'}</div><div class="s-unit" style="font-size:11px;color:var(--text-3)">👍${s.rated_up} / 👎${s.rated_down}</div></div>
      <div class="stat"><div class="s-label">问题解决率</div><div class="s-num" style="color:${s.resolve_rate == null ? 'var(--text-3)' : s.resolve_rate >= 80 ? '#059669' : '#dc2626'}">${s.resolve_rate == null ? '—' : s.resolve_rate + '%'}</div><div class="s-unit" style="font-size:11px;color:var(--text-3)">解决${s.solved_yes} / 未解决${s.solved_no}</div></div>
      <div class="stat"><div class="s-label">好评数</div><div class="s-num" style="color:#059669">${s.rated_up}</div></div>
      <div class="stat"><div class="s-label">差评数</div><div class="s-num" style="color:${s.rated_down ? '#dc2626' : 'var(--text)'}">${s.rated_down}</div></div>`;
    renderFilters();
    renderTable();
  }

  // 复用反馈页的 chip 样式（fb-chip 类在 feedback 页 scoped style，这里补一份）
  const st = document.createElement('style');
  st.textContent = '.fb-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}.fb-chip:hover{border-color:#93c5fd;color:#2563eb}.fb-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}';
  el.prepend(st);

  await load();
}
