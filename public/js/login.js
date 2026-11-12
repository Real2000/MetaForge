import { api, setLogin } from './api.js';
import { esc, toast, modal } from './ui.js';
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
            // P2-3 连带修复（2026-11-09）：①路径修正 /auth/login/change-password（原 /auth/change-password 恒 404，
            // 因 must_change_pwd 标记长期失效该死链从未暴露）；②改密会吊销旧 token 并重新签发——前端同步更新凭据
            const j2 = await api('/auth/login/change-password', { method: 'POST', body: { oldPwd: sessionStorage.getItem('__loginpwd') || '', newPwd: p1 } });
            if (j2.data?.token) setLogin(j2.data.token, user); // 后端吊销旧 token 后签发的新凭据（Cookie 已同步换新）
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
  // #14（2026-11-03）钉钉扫码回跳：URL hash 中的 60s 一次性 dingtalk_code POST 换 JWT（JSON body 交付，
  // token 不落 URL/历史）。码一次性消费：先清 URL 再请求（刷新不重放报错），失败落回正常登录表单。
  const mCode = /dingtalk_code=([0-9a-f]{64})/.exec(location.hash);
  if (mCode) {
    const code = mCode[1];
    history.replaceState(null, '', '#/login'); // 立即清 URL（码一次性，留在地址栏刷新必 401）
    (async () => {
      try {
        const j = await api('/auth/dingtalk/exchange', { method: 'POST', body: { code } });
        setLogin(j.data.token, j.data.user);
        toast(`${t('欢迎回来')}，${j.data.user.nickname || j.data.user.username}`);
        location.hash = '#/home';
      } catch (e) {
        toast(e.message, 'err'); // 交换码过期/已用 → 落回正常登录表单（下方表单已渲染）
      }
    })();
  }

  root.innerHTML = `
  <div class="login-wrap">
    <div class="pref-float"><span class="pref-lang">${getLang() === 'en' ? 'EN' : '中'}</span></div>
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
      <button class="btn" id="dtH5Btn" style="width:100%;justify-content:center;padding:10px;font-size:13px;margin-top:10px;display:none">📱 ${t('钉钉免登（演示）')}</button>
      <div id="ssoBtnArea" style="display:none;margin-top:12px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span style="flex:1;height:1px;background:rgba(255,255,255,.2)"></span><span style="font-size:11px;color:var(--text-3,#9ca3af)">${t('或')}</span><span style="flex:1;height:1px;background:rgba(255,255,255,.2)"></span></div><button class="btn" id="ssoBtn" style="width:100%;justify-content:center;padding:10px;font-size:13px">🏢 ${t('企业登录')}</button></div>
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

  // 语言切换（登录页右上角悬浮按钮；span 占位替换为按钮）
  const float = root.querySelector('.pref-float');
  const mkBtn = (span, label) => {
    const b = document.createElement('button');
    b.textContent = label;
    span.replaceWith(b);
    return b;
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

  // V3.1 #11 钉钉 H5 免登（2026-11-03）：mock 模式（凭证未配置）显示演示按钮——POST /dingtalk/h5/login
  // 直登 demo 账号验证免登链路（JWT 走 JSON body，#14 同款安全交付）；真实模式按钮隐藏（待 JSAPI 联调阶段接线）
  (async () => {
    try {
      const j = await api('/dingtalk/h5/config', { rawResponse: true });
      if (j.code !== 0 || !j.data?.mock) return;
      const btn = root.querySelector('#dtH5Btn');
      btn.style.display = 'flex';
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = t('免登中…');
        try {
          const r = await api('/dingtalk/h5/login', { method: 'POST', body: { mock_user: 'demo' } });
          setLogin(r.data.token, r.data.user);
          toast(`${t('欢迎回来')}，${r.data.user.nickname || r.data.user.username}（${t('钉钉免登演示')}）`);
          location.hash = '#/home';
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          btn.disabled = false; btn.textContent = `📱 ${t('钉钉免登（演示）')}`;
        }
      };
    } catch { /* config 不可达时静默（登录页核心是密码登录） */ }
  })();

  // P1-1 SSO/OIDC 企业登录：查询已启用的 SSO 提供方，有则显示按钮
  (async () => {
    try {
      const j = await api('/auth/sso/providers', { rawResponse: true });
      if (j.code !== 0 || !Array.isArray(j.data) || !j.data.length) return;
      const area = root.querySelector('#ssoBtnArea');
      if (!area) return;
      area.style.display = 'block';
      const btn = root.querySelector('#ssoBtn');
      if (!btn) return;
      const name = j.data[0].display_name || j.data[0].name;
      btn.textContent = `🏢 ${t('企业登录')}（${name}）`;
      btn.onclick = () => {
        // 跳转到 SSO 授权页（OAuth2 authorize 端点）
        window.location.href = `/api/auth/sso/authorize?provider_id=${j.data[0].id}&redirect=${encodeURIComponent(location.href)}`;
      };
    } catch { /* SSO 服务不可用时静默 */ }
  })();
}
