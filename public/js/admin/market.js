/**
 * U2-5 市场商业管理页（2026-11-16）
 *
 * 路由：/admin/market
 * 功能：
 *   - 商品列表（已上架智能体商品）
 *   - 创建/编辑商品（设置价格类型、价格、分成比例）
 *   - 月度收入对账报表
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export default async function render(root) {
  root.innerHTML = `
    <div style="padding:24px 32px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <h1 style="margin:0">💰 ${t('市场商业')}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn" id="revenueBtn">📊 ${t('月度对账')}</button>
          <button class="btn primary" id="addBtn">＋ ${t('上架商品')}</button>
        </div>
      </div>
      <div class="table-wrap"><table class="tbl" id="marketTable">
        <thead><tr>
          <th>${t('智能体')}</th><th>${t('价格类型')}</th><th>${t('单价（元）')}</th><th>${t('订阅周期')}</th><th>${t('作者分成')}</th><th>${t('状态')}</th><th>${t('操作')}</th>
        </tr></thead>
        <tbody id="marketBody"><tr><td class="empty" colspan="7">${t('加载中…')}</td></tr></tbody>
      </table></div>
    </div>`;

  const tbody = $('#marketBody');

  async function loadList() {
    tbody.innerHTML = `<tr><td class="empty" colspan="7">${t('加载中…')}</td></tr>`;
    try {
      const j = await api('/market/products');
      if (j.code !== 0) throw new Error(j.msg || '加载失败');
      const rows = j.data || [];
      if (!rows.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="7">${t('暂无商品，先通过「智能体管理」发布智能体后，再点击上架')}</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(p => `
        <tr id="mp${p.id}">
          <td><strong>${esc(p.agent_name || p.name)}</strong></td>
          <td>${p.price_type === 'free' ? t('免费') : p.price_type === 'one_time' ? t('一次性付费') : t('订阅')}</td>
          <td><b>¥${p.price || 0}</b></td>
          <td style="font-size:12px">${p.price_type === 'subscription' ? t('每月') : '—'}</td>
          <td>${+p.author_profit_share * 100}%</td>
          <td>${p.status === 'active' ? `<span class="tag green">${t('上架中')}</span>` : `<span class="tag gray">${t('已下架')}</span>`}</td>
          <td style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn sm" data-edit="${p.id}">${t('编辑')}</button>
            <button class="btn sm" style="color:#dc2626" data-del="${p.id}">${t('下架')}</button>
          </td>
        </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td class="empty" colspan="7">⚠️ ${esc(e.message)}</td></tr>`;
    }
  }

  root.addEventListener('click', async e => {
    const edit = e.target.dataset.edit;
    if (edit) {
      const p = (await api('/market/products/' + edit)).data;
      if (!p) return toast(t('商品不存在'), 'err');
      modal({
        title: `✏️ ${t('编辑商品')}`,
        body: `<div class="form-item"><label>${t('价格类型')}</label>
          <select class="input" id="mpPriceType" style="width:100%">
            <option value="free" ${p.price_type === 'free' ? 'selected' : ''}>${t('免费')}</option>
            <option value="one_time" ${p.price_type === 'one_time' ? 'selected' : ''}>${t('一次性付费')}</option>
            <option value="subscription" ${p.price_type === 'subscription' ? 'selected' : ''}>${t('订阅')}</option>
          </select></div>
          <div class="form-item"><label>${t('单价（元）')}</label><input class="input" id="mpPrice" type="number" min="0" step="0.01" value="${p.price}" style="width:100%"></div>
          <div class="form-item"><label>${t('作者分成比例（0~1）')}</label><input class="input" id="mpShare" type="number" min="0" max="1" step="0.01" value="${p.author_profit_share || 0.8}" style="width:100%"></div>
          <div class="form-item"><label>${t('状态')}</label>
            <select class="input" id="mpStatus" style="width:100%">
              <option value="active" ${p.status === 'active' ? 'selected' : ''}>${t('上架中')}</option>
              <option value="inactive" ${p.status === 'inactive' ? 'selected' : ''}>${t('已下架')}</option>
            </select></div>`,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('保存')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-go]').onclick = async () => {
            try {
              const body = {
                price_type: mask.querySelector('#mpPriceType').value,
                price: +mask.querySelector('#mpPrice').value,
                author_profit_share: +mask.querySelector('#mpShare').value,
                status: mask.querySelector('#mpStatus').value,
              };
              const j = await api(`/market/products/${edit}`, { method: 'PUT', body });
              if (j.code !== 0) return toast(j.msg || t('保存失败'), 'err');
              toast(t('已保存')); close(); loadList();
            } catch (ex) { toast(ex.message, 'err'); }
          };
        },
      });
      return;
    }
    const del = e.target.dataset.del;
    if (del) {
      if (!await confirmBox(t('下架该商品？已发布的智能体不再在市场中以付费形式展示。'))) return;
      try {
        const j = await api(`/market/products/${del}`, { method: 'DELETE' });
        if (j.code !== 0) return toast(j.msg || t('下架失败'), 'err');
        toast(t('已下架')); loadList();
      } catch (ex) { toast(ex.message, 'err'); }
      return;
    }
  });

  // 上架按钮 → 显示可选智能体列表
  document.getElementById('addBtn').onclick = async () => {
    const j = await api('/market/products');
    const existing = j.data || [];
    const existIds = new Set(existing.map(x => x.agent_id));
    const allAgents = (await api('/agents')).data || [];
    const canPublish = allAgents.filter(a => a.owner === (await getUser()).username || (await getUser()).role === 'admin');
    const unlisted = canPublish.filter(a => !existIds.has(a.id));
    if (!unlisted.length) {
      modal({ title: `🧩 ${t('上架商品')}`, body: `<div style="color:var(--text-2);line-height:1.9">${t('暂无可上架的新智能体（已有商品的智能体不会重复出现）')}</div>` });
      return;
    }
    modal({
      title: `🧩 ${t('选择要上架为商品的智能体')}`,
      body: `<div style="display:flex;flex-direction:column;gap:6px">${unlisted.map(a => `<button class="btn" data-aid="${a.id}" style="text-align:left;padding:10px 12px">🤖 ${esc(a.name)}</button>`).join('')}</div>`,
      onMount(mask, close) {
        mask.querySelectorAll('[data-aid]').forEach(btn => btn.onclick = async () => {
          const aid = +btn.dataset.aid;
          close();
          modal({
            title: `💰 ${t('上架商品设置')}`,
            body: `<div class="form-item"><label>${t('价格类型')}</label>
              <select class="input" id="aPriceType" style="width:100%">
                <option value="free">${t('免费')}</option>
                <option value="one_time">${t('一次性付费')}</option>
                <option value="subscription">${t('订阅（按月）')}</option>
              </select></div>
              <div class="form-item"><label>${t('单价（元）')}</label><input class="input" id="aPrice" type="number" min="0" step="0.01" value="9.99" style="width:100%"></div>
              <div class="form-item"><label>${t('作者分成比例（0~1）')}</label><input class="input" id="aShare" type="number" min="0" max="1" step="0.01" value="0.8" style="width:100%"></div>`,
            foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('上架')}</button>`,
            onMount(mask2, close2) {
              mask2.querySelector('[data-cancel]').onclick = close2;
              mask2.querySelector('[data-go]').onclick = async () => {
                try {
                  const r = await api('/market/products', { method: 'POST', body: {
                    agent_id: aid,
                    price_type: mask2.querySelector('#aPriceType').value,
                    price: +mask2.querySelector('#aPrice').value,
                    author_profit_share: +mask2.querySelector('#aShare').value,
                  }});
                  if (r.code !== 0) return toast(r.msg || t('上架失败'), 'err');
                  toast(t('上架成功')); close2(); loadList();
                } catch (ex) { toast(ex.message, 'err'); }
              };
            },
          });
        });
      },
    });
  };

  // 月度对账报表
  document.getElementById('revenueBtn').onclick = async () => {
    const month = new Date().toISOString().slice(0, 7);
    modal({
      title: `📊 ${t('月度收入对账报表')}`,
      body: `<div style="font-size:13px;line-height:1.8;color:var(--text-2)">
        <div style="display:flex;gap:8px;margin-bottom:12px"><input class="input" id="revMonth" type="month" value="${month}" style="flex:1"><button class="btn" id="revQuery">${t('查询')}</button></div>
        <div id="revResult">${t('选择月份后点击查询')}</div>
      </div>`,
      wide: true,
      onMount(mask, close) {
        mask.querySelector('#revQuery').onclick = async () => {
          const mon = mask.querySelector('#revMonth').value;
          if (!mon) return toast(t('请选择月份'), 'err');
          try {
            const j = await api(`/market/revenue?month=${mon}`);
            if (j.code !== 0) return toast(j.msg || '查询失败', 'err');
            const d = j.data;
            const rows = d.details || [];
            const tot = d.total || {};
            mask.querySelector('#revResult').innerHTML = rows.length
              ? `<div style="margin-top:4px">${t('月份')}：${d.month} · ${t('总收入')} ¥${tot.revenue.toFixed(2)} · ${t('平台收入')} ¥${tot.platformRevenue.toFixed(2)} · ${t('作者分成')} ¥${tot.authorShare.toFixed(2)}</div>
                <table class="tbl"><thead><tr><th>${t('商品')}</th><th>${t('智能体')}</th><th>${t('订单数')}</th><th>${t('收入')}</th><th>${t('作者分成')}</th><th>${t('平台收入')}</th></tr></thead><tbody>
                ${rows.map(r => `<tr><td>${esc(r.product_name)}</td><td>${esc(r.agent_name)}</td><td>${r.orders}</td><td>¥${r.revenue.toFixed(2)}</td><td>¥${r.author_share.toFixed(2)}</td><td>¥${r.platform_revenue.toFixed(2)}</td></tr>`).join('')}</tbody></table>`
              : `<div class="empty-box" style="padding:24px">${t('该月份无订单数据')}</div>`;
          } catch (ex) { toast(ex.message, 'err'); }
        };
      },
    });
  };

  await loadList();
}
