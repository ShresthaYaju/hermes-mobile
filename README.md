# hermes-mobile

[![CI](https://github.com/ShresthaYaju/hermes-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/ShresthaYaju/hermes-mobile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](.nvmrc)

An installable mobile control surface for [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the same local agent you already talk to through Telegram, reachable from your phone over your own Tailscale tailnet and nowhere else.

> **This is a companion app, not a standalone one.** It does nothing without a
> running `hermes serve` on the same host. If you do not run Hermes Agent, this
> repository is not useful to you on its own. See
> [Requirements](#requirements).

> **It is also a remote control for a program that runs shell commands as your
> user.** Who may talk to it is the entire security model. Read
> [SECURITY.md](SECURITY.md) before you deploy it anywhere.

Five tabs:

| Tab | What it answers |
| --- | --- |
| **Now** | Is the gateway up, does the agent need a decision from me, what is running, what ran recently |
| **Threads** | Every conversation across Telegram, the web app, scheduled runs, and subagents — searchable |
| **Work** | Scheduled jobs, their health, and pause / resume / run-now / edit-prompt |
| **Chat** | A live conversation with the agent, with streaming and approvals. Every chat is a durable thread you can leave and come back to |
| **Config** | Profiles, push alerts, and what this app deliberately cannot reach |

Tapping one of your own chats reopens it in the composer, with its history above the input; tapping any other thread or run opens a Claude-Code-style read-only transcript: tool calls as collapsed rows you expand for input and output.

[`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) records the reasoning behind the design, including two architectural spikes that came back negative and changed it.

## Requirements

- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**, installed and running as `hermes serve` on loopback. This app is a proxy in front of it and has no function without it. There is no demo or mock mode.
- **[Tailscale](https://tailscale.com/)**, with `tailscale serve` available. Tailscale is what authenticates callers; this app has no login of its own.
- **Node.js 22 or newer.** The test script relies on `node --test` expanding a glob itself.
- Linux with user systemd, if you want the supplied service units. Nothing else depends on systemd.

## Architecture

```text
Phone browser / installed PWA
  └─ HTTPS over your Tailscale tailnet
       └─ tailscale serve → 127.0.0.1:4174 (this proxy)
            ├─ static PWA assets
            ├─ /push/*  handled locally: VAPID config, subscriptions, notification kinds
            ├─ /api/*   allowlisted REST proxy → 127.0.0.1:9119 (hermes serve)
            │            sessions, cron, profiles, status
            └─ /api/ws  JSON-RPC over WebSocket: live chat, approvals
                         the proxy holds one upstream socket per login and
                         relays phones through it (see below)
```

Hermes delivers a session's events — approval requests, the finished reply, errors — only to the WebSocket that owns the session, and drops them once that socket is gone. A phone's socket is gone the moment the screen locks. So the proxy does not forward the phone's WebSocket transparently: it owns the connection to Hermes itself, one per tailnet login, and relays the phone's JSON-RPC frames through it. That connection stays up when the phone leaves, which is what lets a missed approval or a finished reply become a push notification, and lets a phone that reconnects be handed the approvals it missed.

Both app processes bind only to loopback. `tailscale serve` is the only network entry point; do **not** use `tailscale funnel` for this app.

### One thing worth knowing

Hermes routes agent events to whichever transport last touched a session, with no broadcast. Telegram and cron sessions live in a *different OS process*, so this app cannot stream them — and resuming one over RPC would cold-load its history and spawn a second agent for it. So this app talks only into the threads it created itself, and everything else reads REST and polls. That ownership rule is enforced in `public/lib/threads.js` and pinned by `test/threads.test.mjs`. This is architectural, not a gap in the UI.

## Install

```bash
git clone https://github.com/ShresthaYaju/hermes-mobile.git ~/hermes-mobile
cd ~/hermes-mobile
npm ci
```

Create the service environment file. It holds the loopback credential and the
identity allowlist, so it is written `0600` and lives outside the repository:

```bash
mkdir -p ~/.config ~/.config/systemd/user
umask 077
printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\n' \
  "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" \
  > ~/.config/hermes-mobile-pwa.env

# Who on the tailnet may drive the agent. The server refuses to start without
# this -- see "Security boundary". Use the login `tailscale status` shows you.
printf 'HERMES_MOBILE_ALLOWED_LOGINS=you@example.com\n' \
  >> ~/.config/hermes-mobile-pwa.env
```

Install the service units and start them:

```bash
cp systemd/hermes-mobile-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hermes-mobile-backend.service hermes-mobile-pwa.service
tailscale serve --bg 4174
```

> **Check the unit files first.** They assume the clone is at `~/hermes-mobile`
> and that `node` and `hermes` are at `~/.local/bin/`. If `which node` or
> `which hermes` says otherwise — a system package, Homebrew, nvm — edit
> `ExecStart` and `WorkingDirectory` to match, or systemd will fail with a bare
> `status=203/EXEC`.

Open the HTTPS URL shown by:

```bash
tailscale serve status
```

On iPhone Safari, use **Share → Add to Home Screen**. On Android Chrome, use **Install app**. The app keeps a local visual transcript for page-refresh continuity; Hermes persists actual conversation state on the host.

## Configuration

Everything is environment-driven. Nothing below has a value baked into the
repository.

| Variable | Default | What it does |
| --- | --- | --- |
| `HERMES_MOBILE_ALLOWED_LOGINS` | *(none)* | Comma-separated tailnet logins permitted to drive the agent. **Required** — the server refuses to start without this or `HERMES_MOBILE_ALLOW_LOCAL`. |
| `HERMES_DASHBOARD_SESSION_TOKEN` | *(none)* | The shared loopback credential for `hermes serve`. Added on the internal hop only; the browser never sees it. Without it the WebSocket upgrade is refused. |
| `HOST` | `127.0.0.1` | Bind address. A non-loopback value is refused. |
| `PORT` | `4174` | Bind port. `0` picks an ephemeral port, which the tests rely on. |
| `HERMES_ORIGIN` | `http://127.0.0.1:9119` | Where `hermes serve` is listening. |
| `HERMES_MOBILE_ALLOW_LOCAL` | off | `1` additionally admits callers presenting no identity at all. Those cannot have come through Serve, so in practice this means the host itself — local `curl`, the test suite. |
| `HERMES_MOBILE_IDENTITY_DEBUG` | off | `1` makes a refusal name the identity it saw. Useful exactly once, when first wiring this up. |
| `HERMES_MOBILE_ALLOWED_ORIGINS` | *(none)* | Extra browser origins permitted, comma separated. Only needed when the app is served from one hostname and reached by another. |
| `HERMES_MOBILE_ALLOWED_HOSTS` | loopback, `*.ts.net`, `100.64.0.0/10` | Extra `Host` values this proxy will answer for, comma separated. The defaults cover local use and `tailscale serve`; you need this only if you front the app with some other name. |
| `HERMES_MOBILE_READ_TIMEOUT` | `30000` | Milliseconds a read waits on Hermes before giving up, answering 502. Reads only: a write can legitimately run the agent for minutes, and the WebSocket is long-lived by design. `0` waits forever. |
| `HERMES_MOBILE_WRITE_LIMIT` | `30` | Writes allowed per identity per minute. A WebSocket upgrade spends one unit too, since its method surface is a superset of any REST write's — so `0` refuses writes *and* the chat socket, making the app read-only. A value that does not parse as a number refuses to start rather than silently becoming one write per minute. |
| `HERMES_MOBILE_STATE_DIR` | `$XDG_STATE_HOME/hermes-mobile`, else `~/.local/state/hermes-mobile` | Where the push subscription file is kept. Written `0600`. The shipped `hermes-mobile-pwa.service` sandboxes the process with `ProtectSystem=strict` and only grants write access to `~/.local/state/hermes-mobile` via `ReadWritePaths=`; override this variable *and* that line together, or writes will silently fail under the unit even though they work from a shell. |
| `HERMES_MOBILE_ALLOW_PUBLIC_BIND` | off | `1` overrides the refusal to bind a non-loopback address. **Do not set this** unless you have put real authentication in front of the app; see [SECURITY.md](SECURITY.md). Note that the identity header is still refused off a non-loopback socket, so a fronting proxy has to run on this same host. |
| `HERMES_MOBILE_VAPID_PUBLIC_KEY` | *(none)* | Web Push. Absent, push is off and Config says so. |
| `HERMES_MOBILE_VAPID_PRIVATE_KEY` | *(none)* | Web Push. Keep it in the `0600` env file and nowhere else. |
| `HERMES_MOBILE_VAPID_SUBJECT` | `mailto:hermes@localhost` | Web Push contact, e.g. `mailto:you@example.com`. The fallback is a placeholder and Apple's push service refuses it outright (every delivery to an iPhone answers 403), so set a real address before expecting alerts on iOS. |

## Notifications (optional)

The phone is the only place you look, so it has to be told. With push configured the proxy sends:

| Kind | When |
| --- | --- |
| Approvals | Hermes is waiting for a yes or no (always, even while the app is open — a stuck socket must not silence the one alert that unblocks the agent). Tap → Now. |
| Replies | A turn finished while no phone was connected. Tap → that thread. |
| Errors | A turn failed while no phone was connected. |
| Host status | The proxy could not reach Hermes for three polls in a row, and once more when it can again. |
| Scheduled jobs | A job failed. Jobs that deliver `local` write their error to a file on the host and tell nobody else. |

Each device picks its own kinds under **Config**. Approvals, replies and errors go only to devices of the login whose session produced them; host status and job failures go to everyone subscribed. To turn it on, add a VAPID keypair to the service env file:

```bash
umask 077
node -e "const k=require('web-push').generateVAPIDKeys();
console.log('HERMES_MOBILE_VAPID_PUBLIC_KEY='+k.publicKey);
console.log('HERMES_MOBILE_VAPID_PRIVATE_KEY='+k.privateKey);
console.log('HERMES_MOBILE_VAPID_SUBJECT=mailto:you@example.com');" >> ~/.config/hermes-mobile-pwa.env
systemctl --user restart hermes-mobile-pwa.service
```

Then turn alerts on under **Config**. iOS only offers push to home-screen installs, so add the app to your home screen first. Without keys the app works exactly as before and Config says so.

## Operations

```bash
systemctl --user status hermes-mobile-backend.service hermes-mobile-pwa.service
tailscale serve status
curl -fsS http://127.0.0.1:4174/healthz
```

Every write that reaches the agent is written to stdout as a JSON audit line
carrying the identity, method and path:

```bash
journalctl --user -u hermes-mobile-pwa.service | grep '"audit"'
```

To stop exposure without stopping local services:

```bash
tailscale serve reset
```

## Security boundary

**Read this before deploying it anywhere.** The agent behind this app can run shell commands as your user, so the question "who may talk to it" is the whole security model. [SECURITY.md](SECURITY.md) goes further, including what each control is and is not worth.

- **Only named tailnet identities may drive the agent.** `tailscale serve` authenticates the calling tailnet user and injects `Tailscale-User-Login`, stripping any copy the client supplied. The proxy requires that header on every `/api` and `/push` request *and* on the WebSocket upgrade, and matches it against `HERMES_MOBILE_ALLOWED_LOGINS` (comma separated). Anything else gets a 403 that does not disclose who *is* allowed. The server refuses to start with no allowlist, the same way it refuses a non-loopback bind — starting wide open is the failure this prevents.

  This matters because same-origin is a *browser* control and nothing more: curl forges or omits `Origin` freely. Before the identity gate, reachability was authorization, and a tailnet has peers — any one of them could have driven the agent with a shell one-liner.

  Set `HERMES_MOBILE_ALLOW_LOCAL=1` to additionally admit callers presenting no identity at all. Those cannot have come through Serve, so in practice it means the host itself (local curl, the test suite). Set `HERMES_MOBILE_IDENTITY_DEBUG=1` to have refusals name the identity they saw — useful exactly once, when first wiring this up.

- **Actions that reach the agent are rate limited and recorded.** Writes are capped per identity per minute (`HERMES_MOBILE_WRITE_LIMIT`, default 30) so nothing can sit in a loop on `POST /api/cron/jobs/{id}/trigger`, which runs the agent every time. Each accepted or rate-limited write is written to stdout as a JSON audit line carrying the identity, method and path. Reads are neither limited nor audited: they cannot run the agent, and one line per poll would bury the entries that matter. `/push/*` writes are metered the same way — they do not reach the agent, but each one is a synchronous file write.

- **The proxy only answers for hosts it expects.** Same-origin compares `Origin` against the `Host` header — and DNS rebinding controls both, so a name the attacker owns, pointed at `127.0.0.1`, makes the two agree by construction and the check passes. So the `Host` is checked against an allowlist of its own before same-origin runs: loopback, the `*.ts.net` MagicDNS name `tailscale serve` presents, and the `100.64.0.0/10` tailnet range, plus anything in `HERMES_MOBILE_ALLOWED_HOSTS`. Anything else gets a 421. This is what stops a web page you happen to visit from reaching the JSON-RPC socket on your own machine — which mattered most with `HERMES_MOBILE_ALLOW_LOCAL=1` set, since then no identity is required either.

- **The identity header is only believed from a loopback peer.** `Tailscale-User-Login` is trusted verbatim, so it is worth exactly as much as the claim that Serve put it there. Serve proxies from the machine itself. A request arriving from anywhere else means something other than Serve is in front, and the header is then just a string the caller typed — so it is refused rather than believed. Encoded path separators are refused for the same class of reason: the allowlist matches a normalized path, and letting an encoded one through would leave the upstream's parser, not this proxy, deciding what was authorized. The canonical spellings (`%2f`, `%5c`, `%2e`) are rejected outright, and so is anything whose decoding would move a segment boundary — which covers overlong forms like `%c0%af` without also rejecting a harmless `%20` inside a name. Request targets must be origin-form (`/path`): `//host/…`, `/\host/…` and the absolute form each let the request line, rather than the `Host` header, decide what host the proxy thinks it is answering for.

- **Every `/api` and `/push` request must be same-origin.** A browser sets `Origin` itself and a page cannot forge or suppress it, so the proxy requires `Origin`'s host to match the `Host` it was reached by, and refuses `null`. This is the control that stops a hostile web page from driving the agent, and it matters most for WebSockets: they are exempt from CORS entirely, so nothing in the browser would have stopped the upgrade. A request with no `Origin` at all is not from a browser (curl, native clients) and is allowed — those are stopped by the identity gate instead. Set `HERMES_MOBILE_ALLOWED_ORIGINS` to permit additional origins.

- No model credentials or Hermes tokens are stored in this repository or sent to the browser. The loopback credential lives only in `~/.config/hermes-mobile-pwa.env` (mode `0600`) and the proxy adds it on the internal hop, to both the WebSocket upgrade and each REST call.

- **Hermes serves its entire dashboard API on that loopback port** — including `/api/env/reveal`, `/api/files`, `/api/ops`, and gateway lifecycle. The proxy therefore does not forward `/api/*` wholesale. Reads are allowed by prefix; writes are enumerated one method-and-shape at a time (`server.mjs`). Everything else is refused at the proxy and never reaches Hermes.

  A read prefix that no view calls is reach the app grants and never uses, so the list is kept to what `public/` actually fetches. `/api/logs` used to be on it and is not any more: upstream answers it with thousands of lines of agent log, prompts and tool output included. If you add a view that needs a prefix back, add it with the view.

- Four write actions are withheld on purpose: `DELETE /api/cron/jobs/{id}`, because it also deletes the job's saved run output; cron job *creation*, which needs more context than a phone screen gives; `DELETE /api/sessions/{id}`, which permanently destroys a conversation; and `POST /api/profiles/active`, which moves the sticky profile without retargeting the running dashboard this app reads through — so the app would announce a switch it had not made. Renaming and archiving a thread stay available: they are recoverable.

- `POST /api/model/set` **is** exposed, scoped to the main model slot. The same upstream endpoint can also write per-task auxiliary pins, a provider `base_url` and an API key into `config.yaml`. A proxy cannot inspect request bodies, so what keeps those off the phone is that no client here composes them — `public/lib/api.js` sends a main-slot assignment and nothing else, and a source-level test pins that. Treat it as a constraint to preserve, not a boundary the proxy enforces.

- Push subscription endpoints are capability URLs and are stored `0600` outside the repo. Each one is checked twice against reaching back into the tailnet or the host itself: the literal host is refused at `/push/subscribe` if it is obviously internal, and the resolved address is refused again on every delivery attempt, which is what still catches a name that looked public when accepted and was repointed afterward. See [SECURITY.md](SECURITY.md) for the detail.

- The service listens on `127.0.0.1`; HTTPS and tailnet authentication are provided by Tailscale Serve. Use `tailscale serve`, never `tailscale funnel` — funnel publishes it to the public internet.

- Tailnet ACLs are worth setting as a second layer: they are enforced by Tailscale rather than by this code, so they hold even if something here is wrong.

- The app displays approval requests, but never auto-approves them.

- `hermes-mobile-pwa.service` — the proxy, and the process that terminates a network path — runs under `ProtectSystem=strict` and `ProtectHome=read-only` with a `@system-service` syscall filter and write access only to its own state directory.

### Known limitations

- **The REST allowlist does not constrain the JSON-RPC gateway.** `/api/ws` exposes the full method surface, `shell.exec` included. The identity gate, the same-origin check and the tailnet are what protect it; the careful REST allowlist is a second layer, not the primary one. Anyone you allowlist has, in effect, a shell. This is deliberate — [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) explains why an RPC method allowlist was considered and rejected.
- **Only reads are bounded against a hung upstream** (`HERMES_MOBILE_READ_TIMEOUT`, default 30s). Writes are not, because a write can legitimately run the agent for minutes and cutting it off would abandon work still running upstream; the WebSocket is long-lived by definition. Node's own `headersTimeout` and `requestTimeout` defaults apply to the inbound side.
- **The identity header is trusted, not verified.** Nothing cryptographically binds it to a tailnet user; the guarantee comes from `tailscale serve` injecting it and stripping client copies, and from this proxy refusing it off a non-loopback socket. If you put a different reverse proxy in front, it must be on the same host and it must strip that header itself.
- **The agent's shell is not sandboxed.** `terminal.backend = local` runs it as the host user. That is the blast radius behind every item above, and the highest-leverage thing to change — but it lives in Hermes Agent, not here.
- **Approvals raised while the phone is asleep cannot be recovered.** No REST or RPC surface lists a session's pending approvals. The turn itself survives; the prompt is not re-shown. Closing this needs a change upstream.

## Development

```bash
npm install
npm run check   # node --check over every module, then prettier --check
npm test        # spawns the real server against a stub upstream
```

The test suite does **not** need a running Hermes Agent. To run the app against a real one:

```bash
HOST=127.0.0.1 PORT=4174 HERMES_ORIGIN=http://127.0.0.1:9119 \
  HERMES_MOBILE_ALLOW_LOCAL=1 npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — particularly the two design rules that are not obvious from the code, and the tests that exist to catch failures every other test sails past.

## License

[MIT](LICENSE).

`web-push`, one of the three runtime dependencies, is MPL-2.0; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
