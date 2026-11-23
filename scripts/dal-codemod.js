#!/usr/bin/env node
/**
 * BE-C1 收尾工具（2026-11-23）：裸 db.prepare/db.exec → dal 统一出口批量转换（codemod）
 *
 * 背景：BE-C1 棘轮门禁（lint-bare-prepare.js）下存量裸查 1598 处，目标 ≤50。
 *       形态分析（.temp/analyze-bare-patterns.js）显示 99.2% 为可直接恒等转换的形态：
 *         db.prepare(SQL).all(a,b)  → dal.q(SQL, [a,b])     （多行，恒等：q=getq=runq 走方言层恒等翻译）
 *         db.prepare(SQL).get(a,b)  → dal.getq(SQL, [a,b])   （单行）
 *         db.prepare(SQL).run(a,b)  → dal.runq(SQL, [a,b])   （写入；runq 返回 {changes,lastInsertRowid} 与 .run() 同构）
 *         db.prepare(SQL).pluck().get(a,b) → dal.pluck(SQL, [a,b])
 *         db.exec(SQL)             → dal.exec(SQL)
 *       无参调用省略第二实参（q/getq/runq/pluck 内部对非数组 params 回落 []，零差异）。
 *
 * 为什么参数直接包一层 [] 而不重新切分：调用实参文本 `a, b` 在数组字面量 `[a, b]` 中
 * 逗号语义完全一致（顶层逗号即元素分隔），原样保留可避免任何切分/重构引入的语义偏差
 * ——codemod 只做最小字符串手术，其余字节逐字保留。
 *
 * 保守策略：
 *   - 语句复用（const stmt = db.prepare(...)）、.iterate()/.raw()、pluck 后非 get、
 *     字符串/注释内的匹配 —— 一律跳过并打印清单，绝不盲改（人工处理，全库仅 ~13 处）。
 *   - ALLOWLIST 框架层文件（dal/migrate/retriever 等）不处理。
 *   - 已 require dal 的文件复用其变量名；未 require 的自动注入（按目录深度算相对路径）。
 *
 * 用法：
 *   node scripts/dal-codemod.js                    # 分析模式（只读，打印每文件转换/跳过清单）
 *   node scripts/dal-codemod.js --write            # 全量写入（逐文件原子对账：转换数+跳过数=原计数）
 *   node scripts/dal-codemod.js --write <文件>     # 单文件写入（试点用）
 *
 * 转换后必做：node --check <改动文件> && npm run lint:sql && npm test（全量 smoke 验证零回归）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST = new Set([
  'src-server/db.js', 'src-server/lib/dal.js', 'src-server/lib/migrate.js',
  'src-server/lib/sql-dialect.js', 'src-server/lib/db-driver.js', 'src-server/lib/audit.js',
  'src-server/lib/vector-index.js', 'src-server/lib/retriever.js', 'src-server/lib/graphrag.js',
  'src-server/lib/memory-recall.js', 'src-server/lib/rag-metrics.js', 'src-server/lib/ingestion-pipeline.js',
  'src-server/lib/workflow.js', 'src-server/lib/access-log.js',
]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ---------- 轻量词法状态机：只在「普通代码」状态识别 db.prepare(/db.exec( ---------- */

