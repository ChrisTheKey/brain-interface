#!/usr/bin/env node
/**
 * ZERO Browser — an MCP server that gives ZERO the internet.
 *
 *     ZERO (codex app-server)
 *        │  MCP over stdio
 *        ▼
 *     this server  ──http──▶  ZERO gateway /api/browser/*  ──▶  Chrome | Firefox | Brave | Edge
 *                                                                        │
 *                                                                        ▼
 *                                                                  the internet
 *
 * It is deliberately thin. The browser lifecycle, the protocol clients and
 * the URL policy all live in the gateway, so the browser ZERO drives is the
 * same browser the interface shows in its status line — one bridge, one
 * process, one policy. This server only translates MCP tool calls into
 * gateway calls.
 *
 * Registered in ZERO's `config.toml` as:
 *
 *     [mcp_servers.zero_browser]
 *     command = "node"
 *     args = ["<brain-interface>/mcp/brain-browser-server.mjs"]
 *
 * The interface writes that entry itself (see src/mcp/catalog.ts).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'zero-browser', title: 'ZERO Browser', version: '0.1.0' };

const gatewayUrl = (process.env.ZERO_GATEWAY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const requestTimeoutMs = Number(process.env.ZERO_BROWSER_MCP_TIMEOUT_MS ?? 90_000);

/**
 * The gateway trusts loopback without a token unless it runs in LAN mode, so
 * the token is optional here — read it when it exists rather than requiring it.
 */
function gatewayToken() {
  const direct = (process.env.ZERO_GATEWAY_TOKEN ?? '').trim();
  if (direct.length > 0) return direct;
  const file = process.env.ZERO_TOKEN_FILE ?? '';
  if (file && existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length > 0) return value;
  }
  return null;
}

export const TOOLS = [
  {
    name: 'browser_search',
    title: 'Search the web',
    description:
      'Search the web in a real browser (Chrome, Firefox, Brave or Edge) and return the result page: its text and the links it lists. Use this when you need current information from the internet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        engine: {
          type: 'string',
          enum: ['duckduckgo', 'google', 'bing', 'brave'],
          description: 'Search engine to use. Defaults to the gateway setting.',
        },
        browser: {
          type: 'string',
          enum: ['chrome', 'firefox', 'brave', 'edge'],
          description: 'Browser to run the search in. Defaults to the configured one.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_open',
    title: 'Open a page',
    description:
      'Open a public http(s) URL in a real browser and return the page: title, description, main text and links. Local and private addresses are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to open.' },
        browser: {
          type: 'string',
          enum: ['chrome', 'firefox', 'brave', 'edge'],
          description: 'Browser to open it in. Defaults to the configured one.',
        },
        maxChars: {
          type: 'integer',
          description: 'Maximum characters of page text to return.',
          minimum: 500,
          maximum: 60000,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_read',
    title: 'Re-read the open page',
    description:
      'Read the page that is currently open again, without navigating. Use this after a page has had time to finish loading, or to ask for more of its text.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', minimum: 500, maximum: 60000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_status',
    title: 'Browser status',
    description:
      'Which browsers are installed on this machine and which one is running right now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_close',
    title: 'Close the browser',
    description: 'Close the browser the bridge started and release its profile.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const ROUTES = {
  browser_search: { path: '/api/browser/search', method: 'POST' },
  browser_open: { path: '/api/browser/open', method: 'POST' },
  browser_read: { path: '/api/browser/read', method: 'POST' },
  browser_status: { path: '/api/browser/status', method: 'GET' },
  browser_close: { path: '/api/browser/close', method: 'POST' },
};

async function callGateway(route, args, fetchImpl = fetch) {
  const token = gatewayToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(`${gatewayUrl}${route.path}`, {
      method: route.method,
      headers: {
        accept: 'application/json',
        ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(route.method === 'POST' ? { body: JSON.stringify(args ?? {}) } : {}),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message ?? body.error ?? `gateway returned HTTP ${response.status}`);
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`the browser did not answer within ${requestTimeoutMs}ms`);
    }
    if (error instanceof TypeError) {
      throw new Error(
        `the ZERO gateway is not reachable at ${gatewayUrl} — start it with \`npm run gateway\``,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders a gateway result as the text an agent reads. Page text is quoted as
 * it came out of the page; nothing is summarised here.
 */
export function renderResult(toolName, result) {
  if (toolName === 'browser_status') {
    const installed = (result.browsers ?? []).filter((browser) => browser.installed);
    const lines = [
      installed.length > 0
        ? `Installed: ${installed.map((browser) => `${browser.name} (${browser.id}, ${browser.protocol})`).join(', ')}`
        : 'No supported browser is installed on this machine.',
      `Preferred: ${result.preferred}`,
      result.active
        ? `Running: ${result.active.name} on debugging port ${result.active.port}`
        : 'Running: none',
      `Private addresses: ${result.allowPrivate ? 'allowed' : 'refused'}`,
    ];
    return lines.join('\n');
  }
  if (toolName === 'browser_close') return 'Browser closed.';

  const parts = [];
  if (result.title) parts.push(`# ${result.title}`);
  parts.push(`URL: ${result.url ?? result.requestedUrl ?? ''}`);
  if (result.description) parts.push(`Description: ${result.description}`);
  if (result.browser) parts.push(`Browser: ${result.browser}`);
  if (result.text) {
    parts.push('', result.text);
    if (result.truncated) {
      parts.push('', `[text truncated at ${result.text.length} of ${result.characters} characters]`);
    }
  }
  if (Array.isArray(result.links) && result.links.length > 0) {
    parts.push('', 'Links:');
    for (const link of result.links) parts.push(`- ${link.text} → ${link.href}`);
  }
  return parts.join('\n');
}

async function callTool(name, args, fetchImpl) {
  const route = ROUTES[name];
  if (!route) throw new Error(`unknown tool: ${name}`);
  const result = await callGateway(route, args, fetchImpl);
  return { content: [{ type: 'text', text: renderResult(name, result) }], structuredContent: result };
}

/** Handles one JSON-RPC message. Returns the response, or null for a notification. */
export async function handleMessage(message, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  if (id === undefined) return null; // notification (e.g. notifications/initialized)

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Drives a real browser on the operator machine. Use browser_search for open questions and browser_open for a known URL; both return the page text and its links.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      try {
        return reply(await callTool(name, params?.arguments ?? {}, fetchImpl));
      } catch (error) {
        // A tool failure is a result, not a protocol error: the agent should
        // read what went wrong and decide, not have its request rejected.
        return reply({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      return;
    }
    void handleMessage(message)
      .then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        output.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: error.message } })}\n`,
        );
      });
  });
  return lines;
}

if (process.argv[1] && process.argv[1].endsWith('brain-browser-server.mjs')) {
  serve();
}
