/**
 * Speech input: microphone → speech-to-text → ZERO.
 *
 *   Microphone → Speech Input Service → Speech-to-Text Provider → ZERO pipeline
 *
 * The provider is swappable. The default uses the browser's SpeechRecognition
 * engine, which is a real STT engine (Chrome/Android/Samsung Internet) and
 * needs no credentials. The microphone is only ever opened after an explicit
 * user action, and every stream, track and audio node is released on stop.
 */

export type SpeechInputState = 'idle' | 'listening' | 'denied' | 'unsupported' | 'error';

export interface SpeechTranscript {
  text: string;
  /** false while the engine is still refining the sentence. */
  final: boolean;
}

export interface SpeechInputProvider {
  readonly id: string;
  isSupported(): boolean;
  start(handlers: {
    onTranscript: (transcript: SpeechTranscript) => void;
    onEnd: () => void;
    onError: (error: string) => void;
  }): void;
  stop(): void;
  dispose(): void;
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
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
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

export class WebSpeechInputProvider implements SpeechInputProvider {
  readonly id = 'web-speech';
  private recognition: RecognitionLike | null = null;

  constructor(private readonly language: string) {}

  isSupported(): boolean {
    return getRecognitionConstructor() !== null;
  }

  start(handlers: {
    onTranscript: (transcript: SpeechTranscript) => void;
    onEnd: () => void;
    onError: (error: string) => void;
  }): void {
    const Recognition = getRecognitionConstructor();
    if (!Recognition) {
      handlers.onError('SpeechRecognition is not available in this browser');
      return;
    }
    this.stop();

    const recognition = new Recognition();
    recognition.lang = this.language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        handlers.onTranscript({ text: alternative.transcript, final: result.isFinal });
      }
    };
    recognition.onerror = (event) => {
      const code = event.error ?? 'unknown';
      handlers.onError(code === 'not-allowed' ? 'microphone permission denied' : code);
    };
    recognition.onend = () => {
      handlers.onEnd();
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
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  dispose(): void {
    this.stop();
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
