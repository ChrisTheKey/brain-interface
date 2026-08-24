# ZERO on a Galaxy S25 Ultra — Termux runtime

Everything on one phone. No laptop, no LAN, no tunnel:

```
Android browser
   │  http://localhost:3000
   ▼
brain-interface gateway     (127.0.0.1 + ::1, port 3000)
   │  /api/*  /ws/*
   ▼
HWD-ZERO                    (127.0.0.1:8000)
   ▼
ZeroSession
```

Termux is a first-class target here, next to Windows, macOS and desktop Linux.
Nothing in this path needs `sudo`, `systemd`, Docker or WSL — none of which
exist on Android.

## Layout

```
$HOME/ZERO-WORKSPACE/
├── HWD-ZERO/
└── brain-interface/
```

On Termux `$HOME` is `/data/data/com.termux/files/home`, so this contains no
device-specific user name. The workspace is **detected**, not hardcoded: the
scripts walk up from the checkout looking for a directory that holds both
repositories, and fall back to `$HOME/ZERO-WORKSPACE`. Put it somewhere else
and export `ZERO_WORKSPACE` to say so.

## Install

```bash
pkg update && pkg install -y git
mkdir -p ~/ZERO-WORKSPACE && cd ~/ZERO-WORKSPACE
git clone https://github.com/ChrisTheKey/HWD-ZERO.git
git clone https://github.com/ChrisTheKey/brain-interface.git

cd ~/ZERO-WORKSPACE/brain-interface
bash scripts/setup-termux.sh
```

`setup-termux.sh` installs `nodejs-lts` through `pkg`, installs the npm
dependencies, verifies the native build toolchain (see below), writes
`.env.local` with the detected workspace, and builds the interface.

Optional, and worth it — it keeps ZERO running while the screen is off:

```bash
pkg install -y termux-api      # then install the Termux:API app
```

## Run

```bash
cd ~/ZERO-WORKSPACE/brain-interface
bash scripts/start-zero.sh
```

Then open **http://localhost:3000** in the phone's browser.

Start HWD-ZERO on `127.0.0.1:8000` in a second Termux session
(`ctrl` + `alt` + `c`, or swipe from the left edge → *New session*). The
interface renders either way; without the backend it shows ZERO as offline
rather than inventing data.

## Why `localhost` and not `0.0.0.0`

The browser and the gateway are the same device, so loopback is all that is
needed — and loopback is all the gateway takes. `0.0.0.0` would publish the
interface on whatever WiFi or mobile network the phone is attached to.

There is one Android-specific catch, and it is the usual reason a same-device
setup shows a blank page: **Android resolves `localhost` to `::1` before
`127.0.0.1`.** A server bound only to IPv4 can be unreachable from the very
phone running it. The gateway therefore binds *both* loopback addresses to the
same port. If the device has no IPv6 loopback it says so and keeps serving on
IPv4:

```
BOUND:    127.0.0.1, ::1
```

`scripts/status-zero.sh` and `scripts/zero-doctor.sh` both report which
families actually answer. To pin the gateway to IPv4, set
`ZERO_DISABLE_IPV6=true`.

Reaching ZERO from a *second* device is a different thing and still needs
`scripts/start-zero-lan.sh`, which binds the LAN behind a generated token.

## When the page does not appear

```bash
bash scripts/zero-doctor.sh
```

It checks the host, the workspace, the dependencies, the native toolchain, the
bundle, both loopback families, the gateway's health endpoint and HWD-ZERO —
then names the one command to run next. It never repairs anything itself.

Before the interface has been built, `http://localhost:3000` shows a page
saying exactly that, with the command to run. A blank page means nothing is
listening; a page means the gateway is fine and the problem is further in.

## Native build toolchain

Vite compiles through esbuild and bundles through rollup, and both load a
prebuilt native binary chosen by platform. Termux reports `android`/`arm64`,
for which `@esbuild/android-arm64` and `@rollup/rollup-android-arm64` both
exist — but npm drops optional dependencies often enough
([npm/cli#4828](https://github.com/npm/cli/issues/4828)) that `setup-termux.sh`
verifies rather than assumes:

| Component | Check | Repair |
| --- | --- | --- |
| esbuild | `require('esbuild').transformSync(…)` | `pkg install esbuild`, then `ESBUILD_BINARY_PATH` |
| rollup | `require('rollup')` | `@rollup/wasm-node` (slower, runs anywhere) |

Both repairs are scoped to `node_modules` — installed with `--no-save`, so
`package.json` and `package-lock.json` are untouched and a Windows or Linux
checkout of the same repository is unaffected.

## Memory

The build is the heaviest step. `ZERO_BUILD_HEAP_MB` caps V8's old space
(default 2048); lower it on a device under memory pressure:

```bash
ZERO_BUILD_HEAP_MB=1024 bash scripts/setup-termux.sh
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZERO_WORKSPACE` | detected | Directory holding `HWD-ZERO` and `brain-interface` |
| `ZERO_UI_PORT` | `3000` | Port the gateway serves on |
| `ZERO_API_URL` | `http://127.0.0.1:8000` | HWD-ZERO's API |
| `ZERO_LAN_MODE` | `false` | Bind the LAN as well (not needed same-device) |
| `ZERO_DISABLE_IPV6` | `false` | Bind `127.0.0.1` only |
| `ZERO_BUILD_HEAP_MB` | `2048` | V8 old-space ceiling for the build |
| `ZERO_SKIP_PKG` | `false` | Skip `pkg install` (packages already present) |

## Scripts

| Script | Does |
| --- | --- |
| `scripts/setup-termux.sh` | Full Termux install: packages, deps, toolchain, config, build |
| `scripts/setup-zero.sh` | Desktop setup; hands over to `setup-termux.sh` on Termux |
| `scripts/start-zero.sh` | Serves http://localhost:3000, loopback only |
| `scripts/start-zero-lan.sh` | Adds LAN access for a second device, token-gated |
| `scripts/status-zero.sh` | What is up right now, including both loopback families |
| `scripts/zero-doctor.sh` | Why the interface is not showing |
| `scripts/stop-zero.sh` | Stops the gateway these scripts started |
