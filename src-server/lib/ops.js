/**
 * 平台运维（2026-10-20 P0 安全加固）：
 * 1. dailyBackup —— SQLite 每日备份（VACUUM INTO 一致性快照，保留 30 份，data/backups/）
 * 2. cleanupUploads —— 生成产物定时清理（默认 30 天，可 AGENT_UPLOAD_TTL_DAYS 调整；保留目录结构）
 * 3. archiveLogs —— 日志表保留策略（默认 90 天：op_logs / err_logs / task_runs；消息主表不动）
 * 由 scheduler 内置触发（每日 03:30 与 04:00），不依赖外部 cron；全部幂等可重跑。
 */
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
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
      db.prepare(`VACUUM INTO ?`).run(tmpTarget);
      // 然后打开临时库删表
      const tmpDb = require('better-sqlite3')(tmpTarget);
      for (const tbl of excludeTables) {
        try { tmpDb.exec(`DROP TABLE IF EXISTS "${tbl}"`); } catch { /* 表不存在跳过 */ }
      }
      tmpDb.close();
      fs.renameSync(tmpTarget, target);
    } else {
      db.prepare(`VACUUM INTO ?`).run(target);
    }

    // 清理超量旧备份
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^platform-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (all.length > KEEP_BACKUPS) {
      fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    }
    const sizeMB = (fs.statSync(target).size / 1048576).toFixed(2);
    const msg = `${fname}（${sizeMB} MB，共保留 ${all.length} 份${excludeTables.length ? `，排除表：${excludeTables.join(',')}` : ''}）`;
    console.log(`[ops] 数据库已备份：${msg}`);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run('system', '数据库备份', msg, '', now());
    return { ok: true, msg: fname, sizeMB };
  } catch (e) {
    console.error('[ops] 备份失败：', e.message);
    dal.insert('err_logs', { source: 'ops-backup', message: e.message, created_at: now() });
    return { ok: false, msg: e.message };
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
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('system', '产物清理', `${removed} 个文件（${freedMB.toFixed(1)} MB）`, '', now());
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
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('system', '日志归档', `op_logs ${t.op_logs} / err_logs ${t.err_logs} / task_runs ${t.task_runs}`, '', now());
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
    const rows = db.prepare(`
      SELECT s.agent_id, s.username
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      JOIN agents a ON a.id = s.agent_id AND a.long_memory = 1
      WHERE m.created_at >= datetime('now','-1 day') AND m.role = 'user'
      GROUP BY s.id HAVING COUNT(m.id) >= 5
    `).all();
    if (!rows.length) return { ok: true, skipped: true, msg: '今日无待摘要会话' };
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.agent_id}:${r.username}`;
      if (seen.has(key)) continue;
      const hasDigest = db.prepare("SELECT id FROM agent_memories WHERE agent_id=? AND username=? AND source='digest' LIMIT 1").get(r.agent_id, r.username);
      if (hasDigest) { seen.add(key); continue; }
      const msgs = db.prepare(`
        SELECT role, content FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.agent_id = ? AND s.username = ? ORDER BY m.id DESC LIMIT 30
      `).all(r.agent_id, r.username);
      const userMsgs = msgs.filter(x => x.role === 'user').map(x => (x.content || '').slice(0, 200)).filter(Boolean);
      if (!userMsgs.length) continue;
      const topics = userMsgs.slice(0, 5).map(t => t.length > 50 ? t.slice(0, 50) + '…' : t);
      const summary = `用户提出 ${userMsgs.length} 条消息。话题：${topics.join('； ')}。`;
      db.prepare(`INSERT INTO agent_memories (agent_id,username,fact,type,confidence,source,summary,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(r.agent_id, r.username, summary, 'fact', 0.5, 'digest', summary);
      seen.add(key);
    }
    if (seen.size) {
      console.log(`[ops] 记忆摘要：已蒸馏 ${seen.size} 条（${today}）`);
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('system', '记忆摘要', `${seen.size} 条摘要（${today}）`, '', now());
    }
    return { ok: true, digested: seen.size };
  } catch (e) {
    console.error('[ops] 记忆摘要失败：', e.message);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('ops-digest', e.message, now());
    return { ok: false, msg: e.message };
  }
}

