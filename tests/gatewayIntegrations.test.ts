import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, startGateway } from '../server/gateway.mjs';
import { handleMessage } from '../mcp/brain-browser-server.mjs';

let gateway: Server;
let fishUpstream: Server;
let base: string;
let workDir: string;
/** What the fake Fish Audio upstream saw, so the gateway's request is checked. */
let lastFishRequest: { body: string; authorization?: string; model?: string } | null = null;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-gw-int-'));
  const distDir = join(workDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>brain</title>');

  // Stands in for api.fish.audio and streams PCM back in three chunks.
  fishUpstream = createServer((req, res) => {
    if (req.url !== '/v1/tts') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      lastFishRequest = {
        body,
        authorization: req.headers.authorization as string | undefined,
        model: req.headers.model as string | undefined,
      };
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(32, sent));
        if (++sent === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 5);
    });
  });
  await new Promise<void>((resolve) => fishUpstream.listen(0, '127.0.0.1', () => resolve()));
  const fishPort = (fishUpstream.address() as { port: number }).port;

  gateway = startGateway(
    readConfig({
      ZERO_UI_PORT: '0',
      ZERO_UI_DIST: distDir,
      ZERO_TOKEN_FILE: join(workDir, 'gateway-token'),
      ZERO_API_URL: 'http://127.0.0.1:59999',
      FISH_AUDIO_API_KEY: 'gateway-only-secret',
      FISH_AUDIO_API_URL: `http://127.0.0.1:${fishPort}`,
      FISH_AUDIO_VOICE_ID: 'zero-voice',
    }),
  );
  await new Promise<void>((resolve) => gateway.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(async () => {
  gateway?.close();
  fishUpstream?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('gateway health', () => {
  it('reports what this gateway can do beyond proxying', async () => {
    const response = await fetch(`${base}/api/gateway/health`);
    const body = await response.json();
    expect(body.features.fishAudio).toBe(true);
    expect(Array.isArray(body.features.browser)).toBe(true);
    // The interface needs the absolute command to register the browser MCP
    // server with ZERO; it cannot know its own install path otherwise.
    expect(body.features.browserMcp.args[0]).toMatch(/mcp\/brain-browser-server\.mjs$/);
  });
});

describe('Fish Audio through the gateway', () => {
  it('adds the key upstream and never returns it', async () => {
    const response = await fetch(`${base}/api/voice/fish/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ZERO online.' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-zero-audio-format')).toBe('pcm');
    expect(response.headers.get('x-zero-audio-sample-rate')).toBe('44100');
    // Three chunks of 32 bytes, relayed as they arrived.
    expect((await response.arrayBuffer()).byteLength).toBe(96);

    expect(lastFishRequest?.authorization).toBe('Bearer gateway-only-secret');
    expect(lastFishRequest?.model).toBe('s2.1-pro');
    expect(JSON.parse(lastFishRequest!.body)).toMatchObject({
      text: 'ZERO online.',
      format: 'pcm',
      reference_id: 'zero-voice',
    });
  });

  it('reports its configuration without the key', async () => {
    const body = await (await fetch(`${base}/api/voice/fish/status`)).json();
    expect(body).toMatchObject({ provider: 'fish-audio', configured: true });
    expect(JSON.stringify(body)).not.toContain('gateway-only-secret');
  });

  it('refuses an empty request instead of calling upstream', async () => {
    const response = await fetch(`${base}/api/voice/fish/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/text is required/);
  });

  it('rejects a malformed body', async () => {
    const response = await fetch(`${base}/api/voice/fish/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('the browser bridge through the gateway', () => {
  it('reports which browsers exist on this machine', async () => {
    const body = await (await fetch(`${base}/api/browser/status`)).json();
    expect(body.browsers.map((browser: { id: string }) => browser.id)).toEqual([
      'chrome',
      'brave',
      'edge',
      'firefox',
    ]);
    expect(body.active).toBeNull();
    expect(body.allowPrivate).toBe(false);
  });

  it('refuses to open a loopback address, which is what protects HWD-ZERO', async () => {
    const response = await fetch(`${base}/api/browser/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:8000/api/missions' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('url_blocked');
  });

  it('rejects a GET on a mutating route', async () => {
    expect((await fetch(`${base}/api/browser/open`)).status).toBe(405);
  });

  it('answers an unknown bridge route rather than proxying it to ZERO', async () => {
    const response = await fetch(`${base}/api/browser/teleport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('unknown_browser_route');
  });
});

describe('ZERO reaching the bridge over MCP', () => {
  it('drives the real gateway through the MCP server', async () => {
    // The MCP server is thin on purpose: this proves the whole path from a
    // tool call to the gateway's own browser status.
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_status' } },
      {
        fetch: ((input: string, init?: RequestInit) =>
          fetch(`${base}${new URL(input, base).pathname}`, init)) as typeof fetch,
      },
    );
    expect(response?.result?.isError).toBeUndefined();
    expect(response?.result?.content?.[0]?.text).toContain('Preferred: chrome');
  });

  it('surfaces a blocked URL to the agent as a readable error', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_open', arguments: { url: 'http://10.0.0.1/admin' } },
      },
      {
        fetch: ((input: string, init?: RequestInit) =>
          fetch(`${base}${new URL(input, base).pathname}`, init)) as typeof fetch,
      },
    );
    expect(response?.result?.isError).toBe(true);
    expect(response?.result?.content?.[0]?.text).toMatch(/local address/);
  });
});

describe('what the public probe reveals', () => {
  it('does not hand the install path to an unauthenticated LAN client', async () => {
    // A separate gateway in LAN mode, where loopback is not trusted either.
    const lanDir = mkdtempSync(join(tmpdir(), 'zero-gw-lan-'));
    mkdirSync(join(lanDir, 'dist'), { recursive: true });
    const lan = startGateway(
      readConfig({
        ZERO_LAN_MODE: 'true',
        ZERO_UI_PORT: '0',
        ZERO_UI_DIST: join(lanDir, 'dist'),
        ZERO_TOKEN_FILE: join(lanDir, 'token'),
      }),
    );
    await new Promise<void>((resolve) => lan.once('listening', () => resolve()));
    const lanBase = `http://127.0.0.1:${(lan.address() as { port: number }).port}`;

    const body = await (await fetch(`${lanBase}/api/gateway/health`)).json();
    // Enough to render the pairing screen, and nothing about this machine.
    expect(body).toMatchObject({ gateway: 'ok', authRequired: true });
    expect(body.features).toBeUndefined();

    lan.close();
    rmSync(lanDir, { recursive: true, force: true });
  });
});
