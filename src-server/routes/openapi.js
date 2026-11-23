/**
 * API 发布：把平台智能体以 OpenAI 兼容接口对外提供。
 * - GET  /openapi/v1/models                列出已发布智能体（OpenAI models 格式）
 * - POST /openapi/v1/chat/completions      对话（Bearer sk-ap-xxx 鉴权；支持 stream）
 * 鉴权：agent_api_keys 表中的密钥（后台「智能体管理 → API」创建）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { chat } = require('../lib/llm');
const { retrieve } = require('../lib/retriever');
const { resolveKbFilter } = require('../lib/kb-metadata'); // V1.2 审查加固 2026-10-30：开放 API 检索过滤收口
const { check, countHits, mask } = require('../lib/security');
const dify = require('../lib/dify');
const { createLimiter, createQuotaGuard } = require('../lib/rate-limit');
const { getq } = require('../lib/dal'); // BE-B3：配额读取走统一出口
const { hashKey } = require('../lib/apikey'); // SEC-02a：按哈希比对 API Key
const { addUsage } = require('../lib/quota');
const { recordModelUsage } = require('../lib/billing'); // U1-6：开放 API 调用成本归因（归智能体发布者）
const { buildGlobalOpenApi } = require('../lib/api-doc'); // BE-B4：运行时自动采集的全站规范
const { API_VERSION, PLATFORM_VERSION } = require('../lib/version'); // BE-B4：版本单一来源

const router = express.Router();

// BE-B4（M2 批次3）：对外契约文档——/openapi/openapi.json 与 /api/api-docs 同源（运行时自动采集）。
// 公开无鉴权（规范本身非敏感），置于鉴权端点之前。
router.get('/openapi.json', (req, res) => {
  res.json(buildGlobalOpenApi(req.app, {
    version: API_VERSION,
    extra: { 'x-platform-version': PLATFORM_VERSION },
  }));
});

/** 提取密钥尾段（不落全量密钥） */
const keyTail = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim().slice(-16);

// API Key 限流（2026-10-20 P0）：每 Key 每分钟最多 20 次对话，防密钥泄露后被脚本刷爆网关
// BE-B3（2026-11-22）：改共享存储（rate_limit_counters）——多实例同库合计额度，不再各实例独立放大
const keyChatLimit = createLimiter({
  name: 'openapi-chat',
  windowMs: 60000,
  max: 20,
  keyFn: keyTail,
  shared: true,
  msg: 'API 调用超过频率限制（20 次/分钟），请稍后重试或联系管理员调整',
});

// P3-6（2026-11-09）：models 列表端点补限流——原先仅 chat 有限流，models 可被高频刷（响应含全部已发布智能体
// 元信息且每次制UPDATE last_used_at 写库）；与 chat 同款 Key 尾段维度，列表类查询放宽至 60 次/分钟
const keyModelsLimit = createLimiter({
  name: 'openapi-models',
  windowMs: 60000,
  max: 60,
  keyFn: keyTail,
  shared: true,
  msg: '模型列表查询超过频率限制（60 次/分钟），请稍后重试',
});

// BE-B3：每 Key 日/月调用配额（agent_api_keys.quota_daily/quota_monthly，0=不限）。
// 原子「自增后判超」，多实例下放行总次数恒等于配置额度；无效密钥（无库记录）不计数。
const keyQuota = createQuotaGuard({
  name: 'openapi',
  keyFn: keyTail,
  limitsFn: req => {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!raw) return {};
    const row = getq('SELECT quota_daily, quota_monthly FROM agent_api_keys WHERE key=? AND status=1', [hashKey(raw)]);
    return row ? { daily: row.quota_daily, monthly: row.quota_monthly } : {};
  },
});

// CORS（供外部系统/网页直调）
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/** Bearer 密钥 → 有效 key 记录（不含 agent 校验，由各端点按需决定作用域）
 *  P2-2 修复 2026-11-09：不再在此处校验 agent 存在性——下放到具体 endpoint 按需校验 agent 匹配。 */
function authKey(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return null;
  // SEC-02a：库中 key 列为 HMAC 哈希——按哈希比对（不再明文比对）
  const k = dal.getq('SELECT * FROM agent_api_keys WHERE key=? AND status=1', [hashKey(key)]);
  if (!k) return null;
  dal.runq('UPDATE agent_api_keys SET last_used_at=? WHERE id=?', [now(), k.id]);
  return { k };
}

