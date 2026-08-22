/**
 * `/ws/voice` — the voice channel to HWD-ZERO.
 *
 *   microphone → speech-to-text → voice.partial / voice.final ──▶ HWD-ZERO
 *   HWD-ZERO ──▶ voice.state / voice.response / voice.audio (PCM16) ──▶ brain
 *
 * The channel carries no logic of its own: it forwards what the microphone
 * produced and surfaces what the operator answered. It never decides which
 * agent runs, never starts a process and never invents audio — when the
 * operator does not implement the channel it reports `unavailable` and the
 * interface degrades to the documented fallbacks.
 */
import type { VoiceAudioChunk, VoiceClientFrame, VoiceServerFrame } from './types';

export type VoiceChannelStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'unavailable';

export interface VoiceChannelHandlers {
  onStatus?: (status: VoiceChannelStatus, detail?: string) => void;
  /** The operator's own runtime state, when it reports one. */
  onState?: (state: string, detail?: string) => void;
  /** Server-side recognition (only when the operator does the STT). */
  onPartial?: (text: string) => void;
  onTranscript?: (text: string, final: boolean) => void;
  onResponse?: (text: string, missionId?: string) => void;
  onAudio?: (chunk: VoiceAudioChunk) => void;
  onAudioEnd?: () => void;
  onError?: (message: string) => void;
}

export interface VoiceChannelOptions {
  openSocket: () => WebSocket;
  language: string;
  clientName?: string;
  reconnectDelayMs?: number;
  /**
   * Consecutive failed connects after which the channel gives up and reports
   * `unavailable`. A backend without `/ws/voice` must not be retried forever.
   */
  maxAttempts?: number;
}

/** Default PCM format when the operator streams binary frames without a header. */
export const DEFAULT_AUDIO_FORMAT = { sampleRate: 24_000, channels: 1 } as const;

/** Decode base64 into bytes in both the browser and Node (tests). */
export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const buffer = Buffer.from(base64, 'base64');
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** Reinterpret a byte run as little-endian PCM16 samples. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const frames = Math.floor(bytes.length / 2);
  const samples = new Int16Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frames; i += 1) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

/** Interleaved PCM16 → planar float32 in −1..1, ready for an AudioBuffer. */
export function pcm16ToPlanarFloat(samples: Int16Array, channels: number): Float32Array[] {
  const count = Math.max(1, channels);
  const frames = Math.floor(samples.length / count);
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < count; channel += 1) planes.push(new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const plane = planes[channel];
      if (plane) plane[frame] = (samples[frame * count + channel] ?? 0) / 32768;
    }
  }
  return planes;
}

/**
 * Parse one frame off the wire. Text frames are the JSON protocol; binary
 * frames are raw PCM16 in the format the last `voice.audio` announcement set.
 * Anything unparseable is dropped rather than rendered as half an event.
 */
export function parseVoiceFrame(
  data: unknown,
  format: { sampleRate: number; channels: number },
): { frame: VoiceServerFrame } | { audio: VoiceAudioChunk } | null {
  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['type'] !== 'string') return null;
    return { frame: parsed as VoiceServerFrame };
  }

  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          )
        : null;
  if (!bytes || bytes.length < 2) return null;
  return {
    audio: {
      samples: bytesToPcm16(bytes),
      sampleRate: format.sampleRate,
      channels: format.channels,
    },
  };
}

export class VoiceChannel {
  private socket: WebSocket | null = null;
  private status: VoiceChannelStatus = 'idle';
  private attempts = 0;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everOpened = false;
  private format = { ...DEFAULT_AUDIO_FORMAT } as { sampleRate: number; channels: number };
  private readonly queue: VoiceClientFrame[] = [];

  constructor(
    private readonly options: VoiceChannelOptions,
    private readonly handlers: VoiceChannelHandlers = {},
  ) {}

  get currentStatus(): VoiceChannelStatus {
    return this.status;
  }

  /** True once the operator has actually accepted a voice socket. */
  get isAvailable(): boolean {
    return this.status === 'open';
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private setStatus(status: VoiceChannelStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  private open(): void {
    if (this.closedByUs || this.socket) return;
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = this.options.openSocket();
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.everOpened = true;
      this.setStatus('open');
      this.send({
        type: 'voice.hello',
        language: this.options.language,
        client: this.options.clientName ?? 'brain-interface',
      });
      for (const frame of this.queue.splice(0)) this.send(frame);
    };

    socket.onmessage = (message: MessageEvent) => {
      const parsed = parseVoiceFrame(message.data, this.format);
      if (!parsed) return;
      if ('audio' in parsed) {
        this.handlers.onAudio?.(parsed.audio);
        return;
      }
      this.dispatch(parsed.frame);
    };

    socket.onerror = () => {
      // `onclose` always follows; the reason is reported there.
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.closedByUs) {
        this.setStatus('closed');
        return;
      }
      this.failed(this.everOpened ? 'voice channel closed' : 'operator has no /ws/voice endpoint');
    };
  }

  private failed(detail: string): void {
    this.socket = null;
    this.attempts += 1;
    const maxAttempts = this.options.maxAttempts ?? 3;
    // A backend that never had the endpoint is not retried forever: the
    // interface says so once and falls back to the documented tiers.
    if (!this.everOpened && this.attempts >= maxAttempts) {
      this.setStatus('unavailable', detail);
      return;
    }
    this.setStatus('closed', detail);
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.options.reconnectDelayMs ?? 2_000);
  }

  private dispatch(frame: VoiceServerFrame): void {
    switch (frame.type) {
      case 'voice.state':
        this.handlers.onState?.(frame.state, frame.detail);
        return;
      case 'voice.partial':
        this.handlers.onPartial?.(frame.text ?? '');
        return;
      case 'voice.transcript':
        this.handlers.onTranscript?.(frame.text ?? '', frame.final !== false);
        return;
      case 'voice.response':
        this.handlers.onResponse?.(frame.text ?? '', frame.mission_id);
        return;
      case 'voice.audio': {
        // A frame without `data` announces the format of the binary frames
        // that follow; a frame with `data` carries base64 PCM16 itself.
        this.format = {
          sampleRate: frame.sample_rate ?? this.format.sampleRate,
          channels: frame.channels ?? this.format.channels,
        };
        if (!frame.data) return;
        this.handlers.onAudio?.({
          samples: bytesToPcm16(base64ToBytes(frame.data)),
          sampleRate: this.format.sampleRate,
          channels: this.format.channels,
        });
        return;
      }
      case 'voice.audio.end':
        this.handlers.onAudioEnd?.();
        return;
      case 'voice.error':
        this.handlers.onError?.(frame.message ?? 'voice error');
        return;
      default:
        return;
    }
  }

  /** Queues while connecting, so a fast speaker never loses the first frame. */
  send(frame: VoiceClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      if (this.status === 'unavailable') return;
      // Only the meaningful frames are worth queueing; partials go stale.
      if (frame.type !== 'voice.partial') this.queue.push(frame);
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queue.length = 0;
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }
}
