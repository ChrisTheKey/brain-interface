#!/usr/bin/env node
/**
 * ZERO Gateway.
 *
 * One origin for laptop and phone:
 *
 *     Galaxy / laptop browser
 *              │  http://<host>:3000
 *              ▼
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
 */
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

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

    if (PUBLIC_PATHS.has(url.pathname)) {
      sendJson(res, 200, {
        gateway: 'ok',
        lanMode: config.lanMode,
        zeroApi: config.zeroApi,
        authRequired: config.lanMode,
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
    sendJson(res, 503, {
      error: 'ui_not_built',
      message: 'Run `npm run build` first — the gateway serves the built interface.',
    });
  });

  server.on('upgrade', (req, socket, head) => {
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
    process.stdout.write(`TOKEN:    ${config.tokenFile}\n\n`);
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startGateway();
}
