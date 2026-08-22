# ZERO Brain Interface — Architecture

## Roles

| Component | Role |
| --- | --- |
| **HWD-ZERO** | The operator, and the only runtime: reasoning, memory, missions, policy engine, permission engine, capability broker, agent router, verifier, event source, voice |
| **brain-interface** | Visual / voice / mission-input / approval / monitoring surface — never the orchestrator |
| **ZERO Gateway** | One origin on port 3000: serves the interface, proxies `/api`, `/ws/events` and `/ws/voice` to HWD-ZERO, guards LAN access |
| **Child agents** | Eight repositories HWD-ZERO runs work in |

## Request path

```
USER  (laptop browser  /  Samsung Galaxy)
  ↓  http://127.0.0.1:3000   |   http://<laptop-lan-ip>:3000
ZERO GATEWAY :3000                     ← the only port on the LAN
  ├── /              the built brain interface
  ├── /api/*    ───┐
  ├── /ws/events───┤ (loopback only)
  └── /ws/voice ───┤
                   ▼
HWD-ZERO  127.0.0.1:8000
  ↓ ZeroSession
  ↓ Memory · Reasoning · Policy Engine · Capability Broker
  ↓ Permission Engine   → approval gate → a human decides, on the laptop or the phone
  ↓ Agent Registry → Agent Adapter → CHILD AGENT  (127.0.0.1:<port>, never on the LAN)
  ↓ Verifier
  ↓ TTS
  ↓ /ws/voice  →  AudioContext → AnalyserNode → the 3D brain
USER
```

**The frontend controls nothing.** It has no shell, no credentials, no agent
process handle and no router. Every action is a request HWD-ZERO is free to
refuse. There is no second ZERO runtime in the browser — the only thing the
interface decides is what to draw.

## The brain

Real WebGL geometry, built with three.js and react-three-fiber. Nothing is a
screenshot, a sprite sheet or a canvas drawing of a graph.

```
ZERO core          an icosahedron displaced by layered noise
                   obsidian body · metallic sheen · internal light veins
                   · particle halo · organic pulse
  │
  ├── axon         a curved filament bundle per child agent
  │     │          (several strands, deterministic offsets — tissue, not wires)
  │     └── hub    the agent, obsidian with a department-coloured rim
  │           │
  │           └── dendrite → terminal   one real capability each
  │                                     (a strength, or a gate that needs a human)
  ├── energy       packets travelling along the curves, in the vertex shader
  ├── smoke        a particle plume out of the core, driven by the TTS signal
  └── sparks       the high band of the voice, made visible
```

| Layer | Source of truth |
| --- | --- |
| which clusters exist | `GET /api/agents`, filtered by `src/zero/agentPolicy.ts` |
| which cluster is lit | `/ws/events` — folded in `src/runtime/agentActivity.ts` |
| which way energy flows | `agent.started` → outward, `agent.completed` → back to ZERO |
| the core's colour | the runtime state (`src/runtime/states.ts`) |
| the core's scale, pulse, veins | the measured audio signal — never a timer |

### How it stays fast

- **One data texture** carries per-agent activity to every shader, so no shader
  needs a uniform array or a per-frame attribute rewrite.
- **Instancing**: every hub and terminal is one instanced mesh, one draw call.
- **The energy system is entirely GPU**: each packet carries its own Bézier
  control points, so animating it costs nothing on the CPU.
- **Particle pooling**: smoke and sparks are fixed pools whose trajectories are
  computed from a seed and the clock; nothing is allocated per frame.
- **No React render per frame.** React owns structure; the render loop reads
  motion from a mutable signal object (`src/three/signals.ts`).
- **Adaptive DPR and LOD** (`src/three/quality.ts`): the device picks a tier,
  then a governor watches real frame times and sheds pixel ratio — and, if that
  is not enough, the tier — until the target frame rate holds.
- **Limited bloom**: one pass, high threshold, and only on the desktop tier.
- **Lazy 3D**: three.js is a separate chunk loaded behind the HUD, so the
  operator's state and the approval gate are usable before the engine lands.

## Runtime states

`IDLE · LISTENING · FINALIZING · THINKING · PLANNING · AWAITING_APPROVAL ·
EXECUTING · VERIFYING · SPEAKING · ERROR · SAFE_MODE`

Derived by one pure function (`deriveRuntimeState`) from real signals only:
the operator's `safe_mode` flag, the gates that are genuinely open, the events
on `/ws/events`, and local facts about this browser (the microphone is open,
audio is playing). Priority, highest first:

