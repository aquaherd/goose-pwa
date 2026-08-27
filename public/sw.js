/* goose-pwa service worker: app-shell cache; ACP traffic is never intercepted
 * (WebSockets bypass service workers entirely; this guards the /acp preflight
 * GET and /status fetch). */

const VERSION = 'goose-pwa-v5';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/config.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // never touch ACP traffic
  if (url.pathname.startsWith('/acp') || url.pathname === '/status') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // app code: network-first so edits/updates show up on the first reload
  // (cache is only an offline fallback). This avoids stale-while-revalidate
  // surprises where a reload still runs the previous app.js/styles.css.
  const isCode = e.request.mode === 'navigate'
    || /\.(js|css|webmanifest|json)$/.test(url.pathname);

  if (isCode) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request)),
    );
    return;
  }

  // icons etc.: cache-first with background refresh
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      });
      return cached || network;
    }),
  );
});
