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
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const crypto = require('crypto');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { clientIp } = require('../lib/rate-limit');

const router = express.Router();

const OPS_WHITELIST = ['mkdir', 'list_dir', 'open_app', 'notify',
  // A1 本地桥 op 扩展（2026-11-09）：截图/剪贴板/键鼠/窗口/文件类，共 12 个
  'screenshot', 'clipboard_read', 'clipboard_write', 'key_type', 'mouse_click',
  'window_list', 'window_focus', 'file_read', 'file_write',
  // D1-1 端侧执行 V1（2026-11-20）：写前备份/diff/patch/回滚 + 终端会话 + Python 运行
  'file_backup', 'file_diff', 'file_patch', 'file_restore', 'terminal', 'run_python',
];

// ---------------- D1-1 三档权限模型（设备级能力上限，唯一权威源） ----------------
// readonly < standard < full：op 必须落在设备档位「累计允许集合」内。
// 决策1（2026-11-20）：readonly=纯读/纯看；standard=常规写（备份先行）；full=键鼠注入/终端/脚本。
const TIER_ORDER = { readonly: 0, standard: 1, full: 2 };
const TIER_OPS = {
  readonly: ['list_dir', 'file_read', 'file_diff', 'clipboard_read', 'window_list', 'screenshot'],
  standard: ['mkdir', 'open_app', 'notify', 'window_focus', 'file_write', 'file_backup', 'file_patch', 'file_restore'],
  full: ['key_type', 'mouse_click', 'clipboard_write', 'terminal', 'run_python'],
};
const TIERS = ['readonly', 'standard', 'full'];
function normalizeTier(t) { return TIERS.includes(t) ? t : 'standard'; }
/** 某档位累计允许的 op 集合（含更低档位） */
function allowedOpsForTier(tier) {
  const lvl = TIER_ORDER[normalizeTier(tier)];
  const out = new Set();
  for (const [name, ops] of Object.entries(TIER_OPS)) if (TIER_ORDER[name] <= lvl) for (const o of ops) out.add(o);
  return out;
}
/** op 是否落在设备档位允许集合内 */
function opAllowedForTier(op, tier) { return allowedOpsForTier(tier).has(String(op)); }
/** 返回某 op 所属的最低档位（用于前端展示/提示） */
function opMinTier(op) {
  for (const name of ['readonly', 'standard', 'full']) if (TIER_OPS[name].includes(op)) return name;
  return 'full';
}
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
  const exist = dal.getq('SELECT * FROM localbridge_devices WHERE device_token=?', [token]);
  if (exist) {
    dal.runq('UPDATE localbridge_devices SET username=?, device_name=?, platform=?, last_seen=?, updated_at=? WHERE id=?', [username, String(device_name || exist.device_name).slice(0, 80), String(platform || '').slice(0, 120), now(), now(), exist.id]);
  } else {
    const cnt = dal.getq('SELECT COUNT(*) c FROM localbridge_devices WHERE username=?', [username]).c;
    dal.runq('INSERT INTO localbridge_devices (username,device_token,device_name,platform,is_default,last_seen,created_at) VALUES (?,?,?,?,?,?,?)', [username, token, String(device_name || '未命名设备').slice(0, 80), String(platform || '').slice(0, 120), cnt === 0 ? 1 : 0, now(), now()]);
  }
  res.json({ code: 0, data: { paired: true, username } });
});

// ---------- 桥端鉴权中间件 ----------
function deviceAuth(req, res, next) {
  const token = String(req.headers['x-device-token'] || '');
  const d = token && dal.getq('SELECT * FROM localbridge_devices WHERE device_token=?', [token]);
  if (!d) return res.status(401).json({ code: 401, msg: '设备未注册（先完成配对）' });
  req.device = d;
  next();
}

// 心跳：更新在线状态；未配对设备返回 paired:false（供安装器探测）
router.post('/heartbeat', (req, res) => {
  const token = String(req.headers['x-device-token'] || '');
  const d = dal.getq('SELECT * FROM localbridge_devices WHERE device_token=?', [token]);
  if (!d) return res.json({ code: 0, data: { paired: false } }); // 不报错：安装探测场景
  dal.runq('UPDATE localbridge_devices SET last_seen=? WHERE id=?', [now(), d.id]);
  res.json({ code: 0, data: { paired: true, username: d.username } });
});

