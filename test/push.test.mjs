import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { startProxy, startFakeHermes, rawGet, rawRequest } from './helpers.mjs';
import { createNotifications } from '../notifications.mjs';

// Generated per run rather than committed: a checked-in private key is a
// credential, even a useless one.
const VAPID = webpush.generateVAPIDKeys();

function tempStateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-mobile-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const withVapid = (stateDir) => ({
  HERMES_MOBILE_VAPID_PUBLIC_KEY: VAPID.publicKey,
  HERMES_MOBILE_VAPID_PRIVATE_KEY: VAPID.privateKey,
  HERMES_MOBILE_VAPID_SUBJECT: 'mailto:test@localhost',
  HERMES_MOBILE_STATE_DIR: stateDir,
});

const subscription = (endpoint) => ({
  endpoint,
  keys: {
    // Well-formed dummy keys: storage and validation never decrypt them.
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});

test('push is reported unavailable when no VAPID keys are configured', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const config = await rawGet(proxy.port, '/push/config');
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body).enabled, false);

  // The app must still work: a missing key is not an error state to surface.
  const subscribe = await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription('x'));
  assert.equal(subscribe.status, 503);
});

test('push config exposes only the public key', async (t) => {
  const proxy = await startProxy({ env: withVapid(tempStateDir(t)) });
  t.after(() => proxy.stop());

  const response = await rawGet(proxy.port, '/push/config');
  const body = JSON.parse(response.body);
  assert.equal(body.enabled, true);
  assert.equal(body.publicKey, VAPID.publicKey);
  assert.doesNotMatch(response.body, new RegExp(VAPID.privateKey.replace(/[-_]/g, '.')));
});

test('subscribe stores a subscription owner-only and unsubscribe removes it', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const endpoint = 'https://push.example/abc';
  const added = await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription(endpoint));
  assert.equal(added.status, 204);

  const statePath = join(stateDir, 'push-state.json');
  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'endpoints are capability URLs');
  assert.match(readFileSync(statePath, 'utf8'), /push\.example/);

  const removed = await rawRequest(proxy.port, 'POST', '/push/unsubscribe', {}, { endpoint });
  assert.equal(removed.status, 204);
  assert.doesNotMatch(readFileSync(statePath, 'utf8'), /push\.example/);
});

test('malformed subscriptions are rejected', async (t) => {
  const proxy = await startProxy({ env: withVapid(tempStateDir(t)) });
  t.after(() => proxy.stop());

  for (const body of [{}, { endpoint: 'https://push.example/x' }, { keys: {} }]) {
    const response = await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, body);
    assert.equal(response.status, 400);
  }
  const unknown = await rawGet(proxy.port, '/push/nope');
  assert.equal(unknown.status, 404);
});

test('push endpoints are handled locally and never forwarded to Hermes', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, env: withVapid(tempStateDir(t)) });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  await rawGet(proxy.port, '/push/config');
  await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    {},
    subscription('https://push.example/a'),
  );
  // The watcher polls cron on start, so filter rather than expecting silence.
  assert.deepEqual(
    hermes.requests.filter((r) => r.url.includes('/push/')),
    [],
  );
});

/** A stub cron API whose job list the test can swap between polls. */
async function fakeCron(initial) {
  let jobs = initial;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(jobs));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    set: (next) => {
      jobs = next;
    },
    async stop() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** Records deliveries in place of the real (HTTPS-only) push transport. */
function recordingDeliver() {
  const sent = [];
  return {
    sent,
    deliver: async (subscription, body) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
    },
  };
}

test('the watcher seeds silently, then notifies once per new failure', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  // A job that is already broken when push is switched on.
  const cron = await fakeCron([
    {
      id: 'a',
      name: 'Job A',
      last_run_at: '2026-01-01T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
    { id: 'b', name: 'Job B', last_run_at: '2026-01-01T00:00:00Z', last_status: 'ok' },
  ]);
  t.after(() => cron.stop());

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver,
  });
  assert.equal(notifications.enabled, true);
  notifications.addSubscription(subscription('https://push.example/device'));

  await notifications.poll();
  assert.equal(sent.length, 0, 'the first pass must not replay existing failures');

  // Nothing changed: still silent.
  await notifications.poll();
  assert.equal(sent.length, 0, 'an unchanged failure must not re-notify');

  cron.set([
    {
      id: 'a',
      name: 'Job A',
      last_run_at: '2026-01-01T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
    {
      id: 'b',
      name: 'Job B',
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'new failure',
    },
  ]);
  await notifications.poll();
  assert.equal(sent.length, 1, 'the newly failed job should notify exactly once');
  assert.match(sent[0].payload.title, /Job B/);
  assert.match(sent[0].payload.url, /#\/job\/b$/, 'the notification must deep-link to the job');

  await notifications.poll();
  assert.equal(sent.length, 1, 'and not again on the next tick');
});

test('a paused job is not treated as a failure', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([
    { id: 'a', name: 'Job A', last_run_at: '2026-01-01T00:00:00Z', last_status: 'ok' },
  ]);
  t.after(() => cron.stop());

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/device'));
  await notifications.poll();

  // Pausing a job that also carries a stale error must stay quiet: paused wins.
  cron.set([
    {
      id: 'a',
      name: 'Job A',
      state: 'paused',
      last_run_at: '2026-01-03T00:00:00Z',
      last_error: 'boom',
    },
  ]);
  await notifications.poll();
  assert.equal(sent.length, 0);
});
