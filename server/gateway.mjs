#!/usr/bin/env node
/**
 * ZERO Gateway.
 *
 * One origin for every device, including the phone it runs on:
 *
 *     Galaxy browser (same phone, Termux)     Galaxy / laptop over WiFi
 *              │  http://localhost:3000                │  http://<lan-ip>:3000
 *              ▼                                       ▼
 *        ZERO GATEWAY  ──  /            → the built brain interface
 *              │           /api/*       → HWD-ZERO API   (127.0.0.1 only)
 *              │           /ws/*        → HWD-ZERO events (127.0.0.1 only)
 *              ▼
 *        HWD-ZERO (127.0.0.1:8000)
 *
 * Rules this file enforces:
 *   - Only the gateway may listen on the LAN, and only with ZERO_LAN_MODE=true.
 *   - Upstream ZERO, Ollama and every child agent stay on loopback.
 *   - LAN access requires a token that is generated on first run, stored with
 *     0600 permissions outside the repository and never baked into the bundle.
 *   - No tunnels, no UPnP, no port forwarding — LAN is as far as this goes.
 *
 * Same-device Termux operation needs no LAN mode at all: the gateway binds
 * both loopback addresses (`127.0.0.1` and `::1`) so that the URL Android's
 * browser is given — `http://localhost:3000` — resolves either way. Android
 * hands out `::1` first, which is why an IPv4-only bind shows a blank page on
 * the very phone that is running the server.
 */
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalPaths, detectRuntime, loopbackHosts } from './platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

export const DEFAULT_PORT = 3000;
export const DEFAULT_ZERO_API = 'http://127.0.0.1:8000';

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

/** Routes that never require a token (needed to render the login screen). */
const PUBLIC_PATHS = new Set(['/api/gateway/health']);

