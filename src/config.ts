import { ZERO_VOICE_PROMPT } from './voice/provider';

/**
 * Runtime configuration. Every backend address comes from the environment –
 * nothing about ZERO's location is hardcoded in the interface.
 */

export interface BrainInterfaceConfig {
  /** WebSocket URL of ZERO's app-server (`codex app-server --listen ws://IP:PORT`). */
  zeroWsUrl: string;
  clientName: string;
  clientVersion: string;
  /** Opt into ZERO's experimental API (required for thread realtime / voice). */
  experimentalApi: boolean;
  /** Extra workspace roots to scope `skills/list` to, beyond the ones ZERO's threads report. */
  extraCwds: string[];
  /** How many threads to pull per source kind. */
  threadLimit: number;
  /** Structural refresh interval; live changes still arrive via notifications. */
  refreshIntervalMs: number;
  /** Fullscreen background asset. */
  backgroundImage: string;
  voice: {
    provider: 'zero-realtime' | 'speech-synthesis' | 'none';
    /** Substring match against `speechSynthesis.getVoices()` names. */
    preferredVoices: string[];
    rate: number;
    pitch: number;
    volume: number;
    /** Speak ZERO's completed agent messages as they stream in. */
    speakAgentMessages: boolean;
    /** Session prompt that defines ZERO's voice character (realtime provider). */
    prompt: string;
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

export function resolveConfig(env: EnvRecord): BrainInterfaceConfig {
  const providerRaw = readString(env, 'VITE_ZERO_VOICE_PROVIDER', 'zero-realtime');
  const provider =
    providerRaw === 'speech-synthesis' || providerRaw === 'none' || providerRaw === 'zero-realtime'
      ? providerRaw
      : 'zero-realtime';

  return {
    zeroWsUrl: readString(env, 'VITE_ZERO_WS_URL', 'ws://127.0.0.1:8787'),
    clientName: readString(env, 'VITE_ZERO_CLIENT_NAME', 'brain_interface'),
    clientVersion: readString(env, 'VITE_ZERO_CLIENT_VERSION', '0.1.0'),
    experimentalApi: readBoolean(env, 'VITE_ZERO_EXPERIMENTAL_API', true),
    extraCwds: readList(env, 'VITE_ZERO_CWDS'),
    threadLimit: Math.max(1, Math.trunc(readNumber(env, 'VITE_ZERO_THREAD_LIMIT', 40))),
    refreshIntervalMs: Math.max(2_000, readNumber(env, 'VITE_ZERO_REFRESH_INTERVAL_MS', 20_000)),
    backgroundImage: readString(
      env,
      'VITE_ZERO_BACKGROUND_IMAGE',
      '/assets/brain-background.png',
    ),
    voice: {
      provider,
      preferredVoices: readList(env, 'VITE_ZERO_VOICE_NAMES'),
      rate: readNumber(env, 'VITE_ZERO_VOICE_RATE', 0.92),
      pitch: readNumber(env, 'VITE_ZERO_VOICE_PITCH', 0.82),
      volume: readNumber(env, 'VITE_ZERO_VOICE_VOLUME', 1),
      speakAgentMessages: readBoolean(env, 'VITE_ZERO_VOICE_SPEAK_AGENT_MESSAGES', false),
      prompt: readString(env, 'VITE_ZERO_VOICE_PROMPT', ZERO_VOICE_PROMPT),
    },
  };
}

export const config: BrainInterfaceConfig = resolveConfig(
  (typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as unknown as EnvRecord)
    : {}) as EnvRecord,
);
