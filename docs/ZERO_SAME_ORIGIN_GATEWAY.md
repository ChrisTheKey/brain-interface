# ZERO — the same-origin gateway

## The bug this replaces

The interface showed:

```
ZERO
zero · notLoaded

ZERO disconnected
ws://127.0.0.1:8787
```

Two separate faults, which is why it looked confusing:

1. **`ws://127.0.0.1:8787` was compiled into the browser bundle.** `127.0.0.1`
   means *this device*. On the laptop that runs ZERO it happened to work; on
   the Samsung Galaxy it pointed the phone at the phone. The default came from
   `VITE_ZERO_WS_URL` in `src/config.ts`, and every `VITE_*` value is baked
   into the bundle the browser downloads.
2. **`notLoaded` described the graph, not the backend.** It is the status
   `buildGraph` gives the ZERO node when there is no snapshot yet. Read as a
   statement about ZERO it is meaningless — it says nothing about whether
   HWD-ZERO is running.

## The architecture now

```
Browser · laptop · phone
          │  http(s)://<whatever address was opened>:3000
          ▼
   ZERO GATEWAY :3000                 ← the only port a browser ever needs
          │
   ┌──────┼──────────┬─────────────┐
   /    /api/*      /ws         /ws/events
   │      │          │             │
   ▼      ▼          ▼             ▼
 dist   HWD-ZERO   ZERO runtime  HWD-ZERO
        HTTP API   app-server    event stream
        (loopback) (loopback)    (loopback)
```

The browser knows four public strings — `/`, `/api`, `/ws`, `/ws/events` — and
no host, no port and no scheme. The same build works unchanged:

| opened as | socket becomes |
| --- | --- |
| `http://127.0.0.1:3000` | `ws://127.0.0.1:3000/ws` |
| `http://192.168.1.23:3000` | `ws://192.168.1.23:3000/ws` |
| `https://zero-host` | `wss://zero-host/ws` |

`src/zero/endpoints.ts` is the only place that derives this, from
`window.location`. `tests/noHardcodedBackend.test.ts` fails the build if any
loopback address, internal port or absolute `ws://` URL reappears under `src/`,
and also checks the built bundle in `dist/` when one exists.

## The two upstreams

They are genuinely two processes on two ports, so they are two configuration
values. Collapsing them would be the port assumption this change exists to
remove.

| public path | env var | default | what it is |
| --- | --- | --- | --- |
| `/api/*` | `ZERO_API_URL` | `http://127.0.0.1:8000` | HWD-ZERO's HTTP API |
| `/ws/events` | `ZERO_API_URL` | same host | HWD-ZERO's operator events |
| `/ws` | `ZERO_RUNTIME_WS_URL` | `ws://127.0.0.1:8787` | ZERO runtime app-server |

`/ws/events` is a prefix of `/ws`, so the gateway matches the path **exactly**
(`resolveWsRoute`) rather than by prefix — otherwise every operator event would
be piped into the runtime port.

## Termux, and why port 3000 used to disappear

`http://localhost:3000` returning `ERR_CONNECTION_REFUSED` on the phone had
two causes, both in the start path rather than in the gateway:

1. **The backend was a precondition for the web server.** `zero-go.sh` built
   the bundle and probed HWD-ZERO *before* starting the gateway, under
   `set -e`. A failed build on Android — a native module, an OOM kill — or an
   absent backend meant the script exited and the gateway was never started.
2. **The readiness probe read a correct answer as a failure.** `/api/health`
   answers **503** exactly when the gateway is healthy and HWD-ZERO is not.
   The probe accepted only `< 500`, so it concluded the gateway had failed and
   ran `kill "$GATEWAY_PID"` — killing a working gateway *because the backend
   was offline*.

Both are fixed, and both have regression tests
(`tests/gatewaySupervision.test.ts`, `tests/startScript.test.ts`). The order is
now environment → ports → bundle → **gateway** → prove port 3000 answers →
HWD-ZERO. Everything after the gateway is advisory. A build failure with a
previous `dist` present serves the older bundle rather than nothing.

A third fix is about spelling: the gateway now binds **both loopback
families**, `127.0.0.1` and `::1`. On Android `localhost` commonly resolves to
`::1` first, so a gateway bound only to IPv4 answers one spelling and refuses
the other from the same device. A host without IPv6 skips the second listener
and carries on.

### The optional runtime app-server

`ZERO_RUNTIME_WS_URL` points at the codex app-server, which drives the brain
graph and realtime voice. It is genuinely optional — a phone running HWD-ZERO
under Termux has no reason to run one — so health reports three values, not
two: `healthy`, `offline`, and `not_configured`. Only the middle one is a
degradation, and `READY` turns on HWD-ZERO's own operator stream. Waiting on a
component the deployment does not run would make `READY` unreachable no matter
how healthy the operator is.

## What the HWD-ZERO analysis actually found

> **Superseded.** HWD-ZERO now ships `zero/server` — `python -m zero.server`
> serves the contract below on `127.0.0.1:8000`, standard library only. The
> analysis is kept because it explains why nothing here hardcodes a port.
>
> Checked against `ChrisTheKey/HWD-ZERO` at commit `d1d087c`:

- **No HTTP server.** There is no `zero/api` package, no `uvicorn`, `fastapi`,
  `aiohttp`, `flask` or `http.server` anywhere in the repository, and no
  dependency that would provide one (`pyproject.toml` lists only `PyYAML`).
- **No WebSocket server**, and no `websockets` dependency.
- **No `serve` command.** `zero/cli.py` registers exactly: `status`,
  `validate`, `context`, `preflight`, `run`, `resume`, `result`, `missions`,
  `memory`, `gym`, `bench`. The entry point is `zero = zero.cli:main`, i.e.
  `python -m zero <command>`.

