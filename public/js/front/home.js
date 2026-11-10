/** 前台首页：统一 AI 对话入口（多模态创作：对话/图片/视频/PPT）+ 首次登录新手引导 */
import { api, getUser } from '../api.js';
import { mountChat } from '../chat-component.js';
import { esc, toast, modal } from '../ui.js';
import { t } from '../i18n.js';

/** 新手引导（2026-10-20 帮助体系）：3 步走（创建智能体 → 上传知识库 → 开始对话）
 *  仅首次登录弹一次（users.onboarded 标记，完成/跳过均标记） */
function showOnboarding() {
  const STEPS = [
    {
      ic: '🤖', title: t('创建你的智能体'), desc: t('后台「智能体管理」创建并编排——提示词定义能力，选择模型，配置开场白；也可以到广场一键复制现成的智能体'),
      btn: t('前往创建'), href: '#/admin/agents',
    },
    {
      ic: '📚', title: t('上传知识库'), desc: t('把公司制度、产品文档传到「知识库」，智能体关联后回答自带引用来源——这是让 AI 说「行话」的关键一步'),
      btn: t('前往上传'), href: '#/knowledge',
    },
    {
      ic: '💬', title: t('开始对话'), desc: t('到广场或直接在本页开始使用：支持知识库检索、多模型切换、技能调用与图片/视频/PPT 生成'),
      btn: t('开始体验'), href: '#/home',
    },
  ];
  let cur = 0;
  const m = modal({
    title: t('👋 欢迎使用智能体平台'),
    body: `<div id="obBody"></div>`,
    foot: `<button class="btn" id="obSkip" style="color:var(--text-3)">${t('跳过引导')}</button>
           <button class="btn" id="obPrev">${t('上一步')}</button>
           <button class="btn primary" id="obNext">${t('下一步')}</button>`,
    onMount(mask, close) {
      const render = () => {
        const s = STEPS[cur];
        mask.querySelector('#obBody').innerHTML = `
          <style>
            .ob-dot{display:flex;gap:6px;justify-content:center;margin-bottom:18px}
            .ob-dot i{width:8px;height:8px;border-radius:50%;background:#e5e7eb}
            .ob-dot i.on{background:#2563eb;width:20px;border-radius:999px}
          </style>
          <div class="ob-dot">${STEPS.map((_, i) => `<i class="${i === cur ? 'on' : ''}"></i>`).join('')}</div>
          <div style="text-align:center">
            <div style="font-size:46px">${s.ic}</div>
            <div style="font-size:16px;font-weight:700;color:var(--text);margin-top:8px">第 ${cur + 1} 步 · ${esc(s.title)}</div>
            <div style="font-size:13px;color:var(--text-2);line-height:1.9;margin:10px 0 4px;padding:0 12px">${esc(s.desc)}</div>
            <a href="${s.href}" id="obGo" class="btn primary" style="margin-top:10px">${s.btn} →</a>
          </div>`;
        mask.querySelector('#obPrev').style.visibility = cur === 0 ? 'hidden' : '';
        mask.querySelector('#obNext').textContent = cur === STEPS.length - 1 ? t('完成引导') : t('下一步');
        const go = mask.querySelector('#obGo');
        go.onclick = () => { markDone(); close(); };
      };
      const markDone = async () => {
        try { await api('/auth/onboarding', { method: 'POST' }); } catch { }
      };
      mask.querySelector('#obSkip').onclick = () => { markDone(); close(); };
      mask.querySelector('#obPrev').onclick = () => { if (cur > 0) { cur--; render(); } };
      mask.querySelector('#obNext').onclick = () => {
        if (cur < STEPS.length - 1) { cur++; render(); }
        else { markDone(); close(); toast(t('引导完成，祝你使用愉快！')); }
      };
      render();
    },
  });
}

export async function render(el) {
  // front 布局下的对话页：去掉 .content 的 padding 与滚动（chat-layout 自管高度，避免双滚动条/输入框被裁）
  el.classList.add('chat-fullscreen');
  el.innerHTML = `<div class="empty-box"><div class="big">⏳</div>${t('加载中…')}</div>`;
  mountChat(el, {
    skills: true,
    getAgentId: () => null, // 首页助手，不绑定智能体
    // P5.28 四大核心场景（对齐星辰超级智能体）：整理文件 / 深度调研 / 文档PPT / 代码应用
    getAgentBanner: () => ({
      name: t('AI 助手'),
      desc: t('能干可靠的 AI 办公搭子 · 整理文件 / 深度调研 / 文档PPT / 代码应用'),
      icon: '✨',
      opening: `${t('您好！我是平台 AI 助手——能干可靠的 AI 办公搭子。')}\n\n🗂️ ${t('整理文件')} · 📋 ${t('Word/Excel 信息提取、汇总脑图')}\n🔭 ${t('深度调研')} · 📰 ${t('行业资讯抓取、7×24h 监控')}\n📝 ${t('文档 PPT')} · 📊 ${t('撰写报告、一键成稿')}\n💻 ${t('代码应用')} · ⚡ ${t('定制脚本、生成小应用')}\n\n${t('📎 传文件 · ✨ 选技能 · 🎓 指定专家 · 输入需求即可开始。')}`,
      openingQuestions: [
        t('📎 我传一份 Excel，帮我提取关键信息并汇总成脑图'),
        t('🔭 帮我调研最近一周 AI Agent 行业动态，并持续监控'),
        t('📊 写一份季度工作总结报告（Word）'),
        t('💻 用代码生成一个数据看板演示页面'),
      ],
    }),
    // 空状态只展示欢迎区，不重复渲染顶部横幅（banner 已展示名称/描述）
    hideTopBanner: true,
  });

  // 首次登录新手引导（localStorage 里的用户对象可能早于本功能，以 /auth/me 实时为准）
  try {
    const me = await api('/auth/me');
    if (me.data && !me.data.onboarded) showOnboarding();
  } catch { /* 接口异常不阻塞首页 */ }
}
