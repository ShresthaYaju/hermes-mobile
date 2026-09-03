// gateway.mjs: the session multiplexer that replaces the old transparent
// proxy.ws() forward.
//
// These drive createGateway() directly against two tiny in-process HTTP
// servers -- one standing in for a phone-facing front door, one standing in
// for Hermes -- rather than the full server.mjs. The identity/origin/host
// gates that decide whether an upgrade reaches this far are already covered
// by hardening.test.mjs; what belongs here is what happens once one has:
// id rewriting, event fan-out, approval replay, and the upstream's
// independence from any one phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../gateway.mjs';
import { startFakeHermes, waitFor } from './helpers.mjs';

/** A phone-facing front door that hands every upgrade straight to the
 *  gateway, addressed to whichever login the query string names. */
async function startGatewayHarness({ hermesOrigin, sessionToken = 'secret-token', observe }) {
  const gateway = createGateway({
    hermesOrigin,
    sessionToken,
    observe: observe ?? (async () => {}),
    // Silent by default: several tests below deliberately send garbage and
    // would otherwise spam the test run's own stderr.
    log: { error() {}, warn() {} },
  });
  const server = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://harness');
    gateway.accept(request, socket, head, url.searchParams.get('login') || 'local');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    gateway,
    async stop() {
      gateway.close();
      server.close();
      await once(server, 'close');
    },
  };
}

