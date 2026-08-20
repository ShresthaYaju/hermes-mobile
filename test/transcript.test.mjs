// The read-only transcript: what it renders, and what it must never grow.
//
// Like the rest of this suite these are source-level invariants -- there is no
// DOM here, deliberately. The pure helpers are tested for real; the rendering
// is pinned by the shape of the module that does it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { textOf } from '../public/lib/transcript.js';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// Content arrives as a bare string from some turns and as a parts array from
// others, and the copy control has to hand the clipboard the same text either
// way -- so this is what "a message's text" means everywhere below.
test('textOf reads both content encodings', () => {
  assert.equal(textOf({ content: '  hello  ' }), 'hello');
  assert.equal(textOf({ content: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(textOf({ content: ['a', { text: 'b' }] }), 'ab');
  assert.equal(textOf({ content: [{ type: 'image' }] }), '');
  assert.equal(textOf({ content: null }), '');
  assert.equal(textOf({}), '');
});

test('every rendered message offers its text to the clipboard', () => {
  const source = read('lib/transcript.js');
  assert.match(source, /copyText/, 'copy must go through the ui.js helper');
  // Both prose paths carry the control: a user turn is as worth copying as an
  // assistant one, and only one of them being copyable reads as a bug.
  assert.match(source, /msg--user[\s\S]*?messageActions/, 'user messages');
  assert.match(source, /msg--assistant[\s\S]*?messageActions/, 'assistant messages');
});

// A stored transcript is mostly tool rows, and opening thirty of them one at a
// time to find the failure is the whole reason this control exists.
test('the transcript view can open and close every tool row at once', () => {
  const lib = read('lib/transcript.js');
  assert.match(lib, /export function toolExpander/);
  // It must find rows the same way renderTranscript builds them, or it will
  // silently miss the thinking rows.
  assert.match(lib, /details\.tool/);

  const view = read('views/transcript.js');
  assert.match(view, /toolExpander/, 'the read-only view must mount it');
});

// The clipboard and the expander are chrome. If either one throws or the
// browser refuses, the transcript still has to render -- so neither may sit on
// the path that builds a message.
test('copy failure is reported, not thrown', () => {
  assert.match(read('lib/transcript.js'), /Could not copy/);
});

// append() takes (Node or DOMString), so a null child is coerced to the literal
// text "null" and shows up in the page. The toolbar and the read-only note are
// both absent for some sessions -- an own thread reached by its /session/ URL
// has neither -- so the optional children have to be filtered out first.
test('the optional children never reach append() as null', () => {
  assert.match(read('views/transcript.js'), /body\.append\([\s\S]*?\.filter\(Boolean\)\)/);
});
