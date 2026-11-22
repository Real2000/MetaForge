/**
 * 统一响应契约（BE-B1 / M2 批次3，2026-11-22）
 *
 * 目标：全站「错误一律以对应 HTTP 状态码返回」——成功仍 `{ code: 0, data }`。
 *
 * 实现方式：中央响应契约中间件（contract()），一次性覆盖既有全部响应点，而非逐处改写。
 *   - 凡 `res.json(body)` 且 body 为对象含 `code` 字段、`code !== 0`、当前 HTTP 状态仍为 200，
 *     即按业务码映射为对应 HTTP 状态码（body 原样保留，前后端既有 `j.code` 逻辑零破坏）。
 *   - `code === 0`（成功）与已显式 `res.status(...)` 的响应对其透明无感。
 *
 * 豁免（EXEMPT，保留 HTTP 200 语义，理由见下）：
 *   - /api/auth        ：登录/改密/免登等「凭据失败」端点——前端以 body.code 401 展示「账号或密码错误」，
 *                        若置 HTTP 401 会被前端 api() 统一识别为「登录已过期」而误跳转。
 *   - /api/dingtalk    ：钉钉回调收到非 200 会持续重试（最长 24h）→ 任何拒绝都必须 200 空体静默返回。
 *   - /api/a2a         ：Agent-to-Agent/OAuth 机器协议，错误约定走 body，保持 200。
 *   - 渠道回调三端点   ：IM 平台（飞书/企微/微信）webhook 与卡片回调，非 200 触发平台重试。
 *
 * 新代码请直接使用 ok()/fail() 助手，语义更清晰。
 */

// 豁免前缀（含其子路径）
const EXEMPT_PREFIXES = ['/api/auth', '/api/dingtalk', '/api/a2a'];
// 豁免精确路径（含其子路径）
const EXEMPT_EXACT = ['/api/channel/event', '/api/channel/card-callback', '/api/channel/inbound'];

/** 判断某完整请求路径是否豁免状态码修正 */
function isExempt(path) {
  if (!path) return false;
  if (EXEMPT_EXACT.some(p => path === p || path.startsWith(p + '/'))) return true;
  return EXEMPT_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
}

/** 业务码 → HTTP 状态码：4xx/5xx 原样；其余（异常/落成功区间的错误码）回落 400 */
function httpStatusOf(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 400;
  return n >= 400 && n <= 599 ? n : 400;
}

/** 中央响应契约中间件：修正「HTTP 200 + 业务错误码」为正确状态码（body 不变） */
function contract() {
  return function responseContract(req, res, next) {
    const fullPath = String(req.originalUrl || req.url || '').split('?')[0];
    const exempt = isExempt(fullPath);
    const rawJson = res.json.bind(res);
    res.json = function (body) {
      try {
        if (!exempt && res.statusCode === 200 && body && typeof body === 'object' && !Array.isArray(body)
          && 'code' in body && Number(body.code) !== 0) {
          res.status(httpStatusOf(body.code));
        }
      } catch { /* 契约修正不可影响正常响应 */ }
      return rawJson(body);
    };
    next();
  };
}

/** 成功响应：{ code: 0, data, ...extra } */
function ok(res, data, extra) {
  const body = { code: 0, data };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return res.json(body);
}

/** 失败响应：HTTP 状态码 = httpStatus，body.code = httpStatus（向后兼容既有数字业务码） */
function fail(res, httpStatus, msg, extra) {
  return failWith(res, httpStatus, httpStatus, msg, extra);
}

/** 失败响应（业务码 ≠ HTTP 状态码时使用）：显式区分 errCode 与 HTTP 状态 */
function failWith(res, httpStatus, errCode, msg, extra) {
  const body = { code: errCode, msg };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return res.status(httpStatus).json(body);
}

const badRequest = (res, msg, extra) => fail(res, 400, msg, extra);
const unauthorized = (res, msg, extra) => fail(res, 401, msg, extra);
const paymentRequired = (res, msg, extra) => fail(res, 402, msg, extra);
const forbidden = (res, msg, extra) => fail(res, 403, msg, extra);
const notFound = (res, msg, extra) => fail(res, 404, msg, extra);
const conflict = (res, msg, extra) => fail(res, 409, msg, extra);
const tooMany = (res, msg, extra) => fail(res, 429, msg, extra);
const serverError = (res, msg, extra) => fail(res, 500, msg, extra);

module.exports = {
  contract, ok, fail, failWith, isExempt, httpStatusOf,
  badRequest, unauthorized, paymentRequired, forbidden, notFound, conflict, tooMany, serverError,
};
