/**
 * P2-20/P2-24 STT 语音识别模块（2026-11-14 U0-2 语音识别接入）
 *
 * 支持两种模式：
 *   - whisper：OpenAI Whisper 兼容 API（OpenAI API / 本地 faster-whisper / 自建端点）
 *   - provider：通过 voice_providers 表配置的 STT 供应商（优先）
 *
 *  语义保证：本函数永不 reject（无法连接失败返回 { ok:false }），调用方无需 try-catch。
 */
const { db } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

async function ensureFfmpeg() { /* 检查 ffmpeg（用于音频格式转换） */
  try {
    const { execFile } = require('child_process');
    const util = require('util');
    await util.promisify(execFile)('ffmpeg', ['-version'], { timeout: 3000 });
    return true;
  } catch { return false; }
}

/**
 * 执行 STT 语音识别
 * @param {object} opts
 * @param {Buffer|string} opts.audio     - 音频数据（Buffer）或文件路径
 * @param {string}  [opts.format]         - 音频格式（'wav','mp3','ogg','webm'，默认自动检测）
 * @param {string}  [opts.language]       - 语言（默认 'zh'）
 * @param {string}  [opts.provider]       - 指定使用 voice_providers 中的某个供应商 ID
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
async function stt({ audio, format, language, provider }) {
  if (!audio) return { ok: false, error: '音频数据不能为空' };
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);

  // 1) 尝试从 voice_providers 获取 STT 供应商
  try {
    const providers = provider
      ? [dal.getq('SELECT * FROM voice_providers WHERE id=? AND type IN (\'stt\',\'both\')', [+provider])]
      : dal.q("SELECT * FROM voice_providers WHERE type IN ('stt','both') AND configured=1 ORDER BY is_default DESC, id ASC");
    for (const p of providers) {
      if (!p) continue;
      const result = await whisperSTT(buf, p);
      if (result.ok) return result;
    }
  } catch { /* 降级到 OpenAI */ }

  // 2) 回退：兼容 OpenAI Whisper API
  try {
    const openaiProviders = dal.q("SELECT name, api_key, base_url FROM providers WHERE configured=1");
    for (const p of openaiProviders) {
      const base = p.base_url?.replace(/\/+$/, '') || 'https://api.openai.com';
      const url = base + '/v1/audio/transcriptions';
      const form = new FormData();
      form.append('file', new Blob([buf]), `audio.${format || guessExt(buf)}`);
      form.append('model', 'whisper-1');
      if (language) form.append('language', language);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + p.api_key },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.text) return { ok: true, text: j.text };
    }
  } catch { /* 静默 */ }

  return { ok: false, error: '所有 STT 供应商均不可用（请配置 voice_providers 或 OpenAI 兼容端点）' };
}

/** 通过 voice_providers 中的 whisper 兼容端点识别 */
async function whisperSTT(buf, provider) {
  const base = provider.base_url.replace(/\/+$/, '');
  const ep = provider.endpoint || '/v1/audio/transcriptions';
  const url = base + ep;
  const model = provider.model_name || 'whisper-1';
  // 若是 OpenAI 兼容，发送 multipart form-data
  const form = new FormData();
  form.append('file', new Blob([buf]), `audio.${guessExt(buf)}`);
  form.append('model', model);
  if (Array.isArray(provider.languages) && provider.languages.length) {
    form.append('language', provider.languages[0]);
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + provider.api_key },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, provider: provider.name };
  const j = await r.json();
  if (j.text) return { ok: true, text: j.text, provider: provider.name };
  if (j.results && j.results.length) return { ok: true, text: j.results.map(x => x.alternatives?.[0]?.transcript || '').join(''), provider: provider.name };
  return { ok: false, error: '响应中未找到识别文本', provider: provider.name };
}

// ================== U0-2（N3-P2）流式 ASR 适配位 ==================

/** 支持的流式模式：batch=走降级批式；ws/http-chunk=流式适配位（待供应商协议接入） */
const STREAM_MODES = ['batch', 'ws', 'http-chunk'];

