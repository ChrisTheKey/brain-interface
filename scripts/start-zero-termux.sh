#!/usr/bin/env bash
# Starts ZERO on an Android phone, under Termux.
#
#     bash scripts/start-zero-termux.sh
#
# The phone becomes the host: it runs the operator and serves the interface to
# its own browser, and to anything else on the same WiFi. The network rule does
# not change because the host did — only the gateway binds beyond loopback, and
# HWD-ZERO stays on 127.0.0.1.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

if ! zero_is_termux; then
  echo "This is the Termux launcher. On a laptop use scripts/start-zero-lan.sh." >&2
  exit 1
fi

cd "$ZERO_ROOT"

echo "ZERO PREFLIGHT  (Termux)"
echo "  total ram: $(zero_total_ram_mb) MB"
echo "  free ram:  $(zero_free_ram_mb) MB"
echo "  workspace: $ZERO_WORKSPACE"
echo "  brain:     $ZERO_BRAIN_ROOT"

FREE_MB="$(zero_free_ram_mb)"
if [ "$FREE_MB" -lt 500 ]; then
  echo "  warning: under 500 MB free — close apps, Android will kill this first." >&2
fi

if [ ! -d dist ]; then
  echo "No dist/ — run scripts/setup-termux.sh first." >&2
  exit 1
fi

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

zero_wake_lock
zero_start_api || exit 1

# LAN mode so the gateway is reachable from a laptop or a second phone on the
# same network. On the phone itself 127.0.0.1 works regardless.
ZERO_LAN_MODE=true ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
  node server/gateway.mjs & echo $! > "$ZERO_PID_DIR/gateway.pid"

sleep 1
LAN_IP="$(zero_lan_ip || true)"
TOKEN_FILE="$ZERO_PID_DIR/gateway-token"

echo
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "ZERO ONLINE  — hosted on this phone"
  echo
  echo "OPEN ON THIS PHONE:"
  if [ -f "$TOKEN_FILE" ]; then
    echo "  http://127.0.0.1:$ZERO_UI_PORT/?token=$(cat "$TOKEN_FILE")"
  else
    echo "  http://127.0.0.1:$ZERO_UI_PORT"
  fi
  if [ -n "$LAN_IP" ]; then
    echo
    echo "FROM ANOTHER DEVICE ON THIS WIFI:"
    echo "  http://$LAN_IP:$ZERO_UI_PORT/?token=$(cat "$TOKEN_FILE" 2>/dev/null)"
  else
    echo
    echo "  no WiFi address — on mobile data only this phone can reach ZERO."
  fi
  echo
  echo "AGENTS:"
  zero_print_agents
  echo
  echo "STATUS:  HEALTHY"
  echo
  echo "Keep this Termux session open. Ctrl-C, or scripts/stop-zero.sh from"
  echo "another session, stops it and releases the wake lock."
else
  echo "STATUS: gateway did not answer" >&2
  zero_wake_unlock
fi
wait
