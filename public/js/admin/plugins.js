/**
 * U2-3 插件管理页（2026-11-16）
 *
 * 路由：/admin/plugins
 * 功能：
 *   - 已安装插件列表（启用/停用/卸载/沙箱试运行）
 *   - 插件安装（通过市场 hub 同步或直接指定 plugin_id）
 *   - 远程市场同步
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export default async function render(root) {
  root.innerHTML = `
    <div style="padding:24px 32px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h1 style="margin:0">🧩 ${t('插件管理')}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn" id="syncBtn">🔄 ${t('同步市场')}</button>
          <button class="btn" id="installBtn">＋ ${t('安装插件')}</button>
        </div>
      </div>
      <div class="table-wrap"><table class="tbl" id="pluginTable">
        <thead><tr>
          <th>${t('名称')}</th><th>${t('ID')}</th><th>${t('版本')}</th><th>${t('入口')}</th><th>${t('权限')}</th><th>${t('状态')}</th><th>${t('操作')}</th>
        </tr></thead>
        <tbody id="pluginBody"><tr><td class="empty" colspan="7">${t('加载中…')}</td></tr></tbody>
      </table></div>
    </div>`;
  
  const tbody = document.getElementById('pluginBody');
  
  async function loadList() {
    tbody.innerHTML = `<tr><td class="empty" colspan="7">${t('加载中…')}</td></tr>`;
    try {
      const j = await api('/plugins');
      if (j.code !== 0) throw new Error(j.msg || '加载失败');
      const rows = j.data || [];
      if (!rows.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="7">${t('暂无插件，点击右上角「安装插件」或「同步市场」')}</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(p => `
        <tr id="pr${p.id}">
          <td><strong>${esc(p.name || p.plugin_id)}</strong></td>
          <td class="mono" style="font-size:12px">${esc(p.plugin_id)}</td>
          <td class="mono">${esc(p.version || '-')}</td>
          <td class="mono" style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(p.entry || '-')}</td>
          <td style="font-size:12px;color:var(--text-3)">
            ${(() => {
              let perms;
              try { perms = JSON.parse(p.permissions || '[]'); } catch { perms = []; }
              return Array.isArray(perms) && perms.length ? perms.join(', ') : '-';
            })()}
          </td>
          <td>${p.enabled ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}</td>
          <td style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn sm" data-tg="${p.id}">${p.enabled ? t('停用') : t('启用')}</button>
            <button class="btn sm" data-test="${p.id}">▶ ${t('试运行')}</button>
            <button class="btn sm danger" data-rm="${p.id}">🗑️ ${t('卸载')}</button>
          </td>
        </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td class="empty" colspan="7">⚠️ ${esc(e.message)}</td></tr>`;
    }
  }

  // 启用/停用
  root.addEventListener('click', async e => {
    const tg = e.target.dataset.tg;
    if (tg) {
      try {
        const j = await api(`/plugins/${tg}/toggle`, { method: 'POST' });
        toast(j.msg || (j.data?.enabled ? t('已启用') : t('已停用')));
        loadList();
      } catch (ex) { toast(ex.message, 'err'); }
      return;
    }
    const rm = e.target.dataset.rm;
    if (rm) {
      if (!await confirmBox(t('卸载该插件？使用中的调用将立即失效。'))) return;
      try {
        const j = await api(`/plugins/${rm}/uninstall`, { method: 'POST' });
        toast(j.msg || t('已卸载'));
        loadList();
      } catch (ex) { toast(ex.message, 'err'); }
      return;
    }
    const testId = e.target.dataset.test;
    if (testId) {
      try {
        const j = await api(`/plugins/${testId}/test`, { method: 'POST' });
        if (j.code !== 0) return toast(j.msg || t('试运行失败'), 'err');
        toast(t('试运行成功'));
      } catch (ex) { toast(ex.message, 'err'); }
      return;
    }
  });

  // 同步市场
  document.getElementById('syncBtn').onclick = async () => {
    $('#syncBtn').disabled = true; $('#syncBtn').textContent = '🔄 ' + t('同步中…');
    try {
      const j = await api('/plugins/remote/sync');
      toast(`同步完成，共同步 ${j.data?.hubs || 0} 个市场源`);
      loadList();
    } catch (ex) { toast(ex.message, 'err'); }
    finally { $('#syncBtn').disabled = false; $('#syncBtn').textContent = '🔄 ' + t('同步市场'); }
  };

  // 手动安装
  document.getElementById('installBtn').onclick = () => {
    modal({
      title: `🧩 ${t('安装插件')}`,
      body: `<div style="line-height:2;font-size:13px;color:var(--text-2)">
        <div class="form-item"><label>${t('插件 ID *')}</label><input class="input" id="piPluginId" placeholder="example-plugin" style="width:100%"></div>
        <div class="form-item"><label>${t('入口文件 *')}</label><input class="input" id="piEntry" placeholder="code.js" style="width:100%"></div>
        <div class="form-item"><label>${t('名称（可选）')}</label><input class="input" id="piName" placeholder="'我的插件'" style="width:100%"></div>
        <div class="form-item"><label>${t('版本')}</label><input class="input" id="piVer" value="1.0.0" style="width:100%"></div>
        <div class="form-item"><label>${t('权限声明（JSON 数组，可选）')}</label><input class="input" id="piPerms" placeholder='["network","files"]' style="width:100%"></div>
      </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-go>${t('安装')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-go]').onclick = async () => {
          const pluginId = mask.querySelector('#piPluginId').value.trim();
          const entry = mask.querySelector('#piEntry').value.trim();
          const name = mask.querySelector('#piName').value.trim();
          const version = mask.querySelector('#piVer').value.trim();
          const perms = mask.querySelector('#piPerms').value.trim();
          if (!pluginId) return toast(t('插件 ID 不能为空'), 'err');
          if (!entry) return toast(t('入口文件不能为空'), 'err');
          try {
            const j = await api('/plugins/install', { method: 'POST', body: {
              plugin_id: pluginId,
              name: name || pluginId,
              entry,
              version: version || '1.0.0',
              permissions: perms ? perms.split(',').map(s => s.trim()).filter(Boolean) : [],
            }});
            if (j.code !== 0) return toast(j.msg || t('安装失败'), 'err');
            toast(t('安装成功'));
            close(); loadList();
          } catch (ex) { toast(ex.message, 'err'); }
        };
      },
    });
  };

  await loadList();
}
