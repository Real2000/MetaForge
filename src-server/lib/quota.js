/**
 * 用户级 Token 配额（2026-10-20 P2）
 * 规则：users.quota_total = 0 → 不限制；> 0 → 累计已用 quota_used 达到 quota_total 后拦截新对话。
 * 记账口径：对话（本地/Dify/Coze）按 messages.tokens；分享页与 openapi 消耗归到智能体发布者（admin）。
 * 拦截时机：对话开始前（模型调用之前），返回友好提示；不拦截登录/浏览等非消耗操作。
 */
const { db, now } = require('../db');

/** 查询用户配额状态。返回 { unlimited, total, used, remaining, percent } */
function quotaOf(username) {
  const u = db.prepare('SELECT quota_total, quota_used FROM users WHERE username=?').get(username);
  if (!u) return { unlimited: true, total: 0, used: 0, remaining: Infinity, percent: 0 };
  if (!u.quota_total || u.quota_total <= 0) return { unlimited: true, total: 0, used: u.quota_used, remaining: Infinity, percent: 0 };
  return {
    unlimited: false,
    total: u.quota_total,
    used: u.quota_used,
    remaining: Math.max(0, u.quota_total - u.quota_used),
    percent: Math.min(100, Math.round(u.quota_used / u.quota_total * 100)),
  };
}

/** 对话前检查。放行返回 null；超限返回友好提示文案（调用方 send blocked/error） */
function checkQuota(username) {
  const q = quotaOf(username);
  if (q.unlimited || q.used < q.total) return null;
  return `本月 Token 配额已用完（已用 ${q.used.toLocaleString('zh-CN')} / ${q.total.toLocaleString('zh-CN')}）。\n如需继续使用，请联系管理员调整配额。`;
}

/** 记账（对话完成后调用，允许负值修正）。增量式，幂等性由调用方保证（一次对话一次记账） */
function addUsage(username, tokens) {
  if (!username || !tokens || tokens <= 0) return;
  try {
    db.prepare('UPDATE users SET quota_used = quota_used + ? WHERE username=?').run(Math.ceil(tokens), username);
    quotaAlert(username);
  } catch (e) {
    console.error('[quota] 记账失败：', e.message);
  }
}

/** 用量预警（2026-10-20）：跨过 80%/90% 阈值时发站内信（每档一次性——users.quota_alert_level
 *  记录已提醒档位，升档才发，避免每次记账都轰炸；管理员调整配额后经 resetQuotaAlert 重置重新计） */
function quotaAlert(username) {
  try {
    const u = db.prepare('SELECT quota_total, quota_used, quota_alert_level FROM users WHERE username=?').get(username);
    if (!u || !u.quota_total || u.quota_total <= 0) return; // 不限额用户不预警
    const pct = u.quota_used / u.quota_total;
    const level = pct >= 0.9 ? 2 : (pct >= 0.8 ? 1 : 0);
    if (level > (u.quota_alert_level || 0)) {
      const pctTxt = Math.round(pct * 100);
      const content = level === 2
        ? `本月用量已达 ${pctTxt}%（${u.quota_used.toLocaleString('zh-CN')} / ${u.quota_total.toLocaleString('zh-CN')}），配额即将耗尽——超出后将无法继续对话。如需继续使用，请联系管理员调整配额。`
        : `本月用量已达 ${pctTxt}%（${u.quota_used.toLocaleString('zh-CN')} / ${u.quota_total.toLocaleString('zh-CN')}）。如近期使用较多，可提前联系管理员调整配额，避免用尽影响工作。`;
      db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
        .run(username, '📊 Token 配额预警', content, 'quota', '#/help', now());
      db.prepare('UPDATE users SET quota_alert_level=? WHERE username=?').run(level, username);
      console.log(`[quota] ⚠️ ${username} 用量达 ${pctTxt}%，已发送第 ${level} 档站内信预警`);
    }
  } catch (e) {
    console.error('[quota] 预警通知失败：', e.message);
  }
}

/** 重置预警档位（管理员调整配额后调用，新配额周期重新预警） */
function resetQuotaAlert(username) {
  try {
    db.prepare('UPDATE users SET quota_alert_level=0 WHERE username=?').run(username);
  } catch { }
}

module.exports = { quotaOf, checkQuota, addUsage, resetQuotaAlert };
