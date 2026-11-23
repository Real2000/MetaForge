/**
 * SQLite-vec 向量索引（M3 AI-02 收尾 · D-4 决策落地，2026-11-23）
 *
 * D-4 决策依据（10 万分块 × bge-m3 1024 维实测，.temp/d4-bench）：
 *   - 现状真实路径（BLOB 传输+逐元素解析+JS 扫描）：p50 ≈ 1559ms / p95 ≈ 1904ms —— 超验收线（P95<300ms）5 倍+
 *   - 瓶颈不在余弦算力（向量常驻内存的纯 JS 扫描 p50 ≈ 160ms），而在「每次查询把 400MB 向量从 SQLite 搬进 JS」
 *   - sqlite-vec（vec0 虚拟表，C 实现的库内暴力扫描）：p50 ≈ 194ms —— 数据不出库、零搬运，8 倍提升；
 *     且为精确暴力（非近似 ANN），「ANN 命中率与暴力检索一致 ≥98%」验收天然 100% 满足
 *   - 信创友好：单一 C 扩展文件，npm 预编译覆盖 mac/win/linux(x64+arm64)，LoongArch 可自编译；
 *     与 better-sqlite3 同库——备份/litestream/主从部署故事完全不变
 *
 * 设计（对齐 M3 AI-02 的引擎一致性纪律）：
 *   - 索引只存 bge-m3（B3，1024 维）向量；查询向量必须同引擎（网关不可用 → 整体回落全表扫描，行为不变）
 *   - 每库一张影子表 vec_kb_<id>（vec0 虚拟表，rowid = kb_chunks.id），KNN 限定库域、天然租户隔离
 *   - 覆盖度闸：影子表行数 < 库分块数 → 检索前回填补齐（缺失行优先复用 kb_chunks.embedding 的 B3 缓存，
 *     无缓存才批量走网关；双写 kb_chunks + 影子表），补齐后才走 KNN——保证 KNN 结果与全扫等价
 *   - 失效联动：分块编辑/合并/删除、文件删除、库删除（retriever 侧由 knowledge.js 钩子调用）
 *   - 0 阻断：扩展不可用（未装包/平台不支持/AGENT_VEC_INDEX=0）→ available()=false，
 *     检索自动回落既有全表扫描，任何索引异常不炸主链路
 *
 * 已知坑（sqlite-vec v0.1.9 实测）：
 *   - INSERT 的 rowid 参数绑定仅接受 BigInt（JS number 报 "Only integers are allowed for primary key values"）
 *   - 向量参数须 vec_f32(?) 包装（裸 BLOB 绑定报同上误导性错误）
 *   - DELETE WHERE rowid=? / KNN 的 k=? 绑定正常
 */
const { db } = require('../db');

const BGE_DIM = 1024; // bge-m3 维度（与 retriever.BGE_DIM 一致；B3 专用索引）
const ANN_K = 128;    // KNN 取数上限（覆盖 RERANK_CANDIDATES=30 + RRF 长尾融合余量；KNN 成本对 k 不敏感）

let _available; // undefined=未探测 / true / false（进程级缓存；探测一次定终身，失败不再重试防抖动）

/** 扩展可用性探测（幂等；AGENT_VEC_INDEX=0 显式关闭） */
function available() {
  if (_available !== undefined) return _available;
  if (process.env.AGENT_VEC_INDEX === '0') { _available = false; return false; }
  try {
    require('sqlite-vec').load(db); // 未安装/平台无预编译 → require 或 load 抛错 → 静默降级
    _available = true;
  } catch (e) {
    _available = false;
    try {
      console.warn('[vector-index] sqlite-vec 不可用，向量检索回落全表扫描：', e && e.message);
    } catch { }
  }
  return _available;
}

