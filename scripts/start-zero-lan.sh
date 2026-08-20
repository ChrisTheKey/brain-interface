#!/usr/bin/env bash
# Starts ZERO for laptop + Samsung Galaxy: the gateway binds the LAN, every
# internal service stays on 127.0.0.1.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

echo "ZERO PREFLIGHT"
echo "  host os:   $(zero_os)"
echo "  total ram: $(zero_total_ram_mb) MB"
echo "  free ram:  $(zero_free_ram_mb) MB"

FREE_MB="$(zero_free_ram_mb)"
if [ "$FREE_MB" -lt 700 ]; then
  echo "  warning: less than 700 MB free — close apps before running local AI." >&2
fi

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

if zero_http_ok "$ZERO_API_URL/api/health"; then
  echo "  HWD-ZERO:  reachable at $ZERO_API_URL"
else
  echo "  HWD-ZERO:  NOT reachable at $ZERO_API_URL (start it first; the UI will show the error)"
fi

[ -d dist ] || npm run build

ZERO_LAN_MODE=true ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 1
LAN_IP="$(zero_lan_ip || true)"
echo
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "STATUS: HEALTHY"
else
  echo "STATUS: gateway did not answer" >&2
fi
if [ -z "$LAN_IP" ]; then
  echo "MOBILE: no LAN address detected — connect the laptop to WiFi or start its hotspot."
fi
wait
