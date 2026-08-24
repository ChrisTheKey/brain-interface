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
- Windows, macOS, Linux or **Termux on Android** (ARM64). Termux needs no
  `sudo`, `systemd`, Docker or WSL — see
  [`docs/TERMUX_GALAXY_S25.md`](docs/TERMUX_GALAXY_S25.md)
- A running ZERO backend (the Codex agent runtime in this workspace) reachable
  over WebSocket
- A Chromium/Firefox/Safari browser with Web Audio support (optional; the brain
  runs without audio)

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

## Running it

The gateway is the single origin — port 3000 serves the interface, `/api` and
`/ws`; HWD-ZERO, Ollama and every child agent stay on `127.0.0.1`.

```bash
scripts/setup-zero.sh        # once: install, build, create .env.local
scripts/start-zero.sh        # this device only → http://localhost:3000
scripts/start-zero-lan.sh    # + a second device over WiFi (prints the LAN URL + token)
scripts/status-zero.sh       # what is actually up
scripts/zero-doctor.sh       # why the interface is not showing
scripts/stop-zero.sh
```

`start-zero-lan.sh` checks RAM, port and HWD-ZERO reachability, then prints the
**detected** LAN address — never an example IP. The second device opens that URL
with the `?token=…` it prints; the token is generated on first run into
`.zero/gateway-token` (0600, git-ignored) and is not part of the bundle.

LAN access is deliberately the boundary: no tunnel, no UPnP, no port forwarding.

### Samsung Galaxy, on the phone itself (Termux)

Termux on Android is a first-class target — ARM64, no `sudo`, no `systemd`, no
Docker, no WSL. The whole stack runs on the phone and the phone's own browser
opens it:

```bash
cd ~/ZERO-WORKSPACE/brain-interface
bash scripts/setup-termux.sh    # packages, deps, native toolchain, build
bash scripts/start-zero.sh      # → http://localhost:3000
```

Same-device access needs no LAN mode and no token: the gateway stays on
loopback. It binds **both** `127.0.0.1` and `::1`, because Android resolves
`localhost` to `::1` first — an IPv4-only bind is the usual reason a
same-device setup shows a blank page.

Full guide, including the workspace layout, the native-toolchain repairs and
the memory settings: [`docs/TERMUX_GALAXY_S25.md`](docs/TERMUX_GALAXY_S25.md).

### Samsung Galaxy, over WiFi from a laptop

Run `scripts/start-zero-lan.sh` on the laptop and open the URL it prints on the
phone.

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

The dev server binds one address. On Termux prefer the gateway
(`scripts/start-zero.sh`), which binds both loopback families and is what makes
`http://localhost:3000` reliable in the Android browser.

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
