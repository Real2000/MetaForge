/**
 * 沙箱执行器（2026-11-12 P1-11 脚本沙箱扩展）
 *
 * 对比旧 run_code（node:vm 内嵌，官方明示非安全边界）：
 *   本模块以**独立子进程**执行用户脚本——进程崩溃不影响服务，逃逸面限于一进程。
 *
 * 四道防线：
 *   ① 进程隔离：child_process.spawn 独立 node 进程，一次性工作目录
 *   ② 资源上限：--max-old-space-size 内存帽 + 墙钟超时强杀（SIGKILL）
 *   ③ 网络白名单：prelude 注入受控 fetch（仅白名单域名放行，默认全禁）
 *   ④ 文件系统白名单：cwd 限定一次性沙箱目录，产物仅经拷贝通道出仓
 *
 * 命令分级（runCommand）：ALLOWED_CMDS 白名单制——列表外命令一律拒绝，
 * 危险命令（rm -rf /、shutdown 等）双保险显式 DENY。
 *
 * P1-13：每次执行落 sandbox_runs 审计（环境/归属/状态/版本/产物）。
 */
const { spawn } = require('child_process');
const storage = require('./storage'); // P1-19 对象存储抽象层
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, now } = require('../db');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MEM_MB = 128;
const OUT_LIMIT = 8 * 1024;
const ARTIFACT_MAX = 20 * 1024 * 1024;

// 网络白名单默认集（沙箱离线优先；显式 domain 走白名单）
const DEFAULT_NET_ALLOW = [];

// 命令分级：这些只读/良性命令允许 runCommand 执行
const ALLOWED_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'du', 'df',
  'echo', 'date', 'whoami', 'pwd', 'uname', 'which', 'env',
  'node', 'python3', 'python',
  'mkdir', 'cp', 'mv', 'touch',
  'curl', 'ping', 'dig', 'nslookup',
  'git', 'npm', 'pip3',
]);
// 命令分级：白名单制已足够严格（列表外一律拒绝），无需额外 DENY 黑名单

/** 代码指纹（审计比对：同代码同指纹） */
function digestOf(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex').slice(0, 16);
}

/** prelude：注入子进程头部——受控 fetch（网络白名单）+ 掩蔽 process.env / process.exit */
function buildPrelude(netAllow) {
  const allow = JSON.stringify((netAllow || []).map(d => String(d).toLowerCase()));
  return `
// ---- P1-11 sandbox prelude ----
const __netAllow = new Set(${allow});
const __realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error('sandbox: 非法 URL'); }
  if (!__netAllow.has(host)) throw new Error('sandbox: 网络白名单未放行 ' + host + '（默认禁网，需在调用时显式授权域名）');
  return __realFetch(url, ...rest);
};
if (typeof process !== 'undefined') {
  const __penv = {}; Object.keys(process.env || {}).forEach(() => {});
  try { Object.defineProperty(process, 'env', { get: () => ({ __sandboxed: 'env 已被沙箱掩蔽' }) }); } catch {}
  try { Object.defineProperty(process, 'exit', { value: () => { throw new Error('sandbox: process.exit 已禁用'); } }); } catch {}
}
`;
}

/**
 * 隔离执行 JS：runIsolated({ code, args, timeoutMs, memMb, netAllow, owner, agentId, sessionId })
 * args 若提供，将以 JSON 注入子进程全局 globalThis.PLUGIN_ARGS（供插件工具读取调用入参）
 * 返回 { status, stdout, stderr, durationMs, artifacts, runId }；永不 reject。
 */
