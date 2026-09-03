// The session multiplexer: one long-lived upstream WebSocket to Hermes per
// tailnet login, fanned out to however many phones are attached to it.
//
// Hermes addresses session events (approval.request, message.complete,
// error, ...) only to the transport that owns the session, and drops them
// on the floor when that transport is gone. A phone's socket drops the
// moment it backgrounds, which is exactly when an approval request or a
// finished reply needs to turn into a push notification rather than vanish.
// A transparent proxy.ws() forward can never see that: the event is already
// gone by the time the phone reconnects. Owning the upstream connection here
// instead means it keeps running with nobody attached, this file gets to see
// everything that happens on it, and a phone that reconnects can be caught
// up on whatever it missed.
//
// One upstream per *login*, not per phone: two devices signed in as the same
// person share Hermes's notion of that person's sessions, and sharing one
// socket is also what makes "replay the approval to whichever phone shows
// up next" a property of the login rather than something each phone has to
// coordinate.

import { WebSocket, WebSocketServer } from 'ws';

// Long enough that an idling phone screen (which throttles JS timers, not
// the OS-level TCP stack) does not false-positive as dead, short enough that
// a genuinely gone peer -- a phone that dropped off wifi without a clean
// close -- is noticed well within a person's patience for "why did my chat
// stop updating".
const HEARTBEAT_MS = 30_000;

function upstreamUrl(hermesOrigin, sessionToken) {
  const url = new URL('/api/ws', hermesOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // Exactly how the REST hop and the old proxy.ws() upgrade authenticated:
  // a credential generated outside this repo and shared only with the
  // loopback Hermes service. See hermesSessionToken in server.mjs.
  url.searchParams.set('token', sessionToken);
  return url.toString();
}

function safeSend(ws, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(text);
  } catch {
    // The socket can die between the readyState check and send(); the
    // 'close' handler is what cleans up, not this call site.
  }
}

function safeClose(ws, code, reason) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    } else {
      ws.terminate();
    }
  } catch {
    try {
      ws.terminate();
    } catch {
      // Nothing more this function can do about a socket that will not close.
    }
  }
}

/** Parses a phone/upstream frame, refusing anything that is not a JSON object.
 *  Binary frames, invalid JSON and JSON arrays are all indistinguishable from
 *  "not a JSON-RPC frame" and are dropped rather than guessed at. */
