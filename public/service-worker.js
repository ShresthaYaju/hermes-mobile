// Service worker: offline shell + push delivery.
//
// Network-first for app assets, deliberately. The previous cache-first worker
// pinned whatever shipped on the first visit, so an installed home-screen app
// could never pick up a new build. Cache is the fallback, not the source.

const CACHE = 'hermes-mobile-v4';

const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/styles/shell.css',
  '/styles/chat.css',
  '/styles/config.css',
  '/styles/transcript.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/lib/api.js',
  '/lib/rpc.js',
  '/lib/ui.js',
  '/lib/store.js',
  '/lib/router.js',
  '/lib/push.js',
  '/lib/threads.js',
  '/lib/transcript.js',
  '/views/now.js',
  '/views/threads.js',
  '/views/work.js',
  '/views/job.js',
  '/views/transcript.js',
  '/views/chat.js',
  '/views/config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing file must not fail the whole install and leave the app
      // without a worker at all.
      .then((cache) => Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache agent data or push endpoints: a stale session list is worse
  // than no session list.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/push/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation offline should still land on the shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Hermes';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'hermes',
      // Job failures replace their own earlier notification rather than
      // stacking one per tick.
      renotify: Boolean(data.tag),
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: data.url || '/#/work' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/#/work';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
