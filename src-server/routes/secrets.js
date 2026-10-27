/**
 * 通用密钥管理（P5.5：画布 {{env.XXX}} 占位符数据源；仅管理员）
 * - 值任何接口不回读明文（列表只给 name/remark/长度）
 * - 命名规范：大写字母数字下划线（画布引用 {{env.NAME}}）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const secrets = require('../lib/secrets');

const router = express.Router();
router.use(auth, adminOnly);

// 列表（不含值）
router.get('/', (req, res) => {
  res.json({ code: 0, data: secrets.listNames() });
});

// 写入/更新/删除（value 为空 = 删除）
router.post('/', (req, res) => {
  const { name, value, remark } = req.body || {};
  const n = String(name || '').trim();
  if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(n)) {
    return res.json({ code: 400, msg: '密钥名须为大写字母开头的字母/数字/下划线（2~50 位），如 DB_PASSWORD' });
  }
  const action = secrets.upsert(n, value, remark);
  if (action === 'deleted') {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除密钥', n, req.ip, now());
    return res.json({ code: 0, msg: '已删除' });
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, action === 'created' ? '新增密钥' : '更新密钥', n, req.ip, now());
  res.json({ code: 0, msg: action === 'created' ? '已创建（画布中用 {{env.' + n + '}} 引用）' : '已更新' });
});

// 批量校验引用可用性（画布保存前可查：给定 [NAME] 返回缺失项）
router.post('/check', (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names.map(String).slice(0, 50) : [];
  const have = new Set(secrets.listNames().map(r => r.name));
  res.json({ code: 0, data: { missing: names.filter(n => !have.has(n)) } });
});

module.exports = router;
