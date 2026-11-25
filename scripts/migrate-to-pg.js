#!/usr/bin/env node
/**
 * PG-3（2026-11-24）sqlite → PostgreSQL 数据迁移工具（M6 全量迁移，D-5 停机直切配套）
 *
 * 背景与验收（V1.1 计划表 PG-3，P0）：
 *   「生产库全量搬运对账 diff = 0；中断重跑幂等；迁移时长可预估入 runbook」
 *
 * 时序（runbook 详版见 docs/PG切换runbook.md）：
 *   1. 目标 PG 库就绪（业务角色 owner——与生产 mt7_app 同权结构）；
 *   2. db.js 以 AGENT_DB_DRIVER=pg 首启一次：全量建表 DDL 经方言层生成、RLS 应用、序列空表对齐
 *      ——**schema 的唯一真相来源是 db.js**，本工具只搬数据不建表（防双源漂移）；
 *   3. 停止服务，运行本工具（schema 已在、只补数据）；
 *   4. 工具内置序列重同步（与 db.js 启动块同语义——显式 id 插入后 SERIAL sequence 不感知）。
 *
 * 机制：
 *   - 源端 better-sqlite3 只读直连；目标端 pg 驱动单连接（pool max:1——顺序搬运无需并发，
 *     且避免多连接各自 SET 租户上下文的复杂度）；
 *   - RLS 逃逸：连接后 SET app.tenant_id='platform'（PG-1 显式逃逸值，FORCE RLS 表全量可见；
 *     平面表无 RLS 不受影响）——与 db.js 序列对齐块同一口径；
 *   - int8/numeric 解析器注册（与 lib/pg-bridge-worker.js 相同契约：COUNT/MAX 聚合归一 number）
 *     ——对账两侧读回值形态必须同构，否则哈希无意义；
 *   - 排除表：sqlite_master 内部表、FTS5 影子表（kb_chunks_fts%——PG 方言建表降级跳过，无此结构）、
 *     vec0 虚表组（SW-1 复检发现：sqlite-vec 向量索引表 vec_kb_N 及其影子表——派生索引可重建、
 *     目标库无此结构；识别见 collectVec0Group）、schema_anchor（平台自维护锚点：PG 端首启自建自算，
 *     搬 sqlite 时代的锚点反而会触发假漂移告警）；
 *   - 幂等：每表 TRUNCATE 后整表重搬——中断重跑（或任意次重跑）结果恒一致，不依赖断点续传；
 *   - 分批事务：每批一个 BEGIN…COMMIT（批间落盘），中断只废当前表（下次重跑该表 TRUNCATE 重搬）；
 *   - 类型映射按目标端（PG information_schema 为对账真相标准）：integer/real/text/bytea 四类；
 *     bytea 列源值经列级转换钩子 SRC_CONVERTERS——kb_chunks.embedding 旧 JSON 文本缓存 →
 *     AI-02 float32 BLOB（toEmbeddingBlob；文本按原始字节直转 = 切换后向量静默失效）；
 *
 * 对账设计（diff=0 的口径）：
 *   - 行数对账：源/目标逐表 COUNT 比对；
 *   - 内容哈希：双侧按目标端 PK 列 ORDER BY 逐行读，按目标列类型规范化后 sha256：
 *       integer → 'i:'+v（源值超 int32 立即 fail-fast——PG integer 4 字节静默截断不可接受）；
 *       real     → 'f:'+Math.fround(v)（**单精度归一**：sqlite REAL 双精度、PG real 单精度，
 *                  0.95 双精度 ≠ PG 读回 0.9499999…；fround(fround(x))===fround(x)，
 *                  两侧同归一则真实差异仍被检出，纯精度差异不误报）；
 *       text     → 't:'+JSON.stringify(String(v))（源 TEXT 列偶存数字时插入即转串，哈希同口径）；
 *       bytea    → 'b:'+hex（Buffer）；
 *       null     → '∅'（与空串严格区分）。
 *
 * 用法：
 *   node scripts/migrate-to-pg.js                    # 全量搬运 + 对账
 *   MIG_SRC=data/platform.db PG_CONN=postgres://… node scripts/migrate-to-pg.js
 *   node scripts/migrate-to-pg.js --from-table=messages   # 中断续跑：跳过字典序更早的表（重跑仍 TRUNCATE 重搬）
 *   node scripts/migrate-to-pg.js --only-table=op_logs    # 单表调试
 *   MIG_BATCH=2000 node scripts/migrate-to-pg.js          # 调大批（每批一事务）
 *
 * 退出码：0=对账 diff=0；1=存在失败表（明细见输出）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (name) => { const m = argv.find((a) => a.startsWith(`--${name}=`)); return m ? m.split('=').slice(1).join('=') : null; };
const SRC_PATH = process.env.MIG_SRC || path.join('data', 'platform.db');
const DST_CONN = process.env.PG_CONN || process.env.DATABASE_URL || '';
const BATCH = Number(process.env.MIG_BATCH || 500) || 500;
// 排除清单：FTS5 影子表（PG 无此结构）+ 平台自维护锚点（搬过去会假漂移）
const EXCLUDE = (t) => t.startsWith('sqlite_') || t.startsWith('kb_chunks_fts') || t === 'schema_anchor';
// SW-1 前置复检（2026-11-25）实跑生产快照发现：生产库因向量索引存在 sqlite-vec 虚表组
// （虚表本体 vec_kb_N + 影子表 _info/_chunks/_rowids/_vector_chunksNN），PG 方言建表对其注释化
// 跳过、目标库无此结构，fail-fast 将卡死切换窗口。口径：虚表组是 kb_chunks.embedding 的派生
// 索引（可由数据重建），非事实数据——排除不构成数据丢失。由 collectVec0Group 在源端首枚举时
// 填充（源库是唯一事实来源），两处消费点（源表清单/目标多表告警）共用同一 Set，防口径漂移。
const VEC0_TABLES = new Set();
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/; // 表/列名白名单（catalog 来源，防注入双保险）

function fail(msg) { console.error(`[migrate-to-pg] ✗ ${msg}`); process.exit(1); }
const q = (id) => `"${id}"`; // 标识符引用（进函数前已过白名单校验）

// ---------- 源端（sqlite 只读） ----------
function openSrc() {
  if (!fs.existsSync(SRC_PATH)) fail(`源库不存在：${SRC_PATH}（MIG_SRC 可指定）`);
  return require('better-sqlite3')(SRC_PATH, { readonly: true });
}

// ---------- 目标端（pg 单连接） ----------
async function openDst() {
  if (!DST_CONN) fail('目标连接串缺失：PG_CONN 或 DATABASE_URL（与 db.js 同口径）');
  const pg = require('pg');
  // int8/numeric → number：与 pg-bridge-worker 相同契约（对账两侧读回形态同构的前提）
  pg.types.setTypeParser(20, (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; });
  pg.types.setTypeParser(1700, (v) => { const n = Number(v); return Number.isFinite(n) ? n : v; });
  const pool = new pg.Pool({ connectionString: DST_CONN, max: 1 });
  const conn = await pool.connect();
  // FORCE RLS 对 owner 也强制：全量搬运用 platform 显式逃逸（与 db.js 序列对齐块同口径）
  await conn.query("SELECT set_config('app.tenant_id', 'platform', false)");
  return { pool, conn };
}

// ---------- catalog 探测 ----------
/** 识别 vec0 虚表组：本体按 sql 含 USING vec0 判定（不猜命名约定——vec_kb_<kbId> 拼接名不可枚举）。
 *  影子表由 vec0 模块自建，但 sqlite_master 里带 CREATE TABLE 文本（SW-1 生产快照实测，非 NULL），
 *  故收编条件为「所属虚表名前缀 + 已知后缀族」双判定：纯前缀匹配会把业务误建的同前缀表静默
 *  跳过；双判定宁可漏识别——未来 sqlite-vec 新增后缀时 fail-fast 显式炸，不静默丢表。 */
