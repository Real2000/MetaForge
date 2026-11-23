/**
 * MT-7（2026-11-23）PostgreSQL RLS 策略 —— 租户行级强制隔离（DB 层）
 *
 * 设计：
 *   · 每表一条 POLICY（USING 管读 + WITH CHECK 管写）：tenant_id = 会话变量 app.tenant_id；
 *   · current_setting(..., true) 缺省回退 0（平台基线租户）——单租户部署/未设上下文时
 *     行为与现状一致（tenant_id 默认 0），不阻断启动；
 *   · FORCE ROW LEVEL SECURITY：表 owner 也受控（RLS 默认对 owner 旁路——FORCE 后
 *     「DB 层强制隔离」的验收语义才成立，隔离不依赖应用层自觉）；
 *   · 应用时机：PG 模式启动时（db.js 接线后）由 applyRls() 幂等执行（POLICY IF NOT EXISTS 幂等）。
 *
 * PoC 范围：默认核心资源表（agents/kbs/sessions/messages/tasks——迁移 #122 已补齐 tenant_id 列）；
 * 可经 RLS_TABLES 环境变量扩展。全量 88 张租户表铺开属 MT-7 全量迁移范围。
 */
'use strict';

/** 默认启用 RLS 的核心资源表（租户隔离的关键路径验收对象） */
const DEFAULT_RLS_TABLES = ['agents', 'kbs', 'sessions', 'messages', 'tasks'];

/**
 * 生成单表 RLS 策略 SQL（幂等：重复执行安全）。
 * @param {string} table
 * @returns {string} 多语句 SQL 块
 */
function rlsPolicySql(table) {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${table};`,
    `CREATE POLICY tenant_isolation ON ${table}`,
    `  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '0')::int)`,
    `  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '0')::int);`,
    // 注：括号必须严格配平——WITH CHECK 曾多一个右括号导致 PG syntax error（PoC 首跑踩坑，
    // smoke 已加配平断言锚定；WITH CHECK 与 USING 同为单层组括号收尾）
  ].join('\n');
}

/**
 * 对核心表应用 RLS 策略（幂等）。
 * @param {object} db pg-bridge 的 db 兼容对象（exec 多语句）
 * @param {string[]} [tables] 表清单（缺省 DEFAULT_RLS_TABLES + RLS_TABLES 环境变量）
 */
function applyRls(db, tables) {
  const list = (tables && tables.length ? tables : DEFAULT_RLS_TABLES).concat(
    String(process.env.RLS_TABLES || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  for (const t of new Set(list)) {
    db.exec(rlsPolicySql(t));
  }
  return [...new Set(list)];
}

module.exports = { DEFAULT_RLS_TABLES, rlsPolicySql, applyRls };
