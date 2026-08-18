/**
 * Browser speech-synthesis fallback for ZERO's voice.
 *
 * Used when ZERO's realtime voice is unavailable (no experimental API, no
 * thread, or offline). The platform synthesizer cannot be routed into the Web
 * Audio graph, so this provider reports `connect() === false`: the smoke then
 * reacts to the synthesizer's real word-boundary events only, and never to a
 * fabricated waveform.
 */
import type { AudioLevels } from '../audio/analyser';
import { rankVoiceCandidates, type VoiceCharacter, type VoiceProvider, type VoiceSpeakOptions } from './provider';

export class SpeechSynthesisVoiceProvider implements VoiceProvider {
  readonly id = 'speech-synthesis' as const;
  readonly label = 'Browser speech synthesis';
  readonly unavailableReason = 'speechSynthesis is not available in this browser';

  private boundaryEnergy = 0;
  private speaking = false;

  constructor(private readonly character: VoiceCharacter) {}

  isAvailable(): boolean {
    return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
  }

  connect(): boolean {
    // No audio-graph access for platform TTS.
    return false;
  }

  readLevels(): AudioLevels | null {
    if (!this.speaking) return null;
    this.boundaryEnergy = Math.max(0, this.boundaryEnergy - 0.045);
    const amplitude = 0.12 + this.boundaryEnergy * 0.5;
    return {
      amplitude,
      peak: amplitude,
      low: amplitude * 0.7,
      high: this.boundaryEnergy * 0.6,
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

    await new Promise<void>((resolve) => {
      utterance.onboundary = () => {
        this.boundaryEnergy = 1;
      };
      utterance.onend = () => {
        this.speaking = false;
        this.boundaryEnergy = 0;
        resolve();
      };
      utterance.onerror = () => {
        this.speaking = false;
        this.boundaryEnergy = 0;
        resolve();
      };
      options?.signal?.addEventListener('abort', () => {
        synth.cancel();
        this.speaking = false;
        resolve();
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
