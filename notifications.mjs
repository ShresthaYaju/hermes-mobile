// Web Push: subscription storage plus three sources of things a phone-only
// user needs to be told about. observe() turns a Hermes session event
// (someone else's proxy connection, forwarded by the gateway) into a push --
// an approval or question stuck waiting, a reply or error once the phone has
// stopped looking. poll() watches scheduled cron jobs the same way it always
// has. And poll() separately watches its own connection to Hermes, because a
// proxy that has quietly lost its agent is not something the phone would
// otherwise ever find out.
//
// This exists because the failure mode that actually matters for an always-on
// agent is silent: nothing surfaces on its own unless the phone happens to be
// looking at it right now, and the phone is the only place the person ever
// looks. Each device picks which of these it wants -- see PUSH_KINDS -- so a
// push is only ever as loud as that device asked for.
//
// Everything here degrades to a no-op when VAPID keys are absent. The app must
// stay fully usable without push configured.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import dns from 'node:dns';
import https from 'node:https';
import webpush from 'web-push';

// The exact spelling and order the client shows as labels, and the order
// every stored `kinds` list is normalized into.
export const PUSH_KINDS = ['approval', 'reply', 'error', 'ops', 'job'];

const POLL_MS = 60_000;
const MAX_SUBSCRIPTIONS = 20;
// Per identity, so a caller that floods subscriptions can only evict its own
// devices. The global cap stays as a backstop: reaching it now needs four-plus
// distinct allowlisted logins, and everyone on the allowlist can already drive
// the agent, so cross-identity eviction is not the threat worth more code. When
// the global cap is hit, the new add is refused rather than evicting whichever
// entry happens to be globally oldest -- that entry can belong to any identity,
// so silently dropping it let one identity's flood bump a completely unrelated
// person's device. Refusing costs the new device its registration; it does not
// cost anyone else theirs.
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
// A free-text job name is the one field in a notification with no natural
// bound. Cap it well short of what any push service will accept (most sit
// around 4KB post-encryption) so an oversized one degrades to a smaller
// notification instead of a guaranteed 413 that the failure accounting in
// send() would then have to count against the subscription for no fault of
// its own.
const NOTIFICATION_TITLE_CHARS = 80;
const NOTIFICATION_TAG_CHARS = 100;
const MAX_PUSH_PAYLOAD_BYTES = 3800;
// How long to give a single delivery before giving up on it. Without this a
// wedged connection to one dead-but-not-yet-reset endpoint can hold the watcher
// open indefinitely -- there is no default timeout on an outbound HTTPS request.
const DELIVERY_TIMEOUT_MS = 10_000;
// Consecutive failed polls (~3 minutes at the 60s tick) before the backend is
// treated as down rather than blipping -- a deploy or a restart of the agent
// must not itself trigger an unreachable alert.
const BACKEND_DOWN_THRESHOLD = 3;

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

/** The IPv6-literal internal-range rules. Shared by isInternalHost, which
 * judges the literal a caller wrote in the endpoint, and isInternalAddress,
 * which judges what that endpoint's host actually resolves to -- the two are
 * not the same string (see guardedLookup), but the ranges that disqualify an
 * address are. */
function isInternalIpv6Words(words) {
  // An IPv6 literal we cannot parse is not one we can vouch for.
  if (!words) return true;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  // Several IPv6 forms carry an IPv4 address inside them, and on a host with
  // the matching transition mechanism configured they reach that address. So
  // wherever a v4 address is embedded, unwrap it and apply the v4 rules --
  // otherwise `[64:ff9b::7f00:1]` is a spelling of 127.0.0.1 that walks past
  // every check above.
  const embedded = embeddedIpv4(words);
  if (embedded) return isInternalIpv4(embedded);

  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link local
  return (words[0] & 0xffc0) === 0xfec0; // fec0::/10, deprecated site local
}