const VEC0_SHADOW_SUFFIX = /^(?:_info|_chunks|_rowids|_vector_chunks\d+)$/;
function collectVec0Group(rows) {
  const vtabs = rows.filter((r) => r.sql && /USING\s+vec0/i.test(r.sql)).map((r) => r.name);
  const group = new Set(vtabs);
  for (const v of vtabs) {
    rows.forEach((r) => {
      if (r.name.startsWith(v + '_') && VEC0_SHADOW_SUFFIX.test(r.name.slice(v.length))) group.add(r.name);
    });
  }
  return group;
}

function srcTables(src) {
  const rows = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
  collectVec0Group(rows).forEach((t) => VEC0_TABLES.add(t));
  if (VEC0_TABLES.size) {
    console.log(`[migrate-to-pg] 跳过 sqlite-vec 虚表组 ${VEC0_TABLES.size} 张（派生索引可重建，目标库无此结构）：${[...VEC0_TABLES].sort().join(', ')}`);
  }
  return rows.map((r) => r.name).filter((t) => !EXCLUDE(t) && !VEC0_TABLES.has(t));
}

async function dstCatalog(conn) {
  const r = await conn.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  const cat = new Map();
  for (const row of r.rows) {
    if (!cat.has(row.table_name)) cat.set(row.table_name, { cols: [], types: {}, pk: null });
    const e = cat.get(row.table_name);
    e.cols.push(row.column_name);
    e.types[row.column_name] = row.data_type;
    if (/^nextval\(/.test(row.column_default || '')) e.autoId = row.column_name;
  }
  // PK 列（对账排序键；单列为主，复合按列序拼接）
  const pk = await conn.query(`
    SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='public'
    ORDER BY tc.table_name, kcu.ordinal_position`);
  for (const row of pk.rows) {
    const e = cat.get(row.table_name); if (!e) continue;
    e.pk = e.pk ? [...e.pk, row.column_name] : [row.column_name];
  }
  return cat;
}

// ---------- 规范化哈希 ----------
function canon(v, pgType) {
  if (v === null || v === undefined) return '∅';
  if (/^integer$|^smallint$|^bigint$/.test(pgType)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return `BAD:${typeof v}:${String(v)}`;
    if (/^integer$|^smallint$/.test(pgType) && Math.abs(v) > 2147483647) return `RANGE:${String(v)}`; // int32 防御
    return `i:${String(v)}`;
  }
  if (/^real$|^double precision$/.test(pgType)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `BAD:${typeof v}:${String(v)}`;
    return `f:${String(Math.fround(v))}`; // 单精度归一（见头注释：两侧同归一，纯精度差不误报）
  }
  if (/^bytea$/.test(pgType)) {
    // 空串归一：sqlite 旧 TEXT DEFAULT '' 时代的无向量行（src ''）与改型后的空 bytea 同为
    // 「无向量」语义——归一为空 hex 对账；非空非 Buffer 值仍 BAD（真数据形态差异不掩盖）
    if (v === '') return 'b:';
    if (!Buffer.isBuffer(v)) return `BAD:${typeof v}`;
    return `b:${v.toString('hex')}`;
  }
  // text 及其余（timestamp 等全部 text 化的形态）
  return `t:${JSON.stringify(typeof v === 'string' ? v : String(v))}`;
}

function rowHash(row, cols, types) {
  const parts = cols.map((c) => canon(row[c], types[c]));
  return parts.join('\u0001');
}

function tableHash(rows, cols, types) {
  const h = crypto.createHash('sha256');
  for (const line of rows) h.update(line + '\n');
  return h.digest('hex');
}

// 目标行 → 可比对形态（pg 读回 Buffer/number/string/null）
function canonDstRow(row, cols, types) { return rowHash(row, cols, types); }

// ---------- 源值转换钩子（bytea 列的 sqlite 侧文本形态 → PG 侧二进制语义） ----------
/** kb_chunks.embedding 源值 → AI-02 float32 BLOB（目标 bytea 语义）。
 *  格式单一事实源在 retriever.js（encodeVec/parseVec：首字节 engine tag 1=B3/2=H + 小端
 *  Float32×dim，B3=1024 维 / H=256 维）；但 retriever 顶层 require db，迁移工具不可反向依赖
 *  （会触发 db.js 全量启动路径），故自带同构转换 + smoke 运行时守卫锁格式同步（转换结果必须被
 *  retriever.decodeVec 精确还原）。
 *  源形态（SW-1 生产快照实测，AI-02 懒迁移中间态三态混存）：float32 BLOB（新格式直写行）→ 原样
 *  直通；H:/B3: 前缀 JSON / 裸 JSON（旧版本地哈希）→ 解析转 BLOB；'' → 空 bytea（无向量语义）；
 *  null → null（SQL NULL）。不可解析/维度不符 → 抛错 fail-fast（静默丢向量 = 检索能力静默降级，
 *  宁可炸出人工判）。 */
const VEC_DIM = { B3: 1024, H: 256 };
const VEC_TAG = { B3: 1, H: 2 };
function toEmbeddingBlob(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v); // 新格式直写行——原样
  if (typeof v !== 'string') throw new Error(`kb_chunks.embedding 不可识别形态：${typeof v}`);
  if (v === '') return Buffer.alloc(0);
  let engine = 'H', raw = v; // 裸 JSON 视为旧版本地哈希（与 parseVec 同口径）
  if (v.startsWith('B3:')) { engine = 'B3'; raw = v.slice(3); }
  else if (v.startsWith('H:')) { engine = 'H'; raw = v.slice(2); }
  let arr;
  try { arr = JSON.parse(raw); } catch { throw new Error(`kb_chunks.embedding 文本不可解析（前 40 字符：${raw.slice(0, 40)}）`); }
  if (!Array.isArray(arr) || arr.length !== VEC_DIM[engine]) throw new Error(`kb_chunks.embedding 维度不符：engine=${engine} dim=${Array.isArray(arr) ? arr.length : '非数组'}`);
  const buf = Buffer.allocUnsafe(1 + arr.length * 4);
  buf[0] = VEC_TAG[engine];
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], 1 + i * 4);
  return buf;
}

