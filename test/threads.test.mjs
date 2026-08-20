// Ownership is a correctness rule, not a policy one.
//
// Event fan-out is per-session-transport: the gateway addresses events to
// whichever transport last touched a session. So calling session.resume on a
// session another process owns (Telegram, cron) builds a SECOND agent against
// the same transcript, and resuming one another transport holds (the desktop
// dashboard's web-pwa chats) silently redirects its events. Both were verified
// in the Phase 3 spikes; see PLAN.md.
//
// This suite pins the rule that keeps us out of that: only sessions this app
// created open in the composer, everything else opens read-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OWN_SOURCE, isOwnThread, threadHref, telegramHref } from '../public/lib/threads.js';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('only this app’s own sessions are chattable', () => {
  assert.equal(isOwnThread({ source: OWN_SOURCE }), true);
  for (const source of ['telegram', 'cron', 'subagent', 'web-pwa', 'cli', 'tool', undefined]) {
    assert.equal(isOwnThread({ source }), false, `${source} must not be chattable`);
  }
});

test('a foreign thread routes to the read-only transcript', () => {
  assert.equal(threadHref({ id: 'abc', source: OWN_SOURCE }), '#/chat/abc');
  assert.equal(threadHref({ id: 'abc', source: 'telegram' }), '#/session/abc');
  assert.equal(threadHref({ id: 'cron_x_1', source: 'cron' }), '#/session/cron_x_1');
});

test('thread ids reach the hash encoded', () => {
  assert.equal(threadHref({ id: 'a/b?c', source: OWN_SOURCE }), '#/chat/a%2Fb%3Fc');
});

// The composer must never be able to attach to a session it does not own, so
// the two RPCs that build an agent are only allowed to appear in the chat view
// -- which reaches them through its own thread id, never a list row's.
test('no view but chat calls the session-attaching RPCs', () => {
  for (const name of ['views/threads.js', 'views/transcript.js', 'views/now.js', 'views/work.js']) {
    const source = read(name);
    assert.doesNotMatch(source, /session\.resume|session\.create/, name);
  }
  assert.match(read('views/chat.js'), /session\.resume/);
});

// A draft mints its thread on the first send. If the view stopped tagging the
// source, its own sessions would come back as some other surface's and become
// unchattable -- or worse, indistinguishable from one we must not resume.
test('the chat view stamps its sessions with the owned source', () => {
  const chat = read('views/chat.js');
  assert.match(chat, /source: OWN_SOURCE/);
  assert.equal(OWN_SOURCE, 'hermes-mobile');
});

// ------------------------------------------------------- Telegram hand-off --
//
// Since we cannot talk into a Telegram thread, the honest affordance is to send
// the reader to the client that can -- it is on the same phone. That is only
// honest if the link lands on the right conversation, so these pin exactly when
// one is derivable and, more importantly, when it is not.

test('a private supergroup thread links to its own topic', () => {
  const chat = { source: 'telegram', chat_id: '-1008948560027' };
  assert.equal(telegramHref(chat), 'https://t.me/c/8948560027');
  assert.equal(telegramHref({ ...chat, thread_id: '707' }), 'https://t.me/c/8948560027/707');
  // Ids reach us as numbers from some callers and strings from others.
  assert.equal(
    telegramHref({ ...chat, chat_id: -1008948560027, thread_id: 707 }),
    'https://t.me/c/8948560027/707',
  );
});

// The Bot API reports a private chat's id as the *human's* user id, so this
// value names the phone's own owner and not the bot they were talking to.
// A link built from it opens the reader's own profile: worse than no link.
test('a Telegram direct message yields no link at all', () => {
  assert.equal(
    telegramHref({ source: 'telegram', chat_id: '8948560027', chat_type: 'dm', thread_id: '707' }),
    null,
  );
  assert.equal(telegramHref({ source: 'telegram', chat_id: '8948560027' }), null);
});

test('anything we cannot address truthfully yields no link', () => {
  // t.me/c/ addresses the -100 supergroup space only; a legacy basic group is
  // not reachable by link, and neither is a chat id we cannot even parse.
  assert.equal(telegramHref({ source: 'telegram', chat_id: '-987654321' }), null);
  assert.equal(telegramHref({ source: 'telegram', chat_id: '-100abc' }), null);
  assert.equal(telegramHref({ source: 'telegram', chat_id: '' }), null);
  assert.equal(telegramHref({ source: 'telegram' }), null);
  // A thread id that is not a plain number would be pasted into the URL.
  assert.equal(
    telegramHref({ source: 'telegram', chat_id: '-1008948560027', thread_id: '1/../x' }),
    'https://t.me/c/8948560027',
  );
  for (const source of [OWN_SOURCE, 'cron', 'subagent', 'web-pwa', undefined]) {
    assert.equal(telegramHref({ source, chat_id: '-1008948560027' }), null, source);
  }
  assert.equal(telegramHref(null), null);
});

// https, not tg://. Both open the app when it is installed, but t.me is a
// Universal Link Telegram claims, so it degrades to a web page instead of a
// dead-end scheme prompt when it is not. (The file may still *discuss* tg://;
// what matters is that nothing it returns is one.)
test('the hand-off is an https link, never a bare scheme', () => {
  for (const thread of [undefined, '707']) {
    const href = telegramHref({ source: 'telegram', chat_id: '-1008948560027', thread_id: thread });
    assert.ok(href.startsWith('https://t.me/'), href);
    assert.equal(new URL(href).protocol, 'https:');
  }
});

// The whole point of the hand-off is that it replaces resuming. If it ever
// started routing anywhere in this app, we would be back to two agents on one
// transcript -- so a Telegram thread with a link still opens read-only.
test('a hand-off never changes where a thread opens', () => {
  const session = { id: 'abc', source: 'telegram', chat_id: '-1008948560027', thread_id: '707' };
  assert.equal(isOwnThread(session), false);
  assert.equal(threadHref(session), '#/session/abc');
});
