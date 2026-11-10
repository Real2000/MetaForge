/**
 * B2 压测与性能基线脚本（2026-11-10）
 * ================================================================
 * 三场景 HTTP 压测 + SQLite WAL 写并发摸底
 *
 * 用法（前置：压测专用服务实例已运行，见 docs/性能基线报告.md）：
 *   AGENT_DATA_DIR=.temp/b2-srv node scripts/benchmark.js                    # 全部：三场景 + WAL 摸底
 *   AGENT_DATA_DIR=.temp/b2-srv node scripts/benchmark.js --mode=list        # 单场景：chat/list/kb
 *   node scripts/benchmark.js --mode=wal                                     # 仅 WAL 写并发摸底（独立库）
 *
 * 内部模式（由主进程 fork，不直接调用）：
 *   node scripts/benchmark.js --wal-worker  <db文件> <秒数>   # 写子进程：同步 INSERT 计数
 *   node scripts/benchmark.js --wal-reader  <db文件> <秒数>   # 读子进程：SELECT COUNT 循环
 *
 * 说明：
 *  - HTTP 压测依赖 autocannon（devDependencies）；鉴权用直签 token（与服务端同库同 jwt_secret），
 *    不走登录接口——登录限流（10 次/分钟/IP）会掐断压测节奏
 *  - 对话场景走「模拟回复」模式（压测库未配模型 Key）——测的是纯平台链路开销（SSE/落库/审计），
 *    排除外部 LLM 延迟干扰，这正是本基线想要的口径
 *  - WAL 摸底用 fork 子进程实现真并发：better-sqlite3 是同步 API，单进程循环只是串行假并发；
 *    SQLite 写天生单写者序列化（WAL 下读不阻塞写），子进程数递增看吞吐是否还能维持
 */
const autocannon = require('autocannon');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOST = process.env.BENCHMARK_HOST || 'http://127.0.0.1:35920';
const argv = process.argv.slice(2);
const TEST_MODE = argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'all';

// ---------- 内部：WAL 写/读子进程 ----------
if (argv[0] === '--wal-worker' || argv[0] === '--wal-reader') {
  const Database = require('better-sqlite3');
  const dbFile = argv[1];
  const seconds = Number(argv[2]) || 5;
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const isWriter = argv[0] === '--wal-worker';
  let count = 0, errors = 0;
  const end = Date.now() + seconds * 1000;
  const t0 = Date.now();
  if (isWriter) {
    const ins = db.prepare("INSERT INTO wal_probe (worker, seq, payload, created_at) VALUES (?,?,?,?)");
    const pid = process.pid;
    while (Date.now() < end) {
      try { ins.run(pid, count, 'x'.repeat(100), Date.now()); count++; }
      catch { errors++; }
    }
  } else {
    const sel = db.prepare('SELECT COUNT(*) c FROM wal_probe');
    while (Date.now() < end) {
      try { sel.get(); count++; }
      catch { errors++; }
    }
  }
  const dur = Date.now() - t0;
  process.stdout.write(JSON.stringify({ ok: true, ops: count, errors, ms: dur, qps: +(count / (dur / 1000)).toFixed(1) }));
  db.close();
  process.exit(0);
}

// ---------- 主流程 ----------
const { db, now } = require('../src-server/db');
const { sign } = require('../src-server/lib/auth');

function runCannon(title, url, opts = {}) {
  return new Promise((resolve) => {
    autocannon({ url, ...opts }, (err, result) => {
      if (err) { console.error(`[${title}] 压测异常：${err.message}`); return resolve(null); }
      console.log(`\n───── ${title} ─────`);
      console.log(`  并发连接 : ${result.connections}    时长 : ${result.duration}s`);
      console.log(`  总请求   : ${result.requests.total}   错误 : ${result.errors}   非2xx : ${result.non2xx}`);
      console.log(`  QPS      : ${result.requests.average.toFixed(1)}（均值）`);
      console.log(`  延迟 ms  : avg ${result.latency.average} / p50 ${result.latency.p50} / p99 ${result.latency.p99}`);
      resolve(result);
    });
  });
}

