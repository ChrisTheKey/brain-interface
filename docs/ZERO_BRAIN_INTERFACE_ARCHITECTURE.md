# ZERO Brain Interface — Architecture

How a spoken sentence becomes an agent doing real work, and where it is stopped
if it should be.

## The hierarchy

```
ME
 └── ZERO / HWD-ZERO          the operator: reasons, plans, rules, verifies
      └── MISSION SYSTEM      plans over child agents, resumable, persisted
           └── POLICY + PERMISSION ENGINE
                └── CHILD AGENTS
                     └── TOOLS / EXTERNAL SERVICES
```

The language model is not ZERO. The interface is not ZERO. A child agent is not
ZERO. **HWD-ZERO is the operator runtime**, and everything else either serves it
or is driven by it.

## The path a request takes

```
        Laptop browser                    Samsung Galaxy S25 Ultra
              │                                     │
              │  http://127.0.0.1:3000              │  http://<laptop-lan-ip>:3000
              └──────────────┬──────────────────────┘
                             ▼
                   ZERO GATEWAY  :3000            the only process on the LAN
                   ├── /            the built interface
                   ├── /api/*       proxied to the operator
                   └── /ws/events   proxied to the operator
                             │
                             ▼  127.0.0.1:8000
                       HWD-ZERO — zero/ops/
                             │
      ┌──────────────────────┼──────────────────────┐
      ▼                      ▼                      ▼
   Memory                Reasoning              Agent Registry
   (mission store,       (ZeroSession,          (agents/child-agents.yaml
    audit, policy)        planner)               + each repo's agent.yaml)
                             │
                             ▼
                    Capability Broker      known capability? agent holds it?
                             │
                             ▼
                    Permission Engine      policy allowed / approval / denied
                             │
                             ├──── approval required ──▶ operator's phone
                             │                              │
                             ▼                              ▼
                      Agent Adapter  ◀────────── single-use approval token
                             │
                             ▼
                        Child Agent          own repository, no shell, bounded
                             │
                             ▼
                    Verification (CHECKMATE)
                             │
                             ▼
                          ZERO  ──▶ TTS ──▶ Web Audio analyser ──▶ 3D brain
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

`parent` is always `zero`. ZERO decides when an agent runs, why, with what
input, under which permissions, in what order, and whether the result is
acceptable.

### Never child agents

`Website-Building`, `Loop-Engeneering` (and the `Loop-Engeniering` spelling that
actually exists on GitHub), `Prompt-Optimizer`, `more-available-tokens`.

The exclusion is enforced in `zero/ops/exclusions.py`, below discovery and again
at the execution seam. It cannot be undone from data: a manifest, an
`agent.yaml`, the registry file itself or an API payload naming one of them is
rejected rather than honoured. When one is present on disk, discovery reports it
as *excluded* rather than omitting it — a refusal you can see is a refusal you
can trust.

`HWD-ZERO` is the parent, and `brain-interface` is a client. Neither is an agent.

## The layers, and what each refuses to do

| Module | Owns | Will not |
| --- | --- | --- |
| `ops/exclusions` | the four blocked repositories | be widened by configuration |
| `ops/discovery` | finding repositories, cached | execute repository code |
| `ops/child_agents` | the registry | let a manifest widen its own grant |
| `ops/capabilities` | the capability vocabulary and broker | rule on a name it does not know |
| `ops/policy` | what ZERO may do unattended | let ZERO promote itself |
| `ops/approvals` | single-use, expiring, payload-bound grants | let one approval release another action |
| `ops/audit` | the append-only record | store arguments or secrets |
| `ops/safemode` | the kill switch | lift itself on a timer |
| `ops/adapters` | running an agent | use a shell, or leave loopback |
| `ops/planner` | objective → plan | invent a step for an agent that is not there |
| `ops/operator` | the one execution path | have a second one |
| `ops/api` | the HTTP + WebSocket surface | enforce a permission of its own |

## The permission model

Three outcomes, never two:

- **POLICY ALLOWED** — ZERO proceeds and audits it.
- **APPROVAL REQUIRED** — the mission stops, an approval is raised, the branch
  visibly halts at a gate in the brain, and nothing runs until you decide.
- **DENIED** — the agent was never granted the capability. No approval is
  offered, because there is nothing to approve.

An approval is bound to a digest over `(mission, agent, capability, action,
target, payload)`. Redeeming it requires reproducing that digest, so approving
one action cannot release another, a changed payload invalidates it, and it is
consumed on use. The one-time token is held only in the operator's memory and
never reaches the interface — the browser approves by id.

**ZERO can learn workflows. ZERO cannot remove its own safety gates.** Repeated
approvals produce a `policy.suggested` event — a question, not a change. The
always-human floor (`external.message`, `external.publish`,
`deployment.execute`, `filesystem.delete`, `git.push`, `credentials.use`,
`purchase.execute`, `system.install`, `database.destructive`) cannot be promoted
by any caller, including you, including by editing the policy file.

## The network model

```
LAPTOP
  0.0.0.0:3000        ZERO gateway          ← the phone, with a token
  127.0.0.1:8000      HWD-ZERO operator     ← the gateway only
  127.0.0.1:11434     Ollama                ← HWD-ZERO only
  127.0.0.1:<ports>   child agents          ← HWD-ZERO only
