// Chat -- one conversation, bound to a durable thread.
//
// Two ids are in play and conflating them is the whole trap:
//
//   * the THREAD id (`session.create`'s `stored_session_id`, shaped
//     20260730_101500_ab12cd) is the row in state.db. It is what /api/sessions
//     lists, what the Threads tab links to, and what survives disconnects.
//   * the LIVE id (`session_id`, 8 hex) is a handle inside the gateway process
//     for one attachment. Events and prompt.submit take this one, and it is
//     thrown away whenever the socket drops.
//
// Sessions deliberately do NOT set close_on_disconnect. That flag reaps the
// live handle the instant the socket drops -- and a phone drops its socket
// every time it locks, so a long task fired off before pocketing the phone was
// killed seconds later. Acceptable for a viewer; disqualifying for the primary
// control surface.
//
// Without the flag the host parks the session instead (tui_gateway/server.py,
// _close_sessions_for_transport). Two properties make that safe:
//
//   * a session with a turn in flight is never reaped -- _ws_session_is_orphaned
//     returns false while `running`, so the work survives the phone sleeping;
//   * an idle parked session is reaped after a 20s grace window, so nothing
//     leaks, and a session.resume inside that window cancels the reap.
//
// So we reattach on reconnect rather than waiting for the next send.
//
// Attachment is lazy: opening a thread only reads REST. We resume (and so
// build an agent, and so take over its event stream) at the moment the user
// actually sends. Browsing a thread must never cost an agent.
//
// The one exception is the outbox (lib/store.js): a message composed while the
// socket was down is text the user already committed to sending, so the
// reconnect attaches for it. Queued text is shown in the transcript as pending
// and flushed only once a live handle exists -- submitting against the handle
// from the connection that just died loses the whole turn, because the gateway
// answers the id it was given and that id is gone.

import { api } from '../lib/api.js';
import { socket } from '../lib/rpc.js';
import {
  state,
  update,
  queueMessage,
  outboxFor,
  dequeueMessage,
  adoptQueued,
  markOutboxSubmitted,
  markOutboxUncertain,
  markOutboxDeterministicFailure,
  resetOutboxIssue,
} from '../lib/store.js';
import { renderTranscript, textOf } from '../lib/transcript.js';
import { OWN_SOURCE } from '../lib/threads.js';
import { navigate } from '../lib/router.js';
import {
  el,
  clear,
  copyText,
  errorState,
  renderMarkdown,
  relativeTime,
  sessionTitle,
  toast,
  duration,
} from '../lib/ui.js';

const HISTORY_PAGE = 200;

/**
 * Whether a prompt.submit rejection leaves us unable to say if the gateway
 * ever got the prompt -- as opposed to a *deterministic* refusal, which
 * definitely did not go through. Two shapes of "unknown":
 *
 *   * 'Connection closed' (rpc.js's `drop`): the send() already happened: the
 *     bytes left the device before the socket dropped.
 *   * '... timed out' (rpc.js's per-call timeout): CALL_TIMEOUT_MS gave up
 *     waiting for a response frame, which says nothing about whether the
 *     gateway received and is still working the request.
 *
 * Either way, auto-resending risks a duplicate turn -- see deliver() and
 * flushOutbox(), the only two callers, and store.js's markOutboxUncertain.
 * Exported for its own test: this is the one piece of that logic pure enough
 * to check without a DOM.
 */
export function outcomeUnknown(error) {
  const message = error?.message || '';
  return message === 'Connection closed' || message.endsWith(' timed out');
}

