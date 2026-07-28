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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import webpush from 'web-push';

const POLL_MS = 60_000;
const MAX_SUBSCRIPTIONS = 20;

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
      state = {
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        signatures:
          parsed.signatures && typeof parsed.signatures === 'object' ? parsed.signatures : {},
      };
    } catch {
      // No state yet, or it was corrupted. Either way, start clean.
    }
  }

  function save() {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      // Subscription endpoints are capability URLs: anyone holding one can push
      // to the device. Keep the file owner-only.
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      console.error('Could not persist push state:', error.message);
    }
  }

  function addSubscription(subscription) {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return { ok: false, error: 'Malformed subscription' };
    }
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
    state.subscriptions.push({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });
    // Bound the list so a device that reinstalls repeatedly cannot grow the
    // file without limit.
    if (state.subscriptions.length > MAX_SUBSCRIPTIONS) {
      state.subscriptions = state.subscriptions.slice(-MAX_SUBSCRIPTIONS);
    }
    save();
    return { ok: true };
  }

  function removeSubscription(endpoint) {
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
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
        } catch (error) {
          // 404/410 mean the browser threw the subscription away. Anything else
          // is transient and the subscription is kept.
          if (error.statusCode === 404 || error.statusCode === 410)
            dead.push(subscription.endpoint);
          else console.error('Push send failed:', error.statusCode ?? error.message);
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
      const result = addSubscription(body);
      return result.ok ? json(response, 204, null) : json(response, 400, { error: result.error });
    }

    if (url.pathname === '/push/unsubscribe' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body?.endpoint) return json(response, 400, { error: 'Expected an endpoint.' });
      removeSubscription(String(body.endpoint));
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
