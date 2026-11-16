(async function () {
  const token = location.pathname.split('/').pop();
  const $ = s => document.querySelector(s);
  let info = null, sid = null, streaming = false;

      // V3.1 #12 嵌入（2026-11-03）：iframe 嵌入场景高度上报——浮窗组件（/embed/widget.js）监听
      // ap-share-height 消息自适应面板高度。仅在被嵌入（window.parent !== window）时发送，普通浏览器访问零开销。
      const reportHeight = () => {
        try {
          if (window.parent === window) return;
          window.parent.postMessage({ type: 'ap-share-height', height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');
        } catch (e) { /* 跨域受限时静默（高度上报是尽力而为的增强） */ }
      };
      window.addEventListener('load', reportHeight);
      setInterval(reportHeight, 1500); // 流式回复/图片加载引起的高度变化周期上报

      try {
        const r = await fetch(`/api/share/${token}/info`);
        const j = await r.json();
        if (j.code !== 0) throw new Error(j.msg || '链接无效');
        info = j.data;
      } catch (e) { $('#errPage').style.display = ''; $('#errMsg').textContent = e.message; return; }

      document.title = info.name + ' · 智能体分享';
      $('#shareHead').style.display = '';
      $('#chatBox').style.display = '';
      $('#agName').textContent = info.name + (info.source === 'dify' ? '（Dify 搭建）' : '');
      $('#agDesc').textContent = info.description || '智能体平台分享的智能体';
      // ---------- U1-10 表单模式 ----------
      if (info.form_enabled && Array.isArray(info.variables) && info.variables.length) {
        $('#chatBox').style.display = 'none';
        $('#formBox').style.display = '';
        const fmsgs = $('#formMsgs');
        fmsgs.innerHTML = '';
        // 表单构造
        const form = document.createElement('div');
        form.style.cssText = 'padding:20px;overflow-y:auto;flex:1';
        const mapping = { string: 'text', text: 'textarea', number: 'number', select: 'select', file: 'file' };
        form.innerHTML = `<h2 style="margin:0 0 4px;font-size:18px">${escH(info.name)}</h2>
          <p style="color:#6b7280;font-size:13px;margin:0 0 18px">${escH(info.description || '请填写以下表单')}</p>
          <div id="formFields"></div>
          <button class="send-btn" id="formSubmitBtn" style="width:100%;padding:10px;margin-top:14px">提交表单</button>`;
        fmsgs.appendChild(form);
        const fields = $('#formFields');
        info.variables.forEach(v => {
          const label = escH(v.label || v.name);
          const required = v.required ? ' <span style="color:#dc2626">*</span>' : '';
          const type = mapping[v.type] || 'text';
          let input = '';
          if (type === 'textarea') {
            input = `<textarea class="input" data-fn="${escH(v.name)}" placeholder="${escH(v.desc || '')}" style="width:100%;min-height:60px;resize:vertical"></textarea>`;
          } else if (type === 'select' && v.options) {
            const opts = Array.isArray(v.options) ? v.options.map(o => `<option value="${escH(o)}">${escH(o)}</option>`).join('') : '';
            input = `<select class="input" data-fn="${escH(v.name)}" style="width:100%">${opts}</select>`;
          } else if (type === 'file') {
            input = `<input class="input" type="file" data-fn="${escH(v.name)}" style="width:100%">`;
          } else {
            input = `<input class="input" type="${type}" data-fn="${escH(v.name)}" placeholder="${escH(v.desc || '')}" value="${escH(v.default || '')}" style="width:100%">`;
          }
          fields.innerHTML += `<div style="margin-bottom:12px"><label style="font-size:13px;font-weight:600">${label}${required}</label><div style="margin-top:4px">${input}</div></div>`;
        });
        // 提交处理：使用 SSE 接收回执
        $('#formSubmitBtn').onclick = async function() {
          this.disabled = true; this.textContent = '提交中…';
          const payload = {};
          info.variables.forEach(v => {
            const el = fmsgs.querySelector(`[data-fn="${CSS.escape(v.name)}"]`);
            if (!el) return;
            if (v.type === 'file') {
              // 文件类型暂不做 base64 上传，仅标记文件名
              payload[v.name] = el.files?.[0]?.name || '';
            } else {
              payload[v.name] = el.value || '';
            }
          });
          try {
            const res = await fetch(`/api/share/${token}/form/submit`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            form.innerHTML = '<div style="text-align:center;padding:32px"><div style="font-size:40px">📋</div><h2>表单提交成功</h2></div>';
            const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              for (const part of buf.split('\n\n')) {
                if (!part.startsWith('event:')) continue;
                const ev = part.split('\n')[0].replace('event:','').trim();
                const d = part.split('\n').find(l => l.startsWith('data:'));
                if (!d) continue;
                let j; try { j = JSON.parse(d.replace('data:','').trim()); } catch { continue; }
                if (ev === 'receipt' || ev === 'done') {
                  form.innerHTML = `<div style="text-align:center;padding:32px"><div style="font-size:40px">✅</div><h2>${j.status === 'running' ? '表单已接收' : '处理完成'}</h2>
                    <p style="color:#6b7280;font-size:14px;margin-top:8px">${ev === 'receipt' ? '任务已提交，正在执行…' : (j.message || '')}</p>
                    <div style="font-size:12px;color:#9ca3af;margin-top:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:left">
                      <b>回执信息</b><br>任务 ID：<span class="mono">${j.runId}</span><br>状态：${j.status}<br>${ev === 'done' ? '完成时间：' + (j.finishedAt || '') : ''}<br>
                      <pre style="margin:8px 0 0;font-size:11px;background:#f3f4f6;padding:8px;border-radius:6px;max-height:200px;overflow:auto">${JSON.stringify(j.inputs || payload, null, 2)}</pre>
                    </div>
                    <button class="send-btn" onclick="location.reload()" style="margin-top:16px;padding:8px 28px">返回</button></div>`;
                }
                if (ev === 'error') {
                  form.innerHTML = `<div style="text-align:center;padding:32px"><div style="font-size:40px">⚠️</div><h2>提交失败</h2><p style="color:#dc2626">${j.msg}</p><button class="send-btn" onclick="location.reload()" style="margin-top:12px">重试</button></div>`;
                }
              }
            }
          } catch (e) {
            form.innerHTML = `<div style="text-align:center;padding:32px"><div style="font-size:40px">⚠️</div><h2>提交失败</h2><p style="color:#dc2626">${escH(e.message)}</p><button class="send-btn" onclick="location.reload()" style="margin-top:12px">重试</button></div>`;
          }
        };
      } else {
        // 聊天模式（既有逻辑）

        function addMsg(role, text) {
          const div = document.createElement('div');
          div.className = 'msg ' + role;
          div.innerHTML = `<div class="ava2">${role === 'user' ? '我' : 'AI'}</div><div class="bubble"></div>`;
          div.querySelector('.bubble').textContent = text;
          $('#msgs').appendChild(div);
          $('#msgs').scrollTop = $('#msgs').scrollHeight;
          return div.querySelector('.bubble');
        }
      // 聊天模式（既有逻辑）
      // 有效期提示
      if (info.expires_at) {
        const tip = document.createElement('div');
        tip.style.cssText = 'margin:0 auto 10px;max-width:640px;font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:6px 12px;text-align:center';
        tip.textContent = `⏳ 本分享链接有效期至 ${info.expires_at}，到期后将自动失效`;
        $('#msgs').prepend(tip);
      }

      // 欢迎区
      const hero = document.createElement('div');
      hero.style.cssText = 'text-align:center;margin:6vh 0 14px';
      hero.innerHTML = `<div style="font-size:40px">👋</div><h2 style="margin:8px 0 6px">${escH(info.name)}</h2><p style="color:#8a94a6;font-size:13px">${escH(info.description || '有什么可以帮您？')}</p>`;
      $('#msgs').appendChild(hero);
      if (info.opening) addMsg('bot', info.opening);
      if (info.opening_questions?.length) {
        const qs = document.createElement('div');
        qs.className = 'quick-qs';
        qs.innerHTML = info.opening_questions.map(q => `<span class="quick-q">${escH(q)}</span>`).join('');
        qs.querySelectorAll('.quick-q').forEach(el => el.onclick = () => { $('#chatInput').value = el.textContent; send(); });
        $('#msgs').appendChild(qs);
      }

      function escH(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

      async function send() {
        const ta = $('#chatInput');
        const text = ta.value.trim();
        if (!text || streaming) return;
        ta.value = '';
        streaming = true; $('#sendBtn').disabled = true;
        addMsg('user', text);
        const live = addMsg('bot', '');
        live.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
        let acc = '';
        try {
          const res = await fetch(`/api/share/${token}/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid, content: text }),
          });
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
              let ev = '', data = '';
              for (const line of part.split('\n')) {
                if (line.startsWith('event: ')) ev = line.slice(7).trim();
                else if (line.startsWith('data: ')) data = line.slice(6);
              }
              if (!data) continue;
              let j; try { j = JSON.parse(data); } catch { continue; }
              if (ev === 'session' && j.sid) sid = j.sid;
              else if (ev === 'delta') { acc += j.text; live.textContent = acc; $('#msgs').scrollTop = $('#msgs').scrollHeight; }
              else if (ev === 'done') { acc = j.content; live.textContent = acc; }
              else if (ev === 'blocked') { live.textContent = '⛔ ' + j.msg; }
              else if (ev === 'notice') { live.textContent = acc + '\n\n⚠ ' + j.msg; }
              else if (ev === 'error') { live.textContent = '⚠ ' + j.msg; }
            }
          }
        } catch (e) { live.textContent = '⚠ ' + e.message; }
        streaming = false; $('#sendBtn').disabled = false; $('#chatInput').focus();
      }

      $('#sendBtn').onclick = send;
      $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    }

      function escH(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

      async function send() {
        const ta = $('#chatInput');
        const text = ta.value.trim();
        if (!text || streaming) return;
        ta.value = '';
        streaming = true; $('#sendBtn').disabled = true;
        addMsg('user', text);
        const live = addMsg('bot', '');
        live.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
        let acc = '';
        try {
          const res = await fetch(`/api/share/${token}/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid, content: text }),
          });
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
              let ev = '', data = '';
              for (const line of part.split('\n')) {
                if (line.startsWith('event: ')) ev = line.slice(7).trim();
                else if (line.startsWith('data: ')) data = line.slice(6);
              }
              if (!data) continue;
              let j; try { j = JSON.parse(data); } catch { continue; }
              if (ev === 'session' && j.sid) sid = j.sid;
              else if (ev === 'delta') { acc += j.text; live.textContent = acc; $('#msgs').scrollTop = $('#msgs').scrollHeight; }
              else if (ev === 'done') { acc = j.content; live.textContent = acc; }
              else if (ev === 'blocked') { live.textContent = '⛔ ' + j.msg; }
              else if (ev === 'notice') { live.textContent = acc + '\n\n⚠ ' + j.msg; }
              else if (ev === 'error') { live.textContent = '⚠ ' + j.msg; }
            }
          }
        } catch (e) { live.textContent = '⚠ ' + e.message; }
        streaming = false; $('#sendBtn').disabled = false; $('#chatInput').focus();
      }
      $('#sendBtn').onclick = send;
      $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    })();
