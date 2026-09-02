import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);

const frontendFiles = ['app.js', 'service-worker.js'].concat(
  ...['lib', 'views'].map((dir) =>
    readdirSync(new URL(`${dir}/`, publicDir)).map((name) => `${dir}/${name}`),
  ),
);

const read = (name) => readFileSync(new URL(name, publicDir), 'utf8');

test('PWA manifest is standalone and has an icon', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons?.length);
});

test('frontend only opens Hermes through the same-origin API WebSocket', () => {
  assert.match(read('lib/rpc.js'), /\/api\/ws/);
  // No module may reach past the proxy to the loopback backend, which would
  // both leak the topology and fail from a phone.
  for (const name of frontendFiles) {
    assert.doesNotMatch(read(name), /127\.0\.0\.1|localhost:9119/, `${name} must stay same-origin`);
  }
});

// The session credential lives only in the proxy process. If it ever appears in
// a shipped file it has been served to every device on the tailnet.
test('no frontend file carries the Hermes session token', () => {
  for (const name of frontendFiles) {
    assert.doesNotMatch(read(name), /HERMES_DASHBOARD_SESSION_TOKEN|X-Hermes-Session-Token/i, name);
  }
});

// The old worker was cache-first and never bumped its cache name, so installed
// home-screen apps were pinned to whatever shipped on their first visit.
test('the service worker precaches every shipped module', () => {
  const worker = read('service-worker.js');
  for (const name of frontendFiles) {
    if (name === 'service-worker.js') continue;
    assert.match(worker, new RegExp(`'/${name.replace('.', '\\.')}'`), `${name} is not precached`);
  }
});

// The write used to run outside waitUntil and had no .catch, so a worker
// recycled mid-write lost the cache silently and a rejection went nowhere.
// There is no SW runtime in Node to execute this against, so the fix is
// pinned at the source level: the same statement that opens the cache must be
// an argument to event.waitUntil, and the chain must end in a catch.
test('the fetch handler writes its cache copy inside waitUntil, with a catch', () => {
  const worker = read('service-worker.js');
  const fetchHandler = worker.slice(
    worker.indexOf("addEventListener('fetch'"),
    worker.indexOf("addEventListener('push'"),
  );
  assert.match(
    fetchHandler,
    /event\.waitUntil\(\s*caches\s*\.open\(CACHE\)\s*\.then\(\(cache\) => cache\.put\(request, copy\)\)\s*\.catch\(\(\) => \{\}\),?\s*\)/,
    'caches.open(...).then(cache => cache.put(...)) must be wrapped in event.waitUntil(...) with a .catch',
  );
});

// notificationclick used to navigate the first same-origin client it found,
// visible or not -- silently redirecting a background tab nobody was looking
// at instead of opening a fresh window.
test('notificationclick only navigates a visible client, and opens a window otherwise', () => {
  const worker = read('service-worker.js');
  const handler = worker.slice(
    worker.indexOf("addEventListener('notificationclick'"),
    worker.indexOf("addEventListener('pushsubscriptionchange'"),
  );
  assert.match(handler, /visibilityState === 'visible'/, 'must prefer a visible/focused client');
  assert.match(
    handler,
    /self\.clients\.openWindow\(/,
    'a background-only match must open a window',
  );
  // sameOriginTarget() itself is audited correct and must stay as-is.
  assert.match(worker, /function sameOriginTarget\(url\)/);
});

// The server can evict a subscription on its own (cap, failures, a lost state
// file); the platform's own way of telling this app is pushsubscriptionchange,
// and a worker with no listener for it just stops delivering, silently.
test('pushsubscriptionchange re-subscribes with the host key and re-registers it', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /addEventListener\('pushsubscriptionchange'/);
  const handler = worker.slice(worker.indexOf("addEventListener('pushsubscriptionchange'"));
  assert.match(handler, /event\.waitUntil\(/, "must extend the worker's lifetime while it runs");
  assert.match(handler, /\/push\/config/, 'must fetch the current VAPID public key from the host');
  assert.match(handler, /pushManager\.subscribe\(/, 'must re-subscribe the browser');
  assert.match(
    handler,
    /applicationServerKey/,
    'must re-subscribe with the same host key, not a stale one',
  );
  assert.match(
    handler,
    /\/push\/subscribe/,
    'must tell the host about the replacement subscription',
  );
  assert.match(
    handler,
    /credentials:\s*'same-origin'/,
    'must carry the identity cookie back to the host',
  );
});
