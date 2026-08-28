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
 *              │           /api/*       → HWD-ZERO API      (127.0.0.1 only)
 *              │           /ws/*        → HWD-ZERO events   (127.0.0.1 only)
 *              │           /zero-ws     → ZERO app-server   (127.0.0.1 only)
 *              ▼
 *        HWD-ZERO (127.0.0.1:8000)  ·  ZERO app-server (127.0.0.1:8787)
 *
 * Rules this file enforces:
 *   - Only the gateway may listen on the LAN, and only with ZERO_LAN_MODE=true.
 *   - Upstream ZERO, Ollama and every child agent stay on loopback. That is
 *     what `/zero-ws` is for: the phone's browser cannot reach the ZERO
 *     app-server at 127.0.0.1:8787 — that address is the *phone's* own
 *     loopback — so the gateway carries the connection instead, behind the
 *     same token as everything else. The app-server never leaves loopback.
 *   - LAN access requires a token that is generated on first run, stored with
 *     0600 permissions outside the repository and never baked into the bundle.
 *   - No tunnels, no UPnP, no port forwarding — LAN is as far as this goes.
 *
 * Two upstreams live in this process rather than behind it, because both hold
 * a credential or a process the browser must never touch directly:
 *
 *     /api/voice/fish/*   → Fish Audio  (the API key stays here)
 *     /api/browser/*      → the browser bridge (Chrome, Firefox, Brave, Edge)
 */
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BrowserBridge, readBrowserConfig, BlockedUrlError } from './browser/bridge.mjs';
import { fishStatus, listVoices, readFishConfig, requestSpeech, FishRequestError } from './fishAudio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

export const DEFAULT_PORT = 3000;
export const DEFAULT_ZERO_API = 'http://127.0.0.1:8000';
/** ZERO's app-server (`codex app-server --listen ws://127.0.0.1:8787`). */
export const DEFAULT_ZERO_APP_SERVER = 'ws://127.0.0.1:8787';
/** Path the interface connects to when it goes through the gateway. */
export const ZERO_WS_PATH = '/zero-ws';

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
    // The app-server the interface talks JSON-RPC to. Stays on loopback; the
    // gateway is the only thing that reaches it.
    zeroAppServer: env.ZERO_APP_SERVER_URL ?? DEFAULT_ZERO_APP_SERVER,
    distDir: env.ZERO_UI_DIST ?? join(projectRoot, 'dist'),
    tokenFile: env.ZERO_TOKEN_FILE ?? join(projectRoot, '.zero', 'gateway-token'),
    // Requests per minute per client address.
    rateLimit: Number(env.ZERO_RATE_LIMIT ?? 240),
    fish: readFishConfig(env),
    browser: readBrowserConfig(env),
    /** Largest JSON body the gateway's own endpoints accept. */
    maxBodyBytes: Number(env.ZERO_MAX_BODY_BYTES ?? 256 * 1024),
  };
}

/** Reads a JSON request body, refusing anything oversized or malformed. */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => reject(new HttpError(error.message, 400)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError('request body is not valid JSON', 400));
      }
    });
  });
}

export class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
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

/**
 * Query string for an upstream request, with the gateway's own pairing token
 * removed. The token authenticates the *device to the gateway* — HWD-ZERO and
 * the app-server have no business seeing it, exactly as with the
 * `authorization` and `cookie` headers below.
 */
