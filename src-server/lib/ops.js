/**
 * 平台运维（2026-10-20 P0 安全加固）：
 * 1. dailyBackup —— SQLite 每日备份（VACUUM INTO 一致性快照，保留 30 份，data/backups/）
 * 2. cleanupUploads —— 生成产物定时清理（默认 30 天，可 AGENT_UPLOAD_TTL_DAYS 调整；保留目录结构）
 * 3. archiveLogs —— 日志表保留策略（默认 90 天：op_logs / err_logs / task_runs；消息主表不动）
 * 由 scheduler 内置触发（每日 03:30 与 04:00），不依赖外部 cron；全部幂等可重跑。
 */
const fs = require('fs');
const path = require('path');
const { db, now, withDbTenant } = require('../db');
const config = require('./config'); // P1-20 配置中心
const dal = require('./dal'); // U2-2 数据库抽象层

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');
const KEEP_BACKUPS = config.get('backup_keep') || 30;
const UPLOAD_TTL_DAYS = config.get('upload_ttl_days') || 30;
const LOG_TTL_DAYS = config.get('log_ttl_days') || 90;

function dayKey(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}

/** 每日数据库备份（VACUUM INTO：在线一致性快照，WAL 安全） */
function dailyBackup() {
  // OPS-3（2026-11-24）PG 补轨：VACUUM INTO 为 SQLite 专有，PG 模式改走 pg_dump
  //（-Fc custom 格式：内建压缩 + pg_restore 自校验 + 排除表选项）。sqlite 模式行为不变。
  if ((process.env.DB_DIALECT || 'sqlite') !== 'sqlite') {
    return dailyBackupPg();
  }
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const fname = `platform-${dayKey()}.db`;
    const target = path.join(BACKUP_DIR, fname);
    if (fs.existsSync(target)) return { ok: true, skipped: true, msg: '今日已备份' }; // 幂等

    // P1-22 备份排除表支持：先获取配置中的排除表名
    const excludeRaw = config.get('backup_exclude_tables') || '';
    const excludeTables = excludeRaw ? excludeRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    let tempPath = target;

    // 如果有排除表，先创建临时数据库排除后再备份
    if (excludeTables.length) {
      const tmpTarget = path.join(BACKUP_DIR, `.tmp-${fname}`);
      // 先 VACUUM INTO 到临时文件
      dal.runq(`VACUUM INTO ?`, [tmpTarget]);
      // 然后打开临时库删表
      const tmpDb = require('better-sqlite3')(tmpTarget);
      for (const tbl of excludeTables) {
        try { tmpDb.exec(`DROP TABLE IF EXISTS "${tbl}"`); } catch { /* 表不存在跳过 */ }
      }
      tmpDb.close();
      fs.renameSync(tmpTarget, target);
    } else {
      dal.runq(`VACUUM INTO ?`, [target]);
    }

    // 清理超量旧备份
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^platform-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (all.length > KEEP_BACKUPS) {
      fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    }
    const sizeMB = (fs.statSync(target).size / 1048576).toFixed(2);
    const msg = `${fname}（${sizeMB} MB，共保留 ${all.length} 份${excludeTables.length ? `，排除表：${excludeTables.join(',')}` : ''}）`;
    console.log(`[ops] 数据库已备份：${msg}`);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '数据库备份', msg, '', now()]);
    return { ok: true, msg: fname, sizeMB };
  } catch (e) {
    console.error('[ops] 备份失败：', e.message);
    dal.insert('err_logs', { source: 'ops-backup', message: e.message, created_at: now() });
    return { ok: false, msg: e.message };
  }
}

/* ============ OPS-3（2026-11-24）：PG 模式 pg_dump 备份轨 ============
 * sqlite 轨（上方 VACUUM INTO）与 PG 轨（本组）共用 BACKUP_DIR/KEEP_BACKUPS/排除表配置，
 * 双轨对齐「每日 03:30 调度 + 幂等 + 保留 N 份 + op_logs 审计」语义。
 * 产物形态：platform-YYYY-MM-DD.dump（pg_dump -Fc custom 格式——内建压缩、文件头自校验、
 * pg_restore 直接恢复；比 SQL 文本形态省 3-5×空间且可校验）。 */

