// Threads -- one unified list across every channel.
//
// This reads REST rather than the socket on purpose. Telegram and cron
// sessions live in other OS processes, so the gateway cannot stream them here
// (verified: session.active_list reports zero while eight Telegram sessions
// exist in the database). Resuming such a session over RPC would cold-load its
// history and build a *second* agent, so history is read over HTTP instead.

import { api } from '../lib/api.js';
import {
  el,
  clear,
  spinner,
  errorState,
  emptyState,
  relativeTime,
  sessionTitle,
  sourceGlyph,
  statusDot,
  looksActive,
} from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { threadHref, isOwnThread, OWN_SOURCE } from '../lib/threads.js';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: OWN_SOURCE, label: 'Mine' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'web-pwa', label: 'Web' },
  { key: 'cron', label: 'Scheduled' },
  { key: 'subagent', label: 'Agents' },
];

// What the row's glyph means, for a reader. The chip labels are written for a
// filter bar ("Mine", "Web") and read wrongly as the name of a channel.
const SOURCE_NAMES = {
  [OWN_SOURCE]: 'This app',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  'web-pwa': 'Web dashboard',
  cron: 'Scheduled run',
  subagent: 'Background agent',
  cli: 'Command line',
};
const sourceName = (source) => SOURCE_NAMES[source] || 'Unknown source';

let lastFilter = 'all';
let lastQuery = '';

export function threadsView() {
  const root = el('div', { class: 'view' });
  const search = el('input', {
    class: 'input input--search',
    type: 'search',
    placeholder: 'Search all messages',
    'aria-label': 'Search all messages',
    value: lastQuery,
    autocomplete: 'off',
  });
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by channel' });
  const list = el('div', { class: 'list' }, spinner('Loading threads'));
  // One sentence when the list changes underneath you, rather than the list.
  const summary = el('p', { class: 'sr-only', role: 'status' });
  const compose = el(
    'button',
    { class: 'icon-btn', onclick: () => navigate('#/chat/new'), 'aria-label': 'New thread' },
    '＋',
  );
  root.append(el('div', { class: 'toolbar' }, search, compose), chips, summary, list);

  let disposed = false;
  let controller;
  let searchTimer;
  let summaryText = '';
  let listKey = null;

  const chipButtons = FILTERS.map((filter) =>
    el(
      'button',
      {
        class: 'chip',
        onclick: () => {
          lastFilter = filter.key;
          listKey = null;
          syncChips();
          load();
        },
      },
      filter.label,
    ),
  );
  chips.append(...chipButtons);

  // Updated in place rather than rebuilt: replacing the chip that was just
  // pressed takes the focus with it, and which chip is on is carried by colour
  // alone otherwise.
  const syncChips = () => {
    chipButtons.forEach((button, index) => {
      const on = FILTERS[index].key === lastFilter;
      button.classList.toggle('chip--on', on);
      button.setAttribute('aria-pressed', String(on));
    });
  };

  async function load() {
    controller?.abort();
    const mine = (controller = new AbortController());
    // The spinner belongs to a list that is not on screen yet. Flashing it on
    // every 30s poll would also throw away the row a keyboard has focus on.
    if (listKey === null) clear(list).append(spinner('Loading threads'));
    list.setAttribute('aria-busy', 'true');
    try {
      const sessions = lastQuery.trim()
        ? await searchSessions(lastQuery.trim(), mine.signal)
        : await listSessions(lastFilter, mine.signal);
      if (disposed) return;
      const key = listDigest(sessions);
      if (key !== listKey) {
        listKey = key;
        renderList(list, sessions);
      }
      const text = summarise(sessions, lastQuery);
      if (text !== summaryText) {
        summaryText = text;
        summary.textContent = text;
      }
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      listKey = null;
      clear(list).append(errorState(error, load));
    } finally {
      // An aborted load must not clear the busy flag its replacement just set.
      if (!disposed && controller === mine) list.removeAttribute('aria-busy');
    }
  }

  search.addEventListener('input', () => {
    lastQuery = search.value;
    // A new query means a different list, not a changed one: show it loading.
    listKey = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });

  syncChips();
  load();
  const poller = setInterval(() => {
    if (!lastQuery.trim()) load();
  }, 30000);

  root.refresh = load;
  root.dispose = () => {
    disposed = true;
    clearTimeout(searchTimer);
    clearInterval(poller);
    controller?.abort();
  };
  return root;
}

/**
 * Everything a row puts on screen, relative timestamps included. The poll then
 * only touches the DOM when the list would actually look different, which
 * keeps focus on the row a keyboard is sitting on -- and because the digest is
 * of the rendered text rather than of the data, "5m ago" turning into "6m ago"
 * still counts as a change.
 */
function listDigest(sessions) {
  return JSON.stringify(
    sessions.map((session) => [
      session.id || session.session_id,
      sessionTitle(session),
      session.source,
      session.message_count ?? 0,
      session.profile || '',
      looksActive(session),
      relativeTime(session.last_active || session.started_at),
    ]),
  );
}

function summarise(sessions, query) {
  const count = `${sessions.length} ${sessions.length === 1 ? 'thread' : 'threads'}`;
  return query.trim() ? `${count} matching ${query.trim()}.` : `${count}.`;
}

async function listSessions(filter, signal) {
  const params = { limit: 50, order: 'recent', min_messages: 1, archived: 'exclude' };
  // Of 48 live sessions, 36 are machine noise. The default view is the human one.
  if (filter === 'all') params.exclude_sources = 'cron,subagent,tool';
  else params.source = filter;
  const data = await api.sessions(params, signal);
  return normalise(data);
}

async function searchSessions(query, signal) {
  const data = await api.searchSessions(query, signal);
  return normalise(data);
}

function normalise(data) {
  if (Array.isArray(data)) return data;
  return data?.sessions || data?.results || [];
}

function renderList(node, sessions) {
  clear(node);
  if (!sessions.length) {
    node.append(emptyState('No threads here.', 'Try another filter, or start a conversation.'));
    return;
  }
  for (const session of sessions) {
    const id = session.id || session.session_id;
    // Ownership decides the door: our own threads open in the composer, every
    // other surface's open read-only. See lib/threads.js.
    const href = threadHref({ ...session, id });
    node.append(
      el(
        'button',
        {
          class: 'card row row--tappable',
          onclick: () => navigate(href),
        },
        el('span', { class: 'glyph', 'aria-hidden': 'true' }, sourceGlyph(session.source)),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title' }, sessionTitle(session)),
          el(
            'div',
            { class: 'row-sub' },
            looksActive(session) ? el('span', { class: 'pill pill--live' }, 'recent') : null,
            // The channel is the glyph and nothing else, so it has to be said.
            el('span', { class: 'sr-only' }, `${sourceName(session.source)}. `),
            `${session.message_count ?? 0} messages`,
            isOwnThread(session) ? ' · chat' : '',
            session.profile && session.profile !== 'default' ? ` · ${session.profile}` : '',
          ),
        ),
        el('span', { class: 'row-meta' }, relativeTime(session.last_active || session.started_at)),
      ),
    );
  }
}
