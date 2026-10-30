/**
 * GraphRAG 知识图谱服务（2026-10-30）
 * 基于 LLM 提取实体与关系三元组，存储在 SQLite 表中，检索时用实体链接增强上下文。
 *
 * 核心能力：
 * 1. 实体提取：从知识库内容中提取命名实体（人/组织/地点/事件等）
 * 2. 关系三元组提取：从分块内容中提取 (主体, 关系, 客体) 三元组
 * 3. 图谱检索增强：给定输入查询，匹配关联实体，带回其所在分块和关联关系作为上下文
 */

const { db, tableEntities, tableEntityRelations } = require('../db');
const { chatOnce, getConfiguredProviders } = require('./llm');

// ========== 1. 实体提取（单次调用，批量处理分块） ==========

/** 调用 LLM 从一批分块中提取命名实体，返回 [{name, type, description}] */
async function extractEntitiesFromChunks(chunks) {
  if (getConfiguredProviders().length === 0) return []; // 无模型可用时静默跳过
  const prompt = `从以下文本片段中提取所有重要的命名实体（人/组织/地点/事件/行业术语），每个实体返回 name 和 type，以及简要描述。
要求：仅输出 JSON 数组，不要多余文字或代码块。
格式：[{"name":"实体名称","type":"组织/人物/地点/事件/其他","description":"简要描述（10字内）"}]

文本片段：
${chunks.slice(0, 10).map((c, i) => `---片段${i + 1}---\n${c.content.slice(0, 1500)}`).join('\n')}`;
  const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 2048 });
  if (!r || r.mode === 'mock' || !r.full) return [];
  try {
    const m = String(r.full).match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed.filter(e => e.name && e.type) : [];
  } catch { return []; }
}

/** 从单条文本中提取三元组（用于补生成/精确提取） */
async function extractTriples(text) {
  if (getConfiguredProviders().length === 0) return [];
  const prompt = `从以下文本中提取重要事实三元组 (主体, 关系, 客体)。每个三元组表示 主体 与 客体 之间的事实关系。
要求：仅输出 JSON 数组，不要多余文字或代码块。
格式：[{"subject":"主体","predicate":"关系","object":"客体"}]

文本：
${String(text || '').slice(0, 2000)}`;
  const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 1024 });
  if (!r || r.mode === 'mock' || !r.full) return [];
  try {
    const m = String(r.full).match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed.filter(e => e.subject && e.predicate && e.object) : [];
  } catch { return []; }
}

// ========== 2. 实体持久化 ==========

/** 将提取到的实体列表批量写入 entities 表（幂等：同名+同类型合并） */
function persistEntities(extractedEntities) {
  const ins = db.prepare(`INSERT OR IGNORE INTO ${tableEntities} (name, type, description, kb_ids, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))`);
  const get = db.prepare(`SELECT id FROM ${tableEntities} WHERE name=? AND type=?`);
  let count = 0;
  for (const e of extractedEntities) {
    const exist = get.get(e.name, e.type);
    if (exist) continue;
    ins.run(e.name, e.type, (e.description || '').slice(0, 200), '[]');
    count++;
  }
  return count;
}

/** 将三元组批量写入 entity_relations 表 */
function persistTriples(triples, chunkId) {
  const ins = db.prepare(`INSERT OR IGNORE INTO ${tableEntityRelations} (source_id, target_id, relation, weight, source_chunk_ids, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`);
  const getId = db.prepare(`SELECT id FROM ${tableEntities} WHERE name=? AND type=?`);
  let count = 0;
  for (const t of triples) {
    const src = getId.get(t.subject, '组织') || getId.get(t.subject, '人物') || getId.get(t.subject, '事件') || getId.get(t.subject, '地点') || getId.get(t.subject, '其他');
    const tgt = getId.get(t.object, '组织') || getId.get(t.object, '人物') || getId.get(t.object, '事件') || getId.get(t.object, '地点') || getId.get(t.object, '其他');
    if (!src || !tgt) continue;
    ins.run(src.id, tgt.id, t.predicate, 1.0, JSON.stringify([chunkId]));
    count++;
  }
  return count;
}

// ========== 3. 图谱检索增强 ==========

/** 根据查询词关联实体，返回上下文分块内容和关系路径 */
function retrieveGraph(query, kbId, topK = 5) {
  // 先用 BM25 匹配知名实体（模糊匹配），兜底用 LIKE 搜索
  const qTerms = terms(query);
  const candidates = qTerms
    .map(t => db.prepare(`SELECT id, name, type FROM ${tableEntities} WHERE (name LIKE ? OR ? LIKE ('%' || name || '%')) AND type IN ('组织','人物','事件','地点')`).all(`%${t}%`, t))
    .flat()
    .filter(Boolean);
  // 去重
  const seen = new Set();
  const unique = candidates.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }).slice(0, topK);
  if (!unique.length) return { entities: [], relations: [], context: [] };
  const ids = unique.map(e => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const relations = db.prepare(`SELECT * FROM entity_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).all(...ids, ...ids);
  const relatedIds = new Set();
  for (const r of relations) { relatedIds.add(r.source_id); relatedIds.add(r.target_id); }
  for (const e of unique) relatedIds.add(e.id);
  const allIds = [...relatedIds];
  const ph = allIds.map(() => '?').join(',');
  const contextChunks = db.prepare(`SELECT content FROM kb_chunks WHERE id IN (${ph})`).all(...allIds);
  return { entities: unique, relations, context: contextChunks.map(c => c.content) };
}

module.exports = { extractEntitiesFromChunks, extractTriples, persistEntities, persistTriples, retrieveGraph };
