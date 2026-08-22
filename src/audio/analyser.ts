/**
 * Web Audio analysis of ZERO's voice.
 *
 * The analyser reads the *actual* signal that is being played back — RMS,
 * peak, and low/mid/high band energy from the FFT — and detects transients
 * from the frame-to-frame rise. Those five numbers are the only thing that
 * drives the core, the filaments, the sparks and the smoke while ZERO speaks:
 *
 *   RMS        → core scale + emission
 *   low        → core pulse + smoke density
 *   mid        → filament intensity
 *   high       → sparks
 *   transient  → energy bursts
 *
 * When nothing is playing the levels are exactly zero, so the brain returns to
 * a quiet state on its own instead of idling on a fake signal.
 */

export interface AudioLevels {
  /** RMS amplitude, 0..1. */
  amplitude: number;
  /** Instantaneous peak, 0..1. */
  peak: number;
  /** Energy below roughly 400 Hz, 0..1 — the body of the voice. */
  low: number;
  /** Energy between roughly 400 Hz and 2 kHz, 0..1 — vowels and articulation. */
  mid: number;
  /** Energy above roughly 2 kHz, 0..1 — consonants and emphasis. */
  high: number;
  /** Amplitude rise against the previous frame, 0..1 — drives bursts. */
  transient: number;
}

export const SILENT_LEVELS: AudioLevels = {
  amplitude: 0,
  peak: 0,
  low: 0,
  mid: 0,
  high: 0,
  transient: 0,
};

/** Below this RMS the signal counts as silence, not as a very quiet voice. */
export const NOISE_FLOOR = 0.004;

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
    this.analyser.smoothingTimeConstant = 0.62;
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Node that every audio source must connect into. */
  get node(): AnalyserNode {
    return this.analyser;
  }

  read(): AudioLevels {
    // `Float32Array<ArrayBuffer>` vs `ArrayBufferLike` differences across TS
    // DOM versions are irrelevant here; these are plain typed arrays.
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

    const bands = bandEnergies(this.freqData, this.context.sampleRate);
    const transient = Math.max(0, amplitude - this.previousAmplitude) * 7;
    this.previousAmplitude = amplitude;

    if (amplitude < NOISE_FLOOR && this.smoothed.amplitude < 0.01) {
      this.smoothed = { ...SILENT_LEVELS };
      return this.smoothed;
    }

    this.smoothed = {
      amplitude: smooth(this.smoothed.amplitude, clamp01(amplitude * 2.4), 0.35),
      peak: smooth(this.smoothed.peak, clamp01(peak), 0.5),
      low: smooth(this.smoothed.low, clamp01(bands.low), 0.3),
      mid: smooth(this.smoothed.mid, clamp01(bands.mid), 0.32),
      high: smooth(this.smoothed.high, clamp01(bands.high), 0.34),
      transient: clamp01(transient),
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

/**
 * Split an FFT magnitude buffer into the three bands the brain reacts to.
 * Pure, so the band split is unit-tested rather than eyeballed.
 */
export function bandEnergies(
  freqData: Uint8Array | number[],
  sampleRate: number,
): { low: number; mid: number; high: number } {
  const binCount = freqData.length;
  if (binCount === 0) return { low: 0, mid: 0, high: 0 };
  const nyquist = Math.max(1, sampleRate / 2);
  const binFor = (hz: number): number =>
    Math.min(binCount, Math.max(1, Math.round((hz / nyquist) * binCount)));

  const lowEnd = binFor(400);
  const midEnd = Math.max(lowEnd + 1, binFor(2_000));

  let low = 0;
  for (let i = 0; i < lowEnd; i += 1) low += freqData[i] ?? 0;
  let mid = 0;
  for (let i = lowEnd; i < midEnd; i += 1) mid += freqData[i] ?? 0;
  let high = 0;
  for (let i = midEnd; i < binCount; i += 1) high += freqData[i] ?? 0;

  return {
    low: low / (lowEnd * 255),
    mid: mid / (Math.max(1, midEnd - lowEnd) * 255),
    high: high / (Math.max(1, binCount - midEnd) * 255),
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smooth(previous: number, next: number, factor: number): number {
  return previous + (next - previous) * factor;
}
