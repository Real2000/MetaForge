/**
 * 数据库初始化：Schema + 种子数据（首次运行自动灌入）
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// 数据目录：默认 <项目>/data；测试可用 AGENT_DATA_DIR 指向隔离目录（不污染生产库）
const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'platform.db'));
// U2-1 / N7-P2：集群多进程共用同一 SQLite 库，并发写（启动迁移/写入）时等待锁释放而非立即 SQLITE_BUSY 崩溃。
// 单进程下无锁竞争，此设置无任何行为影响。
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');

// U2-1 / N7-P2：集群多进程并发执行内联迁移「先查列→再 ALTER」时，两进程可能同时判定列不存在，
// 后到达者会抛 "duplicate column name"（列已被另一进程添加）。此处集中吞掉该幂等错误，
// 使迁移在并发启动（WEB_CONCURRENCY / PM2 多实例）下收敛一致，且不掩盖其他 SQL 错误。
{
  const _rawExec = db.exec.bind(db);
  db.exec = (sql) => {
    try { return _rawExec(sql); }
    catch (e) {
      if (e && /duplicate column name/i.test(String(e.message || ''))) return undefined;
      throw e;
    }
  };
}

// 2026-10-28 向量库升级：LanceDB 嵌入式向量数据库（零部署，磁盘持久化）
// LanceDB 数据目录 & 初始化连接在 retriever.js 中按需创建（兼容无向量库的场景）
let lanceTable = null; // LanceDB 表引用，首次插入时自动创建
let lanceDb = null;   // LanceDB 数据库连接引用

// 密码哈希 SALT（2026-10-20 P0 安全加固）：优先环境变量，其次 data/secrets.json（与 JWT 密钥同文件，
// 首次启动自动生成），兜底旧版硬编码值（保证存量用户密码不失效）。兼容策略：验证时依次尝试新/旧 SALT。
const SALT_FILE = path.join(DATA_DIR, 'secrets.json');
const LEGACY_SALT = 'agent-platform-salt-v1';
function loadSalt() {
  if (process.env.AGENT_PWD_SALT && process.env.AGENT_PWD_SALT.length >= 8) return process.env.AGENT_PWD_SALT;
  try {
    if (fs.existsSync(SALT_FILE)) {
      const j = JSON.parse(fs.readFileSync(SALT_FILE, 'utf8'));
      if (j.pwd_salt && j.pwd_salt.length >= 8) return j.pwd_salt;
    }
  } catch { }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 与 auth.js 共用同一文件：保留已有字段（如 jwt_secret），只补 pwd_salt
    const j = fs.existsSync(SALT_FILE) ? JSON.parse(fs.readFileSync(SALT_FILE, 'utf8')) : {};
    if (!j.pwd_salt) {
      j.pwd_salt = crypto.randomBytes(32).toString('hex');
      j.generated_at = new Date().toISOString();
      fs.writeFileSync(SALT_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
    }
    return j.pwd_salt;
  } catch { }
  return LEGACY_SALT;
}
const SALT = loadSalt();
/* P0-1 2026-10-28 密码哈希升级：SHA-256 → scrypt + per-user salt，存量透明迁移
 * hashPwd 现在生成 scrypt 哈希（自动加随机盐），verifyPwd 兼容旧 SHA-256 全局盐哈希，
 * 登录时自动升级为 scrypt（修改 history 列为用户专属 salt+hash）。
 * 新注册用户直接用 scrypt。
 * db schema: users.password 字段含义不变，但格式为 `salt.derivedKey`（scrypt）或旧 hash（SHA-256）
 * 其中 scrypt 配置：N=16384, r=8, p=1, keylen=32
 */
const SCRYPT_OPTS = { N: 1 << 14, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }; // N=16384

function generateSalt(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

async function hashPwdScrypt(pwd, salt) {
  try {
    const key = await new Promise((resolve, reject) => {
      crypto.scrypt(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      });
    });
    return salt + '.' + key.toString('hex');
  } catch (e) {
    const key = crypto.scryptSync(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS);
    return salt + '.' + key.toString('hex');
  }
}

async function verifyPwdScrypt(pwd, stored) {
  // scrypt 格式：salt.derivedKey
  if (stored.includes('.')) {
    const parts = stored.split('.');
    // 确保格式正确（至少 salt + key 两部分）
    if (parts.length >= 2) {
      const salt = parts[0];
      const keyHex = parts.slice(1).join('.'); // 可能有多个点，重新连接
      try {
        const derived = await new Promise((resolve, reject) => {
          crypto.scrypt(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey);
          });
        });
        if (derived.toString('hex') === keyHex) return { ok: true, legacy: false };
      } catch (e) {
        // fallthrough to legacy
      }
    }
    // 格式不对或验证失败，fallthrough 尝试旧方式
  }
  // 旧兼容：SHA-256 + 全局 SALT
  const legacyHash = crypto.createHash('sha256').update(SALT + pwd).digest('hex');
  if (stored === legacyHash) return { ok: true, legacy: true };
  // 再兼容旧旧 SALT（LEGACY_SALT 兜底）
  const legacyHash2 = crypto.createHash('sha256').update(LEGACY_SALT + pwd).digest('hex');
  return { ok: stored === legacyHash2, legacy: stored === legacyHash2 };
}

// 保持 hashPwd 和 verifyPwd 的旧接口签名不变，内部实现升级
function hashPwd(pwd) {
  // 同步包装，实际上 db 操作时统一用 async 变体
  // 但为了向后兼容，保留此函数返回同步值（调用方在赋初值时用）
  // 实际新注册/改密时使用 hashPwdAsync
  const salt = generateSalt();
  // 同步 scrypt 不支持于所有 Node 版本，这里用同步方式生成（主线程阻塞，但只在注册和改密时调用一次，可接受）
  const key = crypto.scryptSync(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS);
  return salt + '.' + key.toString('hex');
}

// 验证时用 async 版本
async function verifyPwd(pwd, stored) {
  return verifyPwdScrypt(pwd, stored);
}

// 注册/改密时写入哈希
async function hashPwdAsync(pwd) {
  const salt = generateSalt();
  try {
    const key = await new Promise((resolve, reject) => {
      crypto.scrypt(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      });
    });
    return salt + '.' + key.toString('hex');
  } catch (e) {
    // fallback: synchronous scrypt
    const key = crypto.scryptSync(pwd, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS);
    return salt + '.' + key.toString('hex');
  }
}
function now() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}
function daysAgo(n, hour = 10, min = 0) {
  const d = new Date(Date.now() - n * 86400000);
  d.setHours(hour, min, 0, 0);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nickname TEXT,
  role TEXT DEFAULT 'user',
  dept TEXT,
  status INTEGER DEFAULT 1,
  must_change_pwd INTEGER DEFAULT 0,
  quota_total INTEGER DEFAULT 0,
  quota_used INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER DEFAULT NULL,
  name TEXT NOT NULL,
  path TEXT DEFAULT '',
  order_num INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner TEXT,
  members INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'digital',
  space_id INTEGER,
  category TEXT DEFAULT '未分类',
  prompt TEXT DEFAULT '',
  model TEXT,
  temperature REAL DEFAULT 0.7,
  context_rounds INTEGER DEFAULT 10,
  max_reply INTEGER DEFAULT 1024,
  opening TEXT DEFAULT '',
  opening_questions TEXT DEFAULT '[]',
  kb_id INTEGER,
  status TEXT DEFAULT 'draft',
  source TEXT DEFAULT 'self',
  source_name TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS kbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  owner TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS kb_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id INTEGER NOT NULL,
  name TEXT,
  size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',
  chunk_count INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  kb_id INTEGER,
  content TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  title TEXT,
  username TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  role TEXT,
  content TEXT,
  tokens INTEGER DEFAULT 0,
  created_at TEXT
);`);
// messages 补充对话质量反馈列（2026-10-20 体验优化）：
// rating：0 未评 / 1 👍 / -1 👎（消息级好坏反馈）
// solved：0 未评 / 1 已解决 / 2 未解决（「这个回答解决你的问题了吗」二选一调研）
{
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  if (!msgCols.includes('rating')) {
    db.exec('ALTER TABLE messages ADD COLUMN rating INTEGER DEFAULT 0');
    console.log('[db] messages 表已迁移：新增 rating 字段');
  }
  if (!msgCols.includes('solved')) {
    db.exec('ALTER TABLE messages ADD COLUMN solved INTEGER DEFAULT 0');
    console.log('[db] messages 表已迁移：新增 solved 字段');
  }
}
// ---------------- P1-6 会话检查点 v2（2026-11-12）----------------
// messages.branch：消息分支归属（main=当前活跃线；回放归档线 br-{ts} 只读保留，防误删上下文）
// sessions.active_branch：会话当前查看/写入的分支（v1 恒 main，预留切换能力）
{
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  if (!msgCols.includes('branch')) {
    db.exec("ALTER TABLE messages ADD COLUMN branch TEXT DEFAULT 'main'");
    console.log('[db] messages 表已迁移：新增 branch 字段（P1-6 分支回放）');
  }
  const sessCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!sessCols.includes('active_branch')) {
    db.exec("ALTER TABLE sessions ADD COLUMN active_branch TEXT DEFAULT 'main'");
    console.log('[db] sessions 表已迁移：新增 active_branch 字段（P1-6 分支回放）');
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE,
  user_content TEXT DEFAULT '',
  partial_content TEXT DEFAULT '',
  status TEXT DEFAULT 'generating',
  model TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// ---------------- P1-7 渠道适配层（2026-11-12）：入站消息审计表 ----------------
// 每条经渠道适配层归一化的入站消息落一行（含派发去向），渠道侧 eventId 幂等去重
db.exec(`CREATE TABLE IF NOT EXISTS channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT DEFAULT '',
  channel TEXT DEFAULT '',
  sender_id TEXT DEFAULT '',
  chat_id TEXT DEFAULT '',
  chat_type TEXT DEFAULT 'single',
  text TEXT DEFAULT '',
  attachments TEXT DEFAULT '[]',
  dispatched_to TEXT DEFAULT '',
  dispatch_result TEXT DEFAULT '',
  raw TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_channel_messages_event ON channel_messages(event_id);');
// checkpoints 补充：SSE 流式生成快照——generating(生成中)/aborted(异常中断，可续跑)/done(正常完成即清理)
// 断点续跑依据：status != 'done' 的检查点在用户重新打开会话时提示「继续生成」
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_type TEXT DEFAULT 'agent',
  target_id INTEGER,
  exec_type TEXT DEFAULT 'once',
  cron TEXT,
  params TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  last_result TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  status TEXT,
  started_at TEXT,
  finished_at TEXT,
  output TEXT
);
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  models TEXT DEFAULT '[]',
  configured INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'coze',
  endpoint TEXT DEFAULT '',
  token TEXT DEFAULT '',
  build_url TEXT DEFAULT '',
  status INTEGER DEFAULT 1,
  synced INTEGER DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS word_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER,
  word TEXT NOT NULL,
  input_block INTEGER DEFAULT 0,
  output_block INTEGER DEFAULT 0,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action TEXT,
  detail TEXT DEFAULT '',
  ip TEXT,
  created_at TEXT
);
`);
// P4 本地桥 A2（2026-11-09）：op_logs 加持续时间列——local_exec run 实测精度 ±5ms 以内；已存在则忽略（幂等）
try { db.exec("ALTER TABLE op_logs ADD COLUMN duration_ms INTEGER DEFAULT NULL"); } catch { }
db.exec(`CREATE TABLE IF NOT EXISTS err_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  message TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  agent_id INTEGER,
  rule_prompt TEXT DEFAULT '',
  dataset TEXT DEFAULT '[]',
  status TEXT DEFAULT 'done',
  score REAL DEFAULT 0,
  result TEXT DEFAULT '[]',
  created_at TEXT
);
`);

// ---------------- 供应商默认唯一性防护（2026-10-14 修复双默认 bug） ----------------
// 根因：providers.js 设默认路由「清空其他默认」语句漏 .run() 从未执行，历史遗留多个 is_default=1 并存。
// 此处幂等归一化（保留最新创建的一个默认）+ 部分唯一索引，数据库层杜绝复发（含直接改库）。
{
  const dupDefaults = db.prepare('SELECT id FROM providers WHERE is_default=1 ORDER BY created_at DESC, id DESC').all();
  if (dupDefaults.length > 1) {
    const keep = dupDefaults[0].id; // 保留最新创建的（用户最近的意图）
    db.prepare('UPDATE providers SET is_default=0 WHERE is_default=1 AND id != ?').run(keep);
    console.log(`[db] 供应商默认归一化：保留 #${keep}，清除其余 ${dupDefaults.length - 1} 个默认标志`);
  }
  // 部分唯一索引：is_default=1 的行全局最多一个（归一化之后才能建成功）
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_single_default ON providers(is_default) WHERE is_default=1`);
}

// ---------------- 存量库迁移（幂等） ----------------
// users 表补充配额字段（2026-10-20 P2：用户级 Token 配额，0=不限制）
{
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('quota_total')) {
    db.exec('ALTER TABLE users ADD COLUMN quota_total INTEGER DEFAULT 0');
    db.exec('ALTER TABLE users ADD COLUMN quota_used INTEGER DEFAULT 0');
    console.log('[db] users 表已迁移：新增 quota_total / quota_used 字段');
  }
  // 存量用户用量回填：按 messages 表 token 累计（含分享页/API 调用归到 admin 创建者）
  const hasUsage = db.prepare('SELECT COUNT(*) c FROM users WHERE quota_used > 0').get().c;
  if (!hasUsage) {
    db.exec(`UPDATE users SET quota_used = COALESCE((
      SELECT SUM(m.tokens) FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.username = users.username
    ), 0)`);
    console.log('[db] users.quota_used 已按历史对话 token 回填');
  }
}
// agents 表补充 owner（2026-10-20 P2：分享页/openapi 消耗记账归属到智能体发布者）
{
  const agentCols2 = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  if (!agentCols2.includes('owner')) {
    db.exec("ALTER TABLE agents ADD COLUMN owner TEXT DEFAULT ''");
    console.log('[db] agents 表已迁移：新增 owner 字段');
    // 存量归属：外部同步的归 admin，自建的也归 admin（当前用户就是唯一创建者）
    db.exec("UPDATE agents SET owner='admin' WHERE COALESCE(owner,'')=''");
  }
}
// users 表补充 must_change_pwd（2026-10-20 P0 弱口令治理：标记需强制改密的账号）
{
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('must_change_pwd')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_pwd INTEGER DEFAULT 0');
    console.log('[db] users 表已迁移：新增 must_change_pwd 字段');
  }
  /** P1-3 重修 2026-11-09：弱口令检测——两版错误实现复盘：
   *  ①原版 `u.password === hashPwd(w)`：hashPwd 每次生成随机盐，scrypt 哈希恒不相等（仅旧 SHA-256 格式命中）；
   *  ②一修版 `scryptSync(w, 固定盐, 64)` vs `Buffer.from('salt.key','hex')`：存储格式是 `salt.derivedKey`
   *    （每用户随机盐、keylen=32、需 SCRYPT_OPTS），固定盐 + keylen 64 + 点号 hex 解码抛错被吞 → 比对恒 false。
   *  正确做法：按 verifyPwdScrypt 同款逻辑同步复刻——解析行内 salt、scryptSync(pwd, salt, 32, SCRYPT_OPTS)
   *  与存储 keyHex 比较；旧格式 SHA-256 兼容 SALT 与 LEGACY_SALT 两种全局盐（与 verifyPwd 的两条 legacy 分支对齐）。
   *  另修复连带问题：恢复被误删的 mark/unmark 预编译语句；SELECT 补 username 列（日志打印需要）。 */
  function isWeakPwdSync(stored, candidate) {
    if (typeof stored !== 'string' || !stored) return false;
    if (stored.includes('.')) { // scrypt 格式：salt.derivedKey
      const dot = stored.indexOf('.');
      const salt = stored.slice(0, dot);
      const keyHex = stored.slice(dot + 1);
      if (!salt || !keyHex) return false;
      try {
        const derived = crypto.scryptSync(candidate, salt, SCRYPT_OPTS.keylen || 32, SCRYPT_OPTS);
        return derived.toString('hex') === keyHex;
      } catch { return false; }
    }
    // 旧格式 SHA-256：SALT（现行全局盐）与 LEGACY_SALT（升级前兜底盐）两条 legacy 分支
    if (stored === crypto.createHash('sha256').update(SALT + candidate).digest('hex')) return true;
    if (stored === crypto.createHash('sha256').update(LEGACY_SALT + candidate).digest('hex')) return true;
    return false;
  }
  const WEAK = ['admin123', '123456', 'demo123', 'password', '111111', '000000', 'abc123'];
  const users = db.prepare('SELECT id, username, password, must_change_pwd FROM users').all().filter(u => !u.must_change_pwd);
  const mark = db.prepare('UPDATE users SET must_change_pwd=1 WHERE id=?');
  const unmark = db.prepare('UPDATE users SET must_change_pwd=0 WHERE id=?');
  let weakMarked = 0;
  for (const u of users) {
    const isWeak = WEAK.some(w => isWeakPwdSync(u.password, w));
    if (isWeak) { mark.run(u.id); weakMarked++; console.log(`[db] 弱口令账号已标记强制改密：#${u.id}（用户名：${u.username}）`); }
    else unmark.run(u.id);
  }
  if (weakMarked) console.log(`[db] 弱口令扫描完成：本次新标记 ${weakMarked} 个账号（改密后标记自动清除）`);
}
// users 表补充 onboarded（2026-10-20 帮助体系：新手引导完成标记，0=未看过 3 步引导）
// 与 quota_alert_level（用量预警已提醒档位：0=未提醒 1=已提醒80% 2=已提醒90%，防重复站内信）
{
  const userCols2 = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols2.includes('onboarded')) {
    db.exec('ALTER TABLE users ADD COLUMN onboarded INTEGER DEFAULT 0');
    console.log('[db] users 表已迁移：新增 onboarded 字段');
  }
  if (!userCols2.includes('quota_alert_level')) {
    db.exec('ALTER TABLE users ADD COLUMN quota_alert_level INTEGER DEFAULT 0');
    console.log('[db] users 表已迁移：新增 quota_alert_level 字段');
  }
}
// users 补充 plan（2026-10-20 商业化）：套餐档位 free/pro/enterprise，默认 free；
// 套餐额度与权益定义见 lib/plans.js（静态配置，不入库）
{
  const userCols3 = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols3.includes('plan')) {
    db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'");
    console.log('[db] users 表已迁移：新增 plan 字段');
  }
  // users 表增加 dept_id（P0 部门组织架构，2026-10-29）
  if (!userCols3.includes('dept_id')) {
    db.exec('ALTER TABLE users ADD COLUMN dept_id INTEGER DEFAULT NULL');
    console.log('[db] users 表已迁移：新增 dept_id 字段');
  }
}
// 企业定制线索表（2026-10-20 商业化）：对外价格页「联系销售」表单收集，免登录提交
db.exec(`CREATE TABLE IF NOT EXISTS enterprise_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  scale TEXT DEFAULT '',
  demand TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  handler TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT
);`);
// 发票申请表（2026-10-20 商业化）：用户在线提交开票信息，管理员处理
db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  title TEXT NOT NULL,
  tax_no TEXT DEFAULT '',
  amount_type TEXT DEFAULT 'plan',
  month TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  email TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  handler TEXT DEFAULT '',
  handled_at TEXT,
  created_at TEXT
);`);
// platforms 表补充 build_url（外部平台搭建页地址）
const platCols = db.prepare('PRAGMA table_info(platforms)').all().map(c => c.name);
if (!platCols.includes('build_url')) {
  db.exec(`ALTER TABLE platforms ADD COLUMN build_url TEXT DEFAULT ''`);
  // 按类型补默认搭建页地址
  db.prepare(`UPDATE platforms SET build_url='https://www.coze.cn/workbench' WHERE type='coze'`).run();
  const difyRows = db.prepare('SELECT id, endpoint FROM platforms WHERE type=?').all('dify');
  difyRows.forEach(r => {
    const base = (r.endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    if (base) db.prepare('UPDATE platforms SET build_url=? WHERE id=?').run(base + '/apps', r.id);
  });
  console.log('[db] platforms 表已迁移：新增 build_url 字段');
}
// platforms 表补充 console_email / console_password（Dify 控制台凭据，真同步用）
if (!platCols.includes('console_email')) {
  db.exec(`ALTER TABLE platforms ADD COLUMN console_email TEXT DEFAULT ''`);
  db.exec(`ALTER TABLE platforms ADD COLUMN console_password TEXT DEFAULT ''`);
  console.log('[db] platforms 表已迁移：新增 console_email / console_password 字段');
}
// agents 表补充外部应用映射与分享字段
const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
if (!agentCols.includes('external_app_id')) {
  db.exec(`ALTER TABLE agents ADD COLUMN external_app_id TEXT DEFAULT ''`);
  db.exec(`ALTER TABLE agents ADD COLUMN external_api_key TEXT DEFAULT ''`);
  db.exec(`ALTER TABLE agents ADD COLUMN external_mode TEXT DEFAULT ''`);
  console.log('[db] agents 表已迁移：新增 external_app_id / external_api_key / external_mode 字段');
}
if (!agentCols.includes('share_token')) {
  db.exec(`ALTER TABLE agents ADD COLUMN share_token TEXT DEFAULT ''`);
  db.exec(`ALTER TABLE agents ADD COLUMN share_enabled INTEGER DEFAULT 0`);
  console.log('[db] agents 表已迁移：新增 share_token / share_enabled 字段');
}
// sessions 表补充外部平台会话 ID（Dify conversation_id，多轮对话必需）
const sessCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
if (!sessCols.includes('ext_conversation_id')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN ext_conversation_id TEXT DEFAULT ''`);
  console.log('[db] sessions 表已迁移：新增 ext_conversation_id 字段');
}
// P5.7 会话变量（Chatflow 跨轮次持久）：按会话存画布 start.session_vars 的当前值（JSON {name:value}）
if (!sessCols.includes('wf_vars')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN wf_vars TEXT DEFAULT ''`);
  console.log('[db] sessions 表已迁移：新增 wf_vars 字段（会话变量）');
}
// API 发布密钥表
db.exec(`CREATE TABLE IF NOT EXISTS agent_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  key TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  status INTEGER DEFAULT 1,
  created_at TEXT,
  last_used_at TEXT
);`);
// 分享会话表（免登录访问，与内部 sessions 隔离）
db.exec(`CREATE TABLE IF NOT EXISTS share_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token TEXT NOT NULL,
  title TEXT DEFAULT '分享对话',
  ext_conversation_id TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// agents 表补充 tools（内置工具开关，JSON 数组）
