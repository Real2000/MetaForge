/**
 * MT-7（2026-11-23）PostgreSQL 同步桥 —— db 兼容层（PoC 主线程侧）
 *
 * 架构定位：让业务层 1585+ 处「同步」db.prepare/exec/transaction 调用在 PG 上零改动运行
 *（BE-C1 收敛 + BE-C2 方言闭环换来的架构红利——本模块是数据层可插拔的最后一公里）。
 *
 * 同步等待原理：Node 主线程允许 Atomics.wait（区别于浏览器主线程）。主线程发请求后阻塞，
 * worker（pg-bridge-worker.js，持有 pg Pool）写完结果文件后 Atomics.notify 唤醒——
 * postMessage 事件在主线程阻塞期间无法被 EventLoop 处理，notify 是唯一同步唤醒路径。
 * PoC 验证「核心资源读写走 PG + RLS + 并发写无 SQLITE_BUSY」的正确性；性能优化
 *（结果通道去文件化/批量化）属全量迁移范围。
 *
 * better-sqlite3 契约对齐（零改动的前提，逐项）：
 *   · prepare(sql).all/get/run —— get 无行返回 undefined（不返回 null，业务 ?. 与 === 判断依赖）
 *   · run 返回 { changes, lastInsertRowid }（dal.insert/路由创建链依赖 lastInsertRowid；
 *     PG 侧由 worker 同连接补查 lastval() 实现）
 *   · prepare().pluck().get() —— 单列取值（dal.pluck/migrate 使用）
 *   · exec(sql) 多语句块、transaction(fn) 同步事务（BEGIN→fn→COMMIT/异常 ROLLBACK，8 处业务使用，
 *     不支持嵌套——全库无嵌套用例，遇嵌套显式报错优于静默错账）
 *   · pragma() no-op（busy_timeout/journal_mode 为 SQLite 专有，PG 由连接参数承担）
 *
 * RLS：setTenantContext(tid) 后每条语句在 worker 端包「BEGIN; SET LOCAL app.tenant_id; stmt;
 * COMMIT」——事务级会话变量、连接归池不残留；POLICY 见 lib/pg-rls.js（FORCE RLS，owner 也受控）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { AsyncLocalStorage } = require('async_hooks'); // PG-1：请求级租户上下文（防 async 恢复点串租）
const { translate: _translateSql } = require('./sql-dialect'); // 桥内置方言翻译（见 prepare/exec 内联说明）

/** 占位符转换与调用超时（见 createPgBridge 内联说明） */
const CALL_TIMEOUT_MS = 30000;

/**
 * SQLite 风格 `?` 占位符 → PG 风格 `$1..$n`（词法感知：字符串/注释内的 ? 不是占位符）。
 * 为什么放桥内而非方言层 translate：占位符与 SQL 字面量语义强相关（LIKE '%?%'），需要词法
 * 状态机而非全文正则；且 sqlite 方言下不转换——仅 PG 桥的 prepare 调用。
 * @returns {{sql:string, n:number}}
 */
function convertPlaceholders(sql) {
  let out = '', i = 0, n = 0;
  const src = String(sql == null ? '' : sql);
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const q = ch; out += ch; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q && src[i + 1] === q) { out += src[i + 1]; i += 2; continue; } // 双写转义
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') { out += src[i]; i++; } continue; }
    if (ch === '/' && src[i + 1] === '*') { out += ch; i++; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i]; i++; } continue; }
    if (ch === '?') { n++; out += `$${n}`; i++; continue; }
    out += ch; i++;
  }
  return { sql: out, n };
}

/**
 * 创建同步桥 db 兼容对象（better-sqlite3 子集）。
 * @param {object} [opts]
 *   - connString：postgres://user:pass@host:port/db（缺省取 PG_CONN / DATABASE_URL）
 *   - poolMax：连接池上限（默认 4——同步桥串行语义下单请求一次一连接）
 * @returns {object} db 兼容对象（prepare/exec/transaction/pragma/close + setTenantContext）
 */
