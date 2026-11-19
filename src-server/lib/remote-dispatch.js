/**
 * 受限远控路由（N6 / U2-4 端侧网关微信远控）
 * ---------------------------------------------------------------
 * 把「渠道入站消息」串成端侧执行闭环，但不复用通用智能体的 local_exec 工具链
 * （local_exec 被 tool-deny.js 的 AGENT_TOOL_DENY 禁止配进智能体，且 workflow.js 在
 *  无人值守上下文一律拒绝），改用**独立、受严格约束**的远控路由。
 *
 * 链路：入站（已由 routes/channel.js 异步派发）
 *   → ① 受限指令解析（文本 → 白名单 op）
 *   → ② 身份反查（user_channel_bindings：渠道 sender_id → 平台 username）
 *   → ③ 设备路由（localbridge_devices：默认/在线）
 *   → ④ 高危闸（allow_high_risk）
 *   → ⑤ 入队 localbridge_tasks（★携带 channel_msg_id 关联回传）
 *
 * 安全：四层防线（会话绑定由 group-context.inbound 完成 / 身份绑定 / op 白名单 / 高危闸）。
 * 解析产物绝不透传为工具调用——未知 op、绝对路径、路径穿越一律拒绝。
 */
const { db, now } = require('../db');
const { OPS_WHITELIST } = require('../routes/localbridge');

// 高危 op：默认关闭，需设备级 allow_high_risk 显式开启（与桥端开关构成双层）
const HIGH_RISK_OPS = ['key_type', 'mouse_click', 'clipboard_write', 'file_write'];

const OP_LABEL = {
  mkdir: '新建文件夹', list_dir: '列目录', open_app: '打开应用', notify: '系统通知',
  screenshot: '截图', clipboard_read: '读剪贴板', clipboard_write: '写剪贴板',
  key_type: '键盘输入', mouse_click: '鼠标点击', window_list: '窗口列表',
  window_focus: '激活窗口', file_read: '读文件', file_write: '写文件',
};

const USAGE_HINT = '暂不支持该指令。可用：建文件夹 X / 列目录 [路径] / 截图 / 读文件 X / 写文件 X 内容… / 打开应用 X / 通知 X / 窗口列表 / 读剪贴板。';

// ---------------- 规则表（规则优先；产物仅允许落在 OPS_WHITELIST） ----------------
// 顺序即优先级：更具体的句式排前。
const RULES = [
  // 列窗口（先于「打开应用」，避免 "打开窗口" 被误判）
  { re: /^(?:列出?|查看|显示|看看)\s*(?:所有)?\s*窗口(?:列表)?\s*$|^窗口列表$/i, op: 'window_list', params: () => ({}) },
  // 列目录
  { re: /^(?:列出?|查看|显示|看看)\s*(?:一下)?\s*(?:目录|文件夹|桌面)\s*(.*)$/i, op: 'list_dir', params: m => ({ target: (m[1] || '').trim() }) },
  // 建文件夹
  { re: /^(?:建|新建|创建|建立|make|mkdir)\s*(?:一个)?\s*(?:文件夹|目录|folder|dir)\s*(.+)$/i, op: 'mkdir', params: m => ({ target: m[1].trim() }) },
  // 截图
  { re: /^(?:截图|截屏|screenshot|screen\s*shot)\s*$/i, op: 'screenshot', params: () => ({}) },
  // 写文件（须先于读文件，避免 "写文件" 被 file_read 的「打开文件」误吃）
  { re: /^(?:写|新建|创建)\s*文件\s*(\S+?)(?:\s*内容\s*[:：]?\s*([\s\S]*))?$/i, op: 'file_write', params: m => ({ path: m[1].trim(), content: (m[2] || '').trim() }) },
  // 读文件
  { re: /^(?:读|查看|打开|cat)\s*文件\s*(.+)$/i, op: 'file_read', params: m => ({ path: m[1].trim() }) },
  // 读剪贴板
  { re: /^(?:读|查看)\s*剪贴板|^clipboard\s*read$/i, op: 'clipboard_read', params: () => ({ type: 'text' }) },
  // 写剪贴板
  { re: /^(?:写剪贴板|复制|复制到剪贴板)\s*[:：]?\s*(.+)$/i, op: 'clipboard_write', params: m => ({ text: m[1].trim() }) },
  // 键盘输入
  { re: /^(?:输入|键入|key\s*type)\s*[:：]?\s*(.+)$/i, op: 'key_type', params: m => ({ text: m[1].trim() }) },
  // 打开应用（放最后，泛化「打开 X」）
  { re: /^(?:打开|启动|运行)\s*(?:应用|程序|app)?\s*(.+)$/i, op: 'open_app', params: m => ({ app: m[1].trim() }) },
  // 系统通知
  { re: /^(?:通知|提示|提醒我|notify)\s*[:：]?\s*(.+)$/i, op: 'notify', params: m => ({ text: m[1].trim() }) },
];

