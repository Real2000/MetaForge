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
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('ops-backup', e.message, now());
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
    t.op_logs = db.prepare("DELETE FROM op_logs WHERE created_at < ? AND username != 'system'").run(cutoff).changes;
    t.err_logs = db.prepare('DELETE FROM err_logs WHERE created_at < ?').run(cutoff).changes;
    t.task_runs = db.prepare('DELETE FROM task_runs WHERE started_at < ?').run(cutoff).changes;
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

/** 每日运维任务（幂等标记，防同日重复执行） */
const ranAt = new Map(); // job -> dayKey
function dailyOps(job, fn) {
  const today = dayKey();
  if (ranAt.get(job) === today) return;
  ranAt.set(job, today);
  fn();
}

function startOps() {
  // 启动 60 秒后先跑一轮（首次部署即有备份），此后每 30 分钟检查跨日触发
  setTimeout(() => { dailyOps('backup', dailyBackup); dailyOps('uploads', cleanupUploads); dailyOps('logs', archiveLogs); }, 60000);
  setInterval(() => {
    dailyOps('backup', dailyBackup);
    dailyOps('uploads', cleanupUploads);
    dailyOps('logs', archiveLogs);
  }, 30 * 60000);
  console.log(`[ops] 运维任务已启动（每日备份保留 ${KEEP_BACKUPS} 份 / 产物保留 ${UPLOAD_TTL_DAYS} 天 / 日志保留 ${LOG_TTL_DAYS} 天）`);
}

module.exports = { dailyBackup, cleanupUploads, archiveLogs, startOps };
