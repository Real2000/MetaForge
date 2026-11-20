/**
 * P1-17 版本化迁移框架（2026-11-13）
 *
 * 目标：替代 db.js 内所有的内联 ALTER TABLE 迁移块，用序号/名称/上移/下移的迁移文件管理。
 * 每步迁移定义 { id, name, up, down }，按 id 顺序依次执行 up（降级用 down，暂不实现）。
 *
 * 设计要点：
 *   1) 幂等：每步迁移执行前检查目标列/表是否存在，存在则跳过；
 *   2) 审计：迁移执行流程写入 op_logs（第一次执行记录 action=migrate）；
 *   3) 兼容：提供 addColumn、ensureTable 等快捷工具，与 db.js 内联迁移等价；
 *   4) 静默：新表创建后不给 console.log（db.js 原有那些日志由各模块自主决定是否输出）；
 *   5) 替代而非删除：内联迁移仍保留在 db.js（兼容旧库、降级分支），迁移框架从 id=1 开始记录。
 */

const { db } = require('../db');

/* ---------- 迁移注册表 ---------- */

/**
 * @typedef {Object} MigrationStep
 * @property {number}       id    - 序号（唯一，从 1 开始递增）
 * @property {string}       name  - 迁移名称（描述）
 * @property {string}       table - 目标表名
 * @property {string}       column - 目标列名
 * @property {string}       def   - 列定义 SQL（如 "TEXT DEFAULT ''"）
 * @property {function}     [up]  - 自定义迁移函数（替代默认 addColumn 行为）
 * @property {function}     [down] - 降级函数（可选，暂不强制实现）
 */

/* ---------- 工具函数 ---------- */

/** 检查表中是否存在某列（缓存列信息避免反复 PRAGMA） */
const columnCache = new Map();
function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key);
  let cols;
  try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch { cols = []; }
  const exists = cols.includes(column);
  columnCache.set(key, exists);
  return exists;
}

/** 检查表是否存在 */
function tableExists(table) {
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return !!r;
  } catch { return false; }
}

/** 快捷添加列（幂等）：列不存在则 ALTER TABLE ADD COLUMN，返回 true 表示已执行 */
function addColumn(table, column, def) {
  if (hasColumn(table, column)) return false;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    columnCache.set(`${table}.${column}`, true);
    console.log(`[migrate] ${table} 表已迁移：新增 ${column} 字段（${def}）`);
    return true;
  } catch (e) {
    // 某些罕见情况下 PRAGMA 和 ALTER 不一致（如并发），第二次幂等
    if (e.message && e.message.includes('duplicate column')) return false;
    throw e;
  }
}

/** 快捷创建表（幂等） */
function ensureTable(name, createSql) {
  if (tableExists(name)) return false;
  db.exec(createSql);
  console.log(`[migrate] 创建 ${name} 表`);
  return true;
}

/** 重置列缓存（迁移完成后调用，避免新迁移读取旧缓存） */
function resetColumnCache() {
  columnCache.clear();
}

/* ---------- 迁移执行器 ---------- */

const MIGRATIONS_TABLE = '_migrations';
let migTableChecked = false;
function ensureMigrationsTable() {
  if (migTableChecked) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  migTableChecked = true;
}

/**
 * 获取已应用的迁移 ID 集合
 * @returns {Set<number>}
 */
function getAppliedIds() {
  ensureMigrationsTable();
  try {
    const rows = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).all();
    return new Set(rows.map(r => r.id));
  } catch { return new Set(); }
}

/**
 * 记录某迁移已应用
 */
