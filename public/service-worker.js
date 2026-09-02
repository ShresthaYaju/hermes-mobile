// Service worker: offline shell + push delivery.
//
// Network-first for app assets, deliberately. The previous cache-first worker
// pinned whatever shipped on the first visit, so an installed home-screen app
// could never pick up a new build. Cache is the fallback, not the source.

const CACHE = 'hermes-mobile-v5';

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
          // Was a floating promise: outside waitUntil, the SW could be
          // recycled mid-write, and nothing observed a rejection either. Both
          // now go through the same lifecycle the response itself is on.
          event.waitUntil(
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => {}),
          );
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

function sameOriginTarget(url) {
  const fallback = '/#/work';
  if (typeof url !== 'string' || !url) return fallback;
  try {
    const resolved = new URL(url, self.location.origin);
    return resolved.origin === self.location.origin ? resolved.href : fallback;
  } catch {
    return fallback;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // The payload is encrypted to this host's VAPID keys, so a hostile url here
  // means the keys are already gone -- but a notification click should not be
  // able to navigate the app off-origin regardless of who is sending.
  const url = sameOriginTarget(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // A visible/focused tab is what the reader is actually looking at right
      // now; a background one is not, and navigating it out from under
      // whatever it is doing would be as unwelcome as it is invisible to
      // them. Only a visible tab is a legitimate target -- anything else
      // opens a fresh window instead of hijacking one nobody is looking at.
      const winner = clients.find(
        (client) =>
          client.url.startsWith(self.location.origin) && client.visibilityState === 'visible',
      );
      if (winner) {
        winner.navigate(url).catch(() => {});
        return winner.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

// The platform can invalidate a push subscription on its own -- a browser
// key rotation, the user revoking notification permission at the OS level --
// without this app ever being open to notice. Its contract with us is this
// event: re-subscribe with the same VAPID key and tell the host about the
// replacement, or deliveries start failing silently against a dead endpoint.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let config;
      try {
        config = await fetch('/push/config', { credentials: 'same-origin' }).then((r) => r.json());
      } catch {
        return;
      }
      if (!config?.enabled || !config.publicKey) return;
      let subscription;
      try {
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        });
      } catch {
        // Permission may have been the thing revoked; nothing to re-register.
        return;
      }
      await fetch('/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      }).catch(() => {});
    })(),
  );
});

// Duplicated from lib/push.js rather than imported: this file loads as a
// classic (non-module) script -- registered with no `{ type: 'module' }` --
// so it cannot import across that boundary.
function urlBase64ToUint8Array(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
