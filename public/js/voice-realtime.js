/* U0-2（N3-P3）实时语音前端：采集 / 保序播放 / 打断（barge-in）
 *
 * 浏览器侧职责：
 *   - 用 WebSocket 连接 /api/voice-ws（握手自动带 ap_token Cookie，服务端 wsUser 鉴权）；
 *   - getUserMedia + MediaRecorder 采集，按时间片把音频分片（二进制帧）持续上行；
 *   - AnalyserNode 做本地 VAD：判定「说话开始/结束」，结束（静音）时发送 utterance-end；
 *   - 播放（speaking）期间检测到用户开口 → 立即发送 interrupt（打断），停播并清空队列；
 *   - Web Audio 把服务端下发的 TTS 音频分片按 seq 保序播放，同步显示字幕。
 *
 * 纯逻辑（PlaybackQueue / vadDecide / shouldBargeIn）以 UMD 导出，供 Node 冒烟测试复用；
 * 本文件不依赖任何构建工具，可直接作为 classic script 引入。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VoiceRealtime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==================== 纯逻辑（可在 Node 中单测） ====================

  /** 保序播放队列：乱序到达的音频分片按 seq 升序出队 */
  class PlaybackQueue {
    constructor() { this.map = new Map(); this.seq = 0; }
    /** 入队一个分片 {data, mime} */
    push(seq, item) { this.map.set(seq, item); }
    /** 取下一个应播放项（严格 seq 递增）；无则返回 null */
    next() {
      const v = this.map.get(this.seq);
      if (v === undefined) return null;
      this.map.delete(this.seq); this.seq++;
      return v;
    }
    get size() { return this.map.size; }
    clear() { this.map.clear(); this.seq = 0; }
  }

  /**
   * VAD 判定：给定上一判定状态与当前帧能量（RMS），返回 { speaking, event }。
   * 采用双阈值滞回（on ≥ off）避免抖动：event 为 'start' | 'end' | null。
   */
  function vadDecide(prevSpeaking, rms, opts) {
    const o = opts || {};
    const on = o.on != null ? o.on : 0.02;
    const off = o.off != null ? o.off : 0.012;
    if (!prevSpeaking) return rms >= on ? { speaking: true, event: 'start' } : { speaking: false, event: null };
    return rms <= off ? { speaking: false, event: 'end' } : { speaking: true, event: null };
  }

  /** 是否应触发打断：会话处于 speaking（播放中）且检测到用户开口 */
  function shouldBargeIn(sessionState, speechStart) {
    return sessionState === 'speaking' && !!speechStart;
  }

  // ==================== 浏览器胶水 ====================

  /** 从时域数据计算 RMS（0~1） */
  function computeRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / (buf.length || 1));
  }

  function isSupported() {
    return typeof window !== 'undefined'
      && typeof WebSocket !== 'undefined'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      && typeof MediaRecorder !== 'undefined'
      && !!(window.AudioContext || window.webkitAudioContext);
  }

  /**
   * 创建一路实时语音会话。
   * @param {object} opts
   * @param {function} [opts.onState]   (state) 会话状态变更（idle/listening/thinking/speaking）
   * @param {function} [opts.onPartial] (text) ASR 中间结果（降级模式不产生）
   * @param {function} [opts.onFinal]   (text) 该句最终识别文本
   * @param {function} [opts.onReply]   (text) LLM 回复文本增量（字幕同步）
   * @param {function} [opts.onDone]    (full)  本轮完成
   * @param {function} [opts.onError]   (msg)   错误
   * @param {function} [opts.onLevel]   (rms)   输入电平（驱动 UI 动画，可选）
   * @param {string}   [opts.wsUrl]     自定义 WS 地址（默认同源 /api/voice-ws）
   * @param {number}   [opts.vadOn]     VAD 开始阈值（默认 0.02）
   * @param {number}   [opts.vadOff]    VAD 结束阈值（默认 0.012）
   */
  function createSession(opts) {
    const o = opts || {};
    const cb = {
      onState: o.onState || (() => {}),
      onPartial: o.onPartial || (() => {}),
      onFinal: o.onFinal || (() => {}),
      onReply: o.onReply || (() => {}),
      onDone: o.onDone || (() => {}),
      onError: o.onError || (() => {}),
      onLevel: o.onLevel || (() => {}),
    };
    if (!isSupported()) throw new Error('当前浏览器不支持实时语音（需 MediaRecorder / Web Audio / WebSocket）');

    const wsUrl = o.wsUrl || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/voice-ws');
    const vadOpts = { on: o.vadOn, off: o.vadOff };

    let ws = null, mediaStream = null, recorder = null, audioCtx = null, analyser = null, rafId = 0;
    let playback = new PlaybackQueue();
    let state = 'idle';
    let currentSource = null;
    let lastMeta = null;         // 最近一次 tts-segment 元信息（与其后的二进制帧配对）
    let userSpeaking = false;    // VAD 判定用户是否在说话
    let hasSpeech = false;       // 本轮倾听期内是否已检测到过语音
    let stopped = false;

    const setState = (s) => { state = s; cb.onState(s); };
    const send = (obj) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* 断开竞态 */ } } };

    /** 停止当前播放并清空保序队列 */
    function stopAudio() {
      if (currentSource) { try { currentSource.onended = null; currentSource.stop(); } catch { } currentSource = null; }
      playback.clear();
    }

    /** 依次播放保序队列中的分片（每片为完整音频文件，逐个解码后衔接） */
    async function drain() {
      if (currentSource) return;
      const item = playback.next();
      if (!item) return;
      try {
        const ab = item.data.slice(0); // decodeAudioData 会 detach，需拷贝
        const buf = await audioCtx.decodeAudioData(ab);
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(audioCtx.destination);
        currentSource = src;
        src.onended = () => { currentSource = null; drain(); };
        src.start();
      } catch { currentSource = null; drain(); }
    }

    function onServerMsg(rawText) {
      let m; try { m = JSON.parse(rawText); } catch { return; }
      if (!m || !m.type) return;
      if (m.type === 'state') { setState(m.state); return; }
      if (m.type === 'asr-partial') { cb.onPartial(String(m.text || '')); return; }
      if (m.type === 'asr-final') { cb.onFinal(String(m.text || '')); return; }
      if (m.type === 'reply-delta') { cb.onReply(String(m.text || '')); return; }
      if (m.type === 'tts-segment') { lastMeta = { seq: m.seq | 0, mime: m.mime || 'audio/mpeg' }; return; }
      if (m.type === 'done') { cb.onDone(m.full || ''); return; }
      if (m.type === 'interrupted') { stopAudio(); return; }
      if (m.type === 'error') { cb.onError(String(m.msg || '未知错误')); return; }
    }

    function onServerBin(buf) {
      if (!lastMeta || !buf || !buf.byteLength) return;
      playback.push(lastMeta.seq, { data: buf, mime: lastMeta.mime });
      lastMeta = null;
      drain();
    }

    /** VAD 循环：读取 AnalyserNode 时域数据 → 判定说话起止 → 触发发送/打断 */
    function vadLoop() {
      if (stopped) return;
      const n = analyser.fftSize;
      const arr = new Uint8Array(n);
      analyser.getByteTimeDomainData(arr);
      const rms = computeRms(arr);
      cb.onLevel(rms);
      const d = vadDecide(userSpeaking, rms, vadOpts);
      if (d.event === 'start') {
        hasSpeech = true;
        if (shouldBargeIn(state, true)) { send({ type: 'interrupt' }); stopAudio(); setState('listening'); }
      } else if (d.event === 'end') {
        if (state === 'listening' && hasSpeech) { send({ type: 'utterance-end' }); hasSpeech = false; }
      }
      userSpeaking = d.speaking;
      rafId = requestAnimationFrame(vadLoop);
    }

    async function start() {
      stopped = false;
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser); // 仅分析，不接 destination（避免回声）

      await new Promise((resolve, reject) => {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('语音通道连接失败'));
        ws.onclose = () => { if (!stopped) { cb.onError('语音通道已断开'); } };
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') onServerMsg(e.data);
          else onServerBin(e.data);
        };
      });

      setState('listening');
      send({ type: 'start', format: 'webm' });

      const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new MediaRecorder(mediaStream, { mimeType: mime });
      recorder.ondataavailable = async (ev) => {
        if (!ev.data || !ev.data.size) return;
        try { const ab = await ev.data.arrayBuffer(); if (ws && ws.readyState === 1) ws.send(ab); } catch { }
      };
      recorder.start(250); // 每 250ms 一个分片
      vadLoop();
    }

    /** 主动打断（UI 按钮，或自动 VAD 触发） */
    function interrupt() { send({ type: 'interrupt' }); stopAudio(); setState('listening'); }

    /** 结束会话并释放资源（麦克风、AudioContext、WS） */
    function stop() {
      stopped = true;
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { }
      try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch { }
      try { if (rafId) cancelAnimationFrame(rafId); } catch { }
      try { send({ type: 'stop' }); } catch { }
      try { if (ws) ws.close(); } catch { }
      stopAudio();
      try { if (audioCtx) audioCtx.close(); } catch { }
      setState('idle');
    }

    return { start, interrupt, stop, get state() { return state; }, _queue: playback };
  }

  return { PlaybackQueue, vadDecide, shouldBargeIn, computeRms, isSupported, createSession };
});
