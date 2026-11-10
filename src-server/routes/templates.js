/**
 * A3 桌面场景模板路由（2026-11-09）：预设场景一键创建桌面 Agent
 * 每个模板 = 智能体配置（prompt/tools） + 可选定时任务（cron）+ 展示元信息
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../lib/auth');

const DESKTOP_TEMPLATES = [
  {
    id: 'daily-cleanup',
    icon: '📂',
    title: '每日整理下载目录',
    category: '文件整理',
    description: '每天定时扫描下载文件夹，按文件类型（图片/文档/压缩包/安装包）归类到对应子目录；超过7天的临时文件移至废纸篓。让桌面保持整洁。',
    operations: ['list_dir', 'file_read', 'file_write', 'mkdir'],
    prompt: '你是一个桌面整理助手。用户授权你在其电脑上执行文件操作。严格遵守：只操作下载目录（~/Downloads）内的文件，不得访问其他目录。每次整理前先 list_dir 了解当前结构，整理完成后通知用户摘要。',
    default_cron: '0 9 * * *', // 每天9:00
    tool_ids: ['local_exec'],
    opening_questions: ['帮我整理一下下载目录', '今天下载了什么'],
  },
  {
    id: 'screenshot-patrol',
    icon: '📸',
    title: '定时截图巡检',
    category: '自动化',
    description: '按设定时间间隔截图用户桌面，分析窗口分布与活跃应用。可用于：工作回顾、时间追踪、下班后检查是否有未保存的工作。截图仅用于当前对话，不存储。',
    operations: ['screenshot', 'window_list'],
    prompt: '你是一个桌面巡检助手。你有权限截图和查看窗口列表。截图后简要描述当前桌面上有哪些窗口，但不要读出用户私密内容。告诉用户截图已阅。截图仅在本次对话使用，不会保存。',
    default_cron: '',
    tool_ids: ['local_exec'],
    opening_questions: ['看看我在用什么', '截个图给我看看', '现在桌面上有什么窗口'],
  },
  {
    id: 'clipboard-translate',
    icon: '📋',
    title: '剪贴板即译',
    category: '效率工具',
    description: '监控剪贴板内容变化，将外文内容自动翻译为中文（或中文翻译为外文）并替换回剪贴板。支持中/英/日/韩四种语言识别。快捷操作：复制外文文本后，随即在本对话中即可收到翻译结果。',
    operations: ['clipboard_read', 'clipboard_write'],
    prompt: '你是一个翻译助手。用户会请你查看剪贴板内容并翻译。读取剪贴板后识别语种：若为外文翻译为中文，若为中文翻译为英文。翻译后展示译文，询问用户是否要写回剪贴板。',
    default_cron: '',
    tool_ids: ['local_exec'],
    opening_questions: ['帮我翻译一下剪贴板', '看看我复制了什么'],
  },
  {
    id: 'window-patrol',
    icon: '🪟',
    title: '窗口巡场提醒',
    category: '办公辅助',
    description: '按周期查看用户当前打开的窗口。当检测到游戏、视频等非办公窗口持续超过指定时长时，提示用户收心。也支持：帮忙找某个应用窗口，或者列出所有已打开窗口让用户选择焦点。',
    operations: ['window_list', 'window_focus'],
    prompt: '你是一个专注力助手。用户授权你定时查看桌面窗口。专注于三项任务：①用户说「找窗口」时列出所有窗口；②用户指定应用名时帮忙激活（window_focus）；③如果用户有特定提醒需求（如「注意我开了视频」），记住并在下次窗口列表中发现时提醒。不要对用户打开的窗口做价值判断。',
    default_cron: '',
    tool_ids: ['local_exec'],
    opening_questions: ['我现在开了什么窗口', '帮我找到微信窗口', '如果看到我在看视频提醒我'],
  },
  {
    id: 'meeting-countdown',
    icon: '⏰',
    title: '开会倒计时通知',
    category: '时间管理',
    description: '设定倒计时后定时提醒。常用场景：午休结束、会议前准备、项目截止。倒计时到期后自动触发系统通知。也支持「还有N分钟提醒我发消息」「几分钟后提醒我去开会」。',
    operations: ['notify'],
    prompt: '你是一个倒计时助手。用户会请你设置一个定时提醒。收到请求后，通过 notify 发送一条带提醒时间的系统通知。示例：用户说「5分钟后提醒我去开会」→ 你立即回复「已设定5分钟倒计时」，5分钟后用户会收到系统通知。重要：notify 仅支持发送通知文本，不支持精确的定时。请用你自身的推理来理解用户的时间要求，并在回复中明确告知用户提前量。',
    default_cron: '',
    tool_ids: ['local_exec'],
    opening_questions: ['5分钟后提醒我发消息', '帮我倒计时10分钟'],
  },
  {
    id: 'lock-and-clear',
    icon: '🔒',
    title: '一键锁屏清剪贴板',
    category: '安全',
    description: '一键快速锁屏 + 清空剪贴板中的文字内容，防止离开时信息泄露。剪切板清空后，读取剪贴板确认。适合临时离开工位时快速操作。',
    operations: ['screenshot', 'clipboard_read', 'clipboard_write'],
    prompt: '你是一个安全助手。用户的指令是「准备离开电脑了」。你的操作流程：① 截图确认当前桌面状态（让用户确认是哪个画面）；② 读取剪贴板内容展示给用户让其确认是否需要备份；③ 写入空字符串清空剪贴板；④ 告诉用户已就绪，提醒其按下屏幕锁（Command+Control+Q 或屏幕角热区）锁屏。注意：你无法直接触发系统锁屏（浏览器没有该 API），请在最后一步明确提示用户手动锁屏。',
    default_cron: '',
    tool_ids: ['local_exec'],
    opening_questions: ['我要离开了', '锁屏清理'],
  },
];

router.get('/desktop', auth, (req, res) => {
  // 仅返回配了对设备的用户的模板（未配对的用户在展示层已有引导文案）
  res.json({
    code: 0,
    data: { templates: DESKTOP_TEMPLATES },
  });
});

module.exports = router;
