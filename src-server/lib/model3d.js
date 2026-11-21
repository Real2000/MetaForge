/**
 * D3-1 3D 与数字人 V1（2026-11-21）——3D 资产生成内核（纯逻辑零依赖）
 *
 * 覆盖：
 *  - 3D 格式识别（glb/gltf/obj/fbx/stl/usdz/ply）与 MIME；
 *  - 生成请求构造（第三方 3D 服务 OpenAI 风格 /3d/generations）；
 *  - 任务台账视图与「3D 任务成功率」（验收口径 ≥ 70%）；
 *  - 导出计划（源格式 → 目标格式的可转换性与是否需要转换）。
 *
 * 设计：本模块只做纯计算，网络调用与落盘在 routes/model3d.js。
 */

/** 支持的 3D 格式（glTF 系为主，兼容 OBJ/FBX/STL 等常见交换格式） */
const FORMATS = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz', 'ply'];

/** 格式 → MIME */
const MIME = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  fbx: 'application/octet-stream',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
  ply: 'application/octet-stream',
};

/** 生成（源）格式 → 可导出（目标）格式表；V1 声明可转换性，真实几何转换由下游服务完成 */
const CONVERTIBLE = {
  glb: ['glb', 'gltf', 'usdz'],
  gltf: ['gltf', 'glb'],
  usdz: ['usdz', 'glb', 'gltf'],
  obj: ['obj', 'stl', 'glb'],
  stl: ['stl', 'obj'],
  fbx: ['fbx', 'glb', 'obj'],
  ply: ['ply', 'obj', 'stl'],
};

/** 验收线：3D 任务成功率 ≥ 70% */
const TARGET_RATE = 70;

/** 取扩展名（小写，去点） */
function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

/** 识别 3D 格式；非 3D 返回 '' */
function detectFormat(name) {
  const e = extOf(name);
  return FORMATS.includes(e) ? e : '';
}

function is3DFormat(name) { return detectFormat(name) !== ''; }

function mimeOf(fmt) { return MIME[String(fmt || '').toLowerCase()] || 'application/octet-stream'; }

/** 规范化目标格式：合法则原样，否则回落 glb */
function normFormat(fmt) {
  const f = String(fmt || '').toLowerCase();
  return FORMATS.includes(f) ? f : 'glb';
}

/**
 * 构造第三方 3D 服务的生成请求体（OpenAI 风格 /3d/generations）
 * @param {string} prompt
 * @param {{model?:string, format?:string, quality?:string}} [opts]
 */
function buildGenRequest(prompt, opts = {}) {
  return {
    model: String(opts.model || 'text-to-3d'),
    prompt: String(prompt || ''),
    format: normFormat(opts.format),
    quality: ['draft', 'standard', 'high'].includes(opts.quality) ? opts.quality : 'standard',
  };
}

/** 任务台账行 → 前端安全视图 */
function normalizeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username || '',
    project_id: row.project_id != null ? row.project_id : null,
    prompt: row.prompt || '',
    format: row.format || '',
    status: row.status || 'queued',
    model: row.model || '',
    provider: row.provider || '',
    url: row.url || '',
    thumb: row.thumb || '',
    asset_id: row.asset_id != null ? row.asset_id : null,
    error: row.error || '',
    duration_ms: row.duration_ms || 0,
    created_at: row.created_at || '',
    finished_at: row.finished_at || '',
  };
}

/**
 * 3D 任务成功率统计（验收口径：成功率 ≥ 70%）
 * 成功率 = success / (success + failed)，进行中（queued/running）不计入分母；无已完成任务时为 null。
 */
function taskStats(tasks = []) {
  const total = tasks.length;
  const success = tasks.filter((t) => t.status === 'success').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  const done = success + failed;
  const successRate = done ? Math.round((success / done) * 10000) / 100 : null;
  return {
    total, success, failed, running,
    successRate,
    target: TARGET_RATE,
    meetsTarget: successRate == null ? null : successRate >= TARGET_RATE,
  };
}

/**
 * 导出计划：源格式 → 目标格式
 * @returns {{ok:boolean, source:string, target:string, needConvert:boolean, mime:string, message:string}}
 */
function exportPlan(sourceFormat, targetFormat) {
  const source = detectFormat('x.' + String(sourceFormat || '')) || String(sourceFormat || '').toLowerCase();
  const target = String(targetFormat || '').toLowerCase();
  if (!FORMATS.includes(source)) return { ok: false, source, target, needConvert: false, mime: '', message: '源文件不是受支持的 3D 格式' };
  if (!FORMATS.includes(target)) return { ok: false, source, target, needConvert: false, mime: '', message: '目标格式不受支持' };
  if (source === target) return { ok: true, source, target, needConvert: false, mime: mimeOf(target), message: '同格式直接导出' };
  const allowed = CONVERTIBLE[source] || [];
  if (allowed.includes(target)) return { ok: true, source, target, needConvert: true, mime: mimeOf(target), message: `需经 ${source} → ${target} 转换` };
  return { ok: false, source, target, needConvert: false, mime: '', message: `不支持从 ${source} 转换到 ${target}` };
}

/**
 * 生成一个最小合法 glTF 2.0 占位模型（离线降级用：未配置第三方 3D 服务时保证链路可跑通、可下载、可导入）
 * 内容为单个三角面，明确标注为占位物。
 */
function placeholderGltf(prompt) {
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const buf = Buffer.alloc(verts.length * 4);
  verts.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  const gltf = {
    asset: { version: '2.0', generator: 'MetaForge D3-1 placeholder (stub)' },
    scene: 0,
    scenes: [{ name: 'stub-scene', nodes: [0] }],
    nodes: [{ name: 'placeholder', mesh: 0 }],
    meshes: [{ name: 'stub-mesh', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + buf.toString('base64'), byteLength: buf.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: buf.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] }],
    extras: { prompt: String(prompt || ''), placeholder: true },
  };
  return Buffer.from(JSON.stringify(gltf), 'utf8');
}

module.exports = {
  FORMATS, MIME, CONVERTIBLE, TARGET_RATE,
  extOf, detectFormat, is3DFormat, mimeOf, normFormat,
  buildGenRequest, normalizeTask, taskStats, exportPlan, placeholderGltf,
};
