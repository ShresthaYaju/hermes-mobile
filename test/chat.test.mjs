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
    // The same failure that costs persistence must be visible on the entry
    // itself -- it is what lets the view say "this tab only" instead of
    // making a durability promise that closing the tab breaks.
    assert.equal(store.outboxFor('t1')[0].durable, false);
  } finally {
    globalThis.localStorage = saved;
  }
});

test('a message that does persist is stamped durable', async () => {
  const store = await freshStore();
  const entry = store.queueMessage('t1', 'saved for real');
  assert.equal(entry.durable, true);
});

// ------------------------------------------------- outbox retry bookkeeping --
//
// prompt.submit is at-least-once: a submit that reached the wire before the
// socket dropped may already be running on the gateway. These pin the store's
// half of the fix -- chat.js's flushOutbox (tested at the source level below,
// since it has no DOM-free entry point) relies on exactly this bookkeeping to
// decide what is safe to auto-resend.

test('an entry starts eligible for the ordinary auto-flush', async () => {
  const store = await freshStore();
  const entry = store.queueMessage('t1', 'first attempt');
  assert.equal(entry.submitted, false);
  assert.equal(entry.uncertain, false);
  assert.equal(entry.failed, false);
  assert.equal(entry.attempts, 0);
});

test('a submit that reached the wire, then lost the pipe, is marked uncertain and never cleared by itself', async () => {
  const store = await freshStore();
  const entry = store.queueMessage('t1', 'maybe sent');
  store.markOutboxSubmitted(entry.id);
  store.markOutboxUncertain(entry.id);

  const found = store.outboxFor('t1')[0];
  assert.equal(found.submitted, true);
  assert.equal(found.uncertain, true, 'the ambiguous outcome must stick until a deliberate resend');
  assert.equal(
    found.failed,
    false,
    'uncertain and failed are distinct: one is doubt, the other is a refusal',
  );
});

test('three deterministic refusals fail the entry; a fourth call adds nothing new', async () => {
  const store = await freshStore();
  const entry = store.queueMessage('t1', 'refused every time');

  const first = store.markOutboxDeterministicFailure(entry.id);
  assert.equal(first.attempts, 1);
  assert.equal(first.failed, false);

  store.markOutboxDeterministicFailure(entry.id);
  const third = store.markOutboxDeterministicFailure(entry.id);
  assert.equal(third.attempts, 3);
  assert.equal(third.failed, true, 'the third deterministic refusal must trip the cap');

  const fourth = store.markOutboxDeterministicFailure(entry.id);
  assert.equal(fourth.attempts, 4, 'the counter itself keeps counting');
  assert.equal(fourth.failed, true, 'but nothing un-fails an already-failed entry');
});

test('a deliberate resend clears both an uncertain and a failed entry, with a fresh budget', async () => {
  const store = await freshStore();
  const entry = store.queueMessage('t1', 'stuck');
  store.markOutboxDeterministicFailure(entry.id);
  store.markOutboxDeterministicFailure(entry.id);
  store.markOutboxDeterministicFailure(entry.id);
  assert.equal(store.outboxFor('t1')[0].failed, true);

  const reset = store.resetOutboxIssue(entry.id);
  assert.equal(reset.failed, false);
  assert.equal(reset.uncertain, false);
  assert.equal(
    reset.attempts,
    0,
    'a deliberate resend is a fresh decision, not the fourth of the old budget',
  );
});

// markOutboxSubmitted() persists `submitted: true` *before* prompt.submit
// resolves -- it has to, or a drop mid-call would not survive a reload
// either. But that means a reload or a killed tab can catch an entry
// mid-flight, with nothing left in memory to say how the call ended. Losing
// that context must not silently turn back into "safe to auto-resend": on
// the way back in the entry has to be exactly as uncertain as a
// 'Connection closed' rejection would have left it.
test('an entry caught mid-submit by a reload comes back uncertain, not eligible for auto-flush', async () => {
  const first = await freshStore();
  const entry = first.queueMessage('t1', 'in flight when the tab died');
  first.markOutboxSubmitted(entry.id);
  // Nothing marks it uncertain or failed before the "reload" -- this is
  // exactly the state a submit still awaiting its response leaves behind.
  assert.equal(first.outboxFor('t1')[0].submitted, true);
  assert.equal(first.outboxFor('t1')[0].uncertain, false);

  const afterReload = await freshStore();
  const restored = afterReload.outboxFor('t1')[0];
  assert.ok(restored, 'the message itself must still survive the reload');
  assert.equal(
    restored.uncertain,
    true,
    'an in-flight submit must not be trusted as safe to resend',
  );
  assert.equal(restored.failed, false, 'unknown is not the same as a known refusal');
  // This is the exact condition flushOutbox()'s loop guard checks (see
  // chat.test.mjs's "nothing leaves the outbox..." test) before ever
  // attempting a submit -- restoring straight to `uncertain: true` is what
  // makes that guard actually block this entry instead of waving it through.
});

