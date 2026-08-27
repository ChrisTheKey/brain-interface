/** Types for the WebDriver BiDi session — Firefox (plain Node ESM). */
import type { ExtractionOptions } from './extract.d.mts';
import type { PageContent } from './cdp.d.mts';

export interface BidiHandshake {
  sessionId: string;
  webSocketUrl: string;
  capabilities: Record<string, unknown>;
}

export declare function createBidiSession(
  port: number,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<BidiHandshake>;

export declare class BidiSession {
  constructor(options: { webSocketUrl: string; sessionId?: string; timeoutMs?: number });
  readonly isOpen: boolean;
  open(): Promise<this>;
  send(method: string, params?: unknown): Promise<Record<string, unknown>>;
  navigate(url: string): Promise<Record<string, unknown>>;
  evaluate(expression: string): Promise<unknown>;
  read(options?: ExtractionOptions): Promise<PageContent>;
  close(): Promise<void>;
}

/** Turns BiDi's tagged value representation back into plain JSON. */
export declare function deserialize(node: unknown): unknown;
