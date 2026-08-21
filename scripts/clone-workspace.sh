#!/usr/bin/env bash
# Clones the repositories ZERO needs, beside this one.
#
#     bash scripts/clone-workspace.sh
#
# HWD-ZERO and most of the agent repositories are private, so an unauthenticated
# git gets HTTP 403 — and git's own message ("Write access to repository not
# granted") describes a permission it was not asking for, which is why that
# failure is so easy to misread. This script names the real cause and the fix.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-zero.sh"

BRANCH="${ZERO_BRANCH:-$(git -C "$ZERO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
OWNER="${ZERO_GITHUB_OWNER:-ChrisTheKey}"

# The operator first: without it there is no ZERO. The agents are optional —
# a missing one is reported OFFLINE, which is a true statement about the system.
REQUIRED=(HWD-ZERO)
OPTIONAL=(
  Autonomous-Website-Lead-Scraper
  Meta-Agent
  Auto-Agent-Install-Helper
  Google-Bewertungen-AI-Agent
  Insta-Agent
  Autonomer-Website-Outreach-Agent
  SEO
  Funnel
)

mkdir -p "$ZERO_WORKSPACE"
cd "$ZERO_WORKSPACE"

auth_hint() {
  cat >&2 <<HINT

  $1 is private, and git here has no GitHub credentials.

  Fix it with a personal access token (classic or fine-grained, scope: repo):

    1. Create one:  https://github.com/settings/tokens
    2. Store it once, then re-run this script:

         git config --global credential.helper store
         git clone https://github.com/$OWNER/$1.git
         # username: your GitHub name
         # password: PASTE THE TOKEN (not your account password)

  The token is written to ~/.git-credentials in plain text — that file is the
  credential, so treat it like one and revoke the token if the phone is lost.

  The alternative, if you would rather not put a token on the phone: make
  $1 public in its GitHub settings.
HINT
}

clone_one() {
  local name="$1" required="$2"
  if [ -d "$name/.git" ]; then
    echo "  $name: already present"
    return 0
  fi

  local output status
  output="$(git clone --depth 1 -b "$BRANCH" \
    "https://github.com/$OWNER/$name.git" "$name" 2>&1)"
  status=$?

  if [ "$status" -eq 0 ]; then
    echo "  $name: cloned ($BRANCH)"
    return 0
  fi

  rm -rf "$name"

  # A 403 on a public-looking URL is almost always a private repository, not a
  # branch or network problem. Separating the two is the whole point here.
  if printf '%s' "$output" | grep -qE '403|Authentication failed|could not read Username'; then
    if [ "$required" = required ]; then
      echo "  $name: FAILED — private repository" >&2
      auth_hint "$name"
      return 1
    fi
    echo "  $name: skipped (private, no credentials) — ZERO will report it OFFLINE"
    return 0
  fi

  if printf '%s' "$output" | grep -q "Remote branch $BRANCH not found"; then
    echo "  $name: branch '$BRANCH' does not exist on the remote" >&2
    [ "$required" = required ] && return 1
    return 0
  fi

  echo "  $name: FAILED" >&2
  printf '%s\n' "$output" | tail -3 >&2
  [ "$required" = required ] && return 1
  return 0
}

echo "CLONING INTO $ZERO_WORKSPACE  (branch $BRANCH)"
echo
echo "operator:"
for name in "${REQUIRED[@]}"; do
  clone_one "$name" required || exit 1
done

echo
echo "child agents:"
for name in "${OPTIONAL[@]}"; do
  clone_one "$name" optional
done

echo
echo "Done. Next: bash scripts/setup-termux.sh   (phone)"
echo "           bash scripts/setup-zero.sh     (laptop)"
