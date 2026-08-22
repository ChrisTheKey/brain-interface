import { describe, expect, it } from 'vitest';
import { mergeResults } from '../src/voice/speechInput';

/** Shape of the platform event, built the way the engine builds it. */
function event(
  resultIndex: number,
  results: { transcript: string; isFinal: boolean }[],
): Parameters<typeof mergeResults>[0] {
  return {
    resultIndex,
    results: results.map((entry) =>
      Object.assign([{ transcript: entry.transcript }], { isFinal: entry.isFinal }),
    ) as unknown as Parameters<typeof mergeResults>[0]['results'],
  };
}

describe('partial and final transcripts', () => {
  it('keeps what is still being revised out of what was committed', () => {
    const merged = mergeResults(event(0, [{ transcript: 'starte den', isFinal: false }]), '');
    expect(merged.committed).toBe('');
    expect(merged.partial).toBe('starte den');
  });

  it('commits a segment the engine finalised', () => {
    const merged = mergeResults(event(0, [{ transcript: 'starte den Scraper', isFinal: true }]), '');
    expect(merged.committed).toBe('starte den Scraper');
    expect(merged.partial).toBe('');
  });

  it('accumulates across the bursts a phone engine produces', () => {
    // The engine keeps every result and moves `resultIndex` to the first one
    // that changed, so the earlier finals are still in the list.
    const committed = { transcript: 'starte den Scraper', isFinal: true };
    const first = mergeResults(event(0, [committed]), '');
    const second = mergeResults(
      event(1, [committed, { transcript: 'für Hamburg', isFinal: false }]),
      first.committed,
    );
    expect(second.committed).toBe('starte den Scraper');
    expect(second.partial).toBe('für Hamburg');

    const third = mergeResults(
      event(1, [committed, { transcript: 'für Hamburg', isFinal: true }]),
      second.committed,
    );
    expect(third.committed).toBe('starte den Scraper für Hamburg');
  });

  it('only reads from resultIndex onward, so a final is never counted twice', () => {
    const merged = mergeResults(
      event(1, [
        { transcript: 'already committed', isFinal: true },
        { transcript: 'neu', isFinal: false },
      ]),
      'already committed',
    );
    expect(merged.committed).toBe('already committed');
    expect(merged.partial).toBe('neu');
  });
});
