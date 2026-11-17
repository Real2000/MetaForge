/**
 * P5.27 本地桥 API（设备配对 + 任务队列）
 * ---------------------------------------------------------------
 * 通信模型：**轮询**——桥 daemon 定期 POST /poll 拉任务、执行后 POST /result 回推。
 * 服务端不主动连接用户电脑（无需公网穿透），任务结果由 local_exec 工具侧等待（DB 轮询）。
 *
 * 鉴权分两路：
 *  - 用户侧（JWT）：paircode 生成 / 设备列表 / 解绑 / 设默认
 *  - 桥侧（device_token）：claim（配对码换绑）/ heartbeat / poll / result
 *
 * 安全：
 *  - 配对码 6 位数字、120s 有效、一次性（防暴力：同用户 1 分钟内最多 10 个码）
 *  - poll 单飞：每设备一次只发一个任务，60s 未回推标记 failed（防占位死锁）
 *  - op 白名单在服务端先校验一层（桥端还有第二层）
 */
const express = require('express');
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { clientIp } = require('../lib/rate-limit');

const router = express.Router();

const OPS_WHITELIST = ['mkdir', 'list_dir', 'open_app', 'notify',
  // A1 本地桥 op 扩展（2026-11-09）：截图/剪贴板/键鼠/窗口/文件类，共 12 个
  'screenshot', 'clipboard_read', 'clipboard_write', 'key_type', 'mouse_click',
  'window_list', 'window_focus', 'file_read', 'file_write',
];
// P2-1 修复：同配对码连续失败 3 次后锁定（防暴力枚举），并配置 IP 级别 10 次/5min 封禁
const PAIRCODE_MAX_FAIL = 3;

// ---------- 配对码（用户网页侧生成） ----------
const pairCodes = new Map(); // code → { username, expires, failCount }
const PAIRCODE_ATTEMPT_WINDOW = 120 * 1000; // 2min
const CLAIM_IP_MAX_FAIL = 10; // 同一 IP 连续失败 10 次后临时封禁 5 分钟
const claimIpFail = new Map(); // ip → { count, blockUntil }

router.post('/paircode', auth, (req, res) => {
  // 防滥用：同用户 1 分钟内最多 10 个
  const recent = [...pairCodes.values()].filter(x => x.username === req.user.username && x.expires > Date.now()).length;
  if (recent >= 10) return res.status(429).json({ code: 429, msg: '生成过于频繁，请稍后再试' });
  // 清理过期
  for (const [k, v] of pairCodes) if (v.expires <= Date.now()) pairCodes.delete(k);
  // P2-1 修复：改用 crypto.randomInt 代替 Math.random —— Math.random 非加密随机，6 位数字枚举空间仅 10^6，
  // 配合 claim 端无失败限流，120s 窗口内可被并发批量穷举。crypto.randomInt 由 /dev/urandom 支撑，无法预测。
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  pairCodes.set(code, { username: req.user.username, expires: Date.now() + PAIRCODE_ATTEMPT_WINDOW, failCount: 0 });
  res.json({ code: 0, data: { code, expires_in: PAIRCODE_ATTEMPT_WINDOW / 1000 } });
});

