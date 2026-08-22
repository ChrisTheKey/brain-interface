#!/usr/bin/env node
/**
 * ZERO Gateway — the single origin of the Brain Interface.
 *
 *     Galaxy / laptop browser
 *              │  http://<host>:3000
 *              ▼
 *        ZERO GATEWAY  ──  /            → the built brain interface
 *              │           /api/*       → HWD-ZERO API      (127.0.0.1 only)
 *              │           /ws/events   → HWD-ZERO events   (127.0.0.1 only)
 *              │           /ws/voice    → HWD-ZERO voice    (127.0.0.1 only)
 *              ▼
 *        HWD-ZERO (127.0.0.1:8000)
 *
 * Rules this file enforces:
 *   - Only the gateway may listen on the LAN, and only with ZERO_LAN_MODE=true.
 *   - Upstream HWD-ZERO, Ollama and every child agent stay on loopback.
 *   - LAN access requires a token that is generated on first run, stored with
 *     0600 permissions outside the repository and never baked into the bundle.
 *   - No tunnels, no UPnP, no port forwarding — LAN is as far as this goes.
 *   - The gateway is independent of HWD-ZERO: when the operator is down the
 *     interface still loads and says so. It never fabricates operator data.
 *
 * Pure Node ESM, no native modules — so it runs under Termux on the phone as
 * well as on the laptop.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

export const DEFAULT_PORT = 3000;
export const DEFAULT_ZERO_API = 'http://127.0.0.1:8000';

/**
 * The only upgrade paths that exist. `/ws/events` carries the operator's
 * event stream, `/ws/voice` the voice channel (transcripts + TTS audio).
 * Anything else is refused rather than blindly forwarded upstream.
 */
export const WS_PATHS = ['/ws/events', '/ws/voice'];

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
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Routes that never require a token (needed to render the pairing screen). */
const PUBLIC_PATHS = new Set(['/api/gateway/health']);

/** Sent on every response. Cheap, and they cost the brain nothing. */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
};

export function readConfig(env = process.env) {
  const lanMode = String(env.ZERO_LAN_MODE ?? '').toLowerCase() === 'true';
  return {
    port: Number(env.ZERO_UI_PORT ?? DEFAULT_PORT),
    // LAN mode is the only way to leave loopback, and it is explicit.
    host: lanMode ? '0.0.0.0' : '127.0.0.1',
    lanMode,
    zeroApi: env.ZERO_API_URL ?? DEFAULT_ZERO_API,
    distDir: env.ZERO_UI_DIST ?? join(projectRoot, 'dist'),
    tokenFile: env.ZERO_TOKEN_FILE ?? join(projectRoot, '.zero', 'gateway-token'),
    // Requests per minute per client address.
    rateLimit: Number(env.ZERO_RATE_LIMIT ?? 240),
    // How long a health probe of HWD-ZERO may take before it counts as down.
    upstreamTimeoutMs: Number(env.ZERO_UPSTREAM_TIMEOUT_MS ?? 1_500),
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
  // Browsers cannot set headers on a WebSocket handshake, so the pairing
  // cookie (or ?token=) is what authenticates /ws/events and /ws/voice.
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

/** Resolves a URL path inside dist, refusing anything that escapes it. */
export function resolveStaticPath(distDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = normalize(join(distDir, decoded === '/' ? 'index.html' : decoded));
  const root = normalize(distDir);
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

/** True for the two upgrade endpoints the interface actually speaks. */
export function isWebSocketPath(pathname) {
  return WS_PATHS.includes(pathname);
}

/** Running under Termux? Only used to print the right hint. */
export function isTermux(env = process.env) {
  return Boolean(env.TERMUX_VERSION) || String(env.PREFIX ?? '').includes('com.termux');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(req, res, filePath) {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const stats = statSync(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'content-length': stats.size,
    // The bundle is hashed; index.html must never be cached.
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/**
 * Cheap, cached reachability probe of HWD-ZERO. The gateway must be able to
 * answer "is the operator up?" without depending on the operator being up.
 */
export function createUpstreamProbe(target, timeoutMs, now = () => Date.now()) {
  let cached = { reachable: false, checkedAt: 0, error: 'not probed yet' };
  let inFlight = null;

  return function probe() {
    if (now() - cached.checkedAt < 3_000 && cached.checkedAt !== 0) {
      return Promise.resolve(cached);
    }
    if (inFlight) return inFlight;
    inFlight = new Promise((resolveProbe) => {
      const finish = (reachable, error) => {
        cached = { reachable, checkedAt: now(), ...(error ? { error } : {}) };
        inFlight = null;
        resolveProbe(cached);
      };
      let request;
      try {
        request = httpRequest(`${target}/api/health`, { method: 'GET' }, (response) => {
          response.resume();
          finish((response.statusCode ?? 500) < 500);
        });
      } catch (error) {
        finish(false, error.message);
        return;
      }
      request.on('error', (error) => finish(false, error.message));
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish(false, `no answer within ${timeoutMs} ms`);
      });
      request.end();
    });
    return inFlight;
  };
}

function proxyHttp(req, res, target, pathname, search) {
  const upstream = new URL(target);
  const headers = { ...req.headers, host: upstream.host };
  // The gateway's own token never travels upstream.
  delete headers.authorization;
  delete headers.cookie;

  const proxied = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: `${pathname}${search}`,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, {
        ...upstreamRes.headers,
        ...SECURITY_HEADERS,
      });
      upstreamRes.pipe(res);
    },
  );
  proxied.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Honest degradation: the interface renders "operator offline", it never
    // gets a synthesised success.
    sendJson(res, 502, {
      error: 'zero_api_unreachable',
      message: `HWD-ZERO is not reachable at ${target}: ${error.message}`,
    });
  });
  req.pipe(proxied);
}