if (!agentCols.includes('tools')) {
  db.exec(`ALTER TABLE agents ADD COLUMN tools TEXT DEFAULT '[]'`);
  console.log('[db] agents 表已迁移：新增 tools 字段');
}
// agents 表补充 mcp_servers（挂载的 MCP 服务 ID，JSON 数组）
if (!agentCols.includes('mcp_servers')) {
  db.exec(`ALTER TABLE agents ADD COLUMN mcp_servers TEXT DEFAULT '[]'`);
  console.log('[db] agents 表已迁移：新增 mcp_servers 字段');
}
// agents 表补充 share_expires_at（分享链接有效期，NULL=永久）
if (!agentCols.includes('share_expires_at')) {
  db.exec(`ALTER TABLE agents ADD COLUMN share_expires_at TEXT DEFAULT NULL`);
  console.log('[db] agents 表已迁移：新增 share_expires_at 字段');
}
// agents 表补充 SinguX 式编排配置（2026-10-14：编排页升级）
const STUDIO_COLS = [
  ['user_prompt', `TEXT DEFAULT ''`],            // 用户提示词（预置指令，注入对话输入框）
  ['top_p', `REAL DEFAULT 0.7`],                  // Top p（生成多样性参数）
  ['diversity_mode', `TEXT DEFAULT 'balanced'`], // 生成多样性模式：precise/balanced/creative/custom
  ['icon', `TEXT DEFAULT ''`],                    // 图标（emoji）
  ['long_memory', `INTEGER DEFAULT 0`],           // 长期记忆开关（跨会话记住用户特征）
  ['allow_user_model', `INTEGER DEFAULT 1`],      // 允许用户选择自有模型
  ['suggest_enabled', `INTEGER DEFAULT 1`],       // 用户问题建议开关
  ['variables', `TEXT DEFAULT '[]'`],             // 自定义变量（JSON：[{name,desc}]）
];
for (const [col, def] of STUDIO_COLS) {
  if (!agentCols.includes(col)) {
    db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
    console.log(`[db] agents 表已迁移：新增 ${col} 字段`);
  }
}
// agents 表补充广场与子智能体编排字段（2026-10-14 第二批：广场/发布体系/子智能体）
const PLAZA_COLS = [
  ['child_ids', `TEXT DEFAULT '[]'`],        // 子智能体编排（JSON：[id]，主智能体经 function calling 路由）
  ['is_official', `INTEGER DEFAULT 0`],      // 官方智能体标识（广场官方筛选）
  ['publish_record', `TEXT DEFAULT ''`],     // 发布记录（本次发布说明，≤200 字）
  ['allow_copy', `INTEGER DEFAULT 1`],       // 允许复制为模板（广场一键复制创建）
  ['fav_count', `INTEGER DEFAULT 0`],        // 收藏数（冗余计数，收藏/取消时同步）
  ['use_count', `INTEGER DEFAULT 0`],        // 使用数（创建会话时 +1，广场统计）
];
for (const [col, def] of PLAZA_COLS) {
  if (!agentCols.includes(col)) {
    db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
    console.log(`[db] agents 表已迁移：新增 ${col} 字段`);
  }
}
// P5.9 版本管理：草稿与发布分离——agents.published_workflow 存发布快照
// （草稿在 workflow 字段，发布时复制；运行时优先快照，编辑草稿不影响线上；无快照的存量画布回退草稿）
if (!agentCols.includes('published_workflow')) {
  db.exec(`ALTER TABLE agents ADD COLUMN published_workflow TEXT DEFAULT NULL`);
  console.log('[db] agents 表已迁移：新增 published_workflow 字段（发布快照）');
}
// P5.9 发布历史表：每次发布存一条（版本号/快照 JSON/发布说明），支持一键回滚
db.exec(`CREATE TABLE IF NOT EXISTS agent_publish_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  workflow TEXT,
  note TEXT DEFAULT '',
  nodes INTEGER DEFAULT 0,
  published_by TEXT,
  created_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pub_history_agent ON agent_publish_history(agent_id, version DESC);`);
// LLMOps 提示词版本管理（2026-10-31 计划 #10）：每次 prompt/user_prompt 实际变更自动记快照
// （快照存变更后的值），支持版本对比与一键回滚。version 在同一 agent 内从 1 递增；
// note 记录来源（'提示词修改' / '回滚到 vN'）。回滚本身也产生新版本（完整审计链）。
db.exec(`CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  version INTEGER NOT NULL,        -- agent_id 内从 1 递增
  prompt TEXT DEFAULT '',          -- 系统提示词快照（变更后值）
  user_prompt TEXT DEFAULT '',     -- 用户提示词快照
  edited_by TEXT,                  -- 操作者 username
  note TEXT DEFAULT '',            -- 备注（自动记 '提示词修改' / '回滚到 vN'）
  created_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent ON agent_prompt_versions(agent_id, version DESC);`);
// V2.4 #9 租户化 + agent_acls 权限表（2026-10-31）：三元组 ACL（用户/部门/角色）做权限的三道防线
// grant_to: 'user'|'dept'|'role'，grant_to_value 为对应的用户名/部门名/角色名
// agent_id 对应的 agent 的 filter：allow 1 允许 / 0 拒绝；未配置任何 ACL = 全允许
// 仅配合空间过滤使用：ACL 在空间过滤通过后检查（空间过滤拒绝的用户无需进一步 ACL 检查）
db.exec(`CREATE TABLE IF NOT EXISTS agent_acls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER,
  grant_to TEXT NOT NULL,
  grant_to_value TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  allow INTEGER DEFAULT 1,
  created_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_acls_agent ON agent_acls(agent_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_acls_space ON agent_acls(space_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_acls_grant ON agent_acls(grant_to, grant_to_value);`);
console.log('[db] 创建 agent_acls 表（租户化 ACL 权限表）');

// V3.1 #12 审核流（2026-11-03）：agent_reviews 审核流水表 + agents.review_comment 列
// 流转：draft/rejected →（提审 submit）review →（approve）published /（reject）rejected
// 企业版（audit_flow 特性）非 admin 提审走人工审核；社区/专业版与管理员发布直接生效（auto_approve 流水）
db.exec(`CREATE TABLE IF NOT EXISTS agent_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  action TEXT NOT NULL,           -- submit / approve / reject / auto_approve / withdraw
  operator TEXT,                  -- submit=提审人；approve/reject=审核人（admin）；auto_approve=系统判定（edition）
  comment TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_reviews_agent ON agent_reviews(agent_id, id DESC);`);
{
  const aCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  if (!aCols.includes('review_comment')) {
    db.exec(`ALTER TABLE agents ADD COLUMN review_comment TEXT DEFAULT ''`);
    console.log('[db] agents 表已迁移：新增 review_comment 字段（V3.1 #12 审核流——最新驳回意见，前台展示用）');
  }
  // V3.1 #12 嵌入代码（2026-11-03）：第三方站点嵌入域名白名单（逗号/换行分隔；空=不允许嵌入——CSP frame-ancestors 仅 'self'）
  if (!aCols.includes('embed_domains')) {
    db.exec(`ALTER TABLE agents ADD COLUMN embed_domains TEXT DEFAULT ''`);
    console.log('[db] agents 表已迁移：新增 embed_domains 字段（V3.1 #12 嵌入域名白名单）');
  }
}

