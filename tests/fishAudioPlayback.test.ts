import { describe, expect, it, vi } from 'vitest';
import { FishAudioVoiceProvider, describeReason } from '../src/voice/fishAudioProvider';

/**
 * Fish Audio's output, on ZERO's own audio graph.
 *
 * The requirement this file guards is easy to lose in a refactor: the cloud
 * voice must go through `createMediaElementSource` into the same analyser the
 * smoke, the filaments and the core already read. A `new Audio(url).play()`
 * would be audible and would leave the brain reacting to nothing — which looks
 * exactly like a bug in the visualisation rather than a missing connection.
 */

class FakeAudioElement {
  src = '';
  crossOrigin: string | null = null;
  preload = '';
  currentTime = 0;
  paused = true;
  playCalls = 0;
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  addEventListener(type: string, handler: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }
  removeEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  emit(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
  }
}

function audioGraph() {
  const connected: unknown[] = [];
  const sourceNode = {
    connect: (node: unknown) => {
      connected.push(node);
    },
    disconnect: () => {},
  };
  const elements: FakeAudioElement[] = [];
  const context = {
    createMediaElementSource: (element: unknown) => {
      elements.push(element as FakeAudioElement);
      return sourceNode;
    },
  } as unknown as AudioContext;
  const analyser = { id: 'analyser' } as unknown as AudioNode;
  return { context, analyser, connected, elements };
}

function okStatus(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'fish_audio',
    configured: true,
    ready: true,
    reason: null,
    model: 's2.1-pro-free',
    free_model: true,
    voice_id: '306c68e5763b42d6b06fe0380daa5281',
    voice_name: 'Lelouch Vi Britannia',
    voice_languages: ['en'],
    fallback: 'browser',
    cloud: true,
    local_only: false,
    ...overrides,
  };
}

/** A fetch answering the status route and the speak route separately. */
function gateway(options: { status?: Record<string, unknown>; speak?: () => Response } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({ url: target, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (target.endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => options.status ?? okStatus(),
      } as unknown as Response;
    }
    return (
      options.speak?.() ??
      ({
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array(4096)], { type: 'audio/mpeg' }),
      } as unknown as Response)
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('the cloud voice on ZERO\'s audio graph', () => {
  it('routes its audio through the analyser, not straight at the speakers', async () => {
    const graph = audioGraph();
    const net = gateway();
    const element = new FakeAudioElement();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => element as unknown as HTMLAudioElement,
    });

    expect(provider.connect(graph.context, graph.analyser)).toBe(true);
    const speaking = provider.speak('Zwei Agenten sind verfügbar.');
    await vi.waitFor(() => expect(element.playCalls).toBe(1));
    element.emit('ended');
    await speaking;

    // The connection that makes the brain react to ZERO's real voice.
    expect(graph.elements).toEqual([element]);
    expect(graph.connected).toEqual([graph.analyser]);
  });

  it('sends the answer and only the answer', async () => {
    const graph = audioGraph();
    const net = gateway();
    const element = new FakeAudioElement();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => element as unknown as HTMLAudioElement,
    });
    provider.connect(graph.context, graph.analyser);
    const speaking = provider.speak('Der Lead-Scraper ist verfügbar.');
    await vi.waitFor(() => expect(element.playCalls).toBe(1));
    element.emit('ended');
    await speaking;

    const post = net.calls.find((call) => call.url.endsWith('/api/voice/tts'));
    expect(post?.body).toEqual({ text: 'Der Lead-Scraper ist verfügbar.' });
  });

  it('reuses one element, because a second source node throws', async () => {
    const graph = audioGraph();
    const net = gateway();
    const element = new FakeAudioElement();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => element as unknown as HTMLAudioElement,
    });
    provider.connect(graph.context, graph.analyser);
    for (let turn = 0; turn < 2; turn += 1) {
      const speaking = provider.speak(`Antwort ${turn}`);
      await vi.waitFor(() => expect(element.playCalls).toBe(turn + 1));
      element.emit('ended');
      await speaking;
    }
    // An element may only ever be attached to one MediaElementSource.
    expect(graph.elements).toHaveLength(1);
  });

  it('is unavailable when the gateway says so, rather than failing mid-answer', async () => {
    const net = gateway({ status: okStatus({ ready: false, reason: 'fish_api_key_missing' }) });
    const provider = new FishAudioVoiceProvider({ fetchImpl: net.impl });
    expect(await provider.isAvailable()).toBe(false);
    // Told before a word is spoken, and with the fix rather than a code.
    expect(provider.unavailableReason).toContain('FISH_API_KEY');
  });

  it('throws on a refusal, which is what hands the sentence to the next voice', async () => {
    const net = gateway({
      speak: () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({ error: 'fish_free_model_unavailable' }),
        }) as unknown as Response,
    });
    const graph = audioGraph();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => new FakeAudioElement() as unknown as HTMLAudioElement,
    });
    provider.connect(graph.context, graph.analyser);
    // The voice service catches this and moves down the chain; the text stays
    // on screen either way.
    await expect(provider.speak('x')).rejects.toThrow(/FREE MODEL UNAVAILABLE/);
  });

  it('treats empty audio as a failure rather than silence', async () => {
    const net = gateway({
      speak: () =>
        ({
          ok: true,
          status: 200,
          blob: async () => new Blob([], { type: 'audio/mpeg' }),
        }) as unknown as Response,
    });
    const graph = audioGraph();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => new FakeAudioElement() as unknown as HTMLAudioElement,
    });
    provider.connect(graph.context, graph.analyser);
    await expect(provider.speak('x')).rejects.toThrow(/not playable audio/);
  });

  it('stops when the turn is interrupted', async () => {
    const graph = audioGraph();
    const net = gateway();
    const element = new FakeAudioElement();
    const provider = new FishAudioVoiceProvider({
      fetchImpl: net.impl,
      createAudio: () => element as unknown as HTMLAudioElement,
    });
    provider.connect(graph.context, graph.analyser);
    const controller = new AbortController();
    const speaking = provider.speak('eine lange Antwort', { signal: controller.signal });
    await vi.waitFor(() => expect(element.playCalls).toBe(1));
    controller.abort();
    await speaking;
    expect(element.paused).toBe(true);
  });

  it('says what is wrong in words, for every failure the gateway can name', () => {
    for (const reason of [
      'local_only',
      'fish_disabled',
      'fish_api_key_missing',
      'fish_voice_not_configured',
      'fish_auth_failed',
      'fish_voice_not_found',
      'fish_free_model_unavailable',
      'fish_rate_limited',
      'fish_timeout',
      'fish_invalid_audio',
      'fish_network_offline',
    ]) {
      const message = describeReason(reason);
      expect(message.length).toBeGreaterThan(10);
      // A remedy or a plain statement, never the raw code on its own.
      expect(message).not.toBe(reason);
    }
    expect(describeReason(undefined)).toContain('unavailable');
  });
});
