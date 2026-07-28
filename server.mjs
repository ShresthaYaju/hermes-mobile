import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import httpProxy from 'http-proxy';
import { createNotifications } from './notifications.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4174);
const hermesOrigin = process.env.HERMES_ORIGIN ?? 'http://127.0.0.1:9119';
// This value is generated outside the repo and shared only with the loopback
// Hermes service. The browser never receives it: this proxy adds it only to
// the upstream WebSocket handshake.
const hermesSessionToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';
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
];

// Writes are enumerated exactly, one method-plus-shape at a time, rather than
// allowed by prefix. Two omissions are deliberate:
//
//   DELETE /api/cron/jobs/{id}  -- also rmtree()s the job's saved run output.
//                                  A mis-tap on a phone is not worth that.
//   POST   /api/cron/jobs       -- creating a schedule needs the blueprint and
//                                  delivery-target UI to be honest about what
//                                  it will do; it is not a mobile action.
const restWriteRules = [
  { method: 'POST', pattern: /^\/api\/cron\/jobs\/[^/]+\/(pause|resume|trigger)$/ },
  { method: 'PUT', pattern: /^\/api\/cron\/jobs\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/api\/sessions\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/sessions\/[^/]+$/ },
];

// The JSON-RPC gateway is a separate, already-working path with its own
// credential handling in the upgrade handler.
const websocketPath = '/api/ws';

function isAllowedRestRequest(method, pathname) {
  if (method === 'GET' || method === 'HEAD') {
    return restReadPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix.replace(/\/$/, '')}/`),
    );
  }
  return restWriteRules.some((rule) => rule.method === method && rule.pattern.test(pathname));
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
  if (hermesSessionToken) {
    proxyRequest.setHeader('X-Hermes-Session-Token', hermesSessionToken);
  }
  proxyRequest.removeHeader('x-forwarded-for');
  proxyRequest.removeHeader('x-forwarded-host');
  proxyRequest.removeHeader('x-forwarded-proto');
});

// The upstream service is loopback-only and validates Host and Origin on every
// WebSocket upgrade. Preserve the outer Tailnet origin at the PWA boundary, but
// present the trusted local origin only on the internal hop.
proxy.on('proxyReqWs', (proxyRequest) => {
  proxyRequest.setHeader('origin', hermesOrigin);
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
    "default-src 'self'; connect-src 'self' wss: https:; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'",
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
    response.end(JSON.stringify({ ok: true, hermesOrigin }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === websocketPath || !isAllowedRestRequest(request.method, url.pathname)) {
      securityHeaders(response);
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Not exposed by hermes-mobile.' }));
      return;
    }
    securityHeaders(response);
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
  createReadStream(filePath).pipe(response);
});

server.on('upgrade', (request, socket, head) => {
  const url = parseRequestUrl(request);
  if (!url || !url.pathname.startsWith('/api/') || !hermesSessionToken) {
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
