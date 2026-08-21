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
  case "$pid" in
    ''|*[!0-9]*)
      # A pid file that does not hold a number is corrupt, not a target.
      echo "$name pid file was unreadable — removed, nothing killed"
      rm -f "$file"
      return
      ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "$name stopped (pid $pid)"
  else
    echo "$name pid $pid is no longer running"
  fi
  rm -f "$file"
}

# Only ever what a pid file names. No `pkill node`, no `killall python`: on a
# phone those take out whatever else the user happens to be running.
stop_pid_file gateway gateway.pid
# Only a runtime *these scripts* started; an HWD-ZERO you run yourself is never
# touched.
if [ -f "$ZERO_PID_DIR/hwd-zero.pid" ]; then
  stop_pid_file hwd-zero hwd-zero.pid
fi
