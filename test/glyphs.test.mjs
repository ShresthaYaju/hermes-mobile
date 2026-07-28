// The app's symbols are monochrome line glyphs that inherit the surrounding
// colour. Any character carrying the Unicode Emoji property risks being
// substituted with the OS emoji font -- iOS does this even to characters whose
// default presentation is text -- and arrives as a colour sticker at the wrong
// weight, visibly unlike its neighbours.
//
// The rule: no non-ASCII Emoji character in a shipped file unless it is
// immediately followed by U+FE0E, the text-presentation selector.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);
const files = ['app.js', 'index.html', 'service-worker.js', 'styles.css'].concat(
  ...['lib', 'views'].map((dir) =>
    readdirSync(new URL(`${dir}/`, publicDir)).map((name) => `${dir}/${name}`),
  ),
);

const TEXT_SELECTOR = '︎';
// ASCII digits, '#' and '*' carry the Emoji property but are never rendered as
// emoji on their own, and they appear on nearly every line of source.
const suspect = /[^\p{ASCII}]/gu;

function offenders(source) {
  const found = [];
  for (const match of source.matchAll(suspect)) {
    const character = match[0];
    if (!/\p{Emoji}/u.test(character)) continue;
    if (source[match.index + character.length] === TEXT_SELECTOR) continue;
    const line = source.slice(0, match.index).split('\n').length;
    found.push(
      `${character} (U+${character.codePointAt(0).toString(16).toUpperCase()}) line ${line}`,
    );
  }
  return found;
}

test('no shipped file renders a colour emoji', () => {
  for (const name of files) {
    const found = offenders(readFileSync(new URL(name, publicDir), 'utf8'));
    assert.deepEqual(found, [], `${name} must use text glyphs, add U+FE0E or pick a line glyph`);
  }
});

// Guards the check itself: if \p{Emoji} ever stops matching these, the test
// above silently passes on anything.
test('the check catches the glyphs that caused this', () => {
  assert.deepEqual(offenders('const a = "⏱";').length, 1, 'stopwatch');
  assert.deepEqual(offenders('const a = "⚙";').length, 1, 'gear');
  assert.deepEqual(offenders('const a = "✈";').length, 1, 'airplane');
  assert.deepEqual(offenders('const a = "⚠";').length, 1, 'warning');

  // The selector clears them, and the geometric glyphs never tripped it.
  assert.deepEqual(offenders('"⚙︎" "✈︎" "⚠︎"'), []);
  assert.deepEqual(
    offenders('"◉" "☰" "✎" "◷" "◐" "◍" "◈" "⑂" "▸" "‹" "›" "○" "↑" "—" "·" "…"'),
    [],
  );
});

test('the tab bar and source glyphs agree on one style', () => {
  const app = readFileSync(new URL('app.js', publicDir), 'utf8');
  const ui = readFileSync(new URL('lib/ui.js', publicDir), 'utf8');

  // Work and cron are the same concept and must not diverge again.
  assert.match(app, /path: '\/work', label: 'Work', glyph: '◷'/);
  assert.match(ui, /cron: '◷'/);
});
