/**
 * The microphone, as a stream of the exact bytes ZERO's engine wants.
 *
 * `getUserMedia` gives 32-bit floats at whatever rate the device likes —
 * 44100 or 48000 on a phone. whisper.cpp wants 16 kHz mono PCM16. Doing that
 * conversion here, next to the capture, keeps it out of the transport and out
 * of the server, and means the bytes on the wire are the bytes the engine
 * reads.
 *
 * Streaming, not recording. A push-to-talk turn that only uploads when the
 * button is released cannot show a live transcript, and a live transcript is
 * the whole point: seeing what ZERO heard while there is still time to stop.
 *
 * The track is stopped on every exit path. A microphone left open is a
 * recording indicator the user did not ask for and cannot explain.
 */

/** What ZERO's STT expects. Everything here converts to exactly this. */
export const TARGET_SAMPLE_RATE = 16_000;

/** ~250 ms of audio per chunk: often enough to feel live, rarely enough to flood. */
export const CHUNK_SAMPLES = 4_096;

export type MicrophoneErrorReason =
  | 'permission_denied'
  | 'no_microphone'
  | 'insecure_context'
  | 'unsupported'
  | 'audio_error';

export class MicrophoneError extends Error {
  constructor(
    message: string,
    readonly reason: MicrophoneErrorReason,
  ) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

export interface MicrophoneHandlers {
  /** One chunk of 16 kHz mono PCM16, ready to send. */
  onChunk: (pcm16: Int16Array) => void;
  /** Input level 0..1, for the listening animation. Real amplitude, never a timer. */
  onLevel?: (level: number) => void;
  onError?: (error: MicrophoneError) => void;
}

/**
 * Is a microphone reachable at all in this context?
 *
 * Browsers only grant `getUserMedia` in a secure context. `localhost` counts;
 * a plain `http://192.168.x.x` LAN address generally does not — which is
 * exactly how the Galaxy reaches the gateway. Saying so up front is better
 * than a permission prompt that never appears.
 */
export function microphoneAvailability(): { available: boolean; reason?: MicrophoneErrorReason } {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { available: false, reason: 'unsupported' };
  }
  // `isSecureContext` is the browser's own answer, and it already counts
  // loopback as secure per the spec — so naming hosts here would be both
  // redundant and a backend-looking literal in the bundle.
  if (typeof window === 'undefined' || !window.isSecureContext) {
    return { available: false, reason: 'insecure_context' };
  }
  return { available: true };
}

/** Average absolute amplitude of a block, 0..1. */
export function levelOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += Math.abs(samples[index]!);
  return Math.min(1, (total / samples.length) * 4);
}

/**
 * Resample by linear interpolation and clamp to PCM16.
 *
 * Linear rather than a windowed filter on purpose: it is cheap enough to run
 * per block on a mid-range phone without stealing the frame budget from the
 * brain, and speech at 16 kHz survives it well enough for whisper.
 */
export function toPcm16(samples: Float32Array, fromRate: number): Int16Array {
  if (samples.length === 0) return new Int16Array(0);
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const value = samples[left]! + (samples[right]! - samples[left]!) * (position - left);
    // Clamp before scaling: a float above 1 would wrap to a loud negative.
    output[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  return output;
}

export interface MicrophoneStream {
  /** Stop capture and release the device. Safe to call twice. */
  stop: () => void;
  /** The rate the device actually gave us, for diagnostics. */
  sampleRate: number;
}

/**
 * Open the microphone and stream PCM16 chunks until `stop()`.
 *
 * `ScriptProcessorNode` rather than an AudioWorklet: it is deprecated but
 * universally available, and an AudioWorklet needs a separately served module
 * file, which is a second thing that can 404 on a phone. The processing here
 * is a resample and a clamp — cheap enough that running it on the main thread
 * does not cost the brain its frame rate.
 */
export async function openMicrophone(handlers: MicrophoneHandlers): Promise<MicrophoneStream> {
  const availability = microphoneAvailability();
  if (!availability.available) {
    throw new MicrophoneError(
      availability.reason === 'insecure_context'
        ? 'the browser only allows the microphone in a secure context (https, or on the device itself)'
        : 'this browser exposes no microphone API',
      availability.reason ?? 'unsupported',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // A phone held near the speaker will otherwise feed ZERO's own voice
        // back in; these are the browser's own defences and they are free.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (error) {
    const name = (error as { name?: string })?.name ?? '';
    throw new MicrophoneError(
      name === 'NotAllowedError'
        ? 'microphone permission was denied'
        : name === 'NotFoundError'
          ? 'no microphone is available on this device'
          : `the microphone could not be opened: ${String(error)}`,
      name === 'NotAllowedError'
        ? 'permission_denied'
        : name === 'NotFoundError'
          ? 'no_microphone'
          : 'audio_error',
    );
  }

  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    for (const track of stream.getTracks()) track.stop();
    throw new MicrophoneError('this browser has no Web Audio support', 'unsupported');
  }

  const audio = new AudioContextCtor();
  const source = audio.createMediaStreamSource(stream);
  const processor = audio.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    handlers.onLevel?.(levelOf(input));
    try {
      handlers.onChunk(toPcm16(input, audio.sampleRate));
    } catch (error) {
      handlers.onError?.(
        error instanceof MicrophoneError
          ? error
          : new MicrophoneError(String(error), 'audio_error'),
      );
    }
  };

  source.connect(processor);
  // A ScriptProcessor only runs when connected to a destination. Zero gain so
  // the operator does not hear themselves through their own speaker.
  const silent = audio.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(audio.destination);

  return {
    sampleRate: audio.sampleRate,
    stop: () => {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        silent.disconnect();
        source.disconnect();
      } catch {
        /* already torn down */
      }
      // Every path releases the device. An open microphone the user cannot
      // explain is worse than a failed turn.
      for (const track of stream.getTracks()) track.stop();
      void audio.close().catch(() => {});
    },
  };
}
