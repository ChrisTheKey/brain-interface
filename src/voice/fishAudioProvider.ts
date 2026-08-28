/**
 * Fish Audio voice provider.
 *
 *   text → gateway /api/voice/fish/speak → api.fish.audio → PCM16 stream
 *        → Web Audio graph → speakers + analyser → smoke
 *
 * The provider never sees an API key: it posts to its own origin and the
 * gateway adds the credential (server/fishAudio.mjs). Audio is requested as
 * raw PCM and scheduled chunk by chunk as it streams in, so ZERO starts
 * speaking before the sentence has finished generating and the smoke reacts to
 * the real waveform — exactly like the ZERO realtime provider, and unlike the
 * browser synthesizer, which cannot be routed through the audio graph at all.
 *
 * A non-PCM format (mp3/wav/opus) is still supported: it is buffered and
 * decoded with `decodeAudioData`, which costs the streaming start but keeps
 * the audio graph — and therefore the smoke — intact.
 */
import { decodePcm16Bytes } from '../audio/analyser';
import type { VoiceProvider, VoiceSpeakOptions } from './provider';

export interface FishAudioStatus {
  provider: 'fish-audio';
  configured: boolean;
  model?: string;
  voiceId?: string | null;
  format?: string;
  sampleRate?: number;
  latency?: string;
  reason?: string;
}

export interface FishAudioOptions {
  /** Gateway endpoint that proxies Fish Audio, e.g. `/api/voice/fish`. */
  endpoint: string;
  /** Fish Audio voice model id; empty means the model's default speaker. */
  voiceId: string;
  model: string;
  latency: 'normal' | 'balanced' | 'low';
  format: 'pcm' | 'mp3' | 'wav' | 'opus';
  sampleRate: number;
  /** Prosody speed, 0.5–2.0. ZERO speaks a little below neutral. */
  speed: number;
  fetchImpl?: typeof fetch;
}

export class FishAudioVoiceProvider implements VoiceProvider {
  readonly id = 'fish-audio' as const;
  readonly label = 'Fish Audio';

  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private playHead = 0;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private reason: string | undefined;
  private status: FishAudioStatus | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FishAudioOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  get unavailableReason(): string | undefined {
    return this.reason;
  }

  /** What the gateway reports about Fish Audio, once it has been asked. */
  get lastStatus(): FishAudioStatus | null {
    return this.status;
  }

  /**
   * Availability is the gateway's answer, not a guess: it knows whether the
   * key is configured, and the interface is never told what the key is.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.options.endpoint}/status`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.reason = `the gateway did not answer for Fish Audio (HTTP ${response.status})`;
        return false;
      }
      const status = (await response.json()) as FishAudioStatus;
      this.status = status;
      if (!status.configured) {
        this.reason = status.reason ?? 'Fish Audio is not configured on the gateway';
        return false;
      }
      this.reason = undefined;
      return true;
    } catch (error) {
      this.reason =
        error instanceof Error
          ? `the ZERO gateway is not reachable: ${error.message}`
          : 'the ZERO gateway is not reachable';
      return false;
    }
  }

  connect(context: AudioContext, destination: AudioNode): boolean {
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(destination);
    return true;
  }

  async speak(text: string, options?: VoiceSpeakOptions): Promise<void> {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) throw new Error('Fish Audio is not connected to the audio graph');

    this.playHead = Math.max(this.playHead, context.currentTime);

    const response = await this.fetchImpl(`${this.options.endpoint}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/octet-stream' },
      body: JSON.stringify({
        text,
        voiceId: this.options.voiceId,
        model: this.options.model,
        latency: this.options.latency,
        format: this.options.format,
        sampleRate: this.options.sampleRate,
        speed: this.options.speed,
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        (detail as { message?: string })?.message ?? `Fish Audio failed (HTTP ${response.status})`,
      );
    }

    const format = response.headers.get('x-zero-audio-format') ?? this.options.format;
    const sampleRate = Number(
      response.headers.get('x-zero-audio-sample-rate') ?? this.options.sampleRate,
    );

    if (format === 'pcm' && response.body) {
      await this.playPcmStream(response.body, sampleRate, options?.signal);
      return;
    }

    // Compressed formats cannot be scheduled chunk by chunk; decode the whole
    // clip and play it through the same graph.
    const encoded = await response.arrayBuffer();
    if (options?.signal?.aborted) return;
    const buffer = await context.decodeAudioData(encoded);
    await this.playBuffer(buffer, options?.signal);
  }

  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    this.playHead = this.context?.currentTime ?? 0;
  }

  dispose(): void {
    this.stop();
    try {
      this.gain?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.gain = null;
    this.context = null;
  }

  /**
   * Schedules PCM as it arrives. A chunk boundary can split a 16-bit sample,
   * so the odd trailing byte is carried into the next chunk instead of being
   * dropped — that single byte is the difference between clean speech and a
   * click on every chunk.
   */
  private async playPcmStream(
    body: ReadableStream<Uint8Array>,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    let carry = new Uint8Array(0);
    let lastEnd = this.context?.currentTime ?? 0;

    try {
      for (;;) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        let bytes: Uint8Array;
        if (carry.length > 0) {
          bytes = new Uint8Array(carry.length + value.length);
          bytes.set(carry, 0);
          bytes.set(value, carry.length);
          carry = new Uint8Array(0);
        } else {
          bytes = value;
        }
        if (bytes.length % 2 === 1) {
          carry = bytes.slice(bytes.length - 1);
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length === 0) continue;

        const end = this.enqueuePcm(bytes, sampleRate);
        if (end !== null) lastEnd = end;
      }
    } finally {
      reader.releaseLock?.();
    }

    await this.waitUntil(lastEnd, signal);
  }

  /** Queues one PCM chunk; returns the time it will finish playing. */
  private enqueuePcm(bytes: Uint8Array, sampleRate: number): number | null {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return null;

    const planes = decodePcm16Bytes(bytes, 1);
    const frameCount = planes[0]?.length ?? 0;
    if (frameCount === 0) return null;

    const buffer = context.createBuffer(1, frameCount, sampleRate || context.sampleRate);
    const plane = planes[0];
    if (plane) buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    // A small lead keeps the first chunk from starting in the past.
    const startAt = Math.max(context.currentTime + 0.05, this.playHead);
    source.start(startAt);
    this.playHead = startAt + buffer.duration;
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
    return this.playHead;
  }

  private async playBuffer(buffer: AudioBuffer, signal?: AbortSignal): Promise<void> {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = Math.max(context.currentTime + 0.03, this.playHead);
    source.start(startAt);
    this.playHead = startAt + buffer.duration;
    this.activeSources.add(source);
    await new Promise<void>((resolve) => {
      source.onended = () => {
        this.activeSources.delete(source);
        resolve();
      };
      signal?.addEventListener('abort', () => {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        resolve();
      });
    });
  }

  /** Resolves when playback reaches `time`, or immediately when aborted. */
  private waitUntil(time: number, signal?: AbortSignal): Promise<void> {
    const context = this.context;
    if (!context) return Promise.resolve();
    const remainingMs = Math.max(0, (time - context.currentTime) * 1000);
    if (remainingMs === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remainingMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
