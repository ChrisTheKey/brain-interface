import { describe, expect, it } from 'vitest';
import { pathForRoute, routeFromLocation, VOICE_PATH } from '../src/state/useRoute';
import { resolveConfig } from '../src/config';

describe('voice mode routing', () => {
  it('recognises /voice, with or without a trailing slash', () => {
    expect(routeFromLocation({ pathname: '/voice' })).toBe('voice');
    expect(routeFromLocation({ pathname: '/voice/' })).toBe('voice');
  });

  it('falls back to the hash when the host cannot rewrite paths', () => {
    expect(routeFromLocation({ pathname: '/', hash: '#/voice' })).toBe('voice');
    expect(routeFromLocation({ pathname: '/', hash: '#voice' })).toBe('voice');
  });

  it('treats everything else as the brain', () => {
    expect(routeFromLocation({ pathname: '/' })).toBe('brain');
    expect(routeFromLocation({ pathname: '/something' })).toBe('brain');
    expect(routeFromLocation({})).toBe('brain');
  });

  it('maps routes back onto paths', () => {
    expect(pathForRoute('voice')).toBe(VOICE_PATH);
    expect(pathForRoute('brain')).toBe('/');
  });
});

describe('voice mode configuration', () => {
  it('keeps the conversation going by default', () => {
    const resolved = resolveConfig({});
    expect(resolved.voiceMode.continuous).toBe(true);
    expect(resolved.voiceMode.autoStart).toBe(false);
    expect(resolved.voiceMode.restartDelayMs).toBe(600);
  });

  it('reads the voice mode settings from the environment', () => {
    const resolved = resolveConfig({
      VITE_ZERO_VOICE_MODE_CONTINUOUS: 'false',
      VITE_ZERO_VOICE_MODE_AUTOSTART: 'true',
      VITE_ZERO_VOICE_MODE_RESTART_MS: '1200',
    });
    expect(resolved.voiceMode).toEqual({
      continuous: false,
      autoStart: true,
      restartDelayMs: 1200,
    });
  });
});

describe('Fish Audio configuration', () => {
  it('defaults to PCM through the gateway, which is what the smoke needs', () => {
    const resolved = resolveConfig({});
    expect(resolved.voice.fish).toMatchObject({
      endpoint: '/api/voice/fish',
      format: 'pcm',
      sampleRate: 44100,
      model: 's2.1-pro',
      latency: 'balanced',
    });
    // The voice id is the operator's choice; there is no invented default.
    expect(resolved.voice.fish.voiceId).toBe('');
  });

  it('accepts fish-audio as the configured provider', () => {
    expect(resolveConfig({ VITE_ZERO_VOICE_PROVIDER: 'fish-audio' }).voice.provider).toBe(
      'fish-audio',
    );
    // An unknown provider falls back rather than disabling the voice.
    expect(resolveConfig({ VITE_ZERO_VOICE_PROVIDER: 'kokoro' }).voice.provider).toBe(
      'zero-realtime',
    );
  });

  it('reads the Fish Audio voice and prosody from the environment', () => {
    const resolved = resolveConfig({
      VITE_ZERO_FISH_VOICE_ID: 'abc123',
      VITE_ZERO_FISH_MODEL: 's1',
      VITE_ZERO_FISH_LATENCY: 'low',
      VITE_ZERO_FISH_FORMAT: 'mp3',
      VITE_ZERO_FISH_SAMPLE_RATE: '24000',
      VITE_ZERO_FISH_SPEED: '0.8',
    });
    expect(resolved.voice.fish).toMatchObject({
      voiceId: 'abc123',
      model: 's1',
      latency: 'low',
      format: 'mp3',
      sampleRate: 24000,
      speed: 0.8,
    });
  });

  it('never carries an API key — that stays on the gateway', () => {
    const resolved = resolveConfig({ FISH_AUDIO_API_KEY: 'secret' });
    expect(JSON.stringify(resolved)).not.toContain('secret');
  });
});

describe('browser configuration', () => {
  it('defaults to Chrome through the gateway bridge', () => {
    expect(resolveConfig({}).browser).toEqual({ endpoint: '/api/browser', preferred: 'chrome' });
  });

  it('accepts each supported browser and rejects anything else', () => {
    for (const browser of ['chrome', 'firefox', 'brave', 'edge'] as const) {
      expect(resolveConfig({ VITE_ZERO_BROWSER: browser }).browser.preferred).toBe(browser);
    }
    expect(resolveConfig({ VITE_ZERO_BROWSER: 'safari' }).browser.preferred).toBe('chrome');
  });
});
