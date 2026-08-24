# brain-interface — Repository Inventory & Code Map

Complete technical inventory of `ChrisTheKey/brain-interface`.

**Scope of this document.** It records only what exists in the repository. Where
something claimed elsewhere does not exist here, it is marked **NOT FOUND**.
Where the code does not settle a question, it is marked **UNKNOWN**. Nothing is
inferred from names, and no behaviour is described that is not in the source.

| | |
| --- | --- |
| Repository | `https://github.com/ChrisTheKey/brain-interface` |
| Branch inventoried | `claude/zero-termux-runtime-fix-dqoira` |
| Commit | `e4e13cb` — *Make Termux on Android a first-class runtime target* |
| Commits on branch | 8 (first: `de66135`, 2026-08-18) |
| Runtime dependencies | `react ^19.2.0`, `react-dom ^19.2.0` — **that is the complete list** |
| Node requirement | `>=20.19` (`package.json` → `engines`) |
| Tests | 119 passing across 17 files |
| CI | **NOT FOUND** — no `.github/` directory, no workflows, no PR/issue template |

---

## 1. Connected repositories

Only two repositories are referenced by the running code. Everything else named
below appears as **data** (a policy list of directory names), not as a code
dependency.

### 1.1 Hard runtime dependency

| Repository | How it is reached | Where |
| --- | --- | --- |
| **HWD-ZERO** | HTTP `/api/*` + WebSocket `/ws/events`, same origin, proxied by the gateway to `127.0.0.1:8000` | `src/hwd/client.ts`, `server/gateway.mjs` |
| **ZERO / Codex app-server** | WebSocket JSON-RPC, **direct** to `ws://127.0.0.1:8787` | `src/zero/client.ts`, `src/config.ts` |

`HWD-ZERO` and `ZERO app-server` are two **separate** backends on two separate
ports with two separate transports. See §5.1 — this is the single most
important structural fact about the repository.

`src/zero/protocol.ts` states its types mirror
`codex-rs/app-server-protocol/schema/json/v2/*.json`. That Codex repository is
**not** a dependency of this one; the types are hand-maintained copies.

### 1.2 Repositories named as data (agent policy)

`src/zero/agentPolicy.ts` hardcodes directory names that the agent scan
classifies. No code from them is imported, and this repository never reads them
from disk itself — the scan runs *through ZERO* (`command/exec`).

**Child agents (8), fixed by policy:**

| id | Repository directory | Department | Always needs approval for |
| --- | --- | --- | --- |
| `lead_scraper` | `Autonomous-Website-Lead-Scraper` | acquisition | `network.write`, `external.message` |
| `meta` | `Meta-Agent` | orchestration | `agent.invoke`, `repo.write` |
| `agent_installer` | `Auto-Agent-Install-Helper` | infrastructure | `system.install`, `repo.write` |
| `google_reviews` | `Google-Bewertungen-AI-Agent` | reputation | `external.publish`, `external.message` |
| `insta` | `Insta-Agent` | social | `external.publish`, `external.message` |
| `website_outreach` | `Autonomer-Website-Outreach-Agent` | outreach | `external.message` |
| `seo` | `SEO` | seo | `external.publish` |
| `funnel` | `Funnel` | funnel | `external.publish`, `network.write` |

**Hard exclusions** (`EXCLUDED_REPOSITORIES`) — never an agent, never routed,
never rendered, not even if a manifest declares them:
`Website-Building`, `Loop-Engeneering`, `Prompt-Optimizer`, `more-available-tokens`.

**System repositories** (`SYSTEM_REPOSITORIES`), recognised but not agents:
`HWD-ZERO`, `brain-interface`.

### 1.3 Expected on-disk layout

```
$HOME/ZERO-WORKSPACE/          ← detected, never hardcoded (server/platform.mjs)
├── HWD-ZERO/
├── brain-interface/           ← this repository
├── Autonomous-Website-Lead-Scraper/
├── Meta-Agent/
└── …                          ← the other child agents
```

---

