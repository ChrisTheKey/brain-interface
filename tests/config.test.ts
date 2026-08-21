import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config';
import { rankVoiceCandidates } from '../src/voice/provider';

describe('configuration', () => {
  it('falls back to documented defaults when nothing is set', () => {
    const resolved = resolveConfig({});
    expect(resolved.backgroundImage).toBe('/reference/red-background.jpg');
    expect(resolved.voice.provider).toBe('zero-realtime');
  });

  it('holds public paths only — never a backend host, port or scheme', () => {
    const resolved = resolveConfig({});
    expect(resolved.zeroWsPath).toBe('/ws');
    expect(resolved.zeroEventsPath).toBe('/ws/events');
    expect(resolved.apiBase).toBe('/api');
  });

  it('refuses to take a backend address from the environment', () => {
    // The environment is how `ws://127.0.0.1:8787` reached the bundle in the
    // first place, so this key is no longer read at all: the origin that
    // served the page is the backend, and nothing may override that.
    const resolved = resolveConfig({
      VITE_ZERO_WS_URL: 'ws://10.0.0.4:9000',
      VITE_ZERO_CWDS: '/workspace/zero, /workspace/other ',
      VITE_ZERO_EXPERIMENTAL_API: 'false',
      VITE_ZERO_VOICE_PROVIDER: 'speech-synthesis',
      VITE_ZERO_THREAD_LIMIT: '12',
    });
    expect(resolved.zeroWsPath).toBe('/ws');
    expect(JSON.stringify(resolved)).not.toContain('10.0.0.4');
    // Everything else still comes from the environment.
    expect(resolved.extraCwds).toEqual(['/workspace/zero', '/workspace/other']);
    expect(resolved.experimentalApi).toBe(false);
    expect(resolved.voice.provider).toBe('speech-synthesis');
    expect(resolved.threadLimit).toBe(12);
  });
});

describe('ZERO voice selection', () => {
  it('prefers configured voices, then male-sounding ones', () => {
    const voices = [
      { name: 'Samantha', lang: 'en-US' },
      { name: 'Daniel', lang: 'en-GB' },
      { name: 'Google UK English Male', lang: 'en-GB' },
    ];
    expect(rankVoiceCandidates(voices, ['Google UK English Male'])[0]?.name).toBe(
      'Google UK English Male',
    );
    expect(rankVoiceCandidates(voices, [])[0]?.name).not.toBe('Samantha');
  });
});
