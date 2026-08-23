/** Types for the voice configuration, which is plain Node ESM. */

export interface KnownVoice {
  id: string;
  name: string;
  author: string;
  languages: string[];
  character: string;
}

export interface TtsConfig {
  provider: string;
  fallback: string;
  localOnly: boolean;
  enabled: boolean;
  /** Never serialised, never logged, never returned. */
  apiKey: string;
  hasKey: boolean;
  model: string;
  paid: boolean;
  voiceId: string;
  voiceName: string;
  voiceLanguages: string[];
  timeoutMs: number;
  endpoint: string;
  cacheEntries: number;
}

export interface TtsPublicStatus {
  provider: string;
  configured: boolean;
  ready: boolean;
  reason: string | null;
  model: string;
  free_model: boolean;
  voice_id: string;
  voice_name: string;
  voice_languages: string[];
  fallback: string;
  cloud: boolean;
  local_only: boolean;
}

export const FREE_MODEL: string;
export const PAID_MODELS: Set<string>;
export const KNOWN_VOICES: KnownVoice[];

export function loadTtsConfig(env?: Record<string, string | undefined>): TtsConfig;
export function unavailableReason(config: TtsConfig): string | null;
export function publicStatus(config: TtsConfig): TtsPublicStatus;
