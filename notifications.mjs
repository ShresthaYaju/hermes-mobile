// Web Push: subscription storage plus a watcher that notifies when a scheduled
// job fails.
//
// This exists because the failure mode that actually matters for an always-on
// agent is silent: a cron job whose delivery target is "local" writes its error
// to a file on the host and tells nobody. The phone is the only place the
// person ever looks, so the phone has to be told.
//
// Everything here degrades to a no-op when VAPID keys are absent. The app must
// stay fully usable without push configured.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import webpush from 'web-push';

const POLL_MS = 60_000;
const MAX_SUBSCRIPTIONS = 20;
// Per identity, so a caller that floods subscriptions can only evict its own
// devices. The global cap stays as a backstop: reaching it now needs four-plus
// distinct allowlisted logins, and everyone on the allowlist can already drive
// the agent, so cross-identity eviction is not the threat worth more code.
const MAX_SUBSCRIPTIONS_PER_OWNER = 5;
// Long enough for every real push service (FCM endpoints are ~200 chars) and
// short enough that the state file cannot be used as free storage.
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
// Consecutive failed deliveries before a subscription is given up on. The
// watcher ticks about once a minute, so this is roughly ten minutes of a
// genuinely unreachable endpoint before it is dropped -- long enough to ride
// out a blip, short enough that a permanently broken one converges.
const MAX_CONSECUTIVE_FAILURES = 10;

const defaultStateDir = () =>
  process.env.HERMES_MOBILE_STATE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'hermes-mobile');

/**
 * Mirror of jobStatus() in public/lib/ui.js. Kept deliberately duplicated
 * rather than shared: the browser copy classifies for display, this one decides
 * whether to wake someone up, and they should be free to diverge.
 */
function classify(job) {
  if (job.state === 'paused' || job.enabled === false) return { key: 'paused', label: 'paused' };
  if (job.last_status === 'error' || job.last_error) {
    return { key: 'error', label: job.last_error || 'run failed' };
  }
  if (job.last_delivery_error) {
    return { key: 'warn', label: `not delivered: ${job.last_delivery_error}` };
  }
  if (job.state === 'error') return { key: 'error', label: job.last_error || 'error' };
  if (!job.last_run_at) return { key: 'idle', label: 'never run' };
  return { key: 'ok', label: 'ok' };
}

const shorten = (text, n = 140) => {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > n ? `${value.slice(0, n)}…` : value;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Octets of a dotted-quad, or null. The WHATWG URL parser has already
 * canonicalised the shorthands (`https://2130706433/` arrives as 127.0.0.1),
 * so only this one form has to be recognised here. */
function ipv4Octets(host) {
  const match = IPV4.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** The eight 16-bit words of an IPv6 literal (brackets already stripped), or
 * null. Written out rather than regexed because the ranges that matter --
 * fc00::/7, fe80::/10, ::ffff:127.0.0.1 -- are numeric, not textual. */
function ipv6Words(host) {
  const toWords = (text) => {
    if (!text) return [];
    const parts = text.split(':');
    const words = [];
    for (const [index, part] of parts.entries()) {
      const octets = ipv4Octets(part);
      if (octets) {
        // A dotted-quad tail (::ffff:127.0.0.1) fills the last two words.
        if (index !== parts.length - 1) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = toWords(halves[0]);
  const tail = halves.length === 2 ? toWords(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...Array(gap).fill(0), ...tail] : null;
}

function isInternalIpv4([a, b]) {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 is CGNAT, which is where Tailscale puts every node. An
  // endpoint in this range is a subscription aimed back into the tailnet, and
  // that is precisely the exfiltration case: payloads carry job names and
  // error text, and the caller supplied the keys to decrypt them.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

function isInternalHost(hostname) {
  // A trailing dot is the DNS root label: `localhost.` resolves exactly where
  // `localhost` does, and the URL parser keeps it on a name (it strips it from
  // a dotted quad, and a bracketed literal carrying one does not parse at all).
  // Normalising it away here, alongside the brackets, is what lets every rule
  // below judge the host the resolver will actually be handed. Repeats parse
  // too (`localhost..`), so strip the whole run.
  const host = hostname
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^\[|\]$/g, '');
  // Nothing but root labels names no host at all, and an endpoint whose target
  // we cannot even identify is not one to keep and re-contact.
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const octets = ipv4Octets(host);
  if (octets) return isInternalIpv4(octets);

  if (!host.includes(':')) return false;
  const words = ipv6Words(host);
  // An IPv6 literal we cannot parse is not one we can vouch for.
  if (!words) return true;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  // ::ffff:a.b.c.d and the deprecated ::a.b.c.d both wrap a v4 address.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return isInternalIpv4([words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]);
  }
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  return (words[0] & 0xffc0) === 0xfe80; // fe80::/10, link local
}

/**
 * Whether an endpoint is one this host is willing to keep and re-contact.
 *
 * web-push turns a stored endpoint into an https.request() from inside the
 * tailnet, refired on every failing cron tick and surviving restarts, so an
 * unvalidated endpoint is a durable SSRF primitive pointed wherever the caller
 * likes. The reason is for the log, never for the response body: naming which
 * rule bit would turn this into a probe oracle for the host's network.
 */
export function isDeliverableEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return { ok: false, reason: 'missing endpoint' };
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: 'endpoint too long' };

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'endpoint is not a URL' };
  }
  if (url.protocol !== 'https:')
    return { ok: false, reason: `scheme ${url.protocol} is not https` };
  if (!url.hostname) return { ok: false, reason: 'endpoint has no host' };
  if (isInternalHost(url.hostname)) {
    return { ok: false, reason: `host ${url.hostname} is internal` };
  }
  return { ok: true };
}

