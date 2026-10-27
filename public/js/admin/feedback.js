/** 后台-意见反馈管理（帮助体系）：用户反馈闭环处理
 *  统计卡片 + 状态/类型筛选 + 列表（用户/类型/内容/联系方式/状态/回复）+ 处理弹窗
 *  处理动作 = 填写回复 → 置为已处理 + 站内信回告提交者（闭环）
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';

const TYPE_META = {
  bug: { ic: '🐛', label: 'Bug 报告', cls: 'red' },
  suggest: { ic: '💡', label: '功能建议', cls: 'blue' },
  consult: { ic: '❓', label: '使用咨询', cls: 'purple' },
};

export async function render(el) {
  let data = null;
  let st = 'all', tp = 'all';

  el.innerHTML = `
  <style>
    .fb-filter{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .fb-chip{padding:5px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:12px;cursor:pointer;color:#4b5563}
    .fb-chip:hover{border-color:#93c5fd;color:#2563eb}
    .fb-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
    .fb-content{max-width:420px;font-size:12.5px;line-height:1.7;color:var(--text)}
    .fb-reply{margin-top:6px;padding:8px 10px;background:#f0fdf4;border-radius:8px;color:#166534;font-size:12px}
  </style>
  <div class="page-head">
    <h2>意见反馈</h2>
    <div class="desc">用户通过全站「💬 意见反馈」入口提交的 Bug / 建议 / 咨询——处理后系统自动向提交者发送站内信，形成闭环。</div>
  </div>
  <div class="grid-4" id="statCards" style="margin-bottom:14px"></div>
  <div class="card" style="padding:12px 18px;margin-bottom:14px">
    <div class="fb-filter" id="filters"></div>
  </div>
  <div class="card">
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th style="width:130px">提交者</th><th style="width:90px">类型</th><th>反馈内容</th><th style="width:120px">联系方式</th><th style="width:80px">状态</th><th style="width:140px">提交时间</th><th style="width:110px">操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
  </div>`;

  const tbody = el.querySelector('#tbody');

  function renderFilters() {
    const f = el.querySelector('#filters');
    const stChips = [
      { k: 'all', label: '全部' }, { k: 'pending', label: '⏳ 待处理' }, { k: 'processed', label: '✅ 已处理' },
    ];
    const tpChips = [
      { k: 'all', label: '全类型' },
      ...Object.entries(TYPE_META).map(([k, v]) => ({ k, label: `${v.ic} ${v.label}` })),
    ];
    f.innerHTML = `
      ${stChips.map(c => `<span class="fb-chip ${st === c.k ? 'on' : ''}" data-st="${c.k}">${c.label}${c.k === 'pending' && data.stat.pending ? `（${data.stat.pending}）` : ''}</span>`).join('')}
      <span style="width:1px;height:16px;background:#e5e7eb"></span>
      ${tpChips.map(c => `<span class="fb-chip ${tp === c.k ? 'on' : ''}" data-tp="${c.k}">${c.label}</span>`).join('')}`;
    f.querySelectorAll('[data-st]').forEach(c => c.onclick = () => { st = c.dataset.st; renderFilters(); renderTable(); });
    f.querySelectorAll('[data-tp]').forEach(c => c.onclick = () => { tp = c.dataset.tp; renderFilters(); renderTable(); });
  }

  function openProcess(fb) {
    modal({
      title: `${TYPE_META[fb.type]?.ic || '💬'} 处理反馈 #${fb.id}（${esc(fb.nickname || fb.username)}）`,
      wide: true,
      body: `
        <div style="font-size:13px;line-height:1.8;color:var(--text);padding:12px 14px;background:#f8faff;border-radius:10px;margin-bottom:12px">${esc(fb.content)}</div>
        ${fb.contact ? `<div style="font-size:12px;color:var(--text-3);margin-bottom:12px">📞 联系方式：${esc(fb.contact)}</div>` : ''}
        ${fb.reply ? `<div class="fb-reply">↩ 当前回复：${esc(fb.reply)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-3);margin:12px 0 6px">处理回复（将作为站内信发送给提交者，请说明处理结果或后续安排）</div>
        <textarea id="fbReply" rows="4" class="input" style="width:100%;box-sizing:border-box;resize:vertical" placeholder="例如：该问题已在 v1.2 修复，感谢反馈！ / 建议已排入下期迭代…">${esc(fb.reply || '')}</textarea>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>标记已处理并发送通知</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const reply = mask.querySelector('#fbReply').value.trim();
          if (!reply) return toast('请填写处理回复', 'err');
          try {
            const j = await api(`/feedback/${fb.id}`, { method: 'PUT', body: { reply } });
            toast(j.msg || '已处理');
            close();
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderTable() {
    const list = data.list.filter(f =>
      (st === 'all' || f.status === st) && (tp === 'all' || f.type === tp));
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">暂无${st === 'pending' ? '待处理' : ''}反馈</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(f => {
      const tm = TYPE_META[f.type] || { ic: '💬', label: f.type, cls: 'gray' };
      return `
      <tr>
        <td><b>${esc(f.nickname || f.username)}</b><div style="font-size:11px;color:var(--text-3)">${esc(f.username)}</div></td>
        <td><span class="tag ${tm.cls}">${tm.ic} ${tm.label}</span></td>
        <td>
          <div class="fb-content">${esc(f.content.length > 120 ? f.content.slice(0, 120) + '…' : f.content)}${f.content.length > 120 ? ` <a href="javascript:;" data-full="${f.id}" style="color:#2563eb">展开</a>` : ''}</div>
          ${f.status === 'processed' && f.reply ? `<div class="fb-reply">↩ 已回复：${esc(f.reply.length > 80 ? f.reply.slice(0, 80) + '…' : f.reply)}</div>` : ''}
        </td>
        <td style="font-size:12px;color:var(--text-3)">${esc(f.contact || '-')}</td>
        <td>${f.status === 'processed' ? '<span class="tag green">已处理</span>' : '<span class="tag orange">待处理</span>'}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc((f.created_at || '').slice(0, 16))}</td>
        <td>
          <button class="btn sm ${f.status === 'pending' ? 'primary' : ''}" data-process="${f.id}">${f.status === 'pending' ? '处理' : '重新处理'}</button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-process]').forEach(b => b.onclick = () => openProcess(list.find(f => f.id === +b.dataset.process)));
    tbody.querySelectorAll('[data-full]').forEach(a => a.onclick = () => {
      const f = list.find(x => x.id === +a.dataset.full);
      modal({
        title: `反馈 #${f.id} 全文（${esc(f.nickname || f.username)}）`,
        body: `<div style="font-size:13px;line-height:1.9;color:var(--text);white-space:pre-wrap">${esc(f.content)}</div>`,
        foot: '<button class="btn" data-close>关闭</button>',
        onMount(mask, close) { mask.querySelector('[data-close]').onclick = close; },
      });
    });
  }

  async function load() {
    data = (await api('/feedback')).data;
    const s = data.stat;
    el.querySelector('#statCards').innerHTML = `
      <div class="stat"><div class="s-label">反馈总数</div><div class="s-num">${s.total}</div></div>
      <div class="stat"><div class="s-label">待处理</div><div class="s-num" style="color:${s.pending ? '#f59e0b' : 'var(--text)'}">${s.pending}</div></div>
      <div class="stat"><div class="s-label">已处理</div><div class="s-num" style="color:#059669">${s.processed}</div></div>
      <div class="stat"><div class="s-label">今日新增</div><div class="s-num">${s.today}</div></div>`;
    renderFilters();
    renderTable();
  }

  await load();
}
