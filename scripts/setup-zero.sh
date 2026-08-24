#!/usr/bin/env bash
# One-time setup for the ZERO brain interface on this machine.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

# Termux needs a different install path (pkg instead of a system package
# manager, and a toolchain check that desktop platforms never need).
if zero_is_termux; then
  exec "$(dirname "${BASH_SOURCE[0]}")/setup-termux.sh" "$@"
fi

echo "ZERO SETUP"
echo "  host os:   $(zero_os)"
echo "  node:      $(node -v 2>/dev/null || echo missing)"
echo "  total ram: $(zero_total_ram_mb) MB"
echo "  free ram:  $(zero_free_ram_mb) MB"
zero_require_node

cd "$ZERO_ROOT"
npm install
npm run build

if [ ! -f "$ZERO_ROOT/.env.local" ]; then
  cp "$ZERO_ROOT/.env.example" "$ZERO_ROOT/.env.local"
  echo "  created .env.local — set VITE_ZERO_AGENT_ROOT to your ZERO-WORKSPACE."
fi

echo
echo "Next: scripts/start-zero.sh   (this device only)"
echo "      scripts/start-zero-lan.sh (this device + phone over WiFi)"
echo "      scripts/zero-doctor.sh    (why is localhost:$ZERO_UI_PORT not showing?)"
