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
import { MicrophoneError } from '../voice/microphone';
import { subscribeMicrophone, type MicrophoneSubscription } from '../voice/microphoneOwner';
import { VoiceTransport, type VoiceReadiness } from '../voice/transport';
import { apiPath } from '../zero/endpoints';
import { postUtterance } from '../zero/utterance';
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
  | 'stt_binary_unusable'
  | 'stt_timeout'
  | 'stt_failed'
  | 'stt_offline'
  | 'empty_transcript'
  | 'voice_socket_disconnected'
  | 'backend_restarted'
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
  /**
   * Deliver a spoken transcript that was captured elsewhere — the hands-free
   * path. The same turn as a pressed button: same endpoint, same answer, same
   * TTS, same conversation. Awaited so the caller knows when ZERO is done.
   */
  submitVoice: (text: string) => Promise<void>;
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
  /**
   * Injected in tests. Defaults to the shared owner, which is what keeps wake
   * listening and a pressed-button turn on one device rather than two.
   */
  microphoneFactory?: typeof subscribeMicrophone;
}

const REMEDIES: Record<VoiceErrorCode, string> = {
  mic_permission_denied: 'Allow microphone access for this site, then press speak again.',
  mic_unavailable: 'No microphone was found on this device.',
  insecure_context:
    'Browsers only allow the microphone over https, or on the device itself. Type instead, or serve the gateway behind TLS.',
  stt_model_missing: 'No speech model is installed. Run scripts/zero-doctor.sh for the command.',
  stt_binary_missing: 'whisper.cpp is not installed on the ZERO host. Run scripts/zero-termux-one-shot.sh.',
  stt_binary_unusable:
    'whisper.cpp is present but will not run on this device. Rebuild it, or set ZERO_WHISPER_BIN.',
  stt_timeout: 'Speech recognition did not finish in time. A shorter utterance usually works.',
  stt_failed: 'The speech engine exited with an error. See .zero/logs/voice.log.',
  stt_offline: 'ZERO could not run speech recognition.',
  empty_transcript: 'Nothing was understood. Press speak and say it again.',
  voice_socket_disconnected: 'The voice connection dropped. Press speak to try again.',
  backend_restarted: 'The ZERO runtime restarted mid-turn. Nothing was executed. Press speak to try again.',
  audio_format_error: 'The captured audio could not be converted.',
  tts_offline: 'ZERO could not speak the answer. The text is above.',
  zero_refused: 'ZERO declined the request.',
};

const SERVER_CODES = new Set<string>([
  'stt_model_missing',
  'stt_binary_missing',
  'stt_binary_unusable',
  'stt_timeout',
  'stt_failed',
  'stt_offline',
  'empty_transcript',
  'voice_socket_disconnected',
  'backend_restarted',
]);

/**
 * The server's reason, as a code this interface has a remedy for.
 *
 * One place rather than three nested ternaries: every reason the runtime can
 * report has to land somewhere better than "voice failed".
 */
export function voiceErrorCodeFor(reason: string): VoiceErrorCode {
  return SERVER_CODES.has(reason) ? (reason as VoiceErrorCode) : 'stt_offline';
}

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

  const micRef = useRef<MicrophoneSubscription | null>(null);
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
      micRef.current?.release();
      transportRef.current?.close();
    };
  }, []);

  const closeMicrophone = useCallback(() => {
    // Release, not stop: wake listening may still be holding the same device,
    // and the owner closes it only when the last listener has gone.
    micRef.current?.release();
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
        const outcome = await postUtterance(text, { fetchImpl, inputType, confidence });
        if (!mounted.current) return;

        if (!outcome.ok) {
          setError(describe('zero_refused', outcome.error));
          setState('error');
          return;
        }

        setAnswer(outcome.speak);
        setAwaitingApproval(outcome.awaitingApproval);
        if (outcome.executed) setState('executing');

        if (outcome.speak && options.speak) {
          // Half-duplex: the microphone is already closed, and the server is
          // told too, so a phone speaker near the mic cannot loop.
          setState('speaking');
          await setServerSpeaking(true);
          try {
            await options.speak(outcome.speak);
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
          const code = voiceErrorCodeFor(readiness.stt?.reason ?? 'stt_offline');
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
        onError: (reason, detail, speak) => {
          closeMicrophone();
          const code = voiceErrorCodeFor(reason);
          if (code === 'empty_transcript') {
            // Heard sound, understood no words. That is a sentence to read
            // back, not a failure banner — and nothing was executed.
            setPartial('');
            setFinalTranscript('');
            setAnswer(speak || 'Ich habe dich nicht verstanden.');
            setError(null);
            setState('idle');
            return;
          }
          setError(describe(code, detail || reason));
          setState('error');
        },
      },
      { language: options.language },
    );
    transportRef.current = transport;
    transport.open();

    void (options.microphoneFactory ?? subscribeMicrophone)({
      onChunk: (pcm16) => transport.send(pcm16),
      onLevel: (level) => {
        levelRef.current = level;
      },
      onError: () => setError(describe('audio_format_error', 'the captured audio failed')),
    })
      .then((subscription) => {
        if (!mounted.current) {
          subscription.release();
          return;
        }
        micRef.current = subscription;
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

  const submitVoice = useCallback(
    (text: string) => deliver(text, 'voice', null),
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
    submitVoice,
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

/**
 * How the brain looks when hands-free is on.
 *
 * The turn is the louder fact: once ZERO is finalizing, thinking or speaking,
 * that is what the operator needs to see and the wake layer has nothing to
 * add. Wake only owns the two states the turn has no word for — waiting for
 * the phrase, and having just heard it.
 */
export function visualStateForWake(
  wake: WakeVisualState,
  turn: VoiceTurnState,
): ConversationVisualState {
  if (turn !== 'idle') return visualStateFor(turn);
  if (wake === 'wake_detected') return 'wakeDetected';
  if (wake === 'command') return 'listening';
  if (wake === 'wake_listening' || wake === 'paused') return 'wakeListening';
  if (wake === 'error') return 'error';
  return 'idle';
}

/** The wake states this mapping cares about. Kept loose to avoid a cycle. */
export type WakeVisualState =
  | 'off'
  | 'starting'
  | 'wake_listening'
  | 'wake_detected'
  | 'command'
  | 'finalizing'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error';