// poll：认领一个 pending 任务（置 running）
router.post('/poll', deviceAuth, (req, res) => {
  dal.runq('UPDATE localbridge_devices SET last_seen=? WHERE id=?', [now(), req.device.id]);
  // 超时回收：60s 未回推的 running 任务标 failed（桥重启/断线场景）
  dal.runq(`UPDATE localbridge_tasks SET status='failed', result='{"ok":false,"error":"执行超时未回推（桥可能离线）"}', updated_at=? WHERE device_id=? AND status='running' AND datetime(updated_at) < datetime('now','localtime','-60 seconds')`, [now(), req.device.id]);
  const task = dal.getq(`SELECT * FROM localbridge_tasks WHERE device_id=? AND status='pending' ORDER BY id LIMIT 1`, [req.device.id]);
  if (task) {
    dal.runq(`UPDATE localbridge_tasks SET status='running', updated_at=? WHERE id=?`, [now(), task.id]);
    let params = {}; try { params = JSON.parse(task.params || '{}'); } catch { }
    res.json({ code: 0, data: { task: { id: task.id, op: task.op, params, tier: normalizeTier(req.device.permission_tier) } } });
  } else {
    res.json({ code: 0, data: { task: null } });
  }
});

// result：回推执行结果
router.post('/result', deviceAuth, async (req, res) => {
  const { task_id, result } = req.body || {};
  const t = dal.getq('SELECT * FROM localbridge_tasks WHERE id=?', [Number(task_id)]);
  if (!t || t.device_id !== req.device.id) return res.status(404).json({ code: 404, msg: '任务不存在' });
  dal.runq(`UPDATE localbridge_tasks SET status=?, result=?, updated_at=? WHERE id=?`, [result && result.ok ? 'done' : 'failed', JSON.stringify(result || {}).slice(0, 8000), now(), t.id]);
  // D1-1：写操作回推后落备份台账（供「事后改动清单 / 一键回滚」）
  recordBackupFromResult(req.device, t, result);
  // U2-4 Phase 2 / N6：结果回传渠道。如果该任务关联了 channel_msg_id，通过 channel.js send 回推结果
  if (t.channel_msg_id) {
    try {
      const { send } = require('../lib/channel');
      const { formatResultForChannel } = require('../lib/remote-dispatch'); // 结果可读化（文件类 op 转人类可读）
      const msgRow = dal.getq('SELECT * FROM channel_messages WHERE id=?', [t.channel_msg_id]);
      if (msgRow && msgRow.channel && msgRow.channel !== 'inbox') {
        const out = formatResultForChannel(t.op, result || {});
        await send({ channel: msgRow.channel, receivers: [msgRow.sender_id] }, { title: out.title, content: out.content });
      }
    } catch (e) {
      console.error('[localbridge] 渠道回传失败：', e.message);
    }
  }
  res.json({ code: 0 });
});

// ---------- 用户侧：设备管理 ----------
router.get('/devices', auth, (req, res) => {
  const rows = dal.q(`SELECT id, device_name, platform, is_default, permission_tier,
    last_seen, created_at,
    CASE WHEN datetime(last_seen) > datetime('now','localtime','-15 seconds') THEN 1 ELSE 0 END AS online
    FROM localbridge_devices WHERE username=? ORDER BY is_default DESC, id DESC`, [req.user.username]);
  res.json({ code: 0, data: rows });
});

router.post('/devices/:id/default', auth, (req, res) => {
  const d = dal.getq('SELECT * FROM localbridge_devices WHERE id=? AND username=?', [Number(req.params.id), req.user.username]);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  dal.runq('UPDATE localbridge_devices SET is_default=0 WHERE username=?', [req.user.username]);
  dal.runq('UPDATE localbridge_devices SET is_default=1 WHERE id=?', [d.id]);
  res.json({ code: 0 });
});

// N6 / U2-4：高危远控开关（键鼠/clipboard_write/file_write）——设备级总闸，默认关闭
router.post('/devices/:id/high-risk', auth, (req, res) => {
  const d = dal.getq('SELECT * FROM localbridge_devices WHERE id=? AND username=?', [Number(req.params.id), req.user.username]);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  const enable = req.body && (req.body.enable === true || req.body.enable === 1 || req.body.enable === '1');
  dal.runq('UPDATE localbridge_devices SET allow_high_risk=? WHERE id=?', [enable ? 1 : 0, d.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, enable ? '开启高危远控' : '关闭高危远控', `设备${d.device_name}#${d.id}`, req.ip, now()]);
  res.json({ code: 0, data: { id: d.id, allow_high_risk: enable ? 1 : 0 } });
});

router.delete('/devices/:id', auth, (req, res) => {
  const d = dal.getq('SELECT * FROM localbridge_devices WHERE id=? AND username=?', [Number(req.params.id), req.user.username]);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  dal.runq('DELETE FROM localbridge_devices WHERE id=?', [d.id]);
  dal.runq(`DELETE FROM localbridge_tasks WHERE device_id=? AND status IN ('pending','running')`, [d.id]);
  res.json({ code: 0 });
});