function parseFrame(data, isBinary) {
  if (isBinary) return null;
  let frame;
  try {
    frame = JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
  return frame;
}

export function createGateway({ hermesOrigin, sessionToken, observe, log = console }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });

  // login -> { upstream, phones, pendingById, threads, pendingApprovals, ... }
  const logins = new Map();

  function getLogin(login) {
    let state = logins.get(login);
    if (!state) {
      state = {
        login,
        upstream: null,
        phones: new Set(),
        // Upstream request id -> { phone, originalId, method, storedId }, so
        // a response can be routed back to the phone that asked and its id
        // restored to whatever the phone sent (a string like "m1", possibly
        // a number).
        pendingById: new Map(),
        // Live gateway session id -> durable stored_session_id, learned off
        // session.create/session.resume responses so events can carry the
        // thread id too.
        threads: new Map(),
        // request_id -> { sessionId, frame }, for approvals that arrived
        // with nobody attached to see them.
        pendingApprovals: new Map(),
        // Disambiguates two phones that independently mint request id "m1".
        nextPhoneSeq: 1,
        // Frames sent by a phone before the upstream has finished connecting.
        outbound: [],
      };
      logins.set(login, state);
    }
    return state;
  }

  async function runObserve(event) {
    try {
      await observe(event);
    } catch (error) {
      log.error(`observe() rejected for ${event.login}/${event.type}:`, error);
    }
  }

  function flushOutbound(state) {
    if (!state.outbound.length) return;
    const pending = state.outbound;
    state.outbound = [];
    for (const text of pending) safeSend(state.upstream, text);
  }

  function sendUpstream(state, text) {
    if (state.upstream && state.upstream.readyState === WebSocket.OPEN) {
      safeSend(state.upstream, text);
    } else {
      state.outbound.push(text);
    }
  }

  function broadcast(state, text) {
    for (const phone of state.phones) safeSend(phone.ws, text);
  }

  /** The upstream is gone, one way or another. Nothing survives it: every
   *  phone attached to it just lost the connection Hermes was routing
   *  session events through, so it is treated exactly like a backend
   *  restart -- close 1012, the code the browser client already retries on. */
  function upstreamGone(state) {
    if (!state.upstream) return; // already handled by whichever event fired first
    state.upstream = null;
    for (const phone of state.phones) safeClose(phone.ws, 1012, 'service restart');
    state.phones.clear();
    state.pendingById.clear();
    state.pendingApprovals.clear();
    state.threads.clear();
    state.outbound = [];
  }

  function handleUpstreamMessage(state, data, isBinary) {
    try {
      const frame = parseFrame(data, isBinary);
      if (!frame) return;

      if (frame.id !== undefined) {
        const entry = state.pendingById.get(frame.id);
        if (!entry) {
          // A request *from* Hermes (id plus method) is not something the
          // phone client speaks today, but relaying it keeps parity with the
          // transparent forward this replaces. A response to an id nobody is
          // waiting on -- the phone that asked has already detached -- has no
          // recipient and is dropped.
          if (frame.method !== undefined) broadcast(state, JSON.stringify(frame));
          return;
        }
        state.pendingById.delete(frame.id);

        // Bookkeeping runs whether or not the phone that asked is still
        // around: a session created just before the phone backgrounded
        // still needs its thread id known for the events that follow.
        if (
          entry.method === 'session.create' &&
          frame.result?.session_id &&
          frame.result?.stored_session_id
        ) {
          state.threads.set(frame.result.session_id, frame.result.stored_session_id);
        } else if (
          entry.method === 'session.resume' &&
          frame.result?.session_id &&
          entry.storedId
        ) {
          state.threads.set(frame.result.session_id, entry.storedId);
        }

        if (state.phones.has(entry.phone)) {
          safeSend(entry.phone.ws, JSON.stringify({ ...frame, id: entry.originalId }));
        }
        return;
      }

      if (frame.method === 'event' && frame.params) {
        const params = frame.params;
        const requestId = params.payload?.request_id;
        if (
          (params.type === 'approval.request' || params.type === 'clarify.request') &&
          requestId
        ) {
          state.pendingApprovals.set(requestId, { sessionId: params.session_id, frame });
        } else if (
          (params.type === 'message.complete' || params.type === 'error') &&
          params.session_id
        ) {
          // The turn that would have answered them is over; a card for this
          // session left dangling from here on is stale, not pending.
          for (const [id, approval] of state.pendingApprovals) {
            if (approval.sessionId === params.session_id) state.pendingApprovals.delete(id);
          }
        }

        runObserve({
          login: state.login,
          attached: state.phones.size > 0,
          type: params.type,
          sessionId: params.session_id,
          threadId: state.threads.get(params.session_id) ?? null,
          payload: params.payload ?? {},
        });

        broadcast(state, JSON.stringify(frame));
        return;
      }

      // Anything else Hermes sends (a notification with no id we do not
      // recognise) is forwarded as-is; refusing to relay an unrecognised but
      // well-formed frame would be a regression from the transparent forward
      // this replaces.
      broadcast(state, JSON.stringify(frame));
    } catch (error) {
      log.error(`Error handling upstream frame for ${state.login}:`, error);
    }
  }

  function connectUpstream(state) {
    let ws;
    try {
      // Hermes's own DNS-rebinding guard checks Origin, so the handshake
      // carries the loopback origin -- never a phone's. That is safe only
      // because a phone never reaches this function without having already
      // passed isSameOrigin() in server.mjs; this file never sees, let alone
      // forwards, anything the phone itself sent as a header.
      ws = new WebSocket(upstreamUrl(hermesOrigin, sessionToken), {
        origin: hermesOrigin,
        perMessageDeflate: false,
        // A Hermes that accepts the TCP connection and then hangs would
        // otherwise hold every phone on this login in the buffered state
        // until the heartbeat gave up on it.
        handshakeTimeout: 10_000,
      });
    } catch (error) {
      log.error(`Failed to open Hermes upstream for ${state.login}:`, error);
      return;
    }
    state.upstream = ws;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('open', () => {
      try {
        flushOutbound(state);
      } catch (error) {
        log.error(`Error flushing buffered frames for ${state.login}:`, error);
      }
    });
    ws.on('message', (data, isBinary) => handleUpstreamMessage(state, data, isBinary));
    ws.on('close', () => {
      try {
        upstreamGone(state);
      } catch (error) {
        log.error(`Error tearing down upstream for ${state.login}:`, error);
      }
    });
    ws.on('error', (error) => {
      log.error(`Hermes upstream error for ${state.login}:`, error.message);
      // 'close' follows every failure mode ws itself produces here, and
      // upstreamGone() is idempotent -- this is just so a phone waiting on a
      // handshake that will never open is not left hanging until the next
      // heartbeat notices.
      try {
        upstreamGone(state);
      } catch (cleanupError) {
        log.error(`Error tearing down upstream for ${state.login}:`, cleanupError);
      }
    });
  }

  function handlePhoneMessage(state, phone, data, isBinary) {
    try {
      // upstreamGone() empties `phones` before the 1012 closes it sent have
      // fired; a frame this phone squeezes in between would otherwise be
      // buffered and flushed into the *next* upstream, for another phone.
      if (!state.phones.has(phone)) return;
      const frame = parseFrame(data, isBinary);
      if (!frame) return;

      if (frame.method === 'approval.respond' && frame.params?.request_id) {
        state.pendingApprovals.delete(frame.params.request_id);
      }

      if (frame.id === undefined) {
        sendUpstream(state, JSON.stringify(frame));
        return;
      }

      const upstreamId = `${phone.seq}.${frame.id}`;
      state.pendingById.set(upstreamId, {
        phone,
        originalId: frame.id,
        method: frame.method,
        storedId: frame.method === 'session.resume' ? frame.params?.session_id : undefined,
      });
      sendUpstream(state, JSON.stringify({ ...frame, id: upstreamId }));
    } catch (error) {
      log.error(`Error handling phone frame for ${state.login}:`, error);
    }
  }

  function detachPhone(state, phone) {
    state.phones.delete(phone);
    for (const [id, entry] of state.pendingById) {
      if (entry.phone === phone) state.pendingById.delete(id);
    }
    // The upstream is untouched. That is the entire point of this file: it
    // keeps receiving events, including whichever one is the reason a push
    // notification needs to fire, with nobody attached to see it live.
  }

  function attachPhone(state, ws) {
    const phone = { ws, seq: state.nextPhoneSeq++ };
    state.phones.add(phone);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => handlePhoneMessage(state, phone, data, isBinary));
    ws.on('close', () => {
      try {
        detachPhone(state, phone);
      } catch (error) {
        log.error(`Error detaching phone for ${state.login}:`, error);
      }
    });
    ws.on('error', (error) => {
      log.error(`Phone socket error for ${state.login}:`, error.message);
    });

    // Catch it up on whatever it missed while it was gone -- the reason this
    // file exists. The client dedupes by request_id, so replaying one it has
    // already answered is harmless.
    for (const { frame } of state.pendingApprovals.values()) {
      safeSend(ws, JSON.stringify(frame));
    }

    if (!state.upstream) connectUpstream(state);
  }

  function accept(request, socket, head, login) {
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        try {
          attachPhone(getLogin(login), ws);
        } catch (error) {
          log.error('Failed to attach phone to gateway:', error);
          safeClose(ws, 1011, 'internal error');
        }
      });
    } catch (error) {
      log.error('WebSocket handshake failed:', error);
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const state of logins.values()) {
      const upstream = state.upstream;
      if (upstream) {
        if (upstream.isAlive === false) {
          upstream.terminate();
        } else {
          upstream.isAlive = false;
          try {
            upstream.ping();
          } catch {
            // A terminate() the next tick will notice cleans this up either way.
          }
        }
      }
      for (const phone of state.phones) {
        if (phone.ws.isAlive === false) {
          phone.ws.terminate();
          continue;
        }
        phone.ws.isAlive = false;
        try {
          phone.ws.ping();
        } catch {
          // As above.
        }
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const state of logins.values()) {
      for (const phone of state.phones) safeClose(phone.ws, 1001, 'server shutting down');
      safeClose(state.upstream, 1001, 'server shutting down');
    }
    wss.close();
  }

  function stats() {
    let phones = 0;
    let active = 0;
    for (const state of logins.values()) {
      phones += state.phones.size;
      if (state.upstream || state.phones.size > 0) active += 1;
    }
    return { logins: active, phones };
  }

  return { accept, close, stats };
}
