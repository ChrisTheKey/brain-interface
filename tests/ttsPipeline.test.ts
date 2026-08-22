import { describe, expect, it } from 'vitest';
import { resolveTier, TIER_NOTES } from '../src/voice/ttsPipeline';

const all = { stream: true, http: true, synthesis: true };
const none = { stream: false, http: false, synthesis: false };

describe('choosing how ZERO is voiced', () => {
  it('prefers the measured, streamed path when the operator offers it', () => {
    expect(resolveTier('auto', all)).toBe('stream');
  });

  it('degrades to the HTTP path, which is still real audio', () => {
    expect(resolveTier('auto', { ...all, stream: false })).toBe('http');
    expect(TIER_NOTES.http).toContain('still analysed');
  });

  it('degrades to the browser voice last, and says the reaction is estimated', () => {
    expect(resolveTier('auto', { ...none, synthesis: true })).toBe('synthesis');
    expect(TIER_NOTES.synthesis).toContain('estimated');
  });

  it('answers in text only when there is no voice at all', () => {
    expect(resolveTier('auto', none)).toBe('none');
    expect(TIER_NOTES.none).toContain('text only');
    expect(TIER_NOTES.stream).toBeNull();
  });

  it('honours a pinned mode instead of silently upgrading it', () => {
    expect(resolveTier('synthesis', all)).toBe('synthesis');
    expect(resolveTier('http', all)).toBe('http');
    expect(resolveTier('none', all)).toBe('none');
  });

  it('does not pretend a pinned mode works when the capability is missing', () => {
    expect(resolveTier('stream', { ...all, stream: false })).toBe('none');
    expect(resolveTier('http', { ...all, http: false })).toBe('none');
  });
});
