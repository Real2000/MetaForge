/**
 * 钉钉集成路由（V1.3 #4 2026-10-30，mock 阶段全链路：验签/解密/回调幂等/组织同步）
 *
 * 挂载于 /api/dingtalk（server.js）。⚠️ 故意不挂 auth 中间件——钉钉回调是服务器对服务器推送，
 * 无登录态；安全完全靠 msg_signature 验签 + AES 解密双重防线（伪造报文在验签一步即被静默拒绝）。
 *
 * 凭证：secrets 表约定键名（lib/secrets.js loadSecrets()，明文存储 + maskSecrets 脱敏为平台既有防护模式）
 *   DINGTALK_APP_KEY / DINGTALK_APP_SECRET —— 扫码 OAuth（routes/auth.js 使用）
 *   DINGTALK_AES_KEY  —— 回调加密 AESKey（43 位 Base64，解码 32 字节）
 *   DINGTALK_TOKEN    —— 回调验签 token
 *   DINGTALK_CORP_ID  —— 可选：企业 corpid 尾部强校验（未配置则跳过该层校验）
 *
 * 钉钉回调协议要点：
 *   - 钉钉收到非 200 会持续重试（最长 24h）→ 任何拒绝都必须 200 空体静默返回，绝不 5xx（防重试风暴）
 *   - 重复投递必须 ACK 不重放 → dingtalk_events 表 event_id UNIQUE 幂等去重（db.js 已建表）
 *   - GET /callback 为 URL 验证：须返回解密后的 echostr 明文（纯文本，非 JSON）
 *
 * mock 阶段简化（真实联调阶段单独立项后再评估）：
 *   - departments 表无 dingtalk_id 列（无加列权限）→ 钉钉↔本地部门映射关系以原始 DeptId/DeptName
 *     存于 dingtalk_events.payload，运行时按历史事件 payload 反查「钉钉 DeptId→部门名→本地部门」两级间接映射；
 *     dept_modify 改名场景（匹配不到 name+parent）退化为 INSERT 新行
 *   - user 离职/部门删除仅记 op_logs 软处理（不物理删，防误删）
 */
const express = require('express');
const crypto = require('crypto');
const { db, hashPwd, now } = require('../db');
const { loadSecrets } = require('../lib/secrets');
const { sha1Sign, decryptMsg, safeEqualHex } = require('../lib/dingtalk-crypto');
const { clientIp, createLimiter } = require('../lib/rate-limit');

const router = express.Router();

// V1.3 审查加固 2026-10-30：免登录回调端点限流——验签失败每次同步写 op_logs，无节流可被刷库膨胀（淹没真实审计）；
// 钉钉真实重试频率远低于此阈值不影响业务；keyFn 用 req.ip 兑底（XFF 首个可伪造，公网直连部署下更稳）
const callbackLimiter = createLimiter({
  name: 'dingtalk-callback',
  windowMs: 60000,
  max: 60,
  keyFn: req => req.ip || clientIp(req),
  msg: '',
});
router.use(callbackLimiter);

/** 审计落库（op_logs；钉钉链路统一系统账号 dingtalk-sync；审计失败不阻塞主流程） */
function logOp(action, detail, ip) {
  try {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run('dingtalk-sync', action, detail || '', ip || '', now());
  } catch { /* 审计失败不影响回调 ACK */ }
}

/** 读钉钉回调凭证（AES_KEY/TOKEN 二者齐备才算已配置） */
function loadCallbackCreds() {
  const s = loadSecrets();
  return { aesKey: s.DINGTALK_AES_KEY || '', token: s.DINGTALK_TOKEN || '', corpid: s.DINGTALK_CORP_ID || '' };
}