// ---------- D1-1 备份台账：写操作回推后落库（供事后改动清单 / 一键回滚） ----------
const BACKUP_OPS = ['file_write', 'file_patch', 'file_backup'];
function recordBackupFromResult(device, task, result) {
  try {
    if (!result || !result.ok) return;
    if (!BACKUP_OPS.includes(task.op)) return;
    const d = result.data || {};
    if (!d.backup_id) return; // 新建文件（无覆盖）不产生备份行
    dal.runq(`INSERT INTO localbridge_backups
      (device_id,username,task_id,op,path,backup_id,change,before_bytes,after_bytes,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?)`, [device.id, device.username, task.id, task.op, String(d.path || '').slice(0, 500), String(d.backup_id).slice(0, 120),
        String(d.change || 'modified').slice(0, 20), Number(d.before_bytes) || 0, Number(d.after_bytes) || 0, now()]);
  } catch (e) { console.error('[localbridge] 备份台账落库失败：', e.message); }
}

// ---------- D1-1 设备三档权限设置（readonly/standard/full） ----------
router.post('/devices/:id/tier', auth, (req, res) => {
  const d = dal.getq('SELECT * FROM localbridge_devices WHERE id=? AND username=?', [Number(req.params.id), req.user.username]);
  if (!d) return res.status(404).json({ code: 404, msg: '设备不存在' });
  const tier = String((req.body && req.body.tier) || '').trim();
  if (!TIERS.includes(tier)) return res.status(400).json({ code: 400, msg: '无效的权限档位（readonly/standard/full）' });
  dal.runq('UPDATE localbridge_devices SET permission_tier=? WHERE id=?', [tier, d.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '设置端侧权限档位', `设备${d.device_name}#${d.id} → ${tier}`, req.ip, now()]);
  res.json({ code: 0, data: { id: d.id, permission_tier: tier, ops: [...allowedOpsForTier(tier)] } });
});

// ---------- D1-1 备份列表（事后改动清单） ----------
router.get('/backups', auth, (req, res) => {
  const devId = Number(req.query.device_id) || 0;
  const rows = devId
    ? dal.q('SELECT * FROM localbridge_backups WHERE username=? AND device_id=? ORDER BY id DESC LIMIT 100', [req.user.username, devId])
    : dal.q('SELECT * FROM localbridge_backups WHERE username=? ORDER BY id DESC LIMIT 100', [req.user.username]);
  res.json({ code: 0, data: rows });
});

