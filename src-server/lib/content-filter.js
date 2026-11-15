/**
 * U0-7 内容安全审核管线（2026-11-13）
 *
 * 统一的内容审核入口，挂载三个通道：
 *   1. 对话回复出站前（chat.js — 组装 answer 后）
 *   2. 知识库入库前（知识库上传 → kb_chunks 写入时）
 *   3. 渠道出站前（channel.send — 发送到 IM 前）
 *
 * 审核策略链（按序、即可跳过）：
 *   a. 本地敏感词库（words 表，已配置的词按 input_block/output_block 双向分类）
 *   b. PII 检测（身份证/手机号/银行卡/邮箱/护照）
 *   c. 提示词注入检测
 *   d. 云审核 API 位（预留，对接阿里云/百度内容安全等接口）
 *
 * 所有命中记录到 security_events 表（已有），并提供审核统计。
 */
const { db } = require('../db');
const security = require('./security');

/* ---------- 审核结果类型 ---------- */

/**
 * @typedef {Object} ReviewResult
 * @property {boolean}  blocked       - 是否拦截
 * @property {string}   [reason]     - 拦截原因摘要
 * @property {Array}    [hits]       - 命中详情
 * @property {string}   [cleaned]    - 通过后的清洗文本（如脱敏后）
 * @property {number}   riskScore    - 风险评分 0~10（供后续决策参考）
 * @property {boolean}  [needsHuman] - 是否需人工复审（高风险但非明确违规）
 */

/**
 * 执行全链路审核（本地敏感词 → PII → 注入检测 → 云 API 预留位）
 * @param {string} text         - 待审核文本
 * @param {string} stage        - 审核阶段：'output'（对话出站）| 'input'（用户输入）| 'kb_import'（知识库入库）
 * @param {object} [opts]
 * @param {boolean} [opts.autoMask] - 是否自动脱敏（PII 自动打码，默认 false）
 * @returns {ReviewResult}
 */
function review(text, stage, opts = {}) {
  const result = { blocked: false, hits: [], riskScore: 0, needsHuman: false };
  if (!text || !text.trim()) return result;
  const t = String(text);

  /* 1. 敏感词库检查 */
  const dir = stage === 'input' ? 'input' : 'output';
  const { blocked, words } = security.check(t, dir);
  if (blocked) {
    result.blocked = true;
    result.reason = `包含违规词汇：${words.map(w => w.word).join('、')}`;
    result.hits.push(...words.map(w => ({ type: 'sensitive_word', word: w.word, category: w.category })));
    result.riskScore = 10;
    security.countHits(words);
    security.logSecurityEvent(`${stage}_blocked`, result.reason, '拦截', stage === 'kb_import' ? 'knowledge_base' : 'chat');
    return result;
  }

  /* 2. PII 检测 */
  const pii = security.detectPII(t);
  if (pii.length > 0) {
    // PII 分场景处理：出站自动脱敏；知识库提示处理
    if (opts.autoMask || stage === 'output') {
      result.cleaned = security.maskPII(t);
      result.hits.push(...pii.map(p => ({ type: 'pii', value: p.value, piiType: p.type })));
      result.riskScore = Math.max(result.riskScore, Math.min(7, pii.length));
      security.logSecurityEvent(`pii_${stage}`, `检测到${pii.map(p => p.type).join('、')}`, opts.autoMask ? '脱敏' : '记录', stage === 'kb_import' ? 'knowledge_base' : 'chat');
    } else if (stage === 'kb_import') {
      // 知识库入库含 PII → 阻断并提示
      result.blocked = true;
      result.reason = `知识库内容包含个人敏感信息（${pii.map(p => p.type).join('、')}），请脱敏后重新上传`;
      result.hits.push(...pii.map(p => ({ type: 'pii', value: p.value, piiType: p.type })));
      result.riskScore = 8;
      security.logSecurityEvent(`pii_kb_blocked`, result.reason, '拦截', 'knowledge_base');
      return result;
    }
  }

  /* 3. 提示词注入检测（仅 input 阶段） */
  if (stage === 'input') {
    const inj = security.detectInjection(t);
    if (inj.risk >= 3 && inj.hits.length > 0) {
      result.blocked = true;
      result.reason = `疑似提示词注入攻击：${inj.hits.map(h => h.msg).join('、')}`;
      result.hits.push(...inj.hits.map(h => ({ type: 'injection', msg: h.msg, weight: h.weight })));
      result.riskScore = Math.max(result.riskScore, inj.risk);
      security.logSecurityEvent('injection_blocked', result.reason, '拦截', 'chat');
      return result;
    }
    result.riskScore = Math.max(result.riskScore, Math.min(3, inj.risk));
  }

  /* 4. 云审核 API 预留位（后续对接阿里云/百度内容安全） */
  // if (process.env.CLOUD_CENSOR_ENABLED === '1') { ... }

  return result;
}

/**
 * 快速通道：仅检查是否完全通过（无阻断+无高风险）
 */
function isClean(text, stage) {
  const r = review(text, stage);
  return !r.blocked && r.riskScore < 5;
}

module.exports = { review, isClean };