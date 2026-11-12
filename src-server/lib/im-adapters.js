/**
 * IM 渠道适配器注册表（2026-11-12 P1-9 预留）
 *
 * 每个适配器实现统一接口（与 im-feishu.js 同构）：
 *   { accessToken(channelId), send(channelId, to, message), handleEvent(channelId, headers, body) }
 *
 * P1-9 已实现：feishu（见 im-feishu.js）
 * 预留接口（本期占位，接入时填充真实逻辑）：
 *   telegram —— Bot API（sendMessage / webhook update）
 *   discord  —— Bot（Channel messages / interactions）
 *   mqtt     —— 物联网场景（topic 订阅 / publish）
 *   wecom    —— 企微自建应用消息（与钉钉同构，待凭证）
 */
const feishu = require('./im-feishu');

const adapters = {
  // P1-9 飞书适配器：统一接口命名（accessToken/send/handleEvent）
  feishu: {
    status: 'active',
    accessToken: feishu.feishuAccessToken,
    send: feishu.feishuSend,
    handleEvent: feishu.handleFeishuEvent,
  },
  telegram: {
    status: 'reserved',
    accessToken: async () => null,
    send: async () => ({ ok: false, error: 'Telegram 适配器为预留接口，尚未实现' }),
    handleEvent: () => ({ error: 'Telegram 适配器为预留接口，尚未实现' }),
  },
  discord: {
    status: 'reserved',
    accessToken: async () => null,
    send: async () => ({ ok: false, error: 'Discord 适配器为预留接口，尚未实现' }),
    handleEvent: () => ({ error: 'Discord 适配器为预留接口，尚未实现' }),
  },
  mqtt: {
    status: 'reserved',
    accessToken: async () => null,
    send: async () => ({ ok: false, error: 'MQTT 适配器为预留接口，尚未实现' }),
    handleEvent: () => ({ error: 'MQTT 适配器为预留接口，尚未实现' }),
  },
  wecom: {
    status: 'reserved',
    accessToken: async () => null,
    send: async () => ({ ok: false, error: '企业微信适配器为预留接口，尚未实现' }),
    handleEvent: () => ({ error: '企业微信适配器为预留接口，尚未实现' }),
  },
};

function getAdapter(type) { return adapters[type] || null; }
function listAdapterStatus() {
  return Object.fromEntries(Object.entries(adapters).map(([k, v]) => [k, v.status || 'reserved']));
}

module.exports = { getAdapter, listAdapterStatus, adapters };
