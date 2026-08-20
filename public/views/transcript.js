// Transcript -- read-only history for one session.
//
// Rendering lives in lib/transcript.js because the chat view replays the same
// stored history above its composer. This view is the read-only door: it never
// attaches to a session, so opening one can never steal another transport's
// event stream (PLAN.md, spike 2).

import { api } from '../lib/api.js';
import { el, clear, spinner, errorState, emptyState, sourceGlyph } from '../lib/ui.js';
import { back } from '../lib/router.js';
import { renderTranscript, toolExpander } from '../lib/transcript.js';
import { isOwnThread, telegramHref } from '../lib/threads.js';

const PAGE = 200;

export function transcriptView({ id }) {
  const root = el('div', { class: 'view view--detail' });
  const header = el('header', { class: 'detail-head' });
  const body = el('div', {}, spinner('Loading transcript'));
  root.append(header, body);

  let disposed = false;
  let controller;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [session, payload] = await Promise.all([
        api.session(id, signal).catch(() => null),
        api.messages(id, { limit: PAGE }, signal),
      ]);
      if (disposed) return;
      renderHeader(header, session, id);
      const messages = payload?.messages || [];
      clear(body);
      if (!messages.length) {
        // A cron run that failed before its first assistant turn has only the
        // prompt. Treat that as a normal state, not an error.
        body.append(
          emptyState(
            'No transcript recorded.',
            'Scheduled runs that fail before the agent replies leave their output only in the run document on the host.',
          ),
        );
        return;
      }
      // Both the toolbar and the note are optional, and append() coerces a
      // null to the *string* "null" rather than skipping it -- el() filters,
      // append() does not.
      const list = renderTranscript(messages);
      body.append(...[toolbar(session, list), list, readOnlyNote(session)].filter(Boolean));
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      clear(body).append(errorState(error, load));
    }
  }

  load();
  root.dispose = () => {
    disposed = true;
    controller?.abort();
  };
  return root;
}

function renderHeader(node, session, id) {
  clear(node);
  const title = session?.title || session?.display_name || 'Transcript';
  node.append(
    el(
      'button',
      { class: 'icon-btn', onclick: () => back('#/threads'), 'aria-label': 'Back' },
      '‹',
    ),
    el(
      'div',
      { class: 'detail-head-main' },
      el('div', { class: 'detail-title' }, title),
      el(
        'div',
        { class: 'detail-sub mono' },
        session?.source ? `${sourceGlyph(session.source)} ${session.source}` : '',
        session?.model ? ` · ${session.model}` : '',
        session?.cwd ? ` · ${shortPath(session.cwd)}` : '',
      ),
    ),
  );
}

// The two controls that act on the transcript as a whole rather than on one
// row. Both are optional, so the bar disappears entirely on a short cron run
// with nothing to expand and nowhere to hand off to.
function toolbar(session, list) {
  const expander = toolExpander(list);
  const handOff = telegramLink(session);
  if (!expander && !handOff) return null;
  return el('div', { class: 'transcript-tools' }, expander, handOff);
}

// The hand-off, and the reason it is a link rather than a composer: this app
// cannot write into a Telegram thread, but Telegram is on the same phone.
// telegramHref() returns null whenever it cannot name the right conversation
// -- notably for direct messages with the bot -- and then there is no control
// at all, because a button that opens the wrong chat is worse than none.
function telegramLink(session) {
  const href = telegramHref(session);
  if (!href) return null;
  return el(
    'a',
    { class: 'btn btn--small transcript-handoff', href, target: '_blank', rel: 'noopener' },
    'Open in Telegram ',
    el('span', { class: 'handoff-arrow', 'aria-hidden': 'true' }, '⇗'),
  );
}

// Say why there is no composer here. The honest reason is ownership, not a
// missing feature: this conversation belongs to another process, and talking
// into it from the phone would build a second agent on the same transcript.
function readOnlyNote(session) {
  const source = session?.source;
  if (!source || isOwnThread(session)) return null;
  const owner =
    source === 'cron'
      ? 'the scheduler'
      : source === 'subagent'
        ? 'its parent agent'
        : `the ${source} surface`;
  // Telegram is the one surface with a real answer to "then where do I reply?"
  // -- it is on this phone. Name it either way, because the reply still has to
  // happen there even when we could not build a link to the exact chat.
  const elsewhere =
    source === 'telegram'
      ? telegramHref(session)
        ? ' Continue it in Telegram.'
        : ' Continue it in Telegram on this phone — a direct chat has no link this app can build.'
      : ' Use the Chat tab for a conversation this app owns.';
  return el(
    'p',
    { class: 'note note--transcript' },
    `Read-only: this thread belongs to ${owner}. Replying here would start a second agent on the same history.${elsewhere}`,
  );
}

const shortPath = (path) => String(path).replace(/^\/home\/[^/]+/, '~');
