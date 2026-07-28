// REST client for the Hermes dashboard API, reached through this app's proxy.
// The proxy adds the session credential on the internal hop and refuses
// anything outside its allowlist, so there is nothing to authenticate here.

class ApiError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    if (cause.name === 'AbortError') throw cause;
    throw new ApiError('Cannot reach hermes-mobile.', 0, path);
  }

  if (response.status === 404) {
    throw new ApiError('Not exposed by hermes-mobile.', 404, path);
  }
  if (response.status === 502) {
    throw new ApiError('Hermes backend is not responding.', 502, path);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const parsed = await response.json();
      if (parsed?.detail) detail = String(parsed.detail);
      else if (parsed?.error) detail = String(parsed.error);
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(detail, response.status, path);
  }
  if (response.status === 204) return null;
  return response.json();
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  status: (signal) => request('/api/status', { signal }),
  systemStats: (signal) => request('/api/system/stats', { signal }),

  // One call for the whole home screen: recents, cron, and messaging slices,
  // opening each profile database exactly once.
  sidebar: (signal) =>
    request(
      `/api/profiles/sessions/sidebar${query({
        recents_profile: 'all',
        recents_limit: 25,
        recents_exclude: 'cron,subagent,tool',
        cron_limit: 25,
        messaging_limit: 25,
      })}`,
      { signal },
    ),

  sessions: (params = {}, signal) => request(`/api/sessions${query(params)}`, { signal }),
  session: (id, signal) => request(`/api/sessions/${encodeURIComponent(id)}`, { signal }),
  messages: (id, params = {}, signal) =>
    request(`/api/sessions/${encodeURIComponent(id)}/messages${query(params)}`, { signal }),
  searchSessions: (q, signal) =>
    request(`/api/sessions/search${query({ q, limit: 40 })}`, { signal }),
  renameSession: (id, title) =>
    request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } }),
  archiveSession: (id, archived) =>
    request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { archived } }),
  deleteSession: (id) => request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  cronJobs: (signal) => request(`/api/cron/jobs${query({ profile: 'all' })}`, { signal }),
  cronRuns: (id, signal) =>
    request(`/api/cron/jobs/${encodeURIComponent(id)}/runs${query({ limit: 25 })}`, { signal }),
  pauseJob: (id) => request(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeJob: (id) => request(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  triggerJob: (id) =>
    request(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, { method: 'POST' }),
  updateJob: (id, updates) =>
    request(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body: { updates } }),

  profiles: (signal) => request('/api/profiles', { signal }),

  // Local to this app rather than Hermes: push subscription management.
  pushConfig: (signal) => request('/push/config', { signal }),
  subscribePush: (subscription) =>
    request('/push/subscribe', { method: 'POST', body: subscription }),
  unsubscribePush: (endpoint) =>
    request('/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

export { ApiError };