// agents 表补充协作与可见性字段（2026-10-22 P3 协作与团队功能）
// visibility: public 全员可见（默认，存量不受影响）/ restricted 受限可见
// visible_depts / visible_members: restricted 时的可见部门/成员名单（JSON 数组）
// collaborators: 协作编辑者名单（JSON 数组，username，含草稿编辑权；企业版权益）
const COLLAB_COLS = [
  ['visibility', `TEXT DEFAULT 'public'`],
  ['visible_depts', `TEXT DEFAULT '[]'`],
  ['visible_members', `TEXT DEFAULT '[]'`],
  ['collaborators', `TEXT DEFAULT '[]'`],
];
for (const [col, def] of COLLAB_COLS) {
  if (!agentCols.includes(col)) {
    db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
    console.log(`[db] agents 表已迁移：新增 ${col} 字段`);
  }
}
// agents 表补充画布工作流字段（2026-10-22 P5 画布编排；P5.1 升级 V2 数据模型）
// workflow: V2 结构 JSON（{nodes:[{id:"node_N",type,position:{x,y},data:{...}}], edges:[{id,source,target,sourceHandle}], viewport}）
// edit_mode: 编辑模式独立字段 form 表单（默认）/ canvas 画布（不再依赖 routing_mode 推断）
if (!agentCols.includes('workflow')) {
  db.exec(`ALTER TABLE agents ADD COLUMN workflow TEXT DEFAULT NULL`);
  console.log('[db] agents 表已迁移：新增 workflow 字段（画布编排）');
}
if (!agentCols.includes('edit_mode')) {
  db.exec(`ALTER TABLE agents ADD COLUMN edit_mode TEXT DEFAULT 'form'`);
  console.log('[db] agents 表已迁移：新增 edit_mode 字段（form/canvas）');
}
// 存量 V1 画布数据自动升级 V2（id 数字→node_N、x/y→position、config→data、from/to/branch→source/target/sourceHandle）
{
  const { migrateWorkflowData } = require('./lib/workflow-schema');
  const rows = db.prepare(`SELECT id, workflow FROM agents WHERE workflow IS NOT NULL`).all();
  let migrated = 0;
  for (const r of rows) {
    try {
      const wf = JSON.parse(r.workflow);
      if (wf && Array.isArray(wf.nodes) && wf.nodes.length && wf.nodes[0].config !== undefined) {
        db.prepare('UPDATE agents SET workflow=? WHERE id=?').run(JSON.stringify(migrateWorkflowData(wf)), r.id);
        migrated++;
      }
    } catch { /* 损坏数据跳过 */ }
  }
  if (migrated) console.log(`[db] agents.workflow 已完成 V1→V2 数据迁移：${migrated} 条`);
}
// 存量数据回填：use_count 按历史会话数初始化（广场统计口径）
{
  const hasCount = db.prepare(`SELECT COUNT(*) c FROM agents WHERE COALESCE(use_count,0) > 0`).get().c;
  if (!hasCount) {
    db.exec(`UPDATE agents SET use_count = (SELECT COUNT(*) FROM sessions WHERE sessions.agent_id = agents.id)`);
    console.log('[db] agents.use_count 已按历史会话数回填');
  }
  // 种子官方智能体：企业级前两个设为官方（管理员发布）
  db.exec(`UPDATE agents SET is_official=1 WHERE id IN (SELECT id FROM agents WHERE source='self' ORDER BY id LIMIT 2) AND is_official=0`);
}
// 智能体收藏表（广场 ⭐ 收藏，username+agent_id 唯一）
db.exec(`CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  created_at TEXT,
  UNIQUE(username, agent_id)
);`);
// 站内通知表（发布上架/系统公告，铃铛消息中心）
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL DEFAULT '*',      -- '*' = 全员广播，否则指定用户
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  type TEXT DEFAULT 'system',              -- system/agent_publish/agent_fav
  link TEXT DEFAULT '',
  is_read INTEGER DEFAULT 0,
  created_at TEXT
);`);
// 通知已读标记（广播通知每人独立已读）
db.exec(`CREATE TABLE IF NOT EXISTS notification_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  read_at TEXT,
  UNIQUE(username, notification_id)
);`);
// 智能体长期记忆表（long_memory 开启时，对话后异步提取的用户特征事实，跨会话注入）
db.exec(`CREATE TABLE IF NOT EXISTS agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at TEXT
);`);
// 通知种子（仅首次有该表时插一条欢迎广播）
{
  const nCount = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
  if (nCount === 0) {
    db.prepare(`INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES ('*','欢迎使用智能体广场','智能体平台已上线「广场」：已发布的智能体在此集中展示，支持分类浏览、搜索、收藏与一键复制创建。','system','#/square',0,?)`).run(now());
  }
};
// kb_chunks 表补充 embedding（本地向量缓存，JSON 数组，懒计算）
const chunkCols = db.prepare('PRAGMA table_info(kb_chunks)').all().map(c => c.name);
if (!chunkCols.includes('embedding')) {
  db.exec(`ALTER TABLE kb_chunks ADD COLUMN embedding TEXT DEFAULT ''`);
  console.log('[db] kb_chunks 表已迁移：新增 embedding 字段');
}
const kbCols = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
if (!kbCols.includes('chunk_size')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN chunk_size INTEGER DEFAULT 500`);
  console.log('[db] kbs 表已迁移：新增 chunk_size 字段');
}
if (!kbCols.includes('chunk_overlap')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN chunk_overlap INTEGER DEFAULT 0`);
  console.log('[db] kbs 表已迁移：新增 chunk_overlap 字段');
}
if (!kbCols.includes('chunk_separator')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN chunk_separator TEXT DEFAULT '\\n\\s*\\n'`);
  console.log('[db] kbs 表已迁移：新增 chunk_separator 字段');
}
// V2.4 #9 租户化（2026-10-31）：kbs 表增加 space_id 列——空间归属，0=无空间（默认），写入时关联对应的 space 表记录。
// 本列是占位迁移，V2.4 正式开工时做存量回填+创建写入口。幂等（列已存在则跳过）。
const kbColsV24 = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
if (!kbColsV24.includes('space_id')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN space_id INTEGER DEFAULT 0`);
  console.log('[db] kbs 表已迁移：新增 space_id 字段（V2.4 #9 租户化占位）');
}
// kb_chunks 表增加 parent_id（父子切片：父 = ~1000 字上下文，子 = ~200 字精准召回）
const chunkCols2 = db.prepare('PRAGMA table_info(kb_chunks)').all().map(c => c.name);
if (!chunkCols2.includes('parent_id')) {
  db.exec(`ALTER TABLE kb_chunks ADD COLUMN parent_id INTEGER DEFAULT NULL`);
  console.log('[db] kb_chunks 表已迁移：新增 parent_id 字段（父子切片）');
}
// kb_chunks 表增加 keywords（自动关键词/问法：JSON {keywords:[],questions:[]}，BM25 同时索引以提升换说法召回）
if (!chunkCols2.includes('keywords')) {
  db.exec(`ALTER TABLE kb_chunks ADD COLUMN keywords TEXT DEFAULT NULL`);
  console.log('[db] kb_chunks 表已迁移：新增 keywords 字段（自动关键词/问法）');
}
// kbs 表增加 toc（TOC 目录结构：JSON [{title, level, startChunkId, chapterId}...]），切片后按章节标记分块归属
const kbCols4 = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
if (!kbCols4.includes('toc')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN toc TEXT DEFAULT '[]'`);
  console.log('[db] kbs 表已迁移：新增 toc 字段（TOC 目录结构）');
}
// kb_chunks 表增加 chapter_id（该分块所属章节的索引，同章节分块检索时自动带上上下文）
if (!chunkCols2.includes('chapter_id')) {
  db.exec(`ALTER TABLE kb_chunks ADD COLUMN chapter_id INTEGER DEFAULT NULL`);
  console.log('[db] kb_chunks 表已迁移：新增 chapter_id 字段（章节归属）');
}
// kb_files 表增加解析日志相关字段（2026-10-29：解析日志与状态可视化）
const fileCols = db.prepare('PRAGMA table_info(kb_files)').all().map(c => c.name);
if (!fileCols.includes('source')) {
  db.exec(`ALTER TABLE kb_files ADD COLUMN source TEXT DEFAULT 'upload'`);
  console.log('[db] kb_files 表已迁移：新增 source 字段（来源标识）');
}
if (!fileCols.includes('error_msg')) {
  db.exec(`ALTER TABLE kb_files ADD COLUMN error_msg TEXT DEFAULT NULL`);
  console.log('[db] kb_files 表已迁移：新增 error_msg 字段（解析失败原因）');
}
if (!fileCols.includes('parsed_at')) {
  db.exec(`ALTER TABLE kb_files ADD COLUMN parsed_at TEXT DEFAULT NULL`);
  console.log('[db] kb_files 表已迁移：新增 parsed_at 字段（解析完成时间）');
}
if (!fileCols.includes('updated_at')) {
  db.exec(`ALTER TABLE kb_files ADD COLUMN updated_at TEXT DEFAULT NULL`);
  console.log('[db] kb_files 表已迁移：新增 updated_at 字段');
}
// ---------------- V1.2 #2 元数据管理与检索过滤（2026-10-30） ----------------
// kb_chunks.metadata：分块级元数据（JSON 对象，约定键：dept 部门/level 密级[公开|内部|机密]/doc_type 文档类型）；
// NULL/''/'{}' 视为无元数据——检索带过滤时被 fail-closed 过滤（防误授权），不带过滤时行为不变
if (!chunkCols2.includes('metadata')) {
  db.exec(`ALTER TABLE kb_chunks ADD COLUMN metadata TEXT DEFAULT NULL`);
  console.log('[db] kb_chunks 表已迁移：新增 metadata 字段（元数据过滤）');
}
// kbs.auto_metadata：1=上传解析后 LLM 自动抽取元数据（lib/kb-metadata.js 后台 best-effort）
if (!kbCols4.includes('auto_metadata')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN auto_metadata INTEGER DEFAULT 0`);
  console.log('[db] kbs 表已迁移：新增 auto_metadata 字段（自动元数据开关）');
}
// ---------------- V2.3 #5 摄取管道化 + PaddleOCR 接入（2026-10-31） ----------------
// kbs.pipeline：摄取管道配置（JSON 字符串数组，元素为 lib/ingestion-pipeline.js 注册的步骤名，
// 如 '["parse","ocr","clean","chunk","toc"]'；NULL/空 = 默认管道）。变更仅影响【后续上传】的执行步骤，
// 不自动重切存量分块（需重切按既有流程重传文件，与 chunk 参数变更语义对齐）。
// 写入侧白名单校验见 routes/knowledge.js PUT /:id；读取侧归一（NULL/空/损坏 → 默认）见 parsePipelineConfig
if (!kbCols4.includes('pipeline')) {
  db.exec(`ALTER TABLE kbs ADD COLUMN pipeline TEXT DEFAULT NULL`);
  console.log('[db] kbs 表已迁移：新增 pipeline 字段（摄取管道配置）');
}

// ================== U1-9 知识库图片理解（2026-11-16）==================
// kb_chunks.image_descs TEXT —— vision-describe 步骤生成的图片描述文本
// kbs.vision_model TEXT —— 该知识库选用的多模态视觉理解模型名（空=不启用 vision 描述）
{
  try {
    const chunkCols3 = db.prepare('PRAGMA table_info(kb_chunks)').all().map(c => c.name);
    if (!chunkCols3.includes('image_descs')) {
      db.exec(`ALTER TABLE kb_chunks ADD COLUMN image_descs TEXT DEFAULT ''`);
      console.log('[db] kb_chunks 表已迁移：新增 image_descs 字段（U1-9 图片描述文本）');
    }
    const kbCols5 = db.prepare('PRAGMA table_info(kbs)').all().map(c => c.name);
    if (!kbCols5.includes('vision_model')) {
      db.exec(`ALTER TABLE kbs ADD COLUMN vision_model TEXT DEFAULT ''`);
      console.log('[db] kbs 表已迁移：新增 vision_model 字段（U1-9 视觉理解模型）');
    }
  } catch (e) { console.error('[db] U1-9 图片理解迁移失败（不阻塞启动）：', e.message); }
}
// agents.kb_metadata_filter：挂知识库时声明的检索过滤（JSON 对象，AND 语义；值支持 "$user.dept" 占位符，
// chat 时解析为请求用户部门文本名；NULL=不过滤）。例：{"level":"公开","dept":"$user.dept"}
const agentCols2 = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
if (!agentCols2.includes('kb_metadata_filter')) {
  db.exec(`ALTER TABLE agents ADD COLUMN kb_metadata_filter TEXT DEFAULT NULL`);
  console.log('[db] agents 表已迁移：新增 kb_metadata_filter 字段（知识库检索过滤声明）');
}
// users.dept_id 存量回填（V1.1 审查 F4 收尾 2026-10-30）：按 dept 文本名精确匹配部门，仅无歧义时回填。
// 幂等（WHERE dept_id IS NULL 可重跑）；行级迁移三件套：try-catch + 幂等 + 迁移日志
try {
  const backfill = db.prepare(`
    UPDATE users SET dept_id = (
      SELECT d.id FROM departments d WHERE d.name = users.dept LIMIT 1
    ) WHERE dept_id IS NULL AND IFNULL(dept, '') != ''
      AND (SELECT COUNT(*) FROM departments d2 WHERE d2.name = users.dept) = 1`);
  const info = backfill.run();
  if (info.changes > 0) console.log(`[db] users 表已迁移：${info.changes} 条 dept_id 按部门名回填（同名部门歧义的跳过）`);
} catch (e) { console.error('[db] users.dept_id 回填迁移失败（不阻塞启动）：', e.message); }
// ---------------- V2.2（2026-10-31）：#7 技能市场收藏 ----------------
// 市场收藏表（泛化 item_type/item_id）：独立于 favorites 表（后者 agent_id NOT NULL 仅服务智能体收藏，
// 泛化改造影响面大，故新建专表）。item_type: wf_template(工作流模版)/skill_asset(技能资产)/mcp_tool(MCP 工具)
// UNIQUE(username, item_type, item_id) 幂等收藏
db.exec(`CREATE TABLE IF NOT EXISTS market_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at TEXT,
  UNIQUE(username, item_type, item_id)
);`);
// ---------------- V1.3（2026-10-30）：#6 评测集 + #4 钉钉 mock ----------------
// evaluations 加 kb_id/type：知识库级召回评测集与智能体级评测同表共存（type='agent'|'kb'，默认 'agent' 兼容存量）
// 存量行 type 归一为 'agent'（agent_id 非 NULL）/查询侧补 type 过滤防两类数据互相污染
const evalCols = db.prepare('PRAGMA table_info(evaluations)').all().map(c => c.name);
if (!evalCols.includes('kb_id')) {
  db.exec(`ALTER TABLE evaluations ADD COLUMN kb_id INTEGER DEFAULT NULL`);
  console.log('[db] evaluations 表已迁移：新增 kb_id 字段（知识库级评测集）');
}
if (!evalCols.includes('type')) {
  db.exec(`ALTER TABLE evaluations ADD COLUMN type TEXT DEFAULT 'agent'`);
  db.exec(`UPDATE evaluations SET type='agent' WHERE type IS NULL OR type=''`);
  console.log('[db] evaluations 表已迁移：新增 type 字段（agent|kb 双型评测，存量归一 agent）');
}
// 钉钉回调事件幂等去重表（V1.3 #4）：钉钉失败会重试（最长 24h），重复投递必须 ACK 不重放
// event_id 为钉钉回调体 EventId；INSERT 冲突 = 已处理过 → 直接返回成功
db.exec(`CREATE TABLE IF NOT EXISTS dingtalk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT DEFAULT '',
  payload TEXT DEFAULT '',
  created_at TEXT
);`);
// P0-1: kbs.owner 存量数据迁移 nickname→username（此前创建时写入 nickname||username，denyIfNotAllowed 需精确匹配 username）
{
  const allKb = db.prepare('SELECT id, owner FROM kbs').all();
  const ownerFix = db.prepare('UPDATE kbs SET owner=? WHERE id=?');
  let fixed = 0;
  for (const r of allKb) {
    if (!r.owner) { ownerFix.run('admin', r.id); fixed++; continue; }
    const u = db.prepare('SELECT username FROM users WHERE nickname=?').get(r.owner);
    if (u && u.username !== r.owner) { ownerFix.run(u.username, r.id); fixed++; }
  }
  if (fixed) console.log(`[db] kbs 表已迁移：${fixed} 条 owner 从 nickname 修正为 username`);
}
// 全链路追踪表
db.exec(`CREATE TABLE IF NOT EXISTS chat_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  message_id INTEGER,
  agent_id INTEGER,
  model TEXT,
  mode TEXT,
  latency_ms INTEGER,
  tokens INTEGER,
  prompt_chars INTEGER,
  kb_hits TEXT DEFAULT '[]',
  tool_calls TEXT DEFAULT '[]',
  blocked TEXT DEFAULT '',
  created_at TEXT
);`);
// chat_traces 表补充 suggestions（用户问题建议，JSON 数组，异步生成后回填）
const traceCols = db.prepare('PRAGMA table_info(chat_traces)').all().map(c => c.name);
if (!traceCols.includes('suggestions')) {
  db.exec(`ALTER TABLE chat_traces ADD COLUMN suggestions TEXT DEFAULT '[]'`);
  console.log('[db] chat_traces 表已迁移：新增 suggestions 字段');
}
// MCP 服务注册表（Streamable HTTP / SSE 传输）
db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT DEFAULT '',
  transport TEXT DEFAULT 'http',
  status INTEGER DEFAULT 1,
  tools_cache TEXT DEFAULT '[]',
  last_check_at TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  created_at TEXT
);`);
// P5.5 工作流运行实例表（生产可观测：每次画布运行落一条完整记录，节点级 Trace 可回溯）
// trigger_type: manual（运行测试）/ chat（对话触发）/ api / webhook / schedule（预留）
// node_logs: [{nodeId,status,duration,inputs,output,outputFull,error,retries}] JSON（env 密钥已脱敏）
db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  trigger_type TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'running',
  inputs TEXT,
  outputs TEXT,
  node_logs TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_runs_agent ON workflow_runs(agent_id, id DESC);`);
// P5.8 差异化能力 #9：workflow_runs 支持 parent_run_id（子智能体节点调用关联父 run，画布下钻调试）
{
  const wfRunCols = db.prepare('PRAGMA table_info(workflow_runs)').all().map(c => c.name);
  if (!wfRunCols.includes('parent_run_id')) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN parent_run_id INTEGER DEFAULT NULL');
    console.log('[db] workflow_runs 表已迁移：新增 parent_run_id 字段（子智能体下钻）');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_runs_parent ON workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;`); // 索引在列迁移之后（新库 CREATE TABLE 无此列）
}
// U1-3 工作流断点恢复（2026-11-13）：workflow_runs.node_checkpoint 存每个节点完成后的中间结果/logs。
// 执行中断后从最后检查点续跑（runGraph 的 skipSet 模式），恢复行为落审计日志
{
  const wfRunCols = db.prepare('PRAGMA table_info(workflow_runs)').all().map(c => c.name);
  if (!wfRunCols.includes('node_checkpoint')) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN node_checkpoint TEXT DEFAULT NULL');
    console.log('[db] workflow_runs 表已迁移：新增 node_checkpoint 字段（U1-3 工作流断点恢复）');
  }
}
// D1-2 专家团式并行编排 V1（2026-11-20）：编排运行台账——存任务图（graph）、节点状态/日志（node_logs）、
// 汇总结论（result）与耗时成本统计，支撑「失败可重跑单节点」与前端可视化复盘。
db.exec(`CREATE TABLE IF NOT EXISTS orchestration_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  session_id INTEGER,
  username TEXT DEFAULT '',
  status TEXT DEFAULT 'running',
  graph TEXT,
  node_logs TEXT,
  result TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_orch_runs_agent ON orchestration_runs(agent_id, id DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_orch_runs_session ON orchestration_runs(session_id, id DESC);`);
