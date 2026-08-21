#!/usr/bin/env bash
# Starts ZERO for laptop + Samsung Galaxy: the gateway binds the LAN, every
# internal service stays on 127.0.0.1.
#
# `scripts/zero-go.sh --lan` is the canonical one-shot start and does more
# (repository and dependency checks, HWD-ZERO startup). This script stays as
# the direct "just bring the gateway up on the LAN" path.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
zero_load_env
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
  echo "  HWD-ZERO:  NOT reachable at $ZERO_API_URL (start it first; the UI will show BACKEND OFFLINE)"
fi

[ -d dist ] || npm run build

ZERO_LAN_MODE=true ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
ZERO_RUNTIME_WS_URL="$ZERO_RUNTIME_WS_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"
if ! zero_wait_http "$HEALTH_URL" 20; then
  echo "STATUS: gateway did not answer" >&2
  exit 1
fi

# Read the truth back out of the gateway rather than assuming it.
GW="$(zero_health_field "$HEALTH_URL" gateway)"
ZS="$(zero_health_field "$HEALTH_URL" zero)"
# The address is detected, now, on this machine. Never an example IP.
LAN_IP="$(zero_lan_ip || true)"

echo
if [ "$ZS" = "healthy" ]; then echo "ZERO ONLINE"; else echo "ZERO ONLINE · BACKEND OFFLINE"; fi
echo
echo "LOCAL"
echo "http://127.0.0.1:$ZERO_UI_PORT"
echo
echo "LAN"
if [ -n "$LAN_IP" ]; then
  echo "http://$LAN_IP:$ZERO_UI_PORT"
else
  echo "no LAN address detected — connect the laptop to WiFi or start its hotspot."
fi
echo
echo "ZERO API"
echo "/api"
echo
echo "EVENT STREAM"
echo "/ws"
echo
echo "HWD-ZERO"
if [ "$ZS" = "healthy" ]; then echo "HEALTHY"; else echo "OFFLINE at $ZERO_API_URL"; fi
echo
echo "GATEWAY"
echo "${GW:-unknown}"
echo
echo "The phone opens the pairing link printed by the gateway above — it carries"
echo "the token. The token is never printed here."
echo
wait
