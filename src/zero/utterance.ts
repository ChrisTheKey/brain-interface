/**
 * The one call that turns something said into something ZERO did.
 *
 * Typed text, a pressed-button turn and a hands-free "Hey ZERO" all arrive
 * here, and they all leave through the same POST. That is the whole point:
 * classification, memory, capabilities, approval gates and the audit trail
 * happen on the other side of this function, so no input route can reach
 * anything another route cannot. A wake word is a way of speaking to ZERO,
 * not a way around it.
 *
 * There is deliberately no session identifier. The runtime keeps one
 * ZeroSession, so "warum genau diesen?" resolves against the answer before it
 * without the interface having to carry the thread itself.
 */
import { apiPath } from './endpoints';

export type UtteranceInput = 'voice' | 'text';

export interface UtteranceOutcome {
  ok: boolean;
  /** What ZERO says back. The text the interface shows and TTS reads. */
  speak: string;
  /** The request hit a permission gate: planned, explained, and stopped. */
  awaitingApproval: boolean;
  /** A mission actually started. */
  executed: boolean;
  /** Set when ZERO refused or the call failed. */
  error: string;
  status: number;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  inputType?: UtteranceInput;
  confidence?: number | null;
}

export async function postUtterance(
  text: string,
  options: DeliverOptions = {},
): Promise<UtteranceOutcome> {
  const send = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const response = await send(apiPath('/voice/transcript'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      input_type: options.inputType ?? 'voice',
      confidence: options.confidence ?? 1,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    speak?: string;
    awaiting_approval?: boolean;
    executed?: boolean;
    error?: string;
  };
  return {
    ok: response.ok,
    speak: payload.speak ?? '',
    awaitingApproval: payload.awaiting_approval === true,
    executed: payload.executed === true,
    error: payload.error ?? (response.ok ? '' : `ZERO answered ${response.status}`),
    status: response.status,
  };
}
