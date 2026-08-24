#!/usr/bin/env bash
# Starts the ZERO gateway on this device, loopback only.
#
# This is the same-device path: on a Galaxy running Termux the browser and the
# gateway are the same phone, so the gateway binds `127.0.0.1` and `::1` and
# the interface is opened at http://localhost:3000. No LAN mode, no 0.0.0.0,
# no token pairing — none of that is needed to reach a server on your own
# device, and binding wider would put the interface on the mobile network.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

# Android suspends background processes when the screen turns off; the wake
# lock keeps the runtime alive while the phone is idle. No-op elsewhere.
zero_wake_lock
cleanup() {
  zero_wake_unlock
  [ -n "${GATEWAY_PID:-}" ] && kill "$GATEWAY_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# Nothing renders without a bundle, so build one rather than serving a 503.
[ -f dist/index.html ] || zero_build

ZERO_LAN_MODE=false ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$ZERO_PID_DIR/gateway.pid"

sleep 1
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "STATUS:  HEALTHY"
  echo "OPEN:    http://localhost:$ZERO_UI_PORT"
  echo "STACK:   $(zero_loopback_report "$ZERO_UI_PORT")"
else
  echo "STATUS: gateway did not answer — run scripts/zero-doctor.sh" >&2
fi
wait "$GATEWAY_PID"
