/**
 * ConversationSink：外部/技能链路统一收尾（P5.33 chat.js 管道化重构）
 *
 * 动机：chat.js 的四条链路（创作技能 / Dify 转发 / Coze 工作流 / Coze 对话）各自复制了一份
 * 「脱敏 → assistant 落库 → 会话更新 → 配额记账 → op_logs 审计 → chat_traces 全链路追踪 → SSE done」
 * 尾部代码（约 120 行 × 4 份）——P5.30 修的「技能路径 addUsage 双重记账」正是这种复制粘贴的直接产物。
 * 收敛到唯一记账/落库/审计点后，此类 bug 结构性不可能复发。
 *
 * 差异参数化（覆盖四条链路的既有行为，逐一保持不变）：
 *  - tokens：显式传值（外部 usage / Coze 工作流 输入+输出估算）；缺省按脱敏后内容长度 ceil(×0.6) 估算
 *  - maskOutput：是否做输出敏感词过滤 + notice（Coze 工作流原本不过滤，传 false）
 *  - billUsage：是否 addUsage 记账（Coze 工作流原本不记账，传 false）
 *  - extConvId !== undefined：回写 sessions.ext_conversation_id（Dify/Coze 对话链路；技能/工作流不传）
 *  - opDetail：op_logs 明细文案；传函数时以最终 tokens 为参（文案含 token 数的场景）
 *  - promptTokens/completionTokens：U1-6 精细计费拆分基数（外部 usage 真实值优先；缺省 prompt 按输入估算、completion=最终 tokens）
 *
 * 注意：内部链路（含 PII/假图防御/建议生成等独有逻辑）不经过本 Sink，仍在 chat.js 主链路内。
 */
const { db, now } = require('../db');
const { check, countHits, mask } = require('./security');
const { addUsage } = require('./quota');
const { recordModelUsage } = require('./billing'); // U1-6：成本归因（与配额记账同点位，失败内部兜底不阻断）

/**
 * 统一收尾一轮外部/技能对话。
 * @param {object} opts 见文件头注释；必填 send/sessionId/username/input/full/modeLabel
 * @returns {{ mid:number, content:string, tokens:number }}
 */
function finishExternalTurn(opts) {
  const {
    send, sessionId, username, ip,
    input, full,
    tokens, agent = null,
    modelLabel = '', modeLabel = '',
    promptTokens, completionTokens,
    tStart = Date.now(),
    maskOutput = true, billUsage = true,
    extConvId, opAction = '对话调用', opDetail = '',
  } = opts;

  // 1. 输出敏感词过滤（与内部链路一致；脱敏命中时计数 + notice 告知）
  let content = String(full ?? '');
  if (maskOutput) {
    const masked = mask(content);
    if (masked !== content) {
      try { countHits(check(content, 'output').words); } catch { /* 词库异常不阻塞收尾 */ }
      send('notice', { msg: '回复内容包含违规词汇，已自动脱敏处理。' });
    }
    content = masked;
  }

  // 2. token 数：显式正值优先；0/null/undefined 均视为缺省按内容估算（P5.33 审查修复 Y2：与调用方 `|| undefined` 预处理及注释口径对齐）
  const finalTokens = (Number.isFinite(+tokens) && +tokens > 0) ? Math.ceil(+tokens) : Math.ceil(content.length * 0.6);

  // 3. assistant 消息落库 + 会话更新（extConvId 有定义时回写外部会话 id）
  const msgInfo = db.prepare('INSERT INTO messages (session_id,role,content,tokens,created_at) VALUES (?,?,?,?,?)')
    .run(sessionId, 'assistant', content, finalTokens, now());
  if (sessionId) {
    if (extConvId !== undefined) {
      db.prepare('UPDATE sessions SET updated_at=?, ext_conversation_id=? WHERE id=?').run(now(), extConvId, sessionId);
    } else {
      db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), sessionId);
    }
  }

  // 4. 配额记账（唯一记账点；billUsage=false 保留 Coze 工作流不记账的原行为）
  if (billUsage && finalTokens > 0) addUsage(username, finalTokens);

  // 4b. U1-6 成本归因：与配额记账同点位（billUsage=false 同样不记）；失败内部兜底不阻断收尾。
  //     拆分基数：外部 usage 真实值优先（调用方传 promptTokens/completionTokens），
  //     缺省 prompt 按输入长度估算（与 tokens 估算口径一致）、completion = 最终 tokens
  if (billUsage && finalTokens > 0 && modelLabel) {
    recordModelUsage({
      username,
      model: modelLabel,
      promptTokens: Number.isFinite(+promptTokens) && +promptTokens > 0 ? +promptTokens : Math.ceil(String(input || '').length * 0.6),
      completionTokens: Number.isFinite(+completionTokens) && +completionTokens > 0 ? +completionTokens : finalTokens,
      meta: modeLabel ? { mode: modeLabel } : {},
    });
  }

  // 5. op_logs 审计（明细文案可为函数，以最终 tokens 为参）；审计/trace 写入失败不阻断 done 事件（P5.33 审查修复 F10：保证前端不悬挂）
  try {
    const detailText = typeof opDetail === 'function' ? String(opDetail(finalTokens)) : String(opDetail);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, opAction, detailText, ip, now());
  } catch (e) { console.error('[chat-sink] op_logs 写入失败：', e.message); }

  // 6. chat_traces 全链路追踪（外部/技能链路无知识库命中与工具调用，固定 '[]'）
  try {
    db.prepare('INSERT INTO chat_traces (session_id,message_id,agent_id,model,mode,latency_ms,tokens,prompt_chars,kb_hits,tool_calls,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(sessionId, msgInfo.lastInsertRowid, agent ? agent.id : null, modelLabel, modeLabel, Date.now() - tStart, finalTokens, String(input || '').length, '[]', '[]', now());
  } catch (e) { console.error('[chat-sink] chat_traces 写入失败：', e.message); }

  // 7. SSE done
  send('done', { content, tokens: finalTokens });
  return { mid: Number(msgInfo.lastInsertRowid), content, tokens: finalTokens };
}

module.exports = { finishExternalTurn };