// ---------- D1-1 一键回滚（入队 file_restore 任务，写操作可回滚） ----------
router.post('/backups/:id/rollback', auth, (req, res) => {
  const b = dal.getq('SELECT * FROM localbridge_backups WHERE id=? AND username=?', [Number(req.params.id), req.user.username]);
  if (!b) return res.status(404).json({ code: 404, msg: '备份记录不存在' });
  if (b.status !== 'active') return res.status(409).json({ code: 409, msg: '该备份已回滚或不可用' });
  const dev = dal.getq('SELECT * FROM localbridge_devices WHERE id=? AND username=?', [b.device_id, req.user.username]);
  if (!dev) return res.status(404).json({ code: 404, msg: '设备不存在' });
  if (!opAllowedForTier('file_restore', dev.permission_tier)) return res.status(403).json({ code: 403, msg: `设备档位（${normalizeTier(dev.permission_tier)}）不允许回滚操作，请先提升档位` });
  const info = dal.runq('INSERT INTO localbridge_tasks (device_id,username,op,params,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [dev.id, req.user.username, 'file_restore', JSON.stringify({ backup_id: b.backup_id, path: b.path }), 'pending', now(), now()]);
  dal.runq('UPDATE localbridge_backups SET status=\'restoring\', restored_at=? WHERE id=?', [now(), b.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '端侧一键回滚', `设备${dev.device_name}#${dev.id} 备份#${b.id} ${b.path}`, req.ip, now()]);
  res.json({ code: 0, data: { task_id: info.lastInsertRowid, backup_id: b.backup_id, path: b.path } });
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

/* ================== D2-3 桌面端升级通道 V1（2026-11-21）================== */
const bridgeUpdate = require('../lib/bridge-update');

/** 读取发布包文件信息（存在则实时算 sha256/size）；public/downloads 下按文件名定位 */
function resolveReleaseFile(fileName) {
  const fs = require('fs');
  const f = path.join(__dirname, '..', '..', 'public', 'downloads', String(fileName || ''));
  try {
    const st = fs.statSync(f);
    return { path: f, exists: true, size: st.size, sha256: bridgeUpdate.sha256(fs.readFileSync(f)) };
  } catch { return { path: f, exists: false, size: 0, sha256: '' }; }
}

/** 软设备鉴权：令牌有效则返回设备行，否则 null（不阻断——供未配对/启动失败场景上报） */
function softDevice(req) {
  const token = String(req.headers['x-device-token'] || '');
  if (!token) return null;
  try { return dal.getq('SELECT * FROM localbridge_devices WHERE device_token=?', [token]) || null; }
  catch { return null; }
}

// 检查更新（客户端启动 + 定时调用）：公开可查（与安装包下载同域，不含敏感信息）
router.get('/version', (req, res) => {
  const { current = '0.0.0', platform = '', arch = '', channel = 'stable' } = req.query;
  const rows = dal.q("SELECT * FROM bridge_releases WHERE status='active'");
  const picked = bridgeUpdate.pickRelease(rows, { platform, arch, channel, current });
  const device = softDevice(req);
  if (device) dal.runq('UPDATE localbridge_devices SET last_seen=? WHERE id=?', [now(), device.id]);
  const r = picked.release;
  res.json({
    code: 0, data: {
      current: bridgeUpdate.normalizeVersion(current),
      latest: picked.latest, update_available: picked.update_available, mandatory: picked.mandatory,
      release: r ? {
        ...bridgeUpdate.releaseView(r),
        url: `/api/localbridge/release/download?version=${encodeURIComponent(r.version)}&platform=${encodeURIComponent(r.platform || 'any')}&arch=${encodeURIComponent(r.arch || 'any')}&channel=${encodeURIComponent(r.channel || 'stable')}`,
      } : null,
    },
  });
});

// 下载发布包（公开，与 /installer 同口径）：命中版本优先，否则按平台/架构/通道取最新
router.get('/release/download', (req, res) => {
  const { version, platform = '', arch = '', channel = 'stable' } = req.query;
  let row = null;
  if (version) {
    row = dal.getq("SELECT * FROM bridge_releases WHERE version=? AND status='active' AND (platform=? OR platform='any' OR platform='') AND (arch=? OR arch='any' OR arch='') ORDER BY id DESC LIMIT 1", [bridgeUpdate.normalizeVersion(version), platform, arch]);
  }
  if (!row) {
    const rows = dal.q("SELECT * FROM bridge_releases WHERE status='active'");
    row = bridgeUpdate.pickRelease(rows, { platform, arch, channel, current: '0.0.0' }).release;
  }
  if (!row) return res.status(404).json({ code: 404, msg: '未找到匹配的发布包' });
  const f = resolveReleaseFile(row.file_name);
  if (!f.exists) return res.status(404).json({ code: 404, msg: `发布包文件不存在：${row.file_name}（管理员需先放入 public/downloads/）` });
  res.setHeader('X-Bridge-Version', row.version);
  res.setHeader('X-Sha256', row.sha256 || f.sha256);
  res.download(f.path, row.file_name);
});

// 更新结果上报（桥端自动更新完成后回推）：success / failed / rollback
router.post('/update-report', (req, res) => {
  const device = softDevice(req);
  const b = req.body || {};
  const st = ['success', 'failed', 'rollback'].includes(b.status) ? b.status : 'failed';
  dal.runq('INSERT INTO bridge_updates (device_id,username,from_version,to_version,channel,status,error,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [device ? device.id : null, device ? device.username : '',
      bridgeUpdate.normalizeVersion(b.from_version), bridgeUpdate.normalizeVersion(b.to_version),
      bridgeUpdate.CHANNELS.includes(b.channel) ? b.channel : 'stable', st,
      String(b.error || '').slice(0, 500), Number(b.duration_ms) || 0, now()]);
  if (device) dal.runq('UPDATE localbridge_devices SET last_seen=? WHERE id=?', [now(), device.id]);
  res.json({ code: 0 });
});

// 崩溃上报（含启动失败，uncaughtException/unhandledRejection）：未配对也可上报
router.post('/crash-report', (req, res) => {
  const device = softDevice(req);
  const b = req.body || {};
  const kind = ['startup', 'runtime', 'unhandled'].includes(b.kind) ? b.kind : 'runtime';
  dal.runq('INSERT INTO bridge_crashes (device_id,username,version,kind,message,stack,created_at) VALUES (?,?,?,?,?,?,?)', [device ? device.id : null, device ? device.username : '',
      bridgeUpdate.normalizeVersion(b.version) || String(b.version || '').slice(0, 40),
      kind, String(b.message || '').slice(0, 500), String(b.stack || '').slice(0, 4000), now()]);
  res.json({ code: 0 });
});

// 发布清单（admin）：附文件是否就位 + 实际哈希
router.get('/releases', auth, adminOnly, (req, res) => {
  const rows = dal.q('SELECT * FROM bridge_releases ORDER BY id DESC');
  res.json({
    code: 0, data: rows.map(r => {
      const f = r.file_name ? resolveReleaseFile(r.file_name) : { exists: false, size: 0, sha256: '' };
      return { ...bridgeUpdate.releaseView(r), file_exists: !!r.file_name && f.exists, actual_sha256: f.sha256, actual_size: f.size };
    }),
  });
});

// 登记发布（admin）：同版本×平台×架构×通道幂等更新；文件在库时自动补 sha256/size
router.post('/releases', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const version = bridgeUpdate.normalizeVersion(b.version);
  if (!/^\d+\.\d+\.\d+/.test(version)) return res.json({ code: 400, msg: '版本号格式应为 1.2.3（可带 -beta.1）' });
  const platform = String(b.platform || 'any').trim() || 'any';
  const arch = String(b.arch || 'any').trim() || 'any';
  const channel = bridgeUpdate.CHANNELS.includes(b.channel) ? b.channel : 'stable';
  const file_name = String(b.file_name || '').trim();
  const finfo = file_name ? resolveReleaseFile(file_name) : { exists: false, size: 0, sha256: '' };
  const sha256 = String(b.sha256 || finfo.sha256 || '').toLowerCase();
  const size = Number(b.size) || finfo.size || 0;
  const notes = String(b.notes || '').slice(0, 2000);
  const mandatory = b.mandatory ? 1 : 0;
  const min_version = bridgeUpdate.normalizeVersion(b.min_version || '');
  const dup = dal.getq('SELECT id FROM bridge_releases WHERE version=? AND platform=? AND arch=? AND channel=?', [version, platform, arch, channel]);
  let id;
  if (dup) {
    dal.runq('UPDATE bridge_releases SET file_name=?,sha256=?,size=?,notes=?,mandatory=?,min_version=?,status=? WHERE id=?', [file_name, sha256, size, notes, mandatory, min_version, 'active', dup.id]);
    id = dup.id;
  } else {
    const info = dal.runq('INSERT INTO bridge_releases (version,platform,arch,channel,file_name,sha256,size,notes,mandatory,min_version,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [version, platform, arch, channel, file_name, sha256, size, notes, mandatory, min_version, 'active', now()]);
    id = Number(info.lastInsertRowid);
  }
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, dup ? '更新发布' : '登记发布', `桥端 ${version} ${platform}/${arch} ${channel}${finfo.exists ? '' : '（文件缺失）'}`, req.ip, now()]);
  res.json({ code: 0, msg: dup ? '发布已更新' : '发布已登记', data: { id, version, file_exists: finfo.exists, sha256 } });
});

