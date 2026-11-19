/**
 * U0-2 实时语音对话 — WS 语音通道与会话状态机（N3 Phase 1，2026-11-19）
 *
 * 目标：在平台既有「批式两段」语音之上补一条「实时对话闭环」通道——
 *   客户端上行音频分片 → 服务端流式流水线（ASR → LLM → 分句 TTS）→ 下行文本增量 + 音频分片，
 *   并支持打断（barge-in：播放中用户开口即停播并终止当前生成）。
 *
 * 传输层（复用 canvas-collab 的 WS 基建）：
 *   - 端点 /api/voice-ws；server.on('upgrade') 握手经 wsUser()（Bearer 头 / ap_token Cookie）鉴权；
 *     与 canvas-collab 各自判各自的 path，互不接管。
 *   - 二进制帧承载音频分片；文本帧承载 JSON 控制/文本消息。心跳复用 30s ping。
 *
 * 会话状态机：idle → listening → thinking → speaking → （idle/listening）
 *   每个 WS 连接一个会话；同一时刻仅处理一轮对话。
 *
 * 协议（客户端 → 服务端）：
 *   {type:'start', agent_id?, model?, voice?, format?}   开始倾听（复位缓冲）
 *   {type:'utterance-end'}                                一句结束（客户端 VAD 静音判定）
 *   {type:'interrupt'}                                    打断（barge-in）
 *   {type:'stop'}                                         结束会话
 *   二进制帧                                               音频分片
 * 协议（服务端 → 客户端）：
 *   {type:'state', state, ts}                             状态变更（驱动前端 UI）
 *   {type:'asr-partial', text}                            识别中间结果（降级模式不产生）
 *   {type:'asr-final', text}                              该句最终识别文本
 *   {type:'reply-delta', text}                            LLM 流式文本增量（字幕同步）
 *   {type:'tts-segment', seq, mime, bytes}                随后到来的二进制音频分片描述
 *   （二进制帧）                                            TTS 音频（保序，seq 递增）
 *   {type:'done', full}                                   本轮完成
 *   {type:'interrupted'}                                  打断已生效
 *   {type:'error', msg}
 *
 * 降级策略（凭证先行，延续平台惯例）：
 *   - ASR：优先 voice_providers（type=stt/both）→ 回退 OpenAI Whisper 兼容端点；均不可用则报错回到 listening。
 *     本 Phase 为「VAD 分段 → 整段批式识别」（无 partial，final 可用）；流式供应商适配位见 P2。
 *   - TTS：分句复用 skills.genTTS() 批式合成，逐句下发（首句先响）；流式 TTS 适配位见 P2。
 *   - 打断：降级模式下仍生效（停播 + AbortController 终止 LLM 生成）。
 *
 * 测试：VOICE_MOCK=1 时全链路本地化（固定 ASR 文本 + 本地 mock LLM + 合成静音 WAV），
 *       不依赖任何外部网关，供自动化冒烟测试稳定验证协议与打断语义。
 */
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { db, now } = require('../db');
const { verify, readToken } = require('./auth');
const { createAsrStream } = require('./stt');
const { genTTS } = require('./skills');
const { chat } = require('./llm');

const WS_PATH = '/api/voice-ws';
const HEARTBEAT_MS = 30000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;         // 倾听态空闲超时回收
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;      // 单句音频缓冲上限
const MAX_SENTENCE_CHARS = 120;                // 单句 TTS 合成硬上限（无标点时强制切分）
const MOCK = process.env.VOICE_MOCK === '1';

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

/** 活跃会话表：ws → session（供并发上限与诊断统计） */
const sessions = new Set();

/** 运行指标（P4 埋点为最小实现；此处先提供计数，便于看板/日志查询） */
const metrics = { sessionsTotal: 0, utterances: 0, ttsSegments: 0, interrupts: 0 };

/** WS upgrade 鉴权：复用 HTTP 同一套（Bearer 头 / ap_token Cookie，浏览器 WS 握手自动带 Cookie） */
function wsUser(req) {
  try {
    const payload = verify(readToken(req));
    if (!payload || !payload.uid) return null;
    return db.prepare('SELECT id, username, nickname, role FROM users WHERE id=? AND status=1').get(payload.uid) || null;
  } catch { return null; }
}

function sendJson(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* 断开竞态静默 */ } } }
function sendBin(ws, buf) { if (ws && ws.readyState === 1) { try { ws.send(buf, { binary: true }); } catch { /* 断开竞态静默 */ } } }

/** 中文/中英标点分句：返回 { complete:[...], rest }。rest 为末尾未闭合片段（等待更多增量） */
function splitSentences(buf) {
  const complete = [];
  const re = /[。！？!?；;\n]+/g;
  let last = -1, m;
  re.lastIndex = 0;
  while ((m = re.exec(buf))) last = m.index + m[0].length;
  if (last <= 0) return { complete, rest: buf };
  const head = buf.slice(0, last);
  const rest = buf.slice(last);
  let start = 0;
  re.lastIndex = 0;
  while ((m = re.exec(head))) {
    const s = head.slice(start, m.index + m[0].length).trim();
    if (s) complete.push(s);
    start = m.index + m[0].length;
  }
  return { complete, rest };
}

