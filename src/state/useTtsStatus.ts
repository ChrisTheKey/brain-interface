/**
 * Which voice is speaking, and where the words go.
 *
 * Read from the gateway rather than from a build-time flag, because the only
 * process that knows whether a Fish Audio key exists is the one holding it.
 * The answer is also the one thing the interface must never soften: when the
 * cloud voice is active, ZERO's replies leave the machine, and saying so is
 * not optional.
 */
import { useEffect, useState } from 'react';
import type { FishAudioStatus } from '../voice/fishAudioProvider';

export function useTtsStatus(fetchImpl?: typeof fetch): FishAudioStatus | null {
  const [status, setStatus] = useState<FishAudioStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const send = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    void send('/api/voice/tts/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setStatus(payload as FishAudioStatus | null);
      })
      .catch(() => {
        // The gateway not answering is not worth a banner: the voice falls
        // back on its own and the interface says LOCAL.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  return status;
}

/** The compact line the operator reads. Cloud or local, never ambiguous. */
export function ttsSummary(status: FishAudioStatus | null): {
  mode: 'CLOUD — FISH AUDIO' | 'LOCAL';
  voice: string;
  model: string;
  fallback: string;
  note: string;
} {
  if (status?.ready) {
    return {
      mode: 'CLOUD — FISH AUDIO',
      voice: status.voice_name || status.voice_id,
      model: status.model.toUpperCase(),
      fallback: status.fallback.toUpperCase(),
      // Short, and it stays visible for as long as the cloud voice is on.
      note: 'VOICE TEXT SENT TO FISH AUDIO',
    };
  }
  return {
    mode: 'LOCAL',
    voice: 'browser speech',
    model: '—',
    fallback: (status?.fallback ?? 'browser').toUpperCase(),
    note: status?.local_only === true ? 'LOCAL ONLY — nothing leaves this machine' : '',
  };
}
