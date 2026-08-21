#!/usr/bin/env bash
# Stops the gateway this machine started. Never touches ZERO's own runtime.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

stop_pid_file() {
  local name="$1" file="$ZERO_PID_DIR/$2"
  if [ ! -f "$file" ]; then
    echo "no $name pid file — nothing started by these scripts is running"
    return
  fi
  local pid
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "$name stopped (pid $pid)"
  else
    echo "$name pid $pid is no longer running"
  fi
  rm -f "$file"
}

stop_pid_file gateway gateway.pid
# Only a runtime *these scripts* started; an HWD-ZERO you run yourself is never
# touched.
[ -f "$ZERO_PID_DIR/hwd-zero.pid" ] && stop_pid_file hwd-zero hwd-zero.pid
