#!/usr/bin/env bash
# One-time setup for the ZERO brain interface on this machine.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

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
  echo "  created .env.local — everything in it is presentation and voice tuning."
  echo "  There is no backend address to set: the gateway is the only origin."
fi

if zero_is_termux; then
  echo
  echo "  Termux: run \`termux-wake-lock\` so Android does not suspend the gateway."
fi

echo
echo "Next:  scripts/zero.sh          one command, laptop only"
echo "       scripts/zero.sh --lan    one command, laptop + phone"