function createPgBridge(opts = {}) {
  const connString = opts.connString || process.env.PG_CONN || process.env.DATABASE_URL;
  if (!connString) {
    throw new Error('pg-bridge：缺少 PG 连接串（设 PG_CONN=postgres://user:pass@host:5432/db，或 DATABASE_URL）');
  }
  try { require.resolve('pg'); } catch {
    throw new Error('pg-bridge：未安装 pg 驱动（npm i pg），或改用默认 SQLite（AGENT_DB_DRIVER=sqlite）');
  }

  // 同步握手状态槽：0=请求进行中（主线程 wait 阻塞于此值），worker 完成 store 1 + notify 唤醒
  const state = new Int32Array(new SharedArrayBuffer(4));
  const stateBuf = state.buffer;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mt7-bridge-'));
  let seq = 0;
  let tenantId = null; // RLS 会话上下文（闭包兜底：启动期种子/脚本/PoC 显式设置；请求域优先走 ALS）
  // PG-1（2026-11-23）请求级租户上下文：闭包方案在 Express async 处理链下有「恢复点串租」天险
  //（A 请求 await 期间 B 请求改写闭包，A 恢复后带着 B 的租户查询）。ALS 上下文随异步链传播，
  // 请求级隔离由此成立。生效优先级：ALS（withTenant 请求域）> 闭包（setTenantContext）。
  const tenantAls = new AsyncLocalStorage();
  /** 归一化租户上下文值：'platform'（跨租户显式逃逸，RLS 策略分支匹配）| 数字租户 id | null（基线） */
  function normTenant(tid) {
    if (tid === 'platform') return 'platform';
    if (tid == null) return null;
    const n = Number(tid);
    if (!Number.isFinite(n) || n < 0) throw new Error('pg-bridge：非法租户上下文（' + String(tid) + '）');
    return n;
  }
  const effTenant = () => {
    const s = tenantAls.getStore();
    return s ? s.tenantId : tenantId;
  };

  const worker = new Worker(path.join(__dirname, 'pg-bridge-worker.js'), { workerData: null });
  // 关键（PoC 首跑踩坑回归锚定）：Worker 线程默认阻止所在进程退出——一次性脚本（node -e 验证子进程 /
  // CLI migrate.js）主逻辑完成后将因 worker 存活而永不退出，表现为子进程挂死、execFileSync 逐级超时。
  // unref 后进程存活只取决于主线程自身句柄：服务进程由监听句柄保活（不受影响）；主线程 Atomics.wait
  // 同步阻塞期间正忙于执行，unref 不影响同步调用的正确性（唤醒仍由 Atomics.notify 承担）。
  worker.unref();

  /** 同步调用 worker：postMessage → Atomics.wait（阻塞至 notify/超时）→ 读结果文件 */
  function callSync(req) {
    const file = path.join(tmpBase, `r${++seq}.json`);
    Atomics.store(state, 0, 0);
    worker.postMessage({ ...req, file, stateBuf });
    const r = Atomics.wait(state, 0, 0, CALL_TIMEOUT_MS);
    if (r === 'timed-out') throw new Error(`pg-bridge：查询超时（${CALL_TIMEOUT_MS}ms）——${String(req.sql || req.op).slice(0, 80)}`);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } finally { try { fs.unlinkSync(file); } catch { } }
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error(`pg-bridge：${parsed.error}`);
    return parsed;
  }

  // init 同步等待（Pool 建立后才接受后续调用——连接失败在此显式抛出，不把首个业务查询当牺牲品）
  callSync({ op: 'init', connString, poolMax: opts.poolMax });

  return {
    _worker: worker,
    /** RLS 租户上下文（DB 层强制隔离的会话变量；null=平台基线/超管全量可见） */
    // 注：窄化必须作用于入参 tid——曾误写 Number(tenantId)（闭包初值 null → Number(null)=0），
    // 使一切租户上下文静默归 0、RLS 隔离形同虚设（PoC 复现踩坑；smoke 静态守卫已锚定）。
    setTenantContext(tid) { tenantId = tid == null ? null : Number(tid); },
    getTenantContext() { return tenantId; },
    /** 请求级租户上下文（ALS）：fn 的全部同步/异步续体（含 await 恢复点）内生效——
     *  auth.tenantContext 中间件对每个请求调用，是 RLS 租户注入的主通道；
     *  'platform' 为平台平面运维的显式跨租户逃逸（代码级 opt-in，非用户可控输入） */
    withTenant(tid, fn) {
      if (typeof fn !== 'function') throw new Error('pg-bridge.withTenant(tid, fn)：fn 必须为函数');
      return tenantAls.run({ tenantId: normTenant(tid) }, fn);
    },

    prepare(sql) {
      // 内置方言翻译（kingbase/PG 系）：覆盖框架层直连 db.prepare 的 SQL（audit/retriever 等
      // 不走 dal 的出口）——dal 出口的 SQL 已翻译过，translate 幂等（已替换文本不再命中规则），二次经过无害
      const t = _translateSql(String(sql), 'kingbase');
      const { sql: pgSql, n } = convertPlaceholders(t.sql);
      const run0 = (op, args) => callSync({ op, sql: pgSql, args: args.slice(0, n), tenantId: effTenant() });
      return {
        all(...args) { return run0('query', args).rows; },
        get(...args) { return run0('query', args).rows[0]; }, // better-sqlite3 契约：无行 → undefined
        run(...args) {
          const r = run0('run', args);
          return { changes: r.rowCount, lastInsertRowid: r.lastval };
        },
        pluck() {
          return { get: (...args) => {
            const rows = run0('query', args).rows;
            return rows[0] ? Object.values(rows[0])[0] : undefined;
          } };
        },
        iterate() { throw new Error('pg-bridge：iterate() 不支持（BE-C1 形态审计全库 0 处使用）'); },
      };
    },

    exec(sql) {
      // 同 prepare：内置翻译（多语句块——DDL 经 db.js exec 包装已翻译，此处幂等兜底框架层直连）
      callSync({ op: 'exec', sql: convertPlaceholders(_translateSql(String(sql), 'kingbase').sql).sql, tenantId: effTenant() });
      return undefined; // better-sqlite3 exec 无返回值
    },

    transaction(fn) {
      // better-sqlite3 契约：transaction(fn) 返回「可调用包装」，调用点形态 db.transaction(fn)(args)。
      // PG-1 复现踩坑（2026-11-24）：原实现直接执行并返回结果——调用点二次调用即报
      // "db.transaction(...) is not a function"，且事务已 COMMIT、结果无法随异常回滚
      //（PG 轨道 MT-10 开通租户出现「400 返回但租户+管理员已落库」假象，run4 排障定位）。
      if (typeof fn !== 'function') throw new Error('pg-bridge.transaction(fn)：fn 必须为函数');
      // 同步事务：BEGIN（worker 租约连接）→ fn()（内部语句自动路由租约连接）→ COMMIT / 异常 ROLLBACK
      return (...args) => {
        callSync({ op: 'exec', sql: 'BEGIN' });
        try {
          const out = fn(...args);
          callSync({ op: 'exec', sql: 'COMMIT' });
          return out;
        } catch (e) {
          try { callSync({ op: 'exec', sql: 'ROLLBACK' }); } catch { /* 回滚失败保留原始异常优先上抛 */ }
          throw e;
        }
      };
    },

    pragma() { return undefined; }, // busy_timeout/journal_mode 为 SQLite 专有——PG 由连接参数承担
    close() { try { worker.postMessage({ op: 'shutdown' }); worker.terminate(); } catch { } },
  };
}

module.exports = { createPgBridge, convertPlaceholders };
