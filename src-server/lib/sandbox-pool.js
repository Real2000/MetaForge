/**
 * 沙箱池 V1（D3-3，2026-11-21）
 *
 * 目标：在 sandbox.js 的「一次性子进程隔离执行」之上，增加**预热池 + 快照 + 按租户并发配额**，
 * 让沙箱执行具备：冷启动 < 3 秒、跨租户隔离越权 0 例、可按租户限制并发。
 *
 * 设计（复用 sandbox.js 的 prelude 语义与 sandbox_runs 审计）：
 *   - 预热：sandbox-worker.js 常驻若干「待命」工作进程；执行作业时直接取用（warm hit），
 *           池空时现场 spawn（cold start，计入冷启动指标）。
 *   - 隔离：每个作业独占一个一次性工作进程 + 一次性工作目录；作业结束进程自毁，
 *           跨作业/跨租户不共享内存或目录（进程边界即隔离边界）。
 *   - 快照：把一份预置环境目录（依赖/辅助文件）登记为快照并可激活；新工作进程的工作目录
 *           由「激活快照」播种，实现「预热即带环境」。
 *   - 配额：sandbox_pools 按租户（owner/空间）限制 max_concurrent 并发；超限直接 denied。
 *
 * 纯逻辑（quotaExceeded / meetsColdStart / poolSummary / snapshotMeta / isolationVerdict）
 * 与有状态池管理分离，后者供 routes/sandbox.js 复用，前者被 test/smoke.js 直接单测。
 */
const { spawn } = require('child_process');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, now } = require('../db');

const TARGET_COLD_MS = 3000;         // 冷启动验收线：< 3 秒
const DEFAULT_MAX_CONCURRENT = 2;    // 租户默认并发上限
const DEFAULT_WARM_SIZE = 1;         // 租户默认预热进程数
const MAX_WARM_TOTAL = 8;            // 全局空闲预热进程上限（防资源滥用）
const IDLE_TTL_MS = 60 * 1000;       // 空闲预热进程存活上限（超时回收）
const OUT_LIMIT = 8 * 1024;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024; // 单快照体积上限
const SNAPSHOT_REL_ROOT = path.join('public', 'uploads', 'sandbox-snapshots');
const WORKER_SCRIPT = path.join(__dirname, 'sandbox-worker.js');

/* ============================ 纯逻辑（可单测） ============================ */

/** 并发配额判定：当前忙碌数 ≥ 上限 → 超限 */
function quotaExceeded(busy, maxConcurrent) {
  const max = Number(maxConcurrent);
  if (!Number.isFinite(max) || max <= 0) return false; // 上限 ≤0 视为不限
  return (Number(busy) || 0) >= max;
}

/** 冷启动是否达标（严格 < 目标毫秒；无样本 → 不算达标也不失败） */
function meetsColdStart(ms, target = TARGET_COLD_MS) {
  if (ms == null) return null;
  return Number(ms) < target;
}

/** 池状态汇总 */
function poolSummary(workers) {
  const list = workers || [];
  const byTenant = {};
  let idle = 0, busy = 0;
  for (const w of list) {
    const t = w.tenant || 'default';
    if (w.state === 'idle') idle++; else busy++;
    byTenant[t] = byTenant[t] || { idle: 0, busy: 0 };
    byTenant[t][w.state === 'idle' ? 'idle' : 'busy']++;
  }
  return { total: list.length, idle, busy, byTenant };
}

/** 规范化快照记录（补派生字段） */
function snapshotMeta(row) {
  const r = row || {};
  const bytes = Number(r.size_bytes) || 0;
  return {
    id: Number(r.id) || 0,
    name: r.name || '',
    source_dir: r.source_dir || '',
    snapshot_path: r.snapshot_path || '',
    node_version: r.node_version || '',
    prelude_hash: r.prelude_hash || '',
    size_bytes: bytes,
    size_human: bytes < 1024 ? bytes + 'B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + 'KB' : (bytes / 1024 / 1024).toFixed(2) + 'MB',
    active: !!r.active,
    created_by: r.created_by || '',
    created_at: r.created_at || '',
  };
}

