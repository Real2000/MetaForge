/**
 * 创作技能库（首页 AI 助手多模态能力，豆包式）：
 * - genImage：文生图（QwenImage，逐供应商尝试直至成功，本地落盘返回 URL）
 * - createVideoTask / queryVideoTask / videoContent：文生视频（minimax h3，异步任务制，记住任务归属供应商）
 * - genPPT：主题生成 PPT（对话模型产出结构化大纲 → pptxgenjs 渲染真实 .pptx）
 * 2026-10-14：多供应商路由——专用渠道（图片/视频）可能不在默认供应商上，
 * 逐个已配置供应商尝试（默认优先），避免切换默认供应商后技能断裂。
 */
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const { chatOnce, getConfiguredProviders, postModel } = require('./llm');
const { classifyModel } = require('./model-types');

/** 已配置供应商（默认优先，供图片/视频渠道逐个尝试） */
function providers() {
  return getConfiguredProviders().map(p => ({ name: p.name, api_key: p.api_key, base_url: p.base_url }));
}

// 视频任务归属供应商记忆（taskId → provider）：创建时记住，查询/拉内容直连，避免每次轮询逐个试
const videoTaskProvider = new Map();
function rememberVideoProvider(taskId, p) {
  videoTaskProvider.set(String(taskId), p);
  if (videoTaskProvider.size > 1000) { // 防膨胀：超限丢弃最早记忆
    videoTaskProvider.delete(videoTaskProvider.keys().next().value);
  }
}
function videoProviderOf(taskId) {
  return videoTaskProvider.get(String(taskId)) || null;
}

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

/**
 * 文生图：逐供应商尝试（默认优先；QwenImage 渠道可能在非默认供应商上），b64 落盘为本地文件
 * 2026-10-22 修复：模型候选优先 QwenImage-Ascend（网关实测该名称路由命中昇腾渠道秒回成功），
 * QwenImage 为兼容回退（旧网关版本/其他供应商使用该名称）。
 * 2026-10-26 修复（用户报告"图片生成失败：该 API Key 无权调用模型"）：网关侧该 Key 已无
 * QwenImage-Ascend/QwenImage 权限（403 仅限自有算力模型），现行可用名称为 Qwen-Image-maas
 * （实测 200）——候选链改为 maas 优先，两个旧名保留兜底（其他网关/供应商仍可能用到）。
 */
const IMAGE_MODELS = ['Qwen-Image-maas', 'QwenImage-Ascend', 'QwenImage'];
async function genImage(prompt, size = '1024x1024') {
  const ps = providers();
  if (!ps.length) throw new Error('未配置可用的模型供应商');
  const errs = [];
  for (const p of ps) {
    for (const model of IMAGE_MODELS) {
      try { return await genImageOnce(prompt, size, p, model); } catch (e) { errs.push(`${p.name}/${model}：${e.message}`); }
    }
  }
  throw new Error(`图片生成失败（已尝试 ${ps.length * IMAGE_MODELS.length} 个候选）——${errs.join('；').slice(0, 220)}`);
}

async function genImageOnce(prompt, size, p, model = 'QwenImage-Ascend') {
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) size = '1024x1024';
  const res = await postModel(p.base_url.replace(/\/+$/, '') + '/images/generations',
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
    { model, prompt: prompt || '', size, n: 1 },
    { signal: AbortSignal.timeout(120000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && (j.error.message || j.error)) || 'HTTP ' + res.status);
  const item = (j.data || [])[0];
  if (item?.url) return { url: item.url, model, size };
  if (item?.b64_json) {
    const dir = path.join(UPLOAD_ROOT, 'gen-images');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, fname), Buffer.from(item.b64_json, 'base64'));
    return { url: `/uploads/gen-images/${fname}`, model, size };
  }
  throw new Error('图片渠道返回异常（' + (j.error ? JSON.stringify(j.error).slice(0, 100) : '无数据') + '）');
}

