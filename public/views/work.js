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
  toast,
} from '../lib/ui.js';
import { navigate } from '../lib/router.js';

export function workView() {
  const root = el('div', { class: 'view' });
  const list = el('div', { class: 'list' }, spinner('Loading schedules'));
  root.append(el('h2', { class: 'section-title' }, 'Schedules'), list);

  let disposed = false;
  let controller;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    try {
      const jobs = await api.cronJobs(controller.signal);
      if (disposed) return;
      renderJobs(list, Array.isArray(jobs) ? jobs : [], load);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      clear(list).append(errorState(error, load));
    }
  }

  load();
  const poller = setInterval(load, 30000);
  root.dispose = () => {
    disposed = true;
    clearInterval(poller);
    controller?.abort();
  };
  return root;
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
          'div',
          {
            class: 'row row--tappable',
            onclick: () => navigate(`#/job/${encodeURIComponent(job.id)}`),
          },
          statusDot(status.key),
          el(
            'div',
            { class: 'row-main' },
            el('div', { class: 'row-title' }, job.name || job.id),
            el(
              'div',
              { class: 'row-sub mono' },
              job.schedule?.display || job.schedule_display || '',
              job.next_run_at && status.key !== 'paused'
                ? ` · next ${relativeTime(job.next_run_at)}`
                : '',
            ),
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

function jobActions(job, status, reload) {
  const bar = el('div', { class: 'job-actions' });
  const paused = status.key === 'paused';

  const run = el('button', { class: 'btn btn--small' }, 'Run now');
  run.addEventListener('click', async () => {
    // trigger only stamps next_run_at=now; the ticker sleeps 60s between
    // passes, so promising an immediate run would be a lie.
    await act(run, () => api.triggerJob(job.id), 'Queued — runs within a minute', reload);
  });

  const toggle = el('button', { class: 'btn btn--small' }, paused ? 'Resume' : 'Pause');
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

const truncate = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
