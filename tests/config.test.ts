import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config';
import { rankVoiceCandidates } from '../src/voice/provider';

describe('configuration', () => {
  it('is same-origin by default: no backend address lives in the bundle', () => {
    const resolved = resolveConfig({});
    expect(resolved.apiBaseUrl).toBe('');
    expect(resolved.backgroundImage).toBe('/reference/red-background.jpg');
    expect(resolved.voice.mode).toBe('auto');
    expect(resolved.speech.provider).toBe('web-speech');
  });

  it('reads presentation and voice tuning from the environment', () => {
    const resolved = resolveConfig({
      VITE_ZERO_API_BASE: 'http://127.0.0.1:3000/',
      VITE_ZERO_SPEECH_LANGUAGE: 'en-GB',
      VITE_ZERO_VOICE_MODE: 'synthesis',
      VITE_ZERO_VOICE_NAMES: 'Daniel, Google UK English Male ',
      VITE_ZERO_RENDER_QUALITY: 'low',
      VITE_ZERO_BLOOM: 'false',
      VITE_ZERO_MAX_PIXEL_RATIO: '1.5',
    });
    expect(resolved.apiBaseUrl).toBe('http://127.0.0.1:3000');
    expect(resolved.speech.language).toBe('en-GB');
    expect(resolved.voice.mode).toBe('synthesis');
    expect(resolved.voice.preferredVoices).toEqual(['Daniel', 'Google UK English Male']);
    expect(resolved.render.quality).toBe('low');
    expect(resolved.render.bloom).toBe(false);
    expect(resolved.render.maxPixelRatio).toBe(1.5);
  });

  it('falls back rather than accepting an unknown enum value', () => {
    const resolved = resolveConfig({
      VITE_ZERO_VOICE_MODE: 'telepathy',
      VITE_ZERO_RENDER_QUALITY: 'ultra',
      VITE_ZERO_SPEECH_PROVIDER: 'whisper',
    });
    expect(resolved.voice.mode).toBe('auto');
    expect(resolved.render.quality).toBe('auto');
    expect(resolved.speech.provider).toBe('web-speech');
  });

  it('clamps the intervals that would otherwise hammer the operator', () => {
    const resolved = resolveConfig({
      VITE_ZERO_REFRESH_INTERVAL_MS: '10',
      VITE_ZERO_RECONNECT_DELAY_MS: '1',
    });
    expect(resolved.refreshIntervalMs).toBe(2_000);
    expect(resolved.reconnectDelayMs).toBe(500);
  });
});

describe('ZERO voice selection', () => {
  it('prefers configured voices, then male-sounding ones', () => {
    const voices = [
      { name: 'Microsoft Zira', lang: 'en-US' },
      { name: 'Daniel', lang: 'en-GB' },
      { name: 'Google UK English Male', lang: 'en-GB' },
    ];
    expect(rankVoiceCandidates(voices, ['Google UK English Male'])[0]?.name).toBe(
      'Google UK English Male',
    );
    expect(rankVoiceCandidates(voices, [])[0]?.name).not.toBe('Microsoft Zira');
  });
});
