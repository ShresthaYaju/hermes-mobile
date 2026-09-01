# Design notes

This is the design record for hermes-mobile: the reasoning behind decisions the code cannot
express on its own. The code says what the app does. It cannot say what was measured before
it was written, what came back negative, or what was deliberately left unbuilt — and "why
not" is the part that gets lost first. The README describes the app as it stands; this file
describes how it got that shape.

## Three spikes

The information architecture was not designed and then validated. Three questions were
answered against a running backend first, because two plausible answers would have made the
obvious design impossible, and one would have meant weeks of backend work.

### Spike 1 — can this app stream live activity from Telegram and scheduled sessions? No

Event fan-out in Hermes is per-session-transport. The gateway addresses a session's events to
whichever transport last touched it. There is no subscribe, no filter, and no broadcast, so a
client sees events only for sessions whose transport is its own socket.

That alone would be workable if every session lived in one process. It does not. Telegram and
cron sessions belong to the separate gateway daemon — a different OS process with its own
in-memory session map, sharing only the database. A session checked against the live backend
was listed by REST and entirely absent from the RPC view of active sessions, because it was
never this process's to begin with.

The worse finding is what happens if you try anyway: calling `session.resume` on a foreign
session does not attach to the running turn. It cold-loads the transcript from the database
and builds a **second** agent against it. So the failure mode is not "no events" — it is two
agents on one conversation.

The design that follows is the one in `public/lib/threads.js`: this app streams only the
threads it created itself, stamped with its own source. Everything else is read-only, over
REST, refreshed explicitly. This is architectural. No amount of UI effort moves it.

### Spike 2 — is transport stealing real? Yes

`session.resume`, `session.activate` and every `prompt.submit` reassign the session's
transport to the caller. There is no lock and no ownership check. Attaching to a session that
another transport already holds silently redirects its events; the previous holder goes dark
with no error on either side.

Two rules follow, and both are enforced in the app rather than upstream, because upstream has
nothing to enforce them with:

- Exactly one active transcript at a time.
- Detail views never attach. Opening a thread reads REST only. Attachment happens at the
  moment the user actually sends, so browsing a conversation never costs an agent and never
  mutes whoever else is watching it.

### Spike 3 — does the messages endpoint preserve tool-call structure? Yes

The collapsed-tool-row transcript is the core of the look, and it is only buildable if the
message history keeps tool calls structured rather than flattening them to prose. Checked
against a session with real tool use on the live backend, `GET /api/sessions/{id}/messages`
returns assistant messages carrying `tool_calls` — each with `id`, `function.name` and
`function.arguments` — and each one paired to a `role: "tool"` message by `tool_call_id`.
Messages also carry `tool_name`, `reasoning`, `finish_reason` and `token_count`.

So the transcript viewer is entirely client-side and needed no backend work at all: pair by
`tool_call_id`, collapse the pair into a row, expand for input and output, fold `reasoning`
behind a thinking row.

One caveat surfaced while spiking, and it shapes the view: a scheduled run that fails early
contains a single user message and no assistant turn at all. Its only readable artifact is a
run document on disk with no HTTP route. So "no transcript" is a normal state that the run
detail view renders as an empty state, not an error.

## Security decisions

The agent behind this app runs shell commands as the host user. Every decision below follows
from that one fact.

### Why there is a tailnet identity gate

Same-origin is a browser control and nothing more. A page cannot forge or suppress `Origin`,
which makes the check exactly right for the threat it addresses — a hostile web page open on
a tailnet device driving the agent, which matters most on the WebSocket upgrade since
WebSockets are exempt from CORS entirely. But curl forges or omits `Origin` freely, and the
proxy allows a request with no `Origin` precisely because it cannot have come from a browser.

Before the identity gate existed, that meant **reachability was authorization**, and a tailnet
has peers. Any one of them could have taken full control of an agent with shell access using
a shell one-liner. That is a defensible trade for a read-only dashboard and not one for a
primary control surface.

