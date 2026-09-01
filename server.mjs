import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import httpProxy from 'http-proxy-3';
import { createNotifications } from './notifications.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4174);
const hermesOrigin = process.env.HERMES_ORIGIN ?? 'http://127.0.0.1:9119';

// Extra browser origins permitted to drive this proxy, comma separated. Empty
// by default: same-origin is the rule, and this exists only for the case where
// the app is served from one hostname and reached by another.
const extraOrigins = new Set(
  (process.env.HERMES_MOBILE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean),
);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

// Hosts this proxy will answer for on /api and /push.
//
// Same-origin compares Origin against the Host header, and DNS rebinding
// controls *both*: point a name you own at 127.0.0.1, and Origin and Host match
// by construction. The check passes, and with HERMES_MOBILE_ALLOW_LOCAL=1 -- the
// documented way to develop against this -- any page the host's browser visits
// reaches the JSON-RPC socket. So the Host itself has to be vouched for, not
// merely agreed with.
//
// The defaults are what a correct deployment actually presents: loopback for
// local use, and the MagicDNS name or CGNAT address that `tailscale serve` puts
// in front. Neither is a name an attacker can point anywhere.
const extraHosts = new Set(
  (process.env.HERMES_MOBILE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

/** Strip the port, and the brackets an IPv6 authority carries. */
function bareHost(hostWithPort) {
  const host = String(hostWithPort ?? '')
    .trim()
    .toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host.slice(1) : host.slice(1, close);
  }
  // A bare IPv6 literal is several colons and no port -- `::1` would otherwise
  // lose its `:1` to the port rule and stop being loopback. Only an IPv4
  // address or a name carries an unbracketed `:port`.
  if (host.indexOf(':') !== host.lastIndexOf(':')) return host;
  return host.replace(/:\d+$/, '');
}

function isAllowedHost(hostWithPort) {
  const host = String(hostWithPort ?? '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (extraHosts.has(host)) return true;

  const bare = bareHost(host);
  if (!bare) return false;
  if (extraHosts.has(bare) || LOOPBACK.has(bare)) return true;
  // The MagicDNS name Serve presents. Tailscale controls this zone, so it is
  // not a name that can be rebound at an attacker's DNS server.
  if (bare === 'ts.net' || bare.endsWith('.ts.net')) return true;
  // 100.64.0.0/10, the CGNAT range tailnet addresses come from, for anyone
  // reaching the node by IP rather than by name.
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/** The peer on the other end of the socket, not any header it sent. */
function isLoopbackPeer(request) {
  return LOOPBACK.has(bareHost(request.socket?.remoteAddress ?? ''));
}

// This value is generated outside the repo and shared only with the loopback
// Hermes service. The browser never receives it: this proxy adds it only to
// the upstream WebSocket handshake.
const hermesSessionToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';

// Tailnet identities permitted to drive the agent, comma separated, matched
// against the Tailscale-User-Login header that `tailscale serve` injects.
//
// Same-origin (below) is a *browser* control: it stops a hostile page, and
// nothing else. It cannot stop curl, which forges or omits Origin freely. So
// until this existed, reachability was authorization -- and a tailnet has
// peers. Any one of them could drive an agent with shell access using nothing
// but a shell one-liner. This is the caller-side control that same-origin
// cannot be.
const allowedLogins = new Set(
  (process.env.HERMES_MOBILE_ALLOWED_LOGINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

// Admits callers that present no identity at all. Those cannot have arrived
// through `tailscale serve` -- it always identifies -- so in practice this is
// the host itself: local curl and the test suite. Off by default.
const allowLocal = process.env.HERMES_MOBILE_ALLOW_LOCAL === '1';

// Puts the reason for a refusal in the response body. Off by default because a
// refusal should not tell an unauthorized caller how authorization works; on
// when first wiring this up, to see what the proxy actually receives.
const identityDebug = process.env.HERMES_MOBILE_IDENTITY_DEBUG === '1';

/**
 * Who is calling. `tailscale serve` sets Tailscale-User-Login for the
 * authenticated tailnet user and strips any copy the client supplied, so the
 * header is trustworthy *only* because reaching this port at all requires
 * either loopback or passing through Serve.
 */
function identify(request) {
  // The header is trusted verbatim, so it is worth only as much as the claim
  // that Serve put it there. Serve proxies from the machine itself, so a
  // non-loopback peer means something else is in front -- an nginx, a Caddy, a
  // public bind -- and in that case the header is just something the caller
  // typed. Refuse rather than believe it.
  if (!isLoopbackPeer(request)) {
    return { ok: false, reason: 'identity presented by a non-loopback peer' };
  }

  const login = String(request.headers['tailscale-user-login'] ?? '')
    .trim()
    .toLowerCase();

  if (!login) {
    // No identity means the caller did not come through Serve, so it is local
    // to the host -- where anyone able to make the request could equally well
    // run the agent directly.
    return allowLocal
      ? { ok: true, login: 'local' }
      : { ok: false, reason: 'no tailnet identity on the request' };
  }
  if (!allowedLogins.has(login)) {
    return { ok: false, login, reason: 'identity is not on the allowlist' };
  }
  return { ok: true, login };
}

// Writes per identity per minute. Generous for a human tapping a phone, and
// low enough that a script cannot sit in a loop on
// POST /api/cron/jobs/{id}/trigger -- which runs the agent every time.
// An empty value means unset, not zero. `HERMES_MOBILE_WRITE_LIMIT=` in an env
// file is a typo, and now that 0 means "refuse every write" it would otherwise
// read as a deliberate lockout and look exactly like the app being broken.
const configuredWriteLimit = (process.env.HERMES_MOBILE_WRITE_LIMIT ?? '').trim();
const WRITE_LIMIT = configuredWriteLimit === '' ? 30 : Number(configuredWriteLimit);
const WRITE_WINDOW_MS = 60_000;
const writeBudget = new Map();

function withinWriteBudget(login) {
  // 0 means no writes at all. It used to mean unlimited, which is the opposite
  // of what someone typing it while hardening a deployment would expect.
  if (WRITE_LIMIT === 0) return false;
  const now = Date.now();
  const entry = writeBudget.get(login);
  if (!entry || now >= entry.resetAt) {
    writeBudget.set(login, { count: 1, resetAt: now + WRITE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= WRITE_LIMIT;
}

/**
 * One line per decision that reaches the agent, so there is a record of what
 * drove it and as whom. Refusals were already logged; accepted writes were not,
 * which meant the interesting half was invisible.
 */
function audit(outcome, { login, method, path }) {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), audit: outcome, login, method, path }),
  );
}

function refuseIdentity(response, pathname, verdict) {
  console.warn(`Refused ${pathname} for ${verdict.login ?? '(no identity)'}: ${verdict.reason}`);
  securityHeaders(response);
  response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  // Never name the allowlist here: a refusal must not teach the caller what
  // would have worked.
  response.end(
    JSON.stringify({
      error: 'This device is not authorized for Hermes.',
      ...(identityDebug ? { detail: verdict.reason, seen: verdict.login ?? null } : {}),
    }),
  );
}
const publicDir = join(process.cwd(), 'public');

// Hermes's backend serves its entire dashboard API on the loopback port, which
// includes secrets (/api/env/reveal), filesystem access (/api/files), and
// gateway lifecycle control (/api/ops). Anyone on the tailnet reaches this
// proxy unauthenticated, so rather than forwarding /api/* wholesale we allow
// only the paths the mobile UI needs. Everything else is refused here and never
// reaches Hermes.
const restReadPrefixes = [
  '/api/status',
  '/api/system/stats',
  '/api/sessions',
  '/api/profiles',
  '/api/cron/jobs',
  '/api/cron/blueprints',
  '/api/cron/delivery-targets',
  '/api/analytics/',
  '/api/logs',
  '/api/model/info',
  // The authenticated-provider catalog the Config picker lists. Named exactly
  // rather than allowing /api/model, which would also hand over the MoA preset
  // editor, the per-task auxiliary pins, and the recommended-default probe --
  // none of which this app renders.
  '/api/model/options',
];

// Writes are enumerated exactly, one method-plus-shape at a time, rather than
// allowed by prefix. Four omissions are deliberate:
//
//   DELETE /api/cron/jobs/{id}  -- also rmtree()s the job's saved run output.
//                                  A mis-tap on a phone is not worth that.
//   POST   /api/cron/jobs       -- creating a schedule needs the blueprint and
//                                  delivery-target UI to be honest about what
//                                  it will do; it is not a mobile action.
//   DELETE /api/sessions/{id}   -- permanently destroys a conversation, which
//                                  is the same class of mis-tap as the cron
//                                  delete above and was inconsistent with it.
//                                  No view ever called it. PATCH stays: rename
//                                  and archive are recoverable.
//   POST   /api/profiles/active -- switches the *sticky* profile without
//                                  retargeting the running dashboard this app
//                                  reads through, so the app would announce one
//                                  profile while still showing another's
//                                  sessions, jobs and model. Config says so
//                                  rather than offering the switch.
const restWriteRules = [
  { method: 'POST', pattern: /^\/api\/cron\/jobs\/[^/]+\/(pause|resume|trigger)$/ },
  { method: 'PUT', pattern: /^\/api\/cron\/jobs\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/api\/sessions\/[^/]+$/ },
  // Assigns the main model in the profile the dashboard is running as -- the
  // same profile /api/model/info reads back, so the picker cannot show one
  // model while having written another. Upstream also honours base_url,
  // api_key and an "auxiliary" scope on this route; a proxy cannot see a
  // request body, so what keeps those off the phone is that no client here
  // composes them (see api.js). The gap is bounded: reaching this at all
  // already means passing the identity gate.
  { method: 'POST', pattern: /^\/api\/model\/set$/ },
];

// The JSON-RPC gateway is a separate, already-working path with its own
// credential handling in the upgrade handler.
const websocketPath = '/api/ws';

// The allowlist matches url.pathname, which the WHATWG parser has normalized.
// `.` and `..` are collapsed there, and http-proxy normalizes the same way
// before forwarding, so /api/status/../env/reveal is refused and stays refused.
//
// What neither parser does is *decode*. `%2f`, `%5c` and `%2e` survive both
// hops untouched, so /api/status/..%2fenv%2freveal passes the prefix test and
// arrives upstream still encoded -- where a parser with different rules may
// decode it and resolve somewhere this proxy never authorized. Today's upstream
// does not, but "safe because of how the other program parses paths" is not a
// property a proxy gets to rely on, least of all a published one whose
// allowlist is the documented boundary.
//
// So refuse encoded separators outright. %25 is included because it is how the
// double-encoded forms start.
const ENCODED_SEPARATOR = /%(?:2f|5c|2e|25)/i;

// Read prefixes are broad by design, which means they also cover the action
// endpoints enumerated as writes below. A GET cannot run them on today's
// backend -- it answers 405 -- but it reaches upstream unlimited and unaudited,
// and the prefix would silently cover any future route added underneath it.
const READ_EXCLUSIONS = /\/(?:pause|resume|trigger)$/;

function isAllowedRestRequest(method, pathname) {
  if (method === 'GET' || method === 'HEAD') {
    if (READ_EXCLUSIONS.test(pathname)) return false;
    return restReadPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix.replace(/\/$/, '')}/`),
    );
  }
  return restWriteRules.some((rule) => rule.method === method && rule.pattern.test(pathname));
}

/**
 * Same-origin enforcement. This is the control that keeps a hostile web page
 * from driving the agent.
 *
 * It matters most for WebSockets, which are exempt from CORS entirely: no
 * preflight, no same-origin rule, so any page anywhere may attempt an upgrade
 * to this host. Without this check the proxy would attach its session token to
 * that upgrade and hand the caller the full JSON-RPC surface -- including
 * shell.exec. It matters for HTTP too, because a cross-origin POST with a
 * simple content type is not preflighted and so reaches us unannounced.
 *
 * A browser sets Origin itself and a page cannot forge or suppress it, so
 * "Origin's host equals the Host we were asked for" is exactly same-origin.
 *
 * A *missing* Origin means the caller is not a browser -- curl, a native
 * client, the test suite. Those are allowed, because the tailnet is already
 * the authorization boundary for them and no web page can reach this state.
 * "null" is not missing: it is what a sandboxed iframe or a file:// page
 * sends, and it is refused.
 */
function isSameOrigin(request, url) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (!origin || origin === 'null') return false;
  if (extraOrigins.has(origin.replace(/\/$/, ''))) return true;

  let originHost;
  try {
    ({ host: originHost } = new URL(origin));
  } catch {
    return false;
  }
  // url.host already carries the Host header we were reached by.
  return originHost === url.host;
}

function refuseRequest(response, status, message) {
  securityHeaders(response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message }));
}

function refuseCrossOrigin(response, pathname) {
  console.warn(`Refused cross-origin request to ${pathname}`);
  securityHeaders(response);
  response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Cross-origin requests are not accepted.' }));
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const proxy = httpProxy.createProxyServer({
  target: hermesOrigin,
  ws: true,
  // Hermes is deliberately loopback-only. Rewrite the upstream Host header so
  // its host-header and loopback-auth checks see the local origin, never the
  // public Tailnet name supplied by the mobile browser.
  changeOrigin: true,
  xfwd: true,
});

// http-proxy reuses this handler for both proxy.web() and proxy.ws(). On a
// WebSocket failure the third argument is a net.Socket, which has no
// writeHead/headersSent -- calling them there throws and takes the process
// down, which is exactly what happens when a phone's reconnect loop hits a
// restarting backend. Branch on the shape rather than assuming a response.
proxy.on('error', (error, request, target) => {
  console.error('Hermes proxy error:', error.message);
  if (!target) return;
  if (typeof target.writeHead === 'function') {
    if (!target.headersSent) {
      target.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      target.end(
        JSON.stringify({
          error: 'Hermes backend is unavailable. Check hermes-mobile-backend.service.',
        }),
      );
    }
    return;
  }
  target.destroy();
});

// Hermes authenticates REST calls with a header, the same shared loopback
// credential the WebSocket upgrade uses. Add it on the internal hop only, so
// the browser never receives it -- mirroring what proxyReqWs already does.
proxy.on('proxyReq', (proxyRequest) => {
  // Unconditionally, so that a client-supplied copy cannot survive when no
  // token is configured for us to overwrite it with.
  proxyRequest.removeHeader('x-hermes-session-token');
  if (hermesSessionToken) {
    proxyRequest.setHeader('X-Hermes-Session-Token', hermesSessionToken);
  }
  // The identity has done its work at this boundary; Hermes has no use for it
  // and should not learn to trust a header this proxy merely relayed.
  proxyRequest.removeHeader('tailscale-user-login');
  proxyRequest.removeHeader('x-forwarded-for');
  proxyRequest.removeHeader('x-forwarded-host');
  proxyRequest.removeHeader('x-forwarded-proto');
});

// Rewriting Origin to the loopback value satisfies Hermes's own DNS-rebinding
// guard, but it also destroys the evidence that guard relies on -- so the
// browser's real Origin MUST have been checked before we get here. See
// isSameOrigin() and the upgrade handler; this rewrite is safe only because
// of them.
proxy.on('proxyReqWs', (proxyRequest) => {
  proxyRequest.setHeader('origin', hermesOrigin);
  proxyRequest.removeHeader('x-hermes-session-token');
  proxyRequest.removeHeader('tailscale-user-login');
  proxyRequest.removeHeader('x-forwarded-for');
  proxyRequest.removeHeader('x-forwarded-host');
  proxyRequest.removeHeader('x-forwarded-proto');
});

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    // connect-src 'self' covers same-origin ws:/wss: under CSP3. The previous
    // value allowed https: and wss: to *any* host, which would have handed a
    // future XSS an unrestricted exfiltration channel.
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  );
}

function publicPath(urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = normalize(join(publicDir, requested));
  return resolved.startsWith(`${publicDir}/`) ? resolved : null;
}

// A malformed percent-escape (e.g. GET /%) makes decodeURIComponent throw a
// URIError. Unhandled, that ends the process -- an unauthenticated remote kill
// switch for anyone who can reach the port.
function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

// Request URLs arrive unvalidated; a garbage target or Host header makes the
// URL constructor throw inside an event handler, which is fatal.
function parseRequestUrl(request) {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    return null;
  }
}

const notifications = createNotifications({ hermesOrigin, sessionToken: hermesSessionToken });

const server = http.createServer((request, response) => {
  const url = parseRequestUrl(request);
  if (!url) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  // One gate for everything that is not a static asset. Push endpoints are
  // unauthenticated by design, so without this any tailnet peer -- or any web
  // page open on a tailnet device -- could redirect this host's alerts.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/push/')) {
    // Only origin-form targets. `GET //evil.example.com/api/status` and the
    // absolute form both make url.host a value the caller chose instead of the
    // Host header -- which is the value same-origin is about to be compared
    // against. No browser emits either; a raw socket does.
    const target = String(request.url ?? '');
    if (!target.startsWith('/') || target.startsWith('//')) {
      refuseRequest(response, 400, 'Bad request.');
      return;
    }
    // Before same-origin, because same-origin only establishes that Origin and
    // Host agree, and rebinding makes them agree on a name the attacker owns.
    if (!isAllowedHost(url.host)) {
      console.warn(`Refused ${url.pathname} for host ${url.host}`);
      refuseRequest(response, 421, 'This host is not served here.');
      return;
    }
    if (ENCODED_SEPARATOR.test(url.pathname)) {
      console.warn(`Refused ${url.pathname}: encoded path separator`);
      refuseRequest(response, 400, 'Bad request.');
      return;
    }
    if (!isSameOrigin(request, url)) {
      refuseCrossOrigin(response, url.pathname);
      return;
    }
    // Identity comes after same-origin so a hostile page is refused as such,
    // and before anything is proxied or handled locally. Static assets are
    // deliberately outside this gate: the shell has to be able to load in
    // order to explain an authorization problem, and it carries no agent data.
    const verdict = identify(request);
    if (!verdict.ok) {
      refuseIdentity(response, url.pathname, verdict);
      return;
    }
  }
  // Push endpoints are served by this proxy itself, not forwarded to Hermes.
  if (url.pathname.startsWith('/push/')) {
    securityHeaders(response);
    notifications.handleRequest(request, response, url).catch((error) => {
      console.error('Push request failed:', error.message);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Push request failed.' }));
      }
    });
    return;
  }
  if (url.pathname === '/healthz') {
    securityHeaders(response);
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    // Deliberately says nothing about the upstream: a liveness probe has no
    // reason to describe the internal topology to whoever asks.
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === websocketPath || !isAllowedRestRequest(request.method, url.pathname)) {
      securityHeaders(response);
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Not exposed by hermes-mobile.' }));
      return;
    }
    const write = request.method !== 'GET' && request.method !== 'HEAD';
    if (write) {
      const login = identify(request).login ?? 'unknown';
      const entry = { login, method: request.method, path: url.pathname };
      if (!withinWriteBudget(login)) {
        audit('rate-limited', entry);
        securityHeaders(response);
        response.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '60',
        });
        response.end(JSON.stringify({ error: 'Too many actions in a row. Try again shortly.' }));
        return;
      }
      audit('write', entry);
    }
    securityHeaders(response);
    // Send the string that was authorized above, not the one that arrived.
    // http-proxy already derives the same value, so this is belt-and-braces --
    // but it makes "authorized path == forwarded path" a property of this file
    // rather than of a dependency's internals, which is where it belongs.
    request.url = `${url.pathname}${url.search}`;
    proxy.web(request, response);
    return;
  }

  const decoded = decodePath(url.pathname);
  if (decoded === null) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  const filePath = publicPath(decoded);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  securityHeaders(response);
  response.setHeader('Content-Type', mimeTypes[extname(filePath)] ?? 'application/octet-stream');
  response.setHeader(
    'Cache-Control',
    filePath.endsWith('service-worker.js') ? 'no-cache' : 'public, max-age=3600',
  );
  // existsSync/statSync above is a check, not a hold: the file can vanish or
  // turn unreadable before open(). An unhandled 'error' on the stream is fatal,
  // and this handler is reachable without any credential.
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error(`Failed to read ${filePath}: ${error.message}`);
    if (!response.headersSent) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end();
  });
  stream.pipe(response);
});

