// Now -- the home surface. Answers, in order: is the agent alive, does it need
// me, what is running, what happened recently.

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

export function nowView() {
  const root = el('div', { class: 'view' });
  const gateway = el('section', { class: 'card card--gateway' }, spinner('Checking gateway'));
  const needs = el('section', { class: 'section' });
  const running = el('section', { class: 'section' });
  const recent = el('section', { class: 'section' });
  root.append(gateway, needs, running, recent);

  let disposed = false;
  let controller;

  const renderApprovals = () => {
    clear(needs);
    if (!state.approvals.length) return;
    needs.append(
      el(
        'h2',
        { class: 'section-title section-title--alert' },
        'Needs you',
        el('span', { class: 'count' }, String(state.approvals.length)),
      ),
    );
    for (const approval of state.approvals) needs.append(approvalCard(approval));
  };

  const renderActivity = () => {
    clear(running);
    if (!state.running && !state.activity) return;
    const elapsed = state.turnStartedAt ? (Date.now() - state.turnStartedAt) / 1000 : 0;
    running.append(
      el('h2', { class: 'section-title' }, 'Running'),
      el(
        'div',
        { class: 'card row row--tappable', onclick: () => navigate('#/chat') },
        statusDot('running'),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title' }, 'This conversation'),
          el(
            'div',
            { class: 'row-sub mono' },
            state.activity || 'working',
            ' · ',
            duration(elapsed),
          ),
        ),
        el(
          'button',
          {
            class: 'btn btn--stop',
            onclick: (event) => {
              event.stopPropagation();
              stopTurn();
            },
          },
          'Stop',
        ),
      ),
    );
  };

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
      renderGateway(gateway, status);
      renderRecent(recent, Array.isArray(jobs) ? jobs : []);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
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
      '⚠',
      el('span', {}, isClarify ? 'Needs an answer' : 'Allow this?'),
    ),
    el('pre', { class: 'approval-command mono' }, command),
  );

  if (isClarify) {
    const input = el('input', { class: 'input', placeholder: 'Your answer', autocomplete: 'off' });
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
      await socket.call(method, { session_id: state.sessionId, ...params });
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
  const platforms = Object.entries(status.gateway_platforms || {});
  const connected = platforms.filter(([, p]) => p?.state === 'connected').map(([name]) => name);
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

function renderRecent(node, jobs) {
  clear(node);
  const withRuns = jobs
    .filter((job) => job.last_run_at)
    .sort((a, b) => new Date(b.last_run_at) - new Date(a.last_run_at))
    .slice(0, 6);

  node.append(el('h2', { class: 'section-title' }, 'Recent scheduled runs'));
  if (!withRuns.length) {
    node.append(emptyState('Nothing has run yet.'));
    return;
  }
  for (const job of withRuns) {
    const status = jobStatus(job);
    node.append(
      el(
        'div',
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
