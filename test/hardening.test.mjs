// Proxy-boundary hardening.
//
// Same-origin, the identity gate and the REST allowlist all decide using values
// the request itself carries: the Host header, the Origin header, and a parsed
// pathname. Each of those was trusted a little further than it had earned.
//
// DNS rebinding controls Host and Origin together, so "they agree" proved
// nothing; the upgrade handler admitted any /api/* target and appended the
// session token to it, which put /api/pty -- a shell -- one handshake away; and
// the allowlist matched the normalized pathname while http-proxy forwarded the
// raw target, so an encoded separator was authorized as one path and sent as
// another. These pin the fixes, and the counterweight: that the legitimate
// paths still work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startFakeHermes, rawGet, rawRequest, rawUpgrade } from './helpers.mjs';

const OWNER = 'yaju@example.com';
const EVIL_HOST = 'evil.example.com';
const rebound = { Host: EVIL_HOST, Origin: `http://${EVIL_HOST}` };

async function proxyFor(t, options = {}) {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, ...options });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });
  return { hermes, proxy };
}

test('a rebound name that agrees with its own Origin is still refused', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // This is the whole rebinding payload: the attacker owns the name, so he
  // controls both halves of the same-origin comparison and they match by
  // construction. It used to answer 200 and forward.
  const response = await rawGet(proxy.port, '/api/status', rebound);

  assert.equal(response.status, 421);
  assert.equal(hermes.requests.length, 0, 'a rebound host must not reach Hermes');
});

test('a rebound name cannot open the JSON-RPC socket', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { token: 'secret-token' });

  // The socket's method surface includes shell.exec, and the proxy attaches its
  // loopback credential on the way through, so admitting this was handing out
  // remote code execution to any name pointed at 127.0.0.1.
  const result = await rawUpgrade(proxy.port, '/api/ws', rebound);

  assert.notEqual(result.outcome, 'upgraded');
  assert.equal(hermes.upgrades.length, 0, 'no rebound upgrade may reach the gateway');
  assert.deepEqual(
    hermes.upgrades.filter((upgrade) => upgrade.url.includes('token=')),
    [],
    'and none may arrive carrying the session token',
  );
});

test('the hosts a correct deployment presents are answered for', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // Loopback for local use, and the MagicDNS name or CGNAT address that
  // `tailscale serve` puts in front. None of these is a name an attacker can
  // point somewhere else, which is the property the allowlist is selecting for.
  const hosts = [
    `127.0.0.1:${proxy.port}`,
    `localhost:${proxy.port}`,
    'hermes.tail1234.ts.net',
    '100.101.102.103',
  ];
  for (const host of hosts) {
    const response = await rawGet(proxy.port, '/api/status', { Host: host });
    assert.equal(response.status, 200, `${host} must be served`);
  }
  assert.equal(hermes.requests.length, hosts.length, 'every allowed host must reach Hermes');
});

test('a name that merely contains ts.net is not a tailnet name', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // Tailscale controls the .ts.net zone; nobody controls a substring of it.
  for (const host of ['notts.net', 'notts.net.example.com', 'ts.net.evil.com']) {
    const response = await rawGet(proxy.port, '/api/status', { Host: host });
    assert.equal(response.status, 421, `${host} must not pass as a MagicDNS name`);
  }
  assert.equal(hermes.requests.length, 0);
});

test('an operator may name an extra Host without admitting every other one', async (t) => {
  const { hermes, proxy } = await proxyFor(t, {
    env: { HERMES_MOBILE_ALLOWED_HOSTS: 'app.internal.example' },
  });

  const named = await rawGet(proxy.port, '/api/status', { Host: 'app.internal.example' });
  assert.equal(named.status, 200);

  const other = await rawGet(proxy.port, '/api/status', { Host: 'other.internal.example' });
  assert.equal(other.status, 421, 'configuring one host must not relax the rule');

  assert.equal(hermes.requests.length, 1);
});

test('an IPv6 loopback Host is recognised through its brackets', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // An IPv6 authority is bracketed, so stripping the port alone leaves "[::1"
  // and the loopback set never matches -- which would refuse a host talking to
  // itself.
  const response = await rawGet(proxy.port, '/api/status', { Host: `[::1]:${proxy.port}` });

  assert.equal(response.status, 200);
  assert.equal(hermes.requests.length, 1);
});

test('only the JSON-RPC path may be upgraded', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { token: 'secret-token' });

  // These are the routes the REST allowlist withholds on purpose -- secrets,
  // the filesystem, gateway lifecycle -- plus /api/pty, a second shell surface
  // this app never uses. Every one of them reached Hermes authenticated as
  // long as the request was upgrade-shaped.
  for (const path of ['/api/pty', '/api/env/reveal', '/api/files', '/api/ops', '/api/console']) {
    const result = await rawUpgrade(proxy.port, path);
    assert.notEqual(result.outcome, 'upgraded', `${path} must not upgrade`);
  }
  assert.equal(hermes.upgrades.length, 0, 'no other target may reach the gateway');
});

