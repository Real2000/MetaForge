/** Hash 路由 + 双布局（前台/后台）+ 主题/语言切换（P3） */
import { api, getToken, getUser, logout } from './api.js';
import { esc, toast, modal, confirmBox, getTheme, getThemePref, setTheme } from './ui.js';
import { t, getLang, setLang } from './i18n.js';

// <html lang> 跟随界面语言（P3 多语言）
document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN';

// 路由层 destroy 生命周期：页面模块 render() 可返回 { destroy }，切页时统一清理（防 monitor 轮询/canvas 监听器泄漏）
let currentDestroy = null;

const routes = {
  '/login': { page: () => import('./login.js'), layout: 'none' },
  '/home': { page: () => import('./front/home.js'), layout: 'front', title: '前台首页' },
  '/agents': { page: () => import('./front/agents.js'), layout: 'front', title: '智能体' },
  '/square': { page: () => import('./front/square.js'), layout: 'front', title: '智能体广场' },
  '/skills': { page: () => import('./front/skills.js'), layout: 'front', title: '技能' },
  '/skills-market': { page: () => import('./front/market.js'), layout: 'front', title: '技能市场' }, // V2.2 #7 四区聚合运营位
  '/models': { page: () => import('./front/models.js'), layout: 'front', title: '我的模型' },
  '/chat': { page: () => import('./front/chat.js'), layout: 'chat', title: '智能体对话' },
  '/knowledge': { page: () => import('./front/knowledge.js'), layout: 'front', title: '知识库' },
  '/tasks': { page: () => import('./front/tasks.js'), layout: 'front', title: '任务管理' },
  '/help': { page: () => import('./front/help.js'), layout: 'front', title: '帮助中心' },
  '/pricing': { page: () => import('./front/pricing.js'), layout: 'none', title: '套餐与定价', public: true },
  '/billing': { page: () => import('./front/billing.js'), layout: 'front', title: '账单与发票', public: true },
  '/insights': { page: () => import('./front/insights.js'), layout: 'front', title: '使用分析', public: true },
  '/devices': { page: () => import('./front/devices.js'), layout: 'front', title: '我的设备' },
  '/admin/dashboard': { page: () => import('./admin/dashboard.js'), layout: 'admin', title: '数据看板', admin: true },
  '/admin/agents': { page: () => import('./admin/agents.js'), layout: 'admin', title: '智能体管理', admin: true },
  '/admin/users': { page: () => import('./admin/users.js'), layout: 'admin', title: '用户管理', admin: true },
  '/admin/studio': { page: () => import('./admin/studio.js'), layout: 'none', title: '智能体编排' }, // P3：协作者（非管理员）可进入，页面内经详情接口鉴权
  '/admin/knowledge': { page: () => import('./admin/knowledge.js'), layout: 'admin', title: '知识库管理', admin: true },
  '/admin/access': { page: () => import('./admin/access.js'), layout: 'admin', title: '接入管理', admin: true },
  '/admin/models': { page: () => import('./admin/models.js'), layout: 'admin', title: '模型接入', admin: true },
  '/admin/secrets': { page: () => import('./admin/secrets.js'), layout: 'admin', title: '密钥管理', admin: true },
  '/admin/security': { page: () => import('./admin/security.js'), layout: 'admin', title: '安全合规', admin: true },
  '/admin/monitor': { page: () => import('./admin/monitor.js'), layout: 'admin', title: '系统监控', admin: true },
  '/admin/operation': { page: () => import('./admin/operation.js'), layout: 'admin', title: '运营监控', admin: true },
  '/admin/mcp': { page: () => import('./admin/mcp.js'), layout: 'admin', title: 'MCP 服务', admin: true },
  '/admin/quota': { page: () => import('./admin/quota.js'), layout: 'admin', title: '用量与配额', admin: true },
  '/admin/feedback': { page: () => import('./admin/feedback.js'), layout: 'admin', title: '意见反馈', admin: true },
  '/admin/quality': { page: () => import('./admin/quality.js'), layout: 'admin', title: '对话质量', admin: true },
  '/admin/biz': { page: () => import('./admin/biz.js'), layout: 'admin', title: '商业化管理', admin: true },
};

