/** 后台-用户管理：平台账号全生命周期管理
 *  列表（角色/状态/弱口令标记/配额用量）· 新增 · 编辑（昵称/角色/部门/启停）· 重置密码 · 删除
 *  防锁死护栏与后端一致：不能停用/降级/删除自己；平台至少保留一名可用管理员。
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let list = [];
  let kw = '';
  const me = getUser() || {};

  // V1.2 #2（F4 收尾）2026-10-30：部门数据源——进页面懒加载一次 GET /api/departments（平铺行 id/parent_id/name/path/order_num）
  // deptRows=null=加载中；Array=已缓存；deptFailed=true=加载失败降级回文本输入并提示
  let deptRows = null, deptFailed = false;
  const deptReady = api('/departments')
    .then(j => { deptRows = Array.isArray(j.data) ? j.data : []; })
    .catch(() => { deptFailed = true; });

  // 平铺行 → 名称路径（如「华东大区 / 上海分公司」）：沿 parent_id 向上拼 name；坏行兑底只显自身名
  function deptLabel(row) {
    const byId = new Map(deptRows.map(d => [d.id, d]));
    const names = [];
    let cur = row, guard = 0;
    while (cur && guard++ < 50) { names.unshift(cur.name); cur = cur.parent_id != null ? byId.get(cur.parent_id) : null; }
    return names.join(' / ');
  }
  // 下拉 option HTML：按层级深度缩进 + 全路径文本展示；selected 匹配指定 dept_id
  function deptOptions(selId, extraFirst) {
    const byId = new Map(deptRows.map(d => [d.id, d]));
    const depth = d => { let n = 0, cur = d, guard = 0; while (cur?.parent_id != null && byId.has(cur.parent_id) && guard++ < 50) { n++; cur = byId.get(cur.parent_id); } return n; };
    const opts = deptRows.map(d =>
      `<option value="${d.id}" ${selId === d.id ? 'selected' : ''}>${'　'.repeat(depth(d))}${esc(deptLabel(d))}</option>`).join('');
    return `<option value="" ${selId ? '' : 'selected'}>${extraFirst || t('未分配')}</option>` + opts;
  }
  // 部门字段 HTML：正常=下拉（未分配空值 + 平铺列表按 path 缩进）；失败降级=文本输入 + 提示
  // legacyText：编辑弹窗无同名部门时的原文本（hint 提示）
  function deptFieldHtml(selId, legacyText) {
    if (deptFailed) {
      return `<label>${t('部门（可选）')}</label>
        <input class="input" id="fDept" placeholder="${t('如 产品部')}" maxlength="30" value="${esc(legacyText || '')}">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">⚠️ ${t('部门列表加载失败，已降级为文本输入，请稍后重试或联系管理员')}</div>`;
    }
    return `<label>${t('部门（可选，从组织架构选择）')}</label>
      <select id="fDept" class="input">
        ${deptOptions(selId)}
      </select>
      ${legacyText ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px">${t('原部门文本：')}${esc(legacyText)}${t('，组织架构中无同名部门')}</div>` : ''}`;
  }
  // 读表单值：下拉 → {dept:部门名文本, dept_id:数字|null}；降级文本 → {dept:文本}（不携带 dept_id 键——
  // V1.2 审查加固 2026-10-30：若显式传 null，后端「未传保留」的防御会被降级路径绕过，
  // 用户仅改昵称保存时会静默清空原有 dept_id 绑定；JSON.stringify 自动剔除 undefined 键）
  function readDept(mask) {
    const f = mask.querySelector('#fDept');
    if (!f) return { dept: '' };
    if (f.tagName === 'SELECT') {
      const id = +f.value || null;
      const row = id ? deptRows.find(d => d.id === id) : null;
      return { dept: row ? row.name : '', dept_id: id };
    }
    return { dept: f.value.trim() }; // 降级文本：不携带 dept_id（保留后端原值）
  }
  // 编辑弹窗初值：优先现有 dept_id（且部门仍存在）；有 dept 文本 → 同名匹配（含 dept_id 悬空场景，
  // V1.2 审查加固：悬空 dept_id+有文本时也走同名匹配/legacy 提示，否则保存会双清且无感知）；均无 → 未分配
  function resolveDeptSel(u) {
    if (u.dept_id != null && deptRows.some(d => d.id === u.dept_id)) return { selId: u.dept_id, legacy: '' };
    if (u.dept) {
      const hit = deptRows.find(d => d.name === u.dept);
      if (hit) return { selId: hit.id, legacy: '' };
      return { selId: null, legacy: u.dept };
    }
    return { selId: null, legacy: '' };
  }

  el.innerHTML = `
  <style>
    .u-avatar{width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0}
    .u-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}
    .u-form .input,.u-form select{width:100%;box-sizing:border-box}
  </style>
  <div class="page-head">
    <h2>${t('用户管理')}</h2>
    <div class="desc">${t('平台账号与角色管理——新增用户、调整管理员/普通用户身份、重置密码、启用停用；被停用账号立即无法登录，已有登录态同时失效。')}</div>
  </div>
  <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <input class="input" id="kw" placeholder="${t('🔍 搜索用户名 / 昵称 / 部门')}" style="width:240px">
    <button class="btn primary" id="addBtn">${t('＋ 新增用户')}</button>
  </div>
  <div class="card">
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>${t('用户')}</th><th>${t('部门')}</th><th>${t('状态')}</th><th>${t('用量 / 配额')}</th><th>${t('创建时间')}</th><th style="width:230px">${t('操作')}</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table></div>
  </div>`;

  const tbody = el.querySelector('#tbody');

  function avatarColor(name) {
    const cs = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2'];
    let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 997;
    return cs[h % cs.length];
  }

  async function openCreate() {
    await deptReady; // V1.2 #2：确保部门列表就绪（或已标记失败）后再渲染下拉
    modal({
      title: `＋ ${t('新增用户')}`,
      body: `
        <div class="u-form">
          <label>${t('用户名（3~20 位字母/数字/下划线，登录账号）')}</label>
          <input class="input" id="fUsername" placeholder="${t('如 zhangsan、ops_li')}" maxlength="20">
          <label>${t('昵称（展示名，可后续修改）')}</label>
          <input class="input" id="fNickname" placeholder="${t('如 张三')}" maxlength="30">
          <label>${t('角色')}</label>
          <select id="fRole" class="input">
            <option value="user">${t('普通用户（使用前台功能）')}</option>
            <option value="admin">${t('管理员（可进入管理后台）')}</option>
          </select>
          ${deptFieldHtml(null)}
          <label>${t('初始密码（至少 6 位，该用户首次登录时将被要求修改）')}</label>
          <input class="input" id="fPwd" type="password" autocomplete="new-password" placeholder="${t('设置初始密码')}">
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('创建')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const deptVal = readDept(mask); // V1.2 #2：dept=部门名文本（兼容存量语义）+ dept_id=数字
          const body = {
            username: mask.querySelector('#fUsername').value.trim(),
            nickname: mask.querySelector('#fNickname').value.trim(),
            role: mask.querySelector('#fRole').value,
            dept: deptVal.dept,
            dept_id: deptVal.dept_id,
            password: mask.querySelector('#fPwd').value,
          };
          if (!body.username) return toast(t('用户名不能为空'), 'err');
          if (!body.password) return toast(t('请设置初始密码'), 'err');
          try {
            await api('/users', { method: 'POST', body });
            close(); toast(t('用户已创建，请将初始密码告知该用户'));
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function openEdit(u) {
    await deptReady; // V1.2 #2：确保部门列表就绪（或已标记失败）后再渲染下拉
    const isSelf = u.username === me.username;
    const { selId, legacy } = resolveDeptSel(u); // V1.2 #2：dept_id 优先，无则同名匹配，均无 → 未分配 + 原文本 hint
    modal({
      title: `${t('编辑用户：')}${u.nickname || u.username}${isSelf ? t('（我）') : ''}`,
      body: `
        <div class="u-form">
          <label>${t('用户名（不可修改）')}</label>
          <input class="input" value="${esc(u.username)}" disabled style="background:#f8faff">
          <label>${t('昵称')}</label>
          <input class="input" id="fNickname" value="${esc(u.nickname || '')}" maxlength="30">
          <label>${t('角色')}${isSelf ? t('（自己的角色不可变更）') : ''}</label>
          <select id="fRole" class="input" ${isSelf ? 'disabled' : ''}>
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>${t('普通用户（使用前台功能）')}</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${t('管理员（可进入管理后台）')}</option>
          </select>
          ${deptFieldHtml(selId, legacy)}
          <label>${t('状态')}${isSelf ? t('（自己的账号不可停用）') : ''}</label>
          <select id="fStatus" class="input" ${isSelf ? 'disabled' : ''}>
            <option value="1" ${u.status ? 'selected' : ''}>${t('启用')}</option>
            <option value="0" ${!u.status ? 'selected' : ''}>${t('停用（无法登录，已有登录态失效）')}</option>
          </select>
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const deptVal = readDept(mask); // V1.2 #2：dept=部门名文本 + dept_id=数字（未分配 → null）
          try {
            await api(`/users/${u.id}`, {
              method: 'PUT',
              body: {
                nickname: mask.querySelector('#fNickname').value.trim(),
                role: mask.querySelector('#fRole').value,
                dept: deptVal.dept,
                dept_id: deptVal.dept_id,
                status: +mask.querySelector('#fStatus').value,
              },
            });
            close(); toast(t('已保存'));
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openResetPwd(u) {
    modal({
      title: `🔑 ${t('重置密码')} - ${u.nickname || u.username}`,
      body: `
        <div style="font-size:12px;color:var(--text-3);line-height:1.7;margin-bottom:4px">
          ${t('重置后该用户')}<b>${t('下次登录将被要求修改密码')}</b>（${t('初始密码只作过渡）'}。${t('请通过安全渠道告知对方。')}）
        </div>
        <div class="u-form"><label>${t('新密码（至少 6 位，非常见默认口令）')}</label>
          <input class="input" id="fPwd" type="password" autocomplete="new-password" placeholder="${t('输入新密码')}"></div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('重置')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const newPwd = mask.querySelector('#fPwd').value;
          if (!newPwd) return toast(t('请输入新密码'), 'err');
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
    if (!shown.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">${t('没有匹配的用户')}</td></tr>`; return; }
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
              ${isSelf ? `<span class="tag blue" style="font-size:10px">${t('我')}</span>` : ''}
              ${u.role === 'admin' ? `<span class="tag purple" style="font-size:10px">${t('管理员')}</span>` : `<span class="tag gray" style="font-size:10px">${t('普通用户')}</span>`}
              ${u.must_change_pwd ? `<span class="tag orange" style="font-size:10px">${t('待改密')}</span>` : ''}
              <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(u.username)}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-3)">${esc(u.dept || '-')}</td>
        <td>${u.status ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag red">${t('已停用')}</span>`}</td>
        <td>
          <b>${(u.quota_used || 0).toLocaleString('zh-CN')}</b>
          <span style="color:var(--text-3)">/ ${unlimited ? t('不限') : (u.quota_total || 0).toLocaleString('zh-CN')}</span>
          ${!unlimited ? `<div style="background:#f1f3f7;border-radius:6px;height:5px;width:70px;margin-top:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#2563eb'}"></div></div>` : ''}
        </td>
        <td style="color:var(--text-3);font-size:12px">${esc((u.created_at || '').slice(0, 10))}</td>
        <td>
          <button class="btn sm" data-edit="${u.id}">${t('编辑')}</button>
          <button class="btn sm" data-pwd="${u.id}">🔑 ${t('重置密码')}</button>
          ${isSelf
            ? `<button class="btn sm" disabled title="${t('不能停用自己的账号')}">${t('停用')}</button><button class="btn sm" disabled title="${t('不能删除自己的账号')}">${t('删除')}</button>`
            : `<button class="btn sm" data-toggle="${u.id}">${u.status ? t('停用') : t('启用')}</button><button class="btn sm" style="color:#dc2626" data-del="${u.id}">${t('删除')}</button>`}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEdit(shown.find(u => u.id === +b.dataset.edit)));
    tbody.querySelectorAll('[data-pwd]').forEach(b => b.onclick = () => openResetPwd(shown.find(u => u.id === +b.dataset.pwd)));
    tbody.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const u = shown.find(x => x.id === +b.dataset.toggle);
      const to = u.status ? 0 : 1;
      if (to === 0 && !(await confirmBox(t('确定停用「{name}」？停用后其立即无法登录（已有登录态同时失效）。').replace('{name}', u.nickname || u.username)))) return;
      try {
        await api(`/users/${u.id}`, { method: 'PUT', body: { status: to } });
        toast(to ? t('已启用') : t('已停用'));
        load();
      } catch (e) { toast(e.message, 'err'); }
    });
    tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const u = shown.find(x => x.id === +b.dataset.del);
      if (!(await confirmBox(t('确定删除用户「{name}」？\n\n其会话、收藏、长期记忆、自有模型源、技能资产将被一并清理；名下智能体回收给 admin（平台资产保留）。').replace('{name}', u.username)))) return;
      try {
        const j = await api(`/users/${u.id}`, { method: 'DELETE' });
        toast(j.msg || t('已删除'));
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
