#!/usr/bin/env bash
#
# hermes-mobile installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ShresthaYaju/hermes-mobile/main/install.sh | bash
#
# or, from a clone:
#
#   ./install.sh
#
# What it does, in order -- every step is idempotent, so re-running after a
# `git pull` is the upgrade path:
#
#   1. Checks for git, Node 22+, Hermes Agent, Tailscale and user systemd.
#   2. Clones the repository to ~/hermes-mobile (or uses the clone it is in).
#   3. Installs the three runtime dependencies.
#   4. Writes ~/.config/hermes-mobile-pwa.env (mode 0600): a fresh loopback
#      token, your tailnet login as the identity allowlist, and a VAPID keypair
#      for push. Values already in the file are never overwritten.
#   5. Installs the two user systemd units with the real paths of `node` and
#      `hermes` substituted, and starts them.
#   6. Runs `tailscale serve` so the app is reachable from your phone.
#
# It never uses sudo. Where something needs root (usually `tailscale serve` the
# first time), it prints the command and stops rather than running it for you.
#
# Flags and the environment variables that mirror them:
#
#   --dir DIR        HERMES_MOBILE_DIR     where to clone      (~/hermes-mobile)
#   --login LOGIN    HERMES_MOBILE_LOGIN   tailnet login to allow (auto-detected)
#   --email ADDR     HERMES_MOBILE_EMAIL   Web Push contact    (your login, if an email)
#   --port PORT      HERMES_MOBILE_PORT    proxy port          (4174)
#   --no-push                              skip VAPID key generation
#   --no-serve                             skip `tailscale serve`
#   --uninstall                            stop and remove the units; keeps everything else
#
set -euo pipefail

REPO_URL='https://github.com/ShresthaYaju/hermes-mobile.git'
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-mobile-pwa.env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hermes-mobile"
BACKEND_UNIT='hermes-mobile-backend.service'
PROXY_UNIT='hermes-mobile-pwa.service'
HEALTH_TIMEOUT="${HERMES_MOBILE_INSTALL_HEALTH_TIMEOUT:-20}"

DIR="${HERMES_MOBILE_DIR:-$HOME/hermes-mobile}"
DIR_CHOSEN="${HERMES_MOBILE_DIR:+1}"
LOGIN="${HERMES_MOBILE_LOGIN:-}"
EMAIL="${HERMES_MOBILE_EMAIL:-}"
PORT="${HERMES_MOBILE_PORT:-4174}"
WANT_PUSH=1
WANT_SERVE=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; DIR_CHOSEN=1; shift 2 ;;
    --login) LOGIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-push) WANT_PUSH=0; shift ;;
    --no-serve) WANT_SERVE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; exit 2 ;;
  esac
done

# --- output -----------------------------------------------------------------

