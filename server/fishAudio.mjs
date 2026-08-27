/**
 * Fish Audio — ZERO's spoken voice.
 *
 *     browser  ──▶  gateway /api/voice/fish/*  ──▶  api.fish.audio
 *
 * The gateway is in this path for one reason: the Fish Audio API key. It stays
 * in the gateway process, is never sent to the browser and never reaches the
 * bundle — the same rule the rest of this repository follows for every
 * upstream credential. The interface only ever asks its own origin to speak.
 *
 * The audio is requested as raw PCM16 and relayed as it arrives, so the
 * provider can push it straight into the Web Audio graph: the voice starts
 * before the sentence is finished, and the smoke analyses the exact signal
 * the operator hears.
 *
 * Reference: POST https://api.fish.audio/v1/tts, bearer auth, `model` header.
 */

export const FISH_API_URL = 'https://api.fish.audio';
export const FISH_DEFAULT_MODEL = 's2.1-pro';

/** Sample rates Fish Audio accepts; anything else is refused upstream. */
const SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 44100, 48000]);
const FORMATS = new Set(['pcm', 'mp3', 'wav', 'opus']);
const LATENCIES = new Set(['normal', 'balanced', 'low']);
const MAX_TEXT_LENGTH = 8_000;

export function readFishConfig(env = process.env) {
  const key = (env.FISH_AUDIO_API_KEY ?? '').trim();
  return {
    apiKey: key,
    configured: key.length > 0,
    apiUrl: (env.FISH_AUDIO_API_URL ?? FISH_API_URL).replace(/\/+$/, ''),
    model: (env.FISH_AUDIO_MODEL ?? FISH_DEFAULT_MODEL).trim(),
    /** The Fish Audio voice model ("reference id") ZERO speaks with. */
    voiceId: (env.FISH_AUDIO_VOICE_ID ?? '').trim(),
    latency: (env.FISH_AUDIO_LATENCY ?? 'balanced').trim(),
    format: (env.FISH_AUDIO_FORMAT ?? 'pcm').trim(),
    sampleRate: Number(env.FISH_AUDIO_SAMPLE_RATE ?? 44100),
    /** Prosody: ZERO speaks a touch below neutral speed. */
    speed: Number(env.FISH_AUDIO_SPEED ?? 0.94),
    volume: Number(env.FISH_AUDIO_VOLUME ?? 0),
    requestTimeoutMs: Number(env.FISH_AUDIO_TIMEOUT_MS ?? 60_000),
  };
}

/**
 * Builds the upstream request body. Exported so the mapping from the
 * interface's request to Fish Audio's schema is testable without the network.
 */
export function buildTtsRequest(body, config) {
  const text = String(body?.text ?? '').trim();
  if (text.length === 0) throw new FishRequestError('text is required', 400);
  if (text.length > MAX_TEXT_LENGTH) {
    throw new FishRequestError(`text exceeds ${MAX_TEXT_LENGTH} characters`, 413);
  }

  const format = FORMATS.has(body?.format) ? body.format : config.format;
  if (!FORMATS.has(format)) throw new FishRequestError(`unsupported format "${format}"`, 400);

  const requestedRate = Number(body?.sampleRate ?? config.sampleRate);
  const sampleRate = SAMPLE_RATES.has(requestedRate) ? requestedRate : 44100;

  const latency = LATENCIES.has(body?.latency) ? body.latency : config.latency;
  const referenceId = String(body?.voiceId ?? config.voiceId ?? '').trim();

  const request = {
    text,
    format,
    sample_rate: sampleRate,
    latency: LATENCIES.has(latency) ? latency : 'balanced',
    normalize: true,
    prosody: {
      speed: clampNumber(body?.speed ?? config.speed, 0.5, 2),
      volume: clampNumber(body?.volume ?? config.volume, -20, 20),
    },
  };
  // A missing reference id is valid: Fish Audio then uses the model's own
  // default speaker rather than failing.
  if (referenceId.length > 0) request.reference_id = referenceId;
  if (format === 'mp3') request.mp3_bitrate = 128;

  return { request, format, sampleRate, model: String(body?.model ?? config.model) };
}

export class FishRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FishRequestError';
    this.status = status;
  }
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

/** What the interface may know about Fish Audio: everything except the key. */
export function fishStatus(config) {
  return {
    provider: 'fish-audio',
    configured: config.configured,
    model: config.model,
    voiceId: config.voiceId || null,
    format: config.format,
    sampleRate: config.sampleRate,
    latency: config.latency,
    ...(config.configured
      ? {}
      : { reason: 'FISH_AUDIO_API_KEY is not set on the gateway — Fish Audio voice is off' }),
  };
}

/**
 * Calls Fish Audio and hands back the streaming response. The caller pipes it
 * to the browser; nothing is buffered here.
 */
export async function requestSpeech(body, config, fetchImpl = fetch) {
  if (!config.configured) {
    throw new FishRequestError('FISH_AUDIO_API_KEY is not configured on the gateway', 503);
  }
  const { request, format, sampleRate, model } = buildTtsRequest(body, config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.apiUrl}/v1/tts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        model,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error?.name === 'AbortError';
    throw new FishRequestError(
      aborted ? `Fish Audio did not answer within ${config.requestTimeoutMs}ms` : `Fish Audio is unreachable: ${error.message}`,
      504,
    );
  }

  if (!response.ok) {
    clearTimeout(timer);
    const detail = await response.text().catch(() => '');
    // The upstream status is passed through so the interface can tell an
    // exhausted balance (402) from a bad key (401).
    throw new FishRequestError(
      `Fish Audio refused the request (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      response.status === 401 || response.status === 402 ? response.status : 502,
    );
  }

  return { response, format, sampleRate, release: () => clearTimeout(timer) };
}

/** The Fish Audio voice models available to this key. */
export async function listVoices(config, query = '', fetchImpl = fetch) {
  if (!config.configured) {
    throw new FishRequestError('FISH_AUDIO_API_KEY is not configured on the gateway', 503);
  }
  const url = new URL(`${config.apiUrl}/model`);
  url.searchParams.set('page_size', '30');
  if (query.trim().length > 0) url.searchParams.set('title', query.trim());

  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new FishRequestError(`Fish Audio model list failed (HTTP ${response.status})`, 502);
  }
  const body = await response.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.map((item) => ({
    id: item._id ?? item.id ?? '',
    title: item.title ?? '',
    languages: item.languages ?? [],
    ...(item.description ? { description: String(item.description).slice(0, 240) } : {}),
  }));
}
