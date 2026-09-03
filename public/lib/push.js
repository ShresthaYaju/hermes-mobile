// Web Push subscription management.
//
// The proxy fans out approvals, replies, errors, host status and job
// failures to subscribed devices, in kinds a device can pick between. Push
// itself degrades quietly throughout: if the browser cannot do push, or the
// host has no VAPID key configured, the rest of the app is unaffected.

import { api } from './api.js';

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// Mirrors notifications.mjs's PUSH_KINDS -- same ids, same order. Kept as a
// literal rather than fetched, since the list of *possible* kinds is fixed
// client code (labels, hints); only which of them the host currently
// supports and which this device wants are runtime facts.
export const PUSH_KINDS = [
  { id: 'approval', label: 'Approvals', hint: 'Hermes is waiting for a yes or no' },
  { id: 'reply', label: 'Replies', hint: 'A turn you started finished while the app was closed' },
  { id: 'error', label: 'Errors', hint: 'A turn failed' },
  { id: 'ops', label: 'Host status', hint: 'The agent stopped responding, or came back' },
  { id: 'job', label: 'Scheduled jobs', hint: 'A job failed' },
];
const ALL_KIND_IDS = PUSH_KINDS.map((kind) => kind.id);

const KINDS_KEY = 'hermes.push.kinds.v1';

// Safari in private mode throws on the property access itself, not just on
// use -- same guard as store.js's outbox uses.
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Which kinds this device wants, in PUSH_KINDS order. Defaults to all. */
export function getPushKinds() {
  try {
    const raw = storage()?.getItem(KINDS_KEY);
    if (!raw) return [...ALL_KIND_IDS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_KIND_IDS];
    // An empty list is a real choice (subscribed, wants nothing yet), not a
    // missing one -- only an absent or unreadable entry falls back to all.
    return ALL_KIND_IDS.filter((id) => parsed.includes(id));
  } catch {
    return [...ALL_KIND_IDS];
  }
}

/**
 * Persist the chosen kinds and, when a subscription already exists, tell the
 * host -- that POST is the only way the server learns the choice changed.
 * Returns the normalised list actually stored.
 */
export async function setPushKinds(ids) {
  const kinds = ALL_KIND_IDS.filter((id) => (ids || []).includes(id));
  try {
    storage()?.setItem(KINDS_KEY, JSON.stringify(kinds));
  } catch {
    // Quota or a locked-down browser: the choice still applies for this tab.
  }
  if (supported()) {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await api.subscribePush(subscription.toJSON(), kinds);
  }
  return kinds;
}

/** The kinds the host currently supports, intersected with the ones we know. */
function supportedKinds(config) {
  return Array.isArray(config?.kinds)
    ? ALL_KIND_IDS.filter((id) => config.kinds.includes(id))
    : [...ALL_KIND_IDS];
}

export async function pushState() {
  if (!supported()) {
    return { available: false, subscribed: false, reason: 'Not supported on this browser' };
  }
  // iOS only exposes push to home-screen installs.
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (iOS && !standalone) {
    return { available: false, subscribed: false, reason: 'Add to Home Screen to enable' };
  }

  let config;
  try {
    config = await api.pushConfig();
  } catch {
    return { available: false, subscribed: false, reason: 'Unavailable' };
  }
  if (!config?.enabled) {
    return { available: false, subscribed: false, reason: 'Not configured on the host' };
  }
  const kinds = supportedKinds(config);

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    // getSubscription() only reports what the browser remembers -- it says
    // nothing about whether the host still holds this endpoint. The host can
    // evict it on its own (delivery failures, the per-owner cap, a state file
    // that did not survive a restart), and this device would otherwise keep
    // showing On forever. /push/subscribe is idempotent (it answers 204
    // whether the entry was already there or just got re-added), so posting
    // it here is free the rest of the time and self-healing the one time it
    // is not. Carrying our chosen kinds along keeps a fresh install's default
    // (all of them) from silently reverting a choice made on a previous host
    // restart that dropped the subscription's kinds along with everything else.
    try {
      await api.subscribePush(subscription.toJSON(), getPushKinds());
    } catch {
      return {
        available: true,
        subscribed: false,
        stale: true,
        reason: 'Needs re-enabling',
        kinds,
      };
    }
    return { available: true, subscribed: true, reason: 'On', kinds };
  }
  if (Notification.permission === 'denied') {
    return { available: false, subscribed: false, reason: 'Blocked in browser settings' };
  }
  return { available: true, subscribed: false, reason: 'Off', kinds };
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const config = await api.pushConfig();
  if (!config?.enabled) throw new Error('Push is not configured on the host');

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });
  await api.subscribePush(subscription.toJSON(), getPushKinds());
  return true;
}

export async function disablePush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  await api.unsubscribePush(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
  return true;
}

function urlBase64ToUint8Array(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
