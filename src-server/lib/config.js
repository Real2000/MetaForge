/**
 * P1-20 配置中心（2026-11-13）
 *
 * 统一管理平台运行时配置项，提供：
 *   - GET  /api/config — 列出全部可配置项（管理员可见值，普通用户仅可见脱敏项）
 *   - POST /api/config — 更新配置（仅管理员，记录审计日志）
 *
 * 配置来源优先级：运行时内存覆盖 > 环境变量 > 数据库默认值。
 * 运行时配置存储于 _config 表，可在不重启服务的前提下热更。
 */
const { db, now } = require('../db');
const crypto = require('crypto');

/* ---------- 配置定义 ---------- */

/**
 * @typedef {Object} ConfigDef
 * @property {string}  key        - 配置键
 * @property {string}  label      - 中文标签名
 * @property {string}  group      - 分组（'backup','security','storage','llm','system'）
 * @property {string}  type       - 值类型（'string','number','boolean'）
 * @property {string}  [env]      - 对应环境变量名（可选）
 * @property {*}       default    - 默认值
 * @property {string}  [desc]     - 说明
 * @property {boolean} [sensitive] - 敏感项（回显时脱敏）
 * @property {string[]} [options]  - 如有枚举值范围
 */

/** @type {ConfigDef[]} */
const CONFIG_DEFS = [
  // ---- 备份 ----
  { key: 'backup_keep', label: '备份保留份数', group: 'backup', type: 'number', env: 'AGENT_BACKUP_KEEP', default: 30, desc: '每日数据库备份保留最新 N 份，超出自动删除最旧备份' },
  { key: 'backup_exclude_tables', label: '备份排除表名', group: 'backup', type: 'string', default: '', desc: '逗号分隔的表名列表，备份时跳过这些表（如：err_logs,op_logs）' },
  { key: 'backup_exclude_dirs', label: '备份排除目录', group: 'backup', type: 'string', default: '', desc: '逗号分隔的 uploads 子目录名，备份产物时跳过（如：sandbox,exports）' },
  { key: 'upload_ttl_days', label: '产物保留天数', group: 'backup', type: 'number', env: 'AGENT_UPLOAD_TTL_DAYS', default: 30, desc: '生成产物（图片、视频、临时文档）超过此天数自动清理' },
  { key: 'log_ttl_days', label: '日志保留天数', group: 'backup', type: 'number', env: 'AGENT_LOG_TTL_DAYS', default: 90, desc: 'op_logs/err_logs/task_runs 超过此天数自动归档删除' },
  // ---- 安全 ----
  { key: 'token_ttl_hours', label: 'Token 有效期（小时）', group: 'security', type: 'number', env: 'AGENT_TOKEN_TTL_HOURS', default: 24, desc: '登录 JWT Token 有效期，过期间需重新登录' },
  { key: 'fetch_allow_private', label: '允许内网地址访问', group: 'security', type: 'boolean', env: 'AGENT_FETCH_ALLOW_PRIVATE', default: false, desc: 'web_fetch 工具是否允许访问 127.0.0.1/10.x/172.x/192.168.x 等内网地址' },
  // ---- 存储 ----
  { key: 'storage_backend', label: '存储后端类型', group: 'storage', type: 'string', env: 'STORAGE_BACKEND', default: 'local', options: ['local', 's3'], desc: 'local=本地磁盘（public/uploads/），s3=S3 兼容对象存储' },
  { key: 's3_endpoint', label: 'S3 端点', group: 'storage', type: 'string', env: 'S3_ENDPOINT', default: '', desc: 'S3 服务地址（如 https://s3.amazonaws.com）' },
  { key: 's3_region', label: 'S3 区域', group: 'storage', type: 'string', env: 'S3_REGION', default: '', desc: 'S3 存储区域（如 us-east-1）' },
  { key: 's3_bucket', label: 'S3 存储桶', group: 'storage', type: 'string', env: 'S3_BUCKET', default: '', desc: 'S3 桶名，所有文件统一存储' },
  { key: 's3_access_key', label: 'S3 访问密钥', group: 'storage', type: 'string', env: 'S3_ACCESS_KEY', default: '', sensitive: true, desc: 'S3 AK，密文存储，回显时仅显示末 4 位' },
  { key: 's3_secret_key', label: 'S3 秘密密钥', group: 'storage', type: 'string', env: 'S3_SECRET_KEY', default: '', sensitive: true, desc: 'S3 SK，密文存储，回显时仅显示末 4 位' },
  { key: 's3_force_path_style', label: 'S3 强制路径风格', group: 'storage', type: 'boolean', env: 'S3_FORCE_PATH_STYLE', default: false, desc: 'MinIO/Ceph 等需设为 true（路径风格而非虚拟主机风格）' },
  // ---- LLM ----
  { key: 'llm_timeout_ms', label: 'LLM 超时（毫秒）', group: 'llm', type: 'number', env: 'LLM_TIMEOUT_MS', default: 60000, desc: 'LLM 接口调用超时（含重试）' },
  // ---- 系统 ----
  { key: 'page_size', label: '默认分页大小', group: 'system', type: 'number', default: 20, desc: '列表页默认每页条数' },
  // ---- 队列（N7 / U2-1） ----
  { key: 'queue_driver', label: '任务队列驱动', group: 'system', type: 'string', env: 'QUEUE_DRIVER', default: 'memory', options: ['memory', 'redis'], desc: 'memory=进程内队列（默认，单进程）；redis=外置 BullMQ 队列（多进程/多节点横向扩展，需已装 bullmq/ioredis 并配好 redis_url）' },
  { key: 'redis_url', label: 'Redis 连接串', group: 'system', type: 'string', env: 'REDIS_URL', default: '', desc: 'redis 驱动使用的 Redis 连接串（如 redis://127.0.0.1:6379）；留空用默认地址' },
  { key: 'deploy_mode', label: '部署模式', group: 'system', type: 'string', env: 'DEPLOY_MODE', default: 'single', options: ['single', 'cluster'], desc: 'single=单进程（默认）；cluster=多进程/多节点（启用选主租约锁，调度 tick 与内存队列仅 leader 执行）' },
];

