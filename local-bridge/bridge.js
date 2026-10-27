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
 *   1. 操作白名单：仅 mkdir / list_dir / open_app / notify 四类，**无任意命令执行**
 *   2. 路径约束：mkdir/list_dir 仅限用户主目录（$HOME）内，resolve 后前缀校验，
 *      拒绝 ~/Library 系统区与路径穿越（..）
 *   3. open_app 仅 `open -a <应用名>`（macOS LaunchServices，应用名经字符白名单校验，无 shell 元字符）
 *   4. 通知走 osascript display notification（固定模板，文本转义）
 *   5. 单飞任务：同一时刻最多执行 1 个任务，防并发滥用
 *   6. 全部动作写本地日志（~/Library/Logs/teleagent-bridge.log）可审计
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

// ---------- 日志（追加写，轮转保护：>5MB 截断） ----------
function log(...a) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${a.join(' ')}\n`;
  try {
    try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0); } catch { }
    fs.appendFileSync(LOG_FILE, line);
  } catch { }
  console.log(line.trim());
}

// ---------- 操作白名单 ----------
const HOME = os.homedir();
const HOME_BLOCK_PREFIXES = [path.join(HOME, 'Library')]; // 系统区拒绝写/列

function safeJoin(base, rel) {
  const p = path.resolve(base, String(rel || ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`路径越界（仅允许 ${base} 内）：${rel}`);
  for (const blk of HOME_BLOCK_PREFIXES) if (p === blk || p.startsWith(blk + path.sep)) throw new Error(`系统保护区拒绝访问：${p}`);
  return p;
}

/** 执行一个任务。返回 { ok, data } —— 白名单操作在此实现 */
async function runOp(op, params) {
  const P = params || {};
  switch (op) {
    case 'mkdir': {
      const dir = safeJoin(HOME, P.target);
      const existedBefore = fs.existsSync(dir); // 先记存在性（创建后再查恒为 true，语义不准）
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, data: { path: dir, existed: existedBefore, created: !existedBefore } };
    }
    case 'list_dir': {
      const dir = safeJoin(HOME, P.target || '.');
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .slice(0, 300) // 上限防爆
        .map(d => ({ name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }));
      return { ok: true, data: { path: dir, count: items.length, items } };
    }
    case 'open_app': {
      const app = String(P.app || '').trim();
      if (!/^[0-9a-zA-Z\u4e00-\u9fa5\s.\-（）()·]{1,60}$/.test(app)) throw new Error(`应用名含非法字符：${app}`);
      await new Promise((resolve, reject) => {
        execFile('open', ['-a', app], { timeout: 15000 }, (e, so, se) => {
          if (e) reject(new Error(`打开应用失败（${(se || e.message).slice(0, 120)}）`)); else resolve(so);
        });
      });
      return { ok: true, data: { app, opened: true } };
    }
    case 'notify': {
      const text = String(P.text || '').slice(0, 200).replace(/["\\]/g, '');
      await new Promise((resolve) => {
        execFile('osascript', ['-e', `display notification "${text}" with title "TeleAgent 智能体平台"`], { timeout: 8000 }, () => resolve());
      });
      return { ok: true, data: { notified: true } };
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
      try { result = { ok: true, ...(await runOp(task.op, task.params)) }; }
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
  log(`TeleAgent 本地桥启动：device=${CFG.device_name} platform=${CFG.platform_url} paired=${!!CFG.paired}`);
  if (CFG.paired) {
    setInterval(loop, CFG.poll_interval);
    loop();
    // 低频心跳更新在线状态
    setInterval(async () => {
      try { await api('POST', '/api/localbridge/heartbeat', {}); } catch { }
    }, 30000);
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
  console.log(JSON.stringify({ paired: !!CFG.paired, user: CFG.paired_user || null, platform_url: CFG.platform_url, device_name: CFG.device_name, token: CFG.device_token.slice(0, 8) + '…' }, null, 2));
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
  start();
}
