#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ZERO — one command, from a fresh Termux to a speaking runtime.
#
#   bash scripts/zero-termux-one-shot.sh
#
# What it does, in order: check the host, install the Termux packages ZERO
# needs, make sure HWD-ZERO is checked out and importable, build whisper.cpp
# and fetch a model, take a wake lock, and start the gateway and the runtime.
#
# What it refuses to do:
#
#   - Nothing outside Termux's own prefix and $HOME. No global Android change,
#     no root, no system service.
#   - No global process kills. `pkill node`, `killall python` and their kin
#     would take down whatever else the phone is running; every process this
#     script stops, it started, and it stops it by pid file.
#   - No model accepted on faith. A truncated download and an HTML error page
#     both arrive with exit code 0; the size is checked and the file is
#     deleted rather than half-installed.
#   - `-j2` and no more when building. A phone that compiles on every core
#     throttles, and on 4 GB it runs out of memory instead of finishing.
#
# Safe to re-run: every step checks before it acts.
# ---------------------------------------------------------------------------
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"
# A bootstrap reports what failed and carries on with what it can. `errexit`
# here would abandon a working install because one optional package is absent.
set +e

STEP=0
step()  { STEP=$((STEP + 1)); printf '\n\033[1m%2d · %s\033[0m\n' "$STEP" "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$1"; }
note()  { printf '    %s\n' "$1"; }

WHISPER_SRC="${ZERO_WHISPER_SRC:-$HOME/whisper.cpp}"
MODEL_DIR="${ZERO_WHISPER_MODEL_DIR:-$HOME/.cache/whisper.cpp}"
MODEL_NAME="${ZERO_WHISPER_MODEL_NAME:-ggml-tiny.bin}"
MODEL_PATH="$MODEL_DIR/$MODEL_NAME"
MODEL_URL="${ZERO_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME}"
# A tiny model is ~75 MB. Anything under this is a failed download, and an
# HTML error page is a few kilobytes.
MIN_MODEL_BYTES="${ZERO_MIN_MODEL_BYTES:-20000000}"
BIN_DIR="$HOME/.local/bin"

printf '\n\033[1mHWD | ZERO — TERMUX ONE-SHOT\033[0m\n'
printf '  root     %s\n' "$ZERO_ROOT"
printf '  runtime  %s\n' "${ZERO_RUNTIME_DIR:-(not found)}"

# ---------------------------------------------------------------------------
step "HOST"
if zero_is_termux; then
  ok "Termux $(echo "${TERMUX_VERSION:-unknown}")"
else
  warn "not Termux — package installation is skipped, the rest still applies"
fi
note "$(zero_os), $(zero_total_ram_mb 2>/dev/null || echo '?') MB RAM total, $(zero_free_ram_mb 2>/dev/null || echo '?') MB free"

# ---------------------------------------------------------------------------
step "TERMUX PACKAGES"
if zero_is_termux && command -v pkg >/dev/null 2>&1; then
  MISSING=""
  for tool in node python git cmake make clang; do
    command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
  done
  # Termux names differ from the binaries they provide.
  PKGS=""
  case "$MISSING" in *node*) PKGS="$PKGS nodejs" ;; esac
  case "$MISSING" in *python*) PKGS="$PKGS python" ;; esac
  case "$MISSING" in *git*) PKGS="$PKGS git" ;; esac
  case "$MISSING" in *cmake*) PKGS="$PKGS cmake" ;; esac
  case "$MISSING" in *make*) PKGS="$PKGS make" ;; esac
  case "$MISSING" in *clang*) PKGS="$PKGS clang" ;; esac
  if [ -n "$PKGS" ]; then
    note "installing:$PKGS"
    # Only into Termux's own prefix. Nothing here touches Android itself.
    pkg install -y $PKGS >/dev/null 2>&1 && ok "installed:$PKGS" || warn "pkg install failed for:$PKGS"
  else
    ok "every required package is already present"
  fi
else
  ok "skipped (not Termux)"
fi

# ---------------------------------------------------------------------------
step "TOOLCHAIN"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] && ok "node $(node -v)" || bad "node $(node -v) is too old (need >= 20.19)"
else
  bad "node is missing — the interface cannot be served"
fi
PYTHON_BIN=""
for candidate in python3 python; do
  command -v "$candidate" >/dev/null 2>&1 && { PYTHON_BIN="$candidate"; break; }
done
[ -n "$PYTHON_BIN" ] && ok "python $($PYTHON_BIN -V 2>&1 | awk '{print $2}')" || bad "python is missing"

# ---------------------------------------------------------------------------
step "PATH"
mkdir -p "$BIN_DIR"
zero_extend_path
ok "\$HOME/.local/bin is on PATH for this run"
if ! grep -qs 'HOME/.local/bin' "$HOME/.bashrc" 2>/dev/null; then
  # Appended to the user's own shell profile only — never to a system file.
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$HOME/.bashrc"
  ok "added it to ~/.bashrc for future shells"
fi

# ---------------------------------------------------------------------------
step "HWD-ZERO"
if [ -n "$ZERO_RUNTIME_DIR" ] && [ -d "$ZERO_RUNTIME_DIR/zero" ]; then
  ok "checked out at $ZERO_RUNTIME_DIR"
else
  warn "not checked out"
  note "git clone https://github.com/ChrisTheKey/HWD-ZERO \"${ZERO_RUNTIME_DIR:-$ZERO_ROOT/../HWD-ZERO}\""
