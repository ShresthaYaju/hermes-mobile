// demo.mjs, the stand-in backend used for screenshots.
//
// The point of the demo is that the real proxy and the real UI run unchanged
// in front of it, so these tests go through server.mjs rather than at the
// stand-in directly: what the proxy's allowlist lets through has to come back
// in the shapes the views read, and the scripted chat has to speak the same
// JSON-RPC the gateway relays.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { startProxy } from './helpers.mjs';
import { startDemoHermes, buildFixtures } from '../demo.mjs';

async function stack(t) {
  const demo = await startDemoHermes({ delay: 0 });
  const proxy = await startProxy({ hermesOrigin: demo.origin });
  t.after(async () => {
    await proxy.stop();
    await demo.stop();
  });
  const get = async (path) => {
    const response = await fetch(`${proxy.origin}${path}`);
    assert.equal(response.status, 200, `${path} -> ${response.status}`);
    return response.json();
  };
  return { demo, proxy, get };
}

/** Open the JSON-RPC socket through the proxy and collect what comes back. */
async function openSocket(proxy) {
  const ws = new WebSocket(`${proxy.origin.replace('http', 'ws')}/api/ws`);
  await once(ws, 'open');
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
  let counter = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `t${(counter += 1)}`;
      const listener = (data) => {
        const frame = JSON.parse(data.toString('utf8'));
        if (frame.id !== id) return;
        ws.off('message', listener);
        if (frame.error) reject(new Error(frame.error.message));
        else resolve(frame.result);
      };
      ws.on('message', listener);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  const eventsFor = (sid) =>
    frames.filter((f) => f.method === 'event' && f.params.session_id === sid).map((f) => f.params);
  const until = async (predicate, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for an event');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { ws, call, eventsFor, until, close: () => ws.close() };
}

test('the fixtures are dated relative to now and internally consistent', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  const f = buildFixtures(now);
  for (const session of f.sessions) {
    assert.ok(session.started_at <= now / 1000, `${session.id} starts in the past`);
    assert.equal(session.message_count, f.messages.get(session.id).length);
    assert.match(session.id, /^(\d{8}_\d{6}_[0-9a-f]{6}|cron_[a-z-]+_\d{8}T\d{6})$/);
  }
  const runs = f.sessions.filter((s) => s.source === 'cron');
  for (const run of runs) {
    const job = f.jobs.find((j) => run.id.startsWith(`cron_${j.id}_`));
    assert.ok(job, `${run.id} belongs to a job`);
  }
  assert.ok(f.jobs.some((j) => j.state === 'paused' && j.enabled === false));
  assert.ok(f.jobs.some((j) => j.last_status === 'error' && j.last_error));
  assert.ok(f.jobs.some((j) => j.last_delivery_error));
  assert.ok(f.profiles.some((p) => p.is_default));
  assert.ok(
    f.sessions.some((s) => s.source === 'hermes-mobile'),
    'threads the app owns',
  );
  assert.ok(f.sessions.some((s) => s.source === 'telegram' && /^-100/.test(s.chat_id)));
});