server.on('upgrade', (request, socket, head) => {
  const url = parseRequestUrl(request);
  // Same reasoning as the request gate: same-origin only proves Origin and Host
  // agree, and rebinding arranges that. Vouch for the Host first.
  if (!url || !isAllowedHost(url.host)) {
    console.warn(`Refused WebSocket upgrade for host ${url?.host}`);
    socket.destroy();
    return;
  }
  // WebSockets are not subject to CORS, so this is the only thing standing
  // between a hostile page and an authenticated JSON-RPC session. It has to
  // come before the token is attached, not after.
  if (!isSameOrigin(request, url)) {
    console.warn(`Refused cross-origin WebSocket upgrade from ${request.headers.origin}`);
    socket.destroy();
    return;
  }
  // The socket is the surface that matters: its JSON-RPC method set includes
  // shell.exec, so an unidentified upgrade is remote code execution for anyone
  // who can reach the port.
  const who = identify(request);
  if (!who.ok) {
    console.warn(`Refused WebSocket upgrade for ${who.login ?? '(no identity)'}: ${who.reason}`);
    socket.destroy();
    return;
  }
  // Exactly the JSON-RPC path. This used to admit any /api/* target, which
  // meant every upgrade-shaped request reached Hermes with the session token
  // appended -- including the routes the REST allowlist withholds on purpose,
  // and including /api/pty, which is a second shell surface this app never uses
  // and never intended to expose.
  if (url.pathname !== websocketPath || !hermesSessionToken) {
    if (!hermesSessionToken) {
      console.error('Refusing WebSocket upgrade: HERMES_DASHBOARD_SESSION_TOKEN is not set.');
    }
    socket.destroy();
    return;
  }
  url.searchParams.set('token', hermesSessionToken);
  request.url = `${url.pathname}${url.search}`;
  proxy.ws(request, socket, head);
});