/* ---------- 运行时配置 ---------- */

// 运行时值缓存（从环境变量 + 数据库读取后合并）
let configMap = null;

/** 初始化配置缓存（幂等） */
function initConfig() {
  if (configMap) return;
  configMap = new Map();

  // 1. 先写入定义默认值
  for (const def of CONFIG_DEFS) {
    configMap.set(def.key, def.default);
  }

  // 2. 环境变量覆盖
  for (const def of CONFIG_DEFS) {
    if (def.env && process.env[def.env] !== undefined) {
      const val = process.env[def.env];
      configMap.set(def.key, coerceValue(def.type, val));
    }
  }

  // 3. 数据库覆盖（运行时配置）
  try {
    const dbConfigs = db.prepare('SELECT key, value FROM _config').all();
    for (const c of dbConfigs) {
      const def = CONFIG_DEFS.find(d => d.key === c.key);
      if (def) {
        configMap.set(c.key, coerceValue(def.type, c.value));
      }
    }
  } catch { /* _config 表尚不存在（首次运行） */ }
}

function coerceValue(type, raw) {
  if (type === 'number') return Number(raw) || 0;
  if (type === 'boolean') return raw === 'true' || raw === true || raw === 1 || raw === '1';
  return String(raw);
}

/** 获取单条配置值 */
function get(key) {
  initConfig();
  return configMap.get(key);
}

/** 获取全部配置 */
function getAll() {
  initConfig();
  return configMap;
}

/** 更新运行时配置（写入数据库 + 刷新缓存） */
function set(key, value) {
  initConfig();
  const def = CONFIG_DEFS.find(d => d.key === key);
  if (!def) throw new Error(`未知配置项：${key}`);

  // 校验类型
  let coerced;
  try { coerced = coerceValue(def.type, value); } catch { throw new Error(`配置项「${key}」类型不匹配，应为 ${def.type}`); }
  if (def.options && !def.options.includes(String(coerced))) {
    throw new Error(`配置项「${key}」值不在允许范围内：${def.options.join(', ')}`);
  }

  // 写入数据库
  db.prepare('INSERT OR REPLACE INTO _config (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(coerced), now());
  // 刷新缓存
  configMap.set(key, coerced);
  return coerced;
}

/* ---------- 配置表创建 ---------- */

function ensureConfigTable() {
  db.exec('CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
}

ensureConfigTable();

/* ---------- 脱敏工具 ---------- */

function maskSensitive(val) {
  const s = String(val || '');
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-4);
}

function exportConfigs(user) {
  initConfig();
  const isAdmin = user && user.role === 'admin';
  const result = [];
  for (const def of CONFIG_DEFS) {
    const val = configMap.get(def.key);
    result.push({
      key: def.key,
      label: def.label,
      group: def.group,
      type: def.type,
      value: (def.sensitive && !isAdmin) ? maskSensitive(val) : val,
      default: def.default,
      env: def.env || null,
      desc: def.desc || '',
      options: def.options || null,
      sensitive: def.sensitive || false,
    });
  }
  return result;
}

module.exports = { get, set, getAll, initConfig, exportConfigs, CONFIG_DEFS };