async function main() {
  const summary = {};

  // ---- 三场景 HTTP 压测（需要服务实例）----
  if (['all', 'chat', 'list', 'kb'].includes(TEST_MODE)) {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin' AND status=1").get();
    if (!admin) throw new Error('压测库无 admin 账号（AGENT_DATA_DIR 指向压测实例数据目录了吗？）');
    const TOKEN = sign({ uid: admin.id, exp: Date.now() + 2 * 3600000 });
    const headers = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
    console.log(`[b2] 目标 ${HOST}｜直签 token ${TOKEN.slice(0, 12)}…`);

    // 场景 1：对话（SSE 流式，模拟回复模式）
    if (['all', 'chat'].includes(TEST_MODE)) {
      // 先建一个压测会话（归属 admin，避免 IDOR 校验 403）
      const sess = db.prepare("INSERT INTO sessions (agent_id,title,username,created_at,updated_at) VALUES (NULL,'b2-压测','admin',datetime('now','localtime'),datetime('now','localtime'))").run();
      summary.chat = await runCannon('场景一：对话 POST /api/chat/stream（SSE · 模拟回复模式）', `${HOST}/api/chat/stream`, {
        method: 'POST', headers, connections: 20, duration: 10,
        body: JSON.stringify({ session_id: sess.lastInsertRowid, content: '平台性能压测' }),
      });
      db.prepare('DELETE FROM sessions WHERE id=?').run(sess.lastInsertRowid);
    }

    // 场景 2：列表 GET /api/agents（含空间过滤与可见性计算，读路径代表）
    if (['all', 'list'].includes(TEST_MODE)) {
      summary.list = await runCannon('场景二：列表 GET /api/agents（可见性过滤）', `${HOST}/api/agents`, {
        method: 'GET', headers, connections: 50, duration: 10,
      });
    }

    // 场景 3：知识库检索 POST /api/knowledge/recall-test（BM25+向量混合）
    if (['all', 'kb'].includes(TEST_MODE)) {
      // 造一个压测知识库 + 足量分片（检索有真实工作量）
      let kbId = db.prepare("SELECT id FROM kbs WHERE name='b2-压测库'").get()?.id;
      if (!kbId) {
        kbId = db.prepare("INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('b2-压测库','压测专用',1,'admin',?)").run(now()).lastInsertRowid;
        const f = db.prepare("INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,?)").run(kbId, 'b2.md', 1024, 'success', 60, now()).lastInsertRowid;
        const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)');
        const seedText = '智能体平台性能基线压测分片内容：包含考勤报销制度、产品功能说明、工作流节点、知识库检索、模型接入配置等主题词汇。';
        for (let i = 0; i < 60; i++) ins.run(f, kbId, `#${i} ${seedText}`);
        console.log('[b2] 已种子压测知识库（1 库 60 分片）');
      }
      summary.kb = await runCannon('场景三：知识库检索 POST /api/knowledge/recall-test（BM25+向量）', `${HOST}/api/knowledge/recall-test`, {
        method: 'POST', headers, connections: 20, duration: 10,
        body: JSON.stringify({ kb_id: kbId, query: '考勤制度 报销标准' }),
      });
      // 清理压测库
      db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId);
      db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(kbId);
      db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
    }
  }

  // ---- WAL 写并发摸底（独立库，fork 子进程真并发）----
  if (['all', 'wal'].includes(TEST_MODE)) {
    console.log('\n═════ SQLite WAL 写并发摸底（独立库 · 子进程真并发） ═════');
    const dbFile = path.join(__dirname, '..', '.temp', 'b2-wal.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    if (fs.existsSync(dbFile)) { fs.rmSync(dbFile); fs.rmSync(dbFile + '-wal', { force: true }); fs.rmSync(dbFile + '-shm', { force: true }); }
    const Database = require('better-sqlite3');
    const init = new Database(dbFile);
    init.exec('CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, worker INTEGER, seq INTEGER, payload TEXT, created_at INTEGER)');
    init.close();

    const runRound = (workers, seconds) => new Promise((resolve) => {
      const t0 = Date.now();
      let done = 0; const stats = [];
      for (let i = 0; i < workers; i++) {
        const child = spawn(process.execPath, [__filename, '--wal-worker', dbFile, String(seconds)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        child.stdout.on('data', d => buf += d);
        child.on('exit', () => {
          try { stats.push(JSON.parse(buf)); } catch { stats.push({ ok: false, ops: 0, errors: 1 }); }
          if (++done === workers) resolve({ workers, seconds, ms: Date.now() - t0, stats });
        });
      }
    });

    summary.wal = {};
    for (const n of [1, 4, 8, 16]) {
      const r = await runRound(n, 5);
      const totalOps = r.stats.reduce((s, x) => s + x.ops, 0);
      const errs = r.stats.reduce((s, x) => s + x.errors, 0);
      const qps = +(totalOps / (r.ms / 1000)).toFixed(1);
      summary.wal[n] = { ops: totalOps, qps, errors: errs };
      console.log(`  ${String(n).padStart(2)} 写进程 : 总写入 ${totalOps} ops / 实测 QPS ${qps} / 写冲突错误 ${errs}`);
    }

    // 混合负载：4 写 + 8 读（WAL 读写不互阻的验证）
    {
      const seconds = 5, t0 = Date.now();
      const stats = []; let done = 0, total = 12;
      const donePromise = new Promise(res => { global.__mixDone = res; });
      const spawnOne = (mode) => {
        const child = spawn(process.execPath, [__filename, '--' + mode, dbFile, String(seconds)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        child.stdout.on('data', d => buf += d);
        child.on('exit', () => { try { stats.push(JSON.parse(buf)); } catch { stats.push({ ops: 0, errors: 1 }); } if (++done === total) global.__mixDone(); });
      };
      for (let i = 0; i < 4; i++) spawnOne('wal-worker');
      for (let i = 0; i < 8; i++) spawnOne('wal-reader');
      await donePromise;
      const w = stats.slice(0, 4), rds = stats.slice(4);
      const wOps = w.reduce((s, x) => s + x.ops, 0), rOps = rds.reduce((s, x) => s + x.ops, 0);
      const ms = Date.now() - t0;
      summary.wal.mix = { writeQps: +(wOps / (ms / 1000)).toFixed(1), readQps: +(rOps / (ms / 1000)).toFixed(1) };
      console.log(`  混合 4写+8读 : 写 QPS ${summary.wal.mix.writeQps} / 读 QPS ${summary.wal.mix.readQps}`);
    }
    // 清理探针库
    setTimeout(() => { try { fs.rmSync(dbFile); fs.rmSync(dbFile + '-wal', { force: true }); fs.rmSync(dbFile + '-shm', { force: true }); } catch { } }, 500);
  }

  console.log('\n═════ 汇总（供基线报告引用） ═════');
  if (summary.chat) console.log(`  对话(SSE)  : QPS ${summary.chat.requests.average.toFixed(1)} / p99 ${summary.chat.latency.p99}ms`);
  if (summary.list) console.log(`  列表(读)   : QPS ${summary.list.requests.average.toFixed(1)} / p99 ${summary.list.latency.p99}ms`);
  if (summary.kb) console.log(`  知识库检索 : QPS ${summary.kb.requests.average.toFixed(1)} / p99 ${summary.kb.latency.p99}ms`);
  if (summary.wal) for (const [n, v] of Object.entries(summary.wal)) {
    if (n === 'mix') console.log(`  WAL混合    : 写 ${v.writeQps} / 读 ${v.readQps} QPS`);
    else console.log(`  WAL ${n} 并发写: QPS ${v.qps}`);
  }
  process.exit(0);
}

main().catch(e => { console.error('[b2] 异常：', e); process.exit(1); });
