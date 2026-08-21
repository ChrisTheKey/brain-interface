#!/usr/bin/env bash
# Shared helpers for the ZERO scripts. Detects the host, never assumes it.
set -euo pipefail

ZERO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZERO_UI_PORT="${ZERO_UI_PORT:-3000}"
ZERO_API_URL="${ZERO_API_URL:-http://127.0.0.1:8000}"
ZERO_PID_DIR="$ZERO_ROOT/.zero"
mkdir -p "$ZERO_PID_DIR"

# Where HWD-ZERO and the agent repositories live. Detected from the usual
# workspace layout, overridable, never guessed silently — zero_require_brain
# says exactly what it looked for when it cannot find it.
ZERO_WORKSPACE="${ZERO_WORKSPACE:-$(cd "$ZERO_ROOT/.." && pwd)}"
ZERO_BRAIN_ROOT="${ZERO_BRAIN_ROOT:-$ZERO_WORKSPACE/HWD-ZERO}"
ZERO_API_PORT="${ZERO_API_PORT:-8000}"
# Termux installs the interpreter as `python`; most distributions as `python3`.
if [ -z "${ZERO_PYTHON:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then ZERO_PYTHON=python3; else ZERO_PYTHON=python; fi
fi

zero_os() {
  # Termux is Linux by uname but not by anything that matters here: no systemd,
  # no /etc, its own prefix, and an OS that kills background processes when it
  # wants memory. It gets its own answer so callers can adapt rather than
  # discover the differences one failure at a time.
  if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux/files/usr" ]; then
    echo termux
    return
  fi
  case "$(uname -s)" in
    Linux*)  echo linux ;;
    Darwin*) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

zero_is_termux() {
  [ "$(zero_os)" = termux ]
}

# Android reclaims memory from backgrounded apps, which for Termux means the
# operator is killed the moment you switch away. A wake lock is what keeps ZERO
# alive with the screen off; it costs battery, and it is released by stop-zero.
zero_wake_lock() {
  if zero_is_termux && command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock && echo "  wake lock: held (release with scripts/stop-zero.sh)"
  fi
}

zero_wake_unlock() {
  if zero_is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock && echo "wake lock: released"
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

zero_require_brain() {
  if [ ! -f "$ZERO_BRAIN_ROOT/agents/child-agents.yaml" ]; then
    echo "HWD-ZERO not found at $ZERO_BRAIN_ROOT" >&2
    echo "  Expected the operator repository beside this one:" >&2
    echo "    $ZERO_WORKSPACE/HWD-ZERO" >&2
    echo "  Set ZERO_BRAIN_ROOT=/path/to/HWD-ZERO to point elsewhere." >&2
    exit 1
  fi
  if ! command -v "$ZERO_PYTHON" >/dev/null 2>&1; then
    echo "$ZERO_PYTHON is required (>= 3.11). Set ZERO_PYTHON to your interpreter." >&2
    exit 1
  fi
}

# Starts HWD-ZERO on loopback unless it is already answering. Idempotent: a
# laptop that woke from standby with the API still alive must not get a second.
zero_start_api() {
  if zero_http_ok "$ZERO_API_URL/api/health"; then
    echo "  hwd-zero:  already up on $ZERO_API_URL"
    return 0
  fi
  zero_require_brain
  # Always 127.0.0.1: only the gateway is ever allowed to leave loopback.
  ( cd "$ZERO_BRAIN_ROOT" && \
    "$ZERO_PYTHON" -m zero serve --host 127.0.0.1 --port "$ZERO_API_PORT" \
      --workspace "$ZERO_WORKSPACE" > "$ZERO_PID_DIR/hwd-zero.log" 2>&1 & \
    echo $! > "$ZERO_PID_DIR/hwd-zero.pid" )

  local attempt=0
  while [ "$attempt" -lt 40 ]; do
    if zero_http_ok "$ZERO_API_URL/api/health"; then
      echo "  hwd-zero:  started on $ZERO_API_URL"
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  echo "  hwd-zero:  FAILED to start — see $ZERO_PID_DIR/hwd-zero.log" >&2
  return 1
}

# One line per child agent, from ZERO itself rather than from a hardcoded list.
zero_print_agents() {
  node -e '
    const http = require("http");
    http.get(process.argv[1] + "/api/agents", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          for (const a of data.agents ?? []) {
            const mark = a.health === "HEALTHY" ? "*" : " ";
            console.log(`    ${mark} ${a.id.padEnd(16)} ${a.department.padEnd(14)} ${a.health}`);
          }
          if ((data.excluded ?? []).length) {
            console.log(`    excluded: ${data.excluded.join(", ")}`);
          }
        } catch { console.log("    (agent list unavailable)"); }
      });
    }).on("error", () => console.log("    (agent list unavailable)"));
  ' "$ZERO_API_URL"
}
