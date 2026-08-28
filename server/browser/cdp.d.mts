/** Types for the Chrome DevTools Protocol session (plain Node ESM). */
import type { ExtractionOptions } from './extract.d.mts';

export interface PageContent {
  url: string;
  title: string;
  description: string;
  text: string;
  truncated: boolean;
  characters: number;
  links: { text: string; href: string }[];
}

export declare function waitForDevTools(
  port: number,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ webSocketDebuggerUrl: string; Browser?: string }>;

export declare class CdpSession {
  constructor(options: { webSocketDebuggerUrl: string; timeoutMs?: number });
  readonly isOpen: boolean;
  open(): Promise<this>;
  send(method: string, params?: unknown, sessionId?: string): Promise<Record<string, unknown>>;
  navigate(url: string, options?: { waitMs?: number }): Promise<Record<string, unknown>>;
  evaluate(expression: string): Promise<unknown>;
  read(options?: ExtractionOptions): Promise<PageContent>;
  close(): Promise<void>;
}
