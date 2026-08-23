import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VAD_CONFIG,
  PreRollBuffer,
  VoiceActivityDetector,
  preRollFor,
} from '../src/voice/vad';
import {
  WakeSession,
  type WakeErrorCode,
  type WakeState,
  type WakeTransportHandlers,
  type WakeTransportLike,
} from '../src/voice/wakeSession';
import type { MicrophoneHandlers } from '../src/voice/microphone';
import type { MicrophoneSubscription } from '../src/voice/microphoneOwner';

/**
 * Hands-free ZERO, driven by synthetic audio.
 *
 * There is no microphone in this container and none in CI, so nothing here
 * claims to have heard anything. What is tested is everything between the
 * samples and the pipeline: when a turn starts, when it ends without anyone
 * pressing a key, which text reaches ZERO, how many times it reaches it, and
 * what happens while ZERO is talking. The real microphone test happens on the
 * Galaxy and the ThinkPad.
 */

const SAMPLE_RATE = 16_000;
const CHUNK = 4_096; // ~256 ms, the size the real capture emits

/** A block of audio at a given loudness. The level is what the VAD reads. */
function block(level: number): { pcm: Int16Array; level: number } {
  return { pcm: new Int16Array(CHUNK), level };
}

const LOUD = 0.3;
const QUIET = 0.001;

// ------------------------------------------------------------------- the VAD

describe('knowing when someone stopped talking', () => {
  it('waits for speech to persist before calling it speech', () => {
    const vad = new VoiceActivityDetector({ ...DEFAULT_VAD_CONFIG, minSpeechMs: 200 });
    // One loud frame is a door, not a sentence.
    expect(vad.push({ level: LOUD, durationMs: 100 })).toBe(null);
    expect(vad.push({ level: LOUD, durationMs: 100 })).toBe('speech-start');
    expect(vad.isSpeaking).toBe(true);
  });

  it('survives a breath mid-sentence', () => {
    const vad = new VoiceActivityDetector({ ...DEFAULT_VAD_CONFIG, silenceMs: 1000 });
    vad.push({ level: LOUD, durationMs: 300 });
    expect(vad.isSpeaking).toBe(true);
    // Half a second of quiet is someone thinking, not someone finished.
    expect(vad.push({ level: QUIET, durationMs: 500 })).toBe(null);
    expect(vad.push({ level: LOUD, durationMs: 300 })).toBe(null);
    expect(vad.isSpeaking).toBe(true);
    // A full second is the end.
    expect(vad.push({ level: QUIET, durationMs: 1000 })).toBe('speech-end');
    expect(vad.isSpeaking).toBe(false);
  });

  it('ends a turn that never ends, exactly once', () => {
    const vad = new VoiceActivityDetector({ ...DEFAULT_VAD_CONFIG, maxTurnMs: 1000 });
    vad.push({ level: LOUD, durationMs: 300 });
    expect(vad.push({ level: LOUD, durationMs: 800 })).toBe('max-duration');
    // A microphone left open must be reported once, not on every frame after.
    expect(vad.push({ level: LOUD, durationMs: 300 })).toBe(null);
  });
});

describe('the pre-roll buffer', () => {
  it('keeps the last moment and nothing more', () => {
    const buffer = new PreRollBuffer(SAMPLE_RATE / 2); // 500 ms
    for (let i = 0; i < 10; i += 1) buffer.push(new Int16Array(CHUNK));
    // Bounded by construction: this runs forever, so it can never be the
    // thing that grows.
    expect(buffer.lengthMs).toBeLessThanOrEqual(600);
    const held = buffer.drain();
    expect(held.length).toBeGreaterThan(0);
    expect(buffer.lengthMs).toBe(0);
  });

  it('is sized in milliseconds, because that is how the delay is felt', () => {
    expect(preRollFor(600).lengthMs).toBe(0);
    const buffer = preRollFor(600);
    buffer.push(new Int16Array(SAMPLE_RATE)); // one second
    expect(buffer.lengthMs).toBeLessThanOrEqual(1000);
  });
});

// ------------------------------------------------------------- the harness

class FakeTransport implements WakeTransportLike {
  static all: FakeTransport[] = [];
  opened = false;
  closed = false;
  stopped = false;
  resets = 0;
  readonly sent: Int16Array[] = [];

  constructor(readonly handlers: WakeTransportHandlers) {
    FakeTransport.all.push(this);
  }