test('the JSON-RPC upgrade still arrives with the session token', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { token: 'secret-token' });

  await rawUpgrade(proxy.port, '/api/ws');

  assert.equal(hermes.upgrades.length, 1, 'the real socket must still work');
  assert.match(hermes.upgrades[0].url, /token=secret-token/);
});

test('an encoded path separator is refused rather than forwarded raw', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // The URL parser collapses `..` but does not decode `%2e` or `%2f`, so each
  // of these passed the prefix test as a path under /api/status and then went
  // upstream intact. Whether the backend collapses it is the backend's
  // business, and not a property this proxy gets to depend on.
  const paths = [
    '/api/status/..%2fenv%2freveal',
    '/api/status/%2e%2e%2fenv%2freveal',
    '/api/status/..%5c..%5capi/env/reveal',
    '/api/status/%252e%252e/api/env/reveal',
  ];
  for (const path of paths) {
    const response = await rawGet(proxy.port, path);
    assert.equal(response.status, 400, `${path} must be refused`);
  }
  assert.equal(hermes.requests.length, 0, 'nothing may be forwarded');
});

test('an encoded character that is not a separator is left alone', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // The rule is about separators, not about percent-encoding, which is ordinary
  // in a path segment.
  const response = await rawGet(proxy.port, '/api/sessions/my%20session');

  assert.equal(response.status, 200);
  assert.equal(hermes.requests[0].url, '/api/sessions/my%20session');
});

test('a target that is not origin-form is refused', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // `//evil.example.com/api/status` is a protocol-relative URL, so the host the
  // rest of the gate reasons about comes from the target rather than from the
  // Host header. No browser emits this; a raw socket does.
  const response = await rawGet(proxy.port, '//evil.example.com/api/status');

  assert.equal(response.status, 400);
  assert.equal(hermes.requests.length, 0);
});

test('the cron actions are not reachable as reads', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  // /api/cron/jobs is a read prefix, so these action endpoints sat underneath
  // it: a GET reached Hermes unlimited and unaudited, and the prefix would have
  // silently covered anything added under it later.
  for (const action of ['trigger', 'pause', 'resume']) {
    for (const method of ['GET', 'HEAD']) {
      const path = `/api/cron/jobs/abc/${action}`;
      const response = await rawRequest(proxy.port, method, path);
      assert.equal(response.status, 404, `${method} ${path} must not read as a read`);
    }
  }
  assert.equal(hermes.requests.length, 0);
});

test('the cron actions are still reachable as writes', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const response = await rawRequest(proxy.port, 'POST', '/api/cron/jobs/abc/trigger');

  assert.equal(response.status, 200, 'the real action must not have been excluded too');
  assert.equal(hermes.requests.length, 1);
});

test('the tailnet identity is not relayed onto the internal hop', async (t) => {
  const { hermes, proxy } = await proxyFor(t, {
    token: 'secret-token',
    env: { HERMES_MOBILE_ALLOWED_LOGINS: OWNER },
  });

  // The identity has done its work at this boundary. Passing it on would teach
  // Hermes to trust a header that, one hop further in, is just something the
  // proxy relayed.
  const response = await rawGet(proxy.port, '/api/status', {
    'Tailscale-User-Login': OWNER,
    'X-Hermes-Session-Token': 'forged',
  });

  assert.equal(response.status, 200);
  const { headers } = hermes.requests[0];
  assert.equal(headers['tailscale-user-login'], undefined);
  assert.equal(headers['x-hermes-session-token'], 'secret-token', 'ours, never the client’s');
});

test('a client-supplied session token does not survive when none is configured', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { token: '' });

  // With no token to overwrite it with, a copy the client sent would otherwise
  // be forwarded verbatim -- letting the caller supply the credential this hop
  // is supposed to be the only source of.
  const response = await rawGet(proxy.port, '/api/status', {
    'X-Hermes-Session-Token': 'forged',
  });

  assert.equal(response.status, 200);
  assert.equal(hermes.requests[0].headers['x-hermes-session-token'], undefined);
});

test('a write limit that does not parse refuses to start', async () => {
  // NaN compares false against everything, so an unparseable value used to mean
  // "one write, ever" -- which reads as a broken app rather than as the
  // misconfiguration it is. Fail closed and loudly instead.
  let started = null;
  try {
    started = await startProxy({ env: { HERMES_MOBILE_WRITE_LIMIT: 'banana' } });
  } catch (error) {
    assert.match(error.message, /exited early/);
    assert.match(error.message, /HERMES_MOBILE_WRITE_LIMIT=banana/);
    return;
  }
  // Do not leak the child: the runner will not exit while it is alive.
  await started.stop();
  assert.fail('the server started with an unparseable write limit');
});

test('a write limit of zero refuses writes rather than permitting every one', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { env: { HERMES_MOBILE_WRITE_LIMIT: '0' } });

  // It used to mean unlimited, which is the opposite of what anyone typing it
  // while hardening a deployment would expect.
  const response = await rawRequest(proxy.port, 'POST', '/api/cron/jobs/abc/trigger');

  assert.equal(response.status, 429);
  assert.equal(hermes.requests.length, 0);
});
