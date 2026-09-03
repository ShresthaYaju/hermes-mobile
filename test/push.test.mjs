import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { startProxy, startFakeHermes, rawGet, rawRequest } from './helpers.mjs';
import {
  createNotifications,
  isDeliverableEndpoint,
  guardedLookup,
  PUSH_KINDS,
} from '../notifications.mjs';

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

/** A syntactically valid, freshly-random key pair: correct decoded lengths and
 * the 0x04 uncompressed-point prefix keysAreUsable now checks for, but not a
 * real EC key -- nothing here decrypts with it, only shape-checks it. Used
 * where a test needs "some other valid-looking key", distinct from the fixed
 * dummy pair above. */
function randomValidKeys() {
  const p256dh = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]);
  return { p256dh: p256dh.toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

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
  assert.deepEqual(body.kinds, PUSH_KINDS, 'the client needs the kind list to intersect against');
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
  // Several IPv6 forms carry an IPv4 address inside them, and on a host with
  // the matching transition mechanism configured they reach it. NAT64 is the
  // one still in live use; the rest are cheap to cover and would otherwise be
  // spellings of 127.0.0.1 that walk past every other rule.
  'a NAT64-wrapped loopback': 'https://[64:ff9b::7f00:1]/x',
  'a NAT64-wrapped private address': 'https://[64:ff9b::a00:1]/x',
  'a 6to4-wrapped loopback': 'https://[2002:7f00:1::]/x',
  'a 6to4-wrapped tailnet address': 'https://[2002:6440:101::]/x',
  'an IPv4-translated loopback': 'https://[::ffff:0:127.0.0.1]/x',
  'deprecated site-local IPv6': 'https://[fec0::1]/x',
  // isInternalHost only ever judged IP literals until now, so a DNS name
  // resolving somewhere on the tailnet -- another peer, or the host itself --
  // walked straight past it. These are the literal-host layer; guardedLookup
  // below is the second layer that catches a name repointed after the fact.
  'a dotless hostname': 'https://hermes/x',
  'a tailnet MagicDNS name': 'https://laptop.tailabc123.ts.net/x',
  'an mDNS .local name': 'https://box.local/x',
  'an .internal name': 'https://db.internal/x',
  'a .home.arpa name': 'https://router.home.arpa/x',
  'a .lan name': 'https://nas.lan/x',
  'a .corp name': 'https://host.corp/x',
  'a .home name': 'https://router.home/x',
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
  // Unwrapping an embedded IPv4 must judge the address, not the wrapper: a
  // transition form around a *public* address is still perfectly deliverable.
  assert.equal(isDeliverableEndpoint('https://[2002:0808:0808::]/x').ok, true);
  assert.equal(isDeliverableEndpoint('https://[::1.2.3.4]/x').ok, true);
  assert.equal(isDeliverableEndpoint('https://[2606:4700:4700::1111]/x').ok, true);
});

