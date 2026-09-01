import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { startProxy, startFakeHermes, rawGet, rawRequest } from './helpers.mjs';
import { createNotifications, isDeliverableEndpoint } from '../notifications.mjs';

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

// An endpoint is a standing instruction to make an outbound HTTPS request from
// inside the tailnet, replayed on every failing cron tick and kept across
// restarts, to a host the caller names -- and the caller supplies the keys, so
// it can read the job names and error text in the payload. These pin the rule
// that stops that.
const REJECTED = {
  'plain http': 'http://push.example/x',
  'a file URL': 'file:///etc/passwd',
  loopback: 'https://127.0.0.1/x',
  'link-local metadata': 'https://169.254.169.254/latest/meta-data',
  'the tailnet CGNAT range': 'https://100.100.100.100/x',
  'a private range': 'https://10.1.2.3/x',
  'IPv6 loopback': 'https://[::1]/x',
  'an IPv4-mapped loopback': 'https://[::ffff:127.0.0.1]/x',
  'unique local IPv6': 'https://[fd00::1]/x',
  'not a URL at all': 'not-a-url',
  'an over-long endpoint': `https://push.example/${'a'.repeat(2100)}`,
  // A trailing dot is the DNS root label, and `localhost.` resolves exactly
  // like `localhost`. The URL parser keeps it on a name (it strips it from a
  // dotted quad), so without normalising it one character walked past the
  // whole internal-host rule.
  'loopback with a root dot': 'https://localhost./x',
  'loopback with a root dot and a port': 'https://localhost.:8443/x',
  'a subdomain of localhost with a root dot': 'https://x.localhost./x',
  'a run of root dots': 'https://localhost../x',
  'nothing but a root label': 'https://./x',
};

test('the endpoint rule accepts public HTTPS and nothing else', () => {
  assert.equal(isDeliverableEndpoint('https://fcm.googleapis.com/fcm/send/abc').ok, true);
  for (const [label, endpoint] of Object.entries(REJECTED)) {
    const verdict = isDeliverableEndpoint(endpoint);
    assert.equal(verdict.ok, false, `${label} must be refused`);
    assert.ok(verdict.reason, `${label} must say why, for the log`);
  }
  // Decimal and octal shorthands reach the URL parser as dotted quads, so the
  // numeric checks see the canonical form rather than the text the caller sent.
  assert.equal(isDeliverableEndpoint('https://2130706433/x').ok, false);
  assert.equal(isDeliverableEndpoint('https://sub.localhost/x').ok, false);
  // Stripping the root label is normalisation, not a rule of its own: a public
  // name with a trailing dot is the same public name and is still deliverable.
  assert.equal(isDeliverableEndpoint('https://fcm.googleapis.com./fcm/send/abc').ok, true);
});

test('only deliverable endpoints are persisted', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const good = 'https://fcm.googleapis.com/fcm/send/good';
  const accepted = await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription(good));
  assert.equal(accepted.status, 204);

  const statePath = join(stateDir, 'push-state.json');
  assert.match(readFileSync(statePath, 'utf8'), /fcm\/send\/good/);

  for (const [label, endpoint] of Object.entries(REJECTED)) {
    const response = await rawRequest(
      proxy.port,
      'POST',
      '/push/subscribe',
      {},
      subscription(endpoint),
    );
    assert.equal(response.status, 400, `${label} should be refused`);
    // The body must not name the rule that fired: that would make this a probe
    // for what the host can reach.
    assert.doesNotMatch(response.body, /scheme|internal|host/i);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(
    state.subscriptions.map((s) => s.endpoint),
    [good],
  );
});

test('keys that cannot be encrypted with are refused', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/keys';
  for (const keys of [{ p256dh: 1, auth: 'x' }, { auth: 'x' }, { p256dh: 'x'.repeat(300) }]) {
    const response = await rawRequest(
      proxy.port,
      'POST',
      '/push/subscribe',
      {},
      {
        endpoint,
        keys,
      },
    );
    assert.equal(response.status, 400);
  }
  assert.equal(existsSync(join(stateDir, 'push-state.json')), false, 'nothing was stored');
});

const OWNER = 'owner@example.com';
const STRANGER = 'stranger@example.com';
const identified = (login) => ({ 'Tailscale-User-Login': login });

test('a subscription can only be removed by the identity that created it', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({
    env: {
      ...withVapid(stateDir),
      HERMES_MOBILE_ALLOWED_LOGINS: `${OWNER},${STRANGER}`,
      HERMES_MOBILE_ALLOW_LOCAL: '',
    },
  });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/owned';
  const added = await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    identified(OWNER),
    subscription(endpoint),
  );
  assert.equal(added.status, 204);

  const statePath = join(stateDir, 'push-state.json');
  const stranger = await rawRequest(proxy.port, 'POST', '/push/unsubscribe', identified(STRANGER), {
    endpoint,
  });
  // 204 either way: the response must not reveal whether the endpoint is held.
  assert.equal(stranger.status, 204);
  assert.match(readFileSync(statePath, 'utf8'), /fcm\/send\/owned/, 'still subscribed');

  const owner = await rawRequest(proxy.port, 'POST', '/push/unsubscribe', identified(OWNER), {
    endpoint,
  });
  assert.equal(owner.status, 204);
  assert.doesNotMatch(readFileSync(statePath, 'utf8'), /fcm\/send\/owned/);
});

