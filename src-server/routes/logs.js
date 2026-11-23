/** 系统监控：操作日志 / 异常日志 / 服务监控（真实系统指标） */
const express = require('express');
const os = require('os');
const fs = require('fs');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { parsePagination } = require('../lib/pagination'); // P1-3 2026-11-04：分页参数容错统一解析

const router = express.Router();
router.use(auth, adminOnly);

router.get('/op-logs', (req, res) => {
  const { keyword } = req.query;
  // P1-3 分页容错：page/size 非法值（abc/负数/超大）一律钳制到安全区间，不再依赖各处手写表达式
  const { page, size, offset } = parsePagination(req);
  let sql = 'SELECT * FROM op_logs WHERE 1=1', args = [];
  if (keyword) { sql += ' AND (username LIKE ? OR action LIKE ? OR detail LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) c')).get(...args).c;
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  args.push(size, offset);
  res.json({ code: 0, data: { list: db.prepare(sql).all(...args), total } });
});

router.get('/err-logs', (req, res) => {
  // P1-3 分页容错：同 op-logs 统一解析（原 +req.query.page 写法碰巧不 500，但与全项目语义不一）
  const { size, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) c FROM err_logs').get().c;
  const list = db.prepare('SELECT * FROM err_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(size, offset);
  res.json({ code: 0, data: { list, total } });
});

router.delete('/err-logs', (req, res) => {
  db.prepare('DELETE FROM err_logs').run();
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '清空异常日志', '手动清理', req.ip, now());
  res.json({ code: 0, msg: '已清空' });
});

// ---------- AI-13 RAG 检索可观测（2026-11-23）：单次检索全链路诊断数据源 ----------
// 数据源：chat_traces.retrieval_trace（AI-09/AI-01/02/04/05/06/07 全链路 trace 已随对话落库）。
// 验收语义：后台可见单次检索全链路；可直接回答「为什么没召回」——前端按 trace 结构化字段
// 自动归因（0 命中时呈现：改写后查询 / 引擎与 ANN 覆盖度 / 重排阈值门控通过数 / 图谱通道）。
router.get('/rag-traces', (req, res) => {
  const dal = require('../lib/dal');
  const { agent_id, session_id } = req.query;
  const { size, offset } = parsePagination(req, { maxSize: 50 });
  // 租户边界：adminOnly 下租户管理员仅见本租户（平台超管 bypass 全见）——新端点走 dal 统一出口（BE-C1）
  const tw = dal.tenantWhere('t', dal.tenantScope(req));
  const conds = ["t.retrieval_trace IS NOT NULL AND t.retrieval_trace NOT IN ('[]','{}','')"];
  const args = [...tw.args];
  if (agent_id) { conds.push('t.agent_id=?'); args.push(Number(agent_id) || 0); }
  if (session_id) { conds.push('t.session_id=?'); args.push(Number(session_id) || 0); }
  const where = ' WHERE ' + conds.join(' AND ') + tw.sqlStr;
  const baseSql = `FROM chat_traces t
    LEFT JOIN agents a ON a.id=t.agent_id
    LEFT JOIN sessions s ON s.id=t.session_id
    LEFT JOIN messages m ON m.id=t.message_id AND m.role='user'` + where;
  const total = dal.getq(`SELECT COUNT(*) c ${baseSql}`, args).c;
  const rows = dal.q(`SELECT t.id, t.session_id, t.message_id, t.agent_id, t.mode, t.latency_ms, t.tokens,
      t.kb_hits, t.retrieval_trace, t.created_at,
      a.name AS agent_name, s.title AS session_title, s.username, m.content AS query
    ${baseSql} ORDER BY t.id DESC LIMIT ? OFFSET ?`, [...args, size, offset]);
  const safeParse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
  const list = rows.map(r => {
    const trace = safeParse(r.retrieval_trace, {});
    const kbHits = safeParse(r.kb_hits, []);
    return {
      id: r.id, session_id: r.session_id, message_id: r.message_id, agent_id: r.agent_id,
      agent_name: r.agent_name || '', session_title: r.session_title || '', username: r.username || '',
      query: r.query || '', mode: r.mode, latency_ms: r.latency_ms, tokens: r.tokens, created_at: r.created_at,
      hit_count: Array.isArray(kbHits) ? kbHits.length : 0,
      kb_hits: kbHits,
      trace, // 结构化全链路：rewrite / engine / ann / rerank / graph / context / faithfulness / memory
    };
  });
  res.json({ code: 0, data: { list, total } });
});

// ---------- BE-F1（2026-11-23）：按 requestId 检索贯穿日志链 ----------
// 验收语义：每次请求可检索到 requestId 贯穿的日志链——access_logs（骨架：方法/路径/状态/耗时/用户/租户）
// + err_logs（请求内异常，server.js 错误中间件必带）+ op_logs（audit 拦截器自动补——安全审计主通道）。
router.get('/request-chain', (req, res) => {
  const dal = require('../lib/dal');
  const rid = String(req.query.request_id || '').trim();
  if (!/^[0-9a-f]{6,64}$/i.test(rid)) return res.json({ code: 400, msg: '请提供合法的 requestId（响应头 X-Request-Id）' });
  const access = dal.getq('SELECT * FROM access_logs WHERE request_id=?', [rid]) || null;
  const errs = dal.q('SELECT id, source, message, created_at FROM err_logs WHERE request_id=? ORDER BY id DESC', [rid]);
  const ops = dal.q('SELECT id, username, action, detail, ip, created_at FROM op_logs WHERE request_id=? ORDER BY id DESC', [rid]);
  res.json({ code: 0, data: { request_id: rid, access, errs, ops } });
});

// 服务监控（真实指标 + 90 秒采样趋势）
const cpuSamples = [];
let lastCpu = os.cpus().map(c => c.times);
function sampleCpu() {
  const cur = os.cpus().map(c => c.times);
  let idle = 0, total = 0;
  cur.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const dIdle = t.idle - p.idle;
    const dTotal = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + dIdle;
    idle += dIdle; total += dTotal;
  });
  lastCpu = cur;
  const usage = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  cpuSamples.push({ t: Date.now(), cpu: usage, mem: Math.round(os.freemem() / os.totalmem() * 1000) / 10 });
  if (cpuSamples.length > 90) cpuSamples.shift();
}
setInterval(sampleCpu, 1000);

function diskUsage() {
  try {
    const st = fs.statfsSync(process.cwd());
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - free, pct: Math.round((total - free) / total * 1000) / 10 };
  } catch {
    return null;
  }
}

router.get('/server', (req, res) => {
  const d = diskUsage();
  res.json({
    code: 0,
    data: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      mem: { total: os.totalmem(), free: os.freemem(), pct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10 },
      disk: d,
      uptime: os.uptime(),
      processUptime: process.uptime(),
      nodeVersion: process.version,
      samples: cpuSamples,
      loadavg: os.loadavg(),
    },
  });
});

module.exports = router;