/**
 * 判断 src[i]（指向 '/'）是否为正则字面量开头（而非除号/注释——注释已由调用方先行处理）。
 * 依据前一有效字符：运算符/开括号/关键字之后为正则；标识符/闭括号之后为除号。
 * 为什么必须识别正则：模板插值中的 /"/g（如 share 卡片 iframe 模板）若被误判，
 * '/' 会被当除号放过、而其中的引号会被 skipString 误当字符串起点——曾导致 L1039-1319
 * 整段被吞成「字符串」（chat/agents/tools-extra 共 143 处真实裸查被误报为非代码）。
 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0) {
    const ch = src[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { j--; continue; }
    if ('([,;=!&|?:{}+-*/%^~<>`'.includes(ch)) return true;
    // 标识符字符 → 回取完整单词判断是否关键字（return /xxx/ 常见）
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
      const word = src.slice(k + 1, j + 1);
      return ['return', 'typeof', 'in', 'of', 'case', 'do', 'else', 'new', 'delete', 'void', 'instanceof', 'yield', 'await'].includes(word);
    }
    return false; // 闭括号/引号后 → 除号
  }
  return true; // 文件开头 → 正则
}

/** 从 i（指向正则开头 '/'）跳过整个正则字面量（含字符类与 flag），返回结束后的索引 */
function skipRegex(src, i) {
  i++; let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) { i++; break; }
    if (ch === '\n') break; // 未闭合换行 → 不是正则（防御：按普通 '/' 回退，宁可漏转换不误吞）
    i++;
  }
  while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
  return i;
}

/** 从 i（指向字符串起始引号）跳过整个字符串字面量，返回结束后的索引 */
function skipString(src, i) {
  const q = src[i]; i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    // 模板字符串中的 ${...} 插值可能包含任意表达式（含引号/嵌套模板/正则）——进入子状态扫描到配对的 }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      i += 2; let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') { depth++; i++; continue; }
        if (c === '}') { depth--; i++; continue; }
        if (c === '`' || c === "'" || c === '"') { i = skipString(src, i); continue; }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
          if (src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; }
          else { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
          continue;
        }
        if (c === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
        i++;
      }
      continue;
    }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** 找到「普通代码」中的所有 db.prepare( / db.exec( 出现区间（[start,end)，end 指向 '('） */
function findHits(src) {
  const hits = [];
  let i = 0, n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (ch === 'd' && src.startsWith('db.', i)) {
      const m = /^db\.(prepare|exec)\s*\(/.exec(src.slice(i));
      if (m) {
        hits.push({ kind: m[1], sqlStart: i, openParen: i + m[0].length - 1 });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return hits;
}

/** 从 open（指向 '('）配对到闭括号，考虑字符串字面量；返回 ')' 索引 */
function matchParen(src, open) {
  let depth = 0, i = open, n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 跳过空白与注释，返回下一有效字符索引 */
function skipWs(src, i) {
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    break;
  }
  return i;
}

/** 行号计算（按 \n 计数到 pos） */
function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos; i++) if (src[i] === '\n') line++;
  return line;
}

/* ---------- 单文件转换 ---------- */

/** 计算该文件 require dal 的相对路径（按目录深度；src-server/lib 下为 ./dal） */
function dalRelPath(rel) {
  const dir = path.posix.dirname(rel); // 如 src-server/lib / src-server/routes / src-server
  if (dir === 'src-server') return './lib/dal';
  if (dir === 'src-server/lib') return './dal';
  return path.posix.join(path.posix.relative(dir, 'src-server/lib'), 'dal');
}

/** 查文件里已有的 dal require 变量名；返回 {name} 或 null
 *  2026-11-23 修复：此前宽松匹配 `[^'']*dal['"]` 且不校验 require(...) 后缀，导致
 *  `const scope = require('../lib/dal').tenantScope(req)`（MT-05 租户作用域调用，返回数字）
 *  被误判为「dal 整体引入」→ 全文件以 scope 作出口名转换 → 运行时 scope is not defined
 *  （chat.js 106 处 / tasks.js 20 处污染，28 个 smoke 用例失败实锤）。收紧为：
 *  ① 路径必须以 /dal 结尾（排除 dal-scope 等同名前缀模块）；② require() 之后必须是分号或行尾
 *  （排除 .tenantScope(req) 等属性链式调用——那是取属性，不是引入模块对象）。 */
function existingDalVar(src) {
  const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"][^'']*\/dal['"]\s*\)\s*(?:;|$)/m.exec(src);
  return m ? { name: m[1] } : null;
}

/** 在首个「顶层」require 语句行后注入 dal require；返回新 src
 *  2026-11-23 修复：此前行首空白匹配允许缩进——若文件首个 require 位于函数体内（惰性 require 模式），
 *  会把 dal 引入注入到函数内部（局部作用域），顶层调用点仍然未定义。收紧为仅匹配行首无缩进（顶层）。 */
function injectDalRequire(src, relPath) {
  const lines = src.split('\n');
  const idx = lines.findIndex(l => /^(?:const|let|var)\s.*require\(/.test(l));
  const inject = `const dal = require('${relPath}'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）`;
  if (idx >= 0) lines.splice(idx + 1, 0, inject);
  else lines.unshift(inject);
  return lines.join('\n');
}

/**
 * 转换单文件。返回 { rel, converted, skipped: [{line, why, snippet}], src, changed }
 * 逐命中做最小手术：从后往前替换避免位置失效。
 */
function transformFile(absFile, rel, doWrite) {
  let src = fs.readFileSync(absFile, 'utf8');
  const hits = findHits(src);
  if (!hits.length) return null;
  let dalVar = existingDalVar(src)?.name || null;

  const converted = [];
  const skipped = [];
  // 倒序处理
  for (let h = hits.length - 1; h >= 0; h--) {
    const { kind, sqlStart, openParen } = hits[h];
    const sqlClose = matchParen(src, openParen);
    if (sqlClose < 0) { skipped.push({ line: lineOf(src, sqlStart), why: 'prepare 括号未闭合', snippet: src.slice(sqlStart, sqlStart + 60) }); continue; }
    const line = lineOf(src, sqlStart);

    if (kind === 'exec') {
      // db.exec(SQL) → dal.exec(SQL)：仅换前缀（exec 无参绑定语义，恒等）
      src = src.slice(0, sqlStart) + `${dalVar || 'dal'}.exec(` + src.slice(openParen + 1);
      converted.push({ line, form: 'exec' });
      continue;
    }

    // prepare 形态：看闭括号后的后缀
    let i = skipWs(src, sqlClose + 1);
    const after = src.slice(i, i + 16);
    let form = null, suffixStart = -1, argOpen = -1;
    if (/^\.all\s*\(/.test(after)) { form = 'q'; suffixStart = i; argOpen = i + after.search(/\(/); }
    else if (/^\.get\s*\(/.test(after)) { form = 'getq'; suffixStart = i; argOpen = i + after.search(/\(/); }
    else if (/^\.run\s*\(/.test(after)) { form = 'runq'; suffixStart = i; argOpen = i + after.search(/\(/); }
    else if (/^\.pluck\s*\(/.test(after)) {
      const pluckClose = matchParen(src, i + after.search(/\(/));
      const j = skipWs(src, pluckClose + 1);
      if (/^\.get\s*\(/.test(src.slice(j, j + 10))) {
        form = 'pluck'; suffixStart = i; argOpen = j + src.slice(j, j + 10).search(/\(/);
      }
    }
    if (!form) {
      skipped.push({ line, why: '语句复用/非常规后缀（需人工）', snippet: (src.slice(sqlStart, sqlStart + 80).replace(/\n/g, '\\n')) });
      continue;
    }
    const argClose = matchParen(src, argOpen);
    if (argClose < 0) { skipped.push({ line, why: '调用括号未闭合', snippet: src.slice(sqlStart, sqlStart + 60) }); continue; }
    const argsText = src.slice(argOpen + 1, argClose);
    const noArgs = argsText.trim() === '';

    // 最小手术（三段替换，从后往前）：
    //   db.prepare( SQL )  .all( args )  →  dal.q( SQL , [ args ] )
    //    ① argClose 的 ')' → '])'（无参则 ']'）
    //    ② [sqlClose, argOpen+1)（').all(' 整段）→ 有参 ', ['（prepare 闭括号一并被替换——它是 .run( 的括号）
    //       / 无参 ')'（prepare 闭括号升级为 dal.q 的闭括号）
    //    ③ sqlStart..openParen 段（'db.prepare('）→ `${dalVar}.${form}(`
    const prefix = `${dalVar || 'dal'}.${form}(`;
    if (noArgs) {
      src = src.slice(0, argClose) + src.slice(argClose + 1);            // 删掉调用的 ')'（prepare 的 ')' 保留）
      src = src.slice(0, sqlClose + 1) + src.slice(argOpen + 1);         // 删掉 '.all(' 段，保留 prepare 的 ')'
      src = src.slice(0, sqlStart) + prefix + src.slice(openParen + 1);  // 'db.prepare(' → 'dal.q('
    } else {
      src = src.slice(0, argClose) + '])' + src.slice(argClose + 1);
      src = src.slice(0, sqlClose) + ', [' + src.slice(argOpen + 1);      // ').run(' → ', ['（prepare 闭括号不保留）
      src = src.slice(0, sqlStart) + prefix + src.slice(openParen + 1);
    }
    converted.push({ line, form });
  }

  const changed = converted.length > 0;
  if (changed && !dalVar) {
    src = injectDalRequire(src, dalRelPath(rel));
    dalVar = 'dal';
  }
  // 对账（词法口径）：转换后真实剩余的 db.prepare/exec 应恰等于跳过数；
  // 正则口径 remain 会多出「注释/字符串中」的虚数（lint 同口径），只作对照打印
  const remain = (src.match(/db\.(prepare|exec)\s*\(/g) || []).length;
  const hitsAfter = findHits(src);
  const nonCode = remain - hitsAfter.length;
  return {
    rel, converted, skipped, src, changed, remain, expectRemain: skipped.length,
    hitsAfter: hitsAfter.length, nonCode,
  };
}

/* ---------- main ---------- */

function main() {
  const args = process.argv.slice(2);
  const doWrite = args.includes('--write');
  const fileArg = args.find(a => !a.startsWith('--'));

  let files = [];
  if (fileArg) {
    files = [path.resolve(fileArg)];
  } else {
    const all = [];
    const srcDir = path.join(ROOT, 'src-server');
    if (fs.existsSync(srcDir)) walk(srcDir, all);
    files = all.filter(f => {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      return !ALLOWLIST.has(rel);
    });
  }

  let totConv = 0, totSkip = 0, totRemain = 0;
  const convFiles = 0;
  let okFiles = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    let r;
    try { r = transformFile(f, rel, doWrite); } catch (e) {
      console.error(`✗ ${rel}: 转换异常 ${e.message}`);
      continue;
    }
    if (!r) continue;
    const nConv = r.converted.length, nSkip = r.skipped.length;
    if (nConv === 0 && nSkip === 0) continue;
    okFiles++;
    totConv += nConv; totSkip += nSkip; totRemain += r.remain;
    const bad = r.hitsAfter !== r.expectRemain;
    const flag = bad ? `  ⚠ 词法对账不符！after=${r.hitsAfter} expect=${r.expectRemain}` : (r.nonCode ? `  （另有 ${r.nonCode} 处在注释/字符串中——lint 口径计数，建议顺手清理措辞）` : '');
    console.log(`${doWrite ? '✍' : '·'} ${rel}: 转换 ${nConv} / 跳过 ${nSkip} → 剩余 ${r.remain}${flag}`);
    for (const s of r.skipped) console.log(`    ✋ L${s.line} ${s.why}: ${s.snippet.slice(0, 70)}`);
    if (doWrite && r.changed && !bad) {
      fs.writeFileSync(f, r.src, 'utf8');
    } else if (doWrite && bad) {
      console.error(`    ✗ 词法对账不符，${rel} 未写入（保持原样，请人工检查）`);
    }
  }
  console.log(`\n==== ${doWrite ? '写入' : '分析'}完成：${okFiles} 文件 / 转换 ${totConv} / 跳过 ${totSkip} / 转后剩余 ${totRemain} ====`);
  if (doWrite) console.log('后续必做：node --check 各改动文件 && npm run lint:sql && npm test');
}

main();
