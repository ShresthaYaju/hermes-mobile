// Web Push subscription management.
//
// The proxy watches scheduled jobs and fans failures out to subscribed
// devices. Everything here degrades quietly: if the browser cannot do push,
// or the host has no VAPID key configured, the rest of the app is unaffected.

import { api } from './api.js';

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

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
    // is not.
    try {
      await api.subscribePush(subscription.toJSON());
    } catch {
      return { available: true, subscribed: false, stale: true, reason: 'Needs re-enabling' };
    }
    return { available: true, subscribed: true, reason: 'On — alerts for failed jobs' };
  }
  if (Notification.permission === 'denied') {
    return { available: false, subscribed: false, reason: 'Blocked in browser settings' };
  }
  return { available: true, subscribed: false, reason: 'Off' };
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
  await api.subscribePush(subscription.toJSON());
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
