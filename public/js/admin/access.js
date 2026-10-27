/** 后台-接入管理：第三方智能体平台（Coze/Dify）纳管 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

const TYPE_LABEL = { coze: 'Coze 扣子', dify: 'Dify', custom: '自定义' };

export async function render(el) {
  let platforms = [];

  el.innerHTML = `
    <div class="page-head"><h2>接入管理</h2><div class="desc">对接外部智能体平台（字节扣子 Coze、Dify 等），同步其智能体到本平台统一纳管；支持连接测试与重新同步。</div></div>
    <div class="card">
      <div class="toolbar">
        <span style="color:var(--text-2)">已接入 ${platforms.length} 个平台</span>
        <button class="btn primary" id="newPlat">＋ 新建接入</button>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>配置名称</th><th>平台类型</th><th>服务地址</th><th>状态</th><th>纳管智能体</th><th>最近同步</th><th>操作</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table></div>
    </div>`;

  function rows() {
    el.querySelector('#tbody').innerHTML = platforms.map(p => `
      <tr>
        <td><b>${esc(p.name)}</b></td>
        <td><span class="tag ${p.type === 'coze' ? 'blue' : 'purple'}">${TYPE_LABEL[p.type] || p.type}</span></td>
        <td class="mono">${esc(p.endpoint)}</td>
        <td>${p.status ? '<span class="badge-dot on"></span>启用' : '<span class="badge-dot off"></span>停用'}</td>
        <td><b>${p.agent_count ?? 0}</b> 个<span style="color:var(--text-3);font-size:12px">（同步 ${p.synced} 次）</span></td>
        <td style="color:var(--text-3);font-size:12px">${esc(p.last_sync_at || '-')}</td>
        <td>
          <button class="btn link" data-jump="${p.id}" title="${esc(p.build_url || '未配置搭建页地址')}">前往搭建</button>
          <button class="btn link" data-test="${p.id}">测试连接</button>
          <button class="btn link" data-sync="${p.id}">重新同步</button>
          <button class="btn link" data-ed="${p.id}">编辑</button>
          <button class="btn link" style="color:var(--danger)" data-del="${p.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无接入配置</td></tr>';

    el.querySelectorAll('[data-jump]').forEach(b => b.onclick = async () => {
      const p = platforms.find(x => x.id === +b.dataset.jump);
      try {
        const j = await api(`/platforms/${p.id}/jump`, { method: 'POST' });
        window.open(j.data.url, '_blank', 'noopener');
        toast(`已跳转到 ${p.name} 搭建页`, 'info');
      } catch (e) { toast(e.message, 'err'); }
    });

    el.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      b.textContent = '测试中…'; b.disabled = true;
      try {
        const j = await api(`/platforms/${b.dataset.test}/test`, { method: 'POST' });
        toast(j.data.msg, j.data.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      b.textContent = '测试连接'; b.disabled = false;
    });
    el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
      b.textContent = '同步中…'; b.disabled = true;
      try {
        const j = await api(`/platforms/${b.dataset.sync}/sync`, { method: 'POST' });
        toast(j.data.msg || `同步完成：新增 ${j.data.added} 个智能体`, j.data.real ? 'ok' : 'info');
        b.textContent = '重新同步'; b.disabled = false;
        load();
      } catch (e) { toast(e.message, 'err'); b.textContent = '重新同步'; b.disabled = false; }
    });
    el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => openEdit(+b.dataset.ed));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该接入配置？')) return;
      await api('/platforms/' + b.dataset.del, { method: 'DELETE' });
      toast('已删除'); load();
    });
  }

  function openEdit(id) {
    const p = id ? platforms.find(x => x.id === id) : { name: '', type: 'coze', endpoint: '', token: '', build_url: '', console_email: '', console_pwd_set: 0 };
    const placeholder = p.type === 'coze' ? 'https://www.coze.cn/space' : p.type === 'dify' ? 'https://your-dify.com/apps' : 'https://…';
    const isDify = p.type === 'dify';
    const body = `
      <div class="form-row">
        <div class="form-item"><label>配置名称<span class="req">*</span></label><input class="input" id="p_name" value="${esc(p.name)}" placeholder="如：字节扣子团队版"></div>
        <div class="form-item"><label>平台类型</label>
          <select class="input" id="p_type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-item"><label>API 服务地址<span class="req">*</span></label><input class="input mono" id="p_endpoint" value="${esc(p.endpoint)}" placeholder="https://api.coze.cn"></div>
      <div class="form-item"><label>搭建页地址（Web 工作台）</label>
        <input class="input mono" id="p_build" value="${esc(p.build_url || '')}" placeholder="${placeholder}">
        <div class="hint">用于「外挂搭建」跳转的浏览器工作台地址，留空则按类型自动填默认值（Coze → 官方开发空间 coze.cn/space；Dify 自部署 → 服务地址去 /v1 加 /apps，官方中文站 → dify.ai/zh（国内可达）；海外云端版 cloud.dify.ai 需代理）</div>
      </div>
      <div class="form-item"><label id="tokenLabel">${p.type === 'coze' ? '个人访问令牌 PAT' : 'API Token'}</label><input class="input mono" id="p_token" value="${esc(p.token || '')}" placeholder="${p.type === 'coze' ? 'pat_ 开头的个人访问令牌' : '平台 API 密钥'}"></div>
      <div id="difyCred" style="display:${isDify ? '' : 'none'}">
        <div class="form-row">
          <div class="form-item"><label>Dify 控制台邮箱</label><input class="input mono" id="p_cemail" value="${esc(p.console_email || '')}" placeholder="admin@example.com"></div>
          <div class="form-item"><label>Dify 控制台密码${p.console_pwd_set ? ' <span class="tag green" style="font-size:10px">已配置</span>' : ''}</label><input class="input mono" id="p_cpwd" type="password" placeholder="${p.console_pwd_set ? '已配置，留空则不修改' : '填写后启用真同步'}"></div>
        </div>
        <div class="hint" style="background:#f0f9ff;border:1px dashed #93c5fd;border-radius:8px;padding:10px 12px;line-height:1.7">🔐 配置控制台账号后，「同步智能体」将真实拉取该 Dify 实例的应用清单并为每个应用自动获取 Service API Key，同步后的智能体可在本平台直接对话（真实转发到 Dify）。密码仅存本地数据库，不会同步给任何第三方。</div>
      </div>
      <div id="cozeCred" style="display:${p.type === 'coze' ? '' : 'none'}">
        <div class="hint" style="background:#f0f9ff;border:1px dashed #93c5fd;border-radius:8px;padding:10px 12px;line-height:1.7">🔐 配置个人访问令牌（PAT）后，「重新同步」将真实遍历你的扣子工作空间拉取智能体(Bot)清单并纳管到本平台，对话时真实转发到扣子。PAT 创建：扣子官网「API 管理 → 个人访问令牌 → 添加」，过期时间选 30 天，权限勾选「团队空间管理 + Bot 管理 + 对话」，生成的 pat_ 开头令牌粘贴到上方 API Token 框。令牌仅存本地数据库。</div>
      </div>
      <div class="hint">接入指引：在目标平台获取 API Token → 填写服务地址 → 测试连接 → 保存后同步智能体；「前往搭建」可直接跳转外部平台搭建智能体。</div>`;
    modal({
      title: id ? '编辑接入' : '新建接入', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        const typeSel = mask.querySelector('#p_type');
        typeSel.onchange = () => {
          mask.querySelector('#difyCred').style.display = typeSel.value === 'dify' ? '' : 'none';
          mask.querySelector('#cozeCred').style.display = typeSel.value === 'coze' ? '' : 'none';
          mask.querySelector('#tokenLabel').textContent = typeSel.value === 'coze' ? '个人访问令牌 PAT' : 'API Token';
        };
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const payload = {
              name: mask.querySelector('#p_name').value.trim(),
              type: typeSel.value,
              endpoint: mask.querySelector('#p_endpoint').value.trim(),
              build_url: mask.querySelector('#p_build').value.trim(),
              token: mask.querySelector('#p_token').value,
            };
            if (typeSel.value === 'dify') {
              payload.console_email = mask.querySelector('#p_cemail').value.trim();
              const pwd = mask.querySelector('#p_cpwd').value;
              if (pwd !== '') payload.console_password = pwd; // 留空不改已有密码
            }
            if (id) await api('/platforms/' + id, { method: 'PUT', body: payload });
            else await api('/platforms', { method: 'POST', body: payload });
            toast('已保存'); close(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  el.querySelector('#newPlat').onclick = () => openEdit(null);

  async function load() { platforms = (await api('/platforms')).data; el.querySelector('.toolbar span').textContent = `已接入 ${platforms.length} 个平台`; rows(); }
  await load();
}
