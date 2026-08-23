/**
 * Knowing when someone started talking, and when they stopped.
 *
 * This is what removes the STOP button. Without it, hands-free means holding
 * a key anyway, and a wake word that still needs a keypress afterwards is a
 * party trick.
 *
 * Energy with hysteresis, not a model. Two reasons: it costs nothing on a
 * phone that is also running whisper, and the decision it makes is coarse —
 * "is this silence or is this a person" — which is exactly the resolution
 * amplitude gives you. A neural VAD would be a second model competing for the
 * same CPU as the one doing the actual work.
 *
 * The hysteresis matters more than the threshold. A single quiet frame is not
 * the end of a sentence; people breathe mid-thought, and cutting them off
 * there is the difference between a system that listens and one that
 * interrupts.
 */

export interface VadConfig {
  /** Level above which a frame counts as speech, 0..1. */
  speechLevel: number;
  /** How long speech must persist before it counts as started. */
  minSpeechMs: number;
  /** How long silence must persist before the turn is over. */
  silenceMs: number;
  /** A turn is finalized at this point no matter what. */
  maxTurnMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  // Well above room tone, well below speech at arm's length. `levelOf` already
  // scales the average amplitude by 4, so this is quieter than it looks.
  speechLevel: 0.045,
  minSpeechMs: 180,
  // Long enough to survive a breath, short enough not to feel like a wait.
  silenceMs: 1100,
  maxTurnMs: 45_000,
};

export type VadEvent = 'speech-start' | 'speech-end' | 'max-duration';

export interface VadFrame {
  level: number;
  durationMs: number;
}

/**
 * A voice activity detector over a stream of frames.
 *
 * Fed levels rather than samples so it can be tested with numbers and reused
 * over any capture stack. It reports transitions, never state — the caller
 * decides what a transition means in the phase it happens to be in.
 */
export class VoiceActivityDetector {
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private turnMs = 0;
  private maxReported = false;

  constructor(private readonly config: VadConfig = DEFAULT_VAD_CONFIG) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Milliseconds of continuous silence since the last speech frame. */
  get silenceMs(): number {
    return this.speaking ? this.belowMs : 0;
  }

  /** Milliseconds since this turn began counting. */
  get elapsedMs(): number {
    return this.turnMs;
  }

  reset(): void {
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.turnMs = 0;
    this.maxReported = false;
  }

  /** Feed one frame. Returns what changed, if anything. */
  push({ level, durationMs }: VadFrame): VadEvent | null {
    this.turnMs += durationMs;
    const loud = level >= this.config.speechLevel;

    if (loud) {
      this.aboveMs += durationMs;
      this.belowMs = 0;
    } else {
      this.belowMs += durationMs;
      this.aboveMs = 0;
    }

    if (!this.speaking) {
      if (this.aboveMs >= this.config.minSpeechMs) {
        this.speaking = true;
        this.belowMs = 0;
        return 'speech-start';
      }
      return null;
    }

    // A turn that never ends is a microphone left open. Report it once.
    if (this.turnMs >= this.config.maxTurnMs && !this.maxReported) {
      this.maxReported = true;
      return 'max-duration';
    }
    if (this.belowMs >= this.config.silenceMs) {
      this.speaking = false;
      this.aboveMs = 0;
      return 'speech-end';
    }
    return null;
  }
}

/**
 * The last few hundred milliseconds of audio, kept in case they turn out to
 * have mattered.
 *
 * A detector needs a moment of sound before it will call it speech, and that
 * moment is the first syllable of "Hey". Replaying it into the socket the
 * instant speech is declared is the difference between the engine hearing
 * "hey zero" and hearing "ey zero" — which does not match, and should not.
 */
export class PreRollBuffer {
  private chunks: Int16Array[] = [];
  private samples = 0;

  constructor(
    private readonly maxSamples: number,
    /** Only used to describe the buffer; the sample count is what bounds it. */
    readonly sampleRate = 16_000,
  ) {}

  get lengthMs(): number {
    return Math.round((this.samples / this.sampleRate) * 1000);
  }

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.samples += chunk.length;
    // Bounded by construction: this runs on every frame forever, so it can
    // never be the thing that grows.
    while (this.samples > this.maxSamples && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.samples -= dropped?.length ?? 0;
    }
  }

  /** Everything held, oldest first, and the buffer is emptied. */
  drain(): Int16Array[] {
    const held = this.chunks;
    this.chunks = [];
    this.samples = 0;
    return held;
  }

  clear(): void {
    this.chunks = [];
    this.samples = 0;
  }
}

/** A pre-roll buffer sized in milliseconds rather than samples. */
export function preRollFor(milliseconds: number, sampleRate = 16_000): PreRollBuffer {
  return new PreRollBuffer(Math.round((milliseconds / 1000) * sampleRate), sampleRate);
}