/** 隔离自检结论：只要有任一检查未通过即视为存在越权 */
function isolationVerdict(checks) {
  const list = checks || [];
  const violations = list.filter(c => !c.ok).length;
  return { checks: list, violations, passed: violations === 0 };
}

/** prelude 指纹（快照元数据：记录生成快照时的沙箱基座版本） */
function preludeHash() {
  return crypto.createHash('sha256').update('sbxpool-v1|' + process.versions.node).digest('hex').slice(0, 16);
}

/* ============================ 租户配额（sandbox_pools） ============================ */

function defaultQuota(tenant) {
  return { tenant, max_concurrent: DEFAULT_MAX_CONCURRENT, max_idle: DEFAULT_WARM_SIZE, warm_size: DEFAULT_WARM_SIZE, enabled: 1 };
}

/** 读取某租户配额（无记录 → 默认值，enabled=1） */
function quotaOf(tenant) {
  const t = String(tenant || 'default');
  const row = dal.getq('SELECT * FROM sandbox_pools WHERE tenant=?', [t]);
  const q = row ? {
    tenant: row.tenant,
    max_concurrent: Number(row.max_concurrent),
    max_idle: Number(row.max_idle),
    warm_size: Number(row.warm_size),
    enabled: Number(row.enabled),
  } : defaultQuota(t);
  return { ...q, enabled: q.enabled ? 1 : 0 };
}

function listPools() {
  const rows = dal.q('SELECT * FROM sandbox_pools ORDER BY id').map(r => ({ ...r, enabled: !!r.enabled }));
  const busy = Object.fromEntries(busyByTenant);
  return rows.map(r => ({ ...r, busy: busy[r.tenant] || 0, pool: poolSummary([...idlePool.values()].map(w => ({ tenant: w.tenant, state: 'idle' }))) }));
}