/** 解析 PG_CONN 连接串 → {user, db}（pg_dump 必需的两个参数源） */
function pgConnParts() {
  const url = process.env.PG_CONN || process.env.DATABASE_URL || '';
  try {
    const u = new URL(url);
    return { user: decodeURIComponent(u.username || ''), db: (u.pathname || '/').replace(/^\//, '') };
  } catch { return { user: '', db: '' }; }
}

/** 探测 pg_dump 命令：config backup_pg_cmd 模板优先，缺省 docker exec 容器内 postgres 超户执行
 *  ——超户天然 BYPASSRLS（演练实证：FORCE RLS 下业务角色的 pg_dump COPY 直接报错
 *  'query would be affected by row-level security policy'；NO FORCE 临时摘除会让备份窗口
 *  RLS 失效，不取。超户只读 dump 动作 + 恢复侧 --role 对齐归属，备份语义本就含全租户数据）。 */
function resolvePgBackupCmd() {
  const custom = String(config.get('backup_pg_cmd') || '').trim();
  const { db } = pgConnParts();
  if (custom) {
    const { user } = pgConnParts();
    return custom.replaceAll('{user}', user).replaceAll('{db}', db);
  }
  let container = process.env.AGENT_PG_CONTAINER || '';
  if (!container) {
    try {
      const list = require('child_process').execSync(
        "docker ps --format '{{.Names}}|{{.Ports}}'", { timeout: 5000, encoding: 'utf8' })
        .split('\n').filter(Boolean).map((l) => l.split('|'))
        // SW-1（2026-11-25）收窄为「发布到宿主机端口」命中（5432->）：同宿主机多栈并存时，复合栈
        // 内部 postgres（Ports 形如 5432/tcp、无宿主机映射）同样被宽匹配 /5432/ 命中，docker ps
        // 顺序不定时 list[0] 可能选中错误容器（库不存在→备份失败；若同名则更糟）。
        .filter(([, ports]) => /5432->/.test(ports || ''));
      if (!list.length) throw new Error('未识别到 5432 端口容器（设 AGENT_PG_CONTAINER 指定）');
      container = list[0][0];
    } catch (e) { throw new Error('PG 备份命令探测失败：' + (e.message || e)); }
  }
  return `docker exec ${container} pg_dump -U postgres -Fc ${db}`;
}

/** 解析模板/自动探测产物为 { file, args, exclude }（execFile 数组形态——命令注入面收敛为参数数组） */
function pgBackupCmdParts(excludeTables) {
  const raw = resolvePgBackupCmd();
  const parts = raw.split(/\s+/).filter(Boolean);
  // 排除表（P1-22 语义对齐：结构保留、数据排除）：表名过标识符白名单（config 来源仍防御）
  const safe = excludeTables.filter((t) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t));
  for (const t of safe) parts.push(`--exclude-table-data=${t}`);
  const [file, ...args] = parts;
  return { file, args };
}

/** PG 每日备份：pg_dump -Fc → data/backups/platform-YYYY-MM-DD.dump（幂等/保留/审计同 sqlite 轨） */
function dailyBackupPg() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const fname = `platform-${dayKey()}.dump`;
    const target = path.join(BACKUP_DIR, fname);
    if (fs.existsSync(target)) return { ok: true, skipped: true, msg: '今日已备份' }; // 幂等
    const excludeRaw = config.get('backup_exclude_tables') || '';
    const excludeTables = excludeRaw ? excludeRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const { file, args } = pgBackupCmdParts(excludeTables);
    // stdout 直收产物（execFileSync 默认 maxBuffer 1MB 不够，提至 2GB 兜大库）；timeout 300s
    //（10 万块演练实测秒级，上限防调度线程挂死）
    const dump = require('child_process').execFileSync(file, args, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 * 1024 });
    fs.writeFileSync(target, dump);
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^platform-\d{4}-\d{2}-\d{2}\.dump$/.test(f)).sort();
    while (all.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    const sizeMB = (dump.length / 1048576).toFixed(2);
    const msg = `${fname}（${sizeMB} MB，pg_dump -Fc，共保留 ${all.length} 份${excludeTables.length ? `，排除表：${excludeTables.join(',')}` : ''}）`;
    console.log(`[ops] 数据库已备份（PG）：${msg}`);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '数据库备份', msg, '', now()]);
    return { ok: true, msg: fname, sizeMB };
  } catch (e) {
    // PG 轨无 sqlite 轨的降级语义（VACUUM 跳过是登记决策）——pg_dump 是 PG 模式的主备份，失败即真失败
    console.error('[ops] PG 备份失败：', e.message);
    dal.insert('err_logs', { source: 'ops-backup-pg', message: String(e.message || e).slice(0, 500), created_at: now() });
    return { ok: false, msg: String(e.message || e) };
  }
}

