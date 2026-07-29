import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);

const frontendFiles = ['app.js', 'service-worker.js'].concat(
  ...['lib', 'views'].map((dir) =>
    readdirSync(new URL(`${dir}/`, publicDir)).map((name) => `${dir}/${name}`),
  ),
);

const read = (name) => readFileSync(new URL(name, publicDir), 'utf8');

test('PWA manifest is standalone and has an icon', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons?.length);
});

test('frontend only opens Hermes through the same-origin API WebSocket', () => {
  assert.match(read('lib/rpc.js'), /\/api\/ws/);
  // No module may reach past the proxy to the loopback backend, which would
  // both leak the topology and fail from a phone.
  for (const name of frontendFiles) {
    assert.doesNotMatch(read(name), /127\.0\.0\.1|localhost:9119/, `${name} must stay same-origin`);
  }
});

// The session credential lives only in the proxy process. If it ever appears in
// a shipped file it has been served to every device on the tailnet.
test('no frontend file carries the Hermes session token', () => {
  for (const name of frontendFiles) {
    assert.doesNotMatch(read(name), /HERMES_DASHBOARD_SESSION_TOKEN|X-Hermes-Session-Token/i, name);
  }
});

// The old worker was cache-first and never bumped its cache name, so installed
// home-screen apps were pinned to whatever shipped on their first visit.
test('the service worker precaches every shipped module', () => {
  const worker = read('service-worker.js');
  for (const name of frontendFiles) {
    if (name === 'service-worker.js') continue;
    assert.match(worker, new RegExp(`'/${name.replace('.', '\\.')}'`), `${name} is not precached`);
  }
});