/** 密钥作用域校验（返回错误消息字符串表示拒绝，null 表示通过）
 *  D-3（2026-11-23 拍板：需要全域模式）：
 *  - 绑定 Key（agent_id 非空）→ 仅可调用绑定智能体（原语义不变）；
 *  - 全域 Key（agent_id NULL）→ 可访问与 Key 同租户的全部已发布智能体（企业对外一 Key 集成多智能体）；
 *    防线 fail-closed：目标 agent 不存在/未发布拒绝；多租户下跨租户拒绝（单租户 tenant_id 恒等零回归）。 */
function authKeyForAgent(k, agentId) {
  if (k.agent_id == null) {
    const agent = getq('SELECT id, status, tenant_id FROM agents WHERE id=?', [agentId]); // BE-C1：新增查询走统一出口
    if (!agent || agent.status !== 'published') return '目标智能体不存在或未发布（全域 Key 仅可访问已发布智能体）';
    if (Number(agent.tenant_id ?? 1) !== Number(k.tenant_id ?? 1)) return 'API Key 无权访问其他租户的智能体';
    return null;
  }
  if (k.agent_id === agentId) return null; // 匹配
  return 'API Key 无权访问该智能体（Key 绑定到特定智能体，请创建对应 Key）';
}

function unauthorized(res) {
  res.status(401).json({ error: { message: '无效的 API Key，请在智能体平台后台「智能体管理 → API」获取', type: 'invalid_api_key' } });
}

// 模型列表：每个已发布智能体对外即一个"模型"
router.get('/v1/models', keyModelsLimit, keyQuota, (req, res) => {
  const h = authKey(req);
  if (!h) return unauthorized(res);
  const agents = dal.q("SELECT id,name,description,tenant_id FROM agents WHERE status='published' AND (source='self' OR source='dify')");
  // D-3：全域 Key（agent_id NULL）可见同租户全部已发布智能体；绑定 Key 仅可见绑定智能体（SEC-02a 语义不变）
  const visible = h.k.agent_id == null
    ? agents.filter(a => Number(a.tenant_id ?? 1) === Number(h.k.tenant_id ?? 1))
    : agents.filter(a => a.id === h.k.agent_id);
  res.json({
    object: 'list',
    data: visible.map(a => ({
      id: `agent-${a.id}-${a.name}`,
      object: 'model',
      owned_by: 'agent-platform',
      description: a.description || '',
    })),
  });
});

/**
 * POST /openapi/v1/chat/completions
 * body 兼容 OpenAI：{ model: "agent-<id>-<名称>", messages: [{role, content}], stream? }
 */