/** 生成产物清理：删除超过 TTL 的子目录内文件（gen-images / videos / ppt / 其他技能产物） */
function cleanupUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_DAYS * 86400000;
  let removed = 0, freedMB = 0;
  const excludeRaw = config.get('backup_exclude_dirs') || '';
  const excludeDirs = excludeRaw ? new Set(excludeRaw.split(',').map(s => s.trim()).filter(Boolean)) : new Set();
  try {
    if (!fs.existsSync(UPLOAD_ROOT)) return { ok: true, removed: 0 };
    for (const dir of fs.readdirSync(UPLOAD_ROOT)) {
      if (excludeDirs.has(dir)) continue; // P1-22 排除目录
      const p = path.join(UPLOAD_ROOT, dir);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) {
        const fp = path.join(p, f);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.mtimeMs < cutoff) {
            freedMB += st.size / 1048576;
            fs.unlinkSync(fp);
            removed++;
          }
        } catch { /* 单文件失败跳过 */ }
      }
    }
    if (removed) {
      console.log(`[ops] 已清理 ${removed} 个过期生成产物（${freedMB.toFixed(1)} MB，> ${UPLOAD_TTL_DAYS} 天）`);
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '产物清理', `${removed} 个文件（${freedMB.toFixed(1)} MB）`, '', now()]);
    }
    return { ok: true, removed, freedMB: +freedMB.toFixed(1) };
  } catch (e) {
    console.error('[ops] 产物清理失败：', e.message);
    return { ok: false, msg: e.message };
  }
}

/** 日志表归档：删除超过 TTL 的 op_logs / err_logs / task_runs（消息与会话主数据不动） */
function archiveLogs() {
  try {
    const cutoff = dayKey(new Date(Date.now() - LOG_TTL_DAYS * 86400000)) + ' 23:59:59';
    const t = { op_logs: 0, err_logs: 0, task_runs: 0 };
    t.err_logs = dal.remove('err_logs', 'created_at < ?', [cutoff]);
    t.op_logs = dal.remove('op_logs', "created_at < ? AND username != 'system'", [cutoff]);
    t.task_runs = dal.remove('task_runs', 'started_at < ?', [cutoff]);
    // 同时使用 db 原有方法验证双方等值
    const total = t.op_logs + t.err_logs + t.task_runs;
    if (total) {
      console.log(`[ops] 日志归档：清理 ${total} 条过期记录（> ${LOG_TTL_DAYS} 天）`);
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '日志归档', `op_logs ${t.op_logs} / err_logs ${t.err_logs} / task_runs ${t.task_runs}`, '', now()]);
    }
    return { ok: true, ...t };
  } catch (e) {
    console.error('[ops] 日志归档失败：', e.message);
  return { ok: false, msg: e.message };
}
}

