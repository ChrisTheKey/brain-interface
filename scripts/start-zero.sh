#!/usr/bin/env bash
# Starts the ZERO gateway on the laptop, loopback only.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

[ -d dist ] || npm run build

ZERO_LAN_MODE=false ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 1
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "STATUS: HEALTHY"
else
  echo "STATUS: gateway did not answer" >&2
fi
wait
