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

module.exports = router;
// 供 routes/auth.js 扫码登录复用同款用户映射规则（departments.js 的附加导出同款模式）
module.exports.upsertDingtalkUser = upsertDingtalkUser;