/** 本地 mock LLM（测试用）：逐段产出多句回复，模拟流式 */
async function* mockLlm() {
  const text = '你好，我是语音助手。这是一段用于验证实时语音链路的回复。请继续说话。';
  for (let i = 0; i < text.length; i += 4) {
    yield { delta: text.slice(i, i + 4) };
    await new Promise(r => setTimeout(r, 40));
  }
  return { usage: null, full: text, mode: 'mock' };
}

/** 生成静音 WAV（测试用，无需外部依赖即得合法可播放音频） */
function mockWav(ms = 120, rate = 8000) {
  const n = Math.max(1, Math.floor(rate * ms / 1000));
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function handleConn(ws, user) {
  const s = {
    ws, user,
    state: 'idle',
    format: 'wav',
    model: undefined,
    voice: '',
    audioChunks: [],
    audioBytes: 0,
    ac: null,            // 当前 LLM 生成的中止控制器
    runId: 0,            // 在途流水线令牌（打断/重启时自增以作废旧流水线）
    busy: false,
    idleTimer: null,
  };
  sessions.add(s);
  metrics.sessionsTotal++;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const setState = (state) => { s.state = state; sendJson(ws, { type: 'state', state, ts: Date.now() }); };

  const touchIdle = () => {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (s.state === 'listening' && !s.busy) {
      s.idleTimer = setTimeout(() => {
        if (s.state === 'listening' && !s.busy) { sendJson(ws, { type: 'error', msg: '会话空闲超时，已结束' }); try { ws.close(1000, 'idle timeout'); } catch { } }
      }, IDLE_TIMEOUT_MS);
      s.idleTimer.unref?.();
    }
  };

  const resetAudio = () => { s.audioChunks = []; s.audioBytes = 0; };

  /** 一轮流水线：ASR → LLM（流式）→ 分句 TTS。用 runId 令牌作废在途流水线（打断/重启） */
  const runPipeline = async () => {
    const myRun = ++s.runId;
    const stale = () => s.runId !== myRun;
    s.busy = true;
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    const audio = Buffer.concat(s.audioChunks);
    resetAudio();
    metrics.utterances++;

    /** 分句合成并逐句下发（先 meta 文本帧，再二进制音频帧） */
    const emitTts = async (text, seq) => {
      let buf = null, mime = 'audio/mpeg';
      if (MOCK) {
        buf = mockWav(80 + Math.min(200, text.length * 15));
        mime = 'audio/wav';
      } else {
        const r = await genTTS(text, s.voice);        // { url:'/uploads/tts/xxx.mp3' }
        const file = path.join(PUBLIC_ROOT, r.url);
        if (!fs.existsSync(file)) throw new Error('TTS 产物缺失：' + r.url);
        buf = fs.readFileSync(file);
        mime = r.url.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
      }
      if (stale()) return;                              // 合成期间被打断/作废 → 丢弃不下发
      sendJson(ws, { type: 'tts-segment', seq, mime, bytes: buf.length });
      sendBin(ws, buf);
      metrics.ttsSegments++;
    };

    try {
      // 1) ASR（降级：整段批式识别）
      setState('thinking');
      let asrText = '';
      if (MOCK) {
        asrText = '请介绍一下你能做什么';
      } else {
        // ASR 经流式适配位（U0-2 P2）：未配置流式供应商时走「整段批式」降级链
        const asr = createAsrStream({ format: s.format, language: 'zh' });
        asr.push(audio);
        const r = await asr.end();
        if (!r.ok) { sendJson(ws, { type: 'error', msg: '语音识别失败：' + (r.error || '未知错误') }); return; }
        asrText = String(r.text || '').trim();
      }
      if (!asrText) { sendJson(ws, { type: 'error', msg: '未识别到有效语音' }); return; }
      if (stale()) return;
      sendJson(ws, { type: 'asr-final', text: asrText });

      // 2) LLM（流式）→ 按句切分 → 逐句 TTS
      setState('speaking');
      const ac = new AbortController();
      s.ac = ac;
      const messages = [
        { role: 'system', content: '你是一个实时语音助手。请用简洁、口语化的中文短句回答，便于语音播报。' },
        { role: 'user', content: asrText },
      ];
      const gen = MOCK ? mockLlm() : chat(messages, { model: s.model, username: user.username, signal: ac.signal, max_reply: 800 });
      let pending = '';
      let seq = 0;
      let full = '';
      for await (const ev of gen) {
        if (stale()) break;
        const delta = ev && ev.delta ? String(ev.delta) : '';
        if (!delta) continue;
        full += delta;
        sendJson(ws, { type: 'reply-delta', text: delta });
        pending += delta;
        // 无标点时按硬上限强制切分，避免长句迟迟不合成
        if (pending.length >= MAX_SENTENCE_CHARS) {
          const cut = pending.slice(0, MAX_SENTENCE_CHARS);
          pending = pending.slice(MAX_SENTENCE_CHARS);
          await emitTts(cut.trim(), seq++);
          if (stale()) break;
          continue;
        }
        const { complete, rest } = splitSentences(pending);
        pending = rest;
        for (const seg of complete) {
          await emitTts(seg, seq++);
          if (stale()) break;
        }
      }
      if (stale()) return;                              // 被打断/作废：不补发尾句、不报 done（打断确认由消息处理）
      if (pending.trim()) await emitTts(pending.trim(), seq++);
      s.ac = null;
      if (stale()) return;
      sendJson(ws, { type: 'done', full });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.aborted)) return; // 打断/重启导致的中止：静默（由消息处理确认）
      sendJson(ws, { type: 'error', msg: '语音对话失败：' + (e.message || e) });
    } finally {
      s.ac = null;
      s.busy = false;
      if (!stale() && s.state !== 'idle') setState('listening');
      touchIdle();
    }
  };

  ws.on('message', (data, isBinary) => {
    // 二进制：音频分片
    if (isBinary) {
      if (s.state !== 'listening' && !s.busy) return;      // 非倾听态丢弃
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      s.audioBytes += buf.length;
      if (s.audioBytes > MAX_AUDIO_BYTES) { resetAudio(); return sendJson(ws, { type: 'error', msg: '单句音频超长，已丢弃，请重说' }); }
      s.audioChunks.push(buf);
      return;
    }
    let m;
    try { m = JSON.parse(String(data)); } catch { return sendJson(ws, { type: 'error', msg: '非法消息（非 JSON）' }); }
    if (!m || typeof m !== 'object' || !m.type) return sendJson(ws, { type: 'error', msg: '消息缺少 type' });

    if (m.type === 'start') {
      s.runId++;                                    // 作废在途流水线（若有）
      if (s.ac) { try { s.ac.abort(); } catch { } }
      resetAudio();
      if (typeof m.format === 'string' && m.format) s.format = m.format;
      if (m.model) s.model = String(m.model);
      if (typeof m.voice === 'string') s.voice = m.voice;
      setState('listening');
      touchIdle();
      return;
    }

    if (m.type === 'utterance-end') {
      if (s.busy) return sendJson(ws, { type: 'error', msg: '上一轮仍在处理中（可发送 interrupt 打断）' });
      if (!s.audioBytes) return sendJson(ws, { type: 'error', msg: '未收到音频数据' });
      runPipeline(); // 异步流水线；不 await（消息循环继续可接收 interrupt）
      return;
    }

    if (m.type === 'interrupt') {
      metrics.interrupts++;
      s.runId++;                                    // 作废在途流水线
      resetAudio();
      if (s.ac) { try { s.ac.abort(); } catch { } }
      // 无论处于生成还是播放阶段，均回到倾听态（打断确认以本处理为准）
      setState('listening');
      touchIdle();
      sendJson(ws, { type: 'interrupted' });
      return;
    }

    if (m.type === 'stop') {
      s.runId++;
      if (s.ac) { try { s.ac.abort(); } catch { } }
      setState('idle');
      try { ws.close(1000, 'client stop'); } catch { }
      return;
    }

    return sendJson(ws, { type: 'error', msg: `未知消息类型：${m.type}` });
  });

  ws.on('close', () => {
    s.runId++;
    if (s.ac) { try { s.ac.abort(); } catch { } }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    sessions.delete(s);
  });
  ws.on('error', () => { /* 由 close 统一清理 */ });
}

