/**
 * The integration catalog.
 *
 * These are the MCP servers the Brain Interface can hand to ZERO: the two
 * official ad platforms, the official Gmail server, and this repository's own
 * browser bridge. The catalog is a declaration of *what* each server is and
 * *how* ZERO must be configured to reach it — it holds no credential, and it
 * is not a claim that any of them is connected. Whether a server is live is
 * only ever read back from ZERO (`mcpServerStatus/list`).
 *
 * Every entry is the vendor's own endpoint or package. Nothing here is a
 * third-party reseller of an API:
 *
 *   Meta Ads    https://mcp.facebook.com/ads          (Meta, OAuth 2.0)
 *   Google Ads  github.com/googleads/google-ads-mcp   (Google, stdio via pipx)
 *   Gmail       https://gmailmcp.googleapis.com/mcp/v1 (Google, OAuth 2.0)
 *   ZERO Browser  mcp/brain-browser-server.mjs        (this repository)
 */
import type { McpServerConfigEntry } from '../zero/protocol';

export type IntegrationCategory = 'advertising' | 'mail' | 'web';

export interface IntegrationRequirement {
  /**
   * `env` — an environment variable ZERO's process must carry.
   * `oauth` — an interactive sign-in ZERO performs (`mcpServer/oauth/login`).
   * `tool` — a program that must exist on the machine.
   */
  kind: 'env' | 'oauth' | 'tool';
  name: string;
  description: string;
  /** Where the operator gets it. */
  href?: string;
}

export interface IntegrationDefinition {
  /** The `[mcp_servers.<id>]` key in ZERO's config.toml. */
  id: string;
  name: string;
  vendor: string;
  category: IntegrationCategory;
  description: string;
  /** True for the vendor's own first-party server. */
  official: boolean;
  docsUrl: string;
  /** Exactly the entry that is written into ZERO's config. */
  config: McpServerConfigEntry;
  /** Whether ZERO has to run an OAuth sign-in after the config is written. */
  requiresOAuth: boolean;
  requirements: IntegrationRequirement[];
  /** What this integration lets ZERO actually do, in the operator's terms. */
  capabilities: string[];
}

/** Meta's official Ads MCP — the hosted server, authorised through Meta OAuth. */
export const META_ADS: IntegrationDefinition = {
  id: 'meta_ads',
  name: 'Meta Ads',
  vendor: 'Meta',
  category: 'advertising',
  description:
    "Meta's own AI connector for the Marketing API: campaigns, ad sets, ads, insights and benchmarks for the ad accounts your Business Manager login already has access to.",
  official: true,
  docsUrl: 'https://mcp.facebook.com/ads',
  config: {
    url: 'https://mcp.facebook.com/ads',
    enabled: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  },
  requiresOAuth: true,
  requirements: [
    {
      kind: 'oauth',
      name: 'Meta Business login',
      description:
        'Sign in with the Meta account that has a role on the ad account, and authorise the ad accounts and Pages ZERO may use. The server inherits exactly the permissions of that login — nothing more.',
      href: 'https://business.facebook.com/',
    },
  ],
  capabilities: [
    'Read campaign, ad set and ad structure',
    'Read insights, opportunity score and industry benchmarks',
    'Create and update campaigns (within the authorised accounts)',
  ],
};

