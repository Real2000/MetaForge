/**
 * GraphRAG 知识图谱服务（2026-10-30；当日二次修复：完整实现恢复 + 上下文取回修正；
 * M4 AI-04 2026-11-23 接通入库管道——原「函数全仓零外部调用、entities/entity_relations 恒空」的纸面能力自此启用）
 * 基于 LLM 提取实体与关系三元组，存储在 SQLite 表中，检索时用实体链接增强上下文。
 *
 * 核心能力：
 * 1. 实体提取：从知识库内容中提取命名实体（人/组织/地点/事件等）
 * 2. 关系三元组提取：从分块内容中提取 (主体, 关系, 客体) 三元组
 * 3. 图谱检索增强：给定输入查询，匹配关联实体，带回支撑关系的分块上下文
 * 4. 入库编排（AI-04）：buildGraphForFile——摄取管道 graphrag 步骤的后台执行体
 *    （fire-and-forget；无供应商静默跳过；单文件分块数设上限控 LLM 成本）
 */

const { db } = require('../db');
const { chatOnce, getConfiguredProviders } = require('./llm');

/** 单文件图谱抽取的分块上限（LLM 调用成本闸：实体 N/10 块一次 + 三元组每块一次） */
const GRAPH_MAX_CHUNKS = 40;
/** 实体抽取批大小（与 extractEntitiesFromChunks 内部 slice(0,10) 对齐） */
const ENTITY_BATCH = 10;

/** 分词（本模块私有，命名 graphTerms 避免与 retriever.js 的 terms 混淆） */
function graphTerms(text) {
  if (!text) return [];
  const result = new Set();
  const s = String(text);
  for (const c of s) {
    if (/[\u4e00-\u9fff]/.test(c)) result.add(c);
  }
  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(pair)) result.add(pair);
  }
  for (const t of s.split(/[\s,，。、；：！？\t\n\r.?!;:]/)) {
    const clean = t.replace(/[^\w]/g, '').trim().toLowerCase();
    if (clean && clean.length >= 2) result.add(clean);
  }
  return [...result];
}

// ========== 1. 实体提取（单次调用，批量处理分块） ==========

/** 调用 LLM 从一批分块中提取命名实体，返回 [{name, type, description}]；无供应商/失败返回 []（不阻塞） */
async function extractEntitiesFromChunks(chunks) {
  if (getConfiguredProviders().length === 0) return [];
  const prompt = `从以下文本片段中提取所有重要的命名实体（人/组织/地点/事件/行业术语），每个实体返回 name 和 type，以及简要描述。
要求：仅输出 JSON 数组，不要多余文字或代码块。
格式：[{"name":"实体名称","type":"组织/人物/地点/事件/其他","description":"简要描述（10字内）"}]

文本片段：
${chunks.slice(0, 10).map((c, i) => `---片段${i + 1}---\n${String(c.content || c || '').slice(0, 1500)}`).join('\n')}`;
  try {
    const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 2048 });
    if (!r || r.mode === 'mock' || !r.full) return [];
    const m = String(r.full).match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed.filter(e => e && e.name && e.type) : [];
  } catch { return []; }
}

/** 从单条文本中提取三元组（主体, 关系, 客体）；无供应商/失败返回 [] */
async function extractTriples(text) {
  if (getConfiguredProviders().length === 0) return [];
  const prompt = `从以下文本中提取重要事实三元组 (主体, 关系, 客体)。每个三元组表示 主体 与 客体 之间的事实关系。
要求：仅输出 JSON 数组，不要多余文字或代码块。
格式：[{"subject":"主体","predicate":"关系","object":"客体"}]

文本：
${String(text || '').slice(0, 2000)}`;
  try {
    const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 1024 });
    if (!r || r.mode === 'mock' || !r.full) return [];
    const m = String(r.full).match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed.filter(e => e && e.subject && e.predicate && e.object) : [];
  } catch { return []; }
}