export function chatView({ id } = {}) {
  // "new" is a reserved draft route. Real thread ids are timestamped
  // (20260730_101500_ab12cd), so the two can never collide.
  const requested = id === 'new' ? null : id || null;

  const root = el('div', { class: 'view view--chat' });
  const head = el('header', { class: 'chat-head' });
  const messages = el('div', { class: 'transcript transcript--chat' });
  const activity = el('div', { class: 'activity', hidden: true });
  const input = el('textarea', {
    class: 'composer-input',
    rows: '1',
    placeholder: 'Message Hermes',
    autocomplete: 'off',
  });
  const send = el(
    'button',
    { class: 'composer-action composer-send', 'aria-label': 'Send', disabled: true },
    '↑',
  );
  const composer = el(
    'form',
    { class: 'composer' },
    el('div', { class: 'composer-field' }, input, send),
  );
  // The jump button is a sibling of the scrollport, not a child of it: inside
  // the transcript it would scroll away with the content it points at.
  const jump = el(
    'button',
    { class: 'jump-latest', type: 'button', hidden: true, 'aria-label': 'Jump to latest' },
    'Latest ↓',
  );
  root.append(head, el('div', { class: 'chat-scroll' }, messages, jump), activity, composer);

  // The thread this view is bound to, and our current attachment to it. Both
  // start empty for a draft: the thread is minted by the first send.
  let threadId = requested;
  let liveId = null;
  let assistantNode = null;
  let assistantText = '';
  let disposed = false;
  let controller;
  // Whether THIS thread has a turn in flight. The store's `running` is app-wide
  // (it drives the Now tab), so composing against it would lock this thread's
  // composer whenever any other thread was mid-turn -- the exact opposite of
  // being able to switch context.
  let running = false;
  let startedAt = null;
  // Queued entry id -> the bubble standing in for it, so a flush can mark the
  // right message sent. Rebuilt from the store on every repaint.
  const queuedNodes = new Map();
  let flushing = false;

  // A reader who has scrolled up is reading. Streaming content must not drag
  // them back down; it offers the jump button instead.
  const NEAR_BOTTOM_PX = 48;
  const atBottom = () =>
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < NEAR_BOTTOM_PX;
  const syncJump = () => {
    jump.hidden = atBottom();
  };
  const follow = () => {
    if (atBottom()) scrollDown(messages);
    else jump.hidden = false;
  };
  messages.addEventListener('scroll', syncJump, { passive: true });
  jump.addEventListener('click', () => {
    scrollDown(messages);
    jump.hidden = true;
  });

  renderHead(null);

  async function load() {
    if (!threadId) {
      // A draft has nothing to read -- the row does not exist until the first
      // prompt, by design (abandoned drafts leave no "Untitled" session).
      clear(messages).append(welcome());
      paintQueued();
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [session, payload] = await Promise.all([
        api.session(threadId, signal).catch(() => null),
        api.messages(threadId, { limit: HISTORY_PAGE }, signal).catch(() => ({ messages: [] })),
      ]);
      if (disposed) return;
      renderHead(session);
      const history = payload?.messages || [];
      clear(messages);
      messages.append(history.length ? renderTranscript(history) : welcome());
      hydrate(history);
      paintQueued();
      scrollDown(messages);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      clear(messages).append(errorState(error, load));
    }
  }

  /**
   * Put each stored message's raw text back on the node it produced. The
   * transcript renderer emits one .msg per user or assistant message that has
   * text, in order, so the two line up -- and copy has to hand over the
   * markdown the agent wrote, which its rendering no longer contains.
   */
  function hydrate(history) {
    const texts = history
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map(textOf)
      .filter(Boolean);
    const nodes = messages.querySelectorAll('.msg');
    nodes.forEach((node, index) => {
      if (texts[index] !== undefined) node.dataset.text = texts[index];
    });
  }

  /** Repaint whatever is still waiting to be sent, below the stored history. */
  function paintQueued() {
    queuedNodes.clear();
    const waiting = outboxFor(threadId);
    if (!waiting.length) return;
    messages.querySelector('.welcome')?.remove();
    for (const entry of waiting) paintEntry(append(messages, 'user', entry.text), entry);
    scrollDown(messages);
  }

  // Resolve the Chat tab (#/chat, no id) to the thread you were last in, so
  // the tab is a way back into the conversation rather than a way to lose it.
  async function resolveLatest() {
    try {
      const payload = await api.sessions({
        source: OWN_SOURCE,
        limit: 1,
        order: 'recent',
        min_messages: 1,
        archived: 'exclude',
      });
      const latest = (payload?.sessions || payload || [])[0];
      if (disposed) return;
      if (latest?.id) {
        // Bind and paint here rather than routing: a replace: true navigation
        // rewrites the URL without re-rendering, so nothing else would load.
        threadId = latest.id;
        navigate(`#/chat/${encodeURIComponent(latest.id)}`, { replace: true });
      }
    } catch {
      // Fall through to a draft: an unreachable list must not block a new chat.
    }
    if (!disposed) await load();
  }

  // A queue can outlive the page that made it, and an app reopened online gets
  // no reconnect to ride back in on -- so the first paint checks the outbox
  // itself. Only ever for text the user already committed to sending: browsing
  // still costs no agent.
  (async () => {
    if (id) await load();
    else await resolveLatest();
    if (!disposed && socket.connected && outboxFor(threadId).length) await flushOutbox();
  })();

  function renderHead(session) {
    clear(head).append(
      el(
        'button',
        { class: 'icon-btn', onclick: () => navigate('#/threads'), 'aria-label': 'All threads' },
        '‹',
      ),
      el(
        'div',
        { class: 'detail-head-main' },
        el('div', { class: 'detail-title' }, session ? sessionTitle(session) : 'New thread'),
        el(
          'div',
          { class: 'detail-sub mono' },
          session?.started_at ? relativeTime(session.started_at) : 'not started yet',
          session?.model ? ` · ${session.model}` : '',
        ),
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          onclick: () => navigate('#/chat/new'),
          'aria-label': 'New thread',
          title: 'New thread',
        },
        '＋',
      ),
    );
  }

  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener('input', () => {
    resize();
    send.disabled = !input.value.trim() || running;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  /**
   * Bind this view to a live gateway session, creating the thread on first use
   * and resuming it on every later one. Returns the live id to submit against.
   */
  async function attach() {
    if (liveId) return liveId;
    if (threadId) {
      const resumed = await socket.call('session.resume', {
        session_id: threadId,
        source: OWN_SOURCE,
      });
      liveId = resumed.session_id;
    } else {
      const created = await socket.call('session.create', {
        source: OWN_SOURCE,
      });
      liveId = created.session_id;
      threadId = created.stored_session_id;
      // This is the one moment a draft becomes a thread, so it is where text
      // queued before the thread existed acquires its address. Miss it and the
      // queue stays keyed to no thread and is never found again.
      adoptQueued(threadId);
      // Put the thread in the URL immediately: a reload, a tab switch or a
      // back gesture mid-turn must land back in this conversation, not a draft.
      if (threadId) navigate(`#/chat/${encodeURIComponent(threadId)}`, { replace: true });
    }
    update({ sessionId: liveId, threadId });
    return liveId;
  }

  function submit() {
    const text = input.value.trim();
    if (!text || running) return;
    messages.querySelector('.welcome')?.remove();
    input.value = '';
    resize();
    send.disabled = true;
    deliver(text);
  }

  /**
   * Put one message on the wire, or in the outbox when it cannot go now.
   *
   * The composer is emptied the moment you hit send, so from here on the bubble
   * is the only copy of your text until the outbox takes it -- which is why
   * every failure below ends in a message you can still send, never in a lost
   * one. `existing` re-sends a bubble that is already on screen (Retry).
   */
  async function deliver(text, existing) {
    const node = existing || append(messages, 'user', text);
    clearMessageState(node);
    scrollDown(messages);
    jump.hidden = true;
    if (!socket.connected) {
      hold(node);
      return;
    }
    running = true;
    startedAt = Date.now();
    assistantText = '';
    assistantNode = append(messages, 'assistant', '');
    scrollDown(messages);
    // Set only once attach() has actually resolved and the prompt.submit call
    // is about to go out -- this is what lets the catch below tell "the
    // gateway may already have this prompt" (submit sent, then the pipe
    // closed) apart from "it never even reached the wire" (attach() itself
    // failed). Only the former is unsafe to auto-resend.
    let submitting = false;
    try {
      // Resuming a cold thread rebuilds its agent, which is seconds of work on
      // a large transcript. Say so rather than showing an idle typing dot.
      if (!liveId && threadId) update({ running: true, activity: 'attaching' });
      renderActivity();
      const sessionId = await attach();
      submitting = true;
      await socket.call('prompt.submit', { session_id: sessionId, text });
    } catch (error) {
      assistantNode?.remove();
      assistantNode = null;
      running = false;
      startedAt = null;
      update({ running: false, activity: null });
      // Which failure it was decides what happens next: a socket that went away
      // mid-send will come back and flush, while a gateway that refused the
      // prompt will refuse it again, so that one waits for a deliberate retry.
      if (submitting && outcomeUnknown(error)) {
        // The submit itself reached the wire before the drop, or the answer
        // simply never arrived in time -- either way the gateway may already
        // be running this turn. Resubmitting it automatically on the next
        // reconnect risks doubling it, so this one waits for the reader
        // instead (markOutboxUncertain, below).
        const entry = queueMessage(threadId, node.dataset.text || '');
        markOutboxUncertain(entry.id);
        paintEntry(node, entry);
      } else if (!socket.connected) hold(node);
      else fail(node, error.message);
      renderActivity();
    }
  }

  /** Mark a bubble as waiting, and queue its text if it is not queued already. */
  function hold(node, existing) {
    const entry = existing || queueMessage(threadId, node.dataset.text || '');
    return paintEntry(node, entry);
  }

  /**
   * Attach `node` to `entry` and show whichever outbox state it is currently
   * in -- queued, needing a deliberate resend (uncertain or failed), or (via
   * release()) neither. The single place that has to know all three so a
   * reload (paintQueued) and a fresh failure (deliver, flushOutbox) never
   * disagree about how one is rendered.
   */
  function paintEntry(node, entry) {
    queuedNodes.set(entry.id, node);
    node.dataset.queued = entry.id;
    clearMessageState(node);
    if (entry.failed) {
      node.classList.add('msg--failed');
      status(node, 'Not sent · tap to resend');
    } else if (entry.uncertain) {
      node.classList.add('msg--uncertain');
      status(node, 'May not have sent · tap to resend');
    } else {
      node.classList.add('msg--pending');
      status(
        node,
        entry.durable === false ? 'Queued in this tab only' : 'Queued · sends when Hermes is back',
      );
    }
    return entry;
  }

  function fail(node, message) {
    node.classList.add('msg--failed');
    status(node, message || 'Not sent');
  }

  /** The gateway has it: the bubble is an ordinary message again. */
  function release(node) {
    if (!node) return;
    queuedNodes.delete(node.dataset.queued);
    delete node.dataset.queued;
    clearMessageState(node);
  }

  function clearMessageState(node) {
    node.classList.remove('msg--pending', 'msg--failed', 'msg--uncertain');
    node.querySelector('.msg-status')?.remove();
  }

  function status(node, text) {
    const line = node.querySelector('.msg-status') || el('div', { class: 'msg-status' });
    line.textContent = text;
    node.append(line);
    renderActions(node);
  }

  // ------------------------------------------------------- copy and retry --
  //
  // There is no hover on a phone, so the actions are revealed by tapping the
  // message. Delegated from the container because most of these bubbles were
  // rendered by the shared transcript renderer, not built here.

  const retryable = (node) =>
    node.classList.contains('msg--failed') ||
    node.classList.contains('msg--pending') ||
    node.classList.contains('msg--uncertain');

  function renderActions(node) {
    const existing = node.querySelector('.msg-actions');
    if (!node.classList.contains('msg--open') && !retryable(node)) {
      existing?.remove();
      return;
    }
    const row = el(
      'div',
      { class: 'msg-actions' },
      el('button', { class: 'msg-action', type: 'button', onclick: () => copy(node) }, 'Copy'),
      retryable(node)
        ? el(
            'button',
            { class: 'msg-action msg-action--retry', type: 'button', onclick: () => retry(node) },
            // Failed and uncertain both require the same deliberate tap; the
            // wording just says which kind of doubt it is resolving.
            node.classList.contains('msg--failed')
              ? 'Retry'
              : node.classList.contains('msg--uncertain')
                ? 'Resend'
                : 'Send now',
          )
        : null,
    );
    if (existing) existing.replaceWith(row);
    else node.append(row);
  }

  async function copy(node) {
    // setText() keeps the raw text on the node. The rendering is lossy -- it is
    // markdown turned into markup -- so it is never the thing to copy.
    const ok = await copyText(node.dataset.text || '');
    toast(ok ? 'Copied' : 'Could not copy', ok ? 'info' : 'error');
  }

  function retry(node) {
    const text = node.dataset.text || '';
    if (!text || running) return;
    // Already durable: the queue owns this one, so a retry is a flush, not a
    // second send. Sending it here would put the same text on the wire twice.
    if (node.dataset.queued) {
      // The tap itself is the deliberate gesture an uncertain or failed entry
      // is waiting for -- clear the block so the ordinary (still oldest-first)
      // flush picks it back up instead of skipping past it again.
      const entry = resetOutboxIssue(node.dataset.queued);
      if (entry) paintEntry(node, entry);
      flushOutbox();
    } else deliver(text, node);
  }

  messages.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    const node = event.target.closest('.msg');
    if (!node) return;
    // A tap that ended a text selection was aimed at the text, not the message.
    if (window.getSelection?.().toString()) return;
    const open = node.classList.contains('msg--open');
    for (const other of messages.querySelectorAll('.msg--open')) {
      other.classList.remove('msg--open');
      renderActions(other);
    }
    if (!open) node.classList.add('msg--open');
    renderActions(node);
  });

  const onEvent = ({ detail }) => {
    if (disposed) return;
    const { type, session_id: sessionId, payload = {} } = detail;
    // Events are addressed to a live handle, so an unattached thread is deaf by
    // definition: while we hold none, every event on the socket belongs to some
    // other thread -- typically one left mid-turn -- and painting it here would
    // put another conversation's reply in this transcript.
    if (!liveId || (sessionId && sessionId !== liveId)) return;
    switch (type) {
      case 'message.start':
        assistantText = '';
        assistantNode ||= append(messages, 'assistant', '');
        break;
      case 'message.delta':
        assistantText += payload.text || '';
        assistantNode ||= append(messages, 'assistant', '');
        setText(assistantNode, assistantText);
        break;
      case 'message.interim':
        if (payload.text) {
          assistantText = payload.text;
          assistantNode ||= append(messages, 'assistant', '');
          setText(assistantNode, assistantText);
        }
        break;
      case 'message.complete': {
        const finalText = payload.text || assistantText;
        assistantNode ||= append(messages, 'assistant', '');
        setText(assistantNode, finalText || '(no visible response)');
        if (payload.status === 'interrupted') systemLine(messages, 'Interrupted');
        assistantNode = null;
        assistantText = '';
        running = false;
        startedAt = null;
        break;
      }
      case 'error':
        systemLine(messages, payload.message || 'Hermes returned an error');
        assistantNode = null;
        running = false;
        startedAt = null;
        break;
      default:
        break;
    }
    follow();
  };
  socket.addEventListener('event', onEvent);

  // The live handle belongs to the socket that opened it, so a drop always
  // invalidates it. The *thread* survives on the host (see the note at the top
  // of this file), so on the way back we rebind rather than going deaf until
  // the user happens to send again — a turn that kept running while the phone
  // was locked has to stream here again, not finish into a view nobody told.
  let wasAttached = false;

  const onConnection = ({ detail }) => {
    if (disposed) return;
    if (detail.state !== 'live') {
      wasAttached = Boolean(liveId);
      liveId = null;
      running = false;
      startedAt = null;
      // A placeholder with nothing in it is a typing dot for a reply that can
      // no longer arrive on this connection.
      if (assistantNode && !assistantText) {
        assistantNode.remove();
        assistantNode = null;
      }
      if (state.sessionId) update({ sessionId: null });
      renderActivity();
      return;
    }
    // Queued text is the user having already decided to send, so it is worth an
    // attach on its own -- including for a draft, which has no thread to rebind.
    if ((wasAttached && threadId) || outboxFor(threadId).length) {
      wasAttached = false;
      reattach();
    }
  };
  socket.addEventListener('state', onConnection);

  /**
   * Rebind after a reconnect, catch the transcript up on whatever landed while
   * we were away, then send anything that was composed offline. Failure is not
   * fatal: the queue keeps until the next reconnect and the next send takes the
   * ordinary cold-start path.
   */
  async function reattach() {
    try {
      await attach();
      if (!disposed) await load();
    } catch {
      liveId = null;
      return;
    }
    if (!disposed) await flushOutbox();
  }

  /**
   * Send everything the outbox holds for this thread, oldest first.
   *
   * Called only once a live handle exists (see reattach): a flush that raced
   * the reattach would submit against the handle from the connection that just
   * dropped, and the gateway would answer an id nobody is listening to.
   */
  async function flushOutbox() {
    if (flushing || disposed) return;
    flushing = true;
    let sent = 0;
    try {
      for (const entry of outboxFor(threadId)) {
        if (disposed || !socket.connected) break;
        // An entry needing a deliberate resend (an uncertain submit, or three
        // deterministic refusals -- see below) must not be retried on its
        // own, and nothing behind it may jump ahead either: the outbox stays
        // strictly ordered, the same as any other failure below.
        if (entry.uncertain || entry.failed) break;
        const node = queuedNodes.get(entry.id);
        // Split from prompt.submit below so an unknown-outcome rejection
        // (see outcomeUnknown) from *this* call can never be mistaken for one
        // from the submit itself -- attach() failing means the prompt never
        // reached the wire, which is always safe to leave for the next flush.
        let sessionId;
        try {
          // Attaching here as well as in reattach() covers the draft case: a
          // thread minted by the first entry is what the rest are sent into.
          sessionId = await attach();
        } catch (error) {
          if (socket.connected && node) fail(node, error.message);
          break;
        }
        try {
          markOutboxSubmitted(entry.id);
          await socket.call('prompt.submit', { session_id: sessionId, text: entry.text });
        } catch (error) {
          if (outcomeUnknown(error)) {
            // Sent before the drop, or answered too late to tell -- outcome
            // unknown either way. See deliver()'s catch for why this has to
            // wait for the reader rather than retry itself into a possible
            // duplicate turn.
            markOutboxUncertain(entry.id);
            if (node) paintEntry(node, entry);
          } else {
            // A real refusal, not a dropped pipe: safe to retry, but not
            // forever -- see markOutboxDeterministicFailure.
            const updated = markOutboxDeterministicFailure(entry.id);
            if (socket.connected && node) {
              if (updated?.failed) paintEntry(node, updated);
              else fail(node, error.message);
            }
          }
          break;
        }
        dequeueMessage(entry.id);
        release(node);
        sent += 1;
      }
    } finally {
      flushing = false;
    }
    if (!sent || disposed) return;
    running = true;
    startedAt = Date.now();
    assistantText = '';
    assistantNode = append(messages, 'assistant', '');
    follow();
    renderActivity();
  }

  const renderActivity = () => {
    if (disposed) return;
    send.disabled = !input.value.trim() || running;
    if (!running) {
      activity.hidden = true;
      return;
    }
    const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    activity.hidden = false;
    clear(activity).append(
      el('span', { class: 'dot dot--running' }),
      el('span', { class: 'mono' }, state.activity || 'working'),
      el('span', { class: 'activity-time mono' }, duration(elapsed)),
    );
  };
  const ticker = setInterval(renderActivity, 500);
  renderActivity();

  root.dispose = () => {
    disposed = true;
    clearInterval(ticker);
    controller?.abort();
    socket.removeEventListener('event', onEvent);
    socket.removeEventListener('state', onConnection);
    // The live handle stays attached on the host: a turn left running keeps
    // streaming into the DB, and the transcript is re-read on the way back in.
  };
  return root;
}

function welcome() {
  return el(
    'div',
    { class: 'welcome' },
    el('h1', {}, 'What can I help you do?'),
    el('p', {}, 'This is a private conversation with the Hermes agent running on your machine.'),
  );
}

// Neither of these scrolls: whether new content should pull the view down is
// the caller's call, and for anything the agent said it depends on where the
// reader is. See follow().
function append(container, role, text) {
  const node = el(
    'article',
    { class: `msg msg--${role}` },
    el('div', { class: role === 'user' ? 'bubble' : 'prose' }),
  );
  container.append(node);
  setText(node, text);
  return node;
}

function setText(node, text) {
  node.dataset.text = text;
  const target = node.firstElementChild;
  if (node.classList.contains('msg--user')) target.textContent = text;
  else if (text) target.innerHTML = renderMarkdown(text);
  else target.replaceChildren(el('span', { class: 'typing' }, el('i'), el('i'), el('i')));
}

function systemLine(container, text) {
  container.append(el('div', { class: 'system-line' }, text));
}

function scrollDown(container) {
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}
