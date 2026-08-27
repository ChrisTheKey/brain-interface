/** Types for the gateway-side Fish Audio proxy (plain Node ESM). */

export interface FishConfig {
  /** Present in the gateway process only; never serialised to the browser. */
  apiKey: string;
  configured: boolean;
  apiUrl: string;
  model: string;
  voiceId: string;
  latency: string;
  format: string;
  sampleRate: number;
  speed: number;
  volume: number;
  requestTimeoutMs: number;
}

export interface FishSpeakRequest {
  text?: string;
  voiceId?: string;
  model?: string;
  latency?: string;
  format?: string;
  sampleRate?: number;
  speed?: number;
  volume?: number;
}

export interface FishTtsRequestBody {
  text: string;
  format: string;
  sample_rate: number;
  latency: string;
  normalize: boolean;
  prosody: { speed: number; volume: number };
  reference_id?: string;
  mp3_bitrate?: number;
}

export interface FishStatus {
  provider: 'fish-audio';
  configured: boolean;
  model: string;
  voiceId: string | null;
  format: string;
  sampleRate: number;
  latency: string;
  reason?: string;
}

export interface FishVoice {
  id: string;
  title: string;
  languages: string[];
  description?: string;
}

export declare const FISH_API_URL: string;
export declare const FISH_DEFAULT_MODEL: string;

export declare class FishRequestError extends Error {
  constructor(message: string, status?: number);
  readonly status: number;
}

export declare function readFishConfig(env?: Record<string, string | undefined>): FishConfig;
export declare function buildTtsRequest(
  body: FishSpeakRequest,
  config: FishConfig,
): { request: FishTtsRequestBody; format: string; sampleRate: number; model: string };
export declare function fishStatus(config: FishConfig): FishStatus;
export declare function requestSpeech(
  body: FishSpeakRequest,
  config: FishConfig,
  fetchImpl?: typeof fetch,
): Promise<{ response: Response; format: string; sampleRate: number; release: () => void }>;
export declare function listVoices(
  config: FishConfig,
  query?: string,
  fetchImpl?: typeof fetch,
): Promise<FishVoice[]>;