// 下线发布（admin）：默认软下线（status=archived），?hard=1 真删
router.delete('/releases/:id', auth, adminOnly, (req, res) => {
  const row = dal.getq('SELECT * FROM bridge_releases WHERE id=?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ code: 404, msg: '发布不存在' });
  if (String(req.query.hard) === '1') dal.runq('DELETE FROM bridge_releases WHERE id=?', [row.id]);
  else dal.runq("UPDATE bridge_releases SET status='archived' WHERE id=?", [row.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '下线发布', `桥端 ${row.version} ${row.platform}/${row.arch}`, req.ip, now()]);
  res.json({ code: 0 });
});

// 更新与崩溃指标（admin）：更新成功率 / 崩溃率 + 最近记录（验收：成功率 ≥ 95%、崩溃率 < 0.5%）
router.get('/update-stats', auth, adminOnly, (req, res) => {
  const updates = dal.q('SELECT * FROM bridge_updates ORDER BY id DESC LIMIT 1000');
  const crashes = dal.q('SELECT * FROM bridge_crashes ORDER BY id DESC LIMIT 1000');
  const stats = bridgeUpdate.updateStats(updates, crashes);
  const releases = dal.q("SELECT * FROM bridge_releases WHERE status='active' ORDER BY id DESC").map(bridgeUpdate.releaseView);
  res.json({
    code: 0, data: {
      stats,
      releases,
      updates: updates.slice(0, 50),
      crashes: crashes.slice(0, 50),
    },
  });
});

module.exports = { router, OPS_WHITELIST, TIER_OPS, TIER_ORDER, TIERS, normalizeTier, allowedOpsForTier, opAllowedForTier, opMinTier };