So `server.mjs` requires the `Tailscale-User-Login` header that `tailscale serve` injects and
strips from client-supplied copies, matches it against an allowlist, and applies the same gate
to `/api/*`, `/push/*` and the WebSocket upgrade. It fails closed at startup: no allowlist and
no local override means the process refuses to start, the same way a non-loopback bind is
refused. Starting wide open is the failure this prevents. Refusals do not name who *is*
allowed.

### Why same-origin needed a `Host` allowlist under it

Same-origin was written as "the `Origin` header's host equals the `Host` we were reached by",
which reads like a tautology-proof identity check and is not one. Both sides come from the
request. An attacker who controls DNS for a name they own points it at `127.0.0.1`, and a page
on that name sends `Origin: http://their-name` to `Host: their-name` — the two agree, because
the attacker chose both. Classic DNS rebinding, and the check passes by construction.

What made it serious rather than academic is the combination with `HERMES_MOBILE_ALLOW_LOCAL=1`,
which is the documented way to develop against this app. With no identity required and
same-origin satisfied, any page the host's own browser visited could open the JSON-RPC socket
and get a shell. Through `tailscale serve` a remote browser is still stopped by TLS, so this
was an exposure for the host itself and for anyone who bound the app publicly — which is to
say, exactly the people running it from a checkout.

The fix is that agreement is not enough: the `Host` has to be one this proxy expects. Loopback,
the `*.ts.net` MagicDNS name Serve presents, and the `100.64.0.0/10` tailnet range are allowed
by default, because those are what a correct deployment actually presents and none of them is
a name an attacker can aim. Anything else needs naming in `HERMES_MOBILE_ALLOWED_HOSTS`.

The general lesson, which applies to more than this app: a check that compares two
attacker-supplied values to each other proves they agree, not that either is trustworthy.

### Why the identity header is only believed from loopback

`Tailscale-User-Login` is trusted verbatim — nothing binds it cryptographically to a tailnet
user. Its entire value rests on Serve injecting it and stripping client copies. Serve proxies
from the machine itself, so a request arriving from any other address means something else is
in front, and the header is then just a string the caller typed. The proxy refuses it in that
case rather than believing it. This costs nothing in a correct deployment and is the
difference between "safe because of how this host happens to be configured" and "safe as
published".

The same reasoning drives refusing percent-encoded path separators. The REST allowlist matches
a URL-normalized path, which collapses `..` — but normalizing is not decoding, and `%2f`,
`%5c` and `%2e` survive it untouched. So `/api/status/..%2fenv%2freveal` passed the prefix
check and arrived upstream still encoded, where a parser with different rules could decode it
and resolve somewhere the proxy never authorized. Today's backend does not, so nothing was
actually reachable. But "safe because of how the *other* program parses paths" is not a
property a proxy gets to rely on, least of all one whose allowlist is the documented boundary.

Worth recording precisely because the first diagnosis was wrong: the suspicion was that the
proxy library forwarded the raw request target while the check ran on a normalized one. It
does not — it derives the same normalized path this file does. The real gap was narrower and
less obvious, and a fix aimed at the wrong mechanism would have closed nothing.

The first fix was also incomplete, which is the more useful half of the lesson. Refusing the
canonical spellings `%2f`, `%5c` and `%2e` left `%c0%af` — an overlong UTF-8 solidus — and
`%%32%66` reaching the upstream untouched. Enumerating encodings is a losing game; the rule
that holds is to decode and ask whether decoding *changed the structure* of the path. A
malformed escape is refused because nothing here has a use for one, and a decode that adds a
segment, a dot-segment or a backslash is refused because it means the string authorized is not
the string the upstream will act on. A `%20` inside a name still passes, which is the property
that makes the rule targeted rather than a blanket ban on percent-encoding.

### Why the request target has to be origin-form

