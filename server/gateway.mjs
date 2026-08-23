#!/usr/bin/env node
/**
 * ZERO Gateway — the single origin.
 *
 *     Galaxy / laptop browser
 *              │  http(s)://<host>:3000        ← the only address a browser needs
 *              ▼
 *        ZERO GATEWAY  ──  /            → the built brain interface
 *              │           /api/health  → composite health (gateway + upstreams)
 *              │           /api/*       → HWD-ZERO HTTP API   (loopback only)
 *              │           /ws          → ZERO runtime socket (loopback only)
 *              │           /ws/events   → HWD-ZERO event stream (loopback only)
 *              ▼
 *        HWD-ZERO + ZERO runtime, both on 127.0.0.1
 *
 * Why this exists at all: `127.0.0.1` means *this device*. A bundle that dials
 * `ws://127.0.0.1:8787` works on the laptop that runs ZERO and fails on every
 * other device, because on the Samsung Galaxy that address is the phone. The
 * gateway removes the question — the browser talks to whatever origin served
 * it, and only the gateway knows where ZERO actually lives.
 *
 * Rules this file enforces:
 *   - Only the gateway may listen on the LAN, and only with ZERO_LAN_MODE=true.
 *   - Upstream ZERO, Ollama and every child agent stay on loopback.
 *   - LAN access requires a token that is generated on first run, stored with
 *     0600 permissions outside the repository and never baked into the bundle.
 *   - `/ws` is a real WebSocket upgrade, proxied end to end. Never polling.
 *   - No tunnels, no UPnP, no port forwarding — LAN is as far as this goes.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadTtsConfig, publicStatus } from './tts/config.mjs';
import { redact, synthesize } from './tts/fishAudio.mjs';
import { BrowserPool, loadBrowserConfig } from './browser/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

export const DEFAULT_PORT = 3000;

/**
 * HWD-ZERO's HTTP API on loopback.
 *
 * Not guessed: this mirrors `src/hwd/client.ts`, whose request shapes are
 * taken from HWD-ZERO's `zero/api/`. The value is a single configuration
 * point (`ZERO_API_URL`) precisely because the port is a property of the
 * deployment, not of this bundle — change it in one place and nothing in the
 * browser has to know.
 */
export const DEFAULT_ZERO_API = 'http://127.0.0.1:8000';

/**
 * ZERO's runtime socket on loopback (`codex app-server --listen ws://IP:PORT`).
 * Separate from the HTTP API because it is genuinely a different upstream on a
 * different port — collapsing the two would be exactly the kind of port
 * assumption that broke this before.
 */
export const DEFAULT_ZERO_RUNTIME_WS = 'ws://127.0.0.1:8787';

/** Public paths. The browser knows these and nothing else. */
export const PUBLIC_API_BASE = '/api';
export const PUBLIC_WS_PATH = '/ws';
export const PUBLIC_EVENTS_WS_PATH = '/ws/events';
/** Microphone audio to HWD-ZERO's voice service. Same origin, like everything else. */
export const PUBLIC_VOICE_WS_PATH = '/ws/voice';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Routes that never require a token.
 *
 * Health has to be public: without it a phone that is not paired yet cannot
 * tell "wrong token" from "backend down", and would show the wrong state for
 * the wrong reason. It reveals no internal address unless diagnostics are on.
 */
const PUBLIC_PATHS = new Set(['/api/health', '/api/gateway/health']);

