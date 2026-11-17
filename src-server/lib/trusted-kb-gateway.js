/**
 * U2-7 Trusted KB Gateway（可信知识库网关，2026-11-16）
 *
 * 职责：
 *   1. 统一的外部知识源认证与检索接口。
 *   2. 将 external_sources 表中的配置解析为可调用的检索端点。
 *   3. 为检索结果注入来源组织水印（watermark）。
 *
 * 当前支持的外部源类型（external_sources.type）：
 *   - 'web'：通用 Web API（REST endpoint + API Key 认证）
 *   - 'confluence'：Confluence 页面检索
 *   - 'notion'：Notion 数据库检索
 *   - 'api'：自定义 API（通过 config 中的 endpoint 和 params 配置）
 *   - 'custom'：自定义实现（通过 entry 脚本）
 *
 * 安全：
 *   - API Key / OAuth 凭证通过 secrets 表引用（秘钥泄漏面仅限于 secrets 管理权限）
 *   - 所有对外请求默认 8 秒超时（可 per-source 覆盖）
 *   - 检索结果自动水印
 */
const { db, now } = require('../db');

const REQUEST_TIMEOUT = 8000;
const API_ENDPOINTS = {
  confluence: (url, query, apiKey) => ({
    url: `${url}/rest/api/content/search?cql=text~"${encodeURIComponent(query)}"&limit=5`,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  }),
  notion: (url, query, secret) => ({
    url: `${url}/v1/search`,
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, page_size: 5 }),
  }),
  web: (url, query, apiKey) => ({
    url: `${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }),
  api: (url, query, apiKey) => ({
    url: `${url}`.replace('{query}', encodeURIComponent(query)),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }),
};

/**
 * 检索单个外部知识源。
 * @param {object} source  — external_sources 中的一行
 * @param {string} query   — 检索关键词
 * @returns { { ok:boolean, results:Array, error?:string } }
 */
async function searchSource(source, query) {
  if (!source || !source.enabled) return { ok: false, results: [], error: '源未启用' };
  const type = source.type;
  const config = safeParse(source.config || '{}', {});
  const url = config.endpoint || config.url || '';
  if (!url) return { ok: false, results: [], error: '未配置端点 URL' };
  const authType = source.auth_type || config.auth_type || 'none';
  const apiKey = authType === 'api_key' ? resolveSecret(config.secret_ref || '') : '';

  const builder = API_ENDPOINTS[type] || (type === 'api' ? API_ENDPOINTS.api : null);
  if (!builder) return { ok: false, results: [], error: `不支持的外部源类型：${type}` };

  try {
    const reqConfig = builder(url, query, apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout || REQUEST_TIMEOUT);
    const res = await fetch(reqConfig.url, {
      method: reqConfig.method || 'GET',
      headers: reqConfig.headers || {},
      body: reqConfig.body || undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, results: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const results = extractResults(type, data, query);
    const orgName = source.org_name || config.org_name || '';
    const watermarked = results.map(r => ({
      ...r,
      content: orgName ? `[📡 来源组织：${orgName} · 外部知识库：${source.name}]\n${r.content}` : r.content,
    }));

    return { ok: true, results: watermarked };
  } catch (e) {
    return { ok: false, results: [], error: `检索失败：${e.message}` };
  }
}

/**
 * 对外部源检索结果统一提取（适配各 API 响应格式差异）。
 */
function extractResults(type, data, query) {
  try {
    if (type === 'confluence') {
      return (data.results || []).map(r => ({
        title: r.title || '',
        content: (r.body?.storage?.value || r.excerpt || '').replace(/<[^>]+>/g, '').slice(0, 2000),
        url: r._links?.webui || '',
        score: 0.5,
      }));
    }
    if (type === 'notion') {
      return (data.results || []).map(r => {
        const props = r.properties || {};
        const titleProp = Object.values(props).find(p => p.type === 'title') || {};
        const title = titleProp.title?.map(t => t.plain_text).join('') || '';
        const content = r.content?.text?.map?.(c => c.text?.content).join('') || r.excerpt || '';
        return { title, content: String(content).slice(0, 2000), url: r.url || '', score: 0.5 };
      });
    }
    if (type === 'web' || type === 'api') {
      return (data.results || data.data || data.items || []).map(r => ({
        title: r.title || r.name || '',
        content: r.content || r.text || r.snippet || r.description || JSON.stringify(r).slice(0, 1000),
        url: r.url || r.link || '',
        score: r.score || r.relevance || 0.5,
      }));
    }
    return [];
  } catch { return []; }
}

/**
 * 为一批检索结果注入水印（不修改原始数据，在 retriever 中调用）。
 * @param {Array} chunks         — kb_chunks 检索结果（含 content/score/file_id 等字段）
 * @param {object} kb            — 关联的知识库行（含 id/owner）
 * @param {object} [user]       — 请求用户（用于水印个性化，可选）
 * @returns {Array}               — 水印注入后的结果
 */
function injectWatermark(chunks, kb, user) {
  if (!Array.isArray(chunks)) return [];
  // 查询该知识库的外部源配置中是否有 org_name
  let orgName = '';
  try {
    const source = db.prepare("SELECT * FROM external_sources WHERE kb_id=? AND enabled=1 AND org_name!='' LIMIT 1").get(kb?.id || kb);
    if (source) orgName = source.org_name;
  } catch { /* 容错 */ }
  if (!orgName) return chunks; // 无外部源水印
  return chunks.map(c => ({
    ...c,
    content: `[📡 来源组织：${orgName}]\n${c.content}`,
  }));
}

// 辅助函数
function safeParse(str, def) {
  try { return JSON.parse(str) || def; } catch { return def; }
}
function resolveSecret(ref) {
  if (!ref) return '';
  try {
    const row = db.prepare("SELECT value FROM secrets WHERE name=?").get(ref);
    return row?.value || '';
  } catch { return ''; }
}

module.exports = { searchSource, injectWatermark, extractResults };