/** 文生视频：创建异步任务（逐供应商尝试默认优先，minimax h3 渠道可能在非默认供应商上；4~15 秒，按秒计费） */
async function createVideoTask(prompt, seconds = 4, aspectRatio = '16:9') {
  const ps = providers();
  if (!ps.length) throw new Error('未配置可用的模型供应商');
  const secs = Math.min(15, Math.max(4, +seconds || 4));
  const ratio = ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : '16:9';
  const errs = [];
  for (const p of ps) {
    try {
      const res = await postModel(p.base_url.replace(/\/+$/, '') + '/videos/generations',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        { model: 'minimax h3', prompt: prompt || '', seconds: secs, aspect_ratio: ratio },
        { signal: AbortSignal.timeout(30000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.task_id) throw new Error(j.error || 'HTTP ' + res.status);
      rememberVideoProvider(j.task_id, p); // 记住归属，后续查询/拉内容直连该供应商
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('system', '视频生成任务', `minimax h3 ${secs}s ${ratio} @ ${p.name}（task ${String(j.task_id).slice(0, 20)}）`, '', now());
      return { taskId: j.task_id, model: j.model, seconds: secs, aspectRatio: ratio, status: j.status || 'queued', progress: j.progress || 0, price: j.price };
    } catch (e) { errs.push(`${p.name}：${e.message}`); }
  }
  throw new Error(`创建视频任务失败（已尝试 ${ps.length} 个供应商）——${errs.join('；').slice(0, 200)}`);
}

/** 查询视频任务进度（优先归属供应商直连，否则逐个尝试）。返回 { data, provider } */
async function queryVideoTask(taskId) {
  const remembered = videoProviderOf(taskId);
  const ps = remembered ? [remembered] : providers();
  if (!ps.length) throw new Error('未配置可用的模型供应商');
  const errs = [];
  for (const p of ps) {
    try {
      const res = await fetch(p.base_url.replace(/\/+$/, '') + `/videos/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: 'Bearer ' + p.api_key },
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      return { data: j, provider: p };
    } catch (e) { errs.push(`${p.name}：${e.message}`); }
  }
  throw new Error(`查询视频任务失败（已尝试 ${ps.length} 个供应商）——${errs.join('；').slice(0, 200)}`);
}

/** PPT 大纲 → pptx 渲染。返回 {url, filename, pages, title} */
async function genPPT(topic) {
  const t = String(topic || '').trim();
  if (!t) throw new Error('请输入 PPT 主题');

  // 1. 模型生成结构化大纲
  const outlinePrompt = `你是专业的PPT内容策划师。根据主题设计一份中文PPT大纲，共7页（1页封面+6页内容）。严格输出纯JSON（不要markdown代码块、不要解释文字），结构如下：
{"title":"主标题(12字内)","subtitle":"副标题(20字内)","pages":[{"title":"页标题(15字内)","points":["要点(25字内)","要点","要点"]}]}
要求：内容专业翔实、要点之间有逻辑递进；每页3-5个要点。主题：${t}`;
  const r = await chatOnce([{ role: 'user', content: outlinePrompt }], { temperature: 0.4, max_reply: 3000 });
  let outline = null;
  try {
    const raw = r.full;
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) outline = JSON.parse(raw.slice(s, e + 1));
  } catch { }
  if (!outline || !Array.isArray(outline.pages) || !outline.pages.length) {
    throw new Error('大纲生成失败，请重试（模型未返回有效结构）');
  }

  // 2. pptxgenjs 渲染（白底 + 蓝色主色，简洁商务风）
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W16x9', width: 13.33, height: 7.5 });
  pptx.layout = 'W16x9';
  pptx.author = '智能体平台';
  pptx.title = outline.title || t;

  const BRAND = '2563EB';
  const DARK = '1E293B';
  const GRAY = '475569';
  const LIGHT = 'EFF6FF';

  // 封面
  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  cover.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.16, fill: { color: BRAND } });
  cover.addShape('rect', { x: 0.9, y: 2.1, w: 0.14, h: 2.5, fill: { color: BRAND } });
  cover.addText(outline.title || t, { x: 1.35, y: 2.3, w: 10.5, h: 1.2, fontSize: 44, bold: true, color: DARK, fontFace: 'Microsoft YaHei' });
  cover.addText(outline.subtitle || '', { x: 1.35, y: 3.55, w: 10.5, h: 0.7, fontSize: 20, color: GRAY, fontFace: 'Microsoft YaHei' });
  cover.addText('由智能体平台 AI 生成 · ' + new Date().toLocaleDateString('zh-CN'), { x: 1.35, y: 6.5, w: 10, h: 0.5, fontSize: 12, color: '94A3B8' });

  // 内容页
  outline.pages.slice(0, 12).forEach((pg, idx) => {
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.1, fill: { color: BRAND } });
    s.addText(String(idx + 1).padStart(2, '0'), { x: 0.9, y: 0.55, w: 1.5, h: 0.9, fontSize: 40, bold: true, color: LIGHT === 'EFF6FF' ? 'DBEAFE' : 'DBEAFE' });
    s.addText(pg.title || `第${idx + 1}部分`, { x: 0.92, y: 1.35, w: 11.5, h: 0.9, fontSize: 30, bold: true, color: DARK, fontFace: 'Microsoft YaHei' });
    s.addShape('line', { x: 0.95, y: 2.25, w: 2.2, h: 0, line: { color: BRAND, width: 2.5 } });
    const points = (pg.points || []).filter(Boolean).slice(0, 6);
    s.addText(points.map(pt => ({ text: pt, options: { bullet: { code: '25CF', color: BRAND }, breakLine: true } })), {
      x: 1.15, y: 2.7, w: 11.2, h: 4.2, fontSize: 18, color: GRAY, lineSpacingMultiple: 1.5, valign: 'top', fontFace: 'Microsoft YaHei',
    });
    s.addText(`${idx + 1 + 1}`, { x: 12.5, y: 6.95, w: 0.6, h: 0.4, fontSize: 11, color: '94A3B8', align: 'right' });
  });

  // 3. 落盘
  const dir = path.join(UPLOAD_ROOT, 'ppt');
  fs.mkdirSync(dir, { recursive: true });
  const fname = `ppt-${Date.now()}.pptx`;
  const safeTitle = (outline.title || t).replace(/[\\\\/:*?\"<>|]/g, '').slice(0, 30) || 'AI演示文稿';
  await pptx.writeFile({ fileName: path.join(dir, fname) });
  return { url: `/uploads/ppt/${fname}`, filename: `${safeTitle}.pptx`, pages: outline.pages.length + 1, title: outline.title || t };
}

/**
 * 语音合成 TTS（2026-10-22 P4）：优先自有昇腾算力（网关 /v1/audio/speech → Qwen3-TTS-12Hz-1.7B-CustomVoice），
 * 逐供应商尝试（找配置了 TTS 渠道的网关），返回本地 MP3 文件。
 */
async function genTTS(text, voice = '') {
  const ps = providers();
  if (!ps.length) throw new Error('未配置可用的模型供应商');
  const errs = [];
  for (const p of ps) {
    try {
      const res = await postModel(p.base_url.replace(/\/+$/, '') + '/audio/speech',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.api_key },
        { model: 'Qwen3-TTS-12Hz-1.7B-CustomVoice', input: String(text || '').slice(0, 1500), ...(voice ? { voice } : {}) },
        { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j.error && (j.error.message || j.error)) || 'HTTP ' + res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error('上游返回空音频');
      const dir = path.join(UPLOAD_ROOT, 'tts');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `tts-ascend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`;
      fs.writeFileSync(path.join(dir, fname), buf);
      return { url: `/uploads/tts/${fname}`, source: 'ascend', voice, model: 'Qwen3-TTS-12Hz-1.7B-CustomVoice' };
    } catch (e) { errs.push(`${p.name}：${e.message}`); }
  }
  throw new Error(`昇腾 TTS 合成失败（已尝试 ${providers.length} 个供应商）——${errs.join('；').slice(0, 160)}`);
}

module.exports = { genImage, createVideoTask, queryVideoTask, genPPT, genTTS, providers, videoProviderOf };
