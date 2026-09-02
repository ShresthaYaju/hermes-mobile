// Live state shared between the socket and the views.
//
// Scope note: the gateway delivers events only for sessions this app created
// or activated. Telegram and cron work runs in other processes and is
// invisible here -- those surfaces poll REST instead. So everything in this
// store is about *our own* session.

import { socket } from './rpc.js';

const listeners = new Set();

export const state = {
  connection: 'idle',
  /** Pending approval requests, oldest first. Queued, never overwritten. */
  approvals: [],
  /** What the agent is doing right now, for the activity bar. */
  activity: null,
  /** Live gateway handle for the chat we are attached to, if any. */
  sessionId: null,
  /** Durable thread (state.db session) that handle is bound to. */
  threadId: null,
  /** Messages composed with no socket to send them on, oldest first. */
  outbox: [],
  running: false,
  turnStartedAt: null,
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

export function update(patch) {
  Object.assign(state, patch);
  emit();
}

export function addApproval(payload) {
  // request_id is what disambiguates concurrent prompts. Without it a second
  // request would silently replace the first and hang the agent.
  const id = payload.request_id ?? `anon-${Date.now()}`;
  if (state.approvals.some((a) => a.id === id)) return;
  state.approvals.push({ id, payload, receivedAt: Date.now() });
  emit();
}

export function removeApproval(id) {
  const index = state.approvals.findIndex((a) => a.id === id);
  if (index >= 0) {
    state.approvals.splice(index, 1);
    emit();
  }
}

export function clearApprovals() {
  if (!state.approvals.length) return;
  state.approvals.length = 0;
  emit();
}

// ---------------------------------------------------------------- outbox --
//
// Text typed with no socket to send it on. It lives here rather than in the
// chat view because the view is disposed on every tab switch and the socket
// drops every time the phone locks -- a queue in either would lose exactly the
// message it exists to protect. It is persisted for the same reason one step
// further out: an installed PWA is killed by the OS, not by the user.
//
// Entries carry the THREAD id, never the live handle: the handle belongs to the
// connection that just died. A draft has no thread yet, so its entries start
// unbound, and adoptQueued() moves them onto the thread their first send mints.

const OUTBOX_KEY = 'hermes.outbox.v1';
let outboxCounter = 0;

// Safari in private mode throws on the property access itself, not just on use.
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function restoreOutbox() {
  try {
    const raw = storage()?.getItem(OUTBOX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.text === 'string' && entry.id)
      .map((entry) => {
        const restored = {
          attempts: 0,
          submitted: false,
          uncertain: false,
          failed: false,
          ...entry,
          // Anything found in storage necessarily persisted, whatever it was
          // stamped with when it was queued.
          durable: true,
        };
        // markOutboxSubmitted() persists `submitted: true` *before*
        // prompt.submit resolves -- that is the whole point, it has to
        // survive a drop mid-call. But it also means a reload or a killed
        // tab can catch an entry mid-flight: nothing observed how that call
        // ended. That is exactly as unknown as a 'Connection closed'
        // rejection would have left it, so it is restored the same way --
        // unless it had already reached the 3-strike cap, which is a known
        // (not unknown) outcome.
        if (restored.submitted && !restored.failed) restored.uncertain = true;
        return restored;
      });
  } catch {
    return [];
  }
}

/** Returns whether the write actually reached storage, so a caller can tell a
 *  durable queue from one that only lives as long as this tab does. */
function persistOutbox() {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(OUTBOX_KEY, JSON.stringify(state.outbox));
    return true;
  } catch {
    // Quota or a locked-down browser. The in-memory queue still holds, so the
    // message survives everything except closing the tab.
    return false;
  }
}

state.outbox = restoreOutbox();

/** Hold `text` for `threadId` (null while the thread is still a draft). */
export function queueMessage(threadId, text) {
  const entry = {
    id: `q${Date.now().toString(36)}${(outboxCounter += 1).toString(36)}`,
    threadId: threadId || null,
    text,
    queuedAt: Date.now(),
    // attempts/submitted/uncertain/failed together decide what a reconnect is
    // allowed to do with this entry automatically -- see flushOutbox() in
    // chat.js. submitted only ever means "a prompt.submit for this entry
    // actually reached the wire", never "attach() ran".
    attempts: 0,
    submitted: false,
    uncertain: false,
    failed: false,
  };
  state.outbox.push(entry);
  entry.durable = persistOutbox();
  emit();
  return entry;
}

