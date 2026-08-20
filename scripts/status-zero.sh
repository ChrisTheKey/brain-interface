#!/usr/bin/env bash
# Reports what is actually up right now.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

LAN_IP="$(zero_lan_ip || true)"
echo "ZERO STATUS"
echo "  host os:    $(zero_os)"
echo "  total ram:  $(zero_total_ram_mb) MB"
echo "  free ram:   $(zero_free_ram_mb) MB"
echo "  lan ip:     ${LAN_IP:-none}"
printf '  gateway:    '
if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
  echo "up on http://127.0.0.1:$ZERO_UI_PORT"
else
  echo "down"
fi
printf '  hwd-zero:   '
if zero_http_ok "$ZERO_API_URL/api/health"; then echo "up on $ZERO_API_URL"; else echo "down"; fi
printf '  ollama:     '
if zero_http_ok "http://127.0.0.1:11434/api/tags"; then echo "up on 127.0.0.1:11434"; else echo "down"; fi
