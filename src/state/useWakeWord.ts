/**
 * "Hey ZERO", as something the interface can switch on.
 *
 * A thin wrapper: every decision lives in `WakeSession`, which is a plain
 * class precisely so the state machine can be driven by synthetic audio in a
 * test rather than only by a person talking at a laptop. This file exists to
 * hold one instance, mirror its state into React, and hand delivery back to
 * the same turn a pressed button would have used.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceTransport } from '../voice/transport';
import { subscribeMicrophone } from '../voice/microphoneOwner';
import {
  WakeSession,
  type WakeDiagnostics,
  type WakeErrorCode,
  type WakeLogEvent,
  type WakeState,
} from '../voice/wakeSession';
import { wakeConfigFrom } from '../voice/wakeWord';

/** Remembered per browser, so the choice survives a reload. Never a secret. */
const PREFERENCE_KEY = 'zero.wakeWord.enabled';

export interface WakeWordApi {
  /** Is hands-free switched on at all? */
  enabled: boolean;
  state: WakeState;
  /** Live transcript of the instruction, with the phrase already removed. */
  partial: string;
  error: { code: WakeErrorCode; detail: string } | null;
  diagnostics: WakeDiagnostics | null;
  toggle: () => void;
  enable: () => void;
  disable: () => void;
}

export interface WakeWordOptions {
  /** The canonical pipeline — the same call typed input makes. */
  deliver: (text: string) => Promise<void>;
  /** True while ZERO is speaking, so the microphone stops feeding the engine. */
  speaking: boolean;
  language?: string;
  /** Injected in tests. */
  sessionFactory?: (deliver: (text: string) => Promise<void>) => WakeSession;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  onLog?: (event: WakeLogEvent, detail?: Record<string, number | string>) => void;
}

function readPreference(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    return store?.getItem(PREFERENCE_KEY) === 'true';
  } catch {
    // A private window, or site data switched off. Off is the safe answer.
    return false;
  }
}

export function useWakeWord(options: WakeWordOptions): WakeWordApi {
  const [enabled, setEnabled] = useState(() => readPreference(options.storage));
  const [state, setState] = useState<WakeState>('off');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<{ code: WakeErrorCode; detail: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<WakeDiagnostics | null>(null);
  const sessionRef = useRef<WakeSession | null>(null);

  const wake = useMemo(
    () => wakeConfigFrom(import.meta.env as unknown as Record<string, string | undefined>),
    [],
  );

  // The deliver callback changes identity on most renders; a ref keeps the
  // session from being torn down and rebuilt underneath a live conversation.
  // Updated in an effect rather than during render — a ref written while
  // rendering is a value React is entitled to throw away.
  const deliverRef = useRef(options.deliver);
  const logRef = useRef(options.onLog);
  const deliver = options.deliver;
  const onLog = options.onLog;
  useEffect(() => {
    deliverRef.current = deliver;
    logRef.current = onLog;
  }, [deliver, onLog]);
  const factory = options.sessionFactory;
  const language = options.language;

  useEffect(() => {
    if (!enabled) return undefined;
    const session =
      factory?.((text) => deliverRef.current(text)) ??
      new WakeSession({
        subscribe: subscribeMicrophone,
        createTransport: (handlers) => new VoiceTransport(handlers, { language }),
        deliver: (text) => deliverRef.current(text),
        onState: setState,
        onPartial: setPartial,
        onError: (code, detail) => setError({ code, detail }),
        onLog: (event, detail) => logRef.current?.(event, detail),
        config: { wake },
      });
    sessionRef.current = session;
    void session.start();

    // Diagnostics are polled rather than pushed: they are a panel someone
    // opens occasionally, not something worth a re-render per audio frame.
    const timer = window.setInterval(() => setDiagnostics(session.diagnostics()), 1000);
    return () => {
      window.clearInterval(timer);
      session.stop();
      sessionRef.current = null;
      setState('off');
      setPartial('');
    };
  }, [enabled, factory, language, wake]);

  // Half-duplex, and the reason is not politeness: with the microphone live
  // while ZERO talks, an answer containing the words "Hey ZERO" wakes it.
  useEffect(() => {
    sessionRef.current?.setSpeaking(options.speaking);
  }, [options.speaking]);

  const persist = useCallback(
    (next: boolean) => {
      setEnabled(next);
      // Switching it on is a fresh attempt: the last refusal is not this one.
      if (next) setError(null);
      try {
        const store = options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
        store?.setItem(PREFERENCE_KEY, String(next));
      } catch {
        /* the choice still applies to this session */
      }
    },
    [options.storage],
  );

  return {
    enabled,
    state,
    partial,
    error,
    diagnostics,
    toggle: () => persist(!enabled),
    enable: () => persist(true),
    disable: () => persist(false),
  };
}

/** What the operator is told, per wake state. Short, and never a spinner. */
export function wakeLabelFor(enabled: boolean, state: WakeState): string {
  if (!enabled) return 'HEY ZERO · OFF';
  switch (state) {
    case 'starting':
      return 'HEY ZERO · STARTING';
    case 'wake_listening':
      return 'HEY ZERO · LISTENING';
    case 'wake_detected':
      return 'HEY ZERO · DETECTED';
    case 'command':
      return 'LISTENING';
    case 'finalizing':
      return 'FINALIZING';
    case 'thinking':
      return 'UNDERSTANDING…';
    case 'speaking':
      return 'ZERO SPEAKING';
    case 'paused':
      return 'HEY ZERO · PAUSED';
    case 'error':
      return 'HEY ZERO · OFFLINE';
    default:
      return 'HEY ZERO · OFF';
  }
}
