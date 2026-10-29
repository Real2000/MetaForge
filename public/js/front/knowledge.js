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
                <button class="btn link" data-chunks="${f.id}">查看分块</button>
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
    paneKb.querySelectorAll('[data-chunks]').forEach(b => b.onclick = () => openChunks(+b.dataset.chunks));
  }

  // 查看分块弹窗（2026-10-29 增补：关键词/问法标签展示 + AI 生成关键词）
  async function openChunks(fileId) {
    const j = await api(`/knowledge/files/${fileId}/chunks`);
    const { file, chunks } = j.data;
    const metaTags = (kw) => {
      if (!kw) return '';
      try {
        const m = JSON.parse(kw);
        const kws = (m.keywords || []).map(k => `<span class="tag blue" style="font-size:10px">${esc(k)}</span>`).join(' ');
        const qs = (m.questions || []).map(q => `<span class="tag orange" style="font-size:10px">❓${esc(q)}</span>`).join(' ');
        return (kws || qs) ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${kws} ${qs}</div>` : '';
      } catch { return ''; }
    };
    const body = `
        <div style="font-size:13px;color:var(--text-3);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span>文件：${esc(file.name)}（共 ${chunks.length} 个片段）</span>
          <button class="btn sm" data-gen-kw="${file.id}" title="用已配置模型为每个分块生成检索关键词与问法">✨ AI 生成关键词</button>
        </div>
        <div style="max-height:500px;overflow-y:auto">${chunks.map((c, i) => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:8px" data-chunk-id="${c.id}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <b style="color:var(--brand);font-size:12px">#${i + 1}</b>
              <div>
                <button class="btn link sm" data-edit-chunk="${c.id}">编辑</button>
                <button class="btn link sm" data-del-chunk="${c.id}" style="color:var(--danger)">删除</button>
                ${i > 0 ? `<button class="btn link sm" data-merge-up="${c.id}" title="合并到上一块">↑ 合并</button>` : ''}
              </div>
            </div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.7;white-space:pre-wrap;word-break:break-word">${esc(c.content)}</div>
            ${metaTags(c.keywords)}
          </div>`).join('')}
        </div>`;
    modal({
      title: '查看分块', body, wide: true,
      foot: '<button class="btn" data-close>关闭</button>',
      onMount(mask, close) {
        mask.querySelector('[data-close]').onclick = close;
        mask.querySelectorAll('[data-gen-kw]').forEach(btn => btn.onclick = async () => {
          if (!await confirmBox('将为该文件全部分块调用模型生成关键词与问法（大文件可能耗时较久），继续？')) return;
          btn.disabled = true; btn.textContent = '⏳ 生成中…';
          try {
            const r = await api(`/knowledge/files/${fileId}/generate-keywords`, { method: 'POST' });
            if (r.data?.skipped === 'no_provider') toast('未配置可用模型供应商，已跳过', 'err');
            else toast(`生成完成：成功 ${r.data?.generated ?? 0} / 共 ${r.data?.total ?? 0} 个分块`);
            close(); openChunks(fileId); // 重新打开以刷新关键词标签
          } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = '✨ AI 生成关键词'; }
        });
          mask.querySelectorAll('[data-edit-chunk]').forEach(btn => btn.onclick = async () => {
            const cid = btn.dataset.editChunk;
            const card = mask.querySelector(`[data-chunk-id="${cid}"]`);
            const contentDiv = card?.querySelector('div:last-child');
            if (!contentDiv) return;
            const cur = contentDiv.textContent;
            const newContent = prompt('编辑分块内容：', cur);
            if (newContent == null || newContent === cur) return;
            await api(`/knowledge/chunks/${cid}`, { method: 'PUT', body: { content: newContent } });
            toast('已更新');
            contentDiv.textContent = newContent;
          });
          mask.querySelectorAll('[data-del-chunk]').forEach(btn => btn.onclick = async () => {
            if (!await confirmBox('确定删除该分块？')) return;
            const cid = btn.dataset.delChunk;
            await api(`/knowledge/chunks/${cid}`, { method: 'DELETE' });
            toast('已删除');
            const card = mask.querySelector(`[data-chunk-id="${cid}"]`);
            if (card) card.remove();
          });
          mask.querySelectorAll('[data-merge-up]').forEach(btn => btn.onclick = async () => {
            const sourceId = btn.dataset.mergeUp;
            const card = mask.querySelector(`[data-chunk-id="${sourceId}"]`);
            const prevCard = card?.previousElementSibling;
            const prevId = prevCard?.dataset.chunkId;
            if (!prevId) return toast('无法找到上一块', 'err');
            if (!await confirmBox('确定将当前分块合并到上一块？')) return;
            await api('/knowledge/chunks/merge', { method: 'POST', body: { sourceId: +sourceId, targetId: +prevId } });
            toast('已合并');
            if (card) card.remove();
            const prevContent = prevCard?.querySelector('div:last-child');
            if (prevContent) prevContent.textContent += '\n' + (mask.querySelector(`[data-chunk-id="${sourceId}"]`)?.querySelector('div:last-child')?.textContent || '');
          });
        },
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
      </div>
      <hr>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin:10px 0 6px">切片配置</div>
      <div class="form-item"><label>切片大小（字符数）</label>
        <input class="input" id="kb_chunk_size" type="range" min="100" max="2000" value="${kb.chunk_size || 500}" style="vertical-align:middle">
        <span class="tag gray" id="kb_chunk_size_val" style="font-size:13px;margin-left:8px">${kb.chunk_size || 500}</span>
      </div>
      <div class="form-item"><label>重叠字符数</label>
        <input class="input" id="kb_chunk_overlap" type="range" min="0" max="${(kb.chunk_size || 500) - 1}" value="${kb.chunk_overlap || 0}" style="vertical-align:middle">
        <span class="tag gray" id="kb_chunk_overlap_val" style="font-size:13px;margin-left:8px">${kb.chunk_overlap || 0}</span>
      </div>
      <div class="form-item"><label>分隔符（正则）</label><input class="input" id="kb_chunk_sep" value="${esc(kb.chunk_separator || '\\n\\s*\\n')}" placeholder="默认：\\n\\s*\\n"><div style="font-size:11px;color:var(--text-3)">用于按段落切分，正则表达式格式，默认按空行分段。</div></div>`;
    modal({
      title: '编辑知识库', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        // 切片大小滑块实时显示值
        const sizeInput = mask.querySelector('#kb_chunk_size');
        const sizeVal = mask.querySelector('#kb_chunk_size_val');
        sizeInput.oninput = () => {
          sizeVal.textContent = sizeInput.value;
          // 同步更新重叠滑块最大值
          overlapInput.max = Math.max(0, +sizeInput.value - 1);
        };
        const overlapInput = mask.querySelector('#kb_chunk_overlap');
        const overlapVal = mask.querySelector('#kb_chunk_overlap_val');
        overlapInput.oninput = () => { overlapVal.textContent = overlapInput.value; };
        mask.querySelector('[data-save]').onclick = async () => {
          const chunkSize = Math.min(2000, Math.max(100, +sizeInput.value)) || 500;
          const chunkOverlap = Math.min(chunkSize - 1, Math.max(0, +mask.querySelector('#kb_chunk_overlap').value)) || 0;
          await api('/knowledge/' + kb.id, { method: 'PUT', body: {
            name: mask.querySelector('#kb_name').value,
            description: mask.querySelector('#kb_desc').value,
            enabled: +mask.querySelector('#kb_enabled').value,
            chunk_size: chunkSize,
            chunk_overlap: chunkOverlap,
            chunk_separator: mask.querySelector('#kb_chunk_sep').value || '\\n\\s*\\n',
          } });
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

  // ---------- 召回测试（2026-10-29 可视化升级：向量权重滑块 + Rerank 模型下拉 + 阈值滑块 + 命中高亮 + 命中通道标识） ----------

  /** 命中词高亮：先转义再替换（安全），长词优先避免碎片化 */
  function highlightTerms(text, hitTerms) {
    const safe = esc(text);
    if (!hitTerms || !hitTerms.length) return safe;
    const pattern = hitTerms
      .map(t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .join('|');
    if (!pattern) return safe;
    try { return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark class="hl">$1</mark>'); }
    catch { return safe; }
  }

  /** 命中通道标签 */
  function channelTag(ch) {
    return {
      both: '<span class="tag green" style="font-size:10px">双命中</span>',
      bm25: '<span class="tag blue" style="font-size:10px">BM25 命中</span>',
      vec: '<span class="tag purple" style="font-size:10px">向量命中</span>',
      none: '<span class="tag gray" style="font-size:10px">低分通过</span>',
    }[ch] || '<span class="tag gray" style="font-size:10px">低分通过</span>';
  }

  async function renderRecall() {
    // 拉取可用 Rerank 模型列表（失败不阻塞，回退默认项）
    let rmList = [];
    try { const j = await api('/knowledge/rerank-models'); rmList = (j.data || []); } catch { }

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
            <div class="form-item"><label>混合得分阈值（RRF）</label>
              <div style="display:flex;align-items:center;gap:8px">
                <input class="input" id="r_th" type="range" min="0" max="0.05" step="0.002" value="0.01" style="width:130px">
                <span id="r_th_v" style="font-size:12px;color:var(--text-2);white-space:nowrap">0.010</span>
              </div>
            </div>
          </div>
          <div class="form-item"><label>向量权重（融合比例）</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input class="input" id="r_vw" type="range" min="0" max="1" step="0.05" value="0.5" style="width:130px">
              <span id="r_vw_v" style="font-size:12px;color:var(--text-2);white-space:nowrap">向量 50% · 关键词 50%</span>
            </div>
          </div>
          <div class="form-item"><label>Rerank 重排（cross-encoder 精排）</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="r_rr" checked style="width:16px;height:16px;flex:none">
              <select class="input" id="r_rm" style="flex:1">${rmList.length ? rmList.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') : '<option value="">默认（bge-reranker-v2-m3）</option>'}</select>
            </div>
          </div>
          <div class="hint">混合检索：BM25 关键词 + 语义向量双通道加权 RRF 融合；滑块实时调整向量/关键词权重；开启 Rerank 后先粗召回 Top 30 再精排取 Top N，关闭可对比纯融合效果</div>
          <button class="btn primary" id="r_run" style="width:100%;justify-content:center">▶ 执行测试</button>
        </div>
        <div class="card">
          <h3>召回结果 <span class="sub" id="r_stat"></span></h3>
          <div id="r_hits"><div class="empty-box"><div class="big">🎯</div>执行测试后在此查看命中的知识片段</div></div>
        </div>
      </div>`;

    // 滑块实时数值联动
    const vwEl = paneRecall.querySelector('#r_vw');
    vwEl.oninput = () => {
      const v = +vwEl.value;
      paneRecall.querySelector('#r_vw_v').textContent = `向量 ${Math.round(v * 100)}% · 关键词 ${Math.round((1 - v) * 100)}%`;
    };
    const thEl = paneRecall.querySelector('#r_th');
    thEl.oninput = () => { paneRecall.querySelector('#r_th_v').textContent = (+thEl.value).toFixed(3); };

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
            vector_weight: +vwEl.value,
            rerank_model: paneRecall.querySelector('#r_rm').value || null,
            rerank_enabled: paneRecall.querySelector('#r_rr').checked,
          },
        });
        paneRecall.querySelector('#r_stat').textContent = `命中 ${j.data.count} 条`;
        paneRecall.querySelector('#r_hits').innerHTML = j.data.hits.map((h, i) => {
          const rrTag = h.rerank_score != null ? `<span class="tag orange" style="font-size:10px">Rerank ${Number(h.rerank_score).toFixed(3)}</span>` : '';
          const engTag = h.engine === 'B3' ? '<span class="tag gray" style="font-size:10px">bge-m3</span>' : '<span class="tag gray" style="font-size:10px">本地哈希</span>';
          return `
          <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:4px">
              <b style="color:var(--brand)">#${i + 1}　${esc(h.file || '-')}</b>
              <span>${channelTag(h.channels)} <span class="tag blue">融合 ${h.score}</span> <span class="tag gray" style="font-size:10px">BM25 ${h.bm25}</span> <span class="tag gray" style="font-size:10px">向量 ${h.vec}</span> ${rrTag} ${engTag}</span>
            </div>
            <div style="font-size:13px;color:var(--text-2);line-height:1.7">${highlightTerms(h.content, h.hit_terms)}</div>
          </div>`;
        }).join('') || '<div class="empty-box"><div class="big">🈳</div>未命中任何片段，可调整阈值或补充知识库内容</div>';
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
  await renderRecall();
}
