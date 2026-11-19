/**
 * 工具确认等待注册表（U0-5 P1，原为 routes/chat.js 模块级 Map）
 *
 * 抽为独立模块的原因：HITL 审批现在有两条决议入口——
 *   ① 前端消息流内嵌确认卡 → POST /api/chat/confirm
 *   ② IM 渠道卡片按钮回调 → POST /api/channel/card-callback
 * 两条路径必须唤醒「同一份」进程内等待，否则 IM 点击按钮后对话仍会挂到 120s 超时。
 *
 * 语义保持与原实现完全一致（单进程内存 Map）：
 *   key = `${session_id}:${Date.now()}:${tool_name}`（与 tool_approvals.confirm_key 同值）
 *   entry = { resolve, username, expires, finalizeApproval }
 */
const registry = new Map();

/** 注册一个等待项。entry: { resolve, username?, expires?, finalizeApproval? } */
function register(key, entry) { registry.set(key, entry); return entry; }

/** 读取等待项（决议路由做归属/时效校验用） */
function get(key) { return registry.get(key); }

/** 是否存在 */
function has(key) { return registry.has(key); }

/** 移除等待项（超时/中止清理用）——仅移出注册表，不触发 resolve */
function del(key) { return registry.delete(key); }

/** 当前等待项数量（排障/测试用） */
function size() { return registry.size; }

/**
 * 按 key 决议：写终态（finalizeApproval）+ 唤醒等待（resolve）+ 移出注册表。
 * 与 routes/chat.js 原 /confirm 逻辑一致：approve===true → 'approved'，否则 'rejected'。
 * 幂等：key 不存在返回 false；entry.resolve 内部会 clearTimeout + 自删，因此重复调用安全。
 * @returns {boolean} 是否命中并完成决议
 */
function resolveByKey(key, approve, approver, reason) {
  const e = registry.get(key);
  if (!e) return false;
  try { e.finalizeApproval && e.finalizeApproval(approve === true ? 'approved' : 'rejected', approver || '', String(reason || '').slice(0, 200)); } catch { /* 审计回写失败不阻断决议 */ }
  try { e.resolve(approve === true); } catch { /* resolve 失败不抛 */ }
  return true;
}

module.exports = { register, get, has, del, size, resolveByKey };
