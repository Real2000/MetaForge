/**
 * 模型级熔断器 + 供应商健康统计（2026-10-20 P1 稳定性）
 * 背景：网关上游渠道会持续故障（如 Qwen3-VL 渠道 503 no healthy upstream 数分钟），
 * 重试救不回持续性故障，需要：①该模型暂时拉黑（熔断冷却），②调用方自动降级到其他候选模型。
 * 纯内存实现，重启即重置（健康探测自然恢复）。
 */
const stats = new Map();       // `${providerId}:${model}` → { fails, openUntil, lastFailAt, lastErr }
const providerStats = new Map(); // providerId → { calls, oks, lastOkAt, lastFailAt, lastErr }

const THRESHOLD = 2;    // 连续失败次数达到阈值 → 熔断
const COOLDOWN = 60000; // 熔断冷却 60s（过后半开放行试探，失败再熔断）

function key(provider, model) { return `${provider.id}:${model}`; }

/** 记录一次调用失败（chat 层捕获错误后调用） */
function recordFail(provider, model, err) {
  const k = key(provider, model);
  const v = stats.get(k) || { fails: 0, openUntil: 0, lastFailAt: 0, lastErr: '' };
  v.fails++;
  v.lastFailAt = Date.now();
  v.lastErr = String(err?.message || err || '').slice(0, 150);
  if (v.fails >= THRESHOLD && v.openUntil <= Date.now()) {
    v.openUntil = Date.now() + COOLDOWN;
    console.warn(`[circuit] ⚡ 模型 ${model}@${provider.name} 连续失败 ${v.fails} 次，熔断 ${COOLDOWN / 1000}s（期间自动降级其他模型）`);
  }
  stats.set(k, v);
  const ps = providerStats.get(provider.id) || { calls: 0, oks: 0 };
  ps.calls++;
  ps.lastFailAt = Date.now();
  ps.lastErr = v.lastErr;
  providerStats.set(provider.id, ps);
}

/** 记录一次调用成功（清除该模型的失败计数） */
function recordSuccess(provider, model) {
  stats.delete(key(provider, model));
  const ps = providerStats.get(provider.id) || { calls: 0, oks: 0 };
  ps.calls++;
  ps.oks++;
  ps.lastOkAt = Date.now();
  providerStats.set(provider.id, ps);
}

/** 该模型当前是否熔断中（冷却期过后自动放行试探） */
function isOpen(provider, model) {
  const v = stats.get(key(provider, model));
  return !!(v && v.openUntil > Date.now());
}

/** 健康面板数据：每供应商最近调用状态 + 熔断中的模型列表 */
function healthReport() {
  const out = [];
  for (const [pid, ps] of providerStats) {
    out.push({
      provider_id: pid,
      calls: ps.calls,
      oks: ps.oks,
      ok_rate: ps.calls ? +(ps.oks / ps.calls).toFixed(2) : null,
      last_ok_at: ps.lastOkAt || null,
      last_fail_at: ps.lastFailAt || null,
      last_err: ps.lastErr || '',
      state: ps.lastFailAt && (!ps.lastOkAt || ps.lastFailAt > ps.lastOkAt) ? 'fail' : (ps.lastOkAt ? 'ok' : 'unknown'),
    });
  }
  const openModels = [];
  for (const [k, v] of stats) {
    if (v.openUntil > Date.now()) {
      openModels.push({ key: k, until: v.openUntil, last_err: v.lastErr });
    }
  }
  return { providers: out, open_circuits: openModels };
}

module.exports = { recordFail, recordSuccess, isOpen, healthReport, THRESHOLD, COOLDOWN };
