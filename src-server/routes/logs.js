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