/**
 * This proxy holds a credential that grants full control of the agent, and it
 * has no login of its own -- reachability *is* authorization. That is a
 * defensible trade behind `tailscale serve`, where the tailnet does the
 * authenticating, and indefensible anywhere else.
 *
 * So binding to anything but loopback is refused rather than warned about. The
 * failure mode being prevented is someone deploying this with HOST=0.0.0.0, or
 * behind `tailscale funnel`, and publishing remote code execution to the
 * internet without realising it.
 */
/**
 * Starting with no allowlist and no local override would mean starting wide
 * open to every peer on the tailnet, which is the exact failure the identity
 * gate exists to prevent. Refuse, the same way a non-loopback bind is refused.
 */
if (!Number.isFinite(WRITE_LIMIT) || WRITE_LIMIT < 0) {
  console.error(
    [
      `Refusing to start: HERMES_MOBILE_WRITE_LIMIT=${configuredWriteLimit} is not a`,
      'whole number of writes per minute.',
      '',
      'It bounds how often this app can make the agent run. A value that does not',
      'parse used to become NaN and silently mean "one write, ever" -- which looks',
      'like the app is broken rather than like a typo. Use 0 to refuse writes',
      'entirely, or leave it unset for the default of 30.',
    ].join('\n'),
  );
  process.exit(1);
}

