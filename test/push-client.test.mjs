// pushState() used to trust getSubscription() alone: the browser remembering a
// subscription says nothing about whether the host still holds it, and the
// host can evict an endpoint on its own (delivery failures, the per-owner
// cap, a state file that did not survive a restart). A device would then keep
// showing "On" forever with nothing actually being delivered.
//
// No DOM here, in the style of chat.test.mjs and store's outbox tests: fetch,
// navigator and window are stubbed just enough for pushState()'s own logic to
// run, and nothing else is asserted against a real browser API.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.PushManager = class {};
globalThis.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
globalThis.matchMedia = () => ({ matches: false });
// Node's own global `navigator` is a getter-only property (it reports the
// runtime's own user agent), so it has to be redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { serviceWorker: {}, userAgent: 'TestBrowser/1.0', standalone: false },
  configurable: true,
  writable: true,
});

const calls = [];

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function stubFetch({ subscribeStatus = 204 } = {}) {
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path === '/push/config')
      return jsonResponse(200, { enabled: true, publicKey: 'BASE64URLKEY' });
    if (path === '/push/subscribe') {
      return jsonResponse(subscribeStatus, subscribeStatus === 204 ? null : { error: 'refused' });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
}

function makeSubscription(endpoint = 'https://push.example/abc') {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'x', auth: 'y' } }),
  };
}

const { pushState } = await import('../public/lib/push.js');

test.beforeEach(() => {
  calls.length = 0;
});

test('an existing browser subscription is re-POSTed to /push/subscribe exactly once', async () => {
  stubFetch({ subscribeStatus: 204 });
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => makeSubscription() },
  });

  const result = await pushState();

  const posts = calls.filter((c) => c.path === '/push/subscribe');
  assert.equal(posts.length, 1, 'exactly one POST to /push/subscribe');
  assert.equal(posts[0].method, 'POST');
  assert.deepEqual(JSON.parse(posts[0].body), {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'x', auth: 'y' },
  });
  assert.equal(result.available, true);
  assert.equal(result.subscribed, true);
});

test('a subscription the host refuses (non-2xx, non-204) is reported stale', async () => {
  stubFetch({ subscribeStatus: 400 });
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => makeSubscription() },
  });

  const result = await pushState();
  assert.equal(result.subscribed, false);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'Needs re-enabling');
});

test('no browser subscription means no POST at all', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  const result = await pushState();
  assert.equal(calls.filter((c) => c.path === '/push/subscribe').length, 0);
  assert.equal(result.subscribed, false);
});
