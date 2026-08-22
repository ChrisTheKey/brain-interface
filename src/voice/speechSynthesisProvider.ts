/**
 * The last-resort speaker: the browser's own synthesizer.
 *
 * Used only when HWD-ZERO can neither stream PCM over `/ws/voice` nor render
 * audio at `/api/voice/tts`. The platform synthesizer cannot be routed into the
 * Web Audio graph, so there is no signal to analyse. Rather than faking one,
 * this provider exposes an *estimated* level source and says so:
 *
 * - Primary: the engine's real `boundary` events — one impulse per spoken
 *   word, which is the only real timing signal the platform gives us.
 * - Fallback: if the engine emits no boundary events (some Android voices do
 *   not), the word cadence is derived from the utterance and the configured
 *   rate. That is an estimate, and it only runs while an utterance is speaking.
 *
 * `estimated` is true for both, and the HUD renders that as a warning so the
 * smoke is never mistaken for a measurement.
 */
import type { AudioLevels } from '../audio/analyser';
import { rankVoiceCandidates, type VoiceCharacter } from './provider';

/** Words per second at rate 1.0 — used only for the estimated cadence. */
const BASE_WORDS_PER_SECOND = 2.6;

export class SpeechSynthesisSpeaker {
  readonly id = 'synthesis' as const;
  /** These levels are derived from word timing, not from an audio signal. */
  readonly estimated = true;

  private boundaryEnergy = 0;
  private speaking = false;
  private hasBoundaryEvents = false;
  private wordCount = 0;
  private startedAt = 0;
  private estimatedWordIndex = -1;
  private readonly now: () => number;

  constructor(
    private readonly character: VoiceCharacter,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  static isSupported(): boolean {
    return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
  }

  isAvailable(): boolean {
    return SpeechSynthesisSpeaker.isSupported();
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Estimated level source: one impulse per word, silence in between. */
  readLevels(): AudioLevels | null {
    if (!this.speaking) return null;

    if (!this.hasBoundaryEvents && this.wordCount > 0) {
      const elapsedSeconds = (this.now() - this.startedAt) / 1000;
      const wordsPerSecond = BASE_WORDS_PER_SECOND * Math.max(0.4, this.character.rate);
      const index = Math.floor(elapsedSeconds * wordsPerSecond);
      if (index !== this.estimatedWordIndex && index < this.wordCount) {
        this.estimatedWordIndex = index;
        this.boundaryEnergy = 1;
      }
    }

    this.boundaryEnergy = Math.max(0, this.boundaryEnergy - 0.06);
    const amplitude = 0.06 + this.boundaryEnergy * 0.62;
    return {
      amplitude,
      peak: amplitude,
      low: 0.2 + this.boundaryEnergy * 0.5,
      mid: 0.15 + this.boundaryEnergy * 0.45,
      high: this.boundaryEnergy * 0.75,
      transient: this.boundaryEnergy,
    };
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!this.isAvailable()) throw new Error('speechSynthesis is not available in this browser');
    const synth = globalThis.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.character.rate;
    utterance.pitch = this.character.pitch;
    utterance.volume = this.character.volume;

    const voices = synth.getVoices();
    const best = rankVoiceCandidates(voices, this.character.preferredVoices)[0];
    if (best) utterance.voice = best;

    this.speaking = true;
    this.hasBoundaryEvents = false;
    this.wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    this.startedAt = this.now();
    this.estimatedWordIndex = -1;
    this.boundaryEnergy = 1;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.speaking = false;
        this.boundaryEnergy = 0;
        resolve();
      };
      utterance.onboundary = (event: SpeechSynthesisEvent) => {
        if (event.name && event.name !== 'word') return;
        this.hasBoundaryEvents = true;
        this.boundaryEnergy = 1;
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      signal?.addEventListener('abort', () => {
        synth.cancel();
        finish();
      });
      synth.speak(utterance);
    });
  }

  stop(): void {
    this.speaking = false;
    this.boundaryEnergy = 0;
    if (this.isAvailable()) globalThis.speechSynthesis.cancel();
  }

  dispose(): void {
    this.stop();
  }
}
