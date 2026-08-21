import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backoff, onNetworkWake } from '../src/zero/lifecycle';
import { ZeroClient, type ZeroSocket } from '../src/zero/client';
import { HwdZeroClient } from '../src/hwd/client';
import { withZeroStatus } from '../src/graph/transform';
import { buildGraph } from '../src/graph/transform';

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnect backoff', () => {
  it('grows 1s, 2s, 4s, 8s and then holds at the ceiling', () => {
    const backoff = new Backoff(1_000, 15_000);
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    // Bounded: a laptop that comes back after lunch waits 15s, not an hour.
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([15_000, 15_000, 15_000]);
  });

  it('never reconnects several times per second', () => {
    const backoff = new Backoff(1_000, 15_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(backoff.next()).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('returns to the first step once a connection actually succeeded', () => {
    const backoff = new Backoff(1_000, 15_000);
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

/** A fake WebSocket that records the URL it was asked to open. */
class FakeEventSocket {
  static opened: FakeEventSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSocket.opened.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

describe('operator event stream reconnect', () => {
  it('backs off exponentially after repeated drops', () => {
    vi.useFakeTimers();
    FakeEventSocket.opened = [];
    const client = new HwdZeroClient({
      baseUrl: 'http://operator.test',
      reconnectDelayMs: 1_000,
      maxReconnectDelayMs: 15_000,
      socketFactory: (url) => new FakeEventSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: () => {} });
    expect(FakeEventSocket.opened).toHaveLength(1);

    // First drop → 1s. Nothing happens earlier than that.
    FakeEventSocket.opened.at(-1)!.onclose?.();
    vi.advanceTimersByTime(999);
    expect(FakeEventSocket.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSocket.opened).toHaveLength(2);

    // Second drop without a successful open → 2s, not 1s again.
    FakeEventSocket.opened.at(-1)!.onclose?.();
    vi.advanceTimersByTime(1_999);
    expect(FakeEventSocket.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSocket.opened).toHaveLength(3);

    stop();
  });

  it('resets the delay once the stream opened again', () => {
    vi.useFakeTimers();
    FakeEventSocket.opened = [];
    const client = new HwdZeroClient({
      baseUrl: 'http://operator.test',
      reconnectDelayMs: 1_000,
      socketFactory: (url) => new FakeEventSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: () => {} });

    FakeEventSocket.opened.at(-1)!.onclose?.();
    vi.advanceTimersByTime(1_000);
    FakeEventSocket.opened.at(-1)!.onopen?.();
    FakeEventSocket.opened.at(-1)!.onclose?.();
    // Back to the first step, because the connection had genuinely worked.
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSocket.opened).toHaveLength(3);
    stop();
  });

  it('reconnects at once when the browser reports it woke up', () => {
    vi.useFakeTimers();
    FakeEventSocket.opened = [];
    const client = new HwdZeroClient({
      baseUrl: 'http://operator.test',
      reconnectDelayMs: 15_000,
      socketFactory: (url) => new FakeEventSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: () => {} });
    FakeEventSocket.opened.at(-1)!.onclose?.();

    // The phone unlocks: the dead socket is replaced now, not in 15 seconds.
    client.reconnectNow();
    expect(FakeEventSocket.opened).toHaveLength(2);
    stop();
  });

  it('stops for good once unsubscribed', () => {
    vi.useFakeTimers();
    FakeEventSocket.opened = [];
    const client = new HwdZeroClient({
      baseUrl: 'http://operator.test',
      socketFactory: (url) => new FakeEventSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: () => {} });
    stop();
    FakeEventSocket.opened.at(-1)!.onclose?.();
    vi.advanceTimersByTime(60_000);
    client.reconnectNow();
    expect(FakeEventSocket.opened).toHaveLength(1);
  });
});

/** Minimal runtime socket, enough to drive the ZeroClient state machine. */
class FakeRuntimeSocket implements ZeroSocket {
  static opened: FakeRuntimeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeRuntimeSocket.opened.push(this);
  }

  send(): void {}
  close(): void {
    this.onclose?.({});
  }
}

describe('ZERO runtime client', () => {
  it('resolves its URL per attempt, so a moved origin is picked up', () => {
    FakeRuntimeSocket.opened = [];
    let host = '127.0.0.1:3000';
    const client = new ZeroClient({
      url: () => `ws://${host}/ws`,
      clientInfo: { name: 'test', version: '0' },
      socketFactory: (url) => new FakeRuntimeSocket(url),
    });
    void client.connect().catch(() => {});
    expect(FakeRuntimeSocket.opened.at(-1)?.url).toBe('ws://127.0.0.1:3000/ws');

    // The page is now open from the phone, over the LAN.
    host = '192.168.1.23:3000';
    FakeRuntimeSocket.opened.at(-1)!.onclose?.({});
    client.reconnectNow();
    expect(FakeRuntimeSocket.opened.at(-1)?.url).toBe('ws://192.168.1.23:3000/ws');
  });

  it('does not claim ZERO answered just because a socket opened', () => {
    FakeRuntimeSocket.opened = [];
    const client = new ZeroClient({
      url: 'ws://origin.test/ws',
      clientInfo: { name: 'test', version: '0' },
      socketFactory: (url) => new FakeRuntimeSocket(url),
    });
    void client.connect().catch(() => {});
    FakeRuntimeSocket.opened.at(-1)!.onopen?.({});
    // `initialize` was sent but nothing came back yet.
    expect(client.hasResponded).toBe(false);
  });
});

describe('browser wake-ups', () => {
  it('fires once for the burst of events an unlock produces', () => {
    vi.useFakeTimers();
    const handlers = new Map<string, Set<() => void>>();
    const target = {
      addEventListener(type: string, listener: () => void) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        handlers.get(type)?.delete(listener);
      },
    };
    const doc = { ...target, visibilityState: 'visible' };
    let woke = 0;
    const off = onNetworkWake(() => (woke += 1), { window: target, document: doc });

    for (const type of ['online', 'focus', 'pageshow']) {
      for (const listener of handlers.get(type) ?? []) listener();
    }
    for (const listener of handlers.get('visibilitychange') ?? []) listener();
    vi.advanceTimersByTime(250);
    // Four events, one reconnect — not four reconnects.
    expect(woke).toBe(1);

    off();
    for (const listener of handlers.get('online') ?? []) listener();
    vi.advanceTimersByTime(1_000);
    expect(woke).toBe(1);
  });

  it('ignores the tab being hidden', () => {
    vi.useFakeTimers();
    const listeners: (() => void)[] = [];
    const target = { addEventListener: () => {}, removeEventListener: () => {} };
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => {},
    };
    let woke = 0;
    onNetworkWake(() => (woke += 1), { window: target, document: doc });
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(1_000);
    expect(woke).toBe(0);
  });
});

describe('the ZERO node reflects the connection, not the graph', () => {
  it('shows an offline backend as an error rather than as an empty graph', () => {
    const graph = buildGraph(null);
    // What `buildGraph` alone can say: "no snapshot".
    expect(graph.nodes[0]?.status).toBe('notLoaded');
    // What the connection state machine knows: HWD-ZERO is down.
    expect(withZeroStatus(graph, 'error').nodes[0]?.status).toBe('error');
    // A no-op change returns the same object, so React does not re-render.
    const offline = withZeroStatus(graph, 'error');
    expect(withZeroStatus(offline, 'error')).toBe(offline);
  });
});
