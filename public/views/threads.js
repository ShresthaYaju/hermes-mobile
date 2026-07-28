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

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'web-pwa', label: 'Web' },
  { key: 'cron', label: 'Scheduled' },
  { key: 'subagent', label: 'Agents' },
];

let lastFilter = 'all';
let lastQuery = '';

export function threadsView() {
  const root = el('div', { class: 'view' });
  const search = el('input', {
    class: 'input input--search',
    type: 'search',
    placeholder: 'Search all messages',
    value: lastQuery,
    autocomplete: 'off',
  });
  const chips = el('div', { class: 'chips' });
  const list = el('div', { class: 'list' }, spinner('Loading threads'));
  root.append(el('div', { class: 'toolbar' }, search), chips, list);

  let disposed = false;
  let controller;
  let searchTimer;

  const renderChips = () => {
    clear(chips);
    for (const filter of FILTERS) {
      chips.append(
        el(
          'button',
          {
            class: `chip ${lastFilter === filter.key ? 'chip--on' : ''}`,
            onclick: () => {
              lastFilter = filter.key;
              renderChips();
              load();
            },
          },
          filter.label,
        ),
      );
    }
  };

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    clear(list).append(spinner('Loading threads'));
    try {
      const sessions = lastQuery.trim()
        ? await searchSessions(lastQuery.trim(), signal)
        : await listSessions(lastFilter, signal);
      if (disposed) return;
      renderList(list, sessions);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      clear(list).append(errorState(error, load));
    }
  }

  search.addEventListener('input', () => {
    lastQuery = search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });

  renderChips();
  load();
  const poller = setInterval(() => {
    if (!lastQuery.trim()) load();
  }, 30000);

  root.dispose = () => {
    disposed = true;
    clearTimeout(searchTimer);
    clearInterval(poller);
    controller?.abort();
  };
  return root;
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
    node.append(
      el(
        'div',
        {
          class: 'card row row--tappable',
          onclick: () => navigate(`#/session/${encodeURIComponent(id)}`),
        },
        el('span', { class: 'glyph' }, sourceGlyph(session.source)),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title' }, sessionTitle(session)),
          el(
            'div',
            { class: 'row-sub' },
            looksActive(session) ? el('span', { class: 'pill pill--live' }, 'recent') : null,
            `${session.message_count ?? 0} messages`,
            session.profile && session.profile !== 'default' ? ` · ${session.profile}` : '',
          ),
        ),
        el('span', { class: 'row-meta' }, relativeTime(session.last_active || session.started_at)),
      ),
    );
  }
}
