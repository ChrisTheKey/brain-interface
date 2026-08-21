#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# zero-doctor — what is actually wrong, in one screen.
#
# Every check prints PASS, WARN or FAIL and, when it is not PASS, the exact
# command that fixes it. Nothing here starts, stops or repairs anything: a
# diagnostic that changes the system cannot be run while diagnosing one.
#
# WARN means degraded but usable — no whisper model means voice is off, and
# ZERO still runs. FAIL means the interface will not come up. The exit code is
# non-zero only for FAIL, so this is safe to run from another script.
# ---------------------------------------------------------------------------
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
# Every check here is allowed to fail; that is the point of running them.
set +e

FAILURES=0
WARNINGS=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
hint() { printf '        %s\n' "$1"; }
group() { printf '\n\033[1m%s\033[0m\n' "$1"; }

GATEWAY_PID_FILE="$ZERO_PID_DIR/gateway.pid"
ZERO_PID_FILE="$ZERO_PID_DIR/hwd-zero.pid"
SUPERVISOR_PID_FILE="$ZERO_PID_DIR/supervisor.pid"
HEALTH_URL="http://127.0.0.1:$ZERO_UI_PORT/api/health"
ZERO_API_PORT="$(zero_url_port "$ZERO_API_URL" 2>/dev/null || echo 8000)"

printf '\n\033[1mZERO DOCTOR\033[0m  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '  root      %s\n' "$ZERO_ROOT"
printf '  runtime   %s\n' "${ZERO_RUNTIME_DIR:-(not found)}"
printf '  host      %s%s\n' "$(zero_os)" "$(zero_is_termux && echo ' (termux)' || true)"

# --------------------------------------------------------------- toolchain

group "TOOLCHAIN"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    pass "node $(node -v)"
  else
    fail "node $(node -v) is too old — the interface needs >= 20.19"
    hint "pkg install nodejs"
  fi
else
  fail "node is missing"
  hint "pkg install nodejs"
fi

PYTHON_BIN=""
for candidate in python3 python; do
  command -v "$candidate" >/dev/null 2>&1 && { PYTHON_BIN="$candidate"; break; }
done
if [ -n "$PYTHON_BIN" ]; then
  pass "python $($PYTHON_BIN -V 2>&1 | awk '{print $2}') ($PYTHON_BIN)"
else
  fail "python is missing — HWD-ZERO cannot run"
  hint "pkg install python"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) pass "\$HOME/.local/bin is on PATH" ;;
  *) warn "\$HOME/.local/bin is not on PATH — pip scripts and whisper-cli will not be found"
     hint 'echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.bashrc' ;;
esac

if [ -n "$ZERO_RUNTIME_DIR" ] && [ -d "$ZERO_RUNTIME_DIR/zero" ]; then
  pass "HWD-ZERO checked out at $ZERO_RUNTIME_DIR"
  if [ -n "$PYTHON_BIN" ] && (cd "$ZERO_RUNTIME_DIR" && "$PYTHON_BIN" -c 'import zero.server' 2>/dev/null); then
    pass "python -m zero.server is importable"
  else
    fail "zero.server cannot be imported"
    hint "cd $ZERO_RUNTIME_DIR && pip install -e ."
  fi
else
  fail "HWD-ZERO is not checked out next to this repository"
  hint "git clone https://github.com/ChrisTheKey/HWD-ZERO \"${ZERO_RUNTIME_DIR:-../HWD-ZERO}\""
fi

# ------------------------------------------------------------------- ports

group "PORTS"
for entry in "interface:$ZERO_UI_PORT:$GATEWAY_PID_FILE" "hwd-zero:$ZERO_API_PORT:$ZERO_PID_FILE"; do
  NAME="${entry%%:*}"; REST="${entry#*:}"; PORT="${REST%%:*}"; PID_FILE="${REST#*:}"
  if zero_port_busy "$PORT"; then
    OCCUPANT="$(zero_port_occupant "$PORT")"
    RECORDED="$(cat "$PID_FILE" 2>/dev/null || true)"
    case "$OCCUPANT" in
      HWD-ZERO*|*"$RECORDED"*) pass "$NAME port $PORT — $OCCUPANT" ;;
      *) warn "$NAME port $PORT is held by $OCCUPANT"
         hint "ZERO will not kill a process it does not own; free it or change the port" ;;
    esac
  else
    pass "$NAME port $PORT is free"
  fi
done

# --------------------------------------------------------------- run state

group "RUN STATE"
for entry in "gateway:$GATEWAY_PID_FILE" "hwd-zero:$ZERO_PID_FILE" "supervisor:$SUPERVISOR_PID_FILE"; do
  NAME="${entry%%:*}"; FILE="${entry#*:}"
  if PID="$(zero_live_pid "$FILE")"; then
    pass "$NAME running (pid $PID)"
  elif [ -f "$FILE" ]; then
    warn "$NAME pid file is stale — the process is gone"
    hint "bash scripts/start-zero-termux.sh --stop"
  else
    warn "$NAME is not running"
  fi
done

# ----------------------------------------------------------------- serving

