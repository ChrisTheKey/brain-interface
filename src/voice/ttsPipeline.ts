/**
 * How ZERO's answer becomes sound — and why the brain may or may not react to
 * it.
 *
 *   1. stream     PCM16 frames on /ws/voice → AudioEngine → AnalyserNode
 *                 Real audio, measured. This is the intended path.
 *   2. http       POST /api/voice/tts → decoded into the same AudioEngine
 *                 Real audio, measured, just not streamed.
 *   3. synthesis  the browser synthesizer
 *                 No audio graph exists for platform TTS, so the levels are
 *                 *estimated* from word boundaries and flagged as such.
 *
 * The tier is chosen from what the operator actually offers, never from a
 * guess, and the chosen tier is reported so the HUD can name the degradation.
 */
import type { VoiceOutputMode } from '../config';
import type { AudioEngine } from '../audio/playback';
import type { AudioLevels } from '../audio/analyser';
import type { HwdZeroClient } from '../hwd/client';
import type { VoiceChannel } from '../hwd/voiceChannel';
import { SpeechSynthesisSpeaker } from './speechSynthesisProvider';
import type { VoiceCharacter } from './provider';

export type VoiceTier = 'stream' | 'http' | 'synthesis' | 'none';

export interface TierCapabilities {
  /** `/ws/voice` is open. */
  stream: boolean;
  /** `/api/voice/tts` answered with audio at least once. */
  http: boolean;
  /** The browser has `speechSynthesis`. */
  synthesis: boolean;
}

/**
 * Pure tier selection: the configured mode narrows the choice, the
 * capabilities decide. `auto` takes the best real-audio path available.
 */
export function resolveTier(mode: VoiceOutputMode, capabilities: TierCapabilities): VoiceTier {
  if (mode === 'none') return 'none';
  if (mode === 'stream') return capabilities.stream ? 'stream' : 'none';
  if (mode === 'http') return capabilities.http ? 'http' : 'none';
  if (mode === 'synthesis') return capabilities.synthesis ? 'synthesis' : 'none';
  if (capabilities.stream) return 'stream';
  if (capabilities.http) return 'http';
  if (capabilities.synthesis) return 'synthesis';
  return 'none';
}

/** Why the current tier is not the intended one — shown in the HUD verbatim. */
export const TIER_NOTES: Record<VoiceTier, string | null> = {
  stream: null,
  http: 'HWD-ZERO has no /ws/voice stream — the answer is fetched from /api/voice/tts and still analysed.',
  synthesis:
    'HWD-ZERO provides no audio (/ws/voice and /api/voice/tts are both missing). The browser voice cannot be routed through Web Audio, so the reaction is estimated from word timing, not measured.',
  none: 'No voice output is available — ZERO answers in text only.',
};

export interface TtsPipelineOptions {
  mode: VoiceOutputMode;
  engine: AudioEngine;
  client: Pick<HwdZeroClient, 'synthesize'>;
  channel: Pick<VoiceChannel, 'isAvailable' | 'send'>;
  character: VoiceCharacter;
  onTierChange?: (tier: VoiceTier, note: string | null) => void;
}

export class TtsPipeline {
  private readonly synthesis: SpeechSynthesisSpeaker;
  /** Set to false the first time `/api/voice/tts` says it does not exist. */
  private httpAvailable = true;
  private tier: VoiceTier = 'none';
  private abort: AbortController | null = null;

  constructor(private readonly options: TtsPipelineOptions) {
    this.synthesis = new SpeechSynthesisSpeaker(options.character);
  }

  get currentTier(): VoiceTier {
    return this.tier;
  }

  get note(): string | null {
    return TIER_NOTES[this.tier];
  }

  /** True when the brain is reacting to a measured signal rather than a guess. */
  get isMeasured(): boolean {
    return this.tier === 'stream' || this.tier === 'http';
  }

  capabilities(): TierCapabilities {
    return {
      stream: this.options.channel.isAvailable,
      http: this.httpAvailable,
      synthesis: SpeechSynthesisSpeaker.isSupported(),
    };
  }

  /** Re-evaluate the tier; call whenever the voice channel changes state. */
  refresh(): VoiceTier {
    const next = resolveTier(this.options.mode, this.capabilities());
    if (next !== this.tier) {
      this.tier = next;
      this.options.onTierChange?.(next, TIER_NOTES[next]);
    }
    return next;
  }

  /**
   * Voice one text. Resolves when the sound has finished — for the streaming
   * tier that is when the operator closed the audio stream, which the caller
   * observes through the engine rather than here.
   */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const tier = this.refresh();
    this.abort?.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;

    if (tier === 'stream') {
      // The operator owns the voice: it renders the audio and streams it back
      // on the same channel. Nothing is synthesised on this machine.
      this.options.channel.send({ type: 'voice.speak', text: trimmed });
      return;
    }

    if (tier === 'http') {
      let audio: ArrayBuffer | null = null;
      try {
        audio = await this.options.client.synthesize(trimmed, signal);
      } catch {
        audio = null;
      }
      if (signal.aborted) return;
      if (audio) {
        await this.options.engine.playEncoded(audio);
        return;
      }
      // The operator does not implement it after all — drop a tier and retry
      // once, so the sentence is still spoken.
      this.httpAvailable = false;
      this.refresh();
      if (this.tier === 'synthesis') await this.speakWithSynthesis(trimmed, signal);
      return;
    }

    if (tier === 'synthesis') {
      await this.speakWithSynthesis(trimmed, signal);
    }
  }

  private async speakWithSynthesis(text: string, signal: AbortSignal): Promise<void> {
    try {
      await this.synthesis.speak(text, signal);
    } catch {
      // A synthesizer that refuses to speak must not break the turn.
    }
  }

  /**
   * Levels for the current tier. Measured tiers read the analyser; the
   * synthesizer tier returns its estimate, or null when nothing is speaking.
   */
  levels(): { levels: AudioLevels | null; estimated: boolean } {
    if (this.isMeasured) {
      const measured = this.options.engine.levels();
      return { levels: measured, estimated: false };
    }
    if (this.tier === 'synthesis') {
      return { levels: this.synthesis.readLevels(), estimated: true };
    }
    return { levels: null, estimated: false };
  }

  get isSpeaking(): boolean {
    if (this.isMeasured) return this.options.engine.isPlaying;
    return this.tier === 'synthesis' && this.synthesis.isSpeaking;
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.options.engine.stop();
    this.synthesis.stop();
    if (this.tier === 'stream') this.options.channel.send({ type: 'voice.cancel' });
  }

  dispose(): void {
    this.stop();
    this.synthesis.dispose();
  }
}