const frontNav = [
  { href: '#/home', ic: '🏠', label: '前台首页' },
  { href: '#/agents', ic: '🤖', label: '智能体' },
  { href: '#/square', ic: '🛍️', label: '广场' },
  { href: '#/skills', ic: '✨', label: '技能' },
  { href: '#/skills-market', ic: '🛒', label: '技能市场' },
  { href: '#/models', ic: '🧩', label: '我的模型' },
  { href: '#/knowledge', ic: '📚', label: '知识库' },
  { href: '#/tasks', ic: '⏰', label: '任务管理' },
  { href: '#/devices', ic: '🖥️', label: '我的设备' },
  { href: '#/insights', ic: '📈', label: '使用分析' },
  { href: '#/billing', ic: '🧾', label: '账单与发票' },
  { href: '#/help', ic: '❓', label: '帮助中心' },
];
const adminNav = [
  { href: '#/admin/dashboard', ic: '📊', label: '数据看板' },
  { href: '#/admin/agents', ic: '🤖', label: '智能体管理' },
  { href: '#/admin/users', ic: '👥', label: '用户管理' },
  { href: '#/admin/knowledge', ic: '📚', label: '知识库管理' },
  { href: '#/admin/access', ic: '🔌', label: '接入管理' },
  { href: '#/admin/mcp', ic: '🧩', label: 'MCP 服务' },
  { href: '#/admin/models', ic: '🧠', label: '模型接入' },
  { href: '#/admin/secrets', ic: '🔐', label: '密钥管理' },
  { href: '#/admin/security', ic: '🛡️', label: '安全合规' },
  { href: '#/admin/quota', ic: '💳', label: '用量与配额' },
  { href: '#/admin/monitor', ic: '📡', label: '系统监控' },
  { href: '#/admin/operation', ic: '📈', label: '运营监控' },
  { href: '#/admin/feedback', ic: '💬', label: '意见反馈' },
  { href: '#/admin/quality', ic: '📊', label: '对话质量' },
  { href: '#/admin/biz', ic: '💼', label: '商业化管理' },
];

function renderNav(list, currentPath) {
  return list.map(n => `<a class="nav-item ${currentPath.startsWith(n.href.slice(1)) ? 'active' : ''}" href="${n.href}"><i class="ic">${n.ic}</i>${t(n.label)}</a>`).join('');
}

/** 主题/语言切换按钮组（顶栏与对话页侧栏共用；P3 暗色 + P5.23 三态：跟随系统/亮/暗循环） */
const THEME_BTN = { auto: { icon: '🖥️', title: '主题：跟随系统（点击切换日间）' }, light: { icon: '☀️', title: '主题：日间（点击切换夜间）' }, dark: { icon: '🌙', title: '主题：夜间（点击切换跟随系统）' } };
function themeBtnHTML() { const p = getThemePref(); return `<button class="btn sm" id="themeBtn" title="${THEME_BTN[p].title}">${THEME_BTN[p].icon}</button>`; }
function prefToggleHTML() {
  return `${themeBtnHTML()}
  <button class="btn sm" id="langBtn" title="切换中英文 / Switch language">${getLang() === 'en' ? 'EN' : '中'}</button>`;
}
function mountPrefToggles() {
  const tb = document.getElementById('themeBtn');
  if (tb) tb.onclick = () => {
    // 三态循环：跟随系统 → 日间 → 夜间 → 跟随系统（旧二态用户习惯保留：亮暗切换仍在环内）
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(getThemePref()) + 1) % 3];
    setTheme(next);
    tb.outerHTML = themeBtnHTML();
    mountPrefToggles();
    // 含 Canvas 图表的页面重渲染以刷新图表；其余页面 CSS 变量即时变色无需刷新
    const h = location.hash;
    const chartPage = /^#\/admin\/(dashboard|monitor|operation|quota)/.test(h) || h === '#/billing' || h === '#/insights';
    if (chartPage && typeof route === 'function') route();
  };
  const lb = document.getElementById('langBtn');
  if (lb) lb.onclick = () => { setLang(getLang() === 'en' ? 'zh' : 'en'); location.reload(); };
}

