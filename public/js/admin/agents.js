/** 后台-智能体管理：列表（卡片/表格）+ 空间 + 测评 + 外挂搭建 */
import { api, getToken } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let agents = [], spaces = [], evals = [], models = [], kbs = [], platforms = [], mcpServers = [];
  let tab = 'list';

  el.innerHTML = `
    <div class="page-head"><h2>${t('智能体管理')}</h2><div class="desc">${t('智能体全生命周期管理：列表（发布/下架/编辑）、空间（企业-部门-个人三级）、AI 自动测评；复杂编排可经「外挂搭建」跳转 Coze/Dify 等专业平台搭建后同步回来统一纳管。')}</div></div>
    <div class="tabs" id="tabs">
      <div class="tab active" data-t="list">${t('智能体列表')}</div>
      <div class="tab" data-t="space">${t('空间管理')}</div>
      <div class="tab" data-t="eval">${t('智能体测评')}</div>
      <div class="tab" data-t="external">${t('外挂搭建')}</div>
    </div>
    <div id="pane"></div>`;

  const pane = el.querySelector('#pane');
  const typeName = { enterprise: '企业智能体', digital: '数字员工', dept: '部门AI助理', other: '其他' };

  // ---------- 列表 ----------
  function renderList() {
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <div class="filters">
            <select class="input" id="f_status"><option value="">${t('全部状态')}</option><option value="published">${t('已发布')}</option><option value="review">${t('审核中')}</option><option value="rejected">${t('已驳回')}</option><option value="draft">${t('草稿/下架')}</option></select>
            <select class="input" id="f_type"><option value="">${t('全部类型')}</option><option value="enterprise">${t('企业智能体')}</option><option value="digital">${t('数字员工')}</option><option value="dept">${t('部门AI助理')}</option><option value="other">${t('其他')}</option></select>
            <input class="input" id="f_kw" placeholder="🔍 ${t('搜索名称')}">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="fromTpl">📚 ${t('从模板创建')}</button>
            <button class="btn" id="importCfg">📥 ${t('导入配置')}</button>
            <button class="btn primary" id="createAgent">＋ ${t('创建智能体')}</button>
          </div>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('名称')}</th><th>${t('类型')}</th><th>${t('模型')}</th><th>${t('知识库')}</th><th>${t('来源')}</th><th>${t('状态')}</th><th>${t('更新时间')}</th><th>${t('操作')}</th></tr></thead>
          <tbody id="tbody"></tbody>
        </table></div>
      </div>`;

    function rows() {
      const st = pane.querySelector('#f_status').value, tp = pane.querySelector('#f_type').value, kw = pane.querySelector('#f_kw').value.trim();
      const shown = agents.filter(a =>
        (!st || a.status === st) && (!tp || a.type === tp) && (!kw || a.name.includes(kw)));
      pane.querySelector('#tbody').innerHTML = shown.map(a => `
        <tr>
          <td><b>${a.icon ? a.icon + ' ' : ''}${esc(a.name)}</b><div style="font-size:11px;color:var(--text-3)">${esc(a.description || '')}</div></td>
          <td><span class="tag ${a.type === 'enterprise' ? 'blue' : a.type === 'dept' ? 'purple' : a.type === 'other' ? 'gray' : 'green'}">${typeName[a.type] ? t(typeName[a.type]) : a.type}</span></td>
          <td class="mono">${esc(a.model || '-')}</td>
          <td>${a.kb_id ? '📚 ' + esc(kbs.find(k => k.id === a.kb_id)?.name || t('已关联')) : '<span style="color:var(--text-3)">-</span>'}</td>
          <td>${a.source === 'self' ? `<span class="tag gray">${t('自建')}</span>` : `<span class="tag orange">${esc(a.source_name || a.source)}</span>`}</td>
          <td>${a.status === 'published' ? `<span class="tag green">${t('已发布')}</span>` : a.status === 'review' ? `<span class="tag orange">${t('审核中')}</span>` : a.status === 'rejected' ? `<span class="tag red" title="${esc(a.review_comment || '')}">${t('已驳回')}</span>` : `<span class="tag gray">${t('草稿')}</span>`}${a.status === 'rejected' && a.review_comment ? `<div style="font-size:11px;color:var(--danger);margin-top:3px">${esc(a.review_comment.slice(0, 60))}${a.review_comment.length > 60 ? '…' : ''}</div>` : ''}</td>
          <td style="color:var(--text-3);font-size:12px">${esc((a.updated_at || '').slice(0, 16))}</td>
          <td>
            ${a.status === 'review' ? `
            <button class="btn link" style="color:var(--success,#059669)" data-rv-approve="${a.id}">${t('通过')}</button>
            <button class="btn link" style="color:var(--danger)" data-rv-reject="${a.id}">${t('驳回')}</button>` : `<button class="btn link" data-pb="${a.id}">${a.status === 'published' ? t('下架') : a.status === 'rejected' ? t('重新发布') : t('发布')}</button>`}
            <button class="btn link" data-ed="${a.id}">${t('编排')}</button>
            <button class="btn link" data-analytics="${a.id}">${t('分析')}</button>
            <button class="btn link" data-apidoc="${a.id}" title="${t('接口文档：参数/输出/调用示例由画布 Start/End 节点自动生成')}">${t('文档')}</button>
            <button class="btn link" data-api="${a.id}">API</button>
            <button class="btn link" data-share="${a.id}">${a.share_enabled ? t('分享中') : t('分享')}</button>
            <button class="btn link" data-embed="${a.id}" title="${t('嵌入代码：iframe / JS 浮窗两种（需已发布+已分享+域名白名单）')}">${t('嵌入')}</button>
            <button class="btn link" data-export="${a.id}">${t('导出')}</button>
            <button class="btn link" style="color:var(--danger)" data-del="${a.id}">${t('删除')}</button>
          </td>
        </tr>`).join('') || `<tr><td colspan="8" class="empty">${t('暂无数据')}</td></tr>`;

      pane.querySelectorAll('[data-pb]').forEach(b => b.onclick = async () => {
        const j = await api(`/agents/${b.dataset.pb}/publish`, { method: 'POST' });
        toast(j.msg); load();
      });
      // V3.1 #12 审核操作：通过（复用发布逻辑）/ 驳回（必填意见）
      pane.querySelectorAll('[data-rv-approve]').forEach(b => b.onclick = async () => {
        if (!await confirmBox(t('确认审核通过并发布该智能体？'))) return;
        const j = await api(`/agents/${b.dataset.rvApprove}/review`, { method: 'POST', body: { action: 'approve' } });
        toast(j.msg); load();
      });
      pane.querySelectorAll('[data-rv-reject]').forEach(b => b.onclick = () => openReject(+b.dataset.rvReject));
      pane.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => { location.hash = '#/admin/studio/' + b.dataset.ed; });
      pane.querySelectorAll('[data-apidoc]').forEach(b => b.onclick = () => openApiDoc(+b.dataset.apidoc));
      pane.querySelectorAll('[data-api]').forEach(b => b.onclick = () => openApiKeys(+b.dataset.api));
      pane.querySelectorAll('[data-analytics]').forEach(b => b.onclick = () => openAnalytics(+b.dataset.analytics));
      pane.querySelectorAll('[data-export]').forEach(b => b.onclick = () => exportAgent(+b.dataset.export));
      pane.querySelectorAll('[data-share]').forEach(b => b.onclick = () => openShare(+b.dataset.share));
      pane.querySelectorAll('[data-embed]').forEach(b => b.onclick = () => openEmbed(+b.dataset.embed));
      pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!await confirmBox(t('删除该智能体？关联会话将保留但无法继续对话。'))) return;
        await api(`/agents/${b.dataset.del}`, { method: 'DELETE' });
        toast(t('已删除')); load();
      });
    }
    ['#f_status', '#f_type'].forEach(s => pane.querySelector(s).onchange = rows);
    pane.querySelector('#f_kw').oninput = rows;
    pane.querySelector('#createAgent').onclick = openCreate;
    pane.querySelector('#fromTpl').onclick = openTemplates;
    pane.querySelector('#importCfg').onclick = importAgentCfg;
    rows();
  }

  // ---------- V3.1 #12 嵌入代码（2026-11-03）：域名白名单管理 + iframe/JS 浮窗两种 snippet ----------
  async function openEmbed(id) {
    const a = agents.find(x => x.id === id);
    if (!a) return;
    let domains = String(a.embed_domains || '').split(',').map(s => s.trim()).filter(Boolean);
    const m = modal({
      title: t('嵌入代码：{n}').replace('{n}', a.name),
      body: `
        <div style="font-size:12.5px;line-height:1.7;color:var(--text-2);margin-bottom:12px">
          ${t('将该智能体嵌入第三方站点（对话能力直接在你的网站可用）。')}<b>${t('安全前置')}</b>：${t('已发布 + 已开启分享 + 配置域名白名单——未列入白名单的域名会被 CSP 拒绝嵌入（防点击劫持/盗用）。')}
        </div>
        <div class="form-item"><label>${t('允许嵌入的域名白名单（逗号或换行分隔，至多 20 个，纯域名不带 https://）')}</label>
          <textarea class="input" id="embDomains" rows="2" placeholder="${t('例如：www.example.com, portal.example.com')}">${esc(domains.join(', '))}</textarea>
        </div>
        <div style="display:flex;gap:8px;margin:10px 0 14px">
          <button class="btn" id="embSave">${t('保存域名白名单')}</button>
          <button class="btn primary" id="embGen">${t('生成嵌入代码')}</button>
        </div>
        <div id="embOut"></div>`,
      foot: `<button class="btn" data-close>${t('关闭')}</button>`,
      onMount(mask) {
        mask.querySelector('#embSave').onclick = async () => {
          try {
            const j = await api(`/agents/${id}/embed-config`, { method: 'POST', body: { domains: mask.querySelector('#embDomains').value } });
            toast(j.msg || t('已保存'));
            if (j.code === 0) { domains = j.data?.domains || []; a.embed_domains = domains.join(','); }
          } catch (e) { toast(e.message, 'err'); }
        };
        const copy = (txt, btn) => {
          navigator.clipboard?.writeText(txt).then(() => { btn.textContent = t('已复制 ✓'); setTimeout(() => btn.textContent = t('复制'), 1500); });
        };
        const renderOut = (d) => {
          const out = mask.querySelector('#embOut');
          out.innerHTML = `
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">✅ ${t('已允许域名：')}${d.domains.map(esc).join('、')}${t('（CSP 即刻生效，域名变更后需重新保存）')}</div>
            <label style="font-size:12px;font-weight:600">${t('方式一：iframe 直嵌（推荐，简单可控）')}</label>
            <div style="display:flex;gap:6px;align-items:flex-start;margin:4px 0 10px">
              <pre class="mono" style="flex:1;font-size:11px;background:var(--surface-2,#f8fafc);border:1px solid var(--border,#eef0f4);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;max-height:110px;overflow:auto;margin:0">${esc(d.iframe)}</pre>
              <button class="btn" id="cpIframe">${t('复制')}</button>
            </div>
            <label style="font-size:12px;font-weight:600">${t('方式二：JS 浮窗（右下角对话球，点击展开）')}</label>
            <div style="display:flex;gap:6px;align-items:flex-start;margin:4px 0 2px">
              <pre class="mono" style="flex:1;font-size:11px;background:var(--surface-2,#f8fafc);border:1px solid var(--border,#eef0f4);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;margin:0">${esc(d.script)}</pre>
              <button class="btn" id="cpScript">${t('复制')}</button>
            </div>
            <div style="font-size:11px;color:var(--text-3)">${esc(d.note || '')}</div>`;
          out.querySelector('#cpIframe').onclick = e => copy(d.iframe, e.target);
          out.querySelector('#cpScript').onclick = e => copy(d.script, e.target);
        };
        mask.querySelector('#embGen').onclick = async () => {
          try {
            // rawResponse：业务码 400（前置缺失引导）不抛错，由本处按 need 字段渲染引导而非 toast
            const j = await api(`/agents/${id}/embed-code`, { rawResponse: true });
            if (j.code === 0) return renderOut(j.data);
            // 前置缺失引导（need 字段：publish / share / domains）
            const need = j.data?.need;
            const out = mask.querySelector('#embOut');
            out.innerHTML = `<div style="font-size:12.5px;color:var(--warn,#b45309);background:var(--surface-3,#fffbeb);border:1px solid #fde68a;border-radius:8px;padding:8px 12px">⚠️ ${esc(j.msg || t('无法生成'))}${need === 'domains' ? t('——上方填写域名并点「保存域名白名单」后再生成') : need === 'share' ? t('——先在列表「分享」按钮开启分享链接') : need === 'publish' ? t('——先发布该智能体') : ''}</div>`;
          } catch (e) { toast(e.message, 'err'); }
        };
        // 已有白名单时自动生成一次（省一次点击）
        if (domains.length) mask.querySelector('#embGen').click();
      },
    });
  }

  // ---------- V3.1 #12 审核流（2026-11-03）：驳回弹窗（必填意见，提审人可据此整改重提） ----------
  function openReject(id) {
    const a = agents.find(x => x.id === id);
    const m = modal({
      title: t('驳回审核：{n}').replace('{n}', a ? a.name : id),
      body: `
        <div style="font-size:12.5px;line-height:1.7;color:var(--text-2);margin-bottom:12px">
          ${t('驳回后智能体转为「已驳回」状态（提审人可见驳回意见，修改后可重新提审）。')}
        </div>
        <div class="form-item"><label>${t('审核意见（必填，将通知提审人）')}</label>
          <textarea class="input" id="rvComment" rows="3" placeholder="${t('例如：开场白包含未授权承诺，请调整后再提交')}"></textarea></div>`,
      foot: `<button class="btn" data-close>${t('取消')}</button><button class="btn primary" id="rvSubmit">${t('确认驳回')}</button>`,
      onMount(mask) {
        mask.querySelector('#rvSubmit').onclick = async () => {
          const comment = mask.querySelector('#rvComment').value.trim();
          if (!comment) return toast(t('驳回必须填写审核意见'), 'err');
          try {
            const j = await api(`/agents/${id}/review`, { method: 'POST', body: { action: 'reject', comment } });
            toast(j.msg || t('已驳回')); m.close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  // ---------- P5.16 API 文档自动生成（Swagger 风格，Start/End 节点 → 参数/输出/调用示例，发布即有零手写） ----------
  async function openApiDoc(id) {
    const j = await api(`/agents/${id}/apidoc`);
    if (j.code !== 0) return toast(j.msg || t('文档生成失败'), 'err');
    const d = j.data, c = d.contract;
    const typeTag = (tp) => tp === 'file' ? '<span class="tag orange">📄 file-id</span>'
      : tp === 'array[file]' ? '<span class="tag orange">📄 file-id[]</span>'
      : tp === 'number' ? '<span class="tag blue">number</span>'
      : tp === 'array' ? '<span class="tag blue">array</span>'
      : '<span class="tag gray">string</span>';
    const paramRow = (p) => `<tr>
      <td class="mono">${esc(p.name)}${p.type === 'file' || p.type === 'array[file]' ? ' 📄' : ''}</td>
      <td>${typeTag(p.type)}</td>
      <td>${p.required ? `<b style="color:var(--danger)">${t('必填')}</b>` : `<span style="color:var(--text-3)">${t('可选')}</span>`}</td>
      <td>${esc(p.label || '')}${p.default ? ` <span style="color:var(--text-3)">${t('默认')} ${esc(String(p.default).slice(0, 20))}</span>` : ''}</td>
      <td style="color:var(--text-3)">${esc(p.hint || '')}</td></tr>`;
    const outRow = (o) => `<tr>
      <td class="mono">${esc(o.name)}</td>
      <td>${typeTag(o.type)}</td>
      <td style="color:var(--text-3)">${esc(o.desc || '')}</td>
      <td style="color:var(--text-3)">${esc(o.source || '')}</td></tr>`;
    const chanBlock = (ch) => `<div class="api-ep">
      <div class="api-ep-head"><span class="m">POST</span><span class="mono url">${esc(ch.endpoint)}</span><span style="flex:1"></span>${ch.key === 'mcp' ? `<span class="tag green">${t('推荐 · 完整参数')}</span>` : `<span class="tag gray">${t('对话式')}</span>`}</div>
      <div style="font-size:12px;color:var(--text-2);margin:6px 0 2px">${esc(ch.name)} · ${esc(ch.protocol || '')}</div>
      <div style="font-size:11.5px;color:var(--text-3)">🔐 ${esc(ch.auth || '')}</div>
      ${ch.tool ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">🧰 ${t('工具名：')}<span class="mono">${esc(ch.tool)}</span>${ch.model ? ` · model：<span class="mono">${esc(ch.model)}</span>` : ''}</div>` : ''}
      ${(ch.steps || []).length ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${ch.steps.map((s, i) => `${i + 1}. ${esc(s)}`).join('　')}</div>` : ''}
      ${ch.note ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">ℹ️ ${esc(ch.note)}</div>` : ''}
      <pre class="api-curl" data-copy="${esc(ch.curl)}">${esc(ch.curl)}</pre>
    </div>`;
    const body = `<div style="font-size:12.5px;line-height:1.7">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <b style="font-size:14px">${esc(d.agent.name)} ${t('接口文档')}</b>
        ${d.agent.status === 'published' ? `<span class="tag green">${t('已发布')}</span>` : `<span class="tag orange">${t('草稿（文档预览）')}</span>`}
        ${c.isCanvas ? `<span class="tag blue">${c.flowType === 'chatflow' ? t('Chatflow 多轮') : t('Workflow 一次性')}</span>` : `<span class="tag gray">${t('表单模式')}</span>`}
        <span style="flex:1"></span>
        <span style="font-size:11px;color:var(--text-3)">${t('由画布 Start/End 节点自动生成 · 改画布即同步 · 无需手写')}</span>
      </div>
      <div style="color:var(--text-2);margin-bottom:10px">${esc(d.agent.description || '')}</div>
      <div class="api-sec">📥 ${t('请求参数（Start 节点变量）')}</div>
      <table class="tbl api-tbl"><thead><tr><th>${t('字段')}</th><th>${t('类型')}</th><th>${t('必填')}</th><th>${t('说明')}</th><th>${t('备注')}</th></tr></thead>
        <tbody>${c.input.map(paramRow).join('')}</tbody></table>
      <div class="api-sec">📤 ${t('响应字段（End / 直接回复节点）')}</div>
      <table class="tbl api-tbl"><thead><tr><th>${t('字段')}</th><th>${t('类型')}</th><th>${t('说明')}</th><th>${t('来源')}</th></tr></thead>
        <tbody>${c.output.map(outRow).join('')}</tbody></table>
      ${d.fileUpload ? `<div class="api-sec">📎 ${t('文件参数上传（file 类型先取 ID）')}</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.8">
          <span class="mono">${esc(d.fileUpload.endpoint)}</span>　${esc(d.fileUpload.returns)}<br>
          <span style="color:var(--text-3)">body：${esc(d.fileUpload.body)}</span></div>` : ''}
      <div class="api-sec">🔌 ${t('调用通道')}</div>
      ${d.channels.map(chanBlock).join('')}
      <div class="api-sec">📜 ${t('OpenAPI 3.0 规范（JSON）')}</div>
      <details style="margin-top:2px"><summary style="cursor:pointer;font-size:12px;color:var(--brand,#2563eb)">${t('展开查看 / 复制完整 OpenAPI JSON（可导入 Swagger Editor / Apifox）')}</summary>
        <pre class="api-curl" data-copy="${esc(JSON.stringify(d.openapi, null, 2))}" style="max-height:340px">${esc(JSON.stringify(d.openapi, null, 2))}</pre></details>
    </div>`;
    modal({ title: t('📄 接口文档：{n}').replace('{n}', esc(d.agent.name)), body, wide: true, noFooter: true });
    // 复制按钮：每个 pre 右上角浮出（curl / OpenAPI JSON）
    setTimeout(() => {
      document.querySelectorAll('.api-curl[data-copy]').forEach(pre => {
        const btn = document.createElement('button');
        btn.className = 'btn sm'; btn.textContent = t('复制');
        btn.style.cssText = 'position:absolute;top:6px;right:8px;opacity:.75';
        pre.style.position = 'relative';
        pre.appendChild(btn);
        btn.onclick = async () => {
          const raw = pre.getAttribute('data-copy') || '';
          try { await navigator.clipboard.writeText(raw); toast(t('已复制到剪贴板')); } catch { toast(t('复制失败，请手动选择'), 'err'); }
        };
      });
    }, 50);
  }

  // ---------- 导出 / 导入配置（借鉴 SinguX：备份、迁移、招投标交付） ----------
  async function exportAgent(id) {
    const a = agents.find(x => x.id === id);
    if (!a) return;
    const res = await fetch(`/api/agents/${id}/export`, { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!res.ok) return toast(t('导出失败'), 'err');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-${id}-${a.name}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast(t('配置已导出为 JSON'));
  }

  function importAgentCfg() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const cfg = JSON.parse(await file.text());
        if (!cfg.agent) return toast(t('不是有效的智能体配置文件（缺少 agent 字段）'), 'err');
        const nameOverride = cfg.agent.name || file.name.replace(/\.json$/i, '');
        const j = await api('/agents/import', { method: 'POST', body: { config: cfg, name_override: nameOverride } });
        toast(j.msg || t('已导入')); load();
      } catch (e) { toast(t('导入失败：') + e.message, 'err'); }
    };
    input.click();
  }

  // ---------- 智能体数据分析（借鉴 SinguX「分析」） ----------
  async function openAnalytics(id) {
    const a = agents.find(x => x.id === id);
    if (!a) return;
    const j = await api(`/agents/${id}/analytics`);
    const { overview, trend, recent } = j.data;
    const maxC = Math.max(1, ...trend.map(tw => tw.count));
    const cards = [
      ['💬 ' + t('会话数'), overview.sessions, t('内部会话')],
      ['👥 ' + t('使用人数'), overview.users, t('去重用户')],
      ['✉️ ' + t('消息数'), overview.messages, t('含分享 {n} 次').replace('{n}', overview.share_sessions)],
      ['🎯 ' + t('Token 消耗'), overview.tokens, t('累计')],
      ['⚡ ' + t('平均响应'), (overview.avg_latency / 1000).toFixed(1) + 's', t('全链路')],
    ];
    const body = `
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px">
        ${cards.map(([tc, v, s]) => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);padding:12px;text-align:center">
            <div style="font-size:12px;color:var(--text-3)">${tc}</div>
            <div style="font-size:22px;font-weight:700;color:var(--brand);margin:4px 0">${v}</div>
            <div style="font-size:11px;color:var(--text-3)">${s}</div>
          </div>`).join('')}
      </div>
      <div style="font-weight:600;margin-bottom:8px">📈 ${t('近 14 天会话趋势')}</div>
      <div style="display:flex;align-items:flex-end;gap:4px;height:90px;margin-bottom:16px;padding:0 4px">
        ${trend.length ? trend.map(tw => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px" title="${tw.day}：${tw.count} ${t('个会话')}">
            <div style="font-size:10px;color:var(--text-3)">${tw.count || ''}</div>
            <div style="width:100%;background:linear-gradient(180deg,#3b82f6,#2563eb);border-radius:3px 3px 0 0;height:${Math.max(6, tw.count / maxC * 60)}px"></div>
            <div style="font-size:9px;color:var(--text-3);transform:scale(.85)">${tw.day.slice(5)}</div>
          </div>`).join('') : `<div style="color:var(--text-3);font-size:12px;padding:20px 0">${t('近 14 天暂无会话')}</div>`}
      </div>
      <div style="font-weight:600;margin-bottom:8px">${t('🕘 最近会话（{n}）').replace('{n}', recent.length)}</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('会话')}</th><th>${t('用户')}</th><th>${t('消息数')}</th><th>${t('最近活跃')}</th></tr></thead>
        <tbody>${recent.map(s => `
          <tr><td>${esc(s.title || '#' + s.id)}</td><td>${esc(s.nickname || '-')}</td><td>${s.msg_count}</td><td style="font-size:12px;color:var(--text-3)">${esc((s.updated_at || '').slice(0, 16))}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">${t('暂无会话记录')}</td></tr>`}
        </tbody>
      </table></div>`;
    modal({ title: t('数据分析 - {n}').replace('{n}', a.name), body, wide: true });
  }

  // ---------- SinguX 式轻量创建：类型选择 → 名称/介绍/图标 → 创建后直接进入编排页 ----------
  const CREATE_TYPES = [
    { k: 'enterprise', icon: '🏢', label: t('企业智能体'), desc: t('面向全员的企业级问答与业务助手') },
    { k: 'digital', icon: '👤', label: t('数字员工'), desc: t('承担岗位化重复工作的 AI 员工') },
    { k: 'dept', icon: '🧑‍💼', label: t('部门 AI 助理'), desc: t('面向部门的专项事务助理') },
    { k: 'other', icon: '🧩', label: t('其他'), desc: t('通用助手或不属于上述类型的智能体') },
  ];
  const CREATE_ICONS = ['🤖', '🎯', '📝', '💡', '📊', '🛠️', '🌐', '📚', '✍️', '🧩', '🧠', '💼', '🛡️', '📈', '🎨', '🎬', '⚖️', '🏦', '💬', '🔍'];
  function openCreate() {
    let selType = 'enterprise', selIcon = '🤖';
    const body = `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px">${t('选择类型')}</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          ${CREATE_TYPES.map(ct => `
            <div class="ctype-card" data-ct="${ct.k}" style="border:1.5px solid ${selType === ct.k ? 'var(--brand)' : 'var(--border)'};border-radius:10px;padding:12px 10px;text-align:center;cursor:pointer;background:${selType === ct.k ? '#f0f7ff' : '#fff'}">
              <div style="font-size:24px">${ct.icon}</div>
              <div style="font-size:13px;font-weight:600;margin:4px 0 2px">${ct.label}</div>
              <div style="font-size:10px;color:var(--text-3);line-height:1.4">${ct.desc}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="form-item"><label>${t('智能体名称')}<span class="req">*</span></label>
        <input class="input" id="c_name" maxlength="50" placeholder="${t('给智能体起一个独一无二的名字')}">
        <div class="hint" id="c_cnt">0 / 50</div></div>
      <div class="form-item"><label>${t('智能体功能介绍')}</label>
        <textarea class="input" id="c_desc" rows="2" placeholder="${t('介绍智能体的功能，将会展示给智能体的用户')}"></textarea></div>
      <div class="form-item"><label>${t('图标')}</label>
        <div id="c_icons" style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px">
          ${CREATE_ICONS.map(ic => `<span data-ci="${ic}" style="font-size:18px;text-align:center;padding:5px 0;border-radius:6px;cursor:pointer;${ic === selIcon ? 'background:var(--brand);color:#fff' : ''}">${ic}</span>`).join('')}
        </div></div>
      <div class="hint" style="background:#f0f9ff;border:1px dashed #93c5fd;border-radius:8px;padding:10px 12px;line-height:1.7">
        💡 ${t('创建后自动进入')}<b>${t('编排页')}</b>${t('：提示词、工具、知识库、记忆、开场白等全部在那里配置（修改实时生效，右侧可直接调试对话）。')}
      </div>`;
    modal({
      title: t('创建智能体'), body,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('创建并进入编排')}</button>`,
      onMount(mask, close) {
        const nameEl = mask.querySelector('#c_name');
        const cnt = mask.querySelector('#c_cnt');
        nameEl.oninput = () => { cnt.textContent = `${nameEl.value.length} / 50`; };
        mask.querySelectorAll('[data-ct]').forEach(card => card.onclick = () => {
          selType = card.dataset.ct;
          mask.querySelectorAll('[data-ct]').forEach(x => {
            const on = x === card;
            x.style.borderColor = on ? 'var(--brand)' : 'var(--border)';
            x.style.background = on ? '#f0f7ff' : '#fff';
          });
        });
        mask.querySelectorAll('[data-ci]').forEach(sp => sp.onclick = () => {
          selIcon = sp.dataset.ci;
          mask.querySelectorAll('[data-ci]').forEach(x => {
            x.style.background = x === sp ? 'var(--brand)' : '';
            x.style.color = x === sp ? '#fff' : '';
          });
        });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const name = nameEl.value.trim();
          if (!name) return toast(t('请填写智能体名称'), 'err');
          const btn = mask.querySelector('[data-save]');
          btn.disabled = true;
          try {
            const j = await api('/agents', { method: 'POST', body: {
              name, description: mask.querySelector('#c_desc').value.trim(), type: selType, icon: selIcon,
            } });
            toast(t('创建成功，正在进入编排页…'));
            close();
            location.hash = '#/admin/studio/' + j.data.id;
          } catch (e) {
            // 商业化：免费版智能体数达上限 → 升级引导弹窗（直达价格页）
            if (e.code === 402 || /免费版最多/.test(e.message || '')) {
              close();
              modal({
                title: t('🚀 升级解锁更多智能体'),
                body: `<div style="font-size:13px;line-height:1.9;color:var(--text-2)">${esc(e.message)}<br><br>${t('专业版（¥199/月）可创建')} <b style="color:var(--text)">${t('20 个智能体')}</b>${t('、每月')} <b style="color:var(--text)">${t('500 万 Tokens')}</b>${t('、10 个知识库与 API 开放接口。')}</div>`,
                foot: `<button class="btn" data-close>${t('暂不升级')}</button><a class="btn primary" href="#/pricing" id="goPricing" style="text-decoration:none">${t('查看套餐并升级 →')}</a>`,
                onMount(mask2, close2) { mask2.querySelector('[data-close]').onclick = close2; },
              });
            } else { toast(e.message, 'err'); btn.disabled = false; }
          }
        };
      },
    });
  }

  // ---------- 行业模板库 ----------
  async function openTemplates() {
    const j = await api('/templates');
    const tpls = j.data;
    const body = `
      <div class="hint" style="margin-bottom:12px">📚 ${t('金融行业预置模板：一键创建开箱即用的专业智能体（提示词/工具/开场白已预配置，创建后可再编辑）')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${tpls.map(tpl => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);padding:14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:22px">${tpl.icon}</span>
              <div><b>${esc(tpl.name)}</b><div style="font-size:11px;color:var(--text-3)">${esc(tpl.industry)} · ${tpl.type === 'digital' ? t('数字员工') : t('企业智能体')}</div></div>
            </div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:8px">${esc(tpl.description)}</div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:10px">${t('工具：')}${tpl.tools.length ? esc(tpl.tools.join('、')) : t('无')}${tpl.opening_questions?.length ? t('｜预置问题 {n} 条').replace('{n}', tpl.opening_questions.length) : ''}</div>
            <button class="btn primary" data-tpl="${tpl.id}" style="padding:4px 14px;font-size:12px">${t('从此模板创建')}</button>
          </div>`).join('')}
      </div>`;
    modal({ title: t('行业模板库'), body, wide: true, onMount(mask) {
      mask.querySelectorAll('[data-tpl]').forEach(b => b.onclick = async () => {
        try {
          const j2 = await api(`/templates/${b.dataset.tpl}/create`, { method: 'POST', body: { kb_id: kbs[0]?.id || null } });
          toast(t('已创建「{n}」，可在列表中编辑').replace('{n}', j2.data.name)); load();
        } catch (e) { toast(e.message, 'err'); }
      });
    } });
  }

  // ---------- API 发布（OpenAI 兼容密钥管理） ----------
  function openApiKeys(id) {
    const a = agents.find(x => x.id === id);
    const modelId = `agent-${a.id}-${a.name}`;
    loadKeys().then(keys => {
      const body = `
        <div class="hint" style="background:#f0f9ff;border:1px dashed #93c5fd;border-radius:8px;padding:10px 12px;line-height:1.8;margin-bottom:12px">
          🔌 <b>${t('OpenAI 兼容接口')}</b>${t('：外部系统可直接调用该智能体。')}<br>
          ${t('端点：')}<span class="mono" style="word-break:break-all">POST ${location.origin}/openapi/v1/chat/completions</span><br>
          ${t('模型名：')}<span class="mono">${esc(modelId)}</span>${t('（先 GET /openapi/v1/models 可列出全部可用智能体）')}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b>${t('API 密钥（{n}）').replace('{n}', keys.length)}</b>
          <button class="btn primary" id="akNew" style="padding:4px 12px;font-size:12px">＋ ${t('创建密钥')}</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('名称')}</th><th>${t('密钥')}</th><th>${t('状态')}</th><th>${t('最近调用')}</th><th>${t('操作')}</th></tr></thead>
          <tbody id="akBody">${keys.map(k => `
            <tr>
              <td>${esc(k.name)}</td>
              <td class="mono" style="font-size:12px">${esc(k.key.slice(0, 14))}…<button class="btn link" data-copy="${esc(k.key)}">${t('复制')}</button></td>
              <td>${k.status ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}</td>
              <td style="font-size:12px;color:var(--text-3)">${esc(k.last_used_at || '-')}</td>
              <td>
                <button class="btn link" data-tg="${k.id}">${k.status ? t('停用') : t('启用')}</button>
                <button class="btn link" style="color:var(--danger)" data-dk="${k.id}">${t('删除')}</button>
              </td>
            </tr>`).join('') || `<tr><td colspan="5" class="empty">${t('暂无密钥，点击右上角创建')}</td></tr>`}
          </tbody>
        </table></div>`;
      modal({ title: t('API 发布 - {n}').replace('{n}', a.name), body, wide: true, onMount(mask, close) {
        bindRows(mask);
        mask.querySelector('#akNew').onclick = async () => {
          const j = await api(`/agents/${id}/api-keys`, { method: 'POST', body: {} });
          copyText(j.data.key);
          modal({ title: t('密钥已创建（已复制）'), body: `<div class="form-item"><label>${t('请立即保存，仅此一次完整展示')}</label><textarea class="input mono" readonly style="min-height:70px">${esc(j.data.key)}</textarea></div>` });
          close(); openApiKeys(id);
        };
      } });
      async function loadKeys() { const j = await api(`/agents/${id}/api-keys`); return j.data; }
      function bindRows(mask) {
        mask.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
        mask.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
          const j = await api(`/agents/${id}/api-keys/${b.dataset.tg}/toggle`, { method: 'POST' });
          toast(j.msg); close(); openApiKeys(id);
        });
        mask.querySelectorAll('[data-dk]').forEach(b => b.onclick = async () => {
          if (!(await confirmBox(t('删除该密钥？使用中的调用将立即失效。')))) return;
          await api(`/agents/${id}/api-keys/${b.dataset.dk}`, { method: 'DELETE' });
          toast(t('已删除')); close(); openApiKeys(id);
        });
      }
    });
  }

  function copyText(txt) {
    navigator.clipboard?.writeText(txt).then(() => toast(t('已复制到剪贴板')), () => { });
  }

  // ---------- 分享链接 ----------
  function openShare(id) {
    const a = agents.find(x => x.id === id);
    if (a.share_enabled) {
      const url = `${location.origin}/share/${a.share_token}`;
      const iframe = `&lt;iframe src="${url}" width="100%" height="600" frameborder="0"&gt;&lt;/iframe&gt;`;
      const expText = a.share_expires_at
        ? `<span class="tag orange">${t('⏳ 有效期至 {n}').replace('{n}', esc(a.share_expires_at))}</span>`
        : `<span class="tag green">♾ ${t('永久有效')}</span>`;
      modal({
        title: t('分享中 - {n}').replace('{n}', a.name), wide: true,
        body: `
          <div class="form-item"><label>${t('分享链接（免登录，任何人可访问）')}</label>
            <div style="display:flex;gap:8px"><input class="input mono" readonly value="${esc(url)}"><button class="btn" id="cpUrl">${t('复制')}</button><a class="btn" href="${esc(url)}" target="_blank" style="text-decoration:none">${t('打开')}</a></div>
            <div style="margin-top:6px">${expText}</div>
          </div>
          <div class="form-item"><label>${t('调整有效期（借鉴临时会话：到期自动失效）')}</label>
            <div style="display:flex;gap:8px;align-items:center">
              <select class="input" id="expSel" style="width:160px">
                <option value="1">${t('1 天（临时试用）')}</option>
                <option value="7">${t('7 天（短期分享）')}</option>
                <option value="30">${t('30 天（项目周期）')}</option>
                <option value="0" selected>${t('永久有效')}</option>
              </select>
              <button class="btn" id="expApply">${t('应用')}</button>
            </div>
          </div>
          <div class="form-item"><label>${t('网页嵌入（iframe 挂件）')}</label>
            <textarea class="input mono" readonly style="min-height:64px">${iframe}</textarea>
          </div>
          <div class="hint">⚠ ${t('关闭分享或到期后链接立即失效；对话仍经过平台安全合规检测（敏感词双向拦截）。')}</div>`,
        foot: `<button class="btn" data-cancel>${t('关闭')}</button><button class="btn" style="color:var(--danger)" data-off>${t('停止分享')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('#cpUrl').onclick = () => copyText(url);
          mask.querySelector('#expApply').onclick = async () => {
            await api(`/agents/${id}/share`, { method: 'POST', body: { enable: true, expires_days: +mask.querySelector('#expSel').value } });
            toast(t('有效期已更新')); close(); load();
          };
          mask.querySelector('[data-off]').onclick = async () => {
            await api(`/agents/${id}/share`, { method: 'POST', body: { enable: false } });
            toast(t('已停止分享')); close(); load();
          };
        },
      });
    } else {
      modal({
        title: t('开启分享 - {n}').replace('{n}', a.name),
        body: `<div class="hint" style="line-height:1.8">🔗 ${t('开启后生成免登录分享链接：')}<br>· ${t('可直接发给同事/客户在浏览器中对话')}<br>· ${t('可用 iframe 嵌入任意内部网页')}<br>· ${t('对话仍受平台安全合规策略保护（敏感词拦截与脱敏）')}<br>· ${t('仅已发布状态的智能体可分享')}</div>
          <div class="form-item" style="margin-top:10px"><label>${t('有效期')}</label>
            <select class="input" id="expSel">
              <option value="7">${t('7 天（短期分享，到期自动失效）')}</option>
              <option value="1">${t('1 天（临时试用）')}</option>
              <option value="30">${t('30 天（项目周期）')}</option>
              <option value="0">${t('永久有效')}</option>
            </select>
          </div>`,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-on>${t('开启分享')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-on]').onclick = async () => {
            if (a.status !== 'published') return toast(t('请先发布该智能体'), 'err');
            await api(`/agents/${id}/share`, { method: 'POST', body: { enable: true, expires_days: +mask.querySelector('#expSel').value } });
            toast(t('分享已开启')); close(); load();
          };
        },
      });
    }
  }

  // ---------- 空间 ----------
  function renderSpace() {
    const tname = { enterprise: t('企业空间'), dept: t('部门空间'), personal: t('个人空间') };
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <span style="color:var(--text-2)">${t('空间是智能体的承载单元，决定可见范围与权限（当前 {n} 个）').replace('{n}', spaces.length)}</span>
          <button class="btn primary" id="newSpace">＋ ${t('新建空间')}</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('空间名称')}</th><th>${t('类型')}</th><th>${t('所有者')}</th><th>${t('成员数')}</th><th>${t('智能体数')}</th><th>${t('创建时间')}</th><th>${t('操作')}</th></tr></thead>
          <tbody>${spaces.map(s => `
            <tr>
              <td><b>${esc(s.name)}</b></td>
              <td><span class="tag ${s.type === 'enterprise' ? 'blue' : s.type === 'dept' ? 'purple' : 'gray'}">${tname[s.type] || s.type}</span></td>
              <td>${esc(s.owner || '-')}</td>
              <td>${s.members}</td>
              <td>${agents.filter(a => a.space_id === s.id).length}</td>
              <td style="color:var(--text-3);font-size:12px">${esc(s.created_at)}</td>
              <td>
                <button class="btn link" data-ed="${s.id}">${t('编辑')}</button>
                <button class="btn link" style="color:var(--danger)" data-del="${s.id}">${t('删除')}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    pane.querySelector('#newSpace').onclick = openSpace(null);
    pane.querySelectorAll('[data-ed]').forEach(b => b.onclick = openSpace(+b.dataset.ed));
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除该空间？'))) return;
      await api('/agents/spaces/' + b.dataset.del, { method: 'DELETE' });
      toast(t('已删除')); load();
    });

    function openSpace(id) {
      const s = id ? spaces.find(x => x.id === id) : { name: '', type: 'dept', owner: '', members: 1 };
      const body = `
        <div class="form-item"><label>${t('空间名称')}<span class="req">*</span></label><input class="input" id="s_name" value="${esc(s.name)}"></div>
        <div class="form-row">
          <div class="form-item"><label>${t('类型')}</label><select class="input" id="s_type">${Object.entries(tname).map(([k, v]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="form-item"><label>${t('所有者')}</label><input class="input" id="s_owner" value="${esc(s.owner || '')}"></div>
        </div>
        <div class="form-item"><label>${t('成员数')}</label><input class="input" id="s_members" type="number" min="1" value="${s.members}"></div>`;
      return () => modal({
        title: id ? t('编辑空间') : t('新建空间'), body,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            try {
              const payload = { name: mask.querySelector('#s_name').value, type: mask.querySelector('#s_type').value, owner: mask.querySelector('#s_owner').value, members: +mask.querySelector('#s_members').value };
              if (id) await api('/agents/spaces/' + id, { method: 'PUT', body: payload });
              else await api('/agents/spaces', { method: 'POST', body: payload });
              toast(t('已保存')); close(); load();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    }
  }

  // ---------- 测评 ----------
  function renderEval() {
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <span style="color:var(--text-2)">${t('规则提示词 + 数据集 → AI 批量自动测评并打分')}</span>
          <button class="btn primary" id="newEval">＋ ${t('新建测评')}</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('测评名称')}</th><th>${t('评测对象')}</th><th>${t('得分')}</th><th>${t('时间')}</th><th>${t('操作')}</th></tr></thead>
          <tbody>${evals.map(e => `
            <tr>
              <td><b>${esc(e.name)}</b></td>
              <td>🤖 ${esc(e.agent_name || '-')}</td>
              <td><b style="color:${e.score >= 80 ? 'var(--success)' : e.score >= 60 ? 'var(--warning)' : 'var(--danger)'}">${e.score}</b> / 100</td>
              <td style="color:var(--text-3);font-size:12px">${esc(e.created_at)}</td>
              <td>
                <button class="btn link" data-view="${e.id}">${t('查看结果')}</button>
                <button class="btn link" style="color:var(--danger)" data-del="${e.id}">${t('删除')}</button>
              </td>
            </tr>`).join('') || `<tr><td colspan="5" class="empty">${t('暂无测评任务')}</td></tr>`}
          </tbody>
        </table></div>
      </div>`;
    pane.querySelector('#newEval').onclick = () => {
      const body = `
        <div class="form-item"><label>${t('测评名称')}<span class="req">*</span></label><input class="input" id="v_name" placeholder="${t('如：制度问答准确性测评')}"></div>
        <div class="form-item"><label>${t('评测对象')}<span class="req">*</span></label>
          <select class="input" id="v_agent">${agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
        <div class="form-item"><label>${t('规则提示词')}</label>
          <textarea class="input" id="v_rule" placeholder="${t('评分规则，如：与参考答案语义一致得 1 分，部分正确 0.5 分，编造 0 分')}">${t('若回答与参考答案语义一致得 1 分，答非所问或编造得 0 分，部分正确得 0.5 分。')}</textarea></div>
        <div class="form-item"><label>${t('数据集（JSON 数组：问题 + 参考答案）')}<span class="req">*</span></label>
          <textarea class="input mono" id="v_data" style="min-height:130px">[
  {"q": "${t('一线城市住宿报销上限是多少？')}", "expect": "${t('500元/晚')}"},
  {"q": "${t('年假怎么申请？')}", "expect": "${t('提前三天 OA 申请')}"}
]</textarea>
          <div class="hint">${t('演示评分逻辑：按参考答案关键词命中率自动打分')}</div>
        </div>`;
      modal({
        title: t('新建测评'), body, wide: true,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-run>${t('开始测评')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-run]').onclick = async () => {
            const btn = mask.querySelector('[data-run]');
            btn.disabled = true; btn.textContent = t('测评执行中…');
            try {
              const j = await api('/agents/evaluations', {
                method: 'POST',
                body: {
                  name: mask.querySelector('#v_name').value.trim(),
                  agent_id: +mask.querySelector('#v_agent').value,
                  rule_prompt: mask.querySelector('#v_rule').value,
                  dataset: mask.querySelector('#v_data').value,
                },
              });
              toast(t('测评完成，得分 {n}').replace('{n}', j.data.score));
              close(); load();
            } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = t('开始测评'); }
          };
        },
      });
    };
    pane.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      const e = evals.find(x => x.id === +b.dataset.view);
      let results = [];
      try { results = JSON.parse(e.result || '[]'); } catch { }
      modal({
        title: t('测评结果 - {n}（{s} 分）').replace('{n}', e.name).replace('{s}', e.score),
        body: results.map(r => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px">
              <b>Q：${esc(r.q)}</b><span class="tag ${r.score >= 1 ? 'green' : r.score > 0 ? 'orange' : 'red'}">${r.score * 100}${t('分')}</span>
            </div>
            <div style="font-size:13px;color:var(--text-2)">${t('期望：')}${esc(r.expect || '-')}</div>
            <div style="font-size:13px;margin-top:4px">${t('回答：')}${esc(r.got)}</div>
          </div>`).join(''),
      });
    });
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除该测评记录？'))) return;
      await api('/agents/evaluations/' + b.dataset.del, { method: 'DELETE' });
      toast(t('已删除')); load();
    });
  }

  // ---------- 外挂搭建 ----------
  const TYPE_META = {
    coze: { label: t('Coze 扣子'), tag: 'blue', icon: '🧩', tip: t('适合工作流编排、插件生态丰富的智能体') },
    dify: { label: t('Dify'), tag: 'purple', icon: '🔧', tip: t('适合 RAG 应用、Agent 编排与私有化部署') },
    custom: { label: t('自定义平台'), tag: 'gray', icon: '🌐', tip: t('任意支持 API 的智能体平台') },
  };

  /** 演示占位/不可达地址识别（与后端 jump 校验同规则） */
  function isDemoUrl(u) {
    if (!u) return false;
    try { const h = new URL(u).hostname; return /(^|\.)example\.(com|org|net)$|\.invalid$|\.test$|^your-dify\./i.test(h); }
    catch { return /example\.(com|org|net)$|\.invalid$|\.test$/i.test(u); }
  }

  function renderExternal() {
    const enabled = platforms.filter(p => p.status);
    pane.innerHTML = `
      <div class="card" style="margin-bottom:16px;border-left:4px solid var(--brand)">
        <h3 style="margin-bottom:10px">🚀 ${t('外挂搭建引导')}</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:6px">
          ${[
      { n: '1', t: t('前往外部平台搭建'), d: t('点击下方平台卡片的「前往搭建」，跳转到 Coze / Dify 的编排工作台，利用其工作流、插件、多智能体能力完成搭建') },
      { n: '2', t: t('回到本平台同步'), d: t('搭建并发布后，点击卡片上的「同步智能体」（或前往接入管理），把外部智能体同步到本平台') },
      { n: '3', t: t('统一纳管使用'), d: t('同步的智能体出现在智能体列表（来源标记为外部平台），与内置智能体一样对话、统计与管理') },
    ].map(s => `
            <div style="background:#f8faff;border:1px solid var(--brand-light);border-radius:10px;padding:14px">
              <div style="font-weight:600;color:var(--brand-dark);margin-bottom:6px">${s.n}. ${s.t}</div>
              <div style="font-size:12px;color:var(--text-2);line-height:1.7">${s.d}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="grid-2" style="align-items:stretch">
        ${enabled.map(p => {
      const meta = TYPE_META[p.type] || TYPE_META.custom;
      return `
          <div class="card" style="display:flex;flex-direction:column">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <h3 style="margin:0">${meta.icon} ${esc(p.name)}
                <span class="tag ${meta.tag}">${meta.label}</span>
                ${p.status ? `<span class="tag green">${t('已启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}
              </h3>
              <span style="font-size:11px;color:var(--text-3)">${t('已同步 {n} 个智能体').replace('{n}', p.synced)}</span>
            </div>
            <div class="kv" style="margin-bottom:6px">
              <span class="k">${t('API 服务地址')}</span><span class="mono" style="word-break:break-all">${esc(p.endpoint || '-')}</span>
              <span class="k">${t('搭建页地址')}</span><span class="mono" style="word-break:break-all;${isDemoUrl(p.build_url) ? 'color:var(--danger);font-weight:600' : ''}">${esc(p.build_url || t('未配置（点「配置」填写）'))}${isDemoUrl(p.build_url) ? ' ⚠ ' + t('演示占位，请点「配置」改为真实地址') : ''}</span>
              <span class="k">${t('适用场景')}</span><span style="color:var(--text-2);font-size:12px">${meta.tip}</span>
              <span class="k">${t('最近同步')}</span><span style="color:var(--text-3);font-size:12px">${esc(p.last_sync_at || '-')}</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:auto;padding-top:14px;flex-wrap:wrap">
              <button class="btn primary" data-jump="${p.id}">🚀 ${t('前往搭建')}</button>
              <button class="btn" data-sync="${p.id}">🔄 ${t('同步智能体')}</button>
              <button class="btn" data-cfg="${p.id}">${t('配置')}</button>
              <a class="btn" href="#/admin/access" style="text-decoration:none">${t('接入管理 →')}</a>
            </div>
          </div>`;
    }).join('') || `<div class="empty-box" style="grid-column:1/-1"><div class="big">🔌</div>${t('暂无已启用的外部平台，请先前往「接入管理」配置 Coze / Dify')}</div>`}
      </div>`;

    pane.querySelectorAll('[data-jump]').forEach(b => b.onclick = async () => {
      const p = platforms.find(x => x.id === +b.dataset.jump);
      try {
        const j = await api(`/platforms/${p.id}/jump`, { method: 'POST' });
        window.open(j.data.url, '_blank', 'noopener');
        toast(t('已跳转到 {n} 搭建页，完成后回来点「同步智能体」').replace('{n}', p.name), 'info');
      } catch (e) { toast(e.message, 'err'); }
    });
    pane.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = t('同步中…');
      try {
        const j = await api(`/platforms/${b.dataset.sync}/sync`, { method: 'POST' });
        toast(t('同步完成：新增 {n} 个智能体，已进入智能体列表').replace('{n}', j.data.added));
        load();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = `🔄 ${t('同步智能体')}`; }
    });
    pane.querySelectorAll('[data-cfg]').forEach(b => b.onclick = () => {
      const p = platforms.find(x => x.id === +b.dataset.cfg);
      const meta = TYPE_META[p.type] || TYPE_META.custom;
      const body = `
        <div class="form-item"><label>${t('搭建页地址（Web 工作台）')}<span class="req">*</span></label>
          <input class="input mono" id="ex_url" value="${esc(p.build_url || '')}" placeholder="${p.type === 'coze' ? 'https://www.coze.cn/space' : p.type === 'dify' ? 'https://your-dify.com/apps' : 'https://…'}">
          <div class="hint">${t('浏览器打开的搭建工作台地址（与 API 服务地址不同）。')}${p.type === 'coze' ? t('官方默认：https://www.coze.cn/space，团队版私有化部署请填自己的域名') : p.type === 'dify' ? t('官方中文站 https://dify.ai/zh（国内可达）；自部署填 http://你的域名/apps') : ''}</div>
        </div>
        <div class="form-item"><label>${t('说明')}</label><div class="hint" style="font-size:13px;color:var(--text)">${meta.icon} ${esc(p.name)} · ${meta.label} · ${meta.tip}<br>${t('如需修改 API 服务地址 / Token / 启停，请前往「接入管理」。')}</div></div>`;
      modal({
        title: t('配置搭建入口 - {n}').replace('{n}', p.name), body,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            const url = mask.querySelector('#ex_url').value.trim();
            if (!url) return toast(t('请填写搭建页地址'), 'err');
            try {
              await api(`/platforms/${p.id}`, { method: 'PUT', body: { build_url: url } });
              toast(t('已保存')); close(); load();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    });
  }

  el.querySelectorAll('#tabs .tab').forEach(tb => tb.onclick = () => {
    el.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('active'));
    tb.classList.add('active');
    tab = tb.dataset.t;
    renderCurrent();
  });

  function renderCurrent() {
    tab === 'list' ? renderList() : tab === 'space' ? renderSpace() : tab === 'eval' ? renderEval() : renderExternal();
  }

  async function load() {
    const sp = window.__currentSpace || '';
    const sq = sp ? `?space_id=${sp}` : '';
    const [ja, js, je, jm, jk, jp, jmcp] = await Promise.all([
      api('/agents' + sq), api('/agents/spaces/list'), api('/agents/evaluations'), api('/chat/models'), api('/knowledge' + sq), api('/platforms'), api('/mcp'),
    ]);
    agents = ja.data; spaces = js.data; evals = je.data; models = jm.data; kbs = jk.data; platforms = jp.data; mcpServers = jmcp.data;
    renderCurrent();
  }
  await load();
}
