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
    return parsed.filter((entry) => entry && typeof entry.text === 'string' && entry.id);
  } catch {
    return [];
  }
}

function persistOutbox() {
  try {
    storage()?.setItem(OUTBOX_KEY, JSON.stringify(state.outbox));
  } catch {
    // Quota or a locked-down browser. The in-memory queue still holds, so the
    // message survives everything except closing the tab.
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
  };
  state.outbox.push(entry);
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
  const { type, payload = {} } = detail;
  switch (type) {
    case 'approval.request':
      addApproval(payload);
      break;
    case 'clarify.request':
      addApproval({ ...payload, kind: 'clarify' });
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