// ---------- GET /callback：钉钉回调 URL 验证 ----------
// 钉钉后台保存回调地址时会先发一次验证请求：query 带 msg_signature/timestamp/nonce/echostr，
// 服务端验签 + 解密 echostr 后必须返回明文纯文本（非 JSON！）——钉钉以此确认地址与加解密配置正确
router.get('/callback', (req, res) => {
  const ip = clientIp(req);
  const { msg_signature, timestamp, nonce, echostr } = req.query || {};
  const { aesKey, token, corpid } = loadCallbackCreds();
  if (!aesKey || !token) {
    return res.status(503).json({ code: 503, msg: '钉钉回调未配置' });
  }
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    logOp('钉钉URL验证失败', '验证请求四参不齐（疑似探测）', ip);
    return res.status(400).send('fail');
  }
  let expect;
  try { expect = sha1Sign(token, timestamp, nonce, echostr); } catch (e) {
    logOp('钉钉URL验证失败', '签名计算异常：' + e.message, ip);
    return res.status(403).send('fail');
  }
  if (!safeEqualHex(expect, msg_signature)) {
    logOp('钉钉URL验证失败', 'echostr 验签不通过', ip);
    return res.status(403).send('fail');
  }
  let plain;
  try { plain = decryptMsg(aesKey, echostr); } catch (e) {
    logOp('钉钉URL验证失败', 'echostr 解密失败：' + e.message, ip);
    return res.status(403).send('fail');
  }
  if (corpid && plain.corpid !== corpid) {
    logOp('钉钉URL验证失败', `corpid 不匹配（期望 ${corpid.slice(0, 6)}***，实际 ${String(plain.corpid).slice(0, 6)}***）`, ip);
    return res.status(403).send('fail');
  }
  // 钉钉协议：返回解密后的 echostr 明文（纯文本响应；防御性处理万一解出对象的情况）
  const out = typeof plain.message === 'string' ? plain.message : JSON.stringify(plain.message);
  res.set('Content-Type', 'text/plain; charset=utf-8').status(200).send(out);
});

