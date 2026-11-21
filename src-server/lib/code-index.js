/**
 * D2-1 代码索引内核（2026-11-21）
 *
 * 纯逻辑、零外部依赖。职责：把「仓库目录」变成「按函数/类切片的可检索块」。
 *   ① 语言识别（扩展名 + 文件名）；
 *   ② 目录扫描（忽略 .git/node_modules/dist 等 + 二进制/超大文件）；
 *   ③ 符号抽取：JS/TS / Python / Go / Java 按「函数/类/方法」切块（正则 + 括号/缩进匹配），
 *      其余语言/无法识别符号的文件按「行窗」兜底切块；
 *   ④ 代码感知分词：拆分 camelCase / snake_case / kebab，供 BM25 与符号通道使用。
 *
 * 与知识库分块（段落级）的区别：本模块分片单位是「符号（函数/类）」，命中即整段可读。
 */
const fs = require('fs');
const path = require('path');

/* ---------------- 语言识别 ---------------- */

const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.vue': 'vue', '.svelte': 'svelte',
  '.json': 'json', '.md': 'markdown', '.html': 'html', '.css': 'css', '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift',
};
// 具备「函数/类」结构化切片能力的语言（其余走行窗兜底）
const STRUCTURED_LANGS = new Set(['javascript', 'typescript', 'python', 'go', 'java', 'rust', 'vue', 'svelte', 'c', 'cpp', 'kotlin', 'swift', 'php', 'ruby']);

function detectLang(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile' || base === 'makefile.am') return 'makefile';
  return 'text';
}

/* ---------------- 目录扫描 ---------------- */

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  '.idea', '.vscode', 'tmp', '.temp', 'logs',
]);
const MAX_FILE_BYTES = 1024 * 1024;      // 单文件上限 1MB（超过视为产物/数据，跳过）
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.db', '.sqlite', '.lock']);

/** 判定二进制内容（含 NUL 字节或不可解码比例高） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 扫描目录，返回相对路径列表。
 * @param {string} root 已 realpath 的绝对目录
 * @param {{maxFiles?:number, onProgress?:Function}} opts
 * @returns {string[]} 相对 root 的路径（posix 分隔符）
 */
function scanFiles(root, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles) || 20000);
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        out.push(r);
      }
    }
  };
  walk(root, '');
  return out;
}

/** 读取仓库内文件（相对路径；附逃逸防护 + 大小限制）。返回 {ok, content?, msg?} */
function readRepoFile(root, relPath) {
  const safe = String(relPath || '').replace(/\\/g, '/');
  if (!safe || safe.startsWith('/') || safe.split('/').includes('..')) return { ok: false, msg: '非法文件路径' };
  const abs = path.join(root, safe);
  const rootReal = fs.realpathSync(root);
  let absReal;
  try { absReal = fs.realpathSync(abs); } catch { return { ok: false, msg: '文件不存在' }; }
  if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) return { ok: false, msg: '路径越出仓库根目录' };
  let st; try { st = fs.statSync(absReal); } catch { return { ok: false, msg: '文件不存在' }; }
  if (!st.isFile()) return { ok: false, msg: '不是普通文件' };
  if (st.size > MAX_FILE_BYTES) return { ok: false, msg: `文件过大（>${Math.round(MAX_FILE_BYTES / 1024)}KB）` };
  const buf = fs.readFileSync(absReal);
  if (looksBinary(buf)) return { ok: false, msg: '二进制文件不可读' };
  return { ok: true, content: buf.toString('utf8'), abs: absReal };
}

/* ---------------- 代码感知分词 ---------------- */

/** 拆分标识符：camelCase / snake_case / kebab → 小写词元 */
function splitIdent(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase → camel Case
    .replace(/[_\-./]+/g, ' ')                    // snake/kebab/路径分隔
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** 文本 → 词元集合（代码：拆分标识符 + 保留原词；中文额外 2-gram） */
function codeTerms(s) {
  const set = new Set();
  for (const w of splitIdent(s)) if (w.length > 0) set.add(w);
  // 中文 2-gram（注释里的中文）
  const cjk = String(s || '').replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) set.add(cjk.slice(i, i + 2));
  return [...set];
}

