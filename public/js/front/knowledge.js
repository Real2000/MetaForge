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
      <div class="tab" data-t="logs">解析日志</div>
      <div class="tab" data-t="evals">评测集</div>
    </div>
    <div id="paneKb"></div>
    <div id="paneRecall" style="display:none"></div>
    <div id="paneLogs" style="display:none"></div>
    <div id="paneEvals" style="display:none"></div>`;

  let activeTab = 'kb'; // V1.1 #1 2026-10-30：当前主 tab（上传成功/失败后按所在 tab 决定刷新目标）
  const paneKb = el.querySelector('#paneKb');
  const paneRecall = el.querySelector('#paneRecall');
  const paneLogs = el.querySelector('#paneLogs');
  const paneEvals = el.querySelector('#paneEvals'); // V1.3 #6 2026-10-30：第四个主 tab「评测集」

  // V1.1 #1 2026-10-30：文件状态四态徽章（success/failed/pending/processing）
  // pending/processing 为 #5 摄取管道异步化后的预留态，当前同步架构下不产生（非缺陷）；失败落库后文件列表会出现 failed 行
  function kbFileStatusTag(s) {
    return {
      success: '<span class="tag green">解析完成</span>',
      failed: '<span class="tag red">解析失败</span>',
      processing: '<span class="tag blue">处理中</span>',
      pending: '<span class="tag orange">排队中</span>',
    }[s] || `<span class="tag gray">${esc(s || '未知')}</span>`;
  }

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
        // V1.1 审查加固 2026-10-30：文件列表已收紧为 owner/admin——非 owner 点他人库 403 时不再卡死 UI，提示后仍渲染空文件态
        files = [];
        try { await loadFiles(); }
        catch (e) { toast(e.code === 403 ? '无权查看该知识库的文件（仅创建者或管理员）' : (e.message || '文件加载失败'), 'err'); }
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
              <td>${kbFileStatusTag(f.status)}</td>
              <td style="color:var(--text-3)">${esc(f.created_at)}</td>
              <td>
                ${f.status === 'failed' ? '' : `<button class="btn link" data-re="${f.id}">重新解析</button>
                <button class="btn link" data-chunks="${f.id}">查看分块</button>`}
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

  // ---------- 分块元数据工具（V1.2 #2 2026-10-30）----------
  // kb_chunks.metadata 为 JSON 对象（约定键 dept/level/doc_type）；兼容后端返回对象或 JSON 字符串两种形态
  function parseChunkMeta(m) {
    if (m == null) return null;
    if (typeof m === 'object' && !Array.isArray(m)) return m;
    if (typeof m === 'string') { try { const v = JSON.parse(m); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null; } catch { return null; } }
    return null;
  }
  // 约定键中文标签（非约定键展示 原键:值）
  const META_KEY_LABEL = { dept: '部门', level: '密级', doc_type: '文档类型' };
  // 元数据徽章串：约定键只显示值（如 🏷 产品部 · 公开），其余键显示 键:值
  function metaBadgeHtml(m) {
    const obj = parseChunkMeta(m);
    if (!obj) return '';
    const parts = Object.entries(obj).slice(0, 6).map(([k, v]) =>
      META_KEY_LABEL[k] ? esc(String(v)) : `${esc(k)}:${esc(String(v))}`).join(' · ');
    if (!parts) return '';
    return `<div style="margin-top:6px"><span class="tag gray" style="font-size:10px" title="${esc(Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('；'))}">🏷 ${parts}</span></div>`;
  }

  // 查看分块弹窗（2026-10-29 增补：关键词/问法标签展示 + AI 生成关键词；V1.2 #2：元数据展示 + 结构化编辑）
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
          <div style="display:flex;gap:6px">
            <button class="btn sm" data-gen-meta="${file.id}" title="用已配置模型为每个分块抽取部门/密级/文档类型元数据（V1.2 审查加固：先传文件后开开关的存量文件补抽取途径）">🏷 AI 补抽取元数据</button>
            <button class="btn sm" data-gen-kw="${file.id}" title="用已配置模型为每个分块生成检索关键词与问法">✨ AI 生成关键词</button>
          </div>
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
            ${metaBadgeHtml(c.metadata)}
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
        // V1.2 审查加固 2026-10-30：AI 补抽取元数据（存量文件在开启 auto_metadata 前上传的补抽取途径）
        mask.querySelectorAll('[data-gen-meta]').forEach(btn => btn.onclick = async () => {
          if (!await confirmBox('将为该文件全部分块调用模型抽取部门/密级/文档类型元数据（已有手工值优先，仅填缺失键），继续？')) return;
          btn.disabled = true; btn.textContent = '⏳ 抽取中…';
          try {
            const r = await api(`/knowledge/files/${fileId}/generate-metadata`, { method: 'POST' });
            if (r.data?.skipped === 'no_provider') toast('未配置可用模型供应商，已跳过', 'err');
            else toast(`抽取完成：成功 ${r.data?.extracted ?? 0} / 共 ${r.data?.total ?? 0} 个分块`);
            close(); openChunks(fileId); // 重新打开以刷新元数据徽章
          } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = '🏷 AI 补抽取元数据'; }
        });
          mask.querySelectorAll('[data-edit-chunk]').forEach(btn => btn.onclick = () => {
            const cid = btn.dataset.editChunk;
            const chunk = chunks.find(c => String(c.id) === String(cid));
            if (!chunk) return;
            openChunkEdit(chunk, fileId); // V1.2 #2：prompt 简易编辑升级为内容 + 元数据结构化编辑弹窗
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

  // 分块编辑弹窗（V1.2 #2 2026-10-30）：内容 + 元数据结构化编辑（部门/密级/文档类型 + 「更多键」折叠 JSON）
  function openChunkEdit(chunk, fileId) {
    const meta = parseChunkMeta(chunk.metadata) || {};
    const LEVEL_OPTS = ['公开', '内部', '机密'];
    const body = `
      <div class="form-item"><label>分块内容</label>
        <textarea class="input" id="ce_content" style="min-height:140px;font-size:12px;line-height:1.7">${esc(chunk.content)}</textarea>
      </div>
      <hr>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin:10px 0 6px">🏷 元数据<span style="font-weight:400;font-size:11px;color:var(--text-3)">（用于检索权限过滤，可留空）</span></div>
      <div class="form-row">
        <div class="form-item"><label>部门（dept）</label><input class="input" id="ce_dept" maxlength="32" value="${esc(String(meta.dept ?? ''))}" placeholder="如：产品部"></div>
        <div class="form-item"><label>密级（level）</label>
          <select class="input" id="ce_level">
            <option value="">无</option>
            ${LEVEL_OPTS.map(l => `<option value="${l}" ${meta.level === l ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-item"><label>文档类型（doc_type）</label><input class="input" id="ce_doc_type" maxlength="32" value="${esc(String(meta.doc_type ?? ''))}" placeholder="如：员工手册"></div>
      <details style="margin-top:4px">
        <summary style="font-size:12px;color:var(--text-2);cursor:pointer;user-select:none">⚙️ 更多键（高级：直接编辑完整 JSON 对象）</summary>
        <div class="form-item" style="margin-top:8px">
          <textarea class="input" id="ce_json" style="min-height:110px;font-family:monospace;font-size:12px" spellcheck="false">${esc(JSON.stringify(meta, null, 2))}</textarea>
          <div class="hint">完整元数据对象（含上述三个键与自定义键）；修改后保存时以本 JSON 为准。全部删除并留空 {} 将清空该分块元数据。</div>
        </div>
      </details>`;
    modal({
      title: `编辑分块 #${chunk.id}`, body, wide: true,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        let jsonDirty = false; // 用户是否手动改过高级 JSON（改过则以 JSON 为准，三个快捷输入不再覆盖）
        const jsonTa = mask.querySelector('#ce_json');
        jsonTa.addEventListener('input', () => { jsonDirty = true; });
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          // 组装 metadata：动过高级 JSON → 以解析结果为准（校验失败拦截保存）；未动过 → 三个快捷输入覆盖约定键，其余键原样保留
          let newMeta;
          if (jsonDirty) {
            try {
              newMeta = JSON.parse(jsonTa.value);
              if (!newMeta || typeof newMeta !== 'object' || Array.isArray(newMeta)) throw new Error('不是 JSON 对象');
            } catch (e) { toast(`高级 JSON 格式错误：${e.message}，请修正后再保存`, 'err'); return; }
          } else {
            newMeta = { ...meta }; // 保留非约定键
            const dept = mask.querySelector('#ce_dept').value.trim();
            const level = mask.querySelector('#ce_level').value;
            const docType = mask.querySelector('#ce_doc_type').value.trim();
            if (dept) newMeta.dept = dept; else delete newMeta.dept;
            if (level) newMeta.level = level; else delete newMeta.level;
            if (docType) newMeta.doc_type = docType; else delete newMeta.doc_type;
          }
          // 空对象 → null（契约：清空元数据）
          if (!newMeta || !Object.keys(newMeta).length) newMeta = null;
          try {
            await api(`/knowledge/chunks/${chunk.id}`, { method: 'PUT', body: { content: mask.querySelector('#ce_content').value, metadata: newMeta } });
            toast('分块已保存'); close();
            openChunks(fileId); // 重新打开以刷新元数据徽章
          } catch (e) { toast(e.message, 'err'); }
        };
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
      <div class="form-item"><label>分隔符（正则）</label><input class="input" id="kb_chunk_sep" value="${esc(kb.chunk_separator || '\\n\\s*\\n')}" placeholder="默认：\\n\\s*\\n"><div style="font-size:11px;color:var(--text-3)">用于按段落切分，正则表达式格式，默认按空行分段。</div></div>
      <hr>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin:10px 0 6px">元数据</div>
      <div class="form-item"><label>自动元数据</label>
        <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px">
          <span class="switch ${kb.auto_metadata ? 'on' : ''}" id="kb_auto_meta"></span>
          <div style="flex:1">
            <b style="font-size:13px">AI 自动抽取元数据</b>
            <div class="hint">开启后上传文件由 AI 自动抽取部门/密级/文档类型元数据，用于检索权限过滤（需已配置模型）</div>
          </div>
        </div>
      </div>`;
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
        // V1.2 #2：自动元数据开关（点按切换，不随其它字段联动）
        const autoMetaSw = mask.querySelector('#kb_auto_meta');
        autoMetaSw.onclick = () => autoMetaSw.classList.toggle('on');
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
            auto_metadata: autoMetaSw.classList.contains('on') ? 1 : 0, // V1.2 #2：自动元数据开关
          } });
          toast('已保存'); close(); loadKbs().then(() => { current = kbs.find(x => x.id === kb.id); renderKbList(); });
        };
      },
    });
  }

  function openUpload(prefillName) { // V1.1 #1：prefillName——日志页「重传」时预填失败文件名
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
        <div class="form-item"><label>文件名<span class="req">*</span></label><input class="input" id="f_name" value="${esc(prefillName || '')}" placeholder="如：员工手册.txt"></div>
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
            close();
            if (activeTab === 'logs') renderLogs(1); // V1.1 #1：日志页上传后自动刷新（回第 1 页看最新记录）
            if (activeTab === 'evals') renderEvals(); // V1.3 #6：评测集页上传后刷新（后端已触发自动回归，分数将变化）
            loadFiles().then(renderKbList);
          } catch (e) {
            toast(e.message, 'err');
            if (activeTab === 'logs') renderLogs(1); // V1.1 审查加固：失败记录 ORDER BY id DESC 固定在第 1 页，必须回第 1 页才能看到失败原因
            mask.querySelector('[data-save]').disabled = false; mask.querySelector('[data-save]').textContent = '上传并解析';
          }
        };
      },
    });
  }

  async function loadKbs() { const j = await api('/knowledge'); kbs = j.data; renderKbList(); }
  async function loadFiles() { const j = await api(`/knowledge/${current.id}/files`); files = j.data; }

  // ---------- 解析日志（V1.1 #1 2026-10-30：三张统计卡 + 日志表格 + 分页 + 失败行重传/删除） ----------
  // 四态预设计：pending/processing 为 #5 摄取管道异步化后的预留演进位，当前同步解析架构下「处理中」恒为 0（非缺陷）
  let logsPage = 1;

  async function renderLogs(page) {
    if (!current) {
      paneLogs.innerHTML = `<div class="card"><div class="hint" style="padding:28px 0;text-align:center;font-size:13px">请先在知识库列表选择知识库</div></div>`;
      return;
    }
    const p = Math.max(1, page || logsPage);
    let j;
    try { j = await api(`/knowledge/${current.id}/logs?page=${p}&page_size=20`); }
    catch (e) { paneLogs.innerHTML = `<div class="card"><div class="hint" style="color:var(--danger)">日志加载失败：${esc(e.message)}</div></div>`; return; }
    const { list, total, page: cur, page_size, stats } = j.data;
    logsPage = cur;
    // V1.1 审查加固：删除末页最后一条后自动回退一页（避免停留在空页「第 2 / 1 页」）
    if (!list.length && cur > 1) return renderLogs(cur - 1);
    const pages = Math.max(1, Math.ceil(total / (page_size || 20)));
    // 来源标签（upload→上传，可扩展：api/管道导入等）
    const srcLabel = (s) => ({ upload: '上传', api: 'API', pipeline: '管道' })[s] || (s || '上传');
    // 失败原因列：超长截断 + title 悬浮全文
    const errCell = (msg) => {
      if (!msg) return '<span style="color:var(--text-3)">—</span>';
      const short = msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
      return `<span title="${esc(msg)}" style="color:var(--danger)">${esc(short)}</span>`;
    };

    paneLogs.innerHTML = `
      <div class="toolbar">
        <div class="filters">
          <button class="btn" id="logsBack">← 返回</button>
          <b style="font-size:15px">${esc(current.name)}</b>
          <span class="tag blue">解析日志</span>
        </div>
        <button class="btn primary" id="logsUpload">⬆ 上传文件</button>
      </div>
      <div class="grid-3">
        <div class="stat-card">
          <div class="label">📁 文件总数</div>
          <div class="num">${stats.total}</div>
          <div class="sub">成功 ${stats.success} · 失败 ${stats.failed}</div>
        </div>
        <div class="stat-card">
          <div class="label">❌ 解析失败</div>
          <div class="num" style="color:var(--danger)">${stats.failed}</div>
          <div class="sub">失败行可重传或删除</div>
        </div>
        <div class="stat-card">
          <div class="label">⏳ 处理中</div>
          <div class="num" style="color:var(--brand)">${stats.processing}</div>
          <div class="sub">异步管道化（#5）后生效，当前同步解析恒为 0</div>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>ID</th><th>文件名</th><th>来源</th><th>大小</th><th>分块数</th><th>状态</th><th>解析完成时间</th><th>失败原因</th><th>操作</th></tr></thead>
          <tbody>${list.map(f => `
            <tr>
              <td style="color:var(--text-3)">${f.id}</td>
              <td>📄 ${esc(f.name)}</td>
              <td><span class="tag gray">${esc(srcLabel(f.source))}</span></td>
              <td>${fmtBytes(f.size || 0)}</td>
              <td>${f.chunk_count || 0}</td>
              <td>${kbFileStatusTag(f.status)}</td>
              <td style="color:var(--text-3)">${f.parsed_at ? esc(f.parsed_at) : '—'}</td>
              <td>${errCell(f.error_msg)}</td>
              <td>${f.status === 'failed' ? `
                <button class="btn link" data-ru="${f.id}" data-rn="${esc(f.name)}">重传</button>
                <button class="btn link" style="color:var(--danger)" data-ld="${f.id}">删除</button>` : '<span style="color:var(--text-3)">—</span>'}
              </td>
            </tr>`).join('') || '<tr><td colspan="9" class="empty">暂无解析记录，上传文件后在此查看解析状态与失败原因</td></tr>'}
          </tbody>
        </table></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px">
          <span class="hint">共 ${total} 条记录 · 第 ${cur} / ${pages} 页</span>
          <div style="display:flex;gap:8px">
            <button class="btn" data-pg="prev" ${cur <= 1 ? 'disabled' : ''}>← 上一页</button>
            <button class="btn" data-pg="next" ${cur >= pages ? 'disabled' : ''}>下一页 →</button>
          </div>
        </div>
      </div>`;

    paneLogs.querySelector('#logsBack').onclick = () => { current = null; switchTab('kb'); renderKbList(); };
    paneLogs.querySelector('#logsUpload').onclick = () => openUpload();
    paneLogs.querySelectorAll('[data-ru]').forEach(b => b.onclick = () => openUpload(b.dataset.rn)); // 重传：复用上传弹窗并预填失败文件名
    paneLogs.querySelectorAll('[data-ld]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该失败记录？（及其可能残留的分片）')) return;
      await api(`/knowledge/files/${b.dataset.ld}`, { method: 'DELETE' });
      toast('已删除'); renderLogs();
    });
    const prev = paneLogs.querySelector('[data-pg="prev"]');
    const next = paneLogs.querySelector('[data-pg="next"]');
    if (prev) prev.onclick = () => { if (cur > 1) renderLogs(cur - 1); };
    if (next) next.onclick = () => { if (cur < pages) renderLogs(cur + 1); };
  }

  // ---------- 召回测试（2026-10-29 可视化升级：向量权重滑块 + Rerank 模型下拉 + 阈值滑块 + 命中高亮 + 命中通道标识） ----------
  // V1.2 #2 2026-10-30：检索过滤（元数据）——选中具体库后懒加载 GET /knowledge/:id/meta-options（一次缓存）；
  // 失败/未选库（全部启用）时静默隐藏该区；查询把非空选择组装成 metadataFilter 传 recall-test
  let metaOpts = null;       // {dept:[],level:[]} | null（未加载或不可用）
  let metaOptsKbId = null;   // 已缓存的库 id（懒加载一次）
  let lastRecall = null;     // V1.3 #6 2026-10-30：最近一次成功召回测试 {kbId, query, hitTerms}——「保存为评测集」数据源

  async function loadMetaOptions(kbId) {
    if (kbId === metaOptsKbId) return; // 已缓存
    metaOpts = null; metaOptsKbId = null;
    if (!kbId) { toggleMetaFilterArea(false); return; } // 「全部启用的知识库」无可过滤维度
    try {
      const j = await api(`/knowledge/${kbId}/meta-options`);
      const d = j.data || {};
      // V1.2 审查加固 2026-10-30：适配 {keys, options} 双结构（原平铺结构自定义键 "keys" 会覆盖键列表）
      const opt = d.options || d;
      metaOpts = { dept: opt.dept || [], level: opt.level || [] };
      metaOptsKbId = kbId;
      renderMetaFilterSelects();
      toggleMetaFilterArea(true);
    } catch { toggleMetaFilterArea(false); } // 404/403/网络失败：静默隐藏，不阻塞召回测试主流程
  }

  function toggleMetaFilterArea(show) {
    const area = paneRecall.querySelector('#r_meta_filter');
    if (area) area.style.display = show && metaOpts ? '' : 'none';
  }

  function renderMetaFilterSelects() {
    const selDept = paneRecall.querySelector('#r_mf_dept');
    const selLevel = paneRecall.querySelector('#r_mf_level');
    if (!selDept || !selLevel || !metaOpts) return;
    selDept.innerHTML = `<option value="">部门：不过滤</option>` +
      metaOpts.dept.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    selLevel.innerHTML = `<option value="">密级：不过滤</option>` +
      metaOpts.level.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
  }

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
          <div class="form-item" id="r_meta_filter" style="display:none">
            <label>检索过滤（元数据）</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <select class="input" id="r_mf_dept" style="flex:1;min-width:130px"><option value="">部门：不过滤</option></select>
              <select class="input" id="r_mf_level" style="flex:1;min-width:130px"><option value="">密级：不过滤</option></select>
              <button class="btn" id="r_mf_clear" title="清空两个过滤下拉">清除过滤</button>
            </div>
            <div class="hint">按分块元数据过滤命中结果（部门/密级）；选项来自该库已录入的元数据值</div>
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
          <button class="btn" id="r_save_eval" style="display:none;margin-bottom:10px" title="把当前测试问题与期望命中词存为评测集，供重跑对比与库变更自动回归">💾 保存为评测集</button>
          <div id="r_hits"><div class="empty-box"><div class="big">🎯</div>执行测试后在此查看命中的知识片段</div></div>
        </div>
      </div>`;

    // V1.2 #2：选中具体库后懒加载元数据选项（一次缓存；失败静默隐藏过滤区）
    const kbSel = paneRecall.querySelector('#r_kb');
    kbSel.onchange = () => loadMetaOptions(+kbSel.value || null);
    paneRecall.querySelector('#r_mf_clear').onclick = () => {
      const d = paneRecall.querySelector('#r_mf_dept'); const l = paneRecall.querySelector('#r_mf_level');
      if (d) d.value = ''; if (l) l.value = '';
      toast('已清除检索过滤');
    };

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
      // V1.2 #2：组装 metadataFilter（仅收集非空选择；未加载/隐藏时下拉取值为空自然不带）
      const mfDept = paneRecall.querySelector('#r_mf_dept')?.value || '';
      const mfLevel = paneRecall.querySelector('#r_mf_level')?.value || '';
      const metadataFilter = {};
      if (mfDept) metadataFilter.dept = mfDept;
      if (mfLevel) metadataFilter.level = mfLevel;
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
            ...(Object.keys(metadataFilter).length ? { metadataFilter } : {}), // 空过滤不携带该字段
          },
        });
        paneRecall.querySelector('#r_stat').textContent = `命中 ${j.data.count} 条`;
        // V1.3 #6：记录本次成功测试（保存评测集用）；测试过后显示「保存为评测集」按钮
        lastRecall = {
          kbId: +paneRecall.querySelector('#r_kb').value || null,
          query: q,
          hitTerms: (j.data.hits[0] && j.data.hits[0].hit_terms) || [], // Top-1 命中词（默认标记词候选）
        };
        paneRecall.querySelector('#r_save_eval').style.display = '';
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
            ${metaBadgeHtml(h.metadata)}
          </div>`;
        }).join('') || '<div class="empty-box"><div class="big">🈳</div>未命中任何片段，可调整阈值或补充知识库内容</div>';
      } catch (e) {
        // V1.2 #2：recall-test 已收紧为 owner/admin——非 owner 调用业务码 403 时优雅提示并清空结果区，不卡 UI；
        // V1.2 审查加固：文案透传后端 msg（区分「无权测试该库」与「全库检索仅管理员」两种 403）
        if (e.code === 403) {
          const m403 = e.message || '无权测试该知识库（仅创建者或管理员）';
          toast(m403, 'err');
          paneRecall.querySelector('#r_stat').textContent = '';
          paneRecall.querySelector('#r_hits').innerHTML = `<div class="empty-box"><div class="big">🔒</div>${esc(m403)}</div>`;
          return;
        }
        toast(e.message, 'err');
      }
    };

    // V1.3 #6 2026-10-30：保存为评测集入口（仅测试成功后可见，见 r_run 成功分支）
    paneRecall.querySelector('#r_save_eval').onclick = () => openSaveEvalModal();
  }

  // ---------- V1.3 #6 2026-10-30：知识库级召回评测集（保存/重跑 diff/删除；自动回归见后端触发点） ----------

  // 保存为评测集弹窗：当前 query + 期望命中标记词（默认取 Top-1 命中词前 3 个，可手改）→ dataset 单条入库
  function openSaveEvalModal() {
    if (!lastRecall) return toast('请先执行召回测试', 'err');
    if (!lastRecall.kbId) return toast('请选择具体知识库后再保存（评测集归属单个知识库）', 'err');
    const defTerms = (lastRecall.hitTerms || []).slice(0, 3).join('，');
    const body = `
      <div class="form-item"><label>评测集名称<span class="req">*</span></label><input class="input" id="se_name" maxlength="50" placeholder="如：黄金问答集"></div>
      <div class="form-item"><label>测试问题<span class="req">*</span></label><input class="input" id="se_query" value="${esc(lastRecall.query)}"></div>
      <div class="form-item"><label>期望命中标记词（逗号分隔）<span class="req">*</span></label>
        <input class="input" id="se_terms" value="${esc(defTerms)}" placeholder="如：迟到，旷工，扣款——Top-1 结果包含任一词即该条命中">
        <div class="hint">重跑时逐条检索该库，Top-1 命中片段包含任一标记词即得 1 分；默认取当前命中 Top-1 的命中词，可手工调整</div>
      </div>`;
    modal({
      title: '💾 保存为评测集', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          const name = mask.querySelector('#se_name').value.trim();
          const query = mask.querySelector('#se_query').value.trim();
          const terms = mask.querySelector('#se_terms').value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
          if (!name) return toast('请填写评测集名称', 'err');
          if (!query) return toast('请填写测试问题', 'err');
          if (!terms.length) return toast('请填写至少一个期望命中标记词', 'err');
          try {
            await api(`/knowledge/${lastRecall.kbId}/evaluations`, { method: 'POST', body: { name, dataset: [{ query, expect_terms: terms }] } });
            toast('评测集已保存，可在「评测集」页重跑');
            close();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  // diff 徽章：'首次'/'持平' 灰，+x.xx 绿↑，-x.xx 红↓
  function diffBadge(diff) {
    if (diff === '首次') return '<span class="tag gray">首次评测</span>';
    if (diff === '持平') return '<span class="tag gray">持平</span>';
    const up = String(diff).startsWith('+');
    return `<span class="tag ${up ? 'green' : 'red'}">${up ? '↑' : '↓'}${esc(String(diff).replace(/^[+-]/, ''))}</span>`;
  }

  // 得分徽章：未重跑显 '—'；≥0.8 绿 / ≥0.5 橙 / 其余红
  function scoreBadge(score) {
    if (score == null) return '<span class="tag gray">—</span>';
    const cls = score >= 0.8 ? 'green' : score >= 0.5 ? 'orange' : 'red';
    return `<span class="tag ${cls}">${(+score).toFixed(2)}</span>`;
  }

  // 评测集列表（名称/得分/条数/创建时间/重跑/删除；403 与加载失败优雅提示）
  async function renderEvals() {
    if (!current) {
      paneEvals.innerHTML = `<div class="card"><div class="hint" style="padding:28px 0;text-align:center;font-size:13px">请先在知识库列表选择知识库</div></div>`;
      return;
    }
    let j;
    try { j = await api(`/knowledge/${current.id}/evaluations`); }
    catch (e) {
      const m = e.code === 403 ? '无权查看该知识库的评测集（仅创建者或管理员）' : `评测集加载失败：${e.message}`;
      paneEvals.innerHTML = `<div class="card"><div class="hint" style="color:var(--danger)">${esc(m)}</div></div>`;
      return;
    }
    const list = j.data || [];
    paneEvals.innerHTML = `
      <div class="toolbar">
        <div class="filters">
          <button class="btn" id="evBack">← 返回</button>
          <b style="font-size:15px">${esc(current.name)}</b>
          <span class="tag blue">召回评测集</span>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>名称</th><th>得分</th><th>条数</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${list.map(e => `
            <tr data-eval-row="${e.id}">
              <td><b>${esc(e.name)}</b></td>
              <td class="ev-score">${scoreBadge(e.score)}</td>
              <td>${e.dataset_count}</td>
              <td style="color:var(--text-3)">${esc(e.created_at)}</td>
              <td>
                <button class="btn link" data-rerun="${e.id}" data-name="${esc(e.name)}">重跑</button>
                <button class="btn link" style="color:var(--danger)" data-del-eval="${e.id}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无评测集——在「召回测试」页执行测试后点「💾 保存为评测集」，或等库变更后自动回归</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:10px">💡 知识库变更（重传文件/调整切片参数）后将自动回归评测并通知创建者；得分 = Top-1 命中条数 / 总条数（重跑跳过 Rerank 保证稳定）</div>
      </div>
      <div id="ev_detail"></div>`;
    paneEvals.querySelector('#evBack').onclick = () => { current = null; switchTab('kb'); renderKbList(); };
    paneEvals.querySelectorAll('[data-rerun]').forEach(b => b.onclick = () => rerunEvalUi(+b.dataset.rerun, b.dataset.name));
    paneEvals.querySelectorAll('[data-del-eval]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该评测集？')) return;
      try {
        await api(`/knowledge/${current.id}/evaluations/${b.dataset.delEval}`, { method: 'DELETE' });
        toast('已删除'); renderEvals();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // 重跑单个评测集 → 展示新得分/旧得分/diff 徽章 + 逐条明细（query/是否命中/期望词），并原地刷新该行得分
  async function rerunEvalUi(eid, evalName) {
    const btn = paneEvals.querySelector(`[data-rerun="${eid}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 重跑中…'; }
    try {
      const j = await api(`/knowledge/${current.id}/evaluations/${eid}/rerun`, { method: 'POST' });
      const { score, prev_score, diff, detail } = j.data;
      const hitCount = (detail || []).filter(d => d.hit).length;
      const total = (detail || []).length;
      // 原地刷新该行得分徽章（不整页重渲染，保留下方明细展示）
      const scoreCell = paneEvals.querySelector(`[data-eval-row="${eid}"] .ev-score`);
      if (scoreCell) scoreCell.innerHTML = scoreBadge(score);
      paneEvals.querySelector('#ev_detail').innerHTML = `
        <div class="card">
          <h3>重跑结果：${esc(evalName || '')} ${diffBadge(diff)}</h3>
          <div class="grid-3">
            <div class="stat-card"><div class="label">新得分</div><div class="num">${(+score).toFixed(2)}</div><div class="sub">Top-1 命中 ${hitCount} / ${total} 条</div></div>
            <div class="stat-card"><div class="label">旧得分</div><div class="num">${prev_score == null ? '—' : (+prev_score).toFixed(2)}</div><div class="sub">重跑前最近一次</div></div>
            <div class="stat-card"><div class="label">变化</div><div class="num" style="color:${diff === '持平' || diff === '首次' ? 'var(--text-3)' : String(diff).startsWith('+') ? 'var(--brand)' : 'var(--danger)'}">${esc(diff === '首次' ? '首次' : diff === '持平' ? '持平' : String(diff).replace(/^[+-]/, ''))}</div><div class="sub">±0.02 内算持平</div></div>
          </div>
          <div style="margin-top:12px">${(detail || []).map(d => `
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
                <b style="font-size:13px">${d.hit ? '✅' : '❌'} ${esc(d.query)}</b>
                <span>${d.hit ? '<span class="tag green">命中</span>' : '<span class="tag red">未命中</span>'}${d.top_file ? ` <span class="tag gray" style="font-size:10px">📄 ${esc(d.top_file)}</span>` : ''}</span>
              </div>
              <div style="margin-top:4px;font-size:12px;color:var(--text-3)">期望词：${(d.expected || []).map(t => `<span class="tag blue" style="font-size:10px">${esc(t)}</span>`).join(' ') || '—'}</div>
            </div>`).join('') || '<div class="empty-box"><div class="big">🈳</div>无明细数据</div>'}
          </div>
        </div>`;
      toast(`重跑完成：得分 ${(+score).toFixed(2)}${prev_score != null ? `（原 ${(+prev_score).toFixed(2)}，${diff}）` : '（首次）'}`);
    } catch (e) {
      // 403/加载失败优雅处理（沿用 catch e.code 模式）
      toast(e.code === 403 ? '无权重跑该评测集（仅创建者或管理员）' : (e.message || '重跑失败'), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '重跑'; }
    }
  }

  // 主 tab 切换（V1.1 #1：第三个 tab「解析日志」；V1.3 #6：第四个 tab「评测集」；切页时按需加载）
  function switchTab(t) {
    activeTab = t;
    el.querySelectorAll('#mainTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.t === t));
    paneKb.style.display = t === 'kb' ? '' : 'none';
    paneRecall.style.display = t === 'recall' ? '' : 'none';
    paneLogs.style.display = t === 'logs' ? '' : 'none';
    paneEvals.style.display = t === 'evals' ? '' : 'none'; // V1.3 #6：评测集页
  }

  el.querySelectorAll('#mainTabs .tab').forEach(t => t.onclick = () => {
    switchTab(t.dataset.t);
    if (t.dataset.t === 'logs') renderLogs(1); // V1.1 #1：切到日志页时刷新（回第 1 页看最新记录）
    if (t.dataset.t === 'evals') renderEvals(); // V1.3 #6：切到评测集页时刷新（拿最新分数）
  });

  await loadKbs();
  await renderRecall();
}