/**
 * Raw TCP pipe for a WebSocket upgrade. Byte-level, so it carries the JSON
 * frames of `/ws/events` and the binary audio frames of `/ws/voice` alike.
 */
function proxyUpgrade(req, socket, head, target, pathname, search) {
  const upstream = new URL(target);
  let established = false;
  const client = netConnect(Number(upstream.port || 80), upstream.hostname, () => {
    established = true;
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== 'authorization' && key !== 'cookie')
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    client.write(`${req.method} ${pathname}${search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head?.length) client.write(head);
    client.pipe(socket);
    socket.pipe(client);
  });
  client.on('error', () => {
    // Before the pipe exists the browser is still waiting on the handshake, so
    // answer it: a 502 tells the client to back off and retry, a silent
    // destroy looks like a network glitch and triggers a hot reconnect loop.
    if (!established && !socket.destroyed) {
      const body = JSON.stringify({ error: 'zero_api_unreachable', path: pathname });
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
          'content-type: application/json; charset=utf-8\r\n' +
          `content-length: ${Buffer.byteLength(body)}\r\n` +
          'connection: close\r\n\r\n' +
          body,
      );
    }
    socket.destroy();
  });
  socket.on('error', () => client.destroy());
}

export function startGateway(config = readConfig()) {
  const token = loadOrCreateToken(config.tokenFile);
  const allow = createRateLimiter(config.rateLimit);
  const probeUpstream = createUpstreamProbe(config.zeroApi, config.upstreamTimeoutMs);

  const authorize = (req, url) => {
    // On loopback the laptop's own browser is trusted; the LAN never is.
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!config.lanMode && isLoopback) return true;
    const provided = extractToken(req, url);
    return provided !== null && constantTimeEquals(provided, token);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const remote = req.socket.remoteAddress ?? 'unknown';

    if (!allow(remote)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }

    // The gateway's own health never depends on HWD-ZERO being up: it reports
    // whether the operator answers, which is exactly what the UI needs to say
    // "operator offline" instead of showing an empty brain.
    if (PUBLIC_PATHS.has(url.pathname)) {
      void probeUpstream().then((upstream) => {
        sendJson(res, 200, {
          gateway: 'ok',
          lanMode: config.lanMode,
          zeroApi: config.zeroApi,
          authRequired: config.lanMode,
          websocketPaths: WS_PATHS,
          upstream,
        });
      });
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
        ...SECURITY_HEADERS,
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

    if (url.pathname.startsWith('/api/')) {
      proxyHttp(req, res, config.zeroApi, url.pathname, url.search);
      return;
    }

    // A websocket path reached over plain HTTP is a client that forgot to
    // upgrade — say so instead of serving it the SPA shell.
    if (isWebSocketPath(url.pathname)) {
      sendJson(res, 426, { error: 'upgrade_required', path: url.pathname });
      return;
    }

    const filePath = resolveStaticPath(config.distDir, url.pathname);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      sendFile(req, res, filePath);
      return;
    }
    // SPA fallback.
    const indexPath = join(config.distDir, 'index.html');
    if (existsSync(indexPath)) {
      sendFile(req, res, indexPath);
      return;
    }
    sendJson(res, 503, {
      error: 'ui_not_built',
      message: 'Run `npm run build` first — the gateway serves the built interface.',
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!isWebSocketPath(url.pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorize(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, config.zeroApi, url.pathname, url.search);
  });

  server.listen(config.port, config.host, () => {
    const lan = detectLanAddress();
    process.stdout.write('\nZERO GATEWAY ONLINE\n\n');
    process.stdout.write(`LAPTOP:   http://127.0.0.1:${config.port}\n`);
    if (config.lanMode) {
      process.stdout.write(
        lan
          ? `MOBILE:   http://${lan}:${config.port}/?token=${token}\n`
          : 'MOBILE:   no LAN address detected — is the laptop connected to a network?\n',
      );
    } else {
      process.stdout.write('MOBILE:   disabled (start with ZERO_LAN_MODE=true)\n');
    }
    process.stdout.write(`ZERO API: ${config.zeroApi} (loopback only)\n`);
    process.stdout.write(`SOCKETS:  ${WS_PATHS.join('  ')}\n`);
    process.stdout.write(`TOKEN:    ${config.tokenFile}\n`);
    if (isTermux()) {
      process.stdout.write(
        'TERMUX:   detected — keep the session awake with `termux-wake-lock`.\n',
      );
    }
    process.stdout.write('\n');
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = startGateway();
  const shutdown = () => {
    server.close(() => process.exit(0));
    // Never hang on a websocket that refuses to drain.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
