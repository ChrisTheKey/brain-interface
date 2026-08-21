#!/usr/bin/env bash
# Shared helpers for the ZERO scripts. Detects the host, never assumes it.
set -euo pipefail

ZERO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZERO_UI_PORT="${ZERO_UI_PORT:-3000}"

# ---------------------------------------------------------------------------
# The two internal upstreams.
#
# Separate values because they are separate processes: HWD-ZERO's HTTP API and
# ZERO's runtime app-server run on different ports. Neither is ever exposed to
# the LAN, and neither is ever compiled into the browser bundle — the gateway
# is the only thing that knows them.
#
# Override in the environment (or .env.local) if your deployment differs. Do
# not guess: `scripts/zero-go.sh` prints what it actually found.
# ---------------------------------------------------------------------------
ZERO_API_URL="${ZERO_API_URL:-http://127.0.0.1:8000}"
ZERO_RUNTIME_WS_URL="${ZERO_RUNTIME_WS_URL:-ws://127.0.0.1:8787}"

# Where HWD-ZERO is checked out, if it is a sibling of this repository.
# Checked out names differ across machines (HWD-ZERO, hwd-zero, HWD_ZERO), so
# the sibling is found rather than assumed. Set ZERO_RUNTIME_DIR to override.
zero_find_runtime_dir() {
  local parent
  parent="$(cd "$ZERO_ROOT/.." && pwd)"
  for name in HWD-ZERO hwd-zero HWD_ZERO hwd_zero HWDZERO; do
    if [ -d "$parent/$name" ]; then
      echo "$parent/$name"
      return 0
    fi
  done
  # Nothing found: report the canonical name, so the error message is useful.
  echo "$parent/HWD-ZERO"
  return 1
}
ZERO_RUNTIME_DIR="${ZERO_RUNTIME_DIR:-$(zero_find_runtime_dir || true)}"

ZERO_PID_DIR="$ZERO_ROOT/.zero"
mkdir -p "$ZERO_PID_DIR"

# Load .env.local without exporting anything that is not a plain KEY=value.
zero_load_env() {
  [ -f "$ZERO_ROOT/.env.local" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      ZERO_*=*|VITE_ZERO_*=*) export "${line?}" ;;
    esac
  done < "$ZERO_ROOT/.env.local"
}

zero_os() {
  case "$(uname -s)" in
    Linux*)  echo linux ;;
    Darwin*) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

# True inside Termux, which needs a few different expectations (no systemd, a
# different prefix, and often no cargo toolchain for the runtime).
zero_is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]
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

# Is anything accepting TCP at this ws:// or http:// URL?
zero_socket_open() {
  node -e '
    const net = require("net");
    const url = new URL(process.argv[1]);
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const port = Number(url.port || (secure ? 443 : 80));
    const s = net.connect(port, url.hostname);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => { s.destroy(); process.exit(1); }, 2000);
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

# Reads one field out of the gateway's composite health payload.
# Usage: zero_health_field <url> <field>   → prints the value, or nothing.
zero_health_field() {
  node -e '
    const http = require("http");
    const req = http.get(process.argv[1], (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const value = JSON.parse(body)[process.argv[2]];
          if (value !== undefined) process.stdout.write(String(value));
        } catch { /* not JSON: print nothing rather than a guess */ }
      });
    });
    req.on("error", () => {});
    req.setTimeout(2500, () => req.destroy());
  ' "$1" "$2"
}

# Waits until the gateway answers, or gives up. Usage: zero_wait_http <url> <seconds>
zero_wait_http() {
  local url="$1" deadline=$(( $(date +%s) + ${2:-20} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if zero_http_ok "$url"; then return 0; fi
    sleep 1
  done
  return 1
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
