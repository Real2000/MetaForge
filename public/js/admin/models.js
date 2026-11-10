/** 后台-模型接入：多供应商（OpenAI 兼容）管理 + 健康指示灯（P1） */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let providers = [];
  let health = { providers: [], open_circuits: [] }; // 健康数据（每 15s 刷新）

  el.innerHTML = `
    <div class="page-head"><h2>${t('模型接入')}</h2><div class="desc">${t('接入 OpenAI 兼容的大模型供应商（阿里百炼 / 火山引擎 / DeepSeek / OpenAI / 自建网关…）。为默认供应商填写 API Key 后，全平台对话切换为真实模型输出；未配置时自动降级为内置演示引擎。')}</div></div>
    <div id="plist" class="grid-2" style="align-items:start"></div>`;

  /** 健康指示灯：绿=最近调用成功 / 红=最近调用失败 / 灰=尚无调用记录；另显示熔断中的模型 */
  function healthBadge(p) {
    const h = health.providers.find(x => x.provider_id === p.id);
    const open = health.open_circuits.filter(c => c.key.startsWith(p.id + ':'));
    if (!h) return `<span class="tag gray" title="${t('尚无调用记录')}">⚪ ${t('无调用')}</span>`;
    const state = h.state === 'ok'
      ? `<span class="tag green" title="${t('最近调用成功（成功率')} ${h.ok_rate * 100}%）">🟢 ${t('正常')}</span>`
      : h.state === 'fail'
        ? `<span class="tag red" title="${t('最近调用失败：')}${esc(h.last_err.slice(0, 80))}">🔴 ${t('异常')}</span>`
        : `<span class="tag gray">⚪ ${t('无调用')}</span>`;
    const circuitTip = open.length
      ? ` <span class="tag orange" title="${esc(open.map(c => c.key.split(':')[1] + '：' + c.last_err.slice(0, 60)).join('\n'))}">⚡ ${open.length} ${t('模型熔断中')}</span>`
      : '';
    return state + circuitTip;
  }

  // P4 模型类型徽章（2026-10-22）：模型卡片按类型着色展示（对话/生图/视频/语音/嵌入）
  const TYPE_ICON = { chat: '💬', image: '🎨', video: '🎬', tts: '🎙️', embedding: '🧠' };
  function modelTag(m, p) {
    const type = (p.model_types || {})[m] || '';
    const cls = { chat: 'blue', image: 'purple', video: 'orange', tts: 'green', embedding: 'gray' }[type] || 'gray';
    return `<span class="tag ${cls}" style="margin:2px 2px" title="${type ? t('类型：') + t(({ chat: '对话', image: '生图', video: '视频', tts: '语音', embedding: '嵌入' }[type])) : t('未标注类型')}">${type ? TYPE_ICON[type] + ' ' : ''}${esc(m)}</span>`;
  }
  function cardHtml(p) {
    let models = [];
    try { models = JSON.parse(p.models || '[]'); } catch { }
    return `
      <div class="card" style="border:${p.is_default ? '2px solid var(--brand)' : '1px solid var(--border)'}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0">🧠 ${esc(p.name)}
            ${p.is_default ? `<span class="tag blue">${t('默认供应商')}</span>` : ''}
            ${p.configured ? `<span class="tag green">${models.length} ${t('个模型')}</span>` : `<span class="tag gray">${t('待配置')}</span>`}
            ${healthBadge(p)}
          </h3>
          <span style="font-size:11px;color:var(--text-3)">${p.api_key ? t('已配置 Key') : t('未配置 Key')}</span>
        </div>
        <div class="kv" style="margin-bottom:12px">
          <span class="k">${t('服务地址')}</span><span class="mono" style="word-break:break-all">${esc(p.base_url || '-')}</span>
          <span class="k">${t('模型列表')}</span><span>${models.length ? models.slice(0, 9).map(m => modelTag(m, p)).join('') + (models.length > 9 ? ` <span style="color:var(--text-3)">${t('等')} ${models.length} ${t('个')}</span>` : '') : `<span style="color:var(--text-3)">${t('暂未接入模型')}</span>`}</span>
          <span class="k">${t('说明')}</span><span style="color:var(--text-2);font-size:12px">${esc(t(p.remark || ''))}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-cfg="${p.id}">${t('配置')}</button>
          <button class="btn sm" data-sync="${p.id}">${t('同步模型')}</button>
          <button class="btn sm" data-test="${p.id}">${t('连通测试')}</button>
          ${models.length ? `<button class="btn sm" data-addm="${p.id}">+ ${t('添加模型')}</button>` : ''}
          ${p.api_key && !p.is_default ? `<button class="btn sm" data-def="${p.id}">${t('设为默认')}</button>` : ''}
          <button class="btn sm danger" data-del="${p.id}">${t('删除')}</button>
        </div>
      </div>`;
  }

  function renderCards() {
    el.querySelector('#plist').innerHTML = providers.map(cardHtml).join('') + `
      <div class="card" style="border:1.5px dashed #c7d2fe;display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer" id="newProv">
        <div style="text-align:center;color:var(--brand)"><div style="font-size:30px">＋</div>${t('接入新供应商')}</div>
      </div>`;

    el.querySelectorAll('[data-cfg]').forEach(b => b.onclick = () => openCfg(+b.dataset.cfg));
    el.querySelectorAll('[data-addm]').forEach(b => b.onclick = () => {
      const p = providers.find(x => x.id === +b.dataset.addm);
      const body = `
        <div class="form-item"><label>${t('模型名称')}<span class="req">*</span></label>
          <input class="input mono" id="m_name" placeholder="${t('如 qwen-turbo / deepseek-chat')}"></div>
        <div class="form-item"><label>${t('模型类型')}<span class="req">*</span></label>
          <select class="input" id="m_type">
            <option value="chat">💬 ${t('对话模型（chat/completions）')}</option>
            <option value="image">🎨 ${t('生图模型（images/generations）')}</option>
            <option value="video">🎬 ${t('视频模型（videos/generations）')}</option>
            <option value="tts">🎙️ ${t('语音模型（audio/speech）')}</option>
            <option value="embedding">🧠 ${t('嵌入模型（embeddings）')}</option>
          </select>
          <div class="hint">${t('提交时会按所选类型真实调用一次对应接口校验权限，通过后才加入清单；前台各创作模式按此类型自动隔离')}</div></div>`;
      modal({
        title: `${t('添加模型')} → ${p.name}`, body,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('校验并添加')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            const btn = mask.querySelector('[data-save]');
            const name = mask.querySelector('#m_name').value.trim();
            if (!name) { toast(t('请填写模型名称'), 'err'); return; }
            btn.disabled = true; btn.textContent = t('真实调用校验中…');
            try {
              const j = await api(`/providers/${p.id}/models`, { method: 'POST', body: { model: name, type: mask.querySelector('#m_type').value } });
              toast(j.msg || t('已添加')); close(); load();
            } catch (e) {
              toast(e.message, 'err');
              btn.disabled = false; btn.textContent = t('校验并添加');
            }
          };
        },
      });
    });
    el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
      b.textContent = t('同步中…'); b.disabled = true;
      try {
        const j = await api(`/providers/${b.dataset.sync}/sync`, { method: 'POST' });
        toast(t('同步成功：{n} 个模型').replace('{n}', j.data.count)); load();
      } catch (e) { toast(e.message, 'err'); b.textContent = t('同步模型'); b.disabled = false; }
    });
    el.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      b.textContent = t('测试中…'); b.disabled = true;
      try {
        const j = await api(`/providers/${b.dataset.test}/test`, { method: 'POST' });
        toast(`${j.data.ok ? '✅' : '❌'} ${j.data.msg}`, j.data.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      b.textContent = t('连通测试'); b.disabled = false;
    });
    el.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => {
      const j = await api(`/providers/${b.dataset.def}/default`, { method: 'POST' });
      toast(j.msg); load();
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除该供应商配置？'))) return;
      try {
        await api('/providers/' + b.dataset.del, { method: 'DELETE' });
        toast(t('已删除')); load();
      } catch (e) { toast(e.message, 'err'); }
    });
    el.querySelector('#newProv').onclick = () => openCfg(null);
  }

  function openCfg(id) {
    const p = id ? providers.find(x => x.id === id) : { name: '', base_url: '', api_key: '', models: [], remark: '' };
    let models = [];
    try { models = Array.isArray(p.models) ? p.models : JSON.parse(p.models || '[]'); } catch { }
    const body = `
      <div class="form-row">
        <div class="form-item"><label>${t('供应商名称')}<span class="req">*</span></label><input class="input" id="pv_name" value="${esc(p.name)}" placeholder="${t('如：深度求索')}"></div>
        <div class="form-item"><label>${t('OpenAI 兼容服务地址')}<span class="req">*</span></label><input class="input mono" id="pv_url" value="${esc(p.base_url)}" placeholder="https://api.deepseek.com"></div>
      </div>
      <div class="form-item"><label>API Key</label>
        <input class="input mono" id="pv_key" value="" placeholder="${id && p.api_key ? t('已配置（留空不修改，输入新 Key 可覆盖）') : 'sk-...'}" autocomplete="new-password">
        <div class="hint">${t('填写后该供应商即可真实调用；默认供应商将驱动全平台对话。P5.30 起列表不再回显完整 Key（仅前 3 后 4 位），留空即保持原 Key。')}</div>
      </div>
      <div class="form-item"><label>${t('模型列表（逗号分隔）')}</label>
        <input class="input mono" id="pv_models" value="${esc(models.join(', '))}" placeholder="deepseek-chat, deepseek-reasoner">
        <div class="hint">${t('保存后也可用「同步模型」按钮从 /models 接口自动拉取')}</div>
      </div>
      <div class="form-item"><label>${t('备注')}</label><input class="input" id="pv_remark" value="${esc(p.remark || '')}"></div>`;
    modal({
      title: id ? `${t('配置')} - ${p.name}` : t('接入新供应商'), body, wide: true,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const keyVal = mask.querySelector('#pv_key').value.trim(); // P5.30：留空=不修改 Key（后端掩码防御兑底）
            const payload = {
              name: mask.querySelector('#pv_name').value.trim(),
              base_url: mask.querySelector('#pv_url').value.trim(),
              models: mask.querySelector('#pv_models').value,
              remark: mask.querySelector('#pv_remark').value,
            };
            if (keyVal) payload.api_key = keyVal;
            if (id) await api('/providers/' + id, { method: 'PUT', body: payload });
            else await api('/providers', { method: 'POST', body: payload });
            toast(t('已保存') + (keyVal ? t('（已启用真实调用）') : '')); close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    providers = (await api('/providers')).data;
    try { health = (await api('/providers/health')).data; } catch { health = { providers: [], open_circuits: [] }; }
    renderCards();
  }
  await load();
  // 健康状态每 15 秒刷新（不重载供应商列表，只更新徽标）
  const healthTimer = setInterval(async () => {
    try {
      health = (await api('/providers/health')).data;
      renderCards();
    } catch { /* 静默 */ }
  }, 15000);
  // 页面切换时清理定时器（SPA 下避免泄漏）
  el.dataset.cleanup = '1';
  window.addEventListener('hashchange', () => clearInterval(healthTimer), { once: true });
}
