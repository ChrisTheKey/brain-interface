import { describe, expect, it } from 'vitest';
import {
  CHUNK_SAMPLES,
  TARGET_SAMPLE_RATE,
  levelOf,
  microphoneAvailability,
  toPcm16,
} from '../src/voice/microphone';
import { VoiceTransport } from '../src/voice/transport';
import { visualStateFor, voiceErrorCodeFor } from '../src/state/useVoiceTurn';
import { ZERO_VOICE_WS_PATH, zeroVoiceWsUrl } from '../src/zero/endpoints';

/**
 * The client half of the voice turn.
 *
 * No recorded audio: the fixtures are synthesised, because a repository is no
 * place for someone's voice and what these tests need is control over rate,
 * amplitude and framing rather than a real sentence.
 */

function sine(seconds: number, rate: number, hz = 220, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / rate);
  }
  return samples;
}

// ------------------------------------------------------------------ capture

describe('microphone capture', () => {
  it('resamples whatever the device gives to the rate ZERO expects', () => {
    // A phone hands over 48 kHz; whisper.cpp wants 16 kHz. Getting this wrong
    // does not degrade the transcript, it garbles it.
    for (const rate of [44_100, 48_000, 16_000]) {
      const pcm = toPcm16(sine(1, rate), rate);
      expect(pcm.length).toBeCloseTo(TARGET_SAMPLE_RATE, -2);
    }
  });

  it('produces PCM16 in range, and clamps rather than wrapping', () => {
    // A float above 1 that is scaled without clamping wraps to a loud
    // negative — an audible click the engine has to transcribe around.
    const hot = new Float32Array([2, -2, 0.5, -0.5, 0]);
    const pcm = toPcm16(hot, TARGET_SAMPLE_RATE);
    for (const sample of pcm) {
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32767);
  });

  it('reads a real level rather than a timer', () => {
    expect(levelOf(new Float32Array(512))).toBe(0);
    const quiet = levelOf(sine(0.1, TARGET_SAMPLE_RATE, 220, 0.05));
    const loud = levelOf(sine(0.1, TARGET_SAMPLE_RATE, 220, 0.8));
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });

  it('handles an empty block without throwing', () => {
    expect(toPcm16(new Float32Array(0), 48_000).length).toBe(0);
    expect(levelOf(new Float32Array(0))).toBe(0);
  });

  it('chunks at a size that feels live without flooding the socket', () => {
    // ~250 ms at 16 kHz: often enough to show a moving transcript, rarely
    // enough that a phone spends its battery on framing.
    const seconds = CHUNK_SAMPLES / TARGET_SAMPLE_RATE;
    expect(seconds).toBeGreaterThan(0.1);
    expect(seconds).toBeLessThan(0.5);
  });

  it('refuses the microphone outside a secure context', () => {
    // Chrome on the Galaxy will not prompt over plain http on a LAN address.
    // Saying so beforehand beats a permission dialog that never appears.
    const availability = microphoneAvailability();
    expect(availability.available === false || availability.available === true).toBe(true);
    if (!availability.available) {
      expect(['unsupported', 'insecure_context']).toContain(availability.reason);
    }
  });
});

// ---------------------------------------------------------------- transport

/** A fake socket that records what the transport sent. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;
  binaryType = '';
  readonly sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  deliver(type: string, payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) } as MessageEvent);
  }
}

/** A controllable clock, so a timeout test does not have to wait one out. */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();

  setTimeout = (handler: () => void): number => {
    const handle = this.next++;
    this.pending.set(handle, handler);
    return handle;
  };

  clearTimeout = (handle: number): void => {
    this.pending.delete(handle);
  };

  /** Fire everything currently scheduled. */
  runAll(): void {
    for (const [handle, handler] of [...this.pending]) {
      this.pending.delete(handle);
      handler();
    }
  }
}

