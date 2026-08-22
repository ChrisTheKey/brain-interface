/**
 * Runtime configuration of the Brain Interface.
 *
 * The interface is same-origin by design: the gateway on port 3000 serves this
 * bundle and proxies `/api`, `/ws/events` and `/ws/voice` to HWD-ZERO on
 * loopback. So there is no backend address to configure here and no credential
 * to embed — everything below tunes presentation and the local voice stack.
 */

export type SpeechProvider = 'web-speech' | 'none';
export type VoiceOutputMode = 'auto' | 'stream' | 'http' | 'synthesis' | 'none';

export interface BrainInterfaceConfig {
  /** Same-origin by default; only tests and a split dev setup pass a base. */
  apiBaseUrl: string;
  /** Fullscreen background asset (the red/magenta reference plate). */
  backgroundImage: string;
  /** Structural refresh interval; live changes still arrive over /ws/events. */
  refreshIntervalMs: number;
  /** Reconnect backoff for /ws/events and /ws/voice. */
  reconnectDelayMs: number;
  speech: {
    /** Speech-to-text provider for microphone input. */
    provider: SpeechProvider;
    language: string;
  };
  voice: {
    /**
     * How ZERO's answer is voiced:
     *   stream    – PCM frames over /ws/voice (real audio, fully analysable)
     *   http      – POST /api/voice/tts, decoded into the Web Audio graph
     *   synthesis – the browser synthesizer (no audio graph, see README)
     *   auto      – the best of the three that this backend actually offers
     */
    mode: VoiceOutputMode;
    /** Substring match against `speechSynthesis.getVoices()` names. */
    preferredVoices: string[];
    rate: number;
    pitch: number;
    volume: number;
    /** Speak ZERO's answer automatically when a turn completes. */
    autoSpeak: boolean;
  };
  render: {
    /** Force a quality tier instead of measuring the device. */
    quality: 'auto' | 'low' | 'medium' | 'high';
    /** Upper bound for the device pixel ratio (adaptive DPR clamps below it). */
    maxPixelRatio: number;
    /** Allow the (limited) bloom pass on capable devices. */
    bloom: boolean;
    /** Cap on smoke particles; the quality tier scales down from here. */
    maxSmokeParticles: number;
  };
}

type EnvRecord = Record<string, string | boolean | undefined>;

function readString(env: EnvRecord, key: string, fallback: string): string {
  const value = env[key];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readNumber(env: EnvRecord, key: string, fallback: number): number {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(env: EnvRecord, key: string, fallback: boolean): boolean {
  const raw = readString(env, key, '').toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readList(env: EnvRecord, key: string): string[] {
  return readString(env, key, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readEnum<T extends string>(
  env: EnvRecord,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readString(env, key, '') as T;
  return allowed.includes(raw) ? raw : fallback;
}

export function resolveConfig(env: EnvRecord): BrainInterfaceConfig {
  return {
    // Empty string = same origin. A value is only useful when the Vite dev
    // server and the gateway run on different ports.
    apiBaseUrl: readString(env, 'VITE_ZERO_API_BASE', '').replace(/\/+$/, ''),
    backgroundImage: readString(env, 'VITE_ZERO_BACKGROUND_IMAGE', '/reference/red-background.jpg'),
    refreshIntervalMs: Math.max(2_000, readNumber(env, 'VITE_ZERO_REFRESH_INTERVAL_MS', 10_000)),
    reconnectDelayMs: Math.max(500, readNumber(env, 'VITE_ZERO_RECONNECT_DELAY_MS', 2_000)),
    speech: {
      provider: readEnum(env, 'VITE_ZERO_SPEECH_PROVIDER', ['web-speech', 'none'] as const, 'web-speech'),
      language: readString(env, 'VITE_ZERO_SPEECH_LANGUAGE', 'de-DE'),
    },
    voice: {
      mode: readEnum(
        env,
        'VITE_ZERO_VOICE_MODE',
        ['auto', 'stream', 'http', 'synthesis', 'none'] as const,
        'auto',
      ),
      preferredVoices: readList(env, 'VITE_ZERO_VOICE_NAMES'),
      rate: readNumber(env, 'VITE_ZERO_VOICE_RATE', 0.92),
      pitch: readNumber(env, 'VITE_ZERO_VOICE_PITCH', 0.82),
      volume: readNumber(env, 'VITE_ZERO_VOICE_VOLUME', 1),
      autoSpeak: readBoolean(env, 'VITE_ZERO_VOICE_AUTOSPEAK', true),
    },
    render: {
      quality: readEnum(
        env,
        'VITE_ZERO_RENDER_QUALITY',
        ['auto', 'low', 'medium', 'high'] as const,
        'auto',
      ),
      maxPixelRatio: Math.max(1, readNumber(env, 'VITE_ZERO_MAX_PIXEL_RATIO', 2)),
      bloom: readBoolean(env, 'VITE_ZERO_BLOOM', true),
      maxSmokeParticles: Math.max(
        64,
        Math.trunc(readNumber(env, 'VITE_ZERO_MAX_SMOKE_PARTICLES', 900)),
      ),
    },
  };
}

export const config: BrainInterfaceConfig = resolveConfig(
  (typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as unknown as EnvRecord)
    : {}) as EnvRecord,
);
