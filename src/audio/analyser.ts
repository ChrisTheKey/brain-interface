/**
 * Web Audio analysis for ZERO's voice.
 *
 * The analyser reads the *actual* audio signal that is being played back
 * (RMS amplitude, peak, and low/high band energy from the FFT). These values
 * drive the smoke — the smoke never runs off a plain "audio is playing" flag.
 */

export interface AudioLevels {
  /** RMS amplitude, 0..1. */
  amplitude: number;
  /** Instantaneous peak, 0..1. */
  peak: number;
  /** Energy of the low band (roughly < 400 Hz), 0..1. */
  low: number;
  /** Energy of the high band (roughly > 2 kHz), 0..1. */
  high: number;
  /** Amplitude rise compared to the previous frame, 0..1 (drives bursts). */
  onset: number;
}

export const SILENT_LEVELS: AudioLevels = {
  amplitude: 0,
  peak: 0,
  low: 0,
  high: 0,
  onset: 0,
};

export class VoiceAnalyser {
  private readonly analyser: AnalyserNode;
  private readonly timeData: Float32Array;
  private readonly freqData: Uint8Array;
  private previousAmplitude = 0;
  private smoothed: AudioLevels = { ...SILENT_LEVELS };

  constructor(
    private readonly context: AudioContext,
    fftSize = 1024,
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.65;
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Node that sources must connect into. */
  get node(): AnalyserNode {
    return this.analyser;
  }

  read(): AudioLevels {
    // `Float32Array<ArrayBuffer>` vs `ArrayBufferLike` differences across TS DOM
    // versions are irrelevant here; the buffers are plain typed arrays.
    this.analyser.getFloatTimeDomainData(this.timeData as Float32Array<ArrayBuffer>);
    this.analyser.getByteFrequencyData(this.freqData as Uint8Array<ArrayBuffer>);

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this.timeData.length; i += 1) {
      const sample = this.timeData[i] ?? 0;
      sumSquares += sample * sample;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    const amplitude = Math.sqrt(sumSquares / Math.max(1, this.timeData.length));

    const nyquist = this.context.sampleRate / 2;
    const binCount = this.freqData.length;
    const lowBins = Math.max(1, Math.round((400 / nyquist) * binCount));
    const highStart = Math.min(binCount - 1, Math.round((2000 / nyquist) * binCount));

    let lowSum = 0;
    for (let i = 0; i < lowBins; i += 1) lowSum += this.freqData[i] ?? 0;
    let highSum = 0;
    for (let i = highStart; i < binCount; i += 1) highSum += this.freqData[i] ?? 0;

    const low = lowSum / (lowBins * 255);
    const high = highSum / (Math.max(1, binCount - highStart) * 255);
    const onset = Math.max(0, amplitude - this.previousAmplitude) * 6;
    this.previousAmplitude = amplitude;

    this.smoothed = {
      amplitude: smooth(this.smoothed.amplitude, clamp01(amplitude * 2.2), 0.35),
      peak: smooth(this.smoothed.peak, clamp01(peak), 0.5),
      low: smooth(this.smoothed.low, clamp01(low), 0.3),
      high: smooth(this.smoothed.high, clamp01(high), 0.3),
      onset: clamp01(onset),
    };
    return this.smoothed;
  }

  dispose(): void {
    try {
      this.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smooth(previous: number, next: number, factor: number): number {
  return previous + (next - previous) * factor;
}

/** Decode base64 PCM16 (ZERO realtime audio chunks) into planar float samples. */
export function decodePcm16Base64(
  base64: string,
  numChannels: number,
  decodeBase64: (value: string) => Uint8Array,
): Float32Array[] {
  return decodePcm16Bytes(decodeBase64(base64), numChannels);
}

/**
 * Decode raw PCM16 little-endian bytes into planar float samples. Fish Audio
 * streams PCM over HTTP, so its chunks arrive as bytes rather than base64.
 */
export function decodePcm16Bytes(bytes: Uint8Array, numChannels: number): Float32Array[] {
  const channels = Math.max(1, numChannels);
  const frameCount = Math.floor(bytes.length / 2 / channels);
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    planes.push(new Float32Array(frameCount));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (frame * channels + channel) * 2;
      const sample = view.getInt16(offset, true);
      const plane = planes[channel];
      if (plane) plane[frame] = sample / 32768;
    }
  }
  return planes;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node (tests) fallback.
  const buffer = Buffer.from(base64, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