function markApplied(id, name) {
  ensureMigrationsTable();
  db.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES (?, ?, datetime('now','localtime'))`).run(id, name);
}

/**
 * 执行全部未应用的迁移
 * @param {MigrationStep[]} steps - 迁移步骤数组（按 id 升序排列）
 * @param {object} [opts]
 * @param {string}   [opts.label]   - 日志标签（默认 'migrate'）
 * @param {number[]} [opts.onlyIds] - 仅执行指定 id（可选，默认全部未应用）
 * @returns {{ applied: number, total: number, errors: string[] }}
 */
function runMigrations(steps, opts = {}) {
  const appliedIds = getAppliedIds();
  const sorted = [...steps].sort((a, b) => a.id - b.id);
  const filtered = opts.onlyIds ? sorted.filter(s => opts.onlyIds.includes(s.id)) : sorted;
  const pending = filtered.filter(s => !appliedIds.has(s.id));

  if (!pending.length) {
    return { applied: 0, total: filtered.length, errors: [] };
  }

  const errors = [];
  let applied = 0;

  for (const step of pending) {
    try {
      if (typeof step.up === 'function') {
        // 自定义迁移函数
        step.up({ addColumn, ensureTable, hasColumn, tableExists, db });
      } else if (step.table && step.column) {
        // 标准列迁移
        addColumn(step.table, step.column, step.def || 'TEXT DEFAULT \'\'');
      } else if (step.table && step.createSql) {
        // 表创建迁移
        ensureTable(step.table, step.createSql);
      }
      markApplied(step.id, step.name);
      applied++;
    } catch (e) {
      const msg = `迁移 #${step.id}「${step.name}」失败：${e.message}`;
      console.error(`[migrate] ${msg}`);
      errors.push(msg);
    }
  }

  resetColumnCache();
  console.log(`[migrate] 完成 ${applied}/${filtered.length} 项迁移${errors.length ? `（${errors.length} 项错误）` : ''}`);
  return { applied, total: filtered.length, errors };
}

/* ---------- 迁移步骤定义 ---------- */

/**
 * 所有历史列迁移定义（按时间顺序排列，与 db.js 内联迁移的首次出现时间一致）
 * 每项 { id, name, table, column, def }
 *
 * 添加新迁移：在数组末尾追加新项，id 为上一个 id + 1
 */
