/**
 * Hands-free ZERO: the layer that turns "Hey ZERO" into an ordinary turn.
 *
 * The important thing about this file is what it does *not* do. It runs no
 * recognition of its own, holds no conversation, decides no permissions and
 * knows nothing about agents. It listens for one phrase and then gets out of
 * the way, handing the audio to the same `/ws/voice` socket and the same
 * `/api/voice/transcript` endpoint a pressed button would have used. Wake is
 * an activation layer, not a second ZERO.
 *
 * The one design decision worth stating: **wake and command are the same
 * socket and the same utterance.** Detection happens on a partial transcript
 * while the audio keeps flowing into the buffer it came from, so
 * "Hey ZERO, welche Agenten sind verfügbar?" arrives at the engine whole and
 * the phrase is taken off the front afterwards. Switching sockets on detection
 * would mean replaying whatever had already been said into a new one, and
 * whatever the replay missed would be the first words of the instruction.
 *
 * Everything here is injected — microphone, transport, clock, delivery — so
 * the whole state machine can be driven by synthetic audio in a test. There is
 * no microphone in CI and there is none in the container this was written in.
 */
import { CHUNK_SAMPLES, TARGET_SAMPLE_RATE } from './microphone';
import type { MicrophoneError, MicrophoneHandlers } from './microphone';
import type { MicrophoneSubscription } from './microphoneOwner';
import {
  DEFAULT_VAD_CONFIG,
  VoiceActivityDetector,
  preRollFor,
  type PreRollBuffer,
  type VadConfig,
} from './vad';
import {
  DEFAULT_WAKE_CONFIG,
  matchWakePhrase,
  stripWakePhrase,
  type WakeConfig,
} from './wakeWord';
import type { VoiceReadiness } from './transport';

/** Where the operator is in a hands-free exchange. */
export type WakeState =
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

export type WakeErrorCode =
  | 'wake_provider_missing'
  | 'wake_provider_unusable'
  | 'microphone_denied'
  | 'microphone_lost'
  | 'vad_unavailable'
  | 'stt_unavailable'
  | 'wake_timeout'
  | 'voice_socket_disconnected'
  | 'backend_offline';

/** Only ever metadata. Never a word that was spoken. */
export type WakeLogEvent =
  | 'wake_listener_started'
  | 'speech_segment_detected'
  | 'wake_inference_window'
  | 'wake_detected'
  | 'command_capture_started'
  | 'command_finalized'
  | 'wake_listener_resumed'
  | 'wake_listener_stopped'
  | 'wake_timeout'
  | 'wake_error';

/** The slice of `VoiceTransport` this needs. Duck-typed so tests can stand in. */
export interface WakeTransportLike {
  open: () => void;
  send: (pcm16: Int16Array) => void;
  stop: () => void;
  cancel: () => void;
  close: () => void;
  /** Clear the server's utterance buffer without ending the session. */
  reset?: () => void;
}

export interface WakeTransportHandlers {
  onReady: (readiness: VoiceReadiness) => void;
  onPartial: (text: string) => void;
  onFinal: (text: string, confidence: number | null) => void;
  onError: (reason: string, detail: string, speak?: string) => void;
}

export interface WakeSessionConfig {
  wake: WakeConfig;
  vad: VadConfig;
  /** Audio kept before speech is declared, so the first syllable survives. */
  preRollMs: number;
  /** How long to wait for a partial after a segment ends, before resetting. */
  settleMs: number;
  /** After a bare "Hey ZERO", how long to wait for the instruction. */
  graceMs: number;
  /** Hard ceiling on one spoken command. */
  maxCommandMs: number;
  /** Quiet gap after ZERO stops speaking, before it listens again. */
  cooldownMs: number;
  /** Fewer wake inferences per minute; the command itself is untouched. */
  batterySaver: boolean;
}

export const DEFAULT_WAKE_SESSION_CONFIG: WakeSessionConfig = {
  wake: DEFAULT_WAKE_CONFIG,
  vad: DEFAULT_VAD_CONFIG,
  preRollMs: 600,
  settleMs: 1800,
  graceMs: 7000,
  maxCommandMs: 45_000,
  // Long enough for a phone speaker to stop ringing, short enough that the
  // next thing said is still heard.
  cooldownMs: 600,
  batterySaver: false,
};

export interface WakeSessionDeps {
  subscribe: (handlers: MicrophoneHandlers) => Promise<MicrophoneSubscription>;
  createTransport: (handlers: WakeTransportHandlers) => WakeTransportLike;
  /** The canonical pipeline. The same call a typed request makes. */
  deliver: (text: string) => Promise<void>;
  onState?: (state: WakeState) => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (code: WakeErrorCode, detail: string) => void;
  onLog?: (event: WakeLogEvent, detail?: Record<string, number | string>) => void;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  config?: Partial<WakeSessionConfig>;
}

