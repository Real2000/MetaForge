/**
 * D3-1 3D 与数字人 V1（2026-11-21）——数字人合规评估内核（纯逻辑零依赖）
 *
 * 「评估先行」：把数字人 / 真人合成素材的合规风险结构化为问卷 → 评分 → 结论闸门（decision），
 * 供创作资产登记、对外发布前做前置合规判断。数字人生成本身不在 V1 范围（待评估通过后单独排期）。
 *
 * 依据：《生成式人工智能服务管理暂行办法》合成内容标识要求、肖像权/声音权授权要求。
 */

/** 评估项定义（true/false 型）——weight 为「已具备保障」时的得分权重 */
const ASSESS_ITEMS = [
  { key: 'authorized', label: '已取得本人书面授权（肖像/声音）', weight: 30, risk_if_false: 'high', reason_false: '未取得本人书面授权，禁止用于任何对外用途' },
  { key: 'real_person', label: '素材基于真实自然人形象', weight: 0, risk_if_true: 'medium', reason_true: '涉及真实自然人形象，需核验肖像权授权与用途' },
  { key: 'public_figure', label: '涉及公众人物 / 未成年人', weight: 15, risk_if_true: 'high', reason_true: '涉及公众人物或未成年人，属高风险，须专项审批' },
  { key: 'misleading', label: '存在误导性使用风险（易被误认为真人实时）', weight: 20, risk_if_true: 'high', reason_true: '存在误导性使用风险，须人工复核并加强标识' },
  { key: 'disclosed', label: '已按生成式 AI 规定标注合成标识', weight: 20, risk_if_false: 'medium', reason_false: '未标注 AI 合成标识，对外发布前必须补充标识' },
  { key: 'voice_clone', label: '含声音克隆', weight: 15, risk_if_true: '', reason_true: '含声音克隆，须取得声音权授权并标注' },
  { key: 'commercial', label: '用于商业投放 / 公开传播', weight: 0, risk_if_true: 'medium', reason_true: '用于商业或公开传播，须确保授权与标识齐备' },
];

const DECISION_LABEL = {
  approve: '通过（合规要求已满足）',
  review: '需人工复核',
  reject: '拒绝（存在高风险项）',
};

/** bool 归一化 */
function toBool(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 'on'; }

/**
 * 合规评估：问卷 → 评分（0-100，越高越合规）+ 风险级别 + 结论
 * @param {object} answers
 * @returns {{score:number, level:string, decision:string, decisionLabel:string, reasons:Array, requiredActions:string[], flags:object}}
 */
function assess(answers = {}) {
  const a = {};
  for (const it of ASSESS_ITEMS) a[it.key] = toBool(answers[it.key]);

  const reasons = [];
  let score = 0;
  for (const it of ASSESS_ITEMS) {
    const on = a[it.key];
    // 得分：具备「保障性」条件时加分
    if (it.key === 'authorized') { if (on) score += it.weight; }
    else if (it.key === 'public_figure' || it.key === 'misleading') { if (!on) score += it.weight; } // 不涉及才加分
    else if (it.key === 'disclosed') { if (on) score += it.weight; }
    else if (it.key === 'voice_clone') { if (!on || a.authorized) score += it.weight; } // 无克隆或已授权
    // real_person / commercial 不直接计分，作为风险/观感项
    // 风险原因
    if (on && it.risk_if_true) reasons.push({ key: it.key, level: it.risk_if_true, msg: it.reason_true });
    if (!on && it.risk_if_false) reasons.push({ key: it.key, level: it.risk_if_false, msg: it.reason_false });
  }
  score = Math.max(0, Math.min(100, score));

  const high = reasons.filter((r) => r.level === 'high');
  const medium = reasons.filter((r) => r.level === 'medium');
  let decision = 'approve', level = 'low';
  if (high.length) { decision = 'reject'; level = 'high'; }
  else if (medium.length) { decision = 'review'; level = 'medium'; }

  // 补：即使无高风险，涉及真人且未标注也是 review
  if (decision === 'approve' && a.real_person && !a.disclosed) { decision = 'review'; level = 'medium'; reasons.push({ key: 'disclosed', level: 'medium', msg: '涉及真人形象但未标注合成标识' }); }

  const requiredActions = [];
  for (const r of reasons) {
    if (r.key === 'authorized') requiredActions.push('取得本人书面授权（肖像/声音）并留存凭证');
    if (r.key === 'disclosed') requiredActions.push('在成品中标注「AI 生成」合成标识');
    if (r.key === 'public_figure') requiredActions.push('提交公众人物/未成年人专项审批');
    if (r.key === 'misleading') requiredActions.push('消除误导性场景（避免让人误认为真人实时）');
    if (r.key === 'voice_clone') requiredActions.push('取得声音权授权并加注声音合成标识');
    if (r.key === 'commercial') requiredActions.push('商业投放前核验授权与标识齐备');
  }

  return { score, level, decision, decisionLabel: DECISION_LABEL[decision] || decision, reasons, requiredActions: [...new Set(requiredActions)], flags: a };
}

/** 是否需要人工复核（非「通过」即需人工介入） */
function requiresManualReview(res) {
  return !res || res.decision !== 'approve';
}

module.exports = { ASSESS_ITEMS, DECISION_LABEL, assess, requiresManualReview, toBool };
