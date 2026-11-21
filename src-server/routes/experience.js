/**
 * D3-2 经验自进化 V1 API（2026-11-21）
 *
 * 覆盖：
 *  - 任务类型清单：/task-types（供前端筛选与归类提示）
 *  - 经验记录：/records（专家 × 任务类型聚合记录 + 概览）
 *  - 专家优选：/agents?task_type= （按可靠度排序，供编排器「优先高分」参考）
 *  - 经验回写：POST /record（供编排链路/管理端登记一次运行结果，含首跑/复跑分桶）
 *  - 自进化验收指标：/improvement（同类任务「首跑 vs 复跑」成功率提升 ≥ 15pp）
 *  - 指标总览：/stats（后台指标卡）
 *
 * 全部路由要求 JWT 认证（router.use(auth)）。经验为系统级共享学习数据（按 agent 聚合，非按用户隔离）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const experience = require('../lib/experience');

const router = express.Router();
router.use(auth);

const isAdmin = (u) => u && u.role === 'admin';

/** 记录一次（专家 × 任务类型）运行结果：读旧值 → applyRun 聚合 → UPSERT */
function recordRun({ agent_id, task_type, task_text, success, duration_ms }) {
  const agentId = Number(agent_id);
  if (!Number.isFinite(agentId) || agentId <= 0) return { err: 'agent_id 非法' };
  const type = task_type || experience.classifyTask(task_text || '');
  const ok = !!success;
  const dur = Number(duration_ms) || 0;
  const prev = db.prepare('SELECT * FROM agent_experience WHERE agent_id=? AND task_type=?').get(agentId, type) || {};
  const next = experience.applyRun(prev, { success: ok, durationMs: dur });
  if (prev.id) {
    db.prepare(`UPDATE agent_experience SET runs=?,success=?,failed=?,first_runs=?,first_success=?,repeat_runs=?,repeat_success=?,total_duration_ms=?,last_status=?,last_at=?,updated_at=? WHERE id=?`)
      .run(next.runs, next.success, next.failed, next.first_runs, next.first_success, next.repeat_runs, next.repeat_success, next.total_duration_ms, ok ? 'success' : 'failed', now(), now(), prev.id);
  } else {
    db.prepare(`INSERT INTO agent_experience (agent_id,task_type,runs,success,failed,first_runs,first_success,repeat_runs,repeat_success,total_duration_ms,last_status,last_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(agentId, type, next.runs, next.success, next.failed, next.first_runs, next.first_success, next.repeat_runs, next.repeat_success, next.total_duration_ms, ok ? 'success' : 'failed', now(), now());
  }
  const row = db.prepare('SELECT * FROM agent_experience WHERE agent_id=? AND task_type=?').get(agentId, type);
  return { data: { ...experience.normalizeRecord(row), isFirst: (Number(prev.runs) || 0) === 0 } };
}

/* ============================ 查询 ============================ */

/** 任务类型清单 */
router.get('/task-types', (req, res) => {
  res.json({ code: 0, data: { types: experience.allTypes(), target: experience.TARGET_LIFT } });
});

/** 经验记录（专家 × 任务类型聚合）+ 概览 */
router.get('/records', (req, res) => {
  const cond = [], args = [];
  if (req.query.task_type) { cond.push('task_type=?'); args.push(String(req.query.task_type)); }
  if (req.query.agent_id != null && req.query.agent_id !== '') { cond.push('agent_id=?'); args.push(Number(req.query.agent_id)); }
  const rows = db.prepare(`SELECT * FROM agent_experience ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY runs DESC, id DESC LIMIT 500`).all(...args);
  const all = cond.length ? db.prepare('SELECT * FROM agent_experience').all() : rows;
  res.json({ code: 0, data: rows.map(experience.normalizeRecord), overview: experience.overview(all) });
});

/** 专家优选排行（供编排器「优先高分」参考）：候选可传 agent_ids，缺省取全部已发布智能体 */
router.get('/agents', (req, res) => {
  const taskType = req.query.task_type ? String(req.query.task_type) : '';
  let agents;
  if (req.query.agent_ids) {
    const ids = String(req.query.agent_ids).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
    agents = ids.length ? db.prepare(`SELECT id,name FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  } else {
    agents = db.prepare("SELECT id,name FROM agents WHERE status='published' ORDER BY id").all();
  }
  const records = db.prepare('SELECT * FROM agent_experience').all();
  res.json({ code: 0, data: experience.rankAgents(agents, records, taskType), task_type: taskType || null });
});

/** 自进化验收指标：同类任务首跑 vs 复跑成功率 */
router.get('/improvement', (req, res) => {
  const rows = db.prepare('SELECT * FROM agent_experience').all();
  res.json({ code: 0, data: experience.evolutionStats(rows), records: rows.length });
});

/** 指标总览（后台指标卡） */
router.get('/stats', (req, res) => {
  const rows = db.prepare('SELECT * FROM agent_experience').all();
  const norm = rows.map(experience.normalizeRecord);
  const top = [...norm].sort((a, b) => b.reliability - a.reliability || b.runs - a.runs).slice(0, 20);
  const nameOf = new Map(db.prepare('SELECT id,name FROM agents').all().map(a => [Number(a.id), a.name]));
  const topNamed = top.map(r => ({ ...r, name: nameOf.get(r.agent_id) || ('#' + r.agent_id) }));
  const byType = experience.evolutionStats(rows).byType.map(t => ({
    ...t, agents: norm.filter(r => r.task_type === t.task_type).length,
  }));
  res.json({ code: 0, data: {
    overview: experience.overview(rows),
    evolution: experience.evolutionStats(rows),
    top: topNamed,
    byType,
    target: experience.TARGET_LIFT,
  } });
});

/* ============================ 回写 ============================ */

/** 登记一次运行结果（编排链路内部回写 / 管理端手工登记） */
router.post('/record', (req, res) => {
  const b = req.body || {};
  const r = recordRun({
    agent_id: b.agent_id, task_type: b.task_type, task_text: b.task_text || b.task,
    success: b.success, duration_ms: b.duration_ms,
  });
  if (r.err) return res.json({ code: 400, msg: r.err });
  res.json({ code: 0, data: r.data, msg: r.data.isFirst ? '已记录（该类任务首跑）' : '已记录并更新经验' });
});

/** 清空经验（管理员）：重置自进化基线 */
router.post('/reset', (req, res) => {
  if (!isAdmin(req.user)) return res.json({ code: 403, msg: '需要管理员权限' });
  const n = db.prepare('SELECT COUNT(*) c FROM agent_experience').get().c;
  db.prepare('DELETE FROM agent_experience').run();
  res.json({ code: 0, msg: `已清空 ${n} 条经验记录` });
});

module.exports = router;
module.exports.recordRun = recordRun; // 供 chat.js 编排链路回写复用
