import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config';
import { rankVoiceCandidates } from '../src/voice/provider';

describe('configuration', () => {
  it('falls back to documented defaults when nothing is set', () => {
    const resolved = resolveConfig({});
    expect(resolved.zeroWsUrl).toBe('ws://127.0.0.1:8787');
    expect(resolved.backgroundImage).toBe('/assets/brain-background.png');
    expect(resolved.voice.provider).toBe('zero-realtime');
  });

  it('reads the ZERO endpoint and workspace scoping from the environment', () => {
    const resolved = resolveConfig({
      VITE_ZERO_WS_URL: 'ws://10.0.0.4:9000',
      VITE_ZERO_CWDS: '/workspace/zero, /workspace/other ',
      VITE_ZERO_EXPERIMENTAL_API: 'false',
      VITE_ZERO_VOICE_PROVIDER: 'speech-synthesis',
      VITE_ZERO_THREAD_LIMIT: '12',
    });
    expect(resolved.zeroWsUrl).toBe('ws://10.0.0.4:9000');
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
