/**
 * 后台-密钥管理（P5.5：画布 {{env.XXX}} 占位符数据源）
 * - 值只写不读（列表仅显示名称/备注/长度）；空值提交=删除
 * - 命名规范：大写字母开头的字母/数字/下划线
 */
import { api, getUser } from '../api.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  const me = getUser() || {};
  if (me.role !== 'admin') { el.innerHTML = '<div class="empty-box">仅管理员可访问</div>'; return; }
  el.innerHTML = `
  <style>
    .sec-page{padding:18px 22px;max-width:960px;margin:0 auto}
    .sec-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
    .sec-head h2{margin:0;font-size:18px;color:var(--text,#111827)}
    .sec-card{background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:16px 18px;margin-bottom:14px}
    .sec-row{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--border,#eef0f3)}
    .sec-row:last-child{border-bottom:none}
    .sec-row b{font-family:ui-monospace,monospace;font-size:13px;color:var(--brand,#2563eb)}
    .sec-row .meta{font-size:11.5px;color:var(--text-3,#9ca3af);flex:1}
    .sec-hint{font-size:12px;color:var(--text-3,#9ca3af);line-height:1.8;margin:10px 0}
    .sec-hint code{background:var(--surface-2,#f3f4f6);border-radius:4px;padding:1px 5px;font-size:11px}
  </style>
  <div class="sec-page">
    <div class="sec-head">
      <h2>🔐 ${t('密钥管理')}</h2>
      <div style="flex:1"></div>
      <button class="btn primary" id="secAdd">＋ ${t('新增密钥')}</button>
    </div>
    <div class="sec-hint">
      ${t('画布工作流中用')} <code>{{env.NAME}}</code> ${t('占位符引用（工具参数/代码入参/提示词均可），运行时从本表注入——密钥永不落画布 JSON 与运行日志。')}<br>
      ${t('安全设计：值仅管理员可写，任何接口不回读明文；日志落库前自动脱敏为')} <code>{{env.NAME}}</code>。
    </div>
    <div class="sec-card" id="secList">⏳ ${t('加载中…')}</div>
  </div>`;

  async function load() {
    try {
      const j = await api('/secrets');
      const host = el.querySelector('#secList');
      if (!j.data?.length) {
        host.innerHTML = `<div style="color:var(--text-3);padding:8px 0">${t('暂无密钥——点右上「＋ 新增密钥」添加第一个（如 SEARCH_API_KEY）')}</div>`;
        return;
      }
      host.innerHTML = j.data.map(r => `
        <div class="sec-row">
          <b>{{env.${esc(r.name)}}}</b>
          <span class="meta">${esc(r.remark || '')} · ${r.len} ${t('字符')} · ${esc((r.updated_at || r.created_at || '').slice(0, 16))}</span>
          <button class="btn sm" data-edit="${esc(r.name)}" data-remark="${esc(r.remark || '')}">${t('更新')}</button>
          <button class="btn sm danger" data-del="${esc(r.name)}">${t('删除')}</button>
        </div>`).join('');
      host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(b.dataset.edit, b.dataset.remark));
      host.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm(`确认删除 {{env.${b.dataset.del}}} ？引用它的画布运行时将保留占位符原样`)) return;
        const j2 = await api('/secrets', { method: 'POST', body: { name: b.dataset.del, value: '' } });
        toast(j2.msg || '已删除');
        load();
      });
    } catch (e) { el.querySelector('#secList').innerHTML = `<div style="color:#dc2626">❌ ${esc(e.message)}</div>`; }
  }

  function openForm(name = '', remark = '') {
    modal({
      title: (name ? '✏️ ' + t('更新密钥') : '＋ ' + t('新增密钥')),
      body: `<div style="font-size:12.5px;line-height:1.9">
        <div style="margin-bottom:10px"><label style="font-size:11.5px;color:var(--text-3)">名称（大写字母/数字/下划线）</label>
          <input class="input" id="secName" value="${esc(name)}" ${name ? 'readonly' : ''} placeholder="如 SEARCH_API_KEY"></div>
        <div style="margin-bottom:10px"><label style="font-size:11.5px;color:var(--text-3)">值（留空提交 = 删除${name ? '' : '（必填）'}）</label>
          <input class="input" id="secValue" type="password" placeholder="${name ? '••••••（不变可留空？）留空提交将删除！' : '密钥值'}"></div>
        <div><label style="font-size:11.5px;color:var(--text-3)">备注</label>
          <input class="input" id="secRemark" value="${esc(remark)}" placeholder="${t('用途说明，如 联网搜索 API Key')}"></div>
      </div>`,
      foot: `<button class="btn primary" id="secSave">${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('#secSave').onclick = async () => {
          const name = mask.querySelector('#secName').value.trim();
          const value = mask.querySelector('#secValue').value;
          const remark = mask.querySelector('#secRemark').value.trim();
          if (!name) return toast('名称不能为空', 'err');
          if (!name && !value) return;
          try {
            const j = await api('/secrets', { method: 'POST', body: { name, value, remark } });
            toast(j.msg || '已保存');
            close(); load();
          } catch (e) { toast('保存失败：' + e.message, 'err'); }
        };
      },
    });
  }

  el.querySelector('#secAdd').onclick = () => openForm();
  load();
}