/** Google's official, open-source Google Ads MCP server. Read-only by design. */
export const GOOGLE_ADS: IntegrationDefinition = {
  id: 'google_ads',
  name: 'Google Ads',
  vendor: 'Google',
  category: 'advertising',
  description:
    "Google's own open-source Google Ads server. It is deliberately read-only: it runs GAQL queries and reads resource metadata, and it cannot change bids, pause campaigns or create assets.",
  official: true,
  docsUrl: 'https://github.com/googleads/google-ads-mcp',
  config: {
    command: 'pipx',
    args: ['run', '--spec', 'git+https://github.com/googleads/google-ads-mcp.git', 'google-ads-mcp'],
    // The credentials stay in ZERO's environment and are forwarded by name —
    // no secret is ever written into config.toml by this interface.
    env_vars: [
      'GOOGLE_ADS_DEVELOPER_TOKEN',
      'GOOGLE_PROJECT_ID',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    ],
    enabled: true,
    startup_timeout_sec: 120,
    tool_timeout_sec: 120,
  },
  requiresOAuth: false,
  requirements: [
    {
      kind: 'tool',
      name: 'pipx',
      description: 'Runs the server straight from its Git repository, without a global install.',
      href: 'https://pipx.pypa.io/stable/installation/',
    },
    {
      kind: 'env',
      name: 'GOOGLE_ADS_DEVELOPER_TOKEN',
      description: 'Google Ads API developer token with at least Explorer access.',
      href: 'https://developers.google.com/google-ads/api/docs/get-started/dev-token',
    },
    {
      kind: 'env',
      name: 'GOOGLE_PROJECT_ID',
      description: 'The Google Cloud project the Ads API calls are billed and quota-counted to.',
    },
    {
      kind: 'env',
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      description:
        'Path to the Application Default Credentials JSON for the account that may read the ad accounts.',
    },
    {
      kind: 'env',
      name: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
      description: 'Manager (MCC) account id, if the accounts are reached through a manager.',
    },
  ],
  capabilities: [
    'Run GAQL queries against the account (search)',
    'Read metadata for any Google Ads API resource type',
    'List the customer ids the credentials can reach',
  ],
};

/** Google's official remote Gmail MCP server. */
export const GMAIL: IntegrationDefinition = {
  id: 'gmail',
  name: 'Gmail',
  vendor: 'Google',
  category: 'mail',
  description:
    "Google's own remote Gmail server: search mail, read threads, list labels, and draft and label messages. It drafts — it does not send on its own.",
  official: true,
  docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  config: {
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    enabled: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  },
  requiresOAuth: true,
  requirements: [
    {
      kind: 'oauth',
      name: 'Google sign-in',
      description:
        'Authorise the Google account whose mailbox ZERO may read and draft in. The scopes requested are read-only plus compose.',
      href: 'https://developers.google.com/workspace/guides/create-credentials',
    },
  ],
  capabilities: [
    'Search messages and read threads',
    'List and apply labels',
    'Create draft replies (sending stays with you)',
  ],
};

/**
 * This repository's own browser bridge. It is the integration that gives ZERO
 * the internet, through the operator's Chrome, Firefox, Brave or Edge.
 * `command`/`args` are filled in from the gateway, which knows where the
 * interface is installed (see `/api/gateway/health`).
 */
export const ZERO_BROWSER: IntegrationDefinition = {
  id: 'zero_browser',
  name: 'ZERO Browser',
  vendor: 'Brain Interface',
  category: 'web',
  description:
    'ZERO’s access to the internet, through a browser that is really installed on this machine. Search, open a page, read what it says. Local and private addresses are refused.',
  official: true,
  docsUrl: 'https://github.com/ChrisTheKey/brain-interface#zero-browser',
  config: {
    command: 'node',
    args: ['mcp/brain-browser-server.mjs'],
    env_vars: ['ZERO_GATEWAY_URL', 'ZERO_GATEWAY_TOKEN', 'ZERO_TOKEN_FILE'],
    enabled: true,
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
  },
  requiresOAuth: false,
  requirements: [
    {
      kind: 'tool',
      name: 'A supported browser',
      description:
        'Chrome, Firefox, Brave or Edge, installed on the machine that runs the gateway.',
    },
    {
      kind: 'tool',
      name: 'The ZERO gateway',
      description: 'The bridge lives in the gateway — start it with `npm run gateway`.',
    },
  ],
  capabilities: [
    'Search the web (DuckDuckGo, Google, Bing or Brave Search)',
    'Open a public page and read its title, text and links',
    'Re-read the open page without navigating again',
  ],
};

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  META_ADS,
  GOOGLE_ADS,
  GMAIL,
  ZERO_BROWSER,
];

export function integrationById(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((integration) => integration.id === id);
}

/**
 * The browser bridge is registered with the absolute command the gateway
 * reports, so ZERO can start it from any working directory. Without that
 * report the relative fallback is kept — and shown as such.
 */
export function withGatewayCommand(
  integration: IntegrationDefinition,
  command: { command: string; args: string[] } | null,
): IntegrationDefinition {
  if (integration.id !== ZERO_BROWSER.id || !command) return integration;
  return {
    ...integration,
    config: { ...integration.config, command: command.command, args: [...command.args] },
  };
}
