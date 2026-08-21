#!/usr/bin/env bash
# Starts the ZERO gateway on the laptop, loopback only.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
zero_load_env
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

[ -d dist ] || npm run build

ZERO_LAN_MODE=false ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
ZERO_RUNTIME_WS_URL="$ZERO_RUNTIME_WS_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"
if zero_wait_http "$HEALTH_URL" 20; then
  # Three separate facts, so "the gateway is up" is never mistaken for
  # "ZERO is up".
  echo "GATEWAY:   $(zero_health_field "$HEALTH_URL" gateway)"
  echo "HWD-ZERO:  $(zero_health_field "$HEALTH_URL" zero)"
  echo "WEBSOCKET: $(zero_health_field "$HEALTH_URL" websocket)"
else
  echo "STATUS: gateway did not answer" >&2
fi
wait
