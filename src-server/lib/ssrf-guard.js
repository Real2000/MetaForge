/**
 * SSRF 统一防护（SEC-05 2026-11-22 安全止血）
 *
 * 背景：此前仅 tools-extra.js 的 web_fetch 具备 SSRF 防护，SECURITY.md 却声称「网络出口具备 SSRF 防护」——
 * 声明与实现不一致。usermodels / providers / sso / mcp / retriever 等由用户/管理员自填 URL 的服务端请求
 * 全部未保护，可被用于探测云元数据（169.254.169.254）、内网服务（127.0.0.1 / 10.x / 192.168.x）等。
 *
 * 本模块收敛为一处实现，各业务点统一接入：
 *   ① 仅允许 http(s)；
 *   ② 字面量 IP 或 DNS 解析后逐个 IP 过私网/环回/链路本地/云元数据黑名单；
 *   ③ 手动逐跳重定向（每跳重新校验，上限 3 跳）。
 * 内网知识源/内网网关场景由管理员设 AGENT_FETCH_ALLOW_PRIVATE=1 显式放行（默认关闭）。
 */
const dns = require('dns');

function allowPrivate() {
  return process.env.AGENT_FETCH_ALLOW_PRIVATE === '1';
}

/** 是否私网/环回/链路本地/保留/组播地址（无法解析也视为不安全） */
function ipIsPrivate(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return true;
  const [a, b] = parts;
  return a === 127 || a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || a >= 224; // 224+ 组播/保留段
}

/** 校验 URL 为可访问的公网 http(s) 地址，否则抛错。rawUrl 为空视为「未配置」直接放行（由调用方决定是否必填）。 */
async function assertPublicHttpUrl(rawUrl) {
  if (rawUrl == null || String(rawUrl).trim() === '') return; // 未配置 → 交由调用方必填校验，不在此拦截
  const s = String(rawUrl).trim();
  if (!/^https?:\/\//i.test(s)) throw new Error('仅支持 http(s) 完整链接');
  if (allowPrivate()) return; // 管理员显式放行（内网知识源/网关场景）
  let u;
  try { u = new URL(s); } catch { throw new Error('链接格式非法'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? [host]
    : (await dns.promises.lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (!ips.length) throw new Error(`域名解析失败：${host}`);
  for (const ip of ips) {
    if (ipIsPrivate(ip)) throw new Error(`安全策略拒绝访问内网/本机地址（${host} → ${ip}）。如需访问内网地址，请管理员设置环境变量 AGENT_FETCH_ALLOW_PRIVATE=1 后重启服务`);
  }
}

/** 手动逐跳重定向（每跳重新过私网校验；上限 3 跳）——用于确实需要跟随重定向的抓取场景 */
async function fetchWithRedirectGuard(url, opts = {}, maxHops = 3) {
  let cur = url;
  for (let i = 0; i <= maxHops; i++) {
    await assertPublicHttpUrl(cur);
    const res = await fetch(cur, { ...opts, redirect: 'manual', signal: opts.signal || AbortSignal.timeout(15000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      cur = new URL(loc, cur).toString();
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多（>3）');
}

module.exports = { ipIsPrivate, assertPublicHttpUrl, fetchWithRedirectGuard, allowPrivate };
