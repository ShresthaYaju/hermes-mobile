// Rate limiting and the audit trail for actions that reach the agent.
//
// POST /api/cron/jobs/{id}/trigger runs the agent. Nothing bounded how often
// that could happen, and nothing recorded that it had happened at all -- only
// refusals were logged, so the interesting half was invisible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startFakeHermes, rawRequest } from './helpers.mjs';

const OWNER = 'yaju@example.com';
const identified = (login) => ({ 'Tailscale-User-Login': login });

async function proxyFor(t, env = {}) {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({
    hermesOrigin: hermes.origin,
    env: { HERMES_MOBILE_ALLOWED_LOGINS: OWNER, HERMES_MOBILE_ALLOW_LOCAL: '', ...env },
  });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });
  return { hermes, proxy };
}

const trigger = (proxy) =>
  rawRequest(proxy.port, 'POST', '/api/cron/jobs/abc/trigger', identified(OWNER));

test('repeated writes are cut off once the per-minute budget is spent', async (t) => {
  const { hermes, proxy } = await proxyFor(t, { HERMES_MOBILE_WRITE_LIMIT: '3' });

  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await trigger(proxy)).status);

  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(hermes.requests.length, 3, 'a rate-limited write must not reach Hermes');
});

test('a rate-limited response tells the client when to come back', async (t) => {
  const { proxy } = await proxyFor(t, { HERMES_MOBILE_WRITE_LIMIT: '1' });

  await trigger(proxy);
  const limited = await trigger(proxy);

  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
});

test('reads are never rate limited', async (t) => {
  const { proxy } = await proxyFor(t, { HERMES_MOBILE_WRITE_LIMIT: '1' });

  // Polling is how every view stays current; throttling it would break the app
  // rather than protect anything -- a read cannot run the agent.
  for (let i = 0; i < 6; i += 1) {
    const response = await rawRequest(proxy.port, 'GET', '/api/status', identified(OWNER));
    assert.equal(response.status, 200);
  }
});

test('the budget is per identity, so one device cannot starve another', async (t) => {
  const other = 'housemate@example.com';
  const { proxy } = await proxyFor(t, {
    HERMES_MOBILE_ALLOWED_LOGINS: `${OWNER}, ${other}`,
    HERMES_MOBILE_WRITE_LIMIT: '1',
  });

  await rawRequest(proxy.port, 'POST', '/api/cron/jobs/abc/trigger', identified(OWNER));
  const spent = await rawRequest(
    proxy.port,
    'POST',
    '/api/cron/jobs/abc/trigger',
    identified(OWNER),
  );
  const fresh = await rawRequest(
    proxy.port,
    'POST',
    '/api/cron/jobs/abc/trigger',
    identified(other),
  );

  assert.equal(spent.status, 429);
  assert.equal(fresh.status, 200);
});

test('accepted writes are recorded with the identity that made them', async (t) => {
  const { proxy } = await proxyFor(t);

  await trigger(proxy);
  // Give the child a moment to flush its stdout.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const lines = proxy
    .stdout()
    .split('\n')
    .filter((line) => line.includes('"audit"'))
    .map((line) => JSON.parse(line));

  assert.equal(lines.length, 1);
  assert.equal(lines[0].audit, 'write');
  assert.equal(lines[0].login, OWNER);
  assert.equal(lines[0].method, 'POST');
  assert.equal(lines[0].path, '/api/cron/jobs/abc/trigger');
  assert.ok(Date.parse(lines[0].at), 'the entry must carry a parseable timestamp');
});

test('a rate-limited write is recorded too', async (t) => {
  const { proxy } = await proxyFor(t, { HERMES_MOBILE_WRITE_LIMIT: '1' });

  await trigger(proxy);
  await trigger(proxy);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const outcomes = proxy
    .stdout()
    .split('\n')
    .filter((line) => line.includes('"audit"'))
    .map((line) => JSON.parse(line).audit);

  assert.deepEqual(outcomes, ['write', 'rate-limited']);
});

test('reads are not audited', async (t) => {
  const { proxy } = await proxyFor(t);

  // One line per poll, every 30 seconds, from every open view would bury the
  // entries that matter under noise nobody will ever read.
  await rawRequest(proxy.port, 'GET', '/api/status', identified(OWNER));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(!proxy.stdout().includes('"audit"'));
});
