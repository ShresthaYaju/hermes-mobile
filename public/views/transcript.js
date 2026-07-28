// Transcript -- a typed event log, not a message array.
//
// Verified against the live API: assistant rows carry tool_calls with
// {id, function:{name, arguments}}, paired to role:"tool" rows by
// tool_call_id, alongside tool_name, reasoning and finish_reason. So the
// collapsed tool row is buildable entirely client-side.

import { api } from '../lib/api.js';
import {
  el,
  clear,
  spinner,
  errorState,
  emptyState,
  relativeTime,
  clockTime,
  renderMarkdown,
  copyText,
  toast,
  sourceGlyph,
} from '../lib/ui.js';
import { back } from '../lib/router.js';

const PAGE = 200;

export function transcriptView({ id }) {
  const root = el('div', { class: 'view view--detail' });
  const header = el('header', { class: 'detail-head' });
  const body = el('div', {}, spinner('Loading transcript'));
  root.append(header, body);

  let disposed = false;
  let controller;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [session, payload] = await Promise.all([
        api.session(id, signal).catch(() => null),
        api.messages(id, { limit: PAGE }, signal),
      ]);
      if (disposed) return;
      renderHeader(header, session, id);
      const messages = payload?.messages || [];
      clear(body);
      if (!messages.length) {
        // A cron run that failed before its first assistant turn has only the
        // prompt. Treat that as a normal state, not an error.
        body.append(
          emptyState(
            'No transcript recorded.',
            'Scheduled runs that fail before the agent replies leave their output only in the run document on the host.',
          ),
        );
        return;
      }
      body.append(renderTranscript(messages));
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

function renderHeader(node, session, id) {
  clear(node);
  const title = session?.title || session?.display_name || 'Transcript';
  node.append(
    el(
      'button',
      { class: 'icon-btn', onclick: () => back('#/threads'), 'aria-label': 'Back' },
      '‹',
    ),
    el(
      'div',
      { class: 'detail-head-main' },
      el('div', { class: 'detail-title' }, title),
      el(
        'div',
        { class: 'detail-sub mono' },
        session?.source ? `${sourceGlyph(session.source)} ${session.source}` : '',
        session?.model ? ` · ${session.model}` : '',
        session?.cwd ? ` · ${shortPath(session.cwd)}` : '',
      ),
    ),
  );
}

function renderTranscript(messages) {
  const list = el('div', { class: 'transcript' });

  // Index tool results so each call can render its own outcome inline.
  const resultsByCallId = new Map();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      resultsByCallId.set(message.tool_call_id, message);
    }
  }

  for (const message of messages) {
    if (message.role === 'tool') continue; // rendered with its call
    if (message.role === 'user') {
      const text = textOf(message);
      if (text)
        list.append(
          el('article', { class: 'msg msg--user' }, el('div', { class: 'bubble' }, text)),
        );
      continue;
    }
    if (message.role === 'assistant') {
      const reasoning = message.reasoning || message.reasoning_content;
      if (reasoning) list.append(thinkingRow(String(reasoning)));

      const text = textOf(message);
      if (text) {
        list.append(
          el(
            'article',
            { class: 'msg msg--assistant' },
            el('div', { class: 'prose', html: renderMarkdown(text) }),
          ),
        );
      }
      for (const call of toolCalls(message)) {
        list.append(toolRow(call, resultsByCallId.get(call.id)));
      }
      continue;
    }
    // Unknown record types must degrade to a quiet chip, never break the view.
    if (message.role && message.role !== 'session_meta') {
      list.append(el('div', { class: 'meta-chip mono' }, message.role));
    }
  }
  return list;
}

function textOf(message) {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

function toolCalls(message) {
  let raw = message.tool_calls;
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((call) => ({
    id: call.id || call.call_id,
    name: call.function?.name || call.name || 'tool',
    args: call.function?.arguments ?? call.arguments ?? '',
  }));
}

function thinkingRow(text) {
  const details = el('details', { class: 'tool tool--thinking' });
  details.append(
    el(
      'summary',
      { class: 'tool-summary' },
      el('span', { class: 'tool-chevron' }, '▸'),
      el('span', { class: 'tool-name' }, 'thought'),
    ),
    el('pre', { class: 'tool-body mono' }, clip(text, 4000)),
  );
  return details;
}

function toolRow(call, result) {
  const args = prettyArgs(call.args);
  const summary = firstLine(args);
  const failed =
    result && /error|traceback|exception/i.test(String(result.content || '').slice(0, 200));

  const details = el('details', { class: `tool ${failed ? 'tool--failed' : ''}` });
  const head = el(
    'summary',
    { class: 'tool-summary' },
    el('span', { class: 'tool-chevron' }, '▸'),
    el('span', { class: 'tool-name mono' }, call.name),
    el('span', { class: 'tool-arg mono' }, summary),
  );
  details.append(head);

  const inner = el('div', { class: 'tool-detail' });
  if (args) {
    inner.append(
      el('div', { class: 'tool-label' }, 'input'),
      el('pre', { class: 'tool-body mono' }, clip(args, 4000)),
    );
  }
  if (result) {
    const output = String(result.content ?? '');
    inner.append(
      el('div', { class: 'tool-label' }, `output · ${output.split('\n').length} lines`),
      el('pre', { class: 'tool-body mono' }, clip(output, 6000)),
    );
  }
  inner.append(
    el(
      'button',
      {
        class: 'btn btn--small',
        onclick: async () => {
          const ok = await copyText(`${call.name} ${args}`.trim());
          toast(ok ? 'Copied' : 'Could not copy', ok ? 'info' : 'error');
        },
      },
      'Copy command',
    ),
  );
  details.append(inner);
  return details;
}

function prettyArgs(args) {
  if (!args) return '';
  if (typeof args === 'object') return JSON.stringify(args, null, 2);
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return String(args);
  }
}

function firstLine(text) {
  if (!text) return '';
  const compact = text
    .replace(/\s+/g, ' ')
    .replace(/^\{\s*/, '')
    .trim();
  return compact.length > 46 ? `${compact.slice(0, 46)}…` : compact;
}

function clip(text, max) {
  const value = String(text);
  return value.length > max
    ? `${value.slice(0, max)}\n… ${value.length - max} more characters`
    : value;
}

const shortPath = (path) => String(path).replace(/^\/home\/[^/]+/, '~');