if (!allowedLogins.size && !allowLocal) {
  console.error(
    [
      'Refusing to start: no tailnet identity is authorized.',
      '',
      'Anyone who can reach this port can drive the agent, which includes',
      'running shell commands through it. Name the tailnet logins allowed to',
      'do that:',
      '',
      '  HERMES_MOBILE_ALLOWED_LOGINS=you@example.com',
      '',
      'That is the login `tailscale status` shows for your own node. Verify',
      'what this proxy actually receives by starting it once with',
      'HERMES_MOBILE_IDENTITY_DEBUG=1 and reading the refusal body.',
      '',
      'For a host-local session with no tailnet in front of it (tests, curl',
      'from this machine), set HERMES_MOBILE_ALLOW_LOCAL=1 instead.',
    ].join('\n'),
  );
  process.exit(1);
}

if (!LOOPBACK.has(host) && process.env.HERMES_MOBILE_ALLOW_PUBLIC_BIND !== '1') {
  console.error(
    [
      `Refusing to bind ${host}: hermes-mobile has no authentication of its own.`,
      '',
      'Anyone who can reach this port can control the agent, which includes',
      'running shell commands through it. Bind 127.0.0.1 and publish it with',
      '`tailscale serve` (never `tailscale funnel`) so the tailnet authenticates.',
      '',
      'If you have put real authentication in front of it and understand the',
      'consequences, set HERMES_MOBILE_ALLOW_PUBLIC_BIND=1.',
    ].join('\n'),
  );
  process.exit(1);
}

// Report the address actually bound, not the requested one, so PORT=0 works
// (the tests rely on this to run the real server on an ephemeral port).
server.listen(port, host, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Hermes mobile PWA listening on http://${host}:${boundPort}`);
  console.log(`Proxying /api/* to ${hermesOrigin}`);
  if (notifications.enabled) {
    notifications.start();
    console.log('Watching scheduled jobs for failures (push enabled)');
  } else {
    console.log('Push notifications are off: set HERMES_MOBILE_VAPID_PUBLIC_KEY/PRIVATE_KEY');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    notifications.stop();
    server.close(() => process.exit(0));
  });
}
