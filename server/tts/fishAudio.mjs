/**
 * Fish Audio, as a thing the gateway does on the browser's behalf.
 *
 * The whole reason this runs server-side is the key. `FISH_API_KEY` must never
 * reach the bundle, so the browser POSTs text to the gateway and the gateway
 * is what talks to api.fish.audio. That also makes the network policy
 * enforceable in one place: the only thing that leaves this process is the
 * sentence ZERO decided to say, plus the parameters needed to say it. No
 * conversation history, no mission log, no agent registry, no microphone audio.
 *
 * Everything that can go wrong has a name. A voice that fails must degrade to
 * the browser's own synthesiser with the text still on screen — a cloud TTS
 * outage is not a reason for ZERO to go silent, and it is certainly not a
 * reason for the turn to fail.
 */
import { FREE_MODEL } from './config.mjs';

/** The contract, as published: POST, bearer auth, model in a header. */
const CONTENT_TYPE_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  pcm: 'application/octet-stream',
};

export const FISH_ERRORS = {
  MISSING_KEY: 'fish_api_key_missing',
  AUTH: 'fish_auth_failed',
  VOICE: 'fish_voice_not_found',
  FREE_MODEL: 'fish_free_model_unavailable',
  RATE_LIMIT: 'fish_rate_limited',
  TIMEOUT: 'fish_timeout',
  API: 'fish_api_error',
  AUDIO: 'fish_invalid_audio',
  OFFLINE: 'fish_network_offline',
  LOCAL_ONLY: 'local_only',
};

/**
 * ZERO's delivery, expressed in the parameters the API actually has.
 *
 * The voice character lives in the reference voice; these only stop the model
 * from undoing it. Slightly slow and fairly deterministic: measured and
 * controlled rather than theatrical, and the same sentence twice should not
 * arrive as two different performances.
 */
export const ZERO_PROSODY = Object.freeze({
  temperature: 0.6,
  top_p: 0.75,
  prosody: Object.freeze({ speed: 0.94, volume: 0 }),
});

/**
 * The request body, built and returned separately so a test can read it
 * without a network call — and so it is obvious at a glance that nothing but
 * the text goes out.
 */
export function buildRequest(text, config, overrides = {}) {
  const body = {
    text,
    format: 'mp3',
    mp3_bitrate: 128,
    normalize: true,
    // `balanced` favours quality; the gateway is on loopback and the round
    // trip to the operator's ear is dominated by generation anyway.
    latency: 'balanced',
    ...ZERO_PROSODY,
    ...overrides,
  };
  if (config.voiceId) body.reference_id = config.voiceId;
  return {
    url: config.endpoint,
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      // The model is a header, not a body field. Getting this wrong silently
      // bills the default model instead of the free one.
      model: config.model,
    },
    body,
  };
}

/** Map a transport or HTTP failure onto a name the interface has words for. */
export function classifyFailure(status, bodyText = '') {
  const detail = (bodyText || '').slice(0, 300).toLowerCase();
  if (status === 401 || status === 403) return FISH_ERRORS.AUTH;
  if (status === 402) return FISH_ERRORS.FREE_MODEL;
  if (status === 404) return FISH_ERRORS.VOICE;
  if (status === 429) return FISH_ERRORS.RATE_LIMIT;
  if (status === 400 || status === 422) {
    // A rejected model on the free tier reads as a validation error, and
    // treating it as a generic API fault would hide the one thing the
    // operator needs to know.
    if (detail.includes('model') || detail.includes('free') || detail.includes('quota')) {
      return FISH_ERRORS.FREE_MODEL;
    }
    if (detail.includes('reference') || detail.includes('voice')) return FISH_ERRORS.VOICE;
    return FISH_ERRORS.API;
  }
  return FISH_ERRORS.API;
}

/** Only these are worth a second attempt. Everything else is an answer. */
export function isTransient(code) {
  return code === FISH_ERRORS.API || code === FISH_ERRORS.TIMEOUT || code === FISH_ERRORS.OFFLINE;
}

/** How long to wait before retrying a 429, from the header when it gives one. */
export function retryDelayMs(headers, attempt) {
  const header = headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 4000);
}

/**
 * Speak one sentence.
 *
 * Returns `{ ok: true, body, contentType }` where `body` is the upstream
 * response stream — passed through rather than buffered, so the gateway does
 * not hold a whole answer's audio in memory on a phone.
 */
export async function synthesize(text, config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spoken = (text ?? '').trim();
  if (!spoken) return { ok: false, code: FISH_ERRORS.AUDIO, detail: 'nothing to say' };
  if (config.localOnly) {
    // The one check that must come before everything, key or no key.
    return { ok: false, code: FISH_ERRORS.LOCAL_ONLY, detail: 'ZERO_LOCAL_ONLY is set' };
  }
  if (!config.hasKey) {
    return { ok: false, code: FISH_ERRORS.MISSING_KEY, detail: 'FISH_API_KEY is not set' };
  }

  const maxAttempts = options.maxAttempts ?? 2;
  let last = { ok: false, code: FISH_ERRORS.API, detail: 'not attempted' };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const request = buildRequest(spoken, config, options.overrides);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    // The caller giving up must cancel the upstream call too, or a stopped
    // answer keeps generating and keeps costing.
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });

      if (response.ok) {
        return {
          ok: true,
          body: response.body,
          contentType:
            response.headers?.get?.('content-type') ||
            CONTENT_TYPE_BY_FORMAT[request.body.format] ||
            'audio/mpeg',
          model: config.model,
          voiceId: config.voiceId,
        };
      }

      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const code = classifyFailure(response.status, detail);
      last = { ok: false, code, status: response.status, detail: redact(detail, config) };

      if (code === FISH_ERRORS.RATE_LIMIT && attempt + 1 < maxAttempts) {
        await sleep(retryDelayMs(response.headers, attempt), options.sleepImpl);
        continue;
      }
      if (!isTransient(code) || attempt + 1 >= maxAttempts) return last;
      await sleep(retryDelayMs(response.headers, attempt), options.sleepImpl);
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      const external = aborted && options.signal?.aborted;
      const code = aborted ? FISH_ERRORS.TIMEOUT : FISH_ERRORS.OFFLINE;
      last = { ok: false, code, detail: redact(String(error?.message ?? error), config) };
      // Stopped on purpose: not a failure to retry, and not a fallback either.
      if (external) return { ok: false, code: 'aborted', detail: 'cancelled by the caller' };
      if (attempt + 1 >= maxAttempts) return last;
      await sleep(retryDelayMs(null, attempt), options.sleepImpl);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  return last;
}

function sleep(ms, sleepImpl) {
  if (sleepImpl) return sleepImpl(ms);
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Strip anything key-shaped out of a message before it is logged or returned.
 *
 * Belt and braces: the key is never deliberately put anywhere, and an upstream
 * error that happens to echo the Authorization header back would defeat that
 * on its own.
 */
export function redact(text, config) {
  let output = String(text ?? '');
  if (config?.apiKey) output = output.split(config.apiKey).join('[redacted]');
  return output.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

/** Is the configured model the free one? Used to refuse a silent upgrade. */
export function isFreeModel(model) {
  return model === FREE_MODEL;
}
