/** Types for the minimal RFC 6455 client (plain Node ESM, no build step). */
import type { EventEmitter } from 'node:events';

export interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export interface DecodedFrames {
  frames: WebSocketFrame[];
  /** Bytes of a frame that has not fully arrived yet. */
  rest: Buffer;
}

export interface WebSocketClientOptions {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
}

export interface WebSocketMessage {
  data: string | Buffer;
  binary: boolean;
}

export declare const OPCODE: {
  continuation: number;
  text: number;
  binary: number;
  close: number;
  ping: number;
  pong: number;
};

export declare function acceptKey(key: string): string;
export declare function encodeFrame(
  opcode: number,
  payload: string | Buffer,
  mask?: Buffer,
): Buffer;
export declare function decodeFrames(buffer: Buffer): DecodedFrames;

export declare class WebSocketClient extends EventEmitter {
  constructor(url: string, options?: WebSocketClientOptions);
  readonly url: URL;
  readonly isOpen: boolean;
  connect(): Promise<this>;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  destroy(): void;
}
