import { describe, expect, it } from 'vitest';
import {
  acceptKey,
  decodeFrames,
  encodeFrame,
  OPCODE,
} from '../server/lib/websocket.mjs';

describe('websocket frames', () => {
  it('round-trips a short text frame', () => {
    const { frames, rest } = decodeFrames(encodeFrame(OPCODE.text, 'hello ZERO'));
    expect(rest.length).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(OPCODE.text);
    expect(frames[0]?.fin).toBe(true);
    expect(frames[0]?.payload.toString('utf8')).toBe('hello ZERO');
  });

  it('round-trips payloads across both extended length forms', () => {
    // CDP page reads are routinely larger than 64 KiB, so the 16-bit and
    // 64-bit length headers are both real paths, not theory.
    for (const size of [125, 126, 65_535, 65_536, 200_000]) {
      const payload = Buffer.alloc(size, 0x5a);
      const { frames, rest } = decodeFrames(encodeFrame(OPCODE.binary, payload));
      expect(rest.length).toBe(0);
      expect(frames[0]?.payload.length).toBe(size);
      expect(frames[0]?.payload.equals(payload)).toBe(true);
    }
  });

  it('masks client frames, as the protocol requires of a client', () => {
    const frame = encodeFrame(OPCODE.text, 'abc', Buffer.from([1, 2, 3, 4]));
    expect((frame[1] as number) & 0x80).toBe(0x80);
    // The bytes on the wire are masked, not the plaintext.
    expect(frame.subarray(6).toString('utf8')).not.toBe('abc');
  });

  it('keeps a partial frame back until the rest arrives', () => {
    const frame = encodeFrame(OPCODE.text, 'a longer message than one packet');
    const first = decodeFrames(frame.subarray(0, 8));
    expect(first.frames).toHaveLength(0);
    expect(first.rest.length).toBe(8);

    const complete = decodeFrames(Buffer.concat([first.rest, frame.subarray(8)]));
    expect(complete.frames).toHaveLength(1);
    expect(complete.frames[0]?.payload.toString('utf8')).toBe(
      'a longer message than one packet',
    );
  });

  it('decodes several frames out of one buffer', () => {
    const buffer = Buffer.concat([
      encodeFrame(OPCODE.text, 'one'),
      encodeFrame(OPCODE.text, 'two'),
      encodeFrame(OPCODE.ping, Buffer.alloc(0)),
    ]);
    const { frames, rest } = decodeFrames(buffer);
    expect(frames.map((frame) => frame.opcode)).toEqual([
      OPCODE.text,
      OPCODE.text,
      OPCODE.ping,
    ]);
    expect(rest.length).toBe(0);
  });

  it('computes the RFC 6455 accept key', () => {
    // The example from the RFC itself.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});
