/** 套餐定义（2026-10-20 商业化）：静态配置——价格页展示 / 升级引导 / 权益校验共用
 *  plan 字段存 users 表；quota_total 仍是配额实际控制位（管理员可单独调整，与套餐档解耦）。
 *  agents_limit / kbs_limit 为软约束：超额时友好提示升级，不做硬拦截（避免影响存量使用）。
 */
const PLANS = {
  free: {
    key: 'free', name: '免费版', price: 0, priceLabel: '¥0', period: '永久免费',
    tagline: '个人体验与小型团队试用',
    quota: 500000, agents: 3, kbs: 2,
    features: ['每月 50 万 Tokens', '最多 3 个智能体', '2 个知识库', '基础模型接入', '社区支持'],
    notIncluded: ['专属算力通道', 'SLA 保障'],
  },
  pro: {
    key: 'pro', name: '专业版', price: 199, priceLabel: '¥199', period: '每月',
    tagline: '重度使用者与小团队的生产力档',
    quota: 5000000, agents: 20, kbs: 10,
    features: ['每月 500 万 Tokens', '最多 20 个智能体', '10 个知识库', '全量模型接入 + 自有模型源', 'API 开放接口', '工单支持（8×5）'],
    notIncluded: ['私有化部署'],
    highlight: true,
  },
  enterprise: {
    key: 'enterprise', name: '企业版', price: null, priceLabel: '定制报价', period: '按年',
    tagline: '大型企业的专属方案',
    quota: 0, agents: 0, kbs: 0, // 0 = 不限
    features: ['Token 额度定制', '智能体数量不限', '知识库数量不限', '私有化部署可选', '专属客户成功经理', 'SLA 99.9% 保障'],
    notIncluded: [],
    contactSales: true,
  },
};

function planOf(key) {
  return PLANS[key] || PLANS.free;
}

/** 当前套餐下的权益使用情况（升级引导数据源）：配额占比 / 智能体数 / 知识库数
 *  管理员豁免（2026-10-20 方案A）：role=admin 不受商业化软约束——不限智能体/知识库数，不触发升级引导 */
function planUsage(username) {
  const { db } = require('../db');
  const u = db.prepare('SELECT role, plan, quota_total, quota_used FROM users WHERE username=?').get(username);
  if (!u) return null;
  const plan = planOf(u.plan);
  const agentsCount = db.prepare("SELECT COUNT(*) c FROM agents WHERE owner=? AND source='self'").get(username).c;
  const kbsCount = db.prepare('SELECT COUNT(*) c FROM kbs WHERE owner=?').get(username).c;
  const qTotal = u.quota_total || 0;
  const exempt = u.role === 'admin';
  return {
    plan: plan.key,
    planName: plan.name,
    exempt,
    unlimitedQuota: !qTotal,
    quotaUsed: u.quota_used || 0,
    quotaTotal: qTotal,
    quotaPercent: qTotal ? Math.min(100, Math.round(u.quota_used / qTotal * 100)) : 0,
    agents: agentsCount,
    agentsLimit: plan.agents,
    kbs: kbsCount,
    kbsLimit: plan.kbs,
    // 升级引导触发条件（任一接近或超限）；管理员豁免不生成
    suggestions: exempt ? [] : buildUpgradeReasons(plan, { quotaPercent: qTotal ? Math.min(100, Math.round(u.quota_used / qTotal * 100)) : 0, agents: agentsCount, kbs: kbsCount }),
  };
}

function buildUpgradeReasons(plan, u) {
  const out = [];
  if (plan.key === 'free') {
    if (u.quotaPercent >= 60) out.push(`本月 Token 已用 ${u.quotaPercent}%，专业版额度放大 10 倍（500 万/月）`);
    if (u.agents >= plan.agents) out.push(`已创建 ${u.agents} 个智能体（免费版上限 ${plan.agents} 个），专业版可创建 20 个`);
    if (u.kbs >= plan.kbs) out.push(`知识库已达免费版上限（${plan.kbs} 个），专业版支持 10 个`);
  }
  return out;
}

module.exports = { PLANS, planOf, planUsage };