// 列级白名单：显式逐列定义 bytea 语义转换（不做通配——未来新增 bytea 列须逐个评审，不臆测）
const SRC_CONVERTERS = { 'kb_chunks.embedding': toEmbeddingBlob };
const convertSrcValue = (table, col, v) => {
  const fn = SRC_CONVERTERS[`${table}.${col}`];
  return fn ? fn(v) : v;
};
/** 对账用源行：应用同一转换钩子（插入与哈希必须同钩子——两侧不同源则对账自欺） */
function srcRowForHash(table, row, cols) {
  const o = {};
  for (const c of cols) { const v = convertSrcValue(table, c, row[c]); o[c] = v === undefined ? null : v; }
  return o;
}

// ---------- 单表搬运（TRUNCATE → 分批插入） ----------
async function copyTable(ctx, t) {
  const { src, conn, cat } = ctx;
  const e = cat.get(t);
  const cols = e.cols;
  const colList = cols.map(q).join(', ');
  // 源缺列（历史库旧形态，如生产库 expert_catalog.created_by——DDL 后期新增且无补列迁移）：
  // 不阻塞——显式插 NULL（新功能列对旧数据的语义即无值）；对账两侧 canon(undefined)=canon(null)=∅
  // 天然对齐。治本见 db.js 的结构漂移补列迁移，WARNING 提示运维知晓。
  const srcHave = new Set(src.pragma(`table_info(${q(t)})`).map((c) => c.name));
  const missing = cols.filter((c) => !srcHave.has(c));
  if (missing.length) console.log(`    ⚠ ${t}：源缺列 ${missing.join(',')}，按 NULL 填充`);
  await conn.query(`TRUNCATE TABLE ${q(t)}`); // 幂等基点：重跑=重搬，与断点状态无关
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  const ins = `INSERT INTO ${q(t)} (${colList}) VALUES (${ph})`;
  let total = 0;
  let last = 0; // rowid 游标（参数化——catalog 来源仍不拼 SQL；1 起，0 即首页）
  for (;;) {
    const rows = src.prepare(`SELECT rowid AS __rid, * FROM ${q(t)} WHERE rowid > ? ORDER BY rowid LIMIT ${BATCH}`).all(last);
    if (!rows.length) break;
    await conn.query('BEGIN');
    try {
      for (const r of rows) await conn.query(ins, cols.map((c) => {
        const v = convertSrcValue(t, c, r[c]); // bytea 列文本→BLOB 等语义转换（见 SRC_CONVERTERS）
        return v === undefined ? null : v;
      }));
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => { });
      throw new Error(`插入失败（${t} 第 ${total + 1}~${total + rows.length} 行）：${err.message}`);
    }
    total += rows.length;
    last = rows[rows.length - 1].__rid;
    if (rows.length < BATCH) break;
  }
  return total;
}

