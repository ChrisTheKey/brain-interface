/**
 * The voice socket: microphone bytes out, transcripts back.
 *
 * One socket per push-to-talk turn. That is a deliberate simplification — the
 * server finalizes and closes after `stop`, so there is no ambiguity about
 * which utterance a transcript belongs to, and a dropped connection cannot
 * splice two turns together.
 *
 * Same origin, like everything else the browser touches. Audio from the phone
 * reaches HWD-ZERO through the gateway; the bundle never learns an internal
 * port, and microphone audio never leaves this machine unless the operator
 * configured a provider that sends it.
 */
import { zeroVoiceWsUrl } from '../zero/endpoints';

export type VoiceSocketState = 'connecting' | 'open' | 'closed' | 'error';

/** Why the socket refused, in the same vocabulary the server reports. */
export interface VoiceReadiness {
  voice: 'ready' | 'degraded';
  stt: { ready: boolean; reason: string; detail: string; remedy: string };
  transport?: { path: string };
}

export interface VoiceTransportHandlers {
  /** The server's opening statement: whether it can hear at all. */
  onReady: (readiness: VoiceReadiness) => void;
  /** A correction of the previous partial, never an addition to it. */
  onPartial: (text: string) => void;
  /** The transcript ZERO may act on. Arrives exactly once. */
  onFinal: (text: string, confidence: number | null) => void;
  onState?: (state: VoiceSocketState) => void;
  onError?: (reason: string, detail: string) => void;
}

export interface VoiceTransportOptions {
  language?: string;
  /** Injected for tests; defaults to the browser WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  /** Injected for tests; defaults to `zeroVoiceWsUrl`. */
  urlFor?: (query: { session: string; language?: string }) => string;
}

let sessionCounter = 0;

/** A short id for this turn. Only ever used to correlate one socket's frames. */
function nextSessionId(): string {
  sessionCounter += 1;
  return `ui-${sessionCounter}-${Math.floor(Date.now() / 1000)}`;
}

export class VoiceTransport {
  private socket: WebSocket | null = null;
  private state: VoiceSocketState = 'closed';
  private finalSeen = false;
  readonly sessionId = nextSessionId();

  constructor(
    private readonly handlers: VoiceTransportHandlers,
    private readonly options: VoiceTransportOptions = {},
  ) {}

  get socketState(): VoiceSocketState {
    return this.state;
  }

  /** True only once the server said it can hear and the socket is open. */
  get canSend(): boolean {
    return this.state === 'open' && this.socket?.readyState === 1;
  }

  open(): void {
    const url = (this.options.urlFor ?? ((query) => zeroVoiceWsUrl(query)))({
      session: this.sessionId,
      language: this.options.language,
    });
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = (this.options.socketFactory ?? ((value) => new WebSocket(value)))(url);
    } catch (error) {
      this.setState('error');
      this.handlers.onError?.('voice_socket_failed', String(error));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => this.setState('open');
    socket.onerror = () =>
      this.handlers.onError?.('voice_socket_disconnected', 'the voice socket errored');
    socket.onclose = () => {
      this.socket = null;
      this.setState('closed');
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let message: { type?: string; payload?: Record<string, unknown> };
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // an unreadable frame is dropped, never rendered as a transcript
      }
      const payload = message.payload ?? {};
      switch (message.type) {
        case 'voice.ready':
          this.handlers.onReady(payload as unknown as VoiceReadiness);
          return;
        case 'voice.transcript.partial':
          if (typeof payload['text'] === 'string') this.handlers.onPartial(payload['text']);
          return;
        case 'voice.transcript.final': {
          if (payload['ok'] === false) {
            this.handlers.onError?.(
              String(payload['reason'] ?? 'stt_offline'),
              String(payload['detail'] ?? ''),
            );
            return;
          }
          // Exactly once: a second final for the same turn would run the
          // command twice.
          if (this.finalSeen) return;
          this.finalSeen = true;
          this.handlers.onFinal(
            String(payload['text'] ?? ''),
            typeof payload['confidence'] === 'number' ? payload['confidence'] : null,
          );
          return;
        }
        case 'voice.audio.dropped':
          // Dropped audio is worth knowing about — it usually means ZERO was
          // speaking — but it is not an error the operator must act on.
          return;
        default:
          return;
      }
    };
  }

  /** Send one chunk. Silently ignored when the socket is not ready for it. */
  send(pcm16: Int16Array): void {
    if (!this.canSend || !this.socket) return;
    try {
      this.socket.send(pcm16.buffer as ArrayBuffer);
    } catch {
      /* the close handler reports the state */
    }
  }

  /** End the utterance and ask for the final transcript. */
  stop(): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify({ type: 'stop' }));
    } catch {
      this.close();
    }
  }

  /** Abandon the turn without finalizing — the interrupt path. */
  cancel(): void {
    if (this.socket) {
      try {
        this.socket.send(JSON.stringify({ type: 'cancel' }));
      } catch {
        /* closing anyway */
      }
    }
    this.close();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    this.setState('closed');
  }

  private setState(state: VoiceSocketState): void {
    this.state = state;
    this.handlers.onState?.(state);
  }
}
