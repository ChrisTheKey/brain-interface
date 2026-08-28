import { ZERO_VOICE_PROMPT } from './voice/provider';

/**
 * Runtime configuration. Every backend address comes from the environment –
 * nothing about ZERO's location is hardcoded in the interface.
 */

export interface BrainInterfaceConfig {
  /**
   * WebSocket endpoint of ZERO's app-server, always absolute.
   *
   * A relative value (`/zero-ws`) is resolved against the page's own origin,
   * which is the only form that works on a second device: `ws://127.0.0.1:8787`
   * is evaluated *in the browser*, so on a phone it means the phone's own
   * loopback. Through the gateway the address is whatever served the page.
   */
  zeroWsUrl: string;
  clientName: string;
  clientVersion: string;
  /** Opt into ZERO's experimental API (required for thread realtime / voice). */
  experimentalApi: boolean;
  /** Extra workspace roots to scope `skills/list` to, beyond the ones ZERO's threads report. */
  extraCwds: string[];
  /** How many threads to pull per source kind. */
  threadLimit: number;
  /** Structural refresh interval; live changes still arrive via notifications. */
  refreshIntervalMs: number;
  /** Fullscreen background asset. */
  backgroundImage: string;
  /** Where ZERO finds the agent repositories it can address. */
  agents: {
    /** Directory that holds the agent repositories (scanned through ZERO). */
    root: string;
    /** Optional manifest with ids/roles/capabilities; defaults to <root>/zero-agents.json. */
    manifestPath: string;
    /** Sandbox policy used for the read-only discovery command. */
    execSandbox: 'readOnly' | 'externalSandbox' | 'workspaceWrite';
    /** Sandbox mode for agent threads ZERO starts. */
    threadSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** cwd of the thread ZERO uses to route a request to an agent. */
    orchestratorCwd: string;
    /** Hard timeout for a single agent invocation. */
    invokeTimeoutMs: number;
    /** Timeout for ZERO's routing decision. */
    routeTimeoutMs: number;
  };
  speech: {
    /** Speech-to-text provider for microphone input. */
    provider: 'web-speech' | 'none';
    language: string;
  };
  /** The hands-free conversation at `/voice`. */
  voiceMode: {
    /**
     * Keep listening after ZERO has answered, so a conversation continues
     * without touching the machine. Off means one turn per click.
     */
    continuous: boolean;
    /** Pause between ZERO finishing and the microphone re-opening. */
    restartDelayMs: number;
    /** Start listening as soon as `/voice` is opened (needs a prior gesture). */
    autoStart: boolean;
  };
  voice: {
    provider: VoiceProviderChoice;
    /** Substring match against `speechSynthesis.getVoices()` names. */
    preferredVoices: string[];
    rate: number;
    pitch: number;
    volume: number;
    /** Speak ZERO's completed agent messages as they stream in. */
    speakAgentMessages: boolean;
    /** Session prompt that defines ZERO's voice character (realtime provider). */
    prompt: string;
    /**
     * Fish Audio. No key here: the gateway holds it and the interface only
     * ever talks to its own origin (see server/fishAudio.mjs).
     */
    fish: {
      /** Gateway endpoint that proxies Fish Audio. */
      endpoint: string;
      /** Fish Audio voice model ("reference id"); empty uses the model default. */
      voiceId: string;
      model: string;
      latency: 'normal' | 'balanced' | 'low';
      /** `pcm` is what makes the smoke react — it goes through the audio graph. */
      format: 'pcm' | 'mp3' | 'wav' | 'opus';
      sampleRate: number;
      speed: number;
    };
  };
  /** ZERO's internet access, through the operator's own browser. */
  browser: {
    /** Gateway endpoint of the browser bridge. */
    endpoint: string;
    /** Browser used when a request does not name one. */
    preferred: 'chrome' | 'firefox' | 'brave' | 'edge';
  };
}

