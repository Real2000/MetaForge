/** 前台-智能体对话页：#/chat/:id（无 id 则等同首页助手） */
import { api } from '../api.js';
import { mountChat } from '../chat-component.js';
import { esc } from '../ui.js';
import { t } from '../i18n.js';

const AVA = [
  ['#2563eb', '#7c3aed'], ['#059669', '#0d9488'], ['#d97706', '#dc2626'], ['#db2777', '#7c3aed'],
];
const ICONS = ['🤖', '🎯', '📝', '💡', '📊', '🛠️', '🌐', '📚', '✍️', '🧩'];

export async function render(el, params) {
  const id = params[0] ? +params[0] : null;
  // front 布局下的对话页：去掉 .content 的 padding 与滚动（chat-layout 自管高度，避免双滚动条/输入框被裁）
  el.classList.add('chat-fullscreen');
  el.innerHTML = `<div class="empty-box"><div class="big">⏳</div>${t('加载中…')}</div>`;
  let agent = null;
  if (id) {
    const j = await api('/agents');
    agent = j.data.find(a => a.id === id) || null;
    if (!agent) {
      el.innerHTML = `<div class="empty-box"><div class="big">🤖</div>${t('智能体不存在或未发布')}<button class="btn" style="margin-top:12px" onclick="location.hash='#/agents'">${t('返回列表')}</button></div>`;
      return;
    }
  }
  let openingQuestions = [];
  try { openingQuestions = JSON.parse(agent?.opening_questions || '[]'); } catch { }

  mountChat(el, {
    // P5.18 补充：智能体对话页也启用四模式技能栏（与首页一致）——此前仅首页有，
    // 智能体页模型下拉里"切到XX模式"提示却无入口可点，用户被卡住；生成类技能与智能体配置不冲突（skill 走独立生成分支）
    skills: true,
    getAgentId: () => id,
    getAgentBanner: () => agent ? ({
      name: agent.name,
      desc: agent.description || '',
      icon: agent.icon || ICONS[agent.id % ICONS.length],
      color1: AVA[agent.id % AVA.length][0],
      color2: AVA[agent.id % AVA.length][1],
      opening: agent.opening || '',
      openingQuestions,
    }) : {
      name: t('AI 助手'), desc: t('统一对话入口'), icon: '✨',
      opening: t('您好！我是平台统一 AI 助手，请问有什么可以帮您？'),
      openingQuestions: [t('帮我写一份周报'), t('解释什么是大模型温度参数')],
    },
    // 用户提示词（SinguX 式预置指令）：新会话自动填入输入框
    getUserPrompt: () => agent?.user_prompt || '',
    // 空状态只展示欢迎区，不重复渲染顶部横幅（banner 已展示名称/描述）
    hideTopBanner: true,
    // 「允许用户选择自有模型」关闭时隐藏模型下拉，锁定智能体配置的模型
    allowModelSwitch: () => id ? (agent ? agent.allow_user_model !== 0 : true) : true,
  });
}
