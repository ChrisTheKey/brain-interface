# ZERO Brain Interface

The visual, spoken surface of **HWD-ZERO**.

A dark, dense, three-dimensional neural brain: ZERO at the centre as a
dominant obsidian core with light running under its surface, its child agents
around it as neural clusters, and real energy travelling along the paths that
are actually working. You speak to it, it hands what you said to HWD-ZERO, and
it reacts to the real audio of the answer.

It is an interface and nothing else. HWD-ZERO is the runtime. This app holds no
credentials, touches no shell, starts no process and routes nothing — every
action is a request the operator is free to refuse.

```
USER
 ↓
brain-interface :3000            ← this repository
 ↓  /api  ·  /ws/events  ·  /ws/voice
HWD-ZERO
 ↓
ZeroSession → Agents · Memory · Missions · Permissions
```

---

## What it does

| | |
| --- | --- |
| **3D brain** | Real three.js / react-three-fiber geometry. Displaced icosahedral core, instanced agent clusters, curved filament bundles, GPU energy packets, audio-driven smoke and sparks. No screenshot, no React Flow, no static image. |
| **Agent clusters** | Built from the live agent registry (`GET /api/agents`), coloured by department, filtered by the operator's own agent policy. Each terminal is one real capability the operator reported. |
| **Live events** | `/ws/events` decides which cluster is lit and which way energy flows: `agent.started` pushes it out, `agent.completed` brings it back. |
| **Eleven runtime states** | `IDLE · LISTENING · FINALIZING · THINKING · PLANNING · AWAITING_APPROVAL · EXECUTING · VERIFYING · SPEAKING · ERROR · SAFE_MODE`, all derived from real signals. |
| **Voice** | Real microphone, live partial transcript, final transcript, handed to HWD-ZERO over `/ws/voice`, and the real answer shown and spoken. |
| **Audio reactivity** | The TTS audio itself runs through a Web Audio `AnalyserNode`. RMS scales the core, the low band is its pulse and the smoke's density, the mid band lights the filaments, the high band throws sparks, transients burst energy. |
| **Approval gates** | The one element allowed to demand attention. It shows exactly what HWD-ZERO is stopped on, and approving mints and redeems a single-use ticket. |
| **Kill switch** | SAFE MODE, set in HWD-ZERO. Disabled when the operator is unreachable, because that is where the switch lives. |
| **Mobile + desktop** | One bundle. Mobile-first HUD inside the safe area with the gate at thumb reach; adaptive render quality that measures the device and then corrects from real frame times. |

---

## Requirements

- Node **≥ 20.19** (laptop, or Termux on the phone: `pkg install nodejs-lts`)
- A browser with WebGL. Without it the brain says so and everything else keeps
  working.
- **HWD-ZERO** running and serving its API on `127.0.0.1:8000`
  (`zero serve`). Without it the interface still loads and reports the operator
  as offline.

## Install and run

```bash
npm install
scripts/zero.sh              # laptop only   → http://127.0.0.1:3000
scripts/zero.sh --lan        # laptop + phone, prints a pairing URL with a token
```

`scripts/zero.sh` installs what is missing, rebuilds what is stale, starts the
gateway, waits until it actually answers, and shuts it down cleanly on Ctrl-C.

Other scripts:

| Script | What it does |
| --- | --- |
| `scripts/setup-zero.sh` | one-time: install, build, create `.env.local` |
| `scripts/start-zero.sh` | gateway, loopback only |
| `scripts/start-zero-lan.sh` | gateway on the LAN, token required |
| `scripts/status-zero.sh` | what is actually up right now |
| `scripts/stop-zero.sh` | stops the gateway these scripts started |

npm equivalents: `npm run zero`, `npm run zero:lan`, `npm run status`,
`npm run stop`, `npm run setup`.

## Laptop and phone

The gateway is the only thing that ever listens on the network, and only with
`ZERO_LAN_MODE=true`. HWD-ZERO, Ollama and every child agent stay on loopback.

```
scripts/zero.sh --lan
→ LAPTOP:  http://127.0.0.1:3000
→ MOBILE:  http://192.168.1.42:3000/?token=…
```

Opening the pairing URL on the Galaxy stores the token as a cookie, which is
what authenticates the WebSocket handshakes too. The token is generated on
first run, stored at `.zero/gateway-token` with `0600`, and never appears in
the bundle. No tunnels, no UPnP, no port forwarding — LAN is the boundary.

**Termux.** Everything is pure Node with no native modules, so the same scripts
run on the phone. Use `termux-wake-lock` so Android does not suspend the
gateway.

## Development

```bash
# one shell: the gateway on 3001, proxied to HWD-ZERO
ZERO_UI_PORT=3001 npm run gateway

# another: Vite on 3000, proxying /api and /ws to the gateway
npm run dev
```

