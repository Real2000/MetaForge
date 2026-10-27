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

module.exports = { parseCron, lastFire };