```

Only the gateway ever leaves loopback, and only when `ZERO_LAN_MODE=true`. The
HTTP adapter refuses any agent endpoint that is not on loopback, so a
manifest cannot move a child agent onto an address the phone could reach. No
tunnel, no UPnP, no port forwarding: LAN is as far as this goes.

## The event bus and the brain

`zero/ops/events.py` publishes what happens; `/ws/events` streams it; the
renderer draws it.

| Event | What the brain does |
| --- | --- |
| `zero.state.changed` | the core's activity and the whole scene's mode |
| `mission.planning` | every candidate branch lights briefly |
| `agent.started` | that branch carries energy outward |
| `agent.completed` | energy runs back toward the core |
| `approval.required` | the branch stops at a visible ring |
| `agent.error` | the branch flashes and falls back |

An event carries `simulated: true` only when it came from the development
visualiser. Real execution never sets it, so a simulated run cannot be presented
as real activity.

The core, the particles and the smoke are driven by an `AnalyserNode` reading
the audio that is **actually playing** — not by the length of the text. While
listening, the microphone drives them instead.

## Where state lives

| State | Where | Survives |
| --- | --- | --- |
| child agent registry | `agents/child-agents.yaml` | git |
| ops missions and plans | `state/ops/missions/` | restart |
| approvals | `state/ops/approvals.json` | restart |
| autonomy policy | `state/ops/policy.json` | restart |
| audit trail | `state/ops/audit.ndjson` | restart, append-only |
| SAFE_MODE | `state/ops/safe-mode.json` | restart |
| discovery cache | `state/ops/discovery-cache.json` | bounded TTL |
| engineering missions | `missions/` (existing `MissionStore`) | restart |

The interface holds no truth of its own. It renders the operator's state and
re-reads on reconnect, which is why a phone that was asleep and a laptop that
was not converge on the same picture.

## Resource shape

The operator is designed for a laptop with 8 GB of RAM that is also running a
model:

- The API is stdlib-only — no async web stack resident just to serve JSON and
  one WebSocket. `zero/ops/websocket.py` implements the subset that is needed.
- Child agents are subprocesses started per mission, not imports, so no agent's
  dependency tree stays resident in the operator.
- The brain is instanced geometry with attribute updates; the mobile profile
  reduces density and pixel ratio rather than changing the scene.
- Priority under load: HWD-ZERO runtime → active child agent → STT/TTS → UI →
  visual effects. Never the reverse.