// D1-3 创作资产 V1（2026-11-20）：素材库 + 项目 + 分镜三件套。
//  - projects：创作项目（视频/图文/混合），聚合分镜与素材
//  - assets：素材库（生成物/上传物，url 复用现有 media 存储 public/uploads/*），可挂项目或全局
//  - shots：分镜（引用 asset_id 表示复用已有素材→二手作品复用率口径）
db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT DEFAULT 'video',
  cover TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  space_id INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  meta TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner, id DESC);`);
db.exec(`CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER DEFAULT NULL,
  kind TEXT DEFAULT 'image',
  name TEXT DEFAULT '',
  url TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  source TEXT DEFAULT 'generated',
  prompt TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  real_person INTEGER DEFAULT 0,
  digital_human INTEGER DEFAULT 0,
  meta TEXT DEFAULT '{}',
  owner TEXT DEFAULT '',
  space_id INTEGER DEFAULT 0,
  created_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, id DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner, id DESC);`);
db.exec(`CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  seq INTEGER DEFAULT 0,
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  asset_id INTEGER DEFAULT NULL,
  kind TEXT DEFAULT 'image',
  duration REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',
  meta TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id, seq);`);
// P5.8 差异化能力 #11：tasks 表支持 Webhook 触发（exec_type='webhook' + webhook_token 路由鉴权）
{
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  if (!taskCols.includes('webhook_token')) {
    db.exec('ALTER TABLE tasks ADD COLUMN webhook_token TEXT DEFAULT \'\''); // SQL 值用单引号（双引号在 SQLite 是标识符引用）
    console.log('[db] tasks 表已迁移：新增 webhook_token 字段（Webhook 触发）');
  }
}
// P5.31 对话内一键创建定时任务：tasks 归属列（username；'' = 历史管理员创建的存量任务，仅管理员可见可管）
{
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  if (!taskCols.includes('username')) {
    db.exec('ALTER TABLE tasks ADD COLUMN username TEXT DEFAULT \'\'');
    console.log('[db] tasks 表已迁移：新增 username 归属字段（对话内创建定时任务）');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(username, enabled)'); // 用户任务列表/配额计数索引
}
// P5.32 MCP 细粒度风险分级：服务级信任开关（trusted=1 才允许按工具注解/启发式降级；默认 0 = 整类 high）
{
  const mcpCols = db.prepare('PRAGMA table_info(mcp_servers)').all().map(c => c.name);
  if (!mcpCols.includes('trusted')) {
    db.exec('ALTER TABLE mcp_servers ADD COLUMN trusted INTEGER DEFAULT 0');
    console.log('[db] mcp_servers 表已迁移：新增 trusted 信任字段（工具风险分级白名单）');
  }
  // P5.34：管理员逐工具人工标注（{工具原始名: 'low'|'high'}；人工值优先于启发式，auto=删除 key 回落启发式）
  if (!mcpCols.includes('risk_overrides')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN risk_overrides TEXT DEFAULT '{}'");
    console.log('[db] mcp_servers 表已迁移：新增 risk_overrides 字段（工具风险人工标注）');
  }
  // D2-4 连接器广场：来源与连通健康字段
  if (!mcpCols.includes('catalog_id')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN catalog_id TEXT DEFAULT ''"); // 广场目录 id（一键安装来源）
    db.exec("ALTER TABLE mcp_servers ADD COLUMN source TEXT DEFAULT 'manual'"); // manual | catalog
    db.exec('ALTER TABLE mcp_servers ADD COLUMN last_latency_ms INTEGER DEFAULT 0'); // 最近连通耗时
    db.exec('ALTER TABLE mcp_servers ADD COLUMN last_tool_count INTEGER DEFAULT 0'); // 最近工具数
    db.exec("ALTER TABLE mcp_servers ADD COLUMN last_test_at TEXT DEFAULT ''"); // 最近测试时间
    console.log('[db] mcp_servers 表已迁移：新增 catalog_id/source/last_latency_ms/last_tool_count/last_test_at（连接器广场）');
  }
}
// P5.34（审查 Y4 完整方案）：agents 稳定标识列——系统资源（内置智能体）与用户资产解耦，
// 按 system_key 查找/种子不再受 agents.name 无唯一约束的影响（用户自建同名智能体无法劫持）
{
  const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  if (!agentCols.includes('system_key')) {
    db.exec("ALTER TABLE agents ADD COLUMN system_key TEXT DEFAULT ''");
    console.log('[db] agents 表已迁移：新增 system_key 系统标识字段');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_system_key ON agents(system_key) WHERE system_key != ''`);
  // 存量回填：P5.31 按名称+来源种子过的系统执行智能体打上稳定标识
  // P5.34b（审查 F7/Y2）：逐行回填 + try/catch——多行同名同源时部分唯一索引会抛 UNIQUE 冲突，
  // 整块 UPDATE 无容错会让服务启动崩溃；逐行跳过冲突行并告警（首行生效即达到目的）
  {
    const rows = db.prepare("SELECT id FROM agents WHERE name='定时任务执行助手' AND source_name='系统内置' AND (system_key IS NULL OR system_key='') ORDER BY id").all();
    for (const r of rows) {
      try {
        db.prepare("UPDATE agents SET system_key='system_task_runner' WHERE id=?").run(r.id);
      } catch (e) {
        console.warn(`[db] system_key 回填跳过 #${r.id}（唯一冲突，已有同值行）：${e.message}`);
      }
    }
  }
}