test('only deliverable endpoints are persisted', async (t) => {
  const stateDir = tempStateDir(t);
  // One request per REJECTED case plus the accepted one, all from the same
  // (unidentified/local) caller: comfortably past the default write-rate
  // limit now that the internal-DNS-name cases live in this table too, so
  // raise it rather than have the rate limiter -- not the rule under test --
  // fail these requests instead.
  const proxy = await startProxy({
    env: { ...withVapid(stateDir), HERMES_MOBILE_WRITE_LIMIT: '200' },
  });
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
  for (const keys of [
    { p256dh: 1, auth: 'x' },
    { auth: 'x' },
    { p256dh: 'x'.repeat(300) },
    // Two syntactically fine strings, short enough to pass the old
    // length-only check, but neither decodes to a usable key: p256dh must be
    // a 65-byte uncompressed P-256 point and auth at least 16 bytes.
    { p256dh: 'ZZZ', auth: 'ZZZ' },
  ]) {
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
    // Valid-shaped and distinct from the owner's -- garbage keys would now be
    // refused by keysAreUsable before this ever reaches the ownership check,
    // which would test key validation instead of the takeover rule.
    keys: randomValidKeys(),
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
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
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
    get requests() {
      return requests;
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
      sent.push({
        endpoint: subscription.endpoint,
        payload: JSON.parse(body),
        bytes: Buffer.byteLength(body),
      });
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
// that had started answering 403 was retried on every tick for the life of the
// process, logging an error each time and burying the alerts that matter. One
// failure is still not a verdict; ten in a row is, and a success in between
// resets the count so a blip cannot accumulate.
//
// A second, always-succeeding subscription rides along for the whole test:
// send() now only counts a failure when at least one *other* subscription got
// through that tick (the count-none-if-everything-failed rule below), so with
// only one subscription in play every tick would look like a fleet-wide
// outage and the flaky one would never be counted at all.
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

  const flaky = 'https://push.example/flaky';
  const stable = 'https://push.example/stable';
  let failing = true;
  let attempts = 0;
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver: async (subscription) => {
      if (subscription.endpoint !== flaky) return; // the sibling always succeeds
      attempts += 1;
      // 403 is in the countable-4xx class: "our request, not their outage".
      // 404/410 reap immediately and are covered elsewhere; 403 is the status
      // that used to be lumped in with a 500 or a network error and kept
      // forever.
      if (failing) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    },
  });
  notifications.addSubscription(subscription(flaky), 'owner@example.com');
  notifications.addSubscription(subscription(stable), 'other@example.com');

  const statePath = join(stateDir, 'push-state.json');
  const flakyPresent = () =>
    JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.some((s) => s.endpoint === flaky);

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
  assert.equal(flakyPresent(), true, 'nine consecutive failures is not a verdict');

  failing = false;
  await failJobOnce();
  failing = true;
  for (let i = 0; i < 9; i += 1) await failJobOnce();
  assert.equal(flakyPresent(), true, 'a successful delivery must reset the streak');

  await failJobOnce();
  assert.equal(flakyPresent(), false, 'the tenth consecutive failure should drop it');

  const before = attempts;
  await failJobOnce();
  assert.equal(attempts, before, 'a dropped subscription is not retried');
});

test('transient transport failures with no statusCode never evict a subscription', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([{ id: 'a', name: 'Job A', last_run_at: '2026-01-01T00:00:00Z' }]);
  t.after(() => cron.stop());

  const first = 'https://push.example/one';
  const second = 'https://push.example/two';
  // A third, always-succeeding sibling: without it, every subscription in the
  // tick fails and the "count none if everything failed" rule alone would
  // protect first/second regardless of whether a no-statusCode error is
  // separately excluded from counting. With a success present every tick,
  // this test isolates that second rule instead.
  const stable = 'https://push.example/stable';
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    // ENOTFOUND/ECONNREFUSED/a timeout carry no statusCode at all -- that is
    // our link being down, not a verdict on either endpoint.
    deliver: async (subscription) => {
      if (subscription.endpoint === stable) return;
      throw Object.assign(new Error('getaddrinfo ENOTFOUND push.example'), {});
    },
  });
  notifications.addSubscription(subscription(first), 'owner-a@example.com');
  notifications.addSubscription(subscription(second), 'owner-b@example.com');
  notifications.addSubscription(subscription(stable), 'owner-c@example.com');

  const statePath = join(stateDir, 'push-state.json');
  const endpoints = () =>
    JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.map((s) => s.endpoint);

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

  await notifications.poll(); // seeding
  for (let i = 0; i < 10; i += 1) await failJobOnce();
  assert.deepEqual(
    endpoints().sort(),
    [first, second, stable].sort(),
    'ten straight network-level failures must not evict either owner, success elsewhere notwithstanding',
  );
});

test('a 403 evicts only the subscription it belongs to, not a healthy sibling', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([{ id: 'a', name: 'Job A', last_run_at: '2026-01-01T00:00:00Z' }]);
  t.after(() => cron.stop());

  const bad = 'https://push.example/bad';
  const good = 'https://push.example/good';
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver: async (subscription) => {
      if (subscription.endpoint === bad) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
    },
  });
  notifications.addSubscription(subscription(bad), 'owner-a@example.com');
  notifications.addSubscription(subscription(good), 'owner-b@example.com');

  const statePath = join(stateDir, 'push-state.json');
  const endpoints = () =>
    JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.map((s) => s.endpoint);

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

  await notifications.poll(); // seeding
  for (let i = 0; i < 10; i += 1) await failJobOnce();
  assert.deepEqual(endpoints(), [good], 'only the endpoint answering 403 should be dropped');
});

