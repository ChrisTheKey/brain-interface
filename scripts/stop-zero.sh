#!/usr/bin/env bash
# Stops the gateway this machine started. Never touches ZERO's own runtime.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

PID_FILE="$ZERO_PID_DIR/gateway.pid"
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "gateway stopped (pid $PID)"
  else
    echo "gateway pid $PID is no longer running"
  fi
  rm -f "$PID_FILE"
else
  echo "no gateway pid file — nothing started by these scripts is running"
fi
