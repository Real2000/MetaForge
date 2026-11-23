/** 意见反馈（2026-10-20 帮助体系）：全站反馈通道 + 闭环处理
 *  用户侧（auth）：
 *  - POST /api/feedback        提交反馈 { type: bug/suggest/consult, content, contact? }
 *  - GET  /api/feedback/mine   我的反馈（含处理状态与回复——闭环可见）
 *  管理侧（adminOnly）：
 *  - GET  /api/feedback        全部反馈 + 统计（后台管理页数据源）
 *  - PUT  /api/feedback/:id    处理反馈 { reply } → 置为已处理并向提交者发站内信「你的反馈已处理」
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

const TYPE_META = { bug: 'Bug 报告', suggest: '功能建议', consult: '使用咨询' };

router.post('/', (req, res) => {
  const { type, content, contact } = req.body || {};
  const t = TYPE_META[type] ? type : 'consult';
  const c = String(content || '').trim();
  if (!c) return res.json({ code: 400, msg: '请填写反馈内容' });
  if (c.length > 1000) return res.json({ code: 400, msg: '反馈内容请控制在 1000 字以内' });
  // 简易频率限制：同一用户 60 秒内最多 2 条（防误触连点）
  const recent = dal.getq(`SELECT COUNT(*) c FROM feedbacks WHERE username=? AND created_at >= datetime('now','-60 second','localtime')`, [req.user.username]).c;
  if (recent >= 2) return res.json({ code: 429, msg: '提交太频繁了，请稍后再试' });
  const info = dal.runq("INSERT INTO feedbacks (username,type,content,contact,status,created_at) VALUES (?,?,?,?,'pending',?)", [req.user.username, t, c, String(contact || '').slice(0, 100), now()]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '提交反馈', `${TYPE_META[t]}（#${info.lastInsertRowid}）`, req.ip, now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: '反馈已提交，我们会尽快处理并通过站内通知告知你' });
});

router.get('/mine', (req, res) => {
  const rows = dal.q('SELECT id,type,content,status,reply,created_at,handled_at FROM feedbacks WHERE username=? ORDER BY id DESC LIMIT 20', [req.user.username]);
  res.json({ code: 0, data: rows });
});

// ---------- 管理侧 ----------
router.get('/', adminOnly, (req, res) => {
  const rows = dal.q('SELECT f.id, f.username, f.type, f.content, f.contact, f.status, f.reply, f.handler, f.handled_at, f.created_at, u.nickname FROM feedbacks f LEFT JOIN users u ON u.username=f.username ORDER BY f.id DESC LIMIT 200');
  const stat = {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    processed: rows.filter(r => r.status === 'processed').length,
    today: dal.getq(`SELECT COUNT(*) c FROM feedbacks WHERE created_at >= date('now','localtime')`).c,
    byType: {
      bug: dal.getq(`SELECT COUNT(*) c FROM feedbacks WHERE type='bug'`).c,
      suggest: dal.getq(`SELECT COUNT(*) c FROM feedbacks WHERE type='suggest'`).c,
      consult: dal.getq(`SELECT COUNT(*) c FROM feedbacks WHERE type='consult'`).c,
    },
  };
  res.json({ code: 0, data: { list: rows, stat } });
});

router.put('/:id', adminOnly, (req, res) => {
  const fb = dal.getq('SELECT * FROM feedbacks WHERE id=?', [req.params.id]);
  if (!fb) return res.json({ code: 404, msg: '反馈不存在' });
  const reply = String((req.body || {}).reply || '').trim();
  if (!reply) return res.json({ code: 400, msg: '请填写处理回复（会作为站内信发给提交者）' });
  if (reply.length > 500) return res.json({ code: 400, msg: '回复请控制在 500 字以内' });
  dal.runq("UPDATE feedbacks SET status='processed', reply=?, handler=?, handled_at=? WHERE id=?", [reply, req.user.username, now(), fb.id]);
  // 闭环：站内信通知提交者「你的反馈已处理」（通知中心铃铛即时可见）
  dal.runq('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)', [fb.username, '💬 你的反馈已处理', `你提交的「${TYPE_META[fb.type] || '反馈'}」（${(fb.content || '').slice(0, 40)}${(fb.content || '').length > 40 ? '…' : ''}）已处理：${reply}`, 'feedback', '', now()]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '处理反馈', `#${fb.id}（${fb.username}，${TYPE_META[fb.type]}）`, req.ip, now()]);
  res.json({ code: 0, msg: '已处理并通知提交者' });
});

// 删除反馈（管理员：清理垃圾/测试数据）
router.delete('/:id', adminOnly, (req, res) => {
  const fb = dal.getq('SELECT id FROM feedbacks WHERE id=?', [req.params.id]);
  if (!fb) return res.json({ code: 404, msg: '反馈不存在' });
  dal.runq('DELETE FROM feedbacks WHERE id=?', [fb.id]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '删除反馈', `#${fb.id}`, req.ip, now()]);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