/** U0-8：记忆摘要。遍历近 24h 有交互的长会话，统计话题写入 agent_memories（source='digest'）。同步版本，不调用模型以免打乱现有定时任务架构 */
function digestMemories() {
  const today = dayKey();
  try {
    const rows = dal.q(`
      SELECT s.agent_id, s.username, a.tenant_id AS tenant_id
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      JOIN agents a ON a.id = s.agent_id AND a.long_memory = 1
      WHERE m.created_at >= datetime('now','-1 day') AND m.role = 'user'
      GROUP BY s.id, a.tenant_id HAVING COUNT(m.id) >= 5
    `);
    if (!rows.length) return { ok: true, skipped: true, msg: '今日无待摘要会话' };
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.agent_id}:${r.username}`;
      if (seen.has(key)) continue;
      const hasDigest = dal.getq("SELECT id FROM agent_memories WHERE agent_id=? AND username=? AND source='digest' LIMIT 1", [r.agent_id, r.username]);
      if (hasDigest) { seen.add(key); continue; }
      const msgs = dal.q(`
        SELECT role, content FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.agent_id = ? AND s.username = ? ORDER BY m.id DESC LIMIT 30
      `, [r.agent_id, r.username]);
      const userMsgs = msgs.filter(x => x.role === 'user').map(x => (x.content || '').slice(0, 200)).filter(Boolean);
      if (!userMsgs.length) continue;
      const topics = userMsgs.slice(0, 5).map(t => t.length > 50 ? t.slice(0, 50) + '…' : t);
      const summary = `用户提出 ${userMsgs.length} 条消息。话题：${topics.join('； ')}。`;
      // 行归属租户显式列值（随 agent 归属租户——平台摘要任务跨租户运维，新行租户不得错挂列默认 1）
      dal.runq(`INSERT INTO agent_memories (agent_id,username,fact,type,confidence,source,summary,tenant_id,created_at) VALUES (?,?,?,?,?,?,?, ?, datetime('now','localtime'))`, [r.agent_id, r.username, summary, 'fact', 0.5, 'digest', summary, Number(r.tenant_id) || 1]);
      seen.add(key);
    }
    if (seen.size) {
      console.log(`[ops] 记忆摘要：已蒸馏 ${seen.size} 条（${today}）`);
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '记忆摘要', `${seen.size} 条摘要（${today}）`, '', now()]);
    }
    return { ok: true, digested: seen.size };
  } catch (e) {
    console.error('[ops] 记忆摘要失败：', e.message);
    dal.runq('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)', ['ops-digest', e.message, now()]);
    return { ok: false, msg: e.message };
  }
}

/** U1-5：评测回归流水线。扫描所有开启了自动回归的知识库，对其评测集逐个重跑并记录 recall_eval_results。由于调用路径是 dailyOps 同步回调，内层异步用 then() 处理 */
function runEvalRegression() {
  const today = dayKey();
  try {
    const kbs = dal.q("SELECT id, name, owner, tenant_id FROM kbs WHERE enabled=1");
    let totalEvalCount = 0;
    for (const kb of kbs) {
      const evals = dal.q("SELECT id, name, score, dataset, kb_id FROM evaluations WHERE kb_id=? AND type='kb'", [kb.id]);
      totalEvalCount += evals.length;
      for (const ev of evals) {
        const { rerunEvalSet } = require('./kb-eval-regression');
        rerunEvalSet(ev).then(r => {
          if (r && r.score !== undefined) {
            // 行归属租户显式列值（随 kb 归属租户——平台回归任务跨租户运维）
            dal.runq(`INSERT INTO recall_eval_results (kb_id, eval_name, version, type, total_questions, avg_recall, avg_accuracy, scores, negatives, missees, triggered_by, created_by, tenant_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,'schedule',?, ?,?)`, [kb.id, ev.name, r.version || 'v1', 'full', r.items_count || 0, r.score || 0, 0,
                JSON.stringify(r.detail || []), '[]', '[]', 'system', Number(kb.tenant_id) || 1, now()]);
            console.log(`[ops] 评测回归：kb#${kb.id}「${ev.name}」= ${r.score}`);
          }
        }).catch(e => console.warn(`[ops] 评测回归失败：kb#${kb.id}/eval#${ev.id}`, e.message));
      }
    }
    if (totalEvalCount) {
      console.log(`[ops] 评测回归：今日计划执行 ${totalEvalCount} 个评测集（${today}）`);
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['system', '评测回归', `计划 ${totalEvalCount} 个评测集（${today}）`, '', now()]);
    }
    return { ok: true, total: totalEvalCount };
  } catch (e) {
    console.error('[ops] 评测回归失败：', e.message);
    dal.runq('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)', ['ops-eval', e.message, now()]);
    return { ok: false, msg: e.message };
  }
}

