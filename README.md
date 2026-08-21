# Brain Interface

The visual, voice and approval surface of **ZERO**. It is not a second brain and
it holds no state of its own: every node, every edge, every status and every
permission gate you see is read live from HWD-ZERO, the operator.

```
        Laptop browser                 Samsung Galaxy S25 Ultra
              │  127.0.0.1:3000              │  <laptop-lan-ip>:3000
              └──────────────┬───────────────┘
                             ▼
                   ZERO GATEWAY :3000      the only process on the LAN
                             │
                             ▼  127.0.0.1:8000  (loopback only)
                      HWD-ZERO  — the operator
                             │
   ┌──────────┬──────────┬───┴──────┬──────────┬──────────┬─────────┐
 lead      meta      installer   reviews    insta    outreach   seo · funnel
 scraper
```

ZERO sits at the centre as the operator — the operative centre, not just the
visual one. It hears you, decides which of your agents is needed, runs it inside
its own repository under a capability grant, verifies what came back, stops at a
permission gate when a human is required, and answers.

## Start it

```bash
# once
bash scripts/setup-zero.sh

# laptop only — everything on loopback
npm run zero

# laptop + phone — the gateway binds the LAN, everything else stays on 127.0.0.1
npm run zero:lan
```

`zero:lan` prints the laptop's **current** LAN address and a pairing URL with a
token. It detects the address each time rather than remembering it, because the
laptop moves between WiFi and its own hotspot.

```
ZERO ONLINE

LAPTOP:  http://127.0.0.1:3000
GALAXY:  http://192.168.x.x:3000/?token=…
API:     http://127.0.0.1:8000 (loopback only, not reachable from the phone)

AGENTS:
    * lead_scraper     acquisition    HEALTHY
      seo              seo            OFFLINE
      …
    excluded: Prompt-Optimizer, Website-Building

STATUS:  HEALTHY
```

Then check the whole thing end to end:

```bash
npm run verify      # acceptance run against the live system
npm run test        # unit tests
```

## On the phone instead (Termux)

The supported shape is laptop-hosts, phone-opens-a-browser. Running the operator
*on* the phone works too, and these scripts do it — with the trade-offs stated
rather than discovered.

```bash
pkg install git

# HWD-ZERO is private, so store a GitHub token once (scope: repo).
# Skip this only if you have made the operator repository public.
git config --global credential.helper store

mkdir -p ~/ZERO-WORKSPACE && cd ~/ZERO-WORKSPACE
git clone -b claude/zero-autonomous-business-system-0d7eku \
  https://github.com/ChrisTheKey/brain-interface.git
cd brain-interface

bash scripts/clone-workspace.sh    # asks for the token on the first private repo
bash scripts/setup-termux.sh
bash scripts/start-zero-termux.sh
```

Then open the URL it prints, on the phone itself.

**On the private repositories.** An unauthenticated `git clone` of a private
repo answers `403` with the message *"Write access to repository not granted"* —
a permission it was not asking for, which makes the real cause easy to miss. It
means: not logged in. `clone-workspace.sh` says so in those words and prints the
token steps. Paste the **token** as the password, not your account password.

`~/.git-credentials` then holds that token in clear text. It *is* the
credential — revoke it if you lose the phone.

| Works | Does not |
| --- | --- |
| operator, gateway, 3D brain | Postgres, Redis, Celery — not packaged for Termux |
| missions, gates, kill switch, audit | Ollama — no Termux build; ZERO reports LOCAL MODEL OFFLINE |
| browser speech in and out | whisper.cpp / Kokoro — buildable, not by these scripts |
| lead scraper `analyse`, `prepare_outreach` | `search_leads`, `persist_leads` — need config and a database |

`start-zero-termux.sh` takes a wake lock, because Android reclaims memory from
backgrounded apps and would otherwise kill the operator when you switch away.
`stop-zero.sh` releases it — a wake lock that outlives its processes just costs
battery.

The network rule does not change because the host did: only the gateway binds
beyond loopback, HWD-ZERO stays on 127.0.0.1, and LAN access still needs the
token.

## Where things live

