/** 后台-组织架构管理（2026-11-12 P0-3b 界面补齐）：部门树的可视化增删改
 *  后端接口（P0 已交付）：GET /api/departments、GET /tree、POST/PUT/DELETE（adminOnly，含环校验/级联删除/有用户不可删）
 *  本页 = 树形展示（缩进层级）+ 新增一级/子部门 + 重命名/移动父级 + 删除（级联提示）
 *  用户管理页、智能体编排页「可见部门」均已消费此树（此前只能只读，管理入口缺失）
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let tree = [];

  el.innerHTML = `
  <style>
    .dep-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:13px}
    .dep-row:hover{background:#f6f8fa}
    .dep-line{color:#cbd5e1;margin-right:2px}
    .dep-name{font-weight:500}
    .dep-acts{margin-left:auto;display:none;gap:4px}
    .dep-row:hover .dep-acts{display:flex}
    .dep-child{border-left:1px dashed #e5e7eb}
  </style>
  <div class="page-head">
    <h2>${t('组织架构')}</h2>
    <div class="desc">${t('维护部门树——用户管理的「部门」下拉与智能体「可见部门」范围均基于此树。删除部门将级联删除其全部子部门；存在用户的部门不可删除。')}</div>
  </div>
  <div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;gap:10px;align-items:center">
    <button class="btn primary" id="addRoot">➕ ${t('新增一级部门')}</button>
    <span style="font-size:12px;color:var(--text-3)" id="countHint"></span>
  </div>
  <div class="card" style="padding:14px 18px;min-height:200px" id="treeBox"></div>`;

  const treeBox = el.querySelector('#treeBox');

  function countNodes(nodes) {
    return nodes.reduce((s, n) => s + 1 + countNodes(n.children || []), 0);
  }

  function renderTree(nodes, depth = 0) {
    if (!nodes.length && depth === 0) {
      treeBox.innerHTML = `<div style="text-align:center;padding:36px;color:var(--text-3)">
        <div style="font-size:34px;margin-bottom:8px">🏢</div>${t('尚无部门——点击「新增一级部门」创建组织树的根节点')}</div>`;
      return;
    }
    return nodes.map(n => `
      <div>
        <div class="dep-row" style="margin-left:${depth * 22}px">
          ${'<span class="dep-line">└</span>'.repeat(depth ? 1 : 0)}
          <span>🏢</span><span class="dep-name">${esc(n.name)}</span>
          <span style="font-size:11px;color:var(--text-3)">#${n.id}</span>
          <div class="dep-acts">
            <button class="btn sm" data-add="${n.id}">➕ ${t('子部门')}</button>
            <button class="btn sm" data-edit="${n.id}">✏️ ${t('编辑')}</button>
            <button class="btn sm danger" data-del="${n.id}">🗑️</button>
          </div>
        </div>
        <div class="dep-child" style="margin-left:${depth * 22 + 12}px">${renderTree(n.children || [], depth + 1) || ''}</div>
      </div>`).join('');
  }

  function render() {
    treeBox.innerHTML = renderTree(tree) || '';
    el.querySelector('#countHint').textContent = t('共 {n} 个部门').replace('{n}', countNodes(tree));
    treeBox.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openForm(null, +b.dataset.add));
    treeBox.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const node = findById(tree, +b.dataset.edit);
      if (node) openForm(node, node.parent_id);
    });
    treeBox.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const node = findById(tree, +b.dataset.del);
      if (!node) return;
      if (!await confirmBox(t('删除部门「{n}」？其全部子部门将一并删除，该操作不可恢复。').replace('{n}', node.name))) return;
      try {
        const j = await api(`/departments/${node.id}`, { method: 'DELETE' });
        if (j.code !== 0) return toast(j.msg || t('删除失败'), 'err');
        toast(j.msg || t('已删除')); load();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function findById(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findById(n.children || [], id);
      if (hit) return hit;
    }
    return null;
  }

  // 收集自身及全部子孙 id（移动父级下拉排除，防成环；后端亦有环校验兜底）
  function collectSubtreeIds(node) {
    const ids = new Set([node.id]);
    (node.children || []).forEach(c => collectSubtreeIds(c).forEach(x => ids.add(x)));
    return ids;
  }

  function flatOptions(nodes, depth = 0, excludeIds = new Set()) {
    const out = [];
    for (const n of nodes) {
      if (!excludeIds.has(n.id)) out.push({ id: n.id, name: '　'.repeat(depth) + (depth ? '└ ' : '') + n.name });
      out.push(...flatOptions(n.children || [], depth + 1, excludeIds));
    }
    return out;
  }

  function openForm(node, parentId) {
    const isEdit = !!node;
    const exclude = isEdit ? collectSubtreeIds(node) : new Set();
    const options = flatOptions(tree, 0, exclude);
    modal({
      title: isEdit ? `✏️ ${t('编辑部门')}（${esc(node.name)}）` : (parentId ? `➕ ${t('新增子部门')}` : `➕ ${t('新增一级部门')}`),
      body: `
        <div style="margin-bottom:12px"><label style="font-size:12px;color:var(--text-3)">${t('部门名称 *')}</label>
          <input id="dName" class="input" style="width:100%" value="${esc(node?.name || '')}" placeholder="${t('如：研发部 / 华东销售中心')}"></div>
        <div><label style="font-size:12px;color:var(--text-3)">${t('上级部门')}</label>
          <select id="dParent" class="input" style="width:100%">
            <option value="">${t('（无——作为一级部门）')}</option>
            ${options.map(o => `<option value="${o.id}" ${String(parentId || '') === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
          ${isEdit ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px">${t('自身及其子部门不会出现在上级列表中（防止形成环）')}</div>` : ''}
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${isEdit ? t('保存') : t('创建')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const name = mask.querySelector('#dName').value.trim();
          const parentRaw = mask.querySelector('#dParent').value;
          if (!name) return toast(t('部门名称不能为空'), 'err');
          const body = { name, parent_id: parentRaw ? +parentRaw : null };
          try {
            const j = isEdit
              ? await api(`/departments/${node.id}`, { method: 'PUT', body })
              : await api('/departments', { method: 'POST', body });
            if (j.code !== 0) return toast(j.msg || t('保存失败'), 'err');
            toast(j.msg || t('已保存'));
            close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    tree = (await api('/departments/tree')).data || [];
    render();
  }

  el.querySelector('#addRoot').onclick = () => openForm(null, null);
  await load();
}
