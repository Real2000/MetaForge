/**
 * MT-7（2026-11-23）pg-bridge worker —— pg Pool 持有方（在 worker 线程运行）
 *
 * 职责：把异步 pg 驱动桥接为「主线程可同步等待」的执行端——
 *   1. 持有 pg Pool（连接参数化、用后即还）；
 *   2. 事务亲和：BEGIN 时从池租约专用连接（txConn），事务内语句全部路由该连接，
 *      COMMIT/ROLLBACK 后归还（否则事务跨连接完全失效——多语句必须同连接是硬约束）；
 *   3. 完成唤醒：写结果文件（JSON）后 Atomics.store/notify 共享状态槽——主线程正阻塞在
 *      Atomics.wait 上，postMessage 事件在主线程阻塞期间无法被处理，notify 是唯一唤醒路径；
 *   4. lastInsertRowid：run 类语句在同连接补查 lastval()（PG 会话级序列值），以 __lastval
 *      字段带回——better-sqlite3 的 info.lastInsertRowid 契约（dal.insert/路由创建依赖）。
 *
 * 协议（{op, ...}）：init / shutdown / exec（多语句或事务控制）/ query（参数化）/ run（写+lastval）
 * 结果文件：{ok:true, rows, rowCount, lastval} | {ok:false, error}
 */
'use strict';
const { parentPort } = require('worker_threads'); // worker 线程收父消息必须用 parentPort（process.on('message') 仅主线程 IPC 有效）
let Pool = null;
let pool = null;
let txConn = null; // 事务租约连接
let activeSlot = null; // 当前请求的 SAB 结果槽（PG-2：主线程串行 → 单槽无竞争；每消息重绑）

/** PG-2（2026-11-24）SAB 结果槽写入：常规载荷走共享内存（零文件 IO，单语句往返的恒定开销
 *  主要来自原路径的 write/read/unlink 三次 syscall）；超限/槽异常溢出文件通道（status=2）。
 *  写序：先写数据区与长度，最后 store 状态——Atomics.store 为顺序一致，主线程读到状态 1 时
 *  数据必已就绪。 */
function finish(stateArr, file, payload) {
  if (activeSlot) {
    try {
      const json = JSON.stringify(payload);
      const bytes = Buffer.byteLength(json);
      if (bytes <= activeSlot.cap) {
        Buffer.from(activeSlot.buf, 8).write(json, 0, bytes, 'utf8');
        Atomics.store(activeSlot.head, 1, bytes);
        Atomics.store(activeSlot.head, 0, 1);
        Atomics.store(stateArr, 0, 1);
        Atomics.notify(stateArr, 0);
        return;
      }
    } catch { /* 槽写异常 → 文件兑底，不静默丢结果 */ }
  }
  try {
    require('fs').writeFileSync(file, JSON.stringify(payload));
  } catch (e) {
    // 结果文件写失败也要唤醒主线程（否则 Atomics.wait 挂满超时）——错误经共享槽旁路文件传递
    try { require('fs').writeFileSync(file + '.err', String(e && e.message || e)); } catch { }
  }
  if (activeSlot) Atomics.store(activeSlot.head, 0, 2);
  Atomics.store(stateArr, 0, 1);
  Atomics.notify(stateArr, 0);
}

/** PG-2（2026-11-24）RLS 上下文往返压缩：连接级会话租户缓存（conn.__mfTenant）。
 *  原路径每语句包「BEGIN+set_config(local)+语句+COMMIT」四次串行往返（withTenant P95 3.1ms，
 *  验收硬指标 1.5ms 达不到）。改为会话级 set_config（false）：命中免设（1 次往返），未命中
 *  设一次。**归还保留缓存**（清零会让每次调用都未命中，3 次往返白干）；脏连接防护改为
 *  「无上下文语句租用带残留连接时先 RESET」——无上下文语句不得看到残留会话值，有租户语句
 *  按需覆盖无害。显式事务（租约）内仍用 local=true（随事务回滚，语义不变）。 */
async function ensureTenantSession(conn, tv) {
  if (conn.__mfTenant !== tv) {
    await conn.query("SELECT set_config('app.tenant_id', $1, false)", [String(tv)]);
    conn.__mfTenant = tv;
  }
}

