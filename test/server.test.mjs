import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startFakeHermes, rawGet, rawUpgrade } from './helpers.mjs';

test('serves the app shell with security headers', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const response = await rawGet(proxy.port, '/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
});

test('healthz reports the configured upstream', async (t) => {
  const proxy = await startProxy({ hermesOrigin: 'http://127.0.0.1:9119' });
  t.after(() => proxy.stop());

  const response = await rawGet(proxy.port, '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    hermesOrigin: 'http://127.0.0.1:9119',
  });
});

// Regression: GET /% threw an unhandled URIError out of decodeURIComponent and
// killed the process -- an unauthenticated remote kill switch.
test('a malformed percent-escape is rejected and does not kill the server', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  for (const path of ['/%', '/%zz', '/%E0%A4%A']) {
    const response = await rawGet(proxy.port, path);
    assert.equal(response.status, 400, `${path} should be a 400`);
  }

  assert.equal(proxy.exited, false, 'server should still be running');
  const after = await rawGet(proxy.port, '/healthz');
  assert.equal(after.status, 200, 'server should still serve requests');
});

// Regression: http-proxy reuses the error handler for ws, where the third
// argument is a Socket. Calling response.writeHead on it threw and exited the
// process -- triggered by any reconnect against a down backend.
test('a WebSocket upgrade with the backend down does not kill the server', async (t) => {
  // Port 1 is closed, so the proxy's connection attempt fails.
  const proxy = await startProxy({ hermesOrigin: 'http://127.0.0.1:1' });
  t.after(() => proxy.stop());

  for (let i = 0; i < 3; i += 1) {
    const result = await rawUpgrade(proxy.port, '/api/ws');
    assert.notEqual(result.outcome, 'upgraded');
  }

  assert.equal(proxy.exited, false, 'server should have survived the failed upgrades');
  const after = await rawGet(proxy.port, '/healthz');
  assert.equal(after.status, 200);
});

test('an HTTP request with the backend down returns 502 rather than crashing', async (t) => {
  const proxy = await startProxy({ hermesOrigin: 'http://127.0.0.1:1' });
  t.after(() => proxy.stop());

  const response = await rawGet(proxy.port, '/api/status');
  assert.equal(response.status, 502);
  assert.equal(proxy.exited, false);
});

test('path traversal cannot escape the public directory', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  for (const path of ['/../server.mjs', '/../package.json', '/%2e%2e/server.mjs']) {
    const response = await rawGet(proxy.port, path);
    assert.equal(response.status, 404, `${path} must not be served`);
    assert.doesNotMatch(response.body, /httpProxy/);
  }
  assert.equal(proxy.exited, false);
});

test('unknown paths 404 without reaching the proxy', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const response = await rawGet(proxy.port, '/nope');
  assert.equal(response.status, 404);
  assert.equal(hermes.requests.length, 0);
});

test('/api/* is forwarded upstream', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const response = await rawGet(proxy.port, '/api/status');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).upstream, true);
  assert.equal(hermes.requests.length, 1);
  assert.equal(hermes.requests[0].url, '/api/status');
});

test('the session token is injected on the upstream upgrade, never sent by the browser', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, token: 'secret-token' });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  await rawUpgrade(proxy.port, '/api/ws');
  assert.equal(hermes.upgrades.length, 1);

  const forwarded = hermes.upgrades[0];
  assert.match(forwarded.url, /token=secret-token/);
  // Origin is rewritten to the loopback origin so Hermes's DNS-rebinding guard
  // accepts the upgrade, and the tailnet-facing forwarding headers are stripped.
  assert.equal(forwarded.headers.origin, hermes.origin);
  assert.equal(forwarded.headers['x-forwarded-for'], undefined);
  assert.equal(forwarded.headers['x-forwarded-host'], undefined);
  assert.equal(forwarded.headers['x-forwarded-proto'], undefined);
});

test('non-API upgrades are refused', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const result = await rawUpgrade(proxy.port, '/ws');
  assert.notEqual(result.outcome, 'upgraded');
  assert.equal(hermes.upgrades.length, 0);
  assert.equal(proxy.exited, false);
});

test('upgrades are refused outright when no session token is configured', async (t) => {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, token: '' });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });

  const result = await rawUpgrade(proxy.port, '/api/ws');
  assert.notEqual(result.outcome, 'upgraded');
  assert.equal(hermes.upgrades.length, 0, 'must not forward an unauthenticated upgrade');
  assert.match(proxy.stderr(), /HERMES_DASHBOARD_SESSION_TOKEN/);
});

test('the service worker is served uncached so updates reach installed phones', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const worker = await rawGet(proxy.port, '/service-worker.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers['cache-control'], 'no-cache');

  const app = await rawGet(proxy.port, '/app.js');
  assert.match(app.headers['cache-control'], /max-age=3600/);
});
