# Brain Interface

Brain Interface is the visual and interactive surface of **ZERO**. It is not a
second brain and it holds no state of its own: every node, every edge and every
status you see is read live from ZERO's own API.

```
ZERO repository (agent runtime, orchestrator, agents, skills, memory, tools, voice)
        │
        │  JSON-RPC 2.0 over WebSocket  (codex app-server --listen ws://IP:PORT)
        ▼
brain-interface   (this repository — data adapter + graph transform + rendering)
        │
        ▼
Browser
```

ZERO sits in the geometric centre as the orchestrator — and it is the
operative centre, not just the visual one: it hears you, decides which of your
agents is needed, starts a real thread in that agent's workspace, watches it
work and answers with what came back.

Around ZERO the interface grows the entities ZERO actually reports: your
**agents** (the agent repositories ZERO can run a task in), sessions (ZERO
threads), sub-agents, knowledge bases (skills), tool providers (MCP servers)
with their tools and resources, and connectors (apps). Add an agent repository
and a node appears; remove it and the node disappears. Nothing is hardcoded to
a fixed set of entities, and no production data is mocked.

```
 I speak  →  microphone  →  speech-to-text  →  ZERO (routing turn, real agent roster)
                                                  ↓
                                       thread/start in the agent workspace
                                                  ↓
                                       turn/start  →  the agent works
                                                  ↓
                                    result  →  ZERO  →  voice output  →  I hear
```

## Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| Agent registry | `src/zero/agentRegistry.ts` | Discovers the agent repositories through ZERO (`command/exec`), merges an optional manifest |
| Classification | `src/zero/agentClassifier.ts` | Decides from evidence what a repository is: zero / interface / toolProvider / agent / library |
| Invocation | `src/zero/agentRunner.ts` | Runs an agent for real: `thread/start` in its workspace + `turn/start`, with steps, errors, timeout and cleanup |
| Routing | `src/zero/router.ts` | ZERO itself picks the agents, via a turn constrained by an `outputSchema` |
| Conversation | `src/state/conversation.ts` | The state machine: idle → listening → processing → agentActive → speaking |
| Speech input | `src/voice/speechInput.ts` | Microphone + speech-to-text provider, with a real input level meter |
| Transport | `src/zero/client.ts` | One WebSocket to ZERO, `initialize`/`initialized` handshake, request/response correlation, notification fan-out, reconnect with backoff |
| Protocol | `src/zero/protocol.ts` | Types mirrored from ZERO's generated schemas (`codex app-server generate-json-schema`) |
| Adapter | `src/zero/adapter.ts` | Reads ZERO's entities, tracks live activity, records unavailable APIs instead of inventing data |
| Graph | `src/graph/transform.ts` | Turns a ZERO snapshot into nodes/edges (UI abstraction only) |
| Layout | `src/graph/layout.ts` | Hybrid radial + force relaxation in polar space |
| Render | `src/render/brainRenderer.ts`, `src/render/smoke.ts` | Canvas 2D brain, activity pulses, audio-reactive smoke |
| Voice | `src/voice/*` | Provider abstraction, ZERO realtime provider, browser fallback |
| Audio | `src/audio/analyser.ts` | Web Audio analysis (amplitude, bands, onsets) driving the smoke |

### Which ZERO APIs are used

