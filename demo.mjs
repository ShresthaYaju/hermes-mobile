// A stand-in Hermes backend full of invented data, for screenshots.
//
//   npm run demo               the app on http://127.0.0.1:4174 with the real
//                              proxy in front, talking to this instead of Hermes
//   npm run demo -- --local    also admit the desktop browser on this machine
//   npm run demo -- --port N   listen somewhere other than 4174
//
// Nothing here touches the real Hermes install: the sessions, scheduled jobs,
// profiles and transcripts below are made up, live only in this process's
// memory, and are rebuilt from scratch every start. The proxy is the shipped
// server.mjs, unchanged, so what the screen shows is exactly what the app
// looks like -- only the data behind it is fiction.
//
// To photograph the phone, the phone has to reach this proxy instead of the
// one systemd runs. Both bind the same port, so stop the service first:
//
//   systemctl --user stop hermes-mobile-pwa.service
//   npm run demo
//   ...take the pictures...
//   systemctl --user start hermes-mobile-pwa.service
//
// `tailscale serve` keeps forwarding to the port throughout, and the identity
// allowlist is read from the same env file the service uses, so the phone
// signs in exactly as it normally does. Push stays off: no VAPID keys are
// given to the proxy, so nothing invented is ever delivered to a real device.
//
// The chat is scripted. Any message gets a streamed reply with a tool call in
// it; one that mentions deploying, restarting or deleting something first
// raises an approval so the "Needs you" card can be captured; one ending in a
// question mark about a choice raises a clarify prompt instead.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const repoRoot = dirname(fileURLToPath(import.meta.url));

// --- fixtures ---------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const PROVIDER = 'anthropic';

