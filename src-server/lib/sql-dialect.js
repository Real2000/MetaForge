/**
 * U2-1 / N7-P4 信创 DAL —— SQL 方言适配层
 *
 * 目的：让上层 SQL（当前以 SQLite 语法为主）可在国产数据库上执行。提供把 SQLite 专有构造
 *       翻译为达梦（dm）/ 人大金仓（kingbase，PG 系）等价语法的能力；默认 sqlite 方言下
 *       为恒等转换（不改变任何 SQL，保证零回归）。
 *
 * 设计原则：
 *   - 默认 sqlite 方言恒等返回，回归行为不变；
 *   - 逐构造覆盖、可单测；未知/未映射的 SQLite 专有构造显式产出 warning（不静默）；
 *   - 仅做「可机械改写」的映射；语义复杂的改写（如 UPDATE ... LIMIT、ON CONFLICT→MERGE）不臆造，
 *     转 warning 并由 scripts/lint-dialect.js 审计登记替代方案（BE-C2 验收：warning 清单为 0 或有替代）。
 *
 * BE-C2（2026-11-23）方言闭环增强：
 *   - translate() 返回结构新增 downgrades：与 warnings 分离的「已确认降级路径」清单
 *     （warnings=需人工确认的未映射项；downgrades=方言侧已有替代实现的降级，如 FTS5 虚表跳过）；
 *   - FTS5 / vec0 虚表 DDL：非 sqlite 方言下建表语句注释化跳过（检索降级路径：BM25 内存通道 /
 *     向量库全扫，见 retriever.bm25Scores 方言判定），登记 downgrade 而非 warning；
 *   - dm 补单列自增规则（INTEGER AUTOINCREMENT → INT IDENTITY(1,1)，此前仅覆盖 PK 紧跟形态）；
 *   - dm unsupported 补 ON CONFLICT upsert（达梦不支持，替代：MERGE INTO 模板/先查后写，见登记表）；
 *   - sqlite_master/sqlite_sequence 系统表查询登记（替代：information_schema / db-driver 方言探测 API）。
 */
'use strict';

/* ---------------- 通用规则（dm / kingbase 共有） ---------------- */

