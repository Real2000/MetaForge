const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
/**
 * 空间工具（V2.4 #9 租户化 2026-10-31；2026-11-02 收尾；M1/MT-04 多租户重写 2026-11-22）
 * 统一的空间过滤函数，供 agents/knowledge/tasks 等资源路由复用，
 * 避免各处手写 SQL 片段导致过滤语义不一致。
 *
 * 空间语义（V2.4 #9 收尾后）：
 *   - space_id = 0 或 NULL → 无空间归属（在**本租户内**全员可见）
 *   - 企业空间（spaces.type='enterprise'）→ 本租户内共享
 *   - 个人/部门空间 → 空间 owner 或资源 owner 可见
 *
 * MT-04（2026-11-22）多租户「两段判定」：
 *   当调用方传入 opts.tenantId（多租户模式）时，在原有「空间过滤」之前**先做租户匹配**，
 *   任一缺失即拒绝（fail-closed）：
 *     ① 资源 tenant_id 必须等于 opts.tenantId（跨租户不可见）；
 *     ② 空间所属租户必须等于 opts.tenantId；
 *     ③ admin 不再零条件放行——仅在租户边界内放行（平台超管跨租户由 MT-03 中间件旁路 + 审计）。
 *   不传 opts（单租户私有化部署）时行为与改造前**完全一致**（零回归）。
 *
 * MT-05（2026-11-22）出口接线：提供 reqTenantOpt(req)，从 req.tenant 生成 opts，
 *   供各资源路由统一传入，避免各自判断租户模式。
 */

/** 获取当前用户拥有的个人空间 ID 列表（用于知识库/智能体创建时默认归属） */
function getMySpaceIds(db, username, opts = {}) {
  const enforce = opts.tenantId != null;
  const sql = `SELECT id FROM spaces WHERE type=? AND owner=?${enforce ? ' AND tenant_id=?' : ''}`;
  const args = enforce ? ['personal', username, opts.tenantId] : ['personal', username];
  const rows = dal.q(sql, [...args]);
  return rows.map(r => r.id);
}

/** 获取当前用户拥有的所有空间 ID 列表（可用于查看自己空间内的资源） */
function getOwnedSpaceIds(db, username, opts = {}) {
  const enforce = opts.tenantId != null;
  const sql = `SELECT id FROM spaces WHERE owner=?${enforce ? ' AND tenant_id=?' : ''}`;
  const args = enforce ? [username, opts.tenantId] : [username];
  const rows = dal.q(sql, [...args]);
  return rows.map(r => r.id);
}

/**
 * MT-05：从 Express 请求生成空间过滤 opts。
 * 单租户模式（req.tenant.single）→ 返回 {}（不启用租户边界，零回归）；
 * 多租户模式 → 返回 { tenantId }（启用租户硬边界）。
 * @param {object} req Express 请求（须已过 tenantContext 中间件）
 * @returns {{tenantId?:number}}
 */
function reqTenantOpt(req) {
  const t = req && req.tenant;
  if (!t || t.single) return {};
  const id = t.id;
  return (id != null && Number.isFinite(Number(id))) ? { tenantId: Number(id) } : {};
}

/**
 * 单行资源的空间可见性判定（JS 版，与 spaceFilterSql 的 SQL 语义严格一致）。
 * @param {object} db - better-sqlite3 实例
 * @param {number|string|null} spaceId - 资源的 space_id
 * @param {string} username - 当前用户名
 * @param {object} [opts] - { tenantId, resourceTenantId }；tenantId 非空即启用租户硬边界
 * @returns {boolean}
 */
function spaceVisibleTo(db, spaceId, username, opts = {}) {
  const enforce = opts.tenantId != null;
  // ① 租户硬边界：资源租户与请求租户不一致 → 拒绝（跨租户不可见）
  if (enforce && opts.resourceTenantId != null && Number(opts.resourceTenantId) !== Number(opts.tenantId)) return false;
  if (!spaceId) return true; // 无归属（0/NULL/''）→ 本租户内全员可见（租户边界由 ① 兜底）
  const sp = dal.getq('SELECT type, owner, tenant_id FROM spaces WHERE id=?', [spaceId]);
  // SEC-04（2026-11-22）：空间不存在（脏数据/已删空间）→ fail-closed 不可见，与 spaceFilterSql 的 SQL 语义对齐。
  if (!sp) return false;
  // ② 空间所属租户必须匹配
  if (enforce && sp.tenant_id != null && Number(sp.tenant_id) !== Number(opts.tenantId)) return false;
  if (sp.type === 'enterprise') return true; // 企业空间 → 本租户内共享
  return sp.owner === username; // 个人/部门空间 → 空间 owner 可见
}

/**
 * 统一的空间过滤条件生成（返回 SQL 片段和参数）。
 * @param {string} tableAlias - 表别名（如 'a' 对应 agents 表）
 * @param {object} user - req.user 用户对象
 * @param {object} [opts] - { tenantId }；非空即启用租户边界 + 取消 admin 零条件放行
 * @returns {{sqlStr:string, args:Array}} SQL 过滤条件（以 AND 开头）
 */
function spaceFilterSql(tableAlias, user, opts = {}) {
  const enforce = opts.tenantId != null;
  const tenantStr = enforce ? ` AND ${tableAlias}.tenant_id=?` : '';
  const tenantArgs = enforce ? [opts.tenantId] : [];
  if (!user) return { sqlStr: tenantStr, args: tenantArgs };
  // 单租户：admin 沿用零条件放行（回归不变）；多租户：admin 亦受租户边界约束
  if (user.role === 'admin' && !enforce) return { sqlStr: '', args: [] };
  if (user.role === 'admin' && enforce) return { sqlStr: tenantStr, args: tenantArgs };
  const sqlStr = `${tenantStr} AND (${tableAlias}.space_id IS NULL OR ${tableAlias}.space_id=0 OR ${tableAlias}.owner=? OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.id=${tableAlias}.space_id AND (sp.type='enterprise' OR sp.owner=?)))`;
  return { sqlStr, args: [...tenantArgs, user.username, user.username] };
}

/**
 * 统一的空间过滤函数（JS 执行时过滤，用于已查询的数据结果集过滤）。
 * @param {object[]} rows - 数据行数组
 * @param {object} user - req.user 用户对象
 * @param {object} db - better-sqlite3 实例
 * @param {string} spaceField - 空间 ID 字段名（默认 'space_id'）
 * @param {string} ownerField - 所有者字段名（默认 'owner'）
 * @param {object} [opts] - { tenantId }；非空即启用租户边界
 * @returns {object[]} 过滤后的行数组
 */
function filterBySpace(rows, user, db, spaceField = 'space_id', ownerField = 'owner', opts = {}) {
  const enforce = opts.tenantId != null;
  if (!user) return [];
  if (user.role === 'admin' && !enforce) return rows;
  return rows.filter(r => {
    // ① 租户硬边界
    if (enforce && r.tenant_id != null && Number(r.tenant_id) !== Number(opts.tenantId)) return false;
    const sid = r[spaceField];
    if (!sid) return true; // 无归属 → 本租户内全员可见
    return r[ownerField] === user.username || spaceVisibleTo(db, sid, user.username, opts);
  });
}

module.exports = { getMySpaceIds, getOwnedSpaceIds, spaceVisibleTo, spaceFilterSql, filterBySpace, reqTenantOpt };
