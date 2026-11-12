/** 后台-SSO 企业登录配置（2026-11-12 P1-1b 界面补齐）：OIDC 服务商接入管理
 *  后端接口（P1-1 已交付）：GET/POST/PUT/DELETE /api/auth/sso + POST /:id/toggle（adminOnly，密钥加密存储）
 *  本页 = 服务商卡片列表 + 新增/编辑弹窗 + 启用开关 + 删除；密钥后端脱敏回显（••••••••）
 *  启用后登录页自动出现「企业登录」按钮（login.js 已实现）
 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let list = [];

  el.innerHTML = `
  <style>
    .sso-card{border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:14px 18px;margin-bottom:12px;background:#fff}
    .sso-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .sso-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
    .sso-meta{font-size:12px;color:var(--text-3,#6b7280);line-height:1.9}
    .sso-kv{display:inline-block;background:#f6f8fa;border-radius:6px;padding:1px 8px;margin-right:6px;font-size:11px;font-family:ui-monospace,Monaco,monospace}
  </style>
  <div class="page-head">
    <h2>${t('SSO 企业登录')}</h2>
    <div class="desc">${t('接入企业 OIDC 身份提供商（钉钉/企微/飞书/Keycloak/Okta 等通用 OIDC 均可）。启用后登录页自动出现「企业登录」按钮，员工免密登录。')}</div>
  </div>
  <div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <button class="btn primary" id="addBtn">➕ ${t('新增服务商')}</button>
    <span style="font-size:12px;color:var(--text-3)">${t('回调地址（需配置到 IdP 应用侧）：')}</span>
    <span class="sso-kv">${esc(location.origin)}/api/auth/sso/callback</span>
  </div>
  <div id="cards"></div>`;

  const cards = el.querySelector('#cards');

  function renderCards() {
    cards.innerHTML = list.length ? list.map(p => `
      <div class="sso-card">
        <div class="sso-row">
          <span class="sso-dot" style="background:${p.enabled ? '#059669' : '#9ca3af'}"></span>
          <b>${esc(p.display_name || p.name)}</b>
          <span class="tag blue">${esc(p.type || 'oidc')}</span>
          <span style="font-size:11px;color:var(--text-3)">@${esc(p.name)}</span>
          <span style="flex:1"></span>
          <button class="btn sm ${p.enabled ? '' : 'primary'}" data-toggle="${p.id}">${p.enabled ? t('停用') : t('启用')}</button>
          <button class="btn sm" data-edit="${p.id}">✏️ ${t('编辑')}</button>
          <button class="btn sm danger" data-del="${p.id}">${t('删除')}</button>
        </div>
        <div class="sso-meta">
          ${p.issuer ? `<div>🏢 Issuer：<span class="sso-kv">${esc(p.issuer)}</span></div>` : ''}
          ${p.client_id ? `<div>🔑 Client ID：<span class="sso-kv">${esc(p.client_id)}</span></div>` : ''}
          <div>🔗 ${t('授权端点')}：<span class="sso-kv">${esc(p.authorization_url || '—')}</span></div>
          <div>${p.scopes ? `📎 scopes：<span class="sso-kv">${esc(p.scopes)}</span>` : ''}${p.enabled ? ` ✅ <span style="color:#059669">${t('已启用——登录页已显示企业登录按钮')}</span>` : ` ⏸️ ${t('已停用')}`}</div>
        </div>
      </div>`).join('') : `<div class="card" style="padding:28px;text-align:center;color:var(--text-3)">
        <div style="font-size:34px;margin-bottom:8px">🔐</div>
        ${t('尚未接入任何企业身份提供商。点击上方「新增服务商」开始配置——')}<br>
        <span style="font-size:12px">${t('需要准备：IdP 的 Issuer 地址、应用的 Client ID / Client Secret、授权与令牌端点 URL。')}</span>
      </div>`;

    cards.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const j = await api(`/auth/sso/${b.dataset.toggle}/toggle`, { method: 'POST' });
      toast(j.data?.enabled ? t('已启用——登录页将显示企业登录按钮') : t('已停用'));
      load();
    });
    cards.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(list.find(p => p.id === +b.dataset.edit)));
    cards.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const p = list.find(x => x.id === +b.dataset.del);
      if (!await confirmBox(t('删除服务商「{n}」？登录页对应的企业登录入口将立即消失。').replace('{n}', p.display_name || p.name))) return;
      const j = await api(`/auth/sso/${p.id}`, { method: 'DELETE' });
      toast(j.msg || t('已删除')); load();
    });
  }

  function openForm(p) {
    const isNew = !p;
    modal({
      title: isNew ? `➕ ${t('新增 SSO 服务商')}` : `✏️ ${t('编辑 SSO 服务商')}（${esc(p.name)}）`,
      wide: true,
      body: `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 14px">
          <div><label style="font-size:12px;color:var(--text-3)">${t('唯一标识 *')}</label>
            <input id="fName" class="input" style="width:100%" value="${esc(p?.name || '')}" ${isNew ? '' : 'readonly'}
              placeholder="${t('英文/数字，如 dingtalk、keycloak')}">
            ${isNew ? '' : `<div style="font-size:11px;color:var(--text-3)">${t('创建后不可修改')}</div>`}</div>
          <div><label style="font-size:12px;color:var(--text-3)">${t('显示名称')}</label>
            <input id="fDisplay" class="input" style="width:100%" value="${esc(p?.display_name || '')}" placeholder="${t('登录按钮上的文案，如 企业账号登录')}"></div>
          <div style="grid-column:1/3"><label style="font-size:12px;color:var(--text-3)">${t('Issuer（签发方地址）')}</label>
            <input id="fIssuer" class="input" style="width:100%" value="${esc(p?.issuer || '')}" placeholder="${t('如 https://sso.example.com/realms/main')}"></div>
          <div><label style="font-size:12px;color:var(--text-3)">${t('Client ID *')}</label>
            <input id="fCid" class="input" style="width:100%" value="${esc(p?.client_id || '')}"></div>
          <div><label style="font-size:12px;color:var(--text-3)">${t('Client Secret *')}</label>
            <input id="fSecret" class="input" type="password" style="width:100%" value="" placeholder="${p?.client_secret ? t('已加密存储，留空则保持不变') : ''}">
            ${!isNew && p?.client_secret ? `<div style="font-size:11px;color:var(--text-3)">${t('当前已配置（加密存储）')}</div>` : ''}</div>
          <div style="grid-column:1/3"><label style="font-size:12px;color:var(--text-3)">${t('授权端点（authorization_url）*')}</label>
            <input id="fAuth" class="input" style="width:100%" value="${esc(p?.authorization_url || '')}" placeholder="${t('IdP 的 OAuth 授权页面地址')}"></div>
          <div style="grid-column:1/3"><label style="font-size:12px;color:var(--text-3)">${t('令牌端点（token_url）*')}</label>
            <input id="fToken" class="input" style="width:100%" value="${esc(p?.token_url || '')}" placeholder="${t('IdP 换取 access_token 的地址')}"></div>
          <div style="grid-column:1/3"><label style="font-size:12px;color:var(--text-3)">${t('用户信息端点（userinfo_url，选填）')}</label>
            <input id="fUser" class="input" style="width:100%" value="${esc(p?.userinfo_url || '')}" placeholder="${t('留空则仅从 id_token 解析用户身份')}"></div>
          <div style="grid-column:1/3"><label style="font-size:12px;color:var(--text-3)">${t('权限范围（scopes）')}</label>
            <input id="fScopes" class="input" style="width:100%" value="${esc(p?.scopes || 'openid profile email')}"></div>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:12px;padding:10px 12px;background:#f0f7ff;border-radius:10px">
          📌 ${t('配置完成后，请在 IdP 应用管理侧把回调地址设置为：')}
          <span class="sso-kv">${esc(location.origin)}/api/auth/sso/callback</span>
        </div>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${isNew ? t('创建') : t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const g = id => mask.querySelector(id).value.trim();
          const body = {
            name: g('#fName'), display_name: g('#fDisplay'), issuer: g('#fIssuer'),
            client_id: g('#fCid'), client_secret: g('#fSecret'),
            authorization_url: g('#fAuth'), token_url: g('#fToken'), userinfo_url: g('#fUser'),
            scopes: g('#fScopes') || 'openid profile email', type: 'oidc',
          };
          if (!body.name) return toast(t('唯一标识不能为空'), 'err');
          if (!body.client_id || !body.client_secret) return toast(t('Client ID 与 Client Secret 为必填项'), 'err');
          if (!body.authorization_url || !body.token_url) return toast(t('授权端点与令牌端点为必填项'), 'err');
          try {
            const j = isNew
              ? await api('/auth/sso', { method: 'POST', body })
              : await api(`/auth/sso/${p.id}`, { method: 'PUT', body });
            if (j.code !== 0) return toast(j.msg || t('保存失败'), 'err');
            toast(j.msg || t('已保存'));
            close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    list = (await api('/auth/sso')).data || [];
    renderCards();
  }

  el.querySelector('#addBtn').onclick = () => openForm(null);
  await load();
}