function layoutShell(kind, currentPath, title, contentHTML) {
  // P5.23 企业嵌入模式：URL 带 ?embed=1 时只出内容区（隐藏侧栏/顶栏），供 IM/iframe/门户嵌入
  if (isEmbedMode()) {
    return `<div class="layout embed-mode"><div class="main"><div class="content" id="pageContent" style="padding:0">${contentHTML}</div></div></div>`;
  }
  const user = getUser() || {};
  const isAdmin = user.role === 'admin';
  if (kind === 'chat') {
    // 对话页：极简顶栏 + 全高内容；移动端加悬浮按钮唤出会话抽屉
    return `
    <div class="layout">
      <div class="sidebar-mask" id="sidebarMask"></div>
      <aside class="sidebar" id="mainSidebar">
        <a class="logo" href="#/home"><span class="mark">A</span>${t('智能体平台')}</a>
        <nav class="nav-group">${renderNav(frontNav, currentPath)}</nav>
        <div class="foot">
          <div style="display:flex;gap:6px;padding:0 4px 8px">${prefToggleHTML()}</div>
          <a class="nav-item" id="bellChat" href="javascript:;"><i class="ic">🔔</i>${t('通知')}<span id="bellChatDot" style="display:none;color:#ef4444"> ●</span></a>
          <a class="nav-item" id="feedbackChat" href="javascript:;"><i class="ic">💬</i>${t('意见反馈')}</a>
          <a class="nav-item" id="pwdChat" href="javascript:;"><i class="ic">🔑</i>${t('修改密码')}</a>
          ${isAdmin ? `<a class="nav-item" href="#/admin/dashboard"><i class="ic">⚙️</i>${t('进入后台')}</a>` : ''}
        </div>
      </aside>
      <button class="mobile-menu-btn" id="chatSessBtn" title="历史会话" aria-label="打开历史会话列表" style="position:fixed;top:58px;left:12px;z-index:45">☰</button>
      <div class="main">${contentHTML}</div>
    </div>`;
  }
  const navs = kind === 'admin' ? adminNav : frontNav;
  return `
  <div class="layout">
    <div class="sidebar-mask" id="sidebarMask"></div>
    <aside class="sidebar" id="mainSidebar">
      <a class="logo" href="#/home"><span class="mark">A</span>${t('智能体平台')}</a>
      <nav class="nav-group">
        <div class="nav-title">${kind === 'admin' ? t('管理后台') : t('工作台')}</div>
        ${renderNav(navs, currentPath)}
      </nav>
      <div class="foot">
        <a class="nav-item" id="bellSide" href="javascript:;"><i class="ic">🔔</i>${t('通知')}<span id="bellSideDot" style="display:none;color:#ef4444"> ●</span></a>
        ${kind === 'admin' ? `<a class="nav-item" href="#/home"><i class="ic">↩️</i>${t('返回前台')}</a>` : `<a class="nav-item" id="feedbackSide" href="javascript:;"><i class="ic">💬</i>${t('意见反馈')}</a>${isAdmin ? `<a class="nav-item" href="#/admin/dashboard"><i class="ic">⚙️</i>${t('进入后台')}</a>` : ''}`}
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="crumb"><button class="mobile-menu-btn" id="menuBtn" title="菜单" aria-label="打开导航菜单">☰</button> ${t('智能体平台')} <span>/</span> <b>${esc(t(title))}</b></div>
        <div class="right">
          ${prefToggleHTML()}
          <div class="space-selector" id="spaceSelector">
            <select class="input" id="spaceSelect" style="width:160px;font-size:12px">
              <option value="">全部空间</option>
            </select>
          </div>
          <span class="user-chip" id="userChip">
            <span class="avatar">${esc((user.nickname || user.username || 'U')[0])}</span>
            <span>${esc(user.nickname || user.username || '')}</span>
            ${isAdmin ? `<span class="role-tag">${t('管理员')}</span>` : ''}
          </span>
          <button class="btn sm" id="pwdBtn" title="修改密码">🔑</button>
          <button class="btn sm" id="logoutBtn">${t('退出')}</button>
        </div>
      </div>
      <div class="content" id="pageContent">${contentHTML}</div>
    </div>
  </div>`;
}

/* ---------------- P5.23 企业嵌入 / 网络环境 / 无障碍全局挂载 ---------------- */
/** 嵌入模式：URL 带 ?embed=1（或 hash 后带 ?embed=1）——隐藏侧栏/顶栏，只出内容。
 *  供 IM 客户端、门户 iframe、企业内网单页嵌入；登录态仍走本页 token（宿主需能传递）。 */