/** 库域影子表名（kbId 必须为正整数，防注入——表名无法参数化） */
function tableFor(kbId) {
  const id = Number(kbId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('vector-index：非法库 ID');
  return `vec_kb_${id}`;
}

/** 确保影子表存在（可用性由调用方保证；DDL 幂等） */
function ensureTable(kbId) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableFor(kbId)} USING vec0(embedding float[${BGE_DIM}])`);
}

/** Float32Array/普通数组 → LE float32 Buffer（vec_f32 期望小端；
 *  本平台族 x86/ARM/LoongArch 均为小端，Buffer.from(typed.buffer) 零拷贝；
 *  巨额回填时若遇大端平台（不存在于支持矩阵）会在此报维度/解析错误，属 fail-loud 可接受） */
function toVecBuffer(vec) {
  if (vec instanceof Float32Array) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }
  const f = new Float32Array(vec || []);
  if (f.length !== BGE_DIM) throw new Error(`vector-index：向量维度 ${f.length} ≠ ${BGE_DIM}（仅支持 bge-m3）`);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/**
 * 批量写入（upsert 语义：先删后插）。items: [{ id: chunkId, vec: Float32Array|number[] }]
 * 返回写入条数；任何异常上抛（调用方决定降级）。事务包裹保证「删旧+插新」原子性。
 */
function upsert(kbId, items) {
  const list = (Array.isArray(items) ? items : []).filter(it => it && Number.isInteger(+it.id) && it.vec);
  if (!list.length) return 0;
  const table = tableFor(kbId);
  ensureTable(kbId);
  const del = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
  const ins = db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, vec_f32(?))`);
  const tx = db.transaction(() => {
    for (const it of list) {
      const id = Number(it.id);
      del.run(id); // BigInt 绑定（v0.1.9：rowid 的 number 绑定被拒，见文件头）
      ins.run(BigInt(id), toVecBuffer(it.vec));
    }
  });
  tx();
  return list.length;
}

/** 批量失效（分块编辑/合并/删除）。chunkIds: number[]；表不存在时静默（0 阻断） */
function remove(kbId, chunkIds) {
  const ids = (Array.isArray(chunkIds) ? chunkIds : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const table = tableFor(kbId);
  try {
    const del = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
    const tx = db.transaction(() => { for (const id of ids) del.run(id); });
    tx();
    return ids.length;
  } catch { return 0; } // 表不存在（从未建索引）等 → 静默
}

/** 删除库域影子表（库删除时调用；幂等） */
function drop(kbId) {
  try { db.exec(`DROP TABLE IF EXISTS ${tableFor(kbId)}`); return true; } catch { return false; }
}

/** 影子表现有行数（覆盖度闸）；表不存在返回 0 */
function count(kbId) {
  try {
    ensureTable(kbId);
    return db.prepare(`SELECT COUNT(*) c FROM ${tableFor(kbId)}`).get().c;
  } catch { return 0; }
}

/**
 * KNN 查询：返回 [{ rowid, distance }]（按距离升序；rowid 即 kb_chunks.id）。
 * distance 为 vec0 距离度量（L2，归一化向量下与余弦排序单调等价）——融合用的精确余弦由调用方
 * 对命中行回查 kb_chunks.embedding 计算（≤ANN_K 行，成本可忽略），保证 RRF 分数口径与全扫完全一致。
 */
function knn(kbId, queryVec, k = ANN_K) {
  const kk = Math.max(1, Math.min(1024, Math.floor(Number.isFinite(+k) ? +k : ANN_K)));
  const table = tableFor(kbId);
  ensureTable(kbId);
  const stmt = db.prepare(`SELECT rowid, distance FROM ${table} WHERE embedding MATCH vec_f32(?) AND k = ? ORDER BY distance`);
  return stmt.all(toVecBuffer(queryVec), kk).map(r => ({ rowid: Number(r.rowid), distance: r.distance }));
}

/** 测试助手（下划线约定：生产代码不得调用）——重置可用性缓存，供环境变量切换后重新探测 */
function __reset() { _available = undefined; }
/** 测试助手——强制置可用性（true/false），返回原值便于恢复 */
function __force(v) { const old = _available; _available = v; return old; }

module.exports = { available, ensureTable, upsert, remove, drop, count, knn, tableFor, ANN_K, BGE_DIM, __reset, __force };
