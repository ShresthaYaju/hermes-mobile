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