// ---------- POST /callback：钉钉通讯录事件回调 ----------
// 铁律：除成功 ACK（200 + {errcode:0}）外一律 200 空体静默拒绝并审计——
// 返回 5xx 会让钉钉按指数退避持续重试最长 24h（重试风暴）；伪造探测也拿不到任何信息
router.post('/callback', (req, res) => {
  const ip = clientIp(req);
  const { msg_signature, timestamp, nonce, encrypt } = req.body || {};
  const { aesKey, token, corpid } = loadCallbackCreds();
  // ① 未配置：记审计后 200 空体（不可让未配置状态的探测请求打崩）
  if (!aesKey || !token) {
    logOp('钉钉回调未配置', '收到回调但 DINGTALK_AES_KEY/DINGTALK_TOKEN 未配置', ip);
    return res.status(200).end();
  }
  // ② 报文字段不齐：按验签失败同款静默拒绝
  if (!msg_signature || !timestamp || !nonce || !encrypt) {
    logOp('钉钉回调验签失败', '报文四字段不齐（疑似探测）', ip);
    return res.status(200).end();
  }
  // ③ 验签：sha1(排序拼接) 与报文 msg_signature 常量时间比较
  let expect;
  try { expect = sha1Sign(token, timestamp, nonce, encrypt); } catch (e) {
    logOp('钉钉回调验签失败', '签名计算异常：' + e.message, ip);
    return res.status(200).end();
  }
  if (!safeEqualHex(expect, msg_signature)) {
    logOp('钉钉回调验签失败', 'msg_signature 不匹配（篡改或非本企业投递）', ip);
    return res.status(200).end();
  }
  // ④ 解密 + 可选 corpid 强校验（验签过了仍可能 AES Key 配错——解密失败同样静默审计）
  let plain;
  try { plain = decryptMsg(aesKey, encrypt); } catch (e) {
    logOp('钉钉回调解密失败', e.message, ip);
    return res.status(200).end();
  }
  if (corpid && plain.corpid !== corpid) {
    logOp('钉钉回调拒绝', 'corpid 与配置不匹配', ip);
    return res.status(200).end();
  }
  const payload = plain.message;
  if (!payload || typeof payload !== 'object') {
    logOp('钉钉回调报文异常', '解密后消息体不是 JSON 对象', ip);
    return res.status(200).end();
  }
  const eventId = payload.EventId || payload.eventId || '';
  const eventType = payload.EventType || payload.eventType || '';
  if (!eventId) {
    logOp('钉钉回调报文异常', '消息体缺 EventId，无法幂等去重', ip);
    return res.status(200).end();
  }
  // ⑤ 幂等去重：event_id UNIQUE 冲突 = 已处理过 → 直接 ACK 不重放（钉钉最长 24h 失败重试期间可能重复投递）
  try {
    db.prepare('INSERT INTO dingtalk_events (event_id,event_type,payload,created_at) VALUES (?,?,?,?)')
      .run(String(eventId), String(eventType), JSON.stringify(payload), now());
  } catch (e) {
    // V1.3 审查加固：优先 e.code 稳定 API 判定（message 文案随版本可变；失真会把真冲突误判为库故障）
    if ((e.code && /UNIQUE/i.test(e.code)) || /UNIQUE/i.test(String(e.message || ''))) {
      logOp('钉钉回调幂等命中', `EventId=${eventId} 已处理过，直接 ACK`, ip);
      return res.status(200).json({ errcode: 0 });
    }
    // V1.3 审查加固（安全审查 M5）：库故障分支改 500——钉钉判成功需 body {errcode:0}，空体 200 同样触发重试；
    // 而 events 未落库时重试恰是正确自愈路径（EventId 未消费，库恢复后补投），不该用 500 之外的任何东西拖盖。
    // 注：这会触发钉钉指数退避重试（最长 24h）——库故障本就应重试，这是幂等去重表存在的意义
    logOp('钉钉回调落库异常', `EventId=${eventId}：${e.message}（返回 500 让钉钉重试自愈）`, ip);
    return res.status(500).end();
  }
  // ⑥ 事件处理：每种 try-catch 隔离——handler 失败时回滚去重记录（V1.3 审查加固：
  // 原实现事件已标记已处理但未生效，钉钉永不重投即事件永久丢失；dept/user handler 均为幂等 upsert，重放安全）
  try {
    const handler = DEPT_EVENTS[eventType] || USER_EVENTS[eventType];
    if (handler) handler(payload, ip);
    else logOp('钉钉回调事件忽略', `未识别的 EventType=${eventType}（记录不处理）`, ip);
  } catch (e) {
    logOp('钉钉回调事件处理失败', `EventType=${eventType}：${e.message}（已回滚去重记录，钉钉重试自愈）`, ip);
    try { db.prepare('DELETE FROM dingtalk_events WHERE event_id=?').run(String(eventId)); } catch { }
    try { db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('dingtalk', `事件处理失败 ${eventType}: ${e.message}（可重放）`, now()); } catch { }
  }
  // ⑦ 钉钉要求成功响应 JSON {errcode:0}（非 0 会触发重试）
  return res.status(200).json({ errcode: 0 });
});

// ==================== 组织同步事件处理（mock 简化映射，见文件头注释） ====================

/** 历史部门事件 payload → Map(钉钉 DeptId → 部门名)（后写覆盖先写，dept_modify 事件可更正名称） */
function dingDeptIdToNames() {
  const rows = db.prepare(`SELECT payload FROM dingtalk_events WHERE event_type IN ('dept_create','dept_modify') ORDER BY id`).all();
  const m = new Map();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      if (p && p.DeptId != null && p.DeptName) m.set(String(p.DeptId), String(p.DeptName));
    } catch { /* 损坏历史数据跳过 */ }
  }
  return m;
}

/** 钉钉 DeptId → 本地 departments.id（两级间接：DeptId→部门名→按名查本地；映射不到返回 null=挂根级）。
 *  V1.3 审查加固：同名部门（多个「综合部」挂不同父）时跳过该映射（防串部门），与文件头注释的「仅唯一名命中时采信」对齐 */
function localDeptIdFromDing(dingId) {
  if (dingId == null) return null;
  const name = dingDeptIdToNames().get(String(dingId));
  if (!name) return null;
  const rows = db.prepare('SELECT id FROM departments WHERE name=?').all(name);
  return rows.length === 1 ? rows[0].id : null; // 同名多条 → 放弃映射（歧义时保守处理）
}

