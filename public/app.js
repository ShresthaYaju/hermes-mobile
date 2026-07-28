import { startRouter, defineRoute, navigate, currentPath } from './lib/router.js';
import { socket } from './lib/rpc.js';
import { state, subscribe } from './lib/store.js';
import { el } from './lib/ui.js';
import { nowView } from './views/now.js';
import { threadsView } from './views/threads.js';
import { workView } from './views/work.js';
import { configView } from './views/config.js';
import { chatView } from './views/chat.js';
import { jobView } from './views/job.js';
import { transcriptView } from './views/transcript.js';

// Monochrome line glyphs only. Anything carrying the Unicode Emoji property
// gets substituted with the OS emoji font on iOS and arrives as a colour
// sticker at the wrong weight, however the standard classifies its default
// presentation. ⏱︎ was doing exactly that, so Work uses ◷ from the same block
// as ◉ -- same font, same stroke. ⚙︎ keeps its shape but takes U+FE0E, which
// does pin it to text. test/glyphs.test.mjs enforces the rule, and treats a
// comment no differently: this file contains no bare Emoji codepoint at all.
const TABS = [
  { path: '/now', label: 'Now', glyph: '◉' },
  { path: '/threads', label: 'Threads', glyph: '☰' },
  { path: '/work', label: 'Work', glyph: '◷' },
  { path: '/chat', label: 'Chat', glyph: '✎' },
  { path: '/config', label: 'Config', glyph: '⚙︎' },
];

defineRoute('/now', nowView);
defineRoute('/threads', threadsView);
defineRoute('/work', workView);
defineRoute('/chat', chatView);
defineRoute('/config', configView);
defineRoute(/^\/job\/(?<id>.+)$/, jobView);
defineRoute(/^\/session\/(?<id>.+)$/, transcriptView);

const outlet = document.querySelector('#outlet');
const tabbar = document.querySelector('#tabbar');
const connection = document.querySelector('#connection');

function renderTabs() {
  const path = currentPath();
  tabbar.replaceChildren(
    ...TABS.map((tab) => {
      const active = path === tab.path || path.startsWith(`${tab.path}/`);
      const badge = tab.path === '/now' && state.approvals.length ? state.approvals.length : null;
      return el(
        'button',
        {
          class: `tab ${active ? 'tab--on' : ''}`,
          onclick: () => navigate(`#${tab.path}`),
          'aria-current': active ? 'page' : null,
        },
        el('span', { class: 'tab-glyph' }, tab.glyph),
        el('span', { class: 'tab-label' }, tab.label),
        badge ? el('span', { class: 'tab-badge' }, String(badge)) : null,
      );
    }),
  );
}

function renderConnection() {
  connection.className = `connection connection--${state.connection}`;
  connection.textContent =
    state.connection === 'live'
      ? 'live'
      : state.connection === 'connecting'
        ? 'connecting'
        : 'offline';
}

window.addEventListener('route', renderTabs);
subscribe(() => {
  renderTabs();
  renderConnection();
});

startRouter(outlet);
renderTabs();
renderConnection();
socket.connect();

// Reconnect promptly when the phone returns to the foreground rather than
// waiting out the backoff.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});

// The shell is pinned to the viewport, which iOS does not shrink when the
// keyboard opens -- so without this the composer would sit behind it. The
// visual viewport is the one that does report the covered height.
const viewport = window.visualViewport;
if (viewport) {
  const syncHeight = () => {
    const root = document.documentElement;
    root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    // The home-indicator inset is meaningless once a keyboard covers that
    // edge, and leaving it reads as a gap above the keyboard.
    root.classList.toggle('keyboard-open', viewport.height < root.clientHeight - 80);
    // A focused input can leave iOS scrolled inside a viewport that cannot
    // scroll, which offsets everything by the keyboard's height.
    if (viewport.offsetTop !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', syncHeight);
  viewport.addEventListener('scroll', syncHeight);
  syncHeight();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
