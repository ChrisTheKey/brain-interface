/**
 * ZERO's cloud voice, played through ZERO's own audio graph.
 *
 * Two things make this more than a `new Audio(url)`:
 *
 * **The key is not here.** The browser POSTs the answer text to the gateway
 * and the gateway is what holds `FISH_API_KEY`. Nothing in this file knows a
 * credential, and there is no `VITE_FISH_*` anywhere — a `VITE_` value is
 * compiled into the bundle, and a key in a bundle is a key published.
 *
 * **The audio goes through the analyser.** `createMediaElementSource` puts
 * Fish Audio's output on the same node the smoke, the filaments and the core
 * already read, so the brain reacts to ZERO's actual voice rather than to a
 * timer pretending to be one. That connection is the whole reason this is a
 * `VoiceProvider` and not a fetch call somewhere in a component.
 *
 * Playback is buffered rather than streamed. Fish Audio can stream, and the
 * gateway passes the stream through, but starting playback mid-download needs
 * MediaSource with chunked MP3 appending — which is browser-specific, hard to
 * verify without a device, and fails silently when it fails. A voice that
 * starts half a second later is a worse experience than one that starts
 * immediately; a voice that never starts is a worse one than both.
 */
import type { VoiceProvider, VoiceSpeakOptions } from './provider';

export interface FishAudioStatus {
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

export interface FishAudioProviderOptions {
  fetchImpl?: typeof fetch;
  /** Injected in tests; the browser supplies its own. */
  createAudio?: () => HTMLAudioElement;
  statusPath?: string;
  speakPath?: string;
}

const STATUS_PATH = '/api/voice/tts/status';
const SPEAK_PATH = '/api/voice/tts';

export class FishAudioVoiceProvider implements VoiceProvider {
  readonly id = 'fish-audio' as const;
  readonly label = 'Fish Audio';

  private status: FishAudioStatus | null = null;
  private context: AudioContext | null = null;
  private destination: AudioNode | null = null;
  private element: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private objectUrl: string | null = null;
  private reason: string | undefined;

  constructor(private readonly options: FishAudioProviderOptions = {}) {}

  get unavailableReason(): string | undefined {
    return this.reason;
  }

  /** What the gateway says about itself. Cached: it is read on every turn. */
  async readStatus(force = false): Promise<FishAudioStatus | null> {
    if (this.status && !force) return this.status;
    const send = this.options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    try {
      const response = await send(this.options.statusPath ?? STATUS_PATH);
      if (!response.ok) {
        this.reason = `the gateway answered ${response.status} for the voice status`;
        return null;
      }
      this.status = (await response.json()) as FishAudioStatus;
      if (!this.status.ready) this.reason = describeReason(this.status.reason);
      return this.status;
    } catch (error) {
      this.reason = `the voice status could not be read: ${String(error)}`;
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const status = await this.readStatus(true);
    return status?.ready === true;
  }

  connect(context: AudioContext, destination: AudioNode): boolean {
    this.context = context;
    this.destination = destination;
    // True, and it has to be true: returning false here is what makes the
    // smoke sit at its floor instead of moving with the voice.
    return true;
  }

  async speak(text: string, options: VoiceSpeakOptions = {}): Promise<void> {
    const spoken = text.trim();
    if (!spoken) return;
    const send = this.options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

    // Only the sentence. No history, no mission log, no agent list, no audio.
    const response = await send(this.options.speakPath ?? SPEAK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
      signal: options.signal,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      // Thrown on purpose: the voice service catches this and hands the same
      // sentence to the next provider, with the text still on screen.
      throw new Error(describeReason(payload.error ?? `tts_http_${response.status}`));
    }

    const blob = await response.blob();
    if (blob.size === 0) throw new Error(describeReason('fish_invalid_audio'));
    await this.play(blob, options.signal);
  }

  private async play(blob: Blob, signal?: AbortSignal): Promise<void> {
    const context = this.context;
    const destination = this.destination;
    if (!context || !destination) throw new Error('the audio graph is not connected');

    if (!this.element) {
      this.element = this.options.createAudio?.() ?? new Audio();
      this.element.crossOrigin = 'anonymous';
      this.element.preload = 'auto';
      // Created once and reused: an element may only be attached to one
      // MediaElementSource for its whole life, and a second attempt throws.
      this.source = context.createMediaElementSource(this.element);
      this.source.connect(destination);
    }
    const element = this.element;

    this.revoke();
    this.objectUrl = URL.createObjectURL(blob);
    element.src = this.objectUrl;

    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(describeReason('fish_invalid_audio')));
      };
      const stopped = (): void => {
        cleanup();
        element.pause();
        resolve();
      };
      function cleanup(): void {
        element.removeEventListener('ended', done);
        element.removeEventListener('error', failed);
        signal?.removeEventListener('abort', stopped);
      }
      element.addEventListener('ended', done, { once: true });
      element.addEventListener('error', failed, { once: true });
      signal?.addEventListener('abort', stopped, { once: true });
      void element.play().catch(failed);
    });
  }

  stop(): void {
    this.element?.pause();
    if (this.element) this.element.currentTime = 0;
  }

  dispose(): void {
    this.stop();
    this.revoke();
    this.source?.disconnect();
    this.source = null;
    this.element = null;
    this.context = null;
    this.destination = null;
  }

  private revoke(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

/** Every failure the gateway can name, as something an operator can act on. */
export function describeReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'local_only':
      return 'ZERO_LOCAL_ONLY is on — nothing is sent to a cloud voice.';
    case 'fish_disabled':
      return 'Fish Audio is switched off (FISH_AUDIO_ENABLED).';
    case 'provider_disabled':
      return 'ZERO_TTS_PROVIDER does not select Fish Audio.';
    case 'fish_api_key_missing':
      return 'Fish Audio needs an API key. Set FISH_API_KEY where the gateway runs.';
    case 'fish_voice_not_configured':
      return 'No Fish Audio voice is configured. Set FISH_AUDIO_VOICE_ID.';
    case 'fish_auth_failed':
      return 'Fish Audio rejected the API key.';
    case 'fish_voice_not_found':
      return 'Fish Audio does not know that voice id.';
    case 'fish_free_model_unavailable':
      return 'FISH AUDIO FREE MODEL UNAVAILABLE — falling back rather than using a paid model.';
    case 'fish_rate_limited':
      return 'Fish Audio is rate limiting; ZERO is using the local voice for now.';
    case 'fish_timeout':
      return 'Fish Audio did not answer in time.';
    case 'fish_invalid_audio':
      return 'Fish Audio returned something that is not playable audio.';
    case 'fish_network_offline':
      return 'Fish Audio could not be reached.';
    default:
      return reason ? `Fish Audio is unavailable (${reason}).` : 'Fish Audio is unavailable.';
  }
}
