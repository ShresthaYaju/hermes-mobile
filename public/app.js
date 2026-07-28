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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