// ---------- 单表对账（行数 + 内容哈希，按目标 PK 序） ----------
async function verifyTable(ctx, t, srcCount) {
  const { src, conn, cat } = ctx;
  const e = cat.get(t);
  const cols = e.cols, types = e.types;
  const dstCount = (await conn.query(`SELECT COUNT(*) c FROM ${q(t)}`)).rows[0].c;
  if (dstCount !== srcCount) return `行数不等 src=${srcCount} dst=${dstCount}`;
  // 排序键：PK（复合按列序）；无 PK 表退化为全列序（当前 125 表全有 PK，防御未来新增）。
  // 源端排序只用源实际有的列（源缺列时 ORDER BY 缺列会报错；缺列在 canon 阶段 ∅ 对齐）。
  const srcHave = new Set(src.pragma(`table_info(${q(t)})`).map((c) => c.name));
  const order = e.pk ? e.pk.map(q).join(', ') : cols.filter((c) => srcHave.has(c)).map(q).join(', ');
  const srcLines = src.prepare(`SELECT * FROM ${q(t)} ORDER BY ${cols.filter((c) => srcHave.has(c)).map((c) => q(c)).join(', ')}`).all()
    .map((r) => rowHash(srcRowForHash(t, r, cols), cols, types));
  const dstLines = (await conn.query(`SELECT * FROM ${q(t)} ORDER BY ${order}`)).rows
    .map((r) => canonDstRow(r, cols, types));
  if (srcLines.length !== dstLines.length) return `排序读行数漂移 src=${srcLines.length} dst=${dstLines.length}`;
  // 排序不可比（源无 rowid 序对齐时按行哈希自身排序再比——集合语义对账）
  srcLines.sort(); dstLines.sort();
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i] !== dstLines[i]) return `第 ${i + 1} 行哈希不一致：src=${srcLines[i].slice(0, 120)} dst=${dstLines[i].slice(0, 120)}`;
  }
  return null; // diff=0
}

