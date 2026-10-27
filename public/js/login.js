import { api, setLogin } from './api.js';
import { esc, toast, modal, getTheme, getThemePref, setTheme } from './ui.js';
import { t, getLang, setLang } from './i18n.js';

/** 弱口令强制改密（P0 安全）：登录后检测 must_change_pwd 弹窗改密，不可跳过 */
function forceChangePwd(user, token) {
  return new Promise(resolve => {
    const m = modal({
      title: t('🔐 请先修改初始密码'),
      body: `
        <div style="font-size:13px;line-height:1.8;color:var(--text-2);margin-bottom:14px">
          ${t('当前账号使用的是初始/弱口令，为保障平台安全，请设置一个新密码后继续使用。')}<br>
          ${t('要求：至少 6 位，且不能是常见默认口令（如 123456 / admin123）。')}
        </div>
        <div class="form-item"><label>${t('新密码')}</label><input class="input" id="npwd" type="password" autocomplete="new-password" placeholder="${t('输入新密码（≥6 位）')}"></div>
        <div class="form-item"><label>${t('确认新密码')}</label><input class="input" id="npwd2" type="password" autocomplete="new-password" placeholder="${t('再次输入新密码')}"></div>`,
      foot: `<button class="btn primary" id="pwdSave" style="width:100%;justify-content:center">${t('确认修改并进入平台')}</button>`,
      onMount(mask) {
        mask.querySelector('.modal-close').style.display = 'none'; // 不可跳过
        mask.style.onclick = null;
        mask.addEventListener('click', e => e.stopPropagation()); // 禁点遮罩关闭
        const save = mask.querySelector('#pwdSave');
        save.onclick = async () => {
          const p1 = mask.querySelector('#npwd').value.trim();
          const p2 = mask.querySelector('#npwd2').value.trim();
          if (!p1 || p1.length < 6) return toast(t('新密码至少 6 位'), 'err');
          if (p1 !== p2) return toast(t('两次输入的密码不一致'), 'err');
          save.disabled = true; save.textContent = t('提交中…');
          try {
            // 注意：旧密码即当前登录密码（弱口令本身）
            await api('/auth/change-password', { method: 'POST', body: { oldPwd: sessionStorage.getItem('__loginpwd') || '', newPwd: p1 } });
            toast(t('密码已更新，欢迎使用'));
            m.close();
            resolve(true);
          } catch (e) {
            toast(e.message, 'err');
            save.disabled = false; save.textContent = t('确认修改并进入平台');
          }
        };
      },
    });
  });
}

export function render(root) {
  root.innerHTML = `
  <div class="login-wrap">
    <div class="pref-float"><span class="pref-theme">${getTheme() === 'dark' ? '☀️' : '🌙'}</span><span style="width:6px"></span><span class="pref-lang">${getLang() === 'en' ? 'EN' : '中'}</span></div>
    <div class="login-left">
      <div class="logo-row"><span class="mark">A</span>${t('智能体平台')}</div>
      <h1>${t('一站式企业 AI 办公入口')}</h1>
      <p>${t('以企业智能体、数字员工、部门 AI 助理为组合的智能体矩阵，融合知识库检索增强、定时任务调度与多供应商模型接入，让员工无需适配多系统即可通过 AI 高效开展工作。')}</p>
      <div class="login-feats">
        <span>🤖 ${t('智能体矩阵')}</span><span>📚 知识库 RAG</span><span>⏰ ${t('定时任务')}</span><span>🧠 ${t('多模型接入')}</span><span>🛡️ 安全合规</span>
      </div>
    </div>
    <div class="login-card">
      <h2>${t('欢迎登录')}</h2>
      <div class="sub">${t('请使用平台账号登录')}</div>
      <form id="loginForm">
        <div class="form-item">
          <label>${t('账号')}</label>
          <input class="input" id="username" placeholder="${t('请输入账号')}" autocomplete="username" value="admin">
        </div>
        <div class="form-item">
          <label>${t('密码')}</label>
          <input class="input" id="password" type="password" placeholder="${t('请输入密码')}" autocomplete="current-password" value="">
        </div>
        <button class="btn primary" type="submit" style="width:100%;justify-content:center;padding:11px;font-size:14px;margin-top:6px" id="loginBtn">${t('登 录')}</button>
      </form>
      <div class="demo-tip">
        ${t('演示账号')}：<b>admin</b>（${t('管理员')}）/ <b>demo</b>（${t('普通用户')}）<br>
        ${t('初始密码由管理员在后台「用户管理」中设置与重置')}
      </div>
    </div>
  </div>
  <style>
    .pref-float{position:fixed;top:18px;right:20px;z-index:10;display:flex;align-items:center}
    .pref-float button{min-width:38px;height:34px;padding:0 10px;font-size:13px;cursor:pointer;border-radius:8px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff;backdrop-filter:blur(6px);transition:.15s}
    .pref-float button:hover{background:rgba(255,255,255,.24)}
  </style>`;

  // 主题/语言切换（登录页右上角悬浮按钮组；两个 span 占位替换为按钮；P5.23 三态循环）
  const float = root.querySelector('.pref-float');
  const mkBtn = (span, label) => {
    const b = document.createElement('button');
    b.textContent = label;
    span.replaceWith(b);
    return b;
  };
  const THEME_ICON = { auto: '🖥️', light: '☀️', dark: '🌙' };
  const themeBtn = mkBtn(float.querySelector('.pref-theme'), THEME_ICON[getThemePref()]);
  themeBtn.onclick = () => {
    const order = ['auto', 'light', 'dark'];
    setTheme(order[(order.indexOf(getThemePref()) + 1) % 3]);
    themeBtn.textContent = THEME_ICON[getThemePref()];
  };
  mkBtn(float.querySelector('.pref-lang'), getLang() === 'en' ? 'EN' : '中').onclick = () => { setLang(getLang() === 'en' ? 'zh' : 'en'); location.reload(); };

  const form = root.querySelector('#loginForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = root.querySelector('#username').value.trim();
    const password = root.querySelector('#password').value;
    if (!username || !password) return toast(t('请输入账号和密码'), 'err');
    const btn = root.querySelector('#loginBtn');
    btn.disabled = true; btn.textContent = t('登录中…');
    try {
      const j = await api('/auth/login', { method: 'POST', body: { username, password } });
      setLogin(j.data.token, j.data.user);
      if (j.data.must_change_pwd) {
        // P0 弱口令治理：先改密再进入平台（改密接口需要原密码=当前登录密码）
        sessionStorage.setItem('__loginpwd', password);
        await forceChangePwd(j.data.user, j.data.token);
        sessionStorage.removeItem('__loginpwd');
      } else {
        toast(`${t('欢迎回来')}，${j.data.user.nickname || j.data.user.username}`);
      }
      location.hash = '#/home';
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = t('登 录');
    }
  });
}