// Scoping unsubscribe to the owner is not enough on its own: addSubscription
// replaced any entry with a matching endpoint regardless of who held it, so a
// second identity could take a subscription over and then legitimately remove
// it. Even stopping at the takeover is harmful -- garbage keys fail every
// delivery with a status that is not 404/410, so the owner's alerts stop with
// nothing to show for it.
test('a subscription cannot be taken over by re-subscribing to its endpoint', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({
    env: {
      ...withVapid(stateDir),
      HERMES_MOBILE_ALLOWED_LOGINS: `${OWNER},${STRANGER}`,
      HERMES_MOBILE_ALLOW_LOCAL: '',
    },
  });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/contested';
  const statePath = join(stateDir, 'push-state.json');
  const stored = () => JSON.parse(readFileSync(statePath, 'utf8')).subscriptions;

  assert.equal(
    (
      await rawRequest(
        proxy.port,
        'POST',
        '/push/subscribe',
        identified(OWNER),
        subscription(endpoint),
      )
    ).status,
    204,
  );
  const mine = stored()[0];

  const takeover = await rawRequest(proxy.port, 'POST', '/push/subscribe', identified(STRANGER), {
    endpoint,
    keys: { p256dh: 'ZZZ', auth: 'ZZZ' },
  });
  // 204, the same as success: saying "that endpoint is held by someone else"
  // would answer a question the caller has no business asking.
  assert.equal(takeover.status, 204);

  const after = stored();
  assert.equal(after.length, 1, 'no second entry for the same endpoint');
  assert.equal(after[0].owner, mine.owner, 'ownership is unchanged');
  assert.deepEqual(after[0].keys, mine.keys, "the owner's keys are untouched");

  const evict = await rawRequest(proxy.port, 'POST', '/push/unsubscribe', identified(STRANGER), {
    endpoint,
  });
  assert.equal(evict.status, 204);
  assert.equal(stored().length, 1, 'and it still cannot be removed by a stranger');
});

// The counterweight. Browsers re-POST their subscription on every load, and the
// keys rotate, so refusing a same-owner replacement would silently stop push.
test('an identity can re-subscribe its own endpoint with rotated keys', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({
    env: {
      ...withVapid(stateDir),
      HERMES_MOBILE_ALLOWED_LOGINS: OWNER,
      HERMES_MOBILE_ALLOW_LOCAL: '',
    },
  });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/rotating';
  const statePath = join(stateDir, 'push-state.json');
  const stored = () => JSON.parse(readFileSync(statePath, 'utf8')).subscriptions;

  await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    identified(OWNER),
    subscription(endpoint),
  );
  const rotated = {
    ...subscription(endpoint),
    keys: { ...subscription(endpoint).keys, auth: 'Xn9pQr2sTuVwXyZ0AbCdEg' },
  };
  assert.equal(
    (await rawRequest(proxy.port, 'POST', '/push/subscribe', identified(OWNER), rotated)).status,
    204,
  );

  const after = stored();
  assert.equal(after.length, 1, 'still one entry, not two');
  assert.equal(after[0].keys.auth, 'Xn9pQr2sTuVwXyZ0AbCdEg', 'the new keys took effect');
  assert.equal(after[0].owner, OWNER, 'and it is still theirs');
});

test('the state file and its directory stay owner-only after a rewrite', async (t) => {
  // A directory the server has to create itself, so the mkdir mode is what is
  // under test rather than mkdtemp's.
  const stateDir = join(tempStateDir(t), 'state');
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const first = 'https://fcm.googleapis.com/fcm/send/one';
  await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription(first));
  const statePath = join(stateDir, 'push-state.json');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);

  // writeFileSync's mode only applies to a create, so a file that already went
  // world-readable stayed that way through every later write.
  chmodSync(statePath, 0o644);
  await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    {},
    subscription('https://fcm.googleapis.com/fcm/send/two'),
  );
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
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

// A subscription that keeps failing used to be kept forever: only 404 and 410
// reaped one, and every other status was treated as transient. So an endpoint
// that had started answering 500 was retried on every tick for the life of the
// process, logging an error each time and burying the alerts that matter. One
// failure is still not a verdict; ten in a row is, and a success in between
// resets the count so a blip cannot accumulate.
test('a subscription that fails persistently is eventually given up on', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([{ id: 'a', name: 'Job A', last_run_at: '2026-01-01T00:00:00Z' }]);
  t.after(() => cron.stop());

  let failing = true;
  let attempts = 0;
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver: async () => {
      attempts += 1;
      // 500 is the "might be a blip" class. 404/410 reap immediately and are
      // covered elsewhere; this is the status that used to be kept forever.
      if (failing) throw Object.assign(new Error('upstream refused'), { statusCode: 500 });
    },
  });
  notifications.addSubscription(subscription('https://push.example/flaky'), 'owner@example.com');

  const statePath = join(stateDir, 'push-state.json');
  const stored = () => JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.length;

  // Each poll must see a *newly* failed job to send anything, so give it one.
  let tick = 0;
  const failJobOnce = async () => {
    tick += 1;
    cron.set([
      {
        id: 'a',
        name: 'Job A',
        last_run_at: `2026-01-01T00:00:${String(tick).padStart(2, '0')}Z`,
        last_status: 'error',
        last_error: `boom ${tick}`,
      },
    ]);
    await notifications.poll();
  };

  await notifications.poll(); // seeding pass: never replays existing state
  for (let i = 0; i < 9; i += 1) await failJobOnce();
  assert.equal(stored(), 1, 'nine consecutive failures is not a verdict');

  failing = false;
  await failJobOnce();
  failing = true;
  for (let i = 0; i < 9; i += 1) await failJobOnce();
  assert.equal(stored(), 1, 'a successful delivery must reset the streak');

  await failJobOnce();
  assert.equal(stored(), 0, 'the tenth consecutive failure should drop it');

  const before = attempts;
  await failJobOnce();
  assert.equal(attempts, before, 'a dropped subscription is not retried');
});
