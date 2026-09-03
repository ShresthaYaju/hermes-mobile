import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Spawn the real server.mjs on an ephemeral port and resolve once it reports
 * the port it actually bound. Tests exercise the shipped process, not a
 * re-implementation of it.
 */
export async function startProxy({
  hermesOrigin = 'http://127.0.0.1:1',
  token = 'test-token',
  env = {},
} = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      HERMES_ORIGIN: hermesOrigin,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      // Never let a test inherit real VAPID keys from the developer's shell and
      // start pushing to actual devices.
      HERMES_MOBILE_VAPID_PUBLIC_KEY: '',
      HERMES_MOBILE_VAPID_PRIVATE_KEY: '',
      // Suites that predate tailnet identity exercise other concerns and send
      // no identity headers. Admit host-local callers by default so they keep
      // testing what they were written to test; identity.test.mjs opts out.
      HERMES_MOBILE_ALLOW_LOCAL: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  let exited = false;
  const exit = once(child, 'exit').then(([code]) => {
    exited = true;
    return code;
  });

  child.stdout.setEncoding('utf8');
  let buffered = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10000);
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const match = buffered.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    exit.then(() => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${stderr.join('')}`));
    });
  });

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    get exited() {
      return exited;
    },
    stderr: () => stderr.join(''),
    // The audit trail is written to stdout, so tests read it from there.
    stdout: () => buffered,
    async stop() {
      if (exited) return;
      child.kill('SIGKILL');
      await exit;
    },
  };
}

/**
 * A stand-in for `hermes serve`, recording what the proxy forwards upstream.
 *
 * The gateway keeps its upstream connection open for as long as the login has
 * ever had a phone attached, so this now completes the JSON-RPC handshake for
 * real rather than destroying the socket -- tests need to send events down it
 * (`fake.sockets[0].send(...)`) and read what the gateway relayed up
 * (`fake.frames`, or a socket's own `.messages`).
 */
export async function startFakeHermes() {
  const requests = [];
  const upgrades = [];
  const sockets = [];
  const frames = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ upstream: true, url: request.url }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ url: request.url, headers: request.headers });
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.messages = [];
      sockets.push(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const frame = JSON.parse(data.toString('utf8'));
          frames.push(frame);
          ws.messages.push(frame);
        } catch {
          // Not a test this helper needs to support -- the gateway's own
          // frame parsing is exercised directly in gateway.test.mjs.
        }
      });
      ws.on('close', () => {
        const index = sockets.indexOf(ws);
        if (index >= 0) sockets.splice(index, 1);
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    upgrades,
    sockets,
    frames,
    async stop() {
      for (const ws of sockets.slice()) ws.terminate();
      wss.close();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * Poll until `predicate()` is truthy. The gateway completes a phone's
 * handshake before its upstream connection to Hermes finishes -- the two are
 * independent, unlike the old transparent proxy.ws() forward where a client
 * only ever saw its own 101 after the upstream's had already arrived -- so a
 * test that wants to observe the upstream side can no longer assume it is
 * already there the instant the phone-side await resolves.
 */
export async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Raw request helper -- undici/fetch rejects some of the malformed paths we test. */
export function rawGet(port, path, headers = {}) {
  return rawRequest(port, 'GET', path, headers);
}

export function rawRequest(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length, ...headers }
          : headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/** Attempt a WebSocket upgrade and report how the proxy handled it. */
export function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    const done = (value) => resolve(value);
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      done({ outcome: 'upgraded', status: response.statusCode });
    });
    request.on('response', (response) => {
      response.resume();
      done({ outcome: 'response', status: response.statusCode });
    });
    request.on('error', () => done({ outcome: 'destroyed' }));
    request.setTimeout(5000, () => {
      request.destroy();
      reject(new Error('upgrade timed out'));
    });
    request.end();
  });
}
