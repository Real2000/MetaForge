/** 后台-MCP 服务管理：注册 MCP Server（Streamable HTTP）、测试连接、刷新工具清单；P3 增加「服务端」信息卡与令牌管理 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let servers = [];
  let srvInfo = null;
  let tokens = [];

  el.innerHTML = `
    <div class="page-head"><h2>${t('MCP 服务')}</h2><div class="desc">${t('注册 MCP（Model Context Protocol）服务器，智能体可挂载其工具能力（Streamable HTTP 传输）；支持连接测试与工具清单刷新。平台自身也可作为 MCP Server 向外提供已发布智能体（见下方服务端卡）。')}</div></div>

    <div class="card" style="margin-bottom:16px;border-left:4px solid #7c3aed">
      <div class="toolbar">
        <h3 style="margin:0">🟢 ${t('平台 MCP Server（对外提供智能体）')}</h3>
        <div>
          <button class="btn primary" id="newToken">＋ ${t('生成访问令牌')}</button>
        </div>
      </div>
      <div id="srvInfoBox" style="font-size:13px;line-height:1.9;color:var(--text-2);margin-bottom:12px">${t('加载中…')}</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('令牌')}</th><th>${t('名称')}</th><th>${t('作用域')}</th><th>${t('状态')}</th><th>${t('调用次数')}</th><th>${t('最近使用')}</th><th>${t('操作')}</th></tr></thead>
        <tbody id="tokenBody"></tbody>
      </table></div>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px">💡 ${t('在 Claude Code / Cursor / Cherry Studio 等 MCP 客户端添加自定义 Streamable HTTP 服务器：URL 填上方端点，鉴权头填 Authorization: Bearer &lt;令牌&gt;，即可调用平台已发布智能体（工具名 agent_&lt;id&gt;）。')}</div>
    </div>

    <div class="card">
      <div class="toolbar">
        <span id="mcpCount" style="color:var(--text-2)">${t('已注册 {n} 个 MCP 服务（协议：JSON-RPC 2.0 over HTTP，兼容 SSE 响应）').replace('{n}', servers.length)}</span>
        <button class="btn primary" id="newSrv">＋ ${t('注册 MCP 服务')}</button>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">🔒 ${t('风险分级（P5.32/P5.34）：工具徽标「读」（绿）=只读，服务器被信任后对话中免确认；「写」（橙）=写类/未知，始终需确认。带 ✎ 虚线框=管理员手动定级（优先于启发式）；点击徽标可循环 自动→低→高→自动。')}</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('名称')}</th><th>URL</th><th>${t('状态')}</th><th>${t('工具数')}</th><th>${t('工具清单')}</th><th>${t('最近检查')}</th><th>${t('操作')}</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:16px;border-left:4px solid var(--brand)">
      <h3 style="margin-bottom:8px">📘 ${t('使用说明')}</h3>
      <div style="font-size:13px;color:var(--text-2);line-height:1.9">
        1. ${t('注册 MCP Server 的 Streamable HTTP 端点（如')} <span class="mono">https://your-mcp.com/mcp</span>），${t('如需鉴权可填 Bearer Token；')}<br>
        2. ${t('点击「刷新工具」拉取服务端工具清单（initialize → tools/list）；')}<br>
        3. ${t('在「智能体管理 → 编辑智能体」的 MCP 挂载区勾选该服务，对话时智能体即可自主调用其工具（工具名自动加')} <span class="mono">mcp_</span> ${t('前缀，避免重名冲突）。')}
      </div>
    </div>`;

  function rows() {
    el.querySelector('#tbody').innerHTML = servers.map(s => `
      <tr>
        <td><b>${esc(s.name)}</b></td>
        <td class="mono" style="max-width:260px;word-break:break-all;font-size:12px">${esc(s.url)}</td>
        <td>${s.status ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}${s.trusted ? ` <span class="tag purple" title="${t('只读工具免确认执行')}">🤝 ${t('已信任')}</span>` : ''}${s.last_error ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">${esc(s.last_error.slice(0, 60))}</div>` : ''}</td>
        <td><b>${s.toolNames?.length || 0}</b></td>
        <td style="font-size:12px;color:var(--text-2)">${s.toolList?.length ? s.toolList.map(tl => {
          const lv = tl.override || 'auto';
          const cls = tl.risk === 'low' ? 'green' : 'orange';
          const mark = tl.override ? (tl.risk === 'low' ? '·读✎' : '·写✎') : (tl.risk === 'low' ? '·读' : '·写');
          const tip = tl.override
            ? t('管理员已定级：{lv}；点击切回自动').replace('{lv}', tl.risk === 'low' ? t('低风险（trusted 后免确认）') : t('高风险（始终需确认）'))
            : t('启发式判定：{lv}；点击手动定级').replace('{lv}', tl.risk === 'low' ? t('只读（trusted 后免确认）') : t('写类/未知（始终需确认）'));
          return `<span class="tag ${cls}" data-trk="${s.id}" data-tool="${esc(tl.name)}" data-lv="${lv}" style="font-size:10px;margin:1px;cursor:pointer;${tl.override ? 'outline:1px dashed currentColor;outline-offset:1px;' : ''}" title="${esc(tip)}">${esc(tl.name)}${mark}</span>`;
        }).join('') : '-'}</td>
        <td style="color:var(--text-3);font-size:12px">${esc(s.last_check_at || '-')}</td>
        <td>
          <button class="btn link" data-rf="${s.id}">${t('刷新工具')}</button>
          <button class="btn link" data-tr="${s.id}">${s.trusted ? t('取消信任') : t('信任')}</button>
          <button class="btn link" data-tg="${s.id}">${s.status ? t('停用') : t('启用')}</button>
          <button class="btn link" data-ed="${s.id}">${t('编辑')}</button>
          <button class="btn link" style="color:var(--danger)" data-del="${s.id}">${t('删除')}</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="7" class="empty">${t('暂无 MCP 服务')}</td></tr>`;

    el.querySelectorAll('[data-rf]').forEach(b => b.onclick = async () => {
      b.textContent = t('刷新中…'); b.disabled = true;
      try {
        const j = await api(`/mcp/${b.dataset.rf}/refresh`, { method: 'POST' });
        toast(t('连接成功，发现 {n} 个工具（低风险 {m} 个）').replace('{n}', j.data.count).replace('{m}', j.data.tools.filter(tl => tl.risk === 'low').length), 'ok');
        load();
      } catch (e) { toast(e.message, 'err'); b.textContent = t('刷新工具'); b.disabled = false; }
    });
    // P5.32 信任开关：trusted=1 时该服务的只读（低风险）工具在对话中免确认执行
    el.querySelectorAll('[data-tr]').forEach(b => b.onclick = async () => {
      const s = servers.find(x => x.id === +b.dataset.tr);
      const next = s.trusted ? 0 : 1;
      if (next && !await confirmBox(t('信任「{name}」？信任后其只读类工具（绿徽标）在对话「默认权限」下不再弹确认卡；写类工具（橙徽标）仍需确认。仅信任你了解且可控的服务。').replace('{name}', s.name))) return;
      await api(`/mcp/${s.id}`, { method: 'PUT', body: { trusted: next } });
      toast(next ? t('已信任（只读工具免确认）') : t('已取消信任（全部恢复确认）')); load();
    });
    // P5.34 工具风险人工定级：点击徽标三态循环 自动→低→高→自动（✎+虚线框=已手动定级；人工值优先于启发式）
    el.querySelectorAll('[data-trk]').forEach(b => b.onclick = async () => {
      const cur = b.dataset.lv; // auto | low | high
      const next = cur === 'auto' ? 'low' : (cur === 'low' ? 'high' : 'auto');
      const tool = b.dataset.tool;
      const srv = servers.find(x => x.id === +b.dataset.trk);
      if (next === 'low' && srv && !srv.trusted && !await confirmBox(t('将「{tool}」定为低风险？注意：当前服务未信任（trusted=0），低风险定级需服务受信任后才会在对话中免确认。').replace('{tool}', tool))) return;
      if (next === 'high' && !await confirmBox(t('将「{tool}」定为高风险？该工具此后在对话中始终需要确认（即使服务已信任）。').replace('{tool}', tool))) return;
      try {
        const j = await api(`/mcp/${b.dataset.trk}/tool-risk`, { method: 'PUT', body: { tool, level: next } });
        toast(j.msg || t('已定级')); load();
      } catch (e) { toast(e.message, 'err'); }
    });
    el.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
      const s = servers.find(x => x.id === +b.dataset.tg);
      await api(`/mcp/${s.id}`, { method: 'PUT', body: { status: s.status ? 0 : 1 } });
      toast(t('已切换')); load();
    });
    el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => openEdit(+b.dataset.ed));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除该 MCP 服务？已挂载它的智能体将自动解除挂载。'))) return;
      await api('/mcp/' + b.dataset.del, { method: 'DELETE' });
      toast(t('已删除')); load();
    });
  }

  function openEdit(id) {
    const s = id ? servers.find(x => x.id === id) : { name: '', url: '', api_key_set: 0, trusted: 0 };
    const body = `
      <div class="form-item"><label>${t('服务名称')}<span class="req">*</span></label><input class="input" id="m_name" value="${esc(s.name)}" placeholder="${t('如：企业工具中心')}"></div>
      <div class="form-item"><label>${t('Streamable HTTP 端点')}<span class="req">*</span></label>
        <input class="input mono" id="m_url" value="${esc(s.url)}" placeholder="https://your-mcp.com/mcp">
        <div class="hint">${t('MCP Server 的 HTTP 端点；本机部署可填 http://127.0.0.1:端口/mcp')}</div>
      </div>
      <div class="form-item"><label>Bearer Token${s.api_key_set ? t('（已配置，留空不修改）') : ''}</label>
        <input class="input mono" id="m_key" type="password" placeholder="${t('服务端鉴权 Token（可选）')}"></div>
      <div class="form-item" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="m_trusted" ${s.trusted ? 'checked' : ''} style="width:auto">
        <label for="m_trusted" style="margin:0">${t('信任该服务（其只读类工具在对话「默认权限」下免确认执行；写类工具仍需确认）')}</label>
      </div>`;
    modal({
      title: id ? t('编辑 MCP 服务') : t('注册 MCP 服务'), body,
      foot: `<button class="btn" data-cancel>${t('取消')}</button>${id ? '' : `<button class="btn" data-test>${t('测试连接')}</button>`}<button class="btn primary" data-save>${t('保存')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        const testBtn = mask.querySelector('[data-test]');
        if (testBtn) testBtn.onclick = async () => {
          testBtn.disabled = true; testBtn.textContent = t('测试中…');
          try {
            const j = await api('/mcp/probe', { method: 'POST', body: { url: mask.querySelector('#m_url').value.trim(), api_key: mask.querySelector('#m_key').value } });
            toast(t('连接成功，发现 {n} 个工具：{tools}').replace('{n}', j.data.count).replace('{tools}', j.data.tools.map(tl => tl.name).join(', ') || t('（无）')), 'ok');
          } catch (e) { toast(e.message, 'err'); }
          testBtn.disabled = false; testBtn.textContent = t('测试连接');
        };
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const payload = {
              name: mask.querySelector('#m_name').value.trim(),
              url: mask.querySelector('#m_url').value.trim(),
              trusted: mask.querySelector('#m_trusted').checked ? 1 : 0,
            };
            const key = mask.querySelector('#m_key').value;
            if (key !== '') payload.api_key = key;
            if (!payload.name || !payload.url) return toast(t('名称与 URL 必填'), 'err');
            if (id) await api('/mcp/' + id, { method: 'PUT', body: payload });
            else await api('/mcp', { method: 'POST', body: payload });
            toast(t('已保存')); close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  el.querySelector('#newSrv').onclick = () => openEdit(null);

  // ================= P3：平台 MCP Server 服务端（令牌管理） =================
  function renderSrvInfo() {
    if (!srvInfo) { el.querySelector('#srvInfoBox').innerHTML = t('服务端信息加载失败'); return; }
    const agentTags = (srvInfo.tools || []).map(tp => `<span class="tag purple" style="font-size:10px;margin:1px">${esc(tp.name)} · ${esc(tp.agent)}</span>`).join('') || `<span style="color:var(--text-3)">${t('（暂无已发布智能体）')}</span>`;
    el.querySelector('#srvInfoBox').innerHTML = `
      <div>${t('端点：')}<span class="mono" style="padding:2px 8px;background:var(--surface-3);border-radius:6px">${esc(srvInfo.endpoint)}</span>　${t('协议：')}${esc(srvInfo.protocol)}　${t('鉴权：')}<span class="mono">${esc(srvInfo.auth)}</span></div>
      <div style="margin-top:4px">${t('可调用工具（已发布智能体）：')}${agentTags}</div>`;
  }

  function renderTokens() {
    el.querySelector('#tokenBody').innerHTML = tokens.map(tk => `
      <tr>
        <td class="mono" style="font-size:12px">${esc(tk.token)}</td>
        <td>${esc(tk.name)}</td>
        <td>${tk.status ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}</td>
        <td>${tk.calls || 0}</td>
        <td style="color:var(--text-3);font-size:12px">${esc(tk.last_used_at || '-')}</td>
        <td>
          <button class="btn link" data-ttg="${tk.id}">${tk.status ? t('停用') : t('启用')}</button>
          <button class="btn link" style="color:var(--danger)" data-tdel="${tk.id}">${t('删除')}</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="6" class="empty">${t('暂无令牌，点击右上角「生成访问令牌」')}</td></tr>`;
    el.querySelectorAll('[data-ttg]').forEach(b => b.onclick = async () => {
      await api('/mcp-server/tokens/' + b.dataset.ttg, { method: 'PATCH' });
      toast(t('已切换')); loadTokens();
    });
    el.querySelectorAll('[data-tdel]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除该 MCP 访问令牌？使用它的客户端将立即失去访问权限。'))) return;
      await api('/mcp-server/tokens/' + b.dataset.tdel, { method: 'DELETE' });
      toast(t('已删除')); loadTokens();
    });
  }

  el.querySelector('#newToken').onclick = () => {
    // P2-2：可选绑定智能体（作用域令牌）——下拉源用服务端信息卡的已发布智能体清单
    const agentOptions = (srvInfo?.tools || []).map(ta => `<option value="${ta.name.replace(/^agent_(\d+)-?.*$/, '$1')}">${esc(ta.agent)}（${esc(ta.name)}）</option>`).join('');
    const body = `
      <div class="form-item"><label>${t('令牌备注名')}</label><input class="input" id="t_name" placeholder="${t('如：Claude Code 接入 / 部门网关')}"></div>
      <div class="form-item"><label>${t('绑定智能体（作用域）')}</label><select class="input" id="t_agent">
        <option value="">${t('全域令牌（可调用全部已发布智能体）')}</option>${agentOptions}
      </select>
      <div class="hint">${t('推荐绑定单个智能体（最小授权）：令牌仅可调用绑定的智能体，泄露时影响面最小')}</div></div>`;
    modal({
      title: t('生成 MCP 访问令牌'), body,
      foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('生成')}</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const agentId = mask.querySelector('#t_agent').value || null;
            const j = await api('/mcp-server/tokens', { method: 'POST', body: { name: mask.querySelector('#t_name').value.trim(), agent_id: agentId } });
            close();
            modal({
              title: t('令牌已生成（仅展示一次，请立即保存）'),
              body: `<div class="form-item"><label>${t('访问令牌')}</label>
                <input class="input mono" id="tk_full" readonly value="${esc(j.data.token)}">
                <div class="hint">${t('客户端配置：URL {url}，请求头 {header}').replace('{url}', `<span class="mono">${esc(srvInfo?.endpoint || '')}</span>`).replace('{header}', `<span class="mono">Authorization: Bearer ${esc(j.data.token)}</span>`)}</div></div>`,
              foot: `<button class="btn primary" data-copy>${t('复制令牌')}</button><button class="btn" data-cancel>${t('关闭')}</button>`,
              onMount(m2, close2) {
                m2.querySelector('[data-copy]').onclick = () => {
                  m2.querySelector('#tk_full').select();
                  document.execCommand('copy');
                  toast(t('已复制'), 'ok');
                };
                m2.querySelector('[data-cancel]').onclick = close2;
              },
            });
            loadTokens();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };

  async function loadSrvInfo() {
    try { srvInfo = (await api('/mcp-server/info')).data; } catch { srvInfo = null; }
    renderSrvInfo();
  }
  async function loadTokens() {
    try { tokens = (await api('/mcp-server/tokens')).data || []; } catch { tokens = []; }
    renderTokens();
  }

  async function load() {
    servers = (await api('/mcp')).data;
    el.querySelector('#mcpCount').textContent = t('已注册 {n} 个 MCP 服务（协议：JSON-RPC 2.0 over HTTP，兼容 SSE 响应）').replace('{n}', servers.length);
    rows();
  }
  await Promise.all([load(), loadSrvInfo(), loadTokens()]);
}
