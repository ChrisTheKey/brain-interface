#!/usr/bin/env bash
# Shared helpers for the ZERO scripts. Detects the host, never assumes it.
set -euo pipefail

ZERO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZERO_UI_PORT="${ZERO_UI_PORT:-3000}"
ZERO_API_URL="${ZERO_API_URL:-http://127.0.0.1:8000}"
ZERO_PID_DIR="$ZERO_ROOT/.zero"
mkdir -p "$ZERO_PID_DIR"

# True on Termux. Detected from $PREFIX, never from a user name or a fixed
# path, so the same script works on every Android device.
zero_is_termux() {
  case "${PREFIX:-}" in
    *com.termux*) return 0 ;;
  esac
  [ -n "${TERMUX_VERSION:-}" ]
}

zero_os() {
  if zero_is_termux; then echo termux; return; fi
  case "$(uname -s)" in
    Linux*)  echo linux ;;
    Darwin*) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

zero_arch() { uname -m; }

# The directory that holds HWD-ZERO and brain-interface. Detected by walking up
# from this checkout, then falling back to the canonical $HOME/ZERO-WORKSPACE.
# Prints nothing when neither exists.
zero_workspace() {
  if [ -n "${ZERO_WORKSPACE:-}" ] && [ -d "$ZERO_WORKSPACE/HWD-ZERO" ]; then
    echo "$ZERO_WORKSPACE"; return 0
  fi
  local dir="$ZERO_ROOT"
  while :; do
    if [ -d "$dir/HWD-ZERO" ] && [ -d "$dir/brain-interface" ]; then
      echo "$dir"; return 0
    fi
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done
  if [ -d "$HOME/ZERO-WORKSPACE" ]; then echo "$HOME/ZERO-WORKSPACE"; fi
}

# The canonical workspace path, whether or not it exists yet.
zero_workspace_or_default() {
  local found; found="$(zero_workspace)"
  echo "${found:-$HOME/ZERO-WORKSPACE}"
}

# Keeps Android from suspending the runtime when the screen turns off.
# A no-op off Termux and when termux-api is not installed.
zero_wake_lock() {
  if zero_is_termux && command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock || true
  fi
}

zero_wake_unlock() {
  if zero_is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock || true
  fi
}

# Real LAN address of this machine. Prints nothing when there is no network.
zero_lan_ip() {
  node -e '
    const os = require("os");
    const list = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const e of entries ?? []) {
        if ((e.family === "IPv4" || e.family === 4) && !e.internal) list.push(e.address);
      }
    }
    const priv = list.filter((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    const pick = priv[0] ?? list[0];
    if (pick) process.stdout.write(pick);
  '
}

zero_total_ram_mb() {
  node -e 'process.stdout.write(String(Math.round(require("os").totalmem()/1048576)))'
}

zero_free_ram_mb() {
  node -e 'process.stdout.write(String(Math.round(require("os").freemem()/1048576)))'
}

zero_port_busy() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => { s.destroy(); process.exit(1); }, 1500);
  ' "$1"
}

# Which loopback families actually answer on a port. Android browsers resolve
# `localhost` to ::1 first, so "IPv4 only" is the difference between the
# interface appearing and a blank page.
zero_loopback_report() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const probe = (host) => new Promise((resolve) => {
      const s = net.connect({ port, host });
      const done = (ok) => { s.destroy(); resolve(ok); };
      s.on("connect", () => done(true));
      s.on("error", () => done(false));
      setTimeout(() => done(false), 1500);
    });
    Promise.all([probe("127.0.0.1"), probe("::1")]).then(([v4, v6]) => {
      process.stdout.write(`${v4 ? "ipv4" : "-"} ${v6 ? "ipv6" : "-"}`);
    });
  ' "$1"
}

zero_http_ok() {
  node -e '
    const http = require("http");
    const req = http.get(process.argv[1], (res) => { process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1); });
    req.on("error", () => process.exit(1));
    req.setTimeout(2000, () => { req.destroy(); process.exit(1); });
  ' "$1"
}

zero_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required (>= 20.19). Install it, then re-run." >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    echo "node $(node -v) is too old — ZERO's interface needs >= 20.19." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Build toolchain
#
# Vite compiles through esbuild and bundles through rollup; both load a native
# binary chosen by platform. On Termux that is the `android-arm64` build, which
# exists but is not always installed (npm/cli#4828). Every repair below is
# scoped to node_modules — package.json and package-lock.json stay untouched,
# so a Windows or Linux checkout of the same repository is never affected.
# ---------------------------------------------------------------------------

zero_esbuild_ok() {
  (cd "$ZERO_ROOT" && node -e 'require("esbuild").transformSync("const a=1")' >/dev/null 2>&1)
}

zero_rollup_ok() {
  (cd "$ZERO_ROOT" && node -e 'require("rollup")' >/dev/null 2>&1)
}

# Falls back to Termux's own esbuild package, which esbuild's JS wrapper will
# use when ESBUILD_BINARY_PATH points at it.
zero_repair_esbuild() {
  if zero_esbuild_ok; then
    echo "  esbuild:    ok"
    return 0
  fi
  echo "  esbuild:    native binary unusable — installing Termux's build"
  if zero_is_termux; then
    pkg install -y esbuild >/dev/null 2>&1 || true
  fi
  local binary
  binary="$(command -v esbuild || true)"
  if [ -n "$binary" ]; then
    zero_env_set ESBUILD_BINARY_PATH "$binary"
    export ESBUILD_BINARY_PATH="$binary"
  fi
  if zero_esbuild_ok; then
    echo "  esbuild:    repaired (${binary:-bundled})"
    return 0
  fi
  echo "  esbuild:    STILL BROKEN — see scripts/zero-doctor.sh" >&2
  return 1
}

# Rollup publishes a WebAssembly build that runs anywhere. It is slower than the
# native one, which is why it is only installed when the native one fails.
zero_repair_rollup() {
  if zero_rollup_ok; then
    echo "  rollup:     ok"
    return 0
  fi
  echo "  rollup:     native binary unusable — switching to the WASM build"
  (cd "$ZERO_ROOT" && npm install --no-save --no-audit --no-fund "rollup@npm:@rollup/wasm-node@^4" >/dev/null 2>&1) || true
  if zero_rollup_ok; then
    echo "  rollup:     repaired (@rollup/wasm-node)"
    return 0
  fi
  echo "  rollup:     STILL BROKEN — see scripts/zero-doctor.sh" >&2
  return 1
}

# Builds the interface. On a phone the default V8 heap is generous enough, but
# the ceiling is configurable for devices with less headroom.
zero_build() {
  local heap="${ZERO_BUILD_HEAP_MB:-2048}"
  (cd "$ZERO_ROOT" && NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$heap" npm run build)
}

# ---------------------------------------------------------------------------
# .env.local
# ---------------------------------------------------------------------------

# Sets KEY=VALUE in .env.local, replacing any existing definition. Nothing else
# in the file is reordered or rewritten.
zero_env_set() {
  local key="$1" value="$2" file="$ZERO_ROOT/.env.local"
  [ -f "$file" ] || touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    node -e '
      const fs = require("fs");
      const [file, key, value] = process.argv.slice(1);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      fs.writeFileSync(file, lines.map((l) => (l.startsWith(key + "=") ? key + "=" + value : l)).join("\n"));
    ' "$file" "$key" "$value"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