// ---------------- 参数清洗（防注入 + 路径安全） ----------------
/** 路径安全：禁止绝对路径、家目录简写、盘符、路径穿越 */
function isUnsafePath(p) {
  const s = String(p || '').trim();
  if (!s) return false;
  if (/^[~]/i.test(s)) return true;                 // ~ / ~/xxx
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;       // C:\ / C:/
  if (s.startsWith('/') || s.startsWith('\\')) return true; // 绝对路径
  if (s.split(/[\\/]+/).some(seg => seg === '..')) return true; // 路径穿越
  return false;
}

/** op → 白名单化参数（与 local_exec 的参数清洗一致，只保留该 op 需要的键） */
function sanitizeParams(op, raw) {
  const a = raw || {};
  const params = {};
  if (op === 'mkdir' || op === 'list_dir') {
    const target = String(a.target || '').slice(0, 300).trim();
    if (isUnsafePath(target)) return { ok: false, error: '禁止绝对路径或路径穿越' };
    params.target = target;
  } else if (op === 'open_app') {
    params.app = String(a.app || '').slice(0, 60);
    if (!params.app) return { ok: false, error: '缺少应用名' };
  } else if (op === 'notify') {
    params.text = String(a.text || '').slice(0, 200);
    if (!params.text) return { ok: false, error: '缺少通知内容' };
  } else if (op === 'screenshot') {
    params.window = String(a.window || '').slice(0, 200);
  } else if (op === 'clipboard_read') {
    params.type = ['text', 'html', 'file'].includes(a.type) ? a.type : 'text';
  } else if (op === 'clipboard_write') {
    params.text = String(a.text || '').slice(0, 8000);
    if (!params.text) return { ok: false, error: '缺少写入内容' };
  } else if (op === 'key_type') {
    params.text = String(a.text || '').slice(0, 2000);
    if (!params.text) return { ok: false, error: '缺少输入文本' };
  } else if (op === 'mouse_click') {
    params.x = Math.round(+a.x || 0);
    params.y = Math.round(+a.y || 0);
  } else if (op === 'window_list') {
    /* 无参 */
  } else if (op === 'window_focus') {
    params.window = String(a.window || '').slice(0, 200);
    if (!params.window) return { ok: false, error: '缺少窗口名' };
  } else if (op === 'file_read') {
    const path = String(a.path || '').slice(0, 500).trim();
    if (isUnsafePath(path)) return { ok: false, error: '禁止绝对路径或路径穿越' };
    if (!path) return { ok: false, error: '缺少文件路径' };
    params.path = path;
  } else if (op === 'file_write') {
    const path = String(a.path || '').slice(0, 500).trim();
    if (isUnsafePath(path)) return { ok: false, error: '禁止绝对路径或路径穿越' };
    if (!path) return { ok: false, error: '缺少文件路径' };
    params.path = path;
    params.content = String(a.content || '').slice(0, 32000);
  } else {
    return { ok: false, error: `不支持的操作「${op}」` };
  }
  return { ok: true, params };
}

