#!/usr/bin/env node
/**
 * TeleAgent 本地桥守护进程（P5.27 桌面操控 · 客户端服务）
 * ---------------------------------------------------------------
 * 职责：与智能体平台配对后，轮询拉取任务队列，在**本机白名单内**执行桌面操作，
 *       并把结果回推平台——让网页对话中的 AI 获得"操作我电脑"的受限能力。
 *
 * 通信模式：轮询（平台 → 桥 拉取），无需公网穿透/端口暴露；
 * 鉴权：device_token（32 位随机 hex，首次启动生成，存本机配置）
 *
 * 安全设计（多层）：
 *   1. 操作白名单 + 三档权限：readonly（纯读/看）< standard（常规写，备份先行）< full（键鼠注入/终端/脚本），
 *      op 必须落在设备档位允许集合内（服务端按档位拦截 + 桥端二次校验，防御纵深）
 *   2. 路径约束：文件类 op 仅限用户主目录（$HOME）内，resolve 后前缀校验，
 *      拒绝 ~/Library 系统区与路径穿越（..）
 *   3. open_app 仅 `open -a <应用名>`（macOS LaunchServices，应用名经字符白名单校验，无 shell 元字符）
 *   4. terminal 仅白名单只读命令（execFile 不经 shell）；run_python 走 python3 -c（full 档，需显式授权）
 *   5. 写操作（file_write/file_patch）写前自动备份到 backups/，回推 backup_id 供一键回滚（file_restore）
 *   6. 单飞任务：同一时刻最多执行 1 个任务，防并发滥用
 *   7. 全部动作写本地日志（~/Library/Logs/teleagent-bridge.log）可审计
 *   8. 服务端每 op 执行后落 op_logs（含用户/操作/参数摘要/耗时/结果状态），运营页可检索（A2 完成 2026-11-09）
 *
 * 自启动：launchd（~/Library/LaunchAgents/com.teleagent.bridge.plist，KeepAlive）
 * 平台地址：默认 http://localhost:3210，安装时/配置可改
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const CONF_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'TeleAgentBridge');
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'teleagent-bridge.log');

// ---------- 配置 ----------
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch { }
  let dirty = false;
  if (!cfg.device_token) { cfg.device_token = crypto.randomBytes(16).toString('hex'); dirty = true; }
  if (!cfg.platform_url) { cfg.platform_url = process.env.AP_PLATFORM_URL || 'http://localhost:3210'; dirty = true; }
  if (!cfg.device_name) { cfg.device_name = `${os.hostname()} (${process.platform})`; dirty = true; }
  if (!cfg.poll_interval) { cfg.poll_interval = 2000; dirty = true; }
  if (dirty) { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2)); }
  return cfg;
}
const CFG = loadConfig();

// D2-3 桌面端升级通道：客户端版本号（随发布包递增；自动更新据此与平台发布清单比对）
const BRIDGE_VERSION = '1.0.0';

// ---------- 日志（追加写，轮转保护：>5MB 截断） ----------
function log(...a) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${a.join(' ')}\n`;
  try {
    try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0); } catch { }
    fs.appendFileSync(LOG_FILE, line);
  } catch { }
  console.log(line.trim());
}

// ---------- 操作白名单 + 三档权限（与服务端 TIER_OPS 保持一致，客户端二次校验） ----------
const HOME = os.homedir();
const HOME_BLOCK_PREFIXES = [path.join(HOME, 'Library')]; // 系统区拒绝写/列
const BACKUP_DIR = path.join(CONF_DIR, 'backups'); // D1-1：写前备份存放（file_restore 回滚源）

// D1-1 三档权限（与服务端 routes/localbridge.js 的 TIER_OPS 同构；桥端为第二层防线）
const TIER_ORDER = { readonly: 0, standard: 1, full: 2 };
const TIER_OPS = {
  readonly: ['list_dir', 'file_read', 'file_diff', 'clipboard_read', 'window_list', 'screenshot'],
  standard: ['mkdir', 'open_app', 'notify', 'window_focus', 'file_write', 'file_backup', 'file_patch', 'file_restore'],
  full: ['key_type', 'mouse_click', 'clipboard_write', 'terminal', 'run_python'],
};
function allowedOps(tier) {
  const lvl = TIER_ORDER[tier] != null ? TIER_ORDER[tier] : TIER_ORDER.standard;
  const out = new Set();
  for (const [name, ops] of Object.entries(TIER_OPS)) if (TIER_ORDER[name] <= lvl) for (const o of ops) out.add(o);
  return out;
}
// terminal 白名单命令（V1：仅只读/低风险命令，禁 shell 元字符，走 execFile 不经 shell）
const TERMINAL_ALLOW = new Set(['ls', 'pwd', 'whoami', 'date', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'df', 'du', 'uname', 'sw_vers', 'which', 'id', 'hostname', 'uptime', 'env']);

function safeJoin(base, rel) {
  const p = path.resolve(base, String(rel || ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`路径越界（仅允许 ${base} 内）：${rel}`);
  for (const blk of HOME_BLOCK_PREFIXES) if (p === blk || p.startsWith(blk + path.sep)) throw new Error(`系统保护区拒绝访问：${p}`);
  return p;
}

// ---------- D1-1 备份工具 ----------
function doBackup(target) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, path.join(BACKUP_DIR, id));
    const before = fs.statSync(target).size;
    fs.writeFileSync(path.join(BACKUP_DIR, id + '.json'), JSON.stringify({ path: target, created_at: new Date().toISOString() }));
    return { backup_id: id, before_bytes: before };
  }
  return { backup_id: null, before_bytes: 0 }; // 新建文件无需备份
}
/** 极简行级 diff（供 file_diff / 写操作改动清单） */
function lineDiff(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (i < a.length && i >= b.length) out.push(`- ${a[i]}`);
    else if (i >= a.length && i < b.length) out.push(`+ ${b[i]}`);
    else out.push(`- ${a[i]}`, `+ ${b[i]}`);
    if (out.length > 400) { out.push('…（差异过多，已截断）'); break; }
  }
  return out.join('\n');
}

