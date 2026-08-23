import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FISH_ERRORS,
  buildRequest,
  classifyFailure,
  isFreeModel,
  isTransient,
  redact,
  retryDelayMs,
  synthesize,
} from '../server/tts/fishAudio.mjs';
import {
  FREE_MODEL,
  KNOWN_VOICES,
  loadTtsConfig,
  publicStatus,
  unavailableReason,
} from '../server/tts/config.mjs';

/**
 * ZERO's cloud voice.
 *
 * Two claims are load-bearing and everything else is detail: the API key never
 * leaves the gateway, and a failure of a third-party service never costs ZERO
 * its answer. Most of this file exists to hold those two down.
 *
 * No real Fish Audio call is made. There is no key in this container, and a
 * test suite that spends someone's credits to prove a request shape is a test
 * suite nobody can run twice.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Executable lines only. Comments say what is deliberately *not* done. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

function filesMentioning(needle: string, root: string): string[] {
  try {
    return execFileSync('grep', ['-rIl', needle, root], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Narrow a synthesize result to its failure shape, for the assertions below. */
function failureOf(result: Awaited<ReturnType<typeof synthesize>>): { code: string } {
  if (result.ok) throw new Error('expected a failure');
  return result;
}

function configWith(env: Record<string, string> = {}) {
  return loadTtsConfig({
    FISH_AUDIO_ENABLED: 'true',
    FISH_API_KEY: 'sk-not-a-real-key-0123456789',
    FISH_AUDIO_VOICE_ID: KNOWN_VOICES[0]!.id,
    ...env,
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A fetch that records what it was asked and answers however the test says. */
function recordingFetch(responder: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responder();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function audioResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    headers: { get: (name: string) => (name === 'content-type' ? 'audio/mpeg' : null) },
  } as unknown as Response;
}

function errorResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    text: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

// ------------------------------------------------------------- the request

describe('what actually goes to Fish Audio', () => {
  it('sends the sentence and the parameters to say it — and nothing else', () => {
    const request = buildRequest('Zwei Agenten sind verfügbar.', configWith());
    expect(request.url).toBe('https://api.fish.audio/v1/tts');
    expect(request.body.text).toBe('Zwei Agenten sind verfügbar.');
    expect(request.body.reference_id).toBe(KNOWN_VOICES[0]!.id);

    // The list is the point. Conversation history, mission log, agent
    // registry, memory and microphone audio are all absent by construction,
    // and this test fails the moment one of them is added.
    expect(Object.keys(request.body).sort()).toEqual([
      'format',
      'latency',
      'mp3_bitrate',
      'normalize',
      'prosody',
      'reference_id',
      'temperature',
      'text',
      'top_p',
    ]);
  });

  it('puts the model in the header, where the contract wants it', () => {
    // A model in the body is ignored and the account is billed for the
    // default one instead of the free tier.
    const request = buildRequest('x', configWith());
    expect(request.headers.model).toBe(FREE_MODEL);
    expect(request.body).not.toHaveProperty('model');
    expect(request.headers.authorization).toBe('Bearer sk-not-a-real-key-0123456789');
  });

  it('asks for a measured delivery rather than a performance', () => {
    const request = buildRequest('x', configWith());
    // Controlled, not theatrical — and deterministic enough that the same
    // sentence twice is the same voice twice.
    expect((request.body.prosody as { speed: number }).speed).toBeLessThan(1);
    expect(request.body.temperature).toBeLessThanOrEqual(0.7);
  });
});

// ----------------------------------------------------------------- secrecy

describe('the key stays on the gateway', () => {
  it('is never read from a VITE_ variable, which the bundle would carry', () => {
    // Comments are stripped first: a doc comment explaining why there is no
    // VITE_ key is not a VITE_ key, and a test that cannot tell the two apart
    // punishes the explanation.
    for (const root of [join(repoRoot, 'src'), join(repoRoot, 'server')]) {
      for (const file of filesMentioning('fish', root)) {
        const source = code(file);
        expect(source, file).not.toMatch(/VITE_[A-Z_]*FISH/);
        expect(source, file).not.toMatch(/VITE_[A-Z_]*(API_KEY|TOKEN|SECRET)/);
      }
    }
  });

  it('is not reachable from anything the browser downloads', () => {
    // The client never holds the key, never calls Fish Audio and never sends
    // an Authorization header: it POSTs text to the gateway and gets audio.
    const clientFiles = filesMentioning('fish', join(repoRoot, 'src'));
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const file of clientFiles) {
      const source = code(file);
      expect(source, file).not.toContain('api.fish.audio');
      expect(source, file).not.toMatch(/Bearer\s/);
      expect(source, file).not.toMatch(/env[.[]['"]?FISH/);
    }
  });

  it('is not in the built bundle', () => {
    // The real check: whatever ends up in dist is what ships.
    const assets = join(repoRoot, 'dist', 'assets');
    let names: string[] = [];
    try {
      names = readdirSync(assets);
    } catch {
      return; // nothing built in this run; the source checks above still hold
    }
    for (const name of names.filter((entry) => entry.endsWith('.js'))) {
      const bundle = readFileSync(join(assets, name), 'utf8');
      // The endpoint being absent is the proof that matters: the browser
      // cannot call Fish Audio directly, so it has nothing to call it with.
      // (The words "FISH_API_KEY" do appear — in the sentence telling the
      // operator where to put one. A variable name is not a credential.)
      expect(bundle, name).not.toContain('api.fish.audio');
      expect(bundle, name).not.toMatch(/Bearer\s+\S/);
      expect(bundle, name).not.toMatch(/VITE_[A-Z_]*FISH/);
    }
  });

  it('never lets a key survive into a message', () => {
    const config = configWith();
    const leaked = `upstream said: Authorization: Bearer ${config.apiKey} was rejected`;
    const cleaned = redact(leaked, config);
    expect(cleaned).not.toContain(config.apiKey);
    expect(cleaned).toContain('[redacted]');
    // Even a key this process does not know about is stripped on shape alone.
    expect(redact('Bearer abcdefgh12345678', {})).toBe('Bearer [redacted]');
  });

  it('reports its status without saying anything about the key', () => {
    const status = publicStatus(configWith());
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain('sk-not-a-real-key');
    expect(serialised).not.toContain('apiKey');
    expect(status.ready).toBe(true);
    expect(status.cloud).toBe(true);
    expect(status.model).toBe(FREE_MODEL);
  });
});

// ------------------------------------------------------------ what is refused

describe('what ZERO refuses to do on its own', () => {
  it('does not call the cloud at all under ZERO_LOCAL_ONLY', async () => {
    // Even with a key, a voice and the provider selected. "Local only" has to
    // mean it or it is decoration.
    const config = configWith({ ZERO_LOCAL_ONLY: 'true' });
    expect(unavailableReason(config)).toBe('local_only');
    expect(publicStatus(config).cloud).toBe(false);

    const { impl, calls } = recordingFetch(audioResponse);
    const result = await synthesize('ZERO online.', config, { fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(failureOf(result).code).toBe(FISH_ERRORS.LOCAL_ONLY);
  });

  it('is off until it is switched on', () => {
    // A checkout that happens to inherit a key in its environment does not
    // start sending text to a third party.
    expect(unavailableReason(loadTtsConfig({ FISH_API_KEY: 'x' }))).toBe('fish_disabled');
    expect(unavailableReason(configWith({ FISH_API_KEY: '' }))).toBe('fish_api_key_missing');
    expect(unavailableReason(configWith({ FISH_AUDIO_VOICE_ID: '' }))).toBe(
      'fish_voice_not_configured',
    );
  });

  it('never upgrades itself to a paid model', async () => {
    const free = configWith();
    expect(free.paid).toBe(false);
    expect(isFreeModel(free.model)).toBe(true);

    // The free tier says no. The answer is a named failure and a fallback,
    // not a quiet switch to a model that bills.
    const { impl, calls } = recordingFetch(() =>
      errorResponse(402, '{"detail":"free quota exhausted"}'),
    );
    const result = await synthesize('x', free, { fetchImpl: impl, maxAttempts: 1 });
    expect(failureOf(result).code).toBe(FISH_ERRORS.FREE_MODEL);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)['model']).toBe(FREE_MODEL);

    // A paid model is reachable, but only because someone wrote it down.
    const paid = configWith({ FISH_AUDIO_MODEL: 's2.1-pro' });
    expect(paid.paid).toBe(true);
    expect(publicStatus(paid).free_model).toBe(false);
  });
});

// ------------------------------------------------------------- failure paths

describe('when Fish Audio has a bad day', () => {
  it('names each failure rather than reporting "voice failed"', () => {
    expect(classifyFailure(401)).toBe(FISH_ERRORS.AUTH);
    expect(classifyFailure(403)).toBe(FISH_ERRORS.AUTH);
    expect(classifyFailure(404)).toBe(FISH_ERRORS.VOICE);
    expect(classifyFailure(429)).toBe(FISH_ERRORS.RATE_LIMIT);
    expect(classifyFailure(402)).toBe(FISH_ERRORS.FREE_MODEL);
    expect(classifyFailure(400, 'reference_id not found')).toBe(FISH_ERRORS.VOICE);
    expect(classifyFailure(422, 'model not available on free tier')).toBe(FISH_ERRORS.FREE_MODEL);
    expect(classifyFailure(500)).toBe(FISH_ERRORS.API);
  });

  it('retries what is worth retrying and accepts the rest', async () => {
    // Hammering an API that has already answered is how a rate limit becomes
    // a ban.
    expect(isTransient(FISH_ERRORS.API)).toBe(true);
    expect(isTransient(FISH_ERRORS.TIMEOUT)).toBe(true);
    expect(isTransient(FISH_ERRORS.AUTH)).toBe(false);
    expect(isTransient(FISH_ERRORS.VOICE)).toBe(false);

    const { impl, calls } = recordingFetch(() => errorResponse(401, 'bad key'));
    await synthesize('x', configWith(), { fetchImpl: impl, sleepImpl: async () => {} });
    expect(calls).toHaveLength(1);

    const flaky = recordingFetch(() => errorResponse(500, 'upstream'));
    await synthesize('x', configWith(), {
      fetchImpl: flaky.impl,
      maxAttempts: 2,
      sleepImpl: async () => {},
    });
    expect(flaky.calls).toHaveLength(2);
  });

  it('respects the wait a 429 asks for', () => {
    const withHeader = { get: (name: string) => (name === 'retry-after' ? '3' : null) };
    expect(retryDelayMs(withHeader, 0)).toBe(3000);
    // Capped: a server asking for an hour does not get an hour.
    expect(retryDelayMs({ get: () => '9999' }, 0)).toBe(10_000);
    // No header: a bounded backoff of our own.
    expect(retryDelayMs(null, 0)).toBe(500);
    expect(retryDelayMs(null, 5)).toBe(4000);
  });

  it('gives up rather than generating forever', async () => {
    const config = configWith({ FISH_AUDIO_TIMEOUT_MS: '10' });
    const impl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const result = await synthesize('x', config, {
      fetchImpl: impl,
      maxAttempts: 1,
      sleepImpl: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(failureOf(result).code).toBe(FISH_ERRORS.TIMEOUT);
  });

  it('treats a cancelled turn as cancelled, not as a failure to fall back from', async () => {
    const controller = new AbortController();
    const impl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const pending = synthesize('x', configWith(), { fetchImpl: impl, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(failureOf(result).code).toBe('aborted');
  });

  it('passes the answer through untouched when it works', async () => {
    const { impl, calls } = recordingFetch(audioResponse);
    const result = await synthesize('Der Lead-Scraper ist verfügbar.', configWith(), {
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.contentType).toBe('audio/mpeg');
    // Exactly the sentence ZERO decided on, with nothing prepended, appended
    // or summarised.
    expect(JSON.parse(String(calls[0]!.init.body)).text).toBe('Der Lead-Scraper ist verfügbar.');
  });
});

// ------------------------------------------------------------------- voices

describe('the voices ZERO ships knowing about', () => {
  it('carries only public, verified ids and clones nothing', () => {
    expect(KNOWN_VOICES.length).toBeGreaterThan(0);
    for (const voice of KNOWN_VOICES) {
      // Confirmed against the live model API, not read off a page.
      expect(voice.id).toMatch(/^[0-9a-f]{32}$/);
      expect(voice.name).toBeTruthy();
      expect(voice.author).toBeTruthy();
    }
    // Nothing in this repository trains, uploads or clones a voice.
    const server = execFileSync('grep', ['-rIl', 'fish', join(repoRoot, 'server')], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const file of server) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('/model/create');
      expect(source, file).not.toMatch(/\breferences\s*:/);
    }
  });

  it('names the voice without pretending to know its German', () => {
    const status = publicStatus(configWith());
    expect(status.voice_name).toBe('Lelouch Vi Britannia');
    // The metadata says English. Claiming otherwise in the UI would be a
    // guess dressed as a fact.
    expect(status.voice_languages).toEqual(['en']);
  });
});


/**
 * The one test that touches the real service, and only when a key is present.
 *
 * Skipped everywhere else — including here, where there is no key. A suite
 * that silently spends someone's credits is a suite that gets disabled, and
 * claiming a real call happened when it did not is worse than not making one.
 */
describe.skipIf(!process.env['FISH_API_KEY'])('against the real Fish Audio', () => {
  it('says two words on the free model', async () => {
    const config = loadTtsConfig({
      FISH_AUDIO_ENABLED: 'true',
      FISH_API_KEY: process.env['FISH_API_KEY'],
      FISH_AUDIO_VOICE_ID: process.env['FISH_AUDIO_VOICE_ID'] ?? KNOWN_VOICES[0]!.id,
      // Free tier only. Never a model that bills, not even for a test.
      FISH_AUDIO_MODEL: FREE_MODEL,
    });
    expect(config.paid).toBe(false);
    const result = await synthesize('ZERO online.', config, { maxAttempts: 1 });
    if (!result.ok) {
      throw new Error(`Fish Audio refused: ${failureOf(result).code}`);
    }
    expect(result.contentType).toContain('audio');
  }, 60_000);
});
