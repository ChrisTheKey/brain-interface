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

ZERO sits in the geometric centre as the orchestrator. Around it the interface
grows the entities ZERO actually reports — agents (threads), sub-agents,
knowledge bases (skills), tool providers (MCP servers) with their tools and
resources, and connectors (apps). Add an agent or a skill in ZERO and a node
appears; remove it and the node disappears. Nothing in the interface is
hardcoded to a fixed set of entities, and no production data is mocked.

## Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
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
| Agents | `thread/list` with `sourceKinds: [cli, vscode, exec, appServer, unknown]` |
| Sub-agents | `thread/list` with `sourceKinds: [subAgent, subAgentReview, subAgentCompact, subAgentThreadSpawn, subAgentOther]` |
| Agent → sub-agent edge | `thread.source.subAgent.thread_spawn.parent_thread_id` |
| Loaded / running agents | `thread/loaded/list`, `thread/status/changed` |
| Knowledge bases | `skills/list` (scoped to the workspaces ZERO's threads report + `VITE_ZERO_CWDS`) |
| Skill → tool edge | `skill.dependencies.tools[]` (linked to an MCP server when the names match) |
| Tool providers / tools / sources | `mcpServerStatus/list` (`tools`, `resources`, `resourceTemplates`, `authStatus`) |
| Connectors | `app/list` (+ `app/list/updated`) |
| Live activity | `turn/started`, `turn/completed`, `item/started`, `item/completed`, `thread/tokenUsage/updated`, `error` |
| Voice | `thread/realtime/start`, `thread/realtime/appendText`, `thread/realtime/outputAudio/delta`, `thread/realtime/stop` |

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

Port 3000 is used because it was free and ZERO runs on its own port; Vite falls
back to the next free port if 3000 is taken, and the actual URL is printed on
startup.

## Background asset

The absolute visual background is loaded from `public/assets/brain-background.png`
(configurable through `VITE_ZERO_BACKGROUND_IMAGE`). It is rendered fullscreen,
scaled proportionally with `background-size: cover`, fixed to the viewport, and
sits behind every brain element. Until the file exists a neutral dark gradient
is used as fallback. See `public/assets/README.md`.

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
