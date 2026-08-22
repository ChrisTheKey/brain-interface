# The HWD-ZERO backend contract

Everything the Brain Interface shows comes from HWD-ZERO. This document is the
exact list of what it asks for, what it does when a piece is missing, and what
it says to the operator when it degrades.

The interface never fills a gap in. A contract that is not implemented becomes
a line in the system bar (**“n missing backend contracts”**) naming the method
and the path, so it can be implemented rather than guessed at.

All paths are relative to the gateway origin (`http://<host>:3000`). The
gateway proxies them to HWD-ZERO on `127.0.0.1:8000`; the browser never sees
that address.

---

## 1. Implemented and required

These already exist in `zero/api/` and the interface depends on them.

| Method | Path | Used for | Without it |
| --- | --- | --- | --- |
| GET | `/api/health` | liveness | the gateway health probe reports the operator as down |
| GET | `/api/state` | version, `safe_mode`, mission counts | no SAFE_MODE state, no version |
| GET | `/api/agents` | the agent registry — the brain's clusters | the brain shows ZERO alone |
| GET | `/api/missions` | the mission strip | no mission list |
| GET | `/api/missions/<id>/journal` | audit trail | — |
| GET | `/api/approvals` | open gates | no AWAITING_APPROVAL state, no gate card |
| GET | `/api/tasks` | contracts that can be started | — |
| POST | `/api/missions` | start a mission from a contract | the voice fallback cannot hand a transcript over |
| POST | `/api/approvals` | mint one approval ticket | approving is impossible |
| POST | `/api/approvals/<ticket>/grant` | redeem that ticket | approving is impossible |
| POST | `/api/control/safe-mode` | the kill switch | the kill switch is disabled |
| WS | `/ws/events` | the live event stream | the brain only moves on the poll interval |

### `/api/agents` — optional enrichment

The interface renders whatever the registry gives it. These optional fields
make the brain richer and are all safe to omit:

```jsonc
{
  "version": "1.4.2",
  "agents": [
    {
      "id": "insta",                    // required — the brain's cluster id
      "role": "social",
      "status": "idle",                 // idle | running | error | disabled
      "purpose": "Runs the Instagram presence",
      "strengths": ["posting", "dm"],   // these become the cluster's terminals
      "available": true,

      // optional
      "repo": "Insta-Agent",            // matched against the agent policy
      "cwd": "/home/you/ZERO-WORKSPACE/Insta-Agent",
      "repository": "git@github.com:…",
      "branch": "main",
      "department": "social",           // overridden by the policy when it knows the agent
      "requires_approval_for": ["external.publish"]
    }
  ],
  "projects": [{ "id": "launch", "status": "ACTIVE", "priority": "high", "runtime": "node" }]
}
```

When an agent reports neither `strengths` nor `requires_approval_for`, its
cluster is still drawn but its terminals are marked *structural* and a data
note names the agent. The brain never claims a capability that was not
reported.

### `/ws/events` — the event vocabulary

Frames are JSON, one event per frame:

```jsonc
{
  "event_id": "M-1:000007",     // deduplicates a replay after a reconnect
  "timestamp": "2026-08-22T10:15:00+00:00",
  "mission_id": "mission-…",
  "agent_id": "insta",
  "type": "agent.started",
  "payload": { "action": "writing the launch caption" }
}
```

| Type | Effect in the brain |
| --- | --- |
| `mission.created` | THINKING |
| `mission.planning` | PLANNING |
| `mission.executing` | EXECUTING |
| `mission.verifying` | VERIFYING |
| `mission.completed` / `mission.failed` | clears that mission's agents |
| `agent.started` / `agent.activity` | that agent's cluster lights up, energy flows outward |
| `agent.completed` | energy flows back to ZERO, the cluster settles |
| `agent.error` | the cluster turns to the error tint |
| `approval.required` / `approval.approved` / `approval.denied` | re-reads `/api/approvals` |
| `policy.suggested` / `policy.changed` | recorded, not rendered |
| `zero.state.changed` *(optional)* | adopts `payload.state` for the mission tier |

