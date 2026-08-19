/**
 * Browser speech-synthesis fallback for ZERO's voice.
 *
 * Used when ZERO's realtime voice is unavailable (no experimental API, no
 * thread, offline, or not authenticated). The platform synthesizer cannot be
 * routed into the Web Audio graph, so `connect()` returns false and the smoke
 * is driven by this provider's own level source instead:
 *
 * - Primary: the engine's real `boundary` events — one impulse per spoken
 *   word, which is what makes the smoke pulse in sync with the words.
 * - Fallback: if the engine emits no boundary events (some Android voices do
 *   not), the word cadence is *estimated* from the utterance text and the
 *   configured rate. That is an estimate, not a measurement, and it only ever
 *   runs while an utterance is actually speaking.
 */
import type { AudioLevels } from '../audio/analyser';
import {
  rankVoiceCandidates,
  type VoiceCharacter,
  type VoiceProvider,
  type VoiceSpeakOptions,
} from './provider';

/** Words per second at rate 1.0 — used only for the estimated cadence. */
const BASE_WORDS_PER_SECOND = 2.6;

export class SpeechSynthesisVoiceProvider implements VoiceProvider {
  readonly id = 'speech-synthesis' as const;
  readonly label = 'Browser speech synthesis';
  readonly unavailableReason = 'speechSynthesis is not available in this browser';

  private boundaryEnergy = 0;
  private speaking = false;
  private hasBoundaryEvents = false;
  private wordCount = 0;
  private startedAt = 0;
  private estimatedWordIndex = -1;
  private now: () => number;

  constructor(
    private readonly character: VoiceCharacter,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  isAvailable(): boolean {
    return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
  }

  connect(): boolean {
    // No audio-graph access for platform TTS.
    return false;
  }

  /** Level source for the smoke: one impulse per word, silence in between. */
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
      high: this.boundaryEnergy * 0.75,
      onset: this.boundaryEnergy,
    };
  }

  async speak(text: string, options?: VoiceSpeakOptions): Promise<void> {
    if (!this.isAvailable()) throw new Error(this.unavailableReason);
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
      options?.signal?.addEventListener('abort', () => {
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
