/**
 * P1-18 仓储分层 — 智能体（agents）数据访问层（2026-11-13）
 *
 * 渐进式迁移：先把高频/常用的查询收拢至此，routes/agents.js 逐步改用 repo 调用。
 * 新功能直接走 repo，存量路由代码不要求一次性改造。
 */
const { db, now } = require('./base');

/** ========== 基础 CRUD ========== */

function getById(id) {
  return db.prepare('SELECT * FROM agents WHERE id=?').get(id);
}

function getByIdFull(id) {
  return db.prepare('SELECT a.*, s.name AS space_name FROM agents a LEFT JOIN spaces s ON s.id=a.space_id WHERE a.id=?').get(id);
}

function getAllByUser(username, role) {
  let sql = 'SELECT a.*, s.name AS space_name FROM agents a LEFT JOIN spaces s ON s.id=a.space_id WHERE 1=1';
  const args = [];
  if (role !== 'admin') {
    sql += ` AND (a.owner=? OR a.visibility='public' OR a.visibility='restricted')`;
    args.push(username);
  }
  return db.prepare(sql + ' ORDER BY a.updated_at DESC').all(...args);
}

function countByOwner(owner) {
  return db.prepare("SELECT COUNT(*) AS c FROM agents WHERE owner=? AND source='self'").get(owner).c;
}

function getCategories() {
  return db.prepare("SELECT category, COUNT(*) AS c FROM agents WHERE status='published' GROUP BY category ORDER BY c DESC").all();
}

function create(fields) {
  const cols = Object.keys(fields);
  const vals = cols.map(c => fields[c]);
  const info = db.prepare(`INSERT INTO agents (${cols.join(',')},created_at,updated_at) VALUES (${cols.map(() => '?').join(',')},?,?)`)
    .run(...vals, now(), now());
  return Number(info.lastInsertRowid);
}

function update(id, fields) {
  const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = Object.values(fields);
  db.prepare(`UPDATE agents SET ${setClauses},updated_at=datetime('now','localtime') WHERE id=?`).run(...vals, id);
}

function remove(id) {
  db.prepare('DELETE FROM agents WHERE id=?').run(id);
}

/** ========== 提示词版本（LLMOps） ========== */

function insertPromptVersion(agentId, prompt, userPrompt, editedBy, note) {
  const version = db.prepare('SELECT COALESCE(MAX(version),0) v FROM agent_prompt_versions WHERE agent_id=?').get(agentId).v || 0;
  const v = version + 1;
  db.prepare(`INSERT INTO agent_prompt_versions (agent_id,version,prompt,user_prompt,edited_by,note,created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
    .run(agentId, v, prompt || '', userPrompt || '', editedBy || '', note || '');
  return v;
}

function getPromptVersions(agentId, limit = 50) {
  return db.prepare(`SELECT id,version,note,edited_by,created_at FROM agent_prompt_versions WHERE agent_id=? ORDER BY id DESC LIMIT ?`).all(agentId, limit);
}

function getPromptVersionDetail(agentId, versionId) {
  return db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id=? AND id=?').get(agentId, versionId);
}

/** ========== 发布历史 ========== */

function insertPublishRecord(agentId, version, workflow, note, nodes, publishedBy) {
  const info = db.prepare(`INSERT INTO agent_publish_history (agent_id,version,workflow,note,nodes,published_by,created_at)
    VALUES (?,?,?,?,?,?,datetime('now','localtime'))`).run(agentId, version, workflow || '', note || '', nodes || 0, publishedBy || '');
  return Number(info.lastInsertRowid);
}

function getPublishHistory(agentId) {
  return db.prepare('SELECT * FROM agent_publish_history WHERE agent_id=? ORDER BY version DESC').all(agentId);
}

function getLatestPublishVersion(agentId) {
  return db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM agent_publish_history WHERE agent_id=?').get(agentId).v || 0;
}

function findPublishByWorkflow(agentId, workflowJson) {
  return db.prepare('SELECT version FROM agent_publish_history WHERE agent_id=? AND workflow=? ORDER BY version DESC LIMIT 1').get(agentId, workflowJson);
}

function getPublishById(agentId, historyId) {
  return db.prepare('SELECT * FROM agent_publish_history WHERE agent_id=? AND id=?').get(agentId, historyId);
}

/** ========== 审核流 ========== */

function insertReviewRecord(agentId, action, operator, comment) {
  db.prepare(`INSERT INTO agent_reviews (agent_id,action,operator,comment,created_at) VALUES (?,?,?,?,datetime('now','localtime'))`)
    .run(agentId, action, operator || '', comment || '');
}

function getLatestReview(agentId, action) {
  return db.prepare('SELECT * FROM agent_reviews WHERE agent_id=? AND action=? ORDER BY id DESC LIMIT 1').get(agentId, action);
}

function getReviewFlow(agentId, limit = 100) {
  return db.prepare('SELECT * FROM agent_reviews WHERE agent_id=? ORDER BY id DESC LIMIT ?').all(agentId, limit);
}

/** ========== 记忆 ========== */

function getMemories(agentId, username, typeFilter) {
  let sql = 'SELECT id, fact, type, confidence, source, summary, summary_source, created_at, username FROM agent_memories WHERE agent_id=?';
  const args = [agentId];
  if (typeFilter) { sql += ' AND type=?'; args.push(typeFilter); }
  sql += ' ORDER BY id DESC LIMIT 200';
  return db.prepare(sql).all(...args);
}

function clearMemories(agentId) {
  db.prepare('DELETE FROM agent_memories WHERE agent_id=?').run(agentId);
}

/** ========== 运行记录 ========== */

function insertWorkflowRun(agentId, triggerType, inputs) {
  const info = db.prepare(`INSERT INTO workflow_runs (agent_id,trigger_type,status,inputs,started_at) VALUES (?,?,?,?,datetime('now','localtime'))`)
    .run(agentId, triggerType, 'running', inputs || '{}');
  return Number(info.lastInsertRowid);
}

function finishWorkflowRun(runId, success, outputs, nodeLogs, tokens, duration, err) {
  if (success) {
    db.prepare(`UPDATE workflow_runs SET status='success', outputs=?, node_logs=?, total_tokens=?, total_duration_ms=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run(outputs || '', nodeLogs || '', tokens || 0, duration || 0, runId);
  } else {
    db.prepare(`UPDATE workflow_runs SET status='error',outputs='',node_logs=?,error=?,total_duration_ms=?,finished_at=datetime('now','localtime') WHERE id=?`)
      .run(nodeLogs || '', err || '', duration || 0, runId);
  }
}

function getWorkflowRuns(agentId) {
  return db.prepare(`SELECT id,trigger_type,status,inputs,outputs,total_tokens,total_duration_ms,error,started_at,finished_at
    FROM workflow_runs WHERE agent_id=? ORDER BY id DESC LIMIT 50`).all(agentId);
}

/** ========== 空间 ========== */

function getSpaceById(id) {
  return db.prepare('SELECT * FROM spaces WHERE id=?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT plan, quota_total, quota_used FROM users WHERE username=?').get(username);
}

module.exports = {
  getById, getByIdFull, getAllByUser, countByOwner, getCategories,
  create, update, remove,
  insertPromptVersion, getPromptVersions, getPromptVersionDetail,
  insertPublishRecord, getPublishHistory, getLatestPublishVersion, findPublishByWorkflow, getPublishById,
  insertReviewRecord, getLatestReview, getReviewFlow,
  getMemories, clearMemories,
  insertWorkflowRun, finishWorkflowRun, getWorkflowRuns,
  getSpaceById, getUserByUsername,
};