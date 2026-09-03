# Security policy

## Read this before you deploy

This is not a normal web app, and the usual "it's behind a login, it's fine"
intuition does not apply to it.

hermes-mobile is a proxy in front of an AI agent that **runs shell commands as
your user**. Anyone who can successfully talk to this proxy can, in effect, run
code on the host — not because of a bug, but because that is what the agent on
the other side is for. Every control in this repository exists to answer one
question: *who is allowed to do that?*

So the threat model is not "can an attacker read some data". It is "can an
attacker reach the agent at all". Treat any bypass of the identity gate, the
same-origin check, or the loopback bind as critical, however small it looks.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability
reporting](https://github.com/ShresthaYaju/hermes-mobile/security/advisories/new)
on this repository. That opens a draft advisory only you and the maintainer can
see.

Please include:

- What an attacker can do that they should not be able to do.
- The exact request, header, path or input that triggers it — a `curl` line is
  ideal.
- Which control you got past (identity gate, same-origin, REST allowlist,
  loopback bind, static file root), and what you had to be able to reach to do
  it (the tailnet? the host? any web page?).
- The commit you tested.

You will get an acknowledgement within a week. This is a personal project
maintained in spare time, so please size your expectations accordingly: there is
no SLA, no bounty, and no dedicated security team. There is, however, a genuine
interest in getting this right, because the maintainer runs it too.

Please give a reasonable window to ship a fix before disclosing publicly. If the
finding is that the *documentation* oversells a control, that is also worth
reporting — a security boundary that only exists in a README is the more
dangerous kind of bug.

## What is in scope

Anything that lets a caller reach the agent, or reach Hermes routes this proxy
deliberately withholds, without satisfying every control below:

- Bypassing the tailnet identity gate (`Tailscale-User-Login` /
  `HERMES_MOBILE_ALLOWED_LOGINS`), on `/api/*`, `/push/*`, or the WebSocket
  upgrade.
- Bypassing the same-origin check or the `Host` allowlist, especially on the
  WebSocket upgrade — WebSockets are exempt from CORS, so those checks are the
  only thing between a hostile page and an authenticated JSON-RPC session. A
  way to make the proxy answer for a `Host` it should not, or to reach the
  upgrade on a path other than `/api/ws`, is a serious finding: both were real
  bugs here.
- Getting the `Tailscale-User-Login` header believed off a non-loopback socket
  (loopback means all of `127.0.0.0/8` and the IPv6 equivalents), or getting a
  client-supplied copy of it — or of the session token — relayed upstream.
- Getting the proxy to answer for a `Host` outside the allowlist by any route,
  including a non-origin-form request target that moves where `url.host` comes
  from. Three such forms were live bugs here and are now refused on both the
  HTTP path and the WebSocket upgrade.
- Reaching a route the REST allowlist withholds — notably `/api/env/reveal`
  (plaintext secrets), `/api/files` (filesystem), `/api/ops` (gateway
  lifecycle) — by path traversal, encoding tricks, prefix confusion, or method
  confusion.
- Escaping the `public/` directory through the static file handler.
- Getting the loopback session token, or a VAPID private key, into a response,
  a log line, or anything the browser receives.
- Crashing the proxy from an unauthenticated request. The process is a network
  termination point; an unauthenticated remote kill switch is a real bug, and
  two of them have been fixed here before.
- Stored or reflected XSS. There is a strict CSP, but do not treat the CSP as
  the fix.

## What is *not* a vulnerability

These are known, deliberate, and documented. Reporting them is not useful; if
you can show one is worse than described, that very much is.

- **The JSON-RPC WebSocket exposes the full method surface, `shell.exec`
  included.** The REST allowlist does not constrain it. This is intentional: an
  attacker who can send `prompt.submit` can simply *ask the agent* to run a
  command, so allowlisting RPC methods would close the direct path and not the
  actual one. The identity gate, the same-origin check and the tailnet are what
  protect this. Anyone you allowlist has, in effect, a shell — allowlist
  accordingly. Finding a way to reach the socket *without* passing the identity
  gate is very much in scope.
- **Anyone on `HERMES_MOBILE_ALLOWED_LOGINS` has full agent control.** That is
  the design. There are no roles and no read-only users.
- **`HERMES_MOBILE_ALLOW_LOCAL=1` admits callers with no identity header.**
  Those cannot have come through `tailscale serve`, so in practice this means
  the host itself — where the caller could run the agent directly anyway. It is
  off by default and is for tests and local `curl`. Note that this used to be
  much worse than it sounds: combined with DNS rebinding it meant any page the
  host's browser visited could reach the RPC socket. The `Host` allowlist is
  what closed that, so treat a rebinding bypass as critical rather than
  theoretical.
- **A missing `Origin` header is allowed, unless `Sec-Fetch-Site` says
  otherwise.** A `no-cors` subresource load (`<img src>`, `<script src>`)
  never carries `Origin` either, but it does carry `Sec-Fetch-Site:
  cross-site` or `same-site` — a browser-set header a page cannot forge or
  suppress — and the proxy refuses that exactly like a cross-origin `Origin`.
  With neither header present, the caller is not a browser at all, and
  non-browser callers are stopped by the identity gate instead. `Origin: null`
  *is* refused.
- **Deploying it wrong.** Binding a public address, running it behind
  `tailscale funnel`, or setting `HERMES_MOBILE_ALLOW_PUBLIC_BIND=1` publishes
  remote code execution to the internet. The server refuses the first two by
  default; the third requires you to override an explicit refusal.
- Findings in Hermes Agent itself, or in Tailscale. Report those upstream.
- Generic scanner output with no demonstrated impact.

## The controls, and what each is actually worth

Stated plainly, because the value of each one is easy to overestimate:

| Control | Stops | Does **not** stop |
| --- | --- | --- |
| Loopback-only bind (refuses otherwise) | Exposure to the LAN or internet | Anything already on the host |
| `Host` allowlist (loopback, `*.ts.net`, `100.64.0.0/10`) | DNS rebinding: a page you visit reaching the proxy on `127.0.0.1` | A caller who can set `Host` to a name you allowlisted |
| `tailscale serve` | The public internet | Other peers on your tailnet |
| Identity gate (`Tailscale-User-Login`) | Unlisted tailnet peers, `curl` from a peer | An allowlisted user, or anyone who can spoof the header *before* Serve |
| Same-origin check | A hostile web page driving the agent | `curl`, native clients — they omit `Origin` freely, and rebinding used to defeat it before the `Host` allowlist |
| REST allowlist | Withheld Hermes routes over HTTP | The WebSocket, which is the path that matters |
| Write rate limit + audit log | A script looping on an agent-triggering write | A patient attacker |
| Strict CSP | Exfiltration after a hypothetical XSS | The XSS itself |
| Push endpoint checks (literal host at subscribe, resolved address at every send) | A subscription aimed at the tailnet or the host itself — including one repointed there by DNS after being accepted | A push service that is itself compromised |

One more thing that is not in the table: the identity header is *trusted*, not
verified. Nothing cryptographically binds it to a tailnet user. What makes it
worth anything is that `tailscale serve` injects it and strips client-supplied
copies, and that this proxy refuses it off a non-loopback socket. Put a
different reverse proxy in front and you inherit the job of stripping it — on
the same host, because otherwise the proxy will not believe it at all.

A WebSocket upgrade is metered and recorded exactly like a REST write: it
spends the same per-identity budget and is written to the audit log with
outcome `upgrade` rather than `write`. Its method surface is a superset of any
REST write's, so it would be the one gap in "writes are rate limited and
recorded" otherwise.

The socket is not forwarded transparently. `gateway.mjs` holds one upstream
connection to Hermes per allowlisted login and relays every phone of that
login through it, rewriting request ids so two devices cannot collide. The
upstream carries the loopback credential and the loopback `Origin`, never
anything the phone sent; the phone's own headers stop at the handshake. Two
consequences worth knowing: devices signed in as the same login see each
other's session events (the client filters what it shows, but the frames do
arrive), and an approval request that arrives while no phone is connected is
kept in memory and replayed to the next phone of that login that connects.
Nothing is replayed across logins.