export interface WakeDiagnostics {
  state: WakeState;
  phrase: string;
  provider: string;
  status: 'READY' | 'DEGRADED' | 'OFFLINE';
  microphone: 'READY' | 'BLOCKED' | 'CLOSED';
  vad: 'READY' | 'OFFLINE';
  stt: 'READY' | 'DEGRADED' | 'OFFLINE';
  lastWakeAt: number | null;
  wakeCount: number;
  falseActivationCount: number;
  batterySaver: boolean;
}

const MS_PER_SAMPLE = 1000 / TARGET_SAMPLE_RATE;

export class WakeSession {
  private readonly config: WakeSessionConfig;
  private readonly deps: Required<
    Pick<WakeSessionDeps, 'subscribe' | 'createTransport' | 'deliver'>
  > &
    WakeSessionDeps;

  private state: WakeState = 'off';
  private phase: 'wake' | 'command' = 'wake';
  private transport: WakeTransportLike | null = null;
  private subscription: MicrophoneSubscription | null = null;
  private vad: VoiceActivityDetector;
  private preRoll: PreRollBuffer;

  private lastLevel = 0;
  private sending = false;
  private speaking = false;
  private delivered = false;
  private carried = '';
  private settleTimer: number | null = null;
  private graceTimer: number | null = null;
  private cooldownTimer: number | null = null;
  private commandStartedAt = 0;

  private sttStatus: 'READY' | 'DEGRADED' | 'OFFLINE' = 'OFFLINE';
  private microphoneStatus: 'READY' | 'BLOCKED' | 'CLOSED' = 'CLOSED';
  private lastWakeAt: number | null = null;
  private wakeCount = 0;
  private falseActivationCount = 0;