// ---------------- ① 受限指令解析（文本 → 白名单 op） ----------------
/** parseRemoteCommand(text) → { ok:true, op, params } | { ok:false, reply }
 *  规则优先；只产出 OPS_WHITELIST 内的 op；解析失败回友好提示（不抛异常）。 */
function parseRemoteCommand(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reply: '收到空的指令，请说点什么～' };
  for (const r of RULES) {
    const m = t.match(r.re);
    if (!m) continue;
    const op = r.op;
    if (!OPS_WHITELIST.includes(op)) continue; // 双保险：规则不得越出白名单
    const s = sanitizeParams(op, r.params(m) || {});
    if (!s.ok) return { ok: false, reply: `⛔ 参数不合法：${s.error}` };
    return { ok: true, op, params: s.params };
  }
  return { ok: false, reply: USAGE_HINT };
}

/** 末尾 @设备名 提示（M7：多设备选择）：返回 { text, deviceName } */
function extractDeviceHint(text) {
  const s = String(text || '');
  const m = s.match(/\s*@([\w\u4e00-\u9fa5\-]{1,40})\s*$/);
  if (m) return { text: s.slice(0, m.index).trim(), deviceName: m[1] };
  return { text: s, deviceName: '' };
}

// ---------------- ③ 设备路由 ----------------
function isOnline(dev) {
  return !!(dev && dev.last_seen && Date.now() - new Date(dev.last_seen).getTime() < 30000);
}
function resolveDevice(username, wantName) {
  if (wantName) {
    const byName = db.prepare('SELECT * FROM localbridge_devices WHERE username=? AND device_name LIKE ? ORDER BY is_default DESC, last_seen DESC LIMIT 1')
      .get(username, `%${wantName}%`);
    if (byName) return byName;
  }
  return db.prepare('SELECT * FROM localbridge_devices WHERE username=? AND is_default=1').get(username)
    || db.prepare('SELECT * FROM localbridge_devices WHERE username=? ORDER BY last_seen DESC LIMIT 1').get(username);
}

