#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ZERO on Android / Termux — and anywhere else with bash and node.
#
#   bash scripts/start-zero-termux.sh                foreground, loopback
#   bash scripts/start-zero-termux.sh --background   detached, logs to .zero/logs
#   bash scripts/start-zero-termux.sh --lan          also reachable from the LAN
#   bash scripts/start-zero-termux.sh --stop         stop what this script started
#
# The rule this script exists to enforce:
#
#     THE GATEWAY STARTS FIRST, AND NOTHING ABOUT THE BACKEND CAN STOP IT.
#
# The interface on port 3000 is what the user looks at. If HWD-ZERO is missing,
# broken, half-installed or simply slow, port 3000 must still answer and the
# interface must say BACKEND OFFLINE. A backend that is not running is a state
# to display, never a reason for the web server to disappear.
#
# So: build (failure is survivable), start the gateway, *prove* port 3000
# answers, and only then go looking for HWD-ZERO. Every backend step below the
# gateway is advisory — it changes what is reported, never whether we serve.
#
# No systemd, no sudo, no launchctl, no Windows services. Termux is first class.
# ---------------------------------------------------------------------------
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
cd "$ZERO_ROOT"

BACKGROUND=false
LAN_MODE=false
STOP_ONLY=false
NO_BACKEND=false

for arg in "$@"; do
  case "$arg" in
    --background|-b) BACKGROUND=true ;;
    --lan) LAN_MODE=true ;;
    --stop) STOP_ONLY=true ;;
    --no-backend) NO_BACKEND=true ;;
    -h|--help) sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done
[ "${ZERO_LAN_MODE:-}" = "true" ] && LAN_MODE=true

GATEWAY_PID_FILE="$ZERO_PID_DIR/gateway.pid"
ZERO_PID_FILE="$ZERO_PID_DIR/hwd-zero.pid"
GATEWAY_LOG="$ZERO_LOG_DIR/gateway.log"
ZERO_LOG="$ZERO_LOG_DIR/hwd-zero.log"
WAKELOCK_FILE="$ZERO_PID_DIR/wakelock"

ok()   { printf '  [ok]   %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }

HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"

# ---------------------------------------------------------------------------
# stop — only ever what this script started, identified by pid file
# ---------------------------------------------------------------------------
stop_tracked() {
  local stopped=0
  for entry in "gateway:$GATEWAY_PID_FILE" "hwd-zero:$ZERO_PID_FILE"; do
    local name="${entry%%:*}" file="${entry#*:}" pid
    if pid="$(zero_live_pid "$file")"; then
      # TERM, then a short grace period, then KILL. Never a pattern match:
      # `pkill node` on a phone kills whatever else the user is running.
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
      ok "$name stopped (pid $pid)"
      stopped=$((stopped + 1))
    elif [ -f "$file" ]; then
      warn "$name pid file was stale — removed, nothing killed"
    fi
    rm -f "$file"
  done
  if [ -f "$WAKELOCK_FILE" ]; then
    command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock >/dev/null 2>&1
    rm -f "$WAKELOCK_FILE"
  fi
  [ "$stopped" -eq 0 ] && echo "  nothing that this script started was running"
  return 0
}

if [ "$STOP_ONLY" = true ]; then
  step "ZERO STOP"
  stop_tracked
  exit 0
fi

# ---------------------------------------------------------------------------
# 1 · workspace and runtimes
# ---------------------------------------------------------------------------
step "1 · WORKSPACE"
ok "root      $ZERO_ROOT"
if zero_is_termux; then
  ok "host      termux (android)"
else
  ok "host      $(zero_os)"
fi
zero_load_env

if ! command -v node >/dev/null 2>&1; then
  bad "node is not installed. In Termux:  pkg install nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  bad "node $(node -v) is too old — ZERO's gateway needs >= 20.19. In Termux: pkg upgrade nodejs"
  exit 1
fi
ok "node      $(node -v)"

PYTHON_BIN=""
for candidate in "$ZERO_RUNTIME_DIR/.venv/bin/python" python3 python; do
  if [ -x "$candidate" ] || command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -n "$PYTHON_BIN" ]; then
  ok "python    $("$PYTHON_BIN" --version 2>&1)"
else
  # Not fatal. Python is the backend's business, and the backend is optional.
  warn "python    not found — HWD-ZERO cannot start (the interface still will)"
fi

# ---------------------------------------------------------------------------
# 2 · stale run state
# ---------------------------------------------------------------------------
step "2 · RUN STATE"
zero_clear_stale_pid "$GATEWAY_PID_FILE" && warn "removed a stale gateway pid file"
zero_clear_stale_pid "$ZERO_PID_FILE" && warn "removed a stale hwd-zero pid file"

if EXISTING="$(zero_live_pid "$GATEWAY_PID_FILE")"; then
  if zero_http_ok "$HEALTH_URL"; then
    ok "a ZERO gateway is already running (pid $EXISTING) and answering"
    echo
    echo "LOCAL   http://127.0.0.1:$ZERO_UI_PORT"
    echo "STOP    bash scripts/start-zero-termux.sh --stop"
    exit 0
  fi
  warn "gateway pid $EXISTING is alive but not answering — restarting it"
  stop_tracked
