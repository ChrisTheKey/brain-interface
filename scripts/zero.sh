#!/usr/bin/env bash
# ZERO, in one command.
#
#   scripts/zero.sh          laptop only  (gateway on 127.0.0.1:3000)
#   scripts/zero.sh --lan    laptop + phone (gateway on 0.0.0.0:3000, token required)
#
# Installs what is missing, builds what is stale, starts the gateway, waits
# until it actually answers, and shuts it down cleanly on Ctrl-C.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
zero_require_node
cd "$ZERO_ROOT"

LAN_MODE=false
for arg in "$@"; do
  case "$arg" in
    --lan) LAN_MODE=true ;;
    --help|-h)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if zero_port_busy "$ZERO_UI_PORT"; then
  echo "Port $ZERO_UI_PORT is already in use. Stop it first: scripts/stop-zero.sh" >&2
  exit 1
fi

[ -d node_modules ] || npm install

zero_preflight
zero_build_if_stale
zero_start_gateway "$LAN_MODE"

GATEWAY_PID="$(cat "$ZERO_PID_DIR/gateway.pid")"
shutdown() {
  echo
  echo "stopping the gateway…"
  kill "$GATEWAY_PID" 2>/dev/null || true
  rm -f "$ZERO_PID_DIR/gateway.pid"
}
trap shutdown INT TERM EXIT

zero_report_ready || true
if zero_is_termux; then
  echo "TERMUX:   keep this session awake with \`termux-wake-lock\`."
fi
echo "Ctrl-C stops the gateway. HWD-ZERO is not started or stopped by this script."
wait "$GATEWAY_PID"
