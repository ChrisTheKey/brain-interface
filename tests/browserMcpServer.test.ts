import { describe, expect, it, vi } from 'vitest';
import { handleMessage, renderResult, TOOLS } from '../mcp/brain-browser-server.mjs';

const call = (method: string, params?: unknown, id: number | null = 1) =>
  handleMessage({ jsonrpc: '2.0', id, method, params });

describe('the browser MCP server', () => {
  it('answers initialize with the protocol version the client asked for', async () => {
    const response = await call('initialize', { protocolVersion: '2025-03-26' });
    expect(response?.result?.protocolVersion).toBe('2025-03-26');
    expect(response?.result?.serverInfo?.name).toBe('zero-browser');
    expect(response?.result?.capabilities?.tools).toBeDefined();
  });

  it('falls back to its own version for an unknown one', async () => {
    const response = await call('initialize', { protocolVersion: '1999-01-01' });
    expect(response?.result?.protocolVersion).toBe('2025-06-18');
  });

  it('says nothing back to a notification', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('exposes the tools that make up ZERO’s internet access', async () => {
    const response = await call('tools/list');
    expect(response?.result?.tools?.map((tool) => tool.name)).toEqual([
      'browser_search',
      'browser_open',
      'browser_read',
      'browser_status',
      'browser_close',
    ]);
    // Every tool must be callable by a model without guessing.
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('rejects an unknown method as a protocol error', async () => {
    const response = await call('resources/list');
    expect(response?.error?.code).toBe(-32601);
  });

  it('calls the gateway route that belongs to the tool', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ title: 'Result page', url: 'https://duckduckgo.com/?q=zero', text: 'body', links: [] }),
    })) as unknown as typeof fetch;

    const response = await handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_search', arguments: { query: 'zero' } } },
      { fetch: fetchImpl },
    );

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toContain('/api/browser/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'zero' });
    expect(response?.result?.content?.[0]?.text).toContain('Result page');
    // The raw gateway answer is handed over too, for clients that read it.
    expect(response?.result?.structuredContent?.url).toContain('duckduckgo');
  });

  it('returns a tool failure as a readable result, not a protocol error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'url_blocked', message: '127.0.0.1 is a local address' }),
    })) as unknown as typeof fetch;

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'browser_open', arguments: { url: 'http://127.0.0.1:8000' } },
      },
      { fetch: fetchImpl },
    );
    expect(response?.error).toBeUndefined();
    expect(response?.result?.isError).toBe(true);
    expect(response?.result?.content?.[0]?.text).toContain('local address');
  });

  it('explains a missing gateway instead of failing silently', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_status' } },
      { fetch: fetchImpl },
    );
    expect(response?.result?.content?.[0]?.text).toMatch(/gateway is not reachable/);
  });
});

describe('rendering a page for an agent', () => {
  it('quotes the page rather than summarising it', () => {
    const text = renderResult('browser_open', {
      title: 'Example',
      url: 'https://example.com',
      description: 'a description',
      browser: 'firefox',
      text: 'The body of the page.',
      truncated: true,
      characters: 5000,
      links: [{ text: 'docs', href: 'https://example.com/docs' }],
    });
    expect(text).toContain('# Example');
    expect(text).toContain('The body of the page.');
    expect(text).toContain('- docs → https://example.com/docs');
    expect(text).toContain('[text truncated at 21 of 5000 characters]');
  });

  it('renders browser status as installed / running facts', () => {
    const text = renderResult('browser_status', {
      browsers: [
        { id: 'firefox', name: 'Mozilla Firefox', protocol: 'webdriver-bidi', installed: true },
        { id: 'edge', name: 'Microsoft Edge', protocol: 'cdp', installed: false },
      ],
      preferred: 'firefox',
      allowPrivate: false,
      active: { name: 'Mozilla Firefox', port: 4711 },
    });
    expect(text).toContain('Mozilla Firefox (firefox, webdriver-bidi)');
    expect(text).not.toContain('Microsoft Edge');
    expect(text).toContain('Running: Mozilla Firefox on debugging port 4711');
    expect(text).toContain('Private addresses: refused');
  });

  it('says plainly when no browser is installed', () => {
    expect(renderResult('browser_status', { browsers: [], preferred: 'chrome' })).toContain(
      'No supported browser is installed',
    );
  });
});