export function isEmbedMode() {
  try { return /[?&]embed=1/.test(location.href) || sessionStorage.getItem('ap_embed') === '1'; } catch { return false; }
}
/** 嵌入模式高度上报：iframe 自适应高度场景，宿主监听 message 拿 body 高度后自己调 iframe */
function postEmbedHeight() {
  const send = () => {
    try {
      const h = Math.max(document.body.scrollHeight, document.body.offsetHeight);
      if (window.parent !== window) window.parent.postMessage({ type: 'ap-embed-height', height: h }, '*');
    } catch { }
  };
  send();
  setTimeout(send, 600); // 异步渲染后再报一次（骨架屏→真实内容高度变化）
}
/** 离线提示条：断网时顶部常驻，恢复联网自动消失（弱网/离线场景的最低限度反馈） */
function mountOfflineBar() {
  if (document.getElementById('offlineBar')) return;
  const bar = document.createElement('div');
  bar.id = 'offlineBar';
  bar.className = 'offline-bar';
  bar.textContent = '⚠️ 网络已断开——当前展示离线缓存内容，操作将无法保存';
  document.body.appendChild(bar);
  const sync = () => bar.classList.toggle('show', !navigator.onLine);
  sync();
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
}
// 全局一次性初始化（与路由解耦：嵌入/离线/无障碍均不应被页面切换冲掉）
(function globalInits() {
  if (isEmbedMode()) {
    try { sessionStorage.setItem('ap_embed', '1'); } catch { } // hash 路由切页后仍保持嵌入
    const sk = document.querySelector('.skip-link'); if (sk) sk.remove();  // 嵌入态不需要跳转链接
    document.documentElement.classList.add('embed');
  }
  mountOfflineBar();
})();

async function route() {  const hash = location.hash || '#/home';
  const path = hash.slice(1).split('?')[0];
  const segs = path.split('/').filter(Boolean);
  const base = '/' + segs.slice(0, segs[0] === 'admin' ? 2 : 1).join('/');
  const conf = routes[base] || routes['/home'];

  // 切页前清理上一页 destroy（防轮询/监听器泄漏）
  if (currentDestroy) { try { currentDestroy(); } catch (e) { console.warn('destroy err', e); } currentDestroy = null; }

  if (!getToken() && !conf.public && base !== '/login') { location.hash = '#/login'; return; }
  if (base === '/login' && getToken()) { location.hash = '#/home'; return; }
  if (conf.admin && getUser()?.role !== 'admin') { toast(t('需要管理员权限'), 'err'); location.hash = '#/home'; return; }

  const params = segs.slice(conf.layout === 'chat' ? 1 : (base.split('/').length - 1));

  const app = document.getElementById('app');
  if (conf.layout === 'none') {
    app.innerHTML = '';
    const mod = await conf.page();
    const ret = await mod.render(app, params);
    if (typeof ret?.destroy === 'function') currentDestroy = ret.destroy;
  } else {
    app.innerHTML = layoutShell(conf.layout, path, conf.title, skeletonHTML(conf.layout));
    // P5.23 嵌入模式：隐藏 chrome 后还需把高度报给宿主（iframe 自适应高度场景）
    if (isEmbedMode()) postEmbedHeight();
    const lb = document.getElementById('logoutBtn');
    if (lb) lb.onclick = async () => {
      if (await confirmBox('确定退出登录？')) { logout(); location.hash = '#/login'; }
    };
    const uc = document.getElementById('userChip');
    if (uc) uc.onclick = () => location.hash = '#/home';
    // 通知铃铛（侧栏入口，front/admin/chat 三种布局统一挂载）：未读红点 + 通知面板
    mountBell();
    // 意见反馈（全站固定入口，front/admin/chat 三种布局统一挂载）
    mountFeedback();
    // 修改密码（顶栏 🔑 / 对话页侧栏入口，全员可用）：原密码验证 + 弱口令拦截由后端保障
    mountPwdChange();
    // 主题/语言切换（P3）：顶栏与对话页侧栏按钮绑定
    mountPrefToggles();
    const box = document.getElementById('pageContent') || app.querySelector('.main');
    const mod = await conf.page();
    try {
      const ret = await mod.render(box, params);
      if (typeof ret?.destroy === 'function') currentDestroy = ret.destroy;
    } catch (e) {
      console.error(e);
      box.innerHTML = `<div class="empty-box"><div class="big">⚠️</div>页面加载失败：${esc(e.message)}</div>`;
    }
    // 移动端汉堡菜单：页面渲染后挂载（chat 布局的 .chat-side 此时才存在）
    mountMobileMenu();
    if (!location.hash.startsWith('#/login') && !location.hash.startsWith('#/chat')) {
      mountSpaceSelector();
    }
  }
}

  // 空间选择器（V2.4 #9 2026-10-31）：加载空间列表 + 设置全局 currentSpace + 绑定刷新
