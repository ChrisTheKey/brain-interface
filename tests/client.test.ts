import { describe, expect, it } from 'vitest';
import { ZeroClient, type ZeroSocket } from '../src/zero/client';

/** Protocol-conformant fake of ZERO's WebSocket transport (test-only). */
class FakeSocket implements ZeroSocket {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  lastRequest(): { id: number; method: string; params?: unknown } {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('nothing sent');
    return JSON.parse(raw) as { id: number; method: string; params?: unknown };
  }
}

function makeClient(): { client: ZeroClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const client = new ZeroClient({
    url: 'ws://127.0.0.1:8787',
    clientInfo: { name: 'brain_interface_test', version: '0.0.0' },
    experimentalApi: true,
    socketFactory: () => socket,
  });
  return { client, socket };
}

describe('ZeroClient', () => {
  it('performs the initialize / initialized handshake ZERO requires', async () => {
    const { client, socket } = makeClient();
    const connected = client.connect();
    socket.open();

    const initialize = socket.lastRequest();
    expect(initialize.method).toBe('initialize');
    expect(initialize.params).toMatchObject({
      clientInfo: { name: 'brain_interface_test' },
      capabilities: { experimentalApi: true },
    });
    // No JSON-RPC version field: ZERO's transport omits it on the wire.
    expect(socket.sent[0]).not.toContain('jsonrpc');

    socket.deliver({ id: initialize.id, result: { userAgent: 'zero/1.0' } });
    await connected;

    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ method: 'initialized' });
    expect(client.connectionState).toBe('connected');
    expect(client.serverUserAgent).toBe('zero/1.0');
    client.close();
  });

  it('resolves requests by id and rejects JSON-RPC errors', async () => {
    const { client, socket } = makeClient();
    const connected = client.connect();
    socket.open();
    const initialize = socket.lastRequest();
    socket.deliver({ id: initialize.id, result: { userAgent: 'zero/1.0' } });
    await connected;

    const pending = client.request<{ data: string[] }>('thread/loaded/list', {});
    const request = socket.lastRequest();
    socket.deliver({ id: request.id, result: { data: ['thr_1'] } });
    await expect(pending).resolves.toEqual({ data: ['thr_1'] });

    const failing = client.request('skills/list', {});
    const failingRequest = socket.lastRequest();
    socket.deliver({
      id: failingRequest.id,
      error: { code: -32603, message: 'skills unavailable' },
    });
    await expect(failing).rejects.toThrow('skills unavailable');
    client.close();
  });

  it('fans notifications out to subscribers', async () => {
    const { client, socket } = makeClient();
    const connected = client.connect();
    socket.open();
    const initialize = socket.lastRequest();
    socket.deliver({ id: initialize.id, result: { userAgent: 'zero/1.0' } });
    await connected;

    const received: { method: string; params: unknown }[] = [];
    client.on('notification', (method, params) => received.push({ method, params }));
    socket.deliver({
      method: 'thread/status/changed',
      params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } },
    });

    expect(received).toEqual([
      {
        method: 'thread/status/changed',
        params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } },
      },
    ]);
    client.close();
  });

  it('declines server-initiated requests instead of answering on the user behalf', async () => {
    const { client, socket } = makeClient();
    const connected = client.connect();
    socket.open();
    const initialize = socket.lastRequest();
    socket.deliver({ id: initialize.id, result: { userAgent: 'zero/1.0' } });
    await connected;

    socket.deliver({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr_1' },
    });
    const response = JSON.parse(socket.sent.at(-1) as string) as {
      id: number;
      error: { message: string };
    };
    expect(response.id).toBe(99);
    expect(response.error.message).toContain('does not handle');
    client.close();
  });
});