fi

if zero_port_busy "$ZERO_UI_PORT"; then
  bad "port $ZERO_UI_PORT is held by a process this script did not start."
  echo "       Find it with:  ss -ltnp 2>/dev/null | grep :$ZERO_UI_PORT"
  echo "       ZERO will not kill a process it does not own."
  exit 1
fi
ok "port $ZERO_UI_PORT is free"

# ---------------------------------------------------------------------------
# 3 · the interface bundle
#
# A build failure is survivable when a previous `dist` exists: serving a
# slightly stale interface beats serving nothing. Only "no bundle at all" is
# fatal, and then the log says why.
# ---------------------------------------------------------------------------
step "3 · INTERFACE BUNDLE"
NEEDS_BUILD=false
if [ ! -f dist/index.html ]; then
  NEEDS_BUILD=true
elif [ -n "$(find src index.html package.json -newer dist/index.html 2>/dev/null | head -1)" ]; then
  NEEDS_BUILD=true
fi

if [ "$NEEDS_BUILD" = true ]; then
  if [ ! -d node_modules ]; then
    warn "installing dependencies (this is the slow part on a phone)"
    npm install >>"$ZERO_LOG_DIR/build.log" 2>&1 || warn "npm install reported errors — see .zero/logs/build.log"
  fi
  warn "building the interface"
  if npm run build >>"$ZERO_LOG_DIR/build.log" 2>&1; then
    ok "built"
  elif [ -f dist/index.html ]; then
    warn "build failed — serving the previous bundle instead"
    zero_tail_log "$ZERO_LOG_DIR/build.log" 15
  else
    bad "build failed and there is no previous bundle to serve"
    zero_tail_log "$ZERO_LOG_DIR/build.log" 30
    exit 1
  fi
else
  ok "dist is current"
fi

# ---------------------------------------------------------------------------
# 4 · THE GATEWAY — before any backend work, and independent of it
# ---------------------------------------------------------------------------
step "4 · GATEWAY"
: >"$GATEWAY_LOG"
GATEWAY_ENV=(
  "ZERO_LAN_MODE=$LAN_MODE"
  "ZERO_UI_PORT=$ZERO_UI_PORT"
  "ZERO_API_URL=$ZERO_API_URL"
  "ZERO_RUNTIME_WS_URL=$ZERO_RUNTIME_WS_URL"
)

# nohup + setsid where available: closing the Termux session, or Android
# freezing the terminal, must not take the gateway with it.
if command -v setsid >/dev/null 2>&1; then
  setsid env "${GATEWAY_ENV[@]}" nohup node server/gateway.mjs >>"$GATEWAY_LOG" 2>&1 &
else
  env "${GATEWAY_ENV[@]}" nohup node server/gateway.mjs >>"$GATEWAY_LOG" 2>&1 &
fi
GATEWAY_PID=$!
echo "$GATEWAY_PID" >"$GATEWAY_PID_FILE"
ok "gateway started (pid $GATEWAY_PID)"

# ---------------------------------------------------------------------------
# 5 · PROVE port 3000 answers. Claiming ONLINE without checking is the bug.
# ---------------------------------------------------------------------------
step "5 · GATEWAY HEALTH"
GATEWAY_UP=false
for _ in $(seq 1 40); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    break  # It died; the log below says why.
  fi
  # Both the interface root and the health endpoint, because either failing
  # alone still means the user sees a broken page.
  if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/" && zero_http_ok "$HEALTH_URL"; then
    GATEWAY_UP=true
    break
  fi
  sleep 0.5
done

if [ "$GATEWAY_UP" != true ]; then
  bad "ZERO GATEWAY FAILED — port $ZERO_UI_PORT did not answer"
  echo
  zero_tail_log "$GATEWAY_LOG" 30
  echo
  echo "LOG     $GATEWAY_LOG"
  rm -f "$GATEWAY_PID_FILE"
  kill "$GATEWAY_PID" 2>/dev/null || true
  exit 1
fi
ok "GET /            answers"
ok "GET /api/health  answers"

# ---------------------------------------------------------------------------
# 6 · HWD-ZERO — advisory from here on. Nothing below may exit non-zero.
# ---------------------------------------------------------------------------
step "6 · HWD-ZERO"
# Tracks whether there is any point waiting for the backend in step 7.
BACKEND_EXPECTED=false
if [ "$NO_BACKEND" = true ]; then
  warn "skipped (--no-backend); the interface will report BACKEND OFFLINE"
elif zero_http_ok "$ZERO_API_URL/api/health"; then
  ok "already running at $ZERO_API_URL"
  BACKEND_EXPECTED=true
elif [ ! -d "$ZERO_RUNTIME_DIR" ]; then
  warn "not checked out at $ZERO_RUNTIME_DIR"
  echo "         git clone https://github.com/ChrisTheKey/HWD-ZERO \"$ZERO_RUNTIME_DIR\""
