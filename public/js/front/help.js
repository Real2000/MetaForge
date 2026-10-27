/** 前台-帮助中心（2026-10-20 帮助体系）：快速开始 / FAQ / 图文教程 / 文档链接 / 反馈入口 */
import { api } from '../api.js';
import { esc, toast, modal } from '../ui.js';

const FAQS = [
  {
    q: '怎么创建自己的智能体？',
    a: '两种方式：① 进入后台「智能体管理」→「创建智能体」，在编排页配置提示词、模型、开场白与工具；② 在「广场」找到喜欢的智能体，点「⧉ 复制」一键复制为草稿再修改。创建完成后在编排页发布，即可在广场与对话中使用。',
    link: { href: '#/admin/agents', label: '前往智能体管理' },
  },
  {
    q: '知识库怎么用？怎么让 AI 回答公司制度类问题？',
    a: '在前台「知识库」创建知识库 → 上传制度文档（TXT / PDF / DOCX）→ 系统自动分块与向量化。然后在智能体编排页关联该知识库，对话时 AI 会先检索相关片段再作答，并附引用来源角标（点击可展开原文）。',
    link: { href: '#/knowledge', label: '前往知识库' },
  },
  {
    q: 'API 怎么调用？在哪里拿密钥？',
    a: '后台「接入管理」→ 创建 API Key（鉴权方式选 OpenAI 兼容），然后以 Bearer Key 调用 POST /openapi/chat/completions，body 与 OpenAI Chat API 一致（model 填发布时绑定的模型标识）。接口与密钥管理在接入管理页有完整示例与限流说明（每 Key 60 秒 20 次）。',
    link: { href: '#/admin/access', label: '前往接入管理' },
  },
  {
    q: '怎么接入我自己的模型（个人网关 / 第三方中转）？',
    a: '前台「我的模型」→「＋ 接入模型源」：填 OpenAI 兼容服务地址与 API Key、模型清单。保存后对话下拉即可选用（标注「我的」），同名模型优先走你的自有渠道，Key 仅本人可见。每人最多 10 个模型源。',
    link: { href: '#/models', label: '前往我的模型' },
  },
  {
    q: 'Token 配额是什么？用完了怎么办？',
    a: '平台为每个用户计量 Token 用量（对话页右上角常驻「本月已用 / 配额」）。配额不限的用户显示「不限额」；受限用户达到 80% / 90% 时会收到站内信预警，用尽后将无法继续对话。需要调整请联系管理员（后台「用量与配额」页可设置）。',
    link: { href: '#/tasks', label: '查看定时任务' },
  },
  {
    q: '技能是什么？怎么用？',
    a: '技能是可复用的「提示词 + 工具」组合（如周报专家、小红书文案）。在「技能」页创建后，对话输入框输入 @技能名（或点「✨ 技能」按钮选择）即可调用——技能的提示词与工具会自动注入本轮对话。发布后的技能他人也可引用。',
    link: { href: '#/skills', label: '前往技能' },
  },
  {
    q: '忘记密码 / 想修改密码怎么办？',
    a: '已登录：点顶栏 🔑 按钮自助修改（需验证原密码）。忘记密码或新账号初始密码问题：联系管理员在后台「用户管理」重置——重置后你首次登录时会被要求设置新密码。',
    link: { href: '#/admin/users', label: '管理员：用户管理' },
  },
  {
    q: '怎么搜索历史会话？怎么把智能体分享给同事？',
    a: '会话搜索：对话页左侧栏搜索框，支持按标题或消息内容实时过滤。分享智能体：编排页开启「分享链接」，把链接发给同事即可免登录对话（按 IP 限流）；也可在广场发布让全员可见。',
    link: { href: '#/square', label: '前往广场' },
  },
];

