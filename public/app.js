import {
  startRouter,
  defineRoute,
  navigate,
  currentPath,
  canRefresh,
  refreshCurrent,
  reportViewError,
} from './lib/router.js';
import { socket } from './lib/rpc.js';
import { state, subscribe } from './lib/store.js';
import { el, toast } from './lib/ui.js';
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
defineRoute(/^\/chat\/(?<id>.+)$/, chatView);
defineRoute(/^\/job\/(?<id>.+)$/, jobView);
defineRoute(/^\/session\/(?<id>.+)$/, transcriptView);

const outlet = document.querySelector('#outlet');
const tabbar = document.querySelector('#tabbar');
const connection = document.querySelector('#connection');
const topbar = document.querySelector('.topbar');

// Nothing about a hash navigation reaches a screen reader: the page never
// reloads, and swapping the outlet's children is not an event anything
// announces. This is the one place that says what just happened. It clears
// itself first so the same message twice running is still spoken twice.
const announcer = el('p', { class: 'sr-only', role: 'status' });
document.body.append(announcer);
let announceTimer;
function announce(message) {
  announcer.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announcer.textContent = message;
  }, 60);
}

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
          // The badge is a bare numeral sitting next to the label, which reads
          // as "Now 3". Naming the button says what the 3 counts.
          'aria-label': badge ? `${tab.label}, ${badge} waiting on you` : null,
        },
        el('span', { class: 'tab-glyph', 'aria-hidden': 'true' }, tab.glyph),
        el('span', { class: 'tab-label' }, tab.label),
        badge ? el('span', { class: 'tab-badge', 'aria-hidden': 'true' }, String(badge)) : null,
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

// One explicit "check now", shared by every view that polls, rather than
// pull-to-refresh. The scrolling element here is the outlet, which on iOS
// already rubber-bands under the finger; a gesture handler on top of that
// either fights the rubber band or misfires part-way through a fling, and
// there is no way to discover it exists. A control in the topbar is always in
// the same place, works without a touchscreen, and can say when it is busy.
const refresh = el(
  'button',
  { class: 'icon-btn topbar-refresh', 'aria-label': 'Refresh', onclick: refreshNow },
  '↻',
);
refresh.hidden = true;
topbar.insertBefore(refresh, connection);

let refreshing = false;
async function refreshNow() {
  if (refreshing) return;
  refreshing = true;
  refresh.setAttribute('aria-busy', 'true');
  try {
    // The floor is what makes the spin readable as feedback: a cached response
    // can land in 20ms, which looks like the tap did nothing at all.
    await Promise.all([refreshCurrent(), new Promise((done) => setTimeout(done, 450))]);
    announce('Refreshed');
  } catch (error) {
    toast(error?.message || 'Could not refresh', 'error');
  } finally {
    refreshing = false;
    refresh.removeAttribute('aria-busy');
  }
}

function routeName(path) {
  const tab = TABS.find((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
  if (tab) return tab.label;
  if (path.startsWith('/job/')) return 'Job';
  if (path.startsWith('/session/')) return 'Transcript';
  return 'Hermes';
}

window.addEventListener('route', ({ detail }) => {
  renderTabs();
  refresh.hidden = !canRefresh();
  announce(routeName(detail?.path || currentPath()));
});
subscribe(() => {
  renderTabs();
  renderConnection();
});

// A throw inside a view's async load lands here rather than in the router's
// boundary, which can only guard construction. Two outcomes matter: the outlet
// was left empty, in which case the app looks dead and needs the boundary, or
// the screen is still standing and the user only needs telling that the last
// update did not arrive. Repeats are swallowed so a poll that fails every 30s
// does not become a rolling toast.
let lastFailureAt = 0;
function handleFailure(reason) {
  // Views abort their own in-flight fetches on dispose. That is not a fault.
  if (reason?.name === 'AbortError') return;
  if (reportViewError(reason)) return;
  if (Date.now() - lastFailureAt < 10000) return;
  lastFailureAt = Date.now();
  toast(reason?.message || 'Something went wrong', 'error');
}

window.addEventListener('error', (event) => handleFailure(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => handleFailure(event.reason));

startRouter(outlet);
renderTabs();
renderConnection();
refresh.hidden = !canRefresh();
socket.connect();

// Reconnect promptly when the phone returns to the foreground rather than
// waiting out the backoff.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
