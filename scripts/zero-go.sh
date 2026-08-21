#!/usr/bin/env bash
# Everything, in one command.
#
#     GITHUB_TOKEN=ghp_… bash scripts/zero-go.sh
#
# Clone what is missing, install, build, start, print the URL. Written to be
# pasted as a single line into a phone terminal, because that is where it is
# used: a multi-line paste in Termux loses its newlines and runs the second
# command as an argument to the first.
#
# The token is read from the environment rather than prompted for. An
# interactive password prompt is exactly what failed on the phone — the paste
# does not survive it — and a non-interactive path also means this can be run
# again after a reboot without anyone typing anything.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
# lib-zero.sh turns on `set -e`. This script decides for itself what a failure
# means — a private agent repository that will not clone is reported and skipped,
# not fatal — so exit-on-error goes back off here.
set +e

BRANCH="${ZERO_BRANCH:-$(git -C "$ZERO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
OWNER="${ZERO_GITHUB_OWNER:-ChrisTheKey}"
TOKEN="${GITHUB_TOKEN:-${ZERO_GITHUB_TOKEN:-}}"

AGENTS=(
  Autonomous-Website-Lead-Scraper Meta-Agent Auto-Agent-Install-Helper
  Google-Bewertungen-AI-Agent Insta-Agent Autonomer-Website-Outreach-Agent
  SEO Funnel
)

echo "ZERO — ONE-SHOT START"
echo "  workspace: $ZERO_WORKSPACE"
echo "  branch:    $BRANCH"
echo "  token:     $([ -n "$TOKEN" ] && echo "supplied" || echo "none (public repositories only)")"
echo

# --------------------------------------------------------------------- clone
# The credential is passed per command and never written anywhere: not into
# .git/config, not into ~/.git-credentials, not into a remote URL. A token in a
# remote URL survives in every later `git remote -v`, which is how these leak.
git_auth() {
  if [ -z "$TOKEN" ]; then
    GIT_TERMINAL_PROMPT=0 git "$@"
    return
  fi
  local header
  header="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
  GIT_TERMINAL_PROMPT=0 git -c "http.extraHeader=Authorization: Basic $header" "$@"
}

clone_missing() {
  local name="$1" required="$2" output status
  [ -d "$ZERO_WORKSPACE/$name/.git" ] && { echo "  $name: present"; return 0; }

  output="$(git_auth clone --depth 1 -b "$BRANCH" \
    "https://github.com/$OWNER/$name.git" "$ZERO_WORKSPACE/$name" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then echo "  $name: cloned"; return 0; fi
  rm -rf "${ZERO_WORKSPACE:?}/$name"

  if printf '%s' "$output" | grep -qE '403|401|Authentication failed|could not read Username'; then
    if [ "$required" = required ]; then
      cat >&2 <<HINT
  $name: CANNOT CLONE — it is private and the token was rejected or missing.

  Create one at  https://github.com/settings/tokens
    classic token  -> tick the "repo" scope
    fine-grained   -> give it read access to $OWNER/$name
  Then run this again as ONE line:

    GITHUB_TOKEN=ghp_yourtoken bash scripts/zero-go.sh

  Or make $OWNER/$name public, and run it with no token at all.
HINT
      return 1
    fi
    echo "  $name: skipped (private, not authorised) — ZERO reports it OFFLINE"
    return 0
  fi

  echo "  $name: clone failed" >&2
  printf '%s\n' "$output" | tail -2 >&2
  [ "$required" = required ] && return 1
  return 0
}

mkdir -p "$ZERO_WORKSPACE"
echo "[1/4] repositories"
clone_missing HWD-ZERO required || exit 1
for name in "${AGENTS[@]}"; do clone_missing "$name" optional; done

# ------------------------------------------------------------------ operator
echo
echo "[2/4] operator"
if ! "$ZERO_PYTHON" -c "import yaml" >/dev/null 2>&1; then
  "$ZERO_PYTHON" -m pip install --quiet "PyYAML>=6.0" || {
    echo "  pip install PyYAML failed — try: pkg install python-pip" >&2; exit 1; }
fi
echo "  PyYAML: ok  ($("$ZERO_PYTHON" --version 2>&1))"

# ----------------------------------------------------------------- interface
echo
echo "[3/4] interface"
cd "$ZERO_ROOT"
if [ ! -d node_modules ]; then
  echo "  installing dependencies (a few minutes on a phone)…"
  npm install --no-audit --no-fund --loglevel=error || {
    echo "  npm install failed. Try: rm -rf node_modules package-lock.json && npm install" >&2
    exit 1; }
fi
if [ ! -d dist ]; then
  echo "  building…"
  # Bounded heap: this phone reported ~3 GB free, and the default heap on a
  # 64-bit build is large enough that the OOM killer takes the whole process
  # instead of node reporting a clean failure.
  NODE_OPTIONS="--max-old-space-size=${ZERO_BUILD_HEAP_MB:-1536}" npm run build || {
    echo >&2
    echo "  BUILD FAILED." >&2
    echo "  If it was killed: close other apps, then re-run. To go lower:" >&2
    echo "    ZERO_BUILD_HEAP_MB=1024 bash scripts/zero-go.sh" >&2
    exit 1; }
fi
echo "  dist: ready"

# --------------------------------------------------------------------- start
echo
echo "[4/4] starting"
if zero_port_busy "$ZERO_UI_PORT"; then
  echo "  port $ZERO_UI_PORT already in use — stopping what is there"
  bash "$ZERO_ROOT/scripts/stop-zero.sh" >/dev/null 2>&1
  sleep 1
fi

zero_wake_lock
zero_start_api || exit 1

ZERO_LAN_MODE=true ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 2
TOKEN_FILE="$ZERO_PID_DIR/gateway-token"
LAN_IP="$(zero_lan_ip || true)"

echo
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "======================================================"
  echo " ZERO IS ONLINE"
  echo "======================================================"
  echo
  echo " Open this in the browser on this device:"
  echo
  if [ -f "$TOKEN_FILE" ]; then
    echo "   http://localhost:$ZERO_UI_PORT/?token=$(cat "$TOKEN_FILE")"
  else
    echo "   http://localhost:$ZERO_UI_PORT"
  fi
  [ -n "$LAN_IP" ] && {
    echo
    echo " From another device on the same WiFi:"
    echo "   http://$LAN_IP:$ZERO_UI_PORT/?token=$(cat "$TOKEN_FILE" 2>/dev/null)"
  }
  echo
  echo " Agents:"
  zero_print_agents
  echo
  echo " Leave this session open. Stop it with: bash scripts/stop-zero.sh"
  echo "======================================================"
else
  echo "The gateway did not answer. Log: $ZERO_PID_DIR/hwd-zero.log" >&2
  zero_wake_unlock
  exit 1
fi
wait