// ========== 2. 实体持久化 ==========

/** 将提取到的实体列表批量写入 entities 表（幂等：同名+同类型合并 kb_ids），返回新增数 */
function persistEntities(extractedEntities, kbId) {
  const ins = db.prepare(`INSERT INTO entities (name, type, description, kb_ids, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))`);
  const get = db.prepare('SELECT id, kb_ids FROM entities WHERE name=? AND type=?');
  const upd = db.prepare('UPDATE entities SET kb_ids=? WHERE id=?');
  let count = 0;
  for (const e of extractedEntities) {
    const exist = get.get(String(e.name).slice(0, 100), String(e.type).slice(0, 20));
    if (exist) {
      try {
        const ids = new Set(JSON.parse(exist.kb_ids || '[]'));
        if (kbId != null) ids.add(Number(kbId));
        upd.run(JSON.stringify([...ids]), exist.id);
      } catch { }
      continue;
    }
    ins.run(String(e.name).slice(0, 100), String(e.type).slice(0, 20), String(e.description || '').slice(0, 200), JSON.stringify(kbId != null ? [Number(kbId)] : []));
    count++;
  }
  return count;
}

/** 将三元组批量写入 entity_relations 表（主体/客体按名称查实体），返回写入数 */
function persistTriples(triples, chunkId) {
  const getId = db.prepare('SELECT id FROM entities WHERE name=?');
  const ins = db.prepare(`INSERT INTO entity_relations (source_id, target_id, relation, weight, source_chunk_ids, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`);
  let count = 0;
  for (const t of triples) {
    const src = getId.get(String(t.subject).slice(0, 100));
    const tgt = getId.get(String(t.object).slice(0, 100));
    if (!src || !tgt) continue;
    ins.run(src.id, tgt.id, String(t.predicate).slice(0, 50), 1.0, JSON.stringify([Number(chunkId)].filter(Boolean)));
    count++;
  }
  return count;
}

// ========== 3. 图谱检索增强 ==========

/** 根据查询词关联实体，返回 { entities, relations, context, chunk_ids }。
 *  上下文取自关系的 source_chunk_ids（支撑事实的分块），kbId 非空时过滤库范围。
 *  chunk_ids（AI-04）：按图谱关联度排序的支撑分块 ID——retriever 以其构造 RRF 第三通道（图谱）。
 */
function retrieveGraph(query, kbId, topK = 5) {
  const qTerms = graphTerms(query);
  if (!qTerms.length) return { entities: [], relations: [], context: [], chunk_ids: [] };
  // 实体匹配：查询词 → 实体名精确匹配优先
  const placeholders = qTerms.map(() => '?').join(',');
  let candidates = db.prepare(`SELECT id, name, type, description FROM entities WHERE name IN (${placeholders})`).all(...qTerms);
  if (!candidates.length) {
    // 回落：LIKE 模糊匹配（实体名包含查询词或查询词包含实体名）
    const cond = qTerms.map(() => "(name LIKE ? OR ? LIKE ('%' || name || '%'))").join(' OR ');
    const params = qTerms.flatMap(t => [`%${t}%`, t]);
    candidates = db.prepare(`SELECT id, name, type, description FROM entities WHERE ${cond}`).all(...params);
  }
  const seen = new Set();
  const unique = candidates.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }).slice(0, topK);
  if (!unique.length) return { entities: [], relations: [], context: [], chunk_ids: [] };
  // 关联关系（一度邻居）
  const ids = unique.map(e => e.id);
  const relPh = ids.map(() => '?').join(',');
  const relations = db.prepare(`SELECT * FROM entity_relations WHERE source_id IN (${relPh}) OR target_id IN (${relPh})`).all(...ids, ...ids);
  // 上下文：关系携带的 source_chunk_ids → kb_chunks 内容
  const chunkIds = new Set();
  for (const r of relations) {
    try {
      for (const cid of JSON.parse(r.source_chunk_ids || '[]')) chunkIds.add(Number(cid));
    } catch { }
  }
  // kbId 非空时库域过滤提前做（chunk_ids 同口径，防跨库分块混入检索融合通道）
  let chunkIdList = [...chunkIds];
  if (chunkIdList.length && kbId != null) {
    const cph = chunkIdList.map(() => '?').join(',');
    const rows0 = db.prepare(`SELECT id FROM kb_chunks WHERE id IN (${cph}) AND kb_id=?`).all(...chunkIdList, Number(kbId));
    const inKb = new Set(rows0.map(r => r.id));
    chunkIdList = chunkIdList.filter(id => inKb.has(id));
  }
  let context = [];
  if (chunkIdList.length) {
    const cph = chunkIdList.map(() => '?').join(',');
    const rows = kbId != null
      ? db.prepare(`SELECT c.content FROM kb_chunks c JOIN kb_files f ON f.id=c.file_id WHERE c.id IN (${cph}) AND f.kb_id=?`).all(...chunkIdList, Number(kbId))
      : db.prepare(`SELECT content FROM kb_chunks WHERE id IN (${cph})`).all(...chunkIdList);
    context = rows.map(r => r.content).filter(Boolean).slice(0, 10);
  }
  return { entities: unique, relations: relations.slice(0, 20), context, chunk_ids: chunkIdList };
}