/** Voice providers, in the order the service falls back through them. */
export type VoiceProviderChoice = 'zero-realtime' | 'fish-audio' | 'speech-synthesis' | 'none';

const VOICE_PROVIDERS: readonly VoiceProviderChoice[] = [
  'zero-realtime',
  'fish-audio',
  'speech-synthesis',
  'none',
];

const BROWSERS = ['chrome', 'firefox', 'brave', 'edge'] as const;

type EnvRecord = Record<string, string | boolean | undefined>;

/** Just enough of `window.location` to build an absolute WebSocket URL. */
export interface PageLocation {
  protocol: string;
  host: string;
}

/**
 * Turns the configured ZERO endpoint into an absolute WebSocket URL.
 *
 * `ws://…` and `wss://…` are used as they are. A path (`/zero-ws`) is resolved
 * against the page origin, so the same build works on the laptop and on a
 * phone: both reach the gateway that served them, and the gateway carries the
 * connection to the app-server on its own loopback.
 */
export function resolveZeroWsUrl(configured: string, location?: PageLocation): string {
  const value = configured.trim();
  if (/^wss?:\/\//i.test(value)) return value;
  if (!value.startsWith('/')) return value;
  if (!location?.host) {
    // No page to resolve against (tests, SSR): keep the path, so the caller
    // sees what was configured instead of a wrong absolute address.
    return value;
  }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${value}`;
}

function readString(env: EnvRecord, key: string, fallback: string): string {
  const value = env[key];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readNumber(env: EnvRecord, key: string, fallback: number): number {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(env: EnvRecord, key: string, fallback: boolean): boolean {
  const raw = readString(env, key, '').toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readList(env: EnvRecord, key: string): string[] {
  return readString(env, key, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolveConfig(env: EnvRecord, location?: PageLocation): BrainInterfaceConfig {
  const agentRoot = readString(env, 'VITE_ZERO_AGENT_ROOT', '');
  const execSandboxRaw = readString(env, 'VITE_ZERO_EXEC_SANDBOX', 'readOnly');
  const execSandbox =
    execSandboxRaw === 'externalSandbox' || execSandboxRaw === 'workspaceWrite'
      ? execSandboxRaw
      : 'readOnly';
  const threadSandboxRaw = readString(env, 'VITE_ZERO_AGENT_SANDBOX', 'read-only');
  const threadSandbox =
    threadSandboxRaw === 'workspace-write' || threadSandboxRaw === 'danger-full-access'
      ? threadSandboxRaw
      : 'read-only';
  const speechRaw = readString(env, 'VITE_ZERO_SPEECH_PROVIDER', 'web-speech');
  const providerRaw = readString(env, 'VITE_ZERO_VOICE_PROVIDER', 'zero-realtime');
  const provider = VOICE_PROVIDERS.includes(providerRaw as VoiceProviderChoice)
    ? (providerRaw as VoiceProviderChoice)
    : 'zero-realtime';
  const latencyRaw = readString(env, 'VITE_ZERO_FISH_LATENCY', 'balanced');
  const fishLatency =
    latencyRaw === 'normal' || latencyRaw === 'low' || latencyRaw === 'balanced'
      ? latencyRaw
      : 'balanced';
  const fishFormatRaw = readString(env, 'VITE_ZERO_FISH_FORMAT', 'pcm');
  const fishFormat =
    fishFormatRaw === 'mp3' || fishFormatRaw === 'wav' || fishFormatRaw === 'opus'
      ? fishFormatRaw
      : 'pcm';
  const browserRaw = readString(env, 'VITE_ZERO_BROWSER', 'chrome');
  const preferredBrowser = BROWSERS.includes(browserRaw as (typeof BROWSERS)[number])
    ? (browserRaw as (typeof BROWSERS)[number])
    : 'chrome';

  return {
    zeroWsUrl: resolveZeroWsUrl(readString(env, 'VITE_ZERO_WS_URL', 'ws://127.0.0.1:8787'), location),
    clientName: readString(env, 'VITE_ZERO_CLIENT_NAME', 'brain_interface'),
    clientVersion: readString(env, 'VITE_ZERO_CLIENT_VERSION', '0.1.0'),
    experimentalApi: readBoolean(env, 'VITE_ZERO_EXPERIMENTAL_API', true),
    extraCwds: readList(env, 'VITE_ZERO_CWDS'),
    threadLimit: Math.max(1, Math.trunc(readNumber(env, 'VITE_ZERO_THREAD_LIMIT', 40))),
    refreshIntervalMs: Math.max(2_000, readNumber(env, 'VITE_ZERO_REFRESH_INTERVAL_MS', 20_000)),
    backgroundImage: readString(
      env,
      'VITE_ZERO_BACKGROUND_IMAGE',
      '/reference/red-background.jpg',
    ),
    agents: {
      root: agentRoot,
      manifestPath: readString(
        env,
        'VITE_ZERO_AGENT_MANIFEST',
        agentRoot ? `${agentRoot.replace(/\/+$/, '')}/zero-agents.json` : '',
      ),
      execSandbox,
      threadSandbox,
      orchestratorCwd: readString(env, 'VITE_ZERO_ORCHESTRATOR_CWD', agentRoot),
      invokeTimeoutMs: Math.max(5_000, readNumber(env, 'VITE_ZERO_AGENT_TIMEOUT_MS', 180_000)),
      routeTimeoutMs: Math.max(5_000, readNumber(env, 'VITE_ZERO_ROUTE_TIMEOUT_MS', 60_000)),
    },
    speech: {
      provider: speechRaw === 'none' ? 'none' : 'web-speech',
      language: readString(env, 'VITE_ZERO_SPEECH_LANGUAGE', 'de-DE'),
    },
    voiceMode: {
      continuous: readBoolean(env, 'VITE_ZERO_VOICE_MODE_CONTINUOUS', true),
      restartDelayMs: Math.max(0, readNumber(env, 'VITE_ZERO_VOICE_MODE_RESTART_MS', 600)),
      autoStart: readBoolean(env, 'VITE_ZERO_VOICE_MODE_AUTOSTART', false),
    },
    voice: {
      provider,
      preferredVoices: readList(env, 'VITE_ZERO_VOICE_NAMES'),
      rate: readNumber(env, 'VITE_ZERO_VOICE_RATE', 0.92),
      pitch: readNumber(env, 'VITE_ZERO_VOICE_PITCH', 0.82),
      volume: readNumber(env, 'VITE_ZERO_VOICE_VOLUME', 1),
      speakAgentMessages: readBoolean(env, 'VITE_ZERO_VOICE_SPEAK_AGENT_MESSAGES', false),
      prompt: readString(env, 'VITE_ZERO_VOICE_PROMPT', ZERO_VOICE_PROMPT),
      fish: {
        endpoint: readString(env, 'VITE_ZERO_FISH_ENDPOINT', '/api/voice/fish'),
        voiceId: readString(env, 'VITE_ZERO_FISH_VOICE_ID', ''),
        model: readString(env, 'VITE_ZERO_FISH_MODEL', 's2.1-pro'),
        latency: fishLatency,
        format: fishFormat,
        sampleRate: Math.trunc(readNumber(env, 'VITE_ZERO_FISH_SAMPLE_RATE', 44_100)),
        speed: readNumber(env, 'VITE_ZERO_FISH_SPEED', 0.94),
      },
    },
    browser: {
      endpoint: readString(env, 'VITE_ZERO_BROWSER_ENDPOINT', '/api/browser'),
      preferred: preferredBrowser,
    },
  };
}

export const config: BrainInterfaceConfig = resolveConfig(
  (typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as unknown as EnvRecord)
    : {}) as EnvRecord,
  typeof globalThis !== 'undefined' && 'location' in globalThis
    ? (globalThis.location as unknown as PageLocation)
    : undefined,
);
