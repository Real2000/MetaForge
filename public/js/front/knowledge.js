/** 前台-知识库：库列表 + 文件管理 + 召回测试 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox, fmtBytes } from '../ui.js';

export async function render(el) {
  let kbs = [];
  let current = null;   // 当前打开的库
  let files = [];

  el.innerHTML = `
    <div class="page-head">
      <h2>知识库</h2>
      <div class="desc">上传企业文档构建专属知识库，分片解析后供智能体检索增强（RAG）；支持召回效果测试。</div>
    </div>
    <div class="tabs" id="mainTabs">
      <div class="tab active" data-t="kb">知识库列表</div>
      <div class="tab" data-t="recall">召回测试</div>
    </div>
    <div id="paneKb"></div>
    <div id="paneRecall" style="display:none"></div>`;

  const paneKb = el.querySelector('#paneKb');
  const paneRecall = el.querySelector('#paneRecall');

  // ---------- 知识库列表 ----------
  function renderKbList() {
    if (!current) {
      paneKb.innerHTML = `
        <div class="toolbar">
          <span style="color:var(--text-2)">共 ${kbs.length} 个知识库</span>
          <button class="btn primary" id="newKb">＋ 新建知识库</button>
        </div>
        <div class="agent-grid">${kbs.map(k => `
          <div class="agent-card" data-id="${k.id}">
            <div class="a-ava" style="background:linear-gradient(135deg,#0891b2,#2563eb)">📚</div>
            <div class="a-info">
              <div class="a-name">${esc(k.name)} ${k.enabled ? '<span class="tag green">启用</span>' : '<span class="tag gray">停用</span>'}</div>
              <div class="a-desc">${esc(k.description || '暂无描述')}</div>
              <div class="a-meta">
                <span class="tag blue">📄 ${k.file_count} 个文件</span>
                <span class="tag gray">${esc(k.owner || '')}</span>
              </div>
            </div>
          </div>`).join('') || '<div class="empty-box" style="grid-column:1/-1"><div class="big">📚</div>暂无知识库，点击右上角创建</div>'}
        </div>`;
      paneKb.querySelector('#newKb').onclick = openNewKb;
      paneKb.querySelectorAll('.agent-card[data-id]').forEach(c => c.onclick = async () => {
        current = kbs.find(k => k.id === +c.dataset.id);
        await loadFiles();
        renderKbList();
      });
      return;
    }
    // 文件管理视图
    paneKb.innerHTML = `
      <div class="toolbar">
        <div class="filters">
          <button class="btn" id="backBtn">← 返回</button>
          <b style="font-size:15px">${esc(current.name)}</b>
          <span class="tag blue">启用</span>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn" id="editKb">编辑</button>
          <button class="btn primary" id="uploadBtn">⬆ 上传文件</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>文件名</th><th>大小</th><th>片段数</th><th>状态</th><th>上传时间</th><th>操作</th></tr></thead>
          <tbody>${files.map(f => `
            <tr>
              <td>📄 ${esc(f.name)}</td>
              <td>${fmtBytes(f.size)}</td>
              <td>${f.chunk_count}</td>
              <td><span class="tag green">解析完成</span></td>
              <td style="color:var(--text-3)">${esc(f.created_at)}</td>
              <td>
                <button class="btn link" data-re="${f.id}">重新解析</button>
                <button class="btn link" style="color:var(--danger)" data-df="${f.id}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无文件，点击「上传文件」导入（支持粘贴文本内容）</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    paneKb.querySelector('#backBtn').onclick = () => { current = null; renderKbList(); };
    paneKb.querySelector('#editKb').onclick = () => openEditKb(current);
    paneKb.querySelector('#uploadBtn').onclick = () => openUpload();
    paneKb.querySelectorAll('[data-re]').forEach(b => b.onclick = async () => {
      await api(`/knowledge/files/${b.dataset.re}/reparse`, { method: 'POST' });
      toast('重新解析完成'); loadFiles().then(renderKbList);
    });
    paneKb.querySelectorAll('[data-df]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该文件及其全部片段？')) return;
      await api(`/knowledge/files/${b.dataset.df}`, { method: 'DELETE' });
      toast('已删除'); loadFiles().then(renderKbList);
    });
  }

  function openNewKb() {
    const body = `
      <div class="form-item"><label>知识库名称<span class="req">*</span></label><input class="input" id="kb_name" maxlength="50" placeholder="如：产品手册知识库"></div>
      <div class="form-item"><label>描述</label><textarea class="input" id="kb_desc" maxlength="200" placeholder="知识库用途说明"></textarea></div>`;
    modal({
      title: '新建知识库', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            await api('/knowledge', { method: 'POST', body: { name: mask.querySelector('#kb_name').value, description: mask.querySelector('#kb_desc').value } });
            toast('知识库已创建'); close(); loadKbs();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openEditKb(kb) {
    const body = `
      <div class="form-item"><label>知识库名称</label><input class="input" id="kb_name" value="${esc(kb.name)}"></div>
      <div class="form-item"><label>描述</label><textarea class="input" id="kb_desc">${esc(kb.description || '')}</textarea></div>
      <div class="form-item"><label>状态</label>
        <select class="input" id="kb_enabled"><option value="1" ${kb.enabled ? 'selected' : ''}>启用</option><option value="0" ${!kb.enabled ? 'selected' : ''}>停用</option></select>
      </div>`;
    modal({
      title: '编辑知识库', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          await api('/knowledge/' + kb.id, { method: 'PUT', body: { name: mask.querySelector('#kb_name').value, description: mask.querySelector('#kb_desc').value, enabled: +mask.querySelector('#kb_enabled').value } });
          toast('已保存'); close(); loadKbs().then(() => { current = kbs.find(x => x.id === kb.id); renderKbList(); });
        };
      },
    });
  }

  function openUpload() {
    const body = `
      <div class="form-item"><label>上传方式</label>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="u_tab_file" style="flex:1">📎 选择文件（PDF/DOCX/PPTX/TXT/MD）</button>
          <button class="btn" id="u_tab_text" style="flex:1">📝 粘贴文本</button>
        </div>
      </div>
      <div id="u_file_pane">
        <div class="form-item"><label>选择文件<span class="req">*</span></label>
          <input class="input" type="file" id="f_picker" accept=".txt,.md,.markdown,.pdf,.docx,.pptx,.xlsx,.xls,.csv">
          <div class="hint">支持 txt / md / pdf / docx / pptx / xlsx / xls / csv，自动提取文本并智能切片（段落优先，超长段落按句边界 ~500 字切分）；扫描版 PDF 需先 OCR</div>
          <div id="f_pick_info" style="margin-top:6px;font-size:12px;color:var(--brand)"></div>
        </div>
      </div>
      <div id="u_text_pane" style="display:none">
        <div class="form-item"><label>文件名<span class="req">*</span></label><input class="input" id="f_name" placeholder="如：员工手册.txt"></div>
        <div class="form-item"><label>文本内容<span class="req">*</span></label>
          <textarea class="input" id="f_content" style="min-height:180px" placeholder="粘贴文件全文，将按空行自动分段切片"></textarea>
        </div>
      </div>`;
    let mode = 'file';
    let picked = null; // {name, b64}
    modal({
      title: `上传文件 → ${current.name}`, body, wide: true,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>上传并解析</button>',
      onMount(mask, close) {
        const filePane = mask.querySelector('#u_file_pane');
        const textPane = mask.querySelector('#u_text_pane');
        const tabFile = mask.querySelector('#u_tab_file');
        const tabText = mask.querySelector('#u_tab_text');
        tabFile.onclick = () => { mode = 'file'; filePane.style.display = ''; textPane.style.display = 'none'; tabFile.classList.add('primary'); tabText.classList.remove('primary'); };
        tabText.onclick = () => { mode = 'text'; filePane.style.display = 'none'; textPane.style.display = ''; tabText.classList.add('primary'); tabFile.classList.remove('primary'); };
        mask.querySelector('#f_picker').onchange = e => {
          const file = e.target.files[0];
          if (!file) { picked = null; return; }
          if (file.size > 12 * 1024 * 1024) { toast('文件超过 12MB，请拆分后上传', 'err'); e.target.value = ''; picked = null; return; }
          const r = new FileReader();
          r.onload = () => {
            picked = { name: file.name, b64: String(r.result).split(',')[1] || '' };
            mask.querySelector('#f_pick_info').textContent = `已选择：${file.name}（${fmtBytes(file.size)}）`;
          };
          r.readAsDataURL(file);
        };
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            let j;
            if (mode === 'file') {
              if (!picked) return toast('请选择文件', 'err');
              mask.querySelector('[data-save]').disabled = true;
              mask.querySelector('[data-save]').textContent = '解析中…';
              j = await api(`/knowledge/${current.id}/files`, { method: 'POST', body: { name: picked.name, file_b64: picked.b64 } });
            } else {
              const name = mask.querySelector('#f_name').value.trim();
              const content = mask.querySelector('#f_content').value;
              if (!name || !content.trim()) return toast('请填写文件名与内容', 'err');
              j = await api(`/knowledge/${current.id}/files`, { method: 'POST', body: { name, content } });
            }
            toast(`上传成功，解析为 ${j.data.chunks} 个片段`);
            close(); loadFiles().then(renderKbList);
          } catch (e) { toast(e.message, 'err'); mask.querySelector('[data-save]').disabled = false; mask.querySelector('[data-save]').textContent = '上传并解析'; }
        };
      },
    });
  }

  async function loadKbs() { const j = await api('/knowledge'); kbs = j.data; renderKbList(); }
  async function loadFiles() { const j = await api(`/knowledge/${current.id}/files`); files = j.data; }

  // ---------- 召回测试 ----------
  function renderRecall() {
    paneRecall.innerHTML = `
      <div class="grid-2" style="align-items:start">
        <div class="card">
          <h3>测试参数</h3>
          <div class="form-item"><label>测试问题<span class="req">*</span></label><textarea class="input" id="r_q" placeholder="输入用于测试召回效果的问题，如：迟到会怎么处理？"></textarea></div>
          <div class="form-item"><label>知识库范围</label>
            <select class="input" id="r_kb"><option value="">全部启用的知识库</option>${kbs.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
          </div>
          <div class="form-row">
            <div class="form-item"><label>Top N</label><input class="input" id="r_top" type="number" value="5" min="1" max="20"></div>
            <div class="form-item"><label>混合得分阈值（RRF）</label><input class="input" id="r_th" type="number" value="0.01" step="0.005" min="0" max="0.1"></div>
          </div>
          <div class="hint">混合检索：BM25 关键词 + 本地向量（256 维字符 n-gram）双通道，RRF 融合排序；阈值为融合分下限，命中任一通道即可参与排序</div>
          <button class="btn primary" id="r_run" style="width:100%;justify-content:center">▶ 执行测试</button>
        </div>
        <div class="card">
          <h3>召回结果 <span class="sub" id="r_stat"></span></h3>
          <div id="r_hits"><div class="empty-box"><div class="big">🎯</div>执行测试后在此查看命中的知识片段</div></div>
        </div>
      </div>`;

    paneRecall.querySelector('#r_run').onclick = async () => {
      const q = paneRecall.querySelector('#r_q').value.trim();
      if (!q) return toast('请输入测试问题', 'err');
      try {
        const j = await api('/knowledge/recall-test', {
          method: 'POST',
          body: {
            query: q,
            kb_id: +paneRecall.querySelector('#r_kb').value || null,
            top_n: +paneRecall.querySelector('#r_top').value,
            threshold: +paneRecall.querySelector('#r_th').value,
          },
        });
        paneRecall.querySelector('#r_stat').textContent = `命中 ${j.data.count} 条`;
        paneRecall.querySelector('#r_hits').innerHTML = j.data.hits.map((h, i) => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px">
              <b style="color:var(--brand)">#${i + 1}　${esc(h.file || '-')}</b>
              <span><span class="tag blue">融合 ${h.score}</span> <span class="tag gray" style="font-size:10px">BM25 ${h.bm25}</span> <span class="tag gray" style="font-size:10px">向量 ${h.vec}</span></span>
            </div>
            <div style="font-size:13px;color:var(--text-2);line-height:1.7">${esc(h.content)}</div>
          </div>`).join('') || '<div class="empty-box"><div class="big">🈳</div>未命中任何片段，可调整阈值或补充知识库内容</div>';
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  el.querySelectorAll('#mainTabs .tab').forEach(t => t.onclick = () => {
    el.querySelectorAll('#mainTabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    paneKb.style.display = t.dataset.t === 'kb' ? '' : 'none';
    paneRecall.style.display = t.dataset.t === 'recall' ? '' : 'none';
  });

  await loadKbs();
  renderRecall();
}