  open(): void {
    this.opened = true;
    this.handlers.onReady({
      voice: 'ready',
      stt: { ready: true, reason: '', detail: '', remedy: '' },
    });
  }
  send(pcm16: Int16Array): void {
    this.sent.push(pcm16);
  }
  stop(): void {
    this.stopped = true;
  }
  cancel(): void {
    this.closed = true;
  }
  close(): void {
    this.closed = true;
  }
  reset(): void {
    this.resets += 1;
  }
  get sentSamples(): number {
    return this.sent.reduce((total, chunk) => total + chunk.length, 0);
  }
}

interface Harness {
  session: WakeSession;
  states: WakeState[];
  delivered: string[];
  errors: { code: WakeErrorCode; detail: string }[];
  finals: string[];
  partials: string[];
  logs: string[];
  transport: () => FakeTransport;
  feed: (level: number, blocks: number) => void;
  runTimers: () => void;
  released: () => number;
}

function harness(options: { deliver?: (text: string) => Promise<void> } = {}): Harness {
  FakeTransport.all = [];
  const states: WakeState[] = [];
  const delivered: string[] = [];
  const errors: { code: WakeErrorCode; detail: string }[] = [];
  const finals: string[] = [];
  const partials: string[] = [];
  const logs: string[] = [];
  let released = 0;
  let clock = 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let micHandlers: MicrophoneHandlers | null = null;

  const session = new WakeSession({
    subscribe: async (handlers: MicrophoneHandlers): Promise<MicrophoneSubscription> => {
      micHandlers = handlers;
      return {
        sampleRate: SAMPLE_RATE,
        release: () => {
          released += 1;
        },
      };
    },
    createTransport: (handlers) => new FakeTransport(handlers),
    deliver:
      options.deliver ??
      (async (text: string) => {
        delivered.push(text);
      }),
    onState: (state) => states.push(state),
    onError: (code, detail) => errors.push({ code, detail }),
    onFinal: (text) => finals.push(text),
    onPartial: (text) => partials.push(text),
    onLog: (event) => logs.push(event),
    now: () => clock,
    setTimer: (handler, ms) => {
      const handle = nextTimer++;
      timers.set(handle, handler);
      void ms;
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    config: { cooldownMs: 10, settleMs: 10, graceMs: 100 },
  });

  return {
    session,
    states,
    delivered,
    errors,
    finals,
    partials,
    logs,
    transport: () => FakeTransport.all[FakeTransport.all.length - 1]!,
    feed: (level, blocks) => {
      for (let i = 0; i < blocks; i += 1) {
        clock += 256;
        micHandlers?.onLevel?.(level);
        micHandlers?.onChunk(block(level).pcm);
      }
    },
    runTimers: () => {
      for (const [handle, handler] of [...timers]) {
        timers.delete(handle);
        handler();
      }
    },
    released: () => released,
  };
}

// -------------------------------------------------------------- the flow

describe('hands-free, start to finish', () => {
  it('waits quietly until the phrase, then takes the whole instruction', async () => {
    // Case B: wake word and command in one breath.
    const h = harness();
    await h.session.start();
    expect(h.session.currentState).toBe('wake_listening');

    h.feed(QUIET, 4);
    // Nothing is sent while the room is quiet: passive listening costs no
    // inference at all.
    expect(h.transport().sentSamples).toBe(0);

    h.feed(LOUD, 4);
    expect(h.transport().sentSamples).toBeGreaterThan(0);
    // The pre-roll went first, so the engine hears the whole of "Hey", not
    // whatever was left after the detector made up its mind.
    expect(h.logs).toContain('wake_inference_window');

    h.transport().handlers.onPartial('hey zero, welche Agenten sind verfügbar');
    expect(h.session.currentState).toBe('command');

    h.feed(LOUD, 4);
    h.feed(QUIET, 6); // the operator stops talking
    expect(h.session.currentState).toBe('finalizing');
    // Nobody pressed anything.
    expect(h.transport().stopped).toBe(true);

    h.transport().handlers.onFinal('Hey ZERO, welche Agenten sind verfügbar?', 0.9);
    await vi.waitFor(() => expect(h.delivered.length).toBe(1));
    // The wake phrase is activation, not instruction.
    expect(h.delivered[0]).toBe('welche Agenten sind verfügbar?');
    expect(h.finals[0]).toBe('welche Agenten sind verfügbar?');
  });

  it('works when the phrase and the instruction are separate', async () => {
    // Case A: "Hey ZERO" … pause … "Welche Agenten sind verfügbar?"
    const h = harness();
    await h.session.start();

    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero');
    expect(h.session.currentState).toBe('command');
    h.feed(QUIET, 6); // the pause after the wake word

    // Still waiting: a pause after the wake word is not an empty command.
    expect(h.delivered).toEqual([]);

    h.feed(LOUD, 4);
    h.feed(QUIET, 6);
    h.transport().handlers.onFinal('Welche Agenten sind verfügbar?', 0.9);
    await vi.waitFor(() => expect(h.delivered.length).toBe(1));
    expect(h.delivered[0]).toBe('Welche Agenten sind verfügbar?');
  });

  it('sends the instruction exactly once', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero starte den Report');
    h.feed(QUIET, 6);

    const transport = h.transport();
    transport.handlers.onFinal('Hey ZERO, starte den Report.', 0.9);
    // A repeated final — a retry, a duplicated frame — must not run the
    // command twice. "Starte den Report" twice is two reports.
    transport.handlers.onFinal('Hey ZERO, starte den Report.', 0.9);
    await vi.waitFor(() => expect(h.delivered.length).toBe(1));
    expect(h.delivered).toEqual(['starte den Report.']);
  });

  it('goes back to listening on its own after answering', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero status');
    h.feed(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, Status.', 0.9);
    await vi.waitFor(() => expect(h.delivered.length).toBe(1));

    await vi.waitFor(() => expect(h.session.currentState).toBe('wake_listening'));
    expect(h.logs).toContain('wake_listener_resumed');
  });

  it('does not hear itself, and cannot wake itself', async () => {
    // The failure this prevents: ZERO's answer contains the words "Hey ZERO",
    // the microphone picks its own voice up, and it gives itself a command.
    const h = harness();
    await h.session.start();
    const before = h.transport();

    h.session.setSpeaking(true);
    expect(h.session.currentState).toBe('speaking');
    h.feed(LOUD, 10);
    // Not one sample of ZERO's own voice reached the socket, so the detector
    // was never even given the chance to match.
    expect(before.sentSamples).toBe(0);

    h.session.setSpeaking(false);
    expect(h.session.currentState).toBe('paused');
    h.runTimers(); // the cooldown
    expect(h.session.currentState).toBe('wake_listening');
  });

  it('does not wake on its own answer, even if it says the phrase', async () => {
    // ZERO explaining "say Hey ZERO to start" must not thereby start.
    const h = harness();
    await h.session.start();
    const transport = h.transport();

    h.session.setSpeaking(true);
    // A frame that was already in flight when TTS began, carrying the phrase.
    transport.handlers.onPartial('sag einfach hey zero und dann deine Anweisung');
    expect(h.session.currentState).toBe('speaking');
    expect(h.delivered).toEqual([]);

    h.session.setSpeaking(false);
    // Still not woken during the cooldown either.
    transport.handlers.onPartial('hey zero');
    expect(h.session.currentState).toBe('paused');

    h.runTimers();
    expect(h.session.currentState).toBe('wake_listening');
    expect(h.session.diagnostics().wakeCount).toBe(0);
  });

  it('clears the buffer for speech that was not addressed to it', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 4);
    h.transport().handlers.onPartial('das Wetter ist heute ganz gut');
    expect(h.session.currentState).toBe('wake_listening');

    h.feed(QUIET, 6);
    h.runTimers(); // the settle delay expires without a match
    // Otherwise the room's conversation accumulates until the engine is
    // transcribing minutes of history to look for two words.
    expect(h.transport().resets).toBeGreaterThan(0);
  });

  it('waits for a late match rather than clearing it away', async () => {
    // The partial that would have matched can still be in flight when the
    // sentence ends. Losing that race means saying "Hey ZERO" and being
    // ignored.
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.feed(QUIET, 6);
    expect(h.transport().resets).toBe(0);
    h.transport().handlers.onPartial('hey zero');
    expect(h.session.currentState).toBe('command');
    h.runTimers();
    expect(h.transport().resets).toBe(0);
  });

  it('gives up on an accidental wake instead of listening forever', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero');
    expect(h.session.currentState).toBe('command');

    h.runTimers(); // the grace period passes with nothing said
    expect(h.errors.map((error) => error.code)).toContain('wake_timeout');
    expect(h.session.currentState).toBe('wake_listening');
    expect(h.session.diagnostics().falseActivationCount).toBe(1);
  });

  it('shows the live transcript as the instruction, not as the phrase', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero welche');
    h.transport().handlers.onPartial('hey zero welche Agenten');
    // What the operator reads back is what ZERO will act on.
    expect(h.partials).toEqual(['welche', 'welche Agenten']);
  });

  it('keeps one socket and one microphone across a whole exchange', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero status');
    h.feed(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, Status.', 0.9);
    await vi.waitFor(() => expect(h.session.currentState).toBe('wake_listening'));

    // A new socket per exchange is fine; two at once is not.
    const open = FakeTransport.all.filter((transport) => transport.opened && !transport.closed);
    expect(open).toHaveLength(1);
    // The device was never handed back mid-conversation.
    expect(h.released()).toBe(0);

    h.session.stop();
    expect(h.released()).toBe(1);
    expect(FakeTransport.all.every((transport) => transport.closed)).toBe(true);
  });

  it('recovers when the runtime restarts underneath it', async () => {
    const h = harness();
    await h.session.start();
    const first = h.transport();
    first.handlers.onError('backend_restarted', 'the runtime closed the socket');
    // The interface stays up and listening resumes on a clean socket rather
    // than a second listener being stacked on the first.
    expect(h.session.currentState).toBe('wake_listening');
    expect(FakeTransport.all.filter((t) => t.opened && !t.closed)).toHaveLength(1);
  });

  it('treats an empty transcript as nothing said, not as a command', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero');
    h.feed(QUIET, 6);
    h.transport().handlers.onError('empty_transcript', 'the engine returned no words');
    expect(h.delivered).toEqual([]);
    expect(h.session.currentState).toBe('wake_listening');
  });
});

