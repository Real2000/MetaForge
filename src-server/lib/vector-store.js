/**
 * 向量库升级（2026-10-28 P3）：基于 LanceDB 的嵌入式向量存储
 * - 零部署、磁盘持久化、ANN 近似最近邻搜索
 * - 数据目录：data/vector-store/
 * - 自动回退：LanceDB 不可用时降级为 SQLite JSON 全表扫描
 */
const path = require('path');
const fs = require('fs');
const { db } = require('../db');

const VECTOR_DIR = path.join(__dirname, '..', '..', 'data', 'vector-store');

let lancedb = null;
let table = null;
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return true;
  try {
    lancedb = require('vectordb');
    fs.mkdirSync(VECTOR_DIR, { recursive: true });
    const con = await lancedb.connect(VECTOR_DIR);
    dbInitialized = true;
    // 尝试打开已存在的表（按 kb_id 分区：每个知识库一个表）
    try {
      table = await con.openTable('kb_chunks');
    } catch {
      // 表不存在，由首次插入时创建
      table = null;
    }
    return true;
  } catch (e) {
    console.warn('[vector] LanceDB 初始化失败，降级为 SQLite 全表扫描:', e.message);
    return false;
  }
}

/** 将嵌入写入 LanceDB（批量，按 kb_id 分区） */
async function upsertVectors(kbId, vectors) {
  if (!await initDB()) return false;
  if (!vectors || !vectors.length) return false;
  try {
    const data = vectors.map((v, i) => ({
      vector: Array.from(v.vec),
      chunk_id: v.id,
      kb_id: kbId,
      content: v.content,
    }));
    if (!table) {
      // 创建新表（自动建索引）
      table = await lancedb.createTable('kb_chunks', data);
    } else {
      await table.add(data);
    }
    // 创建或重建索引（LanceDB 自动管理，无需显式创建）
    return true;
  } catch (e) {
    console.warn('[vector] LanceDB 写入失败:', e.message);
    return false;
  }
}

/**
 * ANN 搜索：在 LanceDB 中近似最近邻搜索
 * @param {number[]} queryVec - 查询向量
 * @param {number} topK - 返回 Top K 个结果
 * @returns {Array<{id: number, content: string, score: number, kb_id: number}>} 按相似度降序排列
 */
async function annSearch(queryVec, topK = 50) {
  if (!await initDB()) return null;
  if (!table) return null;
  try {
    const results = await table.search(queryVec)
      .limit(topK)
      .execute();
    return (results || []).map(r => ({
      id: r.chunk_id,
      content: r.content,
      score: r._distance != null ? 1 / (1 + r._distance) : 0, // L2 → 相似度
      kb_id: r.kb_id,
    }));
  } catch (e) {
    console.warn('[vector] LanceDB 搜索失败:', e.message);
    return null;
  }
}

/** 清理整个向量库（重建索引） */
async function resetStore() {
  try {
    if (table) {
      await table.delete();
      table = null;
    }
    if (fs.existsSync(VECTOR_DIR)) {
      fs.rmSync(VECTOR_DIR, { recursive: true, force: true });
    }
    dbInitialized = false;
    return true;
  } catch (e) {
    console.warn('[vector] 清理失败:', e.message);
    return false;
  }
}

module.exports = { upsertVectors, annSearch, resetStore, initDB };
