/** 后台-MCP 服务管理：注册 MCP Server（Streamable HTTP）、测试连接、刷新工具清单；P3 增加「服务端」信息卡与令牌管理 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

export async function render(el) {
  let servers = [];
  let srvInfo = null;
  let tokens = [];

  el.innerHTML = `
    <div class="page-head"><h2>MCP 服务</h2><div class="desc">注册 MCP（Model Context Protocol）服务器，智能体可挂载其工具能力（Streamable HTTP 传输）；支持连接测试与工具清单刷新。平台自身也可作为 MCP Server 向外提供已发布智能体（见下方服务端卡）。</div></div>

    <div class="card" style="margin-bottom:16px;border-left:4px solid #7c3aed">
      <div class="toolbar">
        <h3 style="margin:0">🟢 平台 MCP Server（对外提供智能体）</h3>
        <div>
          <button class="btn primary" id="newToken">＋ 生成访问令牌</button>
        </div>
      </div>
      <div id="srvInfoBox" style="font-size:13px;line-height:1.9;color:var(--text-2);margin-bottom:12px">加载中…</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>令牌</th><th>名称</th><th>状态</th><th>调用次数</th><th>最近使用</th><th>操作</th></tr></thead>
        <tbody id="tokenBody"></tbody>
      </table></div>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px">💡 在 Claude Code / Cursor / Cherry Studio 等 MCP 客户端添加自定义 Streamable HTTP 服务器：URL 填上方端点，鉴权头填 Authorization: Bearer &lt;令牌&gt;，即可调用平台已发布智能体（工具名 agent_&lt;id&gt;）。</div>
    </div>

    <div class="card">
      <div class="toolbar">
        <span id="mcpCount" style="color:var(--text-2)">已注册 ${servers.length} 个 MCP 服务（协议：JSON-RPC 2.0 over HTTP，兼容 SSE 响应）</span>
        <button class="btn primary" id="newSrv">＋ 注册 MCP 服务</button>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">🔒 风险分级（P5.32/P5.34）：工具徽标「读」（绿）=只读，服务器被信任后对话中免确认；「写」（橙）=写类/未知，始终需确认。带 ✎ 虚线框=管理员手动定级（优先于启发式）；点击徽标可循环 自动→低→高→自动。</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>名称</th><th>URL</th><th>状态</th><th>工具数</th><th>工具清单</th><th>最近检查</th><th>操作</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:16px;border-left:4px solid var(--brand)">
      <h3 style="margin-bottom:8px">📘 使用说明</h3>
      <div style="font-size:13px;color:var(--text-2);line-height:1.9">
        1. 注册 MCP Server 的 Streamable HTTP 端点（如 <span class="mono">https://your-mcp.com/mcp</span>），如需鉴权可填 Bearer Token；<br>
        2. 点击「刷新工具」拉取服务端工具清单（initialize → tools/list）；<br>
        3. 在「智能体管理 → 编辑智能体」的 MCP 挂载区勾选该服务，对话时智能体即可自主调用其工具（工具名自动加 <span class="mono">mcp_</span> 前缀，避免重名冲突）。
      </div>
    </div>`;

  function rows() {
    el.querySelector('#tbody').innerHTML = servers.map(s => `
      <tr>
        <td><b>${esc(s.name)}</b></td>
        <td class="mono" style="max-width:260px;word-break:break-all;font-size:12px">${esc(s.url)}</td>
        <td>${s.status ? '<span class="tag green">启用</span>' : '<span class="tag gray">停用</span>'}${s.trusted ? ' <span class="tag purple" title="只读工具免确认执行">🤝 已信任</span>' : ''}${s.last_error ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">${esc(s.last_error.slice(0, 60))}</div>` : ''}</td>
        <td><b>${s.toolNames?.length || 0}</b></td>
        <td style="font-size:12px;color:var(--text-2)">${s.toolList?.length ? s.toolList.map(t => {
          const lv = t.override || 'auto';
          const cls = t.risk === 'low' ? 'green' : 'orange';
          const mark = t.override ? (t.risk === 'low' ? '·读✎' : '·写✎') : (t.risk === 'low' ? '·读' : '·写');
          const tip = t.override
            ? `管理员已定级：${t.risk === 'low' ? '低风险（trusted 后免确认）' : '高风险（始终需确认）'}；点击切回自动`
            : `启发式判定：${t.risk === 'low' ? '只读（trusted 后免确认）' : '写类/未知（始终需确认）'}；点击手动定级`;
          return `<span class="tag ${cls}" data-trk="${s.id}" data-tool="${esc(t.name)}" data-lv="${lv}" style="font-size:10px;margin:1px;cursor:pointer;${t.override ? 'outline:1px dashed currentColor;outline-offset:1px;' : ''}" title="${esc(tip)}">${esc(t.name)}${mark}</span>`;
        }).join('') : '-'}</td>
        <td style="color:var(--text-3);font-size:12px">${esc(s.last_check_at || '-')}</td>
        <td>
          <button class="btn link" data-rf="${s.id}">刷新工具</button>
          <button class="btn link" data-tr="${s.id}">${s.trusted ? '取消信任' : '信任'}</button>
          <button class="btn link" data-tg="${s.id}">${s.status ? '停用' : '启用'}</button>
          <button class="btn link" data-ed="${s.id}">编辑</button>
          <button class="btn link" style="color:var(--danger)" data-del="${s.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无 MCP 服务</td></tr>';

    el.querySelectorAll('[data-rf]').forEach(b => b.onclick = async () => {
      b.textContent = '刷新中…'; b.disabled = true;
      try {
        const j = await api(`/mcp/${b.dataset.rf}/refresh`, { method: 'POST' });
        toast(`连接成功，发现 ${j.data.count} 个工具（低风险 ${j.data.tools.filter(t => t.risk === 'low').length} 个）`, 'ok');
        load();
      } catch (e) { toast(e.message, 'err'); b.textContent = '刷新工具'; b.disabled = false; }
    });
    // P5.32 信任开关：trusted=1 时该服务的只读（低风险）工具在对话中免确认执行
    el.querySelectorAll('[data-tr]').forEach(b => b.onclick = async () => {
      const s = servers.find(x => x.id === +b.dataset.tr);
      const next = s.trusted ? 0 : 1;
      if (next && !await confirmBox(`信任「${s.name}」？信任后其只读类工具（绿徽标）在对话「默认权限」下不再弹确认卡；写类工具（橙徽标）仍需确认。仅信任你了解且可控的服务。`)) return;
      await api(`/mcp/${s.id}`, { method: 'PUT', body: { trusted: next } });
      toast(next ? '已信任（只读工具免确认）' : '已取消信任（全部恢复确认）'); load();
    });
    el.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
      const s = servers.find(x => x.id === +b.dataset.tg);
      await api(`/mcp/${s.id}`, { method: 'PUT', body: { status: s.status ? 0 : 1 } });
      toast('已切换'); load();
    });
    el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => openEdit(+b.dataset.ed));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该 MCP 服务？已挂载它的智能体将自动解除挂载。')) return;
      await api('/mcp/' + b.dataset.del, { method: 'DELETE' });
      toast('已删除'); load();
    });
  }

  function openEdit(id) {
    const s = id ? servers.find(x => x.id === id) : { name: '', url: '', api_key_set: 0, trusted: 0 };
    const body = `
      <div class="form-item"><label>服务名称<span class="req">*</span></label><input class="input" id="m_name" value="${esc(s.name)}" placeholder="如：企业工具中心"></div>
      <div class="form-item"><label>Streamable HTTP 端点<span class="req">*</span></label>
        <input class="input mono" id="m_url" value="${esc(s.url)}" placeholder="https://your-mcp.com/mcp">
        <div class="hint">MCP Server 的 HTTP 端点；本机部署可填 http://127.0.0.1:端口/mcp</div>
      </div>
      <div class="form-item"><label>Bearer Token${s.api_key_set ? '（已配置，留空不修改）' : ''}</label>
        <input class="input mono" id="m_key" type="password" placeholder="服务端鉴权 Token（可选）"></div>
      <div class="form-item" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="m_trusted" ${s.trusted ? 'checked' : ''} style="width:auto">
        <label for="m_trusted" style="margin:0">信任该服务（其只读类工具在对话「默认权限」下免确认执行；写类工具仍需确认）</label>
      </div>`;
    modal({
      title: id ? '编辑 MCP 服务' : '注册 MCP 服务', body,
      foot: `<button class="btn" data-cancel>取消</button>${id ? '' : '<button class="btn" data-test>测试连接</button>'}<button class="btn primary" data-save>保存</button>`,
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        const testBtn = mask.querySelector('[data-test]');
        if (testBtn) testBtn.onclick = async () => {
          testBtn.disabled = true; testBtn.textContent = '测试中…';
          try {
            const j = await api('/mcp/probe', { method: 'POST', body: { url: mask.querySelector('#m_url').value.trim(), api_key: mask.querySelector('#m_key').value } });
            toast(`连接成功，发现 ${j.data.count} 个工具：${j.data.tools.map(t => t.name).join(', ') || '（无）'}`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
          testBtn.disabled = false; testBtn.textContent = '测试连接';
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
            if (!payload.name || !payload.url) return toast('名称与 URL 必填', 'err');
            if (id) await api('/mcp/' + id, { method: 'PUT', body: payload });
            else await api('/mcp', { method: 'POST', body: payload });
            toast('已保存'); close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  el.querySelector('#newSrv').onclick = () => openEdit(null);

  // ================= P3：平台 MCP Server 服务端（令牌管理） =================
  function renderSrvInfo() {
    if (!srvInfo) { el.querySelector('#srvInfoBox').innerHTML = '服务端信息加载失败'; return; }
    const agentTags = (srvInfo.tools || []).map(t => `<span class="tag purple" style="font-size:10px;margin:1px">${esc(t.name)} · ${esc(t.agent)}</span>`).join('') || '<span style="color:var(--text-3)">（暂无已发布智能体）</span>';
    el.querySelector('#srvInfoBox').innerHTML = `
      <div>端点：<span class="mono" style="padding:2px 8px;background:var(--surface-3);border-radius:6px">${esc(srvInfo.endpoint)}</span>　协议：${esc(srvInfo.protocol)}　鉴权：<span class="mono">${esc(srvInfo.auth)}</span></div>
      <div style="margin-top:4px">可调用工具（已发布智能体）：${agentTags}</div>`;
  }

  function renderTokens() {
    el.querySelector('#tokenBody').innerHTML = tokens.map(t => `
      <tr>
        <td class="mono" style="font-size:12px">${esc(t.token)}</td>
        <td>${esc(t.name)}</td>
        <td>${t.status ? '<span class="tag green">启用</span>' : '<span class="tag gray">停用</span>'}</td>
        <td>${t.calls || 0}</td>
        <td style="color:var(--text-3);font-size:12px">${esc(t.last_used_at || '-')}</td>
        <td>
          <button class="btn link" data-ttg="${t.id}">${t.status ? '停用' : '启用'}</button>
          <button class="btn link" style="color:var(--danger)" data-tdel="${t.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无令牌，点击右上角「生成访问令牌」</td></tr>';
    el.querySelectorAll('[data-ttg]').forEach(b => b.onclick = async () => {
      await api('/mcp-server/tokens/' + b.dataset.ttg, { method: 'PATCH' });
      toast('已切换'); loadTokens();
    });
    el.querySelectorAll('[data-tdel]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该 MCP 访问令牌？使用它的客户端将立即失去访问权限。')) return;
      await api('/mcp-server/tokens/' + b.dataset.tdel, { method: 'DELETE' });
      toast('已删除'); loadTokens();
    });
  }

  el.querySelector('#newToken').onclick = () => {
    const body = `
      <div class="form-item"><label>令牌备注名</label><input class="input" id="t_name" placeholder="如：Claude Code 接入 / 部门网关"></div>`;
    modal({
      title: '生成 MCP 访问令牌', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>生成</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const j = await api('/mcp-server/tokens', { method: 'POST', body: { name: mask.querySelector('#t_name').value.trim() } });
            close();
            modal({
              title: '令牌已生成（仅展示一次，请立即保存）',
              body: `<div class="form-item"><label>访问令牌</label>
                <input class="input mono" id="tk_full" readonly value="${esc(j.data.token)}">
                <div class="hint">客户端配置：URL <span class="mono">${esc(srvInfo?.endpoint || '')}</span>，请求头 <span class="mono">Authorization: Bearer ${esc(j.data.token)}</span></div></div>`,
              foot: '<button class="btn primary" data-copy>复制令牌</button><button class="btn" data-cancel>关闭</button>',
              onMount(m2, close2) {
                m2.querySelector('[data-copy]').onclick = () => {
                  m2.querySelector('#tk_full').select();
                  document.execCommand('copy');
                  toast('已复制', 'ok');
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
    el.querySelector('#mcpCount').textContent = `已注册 ${servers.length} 个 MCP 服务（协议：JSON-RPC 2.0 over HTTP，兼容 SSE 响应）`;
    rows();
  }
  await Promise.all([load(), loadSrvInfo(), loadTokens()]);
}
