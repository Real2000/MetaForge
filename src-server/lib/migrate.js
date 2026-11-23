/**
 * P1-17 版本化迁移框架（2026-11-13）｜BE-E1 迁移单一化升级（2026-11-23）
 *
 * 目标：db.js 内联建表/加列的历史包袱冻结基线，此后 schema 演进只发生在这里。
 * 每步迁移定义 { id, name, up?, down? }，按 id 顺序依次执行 up；down 用于回滚。
 *
 * 设计要点：
 *   1) 幂等：每步迁移执行前检查目标列/表是否存在，存在则跳过；
 *   2) 审计：_migrations 台账记录已应用 id（首次执行时间）；
 *   3) 工具：addColumn/ensureTable/dropColumn 快捷函数；
 *   4) down（BE-E1）：列迁移默认回滚=DROP COLUMN（SQLite ≥ 3.35），表迁移=DROP TABLE，
 *      自定义 up 未提供 down 则标记不可回滚；revertMigrations 按逆序回滚、遇错即停；
 *   5) 锚点（BE-E1）：anchorSchema 记录全库结构指纹 + 应用版本；checkSchemaDrift 检测
 *      「绕过框架的结构漂移」——迁移台账未变但表结构变了（boot 时 warn，不阻塞）；
 *   6) 开关：AGENT_NO_AUTO_MIGRATE=1 时 db.js 跳过 boot 自动迁移与锚定（CLI down 专用，
 *      防止 require db 后自动 up 把刚回滚的步又加回来）。
 *
 * 背景（为什么 M4 列迁移要迁出 db.js）：M4 期间 AI-09 的 chat_traces.retrieval_trace 内联块
 * 写在建表语句之前，全新库单次启动时 ALTER 报 no such table 被吞，导致首次对话落库即抛
 * no such column、done 事件发不出（smoke 之所以没拦住，是 P2 HTTP 测试 spawn 子进程二次
 * boot 同一目录把列补上了）。迁移执行器在 db.js 全部建表之后运行，时序天然正确。
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

/** BE-C2（2026-11-23）：探测 API 方言化——SQLite 走 PRAGMA/sqlite_master（现状），
 * dm/kingbase 走 information_schema（信创库标准目录视图）。SQLite 分支与既有行为逐字节一致
 * （含 columnCache 语义）；information_schema 分支为 MT-7 驱动接线后生效的等价实现。 */
const PROBE_DIALECT = process.env.DB_DIALECT || 'sqlite';

/** 检查表中是否存在某列（缓存列信息避免反复探测） */
const columnCache = new Map();
function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key);
  let cols;
  if (PROBE_DIALECT === 'sqlite') {
    try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch { cols = []; }
  } else {
    // dm/kingbase：标准目录视图（表名参数化，与 PRAGMA 的防注入边界等价——information_schema 不接受标识符插值）
    try { cols = db.prepare('SELECT column_name AS name FROM information_schema.columns WHERE lower(table_name)=lower(?)').all(table).map(c => c.name); } catch { cols = []; }
  }
  const exists = cols.includes(column);
  columnCache.set(key, exists);
  return exists;
}

/** 检查表是否存在 */
function tableExists(table) {
  if (PROBE_DIALECT === 'sqlite') {
    try {
      const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      return !!r;
    } catch { return false; }
  }
  try {
    const r = db.prepare('SELECT 1 FROM information_schema.tables WHERE lower(table_name)=lower(?)').get(table);
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

/** 快捷删列（BE-E1 down 用，幂等）：列存在则 ALTER TABLE DROP COLUMN（需 SQLite ≥ 3.35），返回 true 表示已执行 */
function dropColumn(table, column) {
  if (!hasColumn(table, column)) return false;
  if (PROBE_DIALECT === 'sqlite') {
    // 版本门槛仅 SQLite 需要（ALTER DROP COLUMN 自 3.35 支持）；dm/kingbase 原生支持，直接执行
    const ver = String(db.prepare('select sqlite_version()').pluck().get());
    const [major, minor] = ver.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 35)) {
      throw new Error(`当前 SQLite ${ver} 不支持 DROP COLUMN（需 ≥ 3.35），无法回滚 ${table}.${column}`);
    }
  }
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  columnCache.set(`${table}.${column}`, false);
  console.log(`[migrate] ${table} 表已回滚：删除 ${column} 字段`);
  return true;
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

/** 从台账移除某迁移记录（BE-E1 down 回滚时用） */
function unmarkApplied(id) {
  ensureMigrationsTable();
  db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id=?`).run(id);
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

/* ---------- BE-E1 down 回滚执行器 ---------- */

/**
 * 按逆序回滚已应用迁移（遇错即停，保持结构一致：后续步可能依赖本步）
 * @param {MigrationStep[]} steps - 迁移步骤数组
 * @param {object} [opts]
 * @param {number}  [opts.to] - 回滚到该 id（保留该 id 及更早；默认仅回滚最新已应用的一步）
 * @returns {{ id:number, name:string, ok:boolean, error?:string }[]}
 */
function revertMigrations(steps, opts = {}) {
  const appliedIds = getAppliedIds();
  if (!appliedIds.size) return [];
  const desc = [...steps].sort((a, b) => b.id - a.id);
  const maxApplied = Math.max(...appliedIds);
  const to = Number.isFinite(opts.to) ? opts.to : maxApplied - 1;
  const results = [];
  for (const s of desc) {
    if (s.id <= to) break;
    if (!appliedIds.has(s.id)) continue;
    try {
      if (typeof s.down === 'function') {
        s.down({ db, dropColumn, addColumn, hasColumn, tableExists });
      } else if (s.table && s.column) {
        dropColumn(s.table, s.column);
      } else if (s.table && s.createSql) {
        db.exec(`DROP TABLE IF EXISTS ${s.table}`);
        console.log(`[migrate] 已回滚：删除 ${s.table} 表`);
      } else {
        throw new Error('自定义 up 迁移未定义 down，不可回滚（请补 down 或指定更早的 --to）');
      }
      unmarkApplied(s.id);
      results.push({ id: s.id, name: s.name, ok: true });
    } catch (e) {
      console.error(`[migrate] 回滚 #${s.id}「${s.name}」失败：${e.message}`);
      results.push({ id: s.id, name: s.name, ok: false, error: e.message });
      break;
    }
  }
  resetColumnCache();
  return results;
}

