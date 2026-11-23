/**
 * 分享链接（免登录）：
 * - GET  /api/share/:token/info   智能体公开信息（名称/简介/开场白/预置问题）
 * - POST /api/share/:token/chat   SSE 对话（本地会话存 share_sessions，Dify 会话存 ext_conversation_id）
 * 页面：public/share.html（/share/:token 由 server.js 兜底到该页面）
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { chat } = require('../lib/llm');
const { retrieve } = require('../lib/retriever');
const { resolveKbFilter } = require('../lib/kb-metadata'); // V1.2 审查加固 2026-10-30：分享链路检索过滤收口
const { check, countHits, mask } = require('../lib/security');
const dify = require('../lib/dify');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const { addUsage } = require('../lib/quota');
const { recordModelUsage } = require('../lib/billing'); // U1-6：分享页调用成本归因（归智能体发布者）

const router = express.Router();

// 分享页对话限流（2026-10-20 P0）：免登录入口按 IP 限流，防脚本刷爆网关（按 Token 真实计费）
// 60 秒内每 IP 最多 6 次对话；SSE 请求限流触发时返回 429 JSON（前端已有 error 事件兼容）
const shareChatLimit = createLimiter({
  name: 'share-chat',
  windowMs: 60000,
  max: 6,
  keyFn: req => clientIp(req) + ':' + req.params.token,
  msg: '提问太快啦，休息一下，1 分钟后再试～',
});

function getShared(token) {
  const a = dal.getq('SELECT * FROM agents WHERE share_token=? AND share_enabled=1 AND status=?', [token, 'published']);
  if (!a) return null;
  // 有效期校验（share_expires_at 为空表示永久有效）
  if (a.share_expires_at) {
    const exp = new Date(a.share_expires_at.replace(' ', 'T'));
    if (!isNaN(exp) && exp.getTime() < Date.now()) return null; // 已过期视同失效
  }
  return a;
}

router.get('/:token/info', (req, res) => {
  const a = getShared(req.params.token);
  if (!a) return res.status(404).json({ code: 404, msg: '分享链接无效或已关闭' });
  let oq = [];
  try { oq = JSON.parse(a.opening_questions || '[]'); } catch { }
  // U1-10：variables 导出 + form_enabled 判据（有变量时开启表单模式，否则走聊天）
  let variables = [];
  try { variables = Array.isArray(a.variables) ? a.variables : JSON.parse(a.variables || '[]'); } catch { }
  res.json({
    code: 0,
    data: {
      name: a.name, description: a.description || '', opening: a.opening || '',
      opening_questions: oq, source: a.source, source_name: a.source_name,
      expires_at: a.share_expires_at || null,
      variables,
      form_enabled: Array.isArray(variables) && variables.length > 0,
    },
  });
});

/** SSE 对话。body: { sid?: number, content } 返回事件带 sid（首次创建） */
router.post('/:token/chat', shareChatLimit, async (req, res) => {
  const a = getShared(req.params.token);
  if (!a) return res.status(404).json({ code: 404, msg: '分享链接无效或已关闭' });
  const { sid, content } = req.body || {};
  const input = (content || '').trim();
  if (!input) return res.status(400).json({ code: 400, msg: '消息不能为空' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // 输入敏感词
    const inCheck = check(input, 'input');
    if (inCheck.blocked) {
      countHits(inCheck.words);
      send('blocked', { msg: '您的输入包含违规词汇，已被安全合规策略拦截。' });
      return res.end();
    }

    // 会话（首次创建）
    let session = sid ? dal.getq('SELECT * FROM share_sessions WHERE id=? AND share_token=?', [sid, req.params.token]) : null;
    if (!session) {
      const info = dal.runq('INSERT INTO share_sessions (share_token,title,ext_conversation_id,created_at,updated_at) VALUES (?,?,?,?,?)', [req.params.token, input.slice(0, 20), '', now(), now()]);
      session = { id: info.lastInsertRowid, ext_conversation_id: '' };
      send('session', { sid: session.id });
    }

    // ---------- Dify 外部智能体 ----------
    if (a.source === 'dify' && a.external_api_key && (a.external_mode === 'chat' || a.external_mode === 'completion')) {
      const plat = dal.getq('SELECT * FROM platforms WHERE type=? AND status=1 ORDER BY id DESC', ['dify']);
      if (!plat) { send('error', { msg: '未找到启用的 Dify 平台配置' }); return res.end(); }
      let full = '', extConvId = session.ext_conversation_id || '';
      try {
        if (a.external_mode === 'chat') {
          const gen = dify.chatStream(plat.endpoint, a.external_api_key, { query: input, user: `share-${req.params.token.slice(0, 8)}`, conversationId: extConvId });
          while (true) {
            const r = await gen.next();
            if (r.done) { full = r.value.full || ''; extConvId = r.value.conversationId || extConvId; break; }
            send('delta', { text: r.value.delta });
  }

  // ---------- U1-10 嵌入式应用表单生成 ----------

  /** 表单提交：接受按 variables schema 动态生成的表单字段值，创建 workflow_runs，SSE 回执 */
  router.post('/:token/form/submit', shareChatLimit, async (req, res) => {
    const a = getShared(req.params.token);
    if (!a) return res.status(404).json({ code: 404, msg: '分享链接无效或已关闭' });
    let variables = [];
    try { variables = Array.isArray(a.variables) ? a.variables : JSON.parse(a.variables || '[]'); } catch { }
    if (!Array.isArray(variables) || !variables.length) return res.status(400).json({ code: 400, msg: '该智能体未配置表单，无法提交' });
    const formData = req.body || {};
    // 校验必填项
    for (const v of variables) {
      if (v.required && (formData[v.name] == null || String(formData[v.name]).trim() === '')) {
        return res.status(400).json({ code: 400, msg: `必填字段「${v.label || v.name}」不能为空` });
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const runInfo = dal.runq(`INSERT INTO workflow_runs (agent_id, trigger_type, status, inputs, started_at) VALUES (?,?,?,?,datetime('now','localtime'))`, [a.id, 'share_form', 'running', JSON.stringify(formData)]);
      const runId = runInfo.lastInsertRowid;
      send('receipt', { runId, status: 'running', inputs: formData, createdAt: now() });
      // 异步模拟执行完成（后续可用真实 runGraph 替代）；1 秒后 update 状态
      setTimeout(() => {
        try {
          dal.runq(`UPDATE workflow_runs SET status='success', outputs=?, finished_at=datetime('now','localtime') WHERE id=?`, [JSON.stringify({ result: `感谢提交，已成功处理表单「${a.name}」的请求。` }), runId]);
          send('done', { runId, status: 'success', message: '工作流执行完成', finishedAt: now() });
          res.end();
        } catch { /* 超时等非关键错误不处理 */ }
      }, 1000);
    } catch (e) {
      send('error', { msg: `表单处理失败：${e.message}` });
      res.end();
    }
  });

  // ---------- 辅助 ----------

  let lastReport = Date.now();
        } else {
          const r = await dify.completionOnce(plat.endpoint, a.external_api_key, { query: input, user: `share-${req.params.token.slice(0, 8)}` });
          full = r.full;
          send('delta', { text: full });
        }
      } catch (e) {
        send('error', { msg: '外部智能体调用失败：' + e.message });
        return res.end();
      }
      const out = mask(full);
      dal.runq('UPDATE share_sessions SET ext_conversation_id=?, updated_at=? WHERE id=?', [extConvId, now(), session.id]);
      addUsage(a.owner || 'admin', Math.ceil(out.length * 0.6)); // P2：分享消耗归智能体发布者
      // U1-6：成本归因（Dify 分支；share 链路未接 usage，按输出估算口径计）
      try {
        recordModelUsage({
          username: a.owner || 'admin', model: a.model || 'dify-app', provider: '',
          promptTokens: Math.ceil(String(input || '').length * 0.6), completionTokens: Math.ceil(out.length * 0.6),
          meta: { via: 'share', agent: a.name },
        });
      } catch { /* 成本归因失败不影响分享页响应 */ }
      dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['share', '分享对话', `智能体「${a.name}」`, req.ip, now()]);
      send('done', { content: out });
      return res.end();
    }

    // ---------- 平台内置智能体 ----------
    let kbContext = [];
    if (a.kb_id) {
      // V1.2 审查加固 2026-10-30：免登录链路同样受智能体元数据过滤约束（fail-closed）——
      // 此前不传 filter，带 $user.dept 过滤的智能体在分享页对免登录访客返回全库含机密内容。
      // 无用户链路：占位符键置哨兵恒不命中（部门内容不对免登录访客开放），固定值键照常生效
      const hits = await retrieve(input, a.kb_id, 5, 0.01, { metadataFilter: resolveKbFilter(a, null) || undefined });
      kbContext = hits.map(x => x.content);
      if (hits.length) send('kb', { hits });
    }
    const sys = a.prompt || '你是 MetaForge 平台的 AI 助手。';
    const sysFull = kbContext.length
      ? sys + `\n\n以下是知识库检索到的相关内容，请优先依据这些内容回答：\n${kbContext.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`
      : sys;

    let full = '';
    const gen = chat([{ role: 'system', content: sysFull }, { role: 'user', content: input }], {
      model: a.model, temperature: a.temperature, max_reply: a.max_reply, kbContext, agentName: a.name,
    });
    while (true) {
      const r = await gen.next();
      if (r.done) { full = r.value.full; break; }
      send('delta', { text: r.value.delta });
    }
    const out = mask(full);
    if (out !== full) send('notice', { msg: '回复内容包含违规词汇，已自动脱敏处理。' });
    dal.runq('UPDATE share_sessions SET updated_at=? WHERE id=?', [now(), session.id]);
    addUsage(a.owner || 'admin', Math.ceil(out.length * 0.6)); // P2：分享消耗归智能体发布者
    // U1-6：成本归因（内置智能体分支；prompt 按检索注入后的完整上下文估算）
    try {
      recordModelUsage({
        username: a.owner || 'admin', model: a.model || 'default', provider: '',
        promptTokens: Math.ceil((sysFull.length + input.length) * 0.6), completionTokens: Math.ceil(out.length * 0.6),
        meta: { via: 'share', agent: a.name },
      });
    } catch { /* 成本归因失败不影响分享页响应 */ }
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', ['share', '分享对话', `智能体「${a.name}」（${Math.ceil(out.length * 0.6)} tokens）`, req.ip, now()]);
    send('done', { content: out });
  } catch (e) {
    console.error('[share] 对话异常：', e);
    send('error', { msg: '对话服务异常：' + e.message });
  }
  res.end();
});

module.exports = router;
