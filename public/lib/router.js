// Hash routing. Views are functions returning a node, optionally carrying a
// dispose() that the router calls on navigation so timers and fetches stop.

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

function render() {
  const path = currentPath();
  const found = match(path);
  if (!found) {
    navigate('#/now', { replace: true });
    return;
  }
  current?.dispose?.();
  const node = found.factory(found.params);
  current = node;
  outlet.replaceChildren(node);
  outlet.scrollTop = 0;
  document.body.dataset.route = path;
  window.dispatchEvent(new CustomEvent('route', { detail: { path } }));
}

export function startRouter(mountPoint) {
  outlet = mountPoint;
  window.addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/now');
  render();
}
