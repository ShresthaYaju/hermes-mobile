# hermes-mobile

An installable mobile control surface for the **same local Hermes Agent** you use through Telegram.

Five tabs:

| Tab | What it answers |
| --- | --- |
| **Now** | Is the gateway up, does the agent need a decision from me, what is running, what ran recently |
| **Threads** | Every conversation across Telegram, the web app, scheduled runs, and subagents — searchable |
| **Work** | Scheduled jobs, their health, and pause / resume / run-now / edit-prompt |
| **Chat** | A live conversation with the agent, with streaming and approvals |
| **Config** | Profiles, push alerts, and what this app deliberately cannot reach |

Tapping a thread or a run opens a Claude-Code-style transcript: tool calls as collapsed rows you expand for input and output. [`PLAN.md`](PLAN.md) records the review this was built from, including two architectural spikes that came back negative and changed the design.

## Architecture

```text
Phone browser / installed PWA
  └─ HTTPS over your Tailscale tailnet
       └─ tailscale serve → 127.0.0.1:4174 (this proxy)
            ├─ static PWA assets
            ├─ /push/*  handled locally: VAPID config, subscriptions, cron-failure watcher
            └─ /api/*   allowlisted proxy → 127.0.0.1:9119 (hermes serve)
                 ├─ REST: sessions, cron, profiles, status
                 └─ JSON-RPC over WebSocket: live chat, approvals
```

Both app processes bind only to loopback. `tailscale serve` is the only network entry point; do **not** use `tailscale funnel` for this app.

### One thing worth knowing

Hermes routes agent events to whichever transport last touched a session, with no broadcast. Telegram and cron sessions live in a *different OS process*, so this app cannot stream them — and resuming one over RPC would cold-load its history and spawn a second agent for it. So only the **Chat** tab streams; everything else reads REST and polls. This is architectural, not a gap in the UI.

## Notifications (optional)

Scheduled jobs that deliver `local` write failures to a file on the host and tell nobody. To have the phone tell you instead, add a VAPID keypair to the service env file:

```bash
umask 077
node -e "const k=require('web-push').generateVAPIDKeys();
console.log('HERMES_MOBILE_VAPID_PUBLIC_KEY='+k.publicKey);
console.log('HERMES_MOBILE_VAPID_PRIVATE_KEY='+k.privateKey);
console.log('HERMES_MOBILE_VAPID_SUBJECT=mailto:you@example.com');" >> ~/.config/hermes-mobile-pwa.env
systemctl --user restart hermes-mobile-pwa.service
```

Then turn alerts on under **Config**. iOS only offers push to home-screen installs, so add the app to your home screen first. Without keys the app works exactly as before and Config says so.

## Install on this host

```bash
cd ~/hermes-mobile
npm ci
mkdir -p ~/.config/systemd/user
umask 077
printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\n' "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" > ~/.config/hermes-mobile-pwa.env
cp systemd/hermes-mobile-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hermes-mobile-backend.service hermes-mobile-pwa.service
tailscale serve --bg 4174
```

Open the HTTPS URL shown by:

```bash
tailscale serve status
```

On iPhone Safari, use **Share → Add to Home Screen**. On Android Chrome, use **Install app**. The app keeps a local visual transcript for page-refresh continuity; Hermes persists actual conversation state on the host.

## Operations

```bash
systemctl --user status hermes-mobile-backend.service hermes-mobile-pwa.service
tailscale serve status
curl -fsS http://127.0.0.1:4174/healthz
```

To stop exposure without stopping local services:

```bash
tailscale serve reset
```

## Security boundary

- No model credentials or Hermes tokens are stored in this repository or sent to the browser. The loopback credential lives only in `~/.config/hermes-mobile-pwa.env` (mode `0600`) and the proxy adds it on the internal hop, to both the WebSocket upgrade and each REST call.
- **Hermes serves its entire dashboard API on that loopback port** — including `/api/env/reveal`, `/api/files`, `/api/ops`, and gateway lifecycle. The proxy therefore does not forward `/api/*` wholesale. Reads are allowed by prefix; writes are enumerated one method-and-shape at a time (`server.mjs`). Everything else is refused at the proxy and never reaches Hermes.
- Two write actions are withheld on purpose: `DELETE /api/cron/jobs/{id}`, because it also deletes the job's saved run output, and cron job *creation*, which needs more context than a phone screen gives.
- Push subscription endpoints are capability URLs and are stored `0600` outside the repo.
- The service listens on `127.0.0.1`; HTTPS and tailnet authentication are provided by Tailscale Serve.
- Anyone with access to your tailnet URL can control this Hermes profile. Use tailnet ACLs/device access as the authorization boundary.
- The app displays approval requests, but never auto-approves them.

## Development

```bash
npm install
npm run check
npm test
HOST=127.0.0.1 PORT=4174 HERMES_ORIGIN=http://127.0.0.1:9119 npm start
```
