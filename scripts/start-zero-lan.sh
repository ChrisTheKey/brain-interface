#!/usr/bin/env bash
# Starts ZERO for the laptop and the Samsung Galaxy.
#
# The gateway binds 0.0.0.0:3000 and requires a token. Every internal service —
# HWD-ZERO, Ollama, every child agent — stays on 127.0.0.1. No tunnel, no UPnP,
# no port forwarding: LAN is as far as this goes.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

echo "ZERO PREFLIGHT"
echo "  host os:   $(zero_os)"
echo "  total ram: $(zero_total_ram_mb) MB"
echo "  free ram:  $(zero_free_ram_mb) MB"
echo "  workspace: $ZERO_WORKSPACE"
echo "  brain:     $ZERO_BRAIN_ROOT"

FREE_MB="$(zero_free_ram_mb)"
if [ "$FREE_MB" -lt 700 ]; then
  echo "  warning: less than 700 MB free — close apps before running local AI." >&2
fi

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

zero_start_api

[ -d dist ] || npm run build

ZERO_LAN_MODE=true ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 1
# The address is read from this machine now, not remembered from last time: the
# laptop moves between WiFi networks and its own hotspot.
LAN_IP="$(zero_lan_ip || true)"
TOKEN_FILE="$ZERO_PID_DIR/gateway-token"

echo
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "ZERO ONLINE"
  echo
  echo "LAPTOP:  http://127.0.0.1:$ZERO_UI_PORT"
  if [ -n "$LAN_IP" ]; then
    if [ -f "$TOKEN_FILE" ]; then
      echo "GALAXY:  http://$LAN_IP:$ZERO_UI_PORT/?token=$(cat "$TOKEN_FILE")"
    else
      echo "GALAXY:  http://$LAN_IP:$ZERO_UI_PORT"
    fi
  else
    echo "GALAXY:  no LAN address — connect to WiFi or start the laptop hotspot."
  fi
  echo "API:     $ZERO_API_URL (loopback only, not reachable from the phone)"
  echo
  echo "AGENTS:"
  zero_print_agents
  echo
  echo "STATUS:  HEALTHY"
else
  echo "STATUS: gateway did not answer" >&2
fi
wait
