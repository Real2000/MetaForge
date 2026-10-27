/** 对外价格页 #/pricing（免登录）：三档套餐展示 + 升级引导 CTA + 企业定制表单
 *  免登录访问（路由 public:true），已登录用户按钮直达控制台/账单。
 */
import { api, getToken, getUser } from '../api.js';
import { esc, toast, modal } from '../ui.js';

export async function render(el) {
  let plans = [];
  try { plans = (await api('/biz/plans')).data; } catch { }
  const logged = !!getToken();
  const user = getUser() || {};
  const myPlan = logged ? user.plan || 'free' : null;

  el.innerHTML = `
  <style>
    .pr-wrap{min-height:100vh;background:linear-gradient(180deg,#f8faff 0%,#fff 340px)}
    .pr-nav{display:flex;align-items:center;justify-content:space-between;padding:18px 6%;background:#fff;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
    .pr-nav .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;color:var(--text)}
    .pr-hero{text-align:center;padding:64px 6% 40px}
    .pr-hero h1{font-size:32px;margin-bottom:12px}
    .pr-hero p{color:var(--text-2);font-size:15px;line-height:1.8}
    .pr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;padding:10px 6% 30px;max-width:1200px;margin:0 auto}
    .pr-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px 24px;display:flex;flex-direction:column;position:relative;transition:.15s}
    .pr-card:hover{box-shadow:0 12px 36px rgba(37,99,235,.1);transform:translateY(-3px)}
    .pr-card.hot{border:2px solid var(--brand);box-shadow:0 12px 36px rgba(37,99,235,.14)}
    .pr-hot{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--brand);color:#fff;font-size:11px;padding:3px 12px;border-radius:999px;white-space:nowrap}
    .pr-name{font-size:16px;font-weight:700}
    .pr-tag{font-size:12px;color:var(--text-3);margin-top:4px}
    .pr-price{margin:16px 0 4px;display:flex;align-items:baseline;gap:4px}
    .pr-price b{font-size:34px;color:var(--text)}
    .pr-price span{font-size:12px;color:var(--text-3)}
    .pr-ul{list-style:none;margin:14px 0 20px;flex:1}
    .pr-ul li{font-size:13px;color:var(--text-2);line-height:2;padding-left:22px;position:relative}
    .pr-ul li::before{content:'✓';position:absolute;left:0;color:#16a34a;font-weight:700}
    .pr-ul li.no::before{content:'—';color:#d1d5db}
    .pr-ul li.no{color:var(--text-3)}
    .pr-cta{width:100%;justify-content:center;padding:11px;font-size:14px}
    .pr-faq{max-width:820px;margin:30px auto 60px;padding:0 6%}
    .pr-contact{background:linear-gradient(135deg,#0b1733,#1e3a8a);color:#fff;border-radius:20px;padding:40px 6%;margin:0 4% 60px}
    .pr-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:20px}
    .pr-form .full{grid-column:1/-1}
    @media (max-width:768px){ .pr-hero h1{font-size:24px} .pr-grid{grid-template-columns:1fr} }
  </style>
  <div class="pr-nav">
    <div class="logo"><span class="mark" style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;color:#fff">A</span>智能体平台</div>
    <div style="display:flex;gap:10px">
      ${logged
        ? `<a class="btn sm" href="#/home">进入控制台</a>`
        : `<a class="btn sm" href="#/login">登录</a><a class="btn sm primary" href="#/login">免费开始</a>`}
    </div>
  </div>

  <div class="pr-hero">
    <h1>选择适合你的套餐</h1>
    <p>从个人体验到企业级部署，按需选择——所有套餐均含知识库 RAG、多模型接入与技能系统</p>
    ${logged && myPlan ? `<div style="margin-top:10px"><span class="tag blue">当前套餐：${plans.find(p => p.key === myPlan)?.name || '免费版'}</span></div>` : ''}
  </div>

  <div class="pr-grid">
    ${plans.map(p => `
    <div class="pr-card ${p.highlight ? 'hot' : ''}">
      ${p.highlight ? '<span class="pr-hot">🔥 最受欢迎</span>' : ''}
      <div class="pr-name">${esc(p.name)}</div>
      <div class="pr-tag">${esc(p.tagline)}</div>
      <div class="pr-price"><b>${esc(p.priceLabel)}</b><span>/ ${esc(p.period)}</span></div>
      <ul class="pr-ul">
        ${p.features.map(f => `<li>${esc(f)}</li>`).join('')}
        ${p.notIncluded.map(f => `<li class="no">${esc(f)}</li>`).join('')}
      </ul>
      ${p.contactSales
        ? `<button class="btn pr-cta" data-contact>联系销售定制方案</button>`
        : p.key === 'free'
          ? `<a class="btn pr-cta" href="#${logged ? '/home' : '/login'}">${logged ? '开始使用' : '免费开始'}</a>`
          : `<button class="btn primary pr-cta" data-upgrade="${p.key}">升级${esc(p.name)}</button>`}
    </div>`).join('')}
  </div>

  <div class="pr-faq">
    <h3 style="margin-bottom:14px">常见问题</h3>
    ${[
      ['Token 是什么？怎么计费的？', 'Token 是模型处理文本的计量单位，1 个中文字约 1.5~2 个 Token。对话、图片生成、知识库检索各环节消耗统一计入月度额度。'],
      ['免费版到期会怎样？', '免费版永久有效，不会到期。月度 Token 用尽后当月暂停对话，次月自动恢复；智能体与知识库配置始终保留。'],
      ['升级后额度立即生效吗？', '是。升级专业版后额度即时放大，历史会话与智能体全部保留，无需迁移。'],
      ['可以开发票吗？', '可以。专业版与企业版支持在线申请发票（增值税普通/专用发票），在「账单与发票」页提交抬头即可。'],
    ].map(([q, a]) => `
    <details style="border:1px solid #eef0f4;border-radius:12px;margin-bottom:10px;background:#fff">
      <summary style="cursor:pointer;padding:14px 16px;font-size:13.5px;font-weight:600">${esc(q)}</summary>
      <div style="padding:0 16px 14px;font-size:13px;line-height:1.9;color:var(--text-2)">${esc(a)}</div>
    </details>`).join('')}
  </div>

  <div class="pr-contact" id="contact">
    <div style="max-width:900px;margin:0 auto">
      <h2 style="font-size:22px;margin-bottom:8px">需要定制化方案？</h2>
      <p style="color:#bfdbfe;font-size:14px;line-height:1.8">私有化部署、专属算力通道、SLA 保障与企业级集成——留下需求，销售顾问 1 个工作日内联系你。</p>
      <div class="pr-form">
        <input class="input" id="cCompany" placeholder="公司名称 *" style="background:rgba(255,255,255,.96)">
        <input class="input" id="cName" placeholder="联系人 *" style="background:rgba(255,255,255,.96)">
        <input class="input" id="cPhone" placeholder="手机号" style="background:rgba(255,255,255,.96)">
        <input class="input" id="cEmail" placeholder="邮箱" style="background:rgba(255,255,255,.96)">
        <select class="input" id="cScale" style="background:rgba(255,255,255,.96)">
          <option value="">企业规模（可选）</option>
          <option>1-50 人</option><option>50-200 人</option><option>200-1000 人</option><option>1000 人以上</option>
        </select>
        <textarea class="input full" id="cDemand" rows="3" placeholder="需求描述：如智能客服、招标文件解析、私有化部署…" style="background:rgba(255,255,255,.96);resize:vertical"></textarea>
        <button class="btn primary full" id="cSubmit" style="justify-content:center;padding:11px">提交需求，等待顾问联系</button>
      </div>
    </div>
  </div>`;

  // 升级按钮（已登录引导至控制台升级确认；未登录先去登录）
  el.querySelectorAll('[data-upgrade]').forEach(b => b.onclick = () => {
    if (!logged) { toast('请先登录再升级', 'info'); location.hash = '#/login'; return; }
    modal({
      title: `升级 ${plans.find(p => p.key === b.dataset.upgrade)?.name || '专业版'}`,
      body: `<div style="font-size:13px;line-height:1.9;color:var(--text-2)">当前版本为演示环境，未接入在线支付。<br>提交后平台管理员会为你开通对应套餐（或在「企业定制」表单留下联系方式）。<br><br>已登录账号：<b style="color:var(--text)">${esc(user.nickname || user.username)}</b></div>`,
      foot: `<button class="btn" data-close>取消</button><button class="btn primary" data-go>提交升级申请</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelector('[data-go]').onclick = async () => {
          try {
            await api('/feedback', { method: 'POST', body: { type: 'consult', content: `【升级申请】希望升级至${b.dataset.upgrade === 'pro' ? '专业版（¥199/月）' : '企业版'}`, contact: user.username } });
            close(); toast('升级申请已提交，管理员将通过站内信联系你');
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  });

  // 企业定制表单（免登录提交线索）
  const submitBtn = el.querySelector('#cSubmit');
  submitBtn.onclick = async () => {
    const body = {
      company: el.querySelector('#cCompany').value.trim(),
      contact_name: el.querySelector('#cName').value.trim(),
      phone: el.querySelector('#cPhone').value.trim(),
      email: el.querySelector('#cEmail').value.trim(),
      scale: el.querySelector('#cScale').value,
      demand: el.querySelector('#cDemand').value.trim(),
    };
    if (!body.company || !body.contact_name) return toast('请填写公司名称与联系人', 'err');
    if (!body.phone && !body.email) return toast('请至少留一个联系方式', 'err');
    submitBtn.disabled = true; submitBtn.textContent = '提交中…';
    try {
      const j = await api('/biz/lead', { method: 'POST', body });
      toast(j.msg || '已提交');
      ['cCompany', 'cName', 'cPhone', 'cEmail', 'cDemand'].forEach(id => el.querySelector('#' + id).value = '');
    } catch (e) { toast(e.message, 'err'); }
    submitBtn.disabled = false; submitBtn.textContent = '提交需求，等待顾问联系';
  };

  // 锚点跳转（联系销售按钮滚到表单）
  el.querySelectorAll('[data-contact]').forEach(b => b.onclick = () => el.querySelector('#contact').scrollIntoView({ behavior: 'smooth' }));
}