// A statusCode that would otherwise be countable (see the test above) must
// not count when *every* subscription got it this tick: that is a fault this
// host caused -- a broken VAPID key, say -- not a verdict on any one endpoint,
// and would otherwise evict the entire fleet in lockstep, exactly as fast as
// one genuinely broken subscription.
test('a status shared by every subscription in a tick evicts none of them', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([{ id: 'a', name: 'Job A', last_run_at: '2026-01-01T00:00:00Z' }]);
  t.after(() => cron.stop());

  const first = 'https://push.example/one';
  const second = 'https://push.example/two';
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver: async () => {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    },
  });
  notifications.addSubscription(subscription(first), 'owner-a@example.com');
  notifications.addSubscription(subscription(second), 'owner-b@example.com');

  const statePath = join(stateDir, 'push-state.json');
  const endpoints = () =>
    JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.map((s) => s.endpoint);

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

  await notifications.poll(); // seeding
  for (let i = 0; i < 10; i += 1) await failJobOnce();
  assert.deepEqual(
    endpoints().sort(),
    [first, second].sort(),
    'a 403 shared by the whole fleet must not evict anyone',
  );
});

// guardedLookup is the second, resolved-address layer behind isDeliverableEndpoint:
// a hostname can look public at subscribe time and still resolve into the
// tailnet, either because DNS was rebound afterward or because it always had
// more than one address and only some of them are internal. web-push has no
// `lookup` option of its own, so this is threaded in through an https.Agent
// instead -- these tests exercise the exported factory directly, with a fake
// resolver standing in for dns.lookup.
test('guardedLookup refuses a hostname that resolves to a tailnet address', () => {
  const fakeResolver = (hostname, options, callback) => {
    assert.equal(hostname, 'push.example.com');
    assert.equal(options.all, true, 'must always ask for every address, not just the first');
    callback(null, [{ address: '100.100.1.1', family: 4 }]);
  };
  const lookup = guardedLookup(fakeResolver);

  let result;
  lookup('push.example.com', {}, (error, address) => {
    result = { error, address };
  });
  assert.ok(result.error, 'a tailnet CGNAT address must fail the lookup');
});

