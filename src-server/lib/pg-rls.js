/**
 * MT-7（2026-11-23）PostgreSQL RLS 策略 —— 租户行级强制隔离（DB 层）
 *
 * PG-1 v2（2026-11-23，承接 D-5~D-8 拍板）：从 PoC 的 5 张核心表铺开为全量租户域——
 *   - 覆盖面 = TENANT_TABLES（lib/tenant-tables.js 权威清单，89 张）− PLATFORM_PLANE_EXCLUDE（平台平面表）；
 *   - 平面表不参与 RLS 的语义（PG-1 定稿，详见各表注释）：认证网关 / 审计 / 计费 / 消息广播 /
 *     开通前实体 / 外部回调 / 设备接入 / 分层配置（tenant_id=0=平台全局基线，对租户必须可见）。
 *     这些表保持应用层租户防线（MT-3/4/5/9/12 的过滤与授权），DB 层 RLS 兜底聚焦「租户内容资产」。
 *
 * 策略设计（每表一条 tenant_isolation）：
 *   · USING 管读 + WITH CHECK 管写：tenant_id = 会话变量 app.tenant_id（请求经 auth 中间件
 *     withTenant 注入——ALS 请求级上下文，async 恢复点不串租）；
 *   · 'platform' 逃逸值：平台平面运维/跨租户只读巡检等显式授权路径（bridge.withTenant('platform')）
 *     ——FORCE ROW LEVEL SECURITY 下 owner 也受控，逃逸值是唯一的跨租户显式通道，代码级 opt-in；
 *   · current_setting(..., true) 缺省回退 '0'（平台基线租户）——未设上下文的启动期/后台路径
 *     行为可预期（基线 0 行的可见性由分层配置类表的应用层语义管理，此类表已入排除清单）；
 *   · 表达式为 cast-safe：'platform' 经双重 NULLIF 归一后再参与 ::int 比较，OR 分支不会因
 *     非数字串触发转换错误（PoC 踩坑回归：策略 SQL 必须括号配平且类型安全，smoke 锚定）；
 *   · FORCE ROW LEVEL SECURITY：表 owner 也受控（RLS 默认对 owner 旁路——FORCE 后
 *     「DB 层强制隔离」的验收语义才成立，隔离不依赖应用层自觉）；
 *   · 应用时机：PG 模式启动时（db.js 建表/迁移完成后）由 applyRls() 幂等执行。
 */
'use strict';

const { TENANT_TABLES } = require('./tenant-tables');

/**
 * 平台平面表排除清单（PG-1 语义定稿）——不参与 RLS，租户防线保持应用层实现。
 * 判定原则：「平台平面表」= 由平台侧（超管/回调/后台任务）跨租户读写、写入者无租户会话、
 * 或采用 tenant_id=0 全局基线分层语义的表；「租户内容表」= 租户用户在会话内创建消费的资源。
 */
const PLATFORM_PLANE_EXCLUDE = [
  // 认证网关：JWT 校验先于租户上下文存在（auth.js verify 须跨租户解析用户身份）
  'users',
  // 审计平面：平台超管跨租户审计视图（op_logs 哈希链 + request_id 贯穿链）
  'op_logs',
  // 计费平面：MT-9 平台超管跨租户聚合报表 + billing-gate 后台配额判定
  'usage_records', 'billing_holds', 'invoices',
  // 消息平面：平台广播与后台任务的写入者无租户会话（notifications 面向全员下发）
  'notifications', 'notification_reads',
  // 开通前实体：租户会话尚未存在的销售线索/邀请注册（平台侧消费）
  'enterprise_leads', 'invite_registrations', 'invited_users',
  // 外部网关/回调平面：webhook 接收器无用户会话；订单由支付回调与平台运营跨租户处理
  'dingtalk_events', 'market_orders', 'channels', 'channel_messages', 'channel_bound_chats',
  // 设备接入平面：本地桥客户端心跳/任务由设备密钥驱动（无用户会话）
  'localbridge_devices', 'localbridge_tasks', 'localbridge_backups',
  // 平台资源池：沙箱池为平台侧调度资产
  'sandbox_pools',
  // 分层配置（MT-12）：tenant_id=0=平台全局基线，必须对全部租户可见（应用层实现分层），
  // 单租户匹配策略会误伤基线行——生产库实测唯一存在 0 层语义的表（1 行全局密钥）
  'secrets',
  // 共享模板库（PG-1 2026-11-24 复现踩坑）：内置模板（builtin=1）为平台全域共享资产，路由层
  // 刻意跨租户读（wf-templates/skills-market 均无租户过滤——use_count 全域累计的共享语义），
  // 且启动期幂等种子由平台写入（无租户会话）——与 secrets 同类的平面语义，防线在应用层
  'workflow_templates',
];

/** 单表 RLS 策略 SQL（幂等：DROP POLICY IF EXISTS + 重建）。
 *  括号必须配平（PG 解析器硬校验，smoke 锚定）；'platform' 逃逸分支 + 租户匹配分支均 cast-safe。
 *  PG-1 复现踩坑（2026-11-24）：双重 NULLIF 曾误写三参形态 NULLIF(x,'','platform')——PG 的 NULLIF
 *  仅收 2 参，多语句块整体解析失败 → ENABLE/FORCE/CREATE 全部未执行，且被 db.js 非致命 catch
 *  吞掉（策略数 0、RLS 完全失效，e2e 仅靠应用层隔离假绿）。正确形态为逐层 2 参嵌套：
 *  NULLIF(NULLIF(x,''),'platform')。 */
function rlsPolicySql(table) {
  const match = `tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.tenant_id', true), ''), 'platform'), '0')::int`;
  const escape = `current_setting('app.tenant_id', true) = 'platform'`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${table};`,
    `CREATE POLICY tenant_isolation ON ${table}`,
    `  USING (${escape} OR ${match})`,
    `  WITH CHECK (${escape} OR ${match});`,
  ].join('\n');
}

/**
 * 计算 RLS 覆盖表清单：TENANT_TABLES − 平面排除 ∩ 实际存在 tenant_id 列的表。
 * @param {object} db db 兼容对象（PG 桥走 information_schema；sqlite 直查 PRAGMA——本函数
 *   在 sqlite 下也可安全调用，用于清单一致性自检，但不产生任何 DDL 副作用）
 * @returns {string[]}
 */
function rlsTableList(db) {
  const excluded = new Set(PLATFORM_PLANE_EXCLUDE);
  const out = [];
  for (const t of TENANT_TABLES) {
    if (excluded.has(t)) continue;
    let hasCol = false;
    try {
      hasCol = !!db.prepare("SELECT 1 FROM information_schema.columns WHERE lower(table_name)=lower(?) AND column_name='tenant_id'").get(t);
    } catch {
      // sqlite（无 information_schema）：PRAGMA 探测
      try { hasCol = db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'tenant_id'); } catch { }
    }
    if (hasCol) out.push(t);
  }
  return out;
}

/**
 * 应用 RLS 策略（幂等）。仅 PG 模式调用（db.js 末尾）；sqlite 模式零执行零影响。
 * @param {object} db pg-bridge 的 db 兼容对象（exec 多语句）
 * @param {string[]} [tables] 缺省自动计算（rlsTableList）
 * @returns {string[]} 实际应用的表清单
 */
function applyRls(db, tables) {
  const list = (tables && tables.length ? tables : rlsTableList(db));
  for (const t of list) db.exec(rlsPolicySql(t));
  return list;
}

module.exports = { PLATFORM_PLANE_EXCLUDE, rlsPolicySql, rlsTableList, applyRls };