/** 挂载到 HTTP server（server.js 在 app.listen 后调用一次） */
function attachVoiceStream(server) {
  const maxSessions = Number(process.env.VOICE_MAX_SESSIONS) || 20;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== WS_PATH) return; // 非语音通道的 upgrade 不接管
    const user = wsUser(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (sessions.size >= maxSessions) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => handleConn(ws, user));
  });
  const hb = setInterval(() => {
    for (const c of wss.clients) {
      if (c.isAlive === false) { try { c.terminate(); } catch { } continue; }
      c.isAlive = false;
      try { c.ping(); } catch { }
    }
  }, HEARTBEAT_MS);
  hb.unref?.();
  console.log(`[voice-stream] WebSocket 实时语音通道已挂载（${WS_PATH}${MOCK ? '，MOCK 模式' : ''}）`);
  return { close: () => { clearInterval(hb); for (const s of sessions) { try { s.ws.close(1001, 'server shutdown'); } catch { } } try { wss.close(); } catch { } } };
}

/** 测试/诊断用：活跃语音会话数与运行指标 */
function voiceStats() {
  return { active: sessions.size, byState: [...sessions].reduce((a, s) => (a[s.state] = (a[s.state] || 0) + 1, a), {}), ...metrics };
}

module.exports = { attachVoiceStream, voiceStats, splitSentences };
