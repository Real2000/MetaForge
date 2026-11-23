/**
 * 敏感词检测：输入/输出双向拦截 + 计数
 */
const { db } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

/** 检查文本，返回 {blocked, words:[{id,word,category}]} 仅统计 input_block/output_block 开启的词 */
function check(text, dir /* 'input' | 'output' */) {
  const col = dir === 'input' ? 'input_block' : 'output_block';
  const words = dal.q(`SELECT w.id, w.word, c.name AS category FROM words w LEFT JOIN word_categories c ON c.id=w.category_id WHERE w.${col}=1`);
  const hits = words.filter(w => text.includes(w.word));
  return { blocked: hits.length > 0, words: hits };
}

/** 命中计数 +1 */
function countHits(hits) {
  hits.forEach(h => dal.runq('UPDATE words SET hit_count = hit_count + 1 WHERE id=?', [h.id]));
}

/** 输出过滤：命中词替换为 *** */
function mask(text) {
  const { blocked, words } = check(text, 'output');
  if (!blocked) return text;
  let t = text;
  words.forEach(w => { t = t.split(w.word).join('*'.repeat(Math.max(2, w.word.length))); });
  return t;
}

// ---------------- PII 识别与脱敏（2026-10-09 P2） ----------------

/** PII 模式（身份证/手机号/银行卡/邮箱/护照） */
const PII_RULES = [
  { type: '身份证', re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx]\b/g },
  { type: '手机号', re: /\b1[3-9]\d{9}\b/g },
  { type: '银行卡号', re: /\b(?:62)\d{14,17}\b/g },
  { type: '邮箱', re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g },
  { type: '护照号', re: /\b[EGeg]\d{8}\b/g },
];

/** 识别 PII，返回 [{type, value}] */
function detectPII(text) {
  const hits = [];
  for (const r of PII_RULES) {
    const ms = String(text || '').match(r.re) || [];
    ms.forEach(m => hits.push({ type: r.type, value: m }));
  }
  return hits;
}

/** PII 脱敏：保留首尾，中间打码 */
function maskPII(text) {
  let t = String(text || '');
  for (const r of PII_RULES) {
    t = t.replace(r.re, m => {
      if (m.length <= 4) return '*'.repeat(m.length);
      if (r.type === '邮箱') {
        const at = m.indexOf('@');
        const head = m.slice(0, Math.min(2, at));
        return head + '***' + m.slice(at);
      }
      if (m.length <= 7) return m.slice(0, 1) + '*'.repeat(m.length - 2) + m.slice(-1);
      return m.slice(0, 3) + '*'.repeat(Math.min(8, m.length - 7)) + m.slice(-4);
    });
  }
  return t;
}

// ---------------- 提示词注入检测（2026-10-09 P2） ----------------

const INJECTION_PATTERNS = [
  { re: /忽略(以上|之前|上面|上述|前面)(的)?(所有)?(指令|提示|设定|规则|约束)/i, w: 3, msg: '要求忽略系统指令' },
  { re: /无视(以上|之前|上述|前面).{0,6}(指令|提示|设定|规则)/i, w: 3, msg: '要求无视系统设定' },
  { re: /(忘记|清空)(你|之前|以上|上述).{0,8}(身份|设定|指令|提示词)/i, w: 2, msg: '要求重置身份' },
  { re: /你(现在)?(是|扮演).{0,6}(DAN|越狱模式|开发者模式|无限制模式|任何限制)/i, w: 3, msg: '越狱模式诱导' },
  { re: /(进入|开启|激活).{0,6}(开发者|developer).{0,4}(模式|mode)/i, w: 3, msg: '开发者模式诱导' },
  { re: /(输出|打印|显示|泄露|透露).{0,10}(系统提示词|system prompt|初始指令|内部设定)/i, w: 3, msg: '套取系统提示词' },
  { re: /(reveal|show|print|repeat).{0,20}(system prompt|initial instructions)/i, w: 3, msg: '套取系统提示词(英文)' },
  { re: /(ignore|disregard).{0,20}(previous|above|prior|all).{0,15}(instructions|prompts|rules)/i, w: 3, msg: '忽略指令(英文)' },
  { re: /(你(的)?(系统|内部|真实).{0,6}(提示|指令|设定)|你的初始prompt)/i, w: 1, msg: '探测系统设定' },
  { re: /(jailbreak|越狱)/i, w: 2, msg: '越狱关键词' },
];

/** 检测提示词注入，返回 {risk: 0-10, hits: [{msg, pattern}]} */
function detectInjection(text) {
  const t = String(text || '');
  const hits = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(t)) hits.push({ msg: p.msg, weight: p.w });
  }
  const risk = Math.min(10, hits.reduce((s, h) => s + h.weight, 0));
  return { risk, hits };
}

/** 记录安全事件 */
function logSecurityEvent(type, detail, action, source) {
  try {
    dal.runq('INSERT INTO security_events (type,detail,action,source,created_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))', [type, String(detail || '').slice(0, 500), action || '', source || '']);
  } catch { }
}

module.exports = { check, countHits, mask, detectPII, maskPII, detectInjection, logSecurityEvent };
