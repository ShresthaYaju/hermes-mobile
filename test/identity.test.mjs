// Tailnet identity enforcement.
//
// Before this, reachability was authorization: the proxy allowed any request
// with no Origin header on the reasoning that the tailnet is the boundary. That
// is true of the *network*, but a tailnet has peers -- four on this host -- and
// any of them could drive an agent with shell access using nothing but curl.
//
// `tailscale serve` identifies the calling tailnet user and injects
// Tailscale-User-Login, stripping any copy the client tried to supply. These
// tests pin that the proxy now requires it and matches it against an allowlist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startFakeHermes, rawRequest, rawUpgrade, waitFor } from './helpers.mjs';

const OWNER = 'yaju@example.com';
const STRANGER = 'someone-else@example.com';

const identified = (login) => ({ 'Tailscale-User-Login': login });

async function proxyFor(t, env = {}) {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({
    hermesOrigin: hermes.origin,
    // helpers.mjs defaults the local escape hatch on so the older suites (which
    // predate identity and send no headers) keep testing what they test. These
    // tests are about the gate itself, so they turn it back off.
    env: { HERMES_MOBILE_ALLOWED_LOGINS: OWNER, HERMES_MOBILE_ALLOW_LOCAL: '', ...env },
  });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });
  return { hermes, proxy };
}

test('an allowlisted tailnet identity reaches the API', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(OWNER));

  assert.equal(response.status, 200);
  assert.equal(hermes.requests.length, 1, 'the request must reach Hermes');
});

test('a tailnet peer who is not on the allowlist is refused', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(STRANGER));

  assert.equal(response.status, 403);
  assert.equal(hermes.requests.length, 0, 'a refused caller must never reach Hermes');
});

test('a request with no tailnet identity is refused', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // This is the exact shape that used to be allowed: curl, no Origin, no
  // credential -- from any device on the tailnet.
  const response = await rawRequest(proxy.port, 'GET', '/api/status');

  assert.equal(response.status, 403);
  assert.equal(hermes.requests.length, 0);
});

test('identity is matched case-insensitively and ignores surrounding space', async (t) => {
  const { proxy } = await proxyFor(t);

  const response = await rawRequest(proxy.port, 'GET', '/api/status', {
    'Tailscale-User-Login': `  ${OWNER.toUpperCase()} `,
  });

  assert.equal(response.status, 200);
});

test('several logins may be allowlisted', async (t) => {
  const { proxy } = await proxyFor(t, {
    HERMES_MOBILE_ALLOWED_LOGINS: `${OWNER}, ${STRANGER}`,
  });

  for (const login of [OWNER, STRANGER]) {
    const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(login));
    assert.equal(response.status, 200, `${login} should be allowed`);
  }
});

test('the WebSocket upgrade requires an allowlisted identity', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // The socket is the surface that matters: its JSON-RPC method set includes
  // shell.exec, so an unidentified upgrade is remote code execution.
  for (const headers of [{}, identified(STRANGER)]) {
    const result = await rawUpgrade(proxy.port, '/api/ws', headers);
    assert.notEqual(result.outcome, 'upgraded');
  }
  assert.equal(hermes.upgrades.length, 0, 'no unidentified upgrade may reach Hermes');
});

test('an allowlisted identity may open the WebSocket', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  await rawUpgrade(proxy.port, '/api/ws', identified(OWNER));

  // The gateway answers the phone's handshake before its own upstream
  // connection to Hermes finishes, so this can lag a tick behind.
  await waitFor(() => hermes.upgrades.length === 1);
});

test('push endpoints are gated too', async (t) => {
  const { proxy } = await proxyFor(t);

  // /push/subscribe accepts a subscription that this host will then send its
  // alerts to. An unidentified caller must not be able to register one.
  const refused = await rawRequest(proxy.port, 'GET', '/push/config');
  assert.equal(refused.status, 403);

  const allowed = await rawRequest(proxy.port, 'GET', '/push/config', identified(OWNER));
  assert.equal(allowed.status, 200);
});

test('static assets stay reachable without identity so the shell can load', async (t) => {
  const { proxy } = await proxyFor(t);

  // The app shell must render in order to explain an identity problem at all.
  // It contains no agent data; everything it then calls is gated.
  const response = await rawRequest(proxy.port, 'GET', '/index.html');

  assert.equal(response.status, 200);
});

test('the local escape hatch allows host-local callers when explicitly enabled', async (t) => {
  const { proxy } = await proxyFor(t, { HERMES_MOBILE_ALLOW_LOCAL: '1' });

  const response = await rawRequest(proxy.port, 'GET', '/api/status');

  assert.equal(response.status, 200);
});

test('the local escape hatch does not admit a non-allowlisted tailnet peer', async (t) => {
  const { proxy } = await proxyFor(t, { HERMES_MOBILE_ALLOW_LOCAL: '1' });

  // Presenting an identity means the caller came through `tailscale serve`, so
  // the allowlist governs -- the loophole is only for callers with no identity
  // at all, which cannot come from the tailnet.
  const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(STRANGER));

  assert.equal(response.status, 403);
});

test('the server refuses to start with no allowlist and no local override', async () => {
  // Fail closed, and loudly, exactly as the non-loopback bind already does:
  // starting wide open is the failure this whole file exists to prevent.
  let started = null;
  try {
    started = await startProxy({
      env: { HERMES_MOBILE_ALLOWED_LOGINS: '', HERMES_MOBILE_ALLOW_LOCAL: '' },
    });
  } catch (error) {
    assert.match(error.message, /exited early/);
    return;
  }
  // Do not leak the child: the runner will not exit while it is alive.
  await started.stop();
  assert.fail('the server started with no allowlist and no local override');
});

test('a refusal does not disclose who is allowed', async (t) => {
  const { proxy } = await proxyFor(t);

  const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(STRANGER));

  assert.doesNotMatch(response.body, new RegExp(OWNER, 'i'));
});

test('destroying a conversation is not reachable from the phone', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // Parity with the cron delete, which was withheld because "a mis-tap on a
  // phone is not worth that". Archive (PATCH) remains, because it is
  // recoverable.
  const deleted = await rawRequest(
    proxy.port,
    'DELETE',
    '/api/sessions/20260730_101500_ab12cd',
    identified(OWNER),
  );
  assert.equal(deleted.status, 404);
  assert.equal(hermes.requests.length, 0, 'the delete must never reach Hermes');

  const archived = await rawRequest(
    proxy.port,
    'PATCH',
    '/api/sessions/20260730_101500_ab12cd',
    identified(OWNER),
    { archived: true },
  );
  assert.equal(archived.status, 200);
});
