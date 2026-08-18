/**
 * ZERO realtime voice provider.
 *
 * Uses ZERO's own experimental thread-realtime API:
 *   thread/realtime/start      → open a realtime session on a thread
 *   thread/realtime/appendText → hand ZERO the text to voice
 *   thread/realtime/outputAudio/delta → PCM16 chunks streamed back
 *   thread/realtime/stop       → close the session
 *
 * The PCM chunks are decoded and scheduled through the Web Audio graph, so
 * the smoke analyses the exact signal the user hears. No API keys live here:
 * ZERO owns the upstream credentials.
 */
import { base64ToBytes, decodePcm16Base64 } from '../audio/analyser';
import type { ZeroClient } from '../zero/client';
import { ZERO_METHODS, type ThreadRealtimeOutputAudioDelta } from '../zero/protocol';
import type { VoiceProvider, VoiceSpeakOptions } from './provider';

export interface RealtimeVoiceOptions {
  client: ZeroClient;
  /** Thread the realtime session is attached to. */
  getThreadId: () => string | null;
  /** ZERO requires `capabilities.experimentalApi` for realtime. */
  experimentalApi: boolean;
  /**
   * Session prompt handed to ZERO's realtime session. This is where ZERO's
   * voice character is defined — an independent persona, not an imitation of
   * any real performer.
   */
  voicePrompt: string;
}

export class ZeroRealtimeVoiceProvider implements VoiceProvider {
  readonly id = 'zero-realtime' as const;
  readonly label = 'ZERO realtime voice';

  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private playHead = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private unsubscribe: (() => void) | null = null;
  private sessionThreadId: string | null = null;
  private reason: string | undefined;

  constructor(private readonly options: RealtimeVoiceOptions) {}

  get unavailableReason(): string | undefined {
    return this.reason;
  }

  isAvailable(): boolean {
    if (!this.options.experimentalApi) {
      this.reason = 'ZERO realtime requires VITE_ZERO_EXPERIMENTAL_API=true';
      return false;
    }
    if (this.options.client.connectionState !== 'connected') {
      this.reason = 'ZERO is not connected';
      return false;
    }
    if (!this.options.getThreadId()) {
      this.reason = 'no ZERO thread selected for the realtime session';
      return false;
    }
    this.reason = undefined;
    return true;
  }

  connect(context: AudioContext, destination: AudioNode): boolean {
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(destination);
    this.unsubscribe?.();
    this.unsubscribe = this.options.client.on('notification', (method, params) => {
      if (method !== 'thread/realtime/outputAudio/delta') return;
      const payload = params as ThreadRealtimeOutputAudioDelta | undefined;
      if (!payload?.audio?.data) return;
      if (this.sessionThreadId && payload.threadId !== this.sessionThreadId) return;
      this.enqueue(payload);
    });
    return true;
  }

  async speak(text: string, options?: VoiceSpeakOptions): Promise<void> {
    const threadId = this.options.getThreadId();
    if (!threadId) throw new Error('no ZERO thread available for realtime voice');
    if (this.sessionThreadId !== threadId) {
      await this.options.client.request(ZERO_METHODS.realtimeStart, {
        threadId,
        prompt: this.options.voicePrompt,
      });
      this.sessionThreadId = threadId;
    }
    if (options?.signal?.aborted) return;
    await this.options.client.request(ZERO_METHODS.realtimeAppendText, { threadId, text });
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
    this.playHead = 0;
    const threadId = this.sessionThreadId;
    this.sessionThreadId = null;
    if (threadId) {
      void this.options.client
        .request(ZERO_METHODS.realtimeStop, { threadId })
        .catch(() => undefined);
    }
  }

  dispose(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.gain?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.gain = null;
    this.context = null;
  }

  private enqueue(payload: ThreadRealtimeOutputAudioDelta): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;

    const { data, sampleRate, numChannels } = payload.audio;
    const channels = Math.max(1, numChannels || 1);
    const planes = decodePcm16Base64(data, channels, base64ToBytes);
    const frameCount = planes[0]?.length ?? 0;
    if (frameCount === 0) return;

    const buffer = context.createBuffer(channels, frameCount, sampleRate || context.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const plane = planes[channel];
      if (plane) buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, channel);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const now = context.currentTime;
    const startAt = Math.max(now + 0.02, this.playHead);
    source.start(startAt);
    this.playHead = startAt + buffer.duration;
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }
}