fi
if [ -n "$PYTHON_BIN" ] && [ -d "${ZERO_RUNTIME_DIR:-}/zero" ]; then
  if (cd "$ZERO_RUNTIME_DIR" && "$PYTHON_BIN" -c 'import zero.server' 2>/dev/null); then
    ok "python -m zero.server is importable"
  else
    note "installing HWD-ZERO in editable mode"
    (cd "$ZERO_RUNTIME_DIR" && "$PYTHON_BIN" -m pip install -e . >/dev/null 2>&1) \
      && ok "installed" || bad "pip install -e . failed — run it by hand to see why"
  fi
fi

# ---------------------------------------------------------------------------
step "WHISPER.CPP"
EXISTING_BIN=""
for candidate in "${ZERO_WHISPER_BIN:-}" "$BIN_DIR/whisper-cli" \
    "$WHISPER_SRC/build/bin/whisper-cli" "$WHISPER_SRC/build/bin/main"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { EXISTING_BIN="$candidate"; break; }
done
if [ -n "$EXISTING_BIN" ] && "$EXISTING_BIN" --help 2>&1 | grep -qi 'usage\|whisper'; then
  ok "already built and runs: $EXISTING_BIN"
elif ! command -v git >/dev/null 2>&1 || ! command -v cmake >/dev/null 2>&1; then
  warn "git and cmake are needed to build whisper.cpp — voice stays off"
  note "pkg install git cmake"
else
  if [ ! -d "$WHISPER_SRC/.git" ]; then
    note "cloning whisper.cpp (shallow) into $WHISPER_SRC"
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_SRC" >/dev/null 2>&1 \
      || bad "clone failed — check the network and re-run"
  fi
  if [ -d "$WHISPER_SRC" ]; then
    note "building with -j2 (more cores throttle the phone and exhaust its RAM)"
    (
      cd "$WHISPER_SRC" || exit 1
      cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1 \
        && cmake --build build -j2 >/dev/null 2>&1
    )
    BUILT=""
    for candidate in "$WHISPER_SRC/build/bin/whisper-cli" "$WHISPER_SRC/build/bin/main" \
        "$WHISPER_SRC/main"; do
      [ -x "$candidate" ] && { BUILT="$candidate"; break; }
    done
    if [ -n "$BUILT" ]; then
      ln -sf "$BUILT" "$BIN_DIR/whisper-cli"
      ok "built: $BUILT  →  $BIN_DIR/whisper-cli"
    else
      bad "the build produced no binary — see the cmake output by running it by hand"
      note "cd $WHISPER_SRC && cmake -B build && cmake --build build -j2"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "SPEECH MODEL"
mkdir -p "$MODEL_DIR"
model_is_real() {
  [ -f "$MODEL_PATH" ] || return 1
  [ "$(wc -c <"$MODEL_PATH")" -ge "$MIN_MODEL_BYTES" ] || return 1
  # An error page saved as a file is still a file. ggml magic varies across
  # versions, so the test is the other way round: reject anything that looks
  # like markup or text. "Keine HTML-Fehlerseite als Modell akzeptieren."
  head -c 512 "$MODEL_PATH" | grep -qi '<!doctype\|<html\|<?xml\|Not Found' && return 1
  return 0
}
if model_is_real; then
  ok "$MODEL_NAME present ($(( $(wc -c <"$MODEL_PATH") / 1048576 )) MB)"
elif [ -f "$MODEL_PATH" ]; then
  bad "$MODEL_PATH is not a usable model — truncated, or an error page saved as a file"
  rm -f "$MODEL_PATH"
  note "deleted it; re-run this script to download again"
else
  note "downloading $MODEL_NAME (~75 MB) — deliberate, once, and never automatic later"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 2 -o "$MODEL_PATH.part" "$MODEL_URL" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$MODEL_PATH.part" "$MODEL_URL"
  else
    bad "neither curl nor wget is available"
    note "pkg install curl"
  fi
  if [ -f "$MODEL_PATH.part" ]; then
    mv "$MODEL_PATH.part" "$MODEL_PATH"
    if model_is_real; then
      ok "downloaded ($(( $(wc -c <"$MODEL_PATH") / 1048576 )) MB)"
    else
      # Never leave a half-file behind: whisper would fail on it every turn
      # with an error that says nothing about the download.
      bad "the download is not a valid model — deleting it rather than half-installing"
      rm -f "$MODEL_PATH"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "WAKE LOCK"
if zero_is_termux && command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock >/dev/null 2>&1 && ok "wake lock held — ZERO survives the screen going off" \
    || warn "termux-wake-lock failed"
  note "release it with: termux-wake-unlock"
elif zero_is_termux; then
  warn "termux-wake-lock is missing — Android may suspend ZERO with the screen off"
  note "pkg install termux-api"
else
  ok "skipped (not Termux)"
fi

# ---------------------------------------------------------------------------
step "START"
bash "$ZERO_ROOT/scripts/start-zero-termux.sh" "$@"
START_RC=$?

# ---------------------------------------------------------------------------
step "DIAGNOSIS"
bash "$ZERO_ROOT/scripts/zero-doctor.sh"
DOCTOR_RC=$?

echo
printf '\033[1mONE-SHOT COMPLETE\033[0m\n'
printf '  interface  http://127.0.0.1:%s\n' "$ZERO_UI_PORT"
printf '  status     bash scripts/zero-doctor.sh\n'
printf '  logs       .zero/logs/  (gateway.log, hwd-zero.log, voice.log)\n'
printf '  stop       bash scripts/start-zero-termux.sh --stop\n'
if [ "$START_RC" -ne 0 ] || [ "$DOCTOR_RC" -ne 0 ]; then
  echo
  printf '\033[33mSomething above is not right. The tails are printed with the failure;\n'
  printf 'zero-doctor names the remedy for each.\033[0m\n'
  exit 1
fi
