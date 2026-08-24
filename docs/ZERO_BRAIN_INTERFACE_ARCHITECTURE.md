# ZERO Brain Interface — Architecture

## Roles

| Component | Role |
| --- | --- |
| **HWD-ZERO** | Central operator: reasoning, memory, missions, policy engine, permission engine, capability broker, agent router, verifier, event source |
| **brain-interface** | Visual / voice / mission-input / approval / monitoring surface — never the orchestrator |
| **ZERO Gateway** | One origin on port 3000: serves the interface, proxies `/api` and `/ws` to HWD-ZERO, guards LAN access |
| **Child agents** | Eight repositories HWD-ZERO runs work in |

## Request path

```
USER  (laptop browser  /  Samsung Galaxy S25 Ultra)
  ↓  http://127.0.0.1:3000   |   http://<laptop-lan-ip>:3000
ZERO GATEWAY :3000                     ← the only port on the LAN
  ├── /            static brain interface
  ├── /api/*  ───┐
  └── /ws/*   ───┤ (loopback only)
                 ▼
HWD-ZERO  127.0.0.1:8000
  ↓ ZeroSession
  ↓ Memory
  ↓ Reasoning              (ModelProvider → Ollama 127.0.0.1:11434, cloud only by policy)
  ↓ Policy Engine
  ↓ Capability Broker
  ↓ Permission Engine      → approval gate → human decision on laptop or phone
  ↓ Agent Registry
  ↓ Agent Adapter
  ↓ CHILD AGENT            127.0.0.1:<agent-port>, never on the LAN
  ↓ Verifier
  ↓ ZERO
  ↓ TTS
  ↓ Web Audio analyser
  ↓ 3D / canvas brain
USER
```

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

The exclusion is applied **before** classification, before the graph, before the
routing roster and before the invocation layer — a manifest cannot re-enable
them either. `tests/agentRegistry.test.ts` asserts this per repository.

`HWD-ZERO` and `brain-interface` are detected by evidence (ZERO runtime markers,
frontend markers) and are never child agents.

## Discovery

Discovery runs **through ZERO**, not through the browser: one read-only
`command/exec` under `VITE_ZERO_AGENT_ROOT` returns, per repository, the path,
git remote, branch, README headline and the evidence used for classification
(agent instructions, entrypoints, MCP markers, frontend markers, ZERO runtime
markers). An optional `zero-agents.json` manifest in the same root adds role,
capabilities, inputs and outputs.

The result feeds the graph *and* ZERO's routing roster, so the picture and the
orchestration cannot disagree.

## Network model

| Service | Address | On the LAN? |
| --- | --- | --- |
| ZERO Gateway | `127.0.0.1:3000` + `[::1]:3000` | no |
| ZERO Gateway | `0.0.0.0:3000` only with `ZERO_LAN_MODE=true` | yes, with a token |
| HWD-ZERO API | `127.0.0.1:8000` | no |
| Ollama | `127.0.0.1:11434` | no |
| Child agents | `127.0.0.1:<port>` | no |

No tunnels, no UPnP, no port forwarding. LAN is the boundary.

The gateway binds both loopback families in its default mode. That is what
makes `http://localhost:3000` work in the Android browser when the whole stack
runs on the same phone under Termux: Android resolves `localhost` to `::1`
before `127.0.0.1`, so an IPv4-only bind can be unreachable from the very
device that is serving it. Both addresses are loopback — this widens nothing.
LAN mode is unchanged and remains a single, explicit `0.0.0.0` bind; it is not
needed for same-device operation.

## Authentication

On first start the gateway generates a 256-bit token, writes it to
`.zero/gateway-token` with `0600` and prints a pairing URL. On loopback the
device's own browser is trusted — including the phone's, when ZERO runs on it
under Termux; every LAN request needs the token (header,
cookie or `?token=`). `POST /api/gateway/session` exchanges the token for a
cookie so the phone stays paired. Requests are rate limited per client address.
The token is never part of the frontend bundle.

## The operator's API

HWD-ZERO serves it with `zero serve` (`zero/api/` in that repository); the
interface reads it through the gateway, same origin, no address and no
credential in the bundle. `src/hwd/client.ts` is the whole client surface.

| Method | Path | Used for |
| --- | --- | --- |
| GET | `/api/state` | brain revision, mission counts, SAFE_MODE |
| GET | `/api/agents` | `agents/registry.yaml`, verbatim |
| GET | `/api/tasks` | contracts that can be started, and their gates |
| GET | `/api/missions`, `/api/missions/<id>/journal` | mission list and audit trail |
| GET | `/api/approvals` | gates a mission is genuinely stopped on |
| GET | `/ws/events` | the live stream |
| POST | `/api/missions` | start a mission from a contract ZERO holds |
| POST | `/api/approvals` → `/api/approvals/<id>/grant` | mint and redeem one approval ticket |
| POST | `/api/control/safe-mode` | the kill switch |

### Approvals

The interface cannot approve anything by asserting it. It asks the operator for
a ticket bound to that mission, that gate and a digest of exactly what the human
was shown, then redeems that one ticket — single use, expiring, re-checked
server-side. A grant clears one gate for one resume; it never edits contract
permissions, so the same action asks again next time. There is no deny button:
an unapproved gate stays closed, because denial is the default.

## Event contract

The interface consumes these events from `/ws/events` and renders them as ZERO
state, agent activity and approval gates:

```
zero.state.changed | zero.listening | zero.thinking | zero.planning | zero.speaking
mission.created | mission.planning | mission.executing | mission.verifying
mission.completed | mission.failed
agent.started | agent.activity | agent.completed | agent.error
approval.required | approval.approved | approval.denied
policy.suggested | policy.changed
```

Each event carries `event_id`, `timestamp`, `mission_id`, `agent_id`, `type`,
`payload`.

## Voice

```
microphone → speech-to-text → the same input pipeline as typed text → HWD-ZERO
HWD-ZERO → answer → TTS → AudioContext → AnalyserNode → brain + smoke
```

States: `IDLE`, `LISTENING`, `PROCESSING`, `AGENT_ACTIVE`, `SPEAKING`, `ERROR`.
Every visual reaction is driven by measured audio (RMS, band energy, onsets) or
by a real event — never by a timer and never by text length.
