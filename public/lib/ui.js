// DOM and formatting helpers. Deliberately tiny: no framework, no build step.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export function escapeHTML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Minimal markdown: fenced code, inline code, and paragraphs. Input is escaped first. */
export function renderMarkdown(text) {
  return escapeHTML(text)
    .split(/```([\s\S]*?)```/g)
    .map((block, index) =>
      index % 2
        ? `<pre><code>${block.replace(/^\w*\n/, '').trim()}</code></pre>`
        : block
            .split(/\n{2,}/)
            .filter(Boolean)
            .map(
              (paragraph) =>
                `<p>${paragraph.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`,
            )
            .join(''),
    )
    .join('');
}

// Hermes stores time in three encodings depending on the subsystem: epoch
// floats for sessions, ISO strings with an offset for cron, and bare epoch
// floats for the ticker heartbeat. Accept all of them.
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return toDate(Number(value));
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function relativeTime(value) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const future = seconds < 0;
  const n = Math.abs(seconds);
  const say = (text) => (future ? `in ${text}` : `${text} ago`);
  if (n < 45) return future ? 'soon' : 'just now';
  if (n < 5400) return say(`${Math.round(n / 60)}m`);
  if (n < 86400) return say(`${Math.round(n / 3600)}h`);
  if (n < 7 * 86400) return say(`${Math.round(n / 86400)}d`);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(value) {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ------------------------------------------------------------- schedules --
//
// Hermes's `schedule.display` is the raw crontab expression echoed back, so
// "0 9 * * *" is what reaches the phone. These turn the common shapes into
// English. Anything unrecognised falls through to the expression rather than
// being guessed at: a schedule the app describes wrongly is worse than one it
// admits it cannot read.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Expand one cron field to sorted values, or null if it uses syntax we do not read. */
function cronField(field, min, max) {
  if (field === '*') return { all: true, values: null, step: null };

  const values = new Set();
  let uniformStep = null;

  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from;
    let to;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b;
    } else {
      from = Number(range);
      to = Number(range);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      return null;
    }
    if (stepText !== undefined) uniformStep = uniformStep === null ? step : NaN;
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return {
    all: false,
    values: [...values].sort((a, b) => a - b),
    step: Number.isNaN(uniformStep) ? null : uniformStep,
  };
}

function timeOfDay(hour, minute) {
  // Locale decides 12h vs 24h; the date itself is a throwaway carrier.
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const ordinal = (n) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
};

/** Common difference of an arithmetic sequence, or null. */
function commonStep(values) {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  for (let i = 2; i < values.length; i += 1) {
    if (values[i] - values[i - 1] !== step) return null;
  }
  return step;
}

function dayPhrase(dom, month, dow) {
  const parts = [];

  if (!dow.all) {
    // Cron accepts both 0 and 7 for Sunday.
    const days = [...new Set(dow.values.map((d) => d % 7))].sort((a, b) => a - b);
    const key = days.join(',');
    if (key === '1,2,3,4,5') parts.push('Weekdays');
    else if (key === '0,6') parts.push('Weekends');
    else if (days.length === 7) parts.push('Every day');
    else parts.push(`Every ${joinList(days.map((d) => WEEKDAYS[d]))}`);
  }

  if (!dom.all) {
    const days = joinList(dom.values.map(ordinal));
    parts.push(parts.length ? `and the ${days}` : `On the ${days}`);
  }

  if (!parts.length) parts.push('Every day');
  if (!month.all) parts.push(`in ${joinList(month.values.map((m) => MONTHS[m - 1]))}`);
  return parts.join(' ');
}

/**
 * "0 9 * * *" -> "Every day at 9:00 AM". Returns null when the expression uses
 * a shape this does not describe confidently.
 *
 * `anchored` forces interval phrasings to name their first run time. Callers
 * set it when they are about to qualify the result with a timezone, because
 * "Every 4 hours, at :15 (UTC-5)" tells you nothing useful, while
 * "Every 4 hours from 12:15 AM (UTC-5)" pins the cycle to a real clock.
 */
export function describeCron(expression, { anchored = false } = {}) {
  const fields = String(expression ?? '')
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = cronField(fields[0], 0, 59);
  const hour = cronField(fields[1], 0, 23);
  const dom = cronField(fields[2], 1, 31);
  const month = cronField(fields[3], 1, 12);
  const dow = cronField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;

  const everyDay = dom.all && month.all && dow.all;

  // Sub-hourly cadences read as intervals, not as times.
  if (minute.all) return hour.all && everyDay ? 'Every minute' : null;
  if (minute.values.length > 1) {
    const step = commonStep(minute.values);
    if (!hour.all || !step || minute.values[0] !== 0 || 60 % step !== 0) return null;
    return everyDay
      ? `Every ${step} minutes`
      : `${dayPhrase(dom, month, dow)}, every ${step} minutes`;
  }

  const atMinute = minute.values[0];
  const day = dayPhrase(dom, month, dow);

  if (hour.all) {
    const hourly = `Every hour at :${String(atMinute).padStart(2, '0')}`;
    return everyDay ? hourly : `${day}, ${hourly.toLowerCase()}`;
  }

  // An hour list that steps evenly and wraps the whole day is an interval, and
  // saying so beats listing six times. "15 */4 * * *" and
  // "10 1,5,9,13,17,21 * * *" are the same cadence, one merely offset.
  const step = commonStep(hour.values);
  if (everyDay && step && step > 1 && hour.values.length === 24 / step) {
    return hour.values[0] === 0 && !anchored
      ? `Every ${step} hours, at :${String(atMinute).padStart(2, '0')}`
      : `Every ${step} hours from ${timeOfDay(hour.values[0], atMinute)}`;
  }

  if (hour.values.length > 4) return null;
  return `${day} at ${joinList(hour.values.map((h) => timeOfDay(h, atMinute)))}`;
}

