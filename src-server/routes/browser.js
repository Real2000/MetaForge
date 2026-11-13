/**
 * P2-18 浏览器自动化管理路由（2026-11-13）
 *
 * 提供浏览器自动化的 REST 管理接口，用于后台管理/监控浏览会话。
 * GET  /api/browser/automations      — 历史记录列表
 * POST /api/browser/automations/run  — 执行浏览器自动化任务
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');

const router = express.Router();
router.use(auth);

// 查询浏览器自动化历史记录
router.get('/automations', (req, res) => {
  const { status, page = 1, pageSize = 50 } = req.query;
  let sql = 'SELECT * FROM browser_automations WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  args.push(+pageSize, (+page - 1) * +pageSize);
  const rows = db.prepare(sql).all(...args);
  res.json({ code: 0, data: { list: rows, page: +page, pageSize: +pageSize } });
});

// 执行浏览器自动化任务（简单的导航+截图）
router.post('/automations/run', async (req, res) => {
  const { url, action, selector, text } = req.body || {};
  if (!url) return res.json({ code: 400, msg: '请提供 URL' });
  try {
    const ba = require('../lib/browser-automation');
    const session = await ba.launchSession();
    if (session.error) return res.json({ code: 500, msg: session.error });
    const sid = session.session_id;
    let result = { navigated: false, screenshot: null };
    // 导航
    const nav = await ba.navigate(sid, url);
    result.navigated = true;
    result.title = nav.title;
    // 可选操作：点击 / 输入
    if (action === 'click' && selector) { await ba.click(sid, selector); result.clicked = selector; }
    if (action === 'type' && selector && text) { await ba.typeText(sid, selector, text); result.typed = true; }
    // 截图
    const shot = await ba.screenshot(sid);
    result.screenshot = { base64: shot.base64 }; // 前端可用 data:image/png;base64,${...} 展示
    // 关闭
    await ba.closeSession(sid);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: 500, msg: '浏览器自动化执行失败：' + e.message });
  }
});

module.exports = router;