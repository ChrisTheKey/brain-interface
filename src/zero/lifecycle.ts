/**
 * Reconnect triggers that are not timers.
 *
 * A phone does not "lose" a connection politely: the screen turns off, the OS
 * freezes the tab, the radio switches from WiFi to mobile, and the socket is
 * simply gone. Waiting for the next backoff tick can mean staring at a dead
 * brain for fifteen seconds after unlocking the device. So the moment the
 * browser says it is back — `online`, tab visible again, page restored from
 * the back/forward cache, window focused — the connection is re-checked.
 *
 * Coalesced, because unlocking a phone fires several of these at once.
 */

export interface WakeTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WakeOptions {
  /** Defaults to `window`. */
  window?: WakeTarget;
  /** Defaults to `document`; only `visibilitychange` is read from it. */
  document?: (WakeTarget & { visibilityState?: string }) | null;
  /** Ignore a second wake within this window, in ms. */
  coalesceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const WINDOW_EVENTS = ['online', 'focus', 'pageshow'] as const;

/**
 * Calls `handler` whenever the browser comes back to life. Returns an
 * unsubscribe function; safe to call outside a browser (it becomes a no-op).
 */
export function onNetworkWake(handler: () => void, options: WakeOptions = {}): () => void {
  const win = options.window ?? (typeof window !== 'undefined' ? window : null);
  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== 'undefined'
        ? document
        : null;
  if (!win && !doc) return () => {};

  const coalesceMs = options.coalesceMs ?? 250;
  const setTimer = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeoutFn ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pending: unknown = null;
  const fire = (): void => {
    if (pending !== null) return;
    pending = setTimer(() => {
      pending = null;
      handler();
    }, coalesceMs);
  };

  const onVisibility = (): void => {
    // Hiding the tab is not a wake-up; only coming back is.
    if (doc?.visibilityState === 'hidden') return;
    fire();
  };

  for (const event of WINDOW_EVENTS) win?.addEventListener(event, fire);
  doc?.addEventListener('visibilitychange', onVisibility);

  return () => {
    if (pending !== null) {
      clearTimer(pending);
      pending = null;
    }
    for (const event of WINDOW_EVENTS) win?.removeEventListener(event, fire);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Bounded exponential backoff: 1s, 2s, 4s, 8s, then 15s forever.
 *
 * Bounded on both ends on purpose. The lower bound keeps a refused connection
 * from becoming a request flood several times per second; the upper bound
 * keeps a laptop that comes back after lunch from waiting minutes.
 */
export class Backoff {
  private current: number;

  constructor(
    readonly minMs = 1_000,
    readonly maxMs = 15_000,
  ) {
    this.current = minMs;
  }

  /** The delay to wait now, then doubles for the next failure. */
  next(): number {
    const delay = this.current;
    this.current = Math.min(this.current * 2, this.maxMs);
    return delay;
  }

  /** Back to the first step — called after a connection actually succeeded. */
  reset(): void {
    this.current = this.minMs;
  }

  get peek(): number {
    return this.current;
  }
}
