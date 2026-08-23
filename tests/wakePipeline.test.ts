import { describe, expect, it, vi } from 'vitest';
import { postUtterance } from '../src/zero/utterance';
import { WakeSession, type WakeTransportHandlers, type WakeTransportLike } from '../src/voice/wakeSession';
import type { MicrophoneHandlers } from '../src/voice/microphone';

/**
 * Where a hands-free instruction actually goes.
 *
 * The claim being tested is the one that matters most about this feature: a
 * wake word changes how a request is *started* and nothing at all about what
 * happens to it afterwards. Same endpoint, same conversation, same gates. If
 * that were untrue, "Hey ZERO" would be a way of talking past the permission
 * model rather than into it.
 */

const CHUNK = 4_096;
const LOUD = 0.3;
const QUIET = 0.001;

class Recorder implements WakeTransportLike {
  static last: Recorder | null = null;
  constructor(readonly handlers: WakeTransportHandlers) {
    Recorder.last = this;
  }
  open(): void {
    this.handlers.onReady({
      voice: 'ready',
      stt: { ready: true, reason: '', detail: '', remedy: '' },
    });
  }
  send(): void {}
  stop(): void {}
  cancel(): void {}
  close(): void {}
  reset(): void {}
}

/** A wake session wired to the real POST, with a fetch we can inspect. */
function handsFree(responder: (body: Record<string, unknown>) => unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const payload = responder(body);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;

  const outcomes: Awaited<ReturnType<typeof postUtterance>>[] = [];
  let mic: MicrophoneHandlers | null = null;
  const session = new WakeSession({
    subscribe: async (handlers) => {
      mic = handlers;
      return { sampleRate: 16_000, release: () => {} };
    },
    createTransport: (handlers) => new Recorder(handlers),
    // Exactly what the interface wires up: the turn's own delivery, which is
    // the same call typed input makes.
    deliver: async (text) => {
      outcomes.push(await postUtterance(text, { fetchImpl, inputType: 'voice' }));
    },
    config: { cooldownMs: 1, settleMs: 1, graceMs: 50 },
  });

  return {
    session,
    calls,
    outcomes,
    speak: (level: number, blocks: number) => {
      for (let i = 0; i < blocks; i += 1) {
        mic?.onLevel?.(level);
        mic?.onChunk(new Int16Array(CHUNK));
      }
    },
    transport: () => Recorder.last!,
  };
}

describe('a spoken instruction takes the ordinary path', () => {
  it('posts to the one endpoint typed input posts to', async () => {
    const h = handsFree(() => ({ speak: 'Zwei Agenten sind verfügbar.' }));
    await h.session.start();
    h.speak(LOUD, 3);
    h.transport().handlers.onPartial('hey zero welche Agenten sind verfügbar');
    h.speak(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, welche Agenten sind verfügbar?', 0.9);
    await vi.waitFor(() => expect(h.calls.length).toBe(1));

    expect(h.calls[0]!.url).toBe('/api/voice/transcript');
    expect(h.calls[0]!.body['text']).toBe('welche Agenten sind verfügbar?');
    expect(h.calls[0]!.body['input_type']).toBe('voice');
    // No session identifier anywhere: the runtime keeps one ZeroSession, and
    // the interface does not get to fork it.
    expect(Object.keys(h.calls[0]!.body)).toEqual(['text', 'input_type', 'confidence']);
  });

  it('keeps the thread across two hands-free turns', async () => {
    // "warum genau diesen?" only means anything if the second turn reaches the
    // same conversation as the first.
    const h = handsFree((body) =>
      String(body['text']).includes('warum')
        ? { speak: 'Weil der Lead-Scraper die Quelle bereits indexiert hat.' }
        : { speak: 'Der Autonomous Website Lead Scraper.' },
    );
    await h.session.start();

    h.speak(LOUD, 3);
    h.transport().handlers.onPartial('hey zero nenne den besten Lead-Agenten');
    h.speak(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, nenne den besten Lead-Agenten.', 0.9);
    await vi.waitFor(() => expect(h.outcomes.length).toBe(1));
    await vi.waitFor(() => expect(h.session.currentState).toBe('wake_listening'));

    h.speak(LOUD, 3);
    h.transport().handlers.onPartial('hey zero warum genau diesen');
    h.speak(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, warum genau diesen?', 0.9);
    await vi.waitFor(() => expect(h.outcomes.length).toBe(2));

    expect(h.calls[0]!.body['text']).toBe('nenne den besten Lead-Agenten.');
    expect(h.calls[1]!.body['text']).toBe('warum genau diesen?');
    // Same endpoint both times, no session key either time: continuity is the
    // runtime's, not something the wake layer invents per turn.
    expect(h.calls[0]!.url).toBe(h.calls[1]!.url);
    expect(h.outcomes[1]!.speak).toContain('Weil');
  });

  it('still hits the approval gate, because waking approves nothing', async () => {
    // The wake word means "I would like to speak to ZERO". It does not mean
    // "approve everything I am about to say".
    const h = handsFree(() => ({
      speak: 'Das braucht deine Freigabe. Nichts wurde gesendet.',
      awaiting_approval: true,
      executed: false,
    }));
    await h.session.start();
    h.speak(LOUD, 3);
    h.transport().handlers.onPartial('hey zero sende die vorbereitete Outreach Nachricht');
    h.speak(QUIET, 6);
    h.transport().handlers.onFinal('Hey ZERO, sende die vorbereitete Outreach-Nachricht.', 0.9);
    await vi.waitFor(() => expect(h.outcomes.length).toBe(1));

    expect(h.outcomes[0]!.awaitingApproval).toBe(true);
    expect(h.outcomes[0]!.executed).toBe(false);
    // Nothing in the wake layer can clear a gate: it has no path to one. The
    // only thing it ever sends is the sentence above.
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0]!.body)).not.toContain('approve');
  });
});

describe('the delivery call itself', () => {
  it('reports a refusal as a refusal rather than an answer', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'backend offline' }),
      }) as Response) as unknown as typeof fetch;
    const outcome = await postUtterance('status', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('backend offline');
    expect(outcome.speak).toBe('');
  });

  it('survives a response that is not JSON at all', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const outcome = await postUtterance('status', { fetchImpl });
    // A gateway error page must land as a stated failure, not as a crash.
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('502');
  });
});