export function upstreamSearch(search) {
  const params = new URLSearchParams(search ?? '');
  if (!params.has('token')) return search ?? '';
  params.delete('token');
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
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

/**
 * Raw TCP pipe for a WebSocket upgrade to an upstream on loopback.
 *
 * `rewriteHost` replaces the client's Host header with the upstream's. The
 * ZERO app-server is reached this way, so it sees the loopback address it is
 * bound to rather than the phone-facing host the browser sent.
 */
function proxyUpgrade(req, socket, head, target, pathname, search, { rewriteHost = false } = {}) {
  const upstream = new URL(target);
  const client = netConnect(Number(upstream.port || 80), upstream.hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== 'authorization' && key !== 'cookie')
      .filter(([key]) => !(rewriteHost && key.toLowerCase() === 'host'))
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    if (rewriteHost) headers.unshift(`host: ${upstream.host}`);
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

/**
 * Fish Audio routes. The key never leaves this process: the browser posts
 * text to its own origin and receives audio back.
 */
async function handleFishRoute(req, res, url, config) {
  if (url.pathname === '/api/voice/fish/status' && req.method === 'GET') {
    sendJson(res, 200, fishStatus(config.fish));
    return true;
  }

  if (url.pathname === '/api/voice/fish/voices' && req.method === 'GET') {
    const voices = await listVoices(config.fish, url.searchParams.get('q') ?? '');
    sendJson(res, 200, { data: voices });
    return true;
  }

  if (url.pathname === '/api/voice/fish/speak' && req.method === 'POST') {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const { response, format, sampleRate, release } = await requestSpeech(body, config.fish);
    res.writeHead(200, {
      // The provider needs the wire format to decode PCM without guessing.
      'content-type': response.headers.get('content-type') ?? contentTypeFor(format),
      'x-zero-audio-format': format,
      'x-zero-audio-sample-rate': String(sampleRate),
      'cache-control': 'no-store',
    });

    const reader = response.body?.getReader();
    if (!reader) {
      release();
      res.end();
      return true;
    }
    // The client hanging up must stop the upstream read, not leak it.
    let aborted = false;
    res.on('close', () => {
      aborted = true;
      void reader.cancel().catch(() => undefined);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        if (value?.length && !res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } finally {
      release();
      res.end();
    }
    return true;
  }

  return false;
}

function contentTypeFor(format) {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Browser-bridge routes: this is ZERO's access to the internet, through the
 * operator's own Chrome, Firefox, Brave or Edge.
 */
async function handleBrowserRoute(req, res, url, config, bridge) {
  if (url.pathname === '/api/browser/status' && req.method === 'GET') {
    sendJson(res, 200, bridge.status());
    return true;
  }
  if (!url.pathname.startsWith('/api/browser/')) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const body = await readJsonBody(req, config.maxBodyBytes);

  switch (url.pathname) {
    case '/api/browser/launch':
      sendJson(res, 200, { active: await bridge.launch(body.browser) });
      return true;
    case '/api/browser/open':
      sendJson(res, 200, await bridge.open(body.url, body));
      return true;
    case '/api/browser/read':
      sendJson(res, 200, await bridge.read(body));
      return true;
    case '/api/browser/search':
      sendJson(res, 200, await bridge.search(body.query, body));
      return true;
    case '/api/browser/close':
      sendJson(res, 200, await bridge.close());
      return true;
    default:
      sendJson(res, 404, { error: 'unknown_browser_route', path: url.pathname });
      return true;
  }
}

/** Maps a handler failure onto a status the interface can act on. */
function sendRouteError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof BlockedUrlError) {
    sendJson(res, 403, { error: 'url_blocked', message: error.message, url: error.url });
    return;
  }
  if (error instanceof FishRequestError || error instanceof HttpError) {
    sendJson(res, error.status, { error: error.name, message: error.message });
    return;
  }
  sendJson(res, 500, { error: 'gateway_error', message: error?.message ?? 'unknown error' });
}

export function startGateway(config = readConfig()) {
  const token = loadOrCreateToken(config.tokenFile);
  const allow = createRateLimiter(config.rateLimit);
  const bridge = new BrowserBridge(config.browser);

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
      // The probe is public so the pairing screen can render before a token
      // exists. What this gateway *contains* — the installed browsers, the
      // install path of the MCP server — is not public: it is added only for a
      // caller that is already allowed in.
      sendJson(res, 200, {
        gateway: 'ok',
        lanMode: config.lanMode,
        zeroApi: config.zeroApi,
        authRequired: config.lanMode,
        ...(authorize(req, url)
          ? {
              // What this gateway can do beyond proxying, so the interface never
              // has to probe an endpoint to find out whether it exists.
              features: {
                fishAudio: config.fish.configured,
                browser: bridge
                  .status()
                  .browsers.filter((browser) => browser.installed)
                  .map((browser) => browser.id),
                // The exact command ZERO needs in `[mcp_servers.zero_browser]`.
                // The gateway knows where it is installed; the browser does not.
                browserMcp: {
                  command: process.execPath,
                  args: [join(projectRoot, 'mcp', 'brain-browser-server.mjs')],
                },
              },
            }
          : {}),
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

    // The gateway's own endpoints are served here; everything else under
    // /api belongs to HWD-ZERO and is proxied on loopback.
    if (url.pathname.startsWith('/api/voice/fish/') || url.pathname.startsWith('/api/browser/')) {
      const handle = url.pathname.startsWith('/api/browser/')
        ? handleBrowserRoute(req, res, url, config, bridge)
        : handleFishRoute(req, res, url, config);
      void handle
        .then((handled) => {
          if (!handled) sendJson(res, 404, { error: 'unknown_route', path: url.pathname });
        })
        .catch((error) => sendRouteError(res, error));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      proxyHttp(req, res, config.zeroApi, url.pathname, upstreamSearch(url.search));
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
    const toAppServer = url.pathname === ZERO_WS_PATH || url.pathname.startsWith(`${ZERO_WS_PATH}/`);
    if (!toAppServer && !url.pathname.startsWith('/ws')) {
      // Answer rather than drop: a silently destroyed socket leaves the client
      // waiting for its own timeout instead of failing straight away.
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // The app-server can start threads and run commands. It is behind the
    // same token as every other route — the LAN is never trusted.
    if (!authorize(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (toAppServer) {
      // The app-server serves its own root path, not `/zero-ws`.
      const upstreamPath = new URL(config.zeroAppServer).pathname || '/';
      proxyUpgrade(req, socket, head, config.zeroAppServer, upstreamPath, upstreamSearch(url.search), {
        rewriteHost: true,
      });
      return;
    }
    proxyUpgrade(req, socket, head, config.zeroApi, url.pathname, upstreamSearch(url.search));
  });

  // The bridge owns a real browser process; it must not outlive the gateway.
  server.on('close', () => {
    void bridge.close();
  });
  server.browserBridge = bridge;

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
    process.stdout.write(
      `ZERO WS:  ${config.zeroAppServer} (loopback only, carried on ${ZERO_WS_PATH})\n`,
    );
    process.stdout.write(`TOKEN:    ${config.tokenFile}\n`);
    process.stdout.write(
      `VOICE:    Fish Audio ${config.fish.configured ? `ready (${config.fish.model})` : 'off (set FISH_AUDIO_API_KEY)'}\n`,
    );
    const installed = bridge
      .status()
      .browsers.filter((browser) => browser.installed)
      .map((browser) => browser.id);
    process.stdout.write(
      `BROWSER:  ${installed.length > 0 ? installed.join(', ') : 'none detected'}\n\n`,
    );
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startGateway();
}