/** dept_create / dept_modify：按 name+parent 匹配 upsert（匹配不到则 INSERT，path 按父链拼 /1/5/12，order_num 默认 0） */
function upsertDingtalkDept(payload) {
  const name = String(payload.DeptName || '').trim();
  if (!name) return; // 无部门名无法建行（钉钉正常报文不会出现）
  const parentId = localDeptIdFromDing(payload.ParentId); // 映射不到 → 挂根级（含钉钉根部门 ParentId=1/0）
  const existing = db.prepare('SELECT id FROM departments WHERE name=? AND parent_id IS ?').get(name, parentId);
  if (existing) return existing.id; // 已存在：幂等确认（mock 阶段无 dingtalk_id 列，改名场景退化为新 INSERT，见文件头）
  const info = db.prepare(`INSERT INTO departments (parent_id,name,path,order_num,created_at) VALUES (?,?, '', 0, datetime('now','localtime'))`)
    .run(parentId, name);
  const id = Number(info.lastInsertRowid);
  const parentPath = parentId ? (db.prepare('SELECT path FROM departments WHERE id=?').get(parentId)?.path || '') : '';
  db.prepare('UPDATE departments SET path=? WHERE id=?').run(parentPath + '/' + id, id); // path 自引用二级写（departments.js 同款模式）
  return id;
}

/**
 * user_add_org / user_modify_org 同款用户映射规则（auth.js 扫码登录复用，故导出）：
 *   1. username 优先按 phone 匹配现有用户（政企常见手机号即账号）→ 命中则更新昵称/部门
 *   2. 无匹配（或 phone 非法）→ username=`dingtalk_${UserId}` 新建：
 *      password=随机串哈希（无人知晓的不可登录占位）、role='user'、dept_id 尽量按部门名匹配
 */
function upsertDingtalkUser({ userId, nickname, deptIdList, phone }) {
  // 部门匹配：钉钉 DeptIdList → 部门名 → 本地 departments.id（仅唯一名命中时采信，防串部门）
  let deptName = '', deptId = null;
  const list = Array.isArray(deptIdList) ? deptIdList : (deptIdList != null ? [deptIdList] : []);
  const nameMap = dingDeptIdToNames();
  for (const did of list) {
    const nm = nameMap.get(String(did));
    if (!nm) continue;
    const rows = db.prepare('SELECT id FROM departments WHERE name=?').all(nm);
    if (rows.length === 1) { deptName = nm; deptId = rows[0].id; break; } // V1.3 审查加固：同名多条跳过（歧义保守）
  }
  // 手机号即账号：宽松校验防垃圾 phone 误匹配（11 位数字）
  const phoneStr = String(phone || '').trim();
  if (/^1\d{10}$/.test(phoneStr)) {
    const byPhone = db.prepare('SELECT id FROM users WHERE username=?').get(phoneStr);
    if (byPhone) {
      // V1.3 审查加固：dept_id 用 COALESCE 保留——此前裸写，映射不到（null）时直接清空已有归属，
      // 而扫码登录恒传空 deptIdList → 每次登录都把用户 dept_id 置 NULL（visible_depts 权限判定依据静默丢失）
      db.prepare(`UPDATE users SET nickname=COALESCE(NULLIF(?,''),nickname), dept=COALESCE(NULLIF(?,''),dept), dept_id=COALESCE(?,dept_id) WHERE id=?`)
        .run(nickname || '', deptName, deptId, byPhone.id);
      return { id: byPhone.id, username: phoneStr, created: false };
    }
  }
  // dingtalk_${userId}：先查后插（重名 UNIQUE 拦截兜底 try-catch）
  const username = `dingtalk_${userId}`;
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (existing) {
    // V1.3 审查加固：同上 dept_id COALESCE 保留
    db.prepare(`UPDATE users SET nickname=COALESCE(NULLIF(?,''),nickname), dept=COALESCE(NULLIF(?,''),dept), dept_id=COALESCE(?,dept_id) WHERE id=?`)
      .run(nickname || '', deptName, deptId, existing.id);
    return { id: existing.id, username, created: false };
  }
  // 新建：随机占位密码（32 字节随机 hex 再哈希——无人可登录；走正常改密/绑定流程激活）
  const password = hashPwd(crypto.randomBytes(32).toString('hex'));
  const info = db.prepare(`INSERT INTO users (username,password,nickname,role,dept,dept_id,status,must_change_pwd,created_at)
    VALUES (?,?,?,'user',?,?,1,0,datetime('now','localtime'))`)
    .run(username, password, nickname || username, deptName, deptId);
  return { id: Number(info.lastInsertRowid), username, created: true };
}

