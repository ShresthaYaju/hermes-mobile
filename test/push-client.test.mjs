// pushState() used to trust getSubscription() alone: the browser remembering a
// subscription says nothing about whether the host still holds it, and the
// host can evict an endpoint on its own (delivery failures, the per-owner
// cap, a state file that did not survive a restart). A device would then keep
// showing "On" forever with nothing actually being delivered.
//
// Kinds cover the newer half of the same client: notifications.mjs now fans
// out several kinds of push (approval, reply, error, ops, job) and lets each
// device pick which it wants. That choice lives in localStorage and is only
// ever told to the host through /push/subscribe's `kinds` field.
//
// No DOM here, in the style of chat.test.mjs and store's outbox tests: fetch,
// navigator, window and localStorage are stubbed just enough for push.js's
// own logic to run, and nothing else is asserted against a real browser API.

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

// Same Map-backed stand-in chat.test.mjs uses for the outbox: getPushKinds()
// and setPushKinds() must exercise a real getItem/setItem round trip, not a
// no-op.
const cells = new Map();
globalThis.localStorage = {
  getItem: (key) => (cells.has(key) ? cells.get(key) : null),
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: (key) => cells.delete(key),
};

const ALL_KINDS = ['approval', 'reply', 'error', 'ops', 'job'];

const calls = [];

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function stubFetch({ subscribeStatus = 204, configKinds } = {}) {
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path === '/push/config') {
      const body = { enabled: true, publicKey: 'BASE64URLKEY' };
      if (configKinds) body.kinds = configKinds;
      return jsonResponse(200, body);
    }
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

const { pushState, getPushKinds, setPushKinds, PUSH_KINDS } = await import('../public/lib/push.js');
const { api } = await import('../public/lib/api.js');

test.beforeEach(() => {
  calls.length = 0;
  cells.clear();
});

test('an existing browser subscription is re-POSTed to /push/subscribe exactly once, carrying kinds', async () => {
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
    kinds: ALL_KINDS,
  });
  assert.equal(result.available, true);
  assert.equal(result.subscribed, true);
  assert.equal(result.reason, 'On');
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

// ------------------------------------------------------------------ kinds --

test('PUSH_KINDS lines up with notifications.mjs, in the same order', () => {
  assert.deepEqual(
    PUSH_KINDS.map((kind) => kind.id),
    ALL_KINDS,
  );
  for (const kind of PUSH_KINDS) {
    assert.equal(typeof kind.label, 'string');
    assert.equal(typeof kind.hint, 'string');
    assert.ok(kind.label && kind.hint);
  }
});

test('getPushKinds defaults to every kind when nothing is stored', () => {
  assert.deepEqual(getPushKinds(), ALL_KINDS);
});

test('setPushKinds persists the choice, in PUSH_KINDS order regardless of input order', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  await setPushKinds(['job', 'approval']);
  assert.deepEqual(getPushKinds(), ['approval', 'job']);
});

test('turning every kind off stays off: an empty choice is not "unset"', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  await setPushKinds([]);
  assert.deepEqual(getPushKinds(), []);
});

test('setPushKinds drops ids PUSH_KINDS does not recognise', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  await setPushKinds(['approval', 'not-a-real-kind']);
  assert.deepEqual(getPushKinds(), ['approval']);
});

test('a choice survives a reload the same way the outbox does', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  await setPushKinds(['error']);
  // Re-importing is not needed to prove persistence here: getPushKinds()
  // always reads storage fresh, never a cached in-module value.
  assert.deepEqual(getPushKinds(), ['error']);
});

test('setPushKinds re-POSTs /push/subscribe with the new kinds when a subscription exists', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => makeSubscription() },
  });

  await setPushKinds(['approval', 'error']);

  const posts = calls.filter((c) => c.path === '/push/subscribe');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body).kinds, ['approval', 'error']);
});

test('setPushKinds does not touch the network when there is no subscription to update', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  await setPushKinds(['approval']);
  assert.equal(calls.filter((c) => c.path === '/push/subscribe').length, 0);
  // The choice must still be recorded even though nothing was posted --
  // enablePush() reads it the next time this device subscribes.
  assert.deepEqual(getPushKinds(), ['approval']);
});

test('api.subscribePush carries kinds in the request body', async () => {
  stubFetch();
  await api.subscribePush({ endpoint: 'https://push.example/z', keys: {} }, ['ops', 'job']);
  const posts = calls.filter((c) => c.path === '/push/subscribe');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), {
    endpoint: 'https://push.example/z',
    keys: {},
    kinds: ['ops', 'job'],
  });
});

test('api.subscribePush omits kinds entirely (not as null/[]) when none are given', async () => {
  stubFetch();
  await api.subscribePush({ endpoint: 'https://push.example/z', keys: {} });
  const posts = calls.filter((c) => c.path === '/push/subscribe');
  assert.deepEqual(Object.keys(JSON.parse(posts[0].body)).sort(), ['endpoint', 'keys']);
});

test('pushState reports the kinds the host supports, intersected with what we know', async () => {
  stubFetch({ configKinds: ['approval', 'job', 'a-future-kind-we-do-not-know-yet'] });
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  const result = await pushState();
  assert.deepEqual(result.kinds, ['approval', 'job']);
});

test('pushState falls back to every kind when the host omits the kinds field', async () => {
  stubFetch();
  globalThis.navigator.serviceWorker.ready = Promise.resolve({
    pushManager: { getSubscription: async () => null },
  });

  const result = await pushState();
  assert.deepEqual(result.kinds, ALL_KINDS);
});