```
SAFE_MODE  >  ERROR  >  AWAITING_APPROVAL  >  LISTENING  >  FINALIZING
           >  SPEAKING  >  VERIFYING > EXECUTING > PLANNING > THINKING  >  IDLE
```

A state HWD-ZERO reports itself is adopted for the mission tier, but it can
never override the kill switch, an open gate, or the microphone.

## Voice

```
microphone → SpeechRecognition → partial transcript ──▶ /ws/voice
                                → final transcript   ──▶ /ws/voice  (the handoff)
HWD-ZERO   → voice.response (text) + voice.audio (PCM16)
           → AudioEngine → AnalyserNode → RMS · low · mid · high · transient
                                        → core scale, veins, filaments, sparks, smoke
```

Three tiers, chosen from what the operator actually offers, and always named in
the HUD:

| Tier | Audio | Reaction |
| --- | --- | --- |
| `stream` | PCM16 on `/ws/voice` | measured |
| `http` | `POST /api/voice/tts`, decoded into the same graph | measured |
| `synthesis` | the browser voice | **estimated** from word timing, and labelled as such |

See [`BACKEND_CONTRACT.md`](./BACKEND_CONTRACT.md) for the frame protocol and
every degradation path.

## Child agents

```
HWD-ZERO
├── Autonomous-Website-Lead-Scraper   acquisition
├── Meta-Agent                        orchestration
├── Auto-Agent-Install-Helper         infrastructure
├── Google-Bewertungen-AI-Agent       reputation
├── Insta-Agent                       social
├── Autonomer-Website-Outreach-Agent  outreach
├── SEO                               seo
└── Funnel                            funnel
```

Defined in `src/zero/agentPolicy.ts`. `parent` is always HWD-ZERO.

### Never registered

`Website-Building`, `Loop-Engeneering`, `Prompt-Optimizer`, `more-available-tokens`.

The exclusion is applied **before** the graph, before the cluster layout and
before anything is rendered — a registry entry cannot re-enable them, whether
it names them as an `id`, a `repo` or a `role`. `tests/brainGraph.test.ts`
asserts this per repository, and the interface still lists them as *excluded by
policy* rather than dropping them silently.

`HWD-ZERO` and `brain-interface` are recognised as system repositories and are
never child agents.

## Network model

| Service | Address | On the LAN? |
| --- | --- | --- |
| ZERO Gateway | `0.0.0.0:3000` only with `ZERO_LAN_MODE=true` | yes, with a token |
| HWD-ZERO API | `127.0.0.1:8000` | no |
| Ollama | `127.0.0.1:11434` | no |
| Child agents | `127.0.0.1:<port>` | no |

No tunnels, no UPnP, no port forwarding. LAN is the boundary.

Only `/ws/events` and `/ws/voice` are accepted as upgrades; any other path is
refused at the gateway rather than forwarded upstream.

## Authentication

On first start the gateway generates a 256-bit token, writes it to
`.zero/gateway-token` with `0600` and prints a pairing URL. On loopback the
laptop's own browser is trusted; every LAN request needs the token (header,
cookie or `?token=`). Opening the pairing link sets the cookie, which is what
authenticates the WebSocket handshakes too — a browser cannot set headers on
one. `POST /api/gateway/session` exchanges the token for that cookie
explicitly. Requests are rate limited per client address. The token is never
part of the frontend bundle.

## Failure behaviour

The gateway does not depend on HWD-ZERO being up:

- `/api/gateway/health` always answers, and reports whether the operator does.
- `/api/*` returns `502 zero_api_unreachable` with the real reason.
- A WebSocket upgrade to a dead operator gets a `502` status line rather than a
  silent socket destroy, so the client backs off instead of reconnecting hot.
- The interface still loads, still shows the brain, and says
  *HWD-ZERO offline* — with the kill switch disabled, because the kill switch
  lives in the operator.

## Where the code is

```
server/gateway.mjs        the one origin: static, /api, /ws/events, /ws/voice, LAN token
src/hwd/                  the operator client: REST, the event stream, the voice channel
src/runtime/              runtime states + the fold of events into agent activity
src/brain/                the brain model: policy → clusters → deterministic 3D layout
src/three/                the WebGL layer: core, clusters, filaments, energy, smoke, sparks
src/audio/                the analyser and the playback engine (the AnalyserNode lives here)
src/voice/                microphone, speech-to-text, the three TTS tiers
src/state/                the React bindings for the operator and the voice session
src/ui/                   the HUD: state, missions, approval gate, agent detail, system bar
src/zero/agentPolicy.ts   which repositories may be agents, and which never can
```
