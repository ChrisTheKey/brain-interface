/**
 * ZERO Voice Service: owns the AudioContext, selects a provider, plays speech
 * and exposes the measured audio levels the smoke consumes.
 *
 * Everything degrades: if the AudioContext is blocked by the browser's
 * autoplay policy, or no provider is available, the service reports
 * `unavailable` and the rest of the interface keeps running.
 */
import { SILENT_LEVELS, VoiceAnalyser, type AudioLevels } from '../audio/analyser';
import type { VoiceProvider, VoiceProviderId } from './provider';

export type VoiceState = 'idle' | 'unavailable' | 'ready' | 'speaking';

export interface VoiceServiceEvents {
  state: (state: VoiceState, detail?: { reason?: string }) => void;
}

export class ZeroVoiceService {
  private context: AudioContext | null = null;
  private analyser: VoiceAnalyser | null = null;
  private provider: VoiceProvider | null = null;
  private readonly failedProviders = new Set<VoiceProviderId>();
  private state: VoiceState = 'idle';
  private abortController: AbortController | null = null;
  private readonly stateListeners = new Set<VoiceServiceEvents['state']>();
  private lastReason: string | undefined;

  constructor(private readonly providers: VoiceProvider[]) {}

  get currentState(): VoiceState {
    return this.state;
  }

  get providerId(): VoiceProviderId | null {
    return this.provider?.id ?? null;
  }

  get reason(): string | undefined {
    return this.lastReason;
  }

  onState(handler: VoiceServiceEvents['state']): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  /** Must be called from a user gesture so the AudioContext can start. */
  async activate(): Promise<boolean> {
    if (this.state === 'ready' || this.state === 'speaking') return true;

    const AudioContextCtor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

    if (!AudioContextCtor) {
      this.setState('unavailable', 'Web Audio API is not available');
      return false;
    }

    try {
      this.context ??= new AudioContextCtor();
      if (this.context.state === 'suspended') await this.context.resume();
    } catch (error) {
      this.setState('unavailable', error instanceof Error ? error.message : 'AudioContext blocked');
      return false;
    }

    this.analyser ??= new VoiceAnalyser(this.context);
    this.analyser.node.connect(this.context.destination);

    for (const candidate of this.providers) {
      if (this.failedProviders.has(candidate.id)) continue;
      const available = await candidate.isAvailable();
      if (!available) continue;
      this.provider = candidate;
      await candidate.connect(this.context, this.analyser.node);
      this.setState('ready');
      return true;
    }

    const reason =
      this.providers.find((candidate) => candidate.unavailableReason)?.unavailableReason ??
      'no voice provider available';
    this.setState('unavailable', reason);
    return false;
  }

  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (this.state !== 'ready' && this.state !== 'speaking') {
      const ok = await this.activate();
      if (!ok) return;
    }
    const provider = this.provider;
    if (!provider) return;

    this.abortController?.abort();
    this.abortController = new AbortController();
    this.setState('speaking');
    try {
      await provider.speak(trimmed, { signal: this.abortController.signal });
    } catch (error) {
      // A provider that fails at runtime (ZERO realtime not configured, for
      // example) hands over to the next one instead of killing the voice.
      const reason = error instanceof Error ? error.message : 'voice failed';
      this.failedProviders.add(provider.id);
      provider.dispose();
      this.provider = null;
      const hasFallback = this.providers.some(
        (candidate) => !this.failedProviders.has(candidate.id),
      );
      if (!hasFallback) {
        this.setState('unavailable', reason);
        return;
      }
      this.setState('idle', reason);
      const activated = await this.activate();
      if (!activated) return;
      await this.speak(trimmed);
      return;
    }
    if (this.state === 'speaking') this.setState('ready');
  }

  stop(): void {
    this.abortController?.abort();
    this.provider?.stop();
    if (this.state === 'speaking') this.setState('ready');
  }

  /** Current measured audio levels; silent when nothing is playing. */
  levels(): AudioLevels {
    if (this.analyser) {
      const measured = this.analyser.read();
      if (measured.amplitude > 0.001) return measured;
    }
    const fallback = this.provider?.readLevels?.();
    return fallback ?? SILENT_LEVELS;
  }

  dispose(): void {
    this.stop();
    for (const provider of this.providers) provider.dispose();
    this.analyser?.dispose();
    this.analyser = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.setState('idle');
  }

  private setState(state: VoiceState, reason?: string): void {
    this.state = state;
    this.lastReason = reason;
    for (const handler of this.stateListeners) handler(state, reason ? { reason } : undefined);
  }
}
