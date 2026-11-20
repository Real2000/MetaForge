/**
 * D1-4 可执行技能包内核（2026-11-21）
 *
 * 纯逻辑、零外部依赖。职责：
 *   ① manifest 解析 / 规范化 —— 把建表默认的 '{}' 与用户录入的 JSON 统一成规范结构；
 *   ② manifest 校验 —— entry/params/permissions/deps 合法性（可执行技能的必要条件）；
 *   ③ 供应链校验 —— 内容哈希（完整性）+ HMAC 签名（来源可信）+ 权限声明风险分级。
 *
 * manifest 结构（V1）：
 *   {
 *     name, description, version: '1.0.0', runtime: 'node',
 *     entry: 'main.js',              // 包内入口文件（相对路径）
 *     entry_code: '...',             // 或内联代码（二者其一）
 *     params: { ... },               // 入参 JSON Schema properties（供表单与描述生成）
 *     permissions: ['fs:read', 'fs:write', 'net:api.example.com', 'env'],
 *     secrets: ['API_KEY'],          // 运行期需要按用户注入的密钥名
 *     deps: { 'x': '^1.0.0' },       // 声明依赖（V1 仅记录，不自动安装）
 *     files: { 'main.js': '...' }    // 安装包内文件（entry 之外的辅助文件）
 *   }
 *   manifest 为空 {} → 纯提示词技能（向后兼容，非可执行）。
 */
const crypto = require('crypto');
const path = require('path');

const RUNTIMES = new Set(['node']);
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ENTRY_BYTES = 200 * 1024; // 单文件入口上限

// 允许声明的权限：前缀式白名单（列表外一律拒绝，避免"声明了但没人认"的假权限）
const PERM_RULES = [
  { re: /^fs:read$/, label: '读取沙箱工作目录', risk: 'low' },
  { re: /^fs:write$/, label: '写入沙箱工作目录', risk: 'middle' },
  { re: /^net:[a-z0-9.-]+$/i, label: '访问指定域名网络', risk: 'middle' },
  { re: /^env$/, label: '读取运行期环境变量', risk: 'low' },
];