## 2. External systems

### 2.1 Integrated (code exists)

| System | Integration | Credentials | File |
| --- | --- | --- | --- |
| **ZERO app-server** (Codex) | JSON-RPC 2.0 over WebSocket, header-less (no `"jsonrpc"` field on the wire) | none in this repo | `src/zero/client.ts`, `src/zero/protocol.ts` |
| **HWD-ZERO operator API** | REST + WebSocket event stream, same origin | none — the gateway authenticates | `src/hwd/client.ts` |
| **Browser SpeechRecognition** (Web Speech API) | Speech-to-text, default `de-DE` | none | `src/voice/speechInput.ts` |
| **ZERO thread-realtime** | Text-to-speech via ZERO's experimental API; PCM16 chunks decoded into the Web Audio graph | none — ZERO owns them | `src/voice/realtimeProvider.ts` |
| **Browser speechSynthesis** | TTS fallback when ZERO realtime is unavailable | none | `src/voice/speechSynthesisProvider.ts` |
| **Web Audio API** | RMS/peak/FFT band analysis driving the smoke | n/a | `src/audio/analyser.ts` |
| **MCP servers** | **Read-only display.** `mcpServerStatus/list` is rendered as graph nodes; this repo never calls an MCP tool | n/a | `src/zero/adapter.ts`, `src/graph/transform.ts` |

There is **no** API key, token or secret anywhere in the repository. `.env.example`
states this explicitly and the code holds to it: every upstream credential
belongs to ZERO.

### 2.2 NOT FOUND — claimed integrations that do not exist here

A full-text search of the repository (excluding `node_modules`, `.git`, `dist`,
`package-lock.json`) returns **zero occurrences** for each of the following:

| Claimed system | Occurrences | Status |
| --- | --- | --- |
| Fish Audio | 0 (`fish`, `fish-audio`, `fishaudio`) | **NOT FOUND** |
| Metricool | 0 | **NOT FOUND** |
| Meta-MCP | 0 (`meta-mcp`, `meta_mcp`, `metaMcp`) | **NOT FOUND** |
| Wake word | 0 (`wakeword`, `wake_word`, `wake word`, `porcupine`, `picovoice`, `snowboy`) | **NOT FOUND** |
| Whisper | 0 | **NOT FOUND** |
| ElevenLabs | 0 | **NOT FOUND** |
| Anthropic / Claude API | 0 (`anthropic`); `claude` only as the filename `CLAUDE.md` in agent-detection heuristics | **NOT FOUND** |

If these exist in the system, they live in `HWD-ZERO` or in the agent
repositories — not in `brain-interface`. This document cannot confirm that;
those repositories were not in scope.

**Voice does exist** — but as browser SpeechRecognition + ZERO realtime /
`speechSynthesis`, not as Fish Audio. A `Meta-Agent` **repository** is in the
policy list; a **Meta-MCP integration** is not.

### 2.3 Referenced but not integrated

| System | Reality |
| --- | --- |
| **Ollama** (`127.0.0.1:11434`) | Named in `scripts/status-zero.sh` (an up/down probe), `README.md` and the architecture doc. **No client code.** The interface never talks to Ollama. |
| **OpenAI** | Appears only as ZERO's own account metadata field `requiresOpenaiAuth` (from the Codex protocol) and as a `modelProvider` string in test fixtures. **No OpenAI client.** |

---

## 3. File and folder inventory

```
brain-interface/
├── index.html                  Vite entry, mounts #root
├── package.json                2 runtime deps; scripts incl. setup:termux, doctor
├── package-lock.json           lockfile (contains android-arm64 native binaries)
├── vite.config.ts              port 3000, strictPort, vitest config
├── tsconfig.json / .app.json / .node.json
├── eslint.config.js
├── .env.example                123 lines — every variable documented
├── .gitignore
├── README.md                   387 lines
├── docs/
│   ├── ZERO_BRAIN_INTERFACE_ARCHITECTURE.md   162 lines
│   ├── TERMUX_GALAXY_S25.md                   158 lines
│   └── REPOSITORY_INVENTORY.md                this file
├── public/
│   ├── assets/brain-background.jpg   149 523 B
│   ├── assets/README.md
│   └── reference/red-background.jpg  149 523 B — byte-identical (md5 c336ab2e…)
├── scripts/                    8 files, 614 lines — bash, no sudo/systemd/Docker
├── server/                     4 files, 705 lines — plain Node ESM, no build step
├── src/                        31 files
└── tests/                      17 files, 2 145 lines, 119 tests
```