// ---------- 序列重同步（与 db.js PG-1 启动块同语义；幂等） ----------
async function syncSequences(conn) {
  const r = await conn.query(`
    SELECT table_name AS t FROM information_schema.columns
    WHERE table_schema='public' AND column_name='id' AND column_default LIKE 'nextval%'`);
  for (const row of r.rows) {
    await conn.query(`SELECT setval(pg_get_serial_sequence('${row.t}', 'id'), COALESCE((SELECT MAX(id) FROM ${q(row.t)}), 0) + 1, false)`);
  }
  return r.rows.length;
}

// ---------- bm25_tsv 存量回填（PG-5 tsvector PoC，2026-11-24） ----------
// 时序设计：回填不在迁移步做（143 在空库首启即记账——若彼时回填，搬运后数据将永远 NULL）；
// 由本工具在搬运后统一执行。只处理 tsv IS NULL 的行——幂等重跑只补增量。
// 口径：lib/text-terms 单一事实源（content+keywords 完整 _idx，与检索端严格一致）。
async function backfillTsv(conn) {
  const hasCol = (await conn.query("SELECT 1 AS v FROM information_schema.columns WHERE table_name='kb_chunks' AND column_name='bm25_tsv'")).rows[0];
  if (!hasCol) return -1; // 目标库无此列（未跑迁移 143 的旧版本）——跳过不阻断搬运
  const { tsvText } = require(path.join(__dirname, '..', 'src-server', 'lib', 'text-terms'));
  const BATCH = 500;
  let total = 0, lastId = 0;
  for (;;) {
    const rows = (await conn.query('SELECT id, content, keywords FROM kb_chunks WHERE bm25_tsv IS NULL AND id > $1 ORDER BY id LIMIT $2', [lastId, BATCH])).rows;
    if (!rows.length) break;
    await conn.query('BEGIN');
    try {
      for (const r of rows) {
        await conn.query("UPDATE kb_chunks SET bm25_tsv = to_tsvector('simple', $2) WHERE id = $1", [r.id, tsvText(r.content, r.keywords)]);
      }
      await conn.query('COMMIT');
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => { });
      throw new Error(`bm25_tsv 回填失败（id ${lastId}~${rows[rows.length - 1].id}）：${e.message}`);
    }
    total += rows.length; lastId = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
  }
  return total;
}

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  console.log(`[migrate-to-pg] 源=${SRC_PATH}  批=${BATCH}  目标=${DST_CONN.replace(/:[^:@]*@/, ':***@')}`);
  const src = openSrc();
  const { pool, conn } = await openDst();
  const cat = await dstCatalog(conn);
  const sTables = srcTables(src);
  const missing = sTables.filter((t) => !cat.has(t));
  if (missing.length) fail(`目标库缺表（先以 AGENT_DB_DRIVER=pg 启动 db.js 建 schema）：${missing.join(', ')}`);
  const extraDst = [...cat.keys()].filter((t) => !sTables.includes(t) && !EXCLUDE(t) && !VEC0_TABLES.has(t));
  if (extraDst.length) console.log(`[migrate-to-pg] ⚠ 目标多出表（源为空/新增表，跳过不搬）：${extraDst.join(', ')}`);

  const fromTable = opt('from-table'), onlyTable = opt('only-table');
  const tables = sTables
    .filter((t) => (!onlyTable || t === onlyTable) && (!fromTable || t >= fromTable))
    .sort();
  const skipped = sTables.length - tables.length;
  console.log(`[migrate-to-pg] 待搬 ${tables.length} 表${skipped ? `（按参数跳过 ${skipped}）` : ''}`);

  const ctx = { src, conn, cat };
  const fails = [];
  let totalRows = 0;
  for (const t of tables) {
    const ts = Date.now();
    try {
      const srcCount = src.prepare(`SELECT COUNT(*) c FROM ${q(t)}`).get().c;
      if (!colsMatchWhitelist(t, cat.get(t).cols)) { fails.push([t, '标识符未过白名单']); continue; }
      await copyTable(ctx, t);
      const bad = await verifyTable(ctx, t, srcCount);
      const ms = Date.now() - ts;
      totalRows += srcCount;
      if (bad) { fails.push([t, bad]); console.log(`  ✗ ${t}（${srcCount} 行，${ms}ms）——${bad}`); }
      else console.log(`  ✓ ${t}：${String(srcCount).padStart(6)} 行对账 diff=0（${ms}ms）`);
    } catch (err) {
      fails.push([t, err.message]);
      console.log(`  ✗ ${t} —— ${err.message}`);
    }
  }
  const seqN = await syncSequences(conn);
  // PG-5：存量 tsv 回填（runbook S5 后自动包含；时长计入报告供时长预估）
  const t0t = Date.now();
  const tsvN = await backfillTsv(conn);
  if (tsvN >= 0) console.log(`[migrate-to-pg] bm25_tsv 存量回填：${tsvN} 行（${Date.now() - t0t}ms，幂等重跑只补增量）`);
  // PG-5 实测踩坑：批量导入后必跑 ANALYZE——统计失真时 planner 对候选集 MATCH 的行数估计错误
  //（实测估 rows=6 而实际 10 万）导致索引选择失当（弃 GIN 走 kb_id 索引逐行过滤，1.2s 级误判）。
  // ANALYZE 幂等（重跑刷新统计），几秒内完成。
  const t0a = Date.now();
  await conn.query('ANALYZE');
  console.log(`[migrate-to-pg] ANALYZE 全库统计已刷新（${Date.now() - t0a}ms）`);
  const el = Date.now() - t0;
  console.log(`———————————————`);
  console.log(`[migrate-to-pg] 搬运完成：${tables.length} 表 / ${totalRows} 行 / 序列同步 ${seqN} 表`);
  console.log(`[migrate-to-pg] 总耗时 ${el}ms（runbook 时长预估参考；生产规模线性外推按行数）`);
  if (fails.length) {
    console.log(`[migrate-to-pg] ✗ 失败 ${fails.length} 表：`);
    fails.forEach(([t, m]) => console.log(`    - ${t}：${m}`));
    process.exitCode = 1;
  } else {
    console.log(`[migrate-to-pg] ✅ 全表对账 diff = 0`);
  }
  conn.release();
  await pool.end();
  src.close();
}

function colsMatchWhitelist(t, cols) {
  if (!IDENT_RE.test(t)) return false;
  return cols.every((c) => IDENT_RE.test(c));
}

// require 不触发 main（守卫出口）：collectVec0Group 供 smoke 运行时守卫直测（SW-1 vec0 排除）
if (require.main === module) main().catch((e) => { console.error('[migrate-to-pg] 致命错误：', e); process.exit(1); });
module.exports = { collectVec0Group, toEmbeddingBlob };