const COMMON_RULES = [
  // datetime()/date() 不在此做正则映射：语义改写（TEXT 契约 + 基准时区 + 修饰符）见下方
  // replaceDatetimeFn（PG-1 2026-11-23 语义修复——此前译作 CURRENT_TIMESTAMP/CURRENT_DATE
  // 是「能解析但行为不等价」，PG 轨道 task_queue 首踩 text <= timestamptz 启动即崩）
  // IFNULL → COALESCE（三者等价）
  { re: /\bIFNULL\s*\(/gi, to: 'COALESCE(' },
  // 反引号标识符 → 双引号（SQLite 与 PG/dm 均支持双引号；反引号非标准）
  { re: /`([^`]+)`/g, to: '"$1"' },
];

/* ---------------- datetime()/date() 语义改写（PG-1 2026-11-23） ----------------
 * sqlite 的 datetime()/date() 返回 TEXT（'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD'）；此前正则映射为
 * CURRENT_TIMESTAMP/CURRENT_DATE 是「能解析但行为不等价」：PG 里它们是 timestamptz/date
 * 强类型——TEXT 列与之比较直接报 operator does not exist（PG 轨道 task_queue 首踩
 * text <= timestamptz，启动即崩），且返回形态违背 TEXT 契约。
 * 时间基准对齐 db.js now()/daysAgo()：业务写入固定 Asia/Shanghai（UTC+8 无夏令时）的 'sv-SE'
 * 墙钟文本——翻译层同基准，与部署机/容器/会话时区解耦；sqlite datetime('now')=UTC 与
 * 'localtime'=本地的双钟语义在此统一为业务基准（跨钟比较即数小时级错乱，读写同钟才可比）。
 * dm 无 AT TIME ZONE 投影语法，基钟用 SYSDATE（MT-9 达梦接入时需校准库时区为 Asia/Shanghai）。 */

/** 业务基准时区（与 db.js now()/daysAgo() 的写入基钟一致） */
const TZ_BASE = 'Asia/Shanghai';

/** 方言基钟表达式（PG 系：timestamptz 投影到业务基准时区的墙钟 timestamp；dm：SYSDATE） */
function clockExpr(isDm) {
  return isDm ? 'SYSDATE' : `now() AT TIME ZONE '${TZ_BASE}'`;
}

/** TEXT 列/值 → timestamp（PG 系 ::timestamp；dm CAST——epoch/to_char 均需强类型入参） */
function tsCast(expr, isDm) {
  return isDm ? `CAST(${expr} AS TIMESTAMP)` : `(${expr})::timestamp`;
}

/** 函数实参顶层逗号切分（本族实参不含逗号；若含逗号字符串会切歪 → 逐项校验失败整体放弃，安全无损） */
function splitFnArgs(s) {
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

/** 修饰符解析：'localtime'→skip（基钟即业务基准）；±N unit→区间算术；'start of X'→截断。
 *  未知修饰符返回 null（调用方整体放弃改写——不臆造，残留进 unsupported 告警网）。 */
function datetimeModifier(mod, isDm) {
  const raw = String(mod).trim().replace(/^'(.*)'$/, '$1').trim();
  if (/^localtime$/i.test(raw)) return { skip: true };
  let m = /^([+-]?)\s*(\d+)\s+(second|minute|hour|day|month|year)s?$/i.exec(raw);
  if (m) {
    const sign = m[1] === '-' ? '-' : '+';
    // PG 系：interval '30 days'；dm（Oracle 式）：INTERVAL '30' DAY
    return { expr: isDm ? `${sign} INTERVAL '${m[2]}' ${m[3].toUpperCase()}` : `${sign} interval '${m[2]} ${m[3].toLowerCase()}'` };
  }
  m = /^start of (day|month|year)$/i.exec(raw);
  if (m) {
    // PG 系 date_trunc；dm TRUNC（日/DD 月/MM 年/YYYY）
    const dmFmt = { day: 'DD', month: 'MM', year: 'YYYY' }[m[1].toLowerCase()];
    return { wrap: isDm ? `TRUNC(<E>, '${dmFmt}')` : `date_trunc('${m[1].toLowerCase()}', <E>)` };
  }
  return null;
}

/**
 * datetime()/date('now'…) → TEXT 契约等价改写（sqlite 语义：返回 TEXT）。
 * 覆盖：'now' 基钟、'localtime'（并入业务基准）、±N unit、'start of day|month|year'、
 * 列形态 datetime(col)（TEXT→timestamp 规范化）；参数化修饰符（?||' seconds'，queue 退避）
 * 不可静态改写 → 保留原文（调用点已改 JS 计算，见 lib/queue/memory-driver.js）。
 */
function replaceDatetimeFn(sql, dialectName) {
  const isDm = dialectName === 'dm';
  const FMT = { datetime: "'YYYY-MM-DD HH24:MI:SS'", date: "'YYYY-MM-DD'" };
  return String(sql).replace(/\b(datetime|date)\(\s*([^()]*?)\s*\)/gi, (whole, fn, argsRaw) => {
    const parts = splitFnArgs(argsRaw);
    if (!parts.length || parts.some((p) => p.includes('?'))) return whole;
    const first = parts[0];
    let expr;
    if (/^'now'$/i.test(first)) expr = clockExpr(isDm);
    else if (/^[\w."]+$/i.test(first)) expr = tsCast(first, isDm); // 列形态：TEXT 规范化
    else return whole;
    for (const mod of parts.slice(1)) {
      const r = datetimeModifier(mod, isDm);
      if (!r) return whole; // 未知修饰符：不臆造
      if (r.skip) continue;
      expr = r.wrap ? r.wrap.replace('<E>', expr) : `${expr} ${r.expr}`;
    }
    return `to_char(${expr}, ${FMT[String(fn).toLowerCase()]})`;
  });
}

/* ---------------- strftime() 处理（BE-C2 2026-11-22） ---------------- */

/** strftime 格式符 → Oracle/PG 通用 to_char 格式符 */
const STRFTIME_FMT_MAP = {
  '%Y': 'YYYY', '%m': 'MM', '%d': 'DD', '%H': 'HH24', '%M': 'MI', '%S': 'SS',
  '%j': 'DDD', '%W': 'IW', '%w': 'D',
};
/** 把 strftime 格式串转成 to_char 格式串（未识别项原样保留） */
function convertStrftimeFormat(fmt) {
  return String(fmt).replace(/%[YmdHMSjWw]/g, m => STRFTIME_FMT_MAP[m] || m);
}

/**
 * 将 strftime(fmt, arg...) 改写为方言等价表达式。
 *   - '%s' 秒级时间戳：kingbase → EXTRACT(EPOCH FROM <arg>)::bigint；dm → DATEDIFF(SECOND, 1970-01-01, <arg>)
 *     特例 arg 为 'now'/'now','localtime' 时取当前时间。
 *   - 其余格式：to_char(<arg>, '<转换后格式>')（PG/dm 均支持 to_char）。
 * 仅处理「单引号格式串 + 无嵌套括号的参数」，命中即改写；否则保留并留给 unsupported 告警。
 */
function replaceStrftime(sql, dialectName) {
  const isDm = dialectName === 'dm';
  return String(sql).replace(/strftime\(\s*'([^']*)'\s*(?:,\s*([^)]*))?\)/gi, (whole, fmt, argRaw) => {
    const arg0 = String(argRaw || '').trim();
    const isNow = /^'now'(\s*,\s*'localtime')?$/.test(arg0) || arg0 === '';
    if (fmt === '%s') {
      // PG-1（2026-11-23）：列实参补 ::timestamp/CAST 强转——EXTRACT(EPOCH FROM text) 直接报错
      //（billing-gate 的 hold TTL 判定实参为 created_at TEXT 列，原文直发即崩）
      if (isDm) {
        return isNow
          ? `DATEDIFF(SECOND, TIMESTAMP '1970-01-01 00:00:00', SYSDATE)`
          : `DATEDIFF(SECOND, TIMESTAMP '1970-01-01 00:00:00', ${tsCast(arg0, isDm)})`;
      }
      return isNow
        ? `EXTRACT(EPOCH FROM now())::bigint`
        : `EXTRACT(EPOCH FROM ${tsCast(arg0, isDm)})::bigint`;
    }
    if (!arg0) return whole; // 无参数（无目标列）不臆造
    // PG-1：'now' 实参走基钟表达式、列实参强转——to_char(text, …) 在 PG 系同样直接报错
    return `to_char(${isNow ? clockExpr(isDm) : tsCast(arg0, isDm)}, '${convertStrftimeFormat(fmt)}')`;
  });
}

/* ---------------- 方言定义 ---------------- */

const DIALECTS = {
  // 默认：恒等（不翻译任何内容）
  sqlite: { name: 'sqlite', label: 'SQLite（默认）', rules: [], unsupported: [] },

  // 达梦 DM8
  dm: {
    name: 'dm',
    label: '达梦 DM8',
    rules: [
      // INTEGER PRIMARY KEY AUTOINCREMENT → INT IDENTITY(1,1) PRIMARY KEY
      { re: /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, to: 'INT IDENTITY(1,1) PRIMARY KEY' },
      // BE-C2（2026-11-23）补单列自增形态（无 PK 紧跟）：此前该形态落入 AUTOINCREMENT 残留告警
      { re: /\bINTEGER\s+AUTOINCREMENT\b/gi, to: 'INT IDENTITY(1,1)' },
      // 搜索型 LIKE 的大小写：DM 默认区分，保留原样
      ...COMMON_RULES,
    ],
    unsupported: [
      { name: 'julianday()', re: /\bjulianday\s*\(/i },
      { name: 'printf()', re: /\bprintf\s*\(/i },
      { name: 'randomblob()', re: /\brandomblob\s*\(/i },
      { name: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/i },
      { name: 'PRAGMA', re: /\bPRAGMA\b/i },
      // BE-C2（2026-11-23）：达梦不支持 ON CONFLICT upsert（PG 9.5+ 语法）——不臆造 MERGE 机械改写
      //（占位符重排/命名风险高且无 dm 环境验证）；替代方案登记于 scripts/dialect-baseline.json：
      // MERGE INTO 模板或应用层先查后写
      { name: 'ON CONFLICT upsert', re: /\bON\s+CONFLICT\b/i },
      { name: 'sqlite_master 系统表', re: /\bsqlite_master\b|\bsqlite_sequence\b/i },
      // PG-1（2026-11-23）残留网：datetime()/date()/strftime() 经改写后仍存留的形态
      //（参数化修饰符、未知修饰符）——此前静默漏过属审计盲区，显式产出 warning
      { name: 'datetime()/date()/strftime() 残留', re: /\b(datetime|strftime)\s*\(|\bdate\s*\(\s*'now'/i },
    ],
  },

  // 人大金仓 KingbaseES（PostgreSQL 兼容）
  kingbase: {
    name: 'kingbase',
    label: '人大金仓 KingbaseES',
    rules: [
      // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
      { re: /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, to: 'SERIAL PRIMARY KEY' },
      // 单独的整型自增列（无 PRIMARY KEY 紧跟）
      { re: /\bINTEGER\s+AUTOINCREMENT\b/gi, to: 'SERIAL' },
      // BLOB（SQLite 任意长度二进制）→ PG 系 BYTEA（迁移 #130 列定义 def='BLOB DEFAULT NULL' 经此翻译；
      // PG 无 BLOB 类型，原文直发即 syntax error——MT-7 PoC 首跑踩坑。dm 自有 BLOB 类型故不入 COMMON_RULES）
      { re: /\bBLOB\b/g, to: 'BYTEA' },
      // instr(X, Y) → PG 系 strpos(X, Y)：语义一致（Y 在 X 中的 1 起始位置，未命中为 0）——
      // api_key 加密迁移的明文探测 WHERE instr(api_key,'.')=0 经此翻译（PG 无 instr，原文直发
      // 即报错、迁移兜底降级为不加密——MT-7 PoC 二跑踩坑。dm 自有 INSTR，保持原文）
      { re: /\binstr\s*\(/gi, to: 'strpos(' },
      ...COMMON_RULES,
    ],
    unsupported: [
      { name: 'julianday()', re: /\bjulianday\s*\(/i },
      { name: 'printf()', re: /\bprintf\s*\(/i },
      { name: 'randomblob()', re: /\brandomblob\s*\(/i },
      { name: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/i },
      { name: 'PRAGMA', re: /\bPRAGMA\b/i },
      // ON CONFLICT upsert：PG 系原生兼容，不告警（smoke 单测锚定该语义）
      { name: 'sqlite_master 系统表', re: /\bsqlite_master\b|\bsqlite_sequence\b/i },
      // PG-1（2026-11-23）残留网：datetime()/date()/strftime() 经改写后仍存留的形态
      //（参数化修饰符、未知修饰符）——此前静默漏过属审计盲区，显式产出 warning
      { name: 'datetime()/date()/strftime() 残留', re: /\b(datetime|strftime)\s*\(|\bdate\s*\(\s*'now'/i },
    ],
  },
};

/** 方言名列表 */
function dialects() { return Object.keys(DIALECTS); }

/** 是否为已知方言 */
function isKnown(name) { return Object.prototype.hasOwnProperty.call(DIALECTS, name); }

/** 取方言定义（未知时回退 sqlite，保持零回归） */
function getDialect(name) {
  const key = String(name || 'sqlite').toLowerCase();
  return DIALECTS[key] || DIALECTS.sqlite;
}

/**
 * 翻译 SQL 到目标方言。
 * @param {string} sql SQL 文本（SQLite 语法）
 * @param {string} [dialectName='sqlite']
 * @returns {{sql:string, warnings:string[], downgrades:Array<{kind:string,table?:string,note:string}>, dialect:string}}
 *   - warnings：需人工确认的未映射构造（审计门禁要求「为 0 或登记替代」）
 *   - downgrades：已确认降级路径的构造（如 FTS5 虚表跳过——检索层有内存通道/全扫兜底，
 *     见 retriever.bm25Scores 的方言判定与 vector-index.available() 探测），不构成阻塞
 */
function translate(sql, dialectName = 'sqlite') {
  const d = getDialect(dialectName);
  let out = String(sql == null ? '' : sql);
  const warnings = [];
  const downgrades = [];

  if (d.name === 'sqlite') return { sql: out, warnings, downgrades, dialect: d.name };

  // --- BE-C2（2026-11-23）FTS5 / vec0 虚表 DDL：方言侧跳过建表（注释化）+ 降级登记 ---
  // 全文索引与 ANN 向量索引均为 SQLite 专有（vec0 为 sqlite-vec 扩展）。非 sqlite 方言下：
  //   - kb_chunks_fts（FTS5 全文）→ 检索降级为 BM25 内存通道（retriever.bm25Scores 方言判定）
  //   - vec_kb_*（vec0 影子表）→ ANN 不可用 → 检索走全扫（vector-index.available() 已有降级路径）
  out = out.replace(
    /CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)\s+USING\s+(fts5|vec0)\b[^;]*;?/gi,
    (whole, table, kind) => {
      downgrades.push({
        kind: `virtual-table:${kind}`,
        table: String(table).replace(/"/g, ''),
        note: kind === 'fts5'
          ? `${d.label} 不支持 FTS5 全文索引，建表跳过——BM25 降级为内存通道（retriever.bm25Scores 方言判定）`
          : `${d.label} 不支持 vec0 向量虚表，建表跳过——ANN 降级为全扫（vector-index.available() 探测兜底）`,
      });
      return `-- [dialect-skip:${kind}] ${table}：${d.label} 专有索引降级（见 downgrades 登记）`;
    }
  );

  // --- 复合语句：INSERT OR IGNORE / INSERT OR REPLACE 的语义等价改写 ---
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
    if (d.name === 'kingbase') {
      out = appendClause(out, 'ON CONFLICT DO NOTHING');
    } else {
      warnings.push('INSERT OR IGNORE：达梦缺少等价语法，已降级为普通 INSERT，去重需依赖唯一约束 + 应用层判定');
    }
  }
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT');
    if (d.name === 'kingbase') {
      warnings.push('INSERT OR REPLACE：金仓需 ON CONFLICT (...) DO UPDATE SET ...，缺少冲突目标，未自动改写（建议业务侧改为标准 ON CONFLICT 写法，本方言即原生兼容）');
    } else {
      warnings.push('INSERT OR REPLACE：达梦需改写为 MERGE，未自动改写（建议业务侧改为标准 ON CONFLICT 写法，由 MERGE 模板登记替代）');
    }
  }

  // --- strftime(…) → to_char/epoch 等价改写（BE-C2；PG-1 补实参强转） ---
  out = replaceStrftime(out, d.name);

  // --- datetime()/date() → TEXT 契约等价改写（PG-1 2026-11-23 语义修复） ---
  out = replaceDatetimeFn(out, d.name);

  // --- 正则规则逐条应用 ---
  for (const r of d.rules) out = out.replace(r.re, r.to);

  // --- 未映射构造告警 ---
  for (const p of d.unsupported) {
    if (p.re.test(out)) warnings.push(`未映射的 SQLite 专有构造：${p.name}（请人工确认 ${d.label} 等价写法）`);
  }

  return { sql: out, warnings, downgrades, dialect: d.name };
}

/** 在语句末尾（分号之前）追加子句 */
function appendClause(sql, clause) {
  const trimmed = sql.replace(/\s*;\s*$/, '');
  const semi = /;\s*$/.test(sql) ? ';' : '';
  return `${trimmed} ${clause}${semi}`;
}

module.exports = { dialects, isKnown, getDialect, translate, DIALECTS, convertStrftimeFormat, replaceStrftime };