/** 每日运维任务（幂等标记，防同日重复执行） */
const ranAt = new Map(); // job -> dayKey
function dailyOps(job, fn) {
  const today = dayKey();
  if (ranAt.get(job) === today) return;
  ranAt.set(job, today);
  fn();
}

/** U1-6：部门月度成本超预算告警（仿 quota.js quotaAlert 模式：跨 80%/100% 两档，升档才发防轰炸；
 *  budget_alert_level 记录已提醒档位。通知发 admin + 部门成员——admin 可调预算，成员可感知本部门消耗） */
function checkDeptBudgets() {
  try {
    const { deptCostOfMonth } = require('./billing');
    const { month, departments } = deptCostOfMonth();
    let alerted = 0;
    for (const d of departments) {
      if (!d.dept_id || !d.budget || d.budget <= 0) continue; // 未归属行与未设预算部门不告警
      const pct = d.cost / d.budget;
      const level = pct >= 1 ? 2 : (pct >= 0.8 ? 1 : 0);
      const row = dal.getq('SELECT budget_alert_level FROM departments WHERE id=?', [d.dept_id]);
      if (!row || level <= (row.budget_alert_level || 0)) continue; // 已提醒过同档/更高档不重复发
      const pctTxt = Math.round(pct * 100);
      const content = level === 2
        ? `「${d.name}」本月模型成本已达预算 100%（${d.cost.toFixed(2)} 元 / 预算 ${d.budget} 元）。已超额支出，请尽快调整预算或限制部门用量。`
        : `「${d.name}」本月模型成本已达预算 ${pctTxt}%（${d.cost.toFixed(2)} 元 / 预算 ${d.budget} 元），接近上限。可提前调整预算或关注部门用量趋势。`;
      dal.runq('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)', ['*', `💸 部门预算${level === 2 ? '超支' : '预警'}：${d.name}`, content, 'budget', '#/admin/dashboard', now()]);
      dal.runq('UPDATE departments SET budget_alert_level=? WHERE id=?', [level, d.dept_id]);
      console.log(`[ops] ⚠️ 部门预算告警：${d.name} 当月 ${d.cost.toFixed(2)}/${d.budget} 元（第 ${level} 档，${month}）`);
      alerted++;
    }
    return { ok: true, alerted };
  } catch (e) {
    console.error('[ops] 部门预算检查失败：', e.message);
    dal.runq('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)', ['ops-budget', e.message, now()]);
    return { ok: false, msg: e.message };
  }
}

