/** 创作资产（D1-3，2026-11-20）：项目 / 素材库 / 分镜 三件套
 *  - 项目卡片（含素材数/分镜数/复用数）→ 进入项目详情
 *  - 详情：复用率统计 + 素材网格（可登记生成物 URL / 删）+ 分镜列表（生成时优先复用已有素材、可手动挂载）
 *  纯 DOM 事件委托，零依赖。 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';
import { t } from '../i18n.js';

const KIND_ICON = { image: '🖼️', video: '🎬', audio: '🎵', text: '📄', '3d': '🧊', other: '📦' };
let S = { projects: [], current: null };

export async function render(box) {
  box.innerHTML = `
  <div class="page-head" style="display:flex;justify-content:space-between;align-items:center">
    <h2>🎨 ${t('创作资产')} <span class="sub">${t('项目 · 素材库 · 分镜')}</span></h2>
    <button class="btn primary" id="newProject">＋ ${t('新建项目')}</button>
  </div>
  <div id="creationBody">${t('加载中…')}</div>`;

  box.querySelector('#newProject').onclick = () => projectForm();
  box.addEventListener('click', onDelegatedClick);
  await loadProjects();
  return { destroy: () => box.removeEventListener('click', onDelegatedClick) };
}

async function loadProjects() {
  const body = document.getElementById('creationBody');
  try {
    const r = await api('/creation/projects');
    S.projects = r.data || [];
  } catch (e) { body.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">${esc(e.message)}</div>`; return; }
  if (!S.projects.length) {
    body.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-3)">${t('还没有创作项目，点击右上角「新建项目」开始')}</div>`;
    return;
  }
  body.innerHTML = `<div class="grid-3">${S.projects.map(p => `
    <div class="card" style="padding:18px;cursor:pointer" data-open="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <h3 style="margin:0 0 6px">🆔 ${esc(p.name)}</h3>
        <span style="font-size:12px;color:var(--text-3)">${esc(p.status)}</span>
      </div>
      <p style="color:var(--text-3);font-size:13px;min-height:34px;margin:0 0 10px">${esc((p.description || '').slice(0, 60) || t('（无描述）'))}</p>
      <div style="display:flex;gap:14px;font-size:12px;color:var(--text-2)">
        <span>🖼️ ${t('素材')} ${p.assets}</span><span>🎬 ${t('分镜')} ${p.shots}</span><span>♻️ ${t('复用')} ${p.reused}</span>
      </div>
    </div>`).join('')}</div>`;
}

async function openProject(id) {
  const body = document.getElementById('creationBody');
  body.innerHTML = t('加载中…');
  let d;
  try { d = (await api('/creation/projects/' + id)).data; } catch (e) { body.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">${esc(e.message)}</div>`; return; }
  S.current = d;
  const rate = Math.round((d.stats?.rate || 0) * 100);
  body.innerHTML = `
  <div class="card" style="padding:18px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <button class="btn" data-back>← ${t('返回')}</button>
        <b style="font-size:17px;margin-left:10px">🆔 ${esc(d.name)}</b>
        <span class="sub" style="margin-left:8px">${t('类型')} ${esc(d.kind)}</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" data-addasset="${d.id}">＋ ${t('登记素材')}</button>
        <button class="btn" data-gen3d="${d.id}">🧊 ${t('生成 3D 资产')}</button>
        <button class="btn" data-addshot="${d.id}">＋ ${t('新增分镜')}</button>
      </div>
    </div>
    <div style="display:flex;gap:20px;margin-top:12px;font-size:13px;color:var(--text-2)">
      <span>🖼️ ${t('素材')} ${d.assets.length}</span>
      <span>🎬 ${t('分镜')} ${d.shots.length}</span>
      <span>♻️ ${t('素材复用率')} <b style="color:${rate >= 50 ? 'var(--green,#16a34a)' : 'var(--text-2)'}">${rate}%</b></span>
    </div>
  </div>

  <div class="card" style="padding:18px;margin-bottom:16px">
    <h3 style="margin:0 0 12px">🖼️ ${t('素材库')}</h3>
    ${d.assets.length ? `<div class="grid-3">${d.assets.map(a => `
      <div class="card" style="padding:10px;position:relative">
        <div style="height:96px;background:var(--bg,#f3f4f6);border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden">
          ${a.kind === 'image' && a.url ? `<img src="${esc(a.url)}" alt="" style="max-width:100%;max-height:96px" onerror="this.style.display='none'">` : `<span style="font-size:30px">${KIND_ICON[a.kind] || '📦'}</span>`}
        </div>
        <div style="margin-top:8px;font-size:13px"><b>${esc(a.name || '#' + a.id)}</b></div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(a.kind)} · ${esc(a.source)}${a.compliance && a.compliance.level !== 'OK' ? ' · <span style="color:#dc2626">' + esc(a.compliance.level) + '</span>' : ''}</div>
        ${a.kind === '3d' ? `<button class="btn" style="margin-top:6px;padding:2px 8px;font-size:12px" data-export="${a.id}">⬇ ${t('导出')}</button>` : ''}
        <button class="btn" style="position:absolute;top:8px;right:8px;padding:2px 8px" data-delasset="${a.id}" title="${t('删除')}">✕</button>
      </div>`).join('')}</div>` : `<div class="hint" style="color:var(--text-3)">${t('暂无素材')}</div>`}
  </div>

  <div class="card" style="padding:18px">
    <h3 style="margin:0 0 12px">🎬 ${t('分镜')}</h3>
    ${d.shots.length ? `<table class="table" style="width:100%">
      <thead><tr><th>#</th><th>${t('标题/提示词')}</th><th>${t('引用素材')}</th><th>${t('状态')}</th><th>${t('操作')}</th></tr></thead>
      <tbody>${d.shots.map(s => {
        const a = d.assets.find(x => x.id === s.asset_id);
        return `<tr>
          <td>${s.seq}</td>
          <td><b>${esc(s.title || '—')}</b><div style="font-size:12px;color:var(--text-3)">${esc((s.prompt || s.description || '').slice(0, 60))}</div></td>
          <td>${a ? `♻️ ${esc(a.name || '#' + a.id)}` : '<span style="color:var(--text-3)">—</span>'}</td>
          <td>${esc(s.status)}</td>
          <td style="white-space:nowrap">
            <button class="btn" style="padding:2px 8px" data-resolve="${s.id}">${t('优先复用')}</button>
            <button class="btn" style="padding:2px 8px" data-attach="${s.id}">${t('挂载素材')}</button>
            <button class="btn" style="padding:2px 8px" data-delshot="${s.id}">✕</button>
          </td></tr>`;
      }).join('')}</tbody></table>` : `<div class="hint" style="color:var(--text-3)">${t('暂无分镜')}</div>`}
  </div>`;
}

function projectForm() {
  modal({
    title: t('新建项目'),
    body: `<div class="st-field"><label>${t('项目名称')}</label><input id="pjName" class="input" style="width:100%"></div>
      <div class="st-field" style="margin-top:10px"><label>${t('类型')}</label>
        <select id="pjKind" class="input"><option value="video">${t('视频')}</option><option value="image">${t('图文')}</option><option value="mixed">${t('混合')}</option></select></div>
      <div class="st-field" style="margin-top:10px"><label>${t('描述')}</label><textarea id="pjDesc" class="input" style="width:100%;height:70px"></textarea></div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('创建')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-ok]').onclick = async () => {
        const name = mask.querySelector('#pjName').value.trim();
        if (!name) return toast(t('请填写项目名称'), 'err');
        try {
          await api('/creation/projects', { method: 'POST', body: { name, kind: mask.querySelector('#pjKind').value, description: mask.querySelector('#pjDesc').value } });
          close(); toast(t('项目已创建')); await loadProjects();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function assetForm(projectId) {
  modal({
    title: t('登记素材'),
    body: `<div class="st-field"><label>${t('素材 URL')}（/uploads/... 生成物路径或 http(s) 链接）</label><input id="asUrl" class="input" style="width:100%" placeholder="/uploads/gen-images/xxx.png"></div>
      <div class="st-field" style="margin-top:10px"><label>${t('类型')}</label>
        <select id="asKind" class="input"><option value="image">${t('图片')}</option><option value="video">${t('视频')}</option><option value="audio">${t('音频')}</option><option value="text">${t('文本')}</option><option value="3d">${t('3D 模型')}</option></select></div>
      <div class="st-field" style="margin-top:10px"><label>${t('名称')}</label><input id="asName" class="input" style="width:100%"></div>
      <div class="st-field" style="margin-top:10px"><label>${t('标签')}（逗号分隔，用于复用匹配）</label><input id="asTags" class="input" style="width:100%"></div>
      <label style="display:flex;gap:6px;margin-top:10px;font-size:13px"><input type="checkbox" id="asReal"> ${t('含真人素材（需合规评估）')}</label>
      <label style="display:flex;gap:6px;margin-top:6px;font-size:13px"><input type="checkbox" id="asDH"> ${t('含数字人/合成形象')}</label>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('登记')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-ok]').onclick = async () => {
        const url = mask.querySelector('#asUrl').value.trim();
        if (!url) return toast(t('请填写素材 URL'), 'err');
        try {
          await api('/creation/assets/import', { method: 'POST', body: {
            project_id: projectId, url, kind: mask.querySelector('#asKind').value, name: mask.querySelector('#asName').value,
            tags: mask.querySelector('#asTags').value, real_person: mask.querySelector('#asReal').checked ? 1 : 0, digital_human: mask.querySelector('#asDH').checked ? 1 : 0,
          } });
          close(); toast(t('素材已登记')); await openProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function gen3DForm(projectId) {
  modal({
    title: `🧊 ${t('生成 3D 资产')}`,
    body: `<div class="st-field"><label>${t('3D 提示词')}</label><textarea id="g3Prompt" class="input" style="width:100%;height:80px" placeholder="${t('例如：一把低多边形风格的中世纪木椅')}"></textarea></div>
      <div class="st-field" style="margin-top:10px"><label>${t('目标格式')}</label>
        <select id="g3Fmt" class="input"><option value="glb">glb（二进制 glTF）</option><option value="gltf">gltf（文本 glTF）</option><option value="obj">obj</option><option value="stl">stl</option><option value="fbx">fbx</option><option value="usdz">usdz</option></select></div>
      <div class="hint" style="margin-top:8px;color:var(--text-3);font-size:12px">${t('提交后由平台 3D 生成通道产出；未配置第三方 3D 服务时降级为本地占位模型（provider=local-stub）。')}</div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('生成')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-ok]').onclick = async () => {
        const prompt = mask.querySelector('#g3Prompt').value.trim();
        if (!prompt) return toast(t('请填写 3D 提示词'), 'err');
        const btn = mask.querySelector('[data-ok]'); btn.disabled = true; btn.textContent = t('生成中…');
        try {
          const r = await api('/model3d/generate', { method: 'POST', body: { project_id: projectId, prompt, format: mask.querySelector('#g3Fmt').value } });
          if (r.data?.status === 'success') toast(t('3D 资产已生成并登记'), 'ok');
          else toast(t('生成失败：') + (r.raw?.error || r.data?.error || ''), 'err');
          close(); await openProject(projectId);
        } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = t('生成'); }
      };
    },
  });
}

function exportDialog(assetId, projectId) {
  const a = (S.current?.assets || []).find(x => x.id === assetId) || {};
  const src = (a.meta && a.meta.format) || 'glb';
  modal({
    title: `⬇ ${t('导出 3D 资产')}`,
    body: `<div style="font-size:13px;color:var(--text-2)">${t('源格式')}：<b>${esc(src)}</b></div>
      <div class="st-field" style="margin-top:10px"><label>${t('目标格式')}</label>
        <select id="exFmt" class="input"><option value="glb">glb</option><option value="gltf">gltf</option><option value="obj">obj</option><option value="stl">stl</option><option value="fbx">fbx</option><option value="usdz">usdz</option><option value="ply">ply</option></select></div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('导出')}</button>`,
    onMount(mask, close) {
      mask.querySelector('#exFmt').value = src;
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-ok]').onclick = async () => {
        try {
          const r = await api(`/model3d/assets/${assetId}/export`, { method: 'POST', body: { target_format: mask.querySelector('#exFmt').value } });
          toast(r.data?.message || t('已导出'), 'ok');
          if (r.data?.url) window.open(r.data.url, '_blank');
          close();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function shotForm(projectId) {
  modal({
    title: t('新增分镜'),
    body: `<div class="st-field"><label>${t('标题')}</label><input id="shTitle" class="input" style="width:100%"></div>
      <div class="st-field" style="margin-top:10px"><label>${t('画面提示词')}</label><textarea id="shPrompt" class="input" style="width:100%;height:70px"></textarea></div>`,
    foot: `<button class="btn" data-cancel>${t('取消')}</button><button class="btn primary" data-ok>${t('新增')}</button>`,
    onMount(mask, close) {
      mask.querySelector('[data-cancel]').onclick = close;
      mask.querySelector('[data-ok]').onclick = async () => {
        try {
          await api('/creation/shots', { method: 'POST', body: { project_id: projectId, title: mask.querySelector('#shTitle').value, prompt: mask.querySelector('#shPrompt').value } });
          close(); toast(t('分镜已新增')); await openProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function attachDialog(shotId, projectId) {
  const assets = S.current?.assets || [];
  if (!assets.length) return toast(t('本项目暂无素材可挂载'), 'info');
  modal({
    title: t('挂载已有素材（复用）'),
    body: `<div style="display:flex;flex-wrap:wrap;gap:8px">${assets.map(a => `<button class="btn" data-pick="${a.id}">${KIND_ICON[a.kind] || '📦'} ${esc(a.name || '#' + a.id)}</button>`).join('')}</div>`,
    onMount(mask, close) {
      mask.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => {
        try { await api(`/creation/shots/${shotId}/attach`, { method: 'POST', body: { asset_id: +b.dataset.pick } }); close(); toast(t('已复用')); await openProject(projectId); }
        catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

async function onDelegatedClick(e) {
  const t2 = e.target.closest('[data-open],[data-back],[data-addasset],[data-addshot],[data-delasset],[data-resolve],[data-attach],[data-delshot],[data-gen3d],[data-export]');
  if (!t2) return;
  const d = t2.dataset;
  try {
    if (d.open) return openProject(+d.open);
    if (d.back !== undefined) return loadProjects();
    if (d.addasset) return assetForm(+d.addasset);
    if (d.addshot) return shotForm(+d.addshot);
    if (d.gen3d) return gen3DForm(+d.gen3d);
    if (d.export) return exportDialog(+d.export, S.current?.id);
    if (d.delasset) {
      if (!await confirmBox(t('删除该素材？引用它的分镜将解除引用。'))) return;
      await api('/creation/assets/' + d.delasset, { method: 'DELETE' }); toast(t('已删除素材')); return openProject(S.current.id);
    }
    if (d.delshot) {
      if (!await confirmBox(t('删除该分镜？'))) return;
      await api('/creation/shots/' + d.delshot, { method: 'DELETE' }); toast(t('已删除分镜')); return openProject(S.current.id);
    }
    if (d.attach) return attachDialog(+d.attach, S.current.id);
    if (d.resolve) {
      const r = await api(`/creation/shots/${d.resolve}/resolve`, { method: 'POST', body: {} });
      toast(r.msg || '', r.data?.reused ? 'ok' : 'info');
      return openProject(S.current.id);
    }
  } catch (err) { toast(err.message, 'err'); }
}
