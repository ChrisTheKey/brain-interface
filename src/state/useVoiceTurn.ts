/**
 * One spoken turn, start to finish.
 *
 *   press → LISTENING → live partials → release → FINALIZING →
 *   UNDERSTANDING → (EXECUTING) → SPEAKING → idle
 *
 * Two rules the hook exists to keep.
 *
 * **Only a final transcript acts.** Partials are shown and replaced; they
 * never reach ZERO. A sentence still being revised is not an instruction.
 *
 * **ZERO does not hear itself.** The microphone is closed before ZERO speaks
 * and the server is told to pause ingestion, so its own answer cannot become
 * the next command. Pressing speak while it talks interrupts rather than
 * layering a second voice over the first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MicrophoneError, openMicrophone, type MicrophoneStream } from '../voice/microphone';
import { VoiceTransport, type VoiceReadiness } from '../voice/transport';
import { apiPath } from '../zero/endpoints';
import type { ConversationVisualState } from '../render/brainRenderer';

/** What the operator sees. Each one is a real state, not a spinner. */
export type VoiceTurnState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'understanding'
  | 'executing'
  | 'speaking'
  | 'error';

/** A specific failure, so the interface never has to say "voice failed". */
export type VoiceErrorCode =
  | 'mic_permission_denied'
  | 'mic_unavailable'
  | 'insecure_context'
  | 'stt_model_missing'
  | 'stt_binary_missing'
  | 'stt_offline'
  | 'voice_socket_disconnected'
  | 'audio_format_error'
  | 'tts_offline'
  | 'zero_refused';

export interface VoiceTurnError {
  code: VoiceErrorCode;
  message: string;
  remedy: string;
}

export interface VoiceTurnApi {
  state: VoiceTurnState;
  /** Live, still being corrected. Rendered dimmer than a final transcript. */
  partial: string;
  /** The last transcript ZERO actually received. Stays visible. */
  finalTranscript: string;
  /** ZERO's answer to it. Stays visible next to the transcript. */
  answer: string;
  /** Set when the turn hit a permission gate: nothing external happened. */
  awaitingApproval: boolean;
  error: VoiceTurnError | null;
  /** Real microphone amplitude, 0..1. Zero while the microphone is closed. */
  micLevel: () => number;
  listening: boolean;
  start: () => void;
  stop: () => void;
  /** Interrupt: stop ZERO speaking and drop the turn. */
  interrupt: () => void;
  /** Send typed text down the identical pipeline. */
  submitText: (text: string) => void;
}

export interface VoiceTurnOptions {
  language?: string;
  /** Speak ZERO's answer. Returns when the audio has finished. */
  speak?: (text: string) => Promise<void>;
  stopSpeaking?: () => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  transportFactory?: (
    handlers: ConstructorParameters<typeof VoiceTransport>[0],
    options: ConstructorParameters<typeof VoiceTransport>[1],
  ) => VoiceTransport;
  microphoneFactory?: typeof openMicrophone;
}

const REMEDIES: Record<VoiceErrorCode, string> = {
  mic_permission_denied: 'Allow microphone access for this site, then press speak again.',
  mic_unavailable: 'No microphone was found on this device.',
  insecure_context:
    'Browsers only allow the microphone over https, or on the device itself. Type instead, or serve the gateway behind TLS.',
  stt_model_missing: 'No speech model is installed. See VOICE diagnostics for the command.',
  stt_binary_missing: 'whisper.cpp is not installed on the ZERO host.',
  stt_offline: 'ZERO could not run speech recognition.',
  voice_socket_disconnected: 'The voice connection dropped. Press speak to try again.',
  audio_format_error: 'The captured audio could not be converted.',
  tts_offline: 'ZERO could not speak the answer. The text is above.',
  zero_refused: 'ZERO declined the request.',
};

function describe(code: VoiceErrorCode, message: string): VoiceTurnError {
  return { code, message, remedy: REMEDIES[code] };
}

