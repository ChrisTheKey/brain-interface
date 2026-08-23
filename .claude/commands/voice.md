---
description: Speak with Claude Code in this repo — dictation in, spoken replies out
argument-hint: "on | off | status | say <text>"
---

Voice for Claude Code in the brain-interface repository.

There are two halves, and they are not the same feature:

- **Dictation (in)** is built into Claude Code and is already switched on for
  this repository by `.claude/settings.json` — hold the voice key, talk, and
  what you said lands in the prompt. Nothing in this repo implements it.
- **Spoken replies (out)** are not built in. `scripts/zero-say.mjs` adds them:
  a `Stop` hook takes the last thing Claude said, strips the code blocks and
  URLs, and hands the prose to whatever speech synthesiser this machine has —
  `termux-tts-speak` on the Galaxy, `System.Speech` on the ThinkPad, `say` or
  `spd-say` elsewhere.

Spoken replies are **off until switched on**, per checkout, and the toggle is
a file under `.zero/run/` that is never committed. A repository that started
talking at whoever cloned it would be a prank.

The argument is: `$ARGUMENTS`

Act on it:

- `on` — run `node scripts/zero-say.mjs --on`, then confirm in one line.
- `off` — run `node scripts/zero-say.mjs --off`, then confirm in one line.
- `status` (or nothing) — run `node scripts/zero-say.mjs --status` and report
  what it says. If it reports no synthesiser, name the one command that
  installs one on this platform: `pkg install termux-api` on Termux,
  `sudo apt install speech-dispatcher` on Debian or Ubuntu. On Windows and
  macOS one is already present.
- `say <text>` — run `node scripts/zero-say.mjs "<text>"` and say nothing else.

Two things to be straight about if asked:

The reply is spoken *after* the turn ends, because that is when the `Stop` hook
fires — so it reads the finished answer rather than narrating along with it.
And it reads only the prose: code, diffs, URLs and tables are skipped, which
also means a token that appears in a code block is never read out loud.
