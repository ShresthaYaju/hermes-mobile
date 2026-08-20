// Work -- scheduled jobs. For an always-on agent these are the real unit of
// work, so they get top-level placement rather than hiding in settings.

import { api } from '../lib/api.js';
import {
  el,
  clear,
  spinner,
  errorState,
  emptyState,
  relativeTime,
  jobStatus,
  statusDot,
  scheduleText,
  toast,
} from '../lib/ui.js';
import { navigate } from '../lib/router.js';

export function workView() {
  const root = el('div', { class: 'view' });
  const list = el('div', { class: 'list' }, spinner('Loading schedules'));
  // A reader gets one sentence when this reloads, not the whole list back
  // again. What changes here that you would want interrupting for is a job
  // going from fine to failing, and that is what the sentence carries.
  const summary = el('p', { class: 'sr-only', role: 'status' });
  root.append(el('h2', { class: 'section-title' }, 'Schedules'), summary, list);

  let disposed = false;
  let controller;
  let summaryText = '';
  let listKey = null;

  async function load() {
    controller?.abort();
    const mine = (controller = new AbortController());
    list.setAttribute('aria-busy', 'true');
    try {
      const found = await api.cronJobs(mine.signal);
      if (disposed) return;
      const jobs = Array.isArray(found) ? found : [];
      // Rebuilding the cards on every poll threw away the row a keyboard had
      // focus on, and could swap a Run now button out from under a tap.
      const key = listDigest(jobs);
      if (key !== listKey) {
        listKey = key;
        renderJobs(list, jobs, load);
      }
      const text = summarise(jobs);
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

  load();
  const poller = setInterval(load, 30000);
  root.refresh = load;
  root.dispose = () => {
    disposed = true;
    clearInterval(poller);
    controller?.abort();
  };
  return root;
}

/** Everything a card puts on screen, so the poll can tell a change from a repeat. */
function listDigest(jobs) {
  return JSON.stringify(
    jobs.map((job) => {
      const status = jobStatus(job);
      return [
        job.id,
        job.name || '',
        status.key,
        status.detail,
        scheduleText(job).text,
        job.next_run_at ? relativeTime(job.next_run_at) : '',
      ];
    }),
  );
}

function summarise(jobs) {
  if (!jobs.length) return 'No scheduled jobs.';
  const failing = jobs.filter((job) => jobStatus(job).key === 'error').length;
  const paused = jobs.filter((job) => jobStatus(job).key === 'paused').length;
  const parts = [`${jobs.length} scheduled ${jobs.length === 1 ? 'job' : 'jobs'}`];
  if (failing) parts.push(`${failing} failing`);
  if (paused) parts.push(`${paused} paused`);
  return `${parts.join(', ')}.`;
}

function renderJobs(node, jobs, reload) {
  clear(node);
  if (!jobs.length) {
    node.append(emptyState('No scheduled jobs.'));
    return;
  }
  const sorted = [...jobs].sort((a, b) => {
    const rank = (job) =>
      jobStatus(job).key === 'error' ? 0 : jobStatus(job).key === 'warn' ? 1 : 2;
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });

  for (const job of sorted) {
    const status = jobStatus(job);
    node.append(
      el(
        'div',
        { class: 'card job' },
        el(
          'button',
          {
            class: 'row row--tappable',
            onclick: () => navigate(`#/job/${encodeURIComponent(job.id)}`),
          },
          statusDot(status.key),
          el(
            'div',
            { class: 'row-main' },
            el('div', { class: 'row-title' }, job.name || job.id),
            // The dot is the only thing carrying the state visually, and it is
            // decorative to a reader. Say it in words instead.
            el('span', { class: 'sr-only' }, `Status: ${status.label}. `),
            scheduleLine(job, status),
            status.detail
              ? el('div', { class: `row-sub row-sub--${status.key}` }, truncate(status.detail, 90))
              : null,
          ),
        ),
        jobActions(job, status, reload),
      ),
    );
  }
}

/**
 * The schedule, in English where we can read the expression. Only an
 * unrecognised expression stays monospaced -- at that point it is machine text
 * being shown verbatim, and should look like it.
 */
function scheduleLine(job, status) {
  const schedule = scheduleText(job);
  const next =
    job.next_run_at && status.key !== 'paused' ? ` · next ${relativeTime(job.next_run_at)}` : '';
  return el('div', { class: `row-sub ${schedule.humanised ? '' : 'mono'}` }, schedule.text, next);
}

function jobActions(job, status, reload) {
  const bar = el('div', { class: 'job-actions' });
  const paused = status.key === 'paused';
  const name = job.name || job.id;

  // Every card carries the same two words, so out of context -- which is how a
  // reader moves through a list of controls -- they need the job named.
  const run = el('button', { class: 'btn btn--small', 'aria-label': `Run ${name} now` }, 'Run now');
  run.addEventListener('click', async () => {
    // trigger only stamps next_run_at=now; the ticker sleeps 60s between
    // passes, so promising an immediate run would be a lie.
    await act(run, () => api.triggerJob(job.id), 'Queued — runs within a minute', reload);
  });

  const toggle = el(
    'button',
    { class: 'btn btn--small', 'aria-label': `${paused ? 'Resume' : 'Pause'} ${name}` },
    paused ? 'Resume' : 'Pause',
  );
  toggle.addEventListener('click', async () => {
    await act(
      toggle,
      () => (paused ? api.resumeJob(job.id) : api.pauseJob(job.id)),
      paused ? 'Resumed' : 'Paused',
      reload,
    );
  });

  bar.append(run, toggle);
  return bar;
}

async function act(button, fn, successMessage, reload) {
  const original = button.textContent;
  button.disabled = true;
  // The label is what a reader has; only the visible text becomes the spinner.
  button.setAttribute('aria-busy', 'true');
  button.textContent = '…';
  try {
    await fn();
    toast(successMessage);
    await reload();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    // The list only rebuilds when something about it visibly changed, and
    // "Run now" often changes nothing you can see -- so this can still be the
    // same node afterwards, and has to be handed back usable either way.
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

const truncate = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