/** 判定供应商生效的流式模式（未配置/非法值一律归 batch） */
function effectiveStreamMode(provider) {
  const m = provider && provider.stream_type;
  return STREAM_MODES.includes(m) ? m : 'batch';
}

/** 选取 STT 供应商行（按指定 ID 或默认优先，含 stream_type）；无则 null */
function pickSttProvider(providerId) {
  try {
    if (providerId) return dal.getq("SELECT * FROM voice_providers WHERE id=? AND type IN ('stt','both')", [+providerId]) || null;
    return dal.getq("SELECT * FROM voice_providers WHERE type IN ('stt','both') AND configured=1 ORDER BY is_default DESC, id ASC") || null;
  } catch { return null; }
}

/**
 * 创建一路流式 ASR 适配位会话（U0-2 N3-P2）。
 *
 *   const asr = createAsrStream({ format, language });   // 自动选取供应商
 *   asr.push(chunkBuf);                                   // 喂入音频分片（可多次）
 *   const r = await asr.end();                            // { ok, text?, mode, degraded, partial }
 *
 * 语义：
 *   - 永不 reject（与 stt() 一致），失败返回 { ok:false }。
 *   - stream_type 为 batch（默认）时：缓冲全部分片后整段复用 stt() 批式识别，partial=false。
 *   - stream_type 为 ws/http-chunk 且配置了 stream_endpoint 时：视为「适配位就绪」，
 *     但真实流式传输协议待供应商确定后接入，当前统一回落批式以保证链路可用，
 *     并以 degraded=true 标注（凭证/协议到位后仅需在此分支接入流式实现）。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.provider]   - 指定 voice_providers 供应商 ID
 * @param {string}   [opts.format]     - 音频格式
 * @param {string}   [opts.language]   - 语言（默认 'zh'）
 * @param {function} [opts.onPartial]  - 流式 partial 回调（batch 模式不触发）
 */
function createAsrStream({ provider, format, language, onPartial } = {}) {
  const p = pickSttProvider(provider);
  const mode = effectiveStreamMode(p);
  const streamDeclared = mode !== 'batch' && !!(p && p.stream_endpoint);
  let chunks = [];
  let bytes = 0;
  let cancelled = false;
  return {
    mode,
    provider: p ? p.name : null,
    /** 当前缓冲字节数 */
    get bytes() { return bytes; },
    /** 喂入音频分片（流式模式可据实回吐 partial；batch 模式仅缓冲） */
    push(buf) {
      if (cancelled || !buf) return;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      chunks.push(b); bytes += b.length;
    },
    /** 结束一轮并取识别结果（永不 reject） */
    async end() {
      if (cancelled) return { ok: false, error: '已取消', mode, cancelled: true };
      const audio = Buffer.concat(chunks);
      chunks = []; bytes = 0;
      const r = await stt({ audio, format, language, provider });
      return { ...r, mode, degraded: streamDeclared, partial: false, provider: p ? p.name : undefined };
    },
    /** 取消（放弃本路识别） */
    cancel() { cancelled = true; chunks = []; bytes = 0; },
  };
}

/** 猜测音频文件格式（根据魔数或默认 wav） */
function guessExt(buf) {
  if (!buf || buf.length < 4) return 'wav';
  // Ogg: OggS
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
  // MP3: ID3 或 0xFF 同步字
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3';
  // WebM: 1a 45 df a3
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';
  // WAV: RIFF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
  return 'wav';
}

/**
 * 浏览器端录音辅助函数（前端工具，export 仅供引用说明）
 * 前端用法：
 *   const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 *   const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
 *   recorder.ondataavailable = e => chunks.push(e.data);
 *   recorder.onstop = () => { const blob = new Blob(chunks, { type: 'audio/webm' }); upload(blob); };
 *   recorder.start(); // 开始录音
 *   recorder.stop();  // 停止录音，触发上传
 */

module.exports = { stt, whisperSTT, guessExt, STREAM_MODES, effectiveStreamMode, pickSttProvider, createAsrStream };