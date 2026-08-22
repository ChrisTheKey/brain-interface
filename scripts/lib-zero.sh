#!/usr/bin/env bash
# Shared helpers for the ZERO scripts. Detects the host, never assumes it.
# Pure POSIX tools plus node — so the same scripts run on the laptop and
# under Termux on the phone.
set -euo pipefail

ZERO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZERO_UI_PORT="${ZERO_UI_PORT:-3000}"
ZERO_API_URL="${ZERO_API_URL:-http://127.0.0.1:8000}"
ZERO_PID_DIR="$ZERO_ROOT/.zero"
mkdir -p "$ZERO_PID_DIR"

zero_is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || case "${PREFIX:-}" in *com.termux*) return 0 ;; esac
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

zero_http_ok() {
  node -e '
    const http = require("http");
    const req = http.get(process.argv[1], (res) => { res.resume(); process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1); });
    req.on("error", () => process.exit(1));
    req.setTimeout(2000, () => { req.destroy(); process.exit(1); });
  ' "$1"
}

# Waits until a URL answers, or gives up. Beats `sleep 1` and a guess.
zero_wait_http() {
  local url="$1" attempts="${2:-25}"
  local i=0
  while [ "$i" -lt "$attempts" ]; do
    if zero_http_ok "$url"; then return 0; fi
    sleep 0.4
    i=$((i + 1))
  done
  return 1
}

zero_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required (>= 20.19). Install it, then re-run." >&2
    if zero_is_termux; then echo "  Termux:  pkg install nodejs-lts" >&2; fi
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    echo "node $(node -v) is too old — ZERO's interface needs >= 20.19." >&2
    exit 1
  fi
}

# Builds only when the build is missing or older than the sources.
zero_build_if_stale() {
  cd "$ZERO_ROOT"
  if [ ! -f dist/index.html ]; then
    echo "  build:     missing — building the interface"
    npm run build
    return
  fi
  local newest
  newest="$(find src public index.html package.json vite.config.ts -newer dist/index.html -print -quit 2>/dev/null || true)"
  if [ -n "$newest" ]; then
    echo "  build:     stale ($newest changed) — rebuilding"
    npm run build
  else
    echo "  build:     up to date"
  fi
}

zero_preflight() {
  echo "ZERO PREFLIGHT"
  echo "  host os:   $(zero_os)"
  echo "  node:      $(node -v 2>/dev/null || echo missing)"
  echo "  total ram: $(zero_total_ram_mb) MB"
  echo "  free ram:  $(zero_free_ram_mb) MB"
  local free_mb
  free_mb="$(zero_free_ram_mb)"
  if [ "$free_mb" -lt 700 ]; then
    echo "  warning:   less than 700 MB free — close apps before running local AI." >&2
  fi
  if zero_http_ok "$ZERO_API_URL/api/health"; then
    echo "  hwd-zero:  reachable at $ZERO_API_URL"
  else
    echo "  hwd-zero:  NOT reachable at $ZERO_API_URL"
    echo "             The gateway starts anyway; the brain will say the operator is offline."
  fi
}

# Starts the gateway in the background and records its pid.
zero_start_gateway() {
  local lan_mode="$1"
  cd "$ZERO_ROOT"
  ZERO_LAN_MODE="$lan_mode" ZERO_UI_PORT="$ZERO_UI_PORT" ZERO_API_URL="$ZERO_API_URL" \
    node server/gateway.mjs &
  echo $! > "$ZERO_PID_DIR/gateway.pid"
}

zero_report_ready() {
  if zero_wait_http "http://127.0.0.1:$ZERO_UI_PORT/api/gateway/health"; then
    echo "STATUS:   HEALTHY"
    echo "LOCAL:    http://127.0.0.1:$ZERO_UI_PORT"
    return 0
  fi
  echo "STATUS:   gateway did not answer on port $ZERO_UI_PORT" >&2
  return 1
}