// A cap already reached is a *known* outcome (three real refusals), not an
// unknown one -- restoring it as uncertain as well would be harmless in
// practice (both block the auto-flush) but would blur two different reasons
// a bubble needs a tap, and reset a fixed fact into a fuzzy one.
test('a restored entry that had already failed stays failed, not uncertain', async () => {
  const first = await freshStore();
  const entry = first.queueMessage('t1', 'refused three times before the reload');
  first.markOutboxSubmitted(entry.id);
  first.markOutboxDeterministicFailure(entry.id);
  first.markOutboxDeterministicFailure(entry.id);
  first.markOutboxDeterministicFailure(entry.id);
  assert.equal(first.outboxFor('t1')[0].failed, true);

  const afterReload = await freshStore();
  const restored = afterReload.outboxFor('t1')[0];
  assert.equal(restored.failed, true);
  assert.equal(restored.uncertain, false);
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

// deliver() sends the prompt live (no outbox involved) the first time a
// thread has a socket to send on. It can hit the exact same at-least-once
// ambiguity flushOutbox does if the socket drops (or a response simply never
// arrives) between the submit going out and an answer coming back, so it
// needs the same guard: only a submit failure -- never an attach() one --
// may be treated as uncertain, and only when the outcome is genuinely
// unknown (outcomeUnknown()).
test('a live send tells "the submit reached the wire" apart from "attach() never got there"', () => {
  const deliver = body(chatSource, 'async function deliver');
  const attachCall = deliver.indexOf('await attach()');
  const submitCall = deliver.indexOf("socket.call('prompt.submit'");
  assert.ok(attachCall !== -1 && submitCall !== -1 && attachCall < submitCall);
  // A flag is set between the two, and only a submit failure after it is set
  // may be treated as uncertain.
  const guardSet = deliver.slice(attachCall, submitCall);
  assert.match(
    guardSet,
    /submitting\s*=\s*true/,
    'the guard must flip on only after attach() resolves',
  );
  const failure = deliver.slice(deliver.indexOf('catch'));
  assert.match(
    failure,
    /submitting\s*&&\s*outcomeUnknown\(error\)/,
    'an uncertain send must require both the guard and an unknown-outcome rejection',
  );
  assert.match(failure, /markOutboxUncertain\(/);
});

// A dropped pipe and a response that never arrived in time are both cases
// where the gateway may already have the prompt -- the predicate is what
// keeps that single piece of judgment from being duplicated (and drifting)
// between deliver() and flushOutbox().
test('outcomeUnknown is one predicate, shared by deliver() and flushOutbox()', () => {
  assert.match(
    chatSource,
    /export function outcomeUnknown\(error\)/,
    'the two call sites must share one definition, not each inline their own string checks',
  );
  const predicate = body(chatSource, 'export function outcomeUnknown');
  assert.match(predicate, /'Connection closed'/);
  assert.match(predicate, /endsWith\(' timed out'\)/);

  const deliver = body(chatSource, 'async function deliver');
  assert.match(deliver.slice(deliver.indexOf('catch')), /outcomeUnknown\(error\)/);
  const flush = body(chatSource, 'async function flushOutbox');
  assert.match(flush, /outcomeUnknown\(error\)/);
  // Neither call site may fall back to comparing error.message itself --
  // that would be the duplicated check the predicate exists to replace.
  assert.doesNotMatch(deliver, /error\.message\s*===\s*'Connection closed'/);
  assert.doesNotMatch(flush, /error\.message\s*===\s*'Connection closed'/);
});

// rpc.js's call() rejects with `${method} timed out` when no response frame
// ever arrives (CALL_TIMEOUT_MS) -- that says nothing about whether the
// gateway received and ran the prompt, so it must be treated exactly like a
// dropped connection: uncertain, never an auto-retried "deterministic"
// refusal.
test('a submit that times out is an unknown outcome, not a deterministic refusal', async () => {
  const { outcomeUnknown } = await import('../public/views/chat.js');
  assert.equal(outcomeUnknown(new Error('prompt.submit timed out')), true);
  assert.equal(outcomeUnknown(new Error('session.resume timed out')), true);
  assert.equal(outcomeUnknown(new Error('Connection closed')), true);
  // A real refusal must still count against the retry budget, not be waved
  // through as unknown.
  assert.equal(outcomeUnknown(new Error('Hermes returned an error')), false);
  assert.equal(outcomeUnknown(new Error('timed out early')), false, 'must match the exact suffix');
  assert.equal(outcomeUnknown({}), false, 'a message-less error must not crash the check');
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

// prompt.submit is at-least-once: the proxy can have forwarded it before the
// socket that carried it drops. Never losing a message is only half the
// promise -- the other half is never *resubmitting* one whose outcome is
// unknown, since that risks the agent running the same turn twice.
test('nothing leaves the outbox until the gateway has taken it, and an uncertain send is never auto-resent', () => {
  const flush = body(chatSource, 'async function flushOutbox');
  assert.ok(
    flush.indexOf("await socket.call('prompt.submit'") < flush.indexOf('dequeueMessage('),
    'a message is dequeued only after the submit it belongs to resolved',
  );
  assert.match(flush, /catch/, 'a refused flush must not throw the rest of the queue away');
  // An entry the last attempt left uncertain (or failed three times) must be
  // skipped by the loop, not retried -- see store.js's markOutboxUncertain.
  assert.match(
    flush,
    /if\s*\(\s*entry\.uncertain\s*\|\|\s*entry\.failed\s*\)\s*break/,
    'an uncertain or repeatedly-failed entry must block the auto-flush, not be resubmitted by it',
  );
  assert.match(
    flush,
    /markOutboxUncertain\(/,
    "a 'Connection closed' rejection must mark the entry, not requeue it plainly",
  );
});

// The cap exists because a deterministic refusal (a stale session, a
// malformed prompt) would otherwise retry forever on every reconnect.
test('a deterministic refusal is capped, not retried forever', () => {
  const flush = body(chatSource, 'async function flushOutbox');
  assert.match(
    flush,
    /markOutboxDeterministicFailure\(/,
    'a rejection other than Connection closed must count against the retry budget',
  );
});

// The two failure points inside one flush attempt -- attach() and the submit
// itself -- must stay in separate try/catch blocks. Collapsing them back into
// one would let an attach() failure's error message (which can itself be
// 'Connection closed', since attach() is also an RPC) be mistaken for the
// submit having reached the wire.
test('flushOutbox tells attach() failing apart from the submit itself failing', () => {
  const flush = body(chatSource, 'async function flushOutbox');
  const attachTry = flush.indexOf('sessionId = await attach()');
  const submitTry = flush.indexOf("socket.call('prompt.submit'");
  assert.ok(attachTry !== -1 && submitTry !== -1 && attachTry < submitTry);
  // A catch sits between the two awaits, so a failed attach() cannot fall
  // through into the code that marks a submit uncertain or deterministic.
  const between = flush.slice(attachTry, submitTry);
  assert.match(
    between,
    /catch/,
    'attach() must be resolved (or rejected) before the submit is attempted',
  );
});

test('the view queues into the store, not into itself', () => {
  assert.match(chatSource, /import \{[^}]*queueMessage[^}]*\} from '\.\.\/lib\/store\.js'/s);
  // Queued text is painted back from the store on load, so a reload shows it.
  assert.match(body(chatSource, 'function paintQueued'), /outboxFor\(/);
});

// A quota error (Safari private mode, a full localStorage) must not be shown
// as the same durable promise an ordinary queue makes: "sends when Hermes is
// back" is a lie if the tab closing loses the message.
test('a message store could not persist is never called durable', () => {
  const paint = body(chatSource, 'function paintEntry');
  assert.match(
    paint,
    /entry\.durable === false[\s\S]*?Queued in this tab only/,
    'a non-durable entry must say so, not claim the ordinary queued text',
  );
});

// A tap on an uncertain or failed bubble is the user gesture the auto-flush
// is waiting for; without clearing the block first, flushOutbox would just
// stop at the same entry again and the button would do nothing.
test('retrying a blocked queued entry clears the block before flushing', () => {
  const retry = body(chatSource, 'function retry');
  assert.match(retry, /resetOutboxIssue\(/, 'retry() must clear uncertain/failed before flushing');
  assert.ok(
    retry.indexOf('resetOutboxIssue(') < retry.indexOf('flushOutbox()'),
    'the block must be cleared before the flush that depends on it running',
  );
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