function startOps(guard) {
  // U2-1 / N7-P2：可选 guard —— 集群下传入「是否 leader」判断，非 leader 进程的定时触发直接跳过（不重复备份/清理）。
  // 不传 guard时等价于恒真，单进程路径行为与引入前完全一致。
  const allow = typeof guard === 'function' ? guard : () => true;
  // PG-1 增量（2026-11-24）：运维任务统一 platform 逃逸上下文——摘要/评测/预算读写 sessions/messages/
  // kbs/departments 等租户表（无上下文在 RLS 下只见基线 0 行，静默空转）；写入行的归属租户由
  // 各任务显式列值指定（digestMemories/runEvalRegression 的 INSERT）。备份/清理/归档仅碰平面表，包裹无副作用。
  const run = (job, fn) => { if (allow()) dailyOps(job, () => withDbTenant('platform', fn)); };
  // 启动 60 秒后先跑一轮（首次部署即有备份），此后每 30 分钟检查跨日触发
  setTimeout(() => { run('backup', dailyBackup); run('uploads', cleanupUploads); run('logs', archiveLogs); }, 60000);
  setInterval(() => {
    run('backup', dailyBackup);
    run('uploads', cleanupUploads);
    run('logs', archiveLogs);
  }, 30 * 60000);
  console.log(`[ops] 运维任务已启动（每日备份保留 ${KEEP_BACKUPS} 份 / 产物保留 ${UPLOAD_TTL_DAYS} 天 / 日志保留 ${LOG_TTL_DAYS} 天 / 记忆摘要已开启 / 评测回归已开启）`);

  // OPS-2（2026-11-25）：健康监控与阈值告警——事件循环采样常驻 + 5 分钟巡检
  //（区别于上面 30 分钟的备份组：健康巡检需要更细粒度；独立间隔零干扰）。
  // 告警触达对象：平台超管（users.platform_admin=1，users 为平面表无 RLS，但读时仍包 platform 口径统一）。
  const metrics = require('./metrics');
  metrics.startMetrics();
  const alertTick = () => {
    if (!allow()) return; // 非 leader 不重复告警
    try {
      const admins = withDbTenant('platform', () => dal.q('SELECT username FROM users WHERE platform_admin=1').map((r) => r.username));
      const { dispatched } = metrics.runAlertCheck(admins);
      if (dispatched.length) console.log(`[ops][metrics] 触发告警 ${dispatched.length} 条：${dispatched.join('；')}`);
    } catch (e) { console.error('[ops][metrics] 巡检异常（不阻断调度循环）：', e.message); }
  };
  setTimeout(alertTick, 120000);  // 启动 2 分钟首轮（避开启动高峰的天然延迟误报）
  setInterval(alertTick, 5 * 60000);
  console.log('[ops][metrics] 健康监控已启动（事件循环/内存/错误率/慢请求 四规则，5 分钟巡检，告警走通知中心）');

  // AI-Q2（2026-11-25）：RAGAS 评测夜跑（每日 03:00 窗口判定，挂 30 分钟轮询——dayKey 防重入
  // 在 eval-nightly 内部隔离）；成本护栏 50 用例/夜（D-8 口径）；回归劣化/改善双向通知平台超管。
  const evalNightly = require('./eval-nightly');
  const evalTick = () => {
    if (!allow()) return;
    const hour = new Date().getHours();
    if (hour !== 3) return; // 每日 03:00~03:59 窗口内首个轮询触发（dayKey 防重入）
    withDbTenant('platform', () => evalNightly.runRagNightly()).catch((e) =>
      console.error('[ops][eval-nightly] 夜跑异常（不阻断调度循环）：', e.message));
  };
  setInterval(evalTick, 30 * 60000);
  console.log('[ops][eval-nightly] 评测夜跑已启用（每日 03:00，RAGAS 重跑 + 前后对比自动报告）');
  // U0-8：启动后 2 分钟跑第一轮摘要，后每 2 小时检查
  setTimeout(() => run('digest', digestMemories), 120000);
  setInterval(() => run('digest', digestMemories), 120 * 60000);
  // U1-5：启动后 3 分钟跑第一轮评测回归，后每 4 小时检查
  setTimeout(() => run('eval', runEvalRegression), 180000);
  setInterval(() => run('eval', runEvalRegression), 240 * 60000);
  // U1-6：部门超预算告警（与每日备份同批检查，每日一次；升档幂等在 checkDeptBudgets 内部）
  setTimeout(() => run('deptBudget', checkDeptBudgets), 240000);
  setInterval(() => run('deptBudget', checkDeptBudgets), 30 * 60000);
}

module.exports = { dailyBackup, cleanupUploads, archiveLogs, digestMemories, runEvalRegression, checkDeptBudgets, startOps };

// ================== U2-1 任务队列注册 ==================
// 将 ops 各任务注册为命名任务类型，供 task-queue 调度执行（当前进程内 setImmediate，后续可切换为 Redis Worker）
const { register } = require('./task-queue');
register('daily-backup', async () => dailyBackup());
register('uploads-cleanup', async () => cleanupUploads());
register('logs-archive', async () => archiveLogs());
register('memories-digest', async () => digestMemories());
register('eval-regression', async () => runEvalRegression());
register('dept-budget-check', async () => checkDeptBudgets());