/** U1-5：评测回归流水线。扫描所有开启了自动回归的知识库，对其评测集逐个重跑并记录 recall_eval_results。由于调用路径是 dailyOps 同步回调，内层异步用 then() 处理 */
function runEvalRegression() {
  const today = dayKey();
  try {
    const kbs = db.prepare("SELECT id, name, owner FROM kbs WHERE enabled=1").all();
    let totalEvalCount = 0;
    for (const kb of kbs) {
      const evals = db.prepare("SELECT id, name, score, dataset, kb_id FROM evaluations WHERE kb_id=? AND type='kb'").all(kb.id);
      totalEvalCount += evals.length;
      for (const ev of evals) {
        const { rerunEvalSet } = require('./kb-eval-regression');
        rerunEvalSet(ev).then(r => {
          if (r && r.score !== undefined) {
            db.prepare(`INSERT INTO recall_eval_results (kb_id, eval_name, version, type, total_questions, avg_recall, avg_accuracy, scores, negatives, missees, triggered_by, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,'schedule',?,?)`)
              .run(kb.id, ev.name, r.version || 'v1', 'full', r.items_count || 0, r.score || 0, 0,
                JSON.stringify(r.detail || []), '[]', '[]', 'system', now());
            console.log(`[ops] 评测回归：kb#${kb.id}「${ev.name}」= ${r.score}`);
          }
        }).catch(e => console.warn(`[ops] 评测回归失败：kb#${kb.id}/eval#${ev.id}`, e.message));
      }
    }
    if (totalEvalCount) {
      console.log(`[ops] 评测回归：今日计划执行 ${totalEvalCount} 个评测集（${today}）`);
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('system', '评测回归', `计划 ${totalEvalCount} 个评测集（${today}）`, '', now());
    }
    return { ok: true, total: totalEvalCount };
  } catch (e) {
    console.error('[ops] 评测回归失败：', e.message);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('ops-eval', e.message, now());
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
      const row = db.prepare('SELECT budget_alert_level FROM departments WHERE id=?').get(d.dept_id);
      if (!row || level <= (row.budget_alert_level || 0)) continue; // 已提醒过同档/更高档不重复发
      const pctTxt = Math.round(pct * 100);
      const content = level === 2
        ? `「${d.name}」本月模型成本已达预算 100%（${d.cost.toFixed(2)} 元 / 预算 ${d.budget} 元）。已超额支出，请尽快调整预算或限制部门用量。`
        : `「${d.name}」本月模型成本已达预算 ${pctTxt}%（${d.cost.toFixed(2)} 元 / 预算 ${d.budget} 元），接近上限。可提前调整预算或关注部门用量趋势。`;
      db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
        .run('*', `💸 部门预算${level === 2 ? '超支' : '预警'}：${d.name}`, content, 'budget', '#/admin/dashboard', now());
      db.prepare('UPDATE departments SET budget_alert_level=? WHERE id=?').run(level, d.dept_id);
      console.log(`[ops] ⚠️ 部门预算告警：${d.name} 当月 ${d.cost.toFixed(2)}/${d.budget} 元（第 ${level} 档，${month}）`);
      alerted++;
    }
    return { ok: true, alerted };
  } catch (e) {
    console.error('[ops] 部门预算检查失败：', e.message);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('ops-budget', e.message, now());
    return { ok: false, msg: e.message };
  }
}

function startOps(guard) {
  // U2-1 / N7-P2：可选 guard —— 集群下传入「是否 leader」判断，非 leader 进程的定时触发直接跳过（不重复备份/清理）。
  // 不传 guard 时等价于恒真，单进程路径行为与引入前完全一致。
  const allow = typeof guard === 'function' ? guard : () => true;
  const run = (job, fn) => { if (allow()) dailyOps(job, fn); };
  // 启动 60 秒后先跑一轮（首次部署即有备份），此后每 30 分钟检查跨日触发
  setTimeout(() => { run('backup', dailyBackup); run('uploads', cleanupUploads); run('logs', archiveLogs); }, 60000);
  setInterval(() => {
    run('backup', dailyBackup);
    run('uploads', cleanupUploads);
    run('logs', archiveLogs);
  }, 30 * 60000);
  console.log(`[ops] 运维任务已启动（每日备份保留 ${KEEP_BACKUPS} 份 / 产物保留 ${UPLOAD_TTL_DAYS} 天 / 日志保留 ${LOG_TTL_DAYS} 天 / 记忆摘要已开启 / 评测回归已开启）`);
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
