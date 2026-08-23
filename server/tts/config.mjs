/**
 * Where ZERO's cloud voice is configured, and where its key stays.
 *
 * Every value here is read by the gateway process and by nothing else. There
 * is deliberately no `VITE_` variant of any of it: a `VITE_` value is compiled
 * into the bundle the browser downloads, and an API key in a bundle is an API
 * key published. The browser asks the gateway to speak; the gateway is what
 * holds the credential.
 *
 * Two switches are stronger than everything else here. `ZERO_LOCAL_ONLY=true`
 * blocks the cloud call even with a key present and a provider configured —
 * "local only" has to mean it, or it is decoration. And `FISH_AUDIO_ENABLED`
 * defaults to off, so a checkout that happens to inherit a key in its
 * environment does not start sending text to a third party.
 */

/**
 * Fish Audio's free tier, as of writing.
 *
 * Named rather than assumed permanent: if the provider stops accepting it the
 * gateway reports FREE MODEL UNAVAILABLE and falls back. It never quietly
 * upgrades to a paid model — nobody's voice should arrive with an invoice.
 */
export const FREE_MODEL = 's2.1-pro-free';

/** Models known to bill. Reaching one requires saying so out loud. */
export const PAID_MODELS = new Set(['s2.1-pro', 's2-pro', 's1']);

/**
 * The public Fish Audio voices ZERO ships knowing about.
 *
 * Confirmed against the live model API rather than read off a page: each is
 * `type: tts`, `state: trained`, `visibility: public`. Neither declares German
 * in its metadata — see the README before expecting it to speak German well.
 * None of these was cloned, trained or uploaded by this project.
 */
export const KNOWN_VOICES = [
  {
    id: '306c68e5763b42d6b06fe0380daa5281',
    name: 'Lelouch Vi Britannia',
    author: 'Universal',
    languages: ['en'],
    character: 'male, middle-aged, authoritative, dramatic, clear, cinematic',
  },
  {
    id: '349b7618384141f780d21e119624783f',
    name: 'Lelouch',
    author: 'Jatteks',
    languages: ['en'],
    character: 'male, middle-aged, dark, dramatic, authoritative, measured',
  },
];

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Resolve the voice configuration from the environment.
 *
 * Returns a plain object with no secret in it beyond `apiKey`, which is never
 * put in a response, a log line or an error message.
 */
export function loadTtsConfig(env = process.env) {
  const localOnly = flag(env.ZERO_LOCAL_ONLY, false);
  const enabled = flag(env.FISH_AUDIO_ENABLED, false);
  const apiKey = (env.FISH_API_KEY ?? '').trim();
  const model = (env.FISH_AUDIO_MODEL ?? '').trim() || FREE_MODEL;
  const voiceId = (env.FISH_AUDIO_VOICE_ID ?? '').trim();
  const voiceName = (env.FISH_AUDIO_VOICE_NAME ?? '').trim();
  const known = KNOWN_VOICES.find((voice) => voice.id === voiceId);

  return {
    provider: (env.ZERO_TTS_PROVIDER ?? 'fish_audio').trim() || 'fish_audio',
    fallback: (env.ZERO_TTS_FALLBACK ?? 'browser').trim() || 'browser',
    localOnly,
    enabled,
    apiKey,
    hasKey: apiKey.length > 0,
    model,
    // Paid models are reachable, but only by writing one down. Nothing
    // upgrades on its own when the free tier says no.
    paid: PAID_MODELS.has(model),
    voiceId,
    voiceName: voiceName || known?.name || (voiceId ? 'configured voice' : ''),
    voiceLanguages: known?.languages ?? [],
    timeoutMs: Number(env.FISH_AUDIO_TIMEOUT_MS ?? 20000) || 20000,
    endpoint: (env.FISH_AUDIO_ENDPOINT ?? 'https://api.fish.audio/v1/tts').trim(),
    cacheEntries: Number(env.FISH_AUDIO_CACHE ?? 0) || 0,
  };
}

/**
 * Why the cloud voice cannot be used, or null when it can.
 *
 * Ordered so the operator is told the *first* thing to fix rather than the
 * last thing that failed.
 */
export function unavailableReason(config) {
  if (config.localOnly) return 'local_only';
  if (config.provider !== 'fish_audio') return 'provider_disabled';
  if (!config.enabled) return 'fish_disabled';
  if (!config.hasKey) return 'fish_api_key_missing';
  if (!config.voiceId) return 'fish_voice_not_configured';
  return null;
}

/** The status payload. Contains no key, and never will. */
export function publicStatus(config) {
  const reason = unavailableReason(config);
  return {
    provider: config.provider,
    configured: config.enabled && config.hasKey && Boolean(config.voiceId),
    ready: reason === null,
    reason,
    model: config.model,
    free_model: !config.paid,
    voice_id: config.voiceId,
    voice_name: config.voiceName,
    voice_languages: config.voiceLanguages,
    fallback: config.fallback,
    // The one fact the interface must never soften: this sends text off the
    // machine.
    cloud: reason === null,
    local_only: config.localOnly,
  };
}
