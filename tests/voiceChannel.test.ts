import { describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  bytesToPcm16,
  parseVoiceFrame,
  pcm16ToPlanarFloat,
  VoiceChannel,
} from '../src/hwd/voiceChannel';
import type { VoiceAudioChunk } from '../src/hwd/types';

/** A WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function channel(handlers = {}, options = {}) {
  FakeSocket.instances = [];
  const instance = new VoiceChannel(
    {
      openSocket: () => new FakeSocket() as unknown as WebSocket,
      language: 'de-DE',
      reconnectDelayMs: 5,
      ...options,
    },
    handlers,
  );
  return instance;
}

const pcm16Base64 = (samples: number[]): string => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString('base64');
};

describe('PCM decoding', () => {
  it('reads little-endian PCM16 out of a base64 frame', () => {
    const samples = bytesToPcm16(base64ToBytes(pcm16Base64([0, 32767, -32768, 16384])));
    expect([...samples]).toEqual([0, 32767, -32768, 16384]);
  });

  it('de-interleaves into planar float in −1..1', () => {
    const planes = pcm16ToPlanarFloat(Int16Array.from([0, 32767, -32768, 16384]), 2);
    expect(planes).toHaveLength(2);
    expect(planes[0]?.[0]).toBeCloseTo(0, 5);
    expect(planes[0]?.[1]).toBeCloseTo(-1, 4);
    expect(planes[1]?.[0]).toBeCloseTo(0.99997, 4);
    expect(planes[1]?.[1]).toBeCloseTo(0.5, 4);
  });

  it('handles an empty chunk without throwing', () => {
    expect(pcm16ToPlanarFloat(new Int16Array(0), 1)[0]?.length).toBe(0);
  });
});

describe('voice frame parsing', () => {
  const format = { sampleRate: 24_000, channels: 1 };

  it('parses the JSON protocol', () => {
    const parsed = parseVoiceFrame('{"type":"voice.response","text":"Verstanden."}', format);
    expect(parsed).toEqual({ frame: { type: 'voice.response', text: 'Verstanden.' } });
  });

  it('treats a binary frame as raw PCM in the announced format', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0x80]);
    const parsed = parseVoiceFrame(bytes.buffer, { sampleRate: 16_000, channels: 2 });
    expect(parsed && 'audio' in parsed).toBe(true);
    const audio = (parsed as { audio: VoiceAudioChunk }).audio;
    expect(audio.sampleRate).toBe(16_000);
    expect(audio.channels).toBe(2);
    expect([...audio.samples]).toEqual([16384, -32768]);
  });

  it('drops a frame it cannot parse rather than half-rendering it', () => {
    expect(parseVoiceFrame('not json', format)).toBeNull();
    expect(parseVoiceFrame('{"no":"type"}', format)).toBeNull();
    expect(parseVoiceFrame(42, format)).toBeNull();
  });
});

describe('the voice channel', () => {
  it('announces itself and reports the socket as open', () => {
    const statuses: string[] = [];
    const instance = channel({ onStatus: (status: string) => statuses.push(status) });
    instance.connect();
    expect(instance.isAvailable).toBe(false);
    FakeSocket.instances[0]?.open();
    expect(instance.isAvailable).toBe(true);
    expect(statuses).toEqual(['connecting', 'open']);
    expect(JSON.parse(FakeSocket.instances[0]!.sent[0]!)).toMatchObject({
      type: 'voice.hello',
      language: 'de-DE',
    });
  });

  it('routes every frame kind to its handler', () => {
    const seen: Record<string, unknown> = {};
    const instance = channel({
      onState: (state: string) => (seen['state'] = state),
      onPartial: (text: string) => (seen['partial'] = text),
      onTranscript: (text: string, final: boolean) => (seen['transcript'] = [text, final]),
      onResponse: (text: string, mission?: string) => (seen['response'] = [text, mission]),
      onAudio: (chunk: VoiceAudioChunk) => (seen['audio'] = [...chunk.samples]),
      onAudioEnd: () => (seen['end'] = true),
      onError: (message: string) => (seen['error'] = message),
    });
    instance.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    socket.receive(JSON.stringify({ type: 'voice.state', state: 'PLANNING' }));
    socket.receive(JSON.stringify({ type: 'voice.partial', text: 'starte den' }));
    socket.receive(JSON.stringify({ type: 'voice.transcript', text: 'starte den Scraper', final: true }));
    socket.receive(JSON.stringify({ type: 'voice.response', text: 'Verstanden.', mission_id: 'M-9' }));
    socket.receive(
      JSON.stringify({ type: 'voice.audio', sample_rate: 24_000, channels: 1, data: pcm16Base64([7, -7]) }),
    );
    socket.receive(JSON.stringify({ type: 'voice.audio.end' }));
    socket.receive(JSON.stringify({ type: 'voice.error', message: 'tts offline' }));

    expect(seen['state']).toBe('PLANNING');
    expect(seen['partial']).toBe('starte den');
    expect(seen['transcript']).toEqual(['starte den Scraper', true]);
    expect(seen['response']).toEqual(['Verstanden.', 'M-9']);
    expect(seen['audio']).toEqual([7, -7]);
    expect(seen['end']).toBe(true);
    expect(seen['error']).toBe('tts offline');
  });

  it('uses the announced format for the binary frames that follow', () => {
    const chunks: VoiceAudioChunk[] = [];
    const instance = channel({ onAudio: (chunk: VoiceAudioChunk) => chunks.push(chunk) });
    instance.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive(JSON.stringify({ type: 'voice.audio', sample_rate: 48_000, channels: 2 }));
    socket.receive(new Uint8Array([0x00, 0x40, 0x00, 0x80]).buffer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sampleRate).toBe(48_000);
    expect(chunks[0]?.channels).toBe(2);
  });

  it('queues what matters while connecting and flushes it on open', () => {
    const instance = channel();
    instance.connect();
    instance.send({ type: 'voice.final', text: 'los', language: 'de-DE' });
    // A partial goes stale in transit, so it is never queued.
    instance.send({ type: 'voice.partial', text: 'lo' });
    const socket = FakeSocket.instances[0]!;
    expect(socket.sent).toHaveLength(0);
    socket.open();
    const kinds = socket.sent.map((payload) => JSON.parse(payload).type);
    expect(kinds).toEqual(['voice.hello', 'voice.final']);
  });

  it('gives up after a few failed connects and says the endpoint is missing', async () => {
    vi.useFakeTimers();
    const statuses: { status: string; detail?: string }[] = [];
    const instance = channel(
      { onStatus: (status: string, detail?: string) => statuses.push({ status, detail }) },
      { maxAttempts: 2 },
    );
    instance.connect();
    FakeSocket.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(10);
    FakeSocket.instances[1]?.close();
    expect(instance.currentStatus).toBe('unavailable');
    expect(statuses.at(-1)?.detail).toContain('/ws/voice');
    // Once it is unavailable nothing is queued: the interface has degraded.
    instance.send({ type: 'voice.final', text: 'x', language: 'de-DE' });
    instance.close();
    vi.useRealTimers();
  });

  it('reconnects after a socket that had been open drops', async () => {
    vi.useFakeTimers();
    const instance = channel();
    instance.connect();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.close();
    expect(instance.currentStatus).toBe('closed');
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances).toHaveLength(2);
    instance.close();
    vi.useRealTimers();
  });
});
