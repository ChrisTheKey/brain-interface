#!/usr/bin/env bash
# Stops what these scripts started: the gateway, then HWD-ZERO.
#
# Note this is not the kill switch. STOP ZERO in the interface puts the operator
# into SAFE_MODE and cancels running work while staying up to be resumed; this
# ends the processes.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

stop_one() {
  local name="$1" pid_file="$ZERO_PID_DIR/$1.pid"
  if [ ! -f "$pid_file" ]; then
    echo "$name: no pid file — nothing started by these scripts"
    return
  fi
  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "$name: stopped (pid $pid)"
  else
    echo "$name: pid $pid is no longer running"
  fi
  rm -f "$pid_file"
}

stop_one gateway
stop_one hwd-zero
