/** Types for the Fish Audio provider, which is plain Node ESM. */
import type { TtsConfig } from './config.d.mts';

export interface FishRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FishSuccess {
  ok: true;
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  model: string;
  voiceId: string;
}

export interface FishFailure {
  ok: false;
  code: string;
  status?: number;
  detail?: string;
}

export interface SynthesizeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxAttempts?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  overrides?: Record<string, unknown>;
}

export const FISH_ERRORS: {
  MISSING_KEY: string;
  AUTH: string;
  VOICE: string;
  FREE_MODEL: string;
  RATE_LIMIT: string;
  TIMEOUT: string;
  API: string;
  AUDIO: string;
  OFFLINE: string;
  LOCAL_ONLY: string;
};
export const ZERO_PROSODY: Record<string, unknown>;

export function buildRequest(
  text: string,
  config: TtsConfig,
  overrides?: Record<string, unknown>,
): FishRequest;
export function classifyFailure(status: number, bodyText?: string): string;
export function isTransient(code: string): boolean;
export function retryDelayMs(headers: { get?: (name: string) => string | null } | null, attempt: number): number;
export function synthesize(
  text: string,
  config: TtsConfig,
  options?: SynthesizeOptions,
): Promise<FishSuccess | FishFailure>;
export function redact(text: string, config: Partial<TtsConfig> | Record<string, never>): string;
export function isFreeModel(model: string): boolean;
