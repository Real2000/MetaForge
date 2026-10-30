/**
 * 部门组织架构 CRUD（2026-10-29 P0 组织树地基）
 *
 * P0 路线：departments 表为组织树主体，users.dept_id 为 persons 映射；
 *         后续钉钉同步回调写入 departments 行，结构兼容。
 *
 * departments 字段：
 *   id         INTEGER PRIMARY KEY
 *   parent_id  INTEGER DEFAULT NULL REFERENCES departments(id) —— 树状
 *   name       TEXT NOT NULL
 *   path       TEXT DEFAULT '' —— "/1/5/12" 全文快速祖先/子节点查询
 *   order_num  INTEGER DEFAULT 0 —— 同级排序
 *   created_at TEXT
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');

const router = express.Router();
router.use(auth);

// ---------- 树工具 ----------
function buildPath(id, parentId) {
  if (!parentId) return '/' + id;
  const p = db.prepare('SELECT path FROM departments WHERE id=?').get(parentId);
  return (p ? p.path : '') + '/' + id;
}
function nextOrder(parentId) {
  const r = db.prepare('SELECT COALESCE(MAX(order_num),-1)+1 n FROM departments WHERE parent_id IS ?').get(parentId || null);
  return r ? r.n : 0;
}

// ---------- 列表（递归树，前端弹窗需要） ----------
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY order_num, id').all();
  // 组装成树（平铺结构，前端自己展开）
  res.json({ code: 0, data: rows });
});

// ---------- 单条 ----------
router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!d) return res.json({ code: 404, msg: '部门不存在' });
  res.json({ code: 0, data: d });
});

// ---------- 创建 ----------
router.post('/', (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '部门名称不能为空' });
  const info = db.prepare(`INSERT INTO departments (parent_id,name,path,order_num,created_at) VALUES (?,?,?,?,datetime('now','localtime'))`).run(parent_id || null, name.trim(), '', nextOrder(parent_id));
  const id = info.lastInsertRowid;
  // 更新 path
  const path = buildPath(id, parent_id || null);
  db.prepare(`UPDATE departments SET path=? WHERE id=?`).run(path, id);
  res.json({ code: 0, data: { id } });
});

// ---------- 修改 ----------
router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '部门不存在' });
  const { name, parent_id } = req.body || {};
  const n = (name || '').trim();
  if (!n) return res.json({ code: 400, msg: '部门名称不能为空' });
  db.prepare('UPDATE departments SET name=?,parent_id=? WHERE id=?').run(n, parent_id || null, old.id);
  // 更新本节点 path
  const path = buildPath(old.id, parent_id || null);
  db.prepare(`UPDATE departments SET path=? WHERE id=?`).run(path, old.id);
  // 递归更新所有子节点的 path
  const walk = (pid, ppath) => {
    const kids = db.prepare('SELECT id FROM departments WHERE parent_id=?').all(pid);
    for (const k of kids) {
      const kp = ppath + '/' + k.id;
      db.prepare(`UPDATE departments SET path=? WHERE id=?`).run(kp, k.id);
      walk(k.id, kp);
    }
  };
  walk(old.id, path);
  res.json({ code: 0, msg: '已更新' });
});

// ---------- 删除（级联删除子部门） ----------
router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '部门不存在' });
  // 禁止删除有用户的部门（防止孤立 dept_id）
  const cnt = db.prepare('SELECT COUNT(*) c FROM users WHERE dept_id=?').get(old.id);
  if (cnt && cnt.c > 0) return res.json({ code: 400, msg: '该部门下存在用户，请先调整用户部门后再删除' });
  // 收集全部子孙 ID 级联删除
  const ids = [old.id];
  const walk = (pid) => {
    const kids = db.prepare('SELECT id FROM departments WHERE parent_id=?').all(pid);
    for (const k of kids) { ids.push(k.id); walk(k.id); }
  };
  walk(old.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM departments WHERE id IN (${placeholders})`).run(...ids);
  res.json({ code: 0, msg: '已删除（含子部门）' });
});

module.exports = router;
