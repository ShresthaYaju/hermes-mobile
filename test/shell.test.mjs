// The shell is the part of the app that has to keep working when a view does
// not: the router, the boundary around view construction, the one explicit
// "check now" the polling surfaces share, and the announcements a screen
// reader gets from screens that change with nobody touching them.
//
// Nothing here builds a DOM. Like test/pwa.test.mjs and test/threads.test.mjs
// this reads the sources and pins the properties that are cheap to lose in a
// later edit and invisible once lost -- a live region that starts repeating
// itself, or a row that stops being reachable without a touchscreen, look
// exactly like a working app from the outside.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

/** Files this suite owns. Other areas are pinned by their own suites. */
const POLLING_VIEWS = ['views/now.js', 'views/work.js', 'views/threads.js'];
const SHELL_FILES = ['app.js', 'lib/router.js', ...POLLING_VIEWS];

/** The balanced span starting at `index`, which must sit on an opening bracket. */
function balanced(source, index, open = '(', close = ')') {
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (!depth) return source.slice(index, i + 1);
    }
  }
  throw new Error(`unbalanced ${open} at ${index}`);
}

/** The text of a top-level function declaration, braces included. */
function body(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  return balanced(source, source.indexOf('{', start), '{', '}');
}

/** Every `el('button', …)` call in a file, as { props, children } text. */
function buttons(source) {
  const found = [];
  for (const match of source.matchAll(/el\(\s*'button',/g)) {
    const call = balanced(source, match.index + 2);
    const props = balanced(call, call.indexOf('{'), '{', '}');
    // Everything after the props object and before the call's own ')'.
    found.push({ props, children: call.slice(call.indexOf(props) + props.length, -1) });
  }
  return found;
}

// --------------------------------------------------------- error boundary --

test('a view that throws mounts a boundary instead of an empty outlet', () => {
  const render = body(read('lib/router.js'), 'render');
  assert.match(render, /try\s*\{[\s\S]*?found\.factory\([\s\S]*?\}\s*catch/, 'factory not guarded');
  assert.match(render, /errorBoundary\(/, 'nothing is mounted when the factory throws');
});

test('the outgoing view is disposed even when the incoming one throws', () => {
  const render = body(read('lib/router.js'), 'render');
  const disposedAt = render.indexOf('dispose');
  const builtAt = render.indexOf('found.factory(');
  assert.ok(disposedAt !== -1 && disposedAt < builtAt, 'dispose must run before the next factory');
  // A dispose() that throws must not take the incoming screen down with it.
  assert.match(render, /try\s*\{[\s\S]{0,120}?dispose\?\.\(\)[\s\S]{0,40}?\}\s*catch/);
});

test('the boundary is recoverable and has a door out of the broken route', () => {
  const boundary = body(read('lib/router.js'), 'errorBoundary');
  assert.match(boundary, /role: 'alert'/, 'the failure must reach a screen reader');
  assert.match(boundary, /Try again/, 'no retry');
  assert.match(boundary, /navigate\(/, 'no way to leave a route that will not build');
});

test('the global handler never replaces a screen that is still standing', () => {
  const router = read('lib/router.js');
  assert.match(router, /export function reportViewError/);
  // It may only take over an outlet with nothing in it: a background poll that
  // rejects must not blow away a working screen.
  assert.match(body(router, 'reportViewError'), /childElementCount/);
});

test('an async failure inside a view is caught at the top level', () => {
  const app = read('app.js');
  assert.match(app, /addEventListener\('error'/, 'no window error handler');
  assert.match(app, /addEventListener\('unhandledrejection'/, 'no rejection handler');
  assert.match(app, /reportViewError/, 'the handler does not reach the boundary');
  // Views abort their own in-flight fetches on dispose; that is not a fault.
  assert.match(app, /AbortError/);
});

// ---------------------------------------------------------------- refresh --

test('every polling view can be refreshed on demand', () => {
  for (const name of POLLING_VIEWS) {
    const source = read(name);
    assert.match(source, /setInterval\(/, `${name} no longer polls -- is this test still right?`);
    assert.match(source, /root\.refresh\s*=/, `${name} offers no way to force a refresh`);
  }
});

test('the shell drives that refresh from one named control', () => {
  const app = read('app.js');
  assert.match(app, /refreshCurrent/, 'the shell never calls a view refresh');
  assert.match(app, /'aria-label': 'Refresh'/, 'the refresh control has no accessible name');
  // Chat, Config and the detail views do not poll, so the control must go away
  // rather than sit there doing nothing.
  assert.match(app, /canRefresh\(\)/);
  assert.match(read('lib/router.js'), /export function (refreshCurrent|canRefresh)/);
});

// ---------------------------------------------------------- accessibility --

test('icon-only controls carry an accessible name', () => {
  for (const name of SHELL_FILES) {
    for (const { props, children } of buttons(read(name))) {
      // A button whose entire content is one glyph literal has no text in it
      // to be named by. A separator inside a longer label does not count.
      const only = children
        .replace(/^\s*,\s*/, '')
        .trim()
        .replace(/,$/, '');
      if (!/^'[^']{1,3}'$/.test(only) || !/[^\p{ASCII}]/u.test(only)) continue;
      assert.match(props, /aria-label/, `${name}: glyph button ${only} is unnamed`);
    }
  }
});

test('decorative glyphs are not read out', () => {
  const app = read('app.js');
  assert.match(app, /class: 'tab-glyph', 'aria-hidden': 'true'/, 'tab glyphs are read as shapes');
  // The badge is a bare number next to the tab label; the count needs saying
  // in words or it arrives as "Now 3".
  assert.match(app, /'aria-label': badge \?/, 'the approvals badge is not named');
  assert.match(app, /'tab-badge', 'aria-hidden': 'true'/, 'the badge is read twice');
});

test('pending approvals are an assertive live region', () => {
  const now = read('views/now.js');
  assert.match(now, /'aria-live': 'assertive'/, 'an agent blocked on a decision must interrupt');
  assert.match(now, /aria-labelledby/, 'the region is unnamed');
});

test('Now does not re-announce approvals that have not changed', () => {
  // The store emits on every activity tick. Rebuilding the cards each time made
  // a reader repeat a pending request every few seconds and wiped whatever had
  // been typed into a clarify answer, so the set of open request ids gates it.
  const now = read('views/now.js');
  assert.match(now, /key (===|!==) approvalsKey/, 'no guard on the approvals rebuild');
  // Same reason on the gateway card, which the poll re-rendered every 30s.
  assert.match(now, /key (===|!==) gatewayKey/, 'no guard on the gateway card');
});

test('Work and Threads say what changed without reading the whole list', () => {
  for (const name of ['views/work.js', 'views/threads.js']) {
    const source = read(name);
    assert.match(source, /role: 'status'/, `${name} announces nothing when it reloads`);
    assert.match(source, /aria-busy/, `${name} does not say it is loading`);
  }
});

test('threads exposes its filter state and names its search box', () => {
  const threads = read('views/threads.js');
  assert.match(threads, /'aria-pressed'/, 'filter chips do not say which one is on');
  assert.match(threads, /'aria-label': 'Search all messages'/);
});

test('rows that open something are buttons, not tappable divs', () => {
  // A div with an onclick is invisible to the keyboard, to switch control and
  // to a reader looking for controls -- and these rows are the whole surface.
  for (const name of POLLING_VIEWS) {
    assert.doesNotMatch(
      read(name),
      /'div',\s*\{[^{}]*row--tappable/,
      `${name} still opens things from a div`,
    );
  }
});
