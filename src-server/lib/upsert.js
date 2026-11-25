'use strict';
/**
 * XC-2（2026-11-25，M9 信创 dm 降级口径）：跨方言 upsert 生成器 + 运行时方言探测。
 *
 * 设计原则（承接 scripts/dialect-baseline.json 登记与 sql-dialect「语义复杂改写不臆造」）：
 *   - 不做 SQL 文本机械翻译——ON CONFLICT → MERGE 的占位符需按 MERGE 语义重排，机械翻译极易
 *     错位。改为业务位以「声明式 spec」由本模块生成分支 SQL：占位符始终按 columns 声明序线性
 *     排列，dm 的 USING (SELECT ? AS c1, ...) 子句同序消费，两分支引用 src."col" 符号名——
 *     从源头消灭重排陷阱。
 *   - 方言分支：
 *       sqlite          ignore → INSERT OR IGNORE（存量语义零变）
 *                       upsert → ON CONFLICT(keys) DO UPDATE SET c=excluded.c（SQLite 3.24+ 原生）
 *       kingbase / PG   ignore → ON CONFLICT(keys) DO NOTHING（显式冲突目标，避免宽约束误吞）
 *                       upsert → 同 sqlite upsert 形态（原生）
 *       dm              ignore → MERGE INTO ... WHEN NOT MATCHED THEN INSERT
 *                       upsert → 完整 MERGE（WHEN MATCHED THEN UPDATE SET c=src.c，Oracle 系
 *                                 分支序：MATCHED 在前）
 *   - 语义微差登记（改写点位注释同步）：token_blacklist.jti 为普通索引非唯一——sqlite 侧
 *     INSERT OR IGNORE 从不触发（插重复 jti 双行，现状如此）；dm 侧 MERGE ON jti 会跳过
 *     （幂等去重的本意，JWT jti 标准全局唯一，真实重复概率为零）。words 表无唯一约束，业务
 *     位已有先查后写，MERGE ON word 为并发窗口的原子化兜底——均记录于改写点注释。
 */

/** 标识符引号转义（与 dal.insert 同风格：ANSI 双引号，" 自身翻倍） */
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/* ---------------- 运行时方言探测 ---------------- */

/** AGENT_DB_DRIVER（db.js 权威源）→ 方言名映射；pg 走 PG 系（kingbase 语法兼容面） */
const DRIVER_TO_DIALECT = { sqlite: 'sqlite', pg: 'kingbase', kingbase: 'kingbase', dm: 'dm' };

/** 当前方言：AGENT_DB_DRIVER 优先，DB_DIALECT（dal 残留变量）兼容兜底，缺省 sqlite。
 *  每次实读环境（进程 env 读取 O(1)）——不缓存，避免测试注入 env 后的跨用例污染。 */
function currentDialect() {
  const driver = String(process.env.AGENT_DB_DRIVER || '').toLowerCase();
  if (DRIVER_TO_DIALECT[driver]) return DRIVER_TO_DIALECT[driver];
  const legacy = String(process.env.DB_DIALECT || '').toLowerCase();
  if (DRIVER_TO_DIALECT[legacy] || legacy === 'sqlite') return DRIVER_TO_DIALECT[legacy] || legacy;
  return 'sqlite';
}

/* ---------------- SQL 生成（带缓存） ---------------- */

const SQL_CACHE_MAX = 200;
const _sqlCache = new Map(); // cacheKey → sql（业务位 spec 静态，热路径零重复拼接）

function cacheGetOrBuild(cacheKey, build) {
  const hit = _sqlCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const sql = build();
  if (_sqlCache.size >= SQL_CACHE_MAX) { // 简单淘汰：Map 保序删最早 10%
    let i = 0; const drop = Math.ceil(SQL_CACHE_MAX * 0.1);
    for (const k of _sqlCache.keys()) { _sqlCache.delete(k); if (++i >= drop) break; }
  }
  _sqlCache.set(cacheKey, sql);
  return sql;
}

