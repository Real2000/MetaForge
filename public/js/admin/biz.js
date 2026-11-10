/** 后台-商业化管理 #/admin/biz：企业定制线索 + 发票申请处理（双 Tab）
 *  线索：新/已联系/成交/流失 状态流转 + 跟进备注
 *  发票：待处理/已开出/未通过 处理（站内信闭环通知申请人）
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const LEAD_ST = { new: () => `🆕 ${t('新线索')}`, contacted: () => `📞 ${t('已联系')}`, won: () => `✅ ${t('成交')}`, lost: () => `❌ ${t('流失')}` };
const INV_ST = { pending: () => `⏳ ${t('处理中')}`, issued: () => `✅ ${t('已开出')}`, rejected: () => `❌ ${t('未通过')}` };

export async function render(el) {
  let tab = 'leads';
  let leads = null, invoices = null;

  el.innerHTML = `
  <style>
    .biz-tabs{display:flex;gap:6px;margin-bottom:14px}
    .biz-tab{padding:9px 20px;border-radius:10px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:13px;color:var(--text-2)}
    .biz-tab.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
    .biz-tab .dot{display:inline-block;min-width:17px;padding:0 5px;background:#ef4444;color:#fff;border-radius:9px;font-size:10px;line-height:17px;text-align:center;margin-left:6px}
  </style>
  <div class="page-head">
    <h2>${t('商业化管理')}</h2>
    <div class="desc">${t('企业定制线索跟进与发票申请处理——价格页提交的销售线索会实时进入这里。')}</div>
  </div>
  <div class="biz-tabs">
    <div class="biz-tab" data-t="leads">💬 ${t('企业线索')}<span class="dot" id="leadDot" style="display:none"></span></div>
    <div class="biz-tab" data-t="invoices">🧾 ${t('发票申请')}<span class="dot" id="invDot" style="display:none"></span></div>
  </div>
  <div id="tabLeads"></div>
  <div id="tabInvoices" style="display:none"></div>`;

  function renderTabs() {
    el.querySelectorAll('.biz-tab').forEach(tb => {
      tb.classList.toggle('on', tb.dataset.t === tab);
      tb.onclick = () => { tab = tb.dataset.t; renderTabs(); };
    });
    el.querySelector('#tabLeads').style.display = tab === 'leads' ? '' : 'none';
    el.querySelector('#tabInvoices').style.display = tab === 'invoices' ? '' : 'none';
    const ld = el.querySelector('#leadDot');
    const id_ = el.querySelector('#invDot');
    if (leads) { ld.style.display = leads.stat.new ? '' : 'none'; ld.textContent = leads.stat.new; }
    if (invoices) { id_.style.display = invoices.stat.pending ? '' : 'none'; id_.textContent = invoices.stat.pending; }
  }

  // ---------- 线索 Tab ----------
  function renderLeads() {
    const box = el.querySelector('#tabLeads');
    const s = leads.stat;
    box.innerHTML = `
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat"><div class="s-label">${t('线索总数')}</div><div class="s-num">${s.total}</div></div>
      <div class="stat"><div class="s-label">${t('新线索')}</div><div class="s-num" style="color:${s.new ? '#f59e0b' : 'var(--text)'}">${s.new}</div></div>
      <div class="stat"><div class="s-label">${t('已联系')}</div><div class="s-num">${s.contacted}</div></div>
      <div class="stat"><div class="s-label">${t('成交')}</div><div class="s-num" style="color:#059669">${s.won}</div></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('公司 / 规模')}</th><th>${t('联系人')}</th><th>${t('联系方式')}</th><th>${t('需求')}</th><th>${t('状态')}</th><th>${t('提交时间')}</th><th style="width:80px">${t('操作')}</th></tr></thead>
        <tbody>${leads.list.length ? leads.list.map(l => `
          <tr>
            <td><b>${esc(l.company)}</b>${l.scale ? `<div style="font-size:11px;color:var(--text-3)">${esc(l.scale)}</div>` : ''}</td>
            <td>${esc(l.contact_name)}${l.handler ? `<div style="font-size:11px;color:var(--text-3)">${t('跟进：')}${esc(l.handler)}</div>` : ''}</td>
            <td style="font-size:12px">${esc(l.phone || '')}${l.phone && l.email ? '<br>' : ''}${esc(l.email || '')}</td>
            <td style="font-size:12px;max-width:260px">${esc((l.demand || '—').slice(0, 80))}${(l.demand || '').length > 80 ? '…' : ''}${l.note ? `<div style="color:var(--text-3);margin-top:4px;padding:6px 8px;background:#f8faff;border-radius:6px">📝 ${esc(l.note.slice(0, 60))}${l.note.length > 60 ? '…' : ''}</div>` : ''}</td>
            <td><span class="tag ${l.status === 'new' ? 'orange' : l.status === 'won' ? 'green' : l.status === 'lost' ? 'gray' : 'blue'}">${LEAD_ST[l.status]() || l.status}</span></td>
            <td style="font-size:12px;color:var(--text-3)">${esc((l.created_at || '').slice(0, 16))}</td>
            <td><button class="btn sm primary" data-follow="${l.id}">${t('跟进')}</button></td>
          </tr>`).join('') : `<tr><td colspan="7" class="empty">${t('暂无线索——价格页「企业定制」表单提交后进入这里')}</td></tr>`}</tbody>
      </table></div>
    </div>`;
    box.querySelectorAll('[data-follow]').forEach(b => b.onclick = () => {
      const l = leads.list.find(x => x.id === +b.dataset.follow);
      modal({
        title: `${t('跟进线索：')}${l.company}`,
        body: `
          <div style="font-size:13px;line-height:1.8;padding:12px 14px;background:#f8faff;border-radius:10px;margin-bottom:12px">
            <b>${esc(l.company)}</b>${l.scale ? `（${esc(l.scale)}）` : ''} · ${t('联系人')} ${esc(l.contact_name)}<br>
            ${esc(l.phone || '')} ${l.email ? ' · ' + esc(l.email) : ''}<br>
            ${esc(l.demand || t('（无需求描述）'))}
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">${t('状态')}</div>
          <select class="input" id="fStatus">${Object.entries(LEAD_ST).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v()}</option>`).join('')}</select>
          <div style="font-size:12px;color:var(--text-3);margin:12px 0 4px">${t('跟进备注')}</div>
          <textarea class="input" id="fNote" rows="3" placeholder="${t('沟通记录、下一步安排…')}" style="resize:vertical">${esc(l.note || '')}</textarea>`,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            try {
              await api(`/biz/leads/${l.id}`, { method: 'PUT', body: { status: mask.querySelector('#fStatus').value, note: mask.querySelector('#fNote').value.trim() } });
              toast(t('已保存')); close(); loadLeads();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    });
  }

  // ---------- 发票 Tab ----------
  function renderInvoices() {
    const box = el.querySelector('#tabInvoices');
    const s = invoices.stat;
    box.innerHTML = `
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat"><div class="s-label">${t('申请总数')}</div><div class="s-num">${s.total}</div></div>
      <div class="stat"><div class="s-label">${t('待处理')}</div><div class="s-num" style="color:${s.pending ? '#f59e0b' : 'var(--text)'}">${s.pending}</div></div>
      <div class="stat"><div class="s-label">${t('已开出')}</div><div class="s-num" style="color:#059669">${s.issued}</div></div>
      <div class="stat"><div class="s-label">${t('未通过')}</div><div class="s-num" style="color:${s.rejected ? '#dc2626' : 'var(--text)'}">${s.rejected}</div></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('申请人')}</th><th>${t('月份')}</th><th>${t('抬头 / 税号')}</th><th>${t('当月用量')}</th><th>${t('接收邮箱')}</th><th>${t('状态')}</th><th style="width:170px">${t('操作')}</th></tr></thead>
        <tbody>${invoices.list.length ? invoices.list.map(i => `
          <tr>
            <td><b>${esc(i.nickname || i.username)}</b><div style="font-size:11px;color:var(--text-3)">${esc(i.username)}</div></td>
            <td><b>${esc(i.month)}</b><div style="font-size:11px;color:var(--text-3)">${esc((i.created_at || '').slice(0, 10))}</div></td>
            <td style="font-size:12px">${esc(i.title)}${i.tax_no ? `<div style="color:var(--text-3)">${esc(i.tax_no)}</div>` : ''}${i.note ? `<div style="color:var(--text-3);margin-top:2px">📝 ${esc(i.note.slice(0, 40))}</div>` : ''}</td>
            <td style="font-size:12px">${(i.tokens || 0).toLocaleString('zh-CN')}<div style="color:var(--text-3)">tokens</div></td>
            <td style="font-size:12px">${esc(i.email || '—')}</td>
            <td><span class="tag ${i.status === 'issued' ? 'green' : i.status === 'rejected' ? 'red' : 'orange'}">${INV_ST[i.status]() || i.status}</span></td>
            <td>
              ${i.status === 'pending' ? `
              <button class="btn sm primary" data-inv="${i.id}" data-st="issued">✅ ${t('开票')}</button>
              <button class="btn sm" data-inv="${i.id}" data-st="rejected">${t('驳回')}</button>` : `<button class="btn sm" data-inv="${i.id}" data-st="pending">${t('重开')}</button>`}
            </td>
          </tr>`).join('') : `<tr><td colspan="7" class="empty">${t('暂无发票申请')}</td></tr>`}</tbody>
      </table></div>
    </div>`;
    box.querySelectorAll('[data-inv]').forEach(b => b.onclick = async () => {
      const st = b.dataset.st;
      if (st === 'issued' && !(await confirmBox(t('确认已开出该发票？将站内信通知申请人。')))) return;
      try {
        const j = await api(`/biz/invoices/${b.dataset.inv}`, { method: 'PUT', body: { status: st } });
        toast(j.msg || t('已处理')); loadInvoices();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function loadLeads() {
    leads = (await api('/biz/leads')).data;
    renderLeads(); renderTabs();
  }
  async function loadInvoices() {
    invoices = (await api('/biz/invoices/all')).data;
    renderInvoices(); renderTabs();
  }

  renderTabs();
  await Promise.all([loadLeads(), loadInvoices()]);
}
