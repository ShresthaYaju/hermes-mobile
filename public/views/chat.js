// Chat -- the live conversation this app owns.
//
// Only sessions created here stream events (the gateway addresses events to
// the transport that last touched a session, and there is no broadcast), so
// this view holds exactly one session and does not try to attach to others.

import { socket } from '../lib/rpc.js';
import { state, update } from '../lib/store.js';
import { el, clear, renderMarkdown, relativeTime, toast, duration } from '../lib/ui.js';

const TRANSCRIPT_KEY = 'hermes-mobile-transcript-v1';

export function chatView() {
  const root = el('div', { class: 'view view--chat' });
  const messages = el('div', { class: 'transcript transcript--chat' });
  const activity = el('div', { class: 'activity', hidden: true });
  const input = el('textarea', {
    class: 'composer-input',
    rows: '1',
    placeholder: 'Message Hermes',
    autocomplete: 'off',
  });
  const send = el('button', { class: 'composer-send', 'aria-label': 'Send', disabled: true }, '↑');
  const stop = el('button', { class: 'btn btn--stop', hidden: true }, 'Stop');
  const composer = el(
    'form',
    { class: 'composer' },
    input,
    el(
      'div',
      { class: 'composer-row' },
      el('span', { class: 'composer-hint' }, 'Enter sends'),
      stop,
      send,
    ),
  );
  root.append(messages, activity, composer);

  let assistantNode = null;
  let assistantText = '';
  let disposed = false;

  restore(messages);

  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener('input', () => {
    resize();
    send.disabled = !input.value.trim() || state.running;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  stop.addEventListener('click', async () => {
    if (!state.sessionId) return;
    try {
      await socket.call('session.interrupt', { session_id: state.sessionId });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    // close_on_disconnect:true so a dropped phone connection does not leave an
    // orphaned session behind. History still persists server-side.
    const created = await socket.call('session.create', {
      source: 'hermes-mobile',
      close_on_disconnect: true,
    });
    update({ sessionId: created.session_id });
    return created.session_id;
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || state.running) return;
    append(messages, 'user', text);
    persist(messages);
    input.value = '';
    resize();
    send.disabled = true;
    assistantText = '';
    assistantNode = append(messages, 'assistant', '');
    try {
      const sessionId = await ensureSession();
      await socket.call('prompt.submit', { session_id: sessionId, text });
    } catch (error) {
      assistantNode?.remove();
      assistantNode = null;
      systemLine(messages, error.message);
      update({ running: false });
    }
  }

  const onEvent = ({ detail }) => {
    if (disposed) return;
    const { type, session_id: sessionId, payload = {} } = detail;
    if (sessionId && state.sessionId && sessionId !== state.sessionId) return;
    switch (type) {
      case 'message.start':
        assistantText = '';
        assistantNode ||= append(messages, 'assistant', '');
        break;
      case 'message.delta':
        assistantText += payload.text || '';
        assistantNode ||= append(messages, 'assistant', '');
        setText(assistantNode, assistantText);
        break;
      case 'message.interim':
        if (payload.text) {
          assistantText = payload.text;
          assistantNode ||= append(messages, 'assistant', '');
          setText(assistantNode, assistantText);
        }
        break;
      case 'message.complete': {
        const finalText = payload.text || assistantText;
        assistantNode ||= append(messages, 'assistant', '');
        setText(assistantNode, finalText || '(no visible response)');
        if (payload.status === 'interrupted') systemLine(messages, 'Interrupted');
        assistantNode = null;
        assistantText = '';
        persist(messages);
        break;
      }
      case 'error':
        systemLine(messages, payload.message || 'Hermes returned an error');
        assistantNode = null;
        break;
      default:
        break;
    }
    scrollDown(messages);
  };
  socket.addEventListener('event', onEvent);

  const renderActivity = () => {
    if (disposed) return;
    stop.hidden = !state.running;
    send.disabled = !input.value.trim() || state.running;
    if (!state.running) {
      activity.hidden = true;
      return;
    }
    const elapsed = state.turnStartedAt ? (Date.now() - state.turnStartedAt) / 1000 : 0;
    activity.hidden = false;
    clear(activity).append(
      el('span', { class: 'dot dot--running' }),
      el('span', { class: 'mono' }, state.activity || 'working'),
      el('span', { class: 'activity-time mono' }, duration(elapsed)),
    );
  };
  const ticker = setInterval(renderActivity, 500);
  renderActivity();

  root.dispose = () => {
    disposed = true;
    clearInterval(ticker);
    socket.removeEventListener('event', onEvent);
  };
  return root;
}

function append(container, role, text) {
  const node = el(
    'article',
    { class: `msg msg--${role}` },
    el('div', { class: role === 'user' ? 'bubble' : 'prose' }),
  );
  container.append(node);
  setText(node, text);
  scrollDown(container);
  return node;
}

function setText(node, text) {
  node.dataset.text = text;
  const target = node.firstElementChild;
  if (node.classList.contains('msg--user')) target.textContent = text;
  else if (text) target.innerHTML = renderMarkdown(text);
  else target.replaceChildren(el('span', { class: 'typing' }, el('i'), el('i'), el('i')));
}

function systemLine(container, text) {
  container.append(el('div', { class: 'system-line' }, text));
  scrollDown(container);
}

function scrollDown(container) {
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

// A local visual cache so a refresh does not look like data loss. Hermes holds
// the real conversation state; this is only paint.
function persist(container) {
  const items = [...container.querySelectorAll('.msg')]
    .map((node) => ({
      role: node.classList.contains('msg--user') ? 'user' : 'assistant',
      text: node.dataset.text || '',
    }))
    .filter((item) => item.text);
  try {
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(items.slice(-40)));
  } catch {
    // A full quota must never block sending.
  }
}

function restore(container) {
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]');
  } catch {
    localStorage.removeItem(TRANSCRIPT_KEY);
  }
  if (!items.length) {
    container.append(
      el(
        'div',
        { class: 'welcome' },
        el('h1', {}, 'What can I help you do?'),
        el(
          'p',
          {},
          'This is a private conversation with the Hermes agent running on your machine.',
        ),
      ),
    );
    return;
  }
  for (const item of items) append(container, item.role, item.text);
  container.append(
    el(
      'div',
      { class: 'system-line' },
      'Earlier messages are shown from this device; the agent starts a fresh session.',
    ),
  );
}

export function resetChat() {
  localStorage.removeItem(TRANSCRIPT_KEY);
  update({ sessionId: null });
}