The dev server proxies `/api`, `/ws/events` and `/ws/voice` to the gateway, so
the app is same-origin in development exactly as it is in production.

## Configuration

Copy `.env.example` to `.env.local`. There is **no backend address to set** —
the gateway is the origin. Everything in it is presentation and local voice
tuning; see the file itself for the full list.

The ones worth knowing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_ZERO_SPEECH_LANGUAGE` | `de-DE` | recognition language |
| `VITE_ZERO_VOICE_MODE` | `auto` | `stream` / `http` / `synthesis` / `none` |
| `VITE_ZERO_RENDER_QUALITY` | `auto` | pin a tier instead of measuring the device |
| `VITE_ZERO_BLOOM` | `true` | allow the bloom pass (desktop tier only) |
| `ZERO_UI_PORT` | `3000` | the one origin |
| `ZERO_API_URL` | `http://127.0.0.1:8000` | HWD-ZERO, loopback only |
| `ZERO_LAN_MODE` | `false` | bind `0.0.0.0` so the phone can reach it |

## The agent network

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

**Never registered, never routed, never rendered:** `Website-Building`,
`Loop-Engeneering`, `Prompt-Optimizer`, `more-available-tokens`. The exclusion
runs before the graph is built and cannot be undone by a registry entry —
whether it arrives as an `id`, a `repo` or a `role`. They are still listed as
*excluded by policy* rather than silently dropped, and there is a test per
repository.

The list lives in `src/zero/agentPolicy.ts`. It is the operator's decision, not
a heuristic and not a model's.

## Speaking to ZERO

Press **speak**. The browser's `SpeechRecognition` engine transcribes; the
partial transcript is shown as *hearing* and streamed to HWD-ZERO, and when the
sentence closes the final transcript is shown as *said* and handed over. ZERO's
answer comes back as text and as audio.

The two transcripts are deliberately separate: a partial is the engine still
thinking, a final is the sentence HWD-ZERO was actually given.

Typing does the same thing through the same pipeline.

## The voice, and when the brain is honest about it

The smoke, the core and the filaments are driven by the **measured** audio
signal — an `AnalyserNode` sitting between the audio sources and the speakers.
It reacts to exactly what you hear, never to a "voice is playing" flag and never
to the length of a sentence.

Three tiers, chosen from what HWD-ZERO actually offers:

1. **`stream`** — PCM16 frames on `/ws/voice`. Measured. The intended path.
2. **`http`** — `POST /api/voice/tts`, decoded into the same graph. Measured.
3. **`synthesis`** — the browser's own voice. Platform TTS **cannot** be routed
   through Web Audio, so there is no signal to analyse. The reaction is then
   *estimated* from word-boundary timing, and the HUD says
   **“reaction estimated, not measured”** for as long as that is true.

ZERO's voice character (calm, low, measured, unhurried) is an original persona
defined in `src/voice/provider.ts` — a description, not an imitation of anyone.

## Missing backend contracts

Whatever HWD-ZERO does not provide is degraded visibly and named in the system
bar, with the exact method and path, rather than filled in. The full contract —
including the `/ws/voice` frame protocol and every fallback — is in
[`docs/BACKEND_CONTRACT.md`](docs/BACKEND_CONTRACT.md).

If HWD-ZERO is not running at all: the gateway still serves the interface, the
brain still renders, and the HUD says *HWD-ZERO offline*.

## The plate

The background is `public/reference/red-background.jpg`, rendered inside the 3D
scene so it takes part in the depth and the bloom, with a copy behind the canvas
as the fallback while the texture decodes. Replace the file — or point
`VITE_ZERO_BACKGROUND_IMAGE` elsewhere — to change it.

## Performance

Desktop targets ~60 fps, mobile a stable 30+. Instancing, particle pooling,
geometry reuse, a shared activity texture, GPU-side energy, adaptive DPR and
LOD, one limited bloom pass on the desktop tier only, and **no React state
update per frame** — the render loop reads motion from a mutable signal object
outside React entirely.

The device picks a starting tier; a governor then watches real frame times and
sheds pixel ratio, and if that is not enough the tier itself, until the target
holds. It never promotes on a single good window, because a brain that
oscillates between two qualities is worse than one that stays at the lower.

## Build, lint, test

```bash
npm run build       # tsc -b && vite build
npm run lint
npm run typecheck
npm test
```

The suite covers the brain graph and the policy exclusions, the 3D layout and
geometry buffers, both WebSockets (the voice protocol and the gateway's upgrade
handling), the voice tiers and transcript merging, the approval flow, the mobile
HUD and the quality governor, and all eleven runtime states — plus an
end-to-end mount of the whole interface against a stubbed operator.

## Architecture

[`docs/ZERO_BRAIN_INTERFACE_ARCHITECTURE.md`](docs/ZERO_BRAIN_INTERFACE_ARCHITECTURE.md)
— roles, the request path, how the brain is built, and where each file lives.