// DNS names that never leave the machine resolving them: Tailscale's own
// MagicDNS zone, mDNS (RFC 6862 .local), RFC 8375's .home.arpa, and the
// long-standing ad hoc conventions (.internal, .lan, .corp, .home) that split-
// horizon setups and home routers use for exactly this. A literal endpoint
// host is checked against these here, before anything is ever resolved --
// guardedLookup below is the second, resolved-address layer that catches a
// name that looked public when accepted and points into the tailnet later.
const INTERNAL_HOST_SUFFIXES = [
  '.ts.net',
  '.local',
  '.internal',
  '.localhost',
  '.home.arpa',
  '.lan',
  '.corp',
  '.home',
];

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

  if (!host.includes(':')) {
    // Not an IPv4 literal and no colon, so this names something a resolver
    // decides at connect time, not an address written into the endpoint. A
    // dotless name can only resolve through a search-domain suffix, mDNS or an
    // /etc/hosts entry -- none of which is a public service -- and the
    // suffixes above cover the ones that spell that out explicitly.
    if (!host.includes('.')) return true;
    if (INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
    return false;
  }

  return isInternalIpv6Words(ipv6Words(host));
}

/** Big-endian octets of the IPv4 address an IPv6 literal embeds, or null. */
function embeddedIpv4(words) {
  const quad = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

  // ::ffff:a.b.c.d (v4-mapped) and the deprecated ::a.b.c.d (v4-compatible).
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return quad(words[6], words[7]);
  }
  // ::ffff:0:a.b.c.d -- v4-translated, one word further left than v4-mapped.
  if (words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0) {
    return quad(words[6], words[7]);
  }
  // 2002:a.b.c.d::/16 -- 6to4 puts the address immediately after the prefix.
  if (words[0] === 0x2002) return quad(words[1], words[2]);
  // 64:ff9b::a.b.c.d -- the well-known NAT64 prefix, which is the one of these
  // still in live use: on a NAT64 network this really is translated.
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    return quad(words[6], words[7]);
  }
  return null;
}

/** Whether a resolved address -- what a hostname actually connects to, not
 * what the caller wrote -- is one this host should not deliver to. Narrower
 * than isInternalHost: dns.lookup hands back a plain address with no brackets
 * and no root dot, so there is no caller-supplied spelling to normalise. */
function isInternalAddress(address) {
  if (typeof address !== 'string' || !address) return true;
  const host = address.toLowerCase();
  const octets = ipv4Octets(host);
  if (octets) return isInternalIpv4(octets);
  if (!host.includes(':')) return true; // not an address shape this code knows
  return isInternalIpv6Words(ipv6Words(host));
}

/**
 * Wraps a DNS resolver so that resolving to an internal address fails the
 * lookup instead of quietly connecting to it. isDeliverableEndpoint only ever
 * judges the literal host a caller wrote at subscribe time; a name that
 * resolved publicly then can be repointed at a tailnet address later (DNS
 * rebinding), and a name can resolve to several addresses where only one of
 * them is internal -- `all: true` is what catches that second case, since the
 * connection is not guaranteed to land on the first one returned.
 *
 * web-push does not accept a `lookup` option directly -- `agent` and `timeout`
 * are the only hooks its options allowlist exposes -- so this is threaded in
 * through an https.Agent's own `lookup`, which every connection made through
 * that agent inherits.
 *
 * Takes the underlying resolver as a parameter, rather than calling
 * dns.lookup itself, so it can be tested with a fake one instead of a real
 * DNS query.
 */
export function guardedLookup(resolver = dns.lookup) {
  return function lookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    } else if (typeof opts === 'number') {
      opts = { family: opts };
    }
    resolver(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const internal = list.find((entry) => isInternalAddress(entry?.address ?? entry));
      if (internal) {
        const address = internal?.address ?? internal;
        return cb(
          new Error(`refusing to deliver: ${hostname} resolves to internal address ${address}`),
        );
      }
      if (opts.all) return cb(null, list);
      const [first] = list;
      cb(null, first?.address ?? first, first?.family);
    });
  };
}

