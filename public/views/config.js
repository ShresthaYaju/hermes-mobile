// Config -- model, profiles, notifications, and connection facts.

import { api } from '../lib/api.js';
import { el, clear, spinner, errorState, relativeTime, toast, statusDot } from '../lib/ui.js';
import { enablePush, disablePush, pushState } from '../lib/push.js';
import { navigate } from '../lib/router.js';

export function configView() {
  const root = el('div', { class: 'view' });
  const model = el('section', { class: 'section' }, spinner('Loading model'));
  const profiles = el('section', { class: 'section' });
  const notifications = el('section', { class: 'section' });
  const about = el('section', { class: 'section' });
  root.append(model, profiles, notifications, about);

  let disposed = false;
  let controller;
  // The provider catalog is fetched lazily, on its own controller: it is the
  // one slow read in this view (upstream probes every configured provider), and
  // it must not be cancelled by the routine reload that follows a switch.
  let pickerController;

  async function load(notice) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [profileData, status, modelInfo] = await Promise.all([
        api.profiles(signal),
        api.status(signal).catch(() => null),
        api.modelInfo(signal).catch(() => null),
      ]);
      if (disposed) return;
      renderModel(model, modelInfo, notice, {
        reload: load,
        // Each open replaces the previous request rather than racing it.
        signal: () => {
          pickerController?.abort();
          pickerController = new AbortController();
          return pickerController.signal;
        },
      });
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
    pickerController?.abort();
  };
  return root;
}

// ------------------------------------------------------------------ model --

/** 200000 -> "200K". The exact figure is noise; the order of magnitude is not. */
function contextSize(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function modelSummary(info) {
  const parts = [];
  if (info?.provider) parts.push(info.provider);
  const context = contextSize(info?.effective_context_length);
  if (context) {
    // An override in config.yaml wins over the auto-detected window, and the
    // two disagreeing is exactly when someone needs to know which is in force.
    parts.push(
      info.config_context_length > 0 ? `${context} context (pinned)` : `${context} context`,
    );
  }
  return parts.join(' · ');
}

function renderModel(node, info, notice, deps) {
  clear(node);
  node.append(el('h2', { class: 'section-title' }, 'Model'));

  const current = info?.model || '';
  const picker = el('div', { class: 'picker' });
  const change = el('button', { class: 'btn btn--small' }, 'Change');
  let open = false;

  change.onclick = () => {
    open = !open;
    change.textContent = open ? 'Cancel' : 'Change';
    if (open) openPicker(picker, info, deps);
    else clear(picker);
  };

  node.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        statusDot(current ? 'ok' : 'warn'),
        el(
          'div',
          { class: 'row-main' },
          el('div', { class: 'row-title mono' }, current || 'No model configured'),
          el('div', { class: 'row-sub' }, modelSummary(info)),
        ),
        change,
      ),
      picker,
    ),
  );

  if (notice) node.append(el('p', { class: 'note note--warn' }, notice));
  node.append(
    el(
      'p',
      { class: 'note' },
      'Applies to threads started from now on. A conversation already running keeps the model it was created with.',
    ),
  );
}

async function openPicker(box, info, deps) {
  clear(box).append(spinner('Loading providers'));
  try {
    const options = await api.modelOptions(false, deps.signal());
    renderPicker(box, options, info, deps);
  } catch (error) {
    if (error.name === 'AbortError') return;
    clear(box).append(errorState(error, () => openPicker(box, info, deps)));
  }
}

function renderPicker(box, options, info, deps) {
  clear(box);

  // Providers with no models are the setup skeletons upstream emits for the
  // canonical list. There is nothing to pick from them and no way to
  // authenticate one from a phone, so they are not offered.
  const rows = (options?.providers || []).filter((row) => (row.models || []).length);
  if (!rows.length) {
    box.append(
      el(
        'p',
        { class: 'note' },
        'No provider on this host has a usable model list. Authenticate one from the desktop dashboard first.',
      ),
    );
    return;
  }

  const currentProvider = String(options?.provider || info?.provider || '').toLowerCase();
  const providerSelect = el('select', { class: 'input select', 'aria-label': 'Provider' });
  for (const row of rows) {
    providerSelect.append(
      el(
        'option',
        { value: row.slug, selected: String(row.slug).toLowerCase() === currentProvider },
        row.authenticated === false
          ? `${row.name || row.slug} (needs setup)`
          : row.name || row.slug,
      ),
    );
  }

  const modelSelect = el('select', { class: 'input select', 'aria-label': 'Model' });
  const fillModels = () => {
    const row = rows.find((entry) => entry.slug === providerSelect.value) || rows[0];
    clear(modelSelect);
    for (const name of row.models || []) {
      modelSelect.append(el('option', { value: name, selected: name === info?.model }, name));
    }
  };
  fillModels();

  // The backend answers an expensive assignment with a refusal carrying the
  // reason, not with a failure. Re-sending it is a second, explicit decision --
  // so it is shown here and the button changes what it says, rather than being
  // auto-confirmed on the user's behalf.
  const caution = el('p', { class: 'note note--warn' });
  const apply = el('button', { class: 'btn btn--primary' }, 'Use this model');
  let confirming = false;

  // A caution answers one specific assignment. Moving either wheel makes it
  // stale, and a confirmation left armed would spend on a model whose warning
  // the user never saw.
  const resetConfirm = () => {
    confirming = false;
    caution.textContent = '';
    apply.textContent = 'Use this model';
  };
  providerSelect.onchange = () => {
    fillModels();
    resetConfirm();
  };
  modelSelect.onchange = resetConfirm;

  apply.onclick = async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    if (!provider || !model) return;
    apply.disabled = true;
    try {
      const result = await api.setModel(provider, model, confirming);
      if (result?.confirm_required) {
        confirming = true;
        caution.textContent = result.confirm_message || 'This model is expensive.';
        apply.textContent = 'Switch anyway';
        return;
      }
      toast(`Now using ${result?.model || model}`);
      // Auxiliary slots are sticky per-task pins that a main switch never
      // touches, so one left on a provider you have moved off keeps billing
      // silently in the background. Say so; never clear it from here.
      const stale = result?.stale_aux || [];
      deps.reload(
        stale.length
          ? `Background tasks are still pinned to ${[...new Set(stale.map((slot) => slot.provider))].join(', ')}. Reset them from the desktop dashboard.`
          : undefined,
      );
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      apply.disabled = false;
    }
  };

  box.append(
    el('label', { class: 'picker-label' }, 'Provider', providerSelect),
    el('label', { class: 'picker-label' }, 'Model', modelSelect),
    caution,
    el('div', { class: 'picker-actions' }, apply),
  );
}

// Profiles stay read-only, and not for want of an endpoint: POST
// /api/profiles/active exists and works. It moves the *sticky* profile -- what
// the next CLI invocation and the next gateway pick up -- and explicitly does
// not retarget the dashboard process already running. That process is the one
// this app reads every session, job and model through. Switching from here
// would leave the app announcing a profile whose sessions, schedules and model
// it is not showing, and the only way back to a consistent view is a restart on
// the desktop. A control that lies about what it did is worse than its absence,
// so the proxy withholds the route and this says why instead.
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
      'Switching the active profile changes which agent new CLI sessions use, but does not retarget the running gateway — this app would keep showing the old profile. It is left to the desktop dashboard. The model above belongs to the profile shown here as active.',
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
      el('button', { class: 'btn', onclick: () => navigate('#/chat/new') }, 'Start a new thread'),
      el(
        'p',
        { class: 'note' },
        'Conversations live on the host, not on this device: each thread keeps its own context and can be reopened from Threads.',
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
