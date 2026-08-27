import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL,
  GOOGLE_ADS,
  INTEGRATIONS,
  META_ADS,
  ZERO_BROWSER,
  integrationById,
  withGatewayCommand,
} from '../src/mcp/catalog';
import {
  configDifferences,
  disconnect,
  provision,
  readConfiguredServers,
  resolveStatuses,
  signIn,
  summarizeStatuses,
} from '../src/mcp/provisioning';
import type { ZeroClient } from '../src/zero/client';
import type { McpServerStatus } from '../src/zero/protocol';

/** A ZeroClient stand-in that records what the interface asked ZERO to do. */
function fakeClient(responses: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    request: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method in responses) {
        const value = responses[method];
        if (value instanceof Error) throw value;
        return value;
      }
      return {};
    }),
  } as unknown as ZeroClient;
  return { client, calls };
}

const serverStatus = (name: string, over: Partial<McpServerStatus> = {}): McpServerStatus => ({
  name,
  authStatus: 'oAuth',
  tools: { a: { name: 'a' }, b: { name: 'b' } },
  resources: [],
  resourceTemplates: [],
  ...over,
});

describe('the integration catalog', () => {
  it('declares the four integrations the interface can hand to ZERO', () => {
    expect(INTEGRATIONS.map((integration) => integration.id)).toEqual([
      'meta_ads',
      'google_ads',
      'gmail',
      'zero_browser',
    ]);
    expect(integrationById('gmail')).toBe(GMAIL);
    expect(integrationById('nope')).toBeUndefined();
  });

  it('points at each vendor’s own official endpoint', () => {
    expect(META_ADS.config.url).toBe('https://mcp.facebook.com/ads');
    expect(GMAIL.config.url).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    expect(GOOGLE_ADS.config.args?.join(' ')).toContain(
      'git+https://github.com/googleads/google-ads-mcp.git',
    );
    expect(INTEGRATIONS.every((integration) => integration.official)).toBe(true);
  });

  it('sets exactly one transport per entry, as ZERO requires', () => {
    for (const { id, config } of INTEGRATIONS) {
      const stdio = config.command !== undefined;
      const http = config.url !== undefined;
      expect(stdio !== http, `${id} must be stdio or http, not both`).toBe(true);
    }
  });

  it('never puts a credential in the config — only the names of env vars', () => {
    const serialized = JSON.stringify(INTEGRATIONS);
    expect(serialized).not.toMatch(/bearer_token"\s*:/);
    // Google Ads credentials are forwarded from ZERO's environment by name.
    expect(GOOGLE_ADS.config.env_vars).toContain('GOOGLE_ADS_DEVELOPER_TOKEN');
    expect(GOOGLE_ADS.config.env).toBeUndefined();
  });

  it('requests only the Gmail scopes it needs', () => {
    expect(GMAIL.config.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
  });

  it('takes the absolute browser command from the gateway', () => {
    const pinned = withGatewayCommand(ZERO_BROWSER, {
      command: '/usr/bin/node',
      args: ['/opt/brain-interface/mcp/brain-browser-server.mjs'],
    });
    expect(pinned.config.command).toBe('/usr/bin/node');
    expect(pinned.config.args).toEqual(['/opt/brain-interface/mcp/brain-browser-server.mjs']);
    // The catalog entry itself is untouched.
    expect(ZERO_BROWSER.config.command).toBe('node');
    // Other integrations are returned unchanged.
    expect(withGatewayCommand(GMAIL, { command: 'x', args: [] })).toBe(GMAIL);
    expect(withGatewayCommand(ZERO_BROWSER, null)).toBe(ZERO_BROWSER);
  });
});

describe('reading ZERO’s configured servers', () => {
  it('pulls the mcp_servers table out of a config/read response', () => {
    expect(
      readConfiguredServers({ config: { mcp_servers: { gmail: { url: 'https://x' } } } }),
    ).toEqual({ gmail: { url: 'https://x' } });
  });

  it('returns nothing rather than guessing when the table is absent', () => {
    expect(readConfiguredServers(null)).toEqual({});
    expect(readConfiguredServers({ config: {} })).toEqual({});
    expect(readConfiguredServers({ config: { mcp_servers: [] } })).toEqual({});
  });
});

describe('comparing a configured entry with the catalog', () => {
  it('sees no difference for an identical entry', () => {
    expect(configDifferences(GMAIL.config, { ...GMAIL.config })).toEqual([]);
  });

  it('names the fields that differ', () => {
    expect(configDifferences(GMAIL.config, { ...GMAIL.config, url: 'https://old' })).toEqual(['url']);
    expect(
      configDifferences(GOOGLE_ADS.config, { ...GOOGLE_ADS.config, args: ['run', 'other'] }),
    ).toEqual(['args']);
  });

  it('does not call a deliberately disabled server wrong', () => {
    // `enabled` is the operator's switch, not the catalog's.
    expect(configDifferences(GMAIL.config, { ...GMAIL.config, enabled: false })).toEqual([]);
  });

  it('treats an entirely missing entry as every field differing', () => {
    expect(configDifferences(GMAIL.config, null).length).toBe(Object.keys(GMAIL.config).length);
  });
});

describe('integration state', () => {
  it('derives each state from ZERO’s two answers', () => {
    const statuses = resolveStatuses(
      [META_ADS, GOOGLE_ADS, GMAIL, ZERO_BROWSER],
      {
        google_ads: { ...GOOGLE_ADS.config },
        gmail: { ...GMAIL.config },
        zero_browser: { ...ZERO_BROWSER.config, enabled: false },
      },
      [serverStatus('gmail', { authStatus: 'notLoggedIn' })],
    );
    const byId = Object.fromEntries(statuses.map((status) => [status.integration.id, status]));

    // Not in the config at all.
    expect(byId.meta_ads?.state).toBe('notConfigured');
    // In the config, but ZERO reports no running server for it.
    expect(byId.google_ads?.state).toBe('configured');
    // Running, but the OAuth sign-in has not happened.
    expect(byId.gmail?.state).toBe('needsSignIn');
    expect(byId.gmail?.toolCount).toBe(2);
    // Turned off by the operator.
    expect(byId.zero_browser?.state).toBe('disabled');
  });

  it('reports connected only when ZERO says the server is up and signed in', () => {
    const [status] = resolveStatuses([GMAIL], { gmail: { ...GMAIL.config } }, [
      serverStatus('gmail'),
    ]);
    expect(status?.state).toBe('connected');
    expect(summarizeStatuses([status!])).toEqual([]);
  });

  it('flags an entry whose configuration drifted from the catalog', () => {
    const [status] = resolveStatuses([META_ADS], { meta_ads: { url: 'https://old.example' } }, []);
    expect(status?.state).toBe('outdated');
    expect(status?.differences).toContain('url');
    expect(summarizeStatuses([status!])[0]).toMatch(/different configuration/);
  });
});

describe('provisioning through ZERO', () => {
  it('writes the entries and reloads ZERO’s MCP servers', async () => {
    const { client, calls } = fakeClient({
      'config/batchWrite': { status: 'ok', version: '2', filePath: '/home/o/.codex/config.toml' },
    });

    const results = await provision(client, [META_ADS, GMAIL]);

    expect(calls[0]?.method).toBe('config/batchWrite');
    expect(calls[0]?.params).toEqual({
      edits: [
        { keyPath: 'mcp_servers.meta_ads', value: META_ADS.config, mergeStrategy: 'replace' },
        { keyPath: 'mcp_servers.gmail', value: GMAIL.config, mergeStrategy: 'replace' },
      ],
    });
    // Without the reload the operator would have to restart ZERO.
    expect(calls[1]?.method).toBe('config/mcpServer/reload');
    expect(results.every((result) => result.wrote && result.reloaded && !result.error)).toBe(true);
    expect(results[0]?.filePath).toBe('/home/o/.codex/config.toml');
  });

  it('reports a failed write instead of claiming success', async () => {
    const { client } = fakeClient({ 'config/batchWrite': new Error('config layer is read-only') });
    const results = await provision(client, [GMAIL]);
    expect(results[0]).toMatchObject({ wrote: false, error: 'config layer is read-only' });
  });

  it('says so when the write landed but the reload did not', async () => {
    const { client } = fakeClient({
      'config/batchWrite': { status: 'ok', version: '1', filePath: '/c.toml' },
      'config/mcpServer/reload': new Error('backend busy'),
    });
    const [result] = await provision(client, [GMAIL]);
    expect(result).toMatchObject({ wrote: true, reloaded: false });
    expect(result?.error).toMatch(/reload failed/);
  });

  it('does nothing at all for an empty selection', async () => {
    const { client, calls } = fakeClient();
    expect(await provision(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('asks ZERO to run the OAuth sign-in and returns its URL', async () => {
    const { client, calls } = fakeClient({
      'mcpServer/oauth/login': { authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' },
    });
    const { authorizationUrl } = await signIn(client, GMAIL);
    expect(authorizationUrl).toContain('accounts.google.com');
    expect(calls[0]).toEqual({
      method: 'mcpServer/oauth/login',
      params: { name: 'gmail', scopes: GMAIL.config.scopes },
    });
  });

  it('fails loudly if ZERO returns no authorization URL', async () => {
    const { client } = fakeClient({ 'mcpServer/oauth/login': {} });
    await expect(signIn(client, META_ADS)).rejects.toThrow(/authorization URL/);
  });

  it('removes an entry by writing null at its path', async () => {
    const { client, calls } = fakeClient({
      'config/value/write': { status: 'ok', version: '3', filePath: '/c.toml' },
    });
    const result = await disconnect(client, META_ADS);
    expect(calls[0]?.params).toEqual({
      keyPath: 'mcp_servers.meta_ads',
      value: null,
      mergeStrategy: 'replace',
    });
    expect(result).toMatchObject({ wrote: true, reloaded: true });
  });
});
