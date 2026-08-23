import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAKE_CONFIG,
  matchWakePhrase,
  normalise,
  stripWakePhrase,
  wakeConfigFrom,
} from '../src/voice/wakeWord';

/**
 * "Hey ZERO" — and nothing that merely sounds like it.
 *
 * A wake word that fires on a near-miss is worse than one that occasionally
 * misses: the miss costs a repeat, the false fire costs a command nobody gave.
 * Most of this file is about what must *not* wake ZERO.
 */

describe('what wakes ZERO', () => {
  it('wakes on the phrase however the engine spells it', () => {
    for (const heard of [
      'hey zero',
      'Hey Zero',
      'HEY ZERO',
      'hey, zero',
      'Hey ZERO.',
      '  hey   zero  ',
      'Hey, Zero!',
    ]) {
      expect(matchWakePhrase(heard).woke, heard).toBe(true);
    }
  });

  it('does not wake on half of it, or on something that rhymes', () => {
    // Each of these has woken a voice assistant somewhere. None of them is
    // someone addressing ZERO.
    for (const heard of [
      'zero',
      'hey',
      'hero',
      'ciro',
      'hey there',
      'zero point five',
      'heyzero',
      'hey zeroes',
      'whiskey zero',
      'the hey zero problem',
      '',
      '   ',
    ]) {
      expect(matchWakePhrase(heard).woke, heard).toBe(false);
    }
  });

  it('treats the phrase inside a sentence as talking about ZERO, not to it', () => {
    // Score 0.6, under the 0.8 default: someone recounting what they said
    // earlier should not start a turn.
    const match = matchWakePhrase('ich habe dann hey zero gesagt');
    expect(match.woke).toBe(false);
    // Lower the bar deliberately and it does match — the score is real, not a
    // flag dressed up as a number.
    const lenient = matchWakePhrase('ich habe dann hey zero gesagt', {
      ...DEFAULT_WAKE_CONFIG,
      threshold: 0.5,
    });
    expect(lenient.woke).toBe(true);
    expect(lenient.score).toBe(0.6);
  });

  it('folds the accents a German engine puts in', () => {
    expect(normalise('Hey Zéro, wie geht es dir?')).toBe('hey zero wie geht es dir');
    expect(matchWakePhrase('Hey Zéro').woke).toBe(true);
  });

  it('takes the phrase off the front and leaves the instruction as spoken', () => {
    // The original spelling survives: what reaches ZERO keeps its capitals,
    // its umlauts and its question mark.
    expect(stripWakePhrase('Hey ZERO, welche Agenten sind verfügbar?')).toBe(
      'welche Agenten sind verfügbar?',
    );
    expect(stripWakePhrase('hey zero starte den Report')).toBe('starte den Report');
    expect(stripWakePhrase('Hey Zero: warum genau diesen?')).toBe('warum genau diesen?');
    // Nothing after the phrase is not an instruction.
    expect(stripWakePhrase('Hey ZERO')).toBe('');
    // Not addressed to ZERO at all: left exactly as it was.
    expect(stripWakePhrase('starte den Report')).toBe('starte den Report');
  });

  it('reports what followed the phrase in the same breath', () => {
    const match = matchWakePhrase('Hey ZERO, welcher Agent eignet sich für Lead-Recherche?');
    expect(match.woke).toBe(true);
    expect(match.score).toBe(1);
    expect(match.command).toBe('welcher agent eignet sich fur lead recherche');
  });

  it('takes its phrase and threshold from the environment', () => {
    const config = wakeConfigFrom({
      ZERO_WAKE_PHRASE: 'hallo zero',
      ZERO_WAKE_VARIANTS: 'hallo sero, halo zero',
      ZERO_WAKE_THRESHOLD: '0.5',
    });
    expect(config.phrase).toBe('hallo zero');
    expect(config.threshold).toBe(0.5);
    expect(matchWakePhrase('hallo sero, was läuft?', config).woke).toBe(true);
    // The default phrase is not implicitly kept when another one is chosen.
    expect(matchWakePhrase('hey zero', config).woke).toBe(false);
  });

  it('falls back to the default rather than an empty phrase', () => {
    const config = wakeConfigFrom({ ZERO_WAKE_PHRASE: '   ', ZERO_WAKE_THRESHOLD: 'nonsense' });
    expect(config.phrase).toBe('hey zero');
    expect(config.threshold).toBe(0.8);
  });

  it('strips a longer variant before the shorter phrase inside it', () => {
    const config = { ...DEFAULT_WAKE_CONFIG, variants: ['ok hey zero'] };
    expect(stripWakePhrase('ok hey zero starte den Report', config)).toBe('starte den Report');
  });
});
