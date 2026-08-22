#!/usr/bin/env bash
# Starts the ZERO gateway on this machine, loopback only.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

zero_preflight
zero_build_if_stale
zero_start_gateway false
zero_report_ready
wait
