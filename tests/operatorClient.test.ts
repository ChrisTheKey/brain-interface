import { describe, expect, it, vi } from 'vitest';
import { HwdZeroClient, OperatorError } from '../src/hwd/client';
import type { ApprovalTicket, OperatorEvent } from '../src/hwd/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HWD-ZERO client', () => {
  it('talks to the operator through the gateway origin, with no address of its own', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok', safe_mode: false }));
    const client = new HwdZeroClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.health();
    expect(fetchImpl).toHaveBeenCalledWith('/api/health', expect.anything());
  });

  it('surfaces the operator error message instead of a bare status code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'SAFE_MODE is on; starting a mission refused', status: 423 }, 423),
    );
    const client = new HwdZeroClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.startMission('gym-happy-path')).rejects.toMatchObject({
      name: 'OperatorError',
      status: 423,
      message: 'SAFE_MODE is on; starting a mission refused',
    });
  });

  it('reports an unreadable body as an error rather than pretending it succeeded', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>gateway</html>', { status: 502 }),
    );
    const client = new HwdZeroClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.state()).rejects.toBeInstanceOf(OperatorError);
  });

  it('never invents an approval: it asks for a ticket and redeems that exact ticket', async () => {
    const ticket: ApprovalTicket = {
      ticket_id: 'T-1',
      mission_id: 'M-1',
      gate: 'architecture',
      payload_digest: 'sha256:abc',
      expires_at: '2026-08-20T12:05:00+00:00',
      token: 'the-one-time-token',
    };
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === '/api/approvals') return jsonResponse(ticket, 201);
      return jsonResponse({ approved_gate: 'architecture', mission_id: 'M-1' });
    });
    const client = new HwdZeroClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const minted = await client.requestApproval('M-1', 'architecture');
    const granted = await client.grantApproval(minted);

    expect(calls[0]).toEqual({
      url: '/api/approvals',
      body: { mission_id: 'M-1', gate: 'architecture' },
    });
    expect(calls[1]).toEqual({
      url: '/api/approvals/T-1/grant',
      body: { token: 'the-one-time-token' },
    });
    expect(granted.approved_gate).toBe('architecture');
  });

  it('builds the event URL from the page origin, so no host is configured here', () => {
    const client = new HwdZeroClient({ baseUrl: 'http://127.0.0.1:8000' });
    expect(client.eventsUrl()).toBe('ws://127.0.0.1:8000/ws/events');
  });
});

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  close(): void {
    this.closed = true;
  }

  emit(event: OperatorEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

describe('operator event stream', () => {
  const event: OperatorEvent = {
    event_id: 'M-1:000001',
    timestamp: '2026-08-20T12:00:00+00:00',
    mission_id: 'M-1',
    agent_id: 'codex',
    type: 'mission.executing',
    payload: { source_event: 'iteration_start' },
  };

  it('delivers parsed events and drops frames it cannot read', () => {
    const received: OperatorEvent[] = [];
    const client = new HwdZeroClient({
      baseUrl: 'http://127.0.0.1:8000',
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: (item) => received.push(item) });
    const socket = FakeSocket.last!;
    socket.onopen?.();
    socket.emit(event);
    socket.onmessage?.({ data: 'not json' } as MessageEvent);
    socket.onmessage?.({ data: new ArrayBuffer(4) } as unknown as MessageEvent);
    expect(received).toEqual([event]);
    stop();
    expect(socket.closed).toBe(true);
  });

  it('reconnects after a drop, and stops for good once unsubscribed', () => {
    vi.useFakeTimers();
    const client = new HwdZeroClient({
      baseUrl: 'http://127.0.0.1:8000',
      reconnectDelayMs: 500,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const stop = client.connectEvents({ onEvent: () => {} });
    const first = FakeSocket.last!;
    first.onclose?.();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.last).not.toBe(first);

    const second = FakeSocket.last!;
    stop();
    second.onclose?.();
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.last).toBe(second);
    vi.useRealTimers();
  });
});
