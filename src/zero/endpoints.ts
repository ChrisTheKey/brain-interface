/**
 * Where the browser talks to ZERO.
 *
 * Exactly one rule: **same origin, always**. The page was served by the ZERO
 * gateway, so the gateway is also what answers `/api` and `/ws`. The bundle
 * therefore contains no host, no port and no scheme of its own — it derives
 * every endpoint from the address the user actually opened.
 *
 * That is not a stylistic choice. A hardcoded `ws://127.0.0.1:8787` means
 * "this device" on every device: on the Samsung Galaxy it points the phone at
 * the phone, never at the laptop running HWD-ZERO. Deriving from
 * `window.location` makes all three deployments work from the same build:
 *
 *     http://127.0.0.1:3000        →  ws://127.0.0.1:3000/ws
 *     http://192.168.1.23:3000     →  ws://192.168.1.23:3000/ws
 *     https://zero-host            →  wss://zero-host/ws
 *
 * The internal port HWD-ZERO listens on is a gateway concern and is never
 * shipped to the browser.
 */

/** The part of `window.location` these helpers depend on. */
export interface LocationLike {
  readonly protocol: string;
  readonly host: string;
}

/** Public base for every HTTP call the interface makes. */
export const ZERO_API_BASE = '/api';

/** Public path of ZERO's runtime event/RPC socket. */
export const ZERO_RUNTIME_WS_PATH = '/ws';

/** Public path of HWD-ZERO's operator event stream. */
export const ZERO_EVENTS_WS_PATH = '/ws/events';

/** Public path of HWD-ZERO's voice transport: microphone audio in, transcripts out. */
export const ZERO_VOICE_WS_PATH = '/ws/voice';

/** Public path of the gateway's composite health probe. */
export const ZERO_HEALTH_PATH = '/api/health';

/**
 * `https:` pages may only open `wss:`. Getting this wrong does not degrade —
 * the browser blocks the connection outright as mixed content.
 */
export function wsProtocolFor(pageProtocol: string): 'ws:' | 'wss:' {
  return pageProtocol === 'https:' ? 'wss:' : 'ws:';
}

function normalisePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** Absolute WebSocket URL for a public path, on the origin that served us. */
export function sameOriginWsUrl(path: string, location: LocationLike): string {
  if (!location.host) {
    throw new Error(`cannot resolve ${path}: the page has no origin host`);
  }
  return `${wsProtocolFor(location.protocol)}//${location.host}${normalisePath(path)}`;
}

/**
 * Public HTTP path. Deliberately relative: `fetch('/api/health')` is resolved
 * by the browser against the current origin, which is what we want, and it
 * keeps the value readable in tests and diagnostics.
 */
export function apiPath(path = ''): string {
  if (path === '') return ZERO_API_BASE;
  return `${ZERO_API_BASE}${normalisePath(path)}`;
}

function browserLocation(): LocationLike {
  if (typeof window === 'undefined' || !window.location) {
    throw new Error('ZERO endpoints need a browser origin (window.location)');
  }
  return window.location;
}

/** `ws(s)://<this origin>/ws` — the ZERO runtime, through the gateway. */
export function zeroRuntimeWsUrl(location: LocationLike = browserLocation()): string {
  return sameOriginWsUrl(ZERO_RUNTIME_WS_PATH, location);
}

/** `ws(s)://<this origin>/ws/events` — HWD-ZERO's operator stream. */
export function zeroEventsWsUrl(location: LocationLike = browserLocation()): string {
  return sameOriginWsUrl(ZERO_EVENTS_WS_PATH, location);
}

/**
 * `ws(s)://<this origin>/ws/voice` — the microphone transport.
 *
 * Same-origin like everything else, so audio from the phone reaches HWD-ZERO
 * through the gateway and never through an internal port the browser would
 * have to know.
 */
export function zeroVoiceWsUrl(
  query: { session?: string; language?: string } = {},
  location: LocationLike = browserLocation(),
): string {
  const parameters = new URLSearchParams();
  if (query.session) parameters.set('session', query.session);
  if (query.language) parameters.set('language', query.language);
  const search = parameters.toString();
  return `${sameOriginWsUrl(ZERO_VOICE_WS_PATH, location)}${search ? `?${search}` : ''}`;
}