router.post('/v1/chat/completions', keyChatLimit, keyQuota, async (req, res) => {
  const h = authKey(req);
  if (!h) return unauthorized(res);
  const { model, messages, stream } = req.body || {};
  const m = /^agent-(\d+)-/.exec(model || '');
  const agentId = m ? +m[1] : 0;
  // P2-2 修复：校验 Key 的作用域——绑定了 agent_id 的 Key 仅可调用绑定智能体
  const scopeCheck = authKeyForAgent(h.k, agentId);
  if (scopeCheck) return res.status(403).json({ error: { message: scopeCheck, type: 'key_scope_denied' } });
  const agent = m ? dal.getq('SELECT * FROM agents WHERE id=? AND status=?', [agentId, 'published']) : null;
  if (!agent) {
    return res.status(404).json({ error: { message: `模型不存在：${model}。请先 GET /openapi/v1/models 获取可用智能体列表`, type: 'model_not_found' } });
  }
  const lastUser = [...(messages || [])].reverse().find(x => x.role === 'user');
  const input = (lastUser?.content || '').trim();
  if (!input) return res.status(400).json({ error: { message: '消息不能为空', type: 'invalid_request_error' } });

  // 安全合规：输入敏感词拦截
  const inCheck = check(input, 'input');
  if (inCheck.blocked) {
    countHits(inCheck.words);
    return res.status(400).json({ error: { message: '输入包含违规词汇，已被安全合规策略拦截', type: 'content_filter' } });
  }

  const created = Math.floor(Date.now() / 1000);
  const modelId = model;

  // ---------- 外部 Dify 智能体 ----------
  if (agent.source === 'dify' && agent.external_api_key && (agent.external_mode === 'chat' || agent.external_mode === 'completion')) {
    const plat = dal.getq('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC', ['dify']);
    if (!plat) return res.status(502).json({ error: { message: '未找到启用的 Dify 平台配置', type: 'api_error' } });
    try {
      let full = '', usage = null;
      if (agent.external_mode === 'chat') {
        const gen = dify.chatStream(plat.endpoint, agent.external_api_key, { query: input, user: `openapi-${h.k.id}` });
        while (true) {
          const r = await gen.next();
          if (r.done) { full = r.value.full || ''; usage = r.value.usage; break; }
          if (stream) writeSseDelta(res, modelId, created, r.value.delta);
        }
      } else {
        const r = await dify.completionOnce(plat.endpoint, agent.external_api_key, { query: input, user: `openapi-${h.k.id}` });
        full = r.full; usage = r.usage;
        if (stream) writeSseDelta(res, modelId, created, full);
      }
      const out = mask(full);
      const pt = usage?.total_tokens || Math.ceil(out.length * 0.6);
      addUsage(agent.owner || 'admin', pt); // P2：API 调用消耗归智能体发布者
      // U1-6：成本归因（Dify 分支，真实 usage 拆分优先）
      try {
        recordModelUsage({
          username: agent.owner || 'admin', model, provider: '',
          promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens || pt,
          meta: { via: 'openapi', agent: agent.name },
        });
      } catch { /* 成本归因失败不影响 API 响应 */ }
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['openapi', 'API调用', `智能体「${agent.name}」（${pt} tokens）`, req.ip, now()]);
      finish(res, stream, modelId, created, out, pt);
    } catch (e) {
      res.status(502).json({ error: { message: '外部智能体调用失败：' + e.message, type: 'api_error' } });
    }
    return;
  }

  // ---------- 平台内置智能体（提示词 + 知识库 + 模型） ----------
  let kbContext = [];
  // V1.2 审查加固 2026-10-30：API Key 持有者检索同样受智能体元数据过滤约束（fail-closed）——
  // 无用户链路：占位符键置哨兵恒不命中（部门内容不对无部门身份的 Key 持有者开放），固定值键照常生效
  if (agent.kb_id) kbContext = (await retrieve(input, agent.kb_id, 5, 0.01, { metadataFilter: resolveKbFilter(agent, null) || undefined })).map(x => x.content);
  const sys = agent.prompt || '你是企业智能体平台的 AI 助手。';
  const sysFull = kbContext.length
    ? sys + `\n\n以下是知识库检索到的相关内容，请优先依据这些内容回答：\n${kbContext.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`
    : sys;

  try {
    let full = '';
    const gen = chat([{ role: 'system', content: sysFull }, { role: 'user', content: input }], {
      model: agent.model, temperature: agent.temperature, max_reply: agent.max_reply, kbContext, agentName: agent.name,
    });
    while (true) {
      const r = await gen.next();
      if (r.done) { full = r.value.full; break; }
      if (stream) writeSseDelta(res, modelId, created, r.value.delta);
    }
    const out = mask(full);
    const pt = Math.ceil(out.length * 0.6);
    addUsage(agent.owner || 'admin', pt); // P2：API 调用消耗归智能体发布者
    // U1-6：成本归因（内置智能体分支；prompt 按检索注入后的完整上下文估算）
    try {
      recordModelUsage({
        username: agent.owner || 'admin', model: agent.model || 'default', provider: '',
        promptTokens: Math.ceil((sysFull.length + input.length) * 0.6), completionTokens: pt,
        meta: { via: 'openapi', agent: agent.name },
      });
    } catch { /* 成本归因失败不影响 API 响应 */ }
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['openapi', 'API调用', `智能体「${agent.name}」（${pt} tokens）`, req.ip, now()]);
    finish(res, stream, modelId, created, out, pt);
  } catch (e) {
    res.status(500).json({ error: { message: '对话服务异常：' + e.message, type: 'api_error' } });
  }
});

function writeSseDelta(res, model, created, text) {
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-ap-' + created, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
}

function finish(res, stream, model, created, content, tokens) {
  if (stream) {
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-ap-' + created, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.json({
      id: 'chatcmpl-ap-' + created, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
    });
  }
}

module.exports = router;
// D-3 测试口：作用域矩阵单测用（smoke 直接验证 authKeyForAgent 的全域/绑定语义矩阵）
module.exports.__authKeyForAgent = authKeyForAgent;