/** The wire has this entry's prompt.submit in flight (or just resolved). */
export function markOutboxSubmitted(id) {
  const entry = state.outbox.find((e) => e.id === id);
  if (!entry) return null;
  entry.submitted = true;
  persistOutbox();
  emit();
  return entry;
}

/**
 * A submitted entry's socket dropped before the response arrived: the
 * gateway may already have the prompt. Outcome unknown, so this entry must
 * wait for a deliberate resend rather than being retried by the next
 * reconnect -- resubmitting a prompt that is already running would double it.
 */
export function markOutboxUncertain(id) {
  const entry = state.outbox.find((e) => e.id === id);
  if (!entry) return null;
  entry.uncertain = true;
  persistOutbox();
  emit();
  return entry;
}

/**
 * A rejection that is *not* 'Connection closed' -- the call itself refused,
 * or the gateway did. Unlike an uncertain entry this one definitely did not
 * go through, so auto-retrying it is safe -- but only up to a point, since a
 * refusal that keeps recurring (a stale session, a malformed prompt) would
 * otherwise retry forever on every reconnect. The third strike requires a
 * deliberate resend, same as an uncertain entry.
 */
export function markOutboxDeterministicFailure(id) {
  const entry = state.outbox.find((e) => e.id === id);
  if (!entry) return null;
  entry.attempts += 1;
  if (entry.attempts >= 3) entry.failed = true;
  persistOutbox();
  emit();
  return entry;
}

/** Clear a stuck entry's block and give it a fresh retry budget, for the
 *  explicit tap that is the only thing allowed to do so. */
export function resetOutboxIssue(id) {
  const entry = state.outbox.find((e) => e.id === id);
  if (!entry) return null;
  entry.uncertain = false;
  entry.failed = false;
  entry.attempts = 0;
  persistOutbox();
  emit();
  return entry;
}

/** Everything waiting for one thread, oldest first. */
export function outboxFor(threadId) {
  const key = threadId || null;
  return state.outbox.filter((entry) => entry.threadId === key);
}

/** Drop one entry. Callers do this only once the gateway has taken it. */
export function dequeueMessage(id) {
  const index = state.outbox.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  state.outbox.splice(index, 1);
  persistOutbox();
  emit();
}

/** Bind everything queued before a thread existed to the thread now minted. */
export function adoptQueued(threadId) {
  if (!threadId) return;
  let changed = false;
  for (const entry of state.outbox) {
    if (entry.threadId === null) {
      entry.threadId = threadId;
      changed = true;
    }
  }
  if (!changed) return;
  persistOutbox();
  emit();
}

socket.addEventListener('state', ({ detail }) => {
  update({ connection: detail.state });
  if (detail.state !== 'live') {
    // A dropped socket means any pending prompt is unanswerable: the request
    // ids belonged to that connection. The outbox deliberately does not go with
    // them -- its entries are addressed to threads, which outlive the socket.
    clearApprovals();
    update({ running: false, activity: null });
  }
});

socket.addEventListener('event', ({ detail }) => {
  const { type, session_id: sessionId, payload = {} } = detail;
  switch (type) {
    // The live handle an approval answers to is the one the event arrived on,
    // not necessarily the chat view's current one -- a reconnect can swap
    // state.sessionId out from under a card still on screen. Stamping it here
    // is what lets now.js answer against the request's own session instead.
    case 'approval.request':
      addApproval({ ...payload, session_id: sessionId });
      break;
    case 'clarify.request':
      addApproval({ ...payload, session_id: sessionId, kind: 'clarify' });
      break;
    case 'message.start':
      update({ running: true, activity: 'thinking', turnStartedAt: Date.now() });
      break;
    case 'tool.start':
      update({ running: true, activity: payload.name || payload.tool || 'working' });
      break;
    case 'tool.complete':
      update({ activity: 'thinking' });
      break;
    case 'status.update':
      update({ activity: payload.text || state.activity });
      break;
    case 'message.complete':
      update({ running: false, activity: null, turnStartedAt: null });
      break;
    case 'error':
      update({ running: false, activity: null });
      break;
    default:
      break;
  }
});