So HWD-ZERO today is a **CLI-only Python package**. Its HTTP port is therefore
not discoverable from the repository, which is precisely why nothing here
hardcodes one: `ZERO_API_URL` and `ZERO_RUNTIME_WS_URL` are single
configuration points, the gateway probes them for real, and the interface
reports `BACKEND OFFLINE` — accurately — when they do not answer.

`8000` is kept as the documented default because `src/hwd/client.ts` and
`src/hwd/types.ts` were written against an HWD-ZERO API surface (`/api/state`,
`/api/agents`, `/api/missions`, `/api/approvals`, `/api/control/safe-mode`,
`/ws/events`). That contract is what HWD-ZERO needs to expose for `READY` to
be reachable:

| method | path | returns |
| --- | --- | --- |
| `GET` | `/api/health` | `{ "status": "ok", "safe_mode": false }` |
| `GET` | `/api/state` | `OperatorState` (see `src/hwd/types.ts`) |
| `GET` | `/api/agents` | `{ "version", "agents": [], "projects": [] }` |
| `GET` | `/api/tasks` | `{ "tasks": [] }` |
| `GET` | `/api/missions` | `{ "missions": [] }` |
| `GET` | `/api/approvals` | `{ "approvals": [] }` |
| `POST` | `/api/missions` | starts a mission from a contract |
| `POST` | `/api/approvals` | mints a single-use approval ticket |
| `POST` | `/api/approvals/{id}/grant` | redeems one ticket |
| `POST` | `/api/control/safe-mode` | the kill switch |
| `WS` | `/ws/events` | `OperatorEvent` frames |

That contract now exists: see `zero/server` in HWD-ZERO and the endpoint table
in its README. `python -m zero.server` serves it, standard library only, so it
installs on a phone without a compiler.

## The connection state machine

`src/zero/connectionState.ts`. Pure, total, and the only thing allowed to say
what ZERO is:

```
STARTING → CONNECTING → BACKEND_CONNECTED → READY
                ↓              ↓
         BACKEND_OFFLINE    DEGRADED
                ↓
     AUTH_REQUIRED · SAFE_MODE · ERROR
```

`READY` requires **all three** at once:

1. `/api/health` reports `zero: "healthy"` (the gateway probed HWD-ZERO), and
2. the same-origin operator event stream is open, and
3. ZERO returned real payload — a runtime snapshot or operator state.

The optional codex app-server is not a fourth condition; when it is configured
and down the state is `DEGRADED`, and when it is absent it is ignored.

A rendered React bundle satisfies none of these. `UI LOADED ≠ ZERO READY`.

## Health

`GET /api/health` is served by the gateway itself and keeps three facts apart:

```json
{ "gateway": "healthy", "zero": "healthy", "websocket": "healthy" }   // 200
{ "gateway": "healthy", "zero": "offline", "websocket": "offline" }   // 503
```

`503` rather than `200` when the chain is broken, so `curl`, the start scripts
and any monitor see it too. Internal upstream addresses appear under
`diagnostics` only when `ZERO_DIAGNOSTICS=true` — which is the default for
local development and **off** in LAN mode.

## Reconnect

Bounded exponential backoff, 1s → 2s → 4s → 8s → 15s, reset the moment a
connection actually succeeds. Never a reconnect storm, never a long silence.

On top of the timer, `src/zero/lifecycle.ts` reconnects immediately when the
browser reports it woke up — `online`, `visibilitychange`, `pageshow`, `focus`
— coalesced, because unlocking a phone fires several of those at once. A
locked screen kills the socket silently; without this the brain stays dead for
up to fifteen seconds after the phone comes back.

## LAN mode

`ZERO_LAN_MODE=true` binds **only the gateway** to `0.0.0.0:3000`. Everything
else stays on `127.0.0.1`: HWD-ZERO's API, the ZERO runtime socket, Ollama,
every child agent, STT/TTS and memory services. LAN access needs the pairing
token (generated on first run into `.zero/gateway-token`, mode 0600, never in
the bundle). No tunnel, no UPnP, no port forwarding.

## HTTPS and the microphone

The code handles `ws:` and `wss:` symmetrically and picks by page protocol; an
`https:` page always gets `wss:`, because a `ws:` socket from an HTTPS page is
blocked as mixed content rather than downgraded.

Separately, and worth knowing before it surprises you: **browsers only grant
`getUserMedia` in a secure context.** `localhost` counts as secure; a plain
`http://192.168.x.x` LAN address generally does not. So on the Galaxy, over
`http://<laptop-ip>:3000`, the microphone may be refused by the browser even
though ZERO is perfectly connected — Chrome and Samsung Internet both enforce
this. Text input drives the identical pipeline, so ZERO stays fully usable.
Serving the gateway behind TLS (any reverse proxy with a certificate the phone
trusts) restores microphone access, and the interface needs no change for it:
`https://` automatically produces `wss://`.

This is a browser policy, not a ZERO problem, and it does not block the
backend fix.

## Starting it

```bash
scripts/zero-go.sh          # laptop only    → http://127.0.0.1:3000
scripts/zero-go.sh --lan    # laptop + phone → prints the detected LAN URL
```

`zero-go.sh` runs the sequence in order and prints what each step actually
found: environment → repositories → ports → HWD-ZERO → HWD-ZERO health →
interface build → gateway → health through the gateway → the URLs. It prints
`ZERO READY` only when the health probe genuinely came back healthy, and
`ZERO ONLINE · BACKEND OFFLINE` otherwise. It never prints the token.

If HWD-ZERO does not start, the interface still starts and says
`BACKEND OFFLINE`. That is on purpose: a correct offline state is more useful
than a blank page.
