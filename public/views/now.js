// Now -- the home surface. Answers, in order: is the agent alive, does it need
// me, what is running, what happened recently.
//
// Three of those four change with nobody touching the phone, so this view is
// also where the screen-reader story matters most. The rule followed here: a
// live region only ever gets a DOM write when the thing it describes actually
// changed. Re-rendering identical content into one makes a reader say it all
// again, and this view used to rebuild its approvals on every activity tick.

import { api } from '../lib/api.js';
import { socket } from '../lib/rpc.js';
import { state, subscribe, removeApproval } from '../lib/store.js';
import {
  el,
  clear,
  spinner,
  errorState,
  emptyState,
  relativeTime,
  clockTime,
  jobStatus,
  statusDot,
  sessionTitle,
  sourceGlyph,
  toast,
  duration,
} from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { clip } from '../lib/transcript.js';

// A command is shown in full up to this length. Past it, an approval with
// hundreds of newlines (a heredoc, a generated script) would push Allow/Deny
// below the fold with nothing on screen saying why -- the one card in this
// app a reader must always be able to act on immediately.
const COMMAND_CLIP = 2000;

export function nowView() {
  const root = el('div', { class: 'view' });
  const gateway = el(
    'section',
    { class: 'card card--gateway', role: 'status', 'aria-label': 'Gateway' },
    spinner('Checking gateway'),
  );

  // The heading stays put and only the cards live inside the region, so the
  // name the region is announced under cannot vanish mid-announcement.
  const needs = el('section', { class: 'section', 'aria-labelledby': 'now-needs-title' });
  // Named from the start, so the region has an accessible name even while it
  // is empty and the heading is hidden.
  const needsTitle = el(
    'h2',
    { class: 'section-title section-title--alert', id: 'now-needs-title' },
    'Needs you',
  );
  const needsList = el('div', { class: 'list', 'aria-live': 'assertive' });
  needsTitle.hidden = true;
  needs.append(needsTitle, needsList);

  const running = el('section', { class: 'section' });
  // Only the edges of a turn are worth speaking. The tool-by-tool detail on
  // the card below changes several times a minute and would bury everything
  // else the reader is being told.
  const activityStatus = el('p', { class: 'sr-only', role: 'status' });
  const recent = el('section', { class: 'section' });
  root.append(gateway, needs, running, activityStatus, recent);

  let disposed = false;
  let controller;
  let approvalsKey = null;
  let gatewayKey = null;
  let recentKey = null;
  let activityKey = null;
  let elapsed = null;

  const renderApprovals = () => {
    // The store emits on every activity tick. Rebuilding these cards each time
    // repeated the pending request to a reader every few seconds and wiped
    // whatever had been typed into a clarify answer, so only a change to the
    // set of open requests is allowed through.
    const key = state.approvals.map((approval) => approval.id).join(' ');
    if (key === approvalsKey) return;
    approvalsKey = key;

    clear(needsList);
    needsTitle.hidden = !state.approvals.length;
    if (!state.approvals.length) return;
    clear(needsTitle).append(
      'Needs you',
      el('span', { class: 'count', 'aria-hidden': 'true' }, String(state.approvals.length)),
      el('span', { class: 'sr-only' }, `, ${state.approvals.length} pending`),
    );
    for (const approval of state.approvals) needsList.append(approvalCard(approval));
  };

  const renderActivity = () => {
    const active = Boolean(state.running || state.activity);
    const key = active ? state.activity || 'working' : '';
    if (key !== activityKey) {
      const wasActive = Boolean(activityKey);
      activityKey = key;
      clear(running);
      elapsed = active ? el('span', { class: 'row-elapsed mono' }) : null;
      if (active) running.append(el('h2', { class: 'section-title' }, 'Running'), activityCard());
      if (active !== wasActive) {
        activityStatus.textContent = active ? 'The agent is working' : 'The agent has stopped';
      }
    }
    // Kept out of the live region above: a duration that ticks every second is
    // the one thing a reader must never be given.
    if (elapsed) {
      elapsed.textContent = duration(
        state.turnStartedAt ? (Date.now() - state.turnStartedAt) / 1000 : 0,
      );
    }
  };

  const activityCard = () =>
    el(
      'div',
      { class: 'card row' },
      statusDot('running'),
      el(
        'button',
        { class: 'row-open row-main', onclick: () => navigate('#/chat') },
        el('div', { class: 'row-title' }, 'This conversation'),
        el('div', { class: 'row-sub mono' }, state.activity || 'working', ' · ', elapsed),
      ),
      el(
        'button',
        { class: 'btn btn--stop', onclick: stopTurn, 'aria-label': 'Stop the current turn' },
        'Stop',
      ),
    );

  async function stopTurn() {
    if (!state.sessionId) return;
    try {
      await socket.call('session.interrupt', { session_id: state.sessionId });
      toast('Stopping the current turn');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [status, jobs] = await Promise.all([
        api.status(signal).catch(() => null),
        api.cronJobs(signal).catch(() => []),
      ]);
      if (disposed) return;
      const key = gatewayDigest(status);
      if (key !== gatewayKey) {
        gatewayKey = key;
        renderGateway(gateway, status);
      }
      const runs = recentRuns(Array.isArray(jobs) ? jobs : []);
      // Same reason as the card above, plus one of its own: these rows are
      // buttons now, and rebuilding them drops whatever had focus.
      const runsKey = recentDigest(runs);
      if (runsKey !== recentKey) {
        recentKey = runsKey;
        renderRecent(recent, runs);
      }
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      gatewayKey = null;
      recentKey = null;
      clear(gateway).append(errorState(error, load));
    }
  }

  const unsubscribe = subscribe(() => {
    if (disposed) return;
    renderApprovals();
    renderActivity();
  });

  const ticker = setInterval(renderActivity, 1000);
  const poller = setInterval(load, 30000);

  renderApprovals();
  renderActivity();
  load();

  root.refresh = load;
  root.dispose = () => {
    disposed = true;
    unsubscribe();
    clearInterval(ticker);
    clearInterval(poller);
    controller?.abort();
  };
  return root;
}