// -------------------------------------------------------------- the limits

describe('what waking does not grant', () => {
  it('routes through the same pipeline a typed request uses', async () => {
    const seen: string[] = [];
    const h = harness({
      deliver: async (text) => {
        seen.push(text);
      },
    });
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero sende die Nachricht');
    h.feed(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, sende die vorbereitete Outreach-Nachricht.', 0.9);
    await vi.waitFor(() => expect(seen.length).toBe(1));

    // The wake word means "I would like to speak to ZERO". It does not mean
    // "approve everything". This session has no way to reach an agent, a
    // capability or an approval — it hands text to the one endpoint that
    // classifies and gates it, exactly as the keyboard does.
    expect(seen[0]).toBe('sende die vorbereitete Outreach-Nachricht.');
  });

  it('reports what it can and cannot do, without inventing readiness', async () => {
    const h = harness();
    expect(h.session.diagnostics().status).toBe('OFFLINE');
    await h.session.start();
    const diagnostics = h.session.diagnostics();
    expect(diagnostics.status).toBe('READY');
    expect(diagnostics.phrase).toBe('hey zero');
    expect(diagnostics.microphone).toBe('READY');
    expect(diagnostics.provider).toContain('local');
    expect(diagnostics.lastWakeAt).toBe(null);

    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero');
    expect(h.session.diagnostics().wakeCount).toBe(1);
    expect(h.session.diagnostics().lastWakeAt).not.toBe(null);
  });

  it('says the microphone was refused rather than pretending to listen', async () => {
    const denied = Object.assign(new Error('microphone permission was denied'), {
      reason: 'permission_denied',
    });
    const session = new WakeSession({
      subscribe: () => Promise.reject(denied),
      createTransport: (handlers) => new FakeTransport(handlers),
      deliver: async () => {},
      onError: (code) => {
        codes.push(code);
      },
    });
    const codes: WakeErrorCode[] = [];
    await session.start();
    expect(codes).toContain('microphone_denied');
    expect(session.currentState).toBe('error');
    expect(session.diagnostics().microphone).toBe('BLOCKED');
  });

  it('logs what happened and never what was said', async () => {
    const h = harness();
    await h.session.start();
    h.feed(LOUD, 3);
    h.transport().handlers.onPartial('hey zero, mein Passwort lautet Hunter2');
    h.feed(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, mein Passwort lautet Hunter2.', 0.9);
    await vi.waitFor(() => expect(h.delivered.length).toBe(1));

    const written = h.logs.join(' ');
    expect(written).toContain('wake_detected');
    expect(written).toContain('command_finalized');
    // A wake listener that logs what it heard is a recording of the room.
    expect(written).not.toContain('Passwort');
    expect(written).not.toContain('Hunter2');
  });
});