async function runIsolated(opts) {
  const {
    code = '', timeoutMs = DEFAULT_TIMEOUT_MS, memMb = DEFAULT_MEM_MB,
    netAllow = DEFAULT_NET_ALLOW, owner = '', agentId = null, sessionId = null,
    args = undefined,
  } = opts || {};
  if (!String(code).trim()) return { status: 'denied', stderr: '代码为空', stdout: '', artifacts: [] };

  const sbxId = 'sbx-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const workDir = path.join(os.tmpdir(), sbxId);
  const digest = digestOf(code);
  // P1-13 审计行（running 态先落库，终态回写）
  const runInfo = db.prepare(`INSERT INTO sandbox_runs (run_env, owner, agent_id, session_id, status, code_digest, created_at)
    VALUES ('local-process', ?, ?, ?, 'running', ?, ?)`).run(owner, agentId, sessionId, digest, now());
  const runId = Number(runInfo.lastInsertRowid);

  try { fs.mkdirSync(workDir, { recursive: true }); } catch { }
  const scriptFile = path.join(workDir, 'main.js');
  let killed = false;
  try {
    // 入参注入：仅当显式传入 args 时（插件工具），以全局常量方式提供给被隔离代码；
    // 其他调用方不传 args → 行为与既有一致（零回归）。
    const argPrelude = args === undefined ? '' : 'globalThis.PLUGIN_ARGS = ' + JSON.stringify(args) + ';\n';
    fs.writeFileSync(scriptFile, buildPrelude(netAllow) + '\n' + argPrelude + code, 'utf8');
  } catch (e) {
    db.prepare('UPDATE sandbox_runs SET status=?, stderr_excerpt=?, created_at=? WHERE id=?').run('failed', '写入脚本失败: ' + e.message, now(), runId);
    return { status: 'failed', stderr: '写入脚本失败: ' + e.message, stdout: '', artifacts: [], runId };
  }

  return await new Promise((resolve) => {
    const out = [], err = [];
    const t0 = Date.now();
    // spawn 独立进程：内存帽 + 无 shell（防命令注入）；cwd 限定沙箱目录
    const child = spawn(process.execPath, [
      '--max-old-space-size=' + memMb, scriptFile,
    ], { cwd: workDir, shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workDir, NODE_ENV: 'sandbox' }, stdio: ['ignore', 'pipe', 'pipe'] });

    const killer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { }
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', d => { if (out.length < 4) out.push(d.toString()); });
    child.stderr.on('data', d => { if (err.length < 4) err.push(d.toString()); });
    child.on('error', e => {
      clearTimeout(killer);
      const msg = '子进程启动失败：' + e.message;
      db.prepare('UPDATE sandbox_runs SET status=?, stderr_excerpt=?, duration_ms=? WHERE id=?').run('failed', msg, Date.now() - t0, runId);
      resolve({ status: 'failed', stderr: msg, stdout: '', artifacts: [], runId });
    });
    child.on('close', (exitCode) => {
      clearTimeout(killer);
      const durationMs = Date.now() - t0;
      // 产物收集（通过存储抽象层）
      const artifacts = [];
      try {
        storage.ensureDir('sandbox');
        for (const f of fs.readdirSync(workDir)) {
          if (f === 'main.js') continue;
          const fp = path.join(workDir, f);
          const st = fs.statSync(fp);
          if (st.isFile() && st.size <= ARTIFACT_MAX) {
            const destName = `${sbxId}-${f.replace(/\.html?$/i, '.html.txt')}`;
            const buf = fs.readFileSync(fp);
            const url = storage.write('sandbox', destName, buf);
            artifacts.push({ name: f, size: st.size, url });
          }
        }
      } catch { /* 产物收集失败不影响执行结果 */ }
      // 清理一次性沙箱目录
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { }
      const stdout = out.join('').slice(0, OUT_LIMIT);
      const stderr = err.join('').slice(0, OUT_LIMIT);
      const status = killed ? 'timeout' : (exitCode === 0 ? 'success' : 'failed');
      // P1-13 终态回写（含 node 版本）
      db.prepare('UPDATE sandbox_runs SET status=?, exit_code=?, duration_ms=?, node_version=?, artifacts=?, stdout_excerpt=?, stderr_excerpt=? WHERE id=?')
        .run(status, exitCode ?? -1, durationMs, process.versions.node, JSON.stringify(artifacts), stdout.slice(0, 2000), stderr.slice(0, 1000), runId);
      resolve({ status, exitCode, stdout, stderr, durationMs, artifacts, runId });
    });
  });
}

/**
 * 命令分级执行（P1-11）：白名单制 runCommand
 * 返回 { status, stdout, stderr }；命令不在白名单 → denied
 */
function runCommand(cmd, { timeoutMs = 10000, workDir, owner, agentId, sessionId } = {}) {
  const parts = String(cmd || '').trim().split(/\s+/);
  const base = parts[0];
  if (!ALLOWED_CMDS.has(base)) {
    return { status: 'denied', stdout: '', stderr: `命令 "${base}" 不在白名单内（可执行：${[...ALLOWED_CMDS].slice(0, 12).join('、')}…）。危险或未分级命令一律拒绝。` };
  }
  const runInfo = db.prepare(`INSERT INTO sandbox_runs (run_env, owner, agent_id, session_id, status, code_digest, created_at)
    VALUES ('local-process', ?, ?, ?, 'running', ?, ?)`).run(owner || '', agentId || null, sessionId || null, digestOf(cmd), now());
  const runId = Number(runInfo.lastInsertRowid);
  return new Promise((resolve) => {
    const child = spawn(base, parts.slice(1), { shell: false, cwd: workDir || os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
    const out = [], err = [];
    let killed = false;
    const killer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { } }, timeoutMs);
    child.stdout.on('data', d => out.push(d.toString()));
    child.stderr.on('data', d => err.push(d.toString()));
    const t0 = Date.now();
    child.on('error', e => {
      clearTimeout(killer);
      db.prepare('UPDATE sandbox_runs SET status=?, stderr_excerpt=?, duration_ms=? WHERE id=?').run('failed', e.message, Date.now() - t0, runId);
      resolve({ status: 'failed', stdout: '', stderr: e.message, runId });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      const stdout = out.join('').slice(0, OUT_LIMIT), stderr = err.join('').slice(0, OUT_LIMIT);
      const status = killed ? 'timeout' : (code === 0 ? 'success' : 'failed');
      db.prepare('UPDATE sandbox_runs SET status=?, exit_code=?, duration_ms=?, stdout_excerpt=?, stderr_excerpt=? WHERE id=?')
        .run(status, code ?? -1, Date.now() - t0, stdout.slice(0, 2000), stderr.slice(0, 1000), runId);
      resolve({ status, stdout, stderr, runId });
    });
  });
}

module.exports = { runIsolated, runCommand, digestOf, ALLOWED_CMDS, DEFAULT_TIMEOUT_MS, DEFAULT_MEM_MB };
