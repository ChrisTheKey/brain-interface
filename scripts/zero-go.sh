#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ZERO GO — the one command.
#
#   scripts/zero-go.sh            laptop only    → http://127.0.0.1:3000
#   scripts/zero-go.sh --lan      laptop + phone → http://<detected LAN IP>:3000
#
# On Android use `scripts/start-zero-termux.sh`, which is the same idea with
# Termux's constraints built in (no init system, detachable, wake lock).
#
# THE GATEWAY COMES FIRST. Earlier this script built the interface and checked
# HWD-ZERO *before* starting the gateway, so a failed build or an absent
# backend meant no web server at all — the browser got ERR_CONNECTION_REFUSED
# and the interface could not even report what was wrong. The order is now:
# environment, ports, bundle, GATEWAY, prove port 3000 answers, and only then
# HWD-ZERO. Everything after the gateway is advisory.
#
# `READY` is printed only when the health probe genuinely came back healthy —
# a started process is not a healthy one, and this script never claims
# otherwise.
# ---------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
cd "$ZERO_ROOT"

LAN_MODE=false
for arg in "$@"; do
  case "$arg" in
    --lan) LAN_MODE=true ;;
    -h|--help) sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ "${ZERO_LAN_MODE:-}" = "true" ] && LAN_MODE=true

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# --- 1. environment --------------------------------------------------------
echo
echo "ZERO GO"
echo
echo "1 · ENVIRONMENT"
zero_require_node
zero_load_env
ok "node $(node -v)"
ok "host $(zero_os)$(zero_is_termux && echo ' (termux)')"
ok "ram $(zero_free_ram_mb) MB free of $(zero_total_ram_mb) MB"
[ "$(zero_free_ram_mb)" -lt 700 ] && warn "less than 700 MB free — close apps before running local models"

if [ ! -d node_modules ]; then
  warn "dependencies missing — installing"
  npm install --silent
fi
ok "dependencies present"

# --- 2. repositories -------------------------------------------------------
echo
echo "2 · REPOSITORIES"
ok "brain-interface  $ZERO_ROOT"
RUNTIME_PRESENT=false
if [ -d "$ZERO_RUNTIME_DIR" ]; then
  RUNTIME_PRESENT=true
  ok "HWD-ZERO         $ZERO_RUNTIME_DIR"
else
  # Named plainly, because a missing private checkout is the single most
  # common reason the backend never comes up.
  bad "HWD-ZERO         not found at $ZERO_RUNTIME_DIR"
  echo "      clone it next to this repository, or set ZERO_RUNTIME_DIR."
fi

