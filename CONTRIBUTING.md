# Contributing

Thanks for looking. This is a small, opinionated project with an unusual
constraint: it is a control surface for an agent that can run shell commands as
your user. That shapes what a good change looks like here, so please read the
short version below before opening a PR.

**Found a security problem? Do not open an issue.** See [SECURITY.md](SECURITY.md).

## The short version

- **No build step, and no framework.** The app ships raw ES modules and plain
  CSS, served as-is. That is deliberate: it makes the deploy a `git pull` and a
  service restart, and it keeps the whole thing readable. A PR that adds a
  bundler, TypeScript, or a UI framework will be declined unless it comes with
  an argument that outweighs losing that.
- **Two runtime dependencies.** `http-proxy-3` and `web-push`. Adding a third
  needs a reason; adding a transitive tree needs a very good one.
- **Security controls are load-bearing.** Anything touching `server.mjs`'s
  identity gate, same-origin check, REST allowlist, or the WebSocket upgrade
  path needs a test that fails without your change.
- **Say what you decided not to do.** The most useful thing in this repo's
  history is the record of approaches that were tried and rejected, and why.
  Keep that up.

## Getting set up

You need Node.js 22 or newer.

```bash
git clone https://github.com/ShresthaYaju/hermes-mobile.git
cd hermes-mobile
npm ci
npm run check   # syntax check + prettier
npm test        # 125 tests, spawns the real server on ephemeral ports
```

The test suite does **not** need a running Hermes Agent — it starts the real
proxy against a stub upstream. So you can develop and test most of this without
the backend. To run the app against a real Hermes:

```bash
HOST=127.0.0.1 PORT=4174 HERMES_ORIGIN=http://127.0.0.1:9119 \
  HERMES_MOBILE_ALLOW_LOCAL=1 npm start
```

`HERMES_MOBILE_ALLOW_LOCAL=1` is what lets you reach it from the same machine
without a tailnet in front of it. Do not set it on a deployed host unless you
have read what it does in [SECURITY.md](SECURITY.md).

## Before you open a PR

1. `npm run check` passes. It runs `node --check` over every module and
   `prettier --check`. Run `npm run format` to fix formatting.
2. `npm test` passes.
3. New behaviour has a test. See below for what the suite already pins.
4. Commit messages say *why*, in the imperative mood. The existing history is
   the style guide.

## What the test suite pins, and why it is shaped that way

Worth knowing before you add tests, because two of these exist to catch
failures that every other test would sail straight past:

- `test/imports.test.mjs` — this app has no bundler, so importing a name a
  module does not export blanks the entire app at link time while every other
  test still passes. This test walks the real import graph. It also pins the
  service worker's precache list and the shell's stylesheet links against files
  that actually exist.
- `test/pwa.test.mjs` — **adding a file to `public/lib/` or `public/views/`
  means adding it to `ASSETS` in `public/service-worker.js`.** This test fails
  if you forget.
- `test/identity.test.mjs`, `test/origin.test.mjs`, `test/writes.test.mjs` —
  the security controls. Treat these as the specification.
- `test/threads.test.mjs` — the session-ownership rule (below). Not a style
  preference; a correctness one.
- The suite is DOM-free by design. It tests the server for real and the client
  at the source level.

## Two design rules that are not obvious

If you are changing the client, these will save you from building something
that cannot work:

**This app only streams into threads it created itself.** Hermes routes agent
events to whichever transport last touched a session, with no broadcast.
Telegram and cron sessions live in a *different OS process*, so this app cannot
stream them — and calling `session.resume` on one cold-loads its history and
spawns a *second* agent for it. Worse, attaching to a session another transport
holds silently steals its events. So: exactly one active transcript at a time,
detail views never attach, and everything not owned by this app reads REST and
polls. The rule lives in `public/lib/threads.js`.

**The proxy cannot see request bodies.** `POST /api/model/set` is allowlisted
for the main model slot, but the same upstream route also accepts a provider
`base_url` and an API key. Nothing in the proxy prevents that — what prevents it
is that no client here composes such a body, and a source-level test pins it.
If you touch `public/lib/api.js`, keep it that way. It is a constraint to
preserve, not a boundary that is enforced for you.

## What is likely to be accepted

- Bug fixes, with a test.
- Accessibility fixes.
- Documentation that corrects something inaccurate. Especially a security claim
  that is stronger in the README than it is in the code.
- Making the app work for people whose setup differs from the maintainer's.
- The open items: attachments from the phone (needs an upload route
  allowlisted, which is a deliberate security decision, not a polish pass), and
  edit-and-resend.

## What is unlikely to be accepted

- A bundler, framework, or TypeScript migration.
- Writing into Telegram or cron threads from this app. Two verified failure
  modes, and Telegram is already on the same phone.
- Exposing `/api/env/*`, `/api/ops/*`, or `/api/files/*` through the proxy.
- Enabling Hermes's `api_server` gateway platform, which opens a second agent
  front door that bypasses every control in `server.mjs`.
- Removing a security control because it is inconvenient in development.
  `HERMES_MOBILE_ALLOW_LOCAL=1` is the supported way around that.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