if [ -t 1 ]; then
  COLOR=1
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  COLOR=''
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
# OSC 8 makes a URL clickable in terminals that understand it; the others
# show the plain text, as does anything that is not a terminal.
link() {
  if [ -n "$COLOR" ]; then
    printf '\e]8;;%s\e\\%s\e]8;;\e\\' "$1" "$1"
  else
    printf '%s' "$1"
  fi
}
ok()   { printf '%s  ✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s  ! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
fail() { printf '%s  ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# When piped from curl, stdin is the script itself. Prompts go to the terminal
# directly; with no terminal, anything that would have prompted must come from
# a flag instead.
ask() {
  local prompt="$1" reply=''
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s  ? %s: %s' "$BOLD" "$prompt" "$RESET" > /dev/tty
    IFS= read -r reply < /dev/tty || true
  fi
  printf '%s' "$reply"
}

# --- uninstall --------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  step 'Removing the systemd units'
  systemctl --user disable --now "$PROXY_UNIT" "$BACKEND_UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$PROXY_UNIT" "$UNIT_DIR/$BACKEND_UNIT"
  systemctl --user daemon-reload
  ok 'Units stopped and removed'
  printf '\nLeft in place, delete them yourself if you want them gone:\n'
  printf '  %s\n  %s\n  %s\n' "$DIR" "$ENV_FILE" "$STATE_DIR"
  printf '\nTo stop exposing the port on your tailnet:\n  tailscale serve reset\n'
  exit 0
fi

# --- 1. preflight -----------------------------------------------------------

step 'Checking prerequisites'

[ "$(uname -s)" = Linux ] || fail 'The service units need Linux with user systemd.'
command -v git >/dev/null || fail 'git is not installed.'

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail 'Node.js is not installed. Version 22 or newer is required.'
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required; found $("$NODE" --version) at $NODE."
NPM="$(command -v npm || true)"
[ -n "$NPM" ] || fail 'npm is not installed.'
ok "Node $("$NODE" --version) at $NODE"

HERMES="$(command -v hermes || true)"
[ -n "$HERMES" ] || fail 'Hermes Agent is not on PATH. Install it first: https://github.com/NousResearch/hermes-agent'
ok "Hermes Agent at $HERMES"

command -v tailscale >/dev/null || fail 'Tailscale is not installed: https://tailscale.com/download'
TS_STATUS="$(tailscale status --json 2>/dev/null || true)"
[ -n "$TS_STATUS" ] || fail 'Tailscale is installed but not running. Start it with `tailscale up`.'
# The CLI hands back one JSON document; node is already required, so use it
# rather than depending on jq.
ts_field() {
  printf '%s' "$TS_STATUS" | "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const out = {
        state: j.BackendState ?? "",
        login: j.User?.[j.Self?.UserID]?.LoginName ?? "",
        dns: (j.Self?.DNSName ?? "").replace(/\.$/, ""),
      };
      process.stdout.write(out[process.argv[1]] ?? "");
    });' "$1"
}
[ "$(ts_field state)" = Running ] || fail "Tailscale is not connected (state: $(ts_field state)). Run \`tailscale up\`."
TS_LOGIN="$(ts_field login)"
TS_DNS="$(ts_field dns)"
ok "Tailscale up as ${TS_LOGIN:-<unknown login>}"

systemctl --user show-environment >/dev/null 2>&1 || fail 'systemctl --user does not work here. Is this a login session with user systemd?'
ok 'User systemd available'

case "$PORT" in ''|*[!0-9]*) fail "--port must be a number, got '$PORT'." ;; esac

# --- 2. the clone -----------------------------------------------------------

step 'Getting the code'

# Running from inside a checkout beats cloning a second copy next to it.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$DIR_CHOSEN" ] && [ -f "$SELF_DIR/server.mjs" ] && [ -f "$SELF_DIR/systemd/$PROXY_UNIT" ]; then
  DIR="$SELF_DIR"
fi

if [ -f "$DIR/server.mjs" ]; then
  ok "Using existing checkout at $DIR"
  printf '%s    (to upgrade: git -C %s pull, then run this again)%s\n' "$DIM" "$DIR" "$RESET"
elif [ -e "$DIR" ]; then
  fail "$DIR exists but is not a hermes-mobile checkout. Pass --dir to use somewhere else."
else
  git clone --quiet "$REPO_URL" "$DIR"
  ok "Cloned to $DIR"
fi

