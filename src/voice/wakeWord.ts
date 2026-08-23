/**
 * "Hey ZERO" — the phrase that turns listening into a command.
 *
 * The matcher lives in exactly one place because it decides two things that
 * must never disagree: whether ZERO woke up, and what the instruction was once
 * the wake phrase is taken off the front. Two copies of that logic would
 * eventually wake on one and route the other.
 *
 * It is deliberately not fuzzy. `zero`, `hey`, `hero` and `ciro` must not wake
 * anything — a wake word that fires on a near-miss is worse than one that
 * occasionally misses, because the miss costs a repeat and the false fire
 * costs a command nobody gave. Variants are added only when a real device
 * actually produces them, which is why the list below is short and
 * configurable rather than clever.
 */

/** The phrase, before normalisation. Configurable, but this is what ZERO answers to. */
export const DEFAULT_WAKE_PHRASE = 'hey zero';

/**
 * How good a match has to be. 1.0 is the phrase at the very start of what was
 * heard; 0.6 is the phrase somewhere inside a longer sentence, which is far
 * more likely to be someone talking *about* ZERO than *to* it.
 */
export const DEFAULT_WAKE_THRESHOLD = 0.8;

export interface WakeConfig {
  phrase: string;
  /** Extra spellings this device's engine actually produces. Usually empty. */
  variants: readonly string[];
  threshold: number;
}

export const DEFAULT_WAKE_CONFIG: WakeConfig = {
  phrase: DEFAULT_WAKE_PHRASE,
  variants: [],
  threshold: DEFAULT_WAKE_THRESHOLD,
};

export interface WakeMatch {
  /** Did the phrase appear well enough to act on? */
  woke: boolean;
  /** Match quality, not acoustic confidence: 1.0 at the start, 0.6 inside. */
  score: number;
  /** What was said after the phrase. Empty when the phrase stood alone. */
  command: string;
  /** The phrase as it was actually heard, for the log line. */
  heard: string;
}

/**
 * Text as the matcher compares it.
 *
 * Case, punctuation and spacing are all things an engine decides for itself
 * and none of them change what was said. Accents are folded because a German
 * engine writes "Hey Zéro" as readily as "Hey Zero" and the operator meant the
 * same thing both times.
 */
export function normalise(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Combining marks: "é" becomes "e", "ü" becomes "u".
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    // Punctuation becomes a space rather than nothing, so "hey,zero" is still
    // two words and "heyzero" — which is not what anyone said — is not.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phrases(config: WakeConfig): string[] {
  return [config.phrase, ...config.variants]
    .map((value) => normalise(value))
    .filter((value) => value.length > 0)
    // Longest first: a variant that contains the base phrase must win, or the
    // shorter match would strip the wrong number of words.
    .sort((left, right) => right.length - left.length);
}

/**
 * Did this transcript wake ZERO, and what was the instruction?
 *
 * Word-boundary matching on the normalised text: "hey zero" wakes, "hey zeroes"
 * does not, and neither half wakes on its own.
 */
export function matchWakePhrase(
  transcript: string,
  config: WakeConfig = DEFAULT_WAKE_CONFIG,
): WakeMatch {
  const spoken = normalise(transcript);
  const miss: WakeMatch = { woke: false, score: 0, command: '', heard: '' };
  if (!spoken) return miss;

  for (const phrase of phrases(config)) {
    const index = spoken.indexOf(phrase);
    if (index === -1) continue;
    // A word boundary on both sides. Without this, "hey zeroes" and
    // "whiskey zero" would both wake ZERO.
    const before = index === 0 ? ' ' : spoken[index - 1]!;
    const afterIndex = index + phrase.length;
    const after = afterIndex >= spoken.length ? ' ' : spoken[afterIndex]!;
    if (before !== ' ' || after !== ' ') continue;

    const score = index === 0 ? 1 : 0.6;
    if (score < config.threshold) continue;
    return {
      woke: true,
      score,
      command: spoken.slice(afterIndex).trim(),
      heard: phrase,
    };
  }
  return miss;
}

/**
 * The instruction, with the wake phrase taken off the front.
 *
 * Applied to the *original* text rather than the normalised one, so what
 * reaches ZERO keeps its capitals, its umlauts and its question mark — the
 * normalised form is for matching, never for routing.
 */
export function stripWakePhrase(
  transcript: string,
  config: WakeConfig = DEFAULT_WAKE_CONFIG,
): string {
  const original = (transcript ?? '').trim();
  if (!original) return '';
  const match = matchWakePhrase(original, config);
  if (!match.woke) return original;

  // Walk the original word by word, skipping exactly as many words as the
  // phrase has. Doing it on words rather than characters keeps the original
  // spelling of everything that follows.
  const phraseWords = match.heard.split(' ').length;
  const words = original.split(/\s+/);
  let skipped = 0;
  let index = 0;
  while (index < words.length && skipped < phraseWords) {
    if (normalise(words[index]!)) skipped += 1;
    index += 1;
  }
  return words
    .slice(index)
    .join(' ')
    // A comma or colon left behind by "Hey ZERO, welche Agenten…"
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}

/** Read the config from the environment, falling back to the defaults. */
export function wakeConfigFrom(
  env: Record<string, string | undefined> = {},
): WakeConfig {
  const phrase = (env['VITE_ZERO_WAKE_PHRASE'] ?? env['ZERO_WAKE_PHRASE'] ?? '').trim();
  const raw = (env['VITE_ZERO_WAKE_VARIANTS'] ?? env['ZERO_WAKE_VARIANTS'] ?? '').trim();
  const threshold = Number(env['VITE_ZERO_WAKE_THRESHOLD'] ?? env['ZERO_WAKE_THRESHOLD']);
  return {
    phrase: phrase || DEFAULT_WAKE_PHRASE,
    variants: raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [],
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_WAKE_THRESHOLD,
  };
}
