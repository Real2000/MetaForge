/**
 * 卡片渲染器（U0-5 P1）：把统一卡片模型转为三渠道原生卡片体
 *
 * 统一卡片模型（上游 sendCard 传入）：
 *   card = {
 *     buttons:      [{ text, action: 'approve'|'reject', url? }],  // 交互按钮
 *     callbackData: String,     // = tool_approvals.confirm_key（回调定位审批记录）
 *   }
 *   message = { title, content }
 *
 * 三渠道差异：
 *   钉钉  action_card        —— 已沿用的卡片体（原 buildDingCardBody 迁入此处统一）
 *   飞书  interactive        —— 卡片元素 elements/action，按钮 value 携 callbackData
 *   企微  template_card      —— button_interaction 模板，按钮 key 携 callbackData|action
 *
 * 说明：本模块只负责「构造卡片体结构」，真实发送由 lib/channel.js 及各适配器完成；
 * 回调对接细节（验签/唤醒）在 routes/channel.js 的 card-callback 内完成。
 */

/** 归一化按钮：兼容历史 { text, value } 与新的 { text, action, url } 两种形态 */
function normalizeButtons(card) {
  const arr = Array.isArray(card?.buttons) ? card.buttons : [];
  return arr.map(b => ({
    text: String(b?.text || '').slice(0, 60),
    action: String(b?.action || ''),        // approve | reject | ''
    url: String(b?.url || b?.value || ''),  // 跳转式回调（钉钉/企微）用
  })).filter(b => b.text);
}

/** 钉钉 action_card（与原 buildDingCardBody 行为一致，签名调整为 (card, message)） */
function renderDingtalkCard(card, message) {
  const title = String(message?.title || '').trim() || '审批通知';
  const content = String(message?.content || '').trim();
  const buttons = normalizeButtons(card);
  const markdown = `## ${title}\n\n${content}\n` + (buttons.length ? buttons.map(b => `---\n[${b.text}](${b.url || '#'})`).join('\n') : '');
  return {
    msgtype: 'action_card',
    action_card: {
      title,
      markdown,
      single_title: buttons.length === 1 ? buttons[0].text : undefined,
      single_url: buttons.length === 1 && buttons[0].url ? buttons[0].url : undefined,
      btn_json_list: buttons.length > 1 ? buttons.map(b => ({ title: b.text, action_url: b.url || '' })) : undefined,
    },
  };
}

/** 飞书 interactive 卡片（content 由调用方 JSON.stringify） */
function renderFeishuCard(card, message) {
  const title = String(message?.title || '').trim() || '审批通知';
  const content = String(message?.content || '').trim();
  const callbackData = String(card?.callbackData || '');
  const buttons = normalizeButtons(card);
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: content || ' ' } }];
  if (buttons.length) {
    elements.push({
      tag: 'action',
      actions: buttons.map(b => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.text },
        type: b.action === 'reject' ? 'danger' : 'primary',
        value: { key: callbackData, action: b.action || '' },
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    elements,
  };
}

/** 企微 template_card（button_interaction；整卡消息体由调用方包裹） */
function renderWecomCard(card, message) {
  const title = String(message?.title || '').trim() || '审批通知';
  const content = String(message?.content || '').trim();
  const callbackData = String(card?.callbackData || '');
  const buttons = normalizeButtons(card);
  return {
    card_type: 'button_interaction',
    main_title: { title },
    sub_title_text: content || ' ',
    button_list: buttons.map(b => ({
      text: b.text,
      style: b.action === 'reject' ? 1 : 2, // 企微样式：1 灰 / 2 蓝（拒绝灰、批准蓝）
      key: `${callbackData}|${b.action || ''}`,
    })),
  };
}

/** 统一入口：按渠道返回原生卡片体；未知渠道返回 null（调用方降级） */
function renderCardBody(channel, card, message) {
  const ch = String(channel || '');
  if (ch === 'dingtalk') return renderDingtalkCard(card, message);
  if (ch === 'feishu') return renderFeishuCard(card, message);
  if (ch === 'wecom') return renderWecomCard(card, message);
  return null;
}

module.exports = { renderCardBody, renderDingtalkCard, renderFeishuCard, renderWecomCard, normalizeButtons };