step 'Installing dependencies'
(cd "$DIR" && "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error)
ok 'Runtime dependencies installed'

# --- 3. the env file --------------------------------------------------------

step "Writing $ENV_FILE"

# Values already present are kept, whatever they are: this file holds the
# loopback token that every installed phone's session depends on, and a
# re-run must not rotate it out from under them.
env_has() { [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE"; }
env_get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-; }
env_set() {
  if env_has "$1"; then
    ok "$1 already set, kept"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
    ok "$1 written"
  fi
}

umask 077
mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR" "$STATE_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

env_set HERMES_DASHBOARD_SESSION_TOKEN "$("$NODE" -p 'require("crypto").randomBytes(32).toString("base64url")')"

if ! env_has HERMES_MOBILE_ALLOWED_LOGINS; then
  if [ -z "$LOGIN" ]; then
    LOGIN="$TS_LOGIN"
  fi
  if [ -z "$LOGIN" ]; then
    LOGIN="$(ask 'Tailnet login allowed to drive the agent (as `tailscale status` shows it)')"
  fi
  [ -n "$LOGIN" ] || fail 'Could not determine your tailnet login. Pass --login you@example.com.'
fi
env_set HERMES_MOBILE_ALLOWED_LOGINS "$LOGIN"

if [ "$WANT_PUSH" = 1 ]; then
  if env_has HERMES_MOBILE_VAPID_PRIVATE_KEY; then
    ok 'VAPID keys already set, kept'
  else
    # Apple's push service rejects a placeholder contact outright, so a
    # subject is required to bother generating keys at all. The tailnet
    # login is usually an email and is already local to this file.
    if [ -z "$EMAIL" ]; then
      case "${LOGIN:-$(env_get HERMES_MOBILE_ALLOWED_LOGINS)}" in
        *@*) EMAIL="${LOGIN:-$(env_get HERMES_MOBILE_ALLOWED_LOGINS)}" ;;
      esac
    fi
    if [ -z "$EMAIL" ]; then
      EMAIL="$(ask 'Contact email for Web Push (blank to skip push)')"
    fi
    if [ -n "$EMAIL" ]; then
      KEYS="$(cd "$DIR" && "$NODE" -p 'const k = require("web-push").generateVAPIDKeys(); k.publicKey + " " + k.privateKey')"
      env_set HERMES_MOBILE_VAPID_PUBLIC_KEY "${KEYS%% *}"
      env_set HERMES_MOBILE_VAPID_PRIVATE_KEY "${KEYS##* }"
      env_set HERMES_MOBILE_VAPID_SUBJECT "mailto:$EMAIL"
    else
      warn 'No contact email; push notifications stay off. Re-run with --email you@example.com to enable them.'
    fi
  fi
fi

# --- 4. systemd -------------------------------------------------------------

step 'Installing the service units'

# The shipped units assume ~/.local/bin and ~/hermes-mobile. Substitute what
# this machine actually has so nobody meets status=203/EXEC.
sed -e "s|^ExecStart=%h/.local/bin/hermes |ExecStart=$HERMES |" \
  "$DIR/systemd/$BACKEND_UNIT" > "$UNIT_DIR/$BACKEND_UNIT"
sed -e "s|^ExecStart=%h/.local/bin/node %h/hermes-mobile/server.mjs|ExecStart=$NODE $DIR/server.mjs|" \
  -e "s|^WorkingDirectory=%h/hermes-mobile|WorkingDirectory=$DIR|" \
  -e "s|^Environment=PORT=4174|Environment=PORT=$PORT|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=$STATE_DIR|" \
  "$DIR/systemd/$PROXY_UNIT" > "$UNIT_DIR/$PROXY_UNIT"
sed -i -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" "$UNIT_DIR/$BACKEND_UNIT"
grep -q "^ExecStart=$HERMES " "$UNIT_DIR/$BACKEND_UNIT" || fail "Could not patch ExecStart in $BACKEND_UNIT; edit it by hand."
grep -q "^ExecStart=$NODE " "$UNIT_DIR/$PROXY_UNIT" || fail "Could not patch ExecStart in $PROXY_UNIT; edit it by hand."
ok "Units written to $UNIT_DIR"

systemctl --user daemon-reload
systemctl --user enable --quiet "$BACKEND_UNIT" "$PROXY_UNIT"
# `enable --now` leaves an already-running unit untouched; restart so a re-run
# after `git pull` or an env change actually takes effect.
systemctl --user restart "$BACKEND_UNIT" "$PROXY_UNIT"
ok 'Services enabled and started'

# Without linger the user manager, and both services with it, stop when the
# last SSH session closes. Own-user linger normally needs no privilege, but
# some polkit setups refuse it -- say so rather than fail.
ME="${USER:-$(id -un)}"
if loginctl enable-linger "$ME" 2>/dev/null; then
  ok 'Services will keep running after you log out'
else
  warn "Could not enable linger; services stop at logout. Run: sudo loginctl enable-linger $ME"
fi

step 'Waiting for the proxy'
HEALTHY=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if "$NODE" -e "fetch('http://127.0.0.1:$PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" = 1 ]; then
  ok "Proxy answering on 127.0.0.1:$PORT"
