// Job detail -- schedule, prompt, and run history for one scheduled job.

import { api } from '../lib/api.js';
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
  scheduleText,
  toast,
} from '../lib/ui.js';
import { navigate, back } from '../lib/router.js';

export function jobView({ id }) {
  const root = el('div', { class: 'view view--detail' });
  const header = el('header', { class: 'detail-head' });
  const body = el('div', { class: 'detail-body' }, spinner('Loading job'));
  root.append(header, body);

  let disposed = false;
  let controller;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [jobs, runs] = await Promise.all([
        api.cronJobs(signal),
        api.cronRuns(id, signal).catch(() => ({ runs: [] })),
      ]);
      if (disposed) return;
      const job = (Array.isArray(jobs) ? jobs : []).find((candidate) => candidate.id === id);
      if (!job) {
        // Repeat-limited and one-shot jobs are popped from the store when they
        // finish, leaving no tombstone.
        clear(body).append(
          emptyState(
            'This job no longer exists.',
            'Jobs with a repeat limit remove themselves once complete.',
          ),
        );
        renderHeader(header, null);
        return;
      }
      renderHeader(header, job);
      renderBody(body, job, runs?.runs || [], load);
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

function renderHeader(node, job) {
  clear(node);
  node.append(
    el('button', { class: 'icon-btn', onclick: () => back('#/work'), 'aria-label': 'Back' }, '‹'),
    el('div', { class: 'detail-title' }, job?.name || 'Job'),
  );
}

function renderBody(node, job, runs, reload) {
  clear(node);
  const status = jobStatus(job);
  const schedule = scheduleText(job);

  node.append(
    el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        statusDot(status.key),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title' }, status.label),
          status.detail
            ? el('div', { class: 'row-sub row-sub--' + status.key }, status.detail)
            : null,
        ),
      ),
      kv('Schedule', schedule.text || '—', !schedule.humanised),
      // Keep the expression visible underneath: it is what you would edit, and
      // the English above is this app's reading of it, not the source of truth.
      schedule.humanised ? el('div', { class: 'kv-aside mono' }, schedule.raw) : null,
      kv(
        'Next run',
        status.key === 'paused'
          ? 'paused'
          : job.next_run_at
            ? `${clockTime(job.next_run_at)} · ${relativeTime(job.next_run_at)}`
            : '—',
      ),
      kv(
        'Last run',
        job.last_run_at
          ? `${clockTime(job.last_run_at)} · ${relativeTime(job.last_run_at)}`
          : 'never',
      ),
      kv('Delivers to', job.deliver || 'local', true),
      job.deliver === 'local'
        ? el(
            'p',
            { class: 'note' },
            'Delivery is “local”: results are saved on the host but not sent anywhere, so failures are silent.',
          )
        : null,
      // Controls belong to the job the card describes, so they live in it: the
      // actions as its footer, the prompt as one more row that opens.
      actionBar(job, status, reload),
      promptEditor(job, reload),
    ),
  );

  const history = el(
    'section',
    { class: 'section' },
    el('h2', { class: 'section-title' }, 'Run history'),
  );
  if (!runs.length) {
    history.append(emptyState('No recorded runs yet.'));
  } else {
    for (const run of runs) {
      const failed = run.end_reason && run.end_reason !== 'cron_complete';
      history.append(
        el(
          'div',
          {
            class: 'card row row--tappable',
            onclick: () => navigate(`#/session/${encodeURIComponent(run.id)}`),
          },
          statusDot(failed ? 'error' : 'ok'),
          el(
            'div',
            { class: 'row-main' },
            el('div', { class: 'row-title' }, clockTime(run.started_at) || run.id),
            el(
              'div',
              { class: 'row-sub' },
              `${run.message_count ?? 0} messages`,
              run.tool_call_count ? ` · ${run.tool_call_count} tools` : '',
            ),
          ),
          el('span', { class: 'row-meta' }, relativeTime(run.started_at)),
        ),
      );
    }
  }
  node.append(history);
}

function actionBar(job, status, reload) {
  const paused = status.key === 'paused';
  const run = el('button', { class: 'btn btn--primary' }, 'Run now');
  const toggle = el('button', { class: 'btn' }, paused ? 'Resume' : 'Pause');

  run.addEventListener('click', () =>
    guard(run, () => api.triggerJob(job.id), 'Queued — runs within a minute', reload),
  );
  toggle.addEventListener('click', () =>
    guard(
      toggle,
      () => (paused ? api.resumeJob(job.id) : api.pauseJob(job.id)),
      paused ? 'Resumed' : 'Paused',
      reload,
    ),
  );

  return el('div', { class: 'job-actions' }, run, toggle);
}

// Whether the prompt is folded open. Module scope so a save-and-reload — or a
// trip to a run transcript and back — does not snap it shut under the reader.
let promptOpen = false;

// Cron prompts carry operational policy ("NEVER submit an application"), so
// the editor is full-height and monospaced rather than a one-line field, and
// the save is explicit. A page of policy text also buries the run history, so
// the editor folds away: closed it is one row of the detail card reading
// "Prompt", labelled like the key/value rows above it.
function promptEditor(job, reload) {
  const textarea = el('textarea', { class: 'textarea mono', rows: '10', spellcheck: 'false' });
  textarea.value = job.prompt || '';
  const save = el('button', { class: 'btn btn--primary', disabled: true }, 'Save prompt');
  const revert = el('button', { class: 'btn', disabled: true }, 'Revert');

  const fold = el('details', { class: 'fold' });
  fold.open = promptOpen;
  fold.addEventListener('toggle', () => {
    promptOpen = fold.open;
  });

  const sync = () => {
    const changed = textarea.value !== (job.prompt || '');
    save.disabled = !changed;
    revert.disabled = !changed;
    // Folding hides the Save button, so the closed row has to admit there are
    // unsaved edits underneath it.
    fold.classList.toggle('fold--dirty', changed);
  };
  textarea.addEventListener('input', sync);
  revert.addEventListener('click', () => {
    textarea.value = job.prompt || '';
    sync();
  });
  save.addEventListener('click', () =>
    guard(save, () => api.updateJob(job.id, { prompt: textarea.value }), 'Prompt saved', reload),
  );

  fold.append(
    el(
      'summary',
      { class: 'fold-head' },
      el('span', { class: 'fold-title' }, 'Prompt'),
      el('span', { class: 'fold-flag' }, 'unsaved'),
      el('span', { class: 'fold-chevron' }),
    ),
    el('div', { class: 'fold-body' }, textarea, el('div', { class: 'action-bar' }, save, revert)),
  );
  return fold;
}

async function guard(button, fn, successMessage, reload) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    await fn();
    toast(successMessage);
    await reload();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}

function kv(label, value, mono = false) {
  return el(
    'div',
    { class: 'kv' },
    el('span', { class: 'kv-key' }, label),
    el('span', { class: `kv-value ${mono ? 'mono' : ''}` }, value),
  );
}
