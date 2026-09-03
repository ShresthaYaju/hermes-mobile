// The proxy now holds one upstream connection per *login*, not per phone --
// see the scope note at the top of store.js. Two devices signed in as the
// same person share that connection, so each one now receives `event` frames
// for sessions the OTHER device is driving, and a reconnecting phone gets a
// replay of any approval/clarify frames it missed while it was away.
//
// This pins the store's half of that: turn-progress events (message.start,
// tool.start, ...) must be dropped unless they belong to the session THIS
// app is attached to, or another device's activity would bleed into this
// one's "Running" card. Approvals are the opposite -- kept for any session,
// since an approval is something this person must answer no matter which
// device is driving -- and a replayed duplicate must still dedupe by
// request_id the way it always has.
//
// No DOM here, in the style of chat.test.mjs: localStorage is stubbed just
// enough for store.js's outbox restore (which runs at import time) to find
// nothing and start empty, and the rest is exercised through the store's own
// exports and the shared `socket` singleton from rpc.js.

import test from 'node:test';
import assert from 'node:assert/strict';

const cells = new Map();
globalThis.localStorage = {
  getItem: (key) => (cells.has(key) ? cells.get(key) : null),
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: (key) => cells.delete(key),
};

const store = await import('../public/lib/store.js');
const { socket } = await import('../public/lib/rpc.js');

function fireEvent(type, sessionId, payload = {}) {
  socket.dispatchEvent(
    new CustomEvent('event', { detail: { type, session_id: sessionId, payload } }),
  );
}

test.beforeEach(() => {
  store.update({ sessionId: null, running: false, activity: null, turnStartedAt: null });
  store.clearApprovals();
});

// ------------------------------------------------------- turn progress --

test('a progress event for another session is ignored', () => {
  store.update({ sessionId: 'sess-mine' });

  fireEvent('message.start', 'sess-other');

  assert.equal(store.state.running, false, 'another session starting a turn must not show here');
  assert.equal(store.state.activity, null);
});

test('a progress event for our own session is applied', () => {
  store.update({ sessionId: 'sess-mine' });

  fireEvent('message.start', 'sess-mine');
  assert.equal(store.state.running, true);
  assert.equal(store.state.activity, 'thinking');

  fireEvent('tool.start', 'sess-mine', { name: 'bash' });
  assert.equal(store.state.activity, 'bash');

  fireEvent('message.complete', 'sess-mine');
  assert.equal(store.state.running, false);
  assert.equal(store.state.activity, null);
});

// Not yet attached to anything (state.sessionId is null) means nothing is
// ours to show -- see the comment above the filter in store.js for why this
// is safe: attach() sets state.sessionId before its first prompt.submit, so
// a real event for our own turn is never dropped for "arriving too early".
test('a progress event is ignored while state.sessionId is still null', () => {
  fireEvent('message.start', 'sess-somewhere');
  assert.equal(store.state.running, false);

  // Even a frame that also carries no session_id must not slip through.
  fireEvent('tool.start', undefined, { name: 'bash' });
  assert.equal(store.state.running, false);
});

test('switching which session we are attached to stops the previous one', () => {
  store.update({ sessionId: 'sess-a' });
  fireEvent('message.start', 'sess-a');
  assert.equal(store.state.running, true);

  store.update({ sessionId: 'sess-b' });
  fireEvent('tool.start', 'sess-a', { name: 'still-going-elsewhere' });
  // Old session's own event no longer applies once we have moved on.
  assert.equal(store.state.activity, 'thinking', 'stale session must not update activity');
});

// ------------------------------------------------------------ approvals --

test('an approval for another session is still accepted', () => {
  store.update({ sessionId: 'sess-mine' });

  fireEvent('approval.request', 'sess-other', { request_id: 'req-1', command: 'ls' });

  const approval = store.state.approvals.find((a) => a.id === 'req-1');
  assert.ok(approval, 'an approval on a session we are not driving must still surface');
  assert.equal(approval.payload.session_id, 'sess-other');
});

test('a clarify request for another session is also accepted', () => {
  store.update({ sessionId: 'sess-mine' });

  fireEvent('clarify.request', 'sess-other', { request_id: 'req-2', question: 'which one?' });

  const approval = store.state.approvals.find((a) => a.id === 'req-2');
  assert.ok(approval);
  // kind lands on the payload (addApproval stores whatever it is handed
  // verbatim), not as a separate field on the approval record itself.
  assert.equal(approval.payload.kind, 'clarify');
});

// The proxy replays approval/clarify frames a reconnecting phone missed --
// same frame shape as a live one, request_id included -- so the dedupe that
// already protected against a double-send from the gateway is what has to
// carry this too.
test('a replayed duplicate approval frame dedupes by request_id', () => {
  store.update({ sessionId: 'sess-mine' });

  fireEvent('approval.request', 'sess-other', { request_id: 'req-3', command: 'rm x' });
  fireEvent('approval.request', 'sess-other', { request_id: 'req-3', command: 'rm x' });

  const matches = store.state.approvals.filter((a) => a.id === 'req-3');
  assert.equal(matches.length, 1, 'a replayed frame must not queue a second card');
});