// One agent for every delivery this process makes: creating it does no I/O by
// itself, and reusing it is what lets the lookup guard above run on every
// single connection without having to be threaded through each call site.
const deliveryAgent = new https.Agent({ lookup: guardedLookup() });

/**
 * Whether an endpoint is one this host is willing to keep and re-contact.
 *
 * web-push turns a stored endpoint into an https.request() from inside the
 * tailnet, refired on every failing cron tick and surviving restarts, so an
 * unvalidated endpoint is a durable SSRF primitive pointed wherever the caller
 * likes. This is the literal-host layer, checked once at subscribe time; the
 * connection guardedLookup installs on every delivery is the second layer,
 * checked against the resolved address every single time. Both exist because
 * they catch different things -- this one is free and rejects instantly, that
 * one is what still holds if a name is deliberately repointed after being
 * accepted. The reason is for the log, never for the response body: naming
 * which rule bit would turn this into a probe oracle for the host's network.
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

/** Base64url-decodes without throwing on characters that are not part of the
 * alphabet -- Buffer.from tolerates and truncates rather than raising, and the
 * length/prefix checks below reject the truncated result on their own. */
function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

/** Keys we cannot encrypt with are a subscription we can never deliver to, so
 * there is no reason to store one -- and every reason not to let a caller park
 * arbitrary strings in the state file. Beyond "is a string of sane length",
 * the keys have a specific decoded shape: p256dh is an uncompressed P-256
 * point (0x04 followed by 32-byte X and Y, 65 bytes total) and auth is at
 * least the 16-byte secret the Web Push spec requires. A string that decodes
 * to anything else cannot be a real subscription key, whatever produced it. */
function keysAreUsable(keys) {
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  for (const [name, value] of [
    ['p256dh', p256dh],
    ['auth', auth],
  ]) {
    if (typeof value !== 'string' || !value || value.length > MAX_KEY_LENGTH) {
      return { ok: false, reason: `unusable ${name}` };
    }
  }
  const p256dhBytes = decodeBase64Url(p256dh);
  if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) {
    return { ok: false, reason: 'unusable p256dh' };
  }
  const authBytes = decodeBase64Url(auth);
  if (authBytes.length < 16) {
    return { ok: false, reason: 'unusable auth' };
  }
  return { ok: true };
}

/** Reduces an arbitrary `kinds` field to the subset of PUSH_KINDS it names,
 * de-duplicated and in PUSH_KINDS order. Returns null when `value` is not an
 * array at all -- the signal that kinds was not supplied, as distinct from an
 * array that was supplied and happens to name nothing recognised (or nothing
 * at all), which is a real, explicit "subscribed to nothing" and comes back
 * as []. Callers decide what null means; this only classifies the input. */
function sanitizeKinds(value) {
  if (!Array.isArray(value)) return null;
  const requested = new Set(value);
  return PUSH_KINDS.filter((kind) => requested.has(kind));
}

/**
 * Rebuilds a subscription from an arbitrary object field-by-field, dropping
 * anything that is not one of the fields this code itself writes, and
 * refusing outright if what is left cannot be delivered to or encrypted for.
 * Used when reading the state file back in: a file written by an older or
 * hand-edited version of this code can carry the same unusable shapes a POST
 * body can, and a state file is not a more trustworthy input than a request
 * just because it lives on disk.
 */
function normalizeSubscription(candidate) {
  const endpoint = isDeliverableEndpoint(candidate?.endpoint);
  if (!endpoint.ok) return null;
  const keys = keysAreUsable(candidate?.keys);
  if (!keys.ok) return null;
  // A legacy entry -- from before kinds existed -- carries no signal that
  // anything was ever opted out of, so it comes back as every kind rather
  // than none.
  const rebuilt = {
    endpoint: candidate.endpoint,
    keys: { p256dh: candidate.keys.p256dh, auth: candidate.keys.auth },
    owner: typeof candidate.owner === 'string' ? candidate.owner : null,
    kinds: sanitizeKinds(candidate?.kinds) ?? [...PUSH_KINDS],
  };
  if (Number.isInteger(candidate?.failures) && candidate.failures > 0) {
    rebuilt.failures = candidate.failures;
  }
  return rebuilt;
}

