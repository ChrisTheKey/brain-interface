import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZeroVoiceService } from '../src/voice/service';
import type { VoiceProvider } from '../src/voice/provider';

/** Minimal Web Audio stub: the service only needs a context and an analyser. */
function installAudioStub(): void {
  const analyser = {
    fftSize: 1024,
    frequencyBinCount: 512,
    smoothingTimeConstant: 0.65,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: (array: Float32Array) => array.fill(0),
    getByteFrequencyData: (array: Uint8Array) => array.fill(0),
  };
  class FakeAudioContext {
    state = 'running';
    sampleRate = 48_000;
    destination = {};
    currentTime = 0;
    createAnalyser = () => analyser;
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
    resume = async () => undefined;
    close = async () => undefined;
  }
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext };
}

function makeProvider(id: VoiceProvider['id'], behaviour: 'ok' | 'throws'): VoiceProvider & {
  spoken: string[];
} {
  const spoken: string[] = [];
  return {
    id,
    label: id,
    spoken,
    isAvailable: () => true,
    connect: () => true,
    speak: async (text: string) => {
      if (behaviour === 'throws') throw new Error(`${id} is not configured`);
      spoken.push(text);
    },
    stop: () => undefined,
    dispose: () => undefined,
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('ZeroVoiceService', () => {
  it('reports unavailable instead of throwing when there is no Web Audio API', async () => {
    const service = new ZeroVoiceService([makeProvider('speech-synthesis', 'ok')]);
    await expect(service.activate()).resolves.toBe(false);
    expect(service.currentState).toBe('unavailable');
    expect(service.levels().amplitude).toBe(0);
  });

  it('falls back to the next provider when ZERO realtime fails at runtime', async () => {
    installAudioStub();
    const realtime = makeProvider('zero-realtime', 'throws');
    const fallback = makeProvider('speech-synthesis', 'ok');
    const service = new ZeroVoiceService([realtime, fallback]);

    await service.activate();
    expect(service.providerId).toBe('zero-realtime');

    await service.speak('ZERO online.');
    expect(fallback.spoken).toEqual(['ZERO online.']);
    expect(service.providerId).toBe('speech-synthesis');
    expect(service.currentState).toBe('ready');
  });

  it('marks the voice unavailable once every provider failed', async () => {
    installAudioStub();
    const service = new ZeroVoiceService([
      makeProvider('zero-realtime', 'throws'),
      makeProvider('speech-synthesis', 'throws'),
    ]);
    await service.activate();
    await service.speak('ZERO online.');
    expect(service.currentState).toBe('unavailable');
  });
});