// ========== 4. 入库编排（AI-04：摄取管道 graphrag 步骤的执行体） ==========

/**
 * 为单个已入库文件构建图谱（后台 fire-and-forget 调用，异常由调用方兜底）：
 *   1) 实体抽取：分块按 ENTITY_BATCH 一批过 LLM → persistEntities（同名+同类型幂等合并 kb_ids）
 *   2) 三元组抽取：逐分块过 LLM → persistTriples（主体/客体须已入库为实体，防悬空引用）
 * 成本闸：单文件最多处理前 maxChunks 个分块（默认 40），LLM 调用次数可控且可预期。
 * 无供应商 → { skipped:'no_provider' }（静默跳过，不产生任何 LLM 调用）。
 * opts.extractEntities / opts.extractTriples / opts.force 供测试注入（DI），生产路径缺省走 LLM。
 */
async function buildGraphForFile(fileId, kbId, opts = {}) {
  const extractEnt = opts.extractEntities || extractEntitiesFromChunks;
  const extractTri = opts.extractTriples || extractTriples;
  if (!opts.force && getConfiguredProviders().length === 0) return { skipped: 'no_provider' };
  const rows = db.prepare('SELECT id, content FROM kb_chunks WHERE file_id=? ORDER BY id').all(fileId);
  if (!rows.length) return { skipped: 'no_chunks' };
  const maxChunks = (Number.isFinite(+opts.maxChunks) && +opts.maxChunks > 0) ? Math.floor(+opts.maxChunks) : GRAPH_MAX_CHUNKS;
  const target = rows.slice(0, maxChunks);
  let newEntities = 0;
  let dupEntities = 0;
  for (let i = 0; i < target.length; i += ENTITY_BATCH) {
    const ents = await extractEnt(target.slice(i, i + ENTITY_BATCH));
    if (ents && ents.length) {
      const before = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      persistEntities(ents, kbId);
      const after = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      newEntities += (after - before); // persistEntities 返回新增数，此处独立计数便于断言（防返回语义漂移）
      dupEntities += Math.max(0, ents.length - (after - before));
    }
  }
  let newRelations = 0;
  for (const chunk of target) {
    const triples = await extractTri(chunk.content);
    if (triples && triples.length) newRelations += persistTriples(triples, chunk.id);
  }
  return { entities: newEntities, entities_dup: dupEntities, relations: newRelations, chunks: target.length };
}

module.exports = { extractEntitiesFromChunks, extractTriples, persistEntities, persistTriples, retrieveGraph, buildGraphForFile };
