/* P5.23 Service Worker：离线缓存静态资源
 * 策略：
 *   - HTML 入口：network-first（保证发版即时生效），失败回缓存（离线可开壳）
 *   - /css /js /icons 静态资源：stale-while-revalidate（秒开 + 后台更新）
 *   - /api /** 与 SSE/流式：永不缓存（NEVER_CACHE），直连网络
 *   - 版本号 bump 触发旧缓存清理；仅在同源且非导出/下载请求时缓存
 */
const SW_VERSION = 'p5.23-v1';
const STATIC_CACHE = `ap-static-${SW_VERSION}`;
const NEVER_CACHE = [/^\/api\//, /\/sse/, /\/stream/, /\/files\/download/, /\?[^\s]*download/];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(STATIC_CACHE).then(c => c.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 清理旧版本缓存
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStatic = url => /^\/(css|js|icons|manifest\.json)/.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('.html');

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;               // 跨域不接管
  if (req.method !== 'GET') return;                          // 非幂等请求直连
  if (NEVER_CACHE.some(re => re.test(url.pathname) || re.test(req.url))) return; // API/流式/下载永不缓存
  if (!isStatic(url)) return;                                // 仅静态资源

  // HTML：network-first（发版即时生效）
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(STATIC_CACHE).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then(m => m || caches.match('/')))
    );
    return;
  }

  // 静态资源：stale-while-revalidate（离线用缓存，在线后台刷新）
  e.respondWith(
    caches.match(req).then(cached => {
      const refresh = fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(STATIC_CACHE).then(c => c.put(req, copy)); } return res; })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});

// 主页面离线提示条的通信：SW 侧转发 online/offline 事件给所有客户端（页面侧也有原生事件，双保险）
self.addEventListener('message', e => {
  if (e.data === 'AP_SW_SKIP_WAITING') self.skipWaiting();
});
