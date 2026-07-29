import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    async stop() {
      if (exited) return;
      child.kill('SIGKILL');
      await exit;
    },
  };
}

/** A stand-in for `hermes serve`, recording what the proxy forwards upstream. */
export async function startFakeHermes() {
  const requests = [];
  const upgrades = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ upstream: true, url: request.url }));
  });
  server.on('upgrade', (request, socket) => {
    upgrades.push({ url: request.url, headers: request.headers });
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    upgrades,
    async stop() {
      server.close();
      await once(server, 'close');
    },
  };
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