/**
 * Cron runs in the host's timezone, not the phone's. When they differ, saying
 * "9:00 AM" without qualification is simply wrong, so name the offset. Derived
 * from next_run_at because the job carries no timezone field of its own.
 */
export function timezoneNote(timestamp) {
  const text = String(timestamp ?? '');
  const match = /(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  const date = toDate(text);
  if (!match || !date) return '';

  const jobMinutes =
    match[1] === 'Z'
      ? 0
      : (match[1].startsWith('-') ? -1 : 1) *
        (Number(match[1].slice(1, 3)) * 60 + Number(match[1].slice(-2)));
  const deviceMinutes = -date.getTimezoneOffset();
  if (jobMinutes === deviceMinutes) return '';

  const abs = Math.abs(jobMinutes);
  const minutes = abs % 60;
  return `UTC${jobMinutes < 0 ? '−' : '+'}${Math.floor(abs / 60)}${
    minutes ? `:${String(minutes).padStart(2, '0')}` : ''
  }`;
}

/**
 * What to show for a job's schedule: `text` is for humans and `raw` is the
 * expression, kept so a schedule we cannot phrase is still shown exactly.
 */
export function scheduleText(job) {
  const raw = job?.schedule?.expr || job?.schedule?.display || job?.schedule_display || '';
  const kind = job?.schedule?.kind;
  if (kind && kind !== 'cron') return { text: raw, raw, humanised: false };

  const zone = timezoneNote(job?.next_run_at || job?.last_run_at);
  const described = describeCron(raw, { anchored: Boolean(zone) });
  if (!described) return { text: raw, raw, humanised: false };

  // Cadences with no clock time in them -- "Every 15 minutes" -- read the same
  // in any timezone, so qualifying them would be noise.
  const needsZone = zone && /\d/.test(described.replace(/Every \d+ (minutes|hours)/, ''));
  return { text: needsZone ? `${described} · ${zone}` : described, raw, humanised: true };
}

/**
 * A cron job's health is spread across four fields. Precedence matters or the
 * list lies: a paused job is not "ok", and a delivery failure is not a run
 * failure -- the agent did its work, only the message did not arrive.
 */
export function jobStatus(job) {
  if (job.state === 'paused' || job.enabled === false) {
    return { key: 'paused', label: 'paused', detail: job.paused_reason || '' };
  }
  if (job.last_status === 'error' || job.last_error) {
    return { key: 'error', label: 'failed', detail: job.last_error || '' };
  }
  if (job.last_delivery_error) {
    return { key: 'warn', label: 'not delivered', detail: job.last_delivery_error };
  }
  if (job.state === 'error') return { key: 'error', label: 'error', detail: job.last_error || '' };
  if (!job.last_run_at) return { key: 'idle', label: 'never run', detail: '' };
  return { key: 'ok', label: 'ok', detail: '' };
}

const SOURCE_GLYPHS = {
  telegram: '✈',
  whatsapp: '◍',
  discord: '◈',
  cron: '⏱',
  subagent: '⑂',
  cli: '›',
  'web-pwa': '◐',
};
export const sourceGlyph = (source) => SOURCE_GLYPHS[source] || '○';

/** is_active is a heuristic (no end time, seen in the last 5 minutes) -- label it softly. */
export const looksActive = (session) => Boolean(session?.is_active);

export function sessionTitle(session) {
  const title = (session.title || session.display_name || '').trim();
  if (title) return title;
  if (session.preview) return String(session.preview).slice(0, 80);
  // Never show a raw id as a headline; say what it is instead.
  if (session.source === 'cron') return 'Scheduled run';
  if (session.source === 'subagent') return 'Background agent';
  return 'Untitled session';
}

export function statusDot(key) {
  return el('span', { class: `dot dot--${key}`, 'aria-hidden': 'true' });
}

export function spinner(label = 'Loading') {
  return el(
    'div',
    { class: 'loading', role: 'status' },
    el('span', { class: 'loading-dots' }),
    label,
  );
}

export function emptyState(title, detail) {
  return el(
    'div',
    { class: 'empty' },
    el('p', { class: 'empty-title' }, title),
    detail ? el('p', {}, detail) : null,
  );
}

export function errorState(error, retry) {
  return el(
    'div',
    { class: 'empty empty--error' },
    el('p', { class: 'empty-title' }, 'Could not load'),
    el('p', {}, error?.message || String(error)),
    retry ? el('button', { class: 'btn', onclick: retry }, 'Try again') : null,
  );
}

/** Copy helper that degrades gracefully when the clipboard API is unavailable. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let toastTimer;
export function toast(message, kind = 'info') {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.className = `toast toast--${kind} toast--visible`;
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('toast--visible'), 3200);
}
