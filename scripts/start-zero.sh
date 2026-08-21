#!/usr/bin/env bash
# Starts the whole ZERO stack on this laptop, loopback only.
#
#   HWD-ZERO      127.0.0.1:8000   the operator
#   gateway       127.0.0.1:3000   the one thing you open
#
# Nothing here binds the LAN. Use start-zero-lan.sh for the phone.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

echo "ZERO STARTING"
zero_start_api

[ -d dist ] || npm run build

ZERO_LAN_MODE=false ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 1
echo
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "ZERO ONLINE"
  echo
  echo "LAPTOP:  http://127.0.0.1:$ZERO_UI_PORT"
  echo "API:     $ZERO_API_URL (loopback only)"
  echo
  echo "AGENTS:"
  zero_print_agents
  echo
  echo "STATUS:  HEALTHY"
else
  echo "STATUS: gateway did not answer" >&2
fi
wait
