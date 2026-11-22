/** 后台-租户账单与订阅（MT-11 租户级配额/账单聚合 + MT-13 支付·订阅闭环，2026-11-22）
 *  Tab1 租户账单：本月成本按租户聚合 + CSV 导出（Excel 直开）
 *  Tab2 订单与订阅：下单（订阅/充值）/ 订单列表 / 标记已支付 / 退款 / 沙箱回调签名 / 本租户商业状态
 *  Tab3 支付对账：已支付订单应付 = 生效快照金额（diff=0），平台超管专属
 *  作用域：平台超管可跨租户（下拉选择）；租户管理员仅本租户（后端 scopeTenant fail-closed 兜底）。
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const ORDER_ST = {
  pending: () => `<span class="tag">⏳ ${t('待支付')}</span>`,
  paid: () => `<span class="tag green">✅ ${t('已支付')}</span>`,
  refunded: () => `<span class="tag red">↩️ ${t('已退款')}</span>`,
};
const fmt = (n) => (Number(n) || 0).toLocaleString('zh-CN');
const money = (n) => '¥' + (Number(n) || 0).toFixed(2);

export async function render(el) {
  const me = getUser() || {};
  const IS_SUPER = !!me.platform_admin;
  let plans = [];
  let tenants = [];
  let bill = null;      // /billing/tenants 聚合
  let detail = null;    // /billing/tenant 明细
  let orders = [];      // /payment/orders
  let status = null;    // /payment/status
  let rec = null;       // /payment/reconcile
  let tab = 'bill';
  let scopeTid = '';    // '' = 全部/默认

  const now = new Date();
  let month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  el.innerHTML = `
  <div class="page-head">
    <h2>${t('租户账单与订阅')}</h2>
    <div class="desc">${t('租户级配额与成本账单（可导出 CSV）+ 支付/订阅闭环：下单 → 回调验签 → 配额/钱包生效 → 退款 → 对账。')}</div>
  </div>
  <div class="card" style="margin-bottom:14px;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <div class="biz-tabs" style="margin:0">
      <div class="pay-tab on" data-t="bill">📊 ${t('租户账单')}</div>
      <div class="pay-tab" data-t="orders">🧾 ${t('订单与订阅')}</div>
      ${IS_SUPER ? `<div class="pay-tab" data-t="rec">🧮 ${t('支付对账')}</div>` : ''}
    </div>
    <input class="input" id="month" type="month" style="width:150px;margin-left:auto" value="${month}">
    ${IS_SUPER ? `<select class="input" id="scope" style="width:180px"><option value="">${t('全部租户')}</option></select>` : ''}
    <button class="btn" id="refreshBtn">${t('刷新')}</button>
  </div>
  <div id="tabBill"></div>
  <div id="tabOrders" style="display:none"></div>
  <div id="tabRec" style="display:none"></div>
  <style>
    .biz-tabs{display:flex;gap:6px}
    .pay-tab{padding:9px 18px;border-radius:10px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:13px;color:var(--text-2)}
    .pay-tab.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
  </style>`;

  if (IS_SUPER) {
    el.querySelector('#scope').onchange = (e) => { scopeTid = e.target.value; loadAll(); };
  }
  el.querySelector('#month').onchange = (e) => { month = e.target.value; loadAll(); };
  el.querySelectorAll('.pay-tab').forEach(tb => tb.onclick = async () => {
    tab = tb.dataset.t;
    el.querySelectorAll('.pay-tab').forEach(x => x.classList.toggle('on', x.dataset.t === tab));
    el.querySelector('#tabBill').style.display = tab === 'bill' ? '' : 'none';
    el.querySelector('#tabOrders').style.display = tab === 'orders' ? '' : 'none';
    if (el.querySelector('#tabRec')) el.querySelector('#tabRec').style.display = tab === 'rec' ? '' : 'none';
    if (tab === 'rec') await loadAll(); // 惰性拉取对账（首次进入该 Tab 才请求）
  });
  el.querySelector('#refreshBtn').onclick = loadAll;

  const q = () => (scopeTid ? `tenant_id=${scopeTid}&` : '');

  // ---------- Tab1 租户账单 ----------
  function renderBill() {
    const tenantsRows = (bill && bill.tenants) || [];
    const users = (detail && detail.users) || [];
    el.querySelector('#tabBill').innerHTML = `
      <div class="grid-4" style="margin-bottom:14px">
        <div class="stat"><div class="s-label">${t('本月成本合计')}</div><div class="s-num">${money(bill && bill.totalCost)}</div></div>
        <div class="stat"><div class="s-label">${t('计费租户数')}</div><div class="s-num">${tenantsRows.length}</div></div>
        <div class="stat"><div class="s-label">${t('本月活跃用户')}</div><div class="s-num">${users.length}</div></div>
        <div class="stat"><div class="s-label">${t('累计成本')}</div><div class="s-num">${money(detail && detail.lifetimeTotal)}</div></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">🏢 ${t('租户维度成本聚合')}（${esc(month)}）</h3>
          <button class="btn sm" id="csvBtn" style="margin-left:auto">⬇️ ${t('导出 CSV')}</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
          <th>${t('租户')}</th><th>${t('成员')}</th><th>Tokens</th><th>${t('成本')}</th>
        </tr></thead><tbody id="billTb"></tbody></table></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 10px">👤 ${t('用户明细（tenant_id → username 两级）')}</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr>
          <th>${t('用户')}</th><th>${t('调用次数')}</th><th>${t('输入/输出 tokens')}</th><th>${t('成本')}</th>
        </tr></thead><tbody id="detailTb"></tbody></table></div>
      </div>`;
    el.querySelector('#billTb').innerHTML = tenantsRows.map(x => `
      <tr><td><b>${esc(x.tenant_name)}</b> <span style="font-size:11px;color:var(--text-3)">#${x.tenant_id}</span></td>
        <td>${x.members}</td><td>${fmt(x.tokens)}</td><td><b>${money(x.cost)}</b></td></tr>`).join('')
      || `<tr><td colspan="4" class="empty">${t('该月暂无计费记录')}</td></tr>`;
    el.querySelector('#detailTb').innerHTML = users.map(u => `
      <tr><td class="mono">${esc(u.username)}</td><td>${fmt(u.calls)}</td>
        <td>${fmt(u.prompt_tokens)} / ${fmt(u.completion_tokens)}</td><td><b>${money(u.cost)}</b></td></tr>`).join('')
      || `<tr><td colspan="4" class="empty">${t('该月暂无计费记录')}</td></tr>`;
    el.querySelector('#csvBtn').onclick = exportCsv;
  }

  async function exportCsv() {
    try {
      const res = await fetch(`/api/billing/tenant/export?${q()}month=${month}`, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tenant-billing-${month}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast(t('账单已导出'));
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- Tab2 订单与订阅 ----------
  function renderOrders() {
    const sub = status && status.subscription;
    const wal = status && status.wallet;
    const st = status && status.tenant;
    el.querySelector('#tabOrders').innerHTML = `
      <div class="grid-4" style="margin-bottom:14px">
        <div class="stat"><div class="s-label">${t('当前套餐')}</div><div class="s-num" style="font-size:18px">${esc((st && st.plan) || (sub && sub.plan_key) || 'free')}</div></div>
        <div class="stat"><div class="s-label">${t('订阅状态')}</div><div class="s-num" style="font-size:18px">${esc((sub && sub.status) || t('未订阅'))}</div></div>
        <div class="stat"><div class="s-label">${t('钱包余额')}</div><div class="s-num">${money(wal && wal.balance)}</div></div>
        <div class="stat"><div class="s-label">${t('周期')}</div><div class="s-num" style="font-size:13px">${sub ? esc((sub.period_start || '') + ' ~ ' + (sub.period_end || '')) : '-'}</div></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">🧾 ${t('支付订单')}</h3>
          <button class="btn primary sm" id="newOrderBtn" style="margin-left:auto">＋ ${t('新建订单')}</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
          <th>${t('订单号')}</th><th>${t('租户')}</th><th>${t('类型')}</th><th>${t('金额')}</th><th>${t('渠道')}</th><th>${t('状态')}</th><th>${t('创建时间')}</th>${IS_SUPER ? `<th>${t('操作')}</th>` : ''}
        </tr></thead><tbody id="orderTb"></tbody></table></div>
      </div>`;
    el.querySelector('#orderTb').innerHTML = orders.map(o => `
      <tr>
        <td class="mono" style="font-size:11px">${esc(o.order_no)}</td>
        <td>#${o.tenant_id}</td>
        <td>${o.type === 'subscribe' ? `📦 ${t('订阅')} ${esc(o.plan_key || '')}` : `💰 ${t('充值')}`}</td>
        <td><b>${money(o.amount)}</b></td>
        <td>${esc(o.channel || '-')}</td>
        <td>${(ORDER_ST[o.status] || (() => esc(o.status)))()}</td>
        <td style="font-size:12px;color:var(--text-3)">${esc(o.created_at || '')}</td>
        ${IS_SUPER ? `<td>
          ${o.status === 'pending' ? `<button class="btn link" data-paid="${esc(o.order_no)}">${t('标记已支付')}</button>` : ''}
          ${o.status === 'paid' ? `<button class="btn link" data-refund="${esc(o.order_no)}">${t('退款')}</button>` : ''}
          ${o.status === 'pending' ? `<button class="btn link" data-sign="${esc(o.order_no)}">${t('生成回调签名')}</button>` : ''}
        </td>` : ''}
      </tr>`).join('') || `<tr><td colspan="${IS_SUPER ? 8 : 7}" class="empty">${t('暂无订单')}</td></tr>`;
    el.querySelector('#newOrderBtn').onclick = openNewOrder;
    el.querySelectorAll('[data-paid]').forEach(b => b.onclick = () => markPaid(b.dataset.paid));
    el.querySelectorAll('[data-refund]').forEach(b => b.onclick = () => refundOrder(b.dataset.refund));
    el.querySelectorAll('[data-sign]').forEach(b => b.onclick = () => signOrder(b.dataset.sign));
  }

  function openNewOrder() {
    const planOpts = plans.filter(p => p.price != null).map(p => `<option value="${esc(p.key)}">${esc(p.name)}（¥${p.price}/${esc(p.period || '')}）</option>`).join('');
    modal({
      title: t('新建订单'),
      body: `
        <div class="form-item"><label>${t('订单类型')}</label>
          <select class="input" id="oType"><option value="subscribe">${t('订阅套餐')}</option><option value="recharge">${t('钱包充值')}</option></select></div>
        <div class="form-item" id="planRow"><label>${t('套餐')}</label><select class="input" id="oPlan">${planOpts || `<option value="">${t('无可用在线套餐')}</option>`}</select></div>
        <div class="form-item" id="amtRow" style="display:none"><label>${t('充值金额（元）')}</label><input class="input" id="oAmt" type="number" min="1" step="1" value="100"></div>
        <div class="form-item"><label>${t('支付渠道')}</label>
          <select class="input" id="oChannel"><option value="sandbox">${t('沙箱（联调）')}</option><option value="wechat">${t('微信支付')}</option><option value="alipay">${t('支付宝')}</option></select></div>
        ${IS_SUPER ? `<div class="form-item"><label>${t('归属租户 ID')}</label><input class="input" id="oTid" type="number" min="1" value="${scopeTid || 1}"></div>` : ''}`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('创建')}</button>`,
      onMount(mask, close) {
        const ty = () => mask.querySelector('#oType').value;
        mask.querySelector('#oType').onchange = () => {
          mask.querySelector('#planRow').style.display = ty() === 'subscribe' ? '' : 'none';
          mask.querySelector('#amtRow').style.display = ty() === 'recharge' ? '' : 'none';
        };
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-ok]').onclick = async () => {
          const body = { type: ty(), channel: mask.querySelector('#oChannel').value };
          if (ty() === 'subscribe') body.plan_key = mask.querySelector('#oPlan').value;
          else body.amount = +mask.querySelector('#oAmt').value || 0;
          if (IS_SUPER) { const v = +mask.querySelector('#oTid').value; if (v > 0) body.tenant_id = v; }
          try {
            const j = await api('/payment/orders', { method: 'POST', body });
            toast(t('订单已创建') + `：${j.data.order_no}`);
            close(); await loadAll();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function markPaid(no) {
    if (!(await confirmBox(t('标记该订单为已支付并立即生效（下发配额/记钱包）？')))) return;
    try { const j = await api(`/payment/orders/${no}/mark-paid`, { method: 'POST', body: {} }); toast(j.msg || t('已生效')); await loadAll(); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function refundOrder(no) {
    if (!(await confirmBox(t('确认退款该订单？充值时将从钱包扣回（不产生负余额）。')))) return;
    try { const j = await api(`/payment/orders/${no}/refund`, { method: 'POST', body: {} }); toast(j.msg || t('已退款')); await loadAll(); }
    catch (e) { toast(e.message, 'err'); }
  }
  // 生成沙箱回调签名并直接投递到 /api/payment/callback/sandbox，验证「验签 → 幂等 → 生效」链路
  async function signOrder(no) {
    try {
      const s = (await api(`/payment/orders/${no}/sign`, { method: 'POST', body: {} })).data;
      const res = await fetch('/api/payment/callback/sandbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pay-Sign': s.sign }, body: s.raw,
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.code === 0) toast(t('回调已投递并生效'));
      else toast(j.msg || t('回调投递失败'), 'err');
      await loadAll();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- Tab3 支付对账 ----------
  function renderRec() {
    if (!el.querySelector('#tabRec')) return;
    const items = (rec && rec.items) || [];
    el.querySelector('#tabRec').innerHTML = `
      <div class="grid-4" style="margin-bottom:14px">
        <div class="stat"><div class="s-label">${t('应付合计')}</div><div class="s-num">${money(rec && rec.expect_amount)}</div></div>
        <div class="stat"><div class="s-label">${t('生效合计')}</div><div class="s-num">${money(rec && rec.actual_amount)}</div></div>
        <div class="stat"><div class="s-label">${t('对账结果')}</div><div class="s-num" style="font-size:18px;color:${!rec ? 'var(--text-3)' : rec.balanced ? '#059669' : '#ef4444'}">${!rec ? t('加载中…') : rec.balanced ? t('账实一致 ✓') : t('存在差异 ✗')}</div></div>
        <div class="stat"><div class="s-label">${t('已支付订单数')}</div><div class="s-num">${rec ? rec.orders : 0}</div></div>
      </div>
      <div class="card"><h3 style="margin:0 0 10px">🧮 ${t('已支付订单生效核验')}（${esc(month)}）</h3>
      <div class="table-wrap"><table class="tbl"><thead><tr>
        <th>${t('订单号')}</th><th>${t('租户')}</th><th>${t('类型')}</th><th>${t('应付')}</th><th>${t('生效')}</th><th>${t('核验')}</th>
      </tr></thead><tbody>${items.map(it => `
        <tr><td class="mono" style="font-size:11px">${esc(it.order_no)}</td><td>#${it.tenant_id}</td>
          <td>${it.type === 'subscribe' ? t('订阅') : t('充值')}</td>
          <td>${money(it.amount)}</td><td>${money(it.effective)}</td>
          <td>${it.balanced ? `<span class="tag green">0</span>` : `<span class="tag red">${t('未生效')}</span>`}</td></tr>`).join('')
        || `<tr><td colspan="6" class="empty">${t('该月暂无已支付订单')}</td></tr>`}</tbody></table></div></div>`;
  }

  // ---------- 加载 ----------
  async function loadAll() {
    try {
      const [b, d, o, s] = await Promise.all([
        api(`/billing/tenants?${q()}month=${month}`),
        api(`/billing/tenant?${q()}month=${month}`),
        api(`/payment/orders?${q()}`),
        api(`/payment/status${scopeTid ? `?tenant_id=${scopeTid}` : ''}`),
      ]);
      bill = b.data; detail = d.data; orders = o.data || []; status = s.data;
      if (IS_SUPER && tab === 'rec') rec = (await api(`/payment/reconcile?month=${month}`)).data;
      renderBill(); renderOrders(); renderRec();
    } catch (e) { toast(e.message, 'err'); }
  }

  // 平台超管：加载租户下拉 + 套餐
  if (IS_SUPER) {
    try {
      tenants = (await api('/platform-admin/stats')).data || [];
      const sel = el.querySelector('#scope');
      tenants.forEach(x => { const op = document.createElement('option'); op.value = x.id; op.textContent = `${x.name} (#${x.id})`; sel.appendChild(op); });
    } catch { /* 忽略 */ }
  }
  try { plans = (await api('/biz/plans')).data || []; } catch { plans = []; }

  await loadAll();
}
