// install.sh, run for real against fake system commands.
//
// The script is the first thing a new user runs, so it is tested the way the
// server is: the shipped file, executed. Everything that would touch the
// machine -- tailscale, systemctl, loginctl, npm, hermes -- is a stub on PATH
// that records its arguments; HOME points at a scratch directory so the env
// file and units land there. `node` is real. The systemctl stub goes one step
// further and, on `restart`, launches the proxy exactly as the generated unit
// says to, so the health wait exercises a unit file that actually works.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'install.sh');

const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { UserID: 7, DNSName: 'box.tail1234.ts.net.' },
  User: { 7: { LoginName: 'owner@example.com' } },
});

// Each stub appends "<name> <args>" to $LOG so assertions can read what the
// script asked the system to do.
const STUBS = {
  tailscale: `
    if [ "$1 $2 $3" = "status --json " ]; then printf '%s' "$TS_STATUS"; exit 0; fi
    if [ "$1 $2 $3" = "serve status --json" ]; then printf '%s' "\${TS_SERVE:-}"; exit 0; fi
    exit "\${TS_SERVE_EXIT:-0}"`,
  systemctl: `
    if [ "$2" = restart ]; then
      unit="$HOME/.config/systemd/user/hermes-mobile-pwa.service"
      exec_line="$(grep '^ExecStart=' "$unit" | cut -d= -f2-)"
      port="$(grep '^Environment=PORT=' "$unit" | cut -d= -f3)"
      set -a; . "$HOME/.config/hermes-mobile-pwa.env"; set +a
      HOST=127.0.0.1 PORT="$port" HERMES_ORIGIN=http://127.0.0.1:1 \\
        nohup $exec_line >"$LOG.proxy" 2>&1 &
      echo $! > "$HOME/proxy.pid"
    fi
    if [ "$2" = is-active ]; then exit "\${BACKEND_ACTIVE_EXIT:-0}"; fi
    exit 0`,
  loginctl: 'exit "${LINGER_EXIT:-0}"',
  npm: 'exit 0',
  hermes: 'exit 0',
  git: 'echo "git must not be called when installing from a checkout" >&2; exit 99',
};

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-mobile-install-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    const file = join(bin, name);
    await writeFile(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$LOG"\n${body}\n`);
    await chmod(file, 0o755);
  }
  t.after(async () => {
    try {
      const pid = Number(await readFile(join(home, 'proxy.pid'), 'utf8'));
      if (pid) process.kill(pid, 'SIGTERM');
    } catch {
      // Nothing was started, or it already exited.
    }
    await rm(home, { recursive: true, force: true });
  });
  return { home, bin, log: join(home, 'calls.log') };
}

