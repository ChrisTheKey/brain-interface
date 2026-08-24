#!/usr/bin/env bash
# Answers one question: why is http://localhost:3000 not showing the interface?
#
# Every check reports what is actually true on this device and, when something
# is wrong, the single command that fixes it. Nothing is assumed and nothing is
# repaired here — this script only looks.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
# A diagnostic that stops at the first problem hides the rest of them. The
# shared library runs with `set -e`; the doctor deliberately does not.
set +e

FAILURES=0
NEXT=""

fail() {
  FAILURES=$((FAILURES + 1))
  # The first problem found is the one to fix first; later ones often follow
  # from it.
  if [ -z "$NEXT" ]; then NEXT="$1"; fi
  return 0
}

say() { printf '  %-12s %s\n' "$1" "$2"; }

echo "ZERO DOCTOR"
echo
echo "HOST"
say "os" "$(zero_os)"
say "arch" "$(zero_arch)"
if zero_is_termux; then
  say "prefix" "${PREFIX:-unset}"
  say "sudo" "not required (Termux needs none)"
fi
say "home" "$HOME"
say "node" "$(node -v 2>/dev/null || echo 'MISSING — pkg install nodejs-lts')"
say "npm" "$(npm -v 2>/dev/null || echo MISSING)"
command -v node >/dev/null 2>&1 || fail "pkg install nodejs-lts"

echo
echo "WORKSPACE"
WORKSPACE="$(zero_workspace_or_default)"
say "root" "$WORKSPACE"
for member in HWD-ZERO brain-interface; do
  if [ -d "$WORKSPACE/$member" ]; then
    say "$member" "present"
  else
    say "$member" "MISSING at $WORKSPACE/$member"
    [ "$member" = "HWD-ZERO" ] && fail "clone HWD-ZERO into $WORKSPACE"
  fi
done
say "interface" "$ZERO_ROOT"

echo
echo "BUILD"
if [ -d "$ZERO_ROOT/node_modules" ]; then
  say "deps" "installed"
else
  say "deps" "MISSING"
  fail "scripts/setup-termux.sh"
fi
if [ -d "$ZERO_ROOT/node_modules" ]; then
  zero_esbuild_ok && say "esbuild" "ok" || { say "esbuild" "BROKEN (native binary will not load)"; fail "scripts/setup-termux.sh"; }
  zero_rollup_ok  && say "rollup"  "ok" || { say "rollup"  "BROKEN (native binary will not load)"; fail "scripts/setup-termux.sh"; }
fi
if [ -f "$ZERO_ROOT/dist/index.html" ]; then
  say "bundle" "built ($(find "$ZERO_ROOT/dist" -type f | wc -l | tr -d ' ') files)"
else
  say "bundle" "NOT BUILT — the gateway has nothing to serve"
  fail "npm run build"
fi

echo
echo "GATEWAY"
say "port" "$ZERO_UI_PORT"
LOOPBACK="$(zero_loopback_report "$ZERO_UI_PORT")"
IPV4="${LOOPBACK%% *}"
IPV6="${LOOPBACK##* }"
if [ "$IPV4" = "ipv4" ]; then say "127.0.0.1" "listening"; else say "127.0.0.1" "not listening"; fi
if [ "$IPV6" = "ipv6" ]; then
  say "::1" "listening"
else
  # Not fatal on its own: Chrome falls back to IPv4. It is the first thing to
  # look at when the browser hangs rather than erroring, though.
  say "::1" "not listening (fine if this device has no IPv6 loopback)"
fi
if [ "$IPV4" != "ipv4" ] && [ "$IPV6" != "ipv6" ]; then
  say "status" "DOWN — nothing is listening on $ZERO_UI_PORT"
  fail "scripts/start-zero.sh"
else
  if zero_http_ok "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
    say "health" "answering"
  else
    say "health" "listening but not answering /api/gateway/health"
    fail "scripts/stop-zero.sh && scripts/start-zero.sh"
  fi
  say "browser" "http://localhost:$ZERO_UI_PORT"
fi

echo
echo "HWD-ZERO"
say "url" "$ZERO_API_URL"
if zero_http_ok "$ZERO_API_URL/api/health"; then
  say "status" "up"
else
  # The interface still renders without it; it shows the backend as offline.
  say "status" "down — start HWD-ZERO on 127.0.0.1:8000"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "VERDICT: healthy — open http://localhost:$ZERO_UI_PORT"
else
  echo "VERDICT: $FAILURES problem(s). Next: $NEXT"
  exit 1
fi
