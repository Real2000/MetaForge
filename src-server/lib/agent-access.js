/**
 * 智能体访问控制（2026-10-22 P3 协作与团队功能）
 * 统一判定「谁能看 / 谁能编」——列表、详情、编排、对话、发布、分享全链路共用，
 * 修复存量漏洞：此前 PUT/DELETE/发布等接口无归属校验，任意登录用户可越权改动他人智能体。
 *
 * 权限模型：
 *  - 可见 canView：管理员 ∪ 创建者 ∪ 协作者（含草稿）∪ 已发布且（public 或 命中部门/成员名单）
 *                    ∪ 命中 agent_acls 授权（V2.4 #9 租户化）
 *  - 可编辑 canEdit：管理员 ∪ 创建者 ∪ 协作者（协作者不可改可见性与协作者名单，见 agents.js）
 *  - 删除/密钥等高危操作仅 管理员 ∪ 创建者（agents.js 内单独校验）
 */
const { db } = require('../db'); // V2.4 #9：引入 db 用于 agent_acls 表查询

function parseJsonArr(s) {
  if (Array.isArray(s)) return s; // 前端 fetch body 直接传数组（E2E 实测发现：JSON.parse(数组) 会静默失败成 []）
  if (typeof s === 'string') {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

/** 检查 agent_acls 表是否有匹配的 allow=1 授权 */
function hasAclAccess(a, user) {
  if (!a || !user) return false;
  // 拒绝规则优先：有明确 deny（allow=0）则拒绝访问
  const denies = db.prepare(`SELECT 1 FROM agent_acls WHERE agent_id=? AND allow=0 AND (grant_to='user' AND grant_to_value=? OR grant_to='dept' AND grant_to_value=? OR grant_to='role' AND grant_to_value=?) LIMIT 1`)
    .all(a.id, user.username, user.dept, user.role);
  if (denies.length) return false;
  // 查用户、部门、角色三路ACL，任一匹配即放行
  const rows = db.prepare(`SELECT allow FROM agent_acls WHERE agent_id=? AND allow=1 AND (grant_to='user' AND grant_to_value=? OR grant_to='dept' AND grant_to_value=? OR grant_to='role' AND grant_to_value=?) LIMIT 1`)
    .all(a.id, user.username, user.dept, user.role);
  if (rows.length && rows[0].allow === 1) return true;
  return null; // 未配置任何 ACL → 不置可否，由下游规则决定
}

/** 智能体对 user 是否可见 */
function canView(a, user) {
  if (!a || !user) return false;
  if (user.role === 'admin') return true;
  if (a.owner && a.owner === user.username) return true;
  if (parseJsonArr(a.collaborators).includes(user.username)) return true;
  if (a.status !== 'published') return false; // 草稿仅 owner/协作者/管理员可见
  // V2.4 #9 租户化：agent_acls 查询优先（deny 覆盖 public 等旧字段）
  const aclResult = hasAclAccess(a, user);
  if (aclResult !== null) return aclResult;
  if ((a.visibility || 'public') === 'public') return true;
  const members = parseJsonArr(a.visible_members);
  if (members.includes(user.username)) return true;
  const depts = parseJsonArr(a.visible_depts);
  if (depts.length) {
    // V1.2 #2 2026-10-30：visible_depts 双模式并列命中（OR）——
    // - ID 模式：名单含纯数字成员（departments 表 ID 字符串）→ 按 user.dept_id 匹配
    // - 文本模式：名单含非数字成员（部门文本名）→ 按 user.dept 文本匹配
    // - 混合名单：任一命中即可见（相比旧「every 判格式后二选一」只扩不缩：纯数字/纯文本
    //   名单行为完全不变，混合名单下 ID 或文本任一命中均放行——服务部门 ID 迁移过渡期）
    const hasId = depts.some(v => /^\d+$/.test(v));
    const hasText = depts.some(v => !/^\d+$/.test(v));
    const idHit = hasId && user.dept_id != null && depts.includes(String(user.dept_id));
    const textHit = hasText && !!user.dept && depts.includes(user.dept);
    if (idHit || textHit) return true;
  }
  return false;
}

/** user 是否可编辑该智能体（内容配置层面） */
function canEdit(a, user) {
  if (!a || !user) return false;
  if (user.role === 'admin') return true;
  if (a.owner && a.owner === user.username) return true;
  // V2.4 #9：可编辑也查一下 agent_acls（允许编辑的 ACL）
  if (parseJsonArr(a.collaborators).includes(user.username)) return true;
  const aclResult = hasAclAccess(a, user);
  if (aclResult === true) return true;
  return false;
}

/** 是否为归属级权限（可删/可改可见性/可管密钥）：管理员 ∪ 创建者 */
function isOwnerLevel(a, user) {
  if (!a || !user) return false;
  return user.role === 'admin' || (!!a.owner && a.owner === user.username);
}

module.exports = { parseJsonArr, canView, canEdit, isOwnerLevel };
