/**
 * BE-F1（2026-11-23）：请求上下文（AsyncLocalStorage）——requestId 全链路传播
 *
 * 设计：access-log 中间件以 runWithContext 包住路由处理，此后该请求的同步/异步
 * 调用链（含 fire-and-forget 后台任务）内皆可 currentRequestId() 取值；
 * audit.js 拦截器据此为全部 op_logs/security_events 写入自动补 request_id 列
 * （关联键，不参与 SEC-11 哈希链——见 audit.js ccols 排除）。
 *
 * 后台任务（定时器/调度器）不在任何请求上下文内 → currentRequestId() 返回 ''（默认空串落库）。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

/** 在给定上下文中执行 fn（中间件入口用） */
function runWithContext(ctx, fn) { return store.run(ctx, fn); }

/** 当前上下文对象（无请求上下文时返回 null——后台任务场景） */
function currentContext() { return store.getStore() || null; }

/** 当前请求 requestId（无上下文返回 ''） */
function currentRequestId() { const c = store.getStore(); return (c && c.requestId) || ''; }

module.exports = { runWithContext, currentContext, currentRequestId };