/* ---------------- 符号抽取 ---------------- */

const MAX_SYMBOL_LINES = 400; // 单个符号体过大则截断（防单函数占满索引）

/** 从 startLine 的 '{' 起做括号配平，返回结束行索引（0基，含） */
function matchBrace(lines, startLine) {
  let depth = 0, started = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) return i; }
    }
    if (started && depth === 0) return i;
  }
  return Math.min(lines.length - 1, startLine + MAX_SYMBOL_LINES);
}

/** 中文/JS 正则：抽取函数/类（含方法）。返回 [{kind,name,parent,startLine,endLine}]（行号 1 基） */
function extractSymbols(content, lang) {
  const lines = content.split('\n');
  const syms = [];
  const push = (kind, name, startLine, endLine, parent) => {
    if (!name) return;
    syms.push({ kind, name: String(name).slice(0, 120), parent: parent || null, startLine, endLine: Math.min(endLine, startLine + MAX_SYMBOL_LINES - 1) });
  };

  if (lang === 'python') {
    // def/class 按缩进定界
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
      if (!m) continue;
      const indent = m[1].length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j];
        if (!t.trim()) { end = j; continue; }
        const ind = t.length - t.replace(/^\s+/, '').length;
        if (ind <= indent && /^\s*\S/.test(t)) break;
        end = j;
      }
      push(m[2] === 'class' ? 'class' : 'function', m[3], i + 1, end + 1);
      // 不跳过类体：类内方法（缩进 def）也各自成块（类块=概览、方法块=精确，允许重叠）
    }
    return syms;
  }

  if (lang === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
      if (m) push('function', m[1], i + 1, matchBrace(lines, i) + 1);
      const c = lines[i].match(/^type\s+([A-Za-z_]\w*)\s+struct/);
      if (c) push('class', c[1], i + 1, matchBrace(lines, i) + 1);
    }
    return syms;
  }

  // JS/TS/Java/C/Rust/PHP/Ruby 等：声明式 + 括号配平
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      push('class', m[1], i + 1, matchBrace(lines, i) + 1);
      continue;
    }
    if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) {
      push('function', m[1], i + 1, matchBrace(lines, i) + 1);
      continue;
    }
    // 箭头函数赋值：const foo = (…) => {
    if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/))) {
      push('function', m[1], i + 1, matchBrace(lines, i) + 1);
      continue;
    }
    // 方法：name(...) {  （缩进内，带参数列表且随后有 {）
    if ((m = line.match(/^\s{2,}(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/)) && !/^(if|for|while|switch|catch|function|return)\b/.test(m[1])) {
      push('method', m[1], i + 1, matchBrace(lines, i) + 1);
      continue;
    }
    // Java/C 风格：修饰符 返回类型 name(...) {
    if ((m = line.match(/^\s*(?:public|private|protected|static|final|synchronized|\s)*[A-Za-z_$][\w$<>\[\],\s]*\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/))) {
      if (!/^(if|for|while|switch|catch|new)\b/.test(m[1])) push('method', m[1], i + 1, matchBrace(lines, i) + 1);
    }
  }
  return syms;
}

/**
 * 把文件切成索引块。
 * @returns {Array<{kind,name,parent,startLine,endLine,content}>}
 */
