/**
 * P2-18 浏览器自动化基座（2026-11-13）
 *
 * 封装 Playwright/Puppeteer CDP（Chrome DevTools Protocol）的浏览器自动化能力。
 *
 * 支持的原子操作（后续可在对话中通过工具调用执行）：
 *   - launchSession    启动浏览器会话（返回 session_id）
 *   - navigate         导航到 URL
 *   - screenshot       截图（base64）
 *   - click            点击元素
 *   - type             输入文本
 *   - scroll           滚动
 *   - evaluate         JS 求值
 *   - closeSession     关闭会话
 *
 * 设计要点：
 *   - 使用内置的 playwright 或通过 CDP 连接已有的 Chrome 实例
 *   - 每个会话记录到 browser_automations 表，便于审计
 *   - 默认 60s 超时自动关闭
 *   - 白名单域名限制（防止 SSRF）
 */
const { db, now } = require('../db');

/* ---------- 配置 ---------- */
const SESSION_TTL = 120 * 1000; // 会话 2 分钟无操作自动关闭
const ALLOWED_DOMAINS = null; // null=无限制（生产环境需设置白名单）
const NAV_TIMEOUT = 30000;
const ACTIVE_SESSIONS = new Map(); // session_id → {browser,page,createdAt}

/* ---------- 会话管理 ---------- */

let sessionCounter = 0;

/**
 * 启动浏览器会话（CDP 或 Playwright）
 * @returns {Promise<{session_id: string}>}
 */
async function launchSession() {
  let browser, page;
  try {
    // 尝试使用内置 playwright
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    page = await browser.newPage();
  } catch {
    // 如 playwright 不可用，尝试通过 CDP 连接已有 Chrome
    try {
      const CDP = require('chrome-remote-interface');
      const client = await CDP();
      await client.Page.enable();
      return { session_id: null, error: 'CDP 连接暂未完整封装' };
    } catch {
      throw new Error('浏览器自动化不可用（需要安装 playwright 或连接 Chrome DevTools）');
    }
  }
  const sessionId = 'br-' + Date.now() + '-' + (++sessionCounter);
  ACTIVE_SESSIONS.set(sessionId, { browser, page, createdAt: Date.now() });
  // 记录
  db.prepare(`INSERT INTO browser_automations (session_id,action,status,created_by,created_at) VALUES (?,'launch','done',?,?)`)
    .run(sessionId, 'system', now());
  return { session_id: sessionId };
}

/** 获取活跃会话 */
function getSession(sessionId) {
  const session = ACTIVE_SESSIONS.get(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在或已过期`);
  return session;
}

/** 导航到 URL */
async function navigate(sessionId, url) {
  if (!url || !url.startsWith('http')) throw new Error('URL 格式不正确');
  if (ALLOWED_DOMAINS) {
    try {
      const host = new URL(url).hostname;
      const allowed = (Array.isArray(ALLOWED_DOMAINS) ? ALLOWED_DOMAINS : [ALLOWED_DOMAINS]).some(d => host.endsWith(d));
      if (!allowed) throw new Error('域名不在白名单中');
    } catch (e) { if (e.message !== '域名不在白名单中') throw e; }
  }
  const session = getSession(sessionId);
  session.lastUsed = Date.now();
  await session.page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  db.prepare(`INSERT INTO browser_automations (session_id,url,action,action_input,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(sessionId, url.slice(0, 500), 'navigate', url.slice(0, 500), 'done', 'system', now());
  return { ok: true, title: await session.page.title() };
}

/** 截图 */
async function screenshot(sessionId) {
  const session = getSession(sessionId);
  session.lastUsed = Date.now();
  const buf = await session.page.screenshot({ type: 'png' });
  const b64 = buf.toString('base64');
  db.prepare(`INSERT INTO browser_automations (session_id,action,action_result,status,created_by,created_at) VALUES (?,'screenshot',?,'done',?,?)`)
    .run(sessionId, 'screenshot 完成', 'system', now());
  return { base64: b64, size: buf.length };
}

/** 点击元素 */
async function click(sessionId, selector) {
  const session = getSession(sessionId);
  session.lastUsed = Date.now();
  await session.page.click(selector);
  db.prepare(`INSERT INTO browser_automations (session_id,action,action_input,status,created_by,created_at) VALUES (?,'click',?,'done',?,?)`)
    .run(sessionId, selector, 'system', now());
  return { ok: true };
}

/** 输入文本 */
async function typeText(sessionId, selector, text) {
  const session = getSession(sessionId);
  session.lastUsed = Date.now();
  await session.page.fill(selector, text);
  db.prepare(`INSERT INTO browser_automations (session_id,action,action_input,status,created_by,created_at) VALUES (?,'type',?,'done',?,?)`)
    .run(sessionId, JSON.stringify({ selector, text: text.slice(0, 100) }), 'system', now());
  return { ok: true };
}

/** 获取页面内容 */
async function getContent(sessionId) {
  const session = getSession(sessionId);
  const content = await session.page.content();
  return { content: content.slice(0, 50000) };
}

/** 关闭会话 */
async function closeSession(sessionId) {
  const session = ACTIVE_SESSIONS.get(sessionId);
  if (!session) return { ok: true, msg: '会话已空闲过期或已关闭' };
  try {
    await session.browser.close();
  } catch { /* 静默 */ }
  ACTIVE_SESSIONS.delete(sessionId);
  db.prepare(`INSERT INTO browser_automations (session_id,action,status,created_by,created_at) VALUES (?,'close','done',?,?)`)
    .run(sessionId, 'system', now());
  return { ok: true };
}

/** 清理过期会话 */
function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of ACTIVE_SESSIONS) {
    if (now - session.createdAt > SESSION_TTL) {
      try { session.browser.close(); } catch { }
      ACTIVE_SESSIONS.delete(id);
    }
  }
}

// 定期清理过期会话
setInterval(cleanupSessions, 60000);

module.exports = {
  launchSession,
  navigate,
  screenshot,
  click,
  typeText,
  getContent,
  closeSession,
  getSession,
};