/** 无上下文语句的脏连接防护：租到带会话租户残留的连接先清零（否则语句会按残留租户被
 *  RLS 过滤——错租户读）。有租户语句走 ensureTenantSession 按需覆盖，无需预清。 */
async function ensureNoTenantSession(conn) {
  if (conn.__mfTenant != null) {
    try { await conn.query('RESET app.tenant_id'); } catch { /* 连接已坏：池重建无残留 */ }
    conn.__mfTenant = null;
  }
}

async function acquireConn() {
  if (txConn) return { conn: txConn, release: () => { } }; // 事务期固定租约（归还由 COMMIT/ROLLBACK 分支处理）
  const conn = await pool.connect();
  return { conn, release: () => conn.release() }; // PG-2：归还保留 __mfTenant 缓存（脏连接防护见 ensureNoTenantSession）
}

parentPort.on('message', (req) => {
  const { op, sql, args, file, stateBuf } = req;
  const stateArr = stateBuf ? new Int32Array(stateBuf) : new Int32Array(new SharedArrayBuffer(4));
  // PG-2：每消息重绑 SAB 结果槽（主线程串行——同一时刻仅一个活跃槽；structured clone 对
  // SAB 是共享引用非拷贝，每消息传递开销可忽略）
  activeSlot = req.slotBuf ? { buf: req.slotBuf, head: new Int32Array(req.slotBuf, 0, 2), cap: req.slotBuf.byteLength - 8 } : null;
  (async () => {
    if (op === 'init') {
      const pg = require('pg');
      // PG-1 类型对齐（2026-11-23 PG 轨道首跑踩坑）：pg 默认把 int8（COUNT(*)/SUM/MAX(id) 等聚合
      // 与 bigint 列）解析为字符串、numeric（AVG 等）亦为字符串，而 better-sqlite3 返回 number——
      // 业务层大量 `count === 0` 判等（如 db.js 种子首启判定 userCount === 0）在 PG 下静默走岔
      // （"0" !== 0 → 种子块整块跳过 → 平台超管缺位 → 登录/开通/计费商用链路连锁崩）。
      // 桥的契约是「PG 行为对齐 sqlite、业务层 1585+ 处零改动」，故在驱动层注册解析器归一为
      // number；int8 超出 Number.isSafeInteger（2^53）时保留原字符串，防大数精度损坏。
      pg.types.setTypeParser(20, (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; });
      pg.types.setTypeParser(1700, (v) => { const n = Number(v); return Number.isFinite(n) ? n : v; });
      Pool = pg.Pool;
      pool = new Pool({ connectionString: req.connString, max: req.poolMax || 4 });
      finish(stateArr, file, { ok: true, rows: [], rowCount: 0 });
      return;
    }
    if (op === 'shutdown') {
      if (pool) await pool.end().catch(() => { });
      process.exit(0); // worker 内 process.exit 结束线程
    }
    if (!pool) { finish(stateArr, file, { ok: false, error: 'pg-bridge worker：Pool 未初始化' }); return; }

    // 事务控制语句：BEGIN 租约连接 / COMMIT|ROLLBACK 归还（其余 exec 为普通多语句执行）
    if (op === 'exec' && /^(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(String(sql).trim())) {
      const kw = RegExp.$1.toUpperCase();
      if (kw === 'BEGIN') {
        if (txConn) { finish(stateArr, file, { ok: false, error: 'pg-bridge：不支持的嵌套事务（外层未结束）' }); return; }
        txConn = await pool.connect();
        // 防御：带会话级租户残留的连接进显式事务——事务内无上下文语句会看到残留会话值
        //（PG-2 归还已改为保留缓存，残留是常态而非异常——此处 RESET 即主防线，非兑底）
        if (txConn.__mfTenant != null) {
          try { await txConn.query('RESET app.tenant_id'); } catch { }
          txConn.__mfTenant = null;
        }
        try { await txConn.query('BEGIN'); finish(stateArr, file, { ok: true, rows: [], rowCount: 0 }); }
        catch (e) { const c = txConn; txConn = null; c.release(); finish(stateArr, file, { ok: false, error: String(e && e.message || e) }); }
        return;
      }
      if (!txConn) { finish(stateArr, file, { ok: false, error: `pg-bridge：${kw} 无对应 BEGIN` }); return; }
      const c = txConn; txConn = null;
      try { await c.query(kw); finish(stateArr, file, { ok: true, rows: [], rowCount: 0 }); }
      catch (e) { finish(stateArr, file, { ok: false, error: String(e && e.message || e) }); }
      finally { c.release(); } // 租约连接 __mfTenant 恒 null（BEGIN 防御清零）——直接归还即无残留
      return;
    }

    const { conn, release } = await acquireConn();
    // PG-1（2026-11-24）租约判定：conn 即 txConn 时处于外层 db.transaction 事务内——内层严禁
    // 再包 BEGIN/COMMIT（内层 COMMIT 会提前提交外层事务，原子性破坏），只注入会话变量
    //（set_config local=true 随外层事务生效/回滚）。
    const inLease = conn === txConn;
    try {
      if (op === 'query' || op === 'run') {
        // RLS 注入（PG-2 压缩）：非租约路径走连接级会话租户缓存（命中免设）；租约内仍
        // local=true（随外层事务生效/回滚，不得污染会话级状态）；'platform' 为显式逃逸值
        let full = String(sql), fullArgs = args || [];
        let result;
        if (req.tenantId != null) {
          const tv = req.tenantId === 'platform' ? 'platform' : Number(req.tenantId);
          if (inLease) {
            await conn.query(`SELECT set_config('app.tenant_id', '${tv}', true)`);
            result = await conn.query(full, fullArgs);
          } else {
            await ensureTenantSession(conn, tv);
            result = await conn.query(full, fullArgs);
          }
        } else {
          if (!inLease) await ensureNoTenantSession(conn); // 脏连接防护：无上下文语句不得按残留租户被 RLS 过滤
          result = await conn.query(full, fullArgs);
        }
        const payload = { ok: true, rows: result.rows || [], rowCount: result.rowCount || 0 };
        if (op === 'run') {
          // better-sqlite3 info.lastInsertRowid 契约：同连接查 lastval()（会话级序列值）
          try {
            const lv = await conn.query('SELECT lastval() AS v');
            payload.lastval = lv.rows[0] ? Number(lv.rows[0].v) : undefined;
          } catch { payload.lastval = undefined; } // 非 INSERT 语句无序列值（与 SQLite 行为一致）
        }
        finish(stateArr, file, payload);
      } else if (op === 'exec') {
        // 多语句块（DDL/迁移）：同 query/run 的会话级缓存路径；租约内不嵌套（local=true）
        if (req.tenantId != null) {
          const tv2 = req.tenantId === 'platform' ? 'platform' : Number(req.tenantId);
          if (inLease) {
            await conn.query(`SELECT set_config('app.tenant_id', '${tv2}', true)`);
            const r = await conn.query(String(sql));
            finish(stateArr, file, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
          } else {
            await ensureTenantSession(conn, tv2);
            const r = await conn.query(String(sql));
            finish(stateArr, file, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
          }
        } else {
          if (!inLease) await ensureNoTenantSession(conn); // 脏连接防护（同 query/run 分支）
          const r = await conn.query(String(sql)); // pg simple query：多语句块原生支持
          finish(stateArr, file, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
        }
      } else {
        finish(stateArr, file, { ok: false, error: `pg-bridge：未知 op ${op}` });
      }
    } catch (e) {
      // 连接状态复位规则（PG-2 简化）：非租约路径已无自包事务（会话级缓存免 BEGIN/COMMIT），
      // 单语句失败自动回滚自身；__mfTenant 残留在归还时保留（连接级缓存），由
      // ensureNoTenantSession 在下次无上下文语句时按需 RESET（脏连接防护）。
      // 事务租约（外层 db.transaction 持有）失败：本层不动（不 ROLLBACK 已中止的外层事务），
      // 错误上抛由外层 ROLLBACK 走同一租约连接完成清理。
      finish(stateArr, file, { ok: false, error: String(e && e.message || e) });
    } finally {
      release();
    }
  })().catch(e => finish(stateArr, file, { ok: false, error: String(e && e.message || e) }));
});