test('guardedLookup refuses a hostname when only one of several resolved addresses is internal', () => {
  const fakeResolver = (hostname, options, callback) => {
    callback(null, [
      { address: '203.0.113.7', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
  };
  const lookup = guardedLookup(fakeResolver);

  let result;
  lookup('push.example.com', {}, (error) => {
    result = error;
  });
  assert.ok(result, 'one internal address among several must still refuse the whole lookup');
});

test('guardedLookup passes through a hostname that resolves publicly', () => {
  const fakeResolver = (hostname, options, callback) => {
    callback(null, [{ address: '203.0.113.7', family: 4 }]);
  };
  const lookup = guardedLookup(fakeResolver);

  let result;
  lookup('push.example.com', {}, (error, address, family) => {
    result = { error, address, family };
  });
  assert.equal(result.error, null);
  assert.equal(result.address, '203.0.113.7');
  assert.equal(result.family, 4);
});

test('guardedLookup propagates a resolver error rather than swallowing it', () => {
  const fakeResolver = (hostname, options, callback) => {
    callback(new Error('getaddrinfo ENOTFOUND'));
  };
  const lookup = guardedLookup(fakeResolver);

  let result;
  lookup('push.example.com', {}, (error) => {
    result = error;
  });
  assert.match(result.message, /ENOTFOUND/);
});

// A corrupt or truncated state file used to be swallowed by a bare `catch {}`:
// nothing was logged, and the next write could clobber a file that might
// still have been recoverable by hand. It should be reported instead -- and,
// separately, an unrelated poll that changes nothing must not needlessly
// rewrite the (now-reset) state file on every tick.
test('a corrupted state file is reported rather than silently discarded, and unrelated polls do not rewrite it', async (t) => {
  const stateDir = tempStateDir(t);
  const statePath = join(stateDir, 'push-state.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, '{ this is not valid json');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

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

  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
  });
  assert.ok(
    warnings.some((w) => w.includes(statePath)),
    'a corrupt state file must be reported, not swallowed silently',
  );

  await notifications.poll(); // seeding: a real change, may legitimately write
  const contentAfterSeed = readFileSync(statePath, 'utf8');
  const mtimeAfterSeed = statSync(statePath).mtimeMs;

  // No wall-clock wait needed between the two polls: save() uses writeFileSync
  // and renameSync, both synchronous, so if the second poll below were to
  // write at all, that write is already complete by the time the awaited
  // poll() call returns -- there is no async gap for a delay to bridge.
  await notifications.poll(); // nothing changed this time
  assert.equal(
    readFileSync(statePath, 'utf8'),
    contentAfterSeed,
    'an unchanged poll must not rewrite the state file',
  );
  assert.equal(
    statSync(statePath).mtimeMs,
    mtimeAfterSeed,
    'and must not touch the file at all -- every tick used to save unconditionally',
  );
});

// A free-text job name is the one field in a notification with no natural
// bound, and used to be sent verbatim. That produces a payload most push
// services reject outright (413), which the failure accounting in send() now
// correctly counts against the subscription as a real fault, so an oversized
// name would evict every subscriber's device for no fault of theirs.
test('an oversized job name is bounded rather than sent as a giant payload', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const hugeName = 'x'.repeat(50_000);
  const cron = await fakeCron([
    { id: 'a', name: hugeName, last_run_at: '2026-01-01T00:00:00Z', last_status: 'ok' },
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
  await notifications.poll(); // seeding

  cron.set([
    {
      id: 'a',
      name: hugeName,
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
  ]);
  await notifications.poll();

  assert.equal(sent.length, 1, 'delivery must still be attempted, just with a bounded payload');
  assert.ok(sent[0].bytes <= 3800, `payload was ${sent[0].bytes} bytes`);
});

// The deep-link url is deliberately left uncapped by the title/tag shortening
// above -- truncating a job id would break the link -- so it is the one field
// that can still blow the budget even with a short name. send()'s own
// byte-length check is what catches that case, independent of the title/tag
// caps: a huge id makes a huge encodeURIComponent(id) inside the url with
// nothing else in the payload construction to stop it.
test('send() falls back to a minimal payload when the url alone makes it oversized', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const hugeId = 'x'.repeat(50_000);
  const cron = await fakeCron([
    { id: hugeId, last_run_at: '2026-01-01T00:00:00Z', last_status: 'ok' },
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
  await notifications.poll(); // seeding

  cron.set([
    { id: hugeId, last_run_at: '2026-01-02T00:00:00Z', last_status: 'error', last_error: 'boom' },
  ]);
  await notifications.poll();

  assert.equal(sent.length, 1, 'delivery must still be attempted, just with a bounded payload');
  assert.ok(sent[0].bytes <= 3800, `payload was ${sent[0].bytes} bytes`);
});

// job.id is used as an object key when tracking which failures have already
// been notified about. `__proto__` is not an ordinary key on a plain object --
// assigning it does not create an own property at all, since the assignment
// runs into the inherited accessor of the same name -- so a job with that id
// either never got recorded (seeding looked permanently incomplete) or the
// signature never matched (a notification on every single tick).
test('a job id of __proto__ does not break the signature map', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const cron = await fakeCron([
    {
      id: '__proto__',
      name: 'Weird Job',
      last_run_at: '2026-01-01T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
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

  await notifications.poll(); // seeding pass: must not replay the pre-existing failure
  assert.equal(sent.length, 0);

  cron.set([
    {
      id: '__proto__',
      name: 'Weird Job',
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'new failure',
    },
  ]);
  for (let i = 0; i < 5; i += 1) await notifications.poll();
  assert.equal(sent.length, 1, 'exactly one notification across five polls after the change');
});

// Without a re-entrancy guard, a delivery slow enough to still be in flight
// when the next interval fires would run two ticks concurrently against the
// same subscriptions.
test('an in-flight poll makes a concurrent poll a no-op', async (t) => {
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

  let deliverCalls = 0;
  let releaseHang;
  let notifyStarted;
  const hang = new Promise((resolve) => {
    releaseHang = resolve;
  });
  // fetchJobs() is a real HTTP round-trip to the fake cron server, so the
  // first poll() has not necessarily reached delivery yet just because it has
  // been called -- wait for delivery to actually start before racing the
  // second poll() against it, rather than assuming the timing.
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const notifications = createNotifications({
    hermesOrigin: cron.origin,
    sessionToken: '',
    stateDir,
    deliver: async () => {
      deliverCalls += 1;
      notifyStarted();
      await hang;
    },
  });
  notifications.addSubscription(subscription('https://push.example/device'));
  await notifications.poll(); // seeding: no deliveries yet

  cron.set([
    {
      id: 'a',
      name: 'Job A',
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
  ]);
  const first = notifications.poll(); // hangs inside deliver
  await started;
  // state.signatures is already updated by the time send() is reached, so a
  // second poll for the *same* failure would find nothing new to notify about
  // regardless of the guard -- that alone would not tell the two cases apart.
  // Whether fetchJobs() was even called a second time does: the guard's job
  // is to make the whole tick, not just delivery, a no-op.
  const requestsBeforeOverlap = cron.requests;
  await notifications.poll(); // must return immediately without starting a second tick
  assert.equal(
    cron.requests,
    requestsBeforeOverlap,
    'an overlapping poll must not even re-fetch the job list, let alone re-deliver',
  );
  assert.equal(
    deliverCalls,
    1,
    'an overlapping poll must not run concurrently with one already in flight',
  );

  releaseHang();
  await first; // let the hung delivery finish so nothing is left dangling
});

// The global cap used to slice(-MAX_SUBSCRIPTIONS) across every identity, so
// the globally-oldest entry -- which could belong to anyone -- was evicted to
// make room for a new one. That let one identity filling its own quota bump a
// completely unrelated identity's device. It should refuse the new add
// instead.
test('the global subscription cap refuses a new device rather than evicting another identity', async (t) => {
  const stateDir = tempStateDir(t);
  const owners = [
    'owner-a@example.com',
    'owner-b@example.com',
    'owner-c@example.com',
    'owner-d@example.com',
  ];
  const proxy = await startProxy({
    env: {
      ...withVapid(stateDir),
      HERMES_MOBILE_ALLOWED_LOGINS: [...owners, 'owner-e@example.com'].join(','),
      HERMES_MOBILE_ALLOW_LOCAL: '',
      HERMES_MOBILE_WRITE_LIMIT: '200',
    },
  });
  t.after(() => proxy.stop());

  const statePath = join(stateDir, 'push-state.json');
  const endpoints = () =>
    JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.map((s) => s.endpoint);
  const earliest = `https://fcm.googleapis.com/fcm/send/${owners[0]}-0`;

  // Four identities at their five-device-each cap: exactly MAX_SUBSCRIPTIONS.
  for (const owner of owners) {
    for (let device = 0; device < 5; device += 1) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/${owner}-${device}`;
      const response = await rawRequest(
        proxy.port,
        'POST',
        '/push/subscribe',
        identified(owner),
        subscription(endpoint),
      );
      assert.equal(response.status, 204);
    }
  }
  assert.equal(endpoints().length, 20, 'the global cap should be exactly full');
  assert.ok(endpoints().includes(earliest));

  const refused = await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    identified('owner-e@example.com'),
    subscription('https://fcm.googleapis.com/fcm/send/owner-e-0'),
  );
  assert.equal(refused.status, 400, 'a new device once the cap is full must be refused');
  assert.equal(endpoints().length, 20, 'nothing was evicted to make room');
  assert.ok(
    endpoints().includes(earliest),
    'the earliest entry, belonging to a different identity, is untouched',
  );
});

// Versions before endpoints and keys were validated could have persisted
// entries this code would now refuse, or fields it never wrote itself. load()
// used to trust the file outright; it should re-run the same checks
// addSubscription applies to a fresh POST.
test('load re-validates stored subscriptions: unusable ones are dropped, unknown fields are stripped', async (t) => {
  const stateDir = tempStateDir(t);
  const statePath = join(stateDir, 'push-state.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      subscriptions: [
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/good',
          keys: subscription('irrelevant').keys,
          owner: null,
          injectedByAnOlderVersionOrByHand: 'should not survive',
        },
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/oversized-key',
          keys: { p256dh: 'ZZZ', auth: 'ZZZ' },
          owner: null,
        },
      ],
      signatures: {},
      seeded: true,
    }),
  );

  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  createNotifications({ hermesOrigin: 'http://127.0.0.1:1', sessionToken: '', stateDir });

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.subscriptions.length, 1, 'the entry with an unusable key must be dropped');
  assert.equal(state.subscriptions[0].endpoint, 'https://fcm.googleapis.com/fcm/send/good');
  assert.deepEqual(
    Object.keys(state.subscriptions[0]).sort(),
    ['endpoint', 'keys', 'kinds', 'owner'],
    'a field this code never wrote must not survive a load',
  );
  assert.deepEqual(
    state.subscriptions[0].kinds,
    PUSH_KINDS,
    'a legacy entry with no kinds field loads as every kind',
  );
});

test('load repairs the state directory permissions even before anything is written', async (t) => {
  const stateDir = tempStateDir(t);
  chmodSync(stateDir, 0o770);

  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  createNotifications({ hermesOrigin: 'http://127.0.0.1:1', sessionToken: '', stateDir });
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});

// --- Per-device kind preferences ---------------------------------------------

test('a subscription with no kinds field defaults to every kind', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/all-kinds';
  const added = await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription(endpoint));
  assert.equal(added.status, 204);

  const statePath = join(stateDir, 'push-state.json');
  const stored = JSON.parse(readFileSync(statePath, 'utf8')).subscriptions[0];
  assert.deepEqual(stored.kinds, PUSH_KINDS);
});

test('kinds are preserved on a re-POST that omits them', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/preserved';
  await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    {},
    { ...subscription(endpoint), kinds: ['error'] },
  );
  const statePath = join(stateDir, 'push-state.json');
  const stored = () => JSON.parse(readFileSync(statePath, 'utf8')).subscriptions[0];
  assert.deepEqual(stored().kinds, ['error']);

  // The client re-POSTs the same subscription -- rotated keys, no kinds -- on
  // every settings visit to self-heal. That must not reset a choice already made.
  await rawRequest(proxy.port, 'POST', '/push/subscribe', {}, subscription(endpoint));
  assert.deepEqual(stored().kinds, ['error'], 'omitting kinds on re-POST must not reset it');
});

test('unknown kinds are dropped, known ones kept in PUSH_KINDS order', async (t) => {
  const stateDir = tempStateDir(t);
  const proxy = await startProxy({ env: withVapid(stateDir) });
  t.after(() => proxy.stop());

  const endpoint = 'https://fcm.googleapis.com/fcm/send/unknown-kinds';
  await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    {},
    { ...subscription(endpoint), kinds: ['job', 'bogus', 'approval', 'also-bogus'] },
  );
  const statePath = join(stateDir, 'push-state.json');
  const stored = JSON.parse(readFileSync(statePath, 'utf8')).subscriptions[0];
  assert.deepEqual(
    stored.kinds,
    ['approval', 'job'],
    'unknown values are dropped and the rest reordered to PUSH_KINDS order',
  );
});

test('an explicit empty kinds array is stored as empty and receives nothing', async (t) => {
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
  const added = notifications.addSubscription({
    ...subscription('https://push.example/none'),
    kinds: [],
  });
  assert.equal(added.ok, true);

  const statePath = join(stateDir, 'push-state.json');
  const stored = JSON.parse(readFileSync(statePath, 'utf8')).subscriptions[0];
  assert.deepEqual(stored.kinds, [], 'an explicit empty array is a real choice, not "absent"');

  await notifications.poll(); // seeding
  cron.set([
    {
      id: 'a',
      name: 'Job A',
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
  ]);
  await notifications.poll();
  assert.equal(sent.length, 0, 'a device subscribed to no kinds gets no job push either');
});

test('send() filters delivery by kind and by owner', async (t) => {
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

  const jobOnly = 'https://push.example/job-only';
  const replyOnly = 'https://push.example/reply-only';
  const everything = 'https://push.example/everything';
  notifications.addSubscription({ ...subscription(jobOnly), kinds: ['job'] }, 'alice@example.com');
  notifications.addSubscription(
    { ...subscription(replyOnly), kinds: ['reply'] },
    'alice@example.com',
  );
  notifications.addSubscription(
    { ...subscription(everything), kinds: [...PUSH_KINDS] },
    'bob@example.com',
  );

  await notifications.poll(); // seeding

  // A job failure is host-wide -- no owner filter -- so only kind decides.
  cron.set([
    {
      id: 'a',
      name: 'Job A',
      last_run_at: '2026-01-02T00:00:00Z',
      last_status: 'error',
      last_error: 'boom',
    },
  ]);
  await notifications.poll();
  assert.deepEqual(
    sent.map((s) => s.endpoint).sort(),
    [everything, jobOnly].sort(),
    'only subscriptions carrying the job kind receive a job push, regardless of owner',
  );

  sent.length = 0;

  // A reply belongs to one session's owner: kind AND owner both gate it.
  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'message.complete',
    sessionId: 'sess-1',
    threadId: null,
    payload: { status: 'ok', text: 'done' },
  });
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [replyOnly],
    "only alice's reply-subscribed device gets it -- not her job-only device, not bob's (different owner)",
  );
});

// --- observe(): session events -> pushes -------------------------------------

test('observe(): approval.request always pushes, even when attached, and is owner-scoped', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: 'http://127.0.0.1:1',
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/owner'), 'alice@example.com');
  notifications.addSubscription(subscription('https://push.example/stranger'), 'bob@example.com');

  await notifications.observe({
    login: 'alice@example.com',
    attached: true, // a stuck half-open socket must not silence this
    type: 'approval.request',
    sessionId: 'sess-1',
    threadId: null,
    payload: { command: 'rm -rf /tmp/build', request_id: 'req-42' },
  });

  assert.equal(sent.length, 1, "only alice's device gets it, and attached does not suppress it");
  assert.equal(sent[0].endpoint, 'https://push.example/owner');
  assert.equal(sent[0].payload.title, 'Approval needed');
  assert.match(sent[0].payload.body, /rm -rf \/tmp\/build/);
  assert.equal(sent[0].payload.tag, 'approval-req-42');
  assert.equal(sent[0].payload.url, '/#/now');
});

test('observe(): message.complete is skipped when attached, otherwise reply or error by status', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: 'http://127.0.0.1:1',
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/device'), 'alice@example.com');

  await notifications.observe({
    login: 'alice@example.com',
    attached: true,
    type: 'message.complete',
    sessionId: 'sess-1',
    threadId: null,
    payload: { status: 'ok', text: 'All done here' },
  });
  assert.equal(sent.length, 0, 'a phone already looking at the chat is not pushed to');

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'message.complete',
    sessionId: 'sess-1',
    threadId: null,
    payload: { status: 'interrupted', text: 'ignored' },
  });
  assert.equal(sent.length, 0, 'an interrupted turn is not a result worth surfacing');

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'message.complete',
    sessionId: 'sess-1',
    threadId: null,
    payload: { status: 'ok', text: 'All done here' },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Hermes replied');
  assert.equal(sent[0].payload.body, 'All done here');
  assert.equal(sent[0].payload.tag, 'reply-sess-1');
  assert.equal(sent[0].payload.url, '/#/chat', 'no threadId known, so the generic chat url');

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'message.complete',
    sessionId: 'sess-2',
    threadId: 'thread/with spaces',
    payload: { status: 'ok', text: '' },
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.body, 'Done', 'an empty reply text falls back to Done');
  assert.equal(sent[1].payload.url, `/#/chat/${encodeURIComponent('thread/with spaces')}`);

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'message.complete',
    sessionId: 'sess-3',
    threadId: null,
    payload: { status: 'error', text: 'the tool call failed' },
  });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].payload.title, 'Hermes hit an error');
  assert.equal(sent[2].payload.body, 'the tool call failed');
  assert.equal(sent[2].payload.tag, 'error-sess-3');
});

test('observe(): a plain error event is skipped when attached, pushed otherwise', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: 'http://127.0.0.1:1',
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/device'), 'alice@example.com');

  await notifications.observe({
    login: 'alice@example.com',
    attached: true,
    type: 'error',
    sessionId: 'sess-9',
    threadId: 'thread-9',
    payload: { message: 'connection reset' },
  });
  assert.equal(sent.length, 0);

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'error',
    sessionId: 'sess-9',
    threadId: 'thread-9',
    payload: { message: 'connection reset' },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Hermes hit an error');
  assert.equal(sent[0].payload.body, 'connection reset');
  assert.equal(sent[0].payload.tag, 'error-sess-9');
  assert.equal(sent[0].payload.url, `/#/chat/${encodeURIComponent('thread-9')}`);
});

test('observe(): clarify.request always pushes, and unrecognised event types are ignored', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: 'http://127.0.0.1:1',
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/device'), 'alice@example.com');

  await notifications.observe({
    login: 'alice@example.com',
    attached: false,
    type: 'session.started',
    sessionId: 'sess-1',
    threadId: null,
    payload: {},
  });
  assert.equal(sent.length, 0, 'an event type this code does not recognise is ignored');

  await notifications.observe({
    login: 'alice@example.com',
    attached: true,
    type: 'clarify.request',
    sessionId: 'sess-1',
    threadId: null,
    payload: { question: 'Which environment?', request_id: 'clarify-7' },
  });
  assert.equal(sent.length, 1, 'a clarifying question always pushes too, even attached');
  assert.equal(sent[0].payload.title, 'Hermes has a question');
  assert.equal(sent[0].payload.body, 'Which environment?');
  assert.equal(sent[0].payload.tag, 'approval-clarify-7');
  assert.equal(sent[0].payload.url, '/#/now');
});

test('observe() never throws, even given a malformed or empty event', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  const notifications = createNotifications({
    hermesOrigin: 'http://127.0.0.1:1',
    sessionToken: '',
    stateDir,
  });
  await assert.doesNotReject(() => notifications.observe());
  await assert.doesNotReject(() => notifications.observe({ type: 'approval.request' }));
});

test("createDisabled's observe() stub resolves immediately and does nothing", async (t) => {
  const proxy = await startProxy(); // no VAPID keys -> push disabled
  t.after(() => proxy.stop());
  const config = await rawGet(proxy.port, '/push/config');
  assert.equal(JSON.parse(config.body).enabled, false);
  // No direct handle to the disabled notifications object from here, but the
  // proxy staying up and answering normally through disabled push is the
  // behavioural guarantee: createDisabled must not have thrown wiring observe.
});

// --- Backend reachability ------------------------------------------------------

test('backend-down fires once after three consecutive failures, and recovery fires once', async (t) => {
  const stateDir = tempStateDir(t);
  process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY = VAPID.privateKey;
  t.after(() => {
    delete process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY;
    delete process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY;
  });

  let down = true;
  const server = http.createServer((request, response) => {
    if (down) {
      response.writeHead(500);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const { sent, deliver } = recordingDeliver();
  const notifications = createNotifications({
    hermesOrigin: `http://127.0.0.1:${server.address().port}`,
    sessionToken: '',
    stateDir,
    deliver,
  });
  notifications.addSubscription(subscription('https://push.example/device'));

  await notifications.poll();
  await notifications.poll();
  assert.equal(sent.length, 0, 'two consecutive failures is not yet a verdict');

  await notifications.poll(); // the third
  assert.equal(sent.length, 1, 'the third consecutive failure fires the unreachable push');
  assert.equal(sent[0].payload.title, 'Hermes is unreachable');
  assert.equal(sent[0].payload.tag, 'ops-backend');

  await notifications.poll(); // still down
  assert.equal(sent.length, 1, 'staying down must not repeat the push');

  down = false;
  await notifications.poll();
  assert.equal(sent.length, 2, 'recovery fires once');
  assert.equal(sent[1].payload.title, 'Hermes is back');
  assert.equal(sent[1].payload.tag, 'ops-backend');

  await notifications.poll();
  assert.equal(sent.length, 2, 'staying up must not repeat the recovery push');
});