| | |
| --- | --- |
| Architecture | [`docs/ZERO_BRAIN_INTERFACE_ARCHITECTURE.md`](docs/ZERO_BRAIN_INTERFACE_ARCHITECTURE.md) |
| The operator | `HWD-ZERO/zero/ops/` |
| Child agent registry | `HWD-ZERO/agents/child-agents.yaml` |
| Excluded repositories | `HWD-ZERO/zero/ops/exclusions.py` |
| 3D brain | `src/render3d/` |
| Gateway | `server/gateway.mjs` |

## Workspace layout

ZERO finds its agents beside itself:

```
ZERO-WORKSPACE/
├── HWD-ZERO/                          the operator
├── brain-interface/                   this repository
├── Autonomous-Website-Lead-Scraper/
├── Meta-Agent/
├── Auto-Agent-Install-Helper/
├── Google-Bewertungen-AI-Agent/
├── Insta-Agent/
├── Autonomer-Website-Outreach-Agent/
├── SEO/
└── Funnel/
```

Set `ZERO_WORKSPACE` if yours is elsewhere. A repository that is not present is
reported `OFFLINE` — ZERO never invents an agent to fill a gap, and a mission it
cannot serve produces no plan rather than a plausible one.

`Website-Building`, `Loop-Engeneering`, `Prompt-Optimizer` and
`more-available-tokens` are never agents. If they are in the workspace they are
detected, reported as excluded, and ignored.

## Adding a child agent

1. Add a block to `HWD-ZERO/agents/child-agents.yaml` — id, display name, repo,
   department, capabilities, and what always needs your approval.
2. Optionally drop an `agent.yaml` in the repository itself declaring its entry
   point and adapter. A manifest may narrow what the operator granted; it can
   never widen it.

No renderer change is needed. The brain grows a cluster from the registry.

## Voice

Speech-to-text and text-to-speech run on the laptop, never on the phone. The
Galaxy captures audio and plays audio; the laptop transcribes and synthesises.

| | Preferred | Fallback |
| --- | --- | --- |
| STT | whisper.cpp (`ZERO_WHISPER_BIN`, `ZERO_WHISPER_MODEL`), faster-whisper | the browser's Web Speech API |
| TTS | Kokoro (`ZERO_KOKORO_BIN`), piper (`ZERO_PIPER_BIN`, `ZERO_PIPER_VOICE`) | the browser's speechSynthesis |

The fallback is a working configuration, not a failure: it runs on both the
laptop and the Galaxy with nothing to download. When no local backend is
configured ZERO reports `STT OFFLINE` / `TTS OFFLINE` and keeps running — it
never quietly reaches for a cloud service you did not configure.

## 8 GB of RAM

The operator is built for a laptop that is also running a model:

- the API is stdlib-only — no async web framework resident to serve JSON;
- child agents are subprocesses per mission, so no agent's dependencies stay
  loaded in the operator;
- the brain uses instanced geometry, and the mobile profile lowers density and
  pixel ratio rather than changing the scene;
- under pressure the order is: ZERO runtime → active agent → STT/TTS → UI →
  visual effects.

## Permissions in one paragraph

Every action is named as a capability, ruled on against the agent's grant and
your policy, and comes out **allowed**, **needs you**, or **denied**. An
approval is single-use, expiring, and bound to a digest of the exact payload —
approving one action can never release another. ZERO may learn to do safe things
unattended; it can never promote a capability off the always-human floor, and
neither can a hand-edited policy file. **STOP ZERO** is server state: it stops
the laptop, not just the screen you pressed it on.

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
| Operator client | `src/hwd/client.ts`, `src/hwd/types.ts` | The HWD-ZERO operations API: agents, missions, approvals, policy, kill switch, `/ws/events` |
| Operator state | `src/state/useOperator.ts` | The server's state, re-read on reconnect; nothing optimistic |
| Activity | `src/state/useAgentActivity.ts` | Turns ZERO's events into per-agent energy, gates and flow direction |
| Brain layout | `src/render3d/layout3d.ts` | Deterministic 3D brain silhouette and per-agent clusters |
| Brain shaders | `src/render3d/materials.ts` | Obsidian core, instanced neurons, travelling edge energy, smoke |
| Brain scene | `src/render3d/scene.ts` | The WebGL scene, camera, picking and quality profiles |
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
- Python ≥ 3.11 with `HWD-ZERO` beside this repository — the operator. The start
  scripts launch it; `ZERO_BRAIN_ROOT` points elsewhere if yours is not adjacent.
