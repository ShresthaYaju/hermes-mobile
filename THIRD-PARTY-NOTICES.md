# Third-party notices

hermes-mobile itself is [MIT](LICENSE) licensed. It ships no vendored code: the
`public/` tree is entirely first-party, with no bundled libraries, polyfills or
webfonts. Everything below is pulled from npm at install time.

## Runtime dependencies

Three, deliberately.

- **`http-proxy-3`** — MIT. The REST proxy.
- **`ws`** — MIT. WebSocket framing for the session multiplexer, on both the
  phone side and the Hermes side. No dependencies of its own.
- **`web-push`** — **MPL-2.0**. VAPID signing and Web Push delivery. This is the
  one non-permissive license in the tree.

### On the MPL-2.0 dependency

Mozilla Public License 2.0 is OSI-approved and *file-level* (weak) copyleft: its
obligations attach to the MPL-covered files themselves, not to software that
merely uses them. `web-push` is consumed here as an unmodified npm dependency
and none of its source is copied into this repository, so it imposes nothing on
this project's MIT licensing or on yours.

Two things to keep true if you fork or redistribute this:

- If you ever *modify* `web-push` and distribute the result, the modified files
  stay under MPL-2.0 and their source must be made available.
- If you redistribute a bundle that includes it, keep this notice with it.

Its full license text is in `node_modules/web-push/LICENSE` after `npm ci`, and
upstream at <https://github.com/web-push-libs/web-push>.

## Development dependencies

- **`prettier`** — MIT. Formatting only; not shipped or served.

## Full resolved tree

As locked by `package-lock.json`. Regenerate with `npm ls --all`.

| Package | Version | License |
| --- | --- | --- |
| `agent-base` | 7.1.4 | MIT |
| `asn1.js` | 5.4.1 | MIT |
| `bn.js` | 4.12.5 | MIT |
| `buffer-equal-constant-time` | 1.0.1 | BSD-3-Clause |
| `debug` | 4.4.3 | MIT |
| `ecdsa-sig-formatter` | 1.0.11 | Apache-2.0 |
| `follow-redirects` | 1.16.0 | MIT |
| `http_ece` | 1.2.0 | MIT |
| `http-proxy-3` | 1.23.3 | MIT |
| `https-proxy-agent` | 7.0.6 | MIT |
| `inherits` | 2.0.4 | ISC |
| `jwa` | 2.0.1 | MIT |
| `jws` | 4.0.1 | MIT |
| `minimalistic-assert` | 1.0.1 | ISC |
| `minimist` | 1.2.8 | MIT |
| `ms` | 2.1.3 | MIT |
| `prettier` | 3.9.6 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `web-push` | 3.6.7 | MPL-2.0 |
| `ws` | 8.21.3 | MIT |

Every package above is MIT, ISC, BSD-3-Clause or Apache-2.0 except `web-push`,
which is MPL-2.0 as described above. There is no GPL, AGPL or LGPL anywhere in
the tree, and no package with an unknown or missing license field.
