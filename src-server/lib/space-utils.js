/**
 * 空间工具（V2.4 #9 租户化 2026-10-31）
 * 统一的空间过滤函数，供 agents/knowledge/tasks 等资源路由复用，
 * 避免各处手写 SQL 片段导致过滤语义不一致。
 *
 * 空间语义：space_id = 0 或 NULL 表示无空间归属（对所有用户可见）
 *           非 0 的 space_id 通过 owner 匹配做过渡过滤（ACL 就绪前）
 *           管理员不受空间过滤限制。
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
  // space_id IS NULL 或无空间归属（0）→ 全员可见；否则仅 owner 可见（过渡逻辑，ACL 就绪前）
  const sqlStr = ` AND (${tableAlias}.space_id IS NULL OR ${tableAlias}.space_id=0 OR ${tableAlias}.owner=?)`;
  return { sqlStr, args: [user.username] };
}

/**
 * 统一的空间过滤函数（JS 执行时过滤，用于已查询的数据结果集过滤）
 * @param {object[]} rows - 数据行数组
 * @param {object} user - req.user 用户对象
 * @param {string} spaceField - 空间 ID 字段名（默认 'space_id'）
 * @param {string} ownerField - 所有者字段名（默认 'owner'）
 * @returns {object[]} 过滤后的行数组
 */
function filterBySpace(rows, user, spaceField = 'space_id', ownerField = 'owner') {
  if (!user || user.role === 'admin') return rows;
  return rows.filter(r => {
    const sid = r[spaceField];
    // space_id 为 0、null 或空字符串 → 对全员可见
    if (!sid) return true;
    // 有空间归属 → 仅 owner 可见
    return r[ownerField] === user.username;
  });
}

module.exports = { getMySpaceIds, getOwnedSpaceIds, spaceFilterSql, filterBySpace };
