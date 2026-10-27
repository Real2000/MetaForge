/**
 * 简化 Cron：五段（分 时 日 月 周），支持 * , - /
 */
function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const [, range, stepStr] = m;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (step <= 0) return null;
    let start, end;
    if (range === '*') { start = min; end = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (a < min || b > max || a > b) return null;
      start = a; end = b;
    } else {
      const v = Number(range);
      if (v < min || v > max) return null;
      start = v; end = v;
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values;
}

/** 校验 cron 表达式，合法返回 {minute,hour,dom,month,dow} */
function parseCron(expr) {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow };
}

/** 上次应触发时间 <= now 且晚于 since 的时刻（分钟粒度） */
function lastFire(expr, since, nowTs = Date.now()) {
  const c = parseCron(expr);
  if (!c) return null;
  const start = Math.floor(since / 60000) * 60000 + 60000;
  const end = Math.floor(nowTs / 60000) * 60000;
  for (let t = end; t >= start; t -= 60000) {
    const d = new Date(t);
    if (!c.minute.has(d.getMinutes())) continue;
    if (!c.hour.has(d.getHours())) continue;
    if (!c.dom.has(d.getDate())) continue;
    if (!c.month.has(d.getMonth() + 1)) continue;
    if (!c.dow.has(d.getDay())) continue;
    return t;
  }
  return null;
}

/** 下次触发时间 > fromTs 的时刻（分钟粒度；P5.31 create_task 确认卡展示用）。
 *  向前扫描至多 horizonDays 天；不合法表达式或窗口内无匹配返回 null（如 2 月 31 日） */
function nextFire(expr, fromTs = Date.now(), horizonDays = 370) {
  const c = parseCron(expr);
  if (!c) return null;
  const start = Math.floor(fromTs / 60000) * 60000 + 60000;
  const end = start + horizonDays * 86400000;
  for (let t = start; t <= end; t += 60000) {
    const d = new Date(t);
    if (!c.minute.has(d.getMinutes())) continue;
    if (!c.hour.has(d.getHours())) continue;
    if (!c.dom.has(d.getDate())) continue;
    if (!c.month.has(d.getMonth() + 1)) continue;
    if (!c.dow.has(d.getDay())) continue;
    return t;
  }
  return null;
}

/** cron 中文语义化描述（与前台任务页 cronDesc 同源逻辑；P5.31 服务端复用）
 *  覆盖常见形态：每 N 分钟 / 每天 hh:mm / 每周X hh:mm / 每月 D 号 hh:mm / 每年；其余原样返回 */
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function describeCron(expr) {
  if (!expr) return '';
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const [m, h, d, mon, w] = parts;
  const hm = `${String(h === '*' ? 0 : h).padStart(2, '0')}:${String(m === '*' ? 0 : m).padStart(2, '0')}`;
  if (m.startsWith('*/')) return `每 ${m.slice(2)} 分钟执行一次`;
  if (h.startsWith('*/')) return `每 ${h.slice(2)} 小时的 ${String(m).padStart(2, '0')} 分执行`;
  if (d === '*' && mon === '*' && w === '*') return `每天 ${hm} 执行`;
  if (d === '*' && mon !== '*' && w === '*') return `每年 ${mon} 月每天 ${hm} 执行`;
  if (d === '*' && mon === '*' && w !== '*') {
    // 周字段支持列表与范围（1-5 / 1,3,5）：经 parseField 展开后逐个命名
    const wf = parseField(w, 0, 7);
    if (wf) {
      const days = [...wf].filter(x => x <= 7).sort((a, b) => a - b).map(x => WEEK_CN[x % 7]);
      if (days.length && days.length < 7) return `每${days.join('、')} ${hm} 执行`;
    }
    return `每周（${expr}）${hm} 执行`;
  }
  if (d !== '*' && mon === '*' && w === '*') return `每月 ${d} 号 ${hm} 执行`;
  if (d !== '*' && mon !== '*') return `每年 ${mon} 月 ${d} 号 ${hm} 执行`;
  return String(expr);
}

module.exports = { parseCron, lastFire, nextFire, describeCron };
