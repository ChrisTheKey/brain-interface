/**
 * The audio engine: one AudioContext, one AnalyserNode, every sound ZERO makes.
 *
 *   /ws/voice PCM16 chunks ─┐
 *   /api/voice/tts buffer  ─┼─▶ GainNode ─▶ AnalyserNode ─▶ speakers
 *                           ┘                    │
 *                                                └─▶ levels() ─▶ the brain
 *
 * Because the analyser sits between the sources and the speakers, the brain
 * reacts to exactly the signal the user hears — not to a "voice is playing"
 * flag and not to an estimate. Streaming chunks are scheduled against a
 * play-head so consecutive frames join without a click.
 */
import { SILENT_LEVELS, VoiceAnalyser, type AudioLevels } from './analyser';
import type { VoiceAudioChunk } from '../hwd/types';
import { pcm16ToPlanarFloat } from '../hwd/voiceChannel';

export type AudioEngineState = 'idle' | 'ready' | 'playing' | 'unavailable';

export interface AudioEngineOptions {
  /** Seconds of lead time given to the first scheduled chunk. */
  scheduleAheadSeconds?: number;
  onStateChange?: (state: AudioEngineState, detail?: string) => void;
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: VoiceAnalyser | null = null;
  private gain: GainNode | null = null;
  private playHead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private state: AudioEngineState = 'idle';
  private reason: string | undefined;

  constructor(private readonly options: AudioEngineOptions = {}) {}

  get currentState(): AudioEngineState {
    return this.state;
  }

  get unavailableReason(): string | undefined {
    return this.reason;
  }

  /** True while audio is genuinely coming out of the speakers. */
  get isPlaying(): boolean {
    if (this.sources.size === 0) return false;
    const context = this.context;
    if (!context) return false;
    return this.playHead > context.currentTime - 0.02;
  }

  /**
   * Must be called from a user gesture — browsers refuse to start an
   * AudioContext otherwise, and a blocked context is reported rather than
   * silently swallowed.
   */
  async activate(): Promise<boolean> {
    if (this.state === 'ready' || this.state === 'playing') return true;
    const Ctor = audioContextConstructor();
    if (!Ctor) {
      this.setState('unavailable', 'the Web Audio API is not available in this browser');
      return false;
    }
    try {
      this.context ??= new Ctor();
      if (this.context.state === 'suspended') await this.context.resume();
    } catch (error) {
      this.setState(
        'unavailable',
        error instanceof Error ? error.message : 'the AudioContext was blocked',
      );
      return false;
    }

    if (!this.analyser) {
      this.analyser = new VoiceAnalyser(this.context);
      this.analyser.node.connect(this.context.destination);
    }
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.analyser.node);
    }
    this.setState('ready');
    return true;
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  /** Schedule one streamed PCM16 chunk right after the previous one. */
  enqueuePcm(chunk: VoiceAudioChunk): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;
    const channels = Math.max(1, chunk.channels || 1);
    const planes = pcm16ToPlanarFloat(chunk.samples, channels);
    const frames = planes[0]?.length ?? 0;
    if (frames === 0) return;

    const buffer = context.createBuffer(channels, frames, chunk.sampleRate || context.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const plane = planes[channel];
      if (plane) buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, channel);
    }
    this.schedule(buffer);
  }

  /** Decode and play a complete audio file (the `/api/voice/tts` fallback). */
  async playEncoded(data: ArrayBuffer): Promise<void> {
    const context = this.context;
    if (!context || !this.gain) return;
    const buffer = await context.decodeAudioData(data.slice(0));
    this.schedule(buffer);
    // Resolve when the last scheduled sample has actually been played, so the
    // caller's SPEAKING state ends with the sound rather than with the request.
    const remaining = Math.max(0, this.playHead - context.currentTime);
    await new Promise<void>((resolve) => setTimeout(resolve, remaining * 1000));
  }

  private schedule(buffer: AudioBuffer): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const ahead = this.options.scheduleAheadSeconds ?? 0.06;
    const startAt = Math.max(context.currentTime + ahead, this.playHead);
    source.start(startAt);
    this.playHead = startAt + buffer.duration;
    this.sources.add(source);
    this.setState('playing');
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.setState('ready');
    };
  }

  /** Cut ZERO off mid-sentence (barge-in, kill switch, unmount). */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.playHead = this.context?.currentTime ?? 0;
    if (this.state === 'playing') this.setState('ready');
  }

  /** Measured levels of what is playing right now. Silent when nothing is. */
  levels(): AudioLevels {
    if (!this.analyser) return SILENT_LEVELS;
    return this.analyser.read();
  }

  dispose(): void {
    this.stop();
    this.analyser?.dispose();
    this.analyser = null;
    try {
      this.gain?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.gain = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.setState('idle');
  }

  private setState(state: AudioEngineState, detail?: string): void {
    if (this.state === state && this.reason === detail) return;
    this.state = state;
    this.reason = detail;
    this.options.onStateChange?.(state, detail);
  }
}