// P5.14 文件一等变量：工作流文件表（上传原文+解析文本；变量值传 fileId，运行时注入内容/下载链接）
// content_b64 仅 ≤8MB 文件保留（供原文下载）；text_content 为解析全文（PDF/DOCX/TXT/MD）
db.exec(`CREATE TABLE IF NOT EXISTS wf_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ext TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  text_content TEXT DEFAULT '',
  content_b64 TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  created_by TEXT DEFAULT '',
  created_at TEXT
);`);
// P5.5 通用密钥表（画布 {{env.XXX}} 占位符运行时注入；值仅管理员可写，任何接口不回读明文）
db.exec(`CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  remark TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// 安全事件表（PII 命中 / 提示词注入检测）
db.exec(`CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  action TEXT DEFAULT '',
  source TEXT DEFAULT '',
  created_at TEXT
);`);
// 用户自有模型供应商表（2026-10-20 P3：用户自带 API Key 接入 OpenAI 兼容模型源，与平台供应商隔离，仅本人可见可用）
db.exec(`CREATE TABLE IF NOT EXISTS user_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  models TEXT DEFAULT '[]',
  status INTEGER DEFAULT 1,
  created_at TEXT
);`);
// 用户级工具 API Key 表（P3-2 2026-11-06 工具市场扩展：用户为需要鉴权的内置工具填自己的 Key，
// 如 weather_query 的和风天气、translate_text 的 DeepL。与 user_providers（模型源）语义分离；
// api_key 落盘 AES-256-GCM 加密（写入方 routes/tool-keys.js，读取方 lib/tools.js getUserToolKey），
// username+tool_name 唯一防重复登记；未配 Key 时工具走免费公共源兜底（企业内开箱即用）
db.exec(`CREATE TABLE IF NOT EXISTS user_tool_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  api_key TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status INTEGER DEFAULT 1,
  created_at TEXT,
  UNIQUE(username, tool_name)
);`);
// 技能资产表（2026-10-20 P3 技能资产化：可复用的「提示词+工具」组合，对话中 @技能名 调用；
// status=1 已发布（他人可见可引用），status=0 私有（仅本人）。owner+name 唯一防重名混淆）
// D1-4 可执行技能包（2026-11-21）：新增 manifest（入口/参数/权限/依赖规范）、version、runtime、
// source_url/package_hash/verified（安装来源与供应链校验）、enabled（启用开关）。
// manifest 为空 {} 时技能 = 纯提示词（向后兼容）；非空且含 entry 时技能可被沙箱执行。
db.exec(`CREATE TABLE IF NOT EXISTS skill_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon TEXT DEFAULT '✨',
  prompt TEXT DEFAULT '',
  tools TEXT DEFAULT '[]',
  status INTEGER DEFAULT 1,
  manifest TEXT DEFAULT '{}',
  runtime TEXT DEFAULT 'node',
  version TEXT DEFAULT '1.0.0',
  source_url TEXT DEFAULT '',
  package_hash TEXT DEFAULT '',
  verified INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at TEXT,
  UNIQUE(owner, name)
);`);
// D1-4 技能密钥表（按「用户 × 技能」隔离；值 AES-256-GCM 加密落盘，接口只回掩码，运行期解密注入沙箱；
// 与全局 secrets 表（管理员画布占位符）语义分离——这里每个用户为自己的技能配置各自的凭据）
db.exec(`CREATE TABLE IF NOT EXISTS skill_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  skill_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(owner, skill_id, name)
);`);
// D1-4 技能执行审计表（可执行技能每次沙箱运行落一行：状态/退出码/耗时/输出摘录；
// 与 sandbox_runs（通用沙箱审计）互补——本表带 skill_id 归属，供技能页「运行历史」与验收统计）
db.exec(`CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  exit_code INTEGER DEFAULT NULL,
  duration_ms INTEGER DEFAULT NULL,
  stdout_excerpt TEXT DEFAULT '',
  stderr_excerpt TEXT DEFAULT '',
  created_at TEXT
);`);
// === D2-1 代码索引与仓库语义检索（2026-11-21）===
// code_repos：登记的可检索代码仓库（服务器本地目录，root_path 为 realpath 后的绝对路径）
db.exec(`CREATE TABLE IF NOT EXISTS code_repos (
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
);`);
// code_index：按「函数/类」切片的索引块（chunk_kind：function/class/method/header/block）
db.exec(`CREATE TABLE IF NOT EXISTS code_index (
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
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_code_index_repo ON code_index (repo_id);`);
// code_patches：补丁提议（只读分析 → propose 生成 diff 待确认；apply 后才写盘）
db.exec(`CREATE TABLE IF NOT EXISTS code_patches (
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
);`);
// code_patch_backups：补丁应用前的原文备份（一键回滚用）
db.exec(`CREATE TABLE IF NOT EXISTS code_patch_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  file_path TEXT NOT NULL,
  patch_id INTEGER DEFAULT NULL,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at TEXT
);`);
// D2-2 计费用量感知闭环：billing_holds 预留/结算台账（预检 held → 结算 settled / 回滚 released / 拦截 blocked）
db.exec(`CREATE TABLE IF NOT EXISTS billing_holds (
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
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bh_user_status ON billing_holds(username, status);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bh_created ON billing_holds(created_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bh_status ON billing_holds(status);');

// D2-4 MCP 与连接器广场：服务凭据托管（AES-256-GCM 加密落盘，掩码回显，按服务隔离）
db.exec(`CREATE TABLE IF NOT EXISTS mcp_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_srv_name ON mcp_credentials(server_id, name);');

// 意见反馈表（2026-10-20 帮助体系）：用户提交 → 管理员处理（回复）→ 站内信闭环通知
// type: bug/suggest/consult；status: pending 待处理 / processed 已处理
db.exec(`CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  contact TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reply TEXT DEFAULT '',
  handler TEXT DEFAULT '',
  handled_at TEXT,
  created_at TEXT
);`);

// ---------------- P3 扩展迁移（2026-10-22）----------------
// ⑦ 分类器路由：agents.routing_mode（function 默认 function calling 编排 / classifier 分类器直达子智能体）
{
  const cols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  if (!cols.includes('routing_mode')) db.exec(`ALTER TABLE agents ADD COLUMN routing_mode TEXT DEFAULT 'function'`);
}
// ⑤ MCP Server：独立访问令牌（把已发布智能体暴露为 MCP 工具，Bearer 鉴权 + 调用计数）
db.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT DEFAULT '',
  status INTEGER DEFAULT 1,
  calls INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT
);`);
// P2-2 修复 2026-11-09：MCP 令牌作用域——agent_id 绑定单个智能体（NULL = 全域令牌，兼容存量）。
// 此前任一有效令牌可调用全部已发布智能体，一把泄露令牌 = 全平台智能体访问；
// 与 openapi.js 的 agent_api_keys 作用域校验（同日修复）对齐，堵齐两条对外链路。
{
  const mcpCols = db.prepare('PRAGMA table_info(mcp_tokens)').all().map(c => c.name);
  if (!mcpCols.includes('agent_id')) {
    db.exec('ALTER TABLE mcp_tokens ADD COLUMN agent_id INTEGER DEFAULT NULL');
    console.log('[db] mcp_tokens 表已迁移：新增 agent_id 字段（P2-2 令牌作用域）');
  }
}

// ---------------- P4 扩展迁移（2026-10-22）----------------
// 模型类型标注：providers.model_types 存 {模型名: chat/image/video/tts/embedding} 映射（后台展示与按类型校验；前台实时分类）
{
  const cols = db.prepare('PRAGMA table_info(providers)').all().map(c => c.name);
  if (!cols.includes('model_types')) db.exec(`ALTER TABLE providers ADD COLUMN model_types TEXT DEFAULT '{}'`);
}

// ---------------- P5.31 系统智能体：定时任务执行助手（幂等自种——存量库迁移补齐 + 新库种子；对话内
// create_task 未指定 agent_id 时绑定它；带联网检索/计算/Word 导出工具，定时任务具备真实执行能力）
// P5.34：按 system_key 稳定标识种子/查找（Y4 完整方案——agents.name 无唯一约束，
// 名称判断会被用户自建同名智能体劫持；system_key 带部分唯一索引） ----------------
{
  const SYS_TASK_AGENT = '定时任务执行助手';
  const SYS_TASK_KEY = 'system_task_runner';
  const exists = db.prepare('SELECT id FROM agents WHERE system_key=?').get(SYS_TASK_KEY);
  if (!exists) {
    db.prepare(`INSERT INTO agents
      (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,tools,status,source,source_name,system_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        SYS_TASK_AGENT, '系统内置执行引擎：对话中创建的定时任务默认由它执行（也可手动绑定）。按任务指令自主完成检索、计算与文档产出。',
        'digital', null, '系统',
        '你是定时任务执行助手，负责自主完成交给你的定时任务指令（如资讯监控、数据汇总、报告生成）。\n工作方式：\n1. 需要外部信息时必须调用 web_search / web_fetch 真实检索，禁止凭记忆编造；\n2. 涉及计算用 calculator 保证准确；\n3. 用户要报告/文档时用 export_word 生成可下载的 Word 交付；\n4. 输出结构化摘要（要点+来源），指明信息时效；\n5. 无法完成的步骤如实说明，不要虚构结果。',
        '', 0.3, 0, 2048, '', '[]', null,
        JSON.stringify(['web_search', 'web_fetch', 'get_datetime', 'calculator', 'export_word']),
        'published', 'self', '系统内置', SYS_TASK_KEY, now(), now());
    console.log('[db] 已种子系统智能体「' + SYS_TASK_AGENT + '」（system_key=' + SYS_TASK_KEY + '）');
  }
}

// ---------------- 种子数据（仅首次） ----------------
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  // P1-3 2026-11-09：种子账号全部使用弱口令（admin123/123456/demo123），显式打 must_change_pwd=1——
  // 弱口令扫描块位于建表迁移区（本行之前），首次启动时扫描先于种子执行扫不到这批账号；
  // 二次启动起由扫描块接管（改密后标记清除，重设弱口令会再次被标记，双路径闭环）
  const insUser = db.prepare('INSERT INTO users (username,password,nickname,role,dept,status,must_change_pwd,created_at) VALUES (?,?,?,?,?,1,1,?)');
  insUser.run('admin', hashPwd('admin123'), '管理员', 'admin', '信息部', daysAgo(30));
  insUser.run('zhangsan', hashPwd('123456'), '张三', 'user', '产品部', daysAgo(25));
  insUser.run('lisi', hashPwd('123456'), '李四', 'user', '研发部', daysAgo(20));
  insUser.run('wangwu', hashPwd('123456'), '王五', 'user', '市场部', daysAgo(12));
  insUser.run('demo', hashPwd('demo123'), '演示账号', 'user', '综合部', daysAgo(5));

  const insSpace = db.prepare('INSERT INTO spaces (name,type,owner,members,created_at) VALUES (?,?,?,?,?)');
  insSpace.run('企业空间', 'enterprise', 'admin', 5, daysAgo(30));
  insSpace.run('产品部空间', 'dept', '张三', 2, daysAgo(25));
  insSpace.run('研发部空间', 'dept', '李四', 1, daysAgo(22));
  insSpace.run('admin 的个人空间', 'personal', 'admin', 1, daysAgo(28));

  const insKb = db.prepare('INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES (?,?,1,?,?)');
  insKb.run('公司制度知识库', '考勤、报销、保密等公司制度文件', 'admin', daysAgo(28));
  insKb.run('产品手册知识库', '平台产品功能说明与常见问题', 'admin', daysAgo(20));
  const insKbFile = db.prepare('INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,?)');
  insKbFile.run(1, '员工考勤管理制度.txt', 2048, 'success', 3, daysAgo(28));
  insKbFile.run(1, '差旅报销管理办法.txt', 3072, 'success', 3, daysAgo(27));
  insKbFile.run(2, '平台功能介绍.md', 4096, 'success', 4, daysAgo(20));
  insKbFile.run(2, '常见问题FAQ.txt', 1536, 'success', 2, daysAgo(19));

  const insChunk = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)');
  const chunks = [
    [1, 1, '考勤制度：公司实行标准工时制，工作时间为周一至周五 9:00-18:00，其中 12:00-13:30 为午休时间。'],
    [1, 1, '迟到早退：月度累计迟到三次以内且每次不超过 30 分钟的，予以口头提醒；超过三次的，每次扣除绩效分 2 分。'],
    [1, 1, '请假流程：事假需提前一天在 OA 系统提交申请，病假需在返岗后两个工作日内补交证明，年假需提前三天申请。'],
    [2, 1, '差旅报销：员工出差需事先填写出差申请单，经部门负责人审批后方可出行。'],
    [2, 1, '报销标准：一线城市住宿上限 500 元/晚，其他城市 400 元/晚；市内交通实报实销，打车需注明事由。'],
    [2, 1, '报销时限：差旅费用需在返程后 15 个工作日内提交报销单，逾期财务部不再受理。'],
    [3, 2, '智能体平台提供前台与管理后台两部分：前台含首页对话、智能体、知识库、任务管理四大模块。'],
    [3, 2, '智能体分为企业智能体、数字员工、部门AI助理及其他类型，支持提示词、模型参数、开场白等完整配置。'],
    [3, 2, '知识库支持文件上传、分片解析与召回测试，可在对话中作为检索增强上下文使用。'],
    [3, 2, '任务管理支持对智能体创建立即执行或 Cron 定时执行的任务，并留存执行记录。'],
    [4, 2, '常见问题：如何创建智能体？进入前台「智能体」模块，切换到数字员工视图，点击新增智能体，按三步配置完成创建。'],
    [4, 2, '常见问题：忘记密码怎么办？请联系管理员在后台「用户管理」中重置密码。'],
  ];
  chunks.forEach(c => insChunk.run(...c));

  const insAgent = db.prepare(`INSERT INTO agents
    (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,source_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insAgent.run('公司制度问答助手', '解答考勤、报销、请假等公司制度问题', 'enterprise', 1, '工作',
    '你是公司制度问答助手。请严格根据知识库内容回答员工关于考勤、报销、请假等制度问题；知识库没有的内容请如实告知无法回答，不要编造。回答保持简洁、分点。',
    'qwen-plus', 0.3, 10, 1024, '您好，我是公司制度问答助手，可以解答考勤、报销、请假等制度问题，请问有什么可以帮您？',
    '["年假有多少天？","出差住宿报销标准是多少？","迟到会怎么处理？"]', 1, 'published', 'self', '', daysAgo(26), daysAgo(10));
  insAgent.run('产品客服助手', '介绍平台功能并解答使用问题', 'enterprise', 1, '工作',
    '你是平台产品客服助手，负责介绍智能体平台的功能与解答使用问题。回答基于知识库产品手册内容，语言亲切、分点清晰。',
    'qwen-plus', 0.5, 10, 1024, '您好！我是产品客服助手，有什么关于平台使用的问题都可以问我~',
    '["如何创建智能体？","知识库怎么用？","任务怎么定时执行？"]', 2, 'published', 'self', '', daysAgo(22), daysAgo(8));
  insAgent.run('智能翻译助手', '中英互译的专业翻译', 'enterprise', 1, '通用',
    '你是一位专业、精准的翻译助手。将用户输入的中文翻译成英文，或英文翻译成中文。译文需准确传达原意、表达自然流畅。只输出译文本身。',
    'qwen-max', 0.3, 10, 2048, '您好，请发送需要翻译的内容，我会为您在中英之间互译。', '[]', null, 'published', 'self', '', daysAgo(18), daysAgo(18));
  insAgent.run('营销文案大师', '生成营销推广文案与活动方案', 'enterprise', 1, '市场',
    '你是资深营销专家，擅长撰写营销文案、活动方案与推广策略。根据用户的产品或需求，输出有创意、有卖点的方案，结构化呈现。',
    'qwen-plus', 0.8, 10, 2048, '您好，告诉我您的产品或活动需求，我来帮您打造吸睛的营销文案！', '["帮我写一条朋友圈广告","新品发布会活动方案"]', null, 'published', 'self', '', daysAgo(15), daysAgo(15));
  insAgent.run('公文写作专家', '撰写通知、请示、纪要等公文', 'dept', 2, '办公',
    '你是公文写作专家，熟悉企业行政公文的规范格式。根据用户需求撰写通知、请示、会议纪要、通报等文体，格式规范、用语严谨。',
    'qwen-plus', 0.5, 10, 2048, '您好，我是公文写作专家，请告诉我需要撰写的公文类型和核心内容。', '[]', null, 'published', 'self', '', daysAgo(14), daysAgo(14));
  insAgent.run('代码评审助理', '审查代码并给出改进建议', 'digital', 3, '研发',
    '你是资深代码评审助理。用户粘贴代码后，你从可读性、健壮性、性能、安全四个维度给出评审意见和改进示例。',
    'qwen-coder-plus', 0.4, 10, 2048, '把需要评审的代码发给我吧，我会从多个维度给出建议。', '[]', null, 'published', 'self', '', daysAgo(10), daysAgo(10));
  insAgent.run('会议纪要整理员', '把会议记录整理成规范纪要', 'digital', null, '办公',
    '你是会议纪要整理员。用户输入会议速记或录音转写文字后，你整理为含「会议主题、参会人、决议事项、待办与负责人」的规范纪要。',
    'qwen-plus', 0.3, 10, 2048, '您好，把会议记录原文发给我，我来整理成规范纪要。', '[]', null, 'published', 'self', '', daysAgo(6), daysAgo(6));
  insAgent.run('周报生成器', '根据工作要点生成工作周报', 'digital', null, '办公',
    '你是周报生成器。用户输入本周工作要点后，你输出结构化周报，包含「本周完成、数据成果、问题与风险、下周计划」四部分。',
    'qwen-plus', 0.6, 10, 2048, '您好，列出本周的工作要点，我来帮您生成一份漂亮的工作周报。', '[]', null, 'published', 'self', '', daysAgo(3), daysAgo(3));
  insAgent.run('数据分析师', '解读数据并输出分析结论', 'digital', null, '数据',
    '你是数据分析专家。用户给出数据或业务问题后，你输出「数据概览、关键发现、原因分析、行动建议」四段式分析结论。',
    'qwen-max', 0.5, 10, 2048, '您好，把数据发给我，我来帮您做解读分析。', '[]', null, 'draft', 'self', '', daysAgo(1), daysAgo(1));
  insAgent.run('外部扣子智能体-天气查询', '经接入管理同步自外部平台', 'enterprise', 1, '生活',
    '天气查询智能体（示例：经第三方平台接入）', 'qwen-plus', 0.5, 10, 1024, '您好，请问想查询哪个城市的天气？', '[]', null, 'published', 'coze', '字节扣子团队版', daysAgo(9), daysAgo(9));

  const insTask = db.prepare('INSERT INTO tasks (name,target_type,target_id,exec_type,cron,params,enabled,last_run_at,last_result,created_at) VALUES (?,?,?,?,?,?,1,?,?,?)');
  insTask.run('每日晨间资讯摘要', 'agent', 2, 'cron', '0 9 * * *', JSON.stringify({ input: '请生成一份今日科技行业晨间资讯摘要。' }), daysAgo(1, 9, 0), 'success', daysAgo(12));
  insTask.run('每周市场舆情汇总', 'agent', 4, 'cron', '0 18 * * 5', JSON.stringify({ input: '请生成本周市场舆情汇总周报。' }), daysAgo(2, 18, 0), 'success', daysAgo(13));
  insTask.run('制度知识库巡检', 'agent', 1, 'once', null, JSON.stringify({ input: '请检查考勤制度中关于迟到处理的规定并复述要点。' }), daysAgo(0, 10, 30), 'success', daysAgo(11));

  const insProvider = db.prepare('INSERT INTO providers (name,base_url,api_key,models,configured,is_default,remark,created_at) VALUES (?,?,?,?,?,?,?,?)');
  insProvider.run('魔芋AI', '', '', '[]', 0, 0, '平台自营额度账户，可兑换或充值', daysAgo(29));
  insProvider.run('阿里百炼', 'https://dashscope.aliyuncs.com/compatible-mode', '',
    JSON.stringify(['qwen-plus', 'qwen-max', 'qwen-flash', 'qwen-turbo', 'qwen-coder-plus', 'text-embedding-v3']), 1, 1, '已配置 6 个模型；未填 API Key 时对话自动降级为模拟回复', daysAgo(28));
  insProvider.run('火山引擎', 'https://ark.cn-beijing.volces.com/api/v3', '',
    JSON.stringify(['doubao-seed-1-6-pro-32k', 'doubao-seed-1-6-flash-32k', 'doubao-embedding']), 1, 0, '已配置 3 个模型', daysAgo(24));
  insProvider.run('深度求索', 'https://api.deepseek.com', '', '[]', 0, 0, '待配置：填写 API Key 后可添加模型', daysAgo(24));
  insProvider.run('OpenAI', 'https://api.openai.com', '', '[]', 0, 0, '待配置：填写 API Key 后可添加模型', daysAgo(24));

  const insPlatform = db.prepare('INSERT INTO platforms (name,type,endpoint,token,build_url,status,synced,last_sync_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  // 修复（2026-10-20）：加 build_url 列时漏补 run 参数（9 列 8 参数），全新库首次建表会抛「参数不足」；生产库为增量升级未暴露
  insPlatform.run('字节扣子团队版', 'coze', 'https://api.coze.cn', '已配置', 'https://www.coze.cn/workbench', 2, 1, daysAgo(9), daysAgo(24));
  insPlatform.run('Dify 社区版', 'dify', 'https://dify.example.com/v1', '已配置', 'https://dify.example.com/apps', 0, 0, null, daysAgo(20));

  const insCate = db.prepare('INSERT INTO word_categories (name) VALUES (?)');
  insCate.run('涉黄词汇'); insCate.run('暴力词汇'); insCate.run('辱骂词汇');
  const insWord = db.prepare('INSERT INTO words (category_id,word,input_block,output_block,hit_count,created_at) VALUES (?,?,?,?,?,?)');
  insWord.run(1, '色情内容', 1, 1, 3, daysAgo(25));
  insWord.run(2, '砍死你', 1, 1, 1, daysAgo(25));
  insWord.run(3, '傻逼', 1, 1, 14, daysAgo(25));
  insWord.run(3, '滚蛋', 1, 0, 6, daysAgo(24));
  insWord.run(3, '废物', 0, 1, 2, daysAgo(24));

  // 历史会话与消息（近 7 天，供看板趋势/运营监控使用）
  const insSession = db.prepare('INSERT INTO sessions (agent_id,title,username,created_at,updated_at) VALUES (?,?,?,?,?)');
  const insMsg = db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)');
  const histUsers = ['admin', 'zhangsan', 'lisi', 'wangwu', 'demo'];
  const qaPairs = [
    ['年假有多少天？', '根据公司制度知识库：年假需提前三天申请。关于年假天数的具体规定，知识库暂未收录，建议咨询人力资源部。'],
    ['出差住宿报销标准是多少？', '根据《差旅报销管理办法》：一线城市住宿上限 500 元/晚，其他城市 400 元/晚。'],
    ['迟到会怎么处理？', '月度累计迟到三次以内且每次不超过 30 分钟，口头提醒；超过三次，每次扣除绩效分 2 分。'],
    ['帮我写一条新品咖啡的朋友圈文案', '☕ 新品上市 | 一口唤醒清晨\n甄选埃塞俄比亚原生豆，低温慢烘，果香入喉。\n今日下单立减 10 元，办公室摸鱼续命神器，冲！'],
    ['如何创建智能体？', '进入前台「智能体」模块 → 数字员工视图 → 点击新增智能体，依次完成基本配置、AI 模型配置、页面配置三步即可。'],
    ['把这段话翻译成英文：会议纪要已发送，请查收。', 'The meeting minutes have been sent. Please check.'],
    ['整理周报要点：完成登录改造、修复3个bug、上线活动页', '【本周完成】登录模块改造上线；修复 3 个线上缺陷；活动页面按期发布。\n【问题与风险】无重大风险。\n【下周计划】启动性能优化专项。'],
    ['知识库怎么用？', '在前台「知识库」模块创建知识库并上传文件，解析完成后可在召回测试中验证效果；智能体关联知识库后对话会自动检索增强。'],
  ];
  let qIdx = 0;
  for (let d = 7; d >= 1; d--) {
    const sessionsToday = 2 + ((d * 7) % 3); // 2~4 条/天
    for (let s = 0; s < sessionsToday; s++) {
      const [q, a] = qaPairs[qIdx++ % qaPairs.length];
      const u = histUsers[(d + s) % histUsers.length];
      const t = daysAgo(d, 9 + s * 2, (s * 17) % 60);
      const sid = insSession.run(1 + ((d + s) % 3), q.slice(0, 16), u, t, t).lastInsertRowid;
      insMsg.run(sid, 'user', q, Math.ceil(q.length * 0.6), t);
      insMsg.run(sid, 'assistant', a, Math.ceil(a.length * 0.6), t);
    }
  }

  const insOp = db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)');
  const opSeeds = [
    ['admin', '登录系统', '密码登录成功', '192.168.1.10'],
    ['admin', '创建智能体', '公司制度问答助手', '192.168.1.10'],
    ['admin', '发布智能体', '产品客服助手', '192.168.1.10'],
    ['zhangsan', '登录系统', '密码登录成功', '192.168.1.22'],
    ['zhangsan', '创建知识库', '产品手册知识库', '192.168.1.22'],
    ['lisi', '对话调用', '与 智能翻译助手 对话', '192.168.1.33'],
    ['admin', '配置模型供应商', '阿里百炼', '192.168.1.10'],
    ['admin', '新增敏感词', '傻逼', '192.168.1.10'],
    ['wangwu', '创建任务', '每日晨间资讯摘要', '192.168.1.44'],
  ];
  opSeeds.forEach((o, i) => insOp.run(...o, daysAgo(7 - i, 10 + i, (i * 13) % 60)));

  db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
    .run('chat-service', '模型调用超时（示例历史记录），已自动重试成功', daysAgo(3, 14, 22));
  db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
    .run('kb-parser', '文件解析失败：损坏的PDF（示例历史记录）', daysAgo(5, 16, 40));

  db.prepare('INSERT INTO evaluations (name,agent_id,rule_prompt,dataset,status,score,result,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    '制度问答准确性测评', 1,
    '若回答与参考答案语义一致得 1 分，答非所问或编造得 0 分，部分正确得 0.5 分。',
    JSON.stringify([
      { q: '一线城市住宿报销上限？', expect: '500元/晚' },
      { q: '年假怎么申请？', expect: '提前三天申请' },
    ]),
    'done', 100,
    JSON.stringify([{ q: '一线城市住宿报销上限？', got: '500 元/晚', score: 1 }, { q: '年假怎么申请？', got: '需提前三天在 OA 系统申请', score: 1 }]),
    daysAgo(2, 15, 0)
  );

  console.log('[db] 种子数据已初始化');
}

// ---------------- P5.17 工作流模板库（2026-10-26）----------------
// 画布工作流模板：预配置 workflow JSON + 场景说明，一键复用（广场展示 + 编排页导入/存为模板）
db.exec(`CREATE TABLE IF NOT EXISTS workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '🎨',
  category TEXT DEFAULT '通用',
  description TEXT DEFAULT '',
  scene TEXT DEFAULT '',
  workflow TEXT NOT NULL,
  builtin INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT
);`);
// 内置模板幂等 seed（slug 已存在跳过；用户后续可存自定义变体）
{
  const ins = db.prepare(`INSERT OR IGNORE INTO workflow_templates (slug,name,icon,category,description,scene,workflow,builtin,use_count,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,0,'platform',datetime('now','localtime'))`);
  for (const s of require('./lib/wf-template-seed').SEEDS) {
    ins.run(s.slug, s.name, s.icon, s.category, s.description, s.scene, JSON.stringify(s.workflow), 1);
  }
}

// P5.34b（审查建议）：存量清洗——agents/skill_assets 的 tools 中被注入的违禁工具（create_task/
// local_exec）一次性剔除（幂等：每次启动执行，无违禁项则无操作；新写入已被各入口白名单拦截，
// 此处清存量，防 @技能/@专家/copy 等旁路继续生效）。位置在全部建表之后（skill_assets 在前文创建）
{
  const { AGENT_TOOL_DENY } = require('./lib/tool-deny'); // 零依赖模块，避免 db ↔ tools 循环依赖
  const denyArr = [...AGENT_TOOL_DENY];
  if (denyArr.length) {
    let cleaned = 0;
    const rows = db.prepare(`SELECT id, tools FROM agents WHERE ${denyArr.map(() => "tools LIKE ?").join(' OR ')}`).all(...denyArr.map(w => `%"${w}"%`));
    for (const r of rows) {
      try {
        const ts = JSON.parse(r.tools || '[]').filter(t => !AGENT_TOOL_DENY.has(t));
        db.prepare('UPDATE agents SET tools=? WHERE id=?').run(JSON.stringify(ts), r.id);
        cleaned++;
      } catch { /* 脏数据跳过 */ }
    }
    const srows = db.prepare(`SELECT id, tools FROM skill_assets WHERE ${denyArr.map(() => "tools LIKE ?").join(' OR ')}`).all(...denyArr.map(w => `%"${w}"%`));
    for (const r of srows) {
      try {
        const ts = JSON.parse(r.tools || '[]').filter(t => !AGENT_TOOL_DENY.has(t));
        db.prepare('UPDATE skill_assets SET tools=? WHERE id=?').run(JSON.stringify(ts), r.id);
        cleaned++;
      } catch { /* 脏数据跳过 */ }
    }
    if (cleaned) console.log(`[db] 存量清洗：已从 ${cleaned} 条 agents/skill_assets 记录中剔除违禁工具（${denyArr.join('/')}）`);
  }
}

// ---------------- V2.4 #9 收尾（2026-11-02）：存量资源空间归属回填（幂等） ----------------
// 规则（只处理 space_id 为 NULL/0 的存量行，已有归属的行不动；位置在 seed 之后，新库种子一并归类）：
//   - 无 owner 或 owner=admin → 第一个企业空间（企业共享语义：配合 space-utils 的 enterprise 全员可见过滤，
//     回填前后普通用户可见性不收缩——admin/演示资源在企业空间仍全员可见）
//   - 其他 owner → 该用户的个人空间（个人空间=私有的目标租户语义）；无个人空间则保持无归属不强行归类
// 注：运行时创建的资源都带明确 space_id（个人空间 id 或 0=无归属），本块不会误改——仅当
//     「无个人空间用户故意写 0」且之后该用户获得个人空间的边缘场景会被归类为个人空间（符合租户化方向）。
{
  const ent = db.prepare("SELECT id FROM spaces WHERE type='enterprise' ORDER BY id LIMIT 1").get();
  if (ent) {
    const ra1 = db.prepare(`UPDATE agents SET space_id=? WHERE (space_id IS NULL OR space_id=0) AND (owner IS NULL OR owner='' OR owner='admin')`).run(ent.id);
    const ra2 = db.prepare(`UPDATE agents SET space_id=(SELECT s.id FROM spaces s WHERE s.type='personal' AND s.owner=agents.owner LIMIT 1)
      WHERE (space_id IS NULL OR space_id=0) AND owner IS NOT NULL AND owner!='admin'
        AND EXISTS (SELECT 1 FROM spaces s2 WHERE s2.type='personal' AND s2.owner=agents.owner)`).run();
    const rk1 = db.prepare(`UPDATE kbs SET space_id=? WHERE (space_id IS NULL OR space_id=0) AND (owner IS NULL OR owner='' OR owner='admin')`).run(ent.id);
    const rk2 = db.prepare(`UPDATE kbs SET space_id=(SELECT s.id FROM spaces s WHERE s.type='personal' AND s.owner=kbs.owner LIMIT 1)
      WHERE (space_id IS NULL OR space_id=0) AND owner IS NOT NULL AND owner!='admin'
        AND EXISTS (SELECT 1 FROM spaces s2 WHERE s2.type='personal' AND s2.owner=kbs.owner)`).run();
    const na = ra1.changes + ra2.changes, nk = rk1.changes + rk2.changes;
    if (na + nk > 0) console.log(`[db] V2.4 #9 存量空间归属回填：agents ${na} 行、kbs ${nk} 行（无主/admin→企业空间#${ent.id}，其余→个人空间）`);
  }
}

// ---------------- 热表索引（2026-10-28 DB 优化：补齐 6 张高频表二级索引 + agents 高频查询）----------------
// 幂等：IF NOT EXISTS 已存在则跳过；首次对存量数据建索引可能耗时数秒（WAL 下读不阻塞，但 better-sqlite3 同步会短暂冻结事件循环）
// 索引与 stats.js 聚合下推必须同批上线（WHERE created_at>=? 依赖 idx_messages_created 才能走范围扫，否则仍全表扫）
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_traces_msg ON chat_traces(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_traces_agent ON chat_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_file ON kb_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_kb_files_kb ON kb_files(kb_id, status);
CREATE INDEX IF NOT EXISTS idx_op_logs_created ON op_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_err_logs_created ON err_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username, updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_started ON task_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agents_status_pub ON agents(status) WHERE status='published';
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);
CREATE INDEX IF NOT EXISTS idx_agents_share_token ON agents(share_token) WHERE share_token != '';
CREATE INDEX IF NOT EXISTS idx_agents_source_ext ON agents(source, external_app_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_traces_session ON chat_traces(session_id);
CREATE TABLE IF NOT EXISTS token_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jti TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_blacklist_jti ON token_blacklist(jti);`);
// P0-5 2026-10-30 GraphRAG 知识图谱索引——实体表+关系表
db.exec(`CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- organization / person / geo / event / category / other
  description TEXT DEFAULT '',
  kb_ids TEXT DEFAULT '[]',        -- 关联的知识库 ID 列表 [1,2,3]
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS entity_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,          -- 关系类型（如「属于」「负责」「关联」等）
  weight REAL DEFAULT 1.0,        -- 关系强度权重
  source_chunk_ids TEXT DEFAULT '[]', -- 支撑此关系的事实来源分块 ID 列表
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_entity_name_type ON entities(name, type);`);

const tableEntities = 'entities';
const tableEntityRelations = 'entity_relations';

// ---------------- P1-6 会话检查点 v2（2026-11-12）：checkpoint 读写辅助 ----------------
// 语义：stream 生成中每 ~200 token 节流 UPSERT 当前快照；异常中断标记 aborted；
// 正常完成删除。前端发现 status != 'done' 的检查点时提示「继续生成」。
function upsertCheckpoint(sessionId, { userContent, partialContent, status, model }) {
  db.prepare(`INSERT INTO checkpoints (session_id, user_content, partial_content, status, model, created_at, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(session_id) DO UPDATE SET
      partial_content=excluded.partial_content, status=excluded.status,
      model=excluded.model, updated_at=datetime('now','localtime')`)
    .run(sessionId, userContent || '', partialContent || '', status || 'generating', model || '');
}
function getCheckpoint(sessionId) {
  return db.prepare('SELECT * FROM checkpoints WHERE session_id=?').get(sessionId);
}
function deleteCheckpoint(sessionId) {
  db.prepare('DELETE FROM checkpoints WHERE session_id=?').run(sessionId);
}

// U2-1 / N7-P3 读写分离：只读连接门面。未配置 AGENT_DB_READONLY（或副本缺失）时委托主库，行为等同现状。
// 用法：const { dbRead } = require('./db'); dbRead.prepare('SELECT ...').all()  —— 仅用于允许轻微延迟的只读查询。
const dbRead = new Proxy({}, {
  get(_t, prop) {
    const target = require('./lib/db-read').getReadDb(db);
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});
module.exports = { db, dbRead, hashPwd, hashPwdAsync, verifyPwd, now, daysAgo, tableEntities, tableEntityRelations, upsertCheckpoint, getCheckpoint, deleteCheckpoint };

// ---------- P1-4 修复 2026-11-09：ENCRYPTION_KEY 自动初始化（secrets 表建表后幂等注入） ----------
// 若 secrets 表中尚无 ENCRYPTION_KEY，自动生成 32 字节（64 hex）随机密钥写入。
// 确保 encrypt() 始终有密钥可用——此前需管理员手动配置，缺省时 encrypt() 返回明文导致 API Key 明文落盘。
// 仅当 secrets 表已创建且存在 name='ENCRYPTION_KEY' 的行时才视为已配置。
{
  try {
    const row = db.prepare("SELECT value FROM secrets WHERE name='ENCRYPTION_KEY'").pluck().get();
    if (!row || row.length !== 64) {
      const key = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT OR REPLACE INTO secrets (name,value,remark,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run('ENCRYPTION_KEY', key, 'AES-256-GCM 加密密钥（首次启动自动生成）', now(), now());
      console.log('[db] 已自动初始化 ENCRYPTION_KEY（AES-256-GCM 加密密钥）');
    }
  } catch (e) {
    // secrets 表不存在时跳过（保守兜底，release 构建一定有该表）
    console.warn('[db] ENCRYPTION_KEY 自动初始化跳过（secrets 表不可用）:', e.message);
  }
}

// ---------- V2.4 #4 收尾：providers/usermodels api_key 加密迁移（幂等） ----------
// 启动时扫描明文 Key 自动加密成 iv.authTag.ciphertext 格式。加密密钥未配置时不动。
// P1-1 修复 2026-11-04：本块必须位于 module.exports 赋值之后——crypto-util 已改为惰性 require('../db')，
// 迁移块执行时（模块加载中）require 返回缓存中已赋值的 exports → encrypt 内 db 可用；
// 此前块在 exports 之前 + crypto-util 顶层解构，构成加载期循环依赖（db 恒 undefined，
// secrets 用例 upsert→encrypt→db.prepare 崩溃中断整个测试套件）。
// P3-2 修复 2026-11-06：存量迁移此前只扫 providers 与 usermodels（老表名，现库已不存在），
// 漏了实际建表的 user_providers / user_tool_keys —— 统一改为按表名清单循环扫描（幂等）。
{
  let n = 0, m = 0;
  try {
    const { encrypt } = require('./lib/crypto-util');
    const rows = db.prepare("SELECT id, api_key FROM providers WHERE api_key!='' AND instr(api_key,'.')=0").all();
    for (const r of rows) { const enc = encrypt(r.api_key); if (enc !== r.api_key) { db.prepare('UPDATE providers SET api_key=? WHERE id=?').run(enc, r.id); n++; } }
    // 用户级 key 表（表存在性防御：老库无对应表时跳过该段；明文判定 = 无 '.' 分隔符）
    for (const t of ['usermodels', 'user_providers', 'user_tool_keys']) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue;
      const urows = db.prepare(`SELECT id, api_key FROM ${t} WHERE api_key!='' AND instr(api_key,'.')=0`).all();
      for (const r of urows) { const enc = encrypt(r.api_key); if (enc !== r.api_key) { db.prepare(`UPDATE ${t} SET api_key=? WHERE id=?`).run(enc, r.id); m++; } }
    }
  } catch (e) { console.error('[db] api_key 加密迁移异常（兜底：不加密）:', e.message); }
  if (n + m) console.log(`[db] 存量 api_key 加密迁移：providers ${n} 行、用户级表 ${m} 行（AES-256-GCM）`);
}

// ---------------- P5.27 本地桥设备与任务队列（2026-10-27）----------------
// 轮询模式：网页对话发 local_exec → 任务入队 → 本地桥 daemon poll 拉取执行 → result 回推
db.exec(`CREATE TABLE IF NOT EXISTS localbridge_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,            -- 配对绑定的平台用户
  device_token TEXT NOT NULL UNIQUE, -- 桥端生成的 32hex 随机令牌（claim 时由配对码换绑）
  device_name TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  is_default INTEGER DEFAULT 1,      -- 首台绑定为默认设备；多台后续可切换
  last_seen TEXT,                    -- 心跳/poll 时间（在线判定）
  created_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS localbridge_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  op TEXT NOT NULL,                  -- mkdir / list_dir / open_app / notify（桥端白名单强制）
  params TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',     -- pending → running → done / failed
  result TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);

// ================== U2-4 Phase 2 端侧指令闭环：localbridge_tasks 加 channel_msg_id ==================
{
  try {
    const lbtCols = db.prepare('PRAGMA table_info(localbridge_tasks)').all().map(c => c.name);
    if (!lbtCols.includes('channel_msg_id')) {
      db.exec('ALTER TABLE localbridge_tasks ADD COLUMN channel_msg_id INTEGER DEFAULT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_lbt_channel_msg ON localbridge_tasks(channel_msg_id);');
      console.log('[db] localbridge_tasks 表已迁移：新增 channel_msg_id 字段（U2-4 Phase 2）');
    }
  } catch (e) { console.error('[db] U2-4 迁移失败（不阻塞）：', e.message); }
}

// ================== N6 / U2-4 端侧网关微信远控：localbridge_devices 加高危开关 ==================
// 服务端高危 op 总闸（键鼠/clipboard_write/file_write）；与桥端开关构成双层。默认关闭。
{
  try {
    const devCols = db.prepare('PRAGMA table_info(localbridge_devices)').all().map(c => c.name);
    if (!devCols.includes('allow_high_risk')) {
      db.exec('ALTER TABLE localbridge_devices ADD COLUMN allow_high_risk INTEGER DEFAULT 0');
      console.log('[db] localbridge_devices 表已迁移：新增 allow_high_risk 字段（N6/U2-4）');
    }
  } catch (e) { console.error('[db] N6/U2-4 迁移失败（不阻塞）：', e.message); }
}

// ================== D1-1 端侧执行 V1：三档权限 + 写前备份/回滚 ==================
// permission_tier：设备级能力上限（readonly < standard < full），默认 standard（与既有可用能力对齐）。
// localbridge_backups：写操作（file_write/file_patch）自动备份台账 + 回滚状态，供「事后改动清单/一键回滚」。
{
  try {
    const devCols = db.prepare('PRAGMA table_info(localbridge_devices)').all().map(c => c.name);
    if (!devCols.includes('permission_tier')) {
      db.exec("ALTER TABLE localbridge_devices ADD COLUMN permission_tier TEXT DEFAULT 'standard'");
      console.log('[db] localbridge_devices 表已迁移：新增 permission_tier 字段（D1-1）');
    }
  } catch (e) { console.error('[db] D1-1 迁移失败（不阻塞）：', e.message); }
}
db.exec(`CREATE TABLE IF NOT EXISTS localbridge_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  task_id INTEGER,                  -- 触发的 localbridge_tasks.id（回滚任务本身可为空）
  op TEXT DEFAULT '',               -- 触发备份的写操作（file_write / file_patch / file_backup）
  path TEXT DEFAULT '',             -- 被改动文件（相对用户主目录）
  backup_id TEXT DEFAULT '',        -- 桥端备份标识（用于 file_restore 定位备份文件）
  change TEXT DEFAULT '',           -- created / modified
  before_bytes INTEGER DEFAULT 0,
  after_bytes INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',     -- active（可回滚）/ restored（已回滚）
  created_at TEXT,
  restored_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_lb_backups_dev ON localbridge_backups(device_id, created_at);');

// ================== D2-3 桌面端升级通道 V1（2026-11-21）==================
// bridge_releases：客户端发布清单（同一版本可多平台/架构/通道），服务端据此给出「是否有新版」。
// bridge_updates ：每次更新尝试的台账（成功/失败/回滚），用于更新成功率（验收 ≥ 95%）。
// bridge_crashes ：客户端崩溃上报（含启动失败），用于崩溃率（验收 < 0.5%）。
db.exec(`CREATE TABLE IF NOT EXISTS bridge_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,            -- 规范化版本号（1.2.3）
  platform TEXT DEFAULT 'any',      -- darwin / win32 / any
  arch TEXT DEFAULT 'any',          -- x64 / arm64 / any
  channel TEXT DEFAULT 'stable',    -- stable / beta
  file_name TEXT DEFAULT '',        -- 平台端文件名（public/downloads 下或 release 目录）
  sha256 TEXT DEFAULT '',           -- 包完整性校验值（下载后客户端校验）
  size INTEGER DEFAULT 0,           -- 字节数
  notes TEXT DEFAULT '',            -- 更新说明（Markdown 纯文本）
  mandatory INTEGER DEFAULT 0,      -- 是否强制升级
  min_version TEXT DEFAULT '',      -- 低于此版本的客户端强制升级
  status TEXT DEFAULT 'active',     -- active / archived
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_br_rel_pick ON bridge_releases(platform, arch, channel, status);');
db.exec(`CREATE TABLE IF NOT EXISTS bridge_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,                -- localbridge_devices.id（可为空：未配对设备也上报）
  username TEXT DEFAULT '',
  from_version TEXT DEFAULT '',
  to_version TEXT DEFAULT '',
  channel TEXT DEFAULT 'stable',
  status TEXT DEFAULT 'success',    -- success / failed / rollback
  error TEXT DEFAULT '',            -- 失败/回滚原因摘要
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bu_created ON bridge_updates(created_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bu_device ON bridge_updates(device_id);');
db.exec(`CREATE TABLE IF NOT EXISTS bridge_crashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  username TEXT DEFAULT '',
  version TEXT DEFAULT '',          -- 崩溃时客户端版本
  kind TEXT DEFAULT 'runtime',      -- startup / runtime / unhandled
  message TEXT DEFAULT '',
  stack TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bc_created ON bridge_crashes(created_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bc_device ON bridge_crashes(device_id);');

// ---------------- P1-4 分层记忆v1：agent_memories 增加 type/confidence/source/summary 字段（2026-11-11）----------------
{
  const cols = db.prepare('PRAGMA table_info(agent_memories)').all().map(r => r.name);
  if (!cols.includes('type')) db.exec("ALTER TABLE agent_memories ADD COLUMN type TEXT DEFAULT 'fact'");
  if (!cols.includes('confidence')) db.exec("ALTER TABLE agent_memories ADD COLUMN confidence REAL DEFAULT 1.0");
  if (!cols.includes('source')) db.exec("ALTER TABLE agent_memories ADD COLUMN source TEXT DEFAULT 'chat'");
  if (!cols.includes('summary')) db.exec("ALTER TABLE agent_memories ADD COLUMN summary TEXT DEFAULT ''");
  if (!cols.includes('summary_source')) db.exec("ALTER TABLE agent_memories ADD COLUMN summary_source TEXT DEFAULT ''");
}


// ---------------- P1-1 SSO 单点登录表（2026-11-11）----------------
db.exec(`CREATE TABLE IF NOT EXISTS sso_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  issuer TEXT DEFAULT '',
  client_id TEXT DEFAULT '',
  client_secret TEXT DEFAULT '',
  authorization_url TEXT DEFAULT '',
  token_url TEXT DEFAULT '',
  userinfo_url TEXT DEFAULT '',
  scopes TEXT DEFAULT '',
  jwt_bind_mode INTEGER DEFAULT 1,
  allow_local_login INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS sso_login_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL UNIQUE,
  nonce TEXT DEFAULT '',
  type TEXT DEFAULT 'oidc',
  provider_id INTEGER,
  redirect_uri TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS user_sso_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  external_username TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  expires_at TEXT DEFAULT '',
  last_login TEXT,
  created_at TEXT,
  UNIQUE(provider, subject)
);`);

// ---------------- P1-2 登录失败计数与锁定（2026-11-11）----------------
db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT DEFAULT '',
  attempts INTEGER DEFAULT 1,
  last_attempt TEXT,
  locked_until TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);`);

// ---------------- P1-3 邀请注册表（2026-11-11）----------------
db.exec(`CREATE TABLE IF NOT EXISTS invited_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_code TEXT NOT NULL UNIQUE,
  role TEXT DEFAULT 'user',
  dept TEXT DEFAULT '',
  quota_total INTEGER DEFAULT 0,
  max_use INTEGER DEFAULT 1,
  use_count INTEGER DEFAULT 0,
  expires_at TEXT,
  created_by TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS invite_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  ip TEXT DEFAULT '',
  created_at TEXT
);`);

// ---------------- P1-8 channels 表（2026-11-12）：渠道注册/配置加密/启停/回调状态 ----------------
// 渠道适配层（P1-7 lib/channel.js）的持久化地基——把渠道配置从散落的 secrets 键升级为可管理表结构
//   type：dingtalk / wecom / feishu / telegram / discord / mqtt / webhook（扩展即加枚举）
//   config：JSON 密文（AES-256-GCM；存凭证字段如 appKey/appSecret/agentId）
//   callback_status：ok / warning / error / pending；callback_last_at 最近回调时间
//   callback_err：最近回调错误摘要（排障用）
db.exec(`CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'webhook',
  config TEXT DEFAULT '',          -- JSON 密文（加密失败兜底明文，与 crypto-util 约定一致）
  enabled INTEGER DEFAULT 1,
  callback_status TEXT DEFAULT 'pending',
  callback_last_at TEXT DEFAULT '',
  callback_err TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// connector_oauth_states：IM 渠道 OAuth 连接流程的 state 防重放/续程表
//   （对应 P1-9 第二 IM 渠道接入时使用；state 一次性消费 + 过期清理）
db.exec(`CREATE TABLE IF NOT EXISTS connector_oauth_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL UNIQUE,
  channel_id INTEGER,
  redirect_uri TEXT DEFAULT '',
  username TEXT DEFAULT '',
  expires_at TEXT,
  consumed INTEGER DEFAULT 0,
  created_at TEXT
);`);

// ---------------- P1-10 群上下文（2026-11-12）：群聊绑定 + 成员白名单 ----------------
// channel_bound_chats：渠道群/会话 ↔ 平台智能体绑定（@机器人或群里发消息 → 路由到绑定的 agent）
//   chat_key 归一化：{channel}:{chat_id}（如 feishu:oc-abc123）；bind_mode 即 P1-10 白名单模式
db.exec(`CREATE TABLE IF NOT EXISTS channel_bound_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  chat_key TEXT NOT NULL UNIQUE,     -- '{channel}:{chat_id}'
  chat_name TEXT DEFAULT '',
  agent_id INTEGER,                  -- 绑定的智能体（@机器人命中后由它回答）
  bind_mode TEXT DEFAULT 'all',      -- all=全员可用 / whitelist=白名单 / admin=仅管理员
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// chat_whitelist：白名单成员（bind_mode=whitelist 时生效；channel 侧用户标识）
db.exec(`CREATE TABLE IF NOT EXISTS chat_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bind_id INTEGER NOT NULL,          -- FK → channel_bound_chats.id（删除绑定级联）
  sender_id TEXT NOT NULL,           -- 渠道侧用户标识（如飞书 open_id）
  sender_name TEXT DEFAULT '',
  created_at TEXT,
  UNIQUE(bind_id, sender_id)
);`);

// ---------------- P1-11~14 沙箱执行子线（2026-11-12） ----------------
// P1-12 远程主机登记：SSH 白名单主体——未登记主机一律拒绝执行；
// credential 为 AES-256-GCM 密文（密码或私钥）；known_hosts_mode：
//   strict=指纹必须匹配 / accept-new=首次记录（TOFU）/ off=不校验（不推荐）
db.exec(`CREATE TABLE IF NOT EXISTS remote_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 22,
  username TEXT DEFAULT '',
  credential TEXT DEFAULT '',          -- 密文：password 或 private key
  credential_type TEXT DEFAULT 'password',  -- password | key
  fingerprint TEXT DEFAULT '',         -- 预登记主机指纹（known_hosts 校验）
  known_hosts_mode TEXT DEFAULT 'strict',
  docker_enabled INTEGER DEFAULT 0,    -- 可选：Docker 容器内执行
  enabled INTEGER DEFAULT 1,
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
// P1-13 运行环境实例：每次沙箱/远程执行的审计记录（环境/归属/状态/版本/产物）
db.exec(`CREATE TABLE IF NOT EXISTS sandbox_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_env TEXT DEFAULT 'local-process',  -- local-vm | local-process | remote-ssh | docker
  owner TEXT DEFAULT '',                 -- 发起用户
  agent_id INTEGER,
  session_id INTEGER,
  status TEXT DEFAULT 'running',         -- running | success | failed | timeout | denied
  exit_code INTEGER,
  duration_ms INTEGER DEFAULT 0,
  node_version TEXT DEFAULT '',          -- 运行环境版本（process.versions.node / ssh 目标标识）
  code_digest TEXT DEFAULT '',           -- 代码指纹（sha256 前 16 位，审计比对用）
  artifacts TEXT DEFAULT '[]',           -- 产物清单 JSON [{name,size,url}]
  stdout_excerpt TEXT DEFAULT '',
  stderr_excerpt TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sandbox_runs_owner ON sandbox_runs(owner, id);');
// P1-14 HITL 五态审批：pending → approved | rejected | expired；批准且执行完 → executed
db.exec(`CREATE TABLE IF NOT EXISTS tool_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  confirm_key TEXT NOT NULL,
  tool_name TEXT DEFAULT '',
  args_json TEXT DEFAULT '',
  requester TEXT DEFAULT '',             -- 发起对话的用户
  approver TEXT DEFAULT '',              -- 实际点击批准/拒绝的人（记录审批与决策）
  status TEXT DEFAULT 'pending',         -- pending | approved | rejected | expired | executed
  decision_at TEXT,
  reason TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_approvals(status, id);');

// U0-5 R2 用户↔渠道身份映射：HITL 主动推送审批卡时据此定位「推给哪个渠道的谁」
// 一个平台用户可在多个渠道各有一个收件身份（UNIQUE(username, channel_id)）
db.exec(`CREATE TABLE IF NOT EXISTS user_channel_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,                 -- 平台用户名（HITL 发起人）
  channel_id INTEGER NOT NULL,            -- FK → channels.id
  channel_user_id TEXT NOT NULL,          -- 渠道侧标识（钉钉 userid / 飞书 open_id / 企微 UserID）
  channel_user_name TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(username, channel_id)
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_channel_bindings_user ON user_channel_bindings(username);');

// ================== P2-1 协作房间（2026-11-13）==================

// 房间表
db.exec(`CREATE TABLE IF NOT EXISTS collab_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  room_type TEXT DEFAULT 'collab',   -- collab | huddle（协作 / 快闪）
  host TEXT NOT NULL DEFAULT '',      -- 主持人 username
  model TEXT DEFAULT '',              -- 房间默认模型
  status TEXT DEFAULT 'active',       -- active | archived | closed
  settings TEXT DEFAULT '{}',         -- JSON：允许@所有人/允许撤回/自动AI加入等
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT
);`);

// 成员表
db.exec(`CREATE TABLE IF NOT EXISTS collab_room_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'member',         -- host | admin | member | viewer
  nickname TEXT DEFAULT '',
  joined_at TEXT,
  left_at TEXT,
  status TEXT DEFAULT 'active'        -- active | left | kicked
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_crm_room ON collab_room_members(room_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_crm_user ON collab_room_members(username);');

// AI 参与者表（智能体作为协作者加入）
db.exec(`CREATE TABLE IF NOT EXISTS collab_ai_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  role TEXT DEFAULT 'collaborator',   -- lead | collaborator | watcher
  instruction TEXT DEFAULT '',        -- 该AI在此房间的角色提示
  status TEXT DEFAULT 'active',       -- active | paused | removed
  added_by TEXT DEFAULT '',
  added_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_cap_room ON collab_ai_participants(room_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_cap_agent ON collab_ai_participants(agent_id);');

// 房间消息表
db.exec(`CREATE TABLE IF NOT EXISTS collab_room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  parent_id INTEGER DEFAULT NULL,     -- 回复目标消息ID（线程/回复）
  sender TEXT NOT NULL DEFAULT '',     -- username 或 'agent:{$agentId}'
  role TEXT DEFAULT 'user',           -- user | ai | system
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT DEFAULT '[]',      -- JSON：附件列表[{name,url,type}]
  msg_type TEXT DEFAULT 'text',       -- text | system | task | image | file
  meta TEXT DEFAULT '{}',             -- JSON：来源/模型等扩展字段
  recalled INTEGER DEFAULT 0,         -- 1=已撤回（软删除）
  hidden_for TEXT DEFAULT '[]',       -- ['userA','userB'] 特定成员隐藏
  read_by TEXT DEFAULT '[]',          -- ['userA','userB'] 已读用户
  edited_at TEXT,
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_crm_msg_room ON collab_room_messages(room_id, id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_crm_msg_parent ON collab_room_messages(parent_id);');

// 邀请表
db.exec(`CREATE TABLE IF NOT EXISTS collab_room_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  target_username TEXT DEFAULT '',     -- 空=公开邀请；非空=定向邀请
  role TEXT DEFAULT 'member',         -- 受邀请将成为的角色
  max_use INTEGER DEFAULT 0,          -- 0=无限
  use_count INTEGER DEFAULT 0,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_cri_code ON collab_room_invites(invite_code);');

console.log('[db] 创建 collab 协作协作表（P2-1 协作房间）');

// P2-2 任务分解表
db.exec(`CREATE TABLE IF NOT EXISTS collab_room_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  parent_id INTEGER DEFAULT NULL,     -- 父任务 ID（子任务分解）
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  assignee TEXT DEFAULT '',            -- 负责人（username 或 agent_id 字符串）
  assignee_type TEXT DEFAULT 'human',  -- human | ai
  deps TEXT DEFAULT '[]',             -- 依赖任务 ID 列表 JSON
  status TEXT DEFAULT 'pending',       -- pending | assigned | running | done | cancelled
  result TEXT DEFAULT '',              -- 执行结果摘要
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_crt_room ON collab_room_tasks(room_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_crt_parent ON collab_room_tasks(parent_id);');
console.log('[db] 创建 collab_room_tasks 表（P2-2 任务分解）');

// ================== P2-4 专家目录 / P2-5 子智能体库 / P2-7 插件体系（2026-11-13）==================

// P2-4 专家目录表：每个专家一条 manifest
db.exec(`CREATE TABLE IF NOT EXISTS expert_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER DEFAULT NULL UNIQUE,  -- 可空，未关联智能体时可先创建专家目录
  identifier TEXT NOT NULL UNIQUE,       -- 英文标识（如 'legal-counsel'）
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  description_zh TEXT DEFAULT '',
  description_en TEXT DEFAULT '',
  welcome TEXT DEFAULT '',               -- 欢迎语
  icon TEXT DEFAULT '🤖',
  color TEXT DEFAULT '#818cf8',          -- 配色（主题色）
  category TEXT DEFAULT '',              -- 业务域（engineering/legal/finance/marketing/test/ops）
  tags TEXT DEFAULT '[]',                -- 标签 JSON
  prompt TEXT DEFAULT '',                 -- 核心提示词（来源于 agents.prompt）
  version INTEGER DEFAULT 1,             -- 版本号
  status TEXT DEFAULT 'draft',           -- draft | published | deprecated
  published_by TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ec_category ON expert_catalog(category);');
db.exec('CREATE INDEX IF NOT EXISTS idx_ec_idfr ON expert_catalog(identifier);');

// P2-5 子智能体库：按业务域分类的预配置智能体
db.exec(`CREATE TABLE IF NOT EXISTS sub_agent_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  description_zh TEXT DEFAULT '',
  description_en TEXT DEFAULT '',
  prompt TEXT DEFAULT '',                -- 子智能体提示词
  tools TEXT DEFAULT '[]',               -- 授权工具名列表
  model_recommend TEXT DEFAULT '',       -- 推荐模型
  category TEXT DEFAULT '',              -- 业务域
  icon TEXT DEFAULT '🧩',
  agent_id INTEGER DEFAULT NULL,         -- 已挂载的智能体 ID（null=未挂载）
  status TEXT DEFAULT 'active',          -- active | archived
  source TEXT DEFAULT 'builtin',         -- builtin | custom | market
  version INTEGER DEFAULT 1,
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sal_cat ON sub_agent_library(category);');

// P2-7 插件注册表
db.exec(`CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL UNIQUE,         -- 唯一插件 ID（如 'code-runner.v2'）
  name TEXT NOT NULL DEFAULT '',
  name_en TEXT DEFAULT '',
  type TEXT DEFAULT 'tool',              -- tool | skill | trigger | event
  entry TEXT DEFAULT '',                 -- 入口文件或 URL
  icon TEXT DEFAULT '🧩',
  description TEXT DEFAULT '',
  version TEXT DEFAULT '1.0.0',
  author TEXT DEFAULT '',
  homepage TEXT DEFAULT '',
  runtime TEXT DEFAULT 'node',           -- node | python | container
  settings_schema TEXT DEFAULT '{}',     -- JSON schema 配置面板
  enabled INTEGER DEFAULT 0,             -- 启用/停用
  installed_by TEXT DEFAULT '',
  installed_at TEXT,
  updated_at TEXT
);`);

// P2-8 市场对接：远程 Hub 配置表
db.exec(`CREATE TABLE IF NOT EXISTS market_hubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'skill',             -- skill | expert | plugin | agent
  enabled INTEGER DEFAULT 1,
  last_sync_at TEXT,
  sync_status TEXT DEFAULT 'never',      -- never | syncing | success | failed
  created_at TEXT,
  updated_at TEXT
);`);
console.log('[db] 创建 expert_catalog/sub_agent_library/plugins/market_hubs 表（P2-4~8 资产目录）');

// ================== P2-9 模型能力注册表（2026-11-13）==================
db.exec(`CREATE TABLE IF NOT EXISTS model_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,              -- 模型名
  provider_name TEXT NOT NULL DEFAULT '', -- 供应商名（空=全局注册，适用于所有供应商的同名模型）
  capability TEXT NOT NULL,              -- 能力标签：text | vision | audio | embedding | rerank | image_gen | video_gen | tool_call | streaming
  priority INTEGER DEFAULT 0,            -- 同模型多能力时的优先级
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mc_model ON model_capabilities(model_name);');
db.exec('CREATE INDEX IF NOT EXISTS idx_mc_cap ON model_capabilities(capability);');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_unique ON model_capabilities(model_name, provider_name, capability);');

// P2-10 供应商鉴权配置列扩充（2026-11-13）
// auth_type: bearer | aksk | oauth | custom
// auth_config: JSON（aksk 存 {access_key,secret_key}；oauth 存 {client_id,client_secret,token_url}；custom 存 {headers:{}}）
// status: 连接状态 1=正常 0=异常（连通测试结果）
{
  const pCols = db.prepare('PRAGMA table_info(providers)').all().map(c => c.name);
  if (!pCols.includes('auth_type')) {
    db.exec("ALTER TABLE providers ADD COLUMN auth_type TEXT DEFAULT 'bearer'");
    db.exec("ALTER TABLE providers ADD COLUMN auth_config TEXT DEFAULT '{}'");
    db.exec("ALTER TABLE providers ADD COLUMN status INTEGER DEFAULT 1");
    db.exec("ALTER TABLE providers ADD COLUMN status_msg TEXT DEFAULT ''");
    console.log('[db] providers 表已迁移：新增 auth_type/auth_config/status/status_msg 字段（P2-10 鉴权多样性）');
  }
}

// ================== P2-11 用量归集表（2026-11-13）==================
// 按维度分解的每次用量记录（对话/工具/召回/分享/OpenAPI）
// dimension: model | tool | kb | share | openapi
db.exec(`CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL,               -- model | tool | kb | share | openapi
  dimension_key TEXT NOT NULL DEFAULT '', -- 模型名 | 工具名 | 知识库名 | 分享token | 路由名
  tokens INTEGER DEFAULT 0,              -- 对话 tokens 消耗（非模型维度可为 0）
  count INTEGER DEFAULT 1,               -- 调用次数
  cost REAL DEFAULT 0.0,                -- 成本估算（元）
  meta TEXT DEFAULT '{}',                 -- JSON：额外维度信息
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ur_user ON usage_records(username);');
db.exec('CREATE INDEX IF NOT EXISTS idx_ur_dim ON usage_records(dimension);');
db.exec('CREATE INDEX IF NOT EXISTS idx_ur_day ON usage_records(created_at);');
console.log('[db] 创建 model_capabilities/usage_records 表 + providers 扩充列（P2-9~11 模型能力/鉴权/用量）');

// ================== U1-6 成本归因与精细计费（2026-11-16）==================
// providers.model_price：模型单价表 JSON，形如 {"deepseek-chat":{"input":0.001,"output":0.002}}（单位：元/千 Token）
// usage_records 扩列：prompt_tokens/completion_tokens（拆分计费基数）、dept_id（写时部门快照，按部门归因聚合）
// departments 扩列：monthly_budget（月度预算元，0=不设预算不告警）、budget_alert_level（已提醒档位 0/1/2，仿 users.quota_alert_level 防轰炸）
{
  try {
    const pvCols = db.prepare('PRAGMA table_info(providers)').all().map(c => c.name);
    if (!pvCols.includes('model_price')) {
      db.exec("ALTER TABLE providers ADD COLUMN model_price TEXT DEFAULT '{}'");
      console.log('[db] providers 表已迁移：新增 model_price 字段（U1-6 模型单价表）');
    }
    const urCols = db.prepare('PRAGMA table_info(usage_records)').all().map(c => c.name);
    if (!urCols.includes('prompt_tokens')) db.exec('ALTER TABLE usage_records ADD COLUMN prompt_tokens INTEGER DEFAULT 0');
    if (!urCols.includes('completion_tokens')) db.exec('ALTER TABLE usage_records ADD COLUMN completion_tokens INTEGER DEFAULT 0');
    if (!urCols.includes('dept_id')) {
      db.exec('ALTER TABLE usage_records ADD COLUMN dept_id INTEGER DEFAULT NULL');
      console.log('[db] usage_records 表已迁移：新增 prompt_tokens/completion_tokens/dept_id 字段（U1-6 精细计费）');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ur_dept ON usage_records(dept_id);');
    const dpCols = db.prepare('PRAGMA table_info(departments)').all().map(c => c.name);
    if (!dpCols.includes('monthly_budget')) {
      db.exec('ALTER TABLE departments ADD COLUMN monthly_budget REAL DEFAULT 0');
      db.exec('ALTER TABLE departments ADD COLUMN budget_alert_level INTEGER DEFAULT 0');
      console.log('[db] departments 表已迁移：新增 monthly_budget/budget_alert_level 字段（U1-6 部门预算告警）');
    }
  } catch (e) { console.error('[db] U1-6 成本计费迁移失败（不阻塞启动）：', e.message); }
}

// ================== U1-7 画布多人实时协作（2026-11-16）==================
// collab_rooms.agent_id：画布协作房间与智能体（及其 workflow 画布）的绑定；
// 房间成员模型（collab_room_members）复用既有结构，在线状态由 WS 内存态承载不入库
{
  try {
    const crCols = db.prepare('PRAGMA table_info(collab_rooms)').all().map(c => c.name);
    if (!crCols.includes('agent_id')) {
      db.exec('ALTER TABLE collab_rooms ADD COLUMN agent_id INTEGER DEFAULT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_cr_agent ON collab_rooms(agent_id);');
      console.log('[db] collab_rooms 表已迁移：新增 agent_id 字段（U1-7 画布协作房间绑定）');
    }
  } catch (e) { console.error('[db] U1-7 collab_rooms 迁移失败（不阻塞启动）：', e.message); }
}

// ================== P2-12 文件台账与修订（2026-11-13）==================
db.exec(`CREATE TABLE IF NOT EXISTS file_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',           -- 文件名
  type TEXT DEFAULT 'unknown',             -- 文件类型：pdf|docx|xlsx|pptx|image|txt|markdown|csv|code|other
  path TEXT DEFAULT '',                    -- 源路径
  url TEXT DEFAULT '',                     -- 公共 URL
  size INTEGER DEFAULT 0,                 -- 字节
  hash TEXT DEFAULT '',                    -- SHA256 文件指纹（内容去重）
  source TEXT DEFAULT 'upload',            -- upload | import | sync | export | attach
  ref_type TEXT DEFAULT '',                -- 关联类型：kb | session | wf | share
  ref_id INTEGER DEFAULT NULL,             -- 关联记录 ID
  owner TEXT DEFAULT '',                   -- 归属用户
  status TEXT DEFAULT 'active',            -- active | archived | deleted
  meta TEXT DEFAULT '{}',                  -- JSON 扩展元数据
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS file_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,                -- 关联 file_catalog.id
  version INTEGER NOT NULL,                -- 版本号（从 1 递增）
  name TEXT DEFAULT '',                     -- 该版本的文件名
  size INTEGER DEFAULT 0,                  -- 该版本大小
  hash TEXT DEFAULT '',                     -- 该版本 SHA256
  path TEXT DEFAULT '',                     -- 该版本存储路径
  change_note TEXT DEFAULT '',              -- 变更备注
  created_by TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_fc_owner ON file_catalog(owner);');
db.exec('CREATE INDEX IF NOT EXISTS idx_fc_source ON file_catalog(source);');
db.exec('CREATE INDEX IF NOT EXISTS idx_fc_hash ON file_catalog(hash);');
db.exec('CREATE INDEX IF NOT EXISTS idx_fr_file ON file_revisions(file_id, version);');

// ================== P2-13 外部知识库登记（2026-11-13）==================
db.exec(`CREATE TABLE IF NOT EXISTS external_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id INTEGER NOT NULL,                  -- 关联 kbs.id
  name TEXT NOT NULL DEFAULT '',            -- 数据源名称
  type TEXT NOT NULL DEFAULT '',            -- confluence | notion | sharepoint | web | api | s3 | custom
  config TEXT DEFAULT '{}',                 -- JSON：连接配置（URL/Key 用 $ref 引用 secrets 表，不直接存储明文）
  sync_interval INTEGER DEFAULT 0,          -- 同步间隔（分钟，0=手动）
  last_sync_at TEXT,
  sync_status TEXT DEFAULT 'never',         -- never | syncing | success | partial | failed
  sync_message TEXT DEFAULT '',
  doc_count INTEGER DEFAULT 0,              -- 已同步文档数
  enabled INTEGER DEFAULT 1,
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_es_kb ON external_sources(kb_id);');

// ================== U2-7 external_sources 扩展列 ==================
{
  try {
    const esCols = db.prepare('PRAGMA table_info(external_sources)').all().map(c => c.name);
    if (!esCols.includes('auth_type')) {
      db.exec("ALTER TABLE external_sources ADD COLUMN auth_type TEXT DEFAULT 'none'");
      db.exec("ALTER TABLE external_sources ADD COLUMN auth_config TEXT DEFAULT ''");
      db.exec("ALTER TABLE external_sources ADD COLUMN org_name TEXT DEFAULT ''");
      console.log('[db] external_sources 表已迁移：新增 auth_type/auth_config/org_name 字段（U2-7 跨租户联邦）');
    }
  } catch (e) { console.error('[db] U2-7 迁移失败（不阻塞）：', e.message); }
}

// ================== P2-14 召回质量闭环（2026-11-13）==================
// 召回评测结果表：每次跑召回对比的记录，scores JSON 存储各评测条目得分
db.exec(`CREATE TABLE IF NOT EXISTS recall_eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id INTEGER NOT NULL,                  -- 评测对象知识库
  eval_name TEXT DEFAULT '',                -- 评测名称（如 '2026-11月度回归'）
  version TEXT DEFAULT '',                  -- 评测版本标记
  type TEXT DEFAULT 'full',                 -- full（全量）| incremental（增量）
  total_questions INTEGER DEFAULT 0,        -- 题目总数
  avg_recall REAL DEFAULT 0.0,             -- 平均召回率
  avg_accuracy REAL DEFAULT 0.0,           -- 平均准确率
  scores TEXT DEFAULT '[]',                 -- JSON：每条评分详情 [{question_id,recall,accuracy,note}]
  negatives TEXT DEFAULT '[]',              -- JSON：本次新沉淀的差评案例
  missees TEXT DEFAULT '[]',               -- JSON：未命中案例
  triggered_by TEXT DEFAULT 'manual',       -- manual | schedule | threshold
  created_by TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_rer_kb ON recall_eval_results(kb_id);');

// ================== P2-20 语音供应商（2026-11-13）==================
db.exec(`CREATE TABLE IF NOT EXISTS voice_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'both',                -- stt | tts | both
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  endpoint TEXT DEFAULT '',                 -- 专用端点 URL（如 /v1/audio/speech）
  voices TEXT DEFAULT '[]',                 -- JSON：可用音色列表 [{name,id,lang,gender}]
  languages TEXT DEFAULT '[]',              -- JSON：支持的语言列表
  rate_options TEXT DEFAULT '[]',           -- JSON：速率范围 [{label,value}]
  model_name TEXT DEFAULT '',               -- 模型名
  configured INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
console.log('[db] 创建 voice_providers 表（P2-20 语音供应商）');
// U0-2（N3-P2）流式适配位：增补流式能力字段（未配置默认 batch，走「VAD 分段批式」降级链；凭证到位后改配置即切流式）
try { db.exec("ALTER TABLE voice_providers ADD COLUMN stream_type TEXT DEFAULT 'batch'"); } catch { }
try { db.exec("ALTER TABLE voice_providers ADD COLUMN stream_endpoint TEXT DEFAULT ''"); } catch { }

// U0-3 FTS5 全文索引虚拟表（2026-11-13 迁移）：kb_chunks 内容列的全文本搜索支持
// FTS5 是 SQLite 内置模块、无需额外依赖；absent 不存储正文（仅存行号用 content=表名; content_rowid=id 关联原表）
// unicode61 分词器支持英文/数字/Unicode 符号，中文需结合 LIKE 等补充
// 创建后可通过 kb_chunks_fts MATCH 实现 BM25 检索（纯文本量 < 100w 行时性能优于运行时扫描版 bm25Scores）
// 注意：此索引仅从创建时起维护新增/更新的分块；存量分块需全量重建，见 scripts/reindex-fts.js
try {
  db.prepare("SELECT 1 FROM kb_chunks_fts LIMIT 1").get();
} catch {
  // 表不存在则创建
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
    content,
    tokenize='unicode61'
  )`);
  console.log('[db] 创建 kb_chunks_fts FTS5 全文索引（U0-3 混合检索升级）');
}

// ================== P2-18 浏览器自动化记录表（2026-11-13）==================
db.exec(`CREATE TABLE IF NOT EXISTS browser_automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT DEFAULT '',               -- CDP 会话 ID / Playwright session ID
  url TEXT DEFAULT '',                       -- 页面 URL
  action TEXT DEFAULT '',                    -- 操作类型
  action_input TEXT DEFAULT '',              -- 操作参数 JSON
  action_result TEXT DEFAULT '',             -- 操作结果
  status TEXT DEFAULT 'done',               -- pending | running | done | failed
  screenshot_path TEXT DEFAULT '',
  duration_ms INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT
);`);
console.log('[db] 创建 browser_automations 表（P2-18 浏览器自动化）');

// ================== U1-1 内建数据库（2026-11-14）==================
db.exec(`CREATE TABLE IF NOT EXISTS app_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- 表名（字母数字下划线，20字符内）
  display_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  columns TEXT NOT NULL DEFAULT '[]',    -- JSON：[{name, type, required, default, comment}] 列定义
  row_count INTEGER DEFAULT 0,           -- 当前行数（快照，精确值由 count_rows SQL 维护）
  max_rows INTEGER DEFAULT 5000,         -- 行数上限
  owner TEXT NOT NULL DEFAULT '',
  space_id INTEGER DEFAULT NULL,
  created_at TEXT,
  updated_at TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS app_table_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,              -- 关联 app_tables.id
  data TEXT NOT NULL DEFAULT '{}',        -- JSON：行数据，键值对应 columns 定义
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_at_name_owner ON app_tables(name, owner);');
db.exec('CREATE INDEX IF NOT EXISTS idx_atr_table ON app_table_rows(table_id);');
console.log('[db] 创建 app_tables/app_table_rows 表（U1-1 内建数据库）');

// ================== U2-5 市场商品表 ==================
db.exec(`CREATE TABLE IF NOT EXISTS market_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  price_type TEXT DEFAULT 'free',          -- free | one_time | subscription
  price REAL DEFAULT 0,
  subscription_period TEXT DEFAULT 'month',
  author_profit_share REAL DEFAULT 0.8,
  status TEXT DEFAULT 'active',            -- active | inactive
  created_at TEXT,
  updated_at TEXT
);`);
console.log('[db] 创建 market_products 表（U2-5 市场商品）');

// ================== U2-5 市场订单表 ==================
// market_orders: 用户购买/订阅智能体商品的订单记录
db.exec(`CREATE TABLE IF NOT EXISTS market_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,          -- 订单号（异步生成，可视）
  product_id INTEGER NOT NULL,           -- market_products.id
  agent_id INTEGER NOT NULL,             -- 快照（关联 agents.id，方便直接查询）
  buyer TEXT NOT NULL,                    -- 购买者 username
  price REAL NOT NULL DEFAULT 0,          -- 成交金额
  price_type TEXT DEFAULT 'one_time',    -- 快照 one_time | subscription
  status TEXT DEFAULT 'pending',          -- pending | paid | completed | cancelled | refunded
  paid_at TEXT,
  completed_at TEXT,
  subscription_end TEXT,                  -- 订阅到期时间（subscription 类型）
  note TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mo_buyer ON market_orders(buyer);');
db.exec('CREATE INDEX IF NOT EXISTS idx_mo_product ON market_orders(product_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_mo_status ON market_orders(status);');
console.log('[db] 创建 market_orders 表（U2-5 市场订单）');

// ================== a2a_tasks 表 ==================
db.exec(`CREATE TABLE IF NOT EXISTS a2a_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,            -- A2A 标准 task_id 格式
  agent_id INTEGER NOT NULL,
  agent_name TEXT DEFAULT '',
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT '{}',
  status TEXT DEFAULT 'submitted',         -- submitted | working | input_required | completed | failed | canceled
  error TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',
  created_by TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_a2a_task_id ON a2a_tasks(task_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_a2a_status ON a2a_tasks(status);');
console.log('[db] 创建 a2a_tasks 表（U0-6 A2A Task 审计）');

// ================== a2a_api_keys 表（U2-7 Phase 3 JWS/OAuth 安全接入）==================
// 外部机器调用方的签名密钥对：public_key 明文可分发（kid 寻址），private_key 经
// crypto-util.encrypt（AES-256-GCM）加密落库，明文私钥永不落盘。
db.exec(`CREATE TABLE IF NOT EXISTS a2a_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL UNIQUE,            -- JWS kid：公钥标识，暴露给调用方
  name TEXT DEFAULT '',                   -- 用途/名称
  owner TEXT DEFAULT '',                  -- 归属平台用户名（归属解析 + 计费口径）
  org_name TEXT DEFAULT '',               -- 调用方所属组织（审计/水印联动）
  alg TEXT DEFAULT 'RS256',               -- RS256 | ES256
  public_key TEXT NOT NULL,               -- PEM 公钥（明文，可公开分发）
  private_key TEXT NOT NULL,              -- PEM 私钥（crypto-util 加密后落库）
  scopes TEXT DEFAULT 'a2a:call',         -- 授权范围（逗号分隔）
  status INTEGER DEFAULT 1,               -- 1 启用 / 0 停用
  expires_at TEXT DEFAULT '',             -- 密钥过期时间（空=长期）
  created_at TEXT,
  last_used_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_a2a_keyid ON a2a_api_keys(key_id);');
console.log('[db] 创建 a2a_api_keys 表（U2-7 Phase 3 JWS 密钥）');

// ================== U2-1 任务队列表 ==================
// task_queue：统一任务队列持久层。当前为进程内调度（setImmediate），
// 后续可替换为 Redis/BullMQ 后端（接口语义等价：jobId/payload/retry/priority/scheduled_at）
db.exec(`CREATE TABLE IF NOT EXISTS task_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,         -- 唯一任务 ID（客户端生成或服务端生成）
  name TEXT NOT NULL,                  -- 任务类型名（对应 register 注册的 name）
  payload TEXT DEFAULT '{}',           -- 任务参数 JSON
  status TEXT DEFAULT 'pending',       -- pending | running | success | failed
  priority INTEGER DEFAULT 0,          -- 优先级（高=先执行）
  max_retries INTEGER DEFAULT 3,       -- 最大重试次数
  retry_count INTEGER DEFAULT 0,       -- 已重试次数
  delay_ms INTEGER DEFAULT 0,          -- 延迟毫秒（延迟任务）
  scheduled_at TEXT,                   -- 计划执行时间
  started_at TEXT,
  finished_at TEXT,
  result TEXT,                         -- 执行结果 JSON
  error TEXT,                          -- 错误信息
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tq_status ON task_queue(status, priority);');
db.exec('CREATE INDEX IF NOT EXISTS idx_tq_job_id ON task_queue(job_id);');

// ================== D3-1 3D 与数字人 V1（2026-11-21）==================
//  - model3d_tasks ：3D 资产生成任务台账（成功率验收口径 ≥ 70%）
//  - asset_exports ：3D 资产导出记录（源格式 → 目标格式 + 是否需要转换）
//  - dh_assessments：数字人/真人合成素材合规评估记录（评估先行闸门）
db.exec(`CREATE TABLE IF NOT EXISTS model3d_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT DEFAULT '',
  project_id INTEGER DEFAULT NULL,
  prompt TEXT DEFAULT '',
  format TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  model TEXT DEFAULT '',
  provider TEXT DEFAULT '',
  url TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  asset_id INTEGER DEFAULT NULL,
  error TEXT DEFAULT '',
  duration_ms INTEGER DEFAULT 0,
  meta TEXT DEFAULT '{}',
  created_at TEXT,
  finished_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_m3d_tasks_user ON model3d_tasks(username, id DESC);');
db.exec('CREATE INDEX IF NOT EXISTS idx_m3d_tasks_status ON model3d_tasks(status);');
db.exec(`CREATE TABLE IF NOT EXISTS asset_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER,
  username TEXT DEFAULT '',
  source_format TEXT DEFAULT '',
  target_format TEXT DEFAULT '',
  need_convert INTEGER DEFAULT 0,
  status TEXT DEFAULT 'done',
  url TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_asset_exports_asset ON asset_exports(asset_id, id DESC);');
db.exec(`CREATE TABLE IF NOT EXISTS dh_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER DEFAULT NULL,
  project_id INTEGER DEFAULT NULL,
  username TEXT DEFAULT '',
  answers TEXT DEFAULT '{}',
  score INTEGER DEFAULT 0,
  level TEXT DEFAULT 'low',
  decision TEXT DEFAULT 'approve',
  reasons TEXT DEFAULT '[]',
  note TEXT DEFAULT '',
  created_at TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_dh_assess_project ON dh_assessments(project_id, id DESC);');
db.exec('CREATE INDEX IF NOT EXISTS idx_dh_assess_asset ON dh_assessments(asset_id, id DESC);');
// D3-2 经验自进化 V1（2026-11-21）：按「专家 × 任务类型」聚合可靠度——编排（D1-2）随使用积累经验，
// 后续同类任务优先选用高分专家；首跑/复跑分桶用于「二次成功率提升」验收指标（evolutionStats）。
db.exec(`CREATE TABLE IF NOT EXISTS agent_experience (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  task_type TEXT NOT NULL,
  runs INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  first_runs INTEGER DEFAULT 0,
  first_success INTEGER DEFAULT 0,
  repeat_runs INTEGER DEFAULT 0,
  repeat_success INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  last_status TEXT DEFAULT '',
  last_at TEXT,
  updated_at TEXT
);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_exp_pair ON agent_experience(agent_id, task_type);');
db.exec('CREATE INDEX IF NOT EXISTS idx_agent_exp_type ON agent_experience(task_type);');

// P1-17 版本化迁移框架（2026-11-13）：执行 _migrations 注册表中尚未登记的列迁移
// 新迁移直接在该框架中追加，逐步替代 db.js 内联 ALTER TABLE 块
try {
  const { runMigrations, ALL_MIGRATIONS } = require('./lib/migrate');
  runMigrations(ALL_MIGRATIONS);
} catch (e) {
  console.error('[migrate] 迁移框架初始化失败（非致命）：', e.message);
}