/** Keys we cannot encrypt with are a subscription we can never deliver to, so
 * there is no reason to store one -- and every reason not to let a caller park
 * arbitrary strings in the state file. */
function keysAreUsable(keys) {
  for (const name of ['p256dh', 'auth']) {
    const value = keys?.[name];
    if (typeof value !== 'string' || !value || value.length > MAX_KEY_LENGTH) {
      return { ok: false, reason: `unusable ${name}` };
    }
  }
  return { ok: true };
}

/**
 * Who is asking. server.mjs has already run the identity gate by the time a
 * /push/* request reaches handleRequest, so this only reads the login back off
 * the request to record it -- no second authorization decision is made here.
 * An absent header cannot have come through `tailscale serve`, which always
 * identifies, so it is the host itself.
 */
function callerLogin(request) {
  return (
    String(request?.headers?.['tailscale-user-login'] ?? '')
      .trim()
      .toLowerCase() || 'local'
  );
}

/**
 * `deliver` is injectable purely so tests can observe delivery: web-push
 * refuses plain-HTTP endpoints, so a fake push service is otherwise
 * unreachable. Production always uses the real transport.
 */
export function createNotifications({
  hermesOrigin,
  sessionToken,
  stateDir = defaultStateDir(),
  deliver = (subscription, body) => webpush.sendNotification(subscription, body, { TTL: 3600 }),
}) {
  const publicKey = process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY ?? '';
  const privateKey = process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY ?? '';
  const subject = process.env.HERMES_MOBILE_VAPID_SUBJECT ?? 'mailto:hermes@localhost';
  const enabled = Boolean(publicKey && privateKey);

  const statePath = join(stateDir, 'push-state.json');
  let state = { subscriptions: [], signatures: {} };
  let timer = null;

  if (enabled) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    } catch (error) {
      console.error('Push disabled: invalid VAPID configuration —', error.message);
      return createDisabled('invalid VAPID configuration');
    }
    load();
  }

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      const stored = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      // Versions before endpoints were validated will have persisted whatever
      // they were handed, so re-check on load: otherwise a bad endpoint written
      // once keeps firing forever and upgrading fixes nothing already stored.
      const kept = stored.filter((subscription) => {
        const verdict = isDeliverableEndpoint(subscription?.endpoint);
        if (!verdict.ok) console.warn('Dropping stored push endpoint:', verdict.reason);
        return verdict.ok;
      });
      state = {
        subscriptions: kept,
        signatures:
          parsed.signatures && typeof parsed.signatures === 'object' ? parsed.signatures : {},
      };
      if (kept.length !== stored.length) save();
    } catch {
      // No state yet, or it was corrupted. Either way, start clean.
    }
  }

  function save() {
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      // Subscription endpoints are capability URLs: anyone holding one can push
      // to the device. Keep the file owner-only.
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      console.error('Could not persist push state:', error.message);
      return;
    }
    try {
      // `mode` on writeFileSync only applies when the write creates the file,
      // so an existing state file keeps whatever mode it already had. Until
      // now the 0600 in production came from the unit's UMask=0077 rather than
      // from anything this code did.
      chmodSync(statePath, 0o600);
    } catch (error) {
      // A filesystem that cannot do POSIX modes is not a reason to take the
      // process down; the write itself already succeeded.
      console.error('Could not restrict push state permissions:', error.message);
    }
  }

  function addSubscription(subscription, owner = null) {
    const endpoint = isDeliverableEndpoint(subscription?.endpoint);
    if (!endpoint.ok) return { ok: false, reason: endpoint.reason };
    const keys = keysAreUsable(subscription?.keys);
    if (!keys.ok) return { ok: false, reason: keys.reason };

    // An endpoint is a capability URL for one specific device, so replacing an
    // entry hands that device's alerts -- and the keys they are encrypted with
    // -- to whoever asked. Refusing here is what makes the ownership rule in
    // removeSubscription mean anything: without it a stranger could overwrite
    // the entry to make it their own and then delete it, or leave unusable keys
    // behind so every delivery fails with a non-404 that send() keeps retrying
    // forever. The owner-less exemption is the same one described there.
    const existing = state.subscriptions.find((s) => s.endpoint === subscription.endpoint);
    if (existing && existing.owner != null && existing.owner !== owner) {
      // Flagged rather than described, so the HTTP layer can answer exactly as
      // it does for a refused removal: a status the caller could tell apart
      // from success would turn /push/subscribe into a probe for which
      // endpoints this host holds.
      return { ok: false, reason: 'endpoint belongs to another identity', conflict: true };
    }

    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
    state.subscriptions.push({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      owner,
    });
    // Bound per identity first, so a device that reinstalls repeatedly -- or a
    // caller doing it on purpose -- evicts only its own older registrations
    // and never another person's phone.
    const mine = state.subscriptions.filter((s) => s.owner === owner);
    if (mine.length > MAX_SUBSCRIPTIONS_PER_OWNER) {
      const evicted = new Set(mine.slice(0, mine.length - MAX_SUBSCRIPTIONS_PER_OWNER));
      state.subscriptions = state.subscriptions.filter((s) => !evicted.has(s));
    }
    if (state.subscriptions.length > MAX_SUBSCRIPTIONS) {
      state.subscriptions = state.subscriptions.slice(-MAX_SUBSCRIPTIONS);
    }
    save();
    return { ok: true };
  }

  /**
   * Removal is scoped to whoever registered the subscription. Without this one
   * allowlisted-but-hostile caller -- or anyone at all when
   * HERMES_MOBILE_ALLOW_LOCAL is on -- could silently unsubscribe another
   * person's phone and leave them believing they were still being alerted.
   *
   * Subscriptions persisted before ownership was recorded stay removable -- and
   * replaceable, see addSubscription -- by anyone rather than being migrated:
   * on load there is no identity to attribute them to, and dropping them
   * outright would stop alerts for a device that is still registered. The gap
   * closes on its own, since browsers re-POST their subscription on every load,
   * and the first such POST is what puts an owner on the entry.
   */
  function removeSubscription(endpoint, owner = null) {
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter(
      (s) => s.endpoint !== endpoint || !(s.owner == null || s.owner === owner),
    );
    if (state.subscriptions.length !== before) save();
    return { ok: true };
  }

  async function send(payload) {
    if (!enabled || !state.subscriptions.length) return;
    const body = JSON.stringify(payload);
    const dead = [];
    await Promise.all(
      state.subscriptions.map(async (subscription) => {
        try {
          await deliver(subscription, body);
          subscription.failures = 0;
        } catch (error) {
          // 404/410 mean the browser threw the subscription away.
          if (error.statusCode === 404 || error.statusCode === 410) {
            dead.push(subscription.endpoint);
            return;
          }
          // Anything else may be a blip, so one failure is not a verdict -- but
          // "kept forever" is not either. An endpoint that has failed this many
          // ticks in a row is not coming back, and retrying it every minute for
          // the life of the process is noise that hides the alerts that matter.
          subscription.failures = (subscription.failures ?? 0) + 1;
          console.error('Push send failed:', error.statusCode ?? error.message);
          if (subscription.failures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(
              `Dropping a push subscription after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
            );
            dead.push(subscription.endpoint);
          }
        }
      }),
    );
    if (dead.length) {
      state.subscriptions = state.subscriptions.filter((s) => !dead.includes(s.endpoint));
      save();
    }
  }

  async function fetchJobs() {
    const response = await fetch(`${hermesOrigin}/api/cron/jobs?profile=all`, {
      headers: sessionToken ? { 'X-Hermes-Session-Token': sessionToken } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`cron jobs returned ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : (data?.jobs ?? []);
  }

  async function poll() {
    let jobs;
    try {
      jobs = await fetchJobs();
    } catch (error) {
      // A backend restart must not kill the watcher; just try again next tick.
      console.error('Cron watch poll failed:', error.message);
      return;
    }

    // The very first poll only records what it sees. Without this, enabling
    // push would immediately fire one notification per already-broken job.
    const seeding = Object.keys(state.signatures).length === 0;
    const failures = [];
    const signatures = {};

    for (const job of jobs) {
      const status = classify(job);
      const signature = `${status.key}:${job.last_run_at ?? ''}:${job.last_error ?? ''}`;
      signatures[job.id] = signature;
      if (seeding) continue;
      if (status.key !== 'error' && status.key !== 'warn') continue;
      if (state.signatures[job.id] === signature) continue;
      failures.push({ job, status });
    }

    state.signatures = signatures;
    save();
    if (!failures.length) return;

    if (failures.length === 1) {
      const [{ job, status }] = failures;
      await send({
        title: `${job.name || job.id} failed`,
        body: shorten(status.label),
        tag: `job-${job.id}`,
        url: `/#/job/${encodeURIComponent(job.id)}`,
      });
      return;
    }
    await send({
      title: `${failures.length} scheduled jobs failed`,
      body: shorten(failures.map(({ job }) => job.name || job.id).join(', ')),
      tag: 'jobs',
      url: '/#/work',
    });
  }

  function start() {
    if (!enabled || timer) return;
    timer = setInterval(() => {
      poll().catch((error) => console.error('Cron watch error:', error.message));
    }, POLL_MS);
    timer.unref?.();
    poll().catch((error) => console.error('Cron watch error:', error.message));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Handles /push/*. Returns true when it took the request, so the caller can
   * fall through to static files otherwise.
   */
  async function handleRequest(request, response, url) {
    if (!url.pathname.startsWith('/push/')) return false;

    if (url.pathname === '/push/config' && request.method === 'GET') {
      return json(response, 200, { enabled, publicKey: enabled ? publicKey : null });
    }
    if (!enabled) {
      return json(response, 503, { error: 'Push is not configured on this host.' });
    }

    if (url.pathname === '/push/subscribe' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body) return json(response, 400, { error: 'Expected a JSON body.' });
      const result = addSubscription(body, callerLogin(request));
      if (result.ok) return json(response, 204, null);
      console.warn('Refused push subscription:', result.reason);
      // An endpoint someone else registered answers like a stored one, for the
      // same reason /push/unsubscribe always answers 204: the caller supplied a
      // subscription that is valid in every other respect, so a distinct code
      // here would say "this host holds that endpoint, and not for you". The
      // caller's own device is simply not registered, and its browser re-POSTs
      // on the next load.
      if (result.conflict) return json(response, 204, null);
      // Deliberately uniform: which rule rejected it stays in the log.
      return json(response, 400, { error: 'That push subscription was not accepted.' });
    }

    if (url.pathname === '/push/unsubscribe' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body?.endpoint) return json(response, 400, { error: 'Expected an endpoint.' });
      // 204 whether or not anything was removed: a caller must not be able to
      // learn which endpoints this host holds by probing for a different code.
      removeSubscription(String(body.endpoint), callerLogin(request));
      return json(response, 204, null);
    }

    return json(response, 404, { error: 'Not found.' });
  }

  return { enabled, start, stop, handleRequest, poll, addSubscription, removeSubscription };
}

function createDisabled(reason) {
  return {
    enabled: false,
    start() {},
    stop() {},
    async handleRequest(request, response, url) {
      if (!url.pathname.startsWith('/push/')) return false;
      if (url.pathname === '/push/config' && request.method === 'GET') {
        return json(response, 200, { enabled: false, publicKey: null, reason });
      }
      return json(response, 503, { error: 'Push is not configured on this host.' });
    },
  };
}

function json(response, status, payload) {
  if (payload === null) {
    response.writeHead(status);
    response.end();
    return true;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
  return true;
}

// Bounded so an oversized body cannot be used to exhaust memory on the host.
function readJson(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}