export function useVoiceTurn(options: VoiceTurnOptions = {}): VoiceTurnApi {
  const [state, setState] = useState<VoiceTurnState>('idle');
  const [partial, setPartial] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [answer, setAnswer] = useState('');
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [error, setError] = useState<VoiceTurnError | null>(null);

  const micRef = useRef<MicrophoneStream | null>(null);
  const transportRef = useRef<VoiceTransport | null>(null);
  const levelRef = useRef(0);
  const mounted = useRef(true);

  // Stable across renders: an inline fallback would be a new function every
  // time and would re-create every callback that depends on it.
  const injected = options.fetchImpl;
  const fetchImpl = useMemo(
    () => injected ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    [injected],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      micRef.current?.stop();
      transportRef.current?.close();
    };
  }, []);

  const closeMicrophone = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    levelRef.current = 0;
  }, []);

  /** Tell the server whether ZERO is speaking, so it can drop its own audio. */
  const setServerSpeaking = useCallback(
    async (speaking: boolean) => {
      try {
        await fetchImpl(apiPath('/voice/speaking'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speaking }),
        });
      } catch {
        // The client already closed the microphone; this is the second lock.
      }
    },
    [fetchImpl],
  );

  /**
   * The one path a request takes — spoken or typed.
   *
   * Both call this, so classification, gates and audit are identical and voice
   * cannot reach anything text cannot.
   */
  const deliver = useCallback(
    async (text: string, inputType: 'voice' | 'text', confidence: number | null) => {
      if (!text.trim()) return;
      setState('understanding');
      setFinalTranscript(text);
      setPartial('');
      setAwaitingApproval(false);
      try {
        const response = await fetchImpl(apiPath('/voice/transcript'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, input_type: inputType, confidence: confidence ?? 1 }),
        });
        const payload = (await response.json()) as {
          speak?: string;
          awaiting_approval?: boolean;
          executed?: boolean;
          error?: string;
        };
        if (!mounted.current) return;

        if (!response.ok) {
          setError(describe('zero_refused', payload.error ?? `ZERO answered ${response.status}`));
          setState('error');
          return;
        }

        setAnswer(payload.speak ?? '');
        setAwaitingApproval(payload.awaiting_approval === true);
        if (payload.executed) setState('executing');

        if (payload.speak && options.speak) {
          // Half-duplex: the microphone is already closed, and the server is
          // told too, so a phone speaker near the mic cannot loop.
          setState('speaking');
          await setServerSpeaking(true);
          try {
            await options.speak(payload.speak);
          } catch {
            if (mounted.current) setError(describe('tts_offline', 'speech output failed'));
          } finally {
            await setServerSpeaking(false);
          }
        }
        if (mounted.current) setState('idle');
      } catch (cause) {
        if (!mounted.current) return;
        setError(describe('zero_refused', String(cause)));
        setState('error');
      }
    },
    [fetchImpl, options, setServerSpeaking],
  );

  const start = useCallback(() => {
    if (state === 'listening') return;
    // Pressing speak while ZERO talks interrupts it rather than talking over it.
    if (state === 'speaking') options.stopSpeaking?.();

    setError(null);
    setPartial('');
    setAwaitingApproval(false);

    const transport = (options.transportFactory ?? ((h, o) => new VoiceTransport(h, o)))(
      {
        onReady: (readiness: VoiceReadiness) => {
          if (readiness.voice === 'ready') return;
          const reason = readiness.stt?.reason ?? 'stt_offline';
          const code: VoiceErrorCode =
            reason === 'stt_model_missing'
              ? 'stt_model_missing'
              : reason === 'stt_binary_missing'
                ? 'stt_binary_missing'
                : 'stt_offline';
          // Told before a word is spoken, rather than after a turn that could
          // never have worked.
          setError({
            code,
            message: readiness.stt?.detail ?? 'speech recognition is unavailable',
            remedy: readiness.stt?.remedy || REMEDIES[code],
          });
          setState('error');
          closeMicrophone();
          transportRef.current?.close();
        },
        onPartial: (text) => {
          // Replace. A partial corrects itself — "fünf und zwanzig" becomes
          // "fünfundzwanzig" — and appending would render both.
          setPartial(text);
          setState('listening');
        },
        onFinal: (text, confidence) => {
          closeMicrophone();
          setState('transcribing');
          void deliver(text, 'voice', confidence);
        },
        onError: (reason, detail) => {
          const code: VoiceErrorCode =
            reason === 'stt_model_missing'
              ? 'stt_model_missing'
              : reason === 'stt_binary_missing'
                ? 'stt_binary_missing'
                : reason === 'voice_socket_disconnected'
                  ? 'voice_socket_disconnected'
                  : 'stt_offline';
          setError(describe(code, detail || reason));
          setState('error');
          closeMicrophone();
        },
      },
      { language: options.language },
    );
    transportRef.current = transport;
    transport.open();

    void (options.microphoneFactory ?? openMicrophone)({
      onChunk: (pcm16) => transport.send(pcm16),
      onLevel: (level) => {
        levelRef.current = level;
      },
      onError: () => setError(describe('audio_format_error', 'the captured audio failed')),
    })
      .then((stream) => {
        if (!mounted.current) {
          stream.stop();
          return;
        }
        micRef.current = stream;
        setState('listening');
      })
      .catch((cause: unknown) => {
        transport.close();
        if (!mounted.current) return;
        const reason = cause instanceof MicrophoneError ? cause.reason : 'audio_error';
        const code: VoiceErrorCode =
          reason === 'permission_denied'
            ? 'mic_permission_denied'
            : reason === 'insecure_context'
              ? 'insecure_context'
              : reason === 'no_microphone'
                ? 'mic_unavailable'
                : 'audio_format_error';
        setError(describe(code, cause instanceof Error ? cause.message : String(cause)));
        setState('error');
      });
  }, [closeMicrophone, deliver, options, state]);

  const stop = useCallback(() => {
    // The microphone closes first: nothing captured after release belongs to
    // this utterance.
    closeMicrophone();
    if (transportRef.current) {
      setState('transcribing');
      transportRef.current.stop();
    } else if (state === 'listening') {
      setState('idle');
    }
  }, [closeMicrophone, state]);

  const interrupt = useCallback(() => {
    options.stopSpeaking?.();
    void setServerSpeaking(false);
    closeMicrophone();
    transportRef.current?.cancel();
    transportRef.current = null;
    setPartial('');
    setState('idle');
  }, [closeMicrophone, options, setServerSpeaking]);

  const submitText = useCallback(
    (text: string) => {
      void deliver(text, 'text', null);
    },
    [deliver],
  );

  return {
    state,
    partial,
    finalTranscript,
    answer,
    awaitingApproval,
    error,
    micLevel: () => levelRef.current,
    listening: state === 'listening',
    start,
    stop,
    interrupt,
    submitText,
  };
}

/**
 * How a voice state looks on the brain.
 *
 * The two audio sources must never be confused: while the operator speaks the
 * energy moves *inward* and no smoke is emitted, and only when ZERO speaks does
 * energy move outward. Collapsing both into one "busy" look would make the
 * brain react to the wrong voice.
 */
export function visualStateFor(state: VoiceTurnState): ConversationVisualState {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'transcribing':
    case 'understanding':
      return 'processing';
    case 'executing':
      return 'agentActive';
    case 'speaking':
      return 'speaking';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}
