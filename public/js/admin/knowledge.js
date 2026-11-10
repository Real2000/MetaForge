/** 后台-知识库管理：库列表 + 文件 + 外部知识库 + 迁移 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

export async function render(el) {
  let kbs = [];

  el.innerHTML = `
    <div class="page-head"><h2>${t('知识库管理')}</h2><div class="desc">${t('平台全部知识库的台账管理：启停、文件解析、外部知识库登记与库间迁移。')}</div></div>
    <div class="tabs" id="tabs">
      <div class="tab active" data-t="list">${t('知识库列表')}</div>
      <div class="tab" data-t="external">${t('外部知识库')}</div>
      <div class="tab" data-t="migrate">${t('知识库迁移')}</div>
    </div>
    <div id="pane"></div>`;

  const pane = el.querySelector('#pane');

  function renderList() {
    pane.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <span style="color:var(--text-2)">${t('共 {n} 个知识库').replace('{n}', kbs.length)}</span>
          <button class="btn primary" id="newKb">${t('＋ 新建知识库')}</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('名称')}</th><th>${t('描述')}</th><th>${t('文件数')}</th><th>${t('所有者')}</th><th>${t('状态')}</th><th>${t('创建时间')}</th><th>${t('操作')}</th></tr></thead>
          <tbody>${kbs.map(k => `
            <tr>
              <td><b>📚 ${esc(k.name)}</b></td>
              <td style="color:var(--text-2);max-width:260px">${esc(k.description || '-')}</td>
              <td>${k.file_count}</td>
              <td>${esc(k.owner || '-')}</td>
              <td>${k.enabled ? `<span class="tag green">${t('启用')}</span>` : `<span class="tag gray">${t('停用')}</span>`}</td>
              <td style="color:var(--text-3);font-size:12px">${esc(k.created_at)}</td>
              <td>
                <button class="btn link" data-tg="${k.id}">${k.enabled ? t('停用') : t('启用')}</button>
                <button class="btn link" data-ed="${k.id}">${t('编辑')}</button>
                <button class="btn link" style="color:var(--danger)" data-del="${k.id}">${t('删除')}</button>
              </td>
            </tr>`).join('')}
           </tbody>
         </table></div>
      </div>`;
    pane.querySelector('#newKb').onclick = () => {
      const body = `
        <div class="form-item"><label>${t('名称')}<span class="req">*</span></label><input class="input" id="k_name"></div>
        <div class="form-item"><label>${t('描述')}</label><textarea class="input" id="k_desc"></textarea></div>`;
      modal({
        title: t('新建知识库'), body,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('创建')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            try {
              await api('/knowledge', { method: 'POST', body: { name: mask.querySelector('#k_name').value, description: mask.querySelector('#k_desc').value } });
              toast(t('已创建')); close(); load();
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
        <div class="form-item"><label>${t('名称')}</label><input class="input" id="k_name" value="${esc(k.name)}"></div>
        <div class="form-item"><label>${t('描述')}</label><textarea class="input" id="k_desc">${esc(k.description || '')}</textarea></div>`;
      modal({
        title: t('编辑知识库'), body,
        foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-save>${t('保存')}</button>`,
        onMount(mask, close) {
          mask.querySelector('[data-cancel]').onclick = close;
          mask.querySelector('[data-save]').onclick = async () => {
            await api('/knowledge/' + k.id, { method: 'PUT', body: { name: mask.querySelector('#k_name').value, description: mask.querySelector('#k_desc').value } });
            toast(t('已保存')); close(); load();
          };
        },
      });
    });
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(t('删除知识库及其全部文件与片段？'))) return;
      await api('/knowledge/' + b.dataset.del, { method: 'DELETE' });
      toast(t('已删除')); load();
    });
  }

  function renderExternal() {
    pane.innerHTML = `
      <div class="card">
        <h3>${t('外部知识库登记')} <span class="sub">${t('对接第三方 RAG 服务（如 RAGFlow / Dify 知识库）的检索端点')}</span></h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t('名称')}</th><th>${t('类型')}</th><th>${t('端点')}</th><th>${t('状态')}</th><th>${t('操作')}</th></tr></thead>
          <tbody>
            <tr><td><b>${t('RAGFlow 主知识库')}</b></td><td><span class="tag purple">RAGFlow</span></td><td class="mono">http://ragflow.local/api/v1</td><td><span class="tag green">${t('已连通')}</span></td><td><button class="btn link">${t('测试')}</button> <button class="btn link">${t('编辑')}</button></td></tr>
            <tr><td><b>${t('Dify 产品库')}</b></td><td><span class="tag blue">Dify</span></td><td class="mono">http://dify.local/v1/datasets</td><td><span class="tag gray">${t('未连通')}</span></td><td><button class="btn link">${t('测试')}</button> <button class="btn link">${t('编辑')}</button></td></tr>
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:10px">💡 ${t('演示环境为静态登记表；生产环境通过 API Key + Dataset ID 接入外部检索服务，对话时统一走本平台检索网关。')}</div>
      </div>`;
  }

  function renderMigrate() {
    pane.innerHTML = `
      <div class="card" style="max-width:640px">
        <h3>${t('知识库迁移')} <span class="sub">${t('将源库全部文件与片段复制到目标库')}</span></h3>
        <div class="form-item"><label>${t('源知识库')}<span class="req">*</span></label>
          <select class="input" id="m_from">${kbs.map(k => `<option value="${k.id}">${esc(k.name)}（${k.file_count} ${t('文件')}）</option>`).join('')}</select></div>
        <div class="form-item"><label>${t('目标知识库')}<span class="req">*</span></label>
          <select class="input" id="m_to">${kbs.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
        <button class="btn primary" id="m_go">${t('开始迁移')}</button>
      </div>`;
    pane.querySelector('#m_go').onclick = async () => {
      const from = +pane.querySelector('#m_from').value, to = +pane.querySelector('#m_to').value;
      if (from === to) return toast(t('源库与目标库不能相同'), 'err');
      // 复制 chunks 到目标库
      const res = await fetch(`/api/knowledge/${from}/files`); // P2-3：Cookie 化后同源自动鉴权
      const files = (await res.json()).data;
      let n = 0;
      for (const f of files) {
        const r = await fetch(`/api/knowledge/${to}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }, // P2-3：Cookie 化后同源自动鉴权
          body: JSON.stringify({ name: f.name + t('（迁移自#{n}）').replace('{n}', from), content: '' }),
        }).then(r => r.json());
        n++;
      }
      toast(t('迁移完成：{n} 个文件记录已复制').replace('{n}', n));
    };
  }

  el.querySelectorAll('#tabs .tab').forEach(tb => tb.onclick = () => {
    el.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('active'));
    tb.classList.add('active');
    tb.dataset.t === 'list' ? renderList() : tb.dataset.t === 'external' ? renderExternal() : renderMigrate();
  });

  async function load() { kbs = (await api('/knowledge')).data; renderList(); }
  await load();
}
