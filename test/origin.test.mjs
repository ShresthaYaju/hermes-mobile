// Same-origin enforcement.
//
// These are regression tests for a live vulnerability: before the origin
// check, a WebSocket upgrade carrying `Origin: https://evil.example` was
// accepted with HTTP 101 and handed an authenticated JSON-RPC session, whose
// method surface includes shell.exec. WebSockets are exempt from CORS, so no
// browser control stood in the way -- the proxy had to refuse it itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startFakeHermes, rawRequest, rawUpgrade, waitFor } from './helpers.mjs';

const EVIL = 'https://evil.example';

test('a cross-origin WebSocket upgrade is refused and never reaches Hermes', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, token: 'secret-token' });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  for (const origin of [EVIL, 'null', 'http://127.0.0.1:1234', '']) {
    const result = await rawUpgrade(proxy.port, '/api/ws', { Origin: origin });
    assert.notEqual(result.outcome, 'upgraded', `Origin: ${origin || '(empty)'} must be refused`);
  }
  assert.equal(hermes.upgrades.length, 0, 'no hostile upgrade may reach the gateway');
  assert.equal(proxy.exited, false);
});

test('the app’s own origin still upgrades', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, token: 'secret-token' });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  // What a browser sends when the page is served from this proxy.
  await rawUpgrade(proxy.port, '/api/ws', { Origin: `http://127.0.0.1:${proxy.port}` });
  // The gateway answers the phone's handshake before its own upstream
  // connection to Hermes finishes, so this can lag a tick behind.
  await waitFor(() => hermes.upgrades.length === 1);
});

test('a non-browser client with no Origin header still works', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  // A page cannot suppress Origin, so absence proves the caller is not a
  // browser. curl, native clients and this suite rely on it.
  await rawUpgrade(proxy.port, '/api/ws');
  // The gateway answers the phone's handshake before its own upstream
  // connection to Hermes finishes, so this can lag a tick behind.
  await waitFor(() => hermes.upgrades.length === 1);
});

test('cross-origin writes are refused before reaching Hermes', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  // POST with a simple content type is not preflighted, so CORS never saw it.
  const writes = [
    ['POST', '/api/cron/jobs/abc/trigger'],
    ['POST', '/api/cron/jobs/abc/pause'],
    ['PUT', '/api/cron/jobs/abc'],
    ['DELETE', '/api/sessions/xyz'],
  ];
  for (const [method, path] of writes) {
    const response = await rawRequest(proxy.port, method, path, {
      Origin: EVIL,
      'Content-Type': 'text/plain',
    });
    assert.equal(response.status, 403, `${method} ${path} must be refused`);
  }
  assert.equal(hermes.requests.length, 0, 'nothing may be forwarded');
});

test('cross-origin reads are refused too', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const response = await rawRequest(proxy.port, 'GET', '/api/status', { Origin: EVIL });
  assert.equal(response.status, 403);
  assert.equal(hermes.requests.length, 0);
});

test('cross-origin push subscription is refused', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  // Otherwise any page open on a tailnet device could redirect this host's
  // alerts to an endpoint it controls.
  const response = await rawRequest(
    proxy.port,
    'POST',
    '/push/subscribe',
    { Origin: EVIL, 'Content-Type': 'text/plain' },
    { endpoint: 'https://attacker.example/x' },
  );
  assert.equal(response.status, 403);

  const config = await rawRequest(proxy.port, 'GET', '/push/config', { Origin: EVIL });
  assert.equal(config.status, 403);
});

test('static assets stay reachable cross-origin', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  // The gate covers /api and /push only; refusing the shell itself would break
  // nothing useful and confuse anyone debugging.
  const response = await rawRequest(proxy.port, 'GET', '/', { Origin: EVIL });
  assert.equal(response.status, 200);
});

test('an explicitly configured origin is honoured', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({
    hermesOrigin: hermes.origin,
    env: { HERMES_MOBILE_ALLOWED_ORIGINS: `${EVIL}, https://phone.example` },
  });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const response = await rawRequest(proxy.port, 'GET', '/api/status', { Origin: EVIL });
  assert.equal(response.status, 200, 'operator-configured origins must pass');
});

test('the proxy refuses to bind a non-loopback address without an explicit opt-in', async () => {
  // Reachability is authorization here, so a public bind would publish remote
  // code execution. It must fail closed, not warn.
  await assert.rejects(
    () => startProxy({ env: { HOST: '0.0.0.0' } }),
    /exited early|did not start/,
    'HOST=0.0.0.0 must not start',
  );
});

test('the health probe does not describe the internal topology', async (t) => {
  const proxy = await startProxy({ hermesOrigin: 'http://127.0.0.1:9119' });
  t.after(() => proxy.stop());

  const response = await rawRequest(proxy.port, 'GET', '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.doesNotMatch(response.body, /9119/);
});

test('the CSP does not permit exfiltration to arbitrary hosts', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const response = await rawRequest(proxy.port, 'GET', '/');
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /connect-src[^;]*https:/, 'https: would allow exfiltration anywhere');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});
