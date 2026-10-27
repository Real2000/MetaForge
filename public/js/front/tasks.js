/** 前台-任务管理：任务列表 + 新建（立即/Cron）+ 执行记录 */
import { api } from '../api.js';
import { esc, toast, modal, confirmBox } from '../ui.js';

export async function render(el) {
  let tasks = [];
  let agents = [];
  let me = null;

    el.innerHTML = `
    <div class="page-head">
      <h2>任务管理</h2>
      <div class="desc">对智能体创建「立即执行」或「Cron 定时」任务，支持动态输入参数、启用停用与执行记录追溯。💡 也可以直接在首页对话中说「每天早上9点帮我监控…」，AI 会帮你创建定时任务（确认后自动出现在这里）。</div>
    </div>
    <div class="card">
      <div class="toolbar">
        <span style="color:var(--text-2)">共 ${0} 个任务</span>
        <button class="btn primary" id="newTask">＋ 新增任务</button>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>任务名称</th><th>任务主体</th><th>执行方式</th><th>状态</th><th>上次执行</th><th>结果</th><th>操作</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table></div>
    </div>`;

  function cronDesc(c) {
    if (!c) return '';
    const [m, h, d, , w] = c.split(' ');
    if (m.startsWith('*/')) return `每 ${m.slice(2)} 分钟执行`;
    if (m === '*' && h !== '*') return `每小时 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} 执行`;
    if (d === '*' && w === '*') return `每天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} 执行`;
    if (w !== '*' && d === '*') return `每${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][+w % 7]} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} 执行`;
    if (d !== '*') return `每月 ${d} 号 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} 执行`;
    return c;
  }

  function renderRows() {
    el.querySelector('.toolbar span').textContent = `共 ${tasks.length} 个任务`;
    el.querySelector('#tbody').innerHTML = tasks.map(t => `
      <tr>
        <td><b>${esc(t.name)}</b>${t.username && me && t.username !== me.username ? ` <span class="tag gray" style="font-size:10px">@${esc(t.username)}</span>` : ''}</td>
        <td>🤖 ${esc(t.agent_name || '-')}</td>
        <td>${t.exec_type === 'cron' ? `<span class="tag purple">定时</span> <span class="mono">${esc(t.cron)}</span><br><span style="font-size:11px;color:var(--text-3)">${cronDesc(t.cron)}</span>` : t.exec_type === 'webhook' ? '<span class="tag green">Webhook</span>' : '<span class="tag blue">单次</span>'}</td>
        <td><span class="badge-dot ${t.enabled ? 'on' : 'off'}"></span>${t.enabled ? '启用' : '停用'}</td>
        <td style="color:var(--text-3);font-size:12px">${esc(t.last_run_at || '-')}</td>
        <td>${t.last_result === 'success' ? '<span class="tag green">成功</span>' : t.last_result === 'fail' ? '<span class="tag red">失败</span>' : '<span class="tag gray">未执行</span>'}</td>
        <td>
          <button class="btn link" data-run="${t.id}">执行</button>
          <button class="btn link" data-log="${t.id}">记录</button>
          <button class="btn link" data-tg="${t.id}">${t.enabled ? '停用' : '启用'}</button>
          <button class="btn link" style="color:var(--danger)" data-del="${t.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无任务，点击右上角创建，或在首页对话中让 AI 帮你创建（如“每天 9 点帮我监控科技新闻”)</td></tr>';

    el.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '执行中…';
      try {
        const j = await api(`/tasks/${b.dataset.run}/run`, { method: 'POST' });
        toast(j.data.status === 'success' ? '任务执行成功' : '任务执行失败：' + j.data.output.slice(0, 60), j.data.status === 'success' ? 'ok' : 'err');
        load();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = '执行'; }
    });
    el.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openLogs(+b.dataset.log));
    el.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
      await api(`/tasks/${b.dataset.tg}/toggle`, { method: 'POST' });
      load();
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('删除该任务及其执行记录？')) return;
      await api(`/tasks/${b.dataset.del}`, { method: 'DELETE' });
      toast('已删除'); load();
    });
  }

  function openLogs(taskId) {
    const task = tasks.find(t => t.id === taskId);
    const body = document.createElement('div');
    modal({
      title: `执行记录 - ${task.name}`, body, wide: true,
      onMount(mask, close) {
        api(`/tasks/${taskId}/runs`).then(j => {
          body.innerHTML = j.data.map(r => `
            <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                <span>${r.status === 'success' ? '<span class="tag green">成功</span>' : '<span class="tag red">失败</span>'}</span>
                <span style="font-size:12px;color:var(--text-3)">${esc(r.started_at)} → ${esc(r.finished_at)}</span>
              </div>
              <div class="code-block" style="max-height:200px;overflow-y:auto">${esc(r.output || '')}</div>
            </div>`).join('') || '<div class="empty-box"><div class="big">📋</div>暂无执行记录</div>';
        });
      },
    });
  }

  function openNew() {
    const body = `
      <div class="form-item"><label>任务名称<span class="req">*</span></label><input class="input" id="t_name" maxlength="40" placeholder="如：每日晨间资讯摘要"></div>
      <div class="form-row">
        <div class="form-item"><label>任务主体（智能体）<span class="req">*</span></label>
          <select class="input" id="t_agent">${agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
          <div class="hint" style="margin-top:4px">🎨 画布模式智能体按其编排图执行（定时拉取→分析→生成报告等自动化链路）；表单模式走提示词+知识库</div>
        </div>
        <div class="form-item"><label>执行方式<span class="req">*</span></label>
          <select class="input" id="t_type"><option value="once">立即执行（单次）</option><option value="cron">定时周期执行</option><option value="webhook">Webhook 事件触发</option></select>
        </div>
      </div>
      <div class="form-item" id="cronBox" style="display:none">
        <label>定时周期<span class="req">*</span> <span style="font-size:11px;color:var(--text-3)">（图形化配置，SinguX 式任务周期）</span></label>
        <div class="form-row" style="margin-bottom:8px">
          <div class="form-item" style="margin:0"><select class="input" id="t_unit">
            <option value="min">每分钟</option>
            <option value="hour">每小时</option>
            <option value="day" selected>每天</option>
            <option value="week">每周</option>
            <option value="month">每月</option>
            <option value="expr">高级（Cron 表达式）</option>
          </select></div>
          <div class="form-item" style="margin:0" id="t_timebox"><input class="input" id="t_time" type="time" value="09:00"></div>
          <div class="form-item" style="margin:0;display:none" id="t_weekbox"><select class="input" id="t_week">
            <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5" selected>周五</option><option value="6">周六</option><option value="0">周日</option>
          </select></div>
          <div class="form-item" style="margin:0;display:none" id="t_monthbox"><select class="input" id="t_day">
            ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${i === 0 ? 'selected' : ''}>${i + 1} 号</option>`).join('')}
          </select></div>
        </div>
        <input class="input mono" id="t_cron" style="display:none" value="0 9 * * *" placeholder="分 时 日 月 周">
        <div class="hint" id="cronPreview">生成表达式：<code>0 9 * * *</code>（每天 09:00 执行）</div>
      </div>
      <div class="form-item"><label>输入参数</label>
        <textarea class="input" id="t_input" placeholder="执行时发送给智能体的内容，如：请生成今日科技行业晨间摘要。"></textarea>
      </div>`;
    modal({
      title: '新增任务', body,
      foot: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建并首次执行</button>',
      onMount(mask, close) {
        const typeSel = mask.querySelector('#t_type');
        typeSel.onchange = () => {
          mask.querySelector('#cronBox').style.display = typeSel.value === 'cron' ? '' : 'none';
          mask.querySelector('#t_input').closest('.form-item').querySelector('label').innerHTML = typeSel.value === 'webhook'
            ? '默认输入参数（Webhook 可覆盖）<span style="font-size:11px;color:var(--text-3)">——POST body 传 input/message/text/content 可覆盖此默认值（企微/钉钉消息格式自动提取）</span>'
            : '输入参数';
        };

        // 图形化周期 → cron 表达式双向预览（SinguX 式「每月/1号」下拉，同时保留高级表达式模式）
        const unitSel = mask.querySelector('#t_unit');
        function buildCron() {
          const time = (mask.querySelector('#t_time').value || '09:00').split(':');
          const hh = +time[0] || 0, mm = +time[1] || 0;
          const week = mask.querySelector('#t_week').value;
          const day = mask.querySelector('#t_day').value;
          switch (unitSel.value) {
            case 'min': return '*/5 * * * *';
            case 'hour': return `0 ${hh} * * *`;
            case 'day': return `${mm} ${hh} * * *`;
            case 'week': return `${mm} ${hh} * * ${week}`;
            case 'month': return `${mm} ${hh} ${day} * *`;
            default: return mask.querySelector('#t_cron').value.trim();
          }
        }
        function unitDesc() {
          const time = (mask.querySelector('#t_time').value || '09:00');
          switch (unitSel.value) {
            case 'min': return '每 5 分钟执行一次';
            case 'hour': return `每小时 ${time.slice(0, 5)} 执行`;
            case 'day': return `每天 ${time} 执行`;
            case 'week': return `每${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][+mask.querySelector('#t_week').value]} ${time} 执行`;
            case 'month': return `每月 ${mask.querySelector('#t_day').value} 号 ${time} 执行`;
            default: return '自定义 Cron 表达式';
          }
        }
        function refreshCron() {
          const advanced = unitSel.value === 'expr';
          mask.querySelector('#t_cron').style.display = advanced ? '' : 'none';
          mask.querySelector('#t_timebox').style.display = (advanced || unitSel.value === 'min') ? 'none' : '';
          mask.querySelector('#t_weekbox').style.display = unitSel.value === 'week' ? '' : 'none';
          mask.querySelector('#t_monthbox').style.display = unitSel.value === 'month' ? '' : 'none';
          if (!advanced) mask.querySelector('#t_cron').value = buildCron();
          mask.querySelector('#cronPreview').innerHTML = `生成表达式：<code>${esc(mask.querySelector('#t_cron').value || '-')}</code>（${esc(unitDesc())}）`;
        }
        unitSel.onchange = refreshCron;
        ['#t_time', '#t_week', '#t_day', '#t_cron'].forEach(s => mask.querySelector(s).oninput = refreshCron);
        mask.querySelector('#t_cron').oninput = refreshCron;
        refreshCron();

        mask.querySelector('[data-cancel]').onclick = close;
        mask.querySelector('[data-save]').onclick = async () => {
          try {
            const j = await api('/tasks', {
              method: 'POST',
              body: {
                name: mask.querySelector('#t_name').value.trim(),
                target_id: +mask.querySelector('#t_agent').value,
                exec_type: typeSel.value,
                cron: typeSel.value === 'cron' ? (mask.querySelector('#t_cron').value.trim() || '0 9 * * *') : '',
                params: JSON.stringify({ input: mask.querySelector('#t_input').value.trim() }),
              },
            });
            toast('任务已创建');
            // Webhook 任务展示调用地址（鉴权 token 一次性回传，后端不再回读）
            if (typeSel.value === 'webhook' && j.data?.webhook_token) {
              const whk = `${location.origin}/api/tasks/webhook/${j.data.webhook_token}`;
              close();
              modal({
                title: '🔗 Webhook 调用地址（仅本次展示）',
                body: `<div class="hint" style="margin-bottom:8px">POST 请求该地址即触发智能体执行；body 可传 <code>{"input":"..."}</code> 覆盖默认输入（兼容企微/钉钉消息格式）。</div>
                  <div class="mono" style="word-break:break-all;padding:8px 10px;background:var(--surface-2,#f3f4f6);border-radius:8px;font-size:11.5px">${esc(whk)}</div>`,
                foot: '<button class="btn primary" data-close>我已保存</button>',
                onMount(m2, c2) { m2.querySelector('[data-close]').onclick = c2; },
              });
            } else close();
            // 立即执行一次（webhook 任务不自动执行，等待外部调用）
            if (typeSel.value !== 'webhook') await api(`/tasks/${j.data.id}/run`, { method: 'POST' }).catch(() => { });
            load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function load() {
    const [jt, ja, jm] = await Promise.all([api('/tasks'), api('/agents'), api('/auth/me').catch(() => ({ data: null }))]);
    tasks = jt.data; agents = ja.data; me = jm.data;
    renderRows();
  }

  el.querySelector('#newTask').onclick = openNew;
  await load();
}