test('every read the screens make comes back through the proxy in shape', async (t) => {
  const { get } = await stack(t);

  const status = await get('/api/status');
  assert.equal(status.gateway_running, true);
  assert.equal(status.gateway_platforms.telegram.state, 'connected');

  const threads = await get(
    '/api/sessions?limit=50&order=recent&min_messages=1&archived=exclude&exclude_sources=cron%2Csubagent%2Ctool',
  );
  assert.ok(threads.sessions.length >= 5);
  assert.ok(threads.sessions.every((s) => !['cron', 'subagent'].includes(s.source)));
  const first = threads.sessions[0];
  assert.ok(first.last_active >= threads.sessions.at(-1).last_active, 'most recent first');

  const mine = await get('/api/sessions?source=hermes-mobile&limit=1&order=recent&min_messages=1');
  assert.equal(mine.sessions[0].source, 'hermes-mobile');

  const session = await get(`/api/sessions/${encodeURIComponent(mine.sessions[0].id)}`);
  assert.equal(session.id, mine.sessions[0].id);
  const history = await get(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=200`);
  assert.ok(history.messages.length >= 2);
  const call = history.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(call, 'an assistant message with a structured tool call');
  assert.ok(
    history.messages.some((m) => m.role === 'tool' && m.tool_call_id === call.tool_calls[0].id),
  );

  const found = await get('/api/sessions/search?q=lisbon&limit=40');
  assert.equal(found.sessions.length, 1);

  const jobs = await get('/api/cron/jobs?profile=all');
  assert.ok(Array.isArray(jobs) && jobs.length >= 4);
  const failing = jobs.find((j) => j.last_status === 'error');
  const runs = await get(`/api/cron/jobs/${failing.id}/runs?limit=25`);
  assert.ok(runs.runs.length >= 2);
  assert.ok(
    runs.runs.some((r) => r.end_reason && r.end_reason !== 'cron_complete'),
    'a failed run',
  );

  const profiles = await get('/api/profiles');
  assert.ok(profiles.profiles.some((p) => p.is_default));
  const model = await get('/api/model/info');
  assert.ok(model.model && model.provider && model.effective_context_length > 0);
  const options = await get('/api/model/options');
  assert.ok(options.providers.some((p) => p.models.length));
});

test('job controls and session edits change what is read back', async (t) => {
  const { proxy, get } = await stack(t);
  const post = (path, body) =>
    fetch(`${proxy.origin}${path}`, {
      method: body === undefined ? 'POST' : 'PUT',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  assert.equal((await post('/api/cron/jobs/inbox-triage/pause')).status, 200);
  let jobs = await get('/api/cron/jobs?profile=all');
  assert.equal(jobs.find((j) => j.id === 'inbox-triage').state, 'paused');
  assert.equal((await post('/api/cron/jobs/inbox-triage/resume')).status, 200);
  jobs = await get('/api/cron/jobs?profile=all');
  assert.equal(jobs.find((j) => j.id === 'inbox-triage').state, 'scheduled');
  assert.equal(
    (await post('/api/cron/jobs/inbox-triage', { updates: { prompt: 'new prompt' } })).status,
    200,
  );
  jobs = await get('/api/cron/jobs?profile=all');
  assert.equal(jobs.find((j) => j.id === 'inbox-triage').prompt, 'new prompt');

  const mine = await get('/api/sessions?source=hermes-mobile&limit=1&order=recent&min_messages=1');
  const id = mine.sessions[0].id;
  const patched = await fetch(`${proxy.origin}/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(patched.status, 200);
  const after = await get(
    '/api/sessions?source=hermes-mobile&limit=50&order=recent&min_messages=1',
  );
  assert.ok(!after.sessions.some((s) => s.id === id), 'archived threads leave the list');
});

test('a chat streams a scripted reply and stores it as a thread', async (t) => {
  const { proxy, get } = await stack(t);
  const rpc = await openSocket(proxy);
  t.after(() => rpc.close());

  const created = await rpc.call('session.create', { source: 'hermes-mobile' });
  assert.match(created.session_id, /^[0-9a-f]{8}$/);
  assert.match(created.stored_session_id, /^\d{8}_\d{6}_[0-9a-f]{6}$/);

  const submitted = await rpc.call('prompt.submit', {
    session_id: created.session_id,
    text: 'Are the tests green now?',
  });
  assert.equal(submitted.status, 'streaming');
  await rpc.until(() =>
    rpc.eventsFor(created.session_id).some((e) => e.type === 'message.complete'),
  );
  const types = rpc.eventsFor(created.session_id).map((e) => e.type);
  assert.ok(types.includes('message.start'));
  assert.ok(types.includes('tool.start'));
  assert.ok(types.includes('message.delta'));
  const done = rpc.eventsFor(created.session_id).find((e) => e.type === 'message.complete');
  assert.match(done.payload.text, /213 passed/);

  const history = await get(`/api/sessions/${created.stored_session_id}/messages?limit=200`);
  assert.deepEqual(
    history.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  const listed = await get(
    '/api/sessions?source=hermes-mobile&limit=1&order=recent&min_messages=1',
  );
  assert.equal(listed.sessions[0].id, created.stored_session_id);
  assert.equal(listed.sessions[0].title, 'Are the tests green now?');

  // Resuming the stored thread hands back a fresh live handle for it.
  const resumed = await rpc.call('session.resume', {
    session_id: created.stored_session_id,
    source: 'hermes-mobile',
  });
  assert.equal(resumed.stored_session_id, created.stored_session_id);
  assert.notEqual(resumed.session_id, created.session_id);
});

test('a risky prompt raises an approval, and the answer decides the reply', async (t) => {
  const { proxy } = await stack(t);
  const rpc = await openSocket(proxy);
  t.after(() => rpc.close());

  const created = await rpc.call('session.create', { source: 'hermes-mobile' });
  const sid = created.session_id;
  await rpc.call('prompt.submit', { session_id: sid, text: 'Deploy the api to production' });
  await rpc.until(() => rpc.eventsFor(sid).some((e) => e.type === 'approval.request'));
  const approval = rpc.eventsFor(sid).find((e) => e.type === 'approval.request').payload;
  assert.match(approval.command, /deploy/);
  assert.deepEqual(approval.choices, ['once', 'session', 'always', 'deny']);

  await rpc.call('approval.respond', {
    session_id: sid,
    request_id: approval.request_id,
    choice: 'once',
  });
  await rpc.until(() => rpc.eventsFor(sid).some((e) => e.type === 'message.complete'));
  const done = rpc.eventsFor(sid).find((e) => e.type === 'message.complete');
  assert.match(done.payload.text, /^Ran `git push/);

  // Denied: nothing runs, and the reply says so.
  const second = await rpc.call('session.create', { source: 'hermes-mobile' });
  await rpc.call('prompt.submit', { session_id: second.session_id, text: 'restart the api' });
  await rpc.until(() =>
    rpc.eventsFor(second.session_id).some((e) => e.type === 'approval.request'),
  );
  const request = rpc
    .eventsFor(second.session_id)
    .find((e) => e.type === 'approval.request').payload;
  await rpc.call('approval.respond', {
    session_id: second.session_id,
    request_id: request.request_id,
    choice: 'deny',
  });
  await rpc.until(() =>
    rpc.eventsFor(second.session_id).some((e) => e.type === 'message.complete'),
  );
  assert.match(
    rpc.eventsFor(second.session_id).find((e) => e.type === 'message.complete').payload.text,
    /not run it/,
  );

  // A clarify prompt for an ambiguous question.
  const third = await rpc.call('session.create', { source: 'hermes-mobile' });
  await rpc.call('prompt.submit', {
    session_id: third.session_id,
    text: 'Which database should I back up?',
  });
  await rpc.until(() => rpc.eventsFor(third.session_id).some((e) => e.type === 'clarify.request'));
  const clarify = rpc.eventsFor(third.session_id).find((e) => e.type === 'clarify.request').payload;
  assert.ok(clarify.question && clarify.request_id);
  await rpc.call('clarify.respond', {
    session_id: third.session_id,
    request_id: clarify.request_id,
    answer: 'staging',
  });
  await rpc.until(() => rpc.eventsFor(third.session_id).some((e) => e.type === 'message.complete'));
  assert.match(
    rpc.eventsFor(third.session_id).find((e) => e.type === 'message.complete').payload.text,
    /^Going with staging/,
  );
});