function approvalCard({ id, payload }) {
  const isClarify = payload.kind === 'clarify';
  const command =
    payload.command || payload.message || payload.question || 'Hermes needs a decision.';
  const choices =
    Array.isArray(payload.choices) && payload.choices.length ? payload.choices : ['deny', 'once'];

  const card = el('div', { class: 'card card--approval' });
  card.append(
    el(
      'div',
      { class: 'approval-head' },
      // U+FE0E pins this to text, so the warning takes the card's colour
      // instead of arriving as a yellow emoji triangle. It is decorative: the
      // heading beside it already says what kind of card this is.
      el('span', { 'aria-hidden': 'true' }, '⚠︎'),
      el('span', {}, isClarify ? 'Needs an answer' : 'Allow this?'),
    ),
    el('pre', { class: 'approval-command mono' }, clip(command, COMMAND_CLIP)),
  );

  if (isClarify) {
    const input = el('input', {
      class: 'input',
      placeholder: 'Your answer',
      'aria-label': 'Your answer',
      autocomplete: 'off',
    });
    const respond = async () => {
      const answer = input.value.trim();
      if (!answer) return;
      await send('clarify.respond', { request_id: payload.request_id, answer });
    };
    card.append(
      el(
        'div',
        { class: 'approval-actions' },
        input,
        el('button', { class: 'btn btn--primary', onclick: respond }, 'Send'),
      ),
    );
    return card;
  }

  // Destructive verbs get the loud treatment and Allow is never the visually
  // dominant action.
  const destructive = /\b(rm|rmdir|drop|truncate|delete|--force|-f\b|shutdown|reboot|mkfs)\b/i.test(
    command,
  );
  if (destructive) card.classList.add('card--destructive');

  const actions = el('div', { class: 'approval-actions' });
  const order = ['deny', ...choices.filter((c) => c !== 'deny')];
  for (const choice of order) {
    actions.append(
      el(
        'button',
        {
          class: `btn ${choice === 'deny' ? 'btn--deny' : 'btn--allow'}`,
          onclick: () => send('approval.respond', { request_id: payload.request_id, choice }),
        },
        labelForChoice(choice),
      ),
    );
  }
  card.append(actions);
  return card;

  async function send(method, params) {
    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      // The approval names its own session (see store.js's event handler);
      // state.sessionId is only a fallback for a payload that predates that,
      // or genuinely never carried one.
      const sessionId = payload.session_id || state.sessionId;
      await socket.call(method, { session_id: sessionId, ...params });
      removeApproval(id);
    } catch (error) {
      // Keep the card on screen: a failed response must stay answerable.
      buttons.forEach((b) => (b.disabled = false));
      toast(error.message, 'error');
    }
  }
}