export function readConfig(env = process.env) {
  const lanMode = String(env.ZERO_LAN_MODE ?? '').toLowerCase() === 'true';
  const runtime = detectRuntime(env);
  // Loopback mode listens on every loopback address; LAN mode binds the one
  // wildcard address and adds nothing else, so IPv6 never widens the exposure.
  const hosts = lanMode ? ['0.0.0.0'] : loopbackHosts(env);
  return {
    port: Number(env.ZERO_UI_PORT ?? DEFAULT_PORT),
    // LAN mode is the only way to leave loopback, and it is explicit.
    host: hosts[0],
    // Additional addresses bound to the same port once the first one is up.
    extraHosts: hosts.slice(1),
    lanMode,
    runtime,
    zeroApi: env.ZERO_API_URL ?? DEFAULT_ZERO_API,
    distDir: env.ZERO_UI_DIST ?? join(projectRoot, 'dist'),
    tokenFile: env.ZERO_TOKEN_FILE ?? join(projectRoot, '.zero', 'gateway-token'),
    // Requests per minute per client address.
    rateLimit: Number(env.ZERO_RATE_LIMIT ?? 240),
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

/** Resolves a URL path inside dist, refusing anything that escapes it. */
export function resolveStaticPath(distDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = normalize(join(distDir, decoded === '/' ? 'index.html' : decoded));
  const root = normalize(distDir);
  if (!candidate.startsWith(root)) return null;
  return candidate;
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

/** True when the caller is a browser asking for a page, not an API client. */
export function wantsHtml(req) {
  const accept = req.headers?.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/**
 * The page `http://localhost:3000` shows before the interface has been built.
 *
 * Self-contained on purpose: no bundle exists yet, so it cannot load one. It
 * states the host it detected and the exact command to run, which on the phone
 * is the difference between "blank page" and "I know what to do".
 */
export function bootPage(config) {
  // Anchored at the checkout, not the cwd: the gateway may be started from anywhere.
  const paths = canonicalPaths({ startDir: projectRoot });
  const command = config.runtime.termux
    ? 'bash scripts/setup-termux.sh'
    : 'npm install && npm run build';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ZERO — interface not built</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0406; color:#f3e8ea; font:16px/1.6 ui-sans-serif,system-ui,sans-serif; padding:6vw; }
  main { max-width:34rem; }
  h1 { font-size:1.3rem; letter-spacing:.18em; text-transform:uppercase; color:#ff4d5e; margin:0 0 1.2rem; }
  code, pre { font-family:ui-monospace,monospace; }
  pre { background:#1a0d11; border:1px solid #3a1c22; border-radius:.6rem;
        padding:1rem; overflow-x:auto; font-size:.95rem; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:.35rem 1rem; font-size:.9rem; color:#c9aeb3; }
  dt { color:#8e6e74; }
</style>
</head>
<body>
<main>
  <h1>ZERO GATEWAY ONLINE — INTERFACE NOT BUILT</h1>
  <p>The gateway is answering on this address, so networking is fine. What is
     missing is the compiled interface. Run this in Termux, then reload:</p>
  <pre>cd ${escapeHtml(paths.brainInterface)}
${escapeHtml(command)}</pre>
  <dl>
    <dt>host</dt><dd>${escapeHtml(config.runtime.name)} / ${escapeHtml(config.runtime.arch)}</dd>
    <dt>bundle</dt><dd>${escapeHtml(config.distDir)}</dd>
    <dt>ZERO API</dt><dd>${escapeHtml(config.zeroApi)}</dd>
    <dt>workspace</dt><dd>${escapeHtml(paths.workspace)}${paths.exists ? '' : ' (not created yet)'}</dd>
  </dl>
</main>
</body>
</html>
`;
}

function proxyHttp(req, res, target, pathname, search) {
  const upstream = new URL(target);
  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: `${pathname}${search}`,
    method: req.method,
    headers: { ...req.headers, host: upstream.host },
  };
  // The gateway's own token never travels upstream.
  delete options.headers.authorization;
  delete options.headers.cookie;

  import('node:http').then(({ request }) => {
    const proxied = request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    proxied.on('error', (error) => {
      sendJson(res, 502, {
        error: 'zero_api_unreachable',
        message: `HWD-ZERO is not reachable at ${target}: ${error.message}`,
      });
    });
    req.pipe(proxied);
  });
}

/** Raw TCP pipe for the WebSocket upgrade to ZERO's event stream. */
function proxyUpgrade(req, socket, head, target, pathname, search) {
  const upstream = new URL(target);
  const client = netConnect(Number(upstream.port || 80), upstream.hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== 'authorization' && key !== 'cookie')
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    client.write(
      `${req.method} ${pathname}${search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`,
    );
    if (head?.length) client.write(head);
    client.pipe(socket);
    socket.pipe(client);
  });
  client.on('error', () => socket.destroy());
  socket.on('error', () => client.destroy());
}

export function startGateway(config = readConfig()) {
  const token = loadOrCreateToken(config.tokenFile);
  const allow = createRateLimiter(config.rateLimit);
  // Filled in as each address comes up. The health probe reports what is
  // actually listening, not what was asked for — a device without IPv6
  // loopback must not claim `::1` works.
  const bound = [];

  const authorize = (req, url) => {
    // On loopback the device's own browser is trusted — on Termux that is the
    // phone's browser talking to the phone. The LAN never is.
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!config.lanMode && isLoopback) return true;
    const provided = extractToken(req, url);
    return provided !== null && constantTimeEquals(provided, token);
  };

  const handleRequest = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const remote = req.socket.remoteAddress ?? 'unknown';

    if (!allow(remote)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }

    if (PUBLIC_PATHS.has(url.pathname)) {
      sendJson(res, 200, {
        gateway: 'ok',
        lanMode: config.lanMode,
        zeroApi: config.zeroApi,
        authRequired: config.lanMode,
        // The doctor script and the boot page both read these.
        host: config.runtime.name,
        arch: config.runtime.arch,
        termux: config.runtime.termux,
        addresses: [...bound],
        uiBuilt: existsSync(join(config.distDir, 'index.html')),
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
    // A phone browser showing a raw JSON error is a dead end. Send a page that
    // says what to run instead — it is the first thing localhost:3000 renders
    // on a fresh install.
    if (wantsHtml(req)) {
      sendHtml(res, 503, bootPage(config));
      return;
    }
    sendJson(res, 503, {
      error: 'ui_not_built',
      message: 'Run `npm run build` first — the gateway serves the built interface.',
      distDir: config.distDir,
    });
  };

  const handleUpgrade = (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    if (!authorize(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, config.zeroApi, url.pathname, url.search);
  };

  const newServer = () => {
    const instance = createServer(handleRequest);
    instance.on('upgrade', handleUpgrade);
    return instance;
  };

  const server = newServer();
  /** Every additional loopback address bound to the same port. */
  const secondary = [];

  server.listen(config.port, config.host, () => {
    // `config.port` may be 0 (tests, or a deliberate ephemeral run); the extra
    // addresses must join the port that was actually granted, not ask for a
    // second random one.
    const port = server.address()?.port ?? config.port;
    bound.push(config.host);
    for (const host of config.extraHosts) {
      const extra = newServer();
      // A device without IPv6 loopback is normal, not an error: `127.0.0.1`
      // already answers, so the gateway keeps running either way.
      extra.on('error', (error) => {
        process.stdout.write(`NOTE:     ${host} unavailable (${error.code ?? error.message})\n`);
      });
      extra.listen(port, host, () => bound.push(host));
      secondary.push(extra);
    }
    // Extra addresses finish binding on the next tick; print once they have.
    setImmediate(() => printBanner(config, port, token, bound));
  });

  // Closing the gateway must release every address it took.
  server.on('close', () => {
    for (const extra of secondary.splice(0)) extra.close();
  });

  return server;
}

function printBanner(config, port, token, bound) {
  const { runtime } = config;
  process.stdout.write('\nZERO GATEWAY ONLINE\n\n');
  process.stdout.write(`HOST:     ${runtime.name} / ${runtime.arch}\n`);
  if (config.lanMode) {
    const lan = detectLanAddress();
    process.stdout.write(`LOCAL:    http://localhost:${port}\n`);
    process.stdout.write(
      lan
        ? `MOBILE:   http://${lan}:${port}/?token=${token}\n`
        : 'MOBILE:   no LAN address detected — connect to a network or start the hotspot.\n',
    );
  } else {
    // The same-device Galaxy case: this is the URL to open in the browser.
    process.stdout.write(`BROWSER:  http://localhost:${port}\n`);
    process.stdout.write(`BOUND:    ${bound.join(', ')}\n`);
    process.stdout.write('MOBILE:   remote access disabled (start with ZERO_LAN_MODE=true)\n');
  }
  process.stdout.write(`ZERO API: ${config.zeroApi} (loopback only)\n`);
  process.stdout.write(`TOKEN:    ${config.tokenFile}\n\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startGateway();
}
