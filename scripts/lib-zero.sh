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
# `${VAR-default}` rather than `${VAR:-default}`: an explicitly empty value
# means "this deployment runs no codex app-server", which is normal on a phone
# and must not be quietly replaced by the default.
ZERO_RUNTIME_WS_URL="${ZERO_RUNTIME_WS_URL-ws://127.0.0.1:8787}"

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

# Run state and logs. Separate directories so a stale pid file is obvious and
# a log can be tailed without stumbling over the token.
ZERO_STATE_DIR="$ZERO_ROOT/.zero"
ZERO_PID_DIR="$ZERO_STATE_DIR/run"
ZERO_LOG_DIR="$ZERO_STATE_DIR/logs"
mkdir -p "$ZERO_PID_DIR" "$ZERO_LOG_DIR"

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

# The port of an http(s):// or ws(s):// URL, with the scheme's default when
# none is written. Parsed, never assumed.
zero_url_port() {
  node -e '
    const url = new URL(process.argv[1]);
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    process.stdout.write(String(url.port || (secure ? 443 : 80)));
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

# Did anything answer at all?
#
# *Any* HTTP status counts as an answer, including 503. That is not laxity:
# the gateway answers `/api/health` with 503 precisely when it is healthy and
# HWD-ZERO is not, so treating 503 as "dead" made the start script conclude the
# gateway had failed and kill it — the exact reason port 3000 disappeared.
# "Is this process serving?" and "is the whole chain healthy?" are different
# questions; this helper answers only the first.
zero_http_ok() {
  node -e '
    const http = require("http");
    const req = http.get(process.argv[1], (res) => { res.resume(); process.exit(res.statusCode ? 0 : 1); });
    req.on("error", () => process.exit(1));
    req.setTimeout(Number(process.argv[2] || 2000), () => { req.destroy(); process.exit(1); });
  ' "$1" "${2:-2000}"
}

# Is a pid file pointing at a process that is actually alive?
# Prints the pid when it is, nothing when it is not.
zero_live_pid() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

# Remove a pid file whose process is gone. A stale file must never be mistaken
# for a running service, and must never cause a kill of whatever recycled
# that pid in the meantime.
zero_clear_stale_pid() {
  local file="$1"
  if [ -f "$file" ] && ! zero_live_pid "$file" >/dev/null; then
    rm -f "$file"
    return 0
  fi
  return 1
}

# The last lines of a log, for when something failed and the reason matters.
zero_tail_log() {
  local file="$1" lines="${2:-25}"
  if [ -s "$file" ]; then
    echo "--- ${file#"$ZERO_ROOT"/} (last $lines lines) ---"
    tail -n "$lines" "$file"
    echo "--- end of log ---"
  else
    echo "(no output in ${file#"$ZERO_ROOT"/})"
  fi
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

# ---------------------------------------------------------------------------
# Ports, on a phone
#
# `OSError: [Errno 98] Address already in use` is the error the operator
# actually hits, and it has two very different causes: ZERO is already running
# (fine — use it), or something else holds the port (never something to kill
# blindly). Everything below is about telling those apart with the tools a
# Termux install actually has, which is not a fixed set: `lsof` and `ss` are
# separate packages and neither is guaranteed. /proc is always there.
# ---------------------------------------------------------------------------

# Pids listening on a TCP port. Prints one per line; prints nothing when it
# cannot tell. Never guesses, and never matches by process name.
zero_port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    # `users:(("python",pid=1234,fd=5))` — the pid is the only field wanted.
    ss -lntp 2>/dev/null | awk -v port=":$port" '
      $4 ~ port"$" { while (match($0, /pid=[0-9]+/)) {
        print substr($0, RSTART + 4, RLENGTH - 4); $0 = substr($0, RSTART + RLENGTH) } }' \
      | sort -u && return 0
  fi
  # /proc only: find the socket inode for the port, then whichever process has
  # it open. Slower, but it needs no package at all.
  local hex inode
  hex="$(printf '%04X' "$port" 2>/dev/null)" || return 0
  [ -r /proc/net/tcp ] || return 0
  for inode in $(awk -v hex=":$hex" '$4 == "0A" && $2 ~ hex"$" { print $10 }' \
      /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u); do
    local link pid
    for link in /proc/[0-9]*/fd/*; do
      [ -e "$link" ] || continue
      case "$(readlink "$link" 2>/dev/null)" in
        "socket:[$inode]")
          pid="${link#/proc/}"
          echo "${pid%%/*}"
          ;;
      esac
    done
  done | sort -u
}

# What is holding this port, in a sentence. Asks /api/health rather than
# assuming: a port that answers as HWD-ZERO is ZERO already running.
zero_port_occupant() {
  local port="$1" identity pids
  identity="$(zero_health_field "http://127.0.0.1:$port/api/health" service 2>/dev/null || true)"
  pids="$(zero_port_pids "$port" | tr '\n' ' ' | sed 's/ $//')"
  if [ "$identity" = "HWD-ZERO" ]; then
    local pid
    pid="$(zero_health_field "http://127.0.0.1:$port/api/health" pid 2>/dev/null || true)"
    echo "HWD-ZERO (pid ${pid:-${pids:-unknown}})"
  elif [ -n "$identity" ]; then
    echo "$identity (pid ${pids:-unknown})"
  elif [ -n "$pids" ]; then
    echo "an unidentified process (pid $pids)"
  else
    echo "something this shell cannot see (no lsof, no ss, no /proc entry)"
  fi
}

# Is an HWD-ZERO already serving this port? Prints its pid when it is.
#
# This is the single-instance check. Identity, not liveness: a stranger on
# port 8000 answered TCP just as convincingly as the runtime did, and starting
# a second server against it is how the EADDRINUSE crash began.
zero_zero_on_port() {
  local port="$1" service pid
  service="$(zero_health_field "http://127.0.0.1:$port/api/health" service 2>/dev/null || true)"
  [ "$service" = "HWD-ZERO" ] || return 1
  pid="$(zero_health_field "http://127.0.0.1:$port/api/health" pid 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  echo "$pid"
}

# Free a port we own, and only one we own.
#
# Refuses unless the port answers as HWD-ZERO *and* its pid matches the pid
# file this deployment wrote. Anything else is reported and left alone: a
# process ZERO did not start is never ZERO's to kill.
zero_release_port() {
  local port="$1" pid_file="${2:-}" running recorded
  running="$(zero_zero_on_port "$port" || true)"
  if [ -z "$running" ]; then
    echo "port $port is held by $(zero_port_occupant "$port") — not touching it"
    return 1
  fi
  recorded="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid_file" ] && [ "$recorded" != "$running" ]; then
    echo "HWD-ZERO on port $port (pid $running) was not started from $pid_file — not touching it"
    return 1
  fi
  kill "$running" 2>/dev/null || true
  local waited=0
  while kill -0 "$running" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -0 "$running" 2>/dev/null && kill -9 "$running" 2>/dev/null || true
  rm -f "$pid_file"
  echo "released port $port (pid $running)"
}

# Termux puts pip's console scripts in ~/.local/bin and does not put that on
# PATH. whisper-cli built by the one-shot lands there too. Adding it here means
# every ZERO script and every process they start can find both.
zero_extend_path() {
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH" ;;
  esac
  export PATH
}
zero_extend_path

# Child processes write their own logs into the same place the scripts do.
export ZERO_LOG_DIR
