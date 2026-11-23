/**
 * MT-10 租户开通闭环（2026-11-22）
 *
 * 职责：租户一等实体的生命周期管理（开通 / 启停 / 列举），供 routes/tenants.js 使用。
 * 设计要点：
 *   1) 开通租户 = 建 tenants 行 + 派生首个租户管理员（role='admin'，tenant_id=新租户）；
 *   2) 用户名保持全局唯一，派生管理员名冲突即整笔回滚（事务保证）；
 *   3) 停用租户 = status='disabled' + 踢出该租户全部用户在线会话（token_version+1）；
 *   4) 单租户私有化形态下（默认）租户 1 恒 active，本模块不改变既有行为。
 */
'use strict';

const { db, hashPwd, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const WEAK = ['123456', 'admin123', 'demo123', 'password', '111111', '000000', 'abc123'];

function validPwd(p) {
  if (!p || p.length < 6) return '密码至少 6 位';
  if (WEAK.includes(p)) return '密码过于简单（常见默认口令），请换一个';
  return '';
}

/** 列举全部租户（含用户数统计） */
function listTenants() {
  const rows = dal.q('SELECT id, name, status, plan, parent_tenant_id, admin_username, note, created_at FROM tenants ORDER BY id');
  return rows.map(t => ({ ...t, user_count: dal.getq('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', [t.id]).c }));
}

function getTenant(id) {
  return dal.getq('SELECT id, name, status, plan, parent_tenant_id, admin_username, note, created_at FROM tenants WHERE id=?', [id]);
}

/**
 * 开通租户：建租户 + 派生首个管理员（事务，同名冲突整笔回滚）。
 * @returns {{ok:true, tenantId:number, adminUsername:string} | {ok:false, msg:string}}
 */
function createTenant({ name, plan, adminUsername, adminPassword, adminNickname, note } = {}) {
  const tname = String(name || '').trim();
  if (!tname) return { ok: false, msg: '租户名称不能为空' };
  if (tname.length > 40) return { ok: false, msg: '租户名称过长（≤40）' };
  const uname = String(adminUsername || '').trim();
  if (!USERNAME_RE.test(uname)) return { ok: false, msg: '管理员用户名需 3~20 位字母/数字/下划线' };
  const pwdErr = validPwd(adminPassword);
  if (pwdErr) return { ok: false, msg: '管理员' + pwdErr };
  const planName = String(plan || 'free').slice(0, 20);
  const dup = dal.getq('SELECT id FROM users WHERE username=?', [uname]);
  if (dup) return { ok: false, msg: '用户名已存在（平台用户名全局唯一）' };

  try {
    const tid = db.transaction(() => {
      const info = dal.runq('INSERT INTO tenants (name,status,plan,admin_username,note,created_at) VALUES (?,?,?,?,?,?)', [tname, 'active', planName, uname, String(note || '').slice(0, 200), now()]);
      const tenantId = info.lastInsertRowid;
      dal.runq('INSERT INTO users (username,password,nickname,role,dept,status,must_change_pwd,created_at,tenant_id,platform_admin) VALUES (?,?,?,?,?,1,1,?,?,0)', [uname, hashPwd(adminPassword), String(adminNickname || uname).slice(0, 30), 'admin', '', now(), tenantId]);
      return tenantId;
    })();
    return { ok: true, tenantId: tid, adminUsername: uname };
  } catch (e) {
    // 唯一约束竞态等：整笔回滚
    return { ok: false, msg: '开通失败：' + (e && e.message ? e.message : '未知错误') };
  }
}

/** 启停租户：停用时踢出该租户全部用户在线会话 */
function setTenantStatus(id, status) {
  const t = getTenant(id);
  if (!t) return { ok: false, msg: '租户不存在' };
  const st = status === 'disabled' ? 'disabled' : 'active';
  if (t.id === 1 && st === 'disabled') return { ok: false, msg: '默认租户不可停用' };
  dal.runq('UPDATE tenants SET status=? WHERE id=?', [st, t.id]);
  if (st === 'disabled') {
    dal.runq('UPDATE users SET token_version = COALESCE(token_version,0) + 1 WHERE tenant_id=?', [t.id]);
  }
  return { ok: true, status: st };
}

/** 是否平台超管（复用 auth 的判定：platform_admin=1 或 admin+清单） */
function isPlatformSuper(user) {
  try { return require('./auth').isPlatformSuperadmin(user || {}); } catch { return false; }
}

/**
 * MT-11/12：解析「本次请求的租户作用域」（列表/报表/管理的统一口径）。
 * @param {object} req Express 请求（须过 tenantContext）
 * @param {object} [opts] { param='tenant_id', superDefault=null }
 * @returns {number|null} number = 限定该租户；null = 不限定（单租户全量 / 平台超管未指定）
 *   - 单租户模式：null（不做租户过滤，零回归）
 *   - 平台超管：req.query[param] 显式指定则用之，否则 superDefault
 *   - 租户内用户：强制本人 req.tenant.id（fail-closed，防头伪造跨租户）
 */
function scopeTenant(req, { param = 'tenant_id', superDefault = null } = {}) {
  const t = req && req.tenant;
  if (!t || t.single) return null;
  if (isPlatformSuper(req.user)) {
    const raw = req.query ? req.query[param] : undefined;
    if (raw !== undefined && raw !== '' && raw !== null && Number.isFinite(Number(raw))) return Number(raw);
    return superDefault;
  }
  return t.id != null ? Number(t.id) : null;
}

/**
 * MT-12：管理视角的租户作用域（providers / secrets 的「平台全局基线 + 租户覆盖层」口径）。
 * @param {object} req
 * @param {object} [opts] { param='tenant_id' }
 * @returns {number} 目标层级：0=平台全局基线；>0=某租户覆盖层
 *   - 单租户模式：0（平台全局层，零回归）
 *   - 平台超管：req.query[param] 指定则用之，否则 0（管理平台基线）
 *   - 租户内用户：强制本人 req.tenant.id（fail-closed，不得操作平台基线或他租户）
 */
function mgmtScope(req, { param = 'tenant_id' } = {}) {
  const t = req && req.tenant;
  if (!t || t.single) return 0;
  if (isPlatformSuper(req.user)) {
    const raw = req.query ? req.query[param] : undefined;
    if (raw !== undefined && raw !== '' && raw !== null && Number.isFinite(Number(raw))) return Number(raw);
    return 0;
  }
  return t.id != null && Number(t.id) > 0 ? Number(t.id) : 0;
}

/**
 * MT-12：某资源行是否可被当前管理作用域操作（写权限校验，fail-closed）。
 * 平台超管可操作全局层(0)与任意租户层；租户用户仅可操作本租户层。
 */
function canManageRow(req, rowTenantId) {
  const rt = Number(rowTenantId) || 0;
  const t = req && req.tenant;
  if (!t || t.single) return true; // 单租户：全部可管理
  if (isPlatformSuper(req.user)) return true;
  return rt === Number(t.id);
}

module.exports = { listTenants, getTenant, createTenant, setTenantStatus, validPwd, isPlatformSuper, scopeTenant, mgmtScope, canManageRow };
