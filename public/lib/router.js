// Hash routing. Views are functions returning a node, optionally carrying a
// dispose() that the router calls on navigation so timers and fetches stop,
// and a refresh() the shell offers as an explicit "check now" for the surfaces
// that otherwise only update on their poll.

import { el } from './ui.js';

const routes = [];
let outlet;
let current;

export function defineRoute(pattern, factory) {
  routes.push({ pattern, factory });
}

export function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) {
    render();
    return;
  }
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}

export function back(fallback = '#/now') {
  if (history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}

export function currentPath() {
  return location.hash.replace(/^#/, '') || '/now';
}

function match(path) {
  for (const route of routes) {
    if (typeof route.pattern === 'string') {
      if (route.pattern === path) return { factory: route.factory, params: {} };
      continue;
    }
    const found = path.match(route.pattern);
    if (found) return { factory: route.factory, params: found.groups || {} };
  }
  return null;
}

/**
 * What a view throwing during construction leaves behind. Before this the
 * outlet was simply emptied: the tab bar still worked, so the app was not
 * actually stuck, but nothing on screen said so and it read as dead.
 *
 * Both ways out are here on purpose. Re-running the factory fixes a failure
 * that was transient, and the second button leaves the route entirely for the
 * case where it never will -- a view that throws on every construction would
 * otherwise be a screen you can only escape by knowing the tab bar still works.
 */
function errorBoundary(path, error) {
  const escape =
    path === '/now' ? { path: '/threads', label: 'Threads' } : { path: '/now', label: 'Now' };
  return el(
    'div',
    { class: 'view' },
    el(
      'section',
      { class: 'card card--boundary', role: 'alert' },
      el('h2', { class: 'boundary-title' }, 'This screen did not load'),
      el(
        'p',
        { class: 'boundary-detail mono' },
        String(error?.message || error || 'Unknown error'),
      ),
      el(
        'div',
        { class: 'action-bar' },
        el('button', { class: 'btn btn--primary', onclick: () => render() }, 'Try again'),
        el('button', { class: 'btn', onclick: () => navigate(`#${escape.path}`) }, escape.label),
      ),
    ),
  );
}

function mount(node) {
  current = node;
  outlet.replaceChildren(node);
  outlet.scrollTop = 0;
}

function render() {
  const path = currentPath();
  const found = match(path);
  if (!found) {
    navigate('#/now', { replace: true });
    return;
  }

  // Disposal sits outside the guard below and runs first regardless: the
  // outgoing view's timers and fetches must stop whether or not the incoming
  // one builds, and a dispose() that throws must not take the new screen with
  // it. Clearing `current` first means a second failure cannot dispose twice.
  const outgoing = current;
  current = null;
  try {
    outgoing?.dispose?.();
  } catch {
    // The view is going away regardless; there is nothing left to recover.
  }

  let node;
  try {
    node = found.factory(found.params);
  } catch (error) {
    node = errorBoundary(path, error);
  }
  mount(node);
  document.body.dataset.route = path;
  window.dispatchEvent(new CustomEvent('route', { detail: { path } }));
}

/** Whether the mounted view offers a refresh, so the shell can hide the control. */
export function canRefresh() {
  return typeof current?.refresh === 'function';
}

/** Force the mounted view to reload now. Resolves when it has. */
export function refreshCurrent() {
  return Promise.resolve(current?.refresh?.());
}

/**
 * Last resort for a failure the router could not catch itself -- a throw
 * inside a view's async load, which happens long after the factory returned.
 * It only takes over an outlet with nothing left in it: replacing a screen
 * that is still standing, because one background poll rejected, would be worse
 * than the failure. Returns whether it did.
 */
export function reportViewError(error) {
  if (!outlet || outlet.childElementCount) return false;
  current = null;
  mount(errorBoundary(currentPath(), error));
  return true;
}

export function startRouter(mountPoint) {
  outlet = mountPoint;
  window.addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/now');
  render();
}
