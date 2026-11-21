/**
 * 经验自进化 V1（D3-2，2026-11-21）
 *
 * 纯逻辑、零依赖：让专家团编排（D1-2）随使用积累「专家 × 任务类型」可靠度，并在后续编排中
 * 优先选用高分专家（同类任务二次成功率提升）。
 *
 * 覆盖：
 *  - 任务类型归类：classifyTask（中英关键词打分，多命中去最高分；无命中归 general）
 *  - 可靠度评分：reliability（贝叶斯平滑成功率——样本少时向先验 0.5 收缩，防「1 次偶然成功=满分」）
 *  - 专家优选排序：rankAgents（按指定任务类型的可靠度降序，样本达标优先）
 *  - 经验回写聚合：applyRun（把一次运行结果并入聚合记录，含首跑/复跑分桶）
 *  - 自进化验收指标：evolutionStats（同类型「首跑成功率」vs「复跑成功率」差值 ≥ 15pp）
 *  - 编排提示构造：experienceHint（给编排器一段「各专家历史可靠度」参考文本）
 *
 * 设计原则：与 orchestrator.js 一致——纯逻辑 + 可注入数据，供 routes/experience.js（HTTP）、
 * chat.js 编排链路（D1-2）复用，也被 test/smoke.js 直接单测（不触碰真实模型/网络）。
 */

const PRIOR_RUNS = 2;     // 贝叶斯平滑先验样本量（越大越保守）
const PRIOR_RATE = 0.5;   // 先验成功率
const MIN_SAMPLES = 3;    // 可靠度「可用/可采信」最小样本量
const TARGET_LIFT = 15;   // 自进化验收线：复跑成功率较首跑提升 ≥ 15 个百分点

/** 任务类型关键词表（中英兼容，命中数最多者胜） */
const TASK_TYPES = [
  { key: 'code', label: '代码开发', kw: ['代码', '编程', '函数', 'bug', '调试', '重构', '脚本', '接口', 'api', 'code', 'debug', 'refactor', 'script', 'sql'] },
  { key: 'writing', label: '文案写作', kw: ['写作', '文案', '撰写', '标题', '推文', '营销', '广告', '软文', '文章', 'write', 'copy', 'article', 'slogan'] },
  { key: 'research', label: '调研分析', kw: ['调研', '研究', '分析', '报告', '市场', '竞品', '综述', 'research', 'analysis', 'report', 'survey'] },
  { key: 'translation', label: '翻译', kw: ['翻译', '译成', '中译英', '英译中', 'translate', 'translation'] },
  { key: 'summary', label: '摘要提炼', kw: ['摘要', '总结', '概括', '提炼', '要点', 'summar', 'abstract', 'key point'] },
  { key: 'data', label: '数据处理', kw: ['数据', '表格', 'excel', '统计', '指标', '清洗', '图表', 'data', 'table', 'statistic'] },
  { key: 'design', label: '设计创意', kw: ['设计', '海报', '配图', '视觉', '创意', '排版', 'design', 'poster', 'visual', 'layout'] },
  { key: 'support', label: '客服问答', kw: ['客服', '问答', '答疑', '咨询', 'faq', 'support', 'inquiry'] },
];
const DEFAULT_TYPE = { key: 'general', label: '通用任务' };

