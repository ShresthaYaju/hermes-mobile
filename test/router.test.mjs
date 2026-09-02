// currentPath() never decodes the hash, and every caller that builds a chat
// or session link (chat.js, threads.js, job.js...) already encodeURIComponent
// the id once for the hash. Left undecoded, the id a view hands to api.js
// gets encoded a *second* time there, so `#/chat/a%20b` requested
// `/api/sessions/a%2520b` instead of `/api/sessions/a%20b`. The fix decodes
// once, in the router, so params reach views as plain text and callers keep
// encoding exactly once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRoute, match } from '../public/lib/router.js';

defineRoute(/^\/chat\/(?<id>.+)$/, () => ({}));
defineRoute('/now', () => ({}));

test('a route param is decoded exactly once', () => {
  const found = match('/chat/a%20b');
  assert.equal(found.params.id, 'a b');
});

test('a param with encoded path-like characters round-trips to its raw form', () => {
  // Mirrors threads.test.mjs's `threadHref` expectation of 'a/b?c' ->
  // '#/chat/a%2Fb%3Fc' -- the router is the other half of that round trip.
  const found = match('/chat/a%2Fb%3Fc');
  assert.equal(found.params.id, 'a/b?c');
});

test('a malformed percent-escape is passed through rather than losing the route', () => {
  const found = match('/chat/100%');
  assert.equal(found.params.id, '100%');
});

test('a string route carries no params to decode', () => {
  const found = match('/now');
  assert.deepEqual(found.params, {});
});

test('no match yields null, decoding or not', () => {
  assert.equal(match('/nope'), null);
});