/** Applies the per-owner and global caps to a list of subscriptions, keeping
 * the most recently registered of each and preserving relative order. Used to
 * bring a state file back within bounds on load; addSubscription enforces the
 * same per-owner cap on every add but, per the comment above
 * MAX_SUBSCRIPTIONS_PER_OWNER, refuses a new add rather than evicting anyone
 * once the global cap is reached instead of pruning down to it. */
function capSubscriptions(list) {
  const byOwner = new Map();
  for (const subscription of list) {
    const bucket = byOwner.get(subscription.owner) ?? [];
    bucket.push(subscription);
    byOwner.set(subscription.owner, bucket);
  }
  const kept = new Set();
  for (const bucket of byOwner.values()) {
    for (const subscription of bucket.slice(-MAX_SUBSCRIPTIONS_PER_OWNER)) {
      kept.add(subscription);
    }
  }
  let capped = list.filter((subscription) => kept.has(subscription));
  if (capped.length > MAX_SUBSCRIPTIONS) capped = capped.slice(-MAX_SUBSCRIPTIONS);
  return capped;
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

/** Whether two job-id -> signature maps are the same, without caring about
 * key order. Used to decide whether a poll actually changed anything worth
 * persisting. */
function signaturesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, signature] of a) {
    if (b.get(id) !== signature) return false;
  }
  return true;
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
  deliver = (subscription, body) =>
    webpush.sendNotification(subscription, body, {
      TTL: 3600,
      agent: deliveryAgent,
      timeout: DELIVERY_TIMEOUT_MS,
    }),
}) {
  const publicKey = process.env.HERMES_MOBILE_VAPID_PUBLIC_KEY ?? '';
  const privateKey = process.env.HERMES_MOBILE_VAPID_PRIVATE_KEY ?? '';
  const subject = process.env.HERMES_MOBILE_VAPID_SUBJECT ?? 'mailto:hermes@localhost';
  const enabled = Boolean(publicKey && privateKey);

  const statePath = join(stateDir, 'push-state.json');
  let state = { subscriptions: [], signatures: new Map(), seeded: false };
  let timer = null;
  let polling = false;
  // Set by load() when it drops or reshapes something from disk, and by
  // poll() when a tick actually changes the signature map. save() is
  // otherwise called unconditionally from addSubscription/removeSubscription,
  // which already know they have something worth persisting.
  let dirty = false;
  // Backend reachability is a live-process concern, not a durable one -- it
  // resets to "assume reachable" on every restart rather than surviving in
  // the state file, so a proxy that comes back up after a crash does not
  // immediately replay a stale "still down" verdict.
  let consecutiveFetchFailures = 0;
  let backendDown = false;

  if (enabled) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    } catch (error) {
      console.error('Push disabled: invalid VAPID configuration —', error.message);
      return createDisabled('invalid VAPID configuration');
    }
    load();
    if (dirty) save();
  }

  /** Creates the state directory if needed and makes sure it is owner-only,
   * whether this call just created it or it already existed with some other
   * mode -- from an older version, or from being created by hand. */
  function ensureStateDir() {
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error('Could not create push state directory:', error.message);
      return false;
    }
    try {
      // `mode` on mkdirSync, like on writeFileSync, only applies when the call
      // itself creates the directory.
      chmodSync(dirname(statePath), 0o700);
    } catch (error) {
      console.error('Could not restrict push state directory permissions:', error.message);
    }
    return true;
  }

  function load() {
    ensureStateDir();

    let raw;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch (error) {
      // No state yet is the common, silent case -- every fresh install and
      // every test hits it. Anything else (permissions, a directory where the
      // file should be, ...) is not something to fail quietly through, since
      // it means whatever was there before is not what is loaded now.
      if (error.code !== 'ENOENT') {
        console.warn('Could not read push state, starting clean:', statePath, '—', error.message);
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn('Could not parse push state, starting clean:', statePath, '—', error.message);
      return;
    }

    const stored = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
    // Versions before endpoints and keys were validated -- or a file edited by
    // hand -- can carry entries this code would now refuse outright, or extra
    // fields it never wrote itself. Re-validate and rebuild each one rather
    // than trusting the file, and re-apply the caps: otherwise a bad entry
    // written once keeps firing forever and upgrading fixes nothing already
    // on disk.
    const rebuilt = [];
    for (const candidate of stored) {
      const normalized = normalizeSubscription(candidate);
      if (!normalized) {
        console.warn('Dropping stored push subscription: unusable endpoint or keys');
        continue;
      }
      rebuilt.push(normalized);
    }
    const kept = capSubscriptions(rebuilt);

    // A plain object read from JSON is a safe source for Object.entries
    // regardless of what its keys are named -- JSON.parse builds it with
    // ordinary property definitions, not the assignment that would trigger
    // Object.prototype's `__proto__` setter -- but the state this code
    // operates on going forward is a Map for exactly that reason: a job id of
    // `__proto__` must be an ordinary entry, never a prototype write, and a
    // Map has no prototype-keyed special case to get that wrong.
    const signatures =
      parsed.signatures && typeof parsed.signatures === 'object'
        ? new Map(Object.entries(parsed.signatures))
        : new Map();

    state = {
      subscriptions: kept,
      signatures,
      seeded: Boolean(parsed.seeded),
    };
    if (kept.length !== stored.length) dirty = true;
  }

  function save() {
    if (!ensureStateDir()) return;
    const tmpPath = `${statePath}.tmp`;
    try {
      // Subscription endpoints are capability URLs: anyone holding one can push
      // to the device. Write to a temp file and rename over the real one so a
      // crash or a concurrent read mid-write never sees a torn (truncated or
      // half-written) file -- a rename onto an existing path is atomic on the
      // same filesystem, a write in place is not.
      writeFileSync(
        tmpPath,
        JSON.stringify({
          subscriptions: state.subscriptions,
          signatures: Object.fromEntries(state.signatures),
          seeded: state.seeded,
        }),
        { mode: 0o600 },
      );
      renameSync(tmpPath, statePath);
    } catch (error) {
      console.error('Could not persist push state:', error.message);
      return;
    }
    try {
      // `mode` on writeFileSync only applies to the file it creates, and the
      // rename above always lands a freshly-created temp file on the target --
      // but chmod explicitly anyway rather than lean on that: rename does not
      // promise to preserve or reset a mode the same way on every platform.
      chmodSync(statePath, 0o600);
    } catch (error) {
      // A filesystem that cannot do POSIX modes is not a reason to take the
      // process down; the write itself already succeeded.
      console.error('Could not restrict push state permissions:', error.message);
    }
    dirty = false;
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

    // The global cap is a backstop, not a queue to bump someone out of: see
    // the comment above MAX_SUBSCRIPTIONS_PER_OWNER. A same-endpoint update
    // (re-subscribing, rotating keys) never grows the total, so only a
    // genuinely new endpoint can be refused here.
    if (!existing && state.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      return { ok: false, reason: 'this host is not accepting more push subscriptions' };
    }

    // A caller that omits `kinds` is either the client self-healing (it
    // re-POSTs the existing subscription every time the notifications setting
    // is opened) or an older client that never knew kinds existed -- neither
    // should silently reset a choice already made. Only an explicit array,
    // even an empty one, changes it; otherwise a known endpoint keeps what it
    // had, and a genuinely new one defaults to everything.
    const requestedKinds = sanitizeKinds(subscription?.kinds);
    const kinds = requestedKinds ?? existing?.kinds ?? [...PUSH_KINDS];

    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
    state.subscriptions.push({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      owner,
      kinds,
    });
    // Bound per identity first, so a device that reinstalls repeatedly -- or a
    // caller doing it on purpose -- evicts only its own older registrations
    // and never another person's phone.
    const mine = state.subscriptions.filter((s) => s.owner === owner);
    if (mine.length > MAX_SUBSCRIPTIONS_PER_OWNER) {
      const evicted = new Set(mine.slice(0, mine.length - MAX_SUBSCRIPTIONS_PER_OWNER));
      state.subscriptions = state.subscriptions.filter((s) => !evicted.has(s));
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
   * closes on its own, since the client re-POSTs its subscription whenever the
   * notifications setting is opened, and the first such POST is what puts an
   * owner on the entry.
   */
  function removeSubscription(endpoint, owner = null) {
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter(
      (s) => s.endpoint !== endpoint || !(s.owner == null || s.owner === owner),
    );
    if (state.subscriptions.length !== before) save();
    return { ok: true };
  }

  /**
   * `kind` restricts delivery to subscriptions that opted into that
   * PUSH_KINDS value; `owner`, when a string, further restricts it to that
   * identity's own devices (approvals, replies and errors belong to whoever's
   * session produced them -- a job failure or a backend outage, with owner
   * left null, is host-wide and every kind-matching device gets it).
   */
  async function send(payload, { kind, owner = null } = {}) {
    if (!enabled || !state.subscriptions.length) return;
    const targets = state.subscriptions.filter((subscription) => {
      if (kind && !subscription.kinds?.includes(kind)) return false;
      if (typeof owner === 'string' && subscription.owner !== owner) return false;
      return true;
    });
    if (!targets.length) return;
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PUSH_PAYLOAD_BYTES) {
      // A payload this size will not fit through most push services anyway
      // (they cap well under 4KB after encryption overhead) and would just
      // turn into a guaranteed 413 on every subscription -- which the countable-
      // 4xx class below correctly counts as a real per-endpoint fault. title/tag
      // are already bounded by the time poll() gets here, but the
      // url is not -- truncating a job id there would deep-link somewhere
      // wrong, so it stays whole on every ordinary payload -- which means an
      // extreme id is the one thing that can still land here. Bound it too in
      // that case: a notification that opens the app instead of the exact job
      // beats one that never sends at all.
      body = JSON.stringify({
        title: shorten(payload.title, 40),
        body: 'Open the app for details',
        tag: payload.tag ? shorten(payload.tag, NOTIFICATION_TAG_CHARS) : undefined,
        url: shorten(payload.url, 200),
      });
    }
    const dead = new Set();
    const outcomes = [];
    await Promise.all(
      targets.map(async (subscription) => {
        try {
          await deliver(subscription, body);
          subscription.failures = 0;
          outcomes.push({ subscription, ok: true });
        } catch (error) {
          // 404/410 mean the browser threw the subscription away. That is a
          // verdict about this one endpoint regardless of what else happened
          // this tick, so it is reaped immediately rather than going through
          // the consecutive-failure accounting below.
          if (error.statusCode === 404 || error.statusCode === 410) {
            dead.add(subscription.endpoint);
            outcomes.push({ subscription, ok: false });
            return;
          }
          console.error('Push send failed:', error.statusCode ?? error.message);
          // Countable: a 4xx that carries a statusCode other than 404/410 --
          // our request was malformed, unauthorized, or too large, and
          // retrying it verbatim will not fix that. Not countable: 429 (rate
          // limited -- back off, do not evict), 5xx (their outage, not this
          // endpoint's fault), and no statusCode at all (ENOTFOUND,
          // ECONNREFUSED, a timeout -- OUR network is down, and penalizing
          // every subscription for that is exactly the whole-fleet eviction
          // this exists to prevent).
          const countable =
            typeof error.statusCode === 'number' &&
            error.statusCode >= 400 &&
            error.statusCode < 500 &&
            error.statusCode !== 429;
          outcomes.push({ subscription, ok: false, countable });
        }
      }),
    );

    // If literally everything failed this tick, that is a signal about this
    // host or its network, not about any one subscription -- a fleet-wide
    // outage that happens to give every endpoint the same 4xx (a broken VAPID
    // key, say) would otherwise evict every subscription in lockstep exactly
    // as fast as ten individually-broken ones.
    const allFailed = outcomes.length > 0 && outcomes.every((outcome) => !outcome.ok);
    if (!allFailed) {
      for (const outcome of outcomes) {
        if (outcome.ok || !outcome.countable) continue;
        outcome.subscription.failures = (outcome.subscription.failures ?? 0) + 1;
        if (outcome.subscription.failures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `Dropping a push subscription after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
          );
          dead.add(outcome.subscription.endpoint);
        }
      }
    }

    if (dead.size) {
      state.subscriptions = state.subscriptions.filter((s) => !dead.has(s.endpoint));
      save();
    }
  }

  // event type       | attached? | kind     | notes
  // -----------------+-----------+----------+----------------------------------
  // approval.request  | (any)     | approval | always -- a stuck half-open
  //                   |           |          | socket must not silence the one
  //                   |           |          | push that unblocks the agent
  // clarify.request   | (any)     | approval | same reasoning as above
  // message.complete  | attached  | (none)   | phone is already looking
  //   status=interrupted| (any)   | (none)   | not a result worth surfacing
  //   status=error     | not att. | error    |
  //   otherwise        | not att. | reply    |
  // error              | attached | (none)   | phone is already looking
  //                    | not att. | error    |
  // anything else      | --        | --       | ignored
  //
  // Every push here carries owner: login -- only the person whose session
  // produced the event, unlike the host-wide job/ops pushes below.
  async function observe({ login, attached, type, sessionId, threadId, payload } = {}) {
    try {
      const p = payload ?? {};
      const chatUrl = threadId ? `/#/chat/${encodeURIComponent(threadId)}` : '/#/chat';

      if (type === 'approval.request') {
        await send(
          {
            title: 'Approval needed',
            body: shorten(
              p.command || p.description || p.tool || 'Hermes is waiting for a decision',
            ),
            tag: `approval-${shorten(p.request_id, 60)}`,
            url: '/#/now',
          },
          { kind: 'approval', owner: login },
        );
        return;
      }

      if (type === 'clarify.request') {
        await send(
          {
            title: 'Hermes has a question',
            body: shorten(p.question || p.text || ''),
            tag: `approval-${shorten(p.request_id, 60)}`,
            url: '/#/now',
          },
          { kind: 'approval', owner: login },
        );
        return;
      }

      if (type === 'message.complete') {
        if (attached) return;
        if (p.status === 'interrupted') return;
        if (p.status === 'error') {
          await send(
            {
              title: 'Hermes hit an error',
              body: shorten(p.text),
              tag: `error-${sessionId}`,
              url: chatUrl,
            },
            { kind: 'error', owner: login },
          );
          return;
        }
        await send(
          {
            title: 'Hermes replied',
            body: shorten(p.text) || 'Done',
            tag: `reply-${sessionId}`,
            url: chatUrl,
          },
          { kind: 'reply', owner: login },
        );
        return;
      }

      if (type === 'error') {
        if (attached) return;
        await send(
          {
            title: 'Hermes hit an error',
            body: shorten(p.message),
            tag: `error-${sessionId}`,
            url: chatUrl,
          },
          { kind: 'error', owner: login },
        );
      }
    } catch (error) {
      console.error('observe() failed:', error.message);
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
    // Ticks are a minute apart and a single one can, in the worst case, hang
    // for as long as DELIVERY_TIMEOUT_MS times every subscription. Without
    // this guard a slow tick and the next interval firing would run two
    // deliveries to the same subscriptions concurrently.
    if (polling) return;
    polling = true;
    try {
      let jobs;
      try {
        jobs = await fetchJobs();
      } catch (error) {
        // A backend restart must not kill the watcher; just try again next tick.
        console.error('Cron watch poll failed:', error.message);
        consecutiveFetchFailures += 1;
        if (!backendDown && consecutiveFetchFailures >= BACKEND_DOWN_THRESHOLD) {
          backendDown = true;
          await send(
            {
              title: 'Hermes is unreachable',
              body: 'The proxy cannot reach the agent. Check hermes-mobile-backend.service.',
              tag: 'ops-backend',
              url: '/#/config',
            },
            { kind: 'ops' },
          );
        }
        return;
      }
      consecutiveFetchFailures = 0;
      if (backendDown) {
        backendDown = false;
        await send(
          {
            title: 'Hermes is back',
            body: 'The proxy can reach the agent again.',
            tag: 'ops-backend',
            url: '/#/config',
          },
          { kind: 'ops' },
        );
      }

      // The very first poll only records what it sees. Without this, enabling
      // push would immediately fire one notification per already-broken job.
      // Persisted explicitly (state.seeded) rather than inferred from the
      // signature map being empty: an empty map is also what a job id of
      // `__proto__` produces on a plain object, and inferring from it made
      // seeding either never end or never stop replaying.
      const seeding = !state.seeded;
      const failures = [];
      const signatures = new Map();

      for (const job of jobs) {
        const id = String(job.id);
        const status = classify(job);
        const signature = `${status.key}:${job.last_run_at ?? ''}:${job.last_error ?? ''}`;
        signatures.set(id, signature);
        if (seeding) continue;
        if (status.key !== 'error' && status.key !== 'warn') continue;
        if (state.signatures.get(id) === signature) continue;
        failures.push({ job, status });
      }

      if (seeding || !signaturesEqual(state.signatures, signatures)) {
        state.signatures = signatures;
        if (seeding) state.seeded = true;
        dirty = true;
      }
      // Only persist when something actually changed. Every tick used to save
      // unconditionally, which meant a healthy, unchanging fleet of jobs still
      // rewrote the state file on disk once a minute for as long as the
      // process ran.
      if (dirty) save();
      if (!failures.length) return;

      if (failures.length === 1) {
        const [{ job, status }] = failures;
        const name = shorten(job.name || job.id, NOTIFICATION_TITLE_CHARS);
        await send(
          {
            title: `${name} failed`,
            body: shorten(status.label),
            tag: shorten(`job-${job.id}`, NOTIFICATION_TAG_CHARS),
            url: `/#/job/${encodeURIComponent(job.id)}`,
          },
          { kind: 'job' },
        );
        return;
      }
      await send(
        {
          title: `${failures.length} scheduled jobs failed`,
          body: shorten(failures.map(({ job }) => job.name || job.id).join(', ')),
          tag: 'jobs',
          url: '/#/work',
        },
        { kind: 'job' },
      );
    } finally {
      polling = false;
    }
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
      return json(response, 200, {
        enabled,
        publicKey: enabled ? publicKey : null,
        kinds: PUSH_KINDS,
      });
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
      // caller's own device is simply not registered, and the client re-POSTs
      // it the next time the notifications setting is opened.
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

  return {
    enabled,
    start,
    stop,
    handleRequest,
    poll,
    addSubscription,
    removeSubscription,
    observe,
  };
}

function createDisabled(reason) {
  return {
    enabled: false,
    start() {},
    stop() {},
    async observe() {},
    async handleRequest(request, response, url) {
      if (!url.pathname.startsWith('/push/')) return false;
      if (url.pathname === '/push/config' && request.method === 'GET') {
        return json(response, 200, { enabled: false, publicKey: null, reason, kinds: PUSH_KINDS });
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