/** 把任务描述归类到任务类型（关键词打分） */
function classifyTask(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return DEFAULT_TYPE.key;
  let best = null, bestScore = 0;
  for (const t of TASK_TYPES) {
    let score = 0;
    for (const k of t.kw) if (s.includes(k.toLowerCase())) score++;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.key : DEFAULT_TYPE.key;
}

/** 任务类型 → 中文标签 */
function typeLabel(key) {
  const t = TASK_TYPES.find(x => x.key === key);
  if (t) return t.label;
  return key === DEFAULT_TYPE.key ? DEFAULT_TYPE.label : String(key || DEFAULT_TYPE.key);
}

/** 全部任务类型清单（供前端下拉/筛选用） */
function allTypes({ withGeneral = true } = {}) {
  const list = TASK_TYPES.map(t => ({ key: t.key, label: t.label }));
  if (withGeneral) list.push({ key: DEFAULT_TYPE.key, label: DEFAULT_TYPE.label });
  return list;
}

/** 可靠度评分（0-100，一位小数）：贝叶斯平滑成功率 */
function reliability(success, runs) {
  const n = Math.max(0, Number(runs) || 0);
  const s = Math.max(0, Number(success) || 0);
  const rate = (s + PRIOR_RATE * PRIOR_RUNS) / (n + PRIOR_RUNS);
  return Math.round(rate * 1000) / 10;
}

/** 规范化一条经验聚合记录（补派生字段：成功率/可靠度/置信/均耗时） */
function normalizeRecord(row) {
  const r = row || {};
  const runs = Math.max(0, Number(r.runs) || 0);
  const success = Math.max(0, Number(r.success) || 0);
  const failed = Number.isFinite(Number(r.failed)) ? Number(r.failed) : Math.max(0, runs - success);
  const taskType = r.task_type || DEFAULT_TYPE.key;
  return {
    agent_id: Number(r.agent_id),
    task_type: taskType,
    type_label: typeLabel(taskType),
    runs, success, failed,
    first_runs: Number(r.first_runs) || 0,
    repeat_runs: Number(r.repeat_runs) || 0,
    successRate: runs ? Math.round((success / runs) * 1000) / 10 : null,
    reliability: reliability(success, runs),
    confidence: runs >= MIN_SAMPLES,
    avgDurationMs: runs ? Math.round((Number(r.total_duration_ms) || 0) / runs) : 0,
    lastStatus: r.last_status || '',
    lastAt: r.last_at || '',
  };
}

/**
 * 依据一次运行结果计算聚合记录的下一状态（含首跑/复跑分桶）。
 * 「首跑」= 该（专家 × 任务类型）第一次运行；其余为「复跑」——用于自进化验收指标。
 */
function applyRun(prev, { success, durationMs = 0 } = {}) {
  const p = prev || {};
  const prevRuns = Math.max(0, Number(p.runs) || 0);
  const isFirst = prevRuns === 0;
  const runs = prevRuns + 1;
  const success2 = (Number(p.success) || 0) + (success ? 1 : 0);
  return {
    task_type: p.task_type,
    runs,
    success: success2,
    failed: runs - success2,
    first_runs: (Number(p.first_runs) || 0) + (isFirst ? 1 : 0),
    first_success: (Number(p.first_success) || 0) + (isFirst && success ? 1 : 0),
    repeat_runs: (Number(p.repeat_runs) || 0) + (isFirst ? 0 : 1),
    repeat_success: (Number(p.repeat_success) || 0) + (!isFirst && success ? 1 : 0),
    total_duration_ms: (Number(p.total_duration_ms) || 0) + (Number(durationMs) || 0),
  };
}

/**
 * 按任务类型对候选专家排序（优选高分组合）。
 * @param {Array<{id?:number,agent_id?:number,name?:string}>} agents  候选专家
 * @param {Array} records  agent_experience 记录（可为全量；按 taskType 过滤）
 * @param {string} taskType 任务类型（空=不限，跨类型取最高可靠度记录）
 * @returns {Array} 排序后的专家数组（含 runs/reliability/successRate/confidence/experienced）
 */
function rankAgents(agents, records, taskType) {
  const recMap = new Map(); // agent_id -> 最优记录
  for (const r of (records || [])) {
    if (taskType && r.task_type !== taskType) continue;
    const id = Number(r.agent_id);
    const prev = recMap.get(id);
    if (!prev || reliability(r.success, r.runs) > reliability(prev.success, prev.runs)) recMap.set(id, r);
  }
  const list = (agents || []).map(a => {
    const id = Number(a.id != null ? a.id : a.agent_id);
    const rec = recMap.get(id);
    const norm = rec ? normalizeRecord(rec) : null;
    return {
      agent_id: id,
      name: a.name || '',
      runs: norm ? norm.runs : 0,
      reliability: norm ? norm.reliability : Math.round(PRIOR_RATE * 100),
      successRate: norm ? norm.successRate : null,
      confidence: norm ? norm.confidence : false,
      experienced: !!norm,
      task_type: taskType || (norm ? norm.task_type : DEFAULT_TYPE.key),
      type_label: typeLabel(taskType || (norm ? norm.task_type : DEFAULT_TYPE.key)),
    };
  });
  list.sort((a, b) => (b.reliability - a.reliability) || (Number(b.confidence) - Number(a.confidence)) || (b.runs - a.runs));
  return list;
}

/**
 * 自进化验收指标：按任务类型对比「首跑成功率」与「复跑成功率」。
 * 复跑 = 同一（专家 × 类型）的第 2 次及以后运行——经验积累后应更高。
 * @param {Array} records agent_experience 记录
 * @param {{target?:number}} opts target 提升目标（百分点，默认 15）
 * @returns {{firstRate, repeatRate, delta, meetsTarget, target, firstRuns, repeatRuns, byType}}
 */
function evolutionStats(records, { target = TARGET_LIFT } = {}) {
  let fRuns = 0, fSucc = 0, rRuns = 0, rSucc = 0;
  const byTypeMap = new Map();
  for (const r of (records || [])) {
    const fr = Number(r.first_runs) || 0, fs = Number(r.first_success) || 0;
    const rr = Number(r.repeat_runs) || 0, rs = Number(r.repeat_success) || 0;
    fRuns += fr; fSucc += fs; rRuns += rr; rSucc += rs;
    if (fr + rr > 0) {
      const tt = r.task_type || DEFAULT_TYPE.key;
      const acc = byTypeMap.get(tt) || { fr: 0, fs: 0, rr: 0, rs: 0 };
      acc.fr += fr; acc.fs += fs; acc.rr += rr; acc.rs += rs;
      byTypeMap.set(tt, acc);
    }
  }
  const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
  const firstRate = fRuns ? fSucc / fRuns : null;
  const repeatRate = rRuns ? rSucc / rRuns : null;
  const delta = (firstRate != null && repeatRate != null) ? (repeatRate - firstRate) * 100 : null;
  const byType = [...byTypeMap.entries()].map(([tt, a]) => {
    const fRate = a.fr ? a.fs / a.fr : null;
    const rRate = a.rr ? a.rs / a.rr : null;
    return {
      task_type: tt,
      type_label: typeLabel(tt),
      firstRate: pct(fRate),
      repeatRate: pct(rRate),
      delta: (fRate != null && rRate != null) ? Math.round((rRate - fRate) * 1000) / 10 : null,
      firstRuns: a.fr, repeatRuns: a.rr,
    };
  }).sort((a, b) => (b.delta || 0) - (a.delta || 0));
  return {
    firstRate: pct(firstRate),
    repeatRate: pct(repeatRate),
    delta: delta == null ? null : Math.round(delta * 10) / 10,
    meetsTarget: delta != null && delta >= target,
    target,
    firstRuns: fRuns, repeatRuns: rRuns,
    byType,
  };
}

/**
 * 构造给编排器的「经验参考」提示文本：列出各专家的历史可靠度（按类型），引导提示词优先高分专家。
 * @returns {string} 无任何经验时返回空串（不干扰原有提示词）
 */
function experienceHint(ranked) {
  const withExp = (ranked || []).filter(x => x.experienced && x.runs > 0);
  if (!withExp.length) return '';
  const lines = withExp.map(x => `- agent_id=${x.agent_id}${x.name ? `（${x.name}）` : ''}：可靠度 ${x.reliability}${x.successRate != null ? `，历史成功率 ${x.successRate}%` : ''}（${x.runs} 次${x.confidence ? '' : '，样本偏少仅供参考'}）`);
  return [
    '【历史经验参考】以下子智能体在该类任务上的历史可靠度（高者优先选用；样本偏少者仅供参考，勿因单次记录就否定）：',
    ...lines,
  ].join('\n');
}

/** 汇总全体专家的经验概览（供后台指标卡） */
function overview(records) {
  const rows = (records || []).map(normalizeRecord);
  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalSuccess = rows.reduce((s, r) => s + r.success, 0);
  const agents = new Set(rows.map(r => r.agent_id));
  const types = new Set(rows.map(r => r.task_type));
  return {
    pairs: rows.length,
    agents: agents.size,
    taskTypes: types.size,
    totalRuns,
    totalSuccess,
    successRate: totalRuns ? Math.round((totalSuccess / totalRuns) * 1000) / 10 : null,
  };
}

module.exports = {
  PRIOR_RUNS, PRIOR_RATE, MIN_SAMPLES, TARGET_LIFT,
  TASK_TYPES, DEFAULT_TYPE,
  classifyTask, typeLabel, allTypes,
  reliability, normalizeRecord, applyRun,
  rankAgents, evolutionStats, experienceHint, overview,
};