group "SERVING"
if zero_http_ok "$HEALTH_URL"; then
  pass "gateway answers $HEALTH_URL"
  GW="$(zero_health_field "$HEALTH_URL" gateway)"
  ZS="$(zero_health_field "$HEALTH_URL" zero)"
  [ "$GW" = "healthy" ] && pass "gateway    healthy" || warn "gateway    ${GW:-unknown}"
  [ "$ZS" = "healthy" ] && pass "hwd-zero   healthy" || warn "hwd-zero   ${ZS:-offline} — the interface stays up and reports BACKEND OFFLINE"
else
  fail "nothing is serving http://127.0.0.1:$ZERO_UI_PORT"
  hint "bash scripts/start-zero-termux.sh"
fi

RUNTIME_HEALTH="$ZERO_API_URL/api/health"
if SERVICE="$(zero_health_field "$RUNTIME_HEALTH" service)" && [ "$SERVICE" = "HWD-ZERO" ]; then
  pass "HWD-ZERO identifies itself: pid $(zero_health_field "$RUNTIME_HEALTH" pid), version $(zero_health_field "$RUNTIME_HEALTH" version)"
  READY="$(zero_health_field "$RUNTIME_HEALTH" runtime_ready)"
  [ "$READY" = "true" ] && pass "ZeroSession runtime is ready" || warn "ZeroSession runtime is not ready yet"
else
  warn "HWD-ZERO is not answering on $ZERO_API_URL"
  hint "see .zero/logs/hwd-zero.log"
fi

# ------------------------------------------------------------------- voice

group "VOICE"
VOICE_URL="http://127.0.0.1:$ZERO_UI_PORT/api/voice/status"
VOICE_STATE="$(zero_health_field "$VOICE_URL" voice)"
case "$VOICE_STATE" in
  ready) pass "voice is ready end to end" ;;
  degraded) warn "voice is degraded — ZERO runs, speech input does not" ;;
  *) warn "the voice endpoint did not answer (is HWD-ZERO up?)" ;;
esac

WHISPER_BIN=""
for candidate in "${ZERO_WHISPER_BIN:-}" \
    "$HOME/.local/bin/whisper-cli" "$HOME/whisper.cpp/build/bin/whisper-cli" \
    "$HOME/whisper.cpp/build/bin/main" "$(command -v whisper-cli 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { WHISPER_BIN="$candidate"; break; }
done
if [ -n "$WHISPER_BIN" ]; then
  # Present is not the same as working: a build for the wrong ABI passes every
  # `test -x` and fails the moment audio arrives.
  if "$WHISPER_BIN" --help 2>&1 | grep -qi 'usage\|whisper'; then
    pass "whisper.cpp runs: $WHISPER_BIN"
  else
    fail "whisper.cpp is present but does not run: $WHISPER_BIN"
    hint "rebuild it: cd ~/whisper.cpp && cmake -B build && cmake --build build -j2"
  fi
else
  warn "no whisper.cpp binary found — voice input is unavailable"
  hint "bash scripts/zero-termux-one-shot.sh   (builds it with -j2)"
fi

WHISPER_MODEL=""
for candidate in "${ZERO_WHISPER_MODEL:-}" \
    "$HOME/.cache/whisper.cpp/ggml-tiny.bin" "$HOME/.local/share/whisper.cpp/ggml-tiny.bin" \
    "$HOME/whisper.cpp/models/ggml-tiny.bin"; do
  [ -n "$candidate" ] && [ -f "$candidate" ] && { WHISPER_MODEL="$candidate"; break; }
done
if [ -n "$WHISPER_MODEL" ]; then
  SIZE_MB=$(( $(wc -c <"$WHISPER_MODEL") / 1048576 ))
  if [ "$SIZE_MB" -ge 20 ]; then
    pass "whisper model: $WHISPER_MODEL (${SIZE_MB} MB)"
  else
    fail "whisper model is only ${SIZE_MB} MB — a truncated download or an HTML error page"
    hint "rm $WHISPER_MODEL && bash scripts/zero-termux-one-shot.sh"
  fi
else
  warn "no whisper model found — voice input is unavailable"
  hint "bash scripts/zero-termux-one-shot.sh   (downloads ggml-tiny.bin, ~75 MB)"
fi

# ------------------------------------------------------------------- state

group "STATE"
for dir in "$ZERO_PID_DIR" "$ZERO_LOG_DIR"; do
  if [ -w "$dir" ]; then
    pass "writable: ${dir#"$ZERO_ROOT"/}"
  else
    fail "not writable: $dir"
    hint "termux-setup-storage, or check the filesystem"
  fi
done
[ -s "$ZERO_LOG_DIR/voice.log" ] && pass "voice log: .zero/logs/voice.log ($(wc -l <"$ZERO_LOG_DIR/voice.log") lines)" \
  || warn "no voice log yet — nothing has been spoken since the last start"

if zero_is_termux; then
  command -v termux-wake-lock >/dev/null 2>&1 \
    && pass "termux-wake-lock is available (keeps ZERO alive with the screen off)" \
    || warn "termux-wake-lock is missing — Android may suspend ZERO with the screen off
        pkg install termux-api"
fi

# ------------------------------------------------------------------ verdict

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%s FAIL, %s WARN\033[0m — fix the FAILs above, then re-run.\n' "$FAILURES" "$WARNINGS"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  printf '\033[33m0 FAIL, %s WARN\033[0m — ZERO runs; the warnings are degraded capabilities.\n' "$WARNINGS"
  exit 0
fi
printf '\033[32mall checks pass\033[0m\n'