/** ISO 8601 with the host's own offset, the way the cron store writes it. */
function isoLocal(ms) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const local = new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** A stored session id in Hermes's own shape: 20260903_101500_ab12cd. */
function storedId(ms, suffix = randomBytes(3).toString('hex')) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${suffix}`
  );
}

/**
 * Everything the screens read, dated relative to `nowMs` so the app shows
 * "12m ago" and "in 3h" rather than a fixed day in the past.
 */
export function buildFixtures(nowMs = Date.now()) {
  const now = nowMs / 1000;
  const minutes = (n) => now - n * 60;
  const hours = (n) => minutes(n * 60);
  const days = (n) => hours(n * 24);

  const sessions = [];
  const messages = new Map();
  let messageId = 1;

  const say = (sessionId, role, content, extra = {}) => {
    const list = messages.get(sessionId) ?? [];
    messages.set(sessionId, list);
    const previous = list.at(-1);
    list.push({
      id: messageId++,
      session_id: sessionId,
      role,
      content,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: previous
        ? previous.timestamp + 4
        : sessions.find((s) => s.id === sessionId).started_at,
      token_count: Math.ceil(String(content ?? '').length / 4),
      finish_reason: role === 'assistant' ? 'stop' : null,
      reasoning: null,
      ...extra,
    });
  };

  const addSession = (session) => {
    const row = {
      user_id: 'owner',
      session_key: null,
      chat_id: null,
      chat_type: null,
      thread_id: null,
      display_name: null,
      model: MODEL,
      parent_session_id: null,
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cwd: '/home/ada/projects/lighthouse',
      git_branch: 'main',
      title: null,
      profile_name: 'default',
      archived: false,
      ...session,
    };
    sessions.push(row);
    return row;
  };

  const finish = (session, endReason = null) => {
    const list = messages.get(session.id) ?? [];
    session.message_count = list.length;
    session.tool_call_count = list.filter((m) => m.role === 'tool').length;
    session.input_tokens = list.length * 640;
    session.output_tokens = list
      .filter((m) => m.role === 'assistant')
      .reduce((sum, m) => sum + (m.token_count ?? 0), 0);
    session.last_active = list.length ? list.at(-1).timestamp : session.started_at;
    if (endReason) {
      session.ended_at = session.last_active;
      session.end_reason = endReason;
    }
    session.preview = list.find((m) => m.role === 'user')?.content?.slice(0, 63) ?? null;
    session.is_active = session.ended_at === null && now - session.last_active < 300;
  };

  // Threads this app owns, so they open in the composer.
  const ci = addSession({
    id: storedId(nowMs - 22 * 60_000, '4f1a2b'),
    source: 'hermes-mobile',
    started_at: minutes(22),
    title: 'Flaky CI on the lighthouse repo',
    git_branch: 'fix/ci-timeouts',
  });
  say(ci.id, 'user', 'CI has failed three times this morning on main. Can you find out why?');
  say(ci.id, 'assistant', 'Looking at the last three failed runs now.', {
    reasoning:
      'Three failures in a row on main suggests something environmental rather than a bad commit. Check the run logs first, then the test that fails.',
    tool_calls: [
      {
        id: 'call_01',
        type: 'function',
        function: {
          name: 'terminal',
          arguments: JSON.stringify({
            command: 'gh run list --branch main --limit 3 --json conclusion,databaseId,name',
          }),
        },
      },
    ],
  });
  say(
    ci.id,
    'tool',
    '[{"conclusion":"failure","databaseId":91827364,"name":"test"},{"conclusion":"failure","databaseId":91826110,"name":"test"},{"conclusion":"failure","databaseId":91824977,"name":"test"}]',
    { tool_call_id: 'call_01', tool_name: 'terminal' },
  );
  say(
    ci.id,
    'assistant',
    'All three are the `test` workflow. Pulling the log for the latest one.',
    {
      tool_calls: [
        {
          id: 'call_02',
          type: 'function',
          function: {
            name: 'terminal',
            arguments: JSON.stringify({
              command: 'gh run view 91827364 --log-failed | tail -n 40',
            }),
          },
        },
      ],
    },
  );
  say(
    ci.id,
    'tool',
    [
      'FAIL test/session-store.test.ts',
      '  ● SessionStore › expires idle sessions',
      '',
      '    thrown: "Exceeded timeout of 5000 ms for a test."',
      '',
      '      at test/session-store.test.ts:88:3',
      '',
      'Tests: 1 failed, 212 passed, 213 total',
      'Time:  61.2 s',
    ].join('\n'),
    { tool_call_id: 'call_02', tool_name: 'terminal' },
  );
  say(
    ci.id,
    'assistant',
    [
      'Found it. The same test times out every run: **`SessionStore › expires idle sessions`** at `test/session-store.test.ts:88`.',
      '',
      'It waits for a real 5 second idle timer, and the CI runners got slower this week, so it now brushes against the 5000 ms test limit. Nothing in the code under test changed.',
      '',
      'Two fixes, and I would do the first:',
      '',
      '1. Use fake timers in that test and advance the clock instead of sleeping.',
      '2. Raise the timeout for that one test to 15 s.',
      '',
      'Want me to open a PR with the fake-timer version?',
    ].join('\n'),
  );
  finish(ci);

  const trip = addSession({
    id: storedId(nowMs - 3 * 3_600_000, 'c9d0e1'),
    source: 'hermes-mobile',
    started_at: hours(3),
    title: 'Weekend in Lisbon',
    cwd: '/home/ada',
    git_branch: null,
  });
  say(
    trip.id,
    'user',
    'Sketch a two day plan for Lisbon. We land Friday night and fly out Sunday evening.',
  );
  say(
    trip.id,
    'assistant',
    [
      'Here is a plan that keeps the walking to one hill a day.',
      '',
      '**Saturday** · Alfama in the morning while it is quiet, lunch near the Sé, then the tram 28 loop and sunset at Miradouro de Santa Luzia.',
      '',
      '**Sunday** · Belém by train: the monastery first, pastéis de nata after, then back along the river to LX Factory before heading to the airport.',
      '',
      'Say the word and I will add restaurant bookings to the calendar.',
    ].join('\n'),
  );
  say(trip.id, 'user', 'Book nothing yet, but add both days to the calendar as tentative.');
  say(
    trip.id,
    'assistant',
    'Added two tentative all-day events, "Lisbon · Alfama" and "Lisbon · Belém", to your calendar.',
    {
      tool_calls: [
        {
          id: 'call_03',
          type: 'function',
          function: {
            name: 'calendar_create',
            arguments: JSON.stringify({
              title: 'Lisbon · Alfama',
              date: '2026-09-12',
              tentative: true,
            }),
          },
        },
        {
          id: 'call_04',
          type: 'function',
          function: {
            name: 'calendar_create',
            arguments: JSON.stringify({
              title: 'Lisbon · Belém',
              date: '2026-09-13',
              tentative: true,
            }),
          },
        },
      ],
    },
  );
  say(trip.id, 'tool', '{"ok":true,"event_id":"evt_7Q2L"}', {
    tool_call_id: 'call_03',
    tool_name: 'calendar_create',
  });
  say(trip.id, 'tool', '{"ok":true,"event_id":"evt_7Q2M"}', {
    tool_call_id: 'call_04',
    tool_name: 'calendar_create',
  });
  finish(trip);

  const prs = addSession({
    id: storedId(nowMs - 26 * 3_600_000, '77ab10'),
    source: 'hermes-mobile',
    started_at: hours(26),
    title: 'This week in pull requests',
  });
  say(prs.id, 'user', 'Summarise the PRs merged this week, one line each.');
  say(
    prs.id,
    'assistant',
    [
      'Seven merged since Monday:',
      '',
      '- **#412** Retry uploads on 503 with jittered backoff',
      '- **#415** Drop the legacy `/v1/export` route',
      '- **#417** Move session expiry to a background sweep',
      '- **#418** Bump Node to 22 in CI',
      '- **#420** Fix a race in the websocket reconnect',
      '- **#421** Docs: rewrite the deploy runbook',
      '- **#423** Add `--dry-run` to the migration tool',
    ].join('\n'),
    {
      tool_calls: [
        {
          id: 'call_05',
          type: 'function',
          function: {
            name: 'terminal',
            arguments: JSON.stringify({
              command:
                'gh pr list --state merged --search "merged:>=2026-08-31" --json number,title',
            }),
          },
        },
      ],
    },
  );
  say(
    prs.id,
    'tool',
    '[{"number":412,"title":"Retry uploads on 503 with jittered backoff"},{"number":415,"title":"Drop the legacy /v1/export route"},{"number":417,"title":"Move session expiry to a background sweep"},{"number":418,"title":"Bump Node to 22 in CI"},{"number":420,"title":"Fix a race in the websocket reconnect"},{"number":421,"title":"Docs: rewrite the deploy runbook"},{"number":423,"title":"Add --dry-run to the migration tool"}]',
    {
      tool_call_id: 'call_05',
      tool_name: 'terminal',
    },
  );
  finish(prs, 'user_exit');

  // Other surfaces, opened read-only.
  const groceries = addSession({
    id: storedId(nowMs - 55 * 60_000, 'e2f3a4'),
    source: 'telegram',
    started_at: minutes(55),
    chat_id: '-1001987654321',
    chat_type: 'supergroup',
    thread_id: '42',
    display_name: 'Household',
    title: 'Sunday groceries',
    cwd: null,
    git_branch: null,
  });
  say(groceries.id, 'user', 'What did we run out of this week?');
  say(
    groceries.id,
    'assistant',
    'From the pantry notes: olive oil, oat milk, coffee beans, and the good tomatoes. Want that as a list in the shared note?',
  );
  say(groceries.id, 'user', 'Yes, and add lemons.');
  say(groceries.id, 'assistant', 'Done. "Sunday groceries" now has five items, lemons included.');
  finish(groceries);

  const passport = addSession({
    id: storedId(nowMs - 2 * 86_400_000, '1b2c3d'),
    source: 'telegram',
    started_at: days(2),
    chat_id: '48120933',
    chat_type: 'private',
    display_name: 'Ada',
    title: 'Passport renewal',
    cwd: null,
    git_branch: null,
  });
  say(passport.id, 'user', 'Remind me to renew my passport, it expires in March.');
  say(
    passport.id,
    'assistant',
    'Reminder set for 1 December: "Renew passport, expires March". That leaves twelve weeks, which is the processing time plus a margin.',
  );
  finish(passport);

  const auth = addSession({
    id: storedId(nowMs - 5 * 3_600_000, '9a8b7c'),
    source: 'web-pwa',
    started_at: hours(5),
    title: 'Refactor the auth middleware',
    git_branch: 'refactor/auth-middleware',
  });
  say(
    auth.id,
    'user',
    'The auth middleware has grown three separate token parsers. Fold them into one.',
  );
  say(
    auth.id,
    'assistant',
    'I have unified the three parsers into `parseBearer()` with the same tests passing. The diff is in `refactor/auth-middleware`, 4 files, +61 −148.',
    {
      tool_calls: [
        {
          id: 'call_06',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/middleware/auth.ts' }),
          },
        },
      ],
    },
  );
  say(auth.id, 'tool', 'export function parseBearer(header: string | undefined) { ... }', {
    tool_call_id: 'call_06',
    tool_name: 'read_file',
  });
  finish(auth);

  const discord = addSession({
    id: storedId(nowMs - 9 * 3_600_000, '5d6e7f'),
    source: 'discord',
    started_at: hours(9),
    chat_id: '1102938475',
    chat_type: 'channel',
    display_name: '#ops',
    title: 'Disk usage on the build box',
    cwd: null,
    git_branch: null,
  });
  say(discord.id, 'user', 'Build box is at 91% disk. What is eating it?');
  say(
    discord.id,
    'assistant',
    'Docker build cache, 38 GB of it. `docker builder prune` would recover most of that; I have not run it.',
  );
  finish(discord);

  const audit = addSession({
    id: storedId(nowMs - 6 * 3_600_000, 'a1b2c3'),
    source: 'subagent',
    started_at: hours(6),
    parent_session_id: auth.id,
    title: 'Dependency audit for lighthouse',
  });
  say(
    audit.id,
    'user',
    'Audit direct dependencies for known vulnerabilities and report only high or critical.',
  );
  say(
    audit.id,
    'assistant',
    'Two findings: `tar` 6.1.x (path traversal, high) and `semver` 7.3.x (ReDoS, high). Both have patched releases one minor up.',
    {
      tool_calls: [
        {
          id: 'call_07',
          type: 'function',
          function: {
            name: 'terminal',
            arguments: JSON.stringify({ command: 'npm audit --omit=dev --json' }),
          },
        },
      ],
    },
  );
  say(audit.id, 'tool', '{"metadata":{"vulnerabilities":{"high":2,"critical":0}}}', {
    tool_call_id: 'call_07',
    tool_name: 'terminal',
  });
  finish(audit, 'user_exit');

  // Scheduled jobs, and the runs they left behind.
  const jobs = [
    {
      id: 'morning-briefing',
      name: 'Morning briefing',
      prompt:
        'Read the calendar for today, the unread items in the inbox marked important, and the overnight CI results for lighthouse. Write a briefing of at most eight lines and deliver it. Never send anything on my behalf.',
      schedule: { kind: 'cron', expr: '0 8 * * *', display: '0 8 * * *' },
      deliver: 'telegram',
      state: 'scheduled',
      last_status: 'ok',
      last_run_at: isoLocal(nowMs - 6 * 3_600_000 - 12 * 60_000),
      next_run_at: isoLocal(nowMs + 18 * 3_600_000),
    },
    {
      id: 'inbox-triage',
      name: 'Inbox triage',
      prompt:
        'Label new email by urgency. Archive newsletters older than a week. Do not reply to anything.',
      schedule: { kind: 'cron', expr: '*/30 * * * *', display: '*/30 * * * *' },
      deliver: 'local',
      state: 'scheduled',
      last_status: 'ok',
      last_run_at: isoLocal(nowMs - 14 * 60_000),
      next_run_at: isoLocal(nowMs + 16 * 60_000),
    },
    {
      id: 'dependency-audit',
      name: 'Dependency audit',
      prompt:
        'Run npm audit in every checked-out repo under ~/projects. Open an issue for any high or critical finding that does not already have one.',
      schedule: { kind: 'cron', expr: '0 6 * * 1', display: '0 6 * * 1' },
      deliver: 'local',
      state: 'scheduled',
      last_status: 'error',
      last_error: 'npm audit exited 1 in ~/projects/lighthouse: 2 high severity vulnerabilities',
      last_run_at: isoLocal(nowMs - 30 * 3_600_000),
      next_run_at: isoLocal(nowMs + 4 * 86_400_000),
    },
    {
      id: 'notes-backup',
      name: 'Back up notes',
      prompt: 'Sync ~/notes to the notes bucket with rclone. Report only if something fails.',
      schedule: { kind: 'cron', expr: '0 2 * * *', display: '0 2 * * *' },
      deliver: 'local',
      state: 'paused',
      enabled: false,
      paused_reason: 'Paused from the phone while the bucket is being moved',
      paused_at: isoLocal(nowMs - 3 * 86_400_000),
      last_status: 'ok',
      last_run_at: isoLocal(nowMs - 4 * 86_400_000),
      next_run_at: null,
    },
    {
      id: 'weekly-summary',
      name: 'Weekly summary',
      prompt:
        'Summarise merged pull requests, closed issues, and any incidents from the last seven days across all repos. One paragraph per repo.',
      schedule: { kind: 'cron', expr: '0 17 * * 5', display: '0 17 * * 5' },
      deliver: 'telegram',
      state: 'scheduled',
      last_status: 'ok',
      last_delivery_error: 'Telegram: chat not found (-1001987654320)',
      last_run_at: isoLocal(nowMs - 2 * 86_400_000),
      next_run_at: isoLocal(nowMs + 5 * 86_400_000),
    },
  ].map((job) => ({
    enabled: true,
    paused_at: null,
    paused_reason: null,
    last_error: null,
    last_delivery_error: null,
    schedule_display: job.schedule.display,
    repeat: { times: null, completed: 0 },
    created_at: isoLocal(nowMs - 40 * 86_400_000),
    skills: [],
    model: null,
    provider: null,
    script: null,
    no_agent: false,
    context_from: [],
    enabled_toolsets: [],
    workdir: null,
    origin: { platform: 'cli' },
    profile: 'default',
    ...job,
  }));

  const cronRun = (job, ms, { failed = false, lines = [] } = {}) => {
    const stamp = new Date(ms)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, '');
    const run = addSession({
      id: `cron_${job.id}_${stamp}`,
      source: 'cron',
      started_at: ms / 1000,
      title: job.name,
      cwd: '/home/ada',
      git_branch: null,
    });
    say(run.id, 'user', job.prompt);
    if (!failed) {
      say(run.id, 'assistant', lines.join('\n'), {
        tool_calls: [
          {
            id: `call_${run.id}`,
            type: 'function',
            function: { name: 'terminal', arguments: JSON.stringify({ command: 'true' }) },
          },
        ],
      });
      say(run.id, 'tool', '', { tool_call_id: `call_${run.id}`, tool_name: 'terminal' });
    }
    finish(run, failed ? 'error' : 'cron_complete');
    return run;
  };

  const briefing = jobs[0];
  for (const daysAgo of [0, 1, 2]) {
    cronRun(briefing, nowMs - daysAgo * 86_400_000 - 6 * 3_600_000 - 12 * 60_000, {
      lines: [
        '**Today** · Two meetings: design review at 10:00, 1:1 at 15:30.',
        '**Inbox** · One item marked important: the venue contract, due Friday.',
        "**CI** · lighthouse main is green after last night's fix.",
      ],
    });
  }
  const triage = jobs[1];
  for (const n of [0, 1, 2, 3]) {
    cronRun(triage, nowMs - 14 * 60_000 - n * 30 * 60_000, {
      lines: ['Labelled 6 messages: 1 urgent, 2 this week, 3 whenever. Archived 4 newsletters.'],
    });
  }
  cronRun(jobs[2], nowMs - 30 * 3_600_000, { failed: true });
  cronRun(jobs[2], nowMs - 30 * 3_600_000 - 7 * 86_400_000, {
    lines: ['No high or critical findings across 6 repositories.'],
  });
  cronRun(jobs[4], nowMs - 2 * 86_400_000, {
    lines: [
      '**lighthouse** · 7 PRs merged, 11 issues closed, no incidents.',
      '**atlas** · 2 PRs merged, 1 issue closed.',
    ],
  });

  const profiles = [
    {
      name: 'default',
      path: '/home/ada/.hermes',
      is_default: true,
      model: MODEL,
      provider: PROVIDER,
      has_env: true,
      skill_count: 14,
      gateway_running: true,
      description: 'Day to day: code, calendar, and the household chat.',
      description_auto: false,
    },
    {
      name: 'research',
      path: '/home/ada/.hermes/profiles/research',
      is_default: false,
      model: 'claude-opus-5',
      provider: PROVIDER,
      has_env: true,
      skill_count: 6,
      gateway_running: false,
      description: 'Long reads and literature summaries. Slower model, no tools that write.',
      description_auto: false,
    },
    {
      name: 'ops',
      path: '/home/ada/.hermes/profiles/ops',
      is_default: false,
      model: 'claude-haiku-4-5',
      provider: PROVIDER,
      has_env: false,
      skill_count: 3,
      gateway_running: false,
      description: '',
      description_auto: false,
    },
  ];

  const status = {
    version: '0.9.4',
    release_date: '2026-08-28',
    gateway_running: true,
    gateway_pid: 41872,
    gateway_state: 'running',
    gateway_platforms: {
      telegram: { state: 'connected' },
      discord: { state: 'connected' },
    },
    active_agents: [],
    active_sessions: 2,
    gateway_busy: false,
  };

  const modelInfo = {
    model: MODEL,
    provider: PROVIDER,
    auto_context_length: 200_000,
    config_context_length: 0,
    effective_context_length: 200_000,
    capabilities: { supports_tools: true, supports_vision: true, supports_reasoning: true },
  };

  const modelOptions = {
    provider: PROVIDER,
    model: MODEL,
    providers: [
      {
        slug: 'anthropic',
        name: 'Anthropic',
        is_current: true,
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
        authenticated: true,
      },
      {
        slug: 'openai',
        name: 'OpenAI',
        is_current: false,
        models: ['gpt-5', 'gpt-5-mini'],
        authenticated: true,
      },
      {
        slug: 'openrouter',
        name: 'OpenRouter',
        is_current: false,
        models: ['deepseek/deepseek-v3.2', 'qwen/qwen3-coder'],
        authenticated: true,
      },
      { slug: 'ollama', name: 'Ollama', is_current: false, models: [], authenticated: false },
    ],
  };

  return { sessions, messages, jobs, profiles, status, modelInfo, modelOptions };
}

// --- the scripted agent ------------------------------------------------------

const REPLIES = [
  {
    match: /test|ci\b|flaky/i,
    tool: { name: 'terminal', context: 'npm test -- --runInBand' },
    text: 'Ran the suite once more: **213 passed, 0 failed** in 48 s. The fake-timer change holds, so I have pushed it to `fix/ci-timeouts` and opened PR #424.',
  },
  {
    match: /status|deploy|release|prod/i,
    tool: { name: 'terminal', context: 'kubectl rollout status deploy/api' },
    text: 'The `api` rollout finished at 14:02: **12 of 12 pods** on the new image, error rate flat at 0.1%, p95 latency down 9 ms. Nothing to roll back.',
  },
  {
    match: /summar|week|report/i,
    tool: { name: 'read_file', context: '~/notes/week-36.md' },
    text: 'Three things this week: the CI timeout is fixed, the auth middleware refactor is in review, and the dependency audit found two high findings that now have issues. Nothing is blocked.',
  },
  {
    match: /calendar|meeting|tomorrow|schedule/i,
    tool: { name: 'calendar_list', context: 'tomorrow' },
    text: 'Tomorrow has two things on it: **design review** at 10:00 and a dentist appointment at 16:30. The afternoon is otherwise clear.',
  },
];

const DEFAULT_REPLY = {
  tool: { name: 'read_file', context: '~/notes/inbox.md' },
  text: 'Done. I checked the notes and there is nothing outstanding on that. Anything else you want me to look at while I am here?',
};

const APPROVAL_TRIGGER = /\b(deploy|restart|delete|remove|rm|drop|prune|shut ?down)\b/i;
const CLARIFY_TRIGGER = /\b(which|should i|or)\b.*\?\s*$/i;

function commandFor(text) {
  if (/prune/i.test(text)) return 'docker builder prune --force';
  if (/restart/i.test(text)) return 'systemctl restart api.service';
  if (/delete|remove|rm|drop/i.test(text)) return 'rm -rf ./dist ./node_modules/.cache';
  return 'git push origin main && ./scripts/deploy.sh production';
}

/** Split a reply into the chunks Hermes streams, word by word-ish. */
function chunks(text) {
  return text.match(/\S+\s*/g) ?? [text];
}

// --- the backend -------------------------------------------------------------

/**
 * Start the stand-in on an ephemeral loopback port. Resolves to
 * `{ origin, fixtures, stop }`. The proxy is pointed at `origin` exactly as it
 * would be at `hermes serve`.
 */
export async function startDemoHermes({ now = Date.now(), delay = 1 } = {}) {
  const fixtures = buildFixtures(now);
  const { sessions, messages, jobs, profiles, status, modelInfo, modelOptions } = fixtures;
  // Live gateway handles (8 hex) -> stored session id.
  const live = new Map();
  const pending = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * delay));

  const json = (response, code, body) => {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const readBody = (request) =>
    new Promise((resolve) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const rowOf = (session) => {
    const { preview, ...rest } = session;
    return { ...rest, preview, is_active: Boolean(session.is_active) };
  };
  const findSession = (id) => sessions.find((s) => s.id === id);
  const findJob = (id) => jobs.find((j) => j.id === id);

  const listSessions = (query) => {
    const source = query.get('source');
    const exclude = (query.get('exclude_sources') ?? '').split(',').filter(Boolean);
    const minMessages = Number(query.get('min_messages') ?? 0);
    const archived = query.get('archived') ?? 'exclude';
    const limit = Number(query.get('limit') ?? 20);
    const offset = Number(query.get('offset') ?? 0);
    let rows = sessions.filter((s) => {
      if (source && s.source !== source) return false;
      if (exclude.includes(s.source)) return false;
      if (s.message_count < minMessages) return false;
      if (archived === 'exclude' && s.archived) return false;
      if (archived === 'only' && !s.archived) return false;
      return true;
    });
    rows = [...rows].sort((a, b) =>
      query.get('order') === 'recent' ? b.last_active - a.last_active : b.started_at - a.started_at,
    );
    return {
      sessions: rows.slice(offset, offset + limit).map(rowOf),
      total: rows.length,
      limit,
      offset,
    };
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/api/status') return json(response, 200, status);
    if (pathname === '/api/system/stats') {
      return json(response, 200, {
        cpu_percent: 7.5,
        memory_percent: 41.2,
        disk_percent: 63.0,
        uptime_seconds: 812_400,
      });
    }
    if (pathname === '/api/sessions' && method === 'GET') {
      return json(response, 200, listSessions(url.searchParams));
    }
    if (pathname === '/api/sessions/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const hits = sessions.filter((s) => {
        if (s.archived) return false;
        if ((s.title ?? '').toLowerCase().includes(q)) return true;
        return (messages.get(s.id) ?? []).some((m) =>
          String(m.content ?? '')
            .toLowerCase()
            .includes(q),
        );
      });
      return json(response, 200, { sessions: hits.map(rowOf), query: q });
    }
    let match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (match) {
      const session = findSession(decodeURIComponent(match[1]));
      if (!session) return json(response, 404, { detail: 'Session not found' });
      if (method === 'GET') return json(response, 200, rowOf(session));
      if (method === 'PATCH') {
        const body = await readBody(request);
        if (typeof body.title === 'string') session.title = body.title;
        if (typeof body.archived === 'boolean') session.archived = body.archived;
        return json(response, 200, { ok: true, session: rowOf(session) });
      }
    }
    match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!findSession(id)) return json(response, 404, { detail: 'Session not found' });
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const list = (messages.get(id) ?? []).slice(0, limit);
      return json(response, 200, {
        session_id: id,
        messages: list,
        pagination: { limit, offset: 0, returned: list.length },
      });
    }
    if (pathname === '/api/cron/jobs' && method === 'GET') return json(response, 200, jobs);
    match = /^\/api\/cron\/jobs\/([^/]+)\/runs$/.exec(pathname);
    if (match) {
      const job = findJob(decodeURIComponent(match[1]));
      if (!job) return json(response, 404, { detail: 'Job not found' });
      const runs = sessions
        .filter((s) => s.id.startsWith(`cron_${job.id}_`))
        .sort((a, b) => b.started_at - a.started_at)
        .map(rowOf);
      return json(response, 200, { runs, limit: 20 });
    }
    match = /^\/api\/cron\/jobs\/([^/]+)(?:\/(pause|resume|trigger))?$/.exec(pathname);
    if (match) {
      const job = findJob(decodeURIComponent(match[1]));
      if (!job) return json(response, 404, { detail: 'Job not found' });
      const action = match[2];
      if (action === 'pause' && method === 'POST') {
        Object.assign(job, {
          state: 'paused',
          enabled: false,
          paused_at: isoLocal(Date.now()),
          paused_reason: 'Paused from the phone',
          next_run_at: null,
        });
        return json(response, 200, { ok: true, job });
      }
      if (action === 'resume' && method === 'POST') {
        Object.assign(job, {
          state: 'scheduled',
          enabled: true,
          paused_at: null,
          paused_reason: null,
          next_run_at: isoLocal(Date.now() + 3_600_000),
        });
        return json(response, 200, { ok: true, job });
      }
      if (action === 'trigger' && method === 'POST') {
        job.next_run_at = isoLocal(Date.now() + 60_000);
        return json(response, 200, { ok: true, job });
      }
      if (!action && method === 'PUT') {
        const body = await readBody(request);
        Object.assign(job, body.updates ?? {});
        return json(response, 200, { ok: true, job });
      }
      if (!action && method === 'GET') return json(response, 200, job);
    }
    if (pathname === '/api/profiles') return json(response, 200, { profiles });
    if (pathname === '/api/model/info') return json(response, 200, modelInfo);
    if (pathname === '/api/model/options') return json(response, 200, modelOptions);
    if (pathname === '/api/model/set' && method === 'POST') {
      const body = await readBody(request);
      if (body.provider) modelInfo.provider = body.provider;
      if (body.model) modelInfo.model = body.model;
      modelOptions.provider = modelInfo.provider;
      modelOptions.model = modelInfo.model;
      profiles[0].model = modelInfo.model;
      profiles[0].provider = modelInfo.provider;
      return json(response, 200, {
        ok: true,
        model: modelInfo.model,
        provider: modelInfo.provider,
        stale_aux: [],
      });
    }
    json(response, 404, { detail: 'Not found in the demo backend' });
  });

  // JSON-RPC over /api/ws, the way tui_gateway speaks it.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/api/ws')) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (ws) => attach(ws));
  });

  function attach(ws) {
    const send = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const emit = (type, sid, payload) =>
      send({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sid, payload } });

    const record = (storedSessionId, role, content, extra = {}) => {
      const session = findSession(storedSessionId);
      const list = messages.get(storedSessionId) ?? [];
      messages.set(storedSessionId, list);
      list.push({
        id: list.length + 1000,
        session_id: storedSessionId,
        role,
        content,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: Date.now() / 1000,
        token_count: Math.ceil(String(content ?? '').length / 4),
        finish_reason: role === 'assistant' ? 'stop' : null,
        reasoning: null,
        ...extra,
      });
      session.message_count = list.length;
      session.tool_call_count = list.filter((m) => m.role === 'tool').length;
      session.last_active = Date.now() / 1000;
      session.is_active = true;
      if (role === 'user' && !session.title) session.title = content.slice(0, 60);
      if (role === 'user' && !session.preview) session.preview = content.slice(0, 63);
    };

    const create = (source) => {
      const nowMs = Date.now();
      const stored = storedId(nowMs);
      const row = {
        id: stored,
        source,
        user_id: 'owner',
        chat_id: null,
        chat_type: null,
        thread_id: null,
        display_name: null,
        model: modelInfo.model,
        parent_session_id: null,
        started_at: nowMs / 1000,
        ended_at: null,
        end_reason: null,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cwd: '/home/ada/projects/lighthouse',
        git_branch: 'main',
        title: null,
        profile_name: 'default',
        archived: false,
        last_active: nowMs / 1000,
        preview: null,
        is_active: true,
      };
      sessions.push(row);
      return row;
    };

    const handle = (sid) => {
      const id = randomBytes(4).toString('hex');
      live.set(id, sid);
      return id;
    };

    async function reply(liveId, text) {
      const stored = live.get(liveId);
      record(stored, 'user', text);
      emit('message.start', liveId, {});
      await sleep(500);

      if (APPROVAL_TRIGGER.test(text)) {
        const requestId = `apr_${randomBytes(3).toString('hex')}`;
        const command = commandFor(text);
        pending.set(requestId, { liveId, text, command });
        emit('tool.start', liveId, { tool_id: 'call_live_0', name: 'terminal', context: command });
        emit('approval.request', liveId, {
          request_id: requestId,
          command,
          tool: 'terminal',
          choices: ['once', 'session', 'always', 'deny'],
          allow_permanent: true,
        });
        return;
      }
      if (CLARIFY_TRIGGER.test(text)) {
        const requestId = `clr_${randomBytes(3).toString('hex')}`;
        pending.set(requestId, { liveId, text });
        emit('clarify.request', liveId, {
          request_id: requestId,
          question: 'Two candidates match. Which one did you mean?',
          choices: ['the staging one', 'the production one'],
        });
        return;
      }
      await finishReply(liveId, text);
    }

    async function finishReply(liveId, text, prefix = '') {
      const stored = live.get(liveId);
      const script = REPLIES.find((entry) => entry.match.test(text)) ?? DEFAULT_REPLY;
      const callId = `call_live_${randomBytes(2).toString('hex')}`;
      emit('tool.start', liveId, {
        tool_id: callId,
        name: script.tool.name,
        context: script.tool.context,
      });
      await sleep(900);
      emit('tool.complete', liveId, { tool_id: callId, name: script.tool.name, ok: true });
      await sleep(300);
      let assembled = '';
      for (const piece of chunks(prefix + script.text)) {
        assembled += piece;
        emit('message.delta', liveId, { text: piece });
        await sleep(45);
      }
      record(stored, 'assistant', assembled, {
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: script.tool.name,
              arguments: JSON.stringify({ input: script.tool.context }),
            },
          },
        ],
      });
      record(stored, 'tool', 'ok', { tool_call_id: callId, tool_name: script.tool.name });
      emit('message.complete', liveId, { text: assembled, status: 'complete' });
    }

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let frame;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const { id, method, params = {} } = frame;
      const ok = (result) => send({ jsonrpc: '2.0', id, result });
      const err = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
      try {
        switch (method) {
          case 'session.create': {
            const row = create(params.source || 'hermes-mobile');
            return ok({
              session_id: handle(row.id),
              stored_session_id: row.id,
              model: row.model,
              title: '',
            });
          }
          case 'session.resume': {
            const row = findSession(params.session_id);
            if (!row) return err(4040, 'Session not found');
            return ok({
              session_id: handle(row.id),
              stored_session_id: row.id,
              model: row.model,
              title: row.title ?? '',
            });
          }
          case 'prompt.submit': {
            if (!live.has(params.session_id)) return err(4040, 'Unknown session');
            ok({ status: 'streaming' });
            reply(params.session_id, String(params.text ?? '')).catch(() => {});
            return;
          }
          case 'approval.respond': {
            const waiting = pending.get(params.request_id);
            pending.delete(params.request_id);
            ok({ ok: true });
            if (!waiting) return;
            if (params.choice === 'deny') {
              record(
                live.get(waiting.liveId),
                'assistant',
                'Understood, I have not run it. Nothing was changed.',
              );
              emit('message.complete', waiting.liveId, {
                text: 'Understood, I have not run it. Nothing was changed.',
                status: 'complete',
              });
              return;
            }
            await sleep(400);
            return finishReply(waiting.liveId, waiting.text, `Ran \`${waiting.command}\`. `);
          }
          case 'clarify.respond': {
            const waiting = pending.get(params.request_id);
            pending.delete(params.request_id);
            ok({ ok: true });
            if (!waiting) return;
            await sleep(300);
            return finishReply(waiting.liveId, waiting.text, `Going with ${params.answer}. `);
          }
          case 'session.interrupt':
            ok({ ok: true });
            return emit('message.complete', params.session_id, { text: '', status: 'interrupted' });
          default:
            return ok({});
        }
      } catch (error) {
        err(5000, error.message);
      }
    });
  }

  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    fixtures,
    async stop() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close();
      await new Promise((resolve) => server.once('close', resolve));
    },
  };
}