const DEPT_EVENTS = {
  dept_create: (p, ip) => { upsertDingtalkDept(p); logOp('钉钉部门同步', `dept_create DeptId=${p.DeptId} Name=${p.DeptName}`, ip); },
  dept_modify: (p, ip) => { upsertDingtalkDept(p); logOp('钉钉部门同步', `dept_modify DeptId=${p.DeptId} Name=${p.DeptName}`, ip); },
  // dept_delete：软处理（仅审计留痕，不物理删——误删组织树是政企红线，真实联调阶段再评估软删标记列）
  dept_delete: (p, ip) => logOp('钉钉部门删除（软处理）', `dept_delete DeptId=${p.DeptId}——仅记录，未物理删除`, ip),
};
// 钉钉原始报文字段（UserId/NickName/DeptIdList/Phone）→ upsertDingtalkUser 形参（camelCase，auth.js 复用同款）
const mapUserPayload = p => ({
  userId: p.UserId ?? p.userid,
  nickname: p.NickName ?? p.nickname,
  deptIdList: p.DeptIdList ?? p.deptIdList ?? p.DeptId,
  phone: p.Phone ?? p.phone ?? p.Mobile ?? p.mobile,
});
const USER_EVENTS = {
  user_add_org: (p, ip) => { const u = upsertDingtalkUser(mapUserPayload(p)); logOp('钉钉用户同步', `user_add_org UserId=${p.UserId} → ${u.username}${u.created ? '（新建）' : '（更新）'}`, ip); },
  user_modify_org: (p, ip) => { const u = upsertDingtalkUser(mapUserPayload(p)); logOp('钉钉用户同步', `user_modify_org UserId=${p.UserId} → ${u.username}${u.created ? '（新建）' : '（更新）'}`, ip); },
  // user_leave_org：软处理（政企红线：离职信息留痕但不自动禁用账号，管理员人工确认后再处理）
  user_leave_org: (p, ip) => logOp('钉钉用户离职（软处理）', `user_leave_org UserId=${p.UserId}——仅记录，未禁用账号`, ip),
};

// ==================== V3.1 #11 钉钉 H5 微应用（2026-11-03：方案设计 + mock 实现，真实联调待企业凭证） ====================
// 设计要点（对齐安全报告 T1.3：H5 免登 JWT 不走 URL，全部 POST JSON body 交付——复用 #14 同款结论）：
//   - GET  /h5/config       模式发现（mock/real + corpId/agentId 回显，前端据此选免登按钮形态）
//   - POST /h5/login        免登换 JWT：real=auth_code 换 userid（gettoken→getuserinfo）；mock=mock_user 直登本地账号
//   - POST /h5/jsapi-config dd.config 所需签名（real=jsapi_ticket HMAC；mock=本地票据同算法，链路可测）
//   - POST /h5/send-msg     工作通知（auth 中间件；real=asyncCorpSend；mock=op_logs 留痕返回成功）
// mock 通道仅在凭证未配置时可用——配置 DINGTALK_APP_KEY/SECRET 后自动关闭（生产环境不可能被 mock 登录绕过）
const { auth, sign, TOKEN_TTL_MS } = require('../lib/auth');
const h5Limiter = createLimiter({
  name: 'dingtalk-h5',
  windowMs: 60000,
  max: 10,
  keyFn: req => req.ip || clientIp(req),
  msg: '钉钉免登请求过于频繁，请 1 分钟后再试',
});

/** H5 凭证就绪判定（APP_KEY/SECRET 齐备 = 真实模式） */
function h5Configured() {
  const s = loadSecrets();
  return !!(s.DINGTALK_APP_KEY && s.DINGTALK_APP_SECRET);
}