The `Host` allowlist above judged `url.host` — the host of the parsed request URL. For an
ordinary request that *is* the `Host` header, so the two looked interchangeable. They are not.
A request line may carry a target that names its own authority: `//node.ts.net/api/ws`, the
absolute form `http://node.ts.net/api/ws`, and — because the WHATWG parser folds `\` into `/`
for special schemes — `/\100.64.0.1/api/ws`. Each puts an allowed value in `url.host` while
the `Host` header says something else entirely, and each walked straight past the allowlist.
On the WebSocket upgrade, which had no target-shape check at all, that meant the session token
was attached and the JSON-RPC socket opened.

No browser can emit those targets, so this was never reachable by the rebinding attack the
allowlist was built for — it needed a raw socket and an already-allowlisted identity. But a
control that is documented as "anything else gets a 421" has to actually be that, and a
fronting proxy written in a language that does not treat `\` as a separator would pass the
form through intact.

Two rules came out of it, and they generalize past this app: validate the *shape* of an input
before reading a decision out of any part of it, and read that decision from the field you
actually mean — the `Host` header — rather than from a parse of something an attacker controls
more of.

### Why there is no JSON-RPC method allowlist

The REST surface is meticulously gated and `/api/ws` is proxied wholesale, which reads like
the glaring inconsistency and mostly is not one. Anyone who can send `prompt.submit` can
simply *ask the agent* to run a command. Allowlisting RPC methods closes the direct path to
`shell.exec` and does not close the real one.

With the identity gate in place the residual threat is narrow: an XSS in this app reaching RPC
without going through the agent. There is a strict CSP (`default-src 'self'; connect-src
'self'`), every markup path escapes, and the one HTML-accepting prop is fed only by a renderer
that escapes first — so the app renders no untrusted HTML. That residue does not justify
hand-rolled WebSocket frame parsing sitting in the path of the live chat, where a parsing bug
breaks the feature the app exists for.

Revisit condition, stated so it is not forgotten: **if this app ever renders untrusted HTML,
build the method allowlist.**

### Why four write actions are withheld

Reads are allowed by prefix. Writes are enumerated one method-and-shape at a time in
`server.mjs`, and four are absent on purpose:

- `DELETE /api/cron/jobs/{id}` — upstream also deletes the job's saved run output directory.
  A mis-tap on a phone is not worth that.
- `POST /api/cron/jobs` — creating a schedule needs the blueprint and delivery-target context
  to be honest about what it will do. It is not a mobile action.
- `DELETE /api/sessions/{id}` — permanently destroys a conversation. Same class of mis-tap as
  the cron delete, and leaving it exposed was simply inconsistent with that reasoning. No view
  ever called it.
- `POST /api/profiles/active` — moves the sticky profile without retargeting the running
  dashboard this app reads through, so the app would announce a switch it had not made.
  Config says so instead of offering the control.

`PATCH /api/sessions/{id}` stays. Renaming and archiving a thread are recoverable, and the
line being drawn is destructive versus reversible, not write versus read.

### What keeps `POST /api/model/set` narrow

Model switching is exposed, because a surface that defers to a desktop dashboard is not a
primary one. But the same upstream route that assigns the main model also honours per-task
auxiliary pins, a provider `base_url` and an `api_key`, all of which get written to config.

A proxy cannot inspect request bodies. So the allowlist entry cannot express "main slot only",
and what actually keeps the rest off the phone is that no client here composes such a body:
`public/lib/api.js` sends a main-slot assignment and nothing else, pinned by a source-level
test. The neighbouring `/api/model/*` routes — presets, auxiliary pins, the recommended-default
probe — are refused by path, which is why the read allowlist names `/api/model/options`
exactly rather than allowing the `/api/model` prefix.

This is a **constraint to preserve, not a boundary the proxy enforces**, and it should be read
that way by anyone adding a call to that endpoint.

## The bug that mattered most

Sessions were originally created with `close_on_disconnect: true`. It was the right-looking
fix for a real problem — before it, nothing ever closed a session and every reconnect orphaned
one.

It was also wrong in a way only a phone reveals. That flag reaps the live session the instant
the socket drops, and a phone drops its socket **every single time it locks**. So the exact
thing an always-on agent is for — fire off a long task, pocket the phone — killed the task a
few seconds later. Acceptable for a viewer. Disqualifying for a control surface.

The fix was to drop the flag rather than to add machinery. Without it the host parks the
session instead of closing it, and two upstream properties make that safe: a session with a
turn in flight is never reaped, so the work survives the phone sleeping; and an idle parked
session is reaped after a short grace window that a `session.resume` inside that window
cancels, so nothing leaks either. On top of that the chat view reattaches on reconnect instead
of going deaf until the next send.

The general lesson is worth keeping: the disconnect semantics that are correct for a desktop
browser tab are wrong for a device whose normal state is asleep.

## Rejected approaches

- **No bundler and no framework.** The no-build deploy is genuinely an asset over a tailnet:
  edit a file, restart a service, reload. ES modules served directly over the local network
  are fast enough, and the transcript viewer did not make the module graph unwieldy. The cost
  is paid once, in the tests below.
- **Pull-to-refresh, rejected for an explicit control.** The scrolling element is the outlet,
  and iOS already rubber-bands it. A gesture handler either fights the rubber band or misfires
  mid-fling. A refresh button in the top bar, shown only on views that can refresh, is
  unambiguous and costs one tap.
- **Writing into Telegram or scheduled threads from this app.** Two verified failures say no
  (a second agent on the same transcript, and transport stealing) and one practical fact
  settles it: Telegram is already on the same phone. Hand off instead of duplicating.
- **Enabling the Hermes `api_server` gateway platform.** It would open a second agent front
  door that bypasses every control in `server.mjs` — identity gate, allowlists, rate limit and
  audit line included. A carefully gated front door plus an ungated one is an ungated one.
- **A Telegram deep-link for every thread.** Only half of it is honest. Supergroup and forum
  chats have ids in the `-100` space, `t.me/c/<internal>[/<topic>]` is the link Telegram itself
  produces for them, and that path *is* derivable and is implemented. Direct messages are not:
  the Bot API reports a private chat's id as the *user's* id, so a link built from it opens
  your own profile rather than the conversation with the bot. Addressing the bot needs its
  username, which lives in gateway config the proxy withholds on purpose. So `telegramHref`
  returns null there and the control is simply absent. A link to the wrong chat is worse than
  a missing link, and inventing a backend route to fetch the bot username would put a new hole
  in an allowlist built one line at a time.

## Known open items

- **Approval recovery is blocked upstream.** Approvals are cleared on disconnect, correctly —
  the request ids belonged to that connection. But no REST or RPC surface lists a session's
  *pending* approvals, so an approval raised while the phone slept cannot be recovered by the
  client at all. The turn itself now survives, which is the important half. Closing this
  properly needs a small addition in hermes-agent: an RPC that returns a session's pending
  prompt. A workaround was deliberately not invented, because every version of one guesses.
- **Attachments from the phone** need an upload route added to the allowlist. That is a new
  upload surface and therefore a security decision to take deliberately, not something to fold
  into a polish pass.
- **Edit-and-resend** on a sent message. Small, and simply not reached.
- **The offline send queue duplicates rather than loses.** A message composed with no socket is
  persisted to an outbox keyed to the thread and flushed only after reattach. The accepted
  tradeoff: a socket death between `prompt.submit` and its reply re-sends on flush. Duplicate
  was chosen over loss, because de-duplicating against history would break a legitimate
  repeated send — sending the same short message twice on purpose is normal.

## Why the test suite is shaped the way it is

The suite is **DOM-free by design** and spawns the real server against a stub upstream. Testing
the proxy means testing routing, allowlists, identity, headers and the crash paths as the
process actually behaves, not as a mocked module claims to. A headless DOM boot was used once
during integration, as a scratchpad, and deliberately not committed — a browser harness here
would be a second thing to maintain for weaker guarantees.

Two tests exist specifically to catch failures every other test sails past:

- **The import graph.** With no bundler, importing a name a module does not export is caught by
  nothing until the browser refuses the whole graph at link time and the app renders blank —
  while every server test still passes. `test/imports.test.mjs` walks the shipped modules and
  checks each import against the target's exports. This is exactly the mistake parallel edits
  to interlocking modules produce.
- **The service-worker precache list.** `cache.add()` on a path that does not exist fails
  silently, by design, so a file missing from `ASSETS` is simply absent offline and nowhere
  else. Adding a file to `public/lib` or `public/views` means adding it to `ASSETS`, and
  `test/pwa.test.mjs` fails if you forget.

Both are the tax for having no build step, and both are cheaper than the build step.
