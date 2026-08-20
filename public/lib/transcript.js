// Rendering for a stored transcript -- a typed event log, not a message array.
//
// Verified against the live API: assistant rows carry tool_calls with
// {id, function:{name, arguments}}, paired to role:"tool" rows by
// tool_call_id, alongside tool_name, reasoning and finish_reason. So the
// collapsed tool row is buildable entirely client-side.
//
// Lives in lib/ rather than in the transcript view because the chat view
// replays the same stored history above its composer. One renderer means a
// thread looks identical whether you are reading it or talking in it.

import { el, renderMarkdown, copyText, toast } from './ui.js';

export function renderTranscript(messages, { into } = {}) {
  const list = into || el('div', { class: 'transcript' });

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
          el(
            'article',
            { class: 'msg msg--user' },
            el('div', { class: 'bubble' }, text),
            messageActions(text),
          ),
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
            // The clipboard gets the source text, not the rendered markdown --
            // pasting `**bold**` back somewhere is the useful outcome.
            messageActions(text),
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

// A phone has no hover, so per-message controls are either always visible or
// effectively absent. Kept to one faint glyph so a long transcript still reads
// as prose rather than as a list of buttons.
function messageActions(text) {
  return el(
    'div',
    { class: 'msg-actions' },
    el(
      'button',
      {
        class: 'msg-copy',
        type: 'button',
        'aria-label': 'Copy message',
        title: 'Copy message',
        onclick: async () => {
          const ok = await copyText(text);
          toast(ok ? 'Copied' : 'Could not copy', ok ? 'info' : 'error');
        },
      },
      '⧉',
    ),
  );
}

/**
 * One control that opens or closes every tool row in `list`, or null when the
 * transcript has none. Lives beside the renderer because it has to know that a
 * tool row is a `<details class="tool">` -- including the thinking rows, which
 * are the ones you most often want out of the way.
 *
 * Mounted by the view rather than by renderTranscript: this is chrome over a
 * whole transcript, and the chat view replays history into a live conversation
 * where a bar pinned above the scrollback would mean something else.
 */
export function toolExpander(list) {
  const rows = () => [...list.querySelectorAll('details.tool')];
  if (!rows().length) return null;

  const button = el('button', {
    class: 'btn btn--small',
    type: 'button',
    onclick: () => {
      const all = rows();
      const expand = all.some((row) => !row.open);
      for (const row of all) row.open = expand;
      sync();
    },
  });

  // Label from the live state, so hand-toggling a row leaves the button
  // telling the truth. `toggle` does not bubble; capture still reaches it.
  function sync() {
    const all = rows();
    button.textContent = all.every((row) => row.open) ? 'Collapse all' : 'Expand all';
  }
  list.addEventListener('toggle', sync, true);
  sync();
  return button;
}

export function textOf(message) {
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
