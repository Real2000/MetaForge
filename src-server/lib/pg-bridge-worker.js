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

function finish(stateArr, file, payload) {
  try {
    require('fs').writeFileSync(file, JSON.stringify(payload));
  } catch (e) {
    // 结果文件写失败也要唤醒主线程（否则 Atomics.wait 挂满超时）——错误经共享槽旁路文件传递
    try { require('fs').writeFileSync(file + '.err', String(e && e.message || e)); } catch { }
  }
  Atomics.store(stateArr, 0, 1);
  Atomics.notify(stateArr, 0);
}

async function acquireConn() {
  if (txConn) return { conn: txConn, release: () => { } }; // 事务期固定租约
  const conn = await pool.connect();
  return { conn, release: () => conn.release() };
}

parentPort.on('message', (req) => {
  const { op, sql, args, file, stateBuf } = req;
  const stateArr = stateBuf ? new Int32Array(stateBuf) : new Int32Array(new SharedArrayBuffer(4));
  (async () => {
    if (op === 'init') {
      Pool = require('pg').Pool;
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
        try { await txConn.query('BEGIN'); finish(stateArr, file, { ok: true, rows: [], rowCount: 0 }); }
        catch (e) { const c = txConn; txConn = null; c.release(); finish(stateArr, file, { ok: false, error: String(e && e.message || e) }); }
        return;
      }
      if (!txConn) { finish(stateArr, file, { ok: false, error: `pg-bridge：${kw} 无对应 BEGIN` }); return; }
      const c = txConn; txConn = null;
      try { await c.query(kw); finish(stateArr, file, { ok: true, rows: [], rowCount: 0 }); }
      catch (e) { finish(stateArr, file, { ok: false, error: String(e && e.message || e) }); }
      finally { c.release(); }
      return;
    }

    const { conn, release } = await acquireConn();
    try {
      if (op === 'query' || op === 'run') {
        // RLS 注入：设置租户上下文时包「事务级 set_config + 语句」——SET LOCAL 事务内生效，
        // 连接归还池后不残留（脏连接隔离）；tenantId 经 Number() 窄化后内插（数字无注入面）
        let full = String(sql), fullArgs = args || [];
        if (req.tenantId != null) {
          await conn.query('BEGIN');
          await conn.query(`SELECT set_config('app.tenant_id', '${Number(req.tenantId)}', true)`);
        }
        let result;
        if (req.tenantId != null) {
          result = await conn.query(full, fullArgs);
          await conn.query('COMMIT');
        } else {
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
        // 多语句块（DDL/迁移）：RLS 上下文下同样包事务（set_config 语义生效）
        if (req.tenantId != null) {
          await conn.query('BEGIN');
          await conn.query(`SELECT set_config('app.tenant_id', '${Number(req.tenantId)}', true)`);
          const r = await conn.query(String(sql));
          await conn.query('COMMIT');
          finish(stateArr, file, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
        } else {
          const r = await conn.query(String(sql)); // pg simple query：多语句块原生支持
          finish(stateArr, file, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
        }
      } else {
        finish(stateArr, file, { ok: false, error: `pg-bridge：未知 op ${op}` });
      }
    } catch (e) {
      // 连接状态复位规则：
      //   · RLS 自包事务（本函数 BEGIN 的）失败 → ROLLBACK 复位后归还（连接不带 aborted 态回池）
      //   · 事务租约（外层 db.transaction 持有）失败 → 本层不动，错误上抛由外层 ROLLBACK
      //     走同一租约连接完成清理（释放也留给外层 COMMIT/ROLLBACK 分支）
      if (req.tenantId != null) {
        try { await conn.query('ROLLBACK'); } catch { /* 连接已坏时归还由池重建 */ }
      }
      finish(stateArr, file, { ok: false, error: String(e && e.message || e) });
    } finally {
      release();
    }
  })().catch(e => finish(stateArr, file, { ok: false, error: String(e && e.message || e) }));
});