export function readConfig(env = process.env) {
  const lanMode = String(env.ZERO_LAN_MODE ?? '').toLowerCase() === 'true';
  const diagnosticsRaw = env.ZERO_DIAGNOSTICS;
  return {
    port: Number(env.ZERO_UI_PORT ?? DEFAULT_PORT),
    // LAN mode is the only way to leave loopback, and it is explicit.
    host: lanMode ? '0.0.0.0' : '127.0.0.1',
    lanMode,
    zeroApi: env.ZERO_API_URL ?? DEFAULT_ZERO_API,
    // May be empty: the codex app-server is a *separate*, optional component
    // that drives the brain graph and realtime voice. HWD-ZERO's own operator
    // stream lives on ZERO_API_URL and is what the interface actually needs.
    zeroRuntimeWs: env.ZERO_RUNTIME_WS_URL ?? DEFAULT_ZERO_RUNTIME_WS,
    distDir: env.ZERO_UI_DIST ?? join(projectRoot, 'dist'),
    tokenFile: env.ZERO_TOKEN_FILE ?? join(projectRoot, '.zero', 'gateway-token'),
    // Requests per minute per client address.
    rateLimit: Number(env.ZERO_RATE_LIMIT ?? 240),
    // Internal host:port details are development diagnostics. On the LAN they
    // stay off by default: a paired phone has no business learning the
    // topology behind the gateway.
    diagnostics:
      diagnosticsRaw === undefined
        ? !lanMode
        : String(diagnosticsRaw).toLowerCase() === 'true',
    healthTimeoutMs: Number(env.ZERO_HEALTH_TIMEOUT_MS ?? 2_000),
    quiet: String(env.ZERO_QUIET ?? '').toLowerCase() === 'true',
  };
}

