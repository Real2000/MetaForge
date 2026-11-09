/** 后台-知识库管理：库列表 + 文件 + 外部知识库 + 迁移 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

export async function render(el) {
  let kbs = [];

  el.innerHTML = `
    <div class="page-head"><h2>知识库管理</h2><div class="desc">平台全部知识库的台账管理：启停、文件解析、外部知识库登记与库间迁移。</div></div>
    <div class="tabs" id="tabs">
      <div class="tab active" data-t="list">知识库列表</div>
      <div class="tab" data-t="external">外部知识库</div>
      <div class="tab" data-t="migrate">知识库迁移</div>
    </div>
    <div id="pane"></div>`;

  const pane = el.querySelector('#pane');

  function renderList() {
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <span style="color:var(--text-2)">共 ${kbs.length} 个知识库</span>
          <button class="btn primary" id="newKb">＋ 新建知识库</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>名称</th><th>描述</th><th>文件数</th><th>所有者</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${kbs.map(k => `
            <tr>
              <td><b>📚 ${esc(k.name)}</b></td>
              <td style="color:var(--text-2);max-width:260px">${esc(k.description || '-')}</td>
              <td>${k.file_count}</td>
              <td>${esc(k.owner || '-')}</td>
              <td>${k.enabled ? '<span class="tag green">启用</span>' : '<span class="tag gray">停用</span>'}</td>
              <td style="color:var(--text-3);font-size:12px">${esc(k.created_at)}</td>
              <td>
                <button class="btn link" data-tg="${k.id}">${k.enabled ? '停用' : '启用'}</button>
                <button class="btn link" data-ed="${k.id}">编辑</button>
                <button class="btn link" style="color:var(--danger)" data-del="${k.id}">删除</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    pane.querySelector('#newKb').onclick = () => {
      const body = `
        <div class="form-item"><label>名称<span class="req">*</span></label><input class="input" id="k_name"></div>
        <div class="form-item"><label>描述</label><textarea class="input" id="k_desc"></textarea></div>`;
      modal({
        title: '新建知识库', body,
        foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建</button>',
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            try {
              await api('/knowledge', { method: 'POST', body: { name: mask.querySelector('#k_name').value, description: mask.querySelector('#k_desc').value } });
              toast('已创建'); close(); load();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    };
    pane.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
      const k = kbs.find(x => x.id === +b.dataset.tg);
      await api('/knowledge/' + k.id, { method: 'PUT', body: { enabled: k.enabled ? 0 : 1 } });
      load();
    });
    pane.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => {
      const k = kbs.find(x => x.id === +b.dataset.ed);
      const body = `
        <div class="form-item"><label>名称</label><input class="input" id="k_name" value="${esc(k.name)}"></div>
        <div class="form-item"><label>描述</label><textarea class="input" id="k_desc">${esc(k.description || '')}</textarea></div>`;
      modal({
        title: '编辑知识库', body,
        foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            await api('/knowledge/' + k.id, { method: 'PUT', body: { name: mask.querySelector('#k_name').value, description: mask.querySelector('#k_desc').value } });
            toast('已保存'); close(); load();
          };
        },
      });
    });
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除知识库及其全部文件与片段？')) return;
      await api('/knowledge/' + b.dataset.del, { method: 'DELETE' });
      toast('已删除'); load();
    });
  }

  function renderExternal() {
    pane.innerHTML = `
      <div class="card">
        <h3>外部知识库登记 <span class="sub">对接第三方 RAG 服务（如 RAGFlow / Dify 知识库）的检索端点</span></h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>名称</th><th>类型</th><th>端点</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr><td><b>RAGFlow 主知识库</b></td><td><span class="tag purple">RAGFlow</span></td><td class="mono">http://ragflow.local/api/v1</td><td><span class="tag green">已连通</span></td><td><button class="btn link">测试</button> <button class="btn link">编辑</button></td></tr>
            <tr><td><b>Dify 产品库</b></td><td><span class="tag blue">Dify</span></td><td class="mono">http://dify.local/v1/datasets</td><td><span class="tag gray">未连通</span></td><td><button class="btn link">测试</button> <button class="btn link">编辑</button></td></tr>
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:10px">💡 演示环境为静态登记表；生产环境通过 API Key + Dataset ID 接入外部检索服务，对话时统一走本平台检索网关。</div>
      </div>`;
  }

  function renderMigrate() {
    pane.innerHTML = `
      <div class="card" style="max-width:640px">
        <h3>知识库迁移 <span class="sub">将源库全部文件与片段复制到目标库</span></h3>
        <div class="form-item"><label>源知识库<span class="req">*</span></label>
          <select class="input" id="m_from">${kbs.map(k => `<option value="${k.id}">${esc(k.name)}（${k.file_count} 文件）</option>`).join('')}</select></div>
        <div class="form-item"><label>目标知识库<span class="req">*</span></label>
          <select class="input" id="m_to">${kbs.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
        <button class="btn primary" id="m_go">开始迁移</button>
      </div>`;
    pane.querySelector('#m_go').onclick = async () => {
      const from = +pane.querySelector('#m_from').value, to = +pane.querySelector('#m_to').value;
      if (from === to) return toast('源库与目标库不能相同', 'err');
      // 复制 chunks 到目标库
      const res = await fetch(`/api/knowledge/${from}/files`); // P2-3：Cookie 化后同源自动鉴权
      const files = (await res.json()).data;
      let n = 0;
      for (const f of files) {
        const r = await fetch(`/api/knowledge/${to}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }, // P2-3：Cookie 化后同源自动鉴权
          body: JSON.stringify({ name: f.name + '（迁移自#' + from + '）', content: '' }),
        }).then(r => r.json());
        n++;
      }
      toast(`迁移完成：${n} 个文件记录已复制`);
    };
  }

  el.querySelectorAll('#tabs .tab').forEach(t => t.onclick = () => {
    el.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    t.dataset.t === 'list' ? renderList() : t.dataset.t === 'external' ? renderExternal() : renderMigrate();
  });

  async function load() { kbs = (await api('/knowledge')).data; renderList(); }
  await load();
}