// --- command line -------------------------------------------------------------

/** HERMES_MOBILE_ALLOWED_LOGINS as the installed service has it, if readable. */
function installedLogins() {
  const file = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
    'hermes-mobile-pwa.env',
  );
  try {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('HERMES_MOBILE_ALLOWED_LOGINS='));
    return line ? line.slice(line.indexOf('=') + 1).trim() : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let port = 4174;
  let local = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--local') local = true;
    else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write('usage: node demo.mjs [--port N] [--local]\n');
      process.exit(0);
    }
  }
  const logins = process.env.HERMES_MOBILE_ALLOWED_LOGINS ?? installedLogins();
  if (!logins && !local) {
    process.stderr.write(
      'demo.mjs: no tailnet login to allow. Set HERMES_MOBILE_ALLOWED_LOGINS, or pass --local\n' +
        "to open the app in this machine's browser at http://127.0.0.1:" +
        port +
        '/ instead.\n',
    );
    process.exit(2);
  }

  const backend = await startDemoHermes();
  const proxy = spawn(process.execPath, [join(repoRoot, 'server.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: '127.0.0.1',
      PORT: String(port),
      HERMES_ORIGIN: backend.origin,
      HERMES_DASHBOARD_SESSION_TOKEN: randomBytes(24).toString('base64url'),
      HERMES_MOBILE_ALLOWED_LOGINS: logins,
      HERMES_MOBILE_ALLOW_LOCAL: local ? '1' : '',
      // No keys, so push is off and nothing invented can reach a real phone.
      HERMES_MOBILE_VAPID_PUBLIC_KEY: '',
      HERMES_MOBILE_VAPID_PRIVATE_KEY: '',
      HERMES_MOBILE_STATE_DIR: mkdtempSync(join(tmpdir(), 'hermes-mobile-demo-')),
    },
  });

  process.stdout.write(
    [
      '',
      `Demo backend on ${backend.origin}; the app is on http://127.0.0.1:${port}/`,
      logins ? `Allowed tailnet logins: ${logins}` : 'Tailnet logins: none (local browser only)',
      local ? 'Local browser admitted: open the URL above on this machine.' : '',
      '',
      'On the phone, this replaces the installed service for as long as it runs:',
      '  systemctl --user stop hermes-mobile-pwa.service   (before, if it holds the port)',
      '  systemctl --user start hermes-mobile-pwa.service  (after)',
      '',
      'Chat prompts: mention "deploy" or "restart" for an approval card, end a',
      '"which ... ?" question for a clarify prompt, anything else streams a reply.',
      'Ctrl-C to stop. Nothing is written anywhere.',
      '',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  );

  const shutdown = () => {
    proxy.kill('SIGTERM');
    backend.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  proxy.on('exit', (code) => {
    backend.stop().finally(() => process.exit(code ?? 1));
  });
}
