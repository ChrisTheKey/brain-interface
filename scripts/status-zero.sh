#!/usr/bin/env bash
# Reports what is actually up right now.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

LAN_IP="$(zero_lan_ip || true)"
echo "ZERO STATUS"
echo "  host os:    $(zero_os)"
echo "  total ram:  $(zero_total_ram_mb) MB"
echo "  free ram:   $(zero_free_ram_mb) MB"
echo "  lan ip:     ${LAN_IP:-none}"
HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"
printf '  gateway:    '
if zero_http_ok "$HEALTH_URL"; then
  echo "up on http://127.0.0.1:$ZERO_UI_PORT"
else
  echo "down"
fi
printf '  hwd-zero:   '
if zero_http_ok "$ZERO_API_URL/api/health"; then echo "up on $ZERO_API_URL"; else echo "down"; fi
printf '  zero ws:    '
if zero_socket_open "$ZERO_RUNTIME_WS_URL"; then echo "up on $ZERO_RUNTIME_WS_URL"; else echo "down"; fi
printf '  via /api:   '
echo "gateway=$(zero_health_field "$HEALTH_URL" gateway) zero=$(zero_health_field "$HEALTH_URL" zero) websocket=$(zero_health_field "$HEALTH_URL" websocket)"
printf '  ollama:     '
if zero_http_ok "http://127.0.0.1:11434/api/tags"; then echo "up on 127.0.0.1:11434"; else echo "down"; fi
