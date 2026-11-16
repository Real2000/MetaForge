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
 *   monthly_budget REAL DEFAULT 0 —— U1-6 月度成本预算（元，0=不设不告警）
 *   budget_alert_level INTEGER DEFAULT 0 —— U1-6 已提醒档位（0/1/2，仿 quota_alert_level 防轰炸）
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth'); // V1.1 审查加固 2026-10-30：写操作加 adminOnly（组织架构属管理职能，部门 ID 已成授权语义输入）

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

// P0-3 收尾 2026-10-30：平铺部门行 → 嵌套树（GET /tree 数据组装；纯函数一并导出便于单测）
// 每节点 { id, parent_id, name, path, order_num, children:[...] }；根 = parent_id 为空的行；
// 同级按 order_num 再按 id 升序（与列表接口排序一致）；孤儿行（parent_id 指向不存在的部门，
// 仅手工改库会产生）兕底挂到根级，避免树接口静默丢数据；空表/空入参返回 []
// V1.1 审查加固 2026-10-30：环状引用（互指成环，PUT 无校验时可构造）时环上节点从 roots 不可达——
// DFS 标记可达集，不可达节点清空 children 后挂根级，防整棵树静默消失且与注释承诺一致
function buildTree(rows) {
  const list = (rows || []).map(r => ({ id: r.id, parent_id: r.parent_id ?? null, name: r.name, path: r.path, order_num: r.order_num ?? 0, monthly_budget: r.monthly_budget || 0, children: [] }));
  const byId = new Map(list.map(n => [n.id, n]));
  const roots = [];
  for (const n of list) {
    const p = n.parent_id != null && n.parent_id !== n.id ? byId.get(n.parent_id) : null;
    if (p) p.children.push(n); else roots.push(n); // 父存在→挂子；否则（根/孤儿/自指）挂根级
  }
  // 环兕底：从 roots DFS 标记可达节点；不可达（环上）节点清空 children 后挂根级，不再成环
  const seen = new Set();
  const mark = n => { if (seen.has(n.id)) return; seen.add(n.id); n.children.forEach(mark); };
  roots.forEach(mark);
  for (const n of list) {
    if (!seen.has(n.id)) { n.children.length = 0; roots.push(n); }
  }
  const sortSib = arr => { arr.sort((a, b) => (a.order_num - b.order_num) || (a.id - b.id)); arr.forEach(n => sortSib(n.children)); };
  sortSib(roots);
  return roots;
}

// ---------- 列表（递归树，前端弹窗需要） ----------
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY order_num, id').all();
  // 组装成树（平铺结构，前端自己展开）
  res.json({ code: 0, data: rows });
});

// ---------- 部门树（P0-3 收尾 2026-10-30：agents 编排页「可见部门」部门树多选数据源） ----------
// 注意：必须注册在 GET /:id 之前——Express 按注册顺序匹配，否则 /tree 的 "tree" 会被当成
// :id 参数命中单条路由，返回 404「部门不存在」（经典路由顺序坑）
router.get('/tree', (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY order_num, id').all();
  res.json({ code: 0, data: buildTree(rows) });
});

// ---------- 单条 ----------
router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!d) return res.json({ code: 404, msg: '部门不存在' });
  res.json({ code: 0, data: d });
});

// ---------- 创建（V1.1 审查加固：仅管理员） ----------
router.post('/', adminOnly, (req, res) => {
  const { name, parent_id, monthly_budget } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '部门名称不能为空' });
  const budget = monthly_budget !== undefined ? Number(monthly_budget) : 0;
  if (!Number.isFinite(budget) || budget < 0) return res.json({ code: 400, msg: '月度预算必须为非负数字' });
  const info = db.prepare(`INSERT INTO departments (parent_id,name,path,order_num,monthly_budget,created_at) VALUES (?,?,?,?,?,datetime('now','localtime'))`).run(parent_id || null, name.trim(), '', nextOrder(parent_id), budget);
  const id = info.lastInsertRowid;
  // 更新 path
  const path = buildPath(id, parent_id || null);
  db.prepare(`UPDATE departments SET path=? WHERE id=?`).run(path, id);
  res.json({ code: 0, data: { id } });
});

// ---------- 修改（V1.1 审查加固：仅管理员 + 环校验） ----------
router.put('/:id', adminOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '部门不存在' });
  const { name, parent_id, monthly_budget } = req.body || {};
  const n = (name || '').trim();
  if (!n) return res.json({ code: 400, msg: '部门名称不能为空' });
  // U1-6：月度预算可更新（未传保持原值）；预算调整后重置告警档位重新计（仿 quota resetQuotaAlert）
  const budget = monthly_budget !== undefined ? Number(monthly_budget) : (old.monthly_budget || 0);
  if (!Number.isFinite(budget) || budget < 0) return res.json({ code: 400, msg: '月度预算必须为非负数字' });
  // V1.1 审查加固 2026-10-30：环校验——沿 parent_id 链上溯遇自身即拒绝；
  // 不校验时两步 PUT 可构造互指环，存量 walk() 递归更新 path 会栈溢出 500，且环上部门无法通过 API 删除自愈
  let cur = parent_id || null, hops = 0;
  while (cur != null) {
    if (cur === old.id) return res.json({ code: 400, msg: '不能将部门挂到自身或其子部门下' });
    const p = db.prepare('SELECT parent_id FROM departments WHERE id=?').get(cur);
    if (!p) break;
    cur = p.parent_id;
    if (++hops > 100) break; // 防御：数据异常时跳出，不阻塞请求
  }
  db.prepare('UPDATE departments SET name=?,parent_id=?,monthly_budget=?,budget_alert_level=0 WHERE id=?').run(n, parent_id || null, budget, old.id);
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

// ---------- 删除（级联删除子部门；V1.1 审查加固：仅管理员） ----------
router.delete('/:id', adminOnly, (req, res) => {
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
// P0-3 收尾 2026-10-30：树组装纯函数一并导出（单测 require('.../departments').buildTree；
// 默认导出保持 router 不变，server.js 的 app.use('/api/departments', require(...)) 无需改动）
module.exports.buildTree = buildTree;
