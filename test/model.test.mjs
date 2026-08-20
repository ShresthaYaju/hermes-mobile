// Model switching from the phone.
//
// Config used to render the model read-only and defer switching to the desktop
// dashboard, which is disqualifying for a surface that claims to be primary.
// Reaching the picker means opening exactly two upstream routes -- the option
// catalog and the assignment write -- and nothing adjacent to them. Hermes
// serves a lot under /api/model: MoA presets, auxiliary task pins, a
// recommended-default probe. None of those belong on a phone, and a prefix
// match would have handed over all of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startProxy, startFakeHermes, rawGet, rawRequest } from './helpers.mjs';

const OWNER = 'yaju@example.com';
const identified = (login) => ({ 'Tailscale-User-Login': login });

async function proxyFor(t, env = {}) {
  const hermes = await startFakeHermes();
  const proxy = await startProxy({ hermesOrigin: hermes.origin, env });
  t.after(async () => {
    await proxy.stop();
    await hermes.stop();
  });
  return { hermes, proxy };
}

test('the model picker can read the current model and the option catalog', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const paths = [
    '/api/model/info',
    '/api/model/options',
    // The picker's explicit refresh busts the upstream model-id cache. The
    // allowlist matches on path, so the query has to survive the hop intact.
    '/api/model/options?refresh=1',
  ];
  for (const path of paths) {
    const response = await rawGet(proxy.port, path);
    assert.equal(response.status, 200, `${path} should be forwarded`);
  }
  assert.deepEqual(
    hermes.requests.map((r) => r.url),
    paths,
  );
});

// /api/model/* is a family, not a page. Only two of its members are exposed.
test('the rest of the model surface is refused and never reaches Hermes', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const blocked = [
    // Mixture-of-agents presets: a multi-slot routing config with its own
    // editor. Nothing on a phone screen can represent it honestly.
    '/api/model/moa',
    // Per-task background model pins. Changing these silently retargets work
    // the user never sees happen.
    '/api/model/auxiliary',
    '/api/model/recommended-default',
    '/api/model',
    '/api/model/infomercial',
  ];
  for (const path of blocked) {
    const response = await rawGet(proxy.port, path);
    assert.equal(response.status, 404, `${path} must be refused`);
  }
  assert.equal(hermes.requests.length, 0);
});

test('assigning a model is forwarded upstream', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const response = await rawRequest(
    proxy.port,
    'POST',
    '/api/model/set',
    {},
    {
      scope: 'main',
      provider: 'anthropic',
      model: 'anthropic/claude-opus-4.6',
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    hermes.requests.map((r) => r.url),
    ['/api/model/set'],
  );
});

test('writes shaped like the assignment but not it are refused', async (t) => {
  const { hermes, proxy } = await proxyFor(t);

  const blocked = [
    // The write rule is an exact method-plus-path match, not a prefix.
    ['PUT', '/api/model/set'],
    ['DELETE', '/api/model/set'],
    ['POST', '/api/model/set/main'],
    ['POST', '/api/model/settings'],
    ['POST', '/api/model/info'],
    // Editing the MoA preset set, and resetting every auxiliary pin.
    ['PUT', '/api/model/moa'],
    ['POST', '/api/model/auxiliary'],
    // Switching the sticky active profile. Withheld on purpose: it does not
    // retarget the running dashboard this app reads through, so the app would
    // report one profile while showing another's sessions, jobs and model.
    ['POST', '/api/profiles/active'],
    ['PUT', '/api/profiles/work/model'],
    ['PATCH', '/api/profiles/work'],
    // The model lives in config.yaml, but the whole-config write reaches every
    // other key in it too.
    ['PUT', '/api/config'],
  ];
  for (const [method, path] of blocked) {
    const response = await rawRequest(proxy.port, method, path);
    assert.equal(response.status, 404, `${method} ${path} must be refused`);
  }
  assert.equal(hermes.requests.length, 0);
});

// Model assignment is a write, so it inherits the gates every write has. These
// are not re-implemented for it; this pins that it did not opt out of them.
test('assigning a model requires an authorized identity', async (t) => {
  const { hermes, proxy } = await proxyFor(t, {
    HERMES_MOBILE_ALLOWED_LOGINS: OWNER,
    HERMES_MOBILE_ALLOW_LOCAL: '',
  });

  const anonymous = await rawRequest(proxy.port, 'POST', '/api/model/set');
  const stranger = await rawRequest(
    proxy.port,
    'POST',
    '/api/model/set',
    identified('someone@example.com'),
  );
  const owner = await rawRequest(proxy.port, 'POST', '/api/model/set', identified(OWNER));

  assert.equal(anonymous.status, 403);
  assert.equal(stranger.status, 403);
  assert.equal(owner.status, 200);
  assert.equal(hermes.requests.length, 1, 'only the authorized write should have been forwarded');
});

test('assigning a model is rate limited and audited like any other write', async (t) => {
  const { proxy } = await proxyFor(t, {
    HERMES_MOBILE_ALLOWED_LOGINS: OWNER,
    HERMES_MOBILE_ALLOW_LOCAL: '',
    HERMES_MOBILE_WRITE_LIMIT: '1',
  });

  const first = await rawRequest(proxy.port, 'POST', '/api/model/set', identified(OWNER));
  const second = await rawRequest(proxy.port, 'POST', '/api/model/set', identified(OWNER));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);

  const lines = proxy
    .stdout()
    .split('\n')
    .filter((line) => line.includes('"audit"'))
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.audit),
    ['write', 'rate-limited'],
  );
  assert.equal(lines[0].path, '/api/model/set');
  assert.equal(lines[0].login, OWNER);
});

// POST /api/model/set also accepts base_url and api_key, which persist a
// provider endpoint and its credential into config.yaml, and an "auxiliary"
// scope that repoints background tasks. The proxy cannot see a request body, so
// what keeps those off the phone is that the client never composes them.
test('the client sends only a main-slot assignment, never credentials', () => {
  const source = readFileSync(new URL('../public/lib/api.js', import.meta.url), 'utf8');
  const [assignment = ''] = source.match(/setModel[\s\S]*?\n\s*\n/) ?? [];

  assert.ok(assignment.includes('/api/model/set'), 'setModel must post the assignment route');
  assert.match(assignment, /scope: 'main'/);
  assert.doesNotMatch(assignment, /api_key|base_url|auxiliary/);
});
