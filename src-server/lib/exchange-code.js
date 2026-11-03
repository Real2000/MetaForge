/**
 * 一次性交换码（#14 2026-11-03）：短时效随机码换敏感载荷。
 * 背景：钉钉扫码回调原实现把 JWT 整串放进 302 URL（浏览器历史/Referer/代理日志泄露面）；
 * 改为回调仅带 60s 一次性交换码，前端 POST /api/auth/dingtalk/exchange 用码换 JWT（JSON body 交付）。
 *
 * - mint(data, ttlMs)：签发 64 hex 随机码绑定载荷（默认 60s TTL），返回码字符串
 * - consume(code)：一次性消费——命中即删（无论调用方后续校验成败，防重放）；过期/不存在返回 null
 * - 模块级 Map + 10s 周期清理过期条目（unref 不阻塞进程退出）
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 60 * 1000;
const entries = new Map(); // code → { payload, expire }

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of entries) if (v.expire < t) entries.delete(k);
}, 10 * 1000).unref();

/** 签发：返回一次性交换码（64 hex）；payload 在 consume 命中时原样返回 */
function mint(data, ttlMs = DEFAULT_TTL_MS) {
  const code = crypto.randomBytes(32).toString('hex');
  entries.set(code, { payload: data, expire: Date.now() + ttlMs });
  return code;
}

/** 消费：命中即删（一次性）；返回绑定的 payload，过期/伪造/已消费返回 null */
function consume(code) {
  const key = String(code || '');
  const hit = entries.get(key);
  entries.delete(key);
  if (!hit || Date.now() > hit.expire) return null;
  return hit.payload;
}

module.exports = { mint, consume, DEFAULT_TTL_MS };
