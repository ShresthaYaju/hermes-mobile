// JSON-RPC 2.0 over the WebSocket the proxy authenticates for us.
//
// Two behaviours of the Hermes gateway shape this client:
//   * Events are addressed per session and delivered only to the transport
//     that last touched that session. There is no subscribe or broadcast, so
//     we can only observe sessions this app itself created or activated.
//   * Roughly 40 slow methods run on a worker pool and answer out of order,
//     so every response must be correlated by id, never by arrival.

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Agent turns routinely run for minutes; only the call itself is bounded.
const CALL_TIMEOUT_MS = 120000;

export class HermesSocket extends EventTarget {
  #socket = null;
  #pending = new Map();
  #counter = 0;
  #attempts = 0;
  #timer = null;
  #closed = false;

  state = 'idle';

  connect() {
    this.#closed = false;
    this.#open();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = null;
  }

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  #setState(state, detail) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  #open() {
    clearTimeout(this.#timer);
    this.#setState('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#attempts = 0;
      this.#setState('live');
    });

    socket.addEventListener('message', ({ data }) => {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.id && this.#pending.has(frame.id)) {
        const waiter = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        clearTimeout(waiter.timer);
        if (frame.error)
          waiter.reject(new Error(frame.error.message || 'Hermes returned an error'));
        else waiter.resolve(frame.result);
        return;
      }
      if (frame.method === 'event' && frame.params) {
        this.dispatchEvent(new CustomEvent('event', { detail: frame.params }));
      }
    });

    const drop = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      for (const waiter of this.#pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Connection closed'));
      }
      this.#pending.clear();
      if (this.#closed) return;
      this.#setState('offline');
      this.#scheduleReconnect();
    };
    socket.addEventListener('close', drop);
    socket.addEventListener('error', drop);
  }

  // Exponential backoff with jitter. The previous flat 2.5s retry hammered a
  // restarting backend hard enough to be a self-inflicted denial of service.
  #scheduleReconnect() {
    this.#attempts += 1;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (this.#attempts - 1), RECONNECT_MAX_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.#timer = setTimeout(() => this.#open(), delay);
  }

  call(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Hermes'));
    const id = `m${(this.#counter += 1)}`;
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }
}

export const socket = new HermesSocket();
