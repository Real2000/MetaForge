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

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const WEAK = ['123456', 'admin123', 'demo123', 'password', '111111', '000000', 'abc123'];

function validPwd(p) {
  if (!p || p.length < 6) return '密码至少 6 位';
  if (WEAK.includes(p)) return '密码过于简单（常见默认口令），请换一个';
  return '';
}

/** 列举全部租户（含用户数统计） */
function listTenants() {
  const rows = db.prepare('SELECT id, name, status, plan, parent_tenant_id, admin_username, note, created_at FROM tenants ORDER BY id').all();
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?');
  return rows.map(t => ({ ...t, user_count: countStmt.get(t.id).c }));
}

function getTenant(id) {
  return db.prepare('SELECT id, name, status, plan, parent_tenant_id, admin_username, note, created_at FROM tenants WHERE id=?').get(id);
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
  const dup = db.prepare('SELECT id FROM users WHERE username=?').get(uname);
  if (dup) return { ok: false, msg: '用户名已存在（平台用户名全局唯一）' };

  try {
    const tid = db.transaction(() => {
      const info = db.prepare('INSERT INTO tenants (name,status,plan,admin_username,note,created_at) VALUES (?,?,?,?,?,?)')
        .run(tname, 'active', planName, uname, String(note || '').slice(0, 200), now());
      const tenantId = info.lastInsertRowid;
      db.prepare('INSERT INTO users (username,password,nickname,role,dept,status,must_change_pwd,created_at,tenant_id,platform_admin) VALUES (?,?,?,?,?,1,1,?,?,0)')
        .run(uname, hashPwd(adminPassword), String(adminNickname || uname).slice(0, 30), 'admin', '', now(), tenantId);
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
  db.prepare('UPDATE tenants SET status=? WHERE id=?').run(st, t.id);
  if (st === 'disabled') {
    db.prepare('UPDATE users SET token_version = COALESCE(token_version,0) + 1 WHERE tenant_id=?').run(t.id);
  }
  return { ok: true, status: st };
}

module.exports = { listTenants, getTenant, createTenant, setTenantStatus, validPwd };