# --- 3. ports --------------------------------------------------------------
echo
echo "3 · PORTS"
if zero_port_busy "$ZERO_UI_PORT"; then
  # Our own gateway from a previous run is fine to reuse; anything else is not.
  if [ -n "$(zero_health_field "http://127.0.0.1:$ZERO_UI_PORT/api/health" gateway)" ]; then
    warn "port $ZERO_UI_PORT already serves a ZERO gateway — stop it first: scripts/stop-zero.sh"
  else
    bad "port $ZERO_UI_PORT is taken by something else. Free it, then re-run."
  fi
  exit 1
fi
ok "port $ZERO_UI_PORT free"

# --- 4. interface bundle ----------------------------------------------------
echo
echo "4 · INTERFACE BUNDLE"
if [ ! -f dist/index.html ] || [ -n "$(find src index.html -newer dist/index.html 2>/dev/null | head -1)" ]; then
  warn "building the interface"
  if npm run build; then
    ok "built"
  elif [ -f dist/index.html ]; then
    # A stale interface that loads beats a fresh one that does not exist.
    warn "build failed — serving the previous bundle"
  else
    bad "build failed and there is no previous bundle to serve"
    exit 1
  fi
else
  ok "dist is current"
fi

# --- 5. gateway ------------------------------------------------------------
echo
echo "5 · GATEWAY"
ZERO_LAN_MODE="$LAN_MODE" \
ZERO_UI_PORT="$ZERO_UI_PORT" \
ZERO_API_URL="$ZERO_API_URL" \
ZERO_RUNTIME_WS_URL="$ZERO_RUNTIME_WS_URL" \
  node server/gateway.mjs &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$ZERO_PID_DIR/gateway.pid"

# "Is the gateway serving?" — not "is the whole chain healthy?". `/api/health`
# answers 503 precisely when the gateway is fine and HWD-ZERO is not, and
# treating that as failure is what used to kill a perfectly good gateway.
if zero_wait_http "http://127.0.0.1:$ZERO_UI_PORT/" 20 &&
   zero_wait_http "http://127.0.0.1:$ZERO_UI_PORT/api/health" 20; then
  ok "gateway answering on port $ZERO_UI_PORT"
else
  bad "ZERO GATEWAY FAILED — port $ZERO_UI_PORT did not answer"
  kill "$GATEWAY_PID" 2>/dev/null || true
  rm -f "$ZERO_PID_DIR/gateway.pid"
  exit 1
fi

# --- 6. HWD-ZERO (advisory from here) -----------------------------------------------------------
echo
echo "6 · HWD-ZERO"
# Nothing below this line may exit non-zero: the gateway is already serving,
# and the backend's state is something to report, not something to fail on.
ZERO_STARTED_HERE=false
if zero_http_ok "$ZERO_API_URL/api/health"; then
  ok "HTTP API already up"
elif [ "$RUNTIME_PRESENT" = true ]; then
  # HWD-ZERO's own serving layer, unless the operator configured another way.
  START_CMD="${ZERO_START_CMD:-python3 -m zero.server --host 127.0.0.1 --port $(zero_url_port "$ZERO_API_URL") --quiet}"
  warn "starting: $START_CMD"
  ( cd "$ZERO_RUNTIME_DIR" && eval "$START_CMD" >>"$ZERO_LOG_DIR/hwd-zero.log" 2>&1 ) &
  echo $! > "$ZERO_PID_DIR/hwd-zero.pid"
  ZERO_STARTED_HERE=true
  sleep 2
else
  warn "HTTP API not answering at $ZERO_API_URL"
  echo "      start it with:  cd \"$ZERO_RUNTIME_DIR\" && python -m zero.server"
  echo "      or set ZERO_START_CMD. The interface stays up and shows BACKEND OFFLINE."
fi

# --- 7. HWD-ZERO health ----------------------------------------------------
echo
echo "7 · HWD-ZERO HEALTH"
ZERO_HEALTHY=false
if zero_wait_http "$ZERO_API_URL/api/health" 10; then
  ZERO_HEALTHY=true
  ok "HTTP health at $ZERO_API_URL/api/health"
else
  warn "no HTTP health — the interface stays up and reports BACKEND OFFLINE"
fi

if [ -z "$ZERO_RUNTIME_WS_URL" ]; then
  ok "no runtime app-server configured (optional)"
elif zero_socket_open "$ZERO_RUNTIME_WS_URL"; then
  ok "runtime socket accepting at $ZERO_RUNTIME_WS_URL"
else
  warn "runtime socket not accepting at $ZERO_RUNTIME_WS_URL (optional component)"
fi

# --- 8. end-to-end health --------------------------------------------------
echo
echo "8 · HEALTH THROUGH THE GATEWAY"
HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"
GW="$(zero_health_field "$HEALTH_URL" gateway)"
ZS="$(zero_health_field "$HEALTH_URL" zero)"
WS="$(zero_health_field "$HEALTH_URL" websocket)"
[ "$GW" = "healthy" ] && ok "gateway   healthy" || bad "gateway   ${GW:-unknown}"
[ "$ZS" = "healthy" ] && ok "hwd-zero  healthy" || bad "hwd-zero  ${ZS:-offline}"
# `not_configured` is not a failure: the codex runtime app-server is optional
# and most deployments (every phone) do not run one.
case "$WS" in
  healthy)        ok   "runtime   healthy" ;;
  not_configured) ok   "runtime   not configured (optional)" ;;
  *)              warn "runtime   offline at $ZERO_RUNTIME_WS_URL" ;;
esac

# --- 9. the URLs -----------------------------------------------------------
LAN_IP="$(zero_lan_ip || true)"
echo
# READY turns on HWD-ZERO, not on the optional runtime app-server.
if [ "$ZS" = "healthy" ]; then
  echo "ZERO READY"
else
  # Never "ready" because a process started. READY means the chain answered.
  echo "ZERO ONLINE · BACKEND OFFLINE"
fi
echo
echo "LOCAL"
echo "http://127.0.0.1:$ZERO_UI_PORT"
echo
if [ "$LAN_MODE" = true ]; then
  echo "LAN"
  if [ -n "$LAN_IP" ]; then
    echo "http://$LAN_IP:$ZERO_UI_PORT"
  else
    echo "no LAN address detected — connect to WiFi or start the hotspot"
  fi
  echo
  echo "The pairing link with the token is printed by the gateway above."
  echo "No token is written to this output."
else
  echo "LAN"
  echo "disabled — re-run with --lan"
fi
echo
echo "ZERO API"
echo "/api"
echo
echo "EVENT STREAM"
echo "/ws"
echo
echo "HWD-ZERO"
if [ "$ZS" = "healthy" ]; then echo "HEALTHY"; else echo "OFFLINE"; fi
echo

trap '[ "$ZERO_STARTED_HERE" = true ] && kill "$(cat "$ZERO_PID_DIR/hwd-zero.pid" 2>/dev/null)" 2>/dev/null; kill "$GATEWAY_PID" 2>/dev/null' INT TERM
wait "$GATEWAY_PID"