`payload.action` / `step` / `label` / `summary` is used verbatim as the agent's
activity label. Nothing is templated.

---

## 2. Asked for, and degraded when missing

### `WS /ws/voice` — the voice channel

This is the intended path for a spoken turn and the only one that gives the
brain a **measured** audio signal to react to.

**Client → server**

```jsonc
{ "type": "voice.hello",   "language": "de-DE", "client": "brain-interface" }
{ "type": "voice.partial", "text": "starte den Scraper für" }      // live, still changing
{ "type": "voice.final",   "text": "starte den Scraper für Hamburg", "language": "de-DE" }
{ "type": "voice.text",    "text": "status" }                       // typed, same pipeline
{ "type": "voice.speak",   "text": "Der Scraper läuft." }           // voice this text
{ "type": "voice.cancel" }
```

**Server → client**

```jsonc
{ "type": "voice.state",      "state": "PLANNING" }
{ "type": "voice.partial",    "text": "…" }                         // if the operator does the STT
{ "type": "voice.transcript", "text": "…", "final": true }
{ "type": "voice.response",   "text": "Der Scraper läuft.", "mission_id": "mission-…" }
{ "type": "voice.audio",      "format": "pcm16", "sample_rate": 24000, "channels": 1,
                              "data": "<base64 PCM16LE>" }
{ "type": "voice.audio.end" }
{ "type": "voice.error",      "message": "tts offline" }
```

A `voice.audio` frame **without** `data` announces the format of the raw binary
frames that follow, so audio can be streamed as binary rather than base64.

**Degradation when `/ws/voice` does not exist.** The channel gives up after
three failed connects and reports it once. The final transcript is then handed
over as `POST /api/missions`, and ZERO's answer arrives on `/ws/events`
instead. Everything else — the microphone, the live partial transcript, the
final transcript, the runtime states — keeps working.

### `POST /api/voice/tts` — rendered speech

```
POST /api/voice/tts
{ "text": "Der Scraper läuft." }
→ 200  audio/wav | audio/mpeg | audio/ogg     (any format the browser can decode)
→ 404 / 405 / 501                              treated as "not implemented"
```

Used when there is no `/ws/voice` stream. The audio is decoded into the same
Web Audio graph, so the brain still reacts to the real signal.

**Degradation when it does not exist.** The browser's own synthesizer speaks.
Platform TTS cannot be routed through Web Audio, so there is no signal to
analyse: the reaction is *estimated* from word-boundary timing, the smoke and
the core are driven by that estimate, and the HUD says
**“reaction estimated, not measured”** for as long as that is true.

---

## 3. Served by the gateway itself

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/gateway/health` | public — answers even when HWD-ZERO is down |
| POST | `/api/gateway/session` | exchanges the pairing token for a cookie |

```jsonc
// GET /api/gateway/health
{
  "gateway": "ok",
  "lanMode": false,
  "zeroApi": "http://127.0.0.1:8000",
  "authRequired": false,
  "websocketPaths": ["/ws/events", "/ws/voice"],
  "upstream": { "reachable": false, "checkedAt": 1787417832093, "error": "connect ECONNREFUSED" }
}
```

This is what lets the interface distinguish “the gateway is broken” from “the
operator is not running”, and say the second one out loud.

---

## 4. What the interface will never ask for

By design, and enforced by the architecture rather than by convention:

- **No shell.** The interface has no command endpoint and no way to reach one.
- **No credentials.** Nothing is stored in the bundle, in `localStorage` or in
  the environment of the browser.
- **No agent process control.** It cannot start, stop or address an agent
  directly; it can only ask HWD-ZERO to run a mission.
- **No routing.** Which agent handles a request is HWD-ZERO's decision. The
  interface renders the decision; it does not make one.
- **No approval it grants itself.** It asks for a ticket bound to one mission,
  one gate and a digest of exactly what the human was shown, then redeems that
  single ticket.