/* ---------- BE-E1 schema 锚点与漂移检测 ---------- */

const crypto = require('crypto');

/** DDL 归一化：压平空白，避免纯格式差异产生假漂移 */
function normalizeDdl(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * 全库结构指纹：sqlite_master 中全部 user 对象（表/索引/视图/触发器）的 DDL 归一化哈希。
 * 排除 _migrations（台账）与 schema_anchor（锚点自身），避免自指。任一对象 DDL 变化 → hash 变化。
 */
function computeSchemaFingerprint() {
  // MT-7（2026-11-23）PG 桥：sqlite_master 为 SQLite 专有（方言层登记差异）——非 sqlite 方言下
  // 结构指纹改用 information_schema（表 → 列名/类型/可空/默认值 归一化哈希；索引/触发器不在此
  // 指纹域——列级增删改已覆盖迁移语义的漂移检测需求，与 db-driver 探测 API 的登记替代一致）。
  // 锚点为「单库内」自比较（boot 间指纹一致即无漂移），跨方言域（sqlite↔PG）指纹不可比，无影响。
  if (PROBE_DIALECT !== 'sqlite') {
    const rows = db.prepare(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name NOT IN ('_migrations','schema_anchor')
      ORDER BY table_name, column_name`).all();
    const byTable = {};
    for (const r of rows) (byTable[r.table_name] = byTable[r.table_name] || [])
      .push(`${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default || ''}`);
    const perObject = {};
    for (const k of Object.keys(byTable)) perObject[`table:${k}`] = sha256(byTable[k].join('\n'));
    const hash = sha256(Object.keys(perObject).sort().map(k => k + '=' + perObject[k]).join('\n'));
    return { hash, perObject, objectCount: Object.keys(perObject).length };
  }
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL AND name NOT IN ('_migrations','schema_anchor')").all();
  const perObject = {};
  for (const r of rows) perObject[`${r.type}:${r.name}`] = sha256(normalizeDdl(r.sql));
  const hash = sha256(Object.keys(perObject).sort().map(k => k + '=' + perObject[k]).join('\n'));
  return { hash, perObject, objectCount: rows.length };
}

let anchorTableChecked = false;
function ensureAnchorTable() {
  if (anchorTableChecked) return;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_anchor (key TEXT PRIMARY KEY, value TEXT)`);
  anchorTableChecked = true;
}

/** 应用版本（锚点与发布绑定：BE-E1 验收「schema 版本号与发布绑定」） */
function appVersion() {
  try { return require('../../package.json').version || 'unknown'; } catch { return 'unknown'; }
}

/** 锚定当前结构（boot 迁移完成后调用）：写 schema_hash / per_object / app_version / anchored_at */
function anchorSchema() {
  ensureAnchorTable();
  const fp = computeSchemaFingerprint();
  const up = db.prepare('INSERT INTO schema_anchor (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  up.run('schema_hash', fp.hash);
  up.run('per_object', JSON.stringify(fp.perObject));
  up.run('app_version', appVersion());
  up.run('anchored_at', new Date().toISOString());
  return fp;
}

/**
 * 漂移检测：实际结构 vs 上次锚点。
 *   ok         —— 台账与实际结构一致（无绕过框架的改动）
 *   drift      —— 结构变了但台账没变（有人绕过框架 ALTER/建表），drifted 列出具体对象
 *   unanchored —— 首次启动（未锚定），boot 时应直接锚定不告警
 */
function checkSchemaDrift() {
  ensureAnchorTable();
  const get = k => { const r = db.prepare('SELECT value FROM schema_anchor WHERE key=?').get(k); return r ? r.value : null; };
  const anchoredHash = get('schema_hash');
  if (!anchoredHash) return { status: 'unanchored' };
  const fp = computeSchemaFingerprint();
  if (fp.hash === anchoredHash) return { status: 'ok', hash: fp.hash, appVersion: get('app_version'), anchoredAt: get('anchored_at') };
  let anchoredPer = {};
  try { anchoredPer = JSON.parse(get('per_object') || '{}'); } catch { }
  const drifted = [...new Set([...Object.keys(anchoredPer), ...Object.keys(fp.perObject)])]
    .filter(k => anchoredPer[k] !== fp.perObject[k]);
  return { status: 'drift', drifted, hash: fp.hash, anchoredHash };
}

/* ---------- 迁移步骤定义 ---------- */

/**
 * 所有历史列迁移定义（按时间顺序排列，与 db.js 内联迁移的首次出现时间一致）
 * 每项 { id, name, table, column, def }
 *
 * 添加新迁移：在数组末尾追加新项，id 为上一个 id + 1
 */
/**
 * M1 / MT-02 租户域表清单（权威来源：docs/tenant-scope.md §3.1）。
 * 单一数据源见 lib/tenant-tables.js（不依赖 db，供探针脚本安全共用，避免误触生产库）。
 */
const { TENANT_TABLES } = require('./tenant-tables');

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
  // === D2-1 代码索引与仓库语义检索（2026-11-21）===
  { id: 82, name: 'code_repos - 可检索代码仓库', createSql: `CREATE TABLE IF NOT EXISTS code_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'new',
    file_count INTEGER DEFAULT 0,
    symbol_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    error TEXT DEFAULT '',
    indexed_at TEXT,
    created_at TEXT
  );` },
  { id: 83, name: 'code_index - 函数/类切片索引', createSql: `CREATE TABLE IF NOT EXISTS code_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    file_path TEXT NOT NULL,
    lang TEXT DEFAULT 'text',
    chunk_kind TEXT DEFAULT 'block',
    symbol_name TEXT DEFAULT '',
    symbol_parent TEXT DEFAULT '',
    start_line INTEGER DEFAULT 0,
    end_line INTEGER DEFAULT 0,
    content TEXT DEFAULT '',
    embedding TEXT DEFAULT '',
    created_at TEXT
  );` },
  { id: 84, name: 'code_patches - 补丁提议/应用台账', createSql: `CREATE TABLE IF NOT EXISTS code_patches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    file_path TEXT NOT NULL,
    old_content TEXT DEFAULT '',
    new_content TEXT DEFAULT '',
    diff TEXT DEFAULT '',
    additions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,
    status TEXT DEFAULT 'proposed',
    created_at TEXT,
    applied_at TEXT
  );` },
  { id: 85, name: 'code_patch_backups - 补丁回滚备份', createSql: `CREATE TABLE IF NOT EXISTS code_patch_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    file_path TEXT NOT NULL,
    patch_id INTEGER DEFAULT NULL,
    content TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT
  );` },
  // === D2-2 计费用量感知闭环（2026-11-21）===
  { id: 86, name: 'billing_holds - 计费预检预留台账', createSql: `CREATE TABLE IF NOT EXISTS billing_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    model TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    est_tokens INTEGER DEFAULT 0,
    actual_tokens INTEGER DEFAULT 0,
    est_cost REAL DEFAULT 0,
    actual_cost REAL DEFAULT 0,
    status TEXT DEFAULT 'held',
    reason TEXT DEFAULT '',
    created_at TEXT,
    settled_at TEXT
  );` },
  { id: 87, name: 'users.cost_quota - 成本配额（元/月，0=不限）', table: 'users', column: 'cost_quota', def: 'REAL DEFAULT 0' },
  { id: 88, name: 'users.max_concurrency - 用户级并发上限（0=不限）', table: 'users', column: 'max_concurrency', def: 'INTEGER DEFAULT 0' },
  // === D2-4 MCP 与连接器广场（2026-11-21）===
  { id: 89, name: 'mcp_servers.catalog_id - 广场目录来源标识', table: 'mcp_servers', column: 'catalog_id', def: "TEXT DEFAULT ''" },
  { id: 90, name: 'mcp_servers.source - 来源（manual/catalog）', table: 'mcp_servers', column: 'source', def: "TEXT DEFAULT 'manual'" },
  { id: 91, name: 'mcp_servers.last_latency_ms - 最近连通耗时', table: 'mcp_servers', column: 'last_latency_ms', def: 'INTEGER DEFAULT 0' },
  { id: 92, name: 'mcp_servers.last_tool_count - 最近工具数', table: 'mcp_servers', column: 'last_tool_count', def: 'INTEGER DEFAULT 0' },
  { id: 93, name: 'mcp_servers.last_test_at - 最近测试时间', table: 'mcp_servers', column: 'last_test_at', def: "TEXT DEFAULT ''" },
  { id: 94, name: 'mcp_credentials - 连接器凭据托管', table: 'mcp_credentials', createSql: `CREATE TABLE IF NOT EXISTS mcp_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  );` },
  // === D2-3 桌面端升级通道（2026-11-21）===
  { id: 95, name: 'bridge_releases - 客户端发布清单', table: 'bridge_releases', createSql: `CREATE TABLE IF NOT EXISTS bridge_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL, platform TEXT DEFAULT 'any', arch TEXT DEFAULT 'any',
    channel TEXT DEFAULT 'stable', file_name TEXT DEFAULT '', sha256 TEXT DEFAULT '',
    size INTEGER DEFAULT 0, notes TEXT DEFAULT '', mandatory INTEGER DEFAULT 0,
    min_version TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT
  );` },
  { id: 96, name: 'bridge_updates - 客户端更新尝试台账', table: 'bridge_updates', createSql: `CREATE TABLE IF NOT EXISTS bridge_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER, username TEXT DEFAULT '', from_version TEXT DEFAULT '', to_version TEXT DEFAULT '',
    channel TEXT DEFAULT 'stable', status TEXT DEFAULT 'success', error TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0, created_at TEXT
  );` },
  { id: 97, name: 'bridge_crashes - 客户端崩溃上报', table: 'bridge_crashes', createSql: `CREATE TABLE IF NOT EXISTS bridge_crashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER, username TEXT DEFAULT '', version TEXT DEFAULT '', kind TEXT DEFAULT 'runtime',
    message TEXT DEFAULT '', stack TEXT DEFAULT '', created_at TEXT
  );` },
  // === D3-1 3D 与数字人 V1（2026-11-21）===
  { id: 98, name: 'model3d_tasks - 3D 资产生成任务台账', table: 'model3d_tasks', createSql: `CREATE TABLE IF NOT EXISTS model3d_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT DEFAULT '', project_id INTEGER DEFAULT NULL, prompt TEXT DEFAULT '', format TEXT DEFAULT '',
    status TEXT DEFAULT 'queued', model TEXT DEFAULT '', provider TEXT DEFAULT '', url TEXT DEFAULT '',
    thumb TEXT DEFAULT '', asset_id INTEGER DEFAULT NULL, error TEXT DEFAULT '', duration_ms INTEGER DEFAULT 0,
    meta TEXT DEFAULT '{}', created_at TEXT, finished_at TEXT
  );` },
  { id: 99, name: 'asset_exports - 3D 资产导出记录', table: 'asset_exports', createSql: `CREATE TABLE IF NOT EXISTS asset_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER, username TEXT DEFAULT '', source_format TEXT DEFAULT '', target_format TEXT DEFAULT '',
    need_convert INTEGER DEFAULT 0, status TEXT DEFAULT 'done', url TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT
  );` },
  { id: 100, name: 'dh_assessments - 数字人合规评估记录', table: 'dh_assessments', createSql: `CREATE TABLE IF NOT EXISTS dh_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER DEFAULT NULL, project_id INTEGER DEFAULT NULL, username TEXT DEFAULT '',
    answers TEXT DEFAULT '{}', score INTEGER DEFAULT 0, level TEXT DEFAULT 'low', decision TEXT DEFAULT 'approve',
    reasons TEXT DEFAULT '[]', note TEXT DEFAULT '', created_at TEXT
  );` },
  // === D3-2 经验自进化 V1（2026-11-21）===
  { id: 101, name: 'agent_experience - 专家×任务类型可靠度聚合', table: 'agent_experience', createSql: `CREATE TABLE IF NOT EXISTS agent_experience (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL, task_type TEXT NOT NULL,
    runs INTEGER DEFAULT 0, success INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
    first_runs INTEGER DEFAULT 0, first_success INTEGER DEFAULT 0,
    repeat_runs INTEGER DEFAULT 0, repeat_success INTEGER DEFAULT 0,
    total_duration_ms INTEGER DEFAULT 0, last_status TEXT DEFAULT '', last_at TEXT, updated_at TEXT
  );` },
  // === D3-3 沙箱池 V1（2026-11-21）===
  { id: 102, name: 'sandbox_runs.tenant - 沙箱池租户', table: 'sandbox_runs', column: 'tenant', def: "TEXT DEFAULT ''" },
  { id: 103, name: 'sandbox_runs.pool_hit - 是否命中预热进程', table: 'sandbox_runs', column: 'pool_hit', def: 'INTEGER DEFAULT 0' },
  { id: 104, name: 'sandbox_runs.cold_start_ms - 冷启动耗时', table: 'sandbox_runs', column: 'cold_start_ms', def: 'INTEGER DEFAULT NULL' },
  { id: 105, name: 'sandbox_pools - 沙箱池租户配额', table: 'sandbox_pools', createSql: `CREATE TABLE IF NOT EXISTS sandbox_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL, max_concurrent INTEGER DEFAULT 2, max_idle INTEGER DEFAULT 1,
    warm_size INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
    created_by TEXT DEFAULT '', created_at TEXT, updated_at TEXT
  );` },
  { id: 106, name: 'sandbox_snapshots - 沙箱池快照', table: 'sandbox_snapshots', createSql: `CREATE TABLE IF NOT EXISTS sandbox_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, source_dir TEXT DEFAULT '', snapshot_path TEXT DEFAULT '',
    node_version TEXT DEFAULT '', prelude_hash TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
    active INTEGER DEFAULT 0, created_by TEXT DEFAULT '', created_at TEXT
  );` },
  // === D3-4 评测体系 V1（2026-11-21）===
  { id: 107, name: 'eval_baselines - 发布基线（成功率/步数/干预率可对比）', table: 'eval_baselines', createSql: `CREATE TABLE IF NOT EXISTS eval_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suite TEXT NOT NULL, suite_type TEXT DEFAULT 'agent', ref_id INTEGER DEFAULT NULL,
    label TEXT DEFAULT '', agent_version INTEGER DEFAULT NULL,
    total INTEGER DEFAULT 0, passed INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 0, avg_steps REAL DEFAULT 0, intervention_rate REAL DEFAULT 0,
    meets_success INTEGER DEFAULT 0, meets_intervention INTEGER DEFAULT 0,
    cases TEXT DEFAULT '[]', created_by TEXT DEFAULT '', created_at TEXT
  );` },

  { id: 108, name: 'eval_baselines.intervened - 需人工介入用例数（显著性检验原始计数）', table: 'eval_baselines', column: 'intervened', def: 'INTEGER DEFAULT 0' },

  // === M1 / MT-02 多租户隔离底座（2026-11-22）===
  // 权威范围：docs/tenant-scope.md §3.1 TENANT 清单。SHARED / INFRA 表不加 tenant_id。
  { id: 109, name: 'tenants - 租户一等实体 + 默认租户 id=1', up: (ctx) => {
    ctx.ensureTable('tenants', `CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      plan TEXT DEFAULT 'free',
      parent_tenant_id INTEGER DEFAULT NULL,
      created_at TEXT
    );`);
    const c = ctx.db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c;
    if (!c) {
      ctx.db.prepare("INSERT INTO tenants (id,name,status,plan,created_at) VALUES (1,'默认租户','active','enterprise',datetime('now','localtime'))").run();
    }
  } },
  { id: 110, name: '租户域表新增 tenant_id（INTEGER DEFAULT 1）', up: (ctx) => {
    let n = 0;
    for (const tbl of TENANT_TABLES) {
      if (!ctx.tableExists(tbl)) continue;
      if (ctx.addColumn(tbl, 'tenant_id', 'INTEGER DEFAULT 1')) n++;
    }
    if (n) console.log(`[migrate] 租户域表 tenant_id 已补齐 ${n} 张`);
  } },
  { id: 111, name: '租户域表存量回填 tenant_id=1', up: (ctx) => {
    for (const tbl of TENANT_TABLES) {
      if (!ctx.tableExists(tbl)) continue;
      try { ctx.db.prepare(`UPDATE ${tbl} SET tenant_id=1 WHERE tenant_id IS NULL`).run(); } catch (e) { /* 忽略无 tenant_id 的表 */ }
    }
  } },
  { id: 112, name: 'spaces.owner 昵称归一化为 username', up: (ctx) => {
    // 依据 users 的 nickname→username 映射，将 spaces.owner 中的昵称改写为用户名。
    // 若某昵称与任何用户名冲突，跳过以避免误改；已是用户名的值不变。
     const users = ctx.db.prepare('SELECT username, nickname FROM users').all();
    const usernames = new Set(users.map(u => u.username));
    let n = 0;
    for (const u of users) {
      if (!u.nickname || usernames.has(u.nickname)) continue;
      n += ctx.db.prepare('UPDATE spaces SET owner=? WHERE owner=?').run(u.username, u.nickname).changes;
    }
    if (n) console.log(`[migrate] spaces.owner 昵称归一化 ${n} 行`);
  } },
  // MT-08（2026-11-22）：账号/角色分层——新增平台超管标记列。
  //   platform_admin=1 → 平台超管（全局免隔离，可跨租户运维）；role='admin' 且非平台超管 → 租户管理员（域内）。
  //   回填：AGENT_PLATFORM_ADMINS 清单（默认 admin）中且当前为 admin 的账号标为平台超管。
  { id: 113, name: 'users.platform_admin - 平台超管标记（MT-08）', up: (ctx) => {
    ctx.addColumn('users', 'platform_admin', 'INTEGER DEFAULT 0');
    const names = String(process.env.AGENT_PLATFORM_ADMINS || 'admin').split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length) return;
    const ph = names.map(() => '?').join(',');
    const n = ctx.db.prepare(`UPDATE users SET platform_admin=1 WHERE role='admin' AND username IN (${ph}) AND COALESCE(platform_admin,0)=0`).run(...names).changes;
    if (n) console.log(`[migrate] 平台超管标记回填 ${n} 个账号`);
  } },
  // MT-10（2026-11-22）：租户表补运营字段——开通时记录首个管理员与备注，便于运维台回显。
  { id: 114, name: 'tenants 补 admin_username/note（MT-10）', up: (ctx) => {
    ctx.addColumn('tenants', 'admin_username', "TEXT DEFAULT ''");
    ctx.addColumn('tenants', 'note', "TEXT DEFAULT ''");
  } },
  // === M2 / MT-12 租户级模型·密钥·配置隔离（2026-11-22）===
  // providers 由 SHARED 升级为「平台全局基线 + 租户覆盖层」：tenant_id=0 平台全局（全租户可见），>0 租户专有。
  { id: 115, name: 'providers.tenant_id - 供应商租户覆盖层（MT-12）', up: (ctx) => {
    ctx.addColumn('providers', 'tenant_id', 'INTEGER DEFAULT 0');
    // 存量供应商视为平台全局基线（0）
    try { ctx.db.prepare('UPDATE providers SET tenant_id=0 WHERE tenant_id IS NULL').run(); } catch { }
    // 默认唯一索引改为「按租户唯一」：每个租户可有各自默认供应商（全局与各租户互不干扰）
    try { ctx.db.exec('DROP INDEX IF EXISTS idx_providers_single_default'); } catch { }
    try { ctx.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_tenant_default ON providers(tenant_id, is_default) WHERE is_default=1'); } catch { }
  } },
  // secrets 唯一键由全局 name 改为 (name, tenant_id)：同一密钥名可在不同租户各自定义；存量键归平台全局（0）。
  { id: 116, name: 'secrets 租户隔离：唯一键改 (name,tenant_id)（MT-12）', up: (ctx) => {
    if (!ctx.tableExists('secrets')) return;
    // MT-7（2026-11-23）PG 桥兼容：sqlite_master/PRAGMA 为 SQLite 专有（方言层登记差异），
    // PG 系下查询即报错——try/catch 探测后走目录视图分支：唯一约束存在性查 information_schema，
    // 缺失时以唯一索引补齐（等价约束语义；重建表搬运法是 SQLite 无 ALTER 约束能力的专用路径，PG 不需要）。
    // sqlite 分支（ddl 非空）逐字节保持原路径——生产零回归。
    let ddl = '';
    try {
      ddl = ctx.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='secrets'").pluck().get() || '';
    } catch { /* PG/kingbase：无 sqlite_master——走下方目录视图分支 */ }
    if (!ddl) {
      const hasU = ctx.db.prepare("SELECT 1 FROM information_schema.table_constraints WHERE table_name='secrets' AND constraint_type='UNIQUE'").get();
      if (hasU) return; // 全新建表 DDL 已含 UNIQUE(name,tenant_id)（db.js 现行定义），幂等跳过
      ctx.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_name_tenant ON secrets(name, tenant_id)');
      console.log('[migrate] secrets 已补唯一索引 (name,tenant_id)（PG 模式：目录视图核验，索引兜底等价约束）');
      return;
    }
    if (/UNIQUE\s*\(\s*name\s*,\s*tenant_id\s*\)/i.test(ddl)) return; // 已重建，幂等跳过
    const cols = ctx.db.prepare('PRAGMA table_info(secrets)').all().map(c => c.name);
    const hasTenant = cols.includes('tenant_id');
    ctx.db.exec(`CREATE TABLE secrets__mt12 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      remark TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      tenant_id INTEGER DEFAULT 0,
      UNIQUE(name, tenant_id)
    );`);
    // 存量密钥一律归平台全局基线（0）——它们此前均为平台级基础设施密钥（ENCRYPTION_KEY 等）
    const tenantExpr = hasTenant ? '0' : '0';
    ctx.db.exec(`INSERT INTO secrets__mt12 (id,name,value,remark,created_at,updated_at,tenant_id)
      SELECT id,name,value,remark,created_at,updated_at, ${tenantExpr} FROM secrets;`);
    ctx.db.exec('DROP TABLE secrets;');
    ctx.db.exec('ALTER TABLE secrets__mt12 RENAME TO secrets;');
    console.log('[migrate] secrets 表已重建：(name,tenant_id) 复合唯一，存量归平台全局（tenant_id=0）');
  } },
  // === M2 / MT-13 支付/订阅闭环（2026-11-22）===
  { id: 117, name: 'tenant_wallets - 租户钱包（MT-13）', table: 'tenant_wallets', createSql: `CREATE TABLE IF NOT EXISTS tenant_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER UNIQUE,
    balance REAL DEFAULT 0,
    currency TEXT DEFAULT 'CNY',
    updated_at TEXT,
    created_at TEXT
  );` },
  { id: 118, name: 'tenant_subscriptions - 租户订阅（MT-13）', table: 'tenant_subscriptions', createSql: `CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    plan_key TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    period_start TEXT,
    period_end TEXT,
    quota_grant INTEGER DEFAULT 0,
    price REAL DEFAULT 0,
    auto_renew INTEGER DEFAULT 0,
    order_no TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  );` },
  { id: 119, name: 'payment_orders - 支付订单（MT-13）', table: 'payment_orders', createSql: `CREATE TABLE IF NOT EXISTS payment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE,
    tenant_id INTEGER,
    type TEXT DEFAULT 'subscribe',
    plan_key TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    channel TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    operator TEXT DEFAULT '',
    paid_at TEXT,
    refunded_at TEXT,
    meta TEXT DEFAULT '{}',
    created_at TEXT
  );` },
  { id: 120, name: 'payment_events - 支付回调事件台账（MT-13 幂等）', table: 'payment_events', createSql: `CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    order_no TEXT,
    channel TEXT DEFAULT '',
    type TEXT DEFAULT 'paid',
    amount REAL DEFAULT 0,
    raw TEXT DEFAULT '',
    created_at TEXT
  );` },
  // === M2 / BE-B3 对外限流与配额（2026-11-22）===
  { id: 121, name: 'rate_limit_counters - 共享限流/配额计数（BE-B3 多实例）', table: 'rate_limit_counters', createSql: `CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    reset_at INTEGER,
    updated_at TEXT
  );` },
  { id: 122, name: 'agent_api_keys 日/月配额（BE-B3）', table: 'agent_api_keys', column: 'quota_daily', def: 'INTEGER DEFAULT 0' },
  { id: 123, name: 'agent_api_keys.quota_monthly（BE-B3）', table: 'agent_api_keys', column: 'quota_monthly', def: 'INTEGER DEFAULT 0' },
  // === M4 检索质量战役（2026-11-23）—— BE-E1 迁出 db.js 内联块，schema 演进单一化 ===
  // 这批列原以内联块写在 db.js（AI-09/AI-03/AI-05），其中 chat_traces.retrieval_trace 的内联块
  // 位置早于建表语句导致全新库单次启动时丢失（详见文件头注释）。迁出后由本注册表唯一维护。
  { id: 124, name: 'kbs.rerank_enabled - 库级重排开关（M4 AI-09）', table: 'kbs', column: 'rerank_enabled', def: 'INTEGER DEFAULT NULL' },
  { id: 125, name: 'kbs.rerank_model - 库级重排模型（M4 AI-09）', table: 'kbs', column: 'rerank_model', def: "TEXT DEFAULT ''" },
  { id: 126, name: 'kbs.rerank_top_n - 库级精排输出条数（M4 AI-09）', table: 'kbs', column: 'rerank_top_n', def: 'INTEGER DEFAULT NULL' },
  { id: 127, name: 'kbs.rerank_threshold - 库级重排分数阈值（M4 AI-09）', table: 'kbs', column: 'rerank_threshold', def: 'REAL DEFAULT NULL' },
  { id: 128, name: 'chat_traces.retrieval_trace - 检索全链路诊断 JSON（M4 AI-09/AI-13）', table: 'chat_traces', column: 'retrieval_trace', def: "TEXT DEFAULT '[]'" },
  { id: 129, name: 'evaluations.metrics - 评测多指标聚合 JSON（M4 AI-03）', table: 'evaluations', column: 'metrics', def: 'TEXT DEFAULT NULL' },
  { id: 130, name: 'agent_memories.embedding - 记忆语义向量缓存 BLOB（M4 AI-05）', table: 'agent_memories', column: 'embedding', def: 'BLOB DEFAULT NULL' },
  { id: 131, name: 'agent_memories.last_used_at - 召回时间衰减基点（M4 AI-05）', table: 'agent_memories', column: 'last_used_at', def: 'TEXT DEFAULT NULL' },
  // === D-3（2026-11-23 拍板：需要全域模式）agent_api_keys 支持 agent_id=NULL（全域 Key）===
  // 背景：M0/SEC-02a 时代「无绑定 Key」曾被判死代码移除（当时 D-3 未拍板、生产库 0 行）；拍板后恢复全域语义
  // 并补齐归属防线：全域 Key（agent_id NULL）可访问同租户全部已发布智能体（openapi.js authKeyForAgent 校验）。
  // SQLite 无法 ALTER 列移除 NOT NULL → 重建表法；存量绑定行归属回填（继承其 agent 的 owner/租户）。
  { id: 132, name: 'agent_api_keys 全域 Key：agent_id 可空 + owner_username/tenant_id 归属（D-3 拍板）',
    up: ({ db }) => {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_api_keys__d3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER DEFAULT NULL,
        key TEXT UNIQUE NOT NULL,
        key_prefix TEXT DEFAULT '',
        name TEXT DEFAULT '',
        status INTEGER DEFAULT 1,
        quota_daily INTEGER DEFAULT 0,
        quota_monthly INTEGER DEFAULT 0,
        owner_username TEXT DEFAULT '',
        tenant_id INTEGER DEFAULT 1,
        created_at TEXT,
        last_used_at TEXT
      )`);
      db.exec(`INSERT INTO agent_api_keys__d3 (id, agent_id, key, key_prefix, name, status, quota_daily, quota_monthly, owner_username, tenant_id, created_at, last_used_at)
        SELECT k.id, k.agent_id, k.key, k.key_prefix, k.name, k.status, IFNULL(k.quota_daily,0), IFNULL(k.quota_monthly,0),
               IFNULL(a.owner, ''), IFNULL(a.tenant_id, 1), k.created_at, k.last_used_at
        FROM agent_api_keys k LEFT JOIN agents a ON a.id = k.agent_id`);
      db.exec('DROP TABLE agent_api_keys');
      db.exec('ALTER TABLE agent_api_keys__d3 RENAME TO agent_api_keys');
      console.log('[migrate] agent_api_keys 已重建：agent_id 可空（D-3 全域 Key）+ owner_username/tenant_id 归属列');
    },
    down: ({ db }) => {
      // 回滚：全域行不可降级保留（旧 schema 无归属语义，fail-closed 清理），绑定行原样迁回
      db.exec(`CREATE TABLE IF NOT EXISTS agent_api_keys__old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        key TEXT UNIQUE NOT NULL,
        key_prefix TEXT DEFAULT '',
        name TEXT DEFAULT '',
        status INTEGER DEFAULT 1,
        quota_daily INTEGER DEFAULT 0,
        quota_monthly INTEGER DEFAULT 0,
        created_at TEXT,
        last_used_at TEXT
      )`);
      db.exec(`INSERT INTO agent_api_keys__old (id, agent_id, key, key_prefix, name, status, quota_daily, quota_monthly, created_at, last_used_at)
        SELECT id, agent_id, key, key_prefix, name, status, quota_daily, quota_monthly, created_at, last_used_at
        FROM agent_api_keys WHERE agent_id IS NOT NULL`);
      db.exec('DROP TABLE agent_api_keys');
      db.exec('ALTER TABLE agent_api_keys__old RENAME TO agent_api_keys');
      console.log('[migrate] agent_api_keys 已回滚：恢复 agent_id NOT NULL（全域行已清理）');
    } },
  // === BE-F1（2026-11-23）请求日志 + 结构化可观测：requestId 贯穿日志链 ===
  // access_logs 为每请求骨架行；op_logs/err_logs/security_events 加 request_id 关联列
  // （audit.js 拦截器自动补值；request_id 不参与 SEC-11 哈希链——写入端/校验端同步排除，旧行校验不受影响）。
  { id: 133, name: 'access_logs 请求日志表（BE-F1）', table: 'access_logs', createSql: `CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT DEFAULT '',
    method TEXT DEFAULT '',
    path TEXT DEFAULT '',
    status INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    username TEXT DEFAULT '',
    tenant_id INTEGER DEFAULT 1,
    ip TEXT DEFAULT '',
    created_at TEXT
  )` },
  { id: 134, name: 'op_logs.request_id - 审计关联请求（BE-F1，不参与哈希链）', table: 'op_logs', column: 'request_id', def: "TEXT DEFAULT ''" },
  { id: 135, name: 'err_logs.request_id - 错误关联请求（BE-F1）', table: 'err_logs', column: 'request_id', def: "TEXT DEFAULT ''" },
  { id: 136, name: 'security_events.request_id - 安全事件关联请求（BE-F1，不参与哈希链）', table: 'security_events', column: 'request_id', def: "TEXT DEFAULT ''" },
  // === AI-10（2026-11-23）多路查询 + HyDE：库级开关（默认关，控成本） ===
  // 0=关闭（默认，行为与历史一致）；1=多路查询（3~5 子查询各路检索跨路 RRF 融合）；2=多路 + HyDE 假设答案向量路。
  { id: 137, name: 'kbs.multi_query - 库级多路查询/HyDE 开关（AI-10，默认关）', table: 'kbs', column: 'multi_query', def: 'INTEGER DEFAULT 0' },
  // === AI-14（2026-11-23）查询感知元数据过滤：库级开关（默认关） ===
  // 开启后 LLM 从查询推断过滤条件（值域约束 fail-closed：域外键值丢弃；与静态声明交集、静态优先）。
  { id: 138, name: 'kbs.infer_metadata_filter - 库级查询感知过滤开关（AI-14，默认关）', table: 'kbs', column: 'infer_metadata_filter', def: 'INTEGER DEFAULT 0' },
  // === AI-11（2026-11-23）多模态向量检索：分块模态标记 ===
  // 'text'（默认，存量行自动归一）/ 'image'（图片文件经 VL 描述分块化的行）——文搜图命中可标识来源（🖼️），
  // 图搜图端点可限定检索域；图片内容以 VL 描述文本嵌入（多模态嵌入模型就位前的务实路径，见 retriever 注释）。
  { id: 139, name: 'kb_chunks.modality - 分块模态标记（AI-11，text/image）', table: 'kb_chunks', column: 'modality', def: "TEXT DEFAULT 'text'" },
  // === AI-12（2026-11-23）提示词多版本效果对比：对比报告存档（离线跑分结果，导出端点数据源） ===
  { id: 140, name: 'prompt_compare_reports 提示词版本对比报告表（AI-12）', table: 'prompt_compare_reports', createSql: `CREATE TABLE IF NOT EXISTS prompt_compare_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    evaluation_id INTEGER,
    report TEXT DEFAULT '{}',
    created_at TEXT
  )` },
];

module.exports = {
  addColumn,
  ensureTable,
  dropColumn,
  hasColumn,
  tableExists,
  resetColumnCache,
  runMigrations,
  revertMigrations,
  getAppliedIds,
  markApplied,
  unmarkApplied,
  computeSchemaFingerprint,
  anchorSchema,
  checkSchemaDrift,
  appVersion,
  ALL_MIGRATIONS,
  TENANT_TABLES,
};