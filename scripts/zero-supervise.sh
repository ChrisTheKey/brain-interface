#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ZERO supervisor — keeps HWD-ZERO alive behind the gateway.
#
# Termux has no systemd, no launchd and no service manager, so "keep it
# running" has to be something ZERO does for itself. This is the smallest
# thing that honestly qualifies: a loop that checks one pid, and restarts one
# process when it is gone.
#
# Deliberately narrow:
#
#   - It supervises HWD-ZERO only. The gateway needs no supervisor — it
#     survives an absent backend by design, and a supervisor that restarted it
#     would be a second thing able to take port 3000 away.
#   - It exits the moment the gateway does, so a stopped ZERO does not leave an
#     orphan loop respawning a backend nobody is talking to.
#   - Restarts back off: 1s, 2s, 5s, 10s, then 15s. A backend that dies
#     instantly, over and over, is a broken install; hammering it hides the
#     error instead of surfacing it, and on a phone it costs the battery too.
#     After a burst the supervisor gives up and says so in the log.
#   - It never starts a second HWD-ZERO. Before restarting it asks the port who
#     is there: an HWD-ZERO already answering is adopted, not duplicated. That
#     duplicate is what produced `[Errno 98] Address already in use`, and the
#     crash that followed it.
#   - It never kills anything it did not start, and never matches by process
#     name.
#
# Started by scripts/start-zero-termux.sh; not meant to be run by hand.
# ---------------------------------------------------------------------------
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
# No `errexit`: a supervisor that exits when a check fails is not a
# supervisor. Every failure here is a condition to act on, not an ending.
set +e

GATEWAY_PID_FILE="$ZERO_PID_DIR/gateway.pid"
ZERO_PID_FILE="$ZERO_PID_DIR/hwd-zero.pid"
SUPERVISOR_PID_FILE="$ZERO_PID_DIR/supervisor.pid"
ZERO_LOG="$ZERO_LOG_DIR/hwd-zero.log"
SUPERVISOR_LOG="$ZERO_LOG_DIR/supervisor.log"

# The command to (re)start, passed in by the caller so the supervisor never
# has to guess how this deployment runs HWD-ZERO.
START_CMD="${ZERO_SUPERVISE_CMD:-}"
CHECK_EVERY="${ZERO_SUPERVISE_INTERVAL:-10}"
# At most this many restarts inside the window below, then stop trying.
MAX_RESTARTS="${ZERO_SUPERVISE_MAX_RESTARTS:-5}"
WINDOW_SECONDS="${ZERO_SUPERVISE_WINDOW:-300}"
# A cold HWD-ZERO loads the brain before it binds. Restarting it during that is
# how one slow start becomes a restart loop.
# Measured against a cold start on the phone, with room to spare. It is added
# to the backoff rather than replacing it: the backoff spaces out *retries*,
# the grace is how long a backend gets to bind before it is judged.
GRACE_SECONDS="${ZERO_SUPERVISE_GRACE:-10}"
# Bounded, and it stays bounded: the last value repeats rather than growing.
BACKOFF_STEPS="${ZERO_SUPERVISE_BACKOFF:-1 2 5 10 15}"
ZERO_API_PORT="$(zero_url_port "$ZERO_API_URL" 2>/dev/null || echo 8000)"

echo "$$" >"$SUPERVISOR_PID_FILE"
trap 'rm -f "$SUPERVISOR_PID_FILE"; exit 0' INT TERM EXIT

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >>"$SUPERVISOR_LOG"
}

if [ -z "$START_CMD" ]; then
  log "no ZERO_SUPERVISE_CMD given — nothing to supervise"
  exit 0
fi

log "supervising HWD-ZERO every ${CHECK_EVERY}s (grace ${GRACE_SECONDS}s): $START_CMD"