/** Loads the access token, generating one on first run. */
export function loadOrCreateToken(tokenFile) {
  if (existsSync(tokenFile)) {
    const value = readFileSync(tokenFile, 'utf8').trim();
    if (value.length >= 32) return value;
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

export function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The laptop's current LAN address — detected, never assumed. */
export function detectLanAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  // Prefer a private range; a hotspot usually lands in 192.168.x or 10.x.
  const privateFirst = candidates.filter((entry) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  );
  return (privateFirst[0] ?? candidates[0])?.address ?? null;
}

/** Extracts the bearer token from a request (header, cookie or query). */
export function extractToken(req, url) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    const match = cookie.match(/(?:^|;\s*)zero_token=([^;]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return url?.searchParams.get('token') ?? null;
}

export function createRateLimiter(limitPerMinute, now = () => Date.now()) {
  const buckets = new Map();
  return function allow(key) {
    const minute = Math.floor(now() / 60_000);
    const bucket = buckets.get(key);
    if (!bucket || bucket.minute !== minute) {
      buckets.set(key, { minute, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limitPerMinute;
  };
}

/**
 * Every address the gateway should listen on.
 *
 * Two, not one, and that is the fix for a real symptom: on Android `localhost`
 * commonly resolves to `::1` before `127.0.0.1`, so a gateway bound only to
 * the IPv4 loopback answers `http://127.0.0.1:3000` and refuses
 * `http://localhost:3000` from the same phone. Binding both loopback families
 * makes the two spellings equivalent, which is what a user reasonably expects.
 *
 * The first entry is the primary: if it cannot bind, the gateway has failed.
 * The rest are best effort — a host without IPv6 simply skips `::1` rather
 * than refusing to start.
 */
export function bindAddresses(config) {
  return config.lanMode ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1'];
}

/** Resolves a URL path inside dist, refusing anything that escapes it. */
export function resolveStaticPath(distDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = normalize(join(distDir, decoded === '/' ? 'index.html' : decoded));
  const root = normalize(distDir);
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

/**
 * Which upstream a WebSocket upgrade belongs to.
 *
 * Two public sockets, two different upstreams, and `/ws/events` is a prefix of
 * `/ws` — so the match is exact rather than `startsWith`, or every operator
 * event would be piped into the runtime port.
 */
export function resolveWsRoute(pathname, config) {
  if (pathname === PUBLIC_EVENTS_WS_PATH) {
    return { target: config.zeroApi, path: PUBLIC_EVENTS_WS_PATH, upstream: 'zeroApi' };
  }
  // Voice lives on HWD-ZERO, which is the runtime. The browser reaches it the
  // same way it reaches everything else: through this origin, never directly.
  if (pathname === PUBLIC_VOICE_WS_PATH) {
    return { target: config.zeroApi, path: PUBLIC_VOICE_WS_PATH, upstream: 'zeroApi' };
  }
  if (pathname === PUBLIC_WS_PATH || pathname === `${PUBLIC_WS_PATH}/`) {
    // The runtime URL carries its own path (`ws://host:port/` for
    // codex app-server); the public `/ws` is a gateway name, not an upstream one.
    const upstreamPath = new URL(config.zeroRuntimeWs).pathname || '/';
    return { target: config.zeroRuntimeWs, path: upstreamPath, upstream: 'zeroRuntimeWs' };
  }
  return null;
}

/** host/port of an http(s):// or ws(s):// upstream, with the right default port. */
export function upstreamAddress(target) {
  const url = new URL(target);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return {
    hostname: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    secure,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const stats = statSync(filePath);
  res.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    // The bundle is hashed; index.html must never be cached.
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
  });
  createReadStream(filePath).pipe(res);
}

function proxyHttp(req, res, target, pathname, search) {
  const { hostname, port } = upstreamAddress(target);
  const options = {
    hostname,
    port,
    path: `${pathname}${search}`,
    method: req.method,
    headers: { ...req.headers, host: `${hostname}:${port}` },
  };
  // The gateway's own token never travels upstream.
  delete options.headers.authorization;
  delete options.headers.cookie;

  const proxied = httpRequest(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  proxied.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, {
      error: 'zero_api_unreachable',
      message: `HWD-ZERO is not reachable at ${target}: ${error.message}`,
    });
  });
  req.pipe(proxied);
}

/**
 * Real WebSocket upgrade proxying: a raw TCP pipe carrying the client's own
 * `Upgrade` request upstream, so the 101 handshake, the negotiated
 * subprotocol and every frame afterwards are the upstream's, unmodified.
 *
 * Deliberately not "polling that looks like a socket": ZERO pushes events, and
 * a poll would turn a live brain into a stuttering one.
 */
function proxyUpgrade(req, socket, head, target, pathname, search) {
  const { hostname, port } = upstreamAddress(target);
  socket.setNoDelay?.(true);
  const client = netConnect(port, hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== 'authorization' && key !== 'cookie')
      .map(([key, value]) =>
        key.toLowerCase() === 'host'
          ? `host: ${hostname}:${port}`
          : `${key}: ${Array.isArray(value) ? value.join(', ') : value}`,
      );
    client.write(`${req.method} ${pathname}${search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head?.length) client.write(head);
    client.pipe(socket);
    socket.pipe(client);
  });
  client.setNoDelay?.(true);
  client.on('error', (error) => {
    // Say why, once, before closing: a socket that just vanishes is
    // indistinguishable from a bug in the browser.
    if (!socket.destroyed) {
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n' +
          `ZERO upstream ${target} is not reachable: ${error.message}`,
      );
      socket.destroy();
    }
  });
  socket.on('error', () => client.destroy());
  return client;
}

/**
 * Is HWD-ZERO's HTTP API answering right now?
 *
 * A real request with a real timeout — the gateway never reports a backend as
 * healthy because it once was.
 */
export function probeHttp(target, path, timeoutMs = 2_000) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolveProbe({ ok, detail });
    };
    let req;
    try {
      const { hostname, port } = upstreamAddress(target);
      req = httpRequest({ hostname, port, path, method: 'GET' }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        finish(status > 0 && status < 500, `HTTP ${status}`);
      });
    } catch (error) {
      finish(false, error.message);
      return;
    }
    req.on('error', (error) => finish(false, error.message));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false, `no answer within ${timeoutMs}ms`);
    });
    req.end();
  });
}

/**
 * Is the runtime WebSocket upstream accepting connections?
 *
 * A TCP connect, not a full handshake: it answers exactly the question the
 * health payload claims to answer ("is something listening there") without
 * opening and abandoning a real ZERO session on every poll.
 */
export function probeSocket(target, timeoutMs = 2_000) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolveProbe({ ok, detail });
    };
    let socket;
    try {
      const { hostname, port } = upstreamAddress(target);
      socket = netConnect(port, hostname, () => {
        socket.destroy();
        finish(true, `tcp ${hostname}:${port} accepting`);
      });
    } catch (error) {
      finish(false, error.message);
      return;
    }
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      finish(false, `no answer within ${timeoutMs}ms`);
    });
    socket.on('error', (error) => finish(false, error.message));
  });
}

/**
 * The composite health payload.
 *
 * Three independent facts, kept apart on purpose. "The gateway is up" is not
 * "ZERO is up", and neither of them is "the event stream works" — the
 * interface needs all three to decide whether it may say READY.
 */
/**
 * Read a small JSON body.
 *
 * Bounded: a request that keeps sending must not be able to fill the gateway's
 * memory, and nothing legitimate here is larger than a spoken paragraph.
 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export async function collectHealth(config, extra = {}) {
  const runtimeConfigured = Boolean(config.zeroRuntimeWs);
  const [zero, websocket] = await Promise.all([
    probeHttp(config.zeroApi, '/api/health', config.healthTimeoutMs),
    runtimeConfigured
      ? probeSocket(config.zeroRuntimeWs, config.healthTimeoutMs)
      : Promise.resolve({ ok: false, detail: 'not configured' }),
  ]);

  const body = {
    gateway: 'healthy',
    zero: zero.ok ? 'healthy' : 'offline',
    // Three values, not two: an optional component that is simply absent is
    // not the same fact as one that is configured and down, and only the
    // second is a degradation.
    websocket: !runtimeConfigured ? 'not_configured' : websocket.ok ? 'healthy' : 'offline',
    runtimeConfigured,
    lanMode: config.lanMode,
    authRequired: config.lanMode,
    publicPaths: {
      api: PUBLIC_API_BASE,
      ws: PUBLIC_WS_PATH,
      events: PUBLIC_EVENTS_WS_PATH,
      voice: PUBLIC_VOICE_WS_PATH,
    },
    ...extra,
  };

  if (config.diagnostics) {
    body.diagnostics = {
      zeroApi: config.zeroApi,
      zeroRuntimeWs: config.zeroRuntimeWs,
      zeroDetail: zero.detail,
      websocketDetail: websocket.detail,
    };
  }

  // 200 only when the whole chain is up. A degraded gateway must be visible to
  // `curl` and to shell scripts, not only to a human reading JSON.
  return { status: zero.ok ? 200 : 503, body };
}

export function startGateway(config = readConfig()) {
  const token = loadOrCreateToken(config.tokenFile);
  const allow = createRateLimiter(config.rateLimit);

  const authorize = (req, url) => {
    // On loopback the laptop's own browser is trusted; the LAN never is.
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!config.lanMode && isLoopback) return true;
    const provided = extractToken(req, url);
    return provided !== null && constantTimeEquals(provided, token);
  };

  // One pool for the process: a session per browser, each launched only when
  // it is asked for and each closing itself when it goes idle.
  let browsers = null;
  const browserPool = () => {
    browsers ??= new BrowserPool(loadBrowserConfig(process.env, process.cwd()));
    return browsers;
  };

  const handleRequest = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const remote = req.socket.remoteAddress ?? 'unknown';

    if (!allow(remote)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }

    if (PUBLIC_PATHS.has(url.pathname)) {
      // The pairing state is a fact about *this* caller, so an already paired
      // phone is not told it still needs a token.
      collectHealth(config, { authRequired: config.lanMode && !authorize(req, url) })
        .then(({ status, body }) => sendJson(res, status, body))
        .catch((error) =>
          sendJson(res, 500, { gateway: 'healthy', error: 'health_failed', message: error.message }),
        );
      return;
    }

    // Pairing: exchange the token for a cookie so the phone stays logged in.
    if (url.pathname === '/api/gateway/session' && req.method === 'POST') {
      const provided = extractToken(req, url);
      if (provided === null || !constantTimeEquals(provided, token)) {
        sendJson(res, 401, { error: 'invalid_token' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `zero_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!authorize(req, url)) {
      sendJson(res, 401, {
        error: 'unauthorized',
        message: 'Open the pairing URL printed by start-zero-lan (it carries ?token=…).',
      });
      return;
    }

    // Opening the pairing link pairs the device: the token becomes a cookie so
    // every asset, API call and websocket that follows is authenticated too.
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && constantTimeEquals(queryToken, token)) {
      res.setHeader(
        'set-cookie',
        `zero_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      );
    }

    /*
      ZERO's cloud voice.

      Handled here rather than proxied to HWD-ZERO because this is the only
      process that holds FISH_API_KEY — the browser asks for audio, the
      gateway is what has the credential. Everything else under /api still
      goes to the runtime.

      Placed *after* the pairing gate deliberately: synthesis costs money and
      sends text to a third party, so an unpaired device on the LAN must not
      be able to trigger it.
    */
    if (url.pathname === '/api/voice/tts/status') {
      // No key, no key length, no key prefix. Just what the interface needs to
      // tell the operator whether ZERO can speak and where the words go.
      sendJson(res, 200, publicStatus(loadTtsConfig()));
      return;
    }

    if (url.pathname === '/api/voice/tts' && req.method === 'POST') {
      readJsonBody(req)
        .then(async (payload) => {
          const ttsConfig = loadTtsConfig();
          const text = typeof payload?.text === 'string' ? payload.text : '';
          if (!text.trim()) {
            sendJson(res, 400, { error: 'empty_text' });
            return;
          }
          const status = publicStatus(ttsConfig);
          if (!status.ready) {
            // A stated refusal, not a 500: the interface falls back to the
            // browser voice and the operator is told which one is speaking.
            sendJson(res, 503, { error: status.reason ?? 'tts_unavailable', fallback: ttsConfig.fallback });
            return;
          }

          const controller = new AbortController();
          req.on('aborted', () => controller.abort());
          const result = await synthesize(text, ttsConfig, { signal: controller.signal });
          if (!result.ok) {
            if (result.code === 'aborted') {
              res.destroy();
              return;
            }
            sendJson(res, result.code === 'fish_rate_limited' ? 429 : 502, {
              error: result.code,
              detail: redact(result.detail ?? '', ttsConfig),
              fallback: ttsConfig.fallback,
            });
            return;
          }

          res.writeHead(200, {
            'content-type': result.contentType,
            'cache-control': 'no-store',
            // The interface shows which voice spoke; these are the same facts
            // /api/voice/tts/status reports, and neither carries a secret.
            'x-zero-tts-provider': 'fish_audio',
            'x-zero-tts-model': result.model,
          });
          // Streamed through rather than buffered: a phone should not hold a
          // whole answer's audio in the gateway as well as in the browser.
          if (result.body && typeof result.body.getReader === 'function') {
            const reader = result.body.getReader();
            const pump = async () => {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(Buffer.from(value))) {
                  await new Promise((ready) => res.once('drain', ready));
                }
              }
            };
            await pump().catch(() => undefined);
          }
          res.end();
        })
        .catch((error) => {
          sendJson(res, 500, { error: 'tts_failed', detail: redact(error?.message ?? '', {}) });
        });
      return;
    }

    /*
      ZERO driving a real browser.

      Here rather than in HWD-ZERO because Playwright cannot live there — that
      process keeps one runtime dependency so it stays installable on a phone.
      Behind the pairing gate for the same reason the voice is: this opens a
      browser and reaches the internet from the operator's machine.
    */
    if (url.pathname === '/api/browser/status') {
      // Every browser ZERO knows, and what this machine can do with each.
      browserPool()
        .status()
        .then((status) => sendJson(res, 200, status))
        .catch((error) => sendJson(res, 500, { error: 'browser_status_failed', detail: error.message }));
      return;
    }

    if (url.pathname === '/api/browser/open' && req.method === 'POST') {
      readJsonBody(req)
        .then(async (payload) => {
          const target = typeof payload?.url === 'string' ? payload.url.trim() : '';
          if (!target) {
            sendJson(res, 400, { error: 'empty_url' });
            return;
          }
          try {
            // `browser` chooses between Chrome, Edge, Brave and Firefox;
            // omitted, it is the configured default.
            sendJson(res, 200, await browserPool().open(target, payload?.browser));
          } catch (error) {
            // A refusal is the runtime's answer, not a fault: 403 so the
            // caller can tell "not allowed" from "did not work".
            const refused = error?.code === 'browser_url_refused' || error?.code === 'local_only';
            sendJson(res, refused ? 403 : 502, {
              error: error?.code ?? 'browser_failed',
              detail: error?.message ?? String(error),
            });
          }
        })
        .catch((error) => sendJson(res, 500, { error: 'browser_failed', detail: error.message }));
      return;
    }

    if (url.pathname === '/api/browser/close' && req.method === 'POST') {
      readJsonBody(req)
        .then((payload) => browserPool().close(payload?.browser))
        .then((closed) => sendJson(res, 200, { closed }))
        .catch((error) => sendJson(res, 500, { error: 'browser_failed', detail: error.message }));
      return;
    }

    if (url.pathname.startsWith(`${PUBLIC_API_BASE}/`)) {
      proxyHttp(req, res, config.zeroApi, url.pathname, url.search);
      return;
    }

    const filePath = resolveStaticPath(config.distDir, url.pathname);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      sendFile(res, filePath);
      return;
    }
    // SPA fallback.
    const indexPath = join(config.distDir, 'index.html');
    if (existsSync(indexPath)) {
      sendFile(res, indexPath);
      return;
    }
    sendJson(res, 503, {
      error: 'ui_not_built',
      message: 'Run `npm run build` first — the gateway serves the built interface.',
    });
  };

  const handleUpgrade = (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = resolveWsRoute(url.pathname, config);
    if (!route) {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorize(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // The pairing token is a gateway credential and stops here; upstream sees
    // a plain upgrade from loopback.
    const search = url.search.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');
    proxyUpgrade(req, socket, head, route.target, route.path, search);
  };

  const server = createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  // A proxy error must never take the gateway down. `proxyHttp` and
  // `proxyUpgrade` already handle their own sockets, but an error emitted on a
  // client socket that has no listener would otherwise reach the process.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    socket.destroy();
  });

  const [primaryAddress, ...alsoBind] = bindAddresses(config);
  const secondary = [];

  server.listen(config.port, primaryAddress, () => {
    // The extra loopback family binds to the port the primary actually got,
    // which matters when the port is 0 (tests) — otherwise the two listeners
    // would land on different ports.
    const port = server.address()?.port ?? config.port;
    for (const address of alsoBind) {
      const extra = createServer(handleRequest);
      extra.on('upgrade', handleUpgrade);
      extra.on('clientError', (_error, socket) => socket.destroy());
      // Best effort: a host without IPv6 skips this and the gateway stays up.
      extra.on('error', (error) => {
        if (!config.quiet) {
          process.stdout.write(`NOTE:     ${address} not bound (${error.code ?? error.message})\n`);
        }
      });
      try {
        extra.listen(port, address);
        secondary.push(extra);
      } catch {
        /* same as the error handler: an unavailable family is not fatal */
      }
    }

    if (config.quiet) return;
    const lan = detectLanAddress();
    process.stdout.write('\nZERO GATEWAY ONLINE\n\n');
    process.stdout.write(`LOCAL:    http://127.0.0.1:${port}\n`);
    process.stdout.write(`          http://localhost:${port}\n`);
    if (config.lanMode) {
      process.stdout.write(
        lan
          ? `LAN:      http://${lan}:${port}/?token=${token}\n`
          : 'LAN:      no LAN address detected — is the device connected to a network?\n',
      );
    } else {
      process.stdout.write('LAN:      disabled (start with ZERO_LAN_MODE=true)\n');
    }
    process.stdout.write(`ZERO API: ${PUBLIC_API_BASE} → ${config.zeroApi} (loopback only)\n`);
    process.stdout.write(
      `EVENTS:   ${PUBLIC_WS_PATH} → ${config.zeroRuntimeWs} (loopback only)\n`,
    );
    process.stdout.write(`TOKEN:    ${config.tokenFile}\n\n`);
  });

  // Closing the handle closes every listener it opened.
  const closePrimary = server.close.bind(server);
  server.close = (callback) => {
    for (const extra of secondary) extra.close();
    return closePrimary(callback);
  };
  server.boundAddresses = () => [server, ...secondary].map((s) => s.address()).filter(Boolean);

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startGateway();
}
