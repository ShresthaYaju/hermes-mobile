import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import httpProxy from 'http-proxy';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4174);
const hermesOrigin = process.env.HERMES_ORIGIN ?? 'http://127.0.0.1:9119';
// This value is generated outside the repo and shared only with the loopback
// Hermes service. The browser never receives it: this proxy adds it only to
// the upstream WebSocket handshake.
const hermesSessionToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';
const publicDir = join(process.cwd(), 'public');

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

proxy.on('error', (error, request, response) => {
  console.error('Hermes proxy error:', error.message);
  if (response && !response.headersSent) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        error: 'Hermes backend is unavailable. Check hermes-mobile-backend.service.',
      }),
    );
  }
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

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/healthz') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ ok: true, hermesOrigin }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    proxy.web(request, response);
    return;
  }

  const filePath = publicPath(decodeURIComponent(url.pathname));
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
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/') || !hermesSessionToken) {
    socket.destroy();
    return;
  }
  url.searchParams.set('token', hermesSessionToken);
  request.url = `${url.pathname}${url.search}`;
  proxy.ws(request, socket, head);
});

server.listen(port, host, () => {
  console.log(`Hermes mobile PWA listening on http://${host}:${port}`);
  console.log(`Proxying /api/* to ${hermesOrigin}`);
});