- A browser with WebGL for the 3D brain, and Web Audio for the audio-reactive
  core and smoke. Without WebGL the panels, voice and approvals still work — the
  picture is the part that is lost, not the control.
- Optionally the Codex app-server on `ws://127.0.0.1:8787`, which still backs the
  realtime voice provider. ZERO itself does not need it.

## Installation

```bash
cd brain-interface
npm install
cp .env.example .env.local   # then adjust VITE_ZERO_WS_URL if needed
```

## Environment

All variables are read at build/dev time by Vite and documented in
`.env.example`. No secrets belong in this repository — ZERO owns every upstream
credential.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_ZERO_WS_URL` | `ws://127.0.0.1:8787` | ZERO app-server WebSocket endpoint |
| `VITE_ZERO_CLIENT_NAME` | `brain_interface` | Client name sent in `initialize` |
| `VITE_ZERO_CLIENT_VERSION` | `0.1.0` | Client version sent in `initialize` |
| `VITE_ZERO_EXPERIMENTAL_API` | `true` | Opt into ZERO's experimental API (required for realtime voice) |
| `VITE_ZERO_CWDS` | – | Extra workspace roots to scan for skills, comma separated |
| `VITE_ZERO_THREAD_LIMIT` | `40` | Threads requested per source kind |
| `VITE_ZERO_REFRESH_INTERVAL_MS` | `20000` | Structural refresh interval |
| `VITE_ZERO_BACKGROUND_IMAGE` | `/reference/red-background.jpg` | Fullscreen background asset |
| `VITE_ZERO_VOICE_PROVIDER` | `zero-realtime` | `zero-realtime` \| `speech-synthesis` \| `none` |
| `VITE_ZERO_VOICE_NAMES` | – | Preferred platform voices (fallback provider only) |
| `VITE_ZERO_VOICE_RATE` | `0.92` | Speech rate |
| `VITE_ZERO_VOICE_PITCH` | `0.82` | Speech pitch |
| `VITE_ZERO_VOICE_VOLUME` | `1` | Speech volume |
| `VITE_ZERO_VOICE_SPEAK_AGENT_MESSAGES` | `false` | Speak ZERO's completed agent messages automatically |
| `VITE_ZERO_VOICE_PROMPT` | built-in ZERO persona | Session prompt describing ZERO's voice character (realtime provider) |

## The agent network

The child agents of HWD-ZERO are declared in the operator's own registry,
`HWD-ZERO/agents/child-agents.yaml`, which is the authority on capabilities and
approvals. `src/zero/agentPolicy.ts` carries only the interface's copy of the
department colours and the exclusion list:

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

## Laptop and Samsung Galaxy access

The gateway is the single origin — port 3000 serves the interface, `/api` and
`/ws`; HWD-ZERO, Ollama and every child agent stay on `127.0.0.1`.

```bash
scripts/setup-zero.sh        # once: install, build, create .env.local
scripts/start-zero.sh        # laptop only  → http://127.0.0.1:3000
scripts/start-zero-lan.sh    # laptop + phone (prints the real LAN URL + token)
scripts/status-zero.sh       # what is actually up
scripts/stop-zero.sh
```

`start-zero-lan.sh` checks RAM, port and HWD-ZERO reachability, then prints the
**detected** LAN address — never an example IP. The phone opens that URL with
the `?token=…` it prints; the token is generated on first run into
`.zero/gateway-token` (0600, git-ignored) and is not part of the bundle.

LAN access is deliberately the boundary: no tunnel, no UPnP, no port forwarding.

## Development

### 1. Start the ZERO backend

ZERO is the Codex agent runtime that lives next to this repository. Build the
app-server once and run it with the WebSocket transport:

```bash
cd ../Codex/codex-rs
cargo build --release -p codex-app-server --bin codex-app-server
./target/release/codex-app-server --listen ws://127.0.0.1:8787
```

On Linux the build needs `libcap` headers (`apt-get install libcap-dev pkg-config`).

The default transport of `codex app-server` is stdio; the interface needs the
WebSocket transport, which is why `--listen ws://IP:PORT` is required. ZERO
binds loopback only. Port `8787` is a free port on this machine — any port
works, as long as `VITE_ZERO_WS_URL` matches.

**ZERO backend URL:** `ws://127.0.0.1:8787`

### 2. Start the Brain Interface

```bash
npm run dev
```

**Local URL:** http://127.0.0.1:3000

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
