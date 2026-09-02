// The socket that owns the connection, not just the one that answers last.
//
// #open() replaces `this.#socket` whenever it is called again -- which
// happens on every foreground event, since `connected` is false for
// anything short of OPEN, and a socket still CONNECTING answers `connected`
// with false too. Nothing before this stopped the old attempt from finishing
// its handshake after the new one had already taken over, and its `open`
// listener had no way to tell it did not belong anymore.

import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal, hand-driven stand-in: real events are dispatched only when the
// test calls the trigger* methods, so a "socket B replaces socket A while A
// is still connecting" race is something the test controls, not something it
// has to win against a timer.
class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.closeCalls = 0;
  }

  send() {}

  close() {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CustomEvent('close'));
  }

  // Test-only: fire the event without going through close()/an actual
  // handshake, so a "the guard, not the close call, is what saves us" race
  // can still be exercised even though close() above is synchronous.
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new CustomEvent('open'));
  }
}

globalThis.location = { protocol: 'https:', host: 'test.invalid' };
const created = [];
globalThis.WebSocket = class extends FakeWebSocket {
  constructor(url) {
    super(url);
    created.push(this);
  }
};

const { HermesSocket } = await import('../public/lib/rpc.js');

test.beforeEach(() => {
  created.length = 0;
});

test('a reconnect while the old socket is still connecting closes it', () => {
  const hs = new HermesSocket();
  hs.connect();
  const a = created[0];
  assert.equal(a.readyState, FakeWebSocket.CONNECTING);

  // The foreground handler in app.js calls connect() again here because
  // `connected` is false for a socket that is merely CONNECTING.
  hs.connect();
  const b = created[1];

  assert.equal(created.length, 2, 'the old attempt is not reused, a new socket is opened');
  assert.equal(a.closeCalls, 1, '#open() must close the socket it is replacing');
  assert.notEqual(a, b);
});

test('an orphaned socket opening late does not resurrect state or the backoff', () => {
  const hs = new HermesSocket();
  hs.connect();
  const a = created[0];
  hs.connect();
  const b = created[1];

  // B has not opened yet -- the connection is still down.
  assert.equal(hs.state, 'connecting');
  assert.equal(hs.connected, false);

  // A finishes its handshake late, after being replaced. Force the event
  // directly (rather than relying on close() already having fired it) so the
  // assertion pins the identity guard itself, not just close()'s side effect.
  a.triggerOpen();

  assert.equal(hs.state, 'connecting', 'a stale socket opening must not report the app live');
  assert.equal(hs.connected, false, 'the live socket (B) still has not opened');
  assert.equal(a.closeCalls, 2, 'an orphan that opens anyway is closed rather than left dangling');

  // Now the real, current socket opens -- this is the one allowed to move
  // state and reset the reconnect backoff.
  b.triggerOpen();
  assert.equal(hs.state, 'live');
  assert.equal(hs.connected, true);
});

test('a stale socket errors instead of opening: still ignored by identity, not just by being the wrong readyState', () => {
  const hs = new HermesSocket();
  hs.connect();
  const a = created[0];
  hs.connect();
  const b = created[1];
  b.triggerOpen();
  assert.equal(hs.state, 'live');

  // A closes on its own after being orphaned (e.g. the network finally
  // answers the abandoned handshake with a failure). `drop`'s existing
  // identity guard must keep this from tearing down B's live connection.
  a.dispatchEvent(new CustomEvent('close'));
  assert.equal(hs.state, 'live', 'an orphan closing must not drop the live connection');
  assert.equal(hs.connected, true);
});
