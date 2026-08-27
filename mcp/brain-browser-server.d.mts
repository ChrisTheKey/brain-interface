/** Types for the ZERO Browser MCP server (plain Node ESM). */
import type { Interface } from 'node:readline';

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/**
 * Which fields a result carries depends on the method, so they are all
 * optional here rather than hidden behind `any`.
 */
export interface McpResult {
  /** initialize */
  protocolVersion?: string;
  capabilities?: { tools?: { listChanged?: boolean } };
  serverInfo?: { name: string; title?: string; version: string };
  instructions?: string;
  /** tools/list */
  tools?: McpTool[];
  /** tools/call */
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: McpResult;
  error?: { code: number; message: string };
}

export declare const TOOLS: McpTool[];

/** Renders a gateway result as the text an agent reads. */
export declare function renderResult(toolName: string, result: Record<string, unknown>): string;

/** Handles one JSON-RPC message; returns null for a notification. */
export declare function handleMessage(
  message: JsonRpcMessage,
  deps?: { fetch?: typeof fetch },
): Promise<McpResponse | null>;

export declare function serve(
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Interface;
