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
  /** Our chat session id, if one is open. */
  sessionId: null,
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

socket.addEventListener('state', ({ detail }) => {
  update({ connection: detail.state });
  if (detail.state !== 'live') {
    // A dropped socket means any pending prompt is unanswerable: the request
    // ids belonged to that connection.
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
