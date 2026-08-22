#!/usr/bin/env bash
# Starts ZERO for laptop + Samsung Galaxy: the gateway binds the LAN, every
# internal service stays on 127.0.0.1.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

zero_preflight
zero_build_if_stale
zero_start_gateway true
zero_report_ready

LAN_IP="$(zero_lan_ip || true)"
if [ -z "$LAN_IP" ]; then
  echo "MOBILE:   no LAN address detected — connect the laptop to WiFi or start its hotspot."
fi
# The pairing URL with the token is printed by the gateway itself, so the
# token never has to be echoed twice or stored anywhere else.
wait
