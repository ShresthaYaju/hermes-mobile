// Config -- profiles, notifications, and connection facts.

import { api } from '../lib/api.js';
import { el, clear, spinner, errorState, relativeTime, toast, statusDot } from '../lib/ui.js';
import { enablePush, disablePush, pushState } from '../lib/push.js';
import { resetChat } from './chat.js';

export function configView() {
  const root = el('div', { class: 'view' });
  const profiles = el('section', { class: 'section' }, spinner('Loading profiles'));
  const notifications = el('section', { class: 'section' });
  const about = el('section', { class: 'section' });
  root.append(profiles, notifications, about);

  let disposed = false;
  let controller;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [profileData, status] = await Promise.all([
        api.profiles(signal),
        api.status(signal).catch(() => null),
      ]);
      if (disposed) return;
      renderProfiles(profiles, profileData?.profiles || profileData || []);
      renderAbout(about, status);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      clear(profiles).append(errorState(error, load));
    }
  }

  renderNotifications(notifications);
  load();

  root.dispose = () => {
    disposed = true;
    controller?.abort();
  };
  return root;
}

function renderProfiles(node, list) {
  clear(node);
  node.append(el('h2', { class: 'section-title' }, 'Agent profiles'));
  if (!list.length) {
    node.append(el('div', { class: 'card' }, 'No profiles found.'));
    return;
  }
  for (const profile of list) {
    // Hermes has no agent registry: a profile is the closest thing to a named
    // agent, and most here have never actually run. Say so rather than
    // rendering an empty activity panel.
    const neverRun = !profile.gateway_running && !profile.is_default;
    node.append(
      el(
        'div',
        { class: 'card row' },
        statusDot(profile.is_default ? 'ok' : 'idle'),
        el(
          'div',
          { class: 'row-main' },
          el(
            'div',
            { class: 'row-title' },
            profile.name,
            profile.is_default ? el('span', { class: 'pill' }, 'active') : null,
          ),
          el('div', { class: 'row-sub' }, profile.description || (neverRun ? 'never run' : '')),
          profile.model ? el('div', { class: 'row-sub mono' }, profile.model) : null,
        ),
      ),
    );
  }
  node.append(
    el(
      'p',
      { class: 'note' },
      'Switching the active profile changes which agent new CLI sessions use. It does not retarget the running gateway, so it is left to the desktop dashboard.',
    ),
  );
}

function renderNotifications(node) {
  clear(node);
  node.append(el('h2', { class: 'section-title' }, 'Notifications'));

  const card = el('div', { class: 'card' });
  const status = el('div', { class: 'row-sub' });
  const button = el('button', { class: 'btn' }, '…');
  card.append(
    el(
      'div',
      { class: 'row' },
      el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, 'Push alerts'), status),
      button,
    ),
    el(
      'p',
      { class: 'note' },
      'Alerts when a scheduled job fails. Requires an installed app on iOS — add hermes-mobile to your home screen first.',
    ),
  );
  node.append(card);

  const refresh = async () => {
    const current = await pushState();
    status.textContent = current.reason;
    button.textContent = current.subscribed ? 'Turn off' : 'Turn on';
    button.disabled = !current.available;
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (current.subscribed) {
          await disablePush();
          toast('Push alerts off');
        } else {
          await enablePush();
          toast('Push alerts on');
        }
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        await refresh();
      }
    };
  };
  refresh();
}

function renderAbout(node, status) {
  clear(node);
  node.append(el('h2', { class: 'section-title' }, 'This app'));
  node.append(
    el(
      'div',
      { class: 'card' },
      kv('Hermes', status?.version ? `v${status.version}` : 'unknown'),
      kv('Gateway', status?.gateway_running ? `running (pid ${status.gateway_pid})` : 'stopped'),
      kv('Sessions active', String(status?.active_sessions ?? 0)),
      kv('Access', 'tailnet only'),
    ),
  );
  node.append(
    el(
      'div',
      { class: 'card' },
      el(
        'button',
        {
          class: 'btn',
          onclick: () => {
            resetChat();
            toast('Local chat history cleared');
          },
        },
        'Clear local chat history',
      ),
      el(
        'p',
        { class: 'note' },
        'Only clears what this device has cached for painting. Conversations stay on the host.',
      ),
    ),
  );
  node.append(
    el(
      'p',
      { class: 'note' },
      'This app exposes read-only access plus scheduled-job controls. Secrets, files, and gateway lifecycle are deliberately not reachable from here.',
    ),
  );
}

function kv(label, value) {
  return el(
    'div',
    { class: 'kv' },
    el('span', { class: 'kv-key' }, label),
    el('span', { class: 'kv-value mono' }, value),
  );
}
