/**
 * API 发布：把平台智能体以 OpenAI 兼容接口对外提供。
 * - GET  /openapi/v1/models                列出已发布智能体（OpenAI models 格式）
 * - POST /openapi/v1/chat/completions      对话（Bearer sk-ap-xxx 鉴权；支持 stream）
 * 鉴权：agent_api_keys 表中的密钥（后台「智能体管理 → API」创建）
 */
const express = require('express');
const { db, now } = require('../db');
const { chat } = require('../lib/llm');
const { retrieve } = require('../lib/retriever');
const { check, countHits, mask } = require('../lib/security');
const dify = require('../lib/dify');
const { createLimiter } = require('../lib/rate-limit');
const { addUsage } = require('../lib/quota');

const router = express.Router();

// API Key 限流（2026-10-20 P0）：每 Key 每分钟最多 20 次对话，防密钥泄露后被脚本刷爆网关
const keyChatLimit = createLimiter({
  name: 'openapi-chat',
  windowMs: 60000,
  max: 20,
  keyFn: req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim().slice(-16), // 用 Key 尾段（不落全量密钥）
  msg: 'API 调用超过频率限制（20 次/分钟），请稍后重试或联系管理员调整',
});

// CORS（供外部系统/网页直调）
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/** Bearer 密钥 → 有效 key 记录（含 agent），并刷新 last_used_at */
function authKey(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return null;
  const k = db.prepare('SELECT * FROM agent_api_keys WHERE key=? AND status=1').get(key);
  if (!k) return null;
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND status=?').get(k.agent_id, 'published');
  if (!agent) return null;
  db.prepare('UPDATE agent_api_keys SET last_used_at=? WHERE id=?').run(now(), k.id);
  return { k, agent };
}

function unauthorized(res) {
  res.status(401).json({ error: { message: '无效的 API Key，请在智能体平台后台「智能体管理 → API」获取', type: 'invalid_api_key' } });
}

// 模型列表：每个已发布智能体对外即一个"模型"
router.get('/v1/models', (req, res) => {
  const h = authKey(req);
  if (!h) return unauthorized(res);
  const agents = db.prepare("SELECT id,name,description FROM agents WHERE status='published' AND (source='self' OR source='dify')").all();
  res.json({
    object: 'list',
    data: agents.map(a => ({
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
router.post('/v1/chat/completions', keyChatLimit, async (req, res) => {
  const h = authKey(req);
  if (!h) return unauthorized(res);
  const { model, messages, stream } = req.body || {};
  const m = /^agent-(\d+)-/.exec(model || '');
  const agent = m ? db.prepare('SELECT * FROM agents WHERE id=? AND status=?').get(+m[1], 'published') : null;
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
    const plat = db.prepare('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC').get('dify');
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
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('openapi', 'API调用', `智能体「${agent.name}」（${pt} tokens）`, req.ip, now());
      finish(res, stream, modelId, created, out, pt);
    } catch (e) {
      res.status(502).json({ error: { message: '外部智能体调用失败：' + e.message, type: 'api_error' } });
    }
    return;
  }

  // ---------- 平台内置智能体（提示词 + 知识库 + 模型） ----------
  let kbContext = [];
  if (agent.kb_id) kbContext = (await retrieve(input, agent.kb_id, 5)).map(x => x.content);
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
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run('openapi', 'API调用', `智能体「${agent.name}」（${pt} tokens）`, req.ip, now());
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