let spaceSelectorMounted = false;
window.__currentSpace = window.__currentSpace || ''; // 初始化全局变量
async function mountSpaceSelector() {
  if (spaceSelectorMounted) return;
  const sel = document.getElementById('spaceSelect');
  if (!sel) return;
  spaceSelectorMounted = true;
  try {
    const j = await api('/agents/spaces/list');
    const spaces = j.data || [];
    spaces.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  } catch { /* 静默 */ }
  // 恢复上次选择的空间
  if (window.__currentSpace) sel.value = window.__currentSpace;
  sel.onchange = () => {
    window.__currentSpace = parseInt(sel.value) || '';
    route(); // 重新加载当前页面
  };
}

/** 骨架屏（体验优化）：路由切换 shimmer 占位，替代白屏/⏳ 文案 */
function skeletonHTML(kind) {
  if (kind === 'chat') {
    return `<div class="skel-page">
      <div class="skel skel-title" style="margin:18px auto 22px"></div>
      <div class="skel skel-card" style="width:70%;margin:0 auto 26px;height:120px"></div>
      <div class="skel skel-line" style="width:55%"></div>
      <div class="skel skel-line" style="width:75%"></div>
      <div class="skel skel-line" style="width:40%"></div>
    </div>`;
  }
  return `<div class="skel-page">
    <div class="skel skel-title"></div>
    <div class="skel skel-card" style="height:52px;margin-bottom:14px"></div>
    <div class="grid-4" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:14px">
      ${'<div class="skel skel-card" style="height:84px"></div>'.repeat(4)}
    </div>
    <div class="skel skel-line" style="width:60%"></div>
    <div class="skel skel-line" style="width:85%"></div>
    <div class="skel skel-line" style="width:70%"></div>
    <div class="skel skel-line" style="width:45%"></div>
  </div>`;
}

/** 移动端汉堡菜单：侧栏/会话栏抽屉 + 遮罩（≤768px 生效，桌面端按钮 display:none）
 *  chat 布局的 .chat-side 在页面模块 async 渲染后才存在——绑定延迟重试 */
function mountMobileMenu(tries = 0) {
  const btn = document.getElementById('menuBtn') || document.getElementById('chatSessBtn');
  const sidebar = document.getElementById('mainSidebar');
  const chatSide = document.querySelector('.chat-side');
  const mask = document.getElementById('sidebarMask');
  if (!btn || !mask) return;
  if (btn.dataset.mounted === '1') return;
  // 对话页：按钮唤出会话抽屉（chat-side）；其余页：唤出主导航抽屉
  const target = btn.id === 'chatSessBtn' ? chatSide : sidebar;
  if (!target) {
    if (tries < 10) setTimeout(() => mountMobileMenu(tries + 1), 200); // 等页面模块渲染出 .chat-side
    return;
  }
  btn.dataset.mounted = '1';
  const close = () => { target.classList.remove('open'); mask.classList.remove('show'); };
  btn.onclick = () => {
    target.classList.toggle('open');
    mask.classList.toggle('show', target.classList.contains('open'));
  };
  mask.onclick = close;
  // 点击导航/会话项后自动收起抽屉
  target.querySelectorAll('.nav-item, .sess-item').forEach(a => a.addEventListener('click', close));
}

/** 通知铃铛（借鉴 SinguX 通知中心）：侧栏「🔔 通知」入口 + 未读红点 + 弹出通知面板 */
async function mountBell() {
  const bell = document.getElementById('bellSide') || document.getElementById('bellChat');
  if (!bell) return;
  let unread = 0;
  try {
    const j = await api('/notify');
    unread = j.data?.unread || 0;
  } catch { /* 静默：通知接口异常不阻塞页面 */ }
  const dot = document.getElementById('bellSideDot') || document.getElementById('bellChatDot');
  if (dot) dot.style.display = unread ? '' : 'none';
  if (bell.dataset.mounted === '1') return;
  bell.dataset.mounted = '1';
  bell.onclick = async () => openNotifyPanel(dot);
}

