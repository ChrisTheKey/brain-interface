/**
 * Speech input: a real microphone, a real speech-to-text engine.
 *
 *   Microphone → SpeechRecognition → partial transcript → HWD-ZERO
 *                                  → final transcript   → HWD-ZERO
 *
 * The default engine is the browser's `SpeechRecognition`, which is a real STT
 * engine on Chrome, Android and Samsung Internet and needs no credentials. The
 * microphone is only ever opened after an explicit user action, and every
 * stream, track and audio node is released on stop.
 *
 * Partials are what the engine is still refining; the final transcript is the
 * sentence that is handed over. Both are surfaced, never merged, never faked.
 */

export type SpeechInputState = 'idle' | 'listening' | 'denied' | 'unsupported' | 'error';

export interface SpeechTranscript {
  text: string;
  /** false while the engine is still refining the sentence. */
  final: boolean;
}

export interface SpeechInputHandlers {
  /** Fires on every revision — this is the live partial transcript. */
  onPartial: (text: string) => void;
  /** Fires once the engine commits a segment. */
  onFinal: (text: string) => void;
  onEnd: (finalText: string) => void;
  onError: (error: string) => void;
}

/** Minimal shape of the platform SpeechRecognition API. */
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionConstructor = new () => RecognitionLike;

export function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof globalThis === 'undefined') return null;
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Merges recognition results into "what is committed" and "what is still
 * being revised". Pure, so the transcript logic is unit-tested rather than
 * only observed in a browser.
 */
export function mergeResults(
  event: SpeechRecognitionResultEventLike,
  committed: string,
): { committed: string; partial: string } {
  let nextCommitted = committed;
  let partial = '';
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (!result) continue;
    const alternative = result[0];
    if (!alternative) continue;
    const text = alternative.transcript;
    if (result.isFinal) {
      nextCommitted = `${nextCommitted} ${text}`.trim();
    } else {
      partial = `${partial} ${text}`.trim();
    }
  }
  return { committed: nextCommitted, partial };
}

export class WebSpeechInput {
  readonly id = 'web-speech';
  private recognition: RecognitionLike | null = null;
  private committed = '';

  constructor(
    private readonly language: string,
    /** Keep listening across pauses — the phone's engine likes short bursts. */
    private readonly continuous = true,
  ) {}

  isSupported(): boolean {
    return getRecognitionConstructor() !== null;
  }

  start(handlers: SpeechInputHandlers): void {
    const Recognition = getRecognitionConstructor();
    if (!Recognition) {
      handlers.onError('SpeechRecognition is not available in this browser');
      return;
    }
    this.stop();
    this.committed = '';

    const recognition = new Recognition();
    recognition.lang = this.language;
    recognition.continuous = this.continuous;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const merged = mergeResults(event, this.committed);
      if (merged.committed !== this.committed) {
        this.committed = merged.committed;
        handlers.onFinal(this.committed);
      }
      // The live view is what is committed so far plus what is being revised.
      handlers.onPartial(`${this.committed} ${merged.partial}`.trim());
    };
    recognition.onerror = (event) => {
      const code = event.error ?? 'unknown';
      handlers.onError(code === 'not-allowed' ? 'microphone permission denied' : code);
    };
    recognition.onend = () => {
      handlers.onEnd(this.committed.trim());
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : 'could not start recognition');
    }
  }

  stop(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  /** Drop the session without emitting a final transcript. */
  abort(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  dispose(): void {
    this.abort();
  }
}

/**
 * Microphone level meter. Separate from the STT engine: it exists so the brain
 * can show that ZERO is *actually* hearing something, driven by the real input
 * signal rather than by a timer.
 */
export class MicrophoneMeter {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private data: Uint8Array | null = null;
  private smoothed = 0;

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: 'no microphone API in this browser' };
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      return {
        ok: false,
        error: name === 'NotAllowedError' ? 'microphone permission denied' : String(name ?? error),
      };
    }

    const AudioContextCtor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!AudioContextCtor) {
      this.stop();
      return { ok: false, error: 'Web Audio API is not available' };
    }

    this.context = new AudioContextCtor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    return { ok: true };
  }

  /** Current input loudness, 0..1. Returns 0 when the microphone is closed. */
  level(): number {
    const analyser = this.analyser;
    const data = this.data;
    if (!analyser || !data) return 0;
    analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] ?? 0;
    const average = sum / (data.length * 255);
    this.smoothed = this.smoothed + (Math.min(1, average * 2.5) - this.smoothed) * 0.3;
    return this.smoothed;
  }

  stop(): void {
    this.smoothed = 0;
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.source = null;
    this.analyser = null;
    this.stream = null;
    this.context = null;
    this.data = null;
  }
}