const CHOICE_LABELS = {
  deny: 'Deny',
  once: 'Allow once',
  session: 'Allow this session',
  always: 'Always allow',
};
const labelForChoice = (choice) => CHOICE_LABELS[choice] || choice;

const connectedPlatforms = (status) =>
  Object.entries(status.gateway_platforms || {})
    .filter(([, platform]) => platform?.state === 'connected')
    .map(([name]) => name);

/** Everything the gateway card shows, so the poll can tell a real change from a repeat. */
function gatewayDigest(status) {
  if (!status) return 'unreachable';
  return JSON.stringify([
    Boolean(status.gateway_running),
    status.version || '',
    connectedPlatforms(status),
  ]);
}

function renderGateway(node, status) {
  clear(node);
  if (!status) {
    node.append(
      statusDot('error'),
      el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, 'Gateway unreachable')),
    );
    return;
  }
  const up = Boolean(status.gateway_running);
  const connected = connectedPlatforms(status);
  node.append(
    statusDot(up ? 'ok' : 'error'),
    el(
      'div',
      { class: 'row-main' },
      el('div', { class: 'row-title' }, up ? 'Gateway up' : 'Gateway down'),
      el(
        'div',
        { class: 'row-sub mono' },
        connected.length ? connected.join(' · ') : 'no platforms connected',
        status.version ? ` · v${status.version}` : '',
      ),
    ),
  );
}

const recentRuns = (jobs) =>
  jobs
    .filter((job) => job.last_run_at)
    .sort((a, b) => new Date(b.last_run_at) - new Date(a.last_run_at))
    .slice(0, 6);

/** The rendered text of the rows, so a poll that changed nothing rebuilds nothing. */
const recentDigest = (runs) =>
  JSON.stringify(
    runs.map((job) => {
      const status = jobStatus(job);
      return [job.id, job.name || '', status.key, status.detail, relativeTime(job.last_run_at)];
    }),
  );

function renderRecent(node, withRuns) {
  clear(node);
  node.append(el('h2', { class: 'section-title' }, 'Recent scheduled runs'));
  if (!withRuns.length) {
    node.append(emptyState('Nothing has run yet.'));
    return;
  }
  for (const job of withRuns) {
    const status = jobStatus(job);
    node.append(
      el(
        'button',
        {
          class: 'card row row--tappable',
          onclick: () => navigate(`#/job/${encodeURIComponent(job.id)}`),
        },
        statusDot(status.key),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title' }, job.name || job.id),
          el(
            'div',
            { class: 'row-sub' },
            clockTime(job.last_run_at),
            ' · ',
            status.detail ? shorten(status.detail) : status.label,
          ),
        ),
        el('span', { class: 'row-meta' }, relativeTime(job.last_run_at)),
      ),
    );
  }
}

const shorten = (text) => (text.length > 52 ? `${text.slice(0, 52)}…` : text);
