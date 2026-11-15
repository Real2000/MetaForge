/**
 * U0-4 模型自动路由（2026-11-13）
 *
 * 当智能体 model 设为 'auto' 时，运行时按任务特征自动选择最优模型。
 *
 * 路由决策依据（权重从高到低）：
 *   1) 能力标签匹配：根据输入任务所需的 capability 匹配模型能力注册表
 *   2) 熔断状态：熔断中的模型不参与选择
 *   3) 供应商连通状态（status/status_msg）
 *   4) 供应商优先级（is_default）
 *   5) 历史成功率（熔断记录中的连续失败/健康状态）
 *
 * 路由模式（model-router 工作流程）：
 *   agent在保存时 model='auto' → 运行时 chat.js 调路由 → 返回 { provider, model }
 *   失败自动降级到候选模型 → 降级记录写入 chat_traces
 */
const { db } = require('../db');
const circuit = require('./circuit');

/* ---------- 能力标签映射 ---------- */

/** 根据输入特征推断需要的 capability 列表 */
function guessCapabilities(input, attachments) {
  const caps = ['text', 'tool_call', 'streaming']; // 默认：需要文本+工具调用+流式
  // 如果输入包含图片链接 → 需要 vision
  if (attachments && Array.isArray(attachments)) {
    for (const att of attachments) {
      if (typeof att === 'string' && /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(att)) {
        caps.push('vision');
        break;
      }
    }
  }
  if (!input) return caps;
  // 检测输入中的图片 URL
  if (/!\[.*?\]\(.*?\)|<img[^>]+src/i.test(input)) caps.push('vision');
  // 检测视频 URL
  if (/\.(mp4|webm|mov)$/i.test(input)) caps.push('vision');
  // 检测长文本（超过 2000 字 → 需要大上下文能力，暂时用标准模型）
  if (input.length > 2000) caps.push('long_text');
  return caps;
}

/** 从已配置供应商的能力注册表中筛选符合条件的候选模型 */
function getCandidates(caps) {
  // 从已配置供应商中提取
  const ps = db.prepare("SELECT id, name, models, configured, is_default, status AS conn_status FROM providers WHERE configured=1 AND api_key != '' AND base_url != '' ORDER BY is_default DESC, id").all();
  const candidates = [];

  for (const provider of ps) {
    // 跳过连接异常态（不可达的供应商）
    if (provider.conn_status === 0) continue;
    let ms = [];
    try { ms = JSON.parse(provider.models || '[]'); } catch { ms = []; }
    for (const model of ms) {
      // 检查能力匹配
      const modelCaps = getModelCapabilities(model, provider.name);
      const match = caps.every(c => modelCaps.includes(c));
      if (!match) continue;
      // 检查熔断状态
      if (circuit.isOpen && circuit.isOpen(provider, model)) continue;
      const score = scoreCandidate(provider, model, modelCaps, caps);
      candidates.push({ provider: provider.name, providerId: provider.id, model, score, isDefault: !!provider.is_default, connStatus: provider.conn_status });
    }
  }
  // 按评分降序排列
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** 从 model_capabilities 表获取某个模型的能力列表（含全局注册） */
function getModelCapabilities(modelName, providerName) {
  const rows = db.prepare(`SELECT capability FROM model_capabilities WHERE (model_name=? AND (provider_name=? OR provider_name='')) AND enabled=1`).all(modelName, providerName);
  const caps = rows.map(r => r.capability);
  // 按未命中补全基础能力（所有模型默认有 text 能力）
  if (!caps.includes('text')) caps.push('text');
  return caps;
}

/** 对候选模型评分（越高越优先） */
function scoreCandidate(provider, model, modelCaps, neededCaps) {
  let score = 0;
  // 基础分：匹配到的必需能力数
  const matched = neededCaps.filter(c => modelCaps.includes(c)).length;
  score += matched * 100;

  // 供应商优先级：default +50
  if (provider.is_default) score += 50;

  // 供应商连通状态：正常 +20
  if (provider.conn_status !== 0) score += 20;

  // 历史成功率（来自熔断器统计）：最近 N 次调用无失败 +10
  const health = circuit.getProviderHealth ? circuit.getProviderHealth(provider.id) : null;
  if (health && health.calls > 0) {
    const okRate = health.calls > 0 ? health.oks / health.calls : 1;
    score += Math.round(okRate * 30);
  }

  // 默认模型（is_default）额外加分
  if (provider.is_default) score += 10;

  return score;
}

/**
 * 执行自动路由（对外主入口）
 * @param {object} opts
 * @param {string}  opts.input        - 用户输入
 * @param {Array}   [opts.attachments] - 附件列表
 * @param {string}  [opts.agentName]  - 智能体名称（用于日志）
 * @returns {{ ok: boolean, model?: string, provider?: string, candidates?: number, routed?: boolean }}
 */
async function autoRoute(opts = {}) {
  const caps = guessCapabilities(opts.input, opts.attachments);
  const candidates = getCandidates(caps);
  if (!candidates.length) {
    return { ok: false, error: '没有符合条件的可用模型（所有候选模型熔断或供应商异常）', candidatesCount: 0 };
  }
  const best = candidates[0];
  return {
    ok: true,
    model: best.model,
    provider: best.provider,
    providerId: best.providerId,
    score: best.score,
    candidatesCount: candidates.length,
    capabilities: caps,
    routed: true,
  };
}

module.exports = { autoRoute, guessCapabilities, getCandidates, getModelCapabilities, scoreCandidate };