Push endpoints get two separate checks, not one, because checking only the
literal host a caller supplied is not enough: that host is what a resolver
turns into a connection at *send* time, on every failing cron tick, for as
long as the subscription is kept. A name can resolve publicly when accepted
and be repointed into the tailnet afterward, or resolve to several addresses
where only one of them is internal. So `/push/subscribe` refuses an obviously
internal literal (an IP in a private/tailnet range, a dotless name, a `.local`
or `.ts.net` name, and the like — see `isDeliverableEndpoint` in
`notifications.mjs`), and separately, every delivery resolves the endpoint's
host itself and refuses to connect if any address it comes back with is
internal (`guardedLookup`). The first is free and rejects at the door; the
second is what still holds if a name is deliberately rebound after being
accepted.

Two things follow from that table. First, the same-origin check is a *browser*
control and nothing more — before the identity gate existed, reachability was
authorization. Second, tailnet ACLs are worth setting as a second layer
precisely because Tailscale enforces them rather than this code, so they still
hold if something here is wrong.

## Hardening beyond the defaults

- Set tailnet ACLs so only your own devices can reach the host at all.
- Keep `HERMES_MOBILE_ALLOWED_LOGINS` to identities you would hand a shell.
- Use `tailscale serve`. Never `tailscale funnel`.
- Run the provided systemd unit rather than a bare `node server.mjs`: it adds
  `ProtectSystem=strict`, `ProtectHome=read-only`, a `@system-service` syscall
  filter, and write access only to its own state directory.
- Keep the agent's own blast radius in mind. The single highest-leverage change
  available is not in this repository: it is sandboxing the agent's shell.

## Supported versions

The tip of `main` is the only supported version. There are no backports.