/** 企业 access_token 获取（真实模式；内存缓存 7000s < 官方 7200s 有效期，避免每请求都打钉钉） */
let cachedToken = { value: '', expire: 0 };
async function getAccessToken() {
  const s = loadSecrets();
  if (Date.now() < cachedToken.expire) return cachedToken.value;
  const r = await fetch('https://oapi.dingtalk.com/gettoken?' + new URLSearchParams({
    appkey: s.DINGTALK_APP_KEY, appsecret: s.DINGTALK_APP_SECRET,
  }), { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j || j.errcode !== 0 || !j.access_token) throw new Error('获取钉钉 access_token 失败：' + JSON.stringify(j || {}).slice(0, 120));
  cachedToken = { value: j.access_token, expire: Date.now() + (j.expires_in || 7200) * 1000 - 200000 };
  return cachedToken.value;
}

/** 签发与密码登录完全同构的登录响应（#14 之后统一走 JSON body，token 不落 URL） */
function loginPayload(user) {
  const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
  const u = db.prepare('SELECT id, username, nickname, role, dept, onboarded, must_change_pwd FROM users WHERE id=? AND status=1').get(user.id);
  return { token, user: { id: u.id, username: u.username, nickname: u.nickname, role: u.role, dept: u.dept, onboarded: u.onboarded ? 1 : 0 }, must_change_pwd: u.must_change_pwd ? 1 : 0 };
}

// ---------- GET /h5/config：模式发现（前端免登按钮形态判定；未挂 auth——登录前调用） ----------
router.get('/h5/config', (req, res) => {
  const s = loadSecrets();
  res.json({ code: 0, data: {
    enabled: h5Configured(),       // true=真实模式（凭证齐备）
    mock: !h5Configured(),         // true=mock 模式（演示/开发用）
    corp_id: s.DINGTALK_CORP_ID || '',
    agent_id: s.DINGTALK_AGENT_ID || '',
  } });
});

// ---------- POST /h5/login：免登换 JWT（真实=auth_code 换 userid；mock=mock_user 直登本地账号） ----------
router.post('/h5/login', h5Limiter, async (req, res) => {
  const ip = clientIp(req);
  const b = req.body || {};
  if (h5Configured()) {
    // 真实模式：前端 dd.runtime.permission.requestAuthCode 拿 auth_code → gettoken → getuserinfo → upsert 用户 → 签发
    if (!b.auth_code) return res.json({ code: 400, msg: '缺少 auth_code（前端需先经 dd.runtime.permission.requestAuthCode 获取）' });
    try {
      const accessToken = await getAccessToken();
      const r = await fetch('https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?' + new URLSearchParams({ access_token: accessToken }), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: b.auth_code }), signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (!j || j.errcode !== 0 || !j.result) return res.json({ code: 401, msg: '钉钉免登失败：' + (j && j.errmsg || '换取用户信息被拒') });
      const user = upsertDingtalkUser({ userId: j.result.userid, nickname: j.result.name || '', deptIdList: (j.result.dept_id_list || []).map(String), phone: j.result.mobile || '' });
      logOp('钉钉H5免登', `userid=${j.result.userid} → ${user.username}（真实模式）`, ip);
      return res.json({ code: 0, data: loginPayload(user) });
    } catch (e) {
      logOp('钉钉H5免登失败', String(e.message).slice(0, 120), ip);
      return res.json({ code: 502, msg: '钉钉服务暂不可达，请稍后重试' });
    }
  }
  // mock 模式：mock_user 指定本地用户名直登（凭证配置后本分支自动不可达——mock 不可能进入生产）
  if (!b.mock_user || !/^[a-zA-Z0-9_]{2,32}$/.test(b.mock_user)) return res.json({ code: 400, msg: 'mock 模式需指定本地用户名（mock_user）' });
  const user = db.prepare('SELECT * FROM users WHERE username=? AND status=1').get(b.mock_user);
  if (!user) return res.json({ code: 401, msg: '本地用户不存在或已禁用：' + b.mock_user });
  logOp('钉钉H5免登', `${b.mock_user}（mock 模式——凭证未配置）`, ip);
  res.json({ code: 0, data: loginPayload(user), mock: true });
});

