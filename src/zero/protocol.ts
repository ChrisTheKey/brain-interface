/**
 * Wire types for the ZERO app-server JSON-RPC API.
 *
 * These mirror the schemas that ZERO itself generates
 * (`codex-rs/app-server-protocol/schema/json/v2/*.json`, also obtainable at
 * runtime via `codex app-server generate-json-schema`). Only the parts the
 * Brain Interface consumes are modelled here; everything unknown is kept as
 * `unknown` instead of being invented.
 *
 * Transport note: ZERO speaks JSON-RPC 2.0 *without* the `"jsonrpc": "2.0"`
 * field on the wire (see `jsonrpc_lite.rs`), which is why the envelope types
 * below have no `jsonrpc` member.
 */

export type RequestId = string | number;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  id: RequestId;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcError;

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && 'result' in message;
}

export function isJsonRpcError(message: JsonRpcMessage): message is JsonRpcError {
  return 'id' in message && 'error' in message;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && 'method' in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) && 'method' in message;
}

/* -------------------------------------------------------------------------- */
/* initialize                                                                  */
/* -------------------------------------------------------------------------- */

export interface InitializeParams {
  clientInfo: { name: string; title?: string | null; version: string };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[] | null;
  };
}

export interface InitializeResponse {
  userAgent: string;
}

/* -------------------------------------------------------------------------- */
/* threads = agents / sub-agents                                               */
/* -------------------------------------------------------------------------- */

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] };

export interface ThreadSpawnSubAgentSource {
  thread_spawn: {
    parent_thread_id: string;
    depth: number;
    agent_role?: string | null;
    agent_nickname?: string | null;
  };
}

export type SubAgentSource =
  | 'review'
  | 'compact'
  | 'memory_consolidation'
  | ThreadSpawnSubAgentSource
  | { other: string };

export type SessionSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown'
  | { subAgent: SubAgentSource };

export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface GitInfo {
  commitHash?: string | null;
  branch?: string | null;
  repositoryUrl?: string | null;
}

export interface Thread {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt?: number;
  modelProvider: string;
  cliVersion?: string;
  ephemeral?: boolean;
  name?: string | null;
  path?: string | null;
  source?: SessionSource;
  status?: ThreadStatus;
  gitInfo?: GitInfo | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  turns?: Turn[];
}

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

export interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  error?: { message: string } | null;
}

export type CollabAgentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent';

export type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';

/** Only the item variants the Brain Interface renders are typed explicitly. */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'userMessage'; id: string; content: unknown[] }
  | { type: 'reasoning'; id: string; summary?: unknown; content?: unknown }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd?: string;
      status: string;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | { type: 'fileChange'; id: string; changes: { path: string; kind: string }[]; status: string }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: 'inProgress' | 'completed' | 'failed';
      arguments?: unknown;
      error?: unknown;
    }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: CollabAgentTool;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt?: string | null;
      agentsStates: Record<string, { status: CollabAgentStatus; message?: string | null }>;
    }
  | { type: 'webSearch'; id: string; query: string }
  | { type: string; id: string; [key: string]: unknown };

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number;
  sortKey?: 'created_at' | 'updated_at';
  sourceKinds?: ThreadSourceKind[];
  archived?: boolean | null;
  cwd?: string | null;
  searchTerm?: string | null;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor?: string | null;
}

export interface ThreadLoadedListResponse {
  data: string[];
}

export interface ThreadReadResponse {
  thread: Thread;
}

/* -------------------------------------------------------------------------- */
/* skills = knowledge bases                                                    */
/* -------------------------------------------------------------------------- */

export type SkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface SkillToolDependency {
  type: string;
  value: string;
  description?: string | null;
  transport?: string | null;
  command?: string | null;
  url?: string | null;
}

export interface SkillInterface {
  displayName?: string | null;
  shortDescription?: string | null;
  iconSmall?: string | null;
  iconLarge?: string | null;
  brandColor?: string | null;
  defaultPrompt?: string | null;
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
  shortDescription?: string | null;
  interface?: SkillInterface | null;
  dependencies?: { tools: SkillToolDependency[] } | null;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: { path: string; message: string }[];
}

export interface SkillsListResponse {
  data: SkillsListEntry[];
}

/* -------------------------------------------------------------------------- */
/* MCP servers = tools + sources                                               */
/* -------------------------------------------------------------------------- */

export type McpAuthStatus = 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth';

export interface McpTool {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface McpResource {
  name: string;
  uri: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

export interface McpResourceTemplate {
  name: string;
  uriTemplate: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
}

export interface McpServerStatus {
  name: string;
  authStatus: McpAuthStatus;
  tools: Record<string, McpTool>;
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
}

export interface ListMcpServerStatusResponse {
  data: McpServerStatus[];
  nextCursor?: string | null;
}

/* -------------------------------------------------------------------------- */
/* apps (connectors)                                                           */
/* -------------------------------------------------------------------------- */

export interface AppSummary {
  id: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  installUrl?: string | null;
  isAccessible?: boolean;
  isEnabled?: boolean;
}

export interface AppsListResponse {
  data: AppSummary[];
  nextCursor?: string | null;
}

/* -------------------------------------------------------------------------- */
/* account + config (ZERO itself)                                              */
/* -------------------------------------------------------------------------- */

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: string };

export interface GetAccountResponse {
  account?: Account | null;
  requiresOpenaiAuth: boolean;
}

export interface ConfigReadResponse {
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelListResponse {
  data?: { id?: string; model?: string; displayName?: string | null }[];
  nextCursor?: string | null;
}

/* -------------------------------------------------------------------------- */
/* realtime (voice)                                                            */
/* -------------------------------------------------------------------------- */

export interface ThreadRealtimeAudioChunk {
  /** base64-encoded PCM16 samples. */
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel?: number | null;
}

export interface ThreadRealtimeOutputAudioDelta {
  threadId: string;
  audio: ThreadRealtimeAudioChunk;
}

/* -------------------------------------------------------------------------- */
/* notification payloads consumed for live activity                            */
/* -------------------------------------------------------------------------- */

export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

export interface ItemNotification {
  threadId?: string;
  turnId?: string;
  item: ThreadItem;
}

export interface TurnNotification {
  threadId?: string;
  turn: Turn;
}

export interface TokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: { totalTokens: number; inputTokens: number; outputTokens: number };
    last: { totalTokens: number };
    modelContextWindow?: number | null;
  };
}

export const ZERO_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  configRead: 'config/read',
  modelList: 'model/list',
  threadList: 'thread/list',
  threadLoadedList: 'thread/loaded/list',
  threadRead: 'thread/read',
  threadResume: 'thread/resume',
  threadStart: 'thread/start',
  threadUnsubscribe: 'thread/unsubscribe',
  skillsList: 'skills/list',
  mcpServerStatusList: 'mcpServerStatus/list',
  appList: 'app/list',
  realtimeStart: 'thread/realtime/start',
  realtimeAppendText: 'thread/realtime/appendText',
  realtimeStop: 'thread/realtime/stop',
} as const;