/** 管道输入执行（pbcopy 等） */
function execInput(cmd, args, input, opts = {}) {
  return new Promise((resolve, reject) => {
    const cp = require('child_process').spawn(cmd, args, { timeout: opts.timeout || 8000 });
    let so = '', se = '';
    cp.stdout.on('data', d => so += d);
    cp.stderr.on('data', d => se += d);
    cp.on('error', reject);
    cp.on('close', code => code === 0 ? resolve(so) : reject(new Error((se || `退出码 ${code}`).slice(0, 200))));
    if (input != null) cp.stdin.end(input);
  });
}
/** 执行命令并回 stdout（execFile，不经 shell） */
function execOut(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 4 * 1024 * 1024 }, (e, so, se) => {
      if (e) reject(new Error((se || e.message).slice(0, 200))); else resolve(so);
    });
  });
}

/** 执行一个任务。返回 { ok, data } —— 白名单操作在此实现 */
async function runOp(op, params, opts = {}) {
  const P = params || {};
  // D1-1：桥端二次档位校验（服务端已按档位拦截；此处为防御纵深，tier 缺省不校验）
  if (opts.tier && !allowedOps(opts.tier).has(op)) {
    throw new Error(`该操作「${op}」超出设备当前权限档位（${opts.tier}），已拒绝`);
  }
  switch (op) {
    case 'mkdir': {
      const dir = safeJoin(HOME, P.target);
      const existedBefore = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, data: { path: dir, existed: existedBefore, created: !existedBefore } };
    }
    case 'list_dir': {
      const dir = safeJoin(HOME, P.target || '.');
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .slice(0, 300)
        .map(d => ({ name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }));
      return { ok: true, data: { path: dir, count: items.length, items } };
    }
    case 'open_app': {
      const app = String(P.app || '').trim();
      if (!/^[0-9a-zA-Z\u4e00-\u9fa5\s.\-（）()·]{1,60}$/.test(app)) throw new Error(`应用名含非法字符：${app}`);
      await execOut('open', ['-a', app], { timeout: 15000 });
      return { ok: true, data: { app, opened: true } };
    }
    case 'notify': {
      const text = String(P.text || '').slice(0, 200).replace(/["\\]/g, '');
      await new Promise((resolve) => {
        execFile('osascript', ['-e', `display notification "${text}" with title "TeleAgent 智能体平台"`], { timeout: 8000 }, () => resolve());
      });
      return { ok: true, data: { notified: true } };
    }
    case 'screenshot': {
      const dir = safeJoin(HOME, 'Desktop'); // 截图统一落桌面（用户主目录内）
      const file = path.join(dir, `TeleAgent截图-${Date.now()}.png`);
      const args = P.window ? ['-x', '-l', String(P.window).slice(0, 30), file] : ['-x', file];
      await execOut('screencapture', args, { timeout: 15000 });
      const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
      return { ok: true, data: { path: file, url: 'file://' + file, bytes, window: P.window || '' } };
    }
    case 'clipboard_read': {
      const text = await execInput('pbpaste', [], null).catch(() => '');
      return { ok: true, data: { type: P.type || 'text', text: String(text).slice(0, 20000) } };
    }
    case 'clipboard_write': {
      const text = String(P.text || '').slice(0, 8000);
      await execInput('pbcopy', [], text, { timeout: 8000 });
      return { ok: true, data: { written: true, bytes: Buffer.byteLength(text, 'utf8') } };
    }
    case 'key_type': {
      const text = String(P.text || '').slice(0, 2000).replace(/["\\]/g, '');
      await execOut('osascript', ['-e', `tell application "System Events" to keystroke "${text}"`], { timeout: 15000 });
      return { ok: true, data: { typed: text.length } };
    }
    case 'mouse_click': {
      const x = Math.round(+P.x || 0), y = Math.round(+P.y || 0);
      // 优先 cliclick（若安装）；否则用 python3 + Quartz（需 pyobjc）
      try {
        await execOut('cliclick', [`c:${x},${y}`], { timeout: 8000 });
      } catch {
        await execOut('python3', ['-c',
          `import Quartz,time;e=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventLeftMouseDown,(${x},${y}),Quartz.kCGMouseButtonLeft);Quartz.CGEventPost(Quartz.kCGHIDEventTap,e);time.sleep(0.05);e2=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventLeftMouseUp,(${x},${y}),Quartz.kCGMouseButtonLeft);Quartz.CGEventPost(Quartz.kCGHIDEventTap,e2)`], { timeout: 10000 });
      }
      return { ok: true, data: { x, y, clicked: true } };
    }
    case 'window_list': {
      const out = await execOut('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'], { timeout: 10000 }).catch(() => '');
      const apps = String(out).split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      return { ok: true, data: { count: apps.length, windows: apps.map(a => ({ app: a })) } };
    }
    case 'window_focus': {
      const name = String(P.window || '').trim().replace(/["\\]/g, '');
      if (!name) throw new Error('缺少窗口/应用名');
      await execOut('osascript', ['-e', `tell application "${name}" to activate`], { timeout: 10000 });
      return { ok: true, data: { focused: name } };
    }
    case 'file_read': {
      const file = safeJoin(HOME, P.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${P.path}`);
      const st = fs.statSync(file);
      if (st.size > 512 * 1024) throw new Error(`文件过大（${st.size} 字节，上限 512KB）`);
      return { ok: true, data: { path: file, bytes: st.size, content: fs.readFileSync(file, 'utf8').slice(0, 200000) } };
    }
    case 'file_write': {
      const file = safeJoin(HOME, P.path);
      const content = String(P.content || '');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      const oldText = existed ? fs.readFileSync(file, 'utf8') : '';
      const bk = doBackup(file);
      fs.writeFileSync(file, content);
      const after = Buffer.byteLength(content, 'utf8');
      return { ok: true, data: {
        path: file, created: !existed, change: existed ? 'modified' : 'created',
        backup_id: bk.backup_id, before_bytes: bk.before_bytes, after_bytes: after,
        diff: existed ? lineDiff(oldText, content) : `+ ${content.slice(0, 2000)}`,
      } };
    }
    case 'file_backup': {
      const file = safeJoin(HOME, P.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${P.path}`);
      const bk = doBackup(file);
      return { ok: true, data: { path: file, backup_id: bk.backup_id, before_bytes: bk.before_bytes, change: 'modified' } };
    }
    case 'file_diff': {
      const file = safeJoin(HOME, P.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${P.path}`);
      const cur = fs.readFileSync(file, 'utf8');
      const oldText = typeof P.old === 'string' ? P.old : null;
      return { ok: true, data: { path: file, lines: cur.split('\n').length, diff: oldText != null ? lineDiff(oldText, cur) : null, content: cur.slice(0, 200000) } };
    }
    case 'file_patch': {
      const file = safeJoin(HOME, P.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在（patch 不支持新建）：${P.path}`);
      const oldText = fs.readFileSync(file, 'utf8');
      let newText;
      if (typeof P.find === 'string' && P.find) {
        if (!oldText.includes(P.find)) throw new Error('未找到待替换片段（find 不匹配），未做任何修改');
        newText = oldText.split(P.find).join(String(P.replace != null ? P.replace : ''));
      } else if (typeof P.append === 'string') {
        newText = oldText + P.append;
      } else if (typeof P.content === 'string') {
        newText = P.content; // 整文件替换
      } else {
        throw new Error('patch 缺少 find/replace、append 或 content 参数');
      }
      const bk = doBackup(file);
      fs.writeFileSync(file, newText);
      return { ok: true, data: { path: file, change: 'modified', backup_id: bk.backup_id, before_bytes: bk.before_bytes, after_bytes: Buffer.byteLength(newText, 'utf8'), diff: lineDiff(oldText, newText) } };
    }
    case 'file_restore': {
      const id = String(P.backup_id || '').trim();
      if (!/^[\w-]+$/.test(id)) throw new Error('非法备份标识');
      const bkFile = path.join(BACKUP_DIR, id);
      const metaFile = bkFile + '.json';
      if (!fs.existsSync(bkFile) || !fs.existsSync(metaFile)) throw new Error('备份不存在或已过期');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const target = meta.path; // 备份元数据记录的是原始绝对路径
      if (!(target === HOME || target.startsWith(HOME + path.sep))) throw new Error('备份目标越界，拒绝回滚');
      fs.copyFileSync(bkFile, target);
      return { ok: true, data: { path: target, restored: true, backup_id: id } };
    }
    case 'terminal': {
      const cmd = String(P.cmd || '').trim();
      const argv = Array.isArray(P.args) ? P.args.map(a => String(a).slice(0, 200)) : [];
      if (!TERMINAL_ALLOW.has(cmd)) throw new Error(`命令「${cmd}」不在终端白名单内（可用：${[...TERMINAL_ALLOW].join(' ')}）`);
      if (/[;&|`$><\n]/.test(cmd)) throw new Error('命令含非法字符');
      const out = await execOut(cmd, argv, { timeout: 15000 });
      return { ok: true, data: { cmd, args: argv, output: String(out).slice(0, 20000) } };
    }
    case 'run_python': {
      const code = String(P.code || '').slice(0, 20000);
      if (!code) throw new Error('缺少 code 参数');
      const out = await execOut('python3', ['-c', code], { timeout: 30000 });
      return { ok: true, data: { output: String(out).slice(0, 20000) } };
    }
    default:
      throw new Error(`未知操作（白名单外拒绝）：${op}`);
  }
}

// ---------- 平台通信 ----------
async function api(method, p, body) {
  const res = await fetch(CFG.platform_url + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': CFG.device_token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ code: res.status, msg: '响应解析失败' }));
  return { status: res.status, ...j };
}

// ================== D2-3 桌面端升级通道（自动更新 + 崩溃上报）==================
// 客户端自检新版本 → 下载发布包 → sha256 校验 → 原子替换自身脚本 → 上报结果 → 交由 launchd 拉起新版本。
// 全流程失败可回滚（替换前保留 .bak），并如实上报 success / failed / rollback 供平台统计更新成功率。
function bridgePlatform() { return process.platform === 'darwin' ? 'darwin' : (process.platform === 'win32' ? 'win32' : process.platform); }

/** 下载发布包原始字节（非 JSON）；返回 { buf, sha256 } */
async function downloadRelease(url) {
  const res = await fetch(CFG.platform_url + url, { headers: { 'X-Device-Token': CFG.device_token } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, sha256: String(res.headers.get('x-sha256') || '').trim().toLowerCase() };
}

/** 原子替换自身脚本：先写临时文件 → 备份现状 → rename 覆盖（运行中的进程仍持旧 inode，安全） */
function applySelfUpdate(buf) {
  const target = __filename;                 // 当前运行的 bridge.js（.app/Contents/MacOS/bridge.js）
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.bridge.new-${Date.now()}`);
  const bak = target + '.bak';
  fs.writeFileSync(tmp, buf);
  try { fs.copyFileSync(target, bak); } catch { }
  fs.renameSync(tmp, target);                // 同目录 rename：POSIX 原子
  return { target, bak };
}

/** 回滚：恢复 .bak 到 target */
function restoreSelf(bak) { try { if (bak && fs.existsSync(bak)) fs.copyFileSync(bak, __filename); } catch { } }

async function reportUpdate(status, { from, to, channel, error, duration_ms }) {
  try {
    await api('POST', '/api/localbridge/update-report', {
      status, from_version: from || BRIDGE_VERSION, to_version: to || '',
      channel: channel || CFG.channel || 'stable', error: String(error || '').slice(0, 500), duration_ms: Number(duration_ms) || 0,
    });
  } catch { }
}

/** 崩溃上报（含启动失败）；未配对也可上报（服务端软鉴权） */
function reportCrash(kind, err) {
  try {
    const body = JSON.stringify({
      kind: kind || 'runtime', version: BRIDGE_VERSION,
      message: String((err && err.message) || err || '').slice(0, 500),
      stack: String((err && err.stack) || '').slice(0, 4000),
    });
    // fire-and-forget（进程可能随即退出，不 await）
    fetch(CFG.platform_url + '/api/localbridge/crash-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': CFG.device_token }, body,
    }).catch(() => { });
  } catch { }
}

/** 查询是否有新版本 */
async function checkForUpdate() {
  const q = `current=${encodeURIComponent(BRIDGE_VERSION)}&platform=${encodeURIComponent(bridgePlatform())}&arch=${encodeURIComponent(process.arch)}&channel=${encodeURIComponent(CFG.channel || 'stable')}`;
  const r = await api('GET', `/api/localbridge/version?${q}`);
  return (r && r.code === 0) ? r.data : null;
}

let _updating = false;
/** 执行一次自动更新（若可用）。成功 → 退出进程交由 launchd 拉起新版本。 */
async function autoUpdate() {
  if (_updating) return { ok: false, reason: 'busy' };
  if (CFG.auto_update === false || process.env.AP_NO_AUTOUPDATE === '1') return { ok: false, reason: 'disabled' };
  _updating = true;
  const t0 = Date.now();
  let replaced = false;
  try {
    const info = await checkForUpdate();
    if (!info || !info.update_available || !info.release) { log(`⏫ 已是最新版本（${BRIDGE_VERSION}）`); return { ok: true, updated: false }; }
    log(`⬆ 发现新版本 ${info.latest}（当前 ${BRIDGE_VERSION}${info.mandatory ? '，强制' : ''}）`);
    const { buf, sha256 } = await downloadRelease(info.release.url);
    const expect = String(info.release.sha256 || sha256 || '').toLowerCase();
    if (expect) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== expect) throw new Error(`包完整性校验失败（期望 ${expect.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
    }
    applySelfUpdate(buf);
    replaced = true;
    await reportUpdate('success', { from: BRIDGE_VERSION, to: info.latest, duration_ms: Date.now() - t0 });
    log(`✅ 更新完成 → ${info.latest}，即将重启生效`);
    setTimeout(() => process.exit(0), 400); // launchd KeepAlive 拉起新版本
    return { ok: true, updated: true };
  } catch (e) {
    await reportUpdate(replaced ? 'rollback' : 'failed', { error: e.message, duration_ms: Date.now() - t0 });
    if (replaced) restoreSelf(__filename + '.bak');
    log(`⚠ 自动更新失败：${e.message}（已保留原版本）`);
    return { ok: false, error: e.message };
  } finally { _updating = false; }
}

// 崩溃/未捕获异常上报（含启动期），便于平台统计崩溃率（验收 < 0.5%）
process.on('uncaughtException', (e) => { log(`💥 未捕获异常：${e && e.message}`); reportCrash('unhandled', e); setTimeout(() => process.exit(1), 200); });
process.on('unhandledRejection', (e) => { log(`💥 未处理的 Promise 拒绝：${(e && e.message) || e}`); reportCrash('unhandled', e); });

// ---------- 配对（安装脚本收集配对码后调用） ----------
async function pairWithCode(code) {
  const r = await api('POST', '/api/localbridge/claim', {
    code: String(code).trim(),
    device_name: CFG.device_name,
    platform: `${process.platform} ${os.release()} · ${os.arch()}`,
  });
  if (r.code === 0 && r.data?.paired) {
    CFG.paired = true; CFG.paired_user = r.data.username;
    fs.writeFileSync(CONF_FILE, JSON.stringify(CFG, null, 2));
    return { ok: true, user: r.data.username };
  }
  return { ok: false, msg: r.msg || '配对失败' };
}

// ---------- 主循环：拉任务 + 执行 + 回推 ----------
let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    const r = await api('POST', '/api/localbridge/poll', {});
    if (r.code === 0 && r.data?.task) {
      const task = r.data.task;
      log(`▶ 任务 #${task.id} ${task.op} ${JSON.stringify(task.params).slice(0, 120)}`);
      let result;
      try { result = { ok: true, ...(await runOp(task.op, task.params, { tier: task.tier })) }; }
      catch (e) { result = { ok: false, error: String(e.message || e) }; }
      log(`✔ 任务 #${task.id} 完成 ok=${result.ok}`);
      for (let i = 0; i < 2; i++) { // 回推结果（失败重试一次）
        try {
          const rr = await api('POST', '/api/localbridge/result', { task_id: task.id, result });
          if (rr.code === 0) break;
        } catch { }
        await new Promise(res => setTimeout(res, 1500));
      }
    }
  } catch (e) {
    if (!loop._warned || Date.now() - loop._warned > 60000) {
      log(`⚠ 平台通信异常：${e.message}（${CFG.platform_url}，将自动重试）`);
      loop._warned = Date.now();
    }
  } finally { busy = false; }
}

function start() {
  log(`TeleAgent 本地桥启动：device=${CFG.device_name} platform=${CFG.platform_url} paired=${!!CFG.paired} version=${BRIDGE_VERSION}`);
  if (CFG.paired) {
    setInterval(loop, CFG.poll_interval);
    loop();
    // 低频心跳更新在线状态
    setInterval(async () => {
      try { await api('POST', '/api/localbridge/heartbeat', {}); } catch { }
    }, 30000);
    // D2-3 自动更新：启动即查一次，之后每 6 小时检查（有新版则替换并重启生效）
    autoUpdate();
    setInterval(autoUpdate, 6 * 3600 * 1000);
  } else {
    log('⏳ 未配对——等待配对（安装程序引导 / 手动: node bridge.js --pair <配对码>）');
    // 未配对时低频探测（用户可能在网页侧用 token 直接激活）
    const probe = setInterval(async () => {
      try {
        const r = await api('POST', '/api/localbridge/heartbeat', {});
        if (r.code === 0 && r.data?.paired) {
          clearInterval(probe);
          CFG.paired = true;
          if (r.data.username) CFG.paired_user = r.data.username;
          fs.writeFileSync(CONF_FILE, JSON.stringify(CFG, null, 2));
          log(`✅ 配对成功（用户 ${r.data.username}），重启进入任务轮询`);
          setTimeout(() => process.exit(0), 500); // launchd KeepAlive 拉起后进主循环
        }
      } catch { }
    }, 5000);
  }
}

// ---------- CLI ----------
const arg = process.argv[2];
if (arg === '--pair') {
  const code = process.argv[3];
  if (!code) { console.error('用法: bridge.js --pair <网页配对码>'); process.exit(1); }
  pairWithCode(code).then(r => {
    console.log(r.ok ? `配对成功（绑定用户 ${r.user}）` : `配对失败：${r.msg}`);
    process.exit(r.ok ? 0 : 1);
  }).catch(e => { console.error('配对异常：', e.message); process.exit(1); });
} else if (arg === '--status') {
  console.log(JSON.stringify({ paired: !!CFG.paired, user: CFG.paired_user || null, platform_url: CFG.platform_url, device_name: CFG.device_name, version: BRIDGE_VERSION, channel: CFG.channel || 'stable', token: CFG.device_token.slice(0, 8) + '…' }, null, 2));
} else if (arg === '--version') {
  console.log(BRIDGE_VERSION);
} else if (arg === '--update') { // D2-3：手动触发一次自动更新检查
  autoUpdate().then(r => { console.log(JSON.stringify(r, null, 2)); if (!r.ok && r.updated === undefined) process.exit(1); }).catch(e => { console.error('更新异常：' + e.message); process.exit(1); });
} else if (arg === '--test') { // 自检：白名单操作连通性
  (async () => {
    const tmp = `Desktop/teleagent-自检-${Date.now()}`;
    console.log('mkdir:', JSON.stringify(await runOp('mkdir', { target: tmp }).catch(e => ({ ok: false, error: e.message }))));
    try { fs.rmdirSync(path.join(HOME, tmp)); } catch { }
    console.log('notify:', JSON.stringify(await runOp('notify', { text: '本地桥自检通过 ✅' }).catch(e => ({ ok: false, error: e.message }))));
    console.log('越权拒绝:', JSON.stringify(await runOp('mkdir', { target: '../etc' }).catch(e => ({ ok: false, error: e.message }))));
    process.exit(0);
  })();
} else {
  try { start(); } catch (e) { reportCrash('startup', e); log(`💥 启动失败：${e.message}`); process.exit(1); }
}
