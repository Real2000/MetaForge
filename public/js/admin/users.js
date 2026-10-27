/** 后台-用户管理：平台账号全生命周期管理
 *  列表（角色/状态/弱口令标记/配额用量）· 新增 · 编辑（昵称/角色/部门/启停）· 重置密码 · 删除
 *  防锁死护栏与后端一致：不能停用/降级/删除自己；平台至少保留一名可用管理员。
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal } from '../ui.js';

export async function render(el) {
  let list = [];
  let kw = '';
  const me = getUser() || {};

  el.innerHTML = `
  <style>
    .u-avatar{width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0}
    .u-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}
    .u-form .input,.u-form select{width:100%;box-sizing:border-box}
  </style>
  <div class="page-head">
    <h2>用户管理</h2>
    <div class="desc">平台账号与角色管理——新增用户、调整管理员/普通用户身份、重置密码、启用停用；被停用账号立即无法登录，已有登录态同时失效。</div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <input class="input" id="kw" placeholder="🔍 搜索用户名 / 昵称 / 部门" style="width:240px">
    <button class="btn primary" id="addBtn">＋ 新增用户</button>
  </div>
  <div class="card">
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>用户</th><th>部门</th><th>状态</th><th>用量 / 配额</th><th>创建时间</th><th style="width:230px">操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
  </div>`;

  const tbody = el.querySelector('#tbody');

  function avatarColor(name) {
    const cs = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2'];
    let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 997;
    return cs[h % cs.length];
  }

  function openCreate() {
    modal({
      title: '＋ 新增用户',
      body: `
        <div class="u-form">
          <label>用户名（3~20 位字母/数字/下划线，登录账号）</label>
          <input class="input" id="fUsername" placeholder="如 zhangsan、ops_li" maxlength="20">
          <label>昵称（展示名，可后续修改）</label>
          <input class="input" id="fNickname" placeholder="如 张三" maxlength="30">
          <label>角色</label>
          <select id="fRole" class="input">
            <option value="user">普通用户（使用前台功能）</option>
            <option value="admin">管理员（可进入管理后台）</option>
          </select>
          <label>部门（可选）</label>
          <input class="input" id="fDept" placeholder="如 产品部" maxlength="30">
          <label>初始密码（至少 6 位，该用户首次登录时将被要求修改）</label>
          <input class="input" id="fPwd" type="password" autocomplete="new-password" placeholder="设置初始密码">
        </div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const body = {
            username: mask.querySelector('#fUsername').value.trim(),
            nickname: mask.querySelector('#fNickname').value.trim(),
            role: mask.querySelector('#fRole').value,
            dept: mask.querySelector('#fDept').value.trim(),
            password: mask.querySelector('#fPwd').value,
          };
          if (!body.username) return toast('用户名不能为空', 'err');
          if (!body.password) return toast('请设置初始密码', 'err');
          try {
            await api('/users', { method: 'POST', body });
            close(); toast('用户已创建，请将初始密码告知该用户');
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openEdit(u) {
    const isSelf = u.username === me.username;
    modal({
      title: `编辑用户：${u.nickname || u.username}${isSelf ? '（我）' : ''}`,
      body: `
        <div class="u-form">
          <label>用户名（不可修改）</label>
          <input class="input" value="${esc(u.username)}" disabled style="background:#f8faff">
          <label>昵称</label>
          <input class="input" id="fNickname" value="${esc(u.nickname || '')}" maxlength="30">
          <label>角色${isSelf ? '（自己的角色不可变更）' : ''}</label>
          <select id="fRole" class="input" ${isSelf ? 'disabled' : ''}>
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>普通用户（使用前台功能）</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员（可进入管理后台）</option>
          </select>
          <label>部门</label>
          <input class="input" id="fDept" value="${esc(u.dept || '')}" maxlength="30">
          <label>状态${isSelf ? '（自己的账号不可停用）' : ''}</label>
          <select id="fStatus" class="input" ${isSelf ? 'disabled' : ''}>
            <option value="1" ${u.status ? 'selected' : ''}>启用</option>
            <option value="0" ${!u.status ? 'selected' : ''}>停用（无法登录，已有登录态失效）</option>
          </select>
        </div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            await api(`/users/${u.id}`, {
              method: 'PUT',
              body: {
                nickname: mask.querySelector('#fNickname').value.trim(),
                role: mask.querySelector('#fRole').value,
                dept: mask.querySelector('#fDept').value.trim(),
                status: +mask.querySelector('#fStatus').value,
              },
            });
            close(); toast('已保存');
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openResetPwd(u) {
    modal({
      title: `🔑 重置密码 - ${u.nickname || u.username}`,
      body: `
        <div style="font-size:12px;color:var(--text-3);line-height:1.7;margin-bottom:4px">
          重置后该用户<b>下次登录将被要求修改密码</b>（初始密码只作过渡）。请通过安全渠道告知对方。
        </div>
        <div class="u-form"><label>新密码（至少 6 位，非常见默认口令）</label>
          <input class="input" id="fPwd" type="password" autocomplete="new-password" placeholder="输入新密码"></div>`,
      foot: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>重置</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const newPwd = mask.querySelector('#fPwd').value;
          if (!newPwd) return toast('请输入新密码', 'err');
          try {
            const j = await api(`/users/${u.id}/reset-password`, { method: 'PUT', body: { newPwd } });
            close(); toast(j.msg);
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function renderTable() {
    const shown = list.filter(u =>
      !kw || u.username.includes(kw) || (u.nickname || '').includes(kw) || (u.dept || '').includes(kw));
    if (!shown.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">没有匹配的用户</td></tr>`; return; }
    tbody.innerHTML = shown.map(u => {
      const isSelf = u.username === me.username;
      const unlimited = !u.quota_total;
      const pct = unlimited ? 0 : Math.min(100, Math.round((u.quota_used / u.quota_total) * 100));
      return `
      <tr style="${u.status ? '' : 'opacity:.55'}">
        <td>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="u-avatar" style="background:${avatarColor(u.username)}">${esc((u.nickname || u.username)[0] || 'U')}</span>
            <div>
              <b>${esc(u.nickname || u.username)}</b>
              ${isSelf ? '<span class="tag blue" style="font-size:10px">我</span>' : ''}
              ${u.role === 'admin' ? '<span class="tag purple" style="font-size:10px">管理员</span>' : '<span class="tag gray" style="font-size:10px">普通用户</span>'}
              ${u.must_change_pwd ? '<span class="tag orange" style="font-size:10px">待改密</span>' : ''}
              <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(u.username)}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-3)">${esc(u.dept || '-')}</td>
        <td>${u.status ? '<span class="tag green">启用</span>' : '<span class="tag red">已停用</span>'}</td>
        <td>
          <b>${(u.quota_used || 0).toLocaleString('zh-CN')}</b>
          <span style="color:var(--text-3)">/ ${unlimited ? '不限' : (u.quota_total || 0).toLocaleString('zh-CN')}</span>
          ${!unlimited ? `<div style="background:#f1f3f7;border-radius:6px;height:5px;width:70px;margin-top:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#2563eb'}"></div></div>` : ''}
        </td>
        <td style="color:var(--text-3);font-size:12px">${esc((u.created_at || '').slice(0, 10))}</td>
        <td>
          <button class="btn sm" data-edit="${u.id}">编辑</button>
          <button class="btn sm" data-pwd="${u.id}">🔑 重置密码</button>
          ${isSelf
            ? `<button class="btn sm" disabled title="不能停用自己的账号">停用</button><button class="btn sm" disabled title="不能删除自己的账号">删除</button>`
            : `<button class="btn sm" data-toggle="${u.id}">${u.status ? '停用' : '启用'}</button><button class="btn sm" style="color:#dc2626" data-del="${u.id}">删除</button>`}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEdit(shown.find(u => u.id === +b.dataset.edit)));
    tbody.querySelectorAll('[data-pwd]').forEach(b => b.onclick = () => openResetPwd(shown.find(u => u.id === +b.dataset.pwd)));
    tbody.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const u = shown.find(x => x.id === +b.dataset.toggle);
      const to = u.status ? 0 : 1;
      if (to === 0 && !confirm(`确定停用「${u.nickname || u.username}」？停用后其立即无法登录（已有登录态同时失效）。`)) return;
      try {
        await api(`/users/${u.id}`, { method: 'PUT', body: { status: to } });
        toast(to ? '已启用' : '已停用');
        load();
      } catch (e) { toast(e.message, 'err'); }
    });
    tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const u = shown.find(x => x.id === +b.dataset.del);
      if (!confirm(`确定删除用户「${u.username}」？\n\n其会话、收藏、长期记忆、自有模型源、技能资产将被一并清理；名下智能体回收给 admin（平台资产保留）。`)) return;
      try {
        const j = await api(`/users/${u.id}`, { method: 'DELETE' });
        toast(j.msg || '已删除');
        load();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function load() {
    list = (await api('/users')).data;
    renderTable();
  }

  el.querySelector('#addBtn').onclick = openCreate;
  el.querySelector('#kw').oninput = e => { kw = e.target.value.trim(); renderTable(); };

  await load();
}
