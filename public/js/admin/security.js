/** 后台-安全合规：敏感词库 + 拦截统计 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

export async function render(el) {
  let cates = [], words = [], stats = null, curCate = '';

  el.innerHTML = `
    <div class="page-head"><h2>安全合规</h2><div class="desc">敏感词库管理与双向拦截策略：输入命中即拦截提问，输出命中自动脱敏；支持分类、批量导入与拦截统计。</div></div>
    <div class="grid-stats" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
      <div class="stat-card"><div class="label">敏感词总量</div><div class="num" id="s_total">-</div><div class="accent" style="background:#2563eb"></div></div>
      <div class="stat-card"><div class="label">输入拦截开启</div><div class="num" style="color:#d97706" id="s_in">-</div><div class="accent" style="background:#d97706"></div></div>
      <div class="stat-card"><div class="label">输出拦截开启</div><div class="num" style="color:#db2777" id="s_out">-</div><div class="accent" style="background:#db2777"></div></div>
      <div class="stat-card"><div class="label">累计拦截次数</div><div class="num" style="color:#dc2626" id="s_hits">-</div><div class="accent" style="background:#dc2626"></div></div>
      <div class="stat-card"><div class="label">注入拦截</div><div class="num" style="color:#7c3aed" id="s_inj">-</div><div class="accent" style="background:#7c3aed"></div></div>
      <div class="stat-card"><div class="label">PII 检出</div><div class="num" style="color:#0891b2" id="s_pii">-</div><div class="accent" style="background:#0891b2"></div></div>
    </div>
    <div class="grid-2" style="margin-top:16px;align-items:start">
      <div class="card">
        <h3>词库分类 <button class="btn sm" id="newCate" style="margin-left:8px">＋ 新增分类</button></h3>
        <div id="cateList"></div>
      </div>
      <div class="card">
        <h3>拦截命中 TOP</h3>
        <table class="tbl"><tbody id="topTbl"></tbody></table>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>🛡️ 安全事件审计 <span class="sub">PII 识别 / 提示词注入检测（输入侧识别告警、输出侧自动脱敏）</span>
        <button class="btn sm" id="evRefresh" style="margin-left:8px">🔄 刷新</button>
      </h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>时间</th><th>类型</th><th>详情</th><th>处置</th></tr></thead>
        <tbody id="evBody"></tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>词汇管理
        <span>
          <button class="btn sm" id="importBtn">📥 批量导入</button>
          <a class="btn sm" href="/api/security/export" style="text-decoration:none">📤 导出</a>
          <button class="btn sm primary" id="newWord">＋ 新增词汇</button>
        </span>
      </h3>
      <div class="toolbar" style="margin-bottom:10px">
        <input class="input" id="w_kw" placeholder="🔍 搜索词汇" style="width:220px">
        <span style="color:var(--text-3);font-size:12px">输入拦截：命中即拒绝提问　|　输出拦截：命中自动脱敏为 ***</span>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>词汇</th><th>分类</th><th>输入拦截</th><th>输出拦截</th><th>命中次数</th><th>操作</th></tr></thead>
        <tbody id="wBody"></tbody>
      </table></div>
    </div>`;

  function renderCates() {
    el.querySelector('#cateList').innerHTML = cates.map(c => `
      <div class="sess-item ${curCate === c.id ? 'active' : ''}" data-c="${c.id}" style="justify-content:space-between">
        <span>${esc(c.name)} <span style="color:var(--text-3);font-size:12px">（${c.word_count}）</span></span>
        <span style="display:flex;gap:6px">
          <span data-edc="${c.id}" style="cursor:pointer">✏️</span>
          <span data-delc="${c.id}" style="cursor:pointer">🗑️</span>
        </span>
      </div>`).join('');
    el.querySelectorAll('[data-c]').forEach(d => d.onclick = e => {
      if (e.target.dataset.edc || e.target.dataset.delc) return;
      curCate = curCate === +d.dataset.c ? '' : +d.dataset.c;
      renderCates(); loadWords();
    });
    el.querySelectorAll('[data-edc]').forEach(b => b.onclick = () => {
      const c = cates.find(x => x.id === +b.dataset.edc);
      const v = prompt('修改分类名称：', c.name);
      if (v && v.trim()) api(`/security/categories/${c.id}`, { method: 'PUT', body: { name: v.trim() } }).then(loadAll);
    });
    el.querySelectorAll('[data-delc]').forEach(b => b.onclick = async () => {
      const c = cates.find(x => x.id === +b.dataset.delc);
      if (!await confirmBox(`删除分类「${c.name}」？`)) return;
      try { await api(`/security/categories/${c.id}`, { method: 'DELETE' }); toast('已删除'); loadAll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  function renderWords() {
    el.querySelector('#wBody').innerHTML = words.map(w => `
      <tr>
        <td><b>${esc(w.word)}</b></td>
        <td><span class="tag gray">${esc(w.category || '未分类')}</span></td>
        <td><span class="switch ${w.input_block ? 'on' : ''}" data-ti="${w.id}" title="点击切换"></span></td>
        <td><span class="switch ${w.output_block ? 'on' : ''}" data-to="${w.id}" title="点击切换"></span></td>
        <td>${w.hit_count}</td>
        <td><button class="btn link" style="color:var(--danger)" data-dw="${w.id}">删除</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无词汇</td></tr>';

    el.querySelectorAll('[data-ti]').forEach(s => s.onclick = async () => {
      const w = words.find(x => x.id === +s.dataset.ti);
      await api(`/security/words/${w.id}`, { method: 'PUT', body: { word: w.word, category_id: w.category_id, input_block: w.input_block ? 0 : 1, output_block: w.output_block } });
      loadWords();
    });
    el.querySelectorAll('[data-to]').forEach(s => s.onclick = async () => {
      const w = words.find(x => x.id === +s.dataset.to);
      await api(`/security/words/${w.id}`, { method: 'PUT', body: { word: w.word, category_id: w.category_id, input_block: w.input_block, output_block: w.output_block ? 0 : 1 } });
      loadWords();
    });
    el.querySelectorAll('[data-dw]').forEach(b => b.onclick = async () => {
      await api('/security/words/' + b.dataset.dw, { method: 'DELETE' });
      loadAll();
    });
  }

  el.querySelector('#newCate').onclick = () => {
    const v = prompt('新分类名称：');
    if (v && v.trim()) api('/security/categories', { method: 'POST', body: { name: v.trim() } }).then(() => { toast('已创建'); loadAll(); });
  };

  el.querySelector('#newWord').onclick = () => {
    const body = `
      <div class="form-item"><label>词汇<span class="req">*</span></label><input class="input" id="nw_word"></div>
      <div class="form-item"><label>分类</label><select class="input" id="nw_cate">${cates.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="form-row">
        <div class="form-item"><label>输入拦截</label><input type="checkbox" id="nw_in" checked style="width:16px;height:16px"></div>
        <div class="form-item"><label>输出拦截</label><input type="checkbox" id="nw_out" checked style="width:16px;height:16px"></div>
      </div>`;
    modal({
      title: '新增敏感词', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>添加</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            await api('/security/words', {
              method: 'POST',
              body: {
                word: mask.querySelector('#nw_word').value,
                category_id: +mask.querySelector('#nw_cate').value,
                input_block: mask.querySelector('#nw_in').checked ? 1 : 0,
                output_block: mask.querySelector('#nw_out').checked ? 1 : 0,
              },
            });
            toast('已添加'); close(); loadAll();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };

  el.querySelector('#importBtn').onclick = () => {
    const body = `
      <div class="form-item"><label>选择分类</label><select class="input" id="im_cate">${cates.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="form-item"><label>词汇内容（每行一个）<span class="req">*</span></label>
        <textarea class="input mono" id="im_text" style="min-height:180px" placeholder="词汇1&#10;词汇2&#10;词汇3"></textarea></div>
      <div class="form-row">
        <div class="form-item"><label>输入拦截</label><input type="checkbox" id="im_in" checked style="width:16px;height:16px"></div>
        <div class="form-item"><label>输出拦截</label><input type="checkbox" id="im_out" checked style="width:16px;height:16px"></div>
      </div>`;
    modal({
      title: '批量导入敏感词', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>导入</button>',
      onMount(mask, close) {
        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const j = await api('/security/words/batch', {
              method: 'POST',
              body: {
                text: mask.querySelector('#im_text').value,
                category_id: +mask.querySelector('#im_cate').value,
                input_block: mask.querySelector('#im_in').checked,
                output_block: mask.querySelector('#im_out').checked,
              },
            });
            toast(`导入完成：新增 ${j.data.added} / ${j.data.total} 个`); close(); loadAll();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };

  el.querySelector('#w_kw').oninput = () => loadWords();

  async function loadStats() {
    stats = (await api('/security/stats')).data;
    el.querySelector('#s_total').textContent = stats.total;
    el.querySelector('#s_in').textContent = stats.inputOn;
    el.querySelector('#s_out').textContent = stats.outputOn;
    el.querySelector('#s_hits').textContent = stats.hits;
    el.querySelector('#topTbl').innerHTML = stats.top.map((t, i) => `
      <tr><td style="width:30px">${i + 1}</td><td>${esc(t.word)}</td><td style="text-align:right"><b style="color:var(--danger)">${t.hit_count}</b></td></tr>`).join('')
      || '<tr><td class="empty">暂无命中</td></tr>';
    await loadEvents();
  }

  async function loadEvents() {
    let j;
    try { j = await api('/security/events?limit=30'); } catch { return; }
    const ev = j.data;
    const cnt = Object.fromEntries(ev.byType.map(x => [x.type, x.c]));
    el.querySelector('#s_inj').textContent = (cnt.injection_blocked || 0) + (cnt.injection_warn ? `（警${cnt.injection_warn}）` : '');
    el.querySelector('#s_pii').textContent = (cnt.pii_input || 0) + (cnt.pii_output || 0);
    const TYPE_META = {
      injection_blocked: ['注入拦截', 'red'], injection_warn: ['注入告警', 'orange'],
      pii_input: ['输入PII', 'blue'], pii_output: ['输出PII脱敏', 'purple'],
    };
    el.querySelector('#evBody').innerHTML = ev.rows.map(r => {
      const [label, tag] = TYPE_META[r.type] || [r.type, 'gray'];
      return `<tr>
        <td style="color:var(--text-3);font-size:12px;white-space:nowrap">${esc(r.created_at || '')}</td>
        <td><span class="tag ${tag}">${label}</span></td>
        <td style="font-size:12px;max-width:480px;word-break:break-all">${esc(r.detail)}</td>
        <td style="font-size:12px">${esc(r.action || '-')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">暂无安全事件（对话输入输出中的 PII 与注入特征将被记录）</td></tr>';
  }

  el.querySelector('#evRefresh').onclick = loadEvents;

  async function loadWords() {
    const kw = el.querySelector('#w_kw').value.trim();
    const q = (curCate ? `category_id=${curCate}&` : '') + (kw ? `keyword=${encodeURIComponent(kw)}` : '');
    words = (await api('/security/words?' + q)).data;
    renderWords();
  }

  async function loadAll() {
    cates = (await api('/security/categories')).data;
    stats = null;
    await Promise.all([loadStats(), loadWords()]);
    renderCates();
  }

  await loadAll();
}
