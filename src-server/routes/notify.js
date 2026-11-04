/** 通知中心（SinguX 式铃铛消息：发布上架广播 / 系统公告）
 *  username='*' 为全员广播，读取时按 (username=me OR username='*') 过滤；
 *  已读状态按用户区分（广播通知每人独立已读：read_marks 记 username+notification_id）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { parseLimit } = require('../lib/pagination'); // P1-3 2026-11-04：limit 容错（原 ?limit=abc → NaN LIMIT 必 500）

const router = express.Router();
router.use(auth);

// 通知列表（unread=1 仅未读；默认最近 30 条）
router.get('/', (req, res) => {
  const unreadOnly = req.query.unread === '1';
  // P1-3 分页容错：limit 非法（abc→NaN）/负数（SQLite 负 LIMIT=无限制）一律回落默认 30，上限 100
  const limit = parseLimit(req, { def: 30, max: 100 });
  const marks = new Set(
    db.prepare('SELECT notification_id FROM notification_reads WHERE username=?').all(req.user.username).map(r => r.notification_id)
  );
  let sql = `SELECT * FROM notifications WHERE (username=? OR username='*')`;
  const args = [req.user.username];
  if (unreadOnly) {
    sql += ` AND id NOT IN (SELECT notification_id FROM notification_reads WHERE username=?)`;
    args.push(req.user.username);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  const list = db.prepare(sql).all(...args).map(n => ({ ...n, is_read: marks.has(n.id) ? 1 : 0 }));
  const unreadCount = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE (username=? OR username='*') AND id NOT IN (SELECT notification_id FROM notification_reads WHERE username=?)`)
    .get(req.user.username, req.user.username).c;
  res.json({ code: 0, data: { list, unread: unreadCount } });
});

// 标记单条已读
router.post('/:id/read', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (username,notification_id,read_at) VALUES (?,?,?)')
    .run(req.user.username, req.params.id, now());
  res.json({ code: 0, msg: '已读' });
});

// 全部已读
router.post('/read-all', (req, res) => {
  const ids = db.prepare(`SELECT id FROM notifications WHERE (username=? OR username='*')`).all(req.user.username);
  const ins = db.prepare('INSERT OR IGNORE INTO notification_reads (username,notification_id,read_at) VALUES (?,?,?)');
  ids.forEach(r => ins.run(req.user.username, r.id, now()));
  res.json({ code: 0, msg: '已全部标记为已读' });
});

module.exports = router;