| Brain entity | ZERO API |
| --- | --- |
| ZERO itself | `initialize` (user agent), `account/read`, `config/read` |
| Agents (your repositories) | `command/exec` — read-only discovery + classification under `VITE_ZERO_AGENT_ROOT` |
| Agent invocation | `thread/start` (cwd = agent workspace) + `turn/start`, `turn/interrupt`, `thread/unsubscribe` |
| Agent selection | `turn/start` with `outputSchema` on the routing thread — ZERO decides, not the UI |
| Sessions | `thread/list` with `sourceKinds: [cli, vscode, exec, appServer, unknown]` |
| Sub-agents | `thread/list` with `sourceKinds: [subAgent, subAgentReview, subAgentCompact, subAgentThreadSpawn, subAgentOther]` |
| Agent → sub-agent edge | `thread.source.subAgent.thread_spawn.parent_thread_id` |
| Loaded / running agents | `thread/loaded/list`, `thread/status/changed` |
| Knowledge bases | `skills/list` (scoped to the workspaces ZERO's threads report + `VITE_ZERO_CWDS`) |
| Skill → tool edge | `skill.dependencies.tools[]` (linked to an MCP server when the names match) |
| Tool providers / tools / sources | `mcpServerStatus/list` (`tools`, `resources`, `resourceTemplates`, `authStatus`) |
| Connectors | `app/list` (+ `app/list/updated`) |
| Live activity | `turn/started`, `turn/completed`, `item/started`, `item/completed`, `thread/tokenUsage/updated`, `error` |
| Voice | `thread/realtime/start`, `thread/realtime/appendText`, `thread/realtime/outputAudio/delta`, `thread/realtime/stop` |

### What counts as an agent

A repository is not an agent because of its name. `agentClassifier.ts` decides
from evidence ZERO collected on disk:

| Classification | Evidence | Drawn as an agent? |
| --- | --- | --- |
| `zero` | contains the ZERO runtime (`codex-rs/app-server`) | no — this *is* ZERO |
| `toolProvider` | MCP server (`@modelcontextprotocol/*`, `mcpName`) | no — it is a tool ZERO uses |
| `interface` | `index.html` + bundler config, no agent instructions | no — it is a frontend |
| `agent` | ships `AGENTS.md` / `CLAUDE.md` / `.codex`, or has a runnable entrypoint | **yes** |
| `library` | no entrypoint, no agent instructions | no |

Everything that is *not* drawn as an agent is listed in the status line's data
notes with its classification, so nothing disappears silently. A
`zero-agents.json` manifest in the agent root overrides the heuristics and adds
role, capabilities, inputs and outputs.

### Relationships that ZERO does not expose

These are documented rather than invented:

- **Memory.** ZERO runs a memory pipeline (`codex-rs/core/src/memories`, artifacts
  under `$CODEX_HOME/memories`) but the app-server exposes no memory read API,
  so there are no memory nodes. Memory work is only visible indirectly, through
  sub-agent threads whose source is `memory_consolidation`.
- **Agent → knowledge.** ZERO scopes skills per working directory, not per
  agent. Repo-scoped skills are therefore linked to the agents whose `cwd`
  matches (`workspaceKnowledge`); user/system/admin-scoped skills hang off ZERO.
- **Agent → tool.** There is no static agent-to-tool relation in ZERO. Tool use
  becomes visible dynamically: an `mcpToolCall` item lights up the agent and the
  exact `server/tool` node while the call runs.
- **Agent roles.** `config/read` reports configured `agent_roles` names; they are
  shown as ZERO metadata, not as separate nodes (ZERO has no per-role entity in
  the API).

Whenever a ZERO API is missing or fails, the interface adds a note (see
"data notes" in the status line) instead of substituting data.

## Requirements

- Node.js ≥ 20.19 (Node 22 recommended) and npm
- A running ZERO backend (the Codex agent runtime in this workspace) reachable
  over WebSocket
- A Chromium/Firefox/Safari browser with Web Audio support (optional; the brain
  runs without audio)

## Installation

```bash
cd brain-interface
npm install
cp .env.example .env.local   # then set ZERO_API_URL / ZERO_RUNTIME_WS_URL if they differ
```

## Environment

`VITE_*` variables are read at build/dev time by Vite and end up **inside the
browser bundle**. `ZERO_*` variables are read by the gateway process and never
reach the browser. No secrets belong in this repository — ZERO owns every
upstream credential.

There is deliberately **no** variable for ZERO's address. The interface derives
`/api` and `/ws` from the origin that served it, so the same build works on the
laptop, over the LAN and behind HTTPS without a change. See
[`docs/ZERO_SAME_ORIGIN_GATEWAY.md`](docs/ZERO_SAME_ORIGIN_GATEWAY.md).

| Gateway variable | Default | Meaning |
| --- | --- | --- |
| `ZERO_UI_PORT` | `3000` | The single port a browser needs |
| `ZERO_API_URL` | `http://127.0.0.1:8000` | HWD-ZERO's HTTP API, loopback only |
| `ZERO_RUNTIME_WS_URL` | `ws://127.0.0.1:8787` | Optional codex app-server, loopback only; empty = none |
| `ZERO_LAN_MODE` | `false` | Bind the gateway (only the gateway) to `0.0.0.0` |
| `ZERO_DIAGNOSTICS` | on locally, off on LAN | Include internal upstreams in `/api/health` |
| `ZERO_START_CMD` | – | Command `zero-go.sh` uses to start HWD-ZERO |

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_ZERO_CLIENT_NAME` | `brain_interface` | Client name sent in `initialize` |
| `VITE_ZERO_CLIENT_VERSION` | `0.1.0` | Client version sent in `initialize` |
| `VITE_ZERO_EXPERIMENTAL_API` | `true` | Opt into ZERO's experimental API (required for realtime voice) |
| `VITE_ZERO_CWDS` | – | Extra workspace roots to scan for skills, comma separated |
| `VITE_ZERO_THREAD_LIMIT` | `40` | Threads requested per source kind |
| `VITE_ZERO_REFRESH_INTERVAL_MS` | `20000` | Structural refresh interval |
| `VITE_ZERO_BACKGROUND_IMAGE` | `/assets/brain-background.png` | Fullscreen background asset |
| `VITE_ZERO_VOICE_PROVIDER` | `zero-realtime` | `zero-realtime` \| `speech-synthesis` \| `none` |
| `VITE_ZERO_VOICE_NAMES` | – | Preferred platform voices (fallback provider only) |
| `VITE_ZERO_VOICE_RATE` | `0.92` | Speech rate |
| `VITE_ZERO_VOICE_PITCH` | `0.82` | Speech pitch |
| `VITE_ZERO_VOICE_VOLUME` | `1` | Speech volume |
| `VITE_ZERO_VOICE_SPEAK_AGENT_MESSAGES` | `false` | Speak ZERO's completed agent messages automatically |
| `VITE_ZERO_VOICE_PROMPT` | built-in ZERO persona | Session prompt describing ZERO's voice character (realtime provider) |

## The agent network

The child agents of HWD-ZERO are fixed by policy (`src/zero/agentPolicy.ts`):

| Agent | Repository | Department |
| --- | --- | --- |
| Autonomous Website Lead Scraper | `Autonomous-Website-Lead-Scraper` | acquisition |
| Meta Agent | `Meta-Agent` | orchestration |
| Auto Agent Install Helper | `Auto-Agent-Install-Helper` | infrastructure |
| Google Bewertungen AI Agent | `Google-Bewertungen-AI-Agent` | reputation |
| Insta Agent | `Insta-Agent` | social |
| Autonomer Website Outreach Agent | `Autonomer-Website-Outreach-Agent` | outreach |
| SEO | `SEO` | seo |
| Funnel | `Funnel` | funnel |

**Never registered:** `Website-Building`, `Loop-Engeneering`, `Prompt-Optimizer`,
`more-available-tokens`. The exclusion is applied before classification, before
the graph and before routing; a manifest cannot re-enable them. `HWD-ZERO` and
`brain-interface` are recognised as runtime and interface, not as agents.

Point `VITE_ZERO_AGENT_ROOT` at the workspace that holds these repositories:

```
ZERO-WORKSPACE/
├── HWD-ZERO/
├── brain-interface/
├── Autonomous-Website-Lead-Scraper/
├── Meta-Agent/
└── …
```

## ZERO's voice: Fish Audio (optional, cloud)

By default ZERO speaks with the browser's own synthesiser and nothing leaves
the machine. Fish Audio is an opt-in upgrade that gives it a darker, measured,
authoritative voice — at the cost of sending each reply to a third party.

```bash
# .env.local — git-ignored, read by the gateway, never by the browser
FISH_AUDIO_ENABLED=true
FISH_API_KEY=<your own key from fish.audio>
FISH_AUDIO_MODEL=s2.1-pro-free
FISH_AUDIO_VOICE_ID=306c68e5763b42d6b06fe0380daa5281
FISH_AUDIO_VOICE_NAME=Lelouch Vi Britannia
```

**The key never reaches the browser.** There is deliberately no `VITE_FISH_*`
anywhere: every `VITE_` value is compiled into the bundle a phone downloads.
The browser POSTs the answer text to the gateway, the gateway holds the
credential and calls `api.fish.audio`. A test asserts the built bundle
contains neither the endpoint nor an Authorization header.

**Only the answer goes out.** The request body is the sentence, the voice id
and the parameters to say it — nothing else. No conversation history, no
mission log, no agent registry, no memory, and never microphone audio. A test
pins the exact field list, so adding anything to it fails the build.

**Nothing bills without being asked.** `s2.1-pro-free` is the default. When the
free tier says no, ZERO reports `FISH AUDIO FREE MODEL UNAVAILABLE` and falls
back to the local voice; reaching `s2.1-pro` or `s2-pro` takes writing the
model name down yourself.

**The voices.** Two public Fish Audio community voices are shipped as known
ids, both confirmed against the live model API as `public` and `trained`:

| Voice | Id | Author |
|---|---|---|
| Lelouch Vi Britannia | `306c68e5763b42d6b06fe0380daa5281` | Universal |
| Lelouch | `349b7618384141f780d21e119624783f` | Jatteks |

Nothing here trains, uploads or clones a voice, and no audio was collected to
build one. Any public Fish Audio voice id works — set `FISH_AUDIO_VOICE_ID`.

**German is untested.** Both voices declare `languages: ["en"]` in their
metadata. The model itself detects language and a reference voice is a timbre
reference, so German may well work — but nobody here has heard it, and the
interface does not claim otherwise. If it sounds wrong, pick another voice.

**Local-only wins over everything.** `ZERO_LOCAL_ONLY=true` blocks the call
even with a key present and the provider selected. The panel says
`VOICE · CLOUD — FISH AUDIO` with `VOICE TEXT SENT TO FISH AUDIO` when the
cloud voice is on, and `VOICE · LOCAL` when it is not. Neither is ever
implied — it is read from the gateway.

**It falls back rather than going silent.** Missing key, bad key, unknown
voice, rate limit, timeout, unplayable audio, no network — each has a name and
each hands the same sentence to the browser voice, with ZERO's answer on
screen throughout. `scripts/zero-doctor.sh` and `zero-windows-doctor.ps1`
report which one is speaking and why.

The audio plays through the same `AnalyserNode` as every other voice, so the
core, the filaments and the smoke react to ZERO's real output. Playback is
buffered, not streamed: Fish Audio can stream and the gateway passes the
stream through, but starting playback mid-download needs MediaSource with
chunked MP3 appending, which is browser-specific and fails silently when it
fails. A voice that starts half a second later beats one that sometimes never
starts.

Windows and Termux are identical here — the provider is plain Node in the
gateway, with no platform-specific code. On Windows put the key in
`.env.local` next to the checkout; the background gateway reads it there
without a terminal.

## Hands-free: "Hey ZERO"

Switch on `HEY ZERO` in the conversation bar and stop pressing anything:

```
"Hey ZERO"                        →  DETECTED, then LISTENING
"Welche Agenten sind verfügbar?"  →  captured until you stop talking
                                  →  FINALIZING, UNDERSTANDING, ZERO answers
                                  →  back to HEY ZERO · LISTENING
```

Both shapes work: the phrase alone with the instruction after a pause, or
`"Hey ZERO, welche Agenten sind verfügbar?"` in one breath. Either way the
phrase is activation, not instruction — what reaches ZERO is the sentence
without it.

**It is an activation layer, not a second ZERO.** The audio goes down the same
`/ws/voice` socket, the transcript goes to the same `/api/voice/transcript`,
and the same ZeroSession answers it. So the conversation continues across
turns — "Hey ZERO, warum genau diesen?" resolves against the previous answer —
and every permission gate still holds. Waking ZERO means "I would like to
speak to you". It does not mean "approve everything I am about to say":
`"Hey ZERO, sende die Outreach-Nachricht"` still stops at AWAITING APPROVAL.

**Local, and quiet when nothing is happening.** No cloud speech API, no Web
Speech Recognition — the same local whisper.cpp that already runs the voice
turn. While the room is silent nothing is sent and nothing is inferred; a
voice-activity detector opens the tap only when someone speaks, and the last
600 ms are replayed first so the engine hears the whole of "Hey" rather than
whatever was left after the detector made up its mind. Speech that was not
addressed to ZERO is dropped from the buffer rather than accumulating.

**It does not hear itself.** Ingestion stops before ZERO's first syllable and
resumes a beat after its last, so an answer containing the words "Hey ZERO"
cannot wake it.

Off until switched on, remembered per browser. `HEY ZERO` shows what it is
doing — LISTENING, DETECTED, PAUSED, OFFLINE — and the diagnostics panel adds
provider, mic, VAD, STT, last wake and a false-activation count. The
SPEAK / STOP buttons work exactly as before; hands-free is in addition to them,
never instead.

One honest limit: this is the browser's microphone, so it listens while the
brain-interface page is open and the browser has not suspended it. It is not
an operating-system-wide listener, and closing the tab stops it.

Tune it with `ZERO_WAKE_PHRASE`, `ZERO_WAKE_VARIANTS`, `ZERO_WAKE_THRESHOLD` —
but the switch in the interface is the intended way in.

## Talking to Claude Code in this repo

Two halves, and they are not the same feature.

**Dictation in** is Claude Code's own. `.claude/settings.json` switches it on
for this repository: hold the voice key, talk, and what you said lands in the
prompt. Nothing here implements it.

**Spoken replies out** are not built into the CLI at all. `scripts/zero-say.mjs`
adds them — a `Stop` hook takes the last thing Claude said, drops the code
blocks, tables and URLs, and hands the prose to whatever synthesiser the
machine already has: `termux-tts-speak` on the Galaxy, `System.Speech` on the
ThinkPad, `say` or `spd-say` elsewhere.

```
/voice on        read replies aloud from now on
/voice off       stop
/voice status    is it on, and is there a voice to use
/voice say ...   read this one thing out
```

Off until switched on, per checkout — the toggle is a file under `.zero/run/`
that is never committed. A repository that started talking at whoever cloned it
would be a prank rather than a feature.

It reads prose only. That is partly because listening to a diff is useless, and
partly because a token pasted into a code block is precisely the thing that
must not be read out across a room. If no synthesiser is installed, `/voice
status` says so and names the one command that fixes it; nothing is installed
behind your back.

The reply is spoken after the turn ends, because that is when the hook fires.

## Windows 11 (ThinkPad)

One command, from a machine with nothing set up to a running ZERO:

```powershell
cd "$HOME\ZERO-WORKSPACE\brain-interface"
git fetch origin
git checkout -B claude/zero-termux-runtime-fix origin/claude/zero-termux-runtime-fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\zero-windows-one-shot.ps1"
```

`-ExecutionPolicy Bypass` applies to that one process. Nothing here changes the
machine's execution policy, its firewall, Defender, UAC or the registry, and no
step needs elevation.

```powershell
.\scripts\zero-windows-one-shot.ps1   # update, install, build, start, diagnose
.\scripts\zero-windows-start.ps1      # start only            (-Lan, -NoBackend, -NoSupervise)
.\scripts\zero-windows-status.ps1     # what is actually up
.\scripts\zero-windows-doctor.ps1     # PASS / WARN / FAIL, with a remedy each
.\scripts\zero-windows-stop.ps1       # stop what these scripts started
```

Same architecture as the phone, same canonical runtime: the gateway on
`127.0.0.1:3000` serves the interface, `/api` and `/ws`; HWD-ZERO answers on
`127.0.0.1:8000`; whisper.cpp runs locally; ZeroSession is the runtime. Windows
adds no second runtime and no separate voice path — the browser's microphone
reaches the same `/ws/voice` and the same `WhisperCppProvider`.

Loopback by default. Windows asks about public networks the moment something
binds `0.0.0.0`, and the interface has no business there until `-Lan` says so.

Two Windows specifics worth knowing. `Start-Process` cannot send stdout and
stderr to one file, so each log has a companion — `gateway.log` and
`gateway.err.log` — and every tail reads both. And `SO_REUSEADDR` means the
opposite thing on Windows to what it means on POSIX: it would let a second
HWD-ZERO bind a port the first is serving, so HWD-ZERO does not set it there
and a duplicate start fails honestly instead.

## Laptop and Samsung Galaxy access

The gateway is the single origin — port 3000 serves the interface, `/api` and
`/ws`; HWD-ZERO, Ollama and every child agent stay on `127.0.0.1`.

```bash
# Android / Termux — from a fresh install to a speaking runtime, one command
bash scripts/zero-termux-one-shot.sh           # packages, whisper, model, start
bash scripts/zero-doctor.sh                    # PASS / WARN / FAIL, with remedies

bash scripts/start-zero-termux.sh              # foreground
bash scripts/start-zero-termux.sh --background # detached, survives the session
bash scripts/start-zero-termux.sh --lan        # also reachable from the LAN
bash scripts/start-zero-termux.sh --stop       # stops only what it started

# Laptop
scripts/zero-go.sh           # the one command  → http://127.0.0.1:3000
scripts/zero-go.sh --lan     # laptop + phone   → prints the detected LAN URL

scripts/setup-zero.sh        # once: install, build, create .env.local
scripts/start-zero.sh        # gateway only, loopback
scripts/start-zero-lan.sh    # gateway only, on the LAN
scripts/status-zero.sh       # what is actually up
scripts/stop-zero.sh
```

**The gateway starts before the backend, and nothing about the backend can
stop it.** Order: environment → ports → bundle → **gateway** → prove port 3000
answers → HWD-ZERO → health. Everything after the gateway is advisory: a
missing, broken or slow HWD-ZERO changes what is *reported*, never whether the
interface is served. A backend that is not running is a state to display.

Both scripts say `ZERO READY` only when the health probe genuinely came back
healthy, and `ZERO ONLINE · BACKEND OFFLINE` otherwise. Neither prints the
token. If port 3000 does not answer they say `ZERO GATEWAY FAILED` and print
the log path rather than claiming success.

```
.zero/run/gateway.pid      .zero/logs/gateway.log
.zero/run/hwd-zero.pid     .zero/logs/hwd-zero.log
.zero/run/supervisor.pid   .zero/logs/supervisor.log
                           .zero/logs/voice.log
```

`voice.log` records what each spoken turn did — session, chunk and byte counts,
when finalizing started, the engine's exit, whether a transcript was produced
and where the command went. It records no words and no audio: a voice log that
holds what was said is a recording.

`--background` starts three things: the gateway on 3000, HWD-ZERO on loopback
via `python -m zero.server`, and a small supervisor that restarts HWD-ZERO if
it dies. The gateway is deliberately *not* supervised — it survives an absent
backend by design, and a second process able to restart it would be a second
process able to take port 3000 away. The supervisor exits when the gateway
does, and gives up after five failed restarts in five minutes rather than
hammering a broken install (`--no-supervise` turns it off). Restarts back off
— 1s, 2s, 5s, 10s, then 15s — and before starting anything it asks port 8000
who is there: an HWD-ZERO already answering is adopted, never duplicated.
Starting a second one is what produced `[Errno 98] Address already in use`.

Stopping goes through those pid files only — never `pkill node` or
`killall python`, which on a phone take out whatever else is running.

`start-zero-lan.sh` checks RAM, port and HWD-ZERO reachability, then prints the
**detected** LAN address — never an example IP. The phone opens that URL with
the `?token=…` it prints; the token is generated on first run into
`.zero/gateway-token` (0600, git-ignored) and is not part of the bundle.

LAN access is deliberately the boundary: no tunnel, no UPnP, no port forwarding.

### What the interface is allowed to claim

`UI LOADED ≠ ZERO READY`. The ZERO panel reports a real state, never "the
bundle rendered":

| state | meaning |
| --- | --- |
| `STARTING` | asking the gateway what is running |
| `CONNECTING` | gateway answered, chain not established yet |
| `AUTH_REQUIRED` | this origin needs the pairing token |
| `BACKEND_OFFLINE` | gateway healthy, **HWD-ZERO not reachable** |
| `BACKEND_CONNECTED` | socket open, first real answer still pending |
| `DEGRADED` | HTTP health fine, an event stream is down |
| `SAFE_MODE` | reachable, and the kill switch refuses execution |
| `READY` | HTTP health **and** open socket **and** a real answer from ZERO |
| `ERROR` | the gateway on this origin stopped answering |

`READY` = gateway healthy + HWD-ZERO healthy + `ZeroSession` online +
`/ws/events` connected. **HWD-ZERO's `ZeroSession` is the canonical ZERO
runtime**; Codex, Claude and Ollama are executors it may drive, and none of
them appears in that list — so no codex app-server and no port 8787 is needed
to reach READY. See
[`docs/ZERO_SAME_ORIGIN_GATEWAY.md`](docs/ZERO_SAME_ORIGIN_GATEWAY.md).

The `AGENTS` row counts **child agents discovered on disk** against the eight
the policy allows, reported as `N/8 DISCOVERED` with the missing ones named.
It is not HWD-ZERO's role registry (`zero`, `codex`, `claude-code`,
`perplexity`, `checkmate`, `pulse`) — those are ZERO's own roles and executors,
a different population that used to be shown here by mistake.

### Microphone over the LAN

Browsers grant `getUserMedia` only in a secure context. `localhost` qualifies;
a plain `http://192.168.x.x` address generally does not — so on the Galaxy the
microphone may be refused even while ZERO is perfectly connected. Text input
drives the identical pipeline, so nothing is blocked. Putting the gateway
behind TLS restores it, and the interface needs no change: an `https:` page
automatically opens `wss://`.

## Development

### 1. Start the ZERO backend

Two upstreams, both on loopback, both configured in one place each. The first
is required for `READY`; the second is optional.

```bash
# HWD-ZERO's HTTP API + operator event stream  → ZERO_API_URL
cd ../HWD-ZERO && python -m zero.server

# ZERO's runtime app-server (OPTIONAL)         → ZERO_RUNTIME_WS_URL
# Drives the brain graph and realtime voice. Leave ZERO_RUNTIME_WS_URL empty
# when you do not run one — a phone never will, and its absence is reported as
# "not configured" rather than as a failure.
cd ../Codex/codex-rs
cargo build --release -p codex-app-server --bin codex-app-server
./target/release/codex-app-server --listen ws://127.0.0.1:8787
```

On Linux the build needs `libcap` headers (`apt-get install libcap-dev pkg-config`).

The default transport of `codex app-server` is stdio; the gateway needs the
WebSocket transport, which is why `--listen ws://IP:PORT` is required. Any port
works as long as `ZERO_RUNTIME_WS_URL` matches — and note where that value is
read: by the **gateway**, never by the browser.

### 2. Start the Brain Interface

```bash
scripts/zero-go.sh
```

**Local URL:** http://127.0.0.1:3000
**From a second device:** `http://<the LAN IP zero-go.sh --lan printed>:3000`

For frontend work without the gateway, `npm run dev` also serves port 3000 and
proxies `/api` and `/ws` to the same two upstreams, so the browser stays
same-origin in development too.

Port 3000 is a hard requirement, so `strictPort` is enabled: if something else
already listens on 3000, the dev server fails with
`Port 3000 is already in use` instead of silently moving to another port. Two
deliberate overrides exist:

```bash
PORT=4000 npm run dev          # run on a different port
HOST=0.0.0.0 npm run dev       # expose it to the local network (phone → laptop)
```

## Background asset

The background image ships with the repository as
`public/assets/brain-background.jpg` and is the absolute visual backdrop:
fullscreen, `background-size: cover`, fixed to the viewport (it never scrolls),
behind every brain element. Replace the file — or point
`VITE_ZERO_BACKGROUND_IMAGE` somewhere else — to swap it. If the asset is
missing, a neutral dark gradient is used instead. See `public/assets/README.md`.

Over that image the graph is deliberately **black**: every node is a black disc
with a dark separation aura and a thin luminous rim, edges are drawn with a
black underlay plus a fine light core, and a radial scrim darkens the image
towards ZERO. Status is a small accent arc — never a coloured fill.

## Speaking to ZERO

The microphone is opened only on an explicit click. Then:

1. `SpeechRecognition` (the browser's real STT engine) produces the transcript.
2. A separate `MicrophoneMeter` reads the real input level — that is what the
   listening animation reacts to, not a timer.
3. The final transcript goes into the **same pipeline as typed input**
   (`ConversationPipeline.handleTranscript`) — there is no separate voice path.
4. ZERO routes it, the selected agents run, and ZERO's answer is spoken.

States: `idle`, `listening`, `processing`, `agentActive`, `speaking`, `error` —
each one a real system state, each with its own quiet mark on the ZERO node.
Activating the microphone while ZERO speaks stops the output first (barge-in).

If the browser has no SpeechRecognition engine, the microphone button is
disabled and the text field next to it drives the identical pipeline.

## ZERO voice

The voice is an abstraction with interchangeable providers:

```
Voice Provider → ZERO Voice Service → Audio Playback → Audio Analyser
```

- `zero-realtime` (default): opens a realtime session on a ZERO thread
  (`thread/realtime/start` with the ZERO voice prompt) and plays the PCM16
  chunks ZERO streams back (`thread/realtime/outputAudio/delta`). Requires
  `VITE_ZERO_EXPERIMENTAL_API=true`, an existing thread and an authenticated
  ZERO. If it fails at runtime the service hands over to the next provider.
- `speech-synthesis`: browser fallback. Voice character is shaped through rate,
  pitch and a male-voice preference ranking — calm, precise, authoritative. It
  is an independent ZERO voice, not an imitation or clone of any performer.
- `none`: disables voice entirely.

Because the platform synthesizer cannot be routed through the Web Audio graph,
the fallback provider exposes only its real word-boundary events; full
amplitude-reactive smoke requires the realtime provider.

## Audio-reactive smoke

`src/audio/analyser.ts` measures the actual playback signal (RMS amplitude,
peak, low band < 400 Hz, high band > 2 kHz, and the frame-to-frame onset).
`src/render/smoke.ts` maps those measurements onto the emitter:

| Signal | Effect |
| --- | --- |
| amplitude | emission rate, particle opacity, expansion speed |
| low band | smoke density and particle size |
| high band | turbulence |
| onset | burst velocity on stressed syllables |

Silence (amplitude below the noise floor) gates emission to zero, so a quiet
ZERO produces essentially no smoke.

**Word synchronisation.** With the realtime provider the smoke follows the
waveform itself. With the browser fallback (no Web Audio access to the platform
synthesizer) it follows the engine's real `boundary` events — one impulse per
spoken word. If an engine emits no boundary events, the word cadence is
*estimated* from the utterance text and the configured rate; that estimate only
runs while an utterance is actually speaking and is marked as such in
`src/voice/speechSynthesisProvider.ts`.

## Fallbacks

The interface never crashes when ZERO is degraded:

- ZERO unreachable → ZERO stays visible as the central node, the status line
  says `disconnected`, and the client reconnects with backoff.
- No agents / no skills / no MCP servers → those rings are simply empty and a
  data note explains it.
- An API a ZERO build does not support → recorded as a capability note.
- Realtime/voice unavailable or `AudioContext` blocked → voice reports
  `unavailable`, everything else keeps running.

## Build

```bash
npm run build     # tsc project build + vite production build → dist/
npm run preview   # serve the production build
```

## Tests

```bash
npm test          # vitest (protocol client, adapter, graph transform, layout, audio, config)
npm run typecheck # tsc -b --force
npm run lint      # eslint
```

Mock data exists only inside `tests/` (a protocol-conformant fake WebSocket and
fake ZERO responses). The application itself has no mock data path.
