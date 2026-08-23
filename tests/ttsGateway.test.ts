import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { loadOrCreateToken, readConfig, startGateway } from '../server/gateway.mjs';

/**
 * The two routes the gateway keeps for itself.
 *
 * Everything else under `/api` is proxied to HWD-ZERO. These two are not,
 * because this is the only process that holds the Fish Audio key — and that
 * makes their access control the gateway's problem rather than the runtime's.
 * On a LAN an unpaired device must not be able to make ZERO spend API calls or
 * send text to a third party, which is the case this file mostly exists for.
 */

let server: Server;
let base: string;
let token: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-tts-'));
  const distDir = join(workDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>brain</title>');
  const tokenFile = join(workDir, 'gateway-token');
  token = loadOrCreateToken(tokenFile);

  const config = readConfig({
    ZERO_LAN_MODE: 'true',
    ZERO_UI_PORT: '0',
    ZERO_UI_DIST: distDir,
    ZERO_TOKEN_FILE: tokenFile,
    ZERO_API_URL: 'http://127.0.0.1:59999',
  });
  server = startGateway(config);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  rmSync(workDir, { recursive: true, force: true });
});

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), cookie: `zero_token=${token}` } };
}

describe('the voice status route', () => {
  it('answers with what the interface needs and no secret', async () => {
    const response = await fetch(`${base}/api/voice/tts/status`, authed());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    // Nothing in this container sets FISH_API_KEY, so the honest answer is
    // "not configured" — not a hopeful "ready".
    expect(body['ready']).toBe(false);
    expect(body['configured']).toBe(false);
    expect(body['reason']).toBe('fish_disabled');
    expect(body['cloud']).toBe(false);
    expect(body['fallback']).toBe('browser');

    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/api_key|apiKey|Bearer/i);
  });

  it('is behind the pairing gate, like everything that costs something', async () => {
    // Synthesis spends credits and sends text off the machine. An unpaired
    // device on the LAN must not be able to start either.
    const status = await fetch(`${base}/api/voice/tts/status`);
    expect(status.status).toBe(401);

    const speak = await fetch(`${base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ZERO online.' }),
    });
    expect(speak.status).toBe(401);
  });
});

describe('the speak route', () => {
  it('refuses an empty request rather than calling anything', async () => {
    const response = await fetch(
      `${base}/api/voice/tts`,
      authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json())['error']).toBe('empty_text');
  });

  it('says why it cannot speak, and names the fallback', async () => {
    const response = await fetch(
      `${base}/api/voice/tts`,
      authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Zwei Agenten sind verfügbar.' }),
      }),
    );
    // 503, not 500: a stated refusal the interface can fall back from, with
    // ZERO's answer still on screen either way.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('fish_disabled');
    expect(body['fallback']).toBe('browser');
  });

  it('does not answer a GET, so an answer can never end up in a URL', async () => {
    // A GET would put ZERO's reply in the query string, and query strings end
    // up in logs, history and referrers.
    const response = await fetch(`${base}/api/voice/tts?text=secret`, authed());
    expect(response.status).not.toBe(200);
  });
});

describe('end to end, with a stand-in for Fish Audio', () => {
  /**
   * The real path, minus the third party: browser → gateway → upstream →
   * audio bytes back. A stub rather than api.fish.audio because there is no
   * key in this container, and a test that spends someone's credits to prove
   * a request shape is a test nobody runs twice.
   */
  it('sends only the answer upstream and streams the audio back', async () => {
    const seen: { headers: IncomingMessage['headers']; body: unknown }[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        // Two writes, so the pass-through is exercised rather than a single
        // buffer that would work either way.
        res.write(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
        res.end(Buffer.alloc(2048, 7));
      });
    });
    await new Promise<void>((ready) => upstream.listen(0, '127.0.0.1', ready));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const localDist = join(workDir, 'dist');
    const localToken = join(workDir, 'gateway-token');
    const config = readConfig({
      ZERO_LAN_MODE: 'false',
      ZERO_UI_PORT: '0',
      ZERO_UI_DIST: localDist,
      ZERO_TOKEN_FILE: localToken,
      ZERO_API_URL: 'http://127.0.0.1:59999',
    });
    // The key lives here and only here — the browser never sees it.
    process.env['FISH_AUDIO_ENABLED'] = 'true';
    process.env['FISH_API_KEY'] = 'sk-test-key-for-the-stub-0001';
    process.env['FISH_AUDIO_VOICE_ID'] = '306c68e5763b42d6b06fe0380daa5281';
    process.env['FISH_AUDIO_ENDPOINT'] = `http://127.0.0.1:${upstreamPort}/v1/tts`;

    const local = startGateway(config);
    await new Promise<void>((ready) => local.once('listening', () => ready()));
    const localBase = `http://127.0.0.1:${(local.address() as { port: number }).port}`;

    try {
      const status = await (await fetch(`${localBase}/api/voice/tts/status`)).json();
      expect(status['ready']).toBe(true);
      expect(status['cloud']).toBe(true);
      expect(JSON.stringify(status)).not.toContain('sk-test-key');

      const response = await fetch(`${localBase}/api/voice/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Der Lead-Scraper ist verfügbar.' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/mpeg');
      expect(response.headers.get('x-zero-tts-model')).toBe('s2.1-pro-free');

      const audio = new Uint8Array(await response.arrayBuffer());
      // Both writes arrived, in order: the gateway streamed rather than
      // truncating at the first chunk.
      expect(audio.length).toBe(2052);
      expect(Array.from(audio.slice(0, 4))).toEqual([0xff, 0xfb, 0x90, 0x00]);

      expect(seen).toHaveLength(1);
      const request = seen[0]!;
      // The model is a header, not a body field — a model in the body is
      // ignored and the account is billed for the default one instead.
      expect(request.headers['model']).toBe('s2.1-pro-free');
      expect(request.headers['authorization']).toBe('Bearer sk-test-key-for-the-stub-0001');
      const body = request.body as Record<string, unknown>;
      expect(body['text']).toBe('Der Lead-Scraper ist verfügbar.');
      expect(body['reference_id']).toBe('306c68e5763b42d6b06fe0380daa5281');
      // Nothing else about the conversation goes out.
      expect(Object.keys(body)).not.toContain('history');
      expect(Object.keys(body)).not.toContain('messages');
    } finally {
      local.close();
      upstream.close();
      delete process.env['FISH_AUDIO_ENABLED'];
      delete process.env['FISH_API_KEY'];
      delete process.env['FISH_AUDIO_VOICE_ID'];
      delete process.env['FISH_AUDIO_ENDPOINT'];
    }
  }, 30_000);

  it('falls back rather than paying when the free tier says no', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'free quota exhausted for this model' }));
    });
    await new Promise<void>((ready) => upstream.listen(0, '127.0.0.1', ready));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const config = readConfig({
      ZERO_LAN_MODE: 'false',
      ZERO_UI_PORT: '0',
      ZERO_UI_DIST: join(workDir, 'dist'),
      ZERO_TOKEN_FILE: join(workDir, 'gateway-token'),
      ZERO_API_URL: 'http://127.0.0.1:59999',
    });
    process.env['FISH_AUDIO_ENABLED'] = 'true';
    process.env['FISH_API_KEY'] = 'sk-test-key-for-the-stub-0001';
    process.env['FISH_AUDIO_VOICE_ID'] = '306c68e5763b42d6b06fe0380daa5281';
    process.env['FISH_AUDIO_ENDPOINT'] = `http://127.0.0.1:${upstreamPort}/v1/tts`;

    const local = startGateway(config);
    await new Promise<void>((ready) => local.once('listening', () => ready()));
    const localBase = `http://127.0.0.1:${(local.address() as { port: number }).port}`;

    try {
      const response = await fetch(`${localBase}/api/voice/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ZERO online.' }),
      });
      expect(response.status).toBe(502);
      const body = (await response.json()) as Record<string, unknown>;
      // Named, and pointed at the local voice. Never a silent upgrade to a
      // model that charges.
      expect(body['error']).toBe('fish_free_model_unavailable');
      expect(body['fallback']).toBe('browser');
      expect(JSON.stringify(body)).not.toContain('sk-test-key');
    } finally {
      local.close();
      upstream.close();
      delete process.env['FISH_AUDIO_ENABLED'];
      delete process.env['FISH_API_KEY'];
      delete process.env['FISH_AUDIO_VOICE_ID'];
      delete process.env['FISH_AUDIO_ENDPOINT'];
    }
  }, 30_000);
});