async function openNotifyPanel(dot) {
  let data;
  try { data = (await api('/notify')).data; } catch { return toast('通知加载失败', 'err'); }
  const list = data.list || [];
  const m = modal({
    title: `🔔 ${t('通知中心')}${data.unread ? `（${data.unread} ${t('条未读')}）` : ''}`,
    body: `
      <div id="notifyList">
        ${list.length ? list.map(n => `
          <div class="notify-item" data-id="${n.id}" data-link="${esc(n.link || '')}" style="display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--surface-2,#f1f3f7);cursor:${n.link ? 'pointer' : 'default'};opacity:${n.is_read ? 0.65 : 1}">
            <span style="font-size:18px">${n.type === 'agent_publish' ? '🤖' : n.type === 'quota' ? '📊' : n.type === 'feedback' ? '💬' : '📢'}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(n.title)}${n.is_read ? '' : ' <span style="color:#ef4444;font-size:11px">NEW</span>'}</div>
              <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(n.content)}</div>
              <div style="font-size:11px;color:#c0c4cc;margin-top:4px">${esc((n.created_at || '').slice(0, 16))}</div>
            </div>
          </div>`).join('') : `<div style="padding:30px;text-align:center;color:var(--text-3)">${t('暂无通知')}</div>`}
      </div>
      <style>.notify-item:hover{background:var(--surface-2,#f8faff)}</style>`,
    foot: `<button class="btn" data-readall>${t('全部已读')}</button><button class="btn primary" data-close>${t('关闭')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-close]').onclick = close;
      mask.querySelector('[data-readall]').onclick = async () => {
        await api('/notify/read-all', { method: 'POST' });
        close(); toast(t('已全部标记为已读'));
        if (dot) dot.style.display = 'none';
      };
      mask.querySelectorAll('.notify-item').forEach(item => {
        item.onclick = async () => {
          await api(`/notify/${item.dataset.id}/read`, { method: 'POST' }).catch(() => { });
          close();
          const link = item.dataset.link;
          if (link && link.startsWith('#')) location.hash = link.slice(1);
        };
      });
    },
  });
}

/** 意见反馈（全站固定入口）：弹窗收集 问题类型+描述+联系方式，提交落库；
 *  下方同屏展示「我的反馈」处理状态与回复（闭环可见） */
function mountFeedback() {
  const btn = document.getElementById('feedbackSide') || document.getElementById('feedbackChat');
  if (!btn || btn.dataset.mounted === '1') return;
  btn.dataset.mounted = '1';
  btn.onclick = openFeedbackModal;
}

async function openFeedbackModal() {
  let mine = [];
  try { mine = (await api('/feedback/mine')).data; } catch { }
  const TYPE_META = { bug: { ic: '🐛', label: t('Bug 报告') }, suggest: { ic: '💡', label: t('功能建议') }, consult: { ic: '❓', label: t('使用咨询') } };
  const m = modal({
    title: '💬 ' + t('意见反馈'),
    wide: true,
    body: `
      <style>
        .fb-types{display:flex;gap:8px;margin-bottom:12px}
        .fb-type{flex:1;padding:10px 8px;border:1px solid #e5e7eb;border-radius:10px;cursor:pointer;text-align:center;font-size:12px;color:var(--text-2);transition:.12s}
        .fb-type:hover{border-color:#93c5fd}
        .fb-type.on{border-color:#2563eb;background:#f0f6ff;color:#2563eb;font-weight:600}
        .fb-mine{margin-top:18px;border-top:1px dashed var(--border,#e5e7eb);padding-top:14px}
        .fb-item{padding:10px 12px;border:1px solid var(--surface-2,#f1f3f7);border-radius:10px;margin-bottom:8px;font-size:12px}
      </style>
      <div class="fb-types" id="fbTypes">
        ${Object.entries(TYPE_META).map(([k, v]) => `<div class="fb-type ${k === 'suggest' ? 'on' : ''}" data-t="${k}">${v.ic}<br>${v.label}</div>`).join('')}
      </div>
      <textarea id="fbContent" rows="4" class="input" style="width:100%;box-sizing:border-box;resize:vertical" placeholder="${t('请详细描述你遇到的问题或建议…')}"></textarea>
      <input id="fbContact" class="input" style="width:100%;box-sizing:border-box;margin-top:8px" placeholder="${t('联系方式（可选，便于我们回访）')}">
      ${mine.length ? `
      <div class="fb-mine">
        <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">${t('📋 我的历史反馈（处理后这里会显示回复）')}</div>
        ${mine.slice(0, 5).map(f => `
          <div class="fb-item">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <span>${TYPE_META[f.type]?.ic || '💬'} ${esc((f.content || '').slice(0, 60))}${(f.content || '').length > 60 ? '…' : ''}</span>
              <span class="tag ${f.status === 'processed' ? 'green' : 'orange'}" style="font-size:10px;flex-shrink:0">${f.status === 'processed' ? t('已处理') : t('待处理')}</span>
            </div>
            ${f.status === 'processed' && f.reply ? `<div style="margin-top:6px;padding:8px 10px;background:var(--surface-2,#f0fdf4);border-radius:8px;color:var(--success,#166534)">↩ ${t('管理员回复')}：${esc(f.reply)}</div>` : ''}
            <div style="color:#c0c4cc;margin-top:4px">${esc((f.created_at || '').slice(0, 16))}</div>
          </div>`).join('')}
      </div>` : ''}`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-submit>${t('提交反馈')}</button>`,
    onMount(mask, close) {
      let type = 'suggest';
      mask.querySelectorAll('.fb-type').forEach(t => t.onclick = () => {
        type = t.dataset.t;
        mask.querySelectorAll('.fb-type').forEach(x => x.classList.toggle('on', x === t));
      });
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-submit]').onclick = async () => {
        const content = mask.querySelector('#fbContent').value.trim();
        if (!content) return toast(t('请填写反馈内容'), 'err');
        const btn2 = mask.querySelector('[data-submit]');
        btn2.disabled = true; btn2.textContent = t('提交中…');
        try {
          const j = await api('/feedback', { method: 'POST', body: { type, content, contact: mask.querySelector('#fbContact').value.trim() } });
          toast(j.msg || t('反馈已提交'));
          close();
        } catch (e) { toast(e.message, 'err'); btn2.disabled = false; btn2.textContent = t('提交反馈'); }
      };
    },
  });
}

// 供对话页悬浮帮助按钮等外部入口唤起（app.js 模块作用域外不可见）
window.__openFeedback = openFeedbackModal;

/** 修改密码弹窗（自服务入口，复用 /auth/change-password：原密码验证 + 弱口令拦截 + 清除强制改密标记） */
function mountPwdChange() {
  const btn = document.getElementById('pwdBtn') || document.getElementById('pwdChat');
  if (!btn || btn.dataset.mounted === '1') return;
  btn.dataset.mounted = '1';
  btn.onclick = () => {
    const m = modal({
      title: t('🔑 修改密码'),
      body: `
        <div class="u-pwd-form">
          <label>${t('原密码')}</label><input class="input" id="oldPwd" type="password" autocomplete="current-password" placeholder="${t('输入当前密码')}">
          <label>${t('新密码（至少 6 位，不能是常见默认口令）')}</label><input class="input" id="newPwd" type="password" autocomplete="new-password" placeholder="${t('输入新密码')}">
          <label>${t('确认新密码')}</label><input class="input" id="newPwd2" type="password" autocomplete="new-password" placeholder="${t('再次输入新密码')}">
        </div>
        <style>.u-pwd-form label{display:block;font-size:12px;color:var(--text-3);margin:12px 0 4px}</style>`,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('确认修改')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const oldPwd = mask.querySelector('#oldPwd').value;
          const p1 = mask.querySelector('#newPwd').value;
          const p2 = mask.querySelector('#newPwd2').value;
          if (!oldPwd) return toast(t('请输入原密码'), 'err');
          if (p1.length < 6) return toast(t('新密码至少 6 位'), 'err');
          if (p1 !== p2) return toast(t('两次输入的新密码不一致'), 'err');
          try {
            const j = await api('/auth/change-password', { method: 'POST', body: { oldPwd, newPwd: p1 } });
            toast(j.msg || t('已保存'));
            close();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };
}

window.addEventListener('hashchange', route);
route();
