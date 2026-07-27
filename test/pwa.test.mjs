import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('PWA manifest is standalone and has an icon', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons?.length);
});

test('frontend only opens Hermes through same-origin API WebSocket', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/ws/);
  assert.doesNotMatch(app, /localhost:9119/);
});