/** 登记/更新租户配额 */
function upsertPool({ tenant, max_concurrent, max_idle, warm_size, enabled, createdBy }) {
  const t = String(tenant || '').trim();
  if (!t) throw new Error('租户（tenant）不能为空');
  const old = dal.getq('SELECT * FROM sandbox_pools WHERE tenant=?', [t]);
  const mc = max_concurrent === undefined ? (old ? old.max_concurrent : DEFAULT_MAX_CONCURRENT) : Math.max(0, Number(max_concurrent) || 0);
  const mi = max_idle === undefined ? (old ? old.max_idle : DEFAULT_WARM_SIZE) : Math.max(0, Number(max_idle) || 0);
  const ws = warm_size === undefined ? (old ? old.warm_size : DEFAULT_WARM_SIZE) : Math.max(0, Math.min(MAX_WARM_TOTAL, Number(warm_size) || 0));
  const en = enabled === undefined ? (old ? old.enabled : 1) : (enabled ? 1 : 0);
  if (old) {
    dal.runq('UPDATE sandbox_pools SET max_concurrent=?,max_idle=?,warm_size=?,enabled=?,updated_at=? WHERE tenant=?', [mc, mi, ws, en, now(), t]);
  } else {
    dal.runq('INSERT INTO sandbox_pools (tenant,max_concurrent,max_idle,warm_size,enabled,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [t, mc, mi, ws, en, String(createdBy || ''), now(), now()]);
  }
  return quotaOf(t);
}

/* ============================ 快照（sandbox_snapshots） ============================ */

/** 递归统计目录大小与文件数 */
function dirStats(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp);
      else { bytes += st.size; files++; }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** 创建快照：把源目录复制到快照根（登记 node 版本与 prelude 指纹） */
function createSnapshot({ name, source, createdBy }) {
  const n = String(name || '').trim();
  const src = String(source || '').trim();
  if (!n) throw new Error('快照名称不能为空');
  if (!src) throw new Error('源目录（source）不能为空');
  const abs = path.isAbsolute(src) ? src : path.join(process.cwd(), src);
  if (!fs.existsSync(abs)) throw new Error('源目录不存在：' + src);
  if (!fs.statSync(abs).isDirectory()) throw new Error('源路径不是目录：' + src);
  const { bytes } = dirStats(abs);
  if (bytes > SNAPSHOT_MAX_BYTES) throw new Error(`源目录过大（${(bytes / 1024 / 1024).toFixed(1)}MB > ${SNAPSHOT_MAX_BYTES / 1024 / 1024}MB）`);
  const slug = 'snap-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const destAbs = path.join(process.cwd(), SNAPSHOT_REL_ROOT, slug);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(abs, destAbs, { recursive: true });
  const rel = path.join(SNAPSHOT_REL_ROOT, slug);
  const info = dal.runq(`INSERT INTO sandbox_snapshots (name, source_dir, snapshot_path, node_version, prelude_hash, size_bytes, active, created_by, created_at)
    VALUES (?,?,?,?,?,?,0,?,?)`, [n, src, rel, process.versions.node, preludeHash(), bytes, String(createdBy || ''), now()]);
  return snapshotMeta(dal.getq('SELECT * FROM sandbox_snapshots WHERE id=?', [info.lastInsertRowid]));
}

function listSnapshots() {
  return dal.q('SELECT * FROM sandbox_snapshots ORDER BY id DESC').map(snapshotMeta);
}

/** 激活某快照（同一时刻仅一个激活；新工作进程目录从激活快照播种） */
function activateSnapshot(id) {
  const s = dal.getq('SELECT * FROM sandbox_snapshots WHERE id=?', [Number(id)]);
  if (!s) throw new Error('快照不存在');
  dal.runq('UPDATE sandbox_snapshots SET active=0');
  dal.runq('UPDATE sandbox_snapshots SET active=1 WHERE id=?', [s.id]);
  // 已预热的空闲进程目录不含新快照 → 回收，下次按新快照重建
  recycleAllIdle();
  return snapshotMeta(dal.getq('SELECT * FROM sandbox_snapshots WHERE id=?', [s.id]));
}

function deleteSnapshot(id) {
  const s = dal.getq('SELECT * FROM sandbox_snapshots WHERE id=?', [Number(id)]);
  if (!s) throw new Error('快照不存在');
  const abs = path.join(process.cwd(), s.snapshot_path);
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch { /* 忽略 */ }
  dal.runq('DELETE FROM sandbox_snapshots WHERE id=?', [s.id]);
  return { deleted: s.id };
}

function activeSnapshotDir() {
  const s = dal.getq('SELECT * FROM sandbox_snapshots WHERE active=1 ORDER BY id DESC LIMIT 1');
  if (!s) return null;
  const abs = path.join(process.cwd(), s.snapshot_path);
  return fs.existsSync(abs) ? abs : null;
}

/* ============================ 预热进程池（有状态） ============================ */

const idlePool = new Map();   // workerId -> { id, child, tenant, workDir, spawnedAt, state:'idle' }
const busyByTenant = new Map(); // tenant -> 当前并发数
let seq = 0;

function newWorkDirId() { return 'sbxpool-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }

/** 创建（spawn）一个待命工作进程，工作目录由激活快照播种 */
function spawnWorker(tenant) {
  const workDir = path.join(os.tmpdir(), newWorkDirId());
  fs.mkdirSync(workDir, { recursive: true });
  const snap = activeSnapshotDir();
  if (snap) { try { fs.cpSync(snap, workDir, { recursive: true }); } catch { /* 播种失败不阻断 */ } }
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    cwd: workDir, shell: false,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workDir, NODE_ENV: 'sandbox-pool' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const id = 'w' + (++seq);
  const w = { id, child, tenant: String(tenant || 'default'), workDir, spawnedAt: Date.now(), state: 'idle', stdout: '', stderr: '' };
  idlePool.set(id, w);
  monkeyPatchResultCapture(w);
  return w;
}

/** 从空闲池取一个同租户待命进程；无则现场 spawn（冷启动） */
function acquire(tenant) {
  const t = String(tenant || 'default');
  sweepIdle();
  for (const [id, w] of idlePool) {
    if (w.tenant === t && w.state === 'idle') {
      idlePool.delete(id);
      return { worker: w, poolHit: true };
    }
  }
  // 现场 spawn（冷启动）：spawnWorker 会先登记进 idlePool，取用后须移出，避免被下次误当空闲复用
  const w = spawnWorker(t);
  idlePool.delete(w.id);
  return { worker: w, poolHit: false };
}

function sweepIdle() {
  const nowMs = Date.now();
  for (const [id, w] of idlePool) {
    if (nowMs - w.spawnedAt > IDLE_TTL_MS) { destroyWorker(w); idlePool.delete(id); }
  }
}

function recycleAllIdle() {
  for (const [id, w] of idlePool) { destroyWorker(w); idlePool.delete(id); }
}

function destroyWorker(w) {
  try { fs.rmSync(w.workDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { w.child.kill('SIGKILL'); } catch { /* 忽略 */ }
}

/** 为该租户把空闲预热进程补齐到 warm_size（受全局上限约束），后台执行不阻塞 */
function replenish(tenant) {
  const q = quotaOf(tenant);
  if (!q.enabled) return;
  const t = String(tenant);
  let mine = 0, total = 0;
  for (const w of idlePool.values()) { total++; if (w.tenant === t) mine++; }
  const want = Math.min(q.warm_size || 0, q.max_idle || 0);
  for (let i = mine; i < want && total < MAX_WARM_TOTAL; i++, total++) {
    const w = spawnWorker(t);
    // 预 spawn 后无需立即等待；worker 就绪后 stdin 可写即可接收作业
    try { w.child.unref(); } catch { /* unref 失败不影响功能 */ }
  }
}

/** 预热（显式 API）：保证该租户有 n 个待命进程 */
function warmUp(tenant, n) {
  const q = quotaOf(tenant);
  const target = Math.max(0, Math.min(MAX_WARM_TOTAL, Number(n) || q.warm_size || 0));
  replenish(tenant);
  const t = String(tenant);
  let mine = 0;
  for (const w of idlePool.values()) if (w.tenant === t) mine++;
  for (let i = mine; i < target && idlePool.size < MAX_WARM_TOTAL; i++) spawnWorker(t);
  return poolStats();
}

/* ============================ 结果捕获 ============================ */

/** worker 启动即挂 stdout 捕获（等待 __POOL_RESULT__ 行）——作业与结果一一握手 */
function monkeyPatchResultCapture(w) {
  w._onResult = null;
  w.child.stdout.setEncoding('utf8');
  w.child.stdout.on('data', (d) => {
    w.stdout += d;
    const i = w.stdout.indexOf('__POOL_RESULT__');
    if (i >= 0 && w._onResult) {
      const line = w.stdout.slice(i + '__POOL_RESULT__'.length).split('\n')[0];
      let payload = null;
      try { payload = JSON.parse(line); } catch { payload = null; }
      const cb = w._onResult; w._onResult = null;
      if (payload) cb(payload);
    }
  });
  w.child.stderr.setEncoding('utf8');
  w.child.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(0, OUT_LIMIT); });
}

/* ============================ 池化执行（主入口） ============================ */

/** 写审计行（sandbox_runs，run_env='pool'） */
function auditStart({ tenant, owner, agentId, sessionId, code }) {
  const digest = crypto.createHash('sha256').update(String(code || '')).digest('hex').slice(0, 16);
  const info = dal.runq(`INSERT INTO sandbox_runs (run_env, tenant, owner, agent_id, session_id, status, code_digest, pool_hit, created_at)
    VALUES ('pool', ?, ?, ?, ?, 'running', ?, 0, ?)`, [String(tenant || ''), owner || '', agentId, sessionId, digest, now()]);
  return Number(info.lastInsertRowid);
}

/**
 * 池化执行：runPooled({ code, tenant, owner, timeoutMs, netAllow, globals, agentId, sessionId })
 * 返回 { status, stdout, stderr, durationMs, coldStartMs, poolHit, slot, runId, files }；永不 reject。
 */
async function runPooled(opts = {}) {
  const {
    code = '', tenant, owner = '', timeoutMs = 15000, netAllow = [], globals = undefined,
    agentId = null, sessionId = null,
  } = opts;
  if (!String(code).trim()) return { status: 'denied', stdout: '', stderr: '代码为空', runId: null };
  const t = String(tenant || owner || 'default');
  const q = quotaOf(t);
  if (!q.enabled) return { status: 'denied', stdout: '', stderr: `租户「${t}」的沙箱池已停用`, runId: null };
  const busy = busyByTenant.get(t) || 0;
  if (quotaExceeded(busy, q.max_concurrent)) {
    return { status: 'denied', stdout: '', stderr: `超出并发配额（${t}：上限 ${q.max_concurrent}，当前 ${busy}）`, runId: null, quotaDenied: true };
  }
  busyByTenant.set(t, busy + 1);

  const runId = auditStart({ tenant: t, owner: owner || t, agentId, sessionId, code });
  const t0 = Date.now();
  const { worker, poolHit } = acquire(t);
  const slot = worker.id;
  try {
    const result = await new Promise((resolve) => {
      const killer = setTimeout(() => {
        destroyWorker(worker);
        resolve({ status: 'timeout', stdout: '', stderr: '执行超时（SIGKILL）', exitCode: -1, durationMs: Date.now() - t0, files: [] });
      }, Math.max(1000, timeoutMs));
      worker._onResult = (payload) => { clearTimeout(killer); resolve(payload); };
      worker.child.on('error', (e) => { clearTimeout(killer); resolve({ status: 'failed', stdout: '', stderr: '子进程启动失败：' + e.message, exitCode: -1, durationMs: Date.now() - t0, files: [] }); });
      worker.child.on('exit', () => { if (worker._onResult) { clearTimeout(killer); resolve({ status: 'failed', stdout: '', stderr: '工作进程异常退出（无结果）', exitCode: -1, durationMs: Date.now() - t0, files: [] }); } });
      try {
        worker.child.stdin.write(JSON.stringify({ code: String(code), netAllow, globals, timeoutMs }) + '\n');
      } catch (e) {
        clearTimeout(killer);
        resolve({ status: 'failed', stdout: '', stderr: '作业下发失败：' + e.message, exitCode: -1, durationMs: Date.now() - t0, files: [] });
      }
    });

    const durationMs = result.durationMs != null ? result.durationMs : (Date.now() - t0);
    const coldStartMs = poolHit ? null : (Date.now() - t0); // 池空 → 本次即冷启动
    const status = result.status || 'failed';
    const stdout = String(result.stdout || '').slice(0, OUT_LIMIT);
    const stderr = String(result.stderr || '').slice(0, OUT_LIMIT);
    dal.runq('UPDATE sandbox_runs SET status=?, exit_code=?, duration_ms=?, node_version=?, stdout_excerpt=?, stderr_excerpt=?, pool_hit=?, cold_start_ms=? WHERE id=?', [status, result.exitCode ?? -1, durationMs, process.versions.node, stdout.slice(0, 2000), stderr.slice(0, 1000), poolHit ? 1 : 0, coldStartMs, runId]);
    // 一次性进程用完即毁（保隔离）；后台补足预热
    destroyWorker(worker);
    replenish(t);
    return { status, stdout, stderr, exitCode: result.exitCode ?? -1, durationMs, coldStartMs, poolHit, slot, runId, files: result.files || [], tenant: t };
  } finally {
    busyByTenant.set(t, Math.max(0, (busyByTenant.get(t) || 1) - 1));
  }
}

/* ============================ 指标与自检 ============================ */

function poolStats() {
  sweepIdle();
  const workers = [...idlePool.values()].map(w => ({ tenant: w.tenant, state: 'idle' }));
  const sum = poolSummary(workers);
  const runs = dal.q("SELECT * FROM sandbox_runs WHERE run_env='pool'");
  const cold = runs.filter(r => Number(r.pool_hit) === 0 && r.cold_start_ms != null);
  const warm = runs.filter(r => Number(r.pool_hit) === 1);
  const avg = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null;
  const coldAvg = avg(cold.map(r => Number(r.cold_start_ms)));
  const success = runs.filter(r => r.status === 'success').length;
  return {
    pool: sum,
    busyByTenant: Object.fromEntries(busyByTenant),
    runs: {
      total: runs.length,
      success,
      denied: runs.filter(r => r.status === 'denied').length,
      poolHits: warm.length,
      coldStarts: cold.length,
      hitRate: runs.length ? Math.round(warm.length / runs.length * 1000) / 10 : null,
      avgColdStartMs: coldAvg,
      avgWarmMs: avg(warm.map(r => Number(r.duration_ms))),
      coldStartMet: meetsColdStart(coldAvg),
    },
    target: TARGET_COLD_MS,
  };
}

/**
 * 隔离自检：验证「进程边界即隔离边界」——分别探测模块/进程/环境可见性与跨进程状态泄漏。
 * 返回 isolationVerdict（violations=0 即「隔离越权 0 例」）。
 */
async function isolationSelfCheck() {
  const checks = [];
  const probe = async (tenant, code, key) => {
    const r = await runPooled({ code, tenant, owner: tenant, timeoutMs: 8000 });
    return { r, out: String(r.stdout || '').trim() };
  };
  // ① 模块边界：require/module 在沙箱内不可见
  const c1 = await probe('iso-a', 'console.log(typeof require, typeof module)', 'require');
  checks.push({ name: '模块边界（require/module 不可见）', ok: c1.out === 'undefined undefined', detail: c1.out });
  // ② 进程环境掩蔽：process.env 已被掩蔽
  const c2 = await probe('iso-a', 'console.log(JSON.stringify(process.env))', 'env');
  checks.push({ name: '环境变量掩蔽（process.env）', ok: /掩蔽/.test(c2.out), detail: c2.out });
  // ③ 跨进程状态不泄漏：A 写全局标记，B 读取应不可见
  await probe('iso-a', 'globalThis.__leak = 42; console.log("set")', 'set');
  const c3 = await probe('iso-b', 'console.log(typeof globalThis.__leak)', 'leak');
  checks.push({ name: '跨进程状态隔离（全局标记不泄漏）', ok: c3.out === 'undefined', detail: c3.out });
  return isolationVerdict(checks);
}

/** 清空池（测试/收尾用）：销毁全部空闲进程与临时目录 */
function resetPool() {
  recycleAllIdle();
  busyByTenant.clear();
}

module.exports = {
  // 常量
  TARGET_COLD_MS, DEFAULT_MAX_CONCURRENT, DEFAULT_WARM_SIZE, MAX_WARM_TOTAL, SNAPSHOT_REL_ROOT,
  // 纯逻辑
  quotaExceeded, meetsColdStart, poolSummary, snapshotMeta, isolationVerdict, preludeHash,
  // 配额
  quotaOf, listPools, upsertPool, defaultQuota,
  // 快照
  createSnapshot, listSnapshots, activateSnapshot, deleteSnapshot, activeSnapshotDir, dirStats,
  // 池
  warmUp, replenish, poolStats, runPooled, isolationSelfCheck, resetPool,
  // 测试观测
  _idlePool: idlePool, _busyByTenant: busyByTenant,
};