const TUTORIALS = [
  {
    ic: '🚀', title: '5 分钟上手：创建第一个智能体', time: '图文 · 4 步',
    steps: [
      '进入后台「智能体管理」→「创建智能体」，填写名称、图标与简介',
      '在编排页写提示词（角色定义 + 任务要求 + 输出格式），选择模型（如 Qwen3-VL）',
      '可选：配置开场白与开场问题，让对话开场更友好',
      '点「发布」上架——到前台「广场」或直接进入对话页开始使用',
    ],
  },
  {
    ic: '📚', title: '知识库实操：让 AI 精准回答公司制度', time: '图文 · 4 步',
    steps: [
      '前台「知识库」→ 新建知识库（如「公司制度」）',
      '上传制度文档（差旅报销、考勤、请假流程等，支持 TXT/PDF/DOCX）',
      '在智能体编排页关联该知识库——对话时自动检索增强（RAG）',
      '提问试试：「出差住宿报销标准是多少？」——回答会附引用来源，点击角标查看原文',
    ],
  },
  {
    ic: '🔌', title: 'API 集成：把智能体接进你的系统', time: '图文 · 3 步',
    steps: [
      '后台「接入管理」→ 创建 API Key（OpenAI 兼容鉴权）',
      '调用 POST /openapi/chat/completions，Header 带 Authorization: Bearer 你的Key',
      'Body 按 OpenAI 格式传 model 与 messages——流式/非流式均支持，限流 20 次/分钟',
    ],
  },
];