/** A phone: a plain `ws` client with its received frames collected in order. */
function connectPhone(port, { login = 'local', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?login=${encodeURIComponent(login)}`, {
      headers,
    });
    ws.messages = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        ws.messages.push(JSON.parse(data.toString('utf8')));
      } catch {
        // None of these tests send a phone anything but well-formed JSON.
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeAndWait(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

function event(type, sessionId, payload = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type, session_id: sessionId, payload },
  });
}

async function harnessFor(t, options = {}) {
  const hermes = await startFakeHermes();
  const harness = await startGatewayHarness({ hermesOrigin: hermes.origin, ...options });
  t.after(async () => {
    await harness.stop();
    await hermes.stop();
  });
  return { hermes, harness };
}

test('a phone id is rewritten upstream and restored on response; two phones sharing an id do not collide', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  const phoneA = await connectPhone(harness.port);
  const phoneB = await connectPhone(harness.port);
  // One login, one shared upstream -- the second attach must not open a
  // second connection to Hermes.
  await waitFor(() => hermes.sockets.length === 1);

  phoneA.send(JSON.stringify({ jsonrpc: '2.0', id: 'm1', method: 'session.create', params: {} }));
  phoneB.send(JSON.stringify({ jsonrpc: '2.0', id: 'm1', method: 'session.create', params: {} }));
  await waitFor(() => hermes.frames.length === 2);

  const [frameA, frameB] = hermes.frames;
  assert.notEqual(frameA.id, 'm1', 'the id that reaches Hermes must not be the raw client id');
  assert.notEqual(frameA.id, frameB.id, 'two phones minting the same id must not collide upstream');

  // Answer out of order, addressed by the rewritten ids -- exactly what the
  // worker-pool responses this gateway exists for do in practice.
  hermes.sockets[0].send(
    JSON.stringify({ jsonrpc: '2.0', id: frameB.id, result: { session_id: 'sB' } }),
  );
  hermes.sockets[0].send(
    JSON.stringify({ jsonrpc: '2.0', id: frameA.id, result: { session_id: 'sA' } }),
  );
  await waitFor(() => phoneA.messages.length === 1 && phoneB.messages.length === 1);

  assert.equal(
    phoneA.messages[0].id,
    'm1',
    'phone A must see its own id back, not the rewritten one',
  );
  assert.equal(phoneA.messages[0].result.session_id, 'sA');
  assert.equal(phoneB.messages[0].id, 'm1');
  assert.equal(phoneB.messages[0].result.session_id, 'sB');
});

test('an event is broadcast to every phone attached to the login', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  const phoneA = await connectPhone(harness.port);
  const phoneB = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);

  hermes.sockets[0].send(event('message.start', 's1'));

  await waitFor(() => phoneA.messages.length === 1 && phoneB.messages.length === 1);
  assert.equal(phoneA.messages[0].params.type, 'message.start');
  assert.equal(phoneB.messages[0].params.type, 'message.start');
});

test('observe reflects whether a phone is attached, and the upstream survives a phone disconnecting', async (t) => {
  const events = [];
  const { hermes, harness } = await harnessFor(t, {
    observe: async (e) => {
      events.push(e);
    },
  });

  const phone = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);

  hermes.sockets[0].send(event('message.start', 's1'));
  await waitFor(() => events.length === 1);
  assert.equal(events[0].attached, true);

  await closeAndWait(phone);
  await waitFor(() => harness.gateway.stats().phones === 0);
  assert.equal(hermes.sockets.length, 1, 'the upstream must not close when the phone does');

  hermes.sockets[0].send(event('message.start', 's1'));
  await waitFor(() => events.length === 2);
  assert.equal(events[1].attached, false, 'nobody is attached to see this one live');
});

test('a missed approval is replayed to the next phone, and forgotten once answered or completed', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  // Nobody is attached when the approval arrives.
  const opener = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);
  await closeAndWait(opener);
  await waitFor(() => harness.gateway.stats().phones === 0);

  hermes.sockets[0].send(event('approval.request', 's1', { request_id: 'r1', text: 'ok?' }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const catchesUp = await connectPhone(harness.port);
  await waitFor(() => catchesUp.messages.length === 1);
  assert.equal(catchesUp.messages[0].params.payload.request_id, 'r1');

  // The phone answers it -- a later attach must not see it again.
  catchesUp.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'm1',
      method: 'approval.respond',
      params: { request_id: 'r1', approved: true },
    }),
  );
  await waitFor(() => hermes.frames.some((f) => f.method === 'approval.respond'));
  await closeAndWait(catchesUp);
  await waitFor(() => harness.gateway.stats().phones === 0);

  const afterAnswer = await connectPhone(harness.port);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(afterAnswer.messages.length, 0, 'an answered approval must not be replayed');
  await closeAndWait(afterAnswer);
  await waitFor(() => harness.gateway.stats().phones === 0);

  // A second approval, this time cleared by the turn ending instead of a reply.
  hermes.sockets[0].send(event('approval.request', 's2', { request_id: 'r2', text: 'ok?' }));
  hermes.sockets[0].send(event('message.complete', 's2'));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const afterComplete = await connectPhone(harness.port);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    afterComplete.messages.length,
    0,
    'a completed session must not replay its approval',
  );
});

test('threadId in observe is populated after session.create and after session.resume', async (t) => {
  const events = [];
  const { hermes, harness } = await harnessFor(t, {
    observe: async (e) => {
      events.push(e);
    },
  });

  const phone = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);

  phone.send(JSON.stringify({ jsonrpc: '2.0', id: 'c1', method: 'session.create', params: {} }));
  await waitFor(() => hermes.frames.length === 1);
  hermes.sockets[0].send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: hermes.frames[0].id,
      result: { session_id: 'live-1', stored_session_id: 'thread-1' },
    }),
  );
  await waitFor(() => phone.messages.length === 1);

  hermes.sockets[0].send(event('message.start', 'live-1'));
  await waitFor(() => events.length === 1);
  assert.equal(events[0].threadId, 'thread-1');

  // session.resume: the stored id travels in on params.session_id, the live
  // id comes back on result.session_id.
  phone.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'r1',
      method: 'session.resume',
      params: { session_id: 'thread-2' },
    }),
  );
  await waitFor(() => hermes.frames.length === 2);
  hermes.sockets[0].send(
    JSON.stringify({ jsonrpc: '2.0', id: hermes.frames[1].id, result: { session_id: 'live-2' } }),
  );
  await waitFor(() => phone.messages.length === 2);

  hermes.sockets[0].send(event('message.start', 'live-2'));
  await waitFor(() => events.length === 2);
  assert.equal(events[1].threadId, 'thread-2');
});

test('invalid JSON, binary and array frames from a phone are dropped, not fatal', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  const phone = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);

  phone.send('not json');
  phone.send(Buffer.from([1, 2, 3]));
  phone.send(JSON.stringify([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(hermes.frames.length, 0, 'nothing malformed may reach the upstream');
  assert.equal(phone.readyState, WebSocket.OPEN, 'sending garbage must not close the phone');

  // Nothing wedged: an ordinary frame still gets through afterward.
  phone.send(JSON.stringify({ jsonrpc: '2.0', id: 'm1', method: 'ping', params: {} }));
  await waitFor(() => hermes.frames.length === 1);
  assert.equal(hermes.frames[0].method, 'ping');
});

test('an upstream close drops attached phones with 1012, and the next attach opens a fresh upstream', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  const phone = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);

  const closeCode = new Promise((resolve) => phone.once('close', (code) => resolve(code)));
  hermes.sockets[0].close();
  assert.equal(await closeCode, 1012, 'the browser client only auto-reconnects on this code');
  await waitFor(() => hermes.sockets.length === 0);

  const second = await connectPhone(harness.port);
  await waitFor(() => hermes.sockets.length === 1);
  assert.equal(hermes.upgrades.length, 2, 'the new attach must open its own upstream connection');
  await closeAndWait(second);
});

test('no phone header reaches the upstream handshake, and its Origin is always the Hermes origin', async (t) => {
  const { hermes, harness } = await harnessFor(t);

  await connectPhone(harness.port, {
    headers: {
      Cookie: 'session=forged',
      'Tailscale-User-Login': 'someone@example.com',
      Authorization: 'Bearer forged',
    },
  });
  await waitFor(() => hermes.upgrades.length === 1);

  const { headers } = hermes.upgrades[0];
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['tailscale-user-login'], undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.origin, hermes.origin, 'never the phone’s Origin, always the loopback one');
});
