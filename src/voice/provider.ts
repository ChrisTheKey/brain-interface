/**
 * Voice provider abstraction.
 *
 *   Voice Provider  →  ZERO Voice Service  →  Audio Playback  →  Audio Analyser
 *
 * Providers are interchangeable and carry no credentials: ZERO's own realtime
 * session is the default provider, the browser speech synthesizer is the
 * offline fallback. A provider that can route through the Web Audio graph
 * exposes `connect()`, which is what makes the smoke audio-reactive.
 */
import type { AudioLevels } from '../audio/analyser';

export type VoiceProviderId = 'zero-realtime' | 'speech-synthesis' | 'none';

export interface VoiceSpeakOptions {
  signal?: AbortSignal;
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  readonly label: string;
  /** True when the provider can actually be used in this environment. */
  isAvailable(): Promise<boolean> | boolean;
  /**
   * Route the provider's output into the Web Audio graph. Providers that
   * cannot expose their signal (browser speech synthesis) return false and
   * the smoke stays at its floor instead of reacting to a faked signal.
   */
  connect(context: AudioContext, destination: AudioNode): Promise<boolean> | boolean;
  speak(text: string, options?: VoiceSpeakOptions): Promise<void>;
  stop(): void;
  dispose(): void;
  /** Optional coarse level source for providers without an audio graph. */
  readLevels?(): AudioLevels | null;
  readonly unavailableReason?: string;
}

/** ZERO's voice character, applied to every provider that can be shaped. */
export interface VoiceCharacter {
  /** Slightly below neutral: measured, controlled delivery. */
  rate: number;
  /** Lower pitch: young-to-middle-aged male, authoritative. */
  pitch: number;
  volume: number;
  /** Ordered preferences matched against the platform voice list. */
  preferredVoices: string[];
}

/**
 * ZERO's voice character, handed to the realtime session as its prompt.
 * Deliberately description-driven: an original persona, no cloning and no
 * imitation of a specific performer.
 */
export const ZERO_VOICE_PROMPT = [
  'You are ZERO, the central orchestrator of this system.',
  'Speak as a young-to-middle-aged male voice: calm, precise and unhurried.',
  'Your delivery is strategic, controlled and quietly authoritative, with an',
  'aristocratic composure and a faint dramatic edge on the words that matter.',
  'Never raise your voice, never rush, never sound cheerful or servile.',
  'Answer in short, deliberate sentences.',
].join(' ');

export const ZERO_VOICE_CHARACTER: VoiceCharacter = {
  rate: 0.92,
  pitch: 0.82,
  volume: 1,
  preferredVoices: [],
};

/**
 * Ranks platform voices for ZERO: male, calm, precise. Purely heuristic
 * ranking over the names the platform reports — no voice cloning, no imitation
 * of a specific performer.
 */
export function rankVoiceCandidates<T extends { name: string; lang: string; default?: boolean }>(
  voices: T[],
  preferred: string[],
  language = 'en',
): T[] {
  const score = (voice: T): number => {
    const name = voice.name.toLowerCase();
    let value = 0;
    const preferenceIndex = preferred.findIndex((entry) =>
      name.includes(entry.toLowerCase()),
    );
    if (preferenceIndex >= 0) value += 1000 - preferenceIndex;
    if (/(male|david|daniel|alex|thomas|george|guy|ryan|brian|arthur|oliver)/.test(name)) {
      value += 40;
    }
    if (/(female|zira|samantha|victoria|karen|anna|amelie|serena)/.test(name)) value -= 60;
    if (voice.lang?.toLowerCase().startsWith(language.toLowerCase())) value += 20;
    if (/(natural|neural|premium|enhanced)/.test(name)) value += 15;
    if (voice.default) value += 5;
    return value;
  };
  return [...voices].sort((a, b) => score(b) - score(a));
}
