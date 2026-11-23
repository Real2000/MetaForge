/**
 * P1-20 配置中心接口路由（2026-11-13）
 *
 * GET  /api/config  — 列出全部可配置项
 * POST /api/config  — 更新某项配置（仅管理员）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { auth, adminOnly } = require('../lib/auth');
const { db, now } = require('../db');
const config = require('../lib/config');

const router = express.Router();
router.use(auth);

router.get('/', (req, res) => {
  const items = config.exportConfigs(req.user);
  res.json({ code: 0, data: { items, groups: [...new Set(items.map(i => i.group))] } });
});

router.post('/', adminOnly, (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.json({ code: 400, msg: '请提供 key' });
  try {
    const coerced = config.set(key, value);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '更新配置', `config.${key}=${JSON.stringify(coerced)}`, req.ip, now()]);
    res.json({ code: 0, data: { key, value: coerced } });
  } catch (e) {
    res.json({ code: 400, msg: e.message });
  }
});

module.exports = router;