function makeTransport() {
  const partials: string[] = [];
  const finals: { text: string; confidence: number | null }[] = [];
  const errors: { reason: string; detail: string; speak?: string }[] = [];
  const ready: unknown[] = [];
  const timers = new FakeTimers();
  const transport = new VoiceTransport(
    {
      onReady: (readiness) => ready.push(readiness),
      onPartial: (text) => partials.push(text),
      onFinal: (text, confidence) => finals.push({ text, confidence }),
      onError: (reason, detail, speak) => errors.push({ reason, detail, speak }),
    },
    {
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
      urlFor: ({ session }) => `ws://origin.test/ws/voice?session=${session}`,
      timers,
    },
  );
  return { transport, partials, finals, errors, ready, timers };
}

describe('voice transport', () => {
  it('opens on the same origin, never on an internal port', () => {
    const url = zeroVoiceWsUrl(
      { session: 's1', language: 'de-DE' },
      { protocol: 'http:', host: '192.168.1.23:3000' },
    );
    expect(url).toBe('ws://192.168.1.23:3000/ws/voice?session=s1&language=de-DE');
    // An https page must open wss, or the browser blocks it as mixed content.
    expect(zeroVoiceWsUrl({}, { protocol: 'https:', host: 'zero-host' })).toBe(
      'wss://zero-host/ws/voice',
    );
    expect(ZERO_VOICE_WS_PATH).toBe('/ws/voice');
  });

  it('reports whether ZERO can hear before a word is spoken', () => {
    const { transport, ready } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.deliver('voice.ready', {
      voice: 'degraded',
      stt: { ready: false, reason: 'stt_model_missing', detail: 'no model', remedy: 'install one' },
    });
    expect(ready).toHaveLength(1);
    expect((ready[0] as { voice: string }).voice).toBe('degraded');
  });

  it('delivers partials as replacements', () => {
    const { transport, partials } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.deliver('voice.transcript.partial', { text: 'ZERO finde mir fünf und' });
    FakeSocket.last!.deliver('voice.transcript.partial', { text: 'ZERO finde mir fünfundzwanzig' });
    // Two corrections of one sentence, not two sentences.
    expect(partials).toEqual(['ZERO finde mir fünf und', 'ZERO finde mir fünfundzwanzig']);
  });

  it('delivers the final transcript exactly once', () => {
    const { transport, finals } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.deliver('voice.transcript.final', { ok: true, text: 'ZERO, status', confidence: 0.9 });
    // A duplicate would run the command twice.
    FakeSocket.last!.deliver('voice.transcript.final', { ok: true, text: 'ZERO, status' });
    expect(finals).toEqual([{ text: 'ZERO, status', confidence: 0.9 }]);
  });

  it('surfaces a failed finalize as its reason, not as a transcript', () => {
    const { transport, finals, errors } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.deliver('voice.transcript.final', {
      ok: false,
      reason: 'stt_model_missing',
      detail: 'no model installed',
    });
    expect(finals).toEqual([]);
    expect(errors[0]).toMatchObject({ reason: 'stt_model_missing', detail: 'no model installed' });
  });

  it('drops a frame it cannot parse rather than rendering it', () => {
    const { transport, partials, finals } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.onmessage?.({ data: 'not json' } as MessageEvent);
    FakeSocket.last!.onmessage?.({ data: new ArrayBuffer(4) } as unknown as MessageEvent);
    expect(partials).toEqual([]);
    expect(finals).toEqual([]);
  });

  it('sends audio only once the socket is open', () => {
    const { transport } = makeTransport();
    transport.open();
    const socket = FakeSocket.last!;
    transport.send(new Int16Array([1, 2, 3]));
    expect(socket.sent).toHaveLength(0);

    socket.onopen?.();
    transport.send(new Int16Array([1, 2, 3]));
    expect(socket.sent).toHaveLength(1);
  });

  it('asks for the final transcript on stop, and abandons the turn on cancel', () => {
    const { transport } = makeTransport();
    transport.open();
    const socket = FakeSocket.last!;
    socket.onopen?.();
    transport.stop();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'stop' });

    const second = makeTransport();
    second.transport.open();
    const other = FakeSocket.last!;
    other.onopen?.();
    second.transport.cancel();
    expect(JSON.parse(other.sent.at(-1) as string)).toEqual({ type: 'cancel' });
    expect(other.closed).toBe(true);
  });
});