### Size by area

| Area | Files | Lines | Role |
| --- | --- | --- | --- |
| `src/zero/` | 8 | 2 393 | ZERO protocol, client, adapter, agent registry/policy/classifier/runner, router |
| `tests/` | 17 | 2 145 | Vitest suites |
| `src/graph/` | 3 | 997 | Graph model, snapshot→graph transform, radial/force layout |
| `src/state/` | 4 | 889 | React hooks + conversation state machine |
| `src/render/` | 4 | 863 | Canvas 2D renderer, filaments, smoke, palette |
| `src/voice/` | 5 | 759 | Provider abstraction, realtime, synthesis fallback, speech input |
| `server/` | 4 | 705 | Gateway + platform probe (+ `.d.mts` types) |
| `src/ui/` | 6 | 696 | React components |
| `src/styles.css` | 1 | 623 | All styling |
| `scripts/` | 8 | 614 | Setup / start / status / doctor / stop |
| `src/hwd/` | 2 | 360 | HWD-ZERO operator client + types |
| `docs/` | 2 | 320 | Architecture + Termux guide |
| `src/audio/` | 1 | 147 | Web Audio analyser |

---

## 4. What each file does

### 4.1 `server/` — the gateway (plain Node ESM, never bundled)

| File | Lines | Purpose |
| --- | --- | --- |
| `gateway.mjs` | 481 | The single origin. Serves `dist/`, proxies `/api/*` (HTTP) and `/ws/*` (raw TCP upgrade) to HWD-ZERO on `127.0.0.1:8000`. Owns token auth, rate limiting, path-traversal defence, SPA fallback, and multi-address binding. |
| `platform.mjs` | 135 | Pure functions: Termux/Android/arch detection, loopback address selection, canonical `$HOME/ZERO-WORKSPACE` discovery. No I/O beyond an injectable `existsSync`. |
| `gateway.d.mts` / `platform.d.mts` | 89 | Hand-written type declarations so TypeScript can consume the `.mjs` modules. |

**Gateway behaviour, precisely:**

- **Binding.** Default (loopback) mode binds `127.0.0.1` *and* `::1` to the same
  port; if `::1` is unavailable it prints a note and keeps serving on IPv4.
  LAN mode (`ZERO_LAN_MODE=true`) binds exactly one address, `0.0.0.0`.
- **Auth.** On loopback the local browser is trusted with no token. On the LAN
  every request needs a 256-bit token (header, cookie, or `?token=`), generated
  on first run into `.zero/gateway-token` with mode `0600`. Comparison is
  constant-time. `POST /api/gateway/session` exchanges the token for an
  `HttpOnly; SameSite=Lax` cookie.
- **Public routes.** Only `/api/gateway/health` skips auth.
- **Upstream isolation.** `authorization` and `cookie` headers are stripped
  before proxying — the gateway's token never reaches HWD-ZERO.
- **Rate limit.** Per remote address, per minute, default 240.
- **Boot page.** When `dist/index.html` is absent, a browser (`Accept: text/html`)
  gets a self-contained HTML page naming the command to run; an API client gets
  JSON `{error: "ui_not_built"}`.

### 4.2 `src/zero/` — the ZERO integration

