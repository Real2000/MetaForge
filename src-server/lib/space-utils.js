/**
 * 空间工具（V2.4 #9 租户化 2026-10-31；2026-11-02 收尾：企业空间全员可见 + 存量回填配套）
 * 统一的空间过滤函数，供 agents/knowledge/tasks 等资源路由复用，
 * 避免各处手写 SQL 片段导致过滤语义不一致。
 *
 * 空间语义（V2.4 #9 收尾后）：
 *   - space_id = 0 或 NULL → 无空间归属，对所有用户可见
 *   - 企业空间（spaces.type='enterprise'）→ 企业共享，对所有用户可见
 *   - 个人/部门空间 → 空间 owner 或资源 owner 可见（部门成员名单待 members 表就绪后扩展）
 *   - 管理员不受空间过滤限制。
 */

/** 获取当前用户拥有的个人空间 ID 列表（用于知识库/智能体创建时默认归属） */
function getMySpaceIds(db, username) {
  // 空间类型 personal 表示个人空间
  const rows = db.prepare('SELECT id FROM spaces WHERE type=? AND owner=?').all('personal', username);
  return rows.map(r => r.id);
}

/** 获取当前用户拥有的所有空间 ID 列表（可用于查看自己空间内的资源） */
function getOwnedSpaceIds(db, username) {
  const rows = db.prepare('SELECT id FROM spaces WHERE owner=?').all(username);
  return rows.map(r => r.id);
}

/**
 * 单行资源的空间可见性判定（JS 版，与 spaceFilterSql 的 SQL 语义严格一致）。
 * knowledge 列表等已在内存中的结果集过滤复用本函数，避免语义分叉。
 * @param {object} db - better-sqlite3 实例
 * @param {number|string|null} spaceId - 资源的 space_id
 * @param {string} username - 当前用户名
 * @returns {boolean} 是否仅凭空间维度即放行（不含资源 owner 命中，调用方自行 OR）
 */
function spaceVisibleTo(db, spaceId, username) {
  if (!spaceId) return true; // 无归属（0/NULL/''）→ 全员可见
  const sp = db.prepare('SELECT type, owner FROM spaces WHERE id=?').get(spaceId);
  // SEC-04（2026-11-22 安全止血）：空间不存在（脏数据/已删空间）→ fail-closed 不可见。
  // 原实现 `return true`（宽容放行）与 spaceFilterSql 的 SQL 语义不一致：SQL 侧空间不存在即 EXISTS 为假、
  // 资源被排除；JS 侧却放行，造成内存过滤链路越权泄露。现改为与 SQL 对齐：无法确认空间归属即拒绝；
  // 资源 owner 命中的放行由调用方（filterBySpace）以 OR 方式补充。
  if (!sp) return false;
  if (sp.type === 'enterprise') return true; // 企业空间 → 企业共享，全员可见
  return sp.owner === username; // 个人/部门空间 → 空间 owner 可见（过渡逻辑，部门成员名单待 members 表）
}

/**
 * 统一的空间过滤条件生成（返回 SQL 片段和参数）
 * @param {string} tableAlias - 表别名（如 'a' 对应 agents 表，'k' 对应 kbs 表）
 * @param {object} user - req.user 用户对象
 * @returns {string} SQL 过滤条件（以 AND 开头，可直接拼接到 WHERE 后）
 *
 * 使用示例：
 *   let { sqlStr, args } = spaceFilterSql('a', req.user);
 *   sql += sqlStr;
 *   args.push(...args);
 */
function spaceFilterSql(tableAlias, user) {
  if (!user || user.role === 'admin') return { sqlStr: '', args: [] };
  // 与 spaceVisibleTo 同语义：无归属(0/NULL) OR 资源owner=我 OR 企业空间 OR 空间owner=我（V2.4 #9 收尾：企业空间全员可见）
  const sqlStr = ` AND (${tableAlias}.space_id IS NULL OR ${tableAlias}.space_id=0 OR ${tableAlias}.owner=? OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.id=${tableAlias}.space_id AND (sp.type='enterprise' OR sp.owner=?)))`;
  return { sqlStr, args: [user.username, user.username] };
}

/**
 * 统一的空间过滤函数（JS 执行时过滤，用于已查询的数据结果集过滤）
 * @param {object[]} rows - 数据行数组
 * @param {object} user - req.user 用户对象
 * @param {object} db - better-sqlite3 实例（查 spaces 表判定空间类型/owner；V2.4 #9 收尾新增）
 * @param {string} spaceField - 空间 ID 字段名（默认 'space_id'）
 * @param {string} ownerField - 所有者字段名（默认 'owner'）
 * @returns {object[]} 过滤后的行数组
 */
function filterBySpace(rows, user, db, spaceField = 'space_id', ownerField = 'owner') {
  if (!user || user.role === 'admin') return rows;
  return rows.filter(r => {
    const sid = r[spaceField];
    // space_id 为 0、null 或空字符串 → 对全员可见；企业空间 → 全员可见；其余 → 资源/空间 owner 可见
    if (!sid) return true;
    return r[ownerField] === user.username || spaceVisibleTo(db, sid, user.username);
  });
}

module.exports = { getMySpaceIds, getOwnedSpaceIds, spaceVisibleTo, spaceFilterSql, filterBySpace };
