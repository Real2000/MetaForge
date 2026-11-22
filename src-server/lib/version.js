/**
 * 版本号单一来源（BE-B4 / M2 批次3，2026-11-22）
 *
 * 平台对外暴露的一切版本标识（A2A Agent Card、OpenAPI info.version、CLI、文档页）
 * 均从此处读取，杜绝多处硬编码漂移。改版本只动本文件。
 */
const PLATFORM_VERSION = 'p5.37'; // 平台产品版本（人类可读）
const API_VERSION = '1.0.0';      // 对外 REST API 契约版本（OpenAPI info.version）
const OPENAPI_VERSION = '3.1.0';  // OpenAPI 规范版本
const SDK_VERSION = '1.0.0';      // 官方 SDK 版本

module.exports = { PLATFORM_VERSION, API_VERSION, OPENAPI_VERSION, SDK_VERSION };