function chunkFile(content, lang) {
  const lines = content.split('\n');
  const chunks = [];
  let syms = [];
  if (STRUCTURED_LANGS.has(lang)) {
    try { syms = extractSymbols(content, lang); } catch { syms = []; }
  }
  if (syms.length) {
    for (const s of syms) {
      const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
      if (body.trim()) chunks.push({ kind: s.kind, name: s.name, parent: s.parent, startLine: s.startLine, endLine: s.endLine, content: body });
    }
    // 文件头（imports/说明）作为概览块，便于按文件级检索
    const firstSym = Math.min(...syms.map(s => s.startLine)) - 1;
    if (firstSym > 0) {
      const head = lines.slice(0, firstSym).join('\n').trim();
      if (head) chunks.push({ kind: 'header', name: '__header__', parent: null, startLine: 1, endLine: firstSym, content: head.slice(0, 4000) });
    }
    return chunks;
  }
  // 兜底：行窗切块（每块 ~40 行，重叠 5 行）
  const WIN = 40, STEP = 35;
  for (let i = 0; i < lines.length; i += STEP) {
    const end = Math.min(lines.length, i + WIN);
    const body = lines.slice(i, end).join('\n');
    if (body.trim()) chunks.push({ kind: 'block', name: null, parent: null, startLine: i + 1, endLine: end, content: body });
    if (end >= lines.length) break;
  }
  return chunks;
}

/* ---------------- 补丁：查找替换 + 统一 diff ---------------- */

/**
 * 对内容做一次查找替换（默认仅替换首个匹配）。
 * @returns {{ok:boolean, content?:string, msg?:string, count?:number}}
 */
function applyFindReplace(content, find, replace, all = false) {
  const text = String(content == null ? '' : content);
  const f = String(find == null ? '' : find);
  if (!f) return { ok: false, msg: 'find 不能为空' };
  const idx = text.indexOf(f);
  if (idx < 0) return { ok: false, msg: '未找到待替换内容（find 与文件当前内容不匹配）' };
  const count = text.split(f).length - 1;
  const out = all ? text.split(f).join(String(replace == null ? '' : replace))
    : text.slice(0, idx) + String(replace == null ? '' : replace) + text.slice(idx + f.length);
  return { ok: true, content: out, count };
}

/**
 * 生成统一 diff（行级 LCS；超长输入退化为前后缀裁剪 + 块替换，保证有界开销）。
 * @returns {{diff:string, additions:number, deletions:number}}
 */
function unifiedDiff(a, b, aName = 'a', bName = 'b') {
  const A = String(a == null ? '' : a).split('\n');
  const B = String(b == null ? '' : b).split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let eA = A.length, eB = B.length;
  while (eA > s && eB > s && A[eA - 1] === B[eB - 1]) { eA--; eB--; }
  const midA = A.slice(s, eA), midB = B.slice(s, eB);
  let ops; // [ {t:' '|'-'|'+', line} ]
  if (midA.length * midB.length <= 4000000) {
    ops = lcsOps(midA, midB);
  } else {
    ops = midA.map(l => ({ t: '-', line: l })).concat(midB.map(l => ({ t: '+', line: l })));
  }
  // 组装（带上少量上下文）
  const CTX = 3;
  const before = A.slice(Math.max(0, s - CTX), s);
  const after = A.slice(eA, eA + CTX);
  const body = [];
  for (const l of before) body.push(' ' + l);
  for (const o of ops) body.push((o.t === ' ' ? ' ' : o.t) + o.line);
  for (const l of after) body.push(' ' + l);
  let additions = 0, deletions = 0;
  for (const o of ops) { if (o.t === '+') additions++; else if (o.t === '-') deletions++; }
  const oldStart = Math.max(1, s + 1 - before.length);
  const newStart = Math.max(1, s + 1 - before.length);
  const oldCount = before.length + (midA.length) + after.length;
  const newCount = before.length + (midB.length) + after.length;
  const header = `--- ${aName}\n+++ ${bName}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return { diff: header + '\n' + body.join('\n'), additions, deletions };
}

/** 行级 LCS → 操作序列 */
function lcsOps(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: ' ', line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: A[i] }); i++; }
    else { ops.push({ t: '+', line: B[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: A[i++] });
  while (j < m) ops.push({ t: '+', line: B[j++] });
  return ops;
}

module.exports = {
  detectLang, scanFiles, readRepoFile,
  splitIdent, codeTerms, extractSymbols, chunkFile,
  applyFindReplace, unifiedDiff,
  LANG_BY_EXT, STRUCTURED_LANGS, IGNORE_DIRS, MAX_FILE_BYTES,
};