/** 解析为对象（容错：非法 JSON → {}） */
function parseManifest(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { const o = JSON.parse(String(raw)); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** 规范化为固定字段结构（缺省补全，类型收敛） */
function normalizeManifest(raw) {
  const m = parseManifest(raw);
  return {
    name: String(m.name || '').trim(),
    description: String(m.description || '').trim(),
    version: String(m.version || '1.0.0').trim() || '1.0.0',
    runtime: String(m.runtime || 'node').trim() || 'node',
    entry: String(m.entry || '').trim(),
    entry_code: m.entry_code != null ? String(m.entry_code) : '',
    params: (m.params && typeof m.params === 'object' && !Array.isArray(m.params)) ? m.params : {},
    permissions: Array.isArray(m.permissions) ? m.permissions.map(String) : [],
    secrets: Array.isArray(m.secrets) ? m.secrets.map(String) : [],
    deps: (m.deps && typeof m.deps === 'object' && !Array.isArray(m.deps)) ? m.deps : {},
    files: (m.files && typeof m.files === 'object' && !Array.isArray(m.files)) ? m.files : {},
  };
}

/** 是否可执行（有入口文件或内联代码） */
function isExecutable(raw) {
  const m = normalizeManifest(raw);
  return !!(m.entry_code || m.entry);
}

/**
 * 校验 manifest。
 * @returns {{ ok:boolean, errors:string[], manifest:object, executable:boolean }}
 *   - 空 manifest（无 name/entry/entry_code）= 纯提示词技能：ok=true、executable=false
 *   - 有内容但校验失败：ok=false、errors 列出全部问题
 */
function validateManifest(raw) {
  const m = normalizeManifest(raw);
  const errors = [];
  const blank = !m.name && !m.entry && !m.entry_code && !m.description;
  if (blank) return { ok: true, errors: [], manifest: m, executable: false };

  if (m.name && !NAME_RE.test(m.name)) errors.push('name 仅支持中英文/数字/下划线/中划线，且不超过 40 字');
  if (!RUNTIMES.has(m.runtime)) errors.push(`runtime 暂仅支持：${[...RUNTIMES].join(' / ')}`);
  if (!VERSION_RE.test(m.version)) errors.push('version 需形如 1.0.0（可带 -beta 后缀）');
  if (!m.entry && !m.entry_code) errors.push('可执行技能需提供 entry（入口文件，包内相对路径）或 entry_code（内联代码）');
  if (m.entry) {
    // 防止 ../ 逃逸与绝对路径（安装后按 entry 相对包目录读取）
    if (path.isAbsolute(m.entry) || m.entry.split(/[\\/]/).includes('..')) {
      errors.push('entry 必须是包内相对路径，不得为绝对路径或包含 ..');
    }
  }
  if (m.entry_code && Buffer.byteLength(m.entry_code, 'utf8') > MAX_ENTRY_BYTES) {
    errors.push(`entry_code 过大（上限 ${Math.round(MAX_ENTRY_BYTES / 1024)}KB）`);
  }
  for (const p of m.permissions) {
    if (!PERM_RULES.some(r => r.re.test(p))) errors.push(`未识别的权限声明：${p}（仅支持 fs:read / fs:write / net:<domain> / env）`);
  }
  for (const s of m.secrets) if (!SECRET_NAME_RE.test(s)) errors.push(`非法密钥名：${s}（字母/下划线开头，字母数字下划线，≤64）`);
  for (const f of Object.keys(m.files)) {
    if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) errors.push(`包内文件路径非法：${f}`);
  }
  return { ok: errors.length === 0, errors, manifest: m, executable: true };
}

/** 从权限声明提取网络白名单域名（net:<domain> → domain） */
function netAllowOf(raw) {
  const m = normalizeManifest(raw);
  return m.permissions.filter(p => /^net:/i.test(p)).map(p => p.slice(4).toLowerCase()).filter(Boolean);
}

/** 权限声明风险分级：低（只读）→ 中（写盘或联网）→ 高（写盘 + 联网，数据外泄面最大） */
function permRisk(raw) {
  const m = normalizeManifest(raw);
  const hasWrite = m.permissions.includes('fs:write');
  const hasNet = m.permissions.some(p => /^net:/i.test(p));
  if (hasWrite && hasNet) return 'high';
  if (hasWrite || hasNet) return 'middle';
  return 'low';
}

/** 权限声明的人读摘要（安装确认页/详情展示） */
function summarizePermissions(raw) {
  const m = normalizeManifest(raw);
  return m.permissions.map(p => {
    const rule = PERM_RULES.find(r => r.re.test(p));
    return { permission: p, label: rule ? rule.label : '未识别', risk: rule ? rule.risk : 'high' };
  });
}

/** 稳定的内容哈希：对影响执行语义的字段做规范化后 sha256（16 段 hex 便于展示） */
function contentHash(raw) {
  const m = normalizeManifest(raw);
  const canonical = JSON.stringify({
    name: m.name, version: m.version, runtime: m.runtime,
    entry: m.entry, entry_code: m.entry_code,
    permissions: [...m.permissions].sort(),
    secrets: [...m.secrets].sort(),
    deps: sortedObj(m.deps),
    files: sortedObj(m.files),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sortedObj(o) {
  return Object.keys(o || {}).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
}

/** 签名载荷（版本化前缀，避免与其它模块签名串串味） */
function signaturePayload(name, version, hash) {
  return `skillpkg-v1:${name}:${version}:${hash}`;
}

/** HMAC-SHA256 签名（安装方对内容哈希用平台密钥签名） */
function signPackage(name, version, hash, key) {
  if (!key) return '';
  return crypto.createHmac('sha256', String(key)).update(signaturePayload(name, version, hash)).digest('hex');
}

/**
 * 校验签名（常量时间比较，防时序侧信道）。
 * @returns {boolean} key/signature 任一缺失返回 false（视为未签名）
 */
function verifySignature(name, version, hash, signature, key) {
  if (!key || !signature) return false;
  const expect = signPackage(name, version, hash, key);
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 供应链校验：组装"声明哈希/签名 vs 实算哈希"的裁决结果。
 * @param {object} manifest 规范化前/后的 manifest
 * @param {{declaredHash?:string, signature?:string, key?:string}} opts
 * @returns {{ hash:string, integrity:boolean|null, signature_ok:boolean|null, verified:boolean, notes:string[] }}
 *   integrity: null=未声明哈希（不校验）；true/false=比对结果
 */
function verifySupplyChain(manifest, opts = {}) {
  const m = normalizeManifest(manifest);
  const hash = contentHash(m);
  const notes = [];
  let integrity = null;
  if (opts.declaredHash) {
    integrity = String(opts.declaredHash).toLowerCase() === hash;
    if (!integrity) notes.push('内容哈希与包声明不一致（可能被篡改或版本不符）');
  } else {
    notes.push('包未声明内容哈希，仅记录实算哈希');
  }
  let signature_ok = null;
  if (opts.signature) {
    signature_ok = verifySignature(m.name, m.version, hash, opts.signature, opts.key);
    if (!signature_ok) notes.push('签名验证失败（来源不可信或密钥不匹配）');
  }
  const verified = integrity !== false && signature_ok !== false;
  return { hash, integrity, signature_ok, verified, notes };
}

module.exports = {
  parseManifest, normalizeManifest, isExecutable, validateManifest,
  netAllowOf, permRisk, summarizePermissions, contentHash,
  signaturePayload, signPackage, verifySignature, verifySupplyChain,
  PERM_RULES, RUNTIMES,
};