export async function render(el) {
  el.innerHTML = `
  <style>
    .hp-hero{background:linear-gradient(135deg,#eff6ff,#f5f3ff);border:1px solid #dbeafe;border-radius:14px;padding:26px 28px;margin-bottom:16px}
    .hp-hero h2{margin:0 0 6px;font-size:20px}
    .hp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
    .hp-step{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:16px;position:relative}
    .hp-step .no{position:absolute;top:-10px;left:14px;background:#2563eb;color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px}
    .hp-faq{margin-top:4px}
    .hp-faq details{border:1px solid #eef0f4;border-radius:12px;margin-bottom:10px;background:#fff;overflow:hidden}
    .hp-faq summary{cursor:pointer;padding:14px 16px;font-size:13.5px;font-weight:600;color:var(--text);list-style:none;display:flex;align-items:center;gap:10px}
    .hp-faq summary::-webkit-details-marker{display:none}
    .hp-faq summary::after{content:'＋';margin-left:auto;color:#9ca3af;font-size:16px}
    .hp-faq details[open] summary::after{content:'－'}
    .hp-faq details[open] summary{border-bottom:1px dashed #f1f3f7;background:#f8faff}
    .hp-faq .a{padding:14px 16px;font-size:13px;line-height:1.9;color:var(--text-2)}
    .hp-tutos{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
    .hp-tuto{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:18px 16px;cursor:pointer;transition:.15s;position:relative}
    .hp-tuto:hover{box-shadow:0 8px 24px rgba(37,99,235,.09);transform:translateY(-2px);border-color:#dbeafe}
    .hp-play{width:38px;height:38px;border-radius:10px;background:#f0f6ff;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:10px}
    .hp-docs{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
    .hp-doc{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:12px 14px;cursor:pointer;font-size:13px;color:var(--text);transition:.15s}
    .hp-doc:hover{border-color:#93c5fd;color:#2563eb}
  </style>
  <div class="page-head">
    <h2>帮助中心</h2>
    <div class="desc">快速上手、常见问题与图文教程——遇到问题先来这里，解决不了随时反馈给我们。</div>
  </div>

  <div class="hp-hero">
    <h2>🚀 三步开启你的 AI 助手</h2>
    <div style="font-size:13px;color:var(--text-2)">从零到对话，只需要三步</div>
    <div class="hp-steps">
      <div class="hp-step"><span class="no">第 1 步</span><b>创建智能体</b><div style="font-size:12px;color:var(--text-3);margin-top:6px;line-height:1.7">后台「智能体管理」创建并编排：提示词 + 模型 + 开场白</div><a class="btn sm" style="margin-top:10px" href="#/admin/agents">去创建 →</a></div>
      <div class="hp-step"><span class="no">第 2 步</span><b>上传知识库</b><div style="font-size:12px;color:var(--text-3);margin-top:6px;line-height:1.7">前台「知识库」上传公司文档，智能体关联后精准作答</div><a class="btn sm" style="margin-top:10px" href="#/knowledge">去上传 →</a></div>
      <div class="hp-step"><span class="no">第 3 步</span><b>开始对话</b><div style="font-size:12px;color:var(--text-3);margin-top:6px;line-height:1.7">到广场或对话页开始使用，支持多模态与技能调用</div><a class="btn sm" style="margin-top:10px" href="#/home">去对话 →</a></div>
    </div>
  </div>

  <div class="card" style="padding:16px 18px">
    <h3 style="margin:0 0 12px">📖 常见问题（FAQ）</h3>
    <div class="hp-faq">
      ${FAQS.map((f, i) => `
      <details ${i === 0 ? 'open' : ''}>
        <summary>Q${i + 1}：${esc(f.q)}</summary>
        <div class="a">${esc(f.a)}${f.link ? ` <a href="${f.link.href}" style="color:#2563eb;font-weight:600">${f.link.label} →</a>` : ''}</div>
      </details>`).join('')}
    </div>
  </div>

  <div class="card" style="padding:16px 18px;margin-top:14px">
    <h3 style="margin:0 0 12px">🎬 图文教程</h3>
    <div class="hp-tutos" id="tutos">
      ${TUTORIALS.map((t, i) => `
      <div class="hp-tuto" data-t="${i}">
        <div class="hp-play">${t.ic}</div>
        <b style="font-size:13.5px">${esc(t.title)}</b>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">${t.time} · 点击展开</div>
      </div>`).join('')}
    </div>
  </div>

  <div class="card" style="padding:16px 18px;margin-top:14px">
    <h3 style="margin:0 0 12px">🔗 相关文档与入口</h3>
    <div class="hp-docs">
      <a class="hp-doc" href="#/admin/access">🔌 API 接入文档</a>
      <a class="hp-doc" href="#/admin/models">🧠 模型接入管理</a>
      <a class="hp-doc" href="#/models">🧩 我的模型</a>
      <a class="hp-doc" href="#/admin/quota">💳 用量与配额说明</a>
      <a class="hp-doc" href="#/skills">✨ 技能使用指南</a>
      <a class="hp-doc" href="#/admin/users">👥 账号与密码</a>
    </div>
  </div>

  <div class="card" style="padding:16px 18px;margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,#fffbeb,#fef3c7);border-color:#fde68a">
    <div>
      <b style="font-size:14px">💬 没找到答案？</b>
      <div style="font-size:12px;color:var(--text-3);margin-top:4px">提交意见反馈（Bug / 建议 / 咨询），管理员处理后会通过站内通知回复你</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn" id="askAI">🤖 问 AI 助手</button>
      <button class="btn primary" id="goFeedback">💬 提交反馈</button>
    </div>
  </div>`;

  // 图文教程弹窗
  el.querySelectorAll('.hp-tuto').forEach(card => card.onclick = () => {
    const t = TUTORIALS[+card.dataset.t];
    modal({
      title: `${t.ic} ${t.title}`,
      body: `
        <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">${t.time}</div>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:2.2;color:var(--text)">
          ${t.steps.map(s => `<li style="margin-bottom:4px">${esc(s)}</li>`).join('')}
        </ol>`,
      foot: `<button class="btn" data-close>关闭</button>`,
      onMount(mask, close) { mask.querySelector('[data-close]').onclick = close; },
    });
  });

  el.querySelector('#askAI').onclick = () => { location.hash = '#/home'; };
  el.querySelector('#goFeedback').onclick = () => window.__openFeedback?.();
}