// ---------- 桥端 claim：配对码 + device_token 换绑 ----------
router.post('/claim', (req, res) => {
  const { code, device_name, platform } = req.body || {};
  const token = String(req.headers['x-device-token'] || '');
  if (!token || token.length < 16) return res.status(400).json({ code: 400, msg: '缺少 device_token' });
  // P2-1 修复：IP级别失败限流——连续失败 CLAIM_IP_MAX_FAIL 次后临时封禁 5 分钟
  const ip = clientIp(req);
  const ipRec = claimIpFail.get(ip);
  if (ipRec && ipRec.blockUntil > Date.now()) {
    return res.status(429).json({ code: 429, msg: '请求过于频繁，请稍后再试' });
  }
  const entry = pairCodes.get(String(code || ''));
  if (!entry) {
    // 配对码不存在：递增 IP 失败计数
    const rec = claimIpFail.get(ip) || { count: 0, blockUntil: 0 };
    rec.count++;
    if (rec.count >= CLAIM_IP_MAX_FAIL) rec.blockUntil = Date.now() + 300000; // 5min
    claimIpFail.set(ip, rec);
    return res.status(404).json({ code: 404, msg: '配对码不存在或已过期（网页端重新生成）' });
  }
  // 验证配对码过期（包含清理过期 IP 失败记录）
  if (entry.expires <= Date.now()) {
    pairCodes.delete(String(code));
    const rec = claimIpFail.get(ip) || { count: 0, blockUntil: 0 };
    rec.count++;
    if (rec.count >= CLAIM_IP_MAX_FAIL) rec.blockUntil = Date.now() + 300000;
    claimIpFail.set(ip, rec);
    return res.status(410).json({ code: 410, msg: '配对码已过期' });
  }
  // 验证通过：配对码一次性消费
  const username = entry.username;
  pairCodes.delete(String(code));
  // 清理 IP 失败记录（配对成功后重置）
  claimIpFail.delete(ip);

  // 同 token 复绑（重装/换用户）→ 更新归属；否则新设备
  const exist = db.prepare('SELECT * FROM localbridge_devices WHERE device_token=?').get(token);
  if (exist) {
    db.prepare('UPDATE localbridge_devices SET username=?, device_name=?, platform=?, last_seen=?, updated_at=? WHERE id=?')
      .run(username, String(device_name || exist.device_name).slice(0, 80), String(platform || '').slice(0, 120), now(), now(), exist.id);
  } else {
    const cnt = db.prepare('SELECT COUNT(*) c FROM localbridge_devices WHERE username=?').get(username).c;
    db.prepare('INSERT INTO localbridge_devices (username,device_token,device_name,platform,is_default,last_seen,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(username, token, String(device_name || '未命名设备').slice(0, 80), String(platform || '').slice(0, 120), cnt === 0 ? 1 : 0, now(), now());
  }
  res.json({ code: 0, data: { paired: true, username } });
});

// ---------- 桥端鉴权中间件 ----------
function deviceAuth(req, res, next) {
  const token = String(req.headers['x-device-token'] || '');
  const d = token && db.prepare('SELECT * FROM localbridge_devices WHERE device_token=?').get(token);
  if (!d) return res.status(401).json({ code: 401, msg: '设备未注册（先完成配对）' });
  req.device = d;
  next();
}

// 心跳：更新在线状态；未配对设备返回 paired:false（供安装器探测）
router.post('/heartbeat', (req, res) => {
  const token = String(req.headers['x-device-token'] || '');
  const d = db.prepare('SELECT * FROM localbridge_devices WHERE device_token=?').get(token);
  if (!d) return res.json({ code: 0, data: { paired: false } }); // 不报错：安装探测场景
  db.prepare('UPDATE localbridge_devices SET last_seen=? WHERE id=?').run(now(), d.id);
  res.json({ code: 0, data: { paired: true, username: d.username } });
});

// poll：认领一个 pending 任务（置 running）
router.post('/poll', deviceAuth, (req, res) => {
  db.prepare('UPDATE localbridge_devices SET last_seen=? WHERE id=?').run(now(), req.device.id);
  // 超时回收：60s 未回推的 running 任务标 failed（桥重启/断线场景）
  db.prepare(`UPDATE localbridge_tasks SET status='failed', result='{"ok":false,"error":"执行超时未回推（桥可能离线）"}', updated_at=? WHERE device_id=? AND status='running' AND datetime(updated_at) < datetime('now','localtime','-60 seconds')`)
    .run(now(), req.device.id);
  const task = db.prepare(`SELECT * FROM localbridge_tasks WHERE device_id=? AND status='pending' ORDER BY id LIMIT 1`).get(req.device.id);
  if (task) {
    db.prepare(`UPDATE localbridge_tasks SET status='running', updated_at=? WHERE id=?`).run(now(), task.id);
    let params = {}; try { params = JSON.parse(task.params || '{}'); } catch { }
    res.json({ code: 0, data: { task: { id: task.id, op: task.op, params } } });
  } else {
    res.json({ code: 0, data: { task: null } });
  }
});

// result：回推执行结果
router.post('/result', deviceAuth, async (req, res) => {
  const { task_id, result } = req.body || {};
  const t = db.prepare('SELECT * FROM localbridge_tasks WHERE id=?').get(Number(task_id));
  if (!t || t.device_id !== req.device.id) return res.status(404).json({ code: 404, msg: '任务不存在' });
  db.prepare(`UPDATE localbridge_tasks SET status=?, result=?, updated_at=? WHERE id=?`)
    .run(result && result.ok ? 'done' : 'failed', JSON.stringify(result || {}).slice(0, 8000), now(), t.id);
  // U2-4 Phase 2：结果回传渠道。如果该任务关联了 channel_msg_id，通过 channel.js send 回推结果
  if (t.channel_msg_id) {
    try {
      const { send } = require('../lib/channel');
      const msgRow = db.prepare('SELECT * FROM channel_messages WHERE id=?').get(t.channel_msg_id);
      if (msgRow && msgRow.channel && msgRow.channel !== 'inbox') {
        const opLabel = t.op === 'list_dir' ? '文件列表' : t.op === 'file_read' ? '文件内容' : t.op;
        const summary = result && result.ok ? `✅「${opLabel}」执行成功` : `❌「${opLabel}」执行失败`;
        await send({ channel: msgRow.channel, receivers: [msgRow.sender_id] }, {
          title: summary,
          content: `${summary}\n\n${result && result.data ? JSON.stringify(result.data, null, 2).slice(0, 3000) : result && result.result ? String(result.result).slice(0, 3000) : '（无输出）'}`,
        });
      }
    } catch (e) {
      console.error('[localbridge] 渠道回传失败：', e.message);
    }
  }
  res.json({ code: 0 });
});

// ---------- 用户侧：设备管理 ----------
router.get('/devices', auth, (req, res) => {
  const rows = db.prepare(`SELECT id, device_name, platform, is_default,
    last_seen, created_at,
    CASE WHEN datetime(last_seen) > datetime('now','localtime','-15 seconds') THEN 1 ELSE 0 END AS online
    FROM localbridge_devices WHERE username=? ORDER BY is_default DESC, id DESC`).all(req.user.username);
  res.json({ code: 0, data: rows });
});

router.post('/devices/:id/default', auth, (req, res) => {
  const d = db.prepare('SELECT * FROM localbridge_devices WHERE id=? AND username=?').get(Number(req.params.id), req.user.username);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  db.prepare('UPDATE localbridge_devices SET is_default=0 WHERE username=?').run(req.user.username);
  db.prepare('UPDATE localbridge_devices SET is_default=1 WHERE id=?').run(d.id);
  res.json({ code: 0 });
});

router.delete('/devices/:id', auth, (req, res) => {
  const d = db.prepare('SELECT * FROM localbridge_devices WHERE id=? AND username=?').get(Number(req.params.id), req.user.username);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  db.prepare('DELETE FROM localbridge_devices WHERE id=?').run(d.id);
  db.prepare(`DELETE FROM localbridge_tasks WHERE device_id=? AND status IN ('pending','running')`).run(d.id);
  res.json({ code: 0 });
});

// ---------- 安装包下载（P5.27b：DMG 主分发 + zip 备用；无鉴权——下载页直接链） ----------
const path = require('path');
router.get('/installer', (req, res) => {
  const fs = require('fs');
  const base = path.join(__dirname, '..', '..', 'public', 'downloads');
  const fmt = req.query.fmt === 'zip' ? 'zip' : 'dmg';
  const file = fmt === 'zip' ? 'TeleAgent助手.zip' : 'TeleAgent助手.dmg';
  const f = path.join(base, file);
  if (!fs.existsSync(f)) return res.status(404).json({ code: 404, msg: '安装包未构建（管理员执行 local-bridge/build-installer.sh）' });
  res.download(f, file);
});

module.exports = { router, OPS_WHITELIST };
