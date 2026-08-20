// The composer's promise: text you typed is never lost.
//
// A phone drops its socket every time it locks, so "the socket is down" is the
// ordinary case for this app, not the edge one. Everything below pins the paths
// that keep a message alive across that -- the outbox that holds it, the
// reattach that has to happen before it is sent, and the retry that is the last
// resort when the gateway refuses it.
//
// This suite tests the store's behaviour directly and asserts source-level
// invariants of the view, in the style of pwa.test.mjs and threads.test.mjs:
// there is no DOM here to render into.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Must exist before the first import of the store: it restores its queue at
// module load, which is exactly the behaviour under test.
const cells = new Map();
globalThis.localStorage = {
  getItem: (key) => (cells.has(key) ? cells.get(key) : null),
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: (key) => cells.delete(key),
};

// A query string gives each test its own module instance, which is how a page
// reload is simulated: fresh module state, same localStorage behind it.
let generation = 0;
const freshStore = () => import(`../public/lib/store.js?reload=${(generation += 1)}`);

const chatSource = readFileSync(new URL('../public/views/chat.js', import.meta.url), 'utf8');

/**
 * The source of a named function, by brace matching. The opening brace is found
 * past the parameter list, so a destructured parameter is not mistaken for it.
 */
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in chat.js`);
  const opener = /\)\s*(=>\s*)?\{/.exec(source.slice(start));
  assert.ok(opener, `${signature} has no body`);
  let depth = 0;
  for (let i = start + opener.index + opener[0].length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

test.beforeEach(() => cells.clear());

test('a queued message keeps its place in line', async () => {
  const store = await freshStore();
  store.queueMessage('t1', 'first');
  store.queueMessage('t1', 'second');
  store.queueMessage('t2', 'other thread');

  assert.deepEqual(
    store.outboxFor('t1').map((entry) => entry.text),
    ['first', 'second'],
    'the outbox is a queue, oldest first, and per thread',
  );
  assert.deepEqual(
    store.outboxFor('t2').map((entry) => entry.text),
    ['other thread'],
  );
});

// The view is disposed on every tab switch and the socket drops on every lock,
// so a queue that lived in either would lose exactly the text it exists for.
test('a queued message outlives the page that composed it', async () => {
  const first = await freshStore();
  first.queueMessage('t1', 'sent while asleep');

  const afterReload = await freshStore();
  assert.deepEqual(
    afterReload.outboxFor('t1').map((entry) => entry.text),
    ['sent while asleep'],
  );
});

test('a dropped socket clears approvals but never the outbox', async () => {
  const store = await freshStore();
  const { socket } = await import('../public/lib/rpc.js');

  store.queueMessage('t1', 'still mine');
  store.addApproval({ request_id: 'r1' });

  socket.dispatchEvent(new CustomEvent('state', { detail: { state: 'offline' } }));

  assert.equal(store.state.approvals.length, 0, 'request ids died with the connection');
  assert.equal(store.outboxFor('t1').length, 1, 'the text did not');
});

// A draft has no thread until its first send mints one, so its queue starts
// unbound. If it stayed unbound the message would be flushed into whatever
// thread was opened next.
test('a draft’s queue moves onto the thread it mints', async () => {
  const store = await freshStore();
  store.queueMessage(null, 'typed before the thread existed');

  assert.equal(store.outboxFor(null).length, 1);
  store.adoptQueued('20260731_101500_ab12cd');

  assert.equal(store.outboxFor(null).length, 0);
  assert.deepEqual(
    store.outboxFor('20260731_101500_ab12cd').map((entry) => entry.text),
    ['typed before the thread existed'],
  );
});

test('an entry leaves the outbox only when it is dequeued by id', async () => {
  const store = await freshStore();
  const first = store.queueMessage('t1', 'first');
  store.queueMessage('t1', 'second');

  store.dequeueMessage(first.id);
  assert.deepEqual(
    store.outboxFor('t1').map((entry) => entry.text),
    ['second'],
  );

  const afterReload = await freshStore();
  assert.equal(afterReload.outboxFor('t1').length, 1, 'the dequeue was persisted too');
});

// Storage throws outright in Safari private mode, and a quota error must not
// take the in-memory queue down with it.
test('unavailable storage costs persistence, not the queue', async () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  try {
    const store = await freshStore();
    store.queueMessage('t1', 'held in memory');
    assert.equal(store.outboxFor('t1').length, 1);
  } finally {
    globalThis.localStorage = saved;
  }
});

// ------------------------------------------------------- the view's rules --

// The flag reaps the live handle the instant the socket drops, killing any turn
// left running while the phone was pocketed. See the note at the top of chat.js.
test('sessions are still never closed on disconnect', () => {
  // The comment at the top of chat.js explains why; this pins the flag itself
  // never being passed to session.create or session.resume.
  assert.doesNotMatch(chatSource, /close_on_disconnect\s*[:=]/);
});

test('the composer holds every send it cannot complete', () => {
  const deliver = body(chatSource, 'async function deliver');
  const failure = deliver.slice(deliver.indexOf('catch'));
  assert.match(failure, /hold\(/, 'a send lost to the socket must be queued');
  assert.match(failure, /fail\(/, 'a send the gateway refused must stay retryable');
  // The composer is emptied on submit, so the DOM node holds the only copy
  // until the outbox does.
  assert.match(deliver, /append\(messages, 'user', text\)/);
});

// Submitting against a handle from the previous connection loses the whole
// turn: the gateway answers the id it was given, and that one is gone.
test('the outbox is flushed only after the view has reattached', () => {
  const flush = body(chatSource, 'async function flushOutbox');
  assert.ok(
    flush.indexOf('await attach()') < flush.indexOf("socket.call('prompt.submit'"),
    'flushOutbox must hold a live handle before it submits',
  );

  const onConnection = body(chatSource, 'const onConnection =');
  assert.doesNotMatch(
    onConnection,
    /flushOutbox/,
    'a reconnect flushes through reattach(), not around it',
  );
  assert.match(onConnection, /reattach\(\)/);

  const reattach = body(chatSource, 'async function reattach');
  assert.ok(
    reattach.indexOf('await attach()') < reattach.indexOf('flushOutbox'),
    'reattach must attach before it flushes',
  );
});

test('nothing leaves the outbox until the gateway has taken it', () => {
  const flush = body(chatSource, 'async function flushOutbox');
  assert.ok(
    flush.indexOf("await socket.call('prompt.submit'") < flush.indexOf('dequeueMessage('),
    'a message is dequeued only after the submit it belongs to resolved',
  );
  assert.match(flush, /catch/, 'a refused flush must not throw the rest of the queue away');
});

test('the view queues into the store, not into itself', () => {
  assert.match(chatSource, /import \{[^}]*queueMessage[^}]*\} from '\.\.\/lib\/store\.js'/s);
  // Queued text is painted back from the store on load, so a reload shows it.
  assert.match(body(chatSource, 'function paintQueued'), /outboxFor\(/);
});

test('copy takes the text the message was made from, not its rendering', () => {
  assert.match(body(chatSource, 'async function copy'), /copyText\(node\.dataset\.text/);
  // renderMarkdown is one-way; reading it back would hand over escaped HTML.
  assert.doesNotMatch(chatSource, /=\s*\w+\.innerHTML/);
  assert.match(body(chatSource, 'function retry'), /node\.dataset\.text/);
});

test('jump-to-latest tracks the scroll rather than fighting it', () => {
  assert.match(body(chatSource, 'const syncJump'), /atBottom\(\)/);
  // Content arriving on its own must not yank a transcript the reader scrolled
  // up in; only the reader's own actions scroll it.
  assert.match(body(chatSource, 'const follow'), /atBottom\(\)/);
  assert.match(body(chatSource, 'const onEvent'), /follow\(\)/);
});