| File | Lines | Purpose |
| --- | --- | --- |
| `protocol.ts` | 435 | Wire types + type guards for ZERO's JSON-RPC API. Defines `ZERO_METHODS` (17 methods). Unknown fields stay `unknown`. |
| `client.ts` | 365 | One WebSocket connection. `initialize`/`initialized` handshake, request→response correlation by id, notification fan-out, reconnect with backoff, 20 s default request timeout. Socket factory is injectable for tests. |
| `adapter.ts` | 468 | Reads the full entity set from ZERO into a `ZeroSnapshot`. **Every call is individually fault-tolerant**: a failure is recorded in `snapshot.capabilities[]` with its error message rather than substituted with invented data. Also converts ZERO's notification stream into `ActivityEvent`s. |
| `agentRegistry.ts` | 378 | Discovers agent repositories **through ZERO** (`command/exec` inside ZERO's sandbox) — this repository never touches a filesystem. Reads an optional `zero-agents.json` manifest plus on-disk evidence. |
| `agentPolicy.ts` | 150 | The operator-defined list (§1.2). Single source of truth for "is this repository an agent?"; graph, routing and invocation all read it. |
| `agentClassifier.ts` | 128 | Classifies a repository from evidence into `zero` / `interface` / `toolProvider` / `agent` / `library`. Only `agent` becomes an agent node. A name is explicitly not evidence. |
| `agentRunner.ts` | 247 | Real invocation: `thread/start {cwd: agent.cwd}` → `turn/start {input:[task]}` → item/turn events → `thread/unsubscribe`. Runs inside ZERO's approval and sandbox policy; never bypasses it. |
| `router.ts` | 222 | ZERO decides which agent handles a request. The transcript + real registry go into a ZERO turn constrained by a JSON output schema, returning `{agentIds, task, reply}`. On failure returns `null` — **there is no keyword-matching fallback pretending to be ZERO**. |

**ZERO methods used** (`ZERO_METHODS`): `initialize`, `initialized`,
`account/read`, `config/read`, `model/list`, `thread/list`, `thread/loaded/list`,
`thread/read`, `thread/resume`, `thread/start`, `thread/unsubscribe`,
`skills/list`, `mcpServerStatus/list`, `app/list`, `thread/realtime/start`,
`thread/realtime/appendText`, `thread/realtime/stop`.

Four further methods are used as **string literals**, not through the constant:
`turn/start` and `turn/interrupt` (requests, in `agentRunner.ts` and `router.ts`),
and the notifications `turn/started` / `turn/completed`. So the constant is not a
complete list of the wire surface this repository touches.

### 4.3 `src/graph/` — snapshot → picture

| File | Lines | Purpose |
| --- | --- | --- |
| `model.ts` | 106 | 10 node types (`zero`, `agent`, `session`, `subAgent`, `skill`, `mcpServer`, `tool`, `resource`, `app`, `toolDependency`), 6 statuses, 15 edge relationships. Node ids derived from ZERO's own identifiers so positions survive refreshes. |
| `transform.ts` | 592 | Builds the graph. Every edge is read out of ZERO's data — the header documents each mapping and its source API. |
| `layout.ts` | 299 | Hybrid radial/force layout. ZERO pinned at centre; nodes on the ring of their depth; within a ring, a force simulation in *polar* space (angular repulsion + spring toward the parent's angle). |

### 4.4 `src/render/` — Canvas 2D

`brainRenderer.ts` (419) draws in order: scrim → filaments → edges → smoke →
nodes → labels. `filaments.ts` (170) — texture bound to data: dendrite count
comes from a node's real graph degree, and a filament only exists where a real
edge does; all parameters hash deterministically from ids so strands do not
flicker. `smoke.ts` (159) — every particle property derives from the measured
audio signal (amplitude → emission/opacity, low band → density, high band →
turbulence, onset → burst). `palette.ts` (115) — node bodies stay black; only
rims glow, coloured by department.

### 4.5 `src/voice/` and `src/audio/`

`provider.ts` (97) defines the swappable `VoiceProvider` interface and the ZERO
persona prompt. `realtimeProvider.ts` (159) uses ZERO's realtime API and
schedules the returned PCM16 through the Web Audio graph, so the smoke analyses
exactly what the user hears. `speechSynthesisProvider.ts` (130) is the fallback;
it cannot route into Web Audio, so it drives the smoke from real `boundary`
events, and — documented as an estimate, not a measurement — falls back to
cadence estimated from the text when an engine emits none. `speechInput.ts` (212)
owns the microphone: opened only after an explicit user action, every stream and
track released on stop. `analyser.ts` (147) computes RMS/peak/band energies.

### 4.6 `src/state/`

`useZeroBrain.ts` (264) owns client, adapter, transform, activity and voice, with
full cleanup on unmount. `useZeroVoiceLoop.ts` (255) owns the spoken loop and the
microphone lifecycle. `conversation.ts` (168) is the state machine
(`idle → listening → processing → agentActive → speaking`, plus `error`); its
header states it contains no fallback that pretends to be ZERO. `useOperator.ts`
(202) polls HWD-ZERO and holds up to 200 events.

### 4.7 `src/hwd/` — the HWD-ZERO operator client

`client.ts` (238) — same-origin, no configurable host, no embedded credential.
Endpoints used:

| Method | Endpoint |
| --- | --- |
| `health()` | `GET /api/health` |
| `state()` | `GET /api/state` |
| `registry()` | `GET /api/agents` |
| `tasks()` | `GET /api/tasks` |
| `missions()` | `GET /api/missions` |
| `approvals()` | `GET /api/approvals` |
| `journal(id, limit)` | `GET /api/missions/{id}/journal?limit=` |
| `startMission(task)` | `POST /api/missions` |
| `requestApproval(id, gate)` | `POST /api/approvals` |
| `grantApproval(ticket)` | `POST /api/approvals/{ticket_id}/grant` |
| `setSafeMode(enabled)` | `POST /api/control/safe-mode` |
| `connectEvents()` | `WS /ws/events` (auto-reconnect) |

The header states the client "reads and requests, never decides": no retry that
re-runs a mission, no self-granted approval.

### 4.8 `src/ui/`

`BrainStage.tsx` (193) full-viewport canvas + hit testing; `DetailPanel.tsx` (156)
selected-node detail and the per-agent task input; `OperatorPanel.tsx` (146)
missions + approval gates; `VoiceBar.tsx` (91) mic control, transcript, answer;
`StatusBar.tsx` (75) one quiet line, explicitly not a dashboard;
`NodeTooltip.tsx` (35).

### 4.9 `scripts/` — bash, Termux-first

| Script | Lines | Purpose |
| --- | --- | --- |
| `lib-zero.sh` | 233 | Shared helpers: OS/Termux/arch detection, workspace discovery, LAN IP, RAM, port and dual-family loopback probes, wake lock, build, `.env.local` editing, native-toolchain checks and repairs. |
| `setup-termux.sh` | 99 | 5-stage Termux install: `pkg` → npm deps → native toolchain verify/repair → config → build. No sudo, systemd or Docker. |
| `zero-doctor.sh` | 115 | Read-only diagnosis across host, workspace, build, both loopback families, gateway health and HWD-ZERO; names the next command. Repairs nothing. |
| `setup-zero.sh` | 30 | Desktop setup; `exec`s `setup-termux.sh` on Termux. |
| `start-zero.sh` | 43 | Loopback-only start → `http://localhost:3000`. Wake lock + cleanup trap. |
| `start-zero-lan.sh` | 52 | LAN start with preflight (RAM, port, HWD-ZERO reachability) and token URL. |
| `status-zero.sh` | 25 | What is up: host, workspace, bundle, gateway, loopback families, HWD-ZERO, Ollama. |
| `stop-zero.sh` | 17 | Stops only the gateway these scripts started. |

---

## 5. How the parts interact

### 5.1 Two backends, two transports — the key structural fact

```
                    Browser (one origin: http://localhost:3000)
                    │
        ┌───────────┴────────────┐
        │                        │
   same origin              DIRECT WebSocket
   /api, /ws/events         (not proxied)
        │                        │
        ▼                        ▼
   ZERO GATEWAY  ──────►  ws://127.0.0.1:8787
   :3000 (127.0.0.1,      ZERO app-server (Codex)
          ::1)            → structural graph, agents,
        │                   routing, agent runs, realtime voice
        ▼
   HWD-ZERO  127.0.0.1:8000
   → missions, approvals, safe mode, operator event stream
```

- The **gateway proxies only** `/api/*` and `/ws/*` → `127.0.0.1:8000` (HWD-ZERO).
- The **ZERO app-server on `:8787` is never proxied.** `vite.config.ts` states
  this deliberately: "the browser talks to it directly over the WebSocket URL
  from the env."

**Consequence, observed not fixed:** `VITE_ZERO_WS_URL` is a *build-time* Vite
variable baked into the bundle, defaulting to `ws://127.0.0.1:8787`. In LAN mode
a second device loads the bundle from the host but then resolves
`ws://127.0.0.1:8787` against **its own** loopback, where no ZERO runs. So over
LAN the operator panel (HWD-ZERO, proxied) works while the ZERO structural graph
and voice do not, unless the bundle was **built** with `VITE_ZERO_WS_URL` set to
the host's LAN address. Same-device Termux operation is unaffected — there
`127.0.0.1` is correct. This is a factual observation about the current code; no
change was made.

### 5.2 The spoken loop

```
microphone (explicit user action)
  → WebSpeechInputProvider           src/voice/speechInput.ts
  → transcript
  → routeTask()  — ZERO decides, JSON-schema-constrained turn   src/zero/router.ts
  → AgentRunner  — thread/start in the agent's cwd + turn/start  src/zero/agentRunner.ts
  → composeAnswer()                  src/state/conversation.ts
  → VoiceProvider.speak()            realtime, else speechSynthesis
  → Web Audio analyser → smoke       src/audio/analyser.ts → src/render/smoke.ts
```

Agent activity feeds back into the picture: `App.tsx` writes a pulse into
`pulsesRef` on start/finish, so the ZERO→agent edge lights up exactly while that
agent's thread runs.

### 5.3 Snapshot → graph

`ZeroClient` → `ZeroDataAdapter.loadSnapshot()` (parallel calls, each
individually fault-tolerant) → `ZeroSnapshot` → `buildGraph()` →
`BrainLayout` → `drawBrain()`. Failed calls become entries in
`snapshot.capabilities[]` and surface as "data notes" in the status line.

### 5.4 Configuration split — important

Two disjoint variable families:

| Prefix | Read by | When |
| --- | --- | --- |
| `VITE_ZERO_*` | the browser bundle (`src/config.ts`) | **build time** — changing one requires `npm run build` |
| `ZERO_*` | the gateway and scripts (`server/gateway.mjs`, `scripts/`) | **runtime** |

---

## 6. What is productive

Assessed as productive where real code exists, it is reachable from the entry
point, and it is covered by passing tests or was executed during this session.

| Area | Status | Evidence |
| --- | --- | --- |
| Gateway (serve, proxy, auth, rate limit, traversal defence, dual-stack bind, boot page) | **Productive** | 26 tests; served the built bundle at `localhost:3000` in this session |
| Platform / workspace detection | **Productive** | 12 tests |
| ZERO client (handshake, correlation, reconnect, timeout) | **Productive** | 4 tests |
| Adapter + capability degradation | **Productive** | 3 tests |
| Graph transform | **Productive** | 10 tests |
| Layout | **Productive** | 7 tests |
| Agent registry / policy / classifier / runner / router | **Productive** | 27 tests |
| Conversation state machine | **Productive** | 4 tests |
| HWD-ZERO operator client | **Productive** | 7 tests |
| Voice service + provider ranking | **Productive** | 4 tests |
| Audio analyser + smoke params | **Productive** | 5 tests |
| Filaments | **Productive** | 3 tests |
| Build pipeline | **Productive** | `tsc -b && vite build` → 62 modules, 282 kB JS |
| Shell scripts | **Productive** | `zero-doctor.sh`, `status-zero.sh`, `start-zero.sh` executed successfully |
| React UI, hooks, canvas renderer | **Present, not automatically tested** — see §7.2 | builds and renders; `vitest` runs in `node` environment |

**End-to-end verified in this session:** `npm run build` → `scripts/start-zero.sh`
→ `curl http://localhost:3000` returned the real built interface
(`<title>Brain Interface</title>`), and `/api/gateway/health` answered.

**Not verifiable here:** anything requiring a live ZERO app-server or a live
HWD-ZERO. Neither backend was running, so the actual JSON-RPC exchange, agent
invocation, routing and realtime voice are **UNKNOWN** at runtime — they are
covered only by unit tests against injected fakes.

---

## 7. Stubs, gaps and inconsistencies

### 7.1 Stubs in production code — none found

A full-text search for `TODO`, `FIXME`, `XXX`, `HACK`, `stub`, `not implemented`,
`unimplemented`, `placeholder`, `coming soon`, `mock` across `src/`, `server/`,
`scripts/` and `tests/` returns only:

- `src/ui/VoiceBar.tsx:76` and `src/ui/DetailPanel.tsx:128` — HTML input
  `placeholder` attributes (normal UI text).
- `tests/voiceService.test.ts` — a deliberate Web Audio test stub.

**There is no unimplemented function, no dead branch marked as pending, and no
fake data path in production code.**

### 7.2 Test coverage gaps

`vite.config.ts` sets `test.environment: 'node'` and
`include: ['tests/**/*.test.ts']` — no DOM environment, and `.tsx` is not
matched. Consequently these modules have **no direct test**:

`App`, `main`, `ui/BrainStage`, `ui/DetailPanel`, `ui/NodeTooltip`,
`ui/OperatorPanel`, `ui/StatusBar`, `ui/VoiceBar`, `state/useZeroBrain`,
`state/useZeroVoiceLoop`, `state/useOperator`, `render/brainRenderer`,
`render/palette`, `voice/realtimeProvider`, `voice/speechInput`, `zero/protocol`.

`jsdom` **is** installed as a devDependency but is not configured for any suite.
Whether that is intentional is **UNKNOWN**.

### 7.3 Documentation inconsistencies found

| Where | Says | Reality |
| --- | --- | --- |
| `README.md:151` | `VITE_ZERO_BACKGROUND_IMAGE` default `/assets/brain-background.png` | Actual default is `/reference/red-background.jpg` (`src/config.ts:117`, `.env.example:31`), and the shipped file is `.jpg`, not `.png` |
| `README.md` env table | omits `VITE_ZERO_SPEECH_PROVIDER`, `VITE_ZERO_SPEECH_LANGUAGE`, `VITE_ZERO_AGENT_*`, `VITE_ZERO_EXEC_SANDBOX` | all documented in `.env.example` |

Both were left unchanged — this mission is inventory, not repair.

### 7.4 Duplicate asset

`public/assets/brain-background.jpg` and `public/reference/red-background.jpg`
are byte-identical (md5 `c336ab2e27e17f9dea24061b344b391a`, 149 523 B each).
Only the `reference/` copy is referenced by the default config. Whether the
duplication is intentional is **UNKNOWN**.

### 7.5 Absent infrastructure

| Missing | Status |
| --- | --- |
| `.github/` — CI workflows, PR/issue templates | **NOT FOUND** |
| `CONTRIBUTING.md`, `LICENSE`, `CHANGELOG.md` | **NOT FOUND** |
| `CLAUDE.md` / `AGENTS.md` in this repository | **NOT FOUND** |
| `zero-agents.json` manifest | **NOT FOUND** here — expected at `<VITE_ZERO_AGENT_ROOT>/zero-agents.json`, i.e. in the workspace, not in this repository |
| Coverage reporting | **NOT FOUND** — `vitest` runs without a coverage provider |

`lint`, `typecheck` and `test` scripts all exist and all pass, but nothing
enforces them automatically on push.
