/** 后台-租户与平台运维（MT-10 租户开通闭环 / MT-09 跨租户运维台，2026-11-22）
 *  平台超管专属：租户列表（用户/资产统计）· 开通（建租户+派生管理员）· 停/启用 · 跨租户借用 · 审计。
 *  非平台超管进入 → 提示无权访问（后端 platformAdminOnly 亦会 403 兜底）。
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  const me = getUser() || {};
  if (!me.platform_admin) {
    el.innerHTML = `<div class="page-head"><h2>${t('租户与平台运维')}</h2></div>
      <div class="card" style="padding:24px;text-align:center;color:var(--text-3)">🔒 ${t('该功能仅平台超管可用。')}</div>`;
    return;
  }

  let tenants = [];
  let audit = [];

  el.innerHTML = `
  <div class="page-head">
    <h2>${t('租户与平台运维')}</h2>
    <div class="desc">${t('平台超管专属：租户开通（建租户 + 派生首个管理员）/ 停用启用 / 跨租户只读统计 / 带审计的账号借用。')}</div>
  </div>
  <div class="card" style="margin-bottom:14px;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <button class="btn primary" id="newBtn">＋ ${t('开通租户')}</button>
    <button class="btn" id="refreshBtn">${t('刷新')}</button>
    <span style="margin-left:auto;font-size:12px;color:var(--text-3)">${t('平台超管')}：${esc(me.username)}</span>
  </div>
  <div class="card" style="margin-bottom:14px">
    <h3 style="margin:0 0 10px">🏢 ${t('租户列表')}</h3>
    <div class="table-wrap"><table class="tbl"><thead><tr>
      <th>ID</th><th>${t('租户名称')}</th><th>${t('套餐')}</th><th>${t('状态')}</th><th>${t('管理员')}</th>
      <th>${t('用户')}</th><th>${t('智能体')}</th><th>${t('知识库')}</th><th>${t('会话')}</th><th>${t('操作')}</th>
    </tr></thead><tbody id="tb"></tbody></table></div>
  </div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">📝 ${t('跨租户审计（旁路 / 借用）')}</h3>
      <button class="btn sm" id="auditBtn" style="margin-left:auto">${t('刷新审计')}</button></div>
    <div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>${t('类型')}</th><th>${t('详情')}</th><th>${t('时间')}</th></tr></thead><tbody id="auditTb"></tbody></table></div>
  </div>`;

  function statusTag(s) {
    return s === 'disabled' ? `<span class="tag red">${t('已停用')}</span>` : `<span class="tag green">${t('启用中')}</span>`;
  }

  function renderTable() {
    el.querySelector('#tb').innerHTML = tenants.map(x => `
      <tr>
        <td>${x.id}</td>
        <td><b>${esc(x.name)}</b>${x.note ? `<br><span style="font-size:11px;color:var(--text-3)">${esc(x.note)}</span>` : ''}</td>
        <td>${esc(x.plan || '-')}</td>
        <td>${statusTag(x.status)}</td>
        <td>${esc(x.admin_username || '-')}</td>
        <td>${x.user_count || 0}</td>
        <td>${x.agents || 0}</td>
        <td>${x.kbs || 0}</td>
        <td>${x.sessions || 0}</td>
        <td>
          <button class="btn link" data-users="${x.id}">${t('成员')}</button>
          ${x.id === 1 ? '' : `<button class="btn link" data-toggle="${x.id}" data-st="${x.status}">${x.status === 'disabled' ? t('启用') : t('停用')}</button>`}
        </td>
      </tr>`).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--text-3)">${t('暂无租户')}</td></tr>`;

    el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleStatus(Number(b.dataset.toggle), b.dataset.st));
    el.querySelectorAll('[data-users]').forEach(b => b.onclick = () => openUsers(Number(b.dataset.users)));
  }

  function renderAudit() {
    el.querySelector('#auditTb').innerHTML = audit.map(a => `
      <tr><td><span class="tag">${esc(a.type)}</span></td><td style="font-size:12px">${esc(a.detail)}</td>
      <td style="font-size:12px;color:var(--text-3)">${esc(a.created_at)}</td></tr>`).join('')
      || `<tr><td colspan="3" style="text-align:center;color:var(--text-3)">${t('暂无记录')}</td></tr>`;
  }

  async function load() {
    try {
      tenants = (await api('/platform-admin/stats')).data || [];
      renderTable();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function loadAudit() {
    try { audit = (await api('/platform-admin/audit?limit=50')).data || []; renderAudit(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // 开通租户
  function openNew() {
    modal({
      title: t('开通租户'),
      body: `
        <div class="form-row"><label>${t('租户名称')} *</label><input class="input" id="tName" placeholder="${t('如：XX 科技有限公司')}"></div>
        <div class="form-row"><label>${t('套餐')}</label><input class="input" id="tPlan" value="free" placeholder="free / pro / enterprise"></div>
        <div class="form-row"><label>${t('首个管理员用户名')} *</label><input class="input" id="tAdmin" placeholder="${t('3~20 位字母/数字/下划线')}"></div>
        <div class="form-row"><label>${t('管理员初始密码')} *</label><input class="input" id="tPwd" type="password" placeholder="${t('至少 6 位，避开常见弱口令')}"></div>
        <div class="form-row"><label>${t('备注')}</label><input class="input" id="tNote" placeholder="${t('选填')}"></div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('开通')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = () => close();
        mask.querySelector('[data-ok]').onclick = async () => {
          const body = {
            name: mask.querySelector('#tName').value.trim(),
            plan: mask.querySelector('#tPlan').value.trim() || 'free',
            adminUsername: mask.querySelector('#tAdmin').value.trim(),
            adminPassword: mask.querySelector('#tPwd').value,
            note: mask.querySelector('#tNote').value.trim(),
          };
          try {
            const j = await api('/tenants', { method: 'POST', body });
            toast(j.msg || t('租户已开通'));
            close();
            await load(); await loadAudit();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  // 停用 / 启用
  async function toggleStatus(id, cur) {
    const to = cur === 'disabled' ? 'active' : 'disabled';
    if (to === 'disabled' && !(await confirmBox(t('停用该租户将踢出其全部在线会话，确认？')))) return;
    try {
      const j = await api(`/tenants/${id}/status`, { method: 'PUT', body: { status: to } });
      toast(j.msg || t('已更新'));
      await load(); await loadAudit();
    } catch (e) { toast(e.message, 'err'); }
  }

  // 租户成员（含借用入口）
  async function openUsers(id) {
    let rows = [];
    try { rows = (await api(`/platform-admin/tenants/${id}/users`)).data || []; }
    catch (e) { return toast(e.message, 'err'); }
    modal({
      title: `${t('租户成员')} #${id}`,
      body: `<div class="table-wrap"><table class="tbl"><thead><tr><th>${t('用户')}</th><th>${t('角色')}</th><th>${t('状态')}</th><th>${t('操作')}</th></tr></thead><tbody>
        ${rows.map(u => `<tr><td><b>${esc(u.nickname || u.username)}</b><br><span style="font-size:11px;color:var(--text-3)">${esc(u.username)}</span></td>
          <td>${u.role === 'admin' ? t('管理员') : t('普通用户')}</td>
          <td>${u.status === 0 ? t('停用') : t('正常')}</td>
          <td>${u.username === me.username ? '-' : `<button class="btn link" data-imp="${u.id}">${t('借用登录')}</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      <div style="font-size:11px;color:var(--text-3);margin-top:8px">${t('借用将签发 30 分钟的临时令牌，操作会记入审计。')}</div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = () => close();
        mask.querySelectorAll('[data-imp]').forEach(b => b.onclick = () => impersonate(Number(b.dataset.imp), close));
      },
    });
  }

  async function impersonate(uid, closeParent) {
    if (!(await confirmBox(t('确认借用该账号登录？将签发 30 分钟临时令牌并记录审计。')))) return;
    try {
      const j = await api('/platform-admin/impersonate', { method: 'POST', body: { user_id: uid, confirm: true } });
      const tk = j.data.token;
      await navigator.clipboard.writeText(tk).catch(() => {});
      closeParent();
      toast(t('借用令牌已签发并复制到剪贴板（30 分钟有效）'));
      await loadAudit();
    } catch (e) { toast(e.message, 'err'); }
  }

  el.querySelector('#newBtn').onclick = openNew;
  el.querySelector('#refreshBtn').onclick = () => { load(); loadAudit(); };
  el.querySelector('#auditBtn').onclick = loadAudit;

  await load();
  await loadAudit();
}