elif [ -z "$PYTHON_BIN" ]; then
  warn "python is missing, so HWD-ZERO cannot be started here"
else
  BACKEND_EXPECTED=true
  zero_clear_stale_pid "$ZERO_PID_FILE" >/dev/null
  : >"$ZERO_LOG"
  # `python -m zero.server` is HWD-ZERO's own serving layer. ZERO_START_CMD
  # overrides it for a deployment that starts the operator some other way.
  START_CMD="${ZERO_START_CMD:-}"
  if [ -z "$START_CMD" ]; then
    START_CMD="$PYTHON_BIN -m zero.server --host 127.0.0.1 --port $(zero_url_port "$ZERO_API_URL") --quiet"
  fi
  warn "starting: $START_CMD"
  (
    cd "$ZERO_RUNTIME_DIR" || exit 1
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup sh -c "$START_CMD" >>"$ZERO_LOG" 2>&1 &
    else
      nohup sh -c "$START_CMD" >>"$ZERO_LOG" 2>&1 &
    fi
    echo $! >"$ZERO_PID_FILE"
  ) || warn "could not launch HWD-ZERO"
fi

# ---------------------------------------------------------------------------
# 7 · backend health, read back through the gateway
# ---------------------------------------------------------------------------
step "7 · BACKEND HEALTH"
# Waiting is only worth it when something was actually started or found. With
# no backend in play the answer is already known, and ten seconds of polling a
# port nobody is listening on just delays the URLs the user is waiting for.
ATTEMPTS=1
[ "$BACKEND_EXPECTED" = true ] && ATTEMPTS=20
ZERO_STATE=""
for _ in $(seq 1 "$ATTEMPTS"); do
  ZERO_STATE="$(zero_health_field "$HEALTH_URL" zero)"
  [ "$ZERO_STATE" = "healthy" ] && break
  [ "$ATTEMPTS" -gt 1 ] && sleep 0.5
done
WS_STATE="$(zero_health_field "$HEALTH_URL" websocket)"
GW_STATE="$(zero_health_field "$HEALTH_URL" gateway)"

[ "$GW_STATE" = "healthy" ] && ok "gateway    healthy" || bad "gateway    ${GW_STATE:-unknown}"
if [ "$ZERO_STATE" = "healthy" ]; then
  ok "hwd-zero   healthy"
else
  warn "hwd-zero   offline — the interface stays up and reports BACKEND OFFLINE"
  [ -s "$ZERO_LOG" ] && zero_tail_log "$ZERO_LOG" 12
fi
case "$WS_STATE" in
  healthy)        ok   "runtime    healthy" ;;
  not_configured) ok   "runtime    not configured (optional)" ;;
  *)              warn "runtime    offline (optional component)" ;;
esac

# ---------------------------------------------------------------------------
# 8 · wake lock (background only, and optional)
# ---------------------------------------------------------------------------
if [ "$BACKGROUND" = true ] && command -v termux-wake-lock >/dev/null 2>&1; then
  if termux-wake-lock >/dev/null 2>&1; then
    touch "$WAKELOCK_FILE"
    ok "termux wake lock held (released by --stop)"
  fi
fi

# ---------------------------------------------------------------------------
# 9 · the real URLs
# ---------------------------------------------------------------------------
LAN_IP="$(zero_lan_ip || true)"
echo
if [ "$ZERO_STATE" = "healthy" ]; then
  echo "ZERO READY"
else
  echo "ZERO ONLINE · BACKEND OFFLINE"
fi
echo
echo "LOCAL"
echo "http://127.0.0.1:$ZERO_UI_PORT"
echo "http://localhost:$ZERO_UI_PORT"
echo
if [ "$LAN_MODE" = true ]; then
  echo "LAN"
  if [ -n "$LAN_IP" ]; then
    echo "http://$LAN_IP:$ZERO_UI_PORT"
    echo "(the pairing link with the token is in $GATEWAY_LOG)"
  else
    echo "no LAN address detected — connect to WiFi or start the hotspot"
  fi
  echo
fi
echo "HEALTH"
echo "curl -s http://127.0.0.1:$ZERO_UI_PORT/api/health"
echo
echo "LOGS"
echo "tail -f $GATEWAY_LOG"
echo "tail -f $ZERO_LOG"
echo
echo "STOP"
echo "bash scripts/start-zero-termux.sh --stop"
echo

if [ "$BACKGROUND" = true ]; then
  echo "Running in the background. This shell can be closed."
  exit 0
fi

# Foreground: hold the terminal and hand Ctrl-C to the tracked processes only.
trap 'echo; stop_tracked; exit 0' INT TERM
echo "Foreground mode — Ctrl-C stops ZERO. (--background detaches instead.)"
while kill -0 "$GATEWAY_PID" 2>/dev/null; do
  sleep 2
done
bad "the gateway exited unexpectedly"
zero_tail_log "$GATEWAY_LOG" 30
rm -f "$GATEWAY_PID_FILE"
exit 1
