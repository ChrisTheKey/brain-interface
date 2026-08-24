#!/usr/bin/env bash
# One-time setup of the ZERO brain interface inside Termux on Android.
#
# Termux is a first-class target: no sudo, no systemd, no Docker, no WSL. Every
# package comes from `pkg`, everything installs under $PREFIX and $HOME, and
# nothing here contains a device-specific path or user name.
#
# After this finishes, `scripts/start-zero.sh` serves the interface on
# http://localhost:3000 in the phone's own browser.
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

if ! zero_is_termux; then
  echo "This script is for Termux. On a laptop run scripts/setup-zero.sh instead." >&2
  exit 1
fi

WORKSPACE="$(zero_workspace_or_default)"

echo "ZERO TERMUX SETUP"
echo "  host:       $(zero_os) / $(zero_arch)"
echo "  prefix:     ${PREFIX:-unset}"
echo "  home:       $HOME"
echo "  workspace:  $WORKSPACE"
echo "  interface:  $ZERO_ROOT"
echo "  total ram:  $(zero_total_ram_mb 2>/dev/null || echo '?') MB"
echo

# --------------------------------------------------------------------------
# 1. Packages. `pkg` needs no privilege escalation — that is the whole point.
# --------------------------------------------------------------------------
echo "[1/5] packages"
if [ "${ZERO_SKIP_PKG:-}" = "true" ]; then
  echo "  skipped (ZERO_SKIP_PKG=true)"
else
  pkg install -y nodejs-lts git >/dev/null 2>&1 ||
    pkg install -y nodejs git ||
    { echo "  pkg install failed — run 'pkg update' and try again." >&2; exit 1; }
  echo "  node $(node -v 2>/dev/null || echo missing), npm $(npm -v 2>/dev/null || echo missing)"
fi
zero_require_node

# --------------------------------------------------------------------------
# 2. Dependencies.
# --------------------------------------------------------------------------
echo "[2/5] npm dependencies"
cd "$ZERO_ROOT"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# --------------------------------------------------------------------------
# 3. Native build tools.
#
# Vite's toolchain ships prebuilt binaries per platform. Termux reports
# `android`/`arm64`, and both @esbuild/android-arm64 and
# @rollup/rollup-android-arm64 exist — but npm's optional-dependency handling
# (npm/cli#4828) drops them often enough that this has to be verified rather
# than assumed. Each check has a repair that does not touch package.json, so
# the Windows and Linux setups are unaffected.
# --------------------------------------------------------------------------
echo "[3/5] native toolchain"
zero_repair_esbuild
zero_repair_rollup

# --------------------------------------------------------------------------
# 4. Configuration. The workspace is detected, never hardcoded.
# --------------------------------------------------------------------------
echo "[4/5] configuration"
if [ ! -f "$ZERO_ROOT/.env.local" ]; then
  cp "$ZERO_ROOT/.env.example" "$ZERO_ROOT/.env.local"
  echo "  created .env.local"
fi
zero_env_set VITE_ZERO_AGENT_ROOT "$WORKSPACE"
zero_env_set ZERO_UI_PORT "$ZERO_UI_PORT"
zero_env_set ZERO_API_URL "$ZERO_API_URL"
# Same-device operation: the browser and the gateway are on one phone, so the
# gateway stays on loopback and no token pairing is involved.
zero_env_set ZERO_LAN_MODE false
echo "  agent root: $WORKSPACE"

# --------------------------------------------------------------------------
# 5. Build. This is what makes the interface visible at all.
# --------------------------------------------------------------------------
echo "[5/5] build"
zero_build || {
  echo
  echo "The build failed. Run scripts/zero-doctor.sh — it reports which part" >&2
  echo "of the toolchain is broken and how to repair it." >&2
  exit 1
}

echo
echo "SETUP COMPLETE"
echo
echo "  start:   scripts/start-zero.sh"
echo "  browser: http://localhost:$ZERO_UI_PORT"
echo "  check:   scripts/zero-doctor.sh"
