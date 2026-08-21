#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ZERO GO — the one command.
#
#   scripts/zero-go.sh            laptop only    → http://127.0.0.1:3000
#   scripts/zero-go.sh --lan      laptop + phone → http://<detected LAN IP>:3000
#
# Order matters, and it is the order below: the environment, then HWD-ZERO,
# then HWD-ZERO's health, then the gateway, then the interface, then the
# gateway's own health, then the socket. `READY` is printed at the end only
# when every one of those actually passed — a started process is not a healthy
# one, and this script never claims otherwise.
#
# If HWD-ZERO does not come up the interface still starts, and says
# BACKEND OFFLINE. That is deliberate: a visible, correct offline state beats a
# blank page every time.
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

# --- 4. HWD-ZERO -----------------------------------------------------------
echo
echo "4 · HWD-ZERO"
ZERO_STARTED_HERE=false
if zero_http_ok "$ZERO_API_URL/api/health"; then
  ok "HTTP API already up"
elif [ "$RUNTIME_PRESENT" = true ] && [ -n "${ZERO_START_CMD:-}" ]; then
  # Only ever the command the operator configured. This script does not invent
  # a way to start HWD-ZERO, and it does not start a second runtime of its own.
  warn "starting HWD-ZERO with ZERO_START_CMD"
  ( cd "$ZERO_RUNTIME_DIR" && eval "$ZERO_START_CMD" ) &
  echo $! > "$ZERO_PID_DIR/hwd-zero.pid"
  ZERO_STARTED_HERE=true
  sleep 2
else
  bad "HTTP API not answering at $ZERO_API_URL"
  echo "      set ZERO_START_CMD to the command that serves HWD-ZERO's API,"
  echo "      or start it yourself. The interface will show BACKEND OFFLINE."
fi

# --- 5. HWD-ZERO health ----------------------------------------------------
echo
echo "5 · HWD-ZERO HEALTH"
ZERO_HEALTHY=false
if zero_wait_http "$ZERO_API_URL/api/health" 10; then
  ZERO_HEALTHY=true
  ok "HTTP health at $ZERO_API_URL/api/health"
else
  bad "no HTTP health — the interface will report BACKEND OFFLINE"
fi

RUNTIME_SOCKET=false
if zero_socket_open "$ZERO_RUNTIME_WS_URL"; then
  RUNTIME_SOCKET=true
  ok "runtime socket accepting at $ZERO_RUNTIME_WS_URL"
else
  warn "runtime socket not accepting at $ZERO_RUNTIME_WS_URL"
fi

# --- 6. interface build ----------------------------------------------------
echo
echo "6 · INTERFACE"
if [ ! -d dist ] || [ -n "$(find src index.html -newer dist 2>/dev/null | head -1)" ]; then
  warn "building the interface"
  npm run build
fi
ok "dist present"

# --- 7. gateway ------------------------------------------------------------
echo
echo "7 · GATEWAY"
ZERO_LAN_MODE="$LAN_MODE" \
ZERO_UI_PORT="$ZERO_UI_PORT" \
ZERO_API_URL="$ZERO_API_URL" \
ZERO_RUNTIME_WS_URL="$ZERO_RUNTIME_WS_URL" \
  node server/gateway.mjs &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$ZERO_PID_DIR/gateway.pid"

if zero_wait_http "http://127.0.0.1:$ZERO_UI_PORT/api/health" 20; then
  ok "gateway answering on port $ZERO_UI_PORT"
else
  bad "gateway did not answer on port $ZERO_UI_PORT"
  kill "$GATEWAY_PID" 2>/dev/null || true
  exit 1
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
[ "$WS" = "healthy" ] && ok "websocket healthy" || bad "websocket ${WS:-offline}"

# --- 9. the URLs -----------------------------------------------------------
LAN_IP="$(zero_lan_ip || true)"
echo
if [ "$ZS" = "healthy" ] && [ "$WS" = "healthy" ]; then
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
