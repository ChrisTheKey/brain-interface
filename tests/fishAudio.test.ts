import { describe, expect, it, vi } from 'vitest';
import {
  buildTtsRequest,
  fishStatus,
  FishRequestError,
  listVoices,
  readFishConfig,
  requestSpeech,
} from '../server/fishAudio.mjs';
import { decodePcm16Bytes } from '../src/audio/analyser';

const configured = readFishConfig({
  FISH_AUDIO_API_KEY: 'test-key',
  FISH_AUDIO_VOICE_ID: 'voice-abc',
  FISH_AUDIO_API_URL: 'https://api.fish.audio',
});

describe('Fish Audio request mapping', () => {
  it('maps the interface request onto Fish Audio’s schema', () => {
    const { request, format, sampleRate, model } = buildTtsRequest({ text: 'ZERO online.' }, configured);
    expect(request).toMatchObject({
      text: 'ZERO online.',
      format: 'pcm',
      sample_rate: 44100,
      latency: 'balanced',
      reference_id: 'voice-abc',
    });
    expect(request.prosody.speed).toBeCloseTo(0.94);
    expect(format).toBe('pcm');
    expect(sampleRate).toBe(44100);
    expect(model).toBe('s2.1-pro');
  });

  it('omits the reference id when no voice is configured', () => {
    const { request } = buildTtsRequest({ text: 'x' }, readFishConfig({ FISH_AUDIO_API_KEY: 'k' }));
    expect(request.reference_id).toBeUndefined();
  });

  it('clamps prosody and falls back on unsupported values', () => {
    const { request, sampleRate } = buildTtsRequest(
      { text: 'x', speed: 9, volume: -900, sampleRate: 12345, latency: 'nope' },
      configured,
    );
    expect(request.prosody.speed).toBe(2);
    expect(request.prosody.volume).toBe(-20);
    expect(request.latency).toBe('balanced');
    expect(sampleRate).toBe(44100);
  });

  it('refuses empty and oversized text', () => {
    expect(() => buildTtsRequest({ text: '   ' }, configured)).toThrow(FishRequestError);
    expect(() => buildTtsRequest({ text: 'a'.repeat(9000) }, configured)).toThrow(/exceeds/);
  });

  it('adds a bitrate only for mp3', () => {
    expect(buildTtsRequest({ text: 'x', format: 'mp3' }, configured).request.mp3_bitrate).toBe(128);
    expect(buildTtsRequest({ text: 'x', format: 'wav' }, configured).request.mp3_bitrate).toBeUndefined();
  });
});

describe('Fish Audio status', () => {
  it('never reports the key, only whether there is one', () => {
    const status = fishStatus(configured);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('test-key');
  });

  it('explains itself when the gateway has no key', () => {
    const status = fishStatus(readFishConfig({}));
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/FISH_AUDIO_API_KEY/);
  });
});

describe('Fish Audio upstream call', () => {
  it('sends the key as a bearer token and the model as a header', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      body: null,
      headers: new Map([['content-type', 'application/octet-stream']]),
    })) as unknown as typeof fetch;

    const { release } = await requestSpeech({ text: 'hi' }, configured, fetchImpl);
    release();

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('https://api.fish.audio/v1/tts');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers.model).toBe('s2.1-pro');
  });

  it('refuses to call upstream without a key', async () => {
    await expect(requestSpeech({ text: 'hi' }, readFishConfig({}))).rejects.toThrow(
      /not configured/,
    );
  });

  it('passes an authentication or billing failure through unchanged', async () => {
    for (const [status, expected] of [
      [401, 401],
      [402, 402],
      [500, 502],
    ] as const) {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status,
        text: async () => 'upstream said no',
      })) as unknown as typeof fetch;
      await expect(requestSpeech({ text: 'hi' }, configured, fetchImpl)).rejects.toMatchObject({
        status: expected,
      });
    }
  });

  it('lists the voice models available to the key', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [{ _id: 'abc', title: 'ZERO', languages: ['de'], description: 'a voice' }],
      }),
    })) as unknown as typeof fetch;
    const voices = await listVoices(configured, 'zero', fetchImpl);
    expect(voices).toEqual([
      { id: 'abc', title: 'ZERO', languages: ['de'], description: 'a voice' },
    ]);
  });
});

describe('PCM decoding', () => {
  it('decodes little-endian PCM16 into float samples', () => {
    // 0, full scale positive, full scale negative.
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    const [plane] = decodePcm16Bytes(bytes, 1);
    expect(plane?.length).toBe(3);
    expect(plane?.[0]).toBe(0);
    expect(plane?.[1]).toBeCloseTo(1, 3);
    expect(plane?.[2]).toBe(-1);
  });

  it('ignores a trailing half sample instead of producing noise', () => {
    const [plane] = decodePcm16Bytes(new Uint8Array([0x10, 0x20, 0x30]), 1);
    expect(plane?.length).toBe(1);
  });
});
