/** 我的设备（P5.27 本地桥配对与管理）
 *  - 生成 6 位配对码（120s 有效，一次性）→ 在客户端「TeleAgent 智能体平台助手」安装后输入
 *  - 设备列表：在线状态（15s 心跳窗）/ 默认设备切换 / 解绑
 *  - 安装包下载（服务端 /api/localbridge/installer 提供的 zip）+ 安装引导
 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

export async function render(box) {
  box.innerHTML = `
  <div class="page-head"><h2>🖥️ ${t('我的设备 · 本地能力')}</h2></div>
  <div class="grid-2">
    <div class="card" style="padding:22px">
      <h3 style="margin-bottom:6px">📦 ${t('安装客户端（Mac）')}</h3>
      <p style="color:var(--text-3);font-size:13px;line-height:1.8">${t('安装「TeleAgent 智能体平台助手」后，AI 可在您的授权下操作本机（白名单）：创建文件夹、打开应用、发送通知。操作前均需您在对话中逐次确认。')}<br>${t('支持 Windows 后续版本')}</p>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
        <a class="btn primary" href="/api/localbridge/installer" download>⬇️ ${t('下载安装包（Mac .dmg）')}</a>
        <a class="btn" href="/api/localbridge/installer?fmt=zip" download>${t('备用 .zip')}</a>
        <button class="btn" id="installGuideBtn">📖 ${t('安装引导')}</button>
      </div>
    </div>
    <div class="card" style="padding:22px">
      <h3 style="margin-bottom:6px">🔗 ${t('配对新设备')}</h3>
      <p style="color:var(--text-3);font-size:13px">${t('客户端首次打开会要求输入配对码；点击下方生成（120 秒内有效，一次性）')}</p>
      <div id="pairArea" style="margin-top:14px"><button class="btn primary" id="genCodeBtn">🔑 ${t('生成配对码')}</button></div>
    </div>
  </div>
  <div class="card" style="margin-top:18px;padding:22px">
    <h3 style="margin-bottom:10px">📱 ${t('已配对设备')}</h3>
    <div id="devList">${t('加载中…')}</div>
  </div>`;

  // 生成配对码
  box.querySelector('#genCodeBtn').onclick = async () => {
    try {
      const j = await api('/localbridge/paircode', { method: 'POST' });
      const { code, expires_in } = j.data;
      box.querySelector('#pairArea').innerHTML = `
        <div style="text-align:center;padding:16px;border:2px dashed var(--brand,#2563eb);border-radius:12px">
          <div style="font-size:13px;color:var(--text-3)">${t('在客户端安装后的配对窗口输入')}</div>
          <div style="font-size:44px;font-weight:700;letter-spacing:14px;color:var(--brand,#2563eb);margin:10px 0;font-family:ui-monospace,monospace">${esc(String(code))}</div>
          <div style="font-size:12px;color:var(--text-3)">${expires_in}s ${t('内有效')} · <a href="javascript:;" id="regen">${t('重新生成')}</a></div>
        </div>`;
      const tick = setInterval(() => {
        const el = box.querySelector('#pairArea [style*="12px"]');
        if (!el || !box.isConnected) return clearInterval(tick);
      }, 1000);
      box.querySelector('#regen').onclick = () => { clearInterval(tick); render(box); };
      // 配对成功检测（客户端 claim 后设备表出现）
      const poll = setInterval(async () => {
        if (!box.isConnected) return clearInterval(poll);
        try {
          const d = await api('/localbridge/devices');
          const found = (d.data || []).some(x => Date.now() - new Date(x.last_seen || 0).getTime() < 20000);
          if (found) {
            clearInterval(poll); clearInterval(tick);
            toast('🎉 配对成功！AI 现在可以（经您确认）操作这台设备', 'ok');
            loadDevs();
          }
        } catch { }
      }, 2500);
    } catch (e) { toast(e.message, 'err'); }
  };

  // 安装引导
  box.querySelector('#installGuideBtn').onclick = () => modal({
    title: '📖 安装引导（macOS）',
    body: `<div style="font-size:13px;line-height:2;color:var(--text)">
      1️⃣ 点击「下载安装包（Mac .dmg）」，得到 <b>TeleAgent助手.dmg</b><br>
      2️⃣ 双击打开 dmg → 把 <b>TeleAgent助手.app</b> 拖入旁边的 <b>Applications</b> 文件夹<br>
      3️⃣ 到「应用程序」打开 TeleAgent助手（首次：右键 → 「打开」绕过未签名提示，仅需一次）<br>
      4️⃣ 助手将自动安装开机自启（launchd），并弹出配对窗口<br>
      5️⃣ 回到本页点「生成配对码」，把 6 位数字输入客户端弹窗<br>
      6️⃣ 完成 ✅ 之后在对话里对 AI 说「帮我在桌面建个文件夹」试试<br><br>
      <span style="color:var(--text-3);font-size:12px">权限边界：客户端仅执行白名单操作（建文件夹/开应用/列目录/发通知），每次高危操作都会在对话中弹确认卡。卸载：双击 dmg 里的「卸载.command」再把 .app 拖入废纸篓。<br>架构说明：当前包为 Intel（x64）；Apple Silicon（M 系列）需在对应机器上运行 local-bridge/build-installer.sh 构建。</span></div>`,
    foot: `<button class="btn primary" data-close>知道了</button>`,
    onMount(m, close) { m.querySelector('[data-close]').onclick = close; },
  });

  async function loadDevs() {
    const el = box.querySelector('#devList');
    try {
      const j = await api('/localbridge/devices');
      const rows = j.data || [];
      if (!rows.length) {
        el.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-3);font-size:13px">${t('还没有已配对设备——安装客户端并配对后，AI 即可（经您确认）操作您的电脑')}</div>`;
        return;
      }
      el.innerHTML = `<table class="table"><thead><tr>
        <th>${t('设备')}</th><th>${t('系统')}</th><th>${t('状态')}</th><th>${t('默认')}</th><th>${t('最近心跳')}</th><th></th>
      </tr></thead><tbody>${rows.map(d => `
        <tr>
          <td><b>${esc(d.device_name || '未命名')}</b></td>
          <td style="font-size:12px;color:var(--text-3)">${esc(d.platform || '—')}</td>
          <td>${d.online ? '<span class="tag green">● 在线</span>' : '<span class="tag gray">○ 离线</span>'}</td>
          <td>${d.is_default ? '<span class="tag blue">默认</span>' : ''}</td>
          <td style="font-size:12px;color:var(--text-3)">${esc(d.last_seen || '—')}</td>
          <td style="white-space:nowrap">
            ${d.is_default ? '' : `<button class="btn sm" data-def="${d.id}">${t('设默认')}</button> `}
            <button class="btn sm" style="color:var(--danger,#dc2626)" data-unbind="${d.id}">${t('解绑')}</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
      el.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => {
        try { await api(`/localbridge/devices/${b.dataset.def}/default`, { method: 'POST' }); toast('已设为默认设备', 'ok'); loadDevs(); } catch (e) { toast(e.message, 'err'); }
      });
      el.querySelectorAll('[data-unbind]').forEach(b => b.onclick = async () => {
        if (!confirm('解绑后该设备将无法再被 AI 操作，确定？')) return;
        try { await api(`/localbridge/devices/${b.dataset.unbind}`, { method: 'DELETE' }); toast('已解绑', 'ok'); loadDevs(); } catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) {
      el.innerHTML = `<div style="padding:14px;color:var(--danger,#dc2626)">${esc(e.message)}</div>`;
    }
  }
  loadDevs();
  const refresh = setInterval(() => { if (!box.isConnected) return clearInterval(refresh); loadDevs(); }, 15000);
}