// ---------------- 出站回执（可读化，best-effort） ----------------
async function sendChannelReply(channel, senderId, content) {
  try {
    const { send } = require('./channel');
    return await send({ channel: String(channel), receivers: [String(senderId)] }, { content: String(content || '').slice(0, 1500) });
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------- ⑤ 结果可读化（供 routes/localbridge.js /result 回传使用） ----------------
/** formatResultForChannel(op, result) → { title, content }：把桥回推的 result 转成人类可读文本 */
function formatResultForChannel(op, result) {
  const ok = !!(result && result.ok);
  const d = (result && result.data) || {};
  const label = OP_LABEL[op] || op;
  const title = ok ? `✅「${label}」执行成功` : `❌「${label}」执行失败`;
  let body = '';
  if (!ok) {
    body = (result && result.error) || '未知错误';
  } else if (op === 'list_dir') {
    const items = Array.isArray(d.items) ? d.items : (Array.isArray(d.entries) ? d.entries : []);
    body = items.length
      ? items.map(i => (typeof i === 'string' ? i : `${i.type === 'dir' || i.is_dir ? '📁' : '📄'} ${i.name || i.path || ''}`)).join('\n')
      : '（空目录）';
  } else if (op === 'file_read') {
    body = String(d.content || d.text || '').slice(0, 1500) || '（空文件）';
  } else if (op === 'mkdir') {
    body = d.existed ? `路径已存在：${d.path || ''}` : `已新建：${d.path || ''}`;
  } else if (op === 'screenshot') {
    body = d.url ? `截图：${d.url}` : '截图已完成';
  } else if (op === 'file_write') {
    body = `已写入：${d.path || ''}`;
  } else if (op === 'notify') {
    body = '系统通知已发送';
  } else {
    body = JSON.stringify(d).slice(0, 1000);
  }
  return { title, content: `${title}\n\n${body}`.slice(0, 3000) };
}

// ---------------- 主入口：入站异步派发 ----------------
/**
 * handleInbound({ msg, text, auditId, channelId, bind })
 *  由 routes/channel.js 在 verdict.ok 后经 setImmediate 调用；不阻塞被动回复窗口。
 *  返回结构化结果（便于单测），异常交由调用方 catch 记录。
 */
async function handleInbound({ msg, text, auditId, channelId, bind } = {}) {
  const m = msg || {};
  const channel = String(m.channel || '');
  const senderId = m.sender ? String(m.sender.id || '') : '';
  const rawText = String(text || m.text || '').trim();

  if (!senderId) return { ok: false, reason: 'no-sender' };

  // ① 受限指令解析（含末尾 @设备名 提示）
  const hint = extractDeviceHint(rawText);
  const parsed = parseRemoteCommand(hint.text);
  if (!parsed.ok) {
    await sendChannelReply(channel, senderId, parsed.reply);
    return { ok: false, reason: 'parse', reply: parsed.reply };
  }

  // ② 身份反查：渠道 sender_id → 平台 username
  const cid = Number(channelId) || (bind && Number(bind.channel_id)) || 0;
  const ub = cid
    ? db.prepare('SELECT username FROM user_channel_bindings WHERE channel_id=? AND channel_user_id=?').get(cid, senderId)
    : null;
  if (!ub || !ub.username) {
    const rr = '请先在平台「接入管理 → 用户绑定」中绑定你的渠道身份，之后才能远程操控你的电脑。';
    await sendChannelReply(channel, senderId, rr);
    return { ok: false, reason: 'unbound', reply: rr };
  }
  const username = ub.username;

  // ③ 设备路由
  const dev = resolveDevice(username, hint.deviceName);
  if (!dev) {
    const rr = '❌ 你还没有配对的本地设备。请先下载安装「TeleAgent 智能体平台助手」并完成配对（平台「设备」页有引导）。';
    await sendChannelReply(channel, senderId, rr);
    return { ok: false, reason: 'no-device', reply: rr };
  }
  if (!isOnline(dev)) {
    const rr = `❌ 设备「${dev.device_name}」离线（心跳超过 30s）。请打开本机的「TeleAgent 智能体平台助手」后重试。`;
    await sendChannelReply(channel, senderId, rr);
    return { ok: false, reason: 'offline', reply: rr };
  }

  // ④ 高危闸（键鼠/clipboard_write/file_write 默认关闭）
  if (HIGH_RISK_OPS.includes(parsed.op) && !dev.allow_high_risk) {
    const rr = `⛔ 操作「${OP_LABEL[parsed.op] || parsed.op}」属高危操作，默认关闭。请在平台设备管理页为设备「${dev.device_name}」开启「允许高危远控」后重试。`;
    await sendChannelReply(channel, senderId, rr);
    return { ok: false, reason: 'high-risk-blocked', reply: rr };
  }

  // ⑤ 入队（★携带 channel_msg_id，使桥 /result 回传分支生效）
  const info = db.prepare('INSERT INTO localbridge_tasks (device_id,username,op,params,status,channel_msg_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(dev.id, username, parsed.op, JSON.stringify(parsed.params), 'pending', auditId || null, now(), now());

  // 审计留痕
  try {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at,duration_ms) VALUES (?,?,?,?,?,?)')
      .run(username, `渠道远控:${parsed.op}`, `设备${dev.device_name}；渠道${channel}#${auditId || ''}`, '', now(), null);
  } catch { /* 审计失败不阻断 */ }

  // 可选回执（公众号已有被动占位回复，跳过避免重复）
  if (channel !== 'wechat-mp') {
    await sendChannelReply(channel, senderId, `已下发到设备「${dev.device_name}」，执行中…`);
  }

  return { ok: true, taskId: info.lastInsertRowid, op: parsed.op, device: dev.device_name, username };
}

module.exports = {
  parseRemoteCommand, sanitizeParams, isUnsafePath, extractDeviceHint,
  resolveDevice, isOnline, formatResultForChannel, handleInbound,
  sendChannelReply, HIGH_RISK_OPS, OP_LABEL, USAGE_HINT, RULES,
};
