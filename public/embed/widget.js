/**
 * 智能体嵌入浮窗组件（V3.1 #12 嵌入代码，2026-11-03）
 * 用法：第三方站点粘贴生成的 script 标签——
 *   <script>(function(){var s=document.createElement('script');s.async=true;
 *     s.src="本站地址/embed/widget.js?token=SHARE_TOKEN";document.body.appendChild(s);})();</script>
 * 行为：页面右下角渲染对话球（可拖动）→ 点击展开 380x560 浮窗 iframe（src=/share/:token）。
 *   iframe 高度自适应：监听 share 页的 ap-share-height postMessage 消息（仅接受白名单 origin——
 *   安全报告 T2.2：event.origin 必须等于浮窗 iframe 自身 src 的源，防跨域消息伪造）。
 * 零依赖单文件；宿主无需引入任何 CSS。
 */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var token = (qs.get('token') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  if (!token) return console.warn('[agent-embed] 缺少 token 参数，浮窗未渲染');
  // 站点根地址 = 本脚本自身的 src origin（宿主页面与平台跨域也能正确解析）
  var origin = (function () {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return ''; }
  })();
  if (!origin) return console.warn('[agent-embed] 无法解析平台地址，浮窗未渲染');

  var ball = document.createElement('div');
  ball.textContent = '💬';
  var css = {
    position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483000',
    width: '56px', height: '56px', borderRadius: '50%',
    background: 'linear-gradient(135deg,#2563eb,#7c3aed)', color: '#fff',
    fontSize: '24px', lineHeight: '56px', textAlign: 'center', cursor: 'pointer',
    boxShadow: '0 6px 24px rgba(37,99,235,.35)', transition: 'transform .15s',
    userSelect: 'none', webkitUserSelect: 'none', fontFamily: 'sans-serif',
  };
  for (var k in css) ball.style[k] = css[k];
  ball.title = '打开 AI 助手';

  var panel = document.createElement('div');
  var pcss = {
    position: 'fixed', right: '24px', bottom: '96px', zIndex: '2147483000',
    width: '380px', height: '560px', maxHeight: 'calc(100vh - 130px)',
    borderRadius: '16px', overflow: 'hidden', display: 'none',
    boxShadow: '0 12px 48px rgba(15,23,42,.28)', background: '#fff',
    flexDirection: 'column',
  };
  for (var pk in pcss) panel.style[pk] = pcss[pk];

  var frame = document.createElement('iframe');
  frame.src = origin + '/share/' + token;
  frame.title = 'AI 助手';
  frame.setAttribute('style', 'width:100%;height:100%;border:0');
  frame.setAttribute('allow', 'clipboard-write');
  panel.appendChild(frame);
  document.body.appendChild(panel);
  document.body.appendChild(ball);

  var open = false;
  ball.onmouseenter = function () { ball.style.transform = 'scale(1.08)'; };
  ball.onmouseleave = function () { ball.style.transform = 'scale(1)'; };
  ball.onclick = function () {
    open = !open;
    panel.style.display = open ? 'flex' : 'none';
    ball.textContent = open ? '✕' : '💬';
    ball.title = open ? '收起 AI 助手' : '打开 AI 助手';
  };

  // iframe 高度自适应：只接受来自浮窗 iframe 自身 origin 的消息（防伪造，安全报告 T2.2）
  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    var d = e.data || {};
    if (d.type === 'ap-share-height' && typeof d.height === 'number' && d.height > 200 && d.height < 2000) {
      panel.style.height = Math.min(Math.round(d.height), window.innerHeight - 130) + 'px';
    }
  });

  // Esc 收起（宿主键盘体验）
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) ball.onclick(); });
})();
