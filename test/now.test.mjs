// The approval gate: a command rendered untruncated, with no cap on the box
// showing it, lets a command with hundreds of newlines push Allow/Deny off
// screen -- the one control in this app that must always be reachable without
// scrolling to find it. And an approval answered against the wrong session_id
// (state.sessionId, stale after a reconnect swapped it) never reaches the
// request it was meant for.
//
// No DOM here, in the style of chat.test.mjs: the clip helper is tested for
// real, session_id propagation is tested through the store directly, and the
// view's wiring is pinned at the source level.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clip } from '../public/lib/transcript.js';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const nowSource = read('views/now.js');

/** The source of a named function, by brace matching (mirrors chat.test.mjs). */
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const opener = /\)\s*(=>\s*)?\{/.exec(source.slice(start));
  assert.ok(opener, `${signature} has no body`);
  let depth = 0;
  for (let i = start + opener.index + opener[0].length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

// -------------------------------------------------------------- clipping --

test('a command at or under the clip length is shown whole', () => {
  const text = 'x'.repeat(2000);
  assert.equal(clip(text, 2000), text);
});

test('a command over the clip length is cut with an explicit marker', () => {
  const text = 'y'.repeat(5000);
  const clipped = clip(text, 2000);
  assert.ok(clipped.length <= 2100, `clipped text was ${clipped.length} chars`);
  assert.match(clipped, /… \d+ more characters$/);
  assert.ok(clipped.startsWith('y'.repeat(2000)));
});

test('the approval card clips through the shared helper, not its own logic', () => {
  const card = body(nowSource, 'function approvalCard');
  assert.match(card, /clip\(command, COMMAND_CLIP\)/);
  assert.match(nowSource, /import \{ clip \} from '\.\.\/lib\/transcript\.js'/);
  assert.match(nowSource, /COMMAND_CLIP\s*=\s*2000/);
});

// --------------------------------------------------------- session_id ----

test('an approval event stamps its own session_id onto the record', async () => {
  const store = await import('../public/lib/store.js');
  const { socket } = await import('../public/lib/rpc.js');

  socket.dispatchEvent(
    new CustomEvent('event', {
      detail: {
        type: 'approval.request',
        session_id: 'sess-from-event',
        payload: { request_id: 'req-1', command: 'rm -rf /tmp/x' },
      },
    }),
  );

  const approval = store.state.approvals.find((a) => a.id === 'req-1');
  assert.ok(approval, 'the approval was recorded');
  assert.equal(
    approval.payload.session_id,
    'sess-from-event',
    'the live handle the event arrived on must survive onto the approval record',
  );
  store.removeApproval('req-1');
});

test('answering an approval prefers its own session_id over the app-wide one', () => {
  const send = body(nowSource, 'async function send');
  assert.match(
    send,
    /payload\.session_id\s*\|\|\s*state\.sessionId/,
    "a stale state.sessionId (swapped by a reconnect) must not outrank the request's own session",
  );
});