RESTARTS=0
WINDOW_STARTED=$(date +%s)
# A backend the start script just launched is still loading its brain, and
# restarting it mid-load is how one slow start becomes a restart loop. With no
# backend in play there is nothing to be patient about, so the grace is only
# taken when there is already something to wait for.
NEXT_CHECK_AT=0
if [ -f "$ZERO_PID_FILE" ]; then
  NEXT_CHECK_AT=$(( $(date +%s) + GRACE_SECONDS ))
fi

backend_alive() {
  # Alive means both: the process exists *and* it is answering. A python
  # process stuck on a port it never bound is not a running backend.
  zero_live_pid "$ZERO_PID_FILE" >/dev/null && zero_http_ok "$ZERO_API_URL/api/health"
}

# Is an HWD-ZERO already on the port that this supervisor simply lost track of?
#
# It happens: a pid file removed by hand, a restarted supervisor, a backend
# started from another terminal. Adopting it is right and starting a second one
# is wrong — the second would fail to bind and take the first down with it in
# the confusion that follows.
adopt_existing() {
  local running
  running="$(zero_zero_on_port "$ZERO_API_PORT")" || return 1
  [ -n "$running" ] || return 1
  echo "$running" >"$ZERO_PID_FILE"
  log "adopted the HWD-ZERO already serving port $ZERO_API_PORT (pid $running)"
  return 0
}

# The nth backoff, with the last step repeating forever.
backoff_for() {
  local index="$1" step last=1
  local count=0
  for step in $BACKOFF_STEPS; do
    count=$((count + 1))
    last="$step"
    [ "$count" -eq "$index" ] && { echo "$step"; return 0; }
  done
  echo "$last"
}

start_backend() {
  : >"$ZERO_LOG.restart"
  (
    cd "$ZERO_RUNTIME_DIR" 2>/dev/null || exit 1
    # `exec` matters: without it `$!` names this shell rather than the server
    # it launches, so the pid file would point at a wrapper — and stopping the
    # wrapper would leave the real process orphaned.
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup sh -c "exec $START_CMD" >>"$ZERO_LOG" 2>&1 &
    else
      nohup sh -c "exec $START_CMD" >>"$ZERO_LOG" 2>&1 &
    fi
    echo $! >"$ZERO_PID_FILE"
  )
}

while true; do
  sleep "$CHECK_EVERY"

  # The gateway is the anchor. When it is gone, ZERO is stopped, and this
  # loop has nothing left to keep alive.
  if ! zero_live_pid "$GATEWAY_PID_FILE" >/dev/null; then
    log "gateway is gone — supervisor exiting"
    exit 0
  fi

  if backend_alive; then
    # Healthy: the next failure starts a fresh backoff.
    RESTARTS=0
    NEXT_CHECK_AT=0
    continue
  fi

  NOW=$(date +%s)
  # Still inside the grace period or a backoff wait. Not a failure yet.
  [ "$NOW" -lt "$NEXT_CHECK_AT" ] && continue

  # Before starting anything: is one already there?
  if adopt_existing; then
    RESTARTS=0
    continue
  fi

  if [ $((NOW - WINDOW_STARTED)) -ge "$WINDOW_SECONDS" ]; then
    # A fresh window: earlier failures are old news.
    RESTARTS=0
    WINDOW_STARTED=$NOW
  fi

  if [ "$RESTARTS" -ge "$MAX_RESTARTS" ]; then
    log "HWD-ZERO has failed ${RESTARTS} times in ${WINDOW_SECONDS}s — giving up."
    log "the interface stays up and reports BACKEND OFFLINE; see $ZERO_LOG"
    exit 0
  fi

  RESTARTS=$((RESTARTS + 1))
  WAIT="$(backoff_for "$RESTARTS")"
  log "HWD-ZERO is not answering — restart ${RESTARTS}/${MAX_RESTARTS}, next check in ${WAIT}s (+${GRACE_SECONDS}s grace)"
  start_backend
  # The backoff is a floor on the *next* judgement, not a sleep: the loop stays
  # responsive to the gateway disappearing.
  NEXT_CHECK_AT=$((NOW + WAIT + GRACE_SECONDS))
done
