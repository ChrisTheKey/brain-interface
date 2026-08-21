#!/usr/bin/env bash
# One-time setup for running ZERO on an Android phone under Termux.
#
#   pkg install git && git clone … && bash scripts/setup-termux.sh
#
# This installs what Termux needs and then says plainly what will and will not
# work on a phone. It does not pretend the phone is a laptop.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

if ! zero_is_termux; then
  echo "This script is for Termux on Android. On a laptop run scripts/setup-zero.sh." >&2
  exit 1
fi

echo "ZERO — TERMUX SETUP"
echo "  prefix:    ${PREFIX:-unknown}"
echo "  workspace: $ZERO_WORKSPACE"
echo

# ---------------------------------------------------------------- packages
echo "[1/5] packages"
# nodejs-lts is the safer pick when it exists; vite needs >= 20.19.
pkg install -y git python nodejs-lts termux-tools 2>/dev/null \
  || pkg install -y git python nodejs termux-tools
echo "  node:   $(node -v 2>/dev/null || echo MISSING)"
echo "  python: $($ZERO_PYTHON --version 2>/dev/null || echo MISSING)"

# ------------------------------------------------------------------- brain
echo
echo "[2/5] HWD-ZERO"
if [ ! -f "$ZERO_BRAIN_ROOT/agents/child-agents.yaml" ]; then
  echo "  not found at $ZERO_BRAIN_ROOT" >&2
  echo "  clone it beside this repository:" >&2
  echo "    cd $ZERO_WORKSPACE && git clone -b $(git -C "$ZERO_ROOT" rev-parse --abbrev-ref HEAD) \\" >&2
  echo "      https://github.com/ChrisTheKey/HWD-ZERO.git" >&2
  exit 1
fi
# The operator's only runtime dependency is PyYAML — deliberately, and it is
# what makes running it on a phone reasonable at all.
$ZERO_PYTHON -m pip install --upgrade pip >/dev/null 2>&1
$ZERO_PYTHON -m pip install "PyYAML>=6.0" || {
  echo "  pip failed — try: pkg install python-pip" >&2
  exit 1
}
echo "  operator dependencies: PyYAML only"

# -------------------------------------------------------------- interface
echo
echo "[3/5] interface dependencies"
cd "$ZERO_ROOT"
# --omit=dev skips Playwright, TypeScript and the test stack. The phone runs the
# built bundle; it does not need the toolchain that produced it.
npm install --omit=dev --no-audit --no-fund || {
  echo "  npm install failed. Most often this is a native binary for android-arm64;" >&2
  echo "  try: npm cache clean --force && npm install --omit=dev" >&2
  exit 1
}

echo
echo "[4/5] building the interface"
# The build itself needs the dev toolchain, so install it, build, and keep it —
# rebuilding after every git pull is the normal case.
npm install --no-audit --no-fund >/dev/null 2>&1
if npm run build; then
  echo "  built into dist/"
else
  echo "  BUILD FAILED — see above." >&2
  echo "  If esbuild or rollup could not load a native binary, the usual fix is:" >&2
  echo "    rm -rf node_modules package-lock.json && npm install" >&2
  echo "  Or build dist/ on the laptop and copy it over; the gateway only serves it." >&2
  exit 1
fi

# ------------------------------------------------------------------ agents
echo
echo "[5/5] child agents"
found=0
for dir in "$ZERO_WORKSPACE"/*/; do
  [ -f "$dir/agent.yaml" ] || continue
  found=$((found + 1))
  echo "  $(basename "$dir")"
done
[ "$found" -eq 0 ] && echo "  none present — ZERO will report them OFFLINE, which is honest"

cat <<'NOTE'

WHAT WORKS ON A PHONE
  the operator, the gateway, the 3D brain, missions, permission gates,
  the kill switch, the audit trail, and browser speech in and out.

WHAT DOES NOT
  Postgres, Redis and Celery are not packaged for Termux, so an agent action
  that needs a database reports `unavailable` rather than inventing a result.
  Ollama has no Termux build either: ZERO reports LOCAL MODEL OFFLINE and keeps
  running on its deterministic planner.

  Android will kill background processes when it wants memory. start-zero-termux
  takes a wake lock, but leaving Termux for a long time can still end the run.

NEXT
  bash scripts/start-zero-termux.sh
NOTE
