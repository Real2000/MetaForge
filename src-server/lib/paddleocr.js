/**
 * PaddleOCR HTTP 封装（V2.3 #5 摄取管道化 2026-10-31）
 *
 * 用途：知识库摄取管道 ocr 步骤的识别后端——扫描版 PDF / 图片型文件解析出的文本过短时，
 * 把原始文件 buffer 送外部 PP-OCR 服务识别，增强为可切片文本。
 *
 * 设计约束（与管道等价性硬指标绑定，改前必读）：
 * 1. 开关语义：PADDLEOCR_URL 未配置（undefined/空串）= 功能整体不可用，ocrAvailable() 直接返回
 *    false 且【不发任何网络请求、不写任何日志】——保证未配置环境下摄取行为与管道化之前逐字节一致；
 * 2. 健康探测 GET {基址}/health，3 秒超时；探测结果（无论成败）缓存 60 秒，
 *    防扫描版文件连续上传时反复探测拖慢上传；
 * 3. 识别 POST {基址}/ocr，15 秒超时；识别失败由调用方（管道 ocr 步骤）静默降级，不阻塞管道。
 *
 * 服务契约（部署见 docker-compose.paddleocr.yml + docs/PaddleOCR部署说明.md）：
 *   GET  /health → 200 {"ok":true,...}                       健康探测
 *   POST /ocr    → {"image":"<base64>"} → {"code":0,"text":"全文","lines":[{text,score}]}
 *   解析侧对 PaddleOCR 官方 hubserving 形态 {"results":[[{"text":...}]]} 做兼容适配
 */

// 服务基址：仅当 PADDLEOCR_URL 已配置时启用（未配置=功能关闭，见文件头约束 1）
const DEFAULT_BASE = 'http://127.0.0.1:9300';
// 各超时与探测缓存参数（毫秒）——见文件头约束 2/3
const HEALTH_TIMEOUT_MS = 3000;
const OCR_TIMEOUT_MS = 15000;
const PROBE_CACHE_MS = 60000;

/** 是否已配置 OCR 服务地址（未配置=功能关闭，调用方据此完全静默跳过，不发请求不写日志） */
function isConfigured() {
  return baseUrl() !== '';
}

/** 归一化服务基址：去掉尾部斜杠；未配置返回空串 */
function baseUrl() {
  const u = String(process.env.PADDLEOCR_URL || '').trim();
  if (!u) return ''; // 未配置=不可用（默认关闭，保证与管道化之前行为一致）
  // 容错：只配了主机或端口时补默认协议（如 "127.0.0.1:9300"）
  const full = /^https?:\/\//i.test(u) ? u : `http://${u}`;
  return full.replace(/\/+$/, '');
}

// 探测结果缓存：{ at: 上次探测时间戳, ok: 是否健康 }——失败缓存 60s 防反复探测（成功同样缓存，窗口内直接复用）
let probeCache = { at: 0, ok: false };

/**
 * 健康探测：服务是否可用。
 * - 未配置 → false（不发请求）
 * - 60s 内探测过 → 直接复用上次结果
 * - GET {基址}/health，3s 超时，HTTP 2xx 视为健康
 * 自吞所有异常（网络错误/超时/响应异常），永不 reject——调用方无需 try-catch
 */
async function ocrAvailable() {
  const base = baseUrl();
  if (!base) return false; // 未配置=不可用
  if (Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.ok; // 缓存窗口内复用
  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      ok = res.ok; // 2xx = 健康（不校验响应体，宽松判定）
    } finally {
      clearTimeout(timer);
    }
  } catch {
    ok = false; // 连接拒绝/超时/DNS 失败 → 不可用（缓存失败结果 60s）
  }
  probeCache = { at: Date.now(), ok };
  return ok;
}

/**
 * 识别图片/扫描件 buffer → 拼接文本。
 * POST {基址}/ocr，body {"image": "<base64>"}，15s 超时。
 * 宽松解析响应：优先 text 字段；其次 lines[].text；兼容 hubserving 的 results[[{text}]] 形态。
 * 网络失败/非 2xx/响应解析失败 → 抛错（调用方管道 ocr 步骤捕获后静默降级）。
 */
async function ocrImage(buf) {
  const base = baseUrl();
  if (!base) throw new Error('PADDLEOCR_URL 未配置');
  if (!buf || !buf.length) throw new Error('待识别内容为空');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OCR_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: buf.toString('base64') }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OCR 服务响应异常（HTTP ${res.status}）`);
    const data = await res.json();
    const text = extractText(data);
    if (text == null) throw new Error('OCR 响应格式无法解析');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 从多种响应形态中宽松提取文本：text 字段 → lines[] → hubserving results[[{text}]] */
function extractText(data) {
  if (!data || typeof data !== 'object') return null;
  // 形态①（自定义契约）：{ code, text, lines:[{text,score}] }
  if (typeof data.text === 'string' && data.text.trim()) return data.text;
  if (Array.isArray(data.lines) && data.lines.length) {
    const joined = data.lines.map(l => (l && typeof l.text === 'string' ? l.text : '')).filter(Boolean).join('\n');
    if (joined.trim()) return joined;
  }
  // 形态②（hubserving 兼容）：{ results: [[{text, confidence, ...}]] }（外层数组=页，内层=行）
  if (Array.isArray(data.results) && data.results.length) {
    const parts = [];
    for (const page of data.results) {
      if (!Array.isArray(page)) continue;
      for (const line of page) {
        if (line && typeof line.text === 'string' && line.text.trim()) parts.push(line.text.trim());
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return null;
}

module.exports = { isConfigured, baseUrl, ocrAvailable, ocrImage };