else
  warn "Proxy did not answer on 127.0.0.1:$PORT within ${HEALTH_TIMEOUT}s. Check: journalctl --user -u $PROXY_UNIT -n 50"
fi
# The proxy answers /healthz whether or not Hermes is up, so look at the
# backend unit separately: a `hermes serve` already running some other way
# fails this one on the port and the app would show 502 for no obvious reason.
if systemctl --user is-active --quiet "$BACKEND_UNIT"; then
  ok 'Hermes backend running'
else
  warn "$BACKEND_UNIT is not running. Check: journalctl --user -u $BACKEND_UNIT -n 50"
  HEALTHY=0
fi

# --- 5. tailscale serve -----------------------------------------------------

if [ "$WANT_SERVE" = 1 ]; then
  step 'Exposing to your tailnet'
  # `tailscale serve --bg PORT` takes over `/` on port 443. Never do that to
  # something else already served there; say what is in the way instead.
  OTHER="$(tailscale serve status --json 2>/dev/null | "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = s.trim() ? JSON.parse(s) : {};
      const mine = "http://127.0.0.1:" + process.argv[1];
      for (const site of Object.values(j.Web ?? {}))
        for (const h of Object.values(site.Handlers ?? {}))
          if (h.Proxy && h.Proxy !== mine) return process.stdout.write(h.Proxy);
    });' "$PORT")"
  if [ -n "$OTHER" ]; then
    warn "tailscale serve already forwards to $OTHER; not touching it. To switch it to this app:"
    printf '      tailscale serve --bg %s\n' "$PORT"
  elif tailscale serve --bg "$PORT" >/dev/null 2>&1; then
    ok "tailscale serve → 127.0.0.1:$PORT"
  else
    warn 'tailscale serve needs more than this user has. Either run once:'
    printf '      sudo tailscale set --operator=%s\n' "$USER"
    printf '    and re-run this script, or run the one command it could not:\n'
    printf '      sudo tailscale serve --bg %s\n' "$PORT"
  fi
fi

# --- done -------------------------------------------------------------------

printf '\n%sDone.%s\n\n' "$BOLD" "$RESET"
if [ -n "$TS_DNS" ]; then
  URL="https://$TS_DNS"
  printf 'Open this on your phone, or point its camera at the code below:\n\n'
  printf '  %s%s%s\n\n' "$BOLD" "$(link "$URL")" "$RESET"
  "$NODE" "$DIR/qr.mjs" ${COLOR:+--color} --indent 2 "$URL" \
    || warn 'Could not draw the QR code; type the URL instead.'
  printf '\n'
else
  printf 'Open the URL shown by `tailscale serve status` on your phone.\n\n'
fi
printf 'The phone must be on the same tailnet. Once the page is open:\n'
printf '  iOS      Share → Add to Home Screen\n'
printf '  Android  Install app\n'
printf 'Push notifications are offered under Config once it is on the home screen.\n\n'
printf '%sUseful later:%s\n' "$DIM" "$RESET"
printf '  systemctl --user status %s %s\n' "$BACKEND_UNIT" "$PROXY_UNIT"
printf '  journalctl --user -u %s -f\n' "$PROXY_UNIT"
printf '  git -C %s pull && %s/install.sh      # upgrade\n' "$DIR" "$DIR"
printf '  %s/install.sh --uninstall\n' "$DIR"
[ "$HEALTHY" = 1 ]
