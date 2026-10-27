/** 账单与发票页 #/billing：月度用量明细 + 套餐概览 + 在线发票申请
 *  用量按 messages.tokens 月度聚合；发票申请落库（管理员在后台「商业化」处理）。
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';

export async function render(el) {
  let billing = null;
  let invoices = [];

  el.innerHTML = `
  <div class="page-head">
    <h2>账单与发票</h2>
    <div class="desc">月度用量明细、套餐费用与发票申请——用量与账单完全透明。</div>
  </div>
  <div class="grid-4" id="overview" style="margin-bottom:14px"></div>
  <div class="grid-2" style="align-items:start">
    <div class="card">
      <h3 style="margin:0 0 10px">📊 近 6 个月用量明细</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>月份</th><th>消息数</th><th>Tokens</th><th>套餐费</th></tr></thead>
        <tbody id="monthTb"></tbody>
      </table></div>
    </div>
    <div>
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin:0 0 10px;display:flex;justify-content:space-between;align-items:center">🧾 发票申请
          <button class="btn sm primary" id="applyBtn">＋ 申请发票</button>
        </h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>月份</th><th>抬头</th><th>当月用量</th><th>状态</th><th>时间</th></tr></thead>
          <tbody id="invTb"></tbody>
        </table></div>
      </div>
      <div class="card" style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border-color:#fde68a">
        <b style="font-size:13px">💡 开票说明</b>
        <div style="font-size:12px;color:var(--text-2);line-height:1.9;margin-top:6px">
          专业版（¥199/月）与企业版支持开具增值税普通/专用发票；免费版用量 0 元，如有其他费用（定制服务等）可在备注中说明。提交后财务将在 3 个工作日内处理，处理结果通过站内通知告知。
        </div>
      </div>
    </div>
  </div>`;

  function fmt(n) { return (n || 0).toLocaleString('zh-CN'); }

  function openApply() {
    const months = billing.months.map(m => m.month);
    const cur = new Date().toISOString().slice(0, 7);
    const opts = [...new Set([cur, ...months])];
    modal({
      title: '🧾 申请发票',
      body: `
        <div class="u-form" style="font-size:12px;color:var(--text-3);margin:12px 0 4px;display:block">开票月份</div>
        <select class="input" id="fMonth">${opts.map(m => `<option value="${m}">${m}${billing.months.find(x => x.month === m) ? `（当月 ${fmt(billing.months.find(x => x.month === m).tokens)} tokens）` : ''}</option>`).join('')}</select>
        <div style="font-size:12px;color:var(--text-3);margin:12px 0 4px">发票抬头 *</div>
        <input class="input" id="fTitle" placeholder="如：中电信人工智能科技有限公司" maxlength="100">
        <div style="font-size:12px;color:var(--text-3);margin:12px 0 4px">税号（专票必填）</div>
        <input class="input" id="fTax" placeholder="纳税人识别号" maxlength="40">
        <div style="font-size:12px;color:var(--text-3);margin:12px 0 4px">接收邮箱</div>
        <input class="input" id="fEmail" placeholder="电子发票发送至该邮箱" maxlength="60">
        <div style="font-size:12px;color:var(--text-3);margin:12px 0 4px">备注（金额说明等）</div>
        <textarea class="input" id="fNote" rows="2" placeholder="如：含定制服务费用说明…" style="resize:vertical"></textarea>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>提交申请</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const body = {
            month: mask.querySelector('#fMonth').value,
            title: mask.querySelector('#fTitle').value.trim(),
            tax_no: mask.querySelector('#fTax').value.trim(),
            email: mask.querySelector('#fEmail').value.trim(),
            note: mask.querySelector('#fNote').value.trim(),
          };
          if (!body.title) return toast('请填写发票抬头', 'err');
          try {
            const j = await api('/biz/invoices', { method: 'POST', body });
            toast(j.msg || '已提交');
            close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderAll() {
    const p = billing.plan;
    el.querySelector('#overview').innerHTML = `
      <div class="stat"><div class="s-label">当前套餐</div><div class="s-num" style="font-size:20px;padding-top:6px">${esc(p.name)}</div><div class="s-unit">月费 ${p.monthlyFee == null ? '定制' : '¥' + p.monthlyFee}</div></div>
      <div class="stat"><div class="s-label">本月已用</div><div class="s-num">${fmt(billing.quota.used)}</div><div class="s-unit">tokens</div></div>
      <div class="stat"><div class="s-label">额度</div><div class="s-num" style="font-size:20px;padding-top:6px">${billing.quota.unlimited ? '不限' : fmt(billing.quota.total)}</div><div class="s-unit">tokens / 月</div></div>
      <div class="stat"><div class="s-label">发票记录</div><div class="s-num">${invoices.length}</div><div class="s-unit">其中待处理 ${invoices.filter(i => i.status === 'pending').length}</div></div>`;
    el.querySelector('#monthTb').innerHTML = billing.months.length ? billing.months.map(m => `
      <tr><td><b>${esc(m.month)}</b></td><td>${fmt(m.msgs)}</td><td><b>${fmt(m.tokens)}</b></td><td>${m.fee === '定制' ? '定制' : '¥' + m.fee}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">暂无用量记录</td></tr>';
    el.querySelector('#invTb').innerHTML = invoices.length ? invoices.map(i => `
      <tr>
        <td><b>${esc(i.month)}</b></td>
        <td style="font-size:12px">${esc(i.title)}</td>
        <td style="font-size:12px">${fmt(i.tokens)}</td>
        <td>${i.status === 'issued' ? '<span class="tag green">已开出</span>' : i.status === 'rejected' ? '<span class="tag red">未通过</span>' : '<span class="tag orange">处理中</span>'}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc((i.created_at || '').slice(0, 10))}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">还没有申请过发票</td></tr>';
  }

  async function load() {
    billing = (await api('/biz/billing')).data;
    invoices = (await api('/biz/invoices')).data;
    renderAll();
  }

  el.querySelector('#applyBtn').onclick = openApply;
  await load();
}
