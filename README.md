# hermes-mobile

An installable mobile control surface for the **same local Hermes Agent** you use through Telegram.

Today it is a chat client. [`PLAN.md`](PLAN.md) describes the path to a full management surface — sessions, cron jobs, and profiles — over the REST and JSON-RPC APIs the Hermes backend already exposes.

## Architecture

```text
Phone browser / installed PWA
  └─ HTTPS over your Tailscale tailnet
       └─ tailscale serve → 127.0.0.1:4174 (this proxy)
            ├─ static PWA assets
            └─ /api/* WebSocket proxy → 127.0.0.1:9119 (hermes serve)
                 └─ Hermes JSON-RPC gateway → your configured default profile
```

Both app processes bind only to loopback. `tailscale serve` is the only network entry point; do **not** use `tailscale funnel` for this app.

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

- No model credentials or Hermes tokens are stored in this repository or sent to the browser. A generated loopback WebSocket credential lives only in `~/.config/hermes-mobile-pwa.env` (mode `0600`) and the proxy adds it on the internal hop.
- The Node process exposes a narrow same-origin proxy: only `/api/*` reaches Hermes.
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
