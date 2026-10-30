/**
 * 智能体访问控制（2026-10-22 P3 协作与团队功能）
 * 统一判定「谁能看 / 谁能编」——列表、详情、编排、对话、发布、分享全链路共用，
 * 修复存量漏洞：此前 PUT/DELETE/发布等接口无归属校验，任意登录用户可越权改动他人智能体。
 *
 * 权限模型：
 *  - 可见 canView：管理员 ∪ 创建者 ∪ 协作者（含草稿）∪ 已发布且（public 或 命中部门/成员名单）
 *  - 可编辑 canEdit：管理员 ∪ 创建者 ∪ 协作者（协作者不可改可见性与协作者名单，见 agents.js）
 *  - 删除/密钥等高危操作仅 管理员 ∪ 创建者（agents.js 内单独校验）
 */

function parseJsonArr(s) {
  if (Array.isArray(s)) return s; // 前端 fetch body 直接传数组（E2E 实测发现：JSON.parse(数组) 会静默失败成 []）
  if (typeof s === 'string') {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

/** 智能体对 user 是否可见 */
function canView(a, user) {
  if (!a || !user) return false;
  if (user.role === 'admin') return true;
  if (a.owner && a.owner === user.username) return true;
  if (parseJsonArr(a.collaborators).includes(user.username)) return true;
  if (a.status !== 'published') return false; // 草稿仅 owner/协作者/管理员可见
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
  return parseJsonArr(a.collaborators).includes(user.username);
}

/** 是否为归属级权限（可删/可改可见性/可管密钥）：管理员 ∪ 创建者 */
function isOwnerLevel(a, user) {
  if (!a || !user) return false;
  return user.role === 'admin' || (!!a.owner && a.owner === user.username);
}

module.exports = { parseJsonArr, canView, canEdit, isOwnerLevel };