// ---------- POST /h5/jsapi-config：dd.config 签名（真实=jsapi_ticket；mock=本地票据同算法） ----------
// 签名算法（钉钉官方）：HMAC-SHA256(jsapi_ticket, `${nonceStr}${timestamp}${url}`) 十六进制。
// 真实模式 ticket 经 access_token 换取并缓存；mock 用确定性本地票据（前端链路可完整调试 dd.config 前置流程）。
let cachedTicket = { value: '', expire: 0 };
router.post('/h5/jsapi-config', h5Limiter, async (req, res) => {
  const s = loadSecrets();
  const url = String((req.body || {}).url || '').slice(0, 500);
  if (!/^https?:\/\//.test(url)) return res.json({ code: 400, msg: '缺少页面 url（dd.config 需按调用页 URL 签名）' });
  let ticket = '';
  if (h5Configured()) {
    try {
      if (Date.now() >= cachedTicket.expire) {
        const accessToken = await getAccessToken();
        const r = await fetch('https://oapi.dingtalk.com/get_jsapi_ticket?' + new URLSearchParams({ access_token: accessToken }), { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!j || j.errcode !== 0 || !j.ticket) return res.json({ code: 502, msg: '获取 jsapi_ticket 失败：' + (j && j.errmsg || '') });
        cachedTicket = { value: j.ticket, expire: Date.now() + (j.expires_in || 7200) * 1000 - 200000 };
      }
      ticket = cachedTicket.value;
    } catch (e) { return res.json({ code: 502, msg: '钉钉服务暂不可达，请稍后重试' }); }
  } else {
    ticket = 'mock-jsapi-ticket-' + crypto.createHash('sha256').update(String(s.DINGTALK_APP_KEY || 'mock') + ':h5').digest('hex').slice(0, 32);
  }
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', ticket).update(`${nonceStr}${timeStamp}${url}`).digest('hex');
  res.json({ code: 0, data: { agentId: s.DINGTALK_AGENT_ID || '', corpId: s.DINGTALK_CORP_ID || '', timeStamp, nonceStr, signature, mock: !h5Configured() } });
});

// ---------- POST /h5/send-msg：工作通知（挂 auth；真实=asyncCorpSend；mock=审计留痕返回成功） ----------
router.post('/h5/send-msg', auth, async (req, res) => {
  const ip = clientIp(req);
  const b = req.body || {};
  const userList = String(b.userid_list || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20); // 单次至多 20 人
  const title = String(b.title || '').trim().slice(0, 60);
  const content = String(b.content || '').trim().slice(0, 500);
  if (!userList.length || !content) return res.json({ code: 400, msg: 'userid_list 与 content 必填（title 可选）' });
  // P1-7 渠道适配层：出站统一走 lib/channel.send（钉钉未配置时自动降级站内信 + 审计）
  const { send: channelSend } = require('../lib/channel');
  const r = await channelSend({ channel: 'dingtalk', receivers: userList }, { title, content });
  if (r.ok && r.mock) {
    logOp('钉钉H5消息（降级）', `收件 ${userList.length} 人 [${title || content.slice(0, 20)}] ${content.slice(0, 80)}`, ip);
    return res.json({ code: 0, msg: '已发送（mock 模式：未配置钉钉凭证，消息仅审计留痕）', data: { mock: true, receivers: userList.length } });
  }
  if (!r.ok) {
    logOp('钉钉H5消息失败', String(r.error || '').slice(0, 120), ip);
    return res.json({ code: 502, msg: '钉钉消息发送失败：' + (r.error || '未知错误') });
  }
  logOp('钉钉H5消息', `收件 ${userList.length} 人 [${title || content.slice(0, 20)}] taskId=${r.taskId}`, ip);
  res.json({ code: 0, msg: '已发送', data: { task_id: r.taskId } });
});

module.exports = router;
// 供 routes/auth.js 扫码登录复用同款用户映射规则（departments.js 的附加导出同款模式）
module.exports.upsertDingtalkUser = upsertDingtalkUser;