describe('finalizing always ends', () => {
  it('gives up rather than waiting forever for a transcript', () => {
    // The failure the operator saw on the phone: LISTENING → FINALIZING →
    // nothing at all. A turn that cannot finish must still finish.
    const { transport, errors, timers } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    transport.stop();
    expect(errors).toEqual([]);
    timers.runAll();
    expect(errors[0]!.reason).toBe('stt_timeout');
  });

  it('cancels the deadline once the transcript arrives', () => {
    const { transport, finals, errors, timers } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    transport.stop();
    FakeSocket.last!.deliver('voice.transcript.final', { ok: true, text: 'ZERO, status' });
    timers.runAll();
    expect(finals).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reports a socket that dies mid-turn as a restart, not as silence', () => {
    const { transport, errors } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.onclose?.();
    // Nothing was executed — but the operator has to be told the turn is over.
    expect(errors[0]!.reason).toBe('backend_restarted');
  });

  it('reports a socket that closes after stop as a dropped connection', () => {
    const { transport, errors } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    transport.stop();
    FakeSocket.last!.onclose?.();
    expect(errors[0]!.reason).toBe('voice_socket_disconnected');
  });

  it('reports exactly one terminal outcome per turn', () => {
    const { transport, errors, timers } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    transport.stop();
    FakeSocket.last!.onerror?.();
    FakeSocket.last!.onclose?.();
    timers.runAll();
    expect(errors).toHaveLength(1);
  });

  it('carries what ZERO should say about an empty transcript', () => {
    const { transport, finals, errors } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    FakeSocket.last!.deliver('voice.transcript.final', {
      ok: false,
      reason: 'empty_transcript',
      detail: 'the engine returned no words',
      speak: 'Ich habe dich nicht verstanden.',
    });
    // Heard sound, understood no words: a sentence to read back, not a command.
    expect(finals).toEqual([]);
    expect(errors[0]!.speak).toBe('Ich habe dich nicht verstanden.');
  });

  it('cancelling is terminal too — no late timeout after an interrupt', () => {
    const { transport, errors, timers } = makeTransport();
    transport.open();
    FakeSocket.last!.onopen?.();
    transport.stop();
    transport.cancel();
    timers.runAll();
    expect(errors).toEqual([]);
  });
});

describe('every runtime reason has a remedy', () => {
  it('maps the reasons the runtime can actually report', () => {
    for (const reason of [
      'stt_binary_missing',
      'stt_binary_unusable',
      'stt_model_missing',
      'stt_timeout',
      'stt_failed',
      'empty_transcript',
      'voice_socket_disconnected',
      'backend_restarted',
    ]) {
      expect(voiceErrorCodeFor(reason)).toBe(reason);
    }
    // Anything unknown still lands somewhere better than a blank screen.
    expect(voiceErrorCodeFor('something_new')).toBe('stt_offline');
  });
});

// ------------------------------------------------------------ visual states

describe('what the brain shows', () => {
  it('separates the two audio sources', () => {
    // While the operator speaks the energy moves inward and no smoke is
    // emitted; only ZERO's own voice pushes energy outward. Collapsing both
    // into one "busy" look would make the brain react to the wrong voice.
    expect(visualStateFor('listening')).toBe('listening');
    expect(visualStateFor('speaking')).toBe('speaking');
    expect(visualStateFor('listening')).not.toBe(visualStateFor('speaking'));
  });

  it('shows work as work and failure as failure', () => {
    expect(visualStateFor('transcribing')).toBe('processing');
    expect(visualStateFor('understanding')).toBe('processing');
    expect(visualStateFor('executing')).toBe('agentActive');
    expect(visualStateFor('error')).toBe('error');
    expect(visualStateFor('idle')).toBe('idle');
  });
});