// The health wait polls the port the unit was written with, so the test needs
// a real free one rather than 0.
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function run(t, args = [], extraEnv = {}) {
  const { home, bin, log } = await scratch(t);
  const port = await freePort();
  const child = spawn('bash', [script, '--port', String(port), ...args], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      USER: 'tester',
      LOG: log,
      TS_STATUS,
      HERMES_MOBILE_INSTALL_HEALTH_TIMEOUT: '10',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  const calls = await readFile(log, 'utf8').catch(() => '');
  return { code, out, calls, home, bin, log, port };
}

const readEnv = async (home) => {
  const text = await readFile(join(home, '.config', 'hermes-mobile-pwa.env'), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
};

test('a first install from a checkout writes env, units, and brings the proxy up', async (t) => {
  const { code, out, calls, home, port } = await run(t);
  assert.equal(code, 0, out);

  const env = await readEnv(home);
  assert.match(env.HERMES_DASHBOARD_SESSION_TOKEN, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(env.HERMES_MOBILE_ALLOWED_LOGINS, 'owner@example.com');
  // The tailnet login is an email, so it doubles as the push contact.
  assert.equal(env.HERMES_MOBILE_VAPID_SUBJECT, 'mailto:owner@example.com');
  assert.match(env.HERMES_MOBILE_VAPID_PUBLIC_KEY, /^[A-Za-z0-9_-]{80,}$/);
  assert.match(env.HERMES_MOBILE_VAPID_PRIVATE_KEY, /^[A-Za-z0-9_-]{40,}$/);
  const mode = (await stat(join(home, '.config', 'hermes-mobile-pwa.env'))).mode & 0o777;
  assert.equal(mode, 0o600);

  const unitDir = join(home, '.config', 'systemd', 'user');
  const proxy = await readFile(join(unitDir, 'hermes-mobile-pwa.service'), 'utf8');
  const backend = await readFile(join(unitDir, 'hermes-mobile-backend.service'), 'utf8');
  assert.match(proxy, new RegExp(`^ExecStart=${process.execPath} ${repoRoot}/server.mjs$`, 'm'));
  assert.match(proxy, new RegExp(`^WorkingDirectory=${repoRoot}$`, 'm'));
  assert.match(proxy, new RegExp(`^Environment=PORT=${port}$`, 'm'));
  assert.match(proxy, new RegExp(`^EnvironmentFile=${home}/.config/hermes-mobile-pwa.env$`, 'm'));
  assert.match(proxy, new RegExp(`^ReadWritePaths=${home}/.local/state/hermes-mobile$`, 'm'));
  assert.doesNotMatch(proxy, /%h/, 'no unresolved %h left for a foreign layout');
  assert.match(backend, new RegExp(`^ExecStart=${home}/bin/hermes serve `, 'm'));

  assert.match(calls, /^systemctl --user daemon-reload$/m);
  assert.match(
    calls,
    /^systemctl --user enable --quiet hermes-mobile-backend.service hermes-mobile-pwa.service$/m,
  );
  assert.match(
    calls,
    /^systemctl --user restart hermes-mobile-backend.service hermes-mobile-pwa.service$/m,
  );
  assert.match(calls, /^loginctl enable-linger tester$/m);
  assert.match(calls, new RegExp(`^tailscale serve --bg ${port}$`, 'm'));
  assert.doesNotMatch(calls, /^git /m);
  // The URL stands on a line of its own with the QR code under it: the code is
  // version 3, 29 modules, 37 characters wide with its quiet zone.
  assert.match(out, /^ {2}https:\/\/box\.tail1234\.ts\.net$/m);
  assert.match(out, /^ {2}█{37}$/m, 'top of the QR code');
  assert.match(out, /^ {2}[█▀▄ ]{37}$/m);
});

test('re-running keeps every existing value and just refreshes units', async (t) => {
  const { home, bin, log } = await scratch(t);
  await mkdir(join(home, '.config'), { recursive: true });
  const existing = [
    'HERMES_DASHBOARD_SESSION_TOKEN=keep-this-token',
    'HERMES_MOBILE_ALLOWED_LOGINS=someone-else@example.com',
    'HERMES_MOBILE_VAPID_PUBLIC_KEY=pub',
    'HERMES_MOBILE_VAPID_PRIVATE_KEY=priv',
    'HERMES_MOBILE_VAPID_SUBJECT=mailto:kept@example.com',
    '',
  ].join('\n');
  await writeFile(join(home, '.config', 'hermes-mobile-pwa.env'), existing, { mode: 0o600 });

  const child = spawn('bash', [script, '--port', String(await freePort()), '--no-serve'], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      USER: 'tester',
      LOG: log,
      TS_STATUS,
      HERMES_MOBILE_INSTALL_HEALTH_TIMEOUT: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);

  assert.equal(await readFile(join(home, '.config', 'hermes-mobile-pwa.env'), 'utf8'), existing);
  assert.match(out, /HERMES_DASHBOARD_SESSION_TOKEN already set, kept/);
  const calls = await readFile(log, 'utf8');
  assert.doesNotMatch(calls, /^tailscale serve --bg/m);
});

test('--no-push writes no VAPID material; --login and --email override detection', async (t) => {
  const { code, out, home } = await run(t, [
    '--no-push',
    '--no-serve',
    '--login',
    'phone@example.net',
  ]);
  assert.equal(code, 0, out);
  const env = await readEnv(home);
  assert.equal(env.HERMES_MOBILE_ALLOWED_LOGINS, 'phone@example.net');
  assert.equal(env.HERMES_MOBILE_VAPID_PRIVATE_KEY, undefined);
  assert.equal(env.HERMES_MOBILE_VAPID_SUBJECT, undefined);

  const second = await run(t, ['--no-serve', '--email', 'push@example.org']);
  assert.equal(second.code, 0, second.out);
  assert.equal((await readEnv(second.home)).HERMES_MOBILE_VAPID_SUBJECT, 'mailto:push@example.org');
});

test('something else already on tailscale serve is left alone', async (t) => {
  const served = JSON.stringify({
    Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  });
  const { code, out, calls } = await run(t, [], { TS_SERVE: served });
  assert.equal(code, 0, out);
  assert.doesNotMatch(calls, /^tailscale serve --bg/m);
  assert.match(out, /already forwards to http:\/\/127\.0\.0\.1:3000; not touching it/);
});

test('tailscale serve refusing is a printed sudo hint, never a sudo call', async (t) => {
  const { code, out, calls, port } = await run(t, [], { TS_SERVE_EXIT: '1' });
  assert.equal(code, 0, out);
  assert.match(calls, new RegExp(`^tailscale serve --bg ${port}$`, 'm'));
  assert.doesNotMatch(calls, /sudo/);
  assert.match(out, /sudo tailscale set --operator=tester/);
});

test('a backend unit that is not running fails the install loudly', async (t) => {
  const { code, out } = await run(t, ['--no-serve'], { BACKEND_ACTIVE_EXIT: '3' });
  assert.equal(code, 1);
  assert.match(out, /hermes-mobile-backend.service is not running/);
});

test('an unreachable tailscale stops before anything is written', async (t) => {
  const stopped = JSON.stringify({ BackendState: 'Stopped', Self: {}, User: {} });
  const { code, out, home } = await run(t, [], { TS_STATUS: stopped });
  assert.equal(code, 1);
  assert.match(out, /Tailscale is not connected \(state: Stopped\)/);
  await assert.rejects(stat(join(home, '.config', 'hermes-mobile-pwa.env')));
});

test('--uninstall removes the units and nothing else', async (t) => {
  const first = await run(t, ['--no-serve']);
  assert.equal(first.code, 0, first.out);
  const { home, bin, log } = first;
  const child = spawn('bash', [script, '--uninstall'], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      USER: 'tester',
      LOG: log,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  await assert.rejects(stat(join(home, '.config', 'systemd', 'user', 'hermes-mobile-pwa.service')));
  await stat(join(home, '.config', 'hermes-mobile-pwa.env'));
  const calls = await readFile(log, 'utf8');
  assert.match(
    calls,
    /^systemctl --user disable --now hermes-mobile-pwa.service hermes-mobile-backend.service$/m,
  );
});
