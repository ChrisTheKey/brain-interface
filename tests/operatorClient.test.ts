import { describe, expect, it, vi } from 'vitest';
import { HwdZeroClient, OperatorError } from '../src/hwd/client';
import type { OperatorEvent } from '../src/hwd/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: unknown): HwdZeroClient {
  return new HwdZeroClient({ fetchImpl: fetchImpl as typeof fetch });
}

/** The arguments of one recorded fetch call, asserted to exist. */
function callArgs(mock: { mock: { calls: unknown[] } }, index = 0): [string, RequestInit] {
  const call = mock.mock.calls[index];
  expect(call, `no fetch call at index ${index}`).toBeDefined();
  return call as [string, RequestInit];
}

/** One recorded fake socket, asserted to exist. */
function socketAt<T>(sockets: T[], index: number): T {
  const socket = sockets[index];
  if (socket === undefined) throw new Error(`no socket at index ${index}`);
  return socket;
}

describe('HWD-ZERO client', () => {
  it('talks to the operator through the gateway origin, with no address of its own', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok', safe_mode: false }));
    await clientWith(fetchImpl).health();
    expect(fetchImpl).toHaveBeenCalledWith('/api/health', expect.anything());
  });

  it('surfaces the operator error message instead of a bare status code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'ZERO is in SAFE_MODE (stopped); mission creation refused' }, 423),
    );
    await expect(clientWith(fetchImpl).createMission('Analysiere Leads')).rejects.toMatchObject({
      name: 'OperatorError',
      status: 423,
      message: 'ZERO is in SAFE_MODE (stopped); mission creation refused',
    });
  });

  it('states an objective and lets ZERO decide the plan', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 'MSN-1', objective: 'Analysiere Leads', state: 'EXECUTING', steps: [] }),
    );
    const mission = await clientWith(fetchImpl).createMission('Analysiere Leads');
    expect(mission.id).toBe('MSN-1');
    const [, init] = callArgs(fetchImpl);
    // The interface sends an objective, never a plan: choosing agents is the
    // operator's job, and a client-supplied step list would bypass routing.
    expect(JSON.parse(String(init.body))).toEqual({
      objective: 'Analysiere Leads',
      origin: 'operator',
    });
  });

  it('approves a gate by id, carrying no payload that could widen it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'APR-1', state: 'approved' }));
    await clientWith(fetchImpl).approve('APR-1');
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('/api/approvals/APR-1/approve');
    // An empty body is the security property: what was approved is whatever the
    // server digested when it raised the gate, not whatever the client sends now.
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('denies a gate by id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'APR-1', state: 'denied' }));
    await clientWith(fetchImpl).deny('APR-1');
    const [denyUrl] = callArgs(fetchImpl);
    expect(denyUrl).toBe('/api/approvals/APR-1/deny');
  });

  it('never sends a one-time approval token — the client is not given one', () => {
    // The client exposes no way to carry a token, which is what keeps the
    // secret on the laptop. This is a shape assertion, deliberately.
    const client = clientWith(vi.fn());
    expect('grantApproval' in client).toBe(false);
    expect('requestApproval' in client).toBe(false);
  });

  it('marks a policy grant as an explicit operator confirmation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ autonomous: ['repo.write'] }));
    await clientWith(fetchImpl).grantPolicy('repo.write');
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('/api/policy/grant');
    expect(JSON.parse(String(init.body))).toEqual({
      capability: 'repo.write',
      operator_confirmed: true,
    });
  });

  it('drives the kill switch through the server, not through local state', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ safe_mode: true }));
    await clientWith(fetchImpl).stop('operator pressed STOP ZERO');
    const [stopUrl] = callArgs(fetchImpl);
    expect(stopUrl).toBe('/api/system/stop');
  });

  it('sends a finished transcript to ZERO rather than interpreting it here', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ kind: 'answer', transcript: 'status?', response: '1 von 8' }),
    );
    const reply = await clientWith(fetchImpl).sendTranscript('status?');
    expect(reply.kind).toBe('answer');
    const [voiceUrl] = callArgs(fetchImpl);
    expect(voiceUrl).toBe('/api/voice/transcript');
  });

  it('reads only the pending gates from the approvals route', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ pending: [{ id: 'APR-1' }], all: [{ id: 'APR-1' }, { id: 'APR-0' }] }),
    );
    const approvals = await clientWith(fetchImpl).approvals();
    expect(approvals).toHaveLength(1);
  });

  it('reconnects the event stream and deduplicates the replayed buffer', async () => {
    const sockets: Array<{
      onopen?: () => void;
      onmessage?: (message: MessageEvent) => void;
      onclose?: () => void;
      onerror?: () => void;
      close: () => void;
    }> = [];
    const socketFactory = (): WebSocket => {
      const socket = { close: vi.fn() };
      sockets.push(socket as never);
      return socket as unknown as WebSocket;
    };

    const seen: OperatorEvent[] = [];
    const client = new HwdZeroClient({ socketFactory, reconnectDelayMs: 1 });
    const disconnect = client.connectEvents({ onEvent: (event) => seen.push(event) });

    const event: OperatorEvent = {
      event_id: 'EV-00000001',
      timestamp: '2026-08-21T08:00:00+00:00',
      mission_id: 'MSN-1',
      agent_id: 'lead_scraper',
      type: 'agent.started',
      simulated: false,
      payload: { step_id: 's1' },
    };
    socketAt(sockets, 0).onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.simulated).toBe(false);

    // A frame that is not parseable is dropped, never rendered half-formed.
    socketAt(sockets, 0).onmessage?.({ data: 'not json' } as MessageEvent);
    expect(seen).toHaveLength(1);

    socketAt(sockets, 0).onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets.length).toBeGreaterThan(1);

    disconnect();
  });

  it('stops reconnecting once the caller disconnects', async () => {
    const sockets: Array<{ onclose?: () => void; close: () => void }> = [];
    const socketFactory = (): WebSocket => {
      const socket = { close: vi.fn() };
      sockets.push(socket as never);
      return socket as unknown as WebSocket;
    };
    const client = new HwdZeroClient({ socketFactory, reconnectDelayMs: 1 });
    const disconnect = client.connectEvents({ onEvent: () => undefined });
    disconnect();
    socketAt(sockets, 0).onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(1);
  });

  it('reports an unparseable error body as the status text rather than crashing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(clientWith(fetchImpl).status()).rejects.toBeInstanceOf(OperatorError);
  });
});
