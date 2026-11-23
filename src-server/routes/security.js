/** 安全合规：词库分类 / 敏感词 CRUD / 拦截统计 / 导入导出 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { parseLimit } = require('../lib/pagination'); // P1-3 2026-11-04：limit 容错统一解析

const router = express.Router();
router.use(auth, adminOnly);

router.get('/categories', (req, res) => {
  const rows = dal.q(`
    SELECT c.*, (SELECT COUNT(*) FROM words w WHERE w.category_id=c.id) AS word_count
    FROM word_categories c ORDER BY c.id`);
  res.json({ code: 0, data: rows });
});
router.post('/categories', (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  if (!name) return res.json({ code: 400, msg: '分类名称不能为空' });
  dal.runq('INSERT INTO word_categories (name) VALUES (?)', [name]);
  res.json({ code: 0, msg: '已创建' });
});
router.put('/categories/:id', (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  if (!name) return res.json({ code: 400, msg: '分类名称不能为空' });
  dal.runq('UPDATE word_categories SET name=? WHERE id=?', [name, req.params.id]);
  res.json({ code: 0, msg: '已保存' });
});
router.delete('/categories/:id', (req, res) => {
  const used = dal.getq('SELECT COUNT(*) c FROM words WHERE category_id=?', [req.params.id]).c;
  if (used) return res.json({ code: 400, msg: `分类下还有 ${used} 个词汇，请先移除` });
  dal.runq('DELETE FROM word_categories WHERE id=?', [req.params.id]);
  res.json({ code: 0, msg: '已删除' });
});

router.get('/words', (req, res) => {
  const { category_id, keyword } = req.query;
  let sql = `SELECT w.*, c.name AS category FROM words w LEFT JOIN word_categories c ON c.id=w.category_id WHERE 1=1`;
  const args = [];
  if (category_id) { sql += ' AND w.category_id=?'; args.push(category_id); }
  if (keyword) { sql += ' AND w.word LIKE ?'; args.push(`%${keyword}%`); }
  sql += ' ORDER BY w.id DESC LIMIT 500';
  res.json({ code: 0, data: dal.q(sql, [...args]) });
});

router.post('/words', (req, res) => {
  const { word, category_id, input_block, output_block } = req.body || {};
  if (!word?.trim()) return res.json({ code: 400, msg: '词汇不能为空' });
  const exists = dal.getq('SELECT id FROM words WHERE word=?', [word.trim()]);
  if (exists) return res.json({ code: 400, msg: '词汇已存在' });
  dal.runq(`INSERT INTO words (category_id,word,input_block,output_block,hit_count,created_at) VALUES (?,?,?,?,0,datetime('now','localtime'))`, [category_id || null, word.trim(), input_block ? 1 : 0, output_block ? 1 : 0]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '新增敏感词', word.trim(), req.ip, now()]);
  res.json({ code: 0, msg: '已添加' });
});

router.post('/words/batch', (req, res) => {
  // 批量导入：纯文本，每行一个词
  const { text, category_id, input_block, output_block } = req.body || {};
  if (!text?.trim()) return res.json({ code: 400, msg: '请粘贴词汇内容（每行一个）' });
  const words = [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  const INS_WORD_SQL = `INSERT OR IGNORE INTO words (category_id,word,input_block,output_block,hit_count,created_at) VALUES (?,?,?,?,0,datetime('now','localtime'))`;
  let n = 0;
  words.forEach(w => { if (!dal.getq('SELECT id FROM words WHERE word=?', [w])) { dal.runq(INS_WORD_SQL, [category_id || null, w, input_block ? 1 : 0, output_block ? 1 : 0]); n++; } });
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '批量导入敏感词', `${n} 个词汇`, req.ip, now()]);
  res.json({ code: 0, data: { added: n, total: words.length } });
});

router.put('/words/:id', (req, res) => {
  const old = dal.getq('SELECT * FROM words WHERE id=?', [req.params.id]);
  if (!old) return res.json({ code: 404, msg: '词汇不存在' });
  const { word, category_id, input_block, output_block } = req.body || {};
  dal.runq('UPDATE words SET word=?,category_id=?,input_block=?,output_block=? WHERE id=?', [word || old.word, category_id ?? old.category_id, input_block ? 1 : 0, output_block ? 1 : 0, old.id]);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/words/:id', (req, res) => {
  dal.runq('DELETE FROM words WHERE id=?', [req.params.id]);
  res.json({ code: 0, msg: '已删除' });
});

// 导出（纯文本，每行 词|分类|输入拦截|输出拦截|命中数）
router.get('/export', (req, res) => {
  const rows = dal.q('SELECT w.*, c.name AS category FROM words w LEFT JOIN word_categories c ON c.id=w.category_id ORDER BY w.id');
  const lines = ['词汇\t分类\t输入拦截\t输出拦截\t命中次数', ...rows.map(r => [r.word, r.category || '-', r.input_block ? '开' : '关', r.output_block ? '开' : '关', r.hit_count].join('\t'))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=words-${Date.now()}.csv`);
  res.send('\uFEFF' + lines.join('\n'));
});

// 拦截统计
router.get('/stats', (req, res) => {
  const total = dal.getq('SELECT COUNT(*) c FROM words').c;
  const inputOn = dal.getq('SELECT COUNT(*) c FROM words WHERE input_block=1').c;
  const outputOn = dal.getq('SELECT COUNT(*) c FROM words WHERE output_block=1').c;
  const hits = dal.getq('SELECT COALESCE(SUM(hit_count),0) c FROM words').c;
  const top = dal.q('SELECT word, hit_count FROM words ORDER BY hit_count DESC LIMIT 10');
  res.json({ code: 0, data: { total, inputOn, outputOn, hits, top } });
});

// PII / 注入安全事件统计（P2 安全合规增强）
router.get('/events', (req, res) => {
  // P1-3 分页容错 2026-11-04：limit 负数（SQLite 负 LIMIT=无限制→全量返回）回落默认 50，上限 200 不变
  const limit = parseLimit(req, { def: 50, max: 200 });
  const type = req.query.type;
  const rows = type
    ? dal.q('SELECT * FROM security_events WHERE type=? ORDER BY id DESC LIMIT ?', [type, limit])
    : dal.q('SELECT * FROM security_events ORDER BY id DESC LIMIT ?', [limit]);
  const byType = dal.q('SELECT type, COUNT(*) c FROM security_events GROUP BY type');
  res.json({ code: 0, data: { rows, byType } });
});

module.exports = router;
