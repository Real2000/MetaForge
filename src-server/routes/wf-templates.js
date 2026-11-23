/**
 * 工作流模板库（P5.17）：画布工作流模板的一键复用通道
 * - GET  /api/wf-templates            模板列表（登录可见；workflow 大 JSON 不下发，附节点数/使用数）
 * - GET  /api/wf-templates/:id/detail 模板详情（含完整 workflow——编排页「导入到画布」用）
 * - POST /api/wf-templates/:id/create 一键创建智能体（edit_mode=canvas + 预配置 workflow）→ use_count+1
 * - POST /api/wf-templates            存为模板（编排页「存为模板」；workflow 过 validateWorkflowV2）
 * - DELETE /api/wf-templates/:id      删除（内置模板与平台 seed 不可删；创建者或管理员可删自己的）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { validateWorkflowV2 } = require('../lib/workflow-schema');

const router = express.Router();
router.use(auth);

/** 列表（轻量：不下发 workflow 大 JSON） */
router.get('/', (req, res) => {
  const rows = dal.q(`SELECT id,slug,name,icon,category,description,scene,builtin,use_count,created_by,created_at,
    (SELECT COUNT(*) FROM json_each(workflow, '$.nodes')) AS nodes_count
    FROM workflow_templates ORDER BY builtin DESC, use_count DESC, id ASC`);
  res.json({ code: 0, data: rows });
});

/** 详情（完整 workflow——画布导入用；所有人可读） */
router.get('/:id/detail', (req, res) => {
  const t = dal.getq('SELECT * FROM workflow_templates WHERE id=?', [+req.params.id]);
  if (!t) return res.json({ code: 404, msg: '模板不存在' });
  res.json({ code: 0, data: { ...t, workflow: JSON.parse(t.workflow) } });
});

/** 一键创建：复制模板 workflow → 新建画布智能体草稿（用户改名/改提示词/关联知识库后发布） */
router.post('/:id/create', (req, res) => {
  const t = dal.getq('SELECT * FROM workflow_templates WHERE id=?', [+req.params.id]);
  if (!t) return res.json({ code: 404, msg: '模板不存在' });
  // workflow 二次校验（模板存储时已过，运行期防御）
  const v = validateWorkflowV2(t.workflow);
  if (!v || v.error) return res.json({ code: 500, msg: '模板 workflow 结构异常：' + (v ? v.error : '解析失败') });
  const name = (String((req.body || {}).name || t.name) + '').slice(0, 40) || t.name;
  const exist = dal.getq('SELECT COUNT(*) c FROM agents WHERE name=?', [name]).c;
  const finalName = exist ? `${name}（副本）` : name;
  const info = dal.runq(`INSERT INTO agents (name,description,type,icon,category,model,prompt,workflow,edit_mode,routing_mode,owner,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`, [finalName, t.description || '', 'digital', t.icon || '🎨', t.category || '通用', '',
      `【工作流模板：${t.name}】${t.description || ''}\n\n使用说明：${t.scene || '按需调整节点参数'}`,
      JSON.stringify(v), 'canvas', 'workflow', req.user.username, 'draft']);
  dal.runq('UPDATE workflow_templates SET use_count=use_count+1 WHERE id=?', [t.id]);
  dal.runq(`INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)`, [req.user.username, '从模板创建工作流', `${finalName}（模板：${t.name}）`, req.ip, now()]);
  res.json({ code: 0, msg: `已创建「${finalName}」草稿——去编排页改提示词/知识库后发布`, data: { id: Number(info.lastInsertRowid), name: finalName } });
});

/** 存为模板（编排页「存为模板」）：当前画布 → 模板库（个人模板；name 必填） */
router.post('/', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.json({ code: 400, msg: '模板名称不能为空' });
  if (!b.workflow) return res.json({ code: 400, msg: '缺少画布数据（workflow）' });
  const v = validateWorkflowV2(typeof b.workflow === 'string' ? b.workflow : JSON.stringify(b.workflow));
  if (!v || v.error) return res.json({ code: 400, msg: '画布结构不合法：' + (v ? v.error : '解析失败') });
  const info = dal.runq(`INSERT INTO workflow_templates (slug,name,icon,category,description,scene,workflow,builtin,use_count,created_by,created_at)
    VALUES (NULL,?,?,?,?,?,?,0,0,?,datetime('now','localtime'))`, [name, String(b.icon || '🎨').slice(0, 8), String(b.category || '通用').slice(0, 20),
      String(b.description || '').slice(0, 300), String(b.scene || '').slice(0, 500), JSON.stringify(v), req.user.username]);
  res.json({ code: 0, msg: `模板「${name}」已入库（广场与编排页可用）`, data: { id: Number(info.lastInsertRowid) } });
});

/** 删除（内置 seed 不可删；创建者或管理员可删自定义模板） */
router.delete('/:id', (req, res) => {
  const t = dal.getq('SELECT * FROM workflow_templates WHERE id=?', [+req.params.id]);
  if (!t) return res.json({ code: 404, msg: '模板不存在' });
  if (t.builtin) return res.json({ code: 403, msg: '内置模板不可删除（可复制后修改）' });
  if (t.created_by !== req.user.username && req.user.role !== 'admin') return res.json({ code: 403, msg: '仅模板创建者或管理员可删除' });
  dal.runq('DELETE FROM workflow_templates WHERE id=?', [t.id]);
  res.json({ code: 0, msg: '模板已删除' });
});

module.exports = router;