/** sqlite/kingbase（PG 系）分支：INSERT ... ON CONFLICT 家族（dialect 由调用方传入——勿内部重读环境，缓存键与生成结果必须同源） */
function buildPgFamily(table, keys, columns, updateCols, ignore, dialect) {
  const target = `(${keys.map(ident).join(', ')})`;
  const cols = columns.map(ident).join(', ');
  const vals = columns.map(() => '?').join(', ');
  if (ignore) {
    if (dialect === 'sqlite') return `INSERT OR IGNORE INTO ${ident(table)} (${cols}) VALUES (${vals})`;
    return `INSERT INTO ${ident(table)} (${cols}) VALUES (${vals}) ON CONFLICT ${target} DO NOTHING`;
  }
  const sets = updateCols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ');
  return `INSERT INTO ${ident(table)} (${cols}) VALUES (${vals}) ON CONFLICT ${target} DO UPDATE SET ${sets}`;
}

/** dm 分支：MERGE INTO（Oracle 系；MATCHED 分支在前） */
function buildDmMerge(table, keys, columns, updateCols, ignore) {
  const srcCols = columns.map((c) => `? AS ${ident(c)}`).join(', ');
  const onKeys = keys.map((k) => `t.${ident(k)} = src.${ident(k)}`).join(' AND ');
  const insCols = columns.map(ident).join(', ');
  const insVals = columns.map((c) => `src.${ident(c)}`).join(', ');
  const matched = ignore ? '' : `WHEN MATCHED THEN UPDATE SET ${updateCols.map((c) => `${ident(c)} = src.${ident(c)}`).join(', ')} `;
  return `MERGE INTO ${ident(table)} t USING (SELECT ${srcCols}) src ON (${onKeys}) ${matched}` +
    `WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals})`;
}

/**
 * 生成分支 SQL。占位符始终按 columns 声明序线性排列（调用方按同序传参）。
 * @param {object} p
 *   table     目标表名（含动态表名，如迁移框架的 _migrations）
 *   keys      冲突目标列（须 ⊆ columns）
 *   columns   插入列（声明序即占位符序）
 *   ignore    true=存在即跳过（INSERT OR IGNORE 家族）；false/缺省=upsert（更新非键列）
 *   updateCols upsert 模式要更新的列，缺省 columns − keys
 *   dialect   缺省 currentDialect()
 * @returns {string} SQL 文本
 */
function buildUpsert({ table, keys, columns, updateCols, ignore = true, dialect }) {
  const d = dialect || currentDialect();
  if (!DRIVER_TO_DIALECT[d] && d !== 'sqlite') throw new Error(`buildUpsert: 未知方言 ${d}`);
  if (!table || typeof table !== 'string') throw new Error('buildUpsert: 表名为空');
  if (!Array.isArray(keys) || !keys.length) throw new Error('buildUpsert: keys（冲突目标列）不能为空');
  if (!Array.isArray(columns) || !columns.length) throw new Error('buildUpsert: columns（插入列）不能为空');
  const bad = keys.find((k) => !columns.includes(k));
  if (bad) throw new Error(`buildUpsert: 冲突目标列 ${bad} 必须包含在 columns 中`);
  const upd = (Array.isArray(updateCols) && updateCols.length) ? updateCols : columns.filter((c) => !keys.includes(c));
  if (!ignore && !upd.length) throw new Error('buildUpsert: upsert 模式需至少一个可更新列（columns 与 keys 全同）');
  return cacheGetOrBuild(
    `${d}|${ignore ? 'ig' : 'up'}|${table}|${keys.join(',')}|${columns.join(',')}|${upd.join(',')}`,
    () => (d === 'dm' ? buildDmMerge(table, keys, columns, upd, ignore) : buildPgFamily(table, keys, columns, upd, ignore, d)));
}

module.exports = { buildUpsert, currentDialect, __clearCache: () => _sqlCache.clear() };
