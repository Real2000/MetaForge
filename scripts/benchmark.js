/**
 * B2 压测脚本：对话 / 列表 / 知识库检索 三场景压测 + WAL 写并发摸底
 * 用法：node scripts/benchmark.js [--mode all|chat|list|kb|wal]
 * 前置：平台服务已运行（默认 http://127.0.0.1:3210）
 * 依赖：autocannon（已入 devDependencies）
 * 鉴权：直签 token（与运行中服务共用同一 data/ 的 jwt_secret）——不走登录接口，
 *       避免登录限流（10 次/分钟/IP）干扰压测节奏
 */

const autocannon = require('autocannon');
const fs = require('fs');
const path = require('path');
const { db, now } = require('../src-server/db');
const { sign } = require('../src-server/lib/auth');

const HOST = process.env.BENCHMARK_HOST || 'http://127.0.0.1:3210';
const TEST_MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'all';

async function main() {
  // 1. 直签 admin token（与服务端同源 jwt_secret；不做真实登录避免限流）
  const admin = db.prepare("SELECT id FROM users WHERE username='admin' AND status=1").get();
  if (!admin) throw new Error('admin 账号不存在，无法签发压测 token');
  const TOKEN = sign({ uid: admin.id, exp: Date.now() + 2 * 3600000 });
  console.log(`[b2] 已直签 admin token（前缀 ${TOKEN.slice(0, 12)}…，2h 有效）`);
  const cookieStr = ''; // Bearer 头通道已足够（服务端 readToken 双通道兼容）

  // 3. 准备测试数据：在知识库中插入一篇文档用于检索
  const kbId = await seedTestData();
  // 获取第一个 published agent 用于对话测试
  const agent = db.prepare("SELECT id FROM agents WHERE status='published' AND source='self' LIMIT 1").get();

  // 4. 压测函数
  function runInstance(title, url, opts = {}) {
    return new Promise((resolve, reject) => {
      const instance = autocannon({
        url,
        connections: opts.connections || 20,
        duration: opts.duration || 10,
        pipelining: opts.pipelining || 1,
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Cookie': cookieStr,
        },
        ...opts,
      }, (err, result) => {
        if (err) return reject(err);
        console.log(`\n===== ${title} =====`);
        console.log(`  连接数  : ${result.connections}`);
        console.log(`  管道数  : ${result.pipelining}`);
        console.log(`  持续时间: ${result.duration}s`);
        console.log(`  总请求  : ${result.requests.total}`);
        console.log(`  总错误  : ${result.errors}`);
        console.log(`  超时数  : ${result.timeouts}`);
        console.log(`  非2xx   : ${result.non2xx}`);
        console.log(`  QPS     : ${result.requests.average.toFixed(2)} (avg)`);
        console.log(`  延迟平均值: ${result.latency.average} ms`);
        console.log(`  延迟中位数: ${result.latency.p50} ms`);
        console.log(`  延迟 P99  : ${result.latency.p99} ms`);
        console.log(`  吞吐量  : ${(result.throughput.average / 1024).toFixed(2)} KB/s`);
        resolve(result);
      });
    });
  }

  const results = { chat: null, list: null, kb: null, wal: null };

  // 场景 1: 对话
  if (['all', 'chat'].includes(TEST_MODE)) {
    const prompt = '你好，请自我介绍一下';
    results.chat = await runInstance('对话场景 - POST /api/chat', `${HOST}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        skill: 'default', text: prompt,
        session_id: 'benchmark-' + Date.now(),
      }),
      setupClient: (client) => {
        client.setBody(`{"skill":"default","text":"${prompt}","session_id":"benchmark-${Date.now()}"}`);
      },
    });
  }

  // 场景 2: 列表接口（agents/sessions/kb 等混合）
  if (['all', 'list'].includes(TEST_MODE)) {
    results.list = await runInstance('列表场景 - GET /api/agents', `${HOST}/api/agents`, {
      method: 'GET',
      connections: 50,
      duration: 10,
    });
  }

  // 场景 3: 知识库检索
  if (['all', 'kb'].includes(TEST_MODE) && kbId) {
     results.kb = await runInstance('知识库检索 - POST /api/knowledge/search', `${HOST}/api/knowledge/search`, {
      method: 'POST',
      body: JSON.stringify({ kb_id: kbId, query: '平台功能介绍' }),
      connections: 10,
      duration: 10,
    });
  }

  // 写并发摸底：WAL 模式直接测 SQLite INSERT+SELECT 混合
  if (['all', 'wal'].includes(TEST_MODE)) {
    console.log(`\n===== WAL 写并发摸底 =====`);
    const rowsBefore = db.prepare('SELECT COUNT(*) c FROM op_logs').get().c;
    const WAL_DURATION = 5; // 秒
    const WAL_CONCURRENCY = 16;
    const workers = [];
    const lock = { c: 0, e: null };

    // 并行写入 op_logs + 查询
    for (let i = 0; i < WAL_CONCURRENCY; i++) {
      workers.push(new Promise(res => {
        let count = 0;
        const end = Date.now() + WAL_DURATION * 1000;
        const t0 = Date.now();
        while (Date.now() < end) {
          try {
            db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
              .run('benchmark', 'wal-concurrency', `worker ${i} write ${count}`, '127.0.0.1', now());
            const r = db.prepare('SELECT COUNT(*) c FROM op_logs').pluck().get();
            count++;
            if (count % 100 === 0) { // 每隔 100 次 yield 一下
              const yields = new Promise(r2 => setImmediate(() => r2()));
            }
          } catch (e) {
            if (!lock.e) lock.e = e;
          }
        }
        const dur = Date.now() - t0;
        const qps = Math.round(count / (dur / 1000) );
        res({ count, dur, qps });
      }));
    }
    const wals = await Promise.all(workers);
    const totalOps = wals.reduce((s, x) => s + x.count, 0);
    const avgQps = wals.reduce((s, x) => s + x.qps, 0);
    console.log(`  并发数    : ${WAL_CONCURRENCY}`);
    console.log(`  耗时      : ${WAL_DURATION}s`);
    console.log(`  总写入量  : ${totalOps} ops`);
    console.log(`  平均 QPS  : ${avgQps} ops/s`);
  }

  // 输出结果报告
  console.log(`\n========== 压测报告 ==========`);
  const summary = [];
  if (results.chat) summary.push(`对话: QPS ${results.chat.requests.average.toFixed(1)} / P99 ${results.chat.latency.p99}ms`);
  if (results.list) summary.push(`列表: QPS ${results.list.requests.average.toFixed(1)} / P99 ${results.list.latency.p99}ms`);
  if (results.kb) summary.push(`知识库: QPS ${results.kb.requests.average.toFixed(1)} / P99 ${results.kb.latency.p99}ms`);
  summary.forEach(s => console.log('  ' + s));

  // 清理测试数据
  if (kbId) db.prepare('DELETE FROM kbs WHERE id=?').run(kbId);
  db.prepare("DELETE FROM op_logs WHERE username='benchmark'").run();
}

async function seedTestData() {
  // 插入一个测试知识库
  const r = db.prepare("INSERT INTO kbs (name,owner,created_at) VALUES ('benchmark-kb','admin',datetime('now','localtime'))").run();
  const kbId = r.lastInsertRowid;
  // 插入两个测试文档
  db.prepare(`INSERT INTO kb_chunks (kb_id, file_name, chunk, content, tokens,created_at) VALUES (?,?,?,?,?,?)`).run(kbId, 'platform-intro.md', 0, '智能体开发平台是一个基于自然语言处理的企业级AI平台', 20, now());
  db.prepare(`INSERT INTO kb_chunks (kb_id, file_name, chunk, content, tokens,created_at) VALUES (?,?,?,?,?,?)`).run(kbId, 'platform-intro.md', 1, '该平台支持智能体、知识库、工作流、MCP工具四大核心功能，提供一站式AI服务', 25, now());
  return kbId;
}

main().catch(e => {
  console.error('[b2] 压测异常：', e);
  process.exit(1);
});