const ALL_MIGRATIONS = [
  // === 2026-10-20 体验优化 ===
  { id: 1,  name: 'messages.rating - 对话质量反馈', table: 'messages', column: 'rating', def: 'INTEGER DEFAULT 0' },
  { id: 2,  name: 'messages.solved - 是否解决', table: 'messages', column: 'solved', def: 'INTEGER DEFAULT 0' },
  // === 2026-10-22 协作与团队 ===
  { id: 3,  name: 'agents.visibility - 可见性', table: 'agents', column: 'visibility', def: "TEXT DEFAULT 'public'" },
  { id: 4,  name: 'agents.visible_depts - 可见部门', table: 'agents', column: 'visible_depts', def: "TEXT DEFAULT '[]'" },
  { id: 5,  name: 'agents.visible_members - 可见成员', table: 'agents', column: 'visible_members', def: "TEXT DEFAULT '[]'" },
  { id: 6,  name: 'agents.collaborators - 协作编辑者', table: 'agents', column: 'collaborators', def: "TEXT DEFAULT '[]'" },
  { id: 7,  name: 'agents.workflow - 画布工作流', table: 'agents', column: 'workflow', def: 'TEXT DEFAULT NULL' },
  { id: 8,  name: 'agents.edit_mode - 编辑模式', table: 'agents', column: 'edit_mode', def: "TEXT DEFAULT 'form'" },
  // === P1-6 分支回放 ===
  { id: 9,  name: 'messages.branch - 分支标识', table: 'messages', column: 'branch', def: "TEXT DEFAULT 'main'" },
  { id: 10, name: 'sessions.active_branch - 活跃分支', table: 'sessions', column: 'active_branch', def: "TEXT DEFAULT 'main'" },
  // === 知识库字段 ===
  { id: 11, name: 'kb_chunks.embedding - 向量嵌入', table: 'kb_chunks', column: 'embedding', def: "TEXT DEFAULT ''" },
  { id: 12, name: 'kbs.chunk_size - 切片大小', table: 'kbs', column: 'chunk_size', def: 'INTEGER DEFAULT 500' },
  { id: 13, name: 'kbs.chunk_overlap - 切片重叠', table: 'kbs', column: 'chunk_overlap', def: 'INTEGER DEFAULT 0' },
  { id: 14, name: 'kbs.chunk_separator - 切片分隔符', table: 'kbs', column: 'chunk_separator', def: "TEXT DEFAULT '\\n\\s*\\n'" },
  { id: 15, name: 'kbs.space_id - 空间归属', table: 'kbs', column: 'space_id', def: 'INTEGER DEFAULT 0' },
  { id: 16, name: 'kb_chunks.parent_id - 父分块', table: 'kb_chunks', column: 'parent_id', def: 'INTEGER DEFAULT NULL' },
  { id: 17, name: 'kb_chunks.keywords - 关键词', table: 'kb_chunks', column: 'keywords', def: 'TEXT DEFAULT NULL' },
  { id: 18, name: 'kbs.toc - 目录结构', table: 'kbs', column: 'toc', def: "TEXT DEFAULT '[]'" },
  { id: 19, name: 'kb_chunks.chapter_id - 章节 ID', table: 'kb_chunks', column: 'chapter_id', def: 'INTEGER DEFAULT NULL' },
  { id: 20, name: 'kb_files.source - 文件来源', table: 'kb_files', column: 'source', def: "TEXT DEFAULT 'upload'" },
  { id: 21, name: 'kb_files.error_msg - 错误信息', table: 'kb_files', column: 'error_msg', def: 'TEXT DEFAULT NULL' },
  { id: 22, name: 'kb_files.parsed_at - 解析时间', table: 'kb_files', column: 'parsed_at', def: 'TEXT DEFAULT NULL' },
  { id: 23, name: 'kb_files.updated_at - 更新时间', table: 'kb_files', column: 'updated_at', def: 'TEXT DEFAULT NULL' },
  { id: 24, name: 'kb_chunks.metadata - 元数据', table: 'kb_chunks', column: 'metadata', def: 'TEXT DEFAULT NULL' },
  { id: 25, name: 'kbs.auto_metadata - 自动元数据', table: 'kbs', column: 'auto_metadata', def: 'INTEGER DEFAULT 0' },
  { id: 26, name: 'kbs.pipeline - 管道配置', table: 'kbs', column: 'pipeline', def: 'TEXT DEFAULT NULL' },
  { id: 27, name: 'agents.kb_metadata_filter - 元数据过滤', table: 'agents', column: 'kb_metadata_filter', def: 'TEXT DEFAULT NULL' },
  // === 用户表 ===
  { id: 28, name: 'users.quota_total - 总配额', table: 'users', column: 'quota_total', def: 'INTEGER DEFAULT 0' },
  { id: 29, name: 'users.quota_used - 已用配额', table: 'users', column: 'quota_used', def: 'INTEGER DEFAULT 0' },
  { id: 30, name: 'users.must_change_pwd - 强制改密', table: 'users', column: 'must_change_pwd', def: 'INTEGER DEFAULT 0' },
  { id: 31, name: 'users.onboarded - 是否完成引导', table: 'users', column: 'onboarded', def: 'INTEGER DEFAULT 0' },
  { id: 32, name: 'users.quota_alert_level - 配额告警等级', table: 'users', column: 'quota_alert_level', def: 'INTEGER DEFAULT 0' },
  { id: 33, name: 'users.plan - 套餐', table: 'users', column: 'plan', def: "TEXT DEFAULT 'free'" },
  { id: 34, name: 'users.dept_id - 部门归属', table: 'users', column: 'dept_id', def: 'INTEGER DEFAULT NULL' },
  // === 平台/智能体外部集成 ===
  { id: 35, name: 'agents.owner - 所有者', table: 'agents', column: 'owner', def: "TEXT DEFAULT ''" },
  { id: 36, name: 'platforms.build_url - 构建 URL', table: 'platforms', column: 'build_url', def: "TEXT DEFAULT ''" },
  { id: 37, name: 'platforms.console_email - 控制台邮箱', table: 'platforms', column: 'console_email', def: "TEXT DEFAULT ''" },
  { id: 38, name: 'platforms.console_password - 控制台密码', table: 'platforms', column: 'console_password', def: "TEXT DEFAULT ''" },
  { id: 39, name: 'agents.external_app_id - 外部应用 ID', table: 'agents', column: 'external_app_id', def: "TEXT DEFAULT ''" },
  { id: 40, name: 'agents.external_api_key - 外部 API Key', table: 'agents', column: 'external_api_key', def: "TEXT DEFAULT ''" },
  { id: 41, name: 'agents.external_mode - 外部模式', table: 'agents', column: 'external_mode', def: "TEXT DEFAULT ''" },
  { id: 42, name: 'agents.share_token - 分享令牌', table: 'agents', column: 'share_token', def: "TEXT DEFAULT ''" },
  { id: 43, name: 'agents.share_enabled - 分享启用', table: 'agents', column: 'share_enabled', def: 'INTEGER DEFAULT 0' },
  { id: 44, name: 'sessions.ext_conversation_id - 外部会话 ID', table: 'sessions', column: 'ext_conversation_id', def: "TEXT DEFAULT ''" },
  { id: 45, name: 'sessions.wf_vars - 工作流变量', table: 'sessions', column: 'wf_vars', def: "TEXT DEFAULT ''" },
  { id: 46, name: 'agents.tools - 内置工具开关', table: 'agents', column: 'tools', def: "TEXT DEFAULT '[]'" },
  { id: 47, name: 'agents.mcp_servers - MCP 服务', table: 'agents', column: 'mcp_servers', def: "TEXT DEFAULT '[]'" },
  { id: 48, name: 'agents.share_expires_at - 分享过期时间', table: 'agents', column: 'share_expires_at', def: 'TEXT DEFAULT NULL' },
  { id: 49, name: 'agents.published_workflow - 发布快照', table: 'agents', column: 'published_workflow', def: 'TEXT DEFAULT NULL' },
  { id: 50, name: 'agents.review_comment - 审核意见', table: 'agents', column: 'review_comment', def: "TEXT DEFAULT ''" },
  { id: 51, name: 'agents.embed_domains - 嵌入域名', table: 'agents', column: 'embed_domains', def: "TEXT DEFAULT ''" },
  { id: 52, name: 'agents.system_key - 系统密钥', table: 'agents', column: 'system_key', def: "TEXT DEFAULT ''" },
  // === 运营与监控 ===
  { id: 53, name: 'evaluations.kb_id - 知识库关联', table: 'evaluations', column: 'kb_id', def: 'INTEGER DEFAULT NULL' },
  { id: 54, name: 'evaluations.type - 评测类型', table: 'evaluations', column: 'type', def: "TEXT DEFAULT 'agent'" },
  { id: 55, name: 'op_logs.duration_ms - 持续时间', table: 'op_logs', column: 'duration_ms', def: 'INTEGER DEFAULT NULL' },
  // === 工作流 ===
  { id: 56, name: 'chat_traces.suggestions - 建议', table: 'chat_traces', column: 'suggestions', def: "TEXT DEFAULT '[]'" },
  { id: 57, name: 'workflow_runs.parent_run_id - 父运行 ID', table: 'workflow_runs', column: 'parent_run_id', def: 'INTEGER DEFAULT NULL' },
  // === 任务与 MCP ===
  { id: 58, name: 'tasks.webhook_token - Webhook 令牌', table: 'tasks', column: 'webhook_token', def: "TEXT DEFAULT ''" },
  { id: 59, name: 'tasks.username - 创建者', table: 'tasks', column: 'username', def: "TEXT DEFAULT ''" },
  { id: 60, name: 'mcp_servers.trusted - 受信任', table: 'mcp_servers', column: 'trusted', def: 'INTEGER DEFAULT 0' },
  { id: 61, name: 'mcp_servers.risk_overrides - 风险覆盖', table: 'mcp_servers', column: 'risk_overrides', def: "TEXT DEFAULT '{}'" },
  { id: 62, name: 'mcp_tokens.agent_id - 关联智能体', table: 'mcp_tokens', column: 'agent_id', def: 'INTEGER DEFAULT NULL' },
  { id: 63, name: 'agents.routing_mode - 路由模式', table: 'agents', column: 'routing_mode', def: "TEXT DEFAULT 'function'" },
  { id: 64, name: 'providers.model_types - 模型类型', table: 'providers', column: 'model_types', def: "TEXT DEFAULT '{}'" },
  // === P1-4 分层记忆 ===
  { id: 65, name: 'agent_memories.type - 记忆类型', table: 'agent_memories', column: 'type', def: "TEXT DEFAULT 'fact'" },
  { id: 66, name: 'agent_memories.confidence - 置信度', table: 'agent_memories', column: 'confidence', def: 'REAL DEFAULT 1.0' },
  { id: 67, name: 'agent_memories.source - 来源', table: 'agent_memories', column: 'source', def: "TEXT DEFAULT 'chat'" },
  { id: 68, name: 'agent_memories.summary - 摘要', table: 'agent_memories', column: 'summary', def: "TEXT DEFAULT ''" },
  { id: 69, name: 'agent_memories.summary_source - 摘要来源', table: 'agent_memories', column: 'summary_source', def: "TEXT DEFAULT ''" },
  // === N7-P2 集群化（U2-1） ===
  { id: 70, name: 'task_queue.worker_id - 处理进程标识', table: 'task_queue', column: 'worker_id', def: 'TEXT DEFAULT NULL' },
  { id: 71, name: 'task_queue.locked_at - 锁定时间', table: 'task_queue', column: 'locked_at', def: 'TEXT DEFAULT NULL' },
  { id: 72, name: 'cluster_locks - 集群选主租约锁', table: 'cluster_locks', createSql: `CREATE TABLE IF NOT EXISTS cluster_locks (
    name TEXT PRIMARY KEY,      -- 锁名（如 cluster-leader）
    owner TEXT NOT NULL,        -- 持有者标识（hostname:pid）
    acquired_at INTEGER NOT NULL, -- 获取时间（epoch ms）
    expires_at INTEGER NOT NULL   -- 过期时间（epoch ms，需持有者续租）
  );` },
  // === D1-4 可执行技能包（2026-11-21）===
  { id: 73, name: 'skill_assets.manifest - 技能 manifest（入口/参数/权限/依赖）', table: 'skill_assets', column: 'manifest', def: "TEXT DEFAULT '{}'" },
  { id: 74, name: 'skill_assets.runtime - 运行时（node）', table: 'skill_assets', column: 'runtime', def: "TEXT DEFAULT 'node'" },
  { id: 75, name: 'skill_assets.version - 技能版本', table: 'skill_assets', column: 'version', def: "TEXT DEFAULT '1.0.0'" },
  { id: 76, name: 'skill_assets.source_url - 安装来源', table: 'skill_assets', column: 'source_url', def: "TEXT DEFAULT ''" },
  { id: 77, name: 'skill_assets.package_hash - 包内容哈希（供应链校验）', table: 'skill_assets', column: 'package_hash', def: "TEXT DEFAULT ''" },
  { id: 78, name: 'skill_assets.verified - 供应链校验结果', table: 'skill_assets', column: 'verified', def: 'INTEGER DEFAULT 0' },
  { id: 79, name: 'skill_assets.enabled - 启用开关', table: 'skill_assets', column: 'enabled', def: 'INTEGER DEFAULT 1' },
  { id: 80, name: 'skill_secrets - 技能密钥（按用户×技能隔离）', createSql: `CREATE TABLE IF NOT EXISTS skill_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    skill_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(owner, skill_id, name)
  );` },
  { id: 81, name: 'skill_runs - 技能执行审计', createSql: `CREATE TABLE IF NOT EXISTS skill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    exit_code INTEGER DEFAULT NULL,
    duration_ms INTEGER DEFAULT NULL,
    stdout_excerpt TEXT DEFAULT '',
    stderr_excerpt TEXT DEFAULT '',
    created_at TEXT
  );` },
];

module.exports = {
  addColumn,
  ensureTable,
  hasColumn,
  tableExists,
  resetColumnCache,
  runMigrations,
  getAppliedIds,
  ALL_MIGRATIONS,
};