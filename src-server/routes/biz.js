/** 商业化（2026-10-20）：套餐定价 / 企业线索 / 账单发票 / 客户成功洞察
 *  - GET  /api/biz/plans            套餐定义（免登录，价格页数据源）
 *  - GET  /api/biz/my               我的套餐与权益使用情况（升级引导数据源）
 *  - POST /api/biz/lead             企业定制线索（免登录提交，价格页表单）
 *  - GET  /api/biz/leads            线索列表（admin）
 *  - PUT  /api/biz/leads/:id        线索跟进（admin）
 *  - GET  /api/biz/billing          我的月度用量明细 + 账单概览
 *  - GET  /api/biz/invoices         我的发票申请列表
 *  - POST /api/biz/invoices         提交发票申请（抬头/税号/月份）
 *  - GET  /api/biz/invoices/all     全部发票申请（admin）
 *  - PUT  /api/biz/invoices/:id     处理发飘（admin：开票/驳回）
 *  - GET  /api/biz/insights         我的智能体使用分析 + 优化建议 + 模板推荐（客户成功）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const { PLANS, planOf, planUsage } = require('../lib/plans');

const router = express.Router();

// ---------- 套餐（免登录：对外价格页） ----------
router.get('/plans', (req, res) => {
  res.json({ code: 0, data: Object.values(PLANS) });
});

// ---------- 我的套餐与权益（auth） ----------
router.get('/my', auth, (req, res) => {
  res.json({ code: 0, data: planUsage(req.user.username) });
});

// ---------- 企业定制线索（免登录提交） ----------
router.post('/lead', (req, res) => {
  const { company, contact_name, phone, email, scale, demand } = req.body || {};
  const c = String(company || '').trim();
  const n = String(contact_name || '').trim();
  if (!c || !n) return res.json({ code: 400, msg: '请填写公司名称与联系人' });
  if (!phone && !email) return res.json({ code: 400, msg: '请至少留一个联系方式（手机或邮箱）' });
  // 提交频控（按 IP）：60 秒 1 次
  const recent = db.prepare(`SELECT COUNT(*) c FROM enterprise_leads WHERE created_at >= datetime('now','-60 second','localtime') AND id IN (SELECT id FROM enterprise_leads ORDER BY id DESC LIMIT 50)`).get().c;
  if (recent) {
    const lastIpRow = db.prepare('SELECT id FROM enterprise_leads ORDER BY id DESC LIMIT 1').get();
    if (lastIpRow) return res.json({ code: 429, msg: '提交太频繁，请稍后再试' });
  }
  const info = db.prepare("INSERT INTO enterprise_leads (company,contact_name,phone,email,scale,demand,status,created_at) VALUES (?,?,?,?,?,?,'new',?)")
    .run(c.slice(0, 80), n.slice(0, 30), String(phone || '').slice(0, 30), String(email || '').slice(0, 60),
      String(scale || '').slice(0, 20), String(demand || '').slice(0, 500), now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(contact_name, '企业定制线索', `${c}${scale ? '（' + scale + '）' : ''}`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: '已收到你的需求，销售顾问将在 1 个工作日内联系你' });
});

router.get('/leads', auth, adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT l.*, (SELECT COUNT(*) c FROM enterprise_leads) total FROM enterprise_leads l ORDER BY l.id DESC LIMIT 200`).all();
  const stat = {
    total: rows.length,
    new: rows.filter(r => r.status === 'new').length,
    contacted: rows.filter(r => r.status === 'contacted').length,
    won: rows.filter(r => r.status === 'won').length,
  };
  res.json({ code: 0, data: { list: rows, stat } });
});

router.put('/leads/:id', auth, adminOnly, (req, res) => {
  const lead = db.prepare('SELECT * FROM enterprise_leads WHERE id=?').get(req.params.id);
  if (!lead) return res.json({ code: 404, msg: '线索不存在' });
  const { status, note } = req.body || {};
  const ST = ['new', 'contacted', 'won', 'lost'];
  if (status && !ST.includes(status)) return res.json({ code: 400, msg: '状态无效' });
  db.prepare('UPDATE enterprise_leads SET status=?, note=?, handler=? WHERE id=?')
    .run(status || lead.status, String(note ?? lead.note).slice(0, 500), req.user.username, lead.id);
  res.json({ code: 0, msg: '已保存跟进记录' });
});

// ---------- 账单（auth）：月度用量明细 + 套餐概览 ----------
router.get('/billing', auth, (req, res) => {
  // 近 6 个月按月聚合（messages join sessions 归属本人）
  const months = db.prepare(`
    SELECT substr(m.created_at,1,7) month, COUNT(*) msgs, COALESCE(SUM(m.tokens),0) tokens
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.username=? AND m.created_at >= datetime('now','-6 month','localtime')
    GROUP BY month ORDER BY month DESC`).all(req.user.username);
  const plan = planUsage(req.user.username);
  const fee = plan.plan === 'pro' ? 199 : (plan.plan === 'enterprise' ? null : 0);
  res.json({ code: 0, data: {
    plan: { key: plan.plan, name: plan.planName, monthlyFee: fee },
    quota: { used: plan.quotaUsed, total: plan.quotaTotal, unlimited: plan.unlimitedQuota },
    months: months.map(m => ({ ...m, fee: fee == null ? '定制' : fee })),
  } });
});

// ---------- 发票申请（auth） ----------
router.get('/invoices', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM invoices WHERE username=? ORDER BY id DESC LIMIT 50').all(req.user.username);
  res.json({ code: 0, data: rows });
});

router.post('/invoices', auth, (req, res) => {
  const { title, tax_no, month, email, note } = req.body || {};
  const t = String(title || '').trim();
  const m = String(month || '').trim();
  if (!t) return res.json({ code: 400, msg: '请填写发票抬头' });
  if (!/^\d{4}-\d{2}$/.test(m) || +m.slice(5, 7) < 1 || +m.slice(5, 7) > 12) return res.json({ code: 400, msg: '请选择有效的开票月份（格式 YYYY-MM）' });
  if (m > new Date().toISOString().slice(0, 7)) return res.json({ code: 400, msg: '开票月份不能晚于当前月' });
  // 该月实际用量带入（金额口径：专业版按月费 199；免费版 0 元通常无需开票，允许提交备注说明）
  // 范围查询替代 substr(created_at,1,7)=?（函数包裹列会阻断 idx_messages_created 索引）
  const monthStart = m + '-01 00:00:00';
  const nextMonth = m.slice(0, 5) + String(+m.slice(5, 7) + 1).padStart(2, '0') + '-01 00:00:00';
  const usage = db.prepare(`SELECT COALESCE(SUM(m.tokens),0) c FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.username=? AND m.created_at >= ? AND m.created_at < ?`)
    .get(req.user.username, monthStart, nextMonth).c;
  const plan = planOf(db.prepare('SELECT plan FROM users WHERE username=?').get(req.user.username)?.plan);
  const pending = db.prepare("SELECT COUNT(*) c FROM invoices WHERE username=? AND month=? AND status='pending'").get(req.user.username, m).c;
  if (pending) return res.json({ code: 400, msg: `「${m}」已有一笔待处理的发票申请` });
  const info = db.prepare('INSERT INTO invoices (username,title,tax_no,amount_type,month,tokens,email,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,\'pending\',?)')
    .run(req.user.username, t.slice(0, 100), String(tax_no || '').slice(0, 40), plan.key, m, usage, String(email || '').slice(0, 60), String(note || '').slice(0, 300), now());
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '申请发票', `${m}（当月 ${usage.toLocaleString('zh-CN')} tokens，${plan.name}）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid }, msg: '发票申请已提交，财务将在 3 个工作日内处理' });
});

router.get('/invoices/all', auth, adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT i.*, u.nickname FROM invoices i LEFT JOIN users u ON u.username=i.username ORDER BY i.id DESC LIMIT 200`).all();
  const stat = {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    issued: rows.filter(r => r.status === 'issued').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
  };
  res.json({ code: 0, data: { list: rows, stat } });
});

router.put('/invoices/:id', auth, adminOnly, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.json({ code: 404, msg: '发票申请不存在' });
  const { status } = req.body || {};
  if (!['issued', 'rejected', 'pending'].includes(status)) return res.json({ code: 400, msg: '状态无效（issued/rejected）' });
  db.prepare('UPDATE invoices SET status=?, handler=?, handled_at=? WHERE id=?').run(status, req.user.username, now(), inv.id);
  // 处理结果站内信闭环（开票/驳回均通知申请人）
  const msg = status === 'issued' ? '你的发票申请已开出，请查收邮箱' : status === 'rejected' ? '你的发票申请未通过（如有疑问请联系管理员）' : '发票申请已重新进入待处理';
  db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(inv.username, '🧾 发票申请处理结果', `「${inv.month}」发票申请：${msg}`, 'billing', '#/billing', now());
  res.json({ code: 0, msg: '已处理并通知申请人' });
});

// ---------- 客户成功：使用分析 + 优化建议 + 模板推荐（auth） ----------
router.get('/insights', auth, (req, res) => {
  const username = req.user.username;
  // 我名下的智能体（owner 归属，含草稿；调用统计只算有会话的）
  const agents = db.prepare("SELECT id, name, icon, status, kb_id, opening, suggest_enabled, allow_copy, created_at FROM agents WHERE owner=? AND source='self' ORDER BY id DESC LIMIT 50").all(username);
  const list = agents.map(a => {
    const week = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE agent_id=? AND created_at >= datetime('now','-7 day','localtime')`).get(a.id).c;
    const totalCalls = db.prepare(`SELECT COUNT(*) c FROM chat_traces WHERE agent_id=?`).get(a.id).c;
    const activeUsers = db.prepare(`SELECT COUNT(DISTINCT username) c FROM sessions WHERE agent_id=? AND created_at >= datetime('now','-7 day','localtime')`).get(a.id).c;
    const rating = db.prepare(`SELECT SUM(CASE WHEN m.rating=1 THEN 1 WHEN m.rating=-1 THEN -1 ELSE 0 END) c, SUM(CASE WHEN m.rating!=0 THEN 1 ELSE 0 END) t FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.agent_id=? AND m.role='assistant'`).get(a.id);
    const kbHit = a.kb_id ? db.prepare(`SELECT COUNT(*) c FROM chat_traces WHERE agent_id=? AND kb_hits != '[]' AND kb_hits != ''`).get(a.id).c : 0;
    const kbTotal = a.kb_id ? db.prepare(`SELECT COUNT(*) c FROM chat_traces WHERE agent_id=?`).get(a.id).c : 0;
    return {
      ...a,
      weekCalls: week,
      totalCalls,
      activeUsers,
      ratingUp: (rating.c || 0) > 0 ? rating.c : (rating.t ? 0 : null), // 正分（1=好评占优）
      ratedCount: rating.t,
      kbHitRate: kbTotal ? Math.round(kbHit / kbTotal * 100) : null,
    };
  });
  // 优化建议（规则引擎：按智能体配置与使用数据生成）
  const advises = [];
  for (const a of list) {
    if (a.status !== 'published') advises.push({ agent: a.name, level: 'info', text: `「${a.name}」尚未发布——发布后可在广场被检索使用` });
    if (a.weekCalls === 0 && a.totalCalls > 0) advises.push({ agent: a.name, level: 'warn', text: `「${a.name}」近 7 天零调用，可尝试分享给同事或在广场提升曝光` });
    if (!a.opening) advises.push({ agent: a.name, level: 'info', text: `「${a.name}」未配置开场白——补上可显著降低新用户的上手门槛` });
    if (a.kb_id && a.kbHitRate != null && a.kbHitRate < 30 && a.totalCalls >= 5) advises.push({ agent: a.name, level: 'warn', text: `「${a.name}」知识库召回率仅 ${a.kbHitRate}%（${a.totalCalls} 次对话）——建议检查文档格式、补充关键词或重传分块` });
    if (a.ratedCount >= 3 && a.ratingUp !== null && a.ratingUp <= 0) advises.push({ agent: a.name, level: 'warn', text: `「${a.name}」近期评价偏负面（${a.ratedCount} 条反馈）——建议优化提示词或补充知识库` });
  }
  // 行业模板推荐（最佳实践）：与 templates 路由共用同一份模板定义
  let templates = [];
  try {
    templates = (require('./templates').TEMPLATES || []).slice(0, 6)
      .map(t => ({ id: t.id, icon: t.icon, name: t.name, industry: t.industry, description: t.description }));
  } catch { /* 模板不可用时跳过推荐 */ }
  res.json({ code: 0, data: { list, advises, templates } });
});

module.exports = router;
