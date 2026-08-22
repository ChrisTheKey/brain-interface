/**
 * ZERO's voice character.
 *
 * The interface holds no credentials and no model: HWD-ZERO owns the voice.
 * What lives here is the character that shapes the *fallback* synthesizer when
 * the operator cannot stream audio itself, plus the ranking that picks the
 * closest platform voice.
 */

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
 * ZERO's persona. Deliberately description-driven: an original character, no
 * cloning and no imitation of a specific performer.
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
    const preferenceIndex = preferred.findIndex((entry) => name.includes(entry.toLowerCase()));
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