  constructor(deps: WakeSessionDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_WAKE_SESSION_CONFIG, ...deps.config };
    const vadConfig = this.config.batterySaver
      ? { ...this.config.vad, minSpeechMs: this.config.vad.minSpeechMs * 1.5 }
      : this.config.vad;
    this.vad = new VoiceActivityDetector({ ...vadConfig, maxTurnMs: this.config.maxCommandMs });
    this.preRoll = preRollFor(this.config.preRollMs);
  }

  // ------------------------------------------------------------------ state

  get currentState(): WakeState {
    return this.state;
  }

  get listening(): boolean {
    return this.state === 'wake_listening';
  }

  diagnostics(): WakeDiagnostics {
    return {
      state: this.state,
      phrase: this.config.wake.phrase,
      // The wake "provider" is whisper.cpp reached through the existing voice
      // socket — named honestly rather than dressed up as a keyword spotter.
      provider: 'whisper.cpp via /ws/voice (local)',
      status:
        this.state === 'off'
          ? 'OFFLINE'
          : this.sttStatus === 'READY'
            ? 'READY'
            : this.sttStatus,
      microphone: this.microphoneStatus,
      vad: 'READY',
      stt: this.sttStatus,
      lastWakeAt: this.lastWakeAt,
      wakeCount: this.wakeCount,
      falseActivationCount: this.falseActivationCount,
      batterySaver: this.config.batterySaver,
    };
  }

  private setState(next: WakeState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onState?.(next);
  }

  private log(event: WakeLogEvent, detail?: Record<string, number | string>): void {
    // Counts, durations and reasons. Never a transcript: a wake listener that
    // logs what it heard is a recording of the room it sits in.
    this.deps.onLog?.(event, detail);
  }

  private fail(code: WakeErrorCode, detail: string): void {
    this.log('wake_error', { code });
    this.deps.onError?.(code, detail);
    this.setState('error');
  }

  // ----------------------------------------------------------- the lifecycle

  async start(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'error') return;
    this.setState('starting');
    try {
      this.subscription = await this.deps.subscribe({
        onChunk: (pcm16) => this.handleChunk(pcm16),
        onLevel: (level) => {
          this.lastLevel = level;
        },
        onError: (error: MicrophoneError) => {
          this.microphoneStatus = 'BLOCKED';
          this.fail('microphone_lost', error.message);
        },
      });
    } catch (error) {
      this.microphoneStatus = 'BLOCKED';
      const reason = (error as { reason?: string })?.reason;
      this.fail(
        reason === 'permission_denied' ? 'microphone_denied' : 'microphone_lost',
        (error as Error)?.message ?? String(error),
      );
      return;
    }
    this.microphoneStatus = 'READY';
    this.openTransport();
    this.setState('wake_listening');
    this.log('wake_listener_started', { preRollMs: this.config.preRollMs });
  }

  stop(): void {
    this.clearTimers();
    this.transport?.close();
    this.transport = null;
    this.subscription?.release();
    this.subscription = null;
    this.microphoneStatus = 'CLOSED';
    this.sending = false;
    this.phase = 'wake';
    this.vad.reset();
    this.preRoll.clear();
    this.setState('off');
    this.log('wake_listener_stopped');
  }

  /**
   * Pause and resume around ZERO's own voice.
   *
   * Not an optimisation. With the microphone live while ZERO talks, its answer
   * is transcribed as the next thing it was told — and if that answer happens
   * to contain the words "Hey ZERO", it wakes itself. Ingestion stops before
   * the first syllable and resumes a beat after the last.
   */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (speaking) {
      this.clearTimer('cooldown');
      this.setState('speaking');
      return;
    }
    if (this.state === 'off' || this.state === 'error') return;
    this.setState('paused');
    this.cooldownTimer = this.schedule(() => {
      this.cooldownTimer = null;
      this.resumeWake();
    }, this.config.cooldownMs);
  }

  // ------------------------------------------------------------------ audio

  private handleChunk(pcm16: Int16Array): void {
    if (this.state === 'off' || this.state === 'error') return;
    // ZERO's own voice, or the gap right after it. Dropped, never transcribed,
    // and never even shown to the detector.
    if (this.speaking || this.state === 'paused') return;

    const durationMs = pcm16.length * MS_PER_SAMPLE;
    this.preRoll.push(pcm16);
    const event = this.vad.push({ level: this.lastLevel, durationMs });

    if (this.phase === 'wake') {
      this.handleWakeAudio(pcm16, event);
      return;
    }
    this.handleCommandAudio(pcm16, event);
  }

  private handleWakeAudio(pcm16: Int16Array, event: string | null): void {
    if (event === 'speech-start') {
      this.clearTimer('settle');
      this.sending = true;
      this.log('speech_segment_detected');
      // The first syllable is already behind us — the detector needed a moment
      // to be sure. Replay it, or the engine hears "ey zero" and is right not
      // to match.
      for (const held of this.preRoll.drain()) this.transport?.send(held);
      this.log('wake_inference_window', { preRollMs: this.preRoll.lengthMs });
    }
    if (this.sending) this.transport?.send(pcm16);
    if (event === 'speech-end') {
      this.sending = false;
      // Do not clear the server's buffer yet: the partial that would have
      // matched may still be in flight. Losing that race would mean saying
      // "Hey ZERO" and being ignored.
      this.settleTimer = this.schedule(() => {
        this.settleTimer = null;
        this.transport?.reset?.();
        this.vad.reset();
      }, this.config.settleMs);
    }
  }

  private handleCommandAudio(pcm16: Int16Array, event: string | null): void {
    this.transport?.send(pcm16);
    if (event === 'speech-start') {
      // The instruction has begun; the operator is not going to be timed out
      // for having paused after the wake phrase.
      this.clearTimer('grace');
    }
    if (event === 'speech-end' || event === 'max-duration') {
      this.finalizeCommand(event === 'max-duration' ? 'max_duration' : 'silence');
    }
  }

  // ------------------------------------------------------------- the phrase

  private handlePartial(text: string): void {
    if (this.phase === 'command') {
      // What the operator sees while speaking, with the phrase already off the
      // front so the live line reads as the instruction it will become.
      this.deps.onPartial?.(stripWakePhrase(text, this.config.wake));
      return;
    }
    // A partial that arrives while ZERO is talking is ZERO's own voice, or a
    // frame that was in flight when it started. If its answer happens to
    // contain the words "Hey ZERO", acting on it would be ZERO giving itself
    // a command — so the phrase is not even looked for here.
    if (this.speaking || this.state === 'paused') return;
    const match = matchWakePhrase(text, this.config.wake);
    if (!match.woke) return;
    // The original text, not the normalised one the matcher compared: what is
    // shown and what is routed keep their capitals and their umlauts.
    this.wake(stripWakePhrase(text, this.config.wake));
  }

  private wake(carried: string): void {
    this.clearTimer('settle');
    this.wakeCount += 1;
    this.lastWakeAt = this.time();
    this.carried = carried;
    this.delivered = false;
    this.phase = 'command';
    this.sending = true;
    this.commandStartedAt = this.time();
    this.log('wake_detected');

    // A visible beat before listening, so the operator knows it heard them.
    this.setState('wake_detected');
    this.setState('command');
    this.log('command_capture_started', { carriedWords: carried ? carried.split(' ').length : 0 });
    // Said in one breath: the operator should see the instruction the instant
    // it wakes, not wait for the next partial to come round.
    if (carried) this.deps.onPartial?.(carried);

    // Mid-sentence detection: the operator is still talking, so the detector
    // must keep its running state or it would call the rest a new segment.
    if (!this.vad.isSpeaking) this.vad.reset();

    if (!carried) {
      // A bare "Hey ZERO" with nothing after it. Wait for the instruction, but
      // not forever — an accidental wake must return to listening on its own.
      this.graceTimer = this.schedule(() => {
        this.graceTimer = null;
        this.falseActivationCount += 1;
        this.log('wake_timeout');
        this.deps.onError?.('wake_timeout', 'no instruction followed the wake word');
        this.restartWake();
      }, this.config.graceMs);
    }
  }

  private finalizeCommand(reason: 'silence' | 'max_duration'): void {
    if (this.phase !== 'command' || this.state === 'finalizing') return;
    this.clearTimer('grace');
    this.sending = false;
    this.setState('finalizing');
    this.log('command_finalized', {
      reason,
      durationMs: Math.round(this.time() - this.commandStartedAt),
    });
    this.transport?.stop();
  }

  private handleFinal(text: string): void {
    if (this.phase !== 'command') {
      // A final while still waiting for a wake word means the socket ended the
      // utterance on us. Start a fresh one rather than leaving it half open.
      this.restartWake();
      return;
    }
    // Exactly once. A second final for one turn would run the command twice,
    // and "sende die Nachricht" twice is not the same mistake as reading a
    // status twice.
    if (this.delivered) return;
    this.delivered = true;

    const spoken = stripWakePhrase(text, this.config.wake);
    const command = spoken || this.carried;
    this.carried = '';
    if (!command) {
      this.falseActivationCount += 1;
      this.restartWake();
      return;
    }
    this.deps.onFinal?.(command);
    this.setState('thinking');
    void this.deps
      .deliver(command)
      .catch(() => {
        /* the delivery path reports its own failure to the operator */
      })
      .then(() => {
        // If ZERO answered aloud, `setSpeaking` already took over and will
        // resume after the cooldown.
        if (this.state === 'thinking') this.resumeWake();
      });
  }

  // ----------------------------------------------------------- the transport

  private openTransport(): void {
    this.transport?.close();
    this.transport = this.deps.createTransport({
      onReady: (readiness) => {
        this.sttStatus =
          readiness.voice === 'ready' ? 'READY' : readiness.stt?.ready ? 'DEGRADED' : 'OFFLINE';
        if (this.sttStatus === 'OFFLINE') {
          this.fail('stt_unavailable', readiness.stt?.detail ?? 'speech recognition is unavailable');
        }
      },
      onPartial: (text) => this.handlePartial(text),
      onFinal: (text) => this.handleFinal(text),
      onError: (reason, detail) => this.handleTransportError(reason, detail),
    });
    this.transport.open();
  }

  private handleTransportError(reason: string, detail: string): void {
    if (this.phase === 'command' && !this.delivered) {
      if (reason === 'empty_transcript') {
        // Heard sound, understood no words. Not a failure worth a banner, and
        // emphatically not a command.
        this.falseActivationCount += 1;
        this.restartWake();
        return;
      }
      this.deps.onError?.(
        reason === 'backend_restarted' ? 'backend_offline' : 'voice_socket_disconnected',
        detail || reason,
      );
      this.restartWake();
      return;
    }
    // A socket that died while nothing was being said is a reconnect, not an
    // incident: the interface stays up and listening resumes.
    this.restartWake();
  }

  /** Back to passive listening on a clean socket. Never two at once. */
  private restartWake(): void {
    if (this.state === 'off' || this.state === 'error') return;
    this.clearTimers();
    this.phase = 'wake';
    this.sending = false;
    this.delivered = false;
    this.carried = '';
    this.vad.reset();
    this.preRoll.clear();
    this.openTransport();
    this.setState('wake_listening');
    this.log('wake_listener_resumed');
  }

  private resumeWake(): void {
    if (this.state === 'off' || this.state === 'error') return;
    this.restartWake();
  }

  // ---------------------------------------------------------------- plumbing

  private time(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private schedule(handler: () => void, ms: number): number {
    if (this.deps.setTimer) return this.deps.setTimer(handler, ms);
    return globalThis.setTimeout(handler, ms) as unknown as number;
  }

  private clearTimer(which: 'settle' | 'grace' | 'cooldown'): void {
    const handle =
      which === 'settle'
        ? this.settleTimer
        : which === 'grace'
          ? this.graceTimer
          : this.cooldownTimer;
    if (handle === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else globalThis.clearTimeout(handle);
    if (which === 'settle') this.settleTimer = null;
    else if (which === 'grace') this.graceTimer = null;
    else this.cooldownTimer = null;
  }

  private clearTimers(): void {
    this.clearTimer('settle');
    this.clearTimer('grace');
    this.clearTimer('cooldown');
  }
}

/** Chunk length in milliseconds, for callers sizing their own buffers. */
export const CHUNK_MS = Math.round(CHUNK_SAMPLES * MS_PER_SAMPLE);
