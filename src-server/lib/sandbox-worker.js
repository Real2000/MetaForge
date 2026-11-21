/**
 * 沙箱池预热工作进程（D3-3，2026-11-21）
 *
 * 生命周期：由 sandbox-pool.js 预 spawn（预热）→ 常驻等待一次性作业 →
 *   收到 stdin 一行 JSON 作业 → 在本进程内执行用户代码（复用 runIsolated 的 prelude 语义：
 *   受控 fetch 网络白名单 + process.env/process.exit 掩蔽；vm 执行 → require/module 不可见）
 *   → 回写一行结果 JSON（带 __POOL_RESULT__ 前缀）到 stdout → 自毁退出。
 *
 * 隔离语义：每个作业独占一个进程 + 一个一次性工作目录（由池从快照播种）；
 *   作业结束进程即销毁，跨作业/跨租户不共享任何内存或目录状态。
 *
 * 作业格式：{ code, netAllow:[域名], globals:{K:V}, timeoutMs }
 * 结果格式：{ status, stdout, stderr, exitCode, durationMs, files:[工作目录文件] }
 */
const vm = require('vm');
const fs = require('fs');

const OUT_LIMIT = 8 * 1024;
const proc = process; // 捕获真实引用（随后会被掩蔽的仅是 globalThis.process.env/exit）

let buf = '';
proc.stdin.setEncoding('utf8');
proc.stdin.on('data', (d) => {
  buf += d;
  const i = buf.indexOf('\n');
  if (i >= 0) runJob(buf.slice(0, i));
});
proc.stdin.on('end', () => { /* 无作业即退出 */ });

function fmt(a) {
  return a.map((x) => {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(' ');
}

function runJob(line) {
  let job = {};
  try { job = JSON.parse(line) || {}; } catch { job = {}; }
  const out = [], err = [];
  const t0 = Date.now();
  let files = [];
  try { files = fs.readdirSync(proc.cwd()); } catch { /* 目录不可读则留空 */ }

  const allow = new Set((job.netAllow || []).map((x) => String(x).toLowerCase()));
  const realFetch = globalThis.fetch;
  // 注入点先放到 globalThis，prelude 再搬进脚本局部作用域并删除全局，防止用户代码回读
  globalThis.__poolConsole = {
    log: (...a) => out.push(fmt(a)),
    info: (...a) => out.push(fmt(a)),
    debug: (...a) => out.push(fmt(a)),
    warn: (...a) => err.push(fmt(a)),
    error: (...a) => err.push(fmt(a)),
  };
  globalThis.__poolFetch = async (url, ...rest) => {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error('sandbox: 非法 URL'); }
    if (!allow.has(host)) throw new Error('sandbox: 网络白名单未放行 ' + host + '（默认禁网，需在调用时显式授权域名）');
    return realFetch(url, ...rest);
  };
  // 注入调用方提供的全局常量（如插件参数），仅合法标识符
  if (job.globals && typeof job.globals === 'object') {
    for (const [k, v] of Object.entries(job.globals)) {
      if (/^[A-Za-z_$][\w$]*$/.test(k)) globalThis[k] = v;
    }
  }

  // 与 runIsolated.buildPrelude 同语义：受控 fetch + 环境/退出掩蔽（此处以 vm 局部作用域落地）
  const prelude = `
const console = globalThis.__poolConsole;
const fetch = globalThis.__poolFetch;
delete globalThis.__poolConsole; delete globalThis.__poolFetch;
if (typeof process !== 'undefined') {
  try { Object.defineProperty(process, 'env', { get: () => ({ __sandboxed: 'env 已被沙箱掩蔽' }), configurable: true }); } catch {}
  try { Object.defineProperty(process, 'exit', { value: () => { throw new Error('sandbox: process.exit 已禁用'); }, configurable: true }); } catch {}
}
`;

  let finished = false;
  const finish = (status, exitCode, e) => {
    if (finished) return;
    finished = true;
    if (e) err.push('Error: ' + (e && e.message ? e.message : String(e)));
    const res = {
      status,
      stdout: out.join('').slice(0, OUT_LIMIT),
      stderr: err.join('').slice(0, OUT_LIMIT),
      exitCode,
      durationMs: Date.now() - t0,
      files,
    };
    proc.stdout.write('\n__POOL_RESULT__' + JSON.stringify(res) + '\n');
    // 给 stdout 刷新留一帧，随后自毁（一次性进程）
    setTimeout(() => proc.exit(0), 10);
  };

  try {
    const wrapped = '(async () => {\n' + String(job.code || '') + '\n})()';
    const p = vm.runInThisContext(prelude + wrapped, { filename: 'sandbox-pool.js' });
    Promise.resolve(p).then(
      () => finish('success', 0),
      (e) => finish('failed', 1, e),
    );
  } catch (e) {
    finish('failed', 1, e);
  }
}
